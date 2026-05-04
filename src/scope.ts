import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PROJECT_SCOPE_FILENAME,
  SCOPE_FILE,
  type TargetKey,
} from "./paths.js";

export interface FilterConfig {
  include_tags?: string[];
  exclude_tags?: string[];
  include_skills?: string[];
  exclude_skills?: string[];
}

export interface ScopeBase {
  database_id: string;
  data_source_id: string;
  database_title?: string;
  filter: FilterConfig;
}

export interface GlobalScope extends ScopeBase {
  type: "global";
  targets: TargetKey[];
  path: string;
}

export interface ProjectScope extends ScopeBase {
  type: "project";
  root: string;
  path: string;
}

export type Scope = GlobalScope | ProjectScope;

interface RawScope extends ScopeBase {
  targets?: TargetKey[];
}

// ---------- discovery ----------

export function findProjectScopePath(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = resolve(dir, PROJECT_SCOPE_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------- read ----------

/**
 * Load the active scope. Auto-detects: if there's a `.notion-skills.json`
 * in or above `cwd`, that's the project scope; otherwise the global scope
 * at `~/.notion-skills/scope.json` (or null if neither exists).
 *
 * Pass `prefer: "global"` or `prefer: "project"` to force a particular
 * scope. `prefer: "project"` returns null if cwd isn't inside a repo with
 * a `.notion-skills.json`.
 */
export async function getScope(
  opts: { prefer?: "global" | "project"; cwd?: string } = {},
): Promise<Scope | null> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.prefer === "global") return readGlobal();
  if (opts.prefer === "project") {
    const path = findProjectScopePath(cwd);
    return path ? readProject(path) : null;
  }
  // Auto-detect: project takes precedence when present.
  const projectPath = findProjectScopePath(cwd);
  if (projectPath) return readProject(projectPath);
  return readGlobal();
}

async function readGlobal(): Promise<GlobalScope | null> {
  const raw = await readJson<RawScope>(SCOPE_FILE);
  if (!raw) return null;
  return {
    type: "global",
    database_id: raw.database_id,
    data_source_id: raw.data_source_id,
    database_title: raw.database_title,
    filter: raw.filter ?? {},
    targets: raw.targets ?? [],
    path: SCOPE_FILE,
  };
}

async function readProject(scopePath: string): Promise<ProjectScope | null> {
  const raw = await readJson<RawScope>(scopePath);
  if (!raw) return null;
  return {
    type: "project",
    database_id: raw.database_id,
    data_source_id: raw.data_source_id,
    database_title: raw.database_title,
    filter: raw.filter ?? {},
    root: dirname(scopePath),
    path: scopePath,
  };
}

// ---------- write ----------

export async function writeGlobalScope(scope: Omit<GlobalScope, "type" | "path">): Promise<void> {
  const payload: RawScope = {
    database_id: scope.database_id,
    data_source_id: scope.data_source_id,
    database_title: scope.database_title,
    targets: scope.targets,
    filter: scope.filter,
  };
  await writeJson(SCOPE_FILE, payload);
}

export async function writeProjectScope(
  cwd: string,
  scope: Omit<ProjectScope, "type" | "root" | "path">,
): Promise<string> {
  const scopePath = resolve(cwd, PROJECT_SCOPE_FILENAME);
  const payload: RawScope = {
    database_id: scope.database_id,
    data_source_id: scope.data_source_id,
    database_title: scope.database_title,
    filter: scope.filter,
  };
  await writeJson(scopePath, payload);
  return scopePath;
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

export async function deleteScope(scope: Scope): Promise<void> {
  await rm(scope.path, { force: true });
}
