import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SCOPE_FILE } from "./paths.js";

export interface Scope {
  database_id: string;
  data_source_id: string;
  database_title?: string;
  targets: string[];
  /**
   * The coding-agent CLI key (claude, codex, opencode, gemini) used by
   * `notion-skills gen`. Set on first gen invocation; can be overridden
   * per-run with `--agent`.
   */
  gen_agent?: string;
  /** Path to the scope file on disk. */
  path: string;
}

/**
 * Raw on-disk shape. Older scope files may carry an `exclude_skills`
 * array (or legacy `filter.exclude_skills`); we read silently and drop
 * the field on write since explicit install/uninstall has obsoleted
 * the denylist.
 */
interface RawScope {
  database_id: string;
  data_source_id: string;
  database_title?: string;
  targets?: string[];
  gen_agent?: string;
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
    gen_agent: raw.gen_agent,
    path: SCOPE_FILE,
  };
}

export async function writeScope(scope: Omit<Scope, "path">): Promise<void> {
  const payload: RawScope = {
    database_id: scope.database_id,
    data_source_id: scope.data_source_id,
    database_title: scope.database_title,
    targets: scope.targets,
    gen_agent: scope.gen_agent,
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
