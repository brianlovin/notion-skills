import chalk from "chalk";
import ora from "ora";
import {
  findProjectScopePath,
  readGlobalScope,
  readProjectScope,
  type Scope,
} from "../scope.js";
import { NotionClient } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";

export async function upgradeCommand(): Promise<void> {
  await assertNtnInstalled();

  const scope = await currentScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  const client = new NotionClient();
  const spinner = ora(
    `Inspecting "${scope.database_title ?? scope.database_id}" schema...`,
  ).start();

  try {
    const { added, retyped } = await client.upgradeSchema(scope.data_source_id);
    if (added.length === 0 && retyped.length === 0) {
      spinner.succeed("Schema is already up to date.");
      return;
    }
    spinner.succeed(
      `${added.length} added, ${retyped.length} retyped.`,
    );
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
  } catch (err) {
    spinner.fail("Schema upgrade failed.");
    throw err;
  }
}

async function currentScope(): Promise<Scope | null> {
  const projPath = findProjectScopePath(process.cwd());
  if (projPath) return readProjectScope(projPath);
  return readGlobalScope();
}
