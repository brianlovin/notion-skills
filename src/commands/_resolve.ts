import chalk from "chalk";
import { select } from "@inquirer/prompts";
import type { Scope } from "../scope.js";
import type { Source } from "../sources.js";
import { resolveTargetSource } from "../sources.js";

/**
 * Resolve the single Source a command should target. Wraps
 * `resolveTargetSource` with friendly UX:
 *   - 0 sources → throws "run init" (caught by the CLI top-level)
 *   - explicit unknown key → throws with a list of valid keys
 *   - ambiguous in TTY → interactive picker
 *   - ambiguous in non-TTY → throws with --source hint
 *
 * Used by every command that operates on exactly one source.
 */
export async function pickSource(
  flag: string | undefined,
  scope: Scope,
): Promise<Source> {
  const r = resolveTargetSource(flag, scope.sources);
  if (r.ok) return r.source;

  if (r.reason === "no_sources") {
    throw new Error(
      "notion-skills isn't configured yet.\n  → notion-skills init",
    );
  }
  if (r.reason === "unknown_key") {
    const known = scope.sources.map((s) => s.key).join(", ");
    throw new Error(
      `Unknown source "${r.key}". Configured sources: ${known}.`,
    );
  }
  // ambiguous
  if (!process.stdin.isTTY) {
    throw new Error(
      "Multiple sources configured and no default set.\n" +
        `  Pass --source <key>. One of: ${r.sources.map((s) => s.key).join(", ")}.`,
    );
  }
  return await select<Source>({
    message: "Which source?",
    choices: r.sources.map((s) => ({
      name: `${s.key} ${chalk.dim(`— ${s.name}`)}`,
      value: s,
    })),
  });
}
