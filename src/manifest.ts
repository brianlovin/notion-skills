import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface ManifestEntry {
  page_id: string;
  last_edited_time: string;
  hash: string;
  tags: string[];
  description: string;
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
  description: string;
  tags: string[];
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
    // Notion's `last_edited_time` does NOT bump on property-only changes
    // (e.g. tagging, description edits). So we also diff tags + description
    // to catch property-only updates.
    if (
      old.last_edited_time !== c.lastEditedTime ||
      old.description !== c.description ||
      !sameStringArrays(old.tags, c.tags)
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

function sameStringArrays(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}
