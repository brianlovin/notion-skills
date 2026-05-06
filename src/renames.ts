import { existsSync, lstatSync } from "node:fs";
import { rename } from "node:fs/promises";
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
import type { TargetKey } from "./paths.js";

/**
 * One detected rename: a manifest entry whose Notion page now has a
 * different slugified title than the entry's manifest key. Surfaced
 * by `detectRenames`; consumed by the apply step.
 */
export interface RenameOp {
  pageId: string;
  oldSlug: string;
  newSlug: string;
}

/**
 * Compare the manifest's slugs against the live Notion query's slugs
 * (matched by stable `page_id`) and return entries whose user-visible
 * title has changed in Notion.
 *
 * The slug stays the user-facing identifier (`/<slug>` in agent CLIs,
 * directory name, symlink target) — but `page_id` is what survives
 * across renames. By keying detection on `page_id` we can rename the
 * local installation in lock-step with Notion, preserving install
 * state, install count, and drift hashes.
 *
 * Pure: no I/O, no manifest mutation. Order is by oldSlug for stable
 * test/log output. Pages without titles (invalid) are ignored.
 */
export function detectRenames(
  manifest: Manifest,
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
  for (const [oldSlug, entry] of Object.entries(manifest.skills)) {
    const newSlug = currentSlugByPageId.get(entry.page_id);
    if (!newSlug) continue; // page archived / not found — handled elsewhere
    if (newSlug === oldSlug) continue;
    ops.push({ pageId: entry.page_id, oldSlug, newSlug });
  }
  return ops.sort((a, b) => a.oldSlug.localeCompare(b.oldSlug));
}

/**
 * Reasons a rename was refused. The slug name space is shared across
 * the manifest and the central-store directory, so collisions on either
 * side block the rename — better to surface the conflict than silently
 * overwrite a different skill or draft.
 */
export type RenameRefusal =
  | { kind: "collision-manifest"; conflictWith: string }
  | { kind: "collision-disk"; path: string };

export function classifyRenameCollision(
  op: RenameOp,
  manifest: Manifest,
  diskHasNewSlug: boolean,
): RenameRefusal | null {
  if (manifest.skills[op.newSlug] && op.newSlug !== op.oldSlug) {
    return { kind: "collision-manifest", conflictWith: op.newSlug };
  }
  if (diskHasNewSlug) {
    return { kind: "collision-disk", path: op.newSlug };
  }
  return null;
}

export type RenameOutcome =
  | { op: RenameOp; status: "renamed" }
  | { op: RenameOp; status: "refused"; reason: RenameRefusal };

/**
 * Apply renames in lock-step across the central store dir, every
 * configured target's symlink, and the manifest entry. The manifest
 * is mutated in place — caller is responsible for writing it.
 *
 *   1. Rename ~/.notion-skills/skills/<old>/ → <new>/
 *   2. For each target dir: rm <target>/<old> symlink, add <target>/<new>
 *   3. Move manifest.skills[<old>] to manifest.skills[<new>]
 *
 * On collision (target slug already in use by another manifest entry
 * or a draft on disk) the rename is refused and the outcome is
 * surfaced; the caller logs it. Refused renames leave state untouched.
 */
export async function applyRenames(
  ops: RenameOp[],
  manifest: Manifest,
  contentRoot: string,
  targetKeys: TargetKey[],
): Promise<RenameOutcome[]> {
  const outcomes: RenameOutcome[] = [];
  const targets = targetsForKeys(targetKeys);

  for (const op of ops) {
    const newDir = join(contentRoot, op.newSlug);
    const collision = classifyRenameCollision(op, manifest, existsSync(newDir));
    if (collision) {
      outcomes.push({ op, status: "refused", reason: collision });
      continue;
    }

    const oldDir = join(contentRoot, op.oldSlug);
    if (existsSync(oldDir)) {
      await rename(oldDir, newDir);
    }

    for (const t of targets) {
      const oldLink = targetSkillPath(t, op.oldSlug);
      const newLink = targetSkillPath(t, op.newSlug);
      // existsSync follows symlinks, so a dangling old symlink (its
      // target was just renamed away) reads as "doesn't exist."
      // Check via lstat to actually see the link itself.
      if (linkOrPathExists(oldLink)) {
        await removeSymlink(oldLink);
      }
      if (existsSync(newDir)) {
        await ensureSymlink(newDir, newLink);
      }
    }

    const entry = manifest.skills[op.oldSlug];
    if (entry) {
      delete manifest.skills[op.oldSlug];
      manifest.skills[op.newSlug] = entry;
    }

    outcomes.push({ op, status: "renamed" });
  }

  return outcomes;
}

function linkOrPathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
