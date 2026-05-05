import { existsSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Manifest } from "./manifest.js";
import { hashLocalSkillDir } from "./skill-files.js";

/**
 * One entry in the drift map: the local SKILL.md's content hash differs
 * from what the manifest stored on the last sync, so the user has edited
 * it since then.
 */
export interface LocalDriftEntry {
  name: string;
  pageId: string;
  /** mtime on the local file — used for last-edit-wins conflict resolution. */
  mtime: Date;
  /** Current SKILL.md content; passed straight to migrate's parser on push. */
  mdContent: string;
}

/**
 * What the local state looks like for the skills the manifest tracks.
 *   - `drift`: SKILL.md content has changed since last sync (push candidate).
 *   - `missingPageIds`: SKILL.md is gone — sync should restore it from
 *     Notion regardless of whether the page changed remotely.
 *
 * Manifest entries with `local_hash === undefined` (legacy or just-migrated)
 * are excluded from drift — there's no baseline to compare against, so we
 * can't tell if the user edited. The next sync write stores the hash and
 * detection works from then on.
 */
export interface LocalState {
  drift: Map<string, LocalDriftEntry>;
  missingPageIds: Set<string>;
}

export async function detectLocalState(
  manifest: Manifest,
  contentRoot: string,
): Promise<LocalState> {
  const drift = new Map<string, LocalDriftEntry>();
  const missingPageIds = new Set<string>();

  for (const [name, entry] of Object.entries(manifest.skills)) {
    const skillDir = join(contentRoot, name);
    const file = join(skillDir, "SKILL.md");
    if (!existsSync(file)) {
      // Force a pull so users can recover by `rm`-ing a corrupt or unwanted
      // local copy. We don't try to diff a file that isn't there.
      missingPageIds.add(entry.page_id);
      continue;
    }
    if (entry.local_hash === undefined) {
      // Legacy manifest: no baseline → can't tell if edited. Skip.
      continue;
    }

    let currentHash: string;
    try {
      currentHash = await hashLocalSkillDir(skillDir);
    } catch {
      continue;
    }
    if (currentHash === entry.local_hash) continue;

    let mtime: Date;
    let raw: string;
    try {
      mtime = lstatSync(file).mtime;
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    drift.set(name, { name, pageId: entry.page_id, mtime, mdContent: raw });
  }

  return { drift, missingPageIds };
}
