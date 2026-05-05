import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface ManifestEntry {
  page_id: string;
  /**
   * Best-effort cache of the page's `last_edited_time` AS OF the last
   * write to this entry. Used as a fast-path optimization: when the live
   * value matches, the page is unambiguously unchanged and we can skip
   * fetching blocks. When it differs, fall through to body_hash /
   * props_hash comparison — the source of truth for drift detection.
   * Notion bumps last_edited_time on every PATCH (including metric-only
   * edits like Installs), so it's a hint, not authoritative.
   */
  last_edited_time: string;
  /**
   * Hash of behavior-affecting properties (description, when_to_use,
   * model, agent, allowed_tools, etc). Excludes Tags (taxonomyOnly) and
   * Installs (metricOnly) — neither affects how a model executes the
   * skill, so editing them isn't drift. See src/page-hash.ts.
   */
  props_hash: string;
  /**
   * Hash of the rendered markdown body. Combined with props_hash, this is
   * the authoritative drift signal. Optional for backward-compat with
   * pre-hash_v=2 manifests; the next list/sync silently rebaselines.
   */
  body_hash?: string;
  /**
   * sha256 hash (truncated to 16 chars) of the SKILL.md file as written
   * to disk by the last sync. Drift on this hash is how `sync` detects
   * that the user edited a skill locally and needs to push it back to
   * Notion. Optional: missing on legacy manifests; `sync` re-hashes and
   * stores it on next write without firing a spurious push.
   */
  local_hash?: string;
}

export interface Manifest {
  version: 1;
  database_id: string;
  data_source_id: string;
  last_synced_at: string;
  /**
   * Drift-hash scheme version. When the manifest's hash_v is older than
   * src/page-hash.ts:HASH_V, drift checks treat existing entries as
   * "needs rebaseline" — they recompute hashes from current page state
   * without flagging drift. Optional for forward-compat with manifests
   * written before this field existed (treated as 1).
   */
  hash_v?: number;
  skills: Record<string, ManifestEntry>;
}

export function emptyManifest(databaseId: string, dataSourceId: string): Manifest {
  return {
    version: 1,
    database_id: databaseId,
    data_source_id: dataSourceId,
    last_synced_at: new Date(0).toISOString(),
    hash_v: 2,
    skills: {},
  };
}

export async function readManifest(file: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Atomic write: serialise to a sibling .tmp file, fsync-after-rename via
 * the kernel's atomic-replace semantics. A crash mid-write leaves either
 * the previous manifest or the new one — never a half-written file.
 */
export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export function hashContent(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * Lightweight identity test before we trust an old entry. Older manifests
 * may be missing props_hash entirely — those count as "needs refetch".
 */
function entryMatches(
  old: ManifestEntry,
  current: { lastEditedTime: string; propsHash: string },
): boolean {
  return (
    old.last_edited_time === current.lastEditedTime &&
    old.props_hash === current.propsHash
  );
}

export interface DiffResult {
  toFetch: string[];   // page ids whose content needs re-fetching (new or changed)
  toRemove: string[];  // skill names to delete (in old, not in new keep set)
  unchanged: string[]; // skill names that can be skipped
}

export interface CurrentPageSummary {
  name: string;
  pageId: string;
  lastEditedTime: string;
  /**
   * Hash over every spec property of this page (description, model,
   * effort, etc). Notion does NOT bump last_edited_time for property-only
   * edits, so we compare this to catch them.
   */
  propsHash: string;
}

export function diffManifest(
  oldManifest: Manifest,
  current: CurrentPageSummary[],
): DiffResult {
  const currentByName = new Map(current.map((c) => [c.name, c]));
  const toFetch: string[] = [];
  const unchanged: string[] = [];

  for (const c of current) {
    const old = oldManifest.skills[c.name];
    if (!old || old.page_id !== c.pageId || !entryMatches(old, c)) {
      toFetch.push(c.pageId);
    } else {
      unchanged.push(c.name);
    }
  }

  const toRemove: string[] = [];
  for (const name of Object.keys(oldManifest.skills)) {
    if (!currentByName.has(name)) toRemove.push(name);
  }

  return { toFetch, toRemove, unchanged };
}
