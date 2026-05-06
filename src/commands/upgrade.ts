import chalk from "chalk";
import { getScope } from "../scope.js";
import { NotionClient } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { pickSource } from "./_resolve.js";

interface UpgradeOptions {
  source?: string;
  all?: boolean;
}

export async function upgradeCommand(opts: UpgradeOptions = {}): Promise<void> {
  await assertNtnInstalled();

  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  const client = new NotionClient();
  // --all → every source. Otherwise pick one (default / flag / picker).
  const sources = opts.all ? scope.sources : [await pickSource(opts.source, scope)];

  for (const source of sources) {
    if (sources.length > 1) {
      console.log(chalk.bold(`\n${source.key}`) + chalk.dim(` — ${source.name}`));
    }
    console.log(chalk.dim(`Inspecting "${source.name}" schema...`));
    const { added, retyped } = await client.upgradeSchema(source.data_source_id);
    await client.ensureDefaultViews(source.database_id, source.data_source_id);

    if (added.length === 0 && retyped.length === 0) {
      console.log(chalk.green("✓ Schema and views are up to date."));
      continue;
    }
    console.log(chalk.green(`✓ ${added.length} added, ${retyped.length} retyped.`));
    for (const name of added) console.log(`  ${chalk.green("+")} ${name}`);
    for (const name of retyped) {
      console.log(`  ${chalk.yellow("~")} ${name} ${chalk.dim("(type changed)")}`);
    }
  }
  console.log("");
  console.log(
    chalk.dim(
      "Re-run `notion-skills sync` to surface the new properties on existing pages.",
    ),
  );
}
