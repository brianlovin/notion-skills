import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface ManifestEntry {
  page_id: string;
  last_edited_time: string;
  /** Hash of the rendered SKILL.md content. */
  hash: string;
  tags: string[];
  description: string;
  /**
   * Hash of all spec properties (description + tags + when_to_use + ... etc).
   * Notion does NOT bump last_edited_time for property-only edits, so we
   * compare this hash on every sync to detect property changes.
   */
  props_hash?: string;
}

export interface Manifest {
  version: 1;
  database_id: string;
  data_source_id: string;
  last_synced_at: string;
  skills: Record<string, ManifestEntry>;
}

export function emptyManifest(databaseId: string, dataSourceId: string): Manifest {
  return {
    version: 1,
    database_id: databaseId,
    data_source_id: dataSourceId,
    last_synced_at: new Date(0).toISOString(),
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

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function hashContent(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
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
   * Hash over every spec property of this page (description, tags, model,
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
    if (!old || old.page_id !== c.pageId) {
      toFetch.push(c.pageId);
      continue;
    }
    // last_edited_time covers content-block changes; props_hash covers
    // property-only edits which Notion silently fails to surface in
    // last_edited_time.
    if (
      old.last_edited_time !== c.lastEditedTime ||
      old.props_hash !== c.propsHash
    ) {
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
