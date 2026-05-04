import chalk from "chalk";
import { checkbox } from "@inquirer/prompts";
import { NotionClient, findMultiSelectProperty } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import {
  findProjectScopePath,
  readGlobalScope,
  readProjectScope,
  writeGlobalScope,
  writeProjectScope,
  type Scope,
} from "../scope.js";

export async function tagsCommand(): Promise<void> {
  const scope = await currentScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  await assertNtnInstalled();
  const client = new NotionClient();

  const ds = await client.getDataSource(scope.data_source_id);
  const tags = findMultiSelectProperty(ds as any, "Tags");
  if (!tags || tags.options.length === 0) {
    console.log(
      chalk.yellow(
        `No multi_select "Tags" property found on this database. Add one in Notion to use tag filters.`,
      ),
    );
    return;
  }

  const newInclude = await checkbox({
    message: "Tags to INCLUDE (skill must have at least one):",
    choices: tags.options.map((t) => ({
      name: t,
      value: t,
      checked: scope.filter.include_tags?.includes(t) ?? false,
    })),
    required: false,
  });

  const remaining = tags.options.filter((t) => !newInclude.includes(t));
  const newExclude = await checkbox({
    message: "Tags to EXCLUDE:",
    choices: remaining.map((t) => ({
      name: t,
      value: t,
      checked: scope.filter.exclude_tags?.includes(t) ?? false,
    })),
    required: false,
  });

  const updatedFilter = {
    ...scope.filter,
    include_tags: newInclude,
    exclude_tags: newExclude,
  };

  if (scope.type === "global") {
    await writeGlobalScope({
      database_id: scope.database_id,
      data_source_id: scope.data_source_id,
      database_title: scope.database_title,
      targets: scope.targets,
      filter: updatedFilter,
    });
  } else {
    await writeProjectScope(scope.root, {
      database_id: scope.database_id,
      data_source_id: scope.data_source_id,
      database_title: scope.database_title,
      filter: updatedFilter,
    });
  }

  console.log(chalk.green(`\n✓ Tag filters updated.`));
  console.log(`Run ${chalk.bold("notion-skills sync")} to apply.`);
}

async function currentScope(): Promise<Scope | null> {
  const projPath = findProjectScopePath(process.cwd());
  if (projPath) return readProjectScope(projPath);
  return readGlobalScope();
}
