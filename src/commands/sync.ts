import chalk from "chalk";
import { getScope, type Scope } from "../scope.js";
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
  if (opts.all) {
    const out: Scope[] = [];
    const g = await getScope({ prefer: "global" });
    if (g) out.push(g);
    const p = await getScope({ prefer: "project" });
    if (p) out.push(p);
    return out;
  }
  if (opts.global) {
    const g = await getScope({ prefer: "global" });
    return g ? [g] : [];
  }
  if (opts.project) {
    const p = await getScope({ prefer: "project" });
    return p ? [p] : [];
  }
  // Auto-detect (project takes precedence when present).
  const s = await getScope();
  return s ? [s] : [];
}
