import { slugify } from "./convert.js";
import { type NotionPage, readTitle } from "./notion.js";
import type { Manifest } from "./manifest.js";

/**
 * One detected rename: a manifest entry whose Notion page now has a
 * different slugified title than the entry's `source_slug`. We don't
 * rename the on-disk dir or the agent symlinks — those are pinned to
 * `local_slug` for muscle-memory stability — only the manifest's
 * `source_slug` field updates. To realign on-disk to a new Notion
 * title, the user uninstalls and reinstalls.
 */
export interface RenameOp {
  pageId: string;
  localSlug: string;
  oldSourceSlug: string;
  newSourceSlug: string;
}

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
    if (newSlug === entry.source_slug) continue;
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
 * Apply rename ops to a manifest in-place. Updates each entry's
 * `source_slug` field; nothing else changes. Returns the same manifest
 * object for fluent use.
 */
export function applyRenames(manifest: Manifest, ops: RenameOp[]): Manifest {
  for (const op of ops) {
    const entry = manifest.skills[op.localSlug];
    if (!entry) continue;
    entry.source_slug = op.newSourceSlug;
  }
  return manifest;
}
