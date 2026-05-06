import chalk from "chalk";
import { getScope } from "../scope.js";
import { printSummary, runSync } from "../sync.js";

/**
 * Pull-only: fetch the latest from Notion and reconcile local symlinks.
 *
 * The push direction (uploading local-only skills to Notion) belongs to
 * `init` (one-time bulk migration) and `migrate` (explicit user action).
 * Surfacing it here every sync would nag users who deliberately keep
 * some skills off Notion.
 */
export async function syncCommand(): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  const label =
    scope.sources.length === 1
      ? scope.sources[0]!.name
      : `${scope.sources.length} sources`;
  console.log(chalk.bold(`\nSyncing ${label}`));
  const summary = await runSync(scope);
  printSummary(summary);
}
