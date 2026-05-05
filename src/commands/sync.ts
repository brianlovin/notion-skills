import chalk from "chalk";
import { getScope } from "../scope.js";
import { printSummary, runSync } from "../sync.js";

export async function syncCommand(names: string[]): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  console.log(chalk.bold(`\nSyncing ${scope.database_title ?? "database"}`));
  const summary = await runSync(scope, names);
  printSummary(summary);
}
