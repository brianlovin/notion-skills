import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { MANIFEST_FILE } from "./paths.js";
import { defaultSource, type Source } from "./sources.js";

/**
 * Per-installed-skill state. Manifest is keyed by `local_slug` (the
 * directory name on disk and what every agent CLI sees) — that's the
 * one canonical identity. `source_key` + `source_slug` together form
 * the "global" identifier `<source>/<source_slug>`; we never use that
 * compound string as a key.
 *
 * After install, `local_slug === source_slug` unless a slug-collision
 * forced auto-namespace at install time. After a Notion-side rename,
 * `source_slug` is updated to match the new title; `local_slug` is
 * also updated if the new source_slug doesn't collide with another
 * installed skill, otherwise it stays stable.
 */
export interface ManifestEntry {
  /** The configured Source's stable key. */
  source_key: string;
  /**
   * The skill's slug as derived from its Notion page title. Updates
   * automatically on rename detection. Equals `local_slug` in the
   * common case; differs only when collision avoidance forced the
   * local_slug to be auto-namespaced.
   */
  source_slug: string;
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
  /**
   * Relative paths of sibling files round-tripped through Notion as
   * child pages. When present and non-empty, the skill is multi-file
   * and `list`'s drift check always takes the slow path — parent's
   * `last_edited_time` doesn't bump on child-only edits, so the fast
   * path can't see them.
   */
  files?: string[];
}

export interface Manifest {
  version: 2;
  last_synced_at: string;
  /**
   * Drift-hash scheme version. When the manifest's hash_v is older than
   * src/page-hash.ts:HASH_V, drift checks treat existing entries as
   * "needs rebaseline" — they recompute hashes from current page state
   * without flagging drift.
   */
  hash_v: number;
  /** Keyed by local_slug (the dir name on disk). */
  skills: Record<string, ManifestEntry>;
}

// ---------- v1 → v2 migration ----------

interface ManifestV1Entry {
  page_id: string;
  last_edited_time: string;
  props_hash: string;
  body_hash?: string;
  local_hash?: string;
  files?: string[];
}

interface ManifestV1 {
  version: 1;
  database_id: string;
  data_source_id: string;
  last_synced_at: string;
  hash_v?: number;
  skills: Record<string, ManifestV1Entry>;
}

type AnyManifest = Manifest | ManifestV1 | (Omit<ManifestV1, "version"> & { version?: number });

function isV2(m: AnyManifest): m is Manifest {
  return (m as Manifest).version === 2;
}

/**
 * Promote a v1 manifest to v2 by attaching every entry to the given
 * default source key. The source_slug for each entry is the existing
 * key (which was the slug under v1's flat keying).
 *
 * The caller passes the default source key; we don't read scope from
 * disk here so manifest migration stays a pure function.
 */
export function migrateV1ToV2(v1: ManifestV1 | (Omit<ManifestV1, "version"> & { version?: number }), defaultSourceKey: string): Manifest {
  const skills: Record<string, ManifestEntry> = {};
  for (const [slug, entry] of Object.entries(v1.skills ?? {})) {
    skills[slug] = {
      source_key: defaultSourceKey,
      source_slug: slug,
      page_id: entry.page_id,
      last_edited_time: entry.last_edited_time,
      props_hash: entry.props_hash,
      body_hash: entry.body_hash,
      local_hash: entry.local_hash,
      files: entry.files,
    };
  }
  return {
    version: 2,
    last_synced_at: v1.last_synced_at ?? new Date(0).toISOString(),
    hash_v: v1.hash_v ?? 2,
    skills,
  };
}

export function emptyManifest(): Manifest {
  return {
    version: 2,
    last_synced_at: new Date(0).toISOString(),
    hash_v: 3,
    skills: {},
  };
}

export async function readManifest(file: string, defaultSourceKey: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as AnyManifest;
    if (isV2(parsed)) return parsed;
    return migrateV1ToV2(parsed as ManifestV1, defaultSourceKey);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read the manifest from its canonical location, deriving the v1→v2
 * migration default-source-key from the scope's configured sources.
 *
 * Most commands want this; only commands that operate against a
 * specific Source for migration purposes (`migrate`, `source rename`)
 * should call `readManifest` directly with an explicit key.
 */
export async function loadManifest(sources: Source[]): Promise<Manifest | null> {
  const defaultKey = defaultSource(sources)?.key ?? sources[0]?.key ?? "default";
  return readManifest(MANIFEST_FILE, defaultKey);
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
  toRemove: string[];  // local_slug values to delete (in old, not in new keep set)
  unchanged: string[]; // local_slug values that can be skipped
}

export interface CurrentPageSummary {
  /** Source-side slug (Notion title slugified). */
  name: string;
  /** Source the page belongs to (sync iterates this scope). */
  source_key: string;
  pageId: string;
  lastEditedTime: string;
  /**
   * Hash over every spec property of this page (description, model,
   * effort, etc). Notion does NOT bump last_edited_time for property-only
   * edits, so we compare this to catch them.
   */
  propsHash: string;
}

/**
 * Diff a v2 manifest against a list of currently-visible pages, scoped
 * to the source(s) the pages came from. Pages that aren't in the
 * provided source set are left alone (their entries stay in the
 * manifest untouched — could belong to a different source not being
 * synced this round).
 */
export function diffManifest(
  oldManifest: Manifest,
  current: CurrentPageSummary[],
  scopedSourceKeys: Set<string>,
): DiffResult {
  const currentByLocal = new Map<string, CurrentPageSummary>();
  // Match an installed entry to a current page by source_key + source_slug.
  for (const c of current) {
    for (const [localSlug, old] of Object.entries(oldManifest.skills)) {
      if (old.source_key === c.source_key && old.source_slug === c.name) {
        currentByLocal.set(localSlug, c);
      }
    }
  }

  const toFetch: string[] = [];
  const unchanged: string[] = [];

  // For currently-visible pages: are they installed? If not, leave alone
  // (sync is install-narrowed). If yes, decide unchanged vs toFetch.
  for (const [localSlug, old] of Object.entries(oldManifest.skills)) {
    if (!scopedSourceKeys.has(old.source_key)) continue;
    const c = currentByLocal.get(localSlug);
    if (!c) {
      // Installed but no longer visible in source — remove.
      continue;
    }
    if (old.page_id !== c.pageId || !entryMatches(old, c)) {
      toFetch.push(c.pageId);
    } else {
      unchanged.push(localSlug);
    }
  }

  // Removals: installed entries from a scoped source whose page is gone.
  const visibleByLocal = new Set(currentByLocal.keys());
  const toRemove: string[] = [];
  for (const [localSlug, entry] of Object.entries(oldManifest.skills)) {
    if (!scopedSourceKeys.has(entry.source_key)) continue;
    if (!visibleByLocal.has(localSlug)) toRemove.push(localSlug);
  }

  return { toFetch, toRemove, unchanged };
}
