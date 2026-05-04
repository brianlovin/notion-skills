import chalk from "chalk";
import {
  findProjectScopePath,
  readGlobalScope,
  readProjectScope,
  type Scope,
} from "../scope.js";
import { printSummary, runSync } from "../sync.js";

interface SyncOptions {
  global?: boolean;
  project?: boolean;
  all?: boolean;
}

export async function syncCommand(
  names: string[],
  opts: SyncOptions,
): Promise<void> {
  const scopes = await resolveScopes(opts);

  if (scopes.length === 0) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first (or `notion-skills init --project` inside a repo).",
    );
  }

  for (const scope of scopes) {
    console.log(
      chalk.bold(
        `\nSyncing ${scope.type} scope${
          scope.type === "project" ? ` (${scope.path})` : ""
        }`,
      ),
    );
    const summary = await runSync(scope, names);
    printSummary(summary);
  }
}

async function resolveScopes(opts: SyncOptions): Promise<Scope[]> {
  const scopes: Scope[] = [];

  if (opts.all) {
    const g = await readGlobalScope();
    if (g) scopes.push(g);
    const projPath = findProjectScopePath(process.cwd());
    if (projPath) {
      const p = await readProjectScope(projPath);
      if (p) scopes.push(p);
    }
    return scopes;
  }

  if (opts.global) {
    const g = await readGlobalScope();
    if (g) scopes.push(g);
    return scopes;
  }

  if (opts.project) {
    const projPath = findProjectScopePath(process.cwd());
    if (projPath) {
      const p = await readProjectScope(projPath);
      if (p) scopes.push(p);
    }
    return scopes;
  }

  // Auto-detect: prefer project if found, else global.
  const projPath = findProjectScopePath(process.cwd());
  if (projPath) {
    const p = await readProjectScope(projPath);
    if (p) {
      scopes.push(p);
      return scopes;
    }
  }
  const g = await readGlobalScope();
  if (g) scopes.push(g);
  return scopes;
}
