import { existsSync, lstatSync } from "node:fs";
import { rename as fsRename } from "node:fs/promises";
import { join } from "node:path";
import { slugify } from "./convert.js";
import { type NotionPage, readTitle } from "./notion.js";
import type { Manifest } from "./manifest.js";
import {
  ensureSymlink,
  removeSymlink,
  targetSkillPath,
  targetsForKeys,
} from "./targets.js";

/**
 * One detected rename. The manifest's entry for `localSlug` belongs to
 * a Notion page whose title now slugifies to `newSourceSlug` instead
 * of `oldSourceSlug`. Apply step:
 *   - Always updates `entry.source_slug` to the new value.
 *   - When the new source_slug doesn't collide with another installed
 *     skill on this machine, ALSO renames the on-disk dir, every
 *     agent target's symlink, and the manifest key (local_slug) to
 *     match. Mirrors the user's expectation: rename in Notion = rename
 *     locally.
 *   - On collision (another skill already occupies the proposed local
 *     slug), the local rename is refused; only `entry.source_slug`
 *     updates, and the user gets a "stuck" warning so they can free
 *     the conflicting slug if they want the rename to land.
 */
export interface RenameOp {
  pageId: string;
  localSlug: string;
  oldSourceSlug: string;
  newSourceSlug: string;
}

export type RenameOutcome =
  | { status: "renamed"; op: RenameOp; newLocalSlug: string }
  | { status: "source-only"; op: RenameOp; reason: RenameRefusedReason };

export type RenameRefusedReason =
  | { kind: "collision-manifest"; conflictWith: string }
  | { kind: "collision-disk"; path: string };

/**
 * Detect rename events for one source. Compares the manifest's
 * `source_slug` per-entry against the current Notion page slug
 * (matched by stable `page_id`). Pure: no I/O, no mutation.
 */
export function detectRenames(
  manifest: Manifest,
  sourceKey: string,
  pages: NotionPage[],
): RenameOp[] {
  const currentSlugByPageId = new Map<string, string>();
  for (const page of pages) {
    if (page.archived || page.in_trash) continue;
    const title = readTitle(page.properties);
    if (!title) continue;
    currentSlugByPageId.set(page.id, slugify(title));
  }
  const ops: RenameOp[] = [];
  for (const [localSlug, entry] of Object.entries(manifest.skills)) {
    if (entry.source_key !== sourceKey) continue;
    const newSlug = currentSlugByPageId.get(entry.page_id);
    if (!newSlug) continue; // page archived / not found — handled elsewhere
    // Detect any disagreement between Notion's current slug and what's
    // on disk. Two sources of disagreement:
    //   (1) Notion-side title change since last sync → entry.source_slug
    //       still points at the old slug; on-disk local_slug also old.
    //   (2) Stuck state from the legacy "pinned local_slug" code:
    //       entry.source_slug already updated, but local_slug never
    //       was. Fires only on the first sync after upgrading.
    // Both reduce to "current source slug doesn't match local dir
    // name" and want the same fix: rename locally if no collision.
    if (newSlug === localSlug && newSlug === entry.source_slug) continue;
    ops.push({
      pageId: entry.page_id,
      localSlug,
      oldSourceSlug: entry.source_slug,
      newSourceSlug: newSlug,
    });
  }
  return ops.sort((a, b) => a.localSlug.localeCompare(b.localSlug));
}

/**
 * Pure-fn variant: classify what would happen for each op without
 * touching the filesystem. The collision check looks at the manifest
 * (other tracked skills) AND any caller-provided "exists on disk"
 * predicate so this stays mockable in tests.
 */
export function classifyRenameOps(
  ops: RenameOp[],
  manifest: Manifest,
  diskExists: (slug: string) => boolean,
): RenameOutcome[] {
  // Track local_slugs we'll reassign during this pass so we don't let
  // two ops in the same batch race for the same target name.
  const inFlight = new Set<string>();
  const outcomes: RenameOutcome[] = [];
  for (const op of ops) {
    const target = op.newSourceSlug;
    // No actual local-name change requested.
    if (target === op.localSlug) {
      outcomes.push({ status: "renamed", op, newLocalSlug: target });
      continue;
    }
    if (manifest.skills[target] && target !== op.localSlug) {
      outcomes.push({
        status: "source-only",
        op,
        reason: { kind: "collision-manifest", conflictWith: target },
      });
      continue;
    }
    if (inFlight.has(target)) {
      outcomes.push({
        status: "source-only",
        op,
        reason: { kind: "collision-manifest", conflictWith: target },
      });
      continue;
    }
    if (diskExists(target)) {
      outcomes.push({
        status: "source-only",
        op,
        reason: { kind: "collision-disk", path: target },
      });
      continue;
    }
    inFlight.add(target);
    outcomes.push({ status: "renamed", op, newLocalSlug: target });
  }
  return outcomes;
}

/**
 * Apply rename ops in lockstep across the manifest, the central skill
 * dir, and every configured agent target's symlink. Returns one
 * outcome per op so the caller can log granularly.
 *
 * Always updates `entry.source_slug` (cheap and mismatch-free).
 * Renames on disk + remaps the manifest key only when the proposed
 * `newSourceSlug` is free; otherwise keeps `local_slug` and surfaces
 * the conflict so the user can free up the name.
 */
export async function applyRenames(
  manifest: Manifest,
  ops: RenameOp[],
  contentRoot: string,
  targetKeys: string[],
): Promise<RenameOutcome[]> {
  const outcomes = classifyRenameOps(
    ops,
    manifest,
    (slug) => existsLocally(join(contentRoot, slug)),
  );

  for (const outcome of outcomes) {
    const entry = manifest.skills[outcome.op.localSlug];
    if (!entry) continue;
    entry.source_slug = outcome.op.newSourceSlug;
    if (outcome.status !== "renamed") continue;
    if (outcome.newLocalSlug === outcome.op.localSlug) continue;

    await applyOneRename(
      manifest,
      outcome.op.localSlug,
      outcome.newLocalSlug,
      contentRoot,
      targetKeys,
    );
  }
  return outcomes;
}

async function applyOneRename(
  manifest: Manifest,
  oldSlug: string,
  newSlug: string,
  contentRoot: string,
  targetKeys: string[],
): Promise<void> {
  // 1. Move the central-store dir.
  const oldDir = join(contentRoot, oldSlug);
  const newDir = join(contentRoot, newSlug);
  if (existsSync(oldDir)) {
    await fsRename(oldDir, newDir);
  }

  // 2. Move the manifest entry to the new key.
  const entry = manifest.skills[oldSlug];
  if (entry) {
    delete manifest.skills[oldSlug];
    manifest.skills[newSlug] = entry;
  }

  // 3. Rebuild every agent target's symlink to point at the new path
  //    under the new name. Old link removed, new link created.
  const targets = targetsForKeys(targetKeys);
  for (const t of targets) {
    const oldLink = targetSkillPath(t, oldSlug);
    await removeSymlink(oldLink);
    await ensureSymlink(newDir, targetSkillPath(t, newSlug));
  }
}

function existsLocally(path: string): boolean {
  // Use lstat semantics: a dangling symlink also "exists" in the
  // collision sense — we shouldn't try to claim the name.
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
