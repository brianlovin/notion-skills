import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SCOPE_FILE } from "./paths.js";
import type { Source } from "./sources.js";
import { deriveKey, sanitiseSources } from "./sources.js";

/**
 * Local state that ties this machine to one or more Notion databases.
 * `sources` is the multi-database registry; `targets` and `gen_agent`
 * are machine-wide (a user's preferred agent CLIs don't change per
 * source).
 */
export interface Scope {
  version: 2;
  sources: Source[];
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
 * Pre-multi-source on-disk shape. One database, fields at top level. We
 * read it transparently and rewrite as v2 on the next save.
 */
interface ScopeV1 {
  database_id: string;
  data_source_id: string;
  database_title?: string;
  targets?: string[];
  gen_agent?: string;
  // Deprecated fields tolerated on read; dropped on write.
  exclude_skills?: string[];
  filter?: { exclude_skills?: string[] };
}

/** Current on-disk shape. */
interface ScopeV2OnDisk {
  version: 2;
  sources: Source[];
  targets?: string[];
  gen_agent?: string;
}

type AnyScope = ScopeV1 | ScopeV2OnDisk;

function isV2(raw: AnyScope): raw is ScopeV2OnDisk {
  return (raw as ScopeV2OnDisk).version === 2 && Array.isArray((raw as ScopeV2OnDisk).sources);
}

/**
 * Promote a v1 scope into v2 by wrapping its single database into a
 * source. The key is derived from the database title; the source is
 * marked default since it's the only one. The migration is in-memory —
 * the on-disk file isn't rewritten until the next save (so a read-only
 * inspection like `list` doesn't mutate state behind the user's back).
 */
export function migrateV1ToV2(v1: ScopeV1): ScopeV2OnDisk {
  const title = v1.database_title ?? "Skills Store";
  const key = deriveKey(title, new Set());
  const source: Source = {
    key,
    name: title,
    database_id: v1.database_id,
    data_source_id: v1.data_source_id,
    default: true,
    added_at: new Date().toISOString(),
  };
  return {
    version: 2,
    sources: [source],
    targets: v1.targets ?? [],
    gen_agent: v1.gen_agent,
  };
}

/**
 * Load the active scope from `~/.notion-skills/scope.json`. Returns
 * null if the file doesn't exist (notion-skills hasn't been initialised
 * yet). Auto-migrates v1 in memory; calls to `writeScope` persist the
 * migration on next write.
 */
export async function getScope(): Promise<Scope | null> {
  const raw = await readJson<AnyScope>(SCOPE_FILE);
  if (!raw) return null;
  const v2 = isV2(raw) ? raw : migrateV1ToV2(raw as ScopeV1);
  return {
    version: 2,
    sources: sanitiseSources(v2.sources),
    targets: v2.targets ?? [],
    gen_agent: v2.gen_agent,
    path: SCOPE_FILE,
  };
}

export interface WritableScope {
  sources: Source[];
  targets: string[];
  gen_agent?: string;
}

export async function writeScope(scope: WritableScope): Promise<void> {
  const payload: ScopeV2OnDisk = {
    version: 2,
    sources: sanitiseSources(scope.sources),
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
