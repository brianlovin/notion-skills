import chalk from "chalk";
import { getScope } from "../scope.js";
import { printSummary, runSync } from "../sync.js";

interface SyncOptions {
  /** Hide per-skill content diffs (default: shown). */
  noDiff?: boolean;
}

/**
 * Pull-only: fetch the latest from Notion and reconcile local symlinks.
 *
 * The push direction (uploading local-only skills to Notion) belongs to
 * `publish` (explicit user action). Surfacing it here every sync would
 * nag users who deliberately keep some skills off Notion.
 *
 * Per-skill diffs are shown by default so the user sees what changed
 * on each pull. Pass `--no-diff` for the older terse output.
 */
export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  const label =
    scope.sources.length === 1
      ? scope.sources[0]!.name
      : `${scope.sources.length} sources`;
  console.log(chalk.bold(`\nSyncing ${label}`));
  const summary = await runSync(scope, { showDiff: !options.noDiff });
  printSummary(summary);
}
