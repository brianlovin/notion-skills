import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SCOPE_FILE } from "./paths.js";

export interface Scope {
  database_id: string;
  data_source_id: string;
  database_title?: string;
  targets: string[];
  /**
   * Optional denylist: skill slugs we should NOT sync. Defaults to syncing
   * everything in the database. Edit the JSON file by hand to set; there's
   * no UI for it (rare enough to not warrant a command).
   */
  exclude_skills?: string[];
  /** Path to the scope file on disk. */
  path: string;
}

/**
 * Raw on-disk shape. We accept exclude_skills either at top-level (current
 * shape) or under a legacy `filter` object (pre-v0.3) for backwards
 * compatibility on read; we always write the new shape.
 */
interface RawScope {
  database_id: string;
  data_source_id: string;
  database_title?: string;
  targets?: string[];
  exclude_skills?: string[];
  filter?: { exclude_skills?: string[] };
}

/**
 * Load the active scope from `~/.notion-skills/scope.json`.
 * Returns null if the file doesn't exist (notion-skills hasn't been
 * initialised yet).
 */
export async function getScope(): Promise<Scope | null> {
  const raw = await readJson<RawScope>(SCOPE_FILE);
  if (!raw) return null;
  return {
    database_id: raw.database_id,
    data_source_id: raw.data_source_id,
    database_title: raw.database_title,
    targets: raw.targets ?? [],
    exclude_skills: raw.exclude_skills ?? raw.filter?.exclude_skills,
    path: SCOPE_FILE,
  };
}

export async function writeScope(scope: Omit<Scope, "path">): Promise<void> {
  const payload: RawScope = {
    database_id: scope.database_id,
    data_source_id: scope.data_source_id,
    database_title: scope.database_title,
    targets: scope.targets,
    exclude_skills: scope.exclude_skills,
  };
  await writeJson(SCOPE_FILE, payload);
}

export async function deleteScope(): Promise<void> {
  await rm(SCOPE_FILE, { force: true });
}

// ---------- helpers ----------

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
