import chalk from "chalk";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { NotionClient, findMultiSelectProperty } from "../notion.js";
import {
  findProjectScopePath,
  getScope,
  writeGlobalScope,
  writeProjectScope,
} from "../scope.js";
import { detectTargets } from "../targets.js";
import { KNOWN_TARGETS, findTargetByKey } from "../known-targets.js";
import { PROJECT_SCOPE_FILENAME, type TargetKey } from "../paths.js";
import { assertNtnInstalled } from "../ntn.js";
import { parseNotionId } from "../parse-id.js";
import { discoverSkills } from "../migrate.js";
import { migrateCommand } from "./migrate.js";
import { runSync, printSummary } from "../sync.js";

interface InitOptions {
  global?: boolean;
  project?: boolean;
}

/**
 * Three intents a user might bring to `init`. Detected up front so the
 * rest of the wizard only asks questions that match the user's path.
 */
type Intent = "migrate" | "connect" | "fresh";

export async function initCommand(opts: InitOptions): Promise<void> {
  await assertNtnInstalled();
  const client = new NotionClient();

  // ---- 1. Pick scope (global vs project) -------------------------------
  const mode = await chooseMode(opts);

  // ---- 2. Look at what's already on disk -------------------------------
  // Knowing whether the user has local skills BEFORE we ask about Notion
  // lets us recommend the migrate path when it matches their reality.
  const localSkillCount = await countLocalSkills(mode);

  // ---- 3. Choose intent ------------------------------------------------
  const intent = await chooseIntent({ mode, localSkillCount });

  // ---- 4. Connect a database (existing or new) -------------------------
  const { databaseId, dataSourceId, databaseTitle, databaseUrl } =
    intent === "connect"
      ? await pickExistingDatabase(client)
      : await createNewDatabase(client);

  // ---- 5. Auto-upgrade schema (no warnings; just make it right) --------
  // The DB might be brand-new (we created it title-only) or an existing
  // user DB with the old schema. Either way, normalize before going further.
  console.log(chalk.dim("Reconciling schema..."));
  const { added, retyped } = await client.upgradeSchema(dataSourceId);
  if (added.length || retyped.length) {
    console.log(
      chalk.dim(`  added ${added.length}, retyped ${retyped.length}`),
    );
  }

  // ---- 6. Tag filter (optional, only when DB has Tags w/ options) ------
  const dataSource = await client.getDataSource(dataSourceId);
  const tagsProp = findMultiSelectProperty(dataSource as any, "Tags");
  const includeTags =
    tagsProp && tagsProp.options.length
      ? await checkbox({
          message: "Include tags (leave empty for all):",
          choices: tagsProp.options.map((t) => ({ name: t, value: t })),
          required: false,
        })
      : [];
  const excludeTags =
    tagsProp && tagsProp.options.length && includeTags.length === 0
      ? await checkbox({
          message: "Exclude tags (leave empty for none):",
          choices: tagsProp.options
            .filter((t) => !includeTags.includes(t))
            .map((t) => ({ name: t, value: t })),
          required: false,
        })
      : [];

  // ---- 7. Persist scope ------------------------------------------------
  if (mode === "global") {
    const targets = await pickTargets();
    await writeGlobalScope({
      database_id: databaseId,
      data_source_id: dataSourceId,
      database_title: databaseTitle,
      targets,
      filter: { include_tags: includeTags, exclude_tags: excludeTags },
    });
    console.log(chalk.green(`✓ Saved global scope (targets: ${targets.join(", ")})`));
  } else {
    const cwd = process.cwd();
    if (findProjectScopePath(cwd)) {
      const ok = await confirm({
        message: ".notion-skills.json already exists here. Overwrite?",
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
    console.log(chalk.green(`✓ Saved project scope at ${path}`));
    console.log(
      chalk.dim(`  commit ${PROJECT_SCOPE_FILENAME} so teammates get the same skills.`),
    );
  }

  // ---- 8. Branch on intent for the post-setup action -------------------
  if (intent === "migrate") {
    console.log(chalk.bold(`\nMigrating ${localSkillCount} local skill(s) to Notion...`));
    await migrateCommand({ yes: true });
    printDoneBanner({ intent, databaseUrl });
    return;
  }

  if (intent === "connect") {
    // Existing DB usually has content; pull it down.
    const reloaded = await getScope();
    if (reloaded) {
      const summary = await runSync(reloaded);
      printSummary(summary);
    }
    printDoneBanner({ intent, databaseUrl });
    return;
  }

  // intent === "fresh": empty DB. Don't bother with sync; tell the user to
  // open the DB and start authoring.
  printDoneBanner({ intent, databaseUrl });
}

// ---------- helpers ----------

async function countLocalSkills(mode: "global" | "project"): Promise<number> {
  // For project scope we don't preempt with migration suggestions —
  // a fresh repo cwd is unlikely to already have skills.
  if (mode === "project") return 0;
  const dirs = KNOWN_TARGETS.map((t) => t.dir);
  const found = await discoverSkills({ sourceDirs: dirs });
  return found.filter((c) => c.kind === "new").length;
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
        name: "Global — sync to my agent CLIs (~/.claude/skills, etc.)",
        value: "global" as const,
      },
      {
        name: inProject
          ? "Project — overwrite this repo's .notion-skills.json"
          : "Project — write .notion-skills.json here, commit to share with team",
        value: "project" as const,
      },
    ],
  });
}

async function chooseIntent(args: {
  mode: "global" | "project";
  localSkillCount: number;
}): Promise<Intent> {
  const { mode, localSkillCount } = args;
  const hasLocals = mode === "global" && localSkillCount > 0;

  if (hasLocals) {
    console.log("");
    console.log(
      chalk.dim(
        `Found ${localSkillCount} skill(s) on this machine. notion-skills can upload them to Notion so they become editable in your browser.`,
      ),
    );
    console.log("");
  }

  const choices: { name: string; value: Intent }[] = [];
  if (hasLocals) {
    choices.push({
      name: `Migrate my ${localSkillCount} local skill(s) to Notion (recommended)`,
      value: "migrate",
    });
  }
  choices.push({
    name: "Connect to an existing Notion database",
    value: "connect",
  });
  choices.push({
    name: hasLocals
      ? "Start fresh — create an empty database and ignore my local skills"
      : "Create a new empty Skills database",
    value: "fresh",
  });

  return select({
    message: "What do you want to do?",
    choices,
  });
}

async function pickExistingDatabase(client: NotionClient): Promise<{
  databaseId: string;
  dataSourceId: string;
  databaseTitle: string;
  databaseUrl: string;
}> {
  const raw = await input({
    message: "Paste the Notion database URL or ID:",
    validate: (v) =>
      parseNotionId(v) !== null ||
      "Couldn't find a 32-char Notion ID in that input. Use the database's full URL.",
  });
  const databaseId = parseNotionId(raw)!;

  console.log(chalk.dim(`Looking up database...`));
  let db;
  try {
    db = await client.getDatabase(databaseId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        `Couldn't load that database from Notion.`,
        ``,
        `Common causes:`,
        `  · The URL points to a page, not a database — check it ends in /...?v=... (a database view URL)`,
        `  · ntn is logged in to a different workspace than the one with this DB — run \`ntn doctor\``,
        `  · The database was archived/deleted`,
        ``,
        `Original error: ${msg.split("\n")[0]}`,
      ].join("\n"),
    );
  }

  if (db.data_sources.length === 0) {
    throw new Error(
      `Database "${db.title}" has no data sources, which is unexpected for the 2025-09-03 API. Try refreshing ntn (\`ntn logout && ntn login\`) and re-running.`,
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

  console.log(chalk.green(`✓ Connected to "${db.title}"`));
  return {
    databaseId: db.id,
    dataSourceId,
    databaseTitle: db.title,
    databaseUrl: `https://www.notion.so/${db.id.replace(/-/g, "")}`,
  };
}

async function createNewDatabase(client: NotionClient): Promise<{
  databaseId: string;
  dataSourceId: string;
  databaseTitle: string;
  databaseUrl: string;
}> {
  const title = await input({
    message: "Name for the new database:",
    default: "Skills",
  });

  console.log(chalk.dim(`Creating database in your workspace...`));
  const db = await client.createSkillsDatabase({ title });
  console.log(chalk.green(`✓ Created "${db.title}"`));
  console.log(chalk.dim(`  ${db.url}`));

  return {
    databaseId: db.id,
    dataSourceId: db.data_source_id,
    databaseTitle: db.title,
    databaseUrl: db.url,
  };
}

async function pickTargets(): Promise<TargetKey[]> {
  const detected = detectTargets();
  const choices = detected.map((t) => ({
    name: t.installed ? t.label : `${t.label} ${chalk.dim("(not installed)")}`,
    value: t.key,
    checked: t.installed,
  }));
  const picked = await checkbox({
    message: "Sync to which agent CLIs?",
    choices,
    required: true,
    validate: (vals) => (vals.length === 0 ? "Pick at least one." : true),
  });
  return picked.length > 0 ? picked : KNOWN_TARGETS.map((t) => t.key);
}

function printDoneBanner(args: { intent: Intent; databaseUrl: string }): void {
  const { intent, databaseUrl } = args;
  console.log("");
  console.log(chalk.green("✓ Setup complete."));
  console.log("");
  if (intent === "fresh") {
    console.log(`Open your new database and add a row for each skill:`);
    console.log(`  ${chalk.cyan(databaseUrl)}`);
    console.log("");
    console.log(`Each row should have:`);
    console.log(`  · A title (becomes the skill slug)`);
    console.log(`  · A Description (the one-line "when to use" hint)`);
    console.log(`  · The skill instructions in the page body`);
    console.log("");
    console.log(`When ready, run ${chalk.bold("notion-skills sync")}.`);
  } else if (intent === "connect") {
    console.log(`Database: ${chalk.cyan(databaseUrl)}`);
    console.log("");
    console.log(`Day to day:`);
    console.log(`  · Edit skills in Notion`);
    console.log(`  · Run ${chalk.bold("notion-skills sync")} to pull updates`);
    console.log(`  · Use ${chalk.bold("notion-skills doctor")} if anything looks off`);
  } else {
    // migrate
    console.log(`Database: ${chalk.cyan(databaseUrl)}`);
    console.log("");
    console.log(`Your skills are now editable in Notion.`);
    console.log(`  · Edit a row in Notion → run ${chalk.bold("notion-skills sync")} to pull it back`);
    console.log(`  · Originals were backed up to ~/.notion-skills/backup/migrate-<ts>/`);
  }
}
