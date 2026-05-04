import chalk from "chalk";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { NotionClient, findMultiSelectProperty } from "../notion.js";
import {
  findProjectScopePath,
  writeGlobalScope,
  writeProjectScope,
} from "../scope.js";
import { detectTargets } from "../targets.js";
import { KNOWN_TARGETS } from "../known-targets.js";
import type { TargetKey } from "../paths.js";
import { assertNtnInstalled } from "../ntn.js";
import { parseNotionId } from "../parse-id.js";

interface InitOptions {
  global?: boolean;
  project?: boolean;
}

export async function initCommand(opts: InitOptions): Promise<void> {
  await assertNtnInstalled();
  const client = new NotionClient();

  const mode = await chooseMode(opts);
  const source = await chooseSource();

  const { databaseId, dataSourceId, databaseTitle } =
    source === "existing"
      ? await pickExistingDatabase(client)
      : await createNewDatabase(client);

  // Inspect schema to find Tags multi-select for filtering and validate Description.
  const dataSource = await client.getDataSource(dataSourceId);
  validateSchema(dataSource);

  const tagsProp = findMultiSelectProperty(dataSource as any, "Tags");
  if (!tagsProp) {
    console.log(
      chalk.yellow(
        `Note: no multi_select property named "Tags" found. Tag filters will be a no-op until you add one in Notion.`,
      ),
    );
  }

  const includeTags = tagsProp && tagsProp.options.length
    ? await checkbox({
        message: "Include tags (leave empty to include all):",
        choices: tagsProp.options.map((t) => ({ name: t, value: t })),
        required: false,
      })
    : [];

  const excludeTags = tagsProp && tagsProp.options.length && includeTags.length === 0
    ? await checkbox({
        message: "Exclude tags (leave empty for none):",
        choices: tagsProp.options
          .filter((t) => !includeTags.includes(t))
          .map((t) => ({ name: t, value: t })),
        required: false,
      })
    : [];

  if (mode === "global") {
    const targets = await pickTargets();
    await writeGlobalScope({
      database_id: databaseId,
      data_source_id: dataSourceId,
      database_title: databaseTitle,
      targets,
      filter: { include_tags: includeTags, exclude_tags: excludeTags },
    });
    console.log(
      chalk.green(`\n✓ Saved global scope. Targets: ${targets.join(", ")}.`),
    );
    console.log(`Next: ${chalk.bold("notion-skills sync")}`);
  } else {
    const cwd = process.cwd();
    if (findProjectScopePath(cwd)) {
      const ok = await confirm({
        message: ".notion-skills.json already exists in this tree. Overwrite?",
        default: false,
      });
      if (!ok) {
        console.log(chalk.dim("Aborted."));
        return;
      }
    }
    const path = await writeProjectScope(cwd, {
      database_id: databaseId,
      data_source_id: dataSourceId,
      database_title: databaseTitle,
      filter: { include_tags: includeTags, exclude_tags: excludeTags },
    });
    console.log(chalk.green(`\n✓ Saved project scope at ${path}.`));
    console.log(`Commit this file so collaborators get the same skills.`);
    console.log(`Next: ${chalk.bold("notion-skills sync")}`);
  }
}

async function chooseMode(opts: InitOptions): Promise<"global" | "project"> {
  if (opts.global && opts.project) {
    throw new Error("Pass only one of --global / --project.");
  }
  if (opts.global) return "global";
  if (opts.project) return "project";

  const inProject = !!findProjectScopePath(process.cwd());
  return select({
    message: "Which scope?",
    choices: [
      {
        name: "Global (sync to ~/.claude/skills, ~/.codex/skills)",
        value: "global" as const,
      },
      {
        name: inProject
          ? "Project (overwrite this repo's .notion-skills.json)"
          : "Project (write .notion-skills.json here, commit to share with team)",
        value: "project" as const,
      },
    ],
  });
}

async function chooseSource(): Promise<"existing" | "new"> {
  return select({
    message: "Where are your skills coming from?",
    choices: [
      {
        name: "I have an existing Notion database — paste its URL or ID",
        value: "existing" as const,
      },
      {
        name: "Create a fresh Skills database under a parent page",
        value: "new" as const,
      },
    ],
  });
}

async function pickExistingDatabase(client: NotionClient): Promise<{
  databaseId: string;
  dataSourceId: string;
  databaseTitle?: string;
}> {
  const raw = await input({
    message: "Paste the Skills database URL or ID:",
    validate: (v) => parseNotionId(v) !== null || "Couldn't find a Notion ID in that input.",
  });
  const databaseId = parseNotionId(raw)!;

  console.log(chalk.dim(`\nLooking up database ${databaseId}...`));
  let db;
  try {
    db = await client.getDatabase(databaseId);
  } catch (err) {
    throw new Error(
      `Couldn't load that ID as a database. Make sure the URL points to a database (not a page or block).\n${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (db.data_sources.length === 0) {
    throw new Error(
      `Database "${db.title}" has no data sources. This is unexpected — Notion's 2025-09-03 API should always expose at least one.`,
    );
  }

  let dataSourceId: string;
  if (db.data_sources.length === 1) {
    dataSourceId = db.data_sources[0]!.id;
  } else {
    dataSourceId = await select({
      message: "This database has multiple data sources — pick one:",
      choices: db.data_sources.map((ds) => ({ name: ds.name, value: ds.id })),
    });
  }

  console.log(chalk.green(`✓ Found "${db.title}".`));
  return { databaseId: db.id, dataSourceId, databaseTitle: db.title };
}

async function createNewDatabase(client: NotionClient): Promise<{
  databaseId: string;
  dataSourceId: string;
  databaseTitle: string;
}> {
  const parentRaw = await input({
    message: "Paste the URL of the parent page in Notion (database will live inside it):",
    validate: (v) => parseNotionId(v) !== null || "Couldn't find a Notion ID in that input.",
  });
  const parentId = parseNotionId(parentRaw)!;

  const title = await input({
    message: "Database title:",
    default: "Skills",
  });

  console.log(chalk.dim(`\nCreating database "${title}"...`));
  const db = await client.createSkillsDatabase(parentId, title);
  if (db.data_sources.length === 0) {
    throw new Error("Database was created but Notion did not return a data source.");
  }
  console.log(
    chalk.green(`✓ Created database. Add some pages in Notion, then run sync.`),
  );

  return {
    databaseId: db.id,
    dataSourceId: db.data_sources[0]!.id,
    databaseTitle: db.title,
  };
}

function validateSchema(dataSource: {
  properties: Record<string, { type: string; name: string }>;
}): void {
  const props = Object.values(dataSource.properties);
  const hasDescription = props.some(
    (p) => p.type === "rich_text" && p.name.toLowerCase() === "description",
  );
  if (!hasDescription) {
    console.log(
      chalk.yellow(
        `\nWarning: this database has no rich_text property called "Description".\n` +
          `Pages without a Description will be skipped during sync.\n` +
          `Add a "Description" property in Notion to fix.`,
      ),
    );
  }
}

async function pickTargets(): Promise<TargetKey[]> {
  const detected = detectTargets();
  const choices = detected.map((t) => ({
    name: t.installed ? t.label : `${t.label} ${chalk.dim("(not installed)")}`,
    value: t.key,
    checked: t.installed,
  }));

  const picked = await checkbox({
    message: "Sync targets:",
    choices,
    required: true,
    validate: (vals) => (vals.length === 0 ? "Pick at least one." : true),
  });

  return picked.length > 0 ? picked : KNOWN_TARGETS.map((t) => t.key);
}
