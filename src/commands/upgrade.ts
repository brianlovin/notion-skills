import chalk from "chalk";
import { getScope } from "../scope.js";
import { NotionClient } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";

export async function upgradeCommand(): Promise<void> {
  await assertNtnInstalled();

  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  const client = new NotionClient();
  console.log(
    chalk.dim(`Inspecting "${scope.database_title ?? scope.database_id}" schema...`),
  );
  const { added, retyped } = await client.upgradeSchema(scope.data_source_id);
  // Reconcile default views (All / Popular / New / Drafts) too —
  // upgrade is the natural place to pick up new views that ship with
  // newer versions, not just schema columns.
  await client.ensureDefaultViews(scope.database_id, scope.data_source_id);

  if (added.length === 0 && retyped.length === 0) {
    console.log(chalk.green("✓ Schema and views are up to date."));
    return;
  }
  console.log(chalk.green(`✓ ${added.length} added, ${retyped.length} retyped.`));
  for (const name of added) {
    console.log(`  ${chalk.green("+")} ${name}`);
  }
  for (const name of retyped) {
    console.log(`  ${chalk.yellow("~")} ${name} ${chalk.dim("(type changed)")}`);
  }
  console.log("");
  console.log(
    chalk.dim(
      "Re-run `notion-skills sync` to surface the new properties on existing pages.",
    ),
  );
}

