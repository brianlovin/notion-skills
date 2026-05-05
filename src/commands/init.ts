import chalk from "chalk";
import { checkbox, input, select } from "@inquirer/prompts";
import { NotionClient } from "../notion.js";
import { writeScope } from "../scope.js";
import { detectTargets } from "../targets.js";
import { KNOWN_TARGETS } from "../known-targets.js";
import { type TargetKey } from "../paths.js";
import { assertNtnInstalled } from "../ntn.js";
import { parseNotionId } from "../parse-id.js";
import { discoverSkills, type Classification } from "../migrate.js";
import { migrateCommand } from "./migrate.js";
import { pickLocalSkillsToUpload } from "./_pick-locals.js";

/**
 * Wizard flow:
 *
 *   1. "Create a new database, or link an existing one?" (default = create)
 *   2. Reconcile minimum schema (Name + Description); rest is added by
 *      migrate as skills with those properties show up
 *   3. Pick sync targets (parent dir of each known target gates default-on)
 *   4. Save scope
 *   5. Scan local skills NOT yet in the DB; if any exist, show a
 *      multiselect picker and offer to upload them via migrate
 *   6. Print summary with the DB URL
 */
export async function initCommand(): Promise<void> {
  await assertNtnInstalled();
  const client = new NotionClient();

  // ---- 1. Connect or create the database -------------------------------
  const useExisting = await select({
    message: "Set up a skills database:",
    choices: [
      { name: "Create a new skills database", value: false },
      { name: "Link an existing skills database", value: true },
    ],
    default: false,
  });

  const { databaseId, dataSourceId, databaseTitle, databaseUrl, isFresh } =
    useExisting
      ? { ...(await pickExistingDatabase(client)), isFresh: false }
      : { ...(await createNewDatabase(client)), isFresh: true };

  // ---- 2. Make sure the minimum schema exists --------------------------
  // Fresh DBs already have Name + Description from createSkillsDatabase.
  // For linked DBs, ensure Description exists — anything else is added
  // progressively by migrate as skills using those properties show up.
  // Stay silent unless we actually changed something.
  if (!isFresh) {
    const { added, retyped } = await client.upgradeSchema(dataSourceId, {
      only: new Set(["Description"]),
    });
    if (added.length || retyped.length) {
      console.log(chalk.dim(`Added Description column to existing database.`));
    }
  }

  // ---- 3. Targets -------------------------------------------------------
  const targets = await pickTargets();

  // ---- 4. Persist scope ------------------------------------------------
  await writeScope({
    database_id: databaseId,
    data_source_id: dataSourceId,
    database_title: databaseTitle,
    targets,
  });
  console.log(chalk.green(`✓ Saved scope (targets: ${targets.join(", ")})`));

  // ---- 5. Detect local skills not yet in Notion ------------------------
  // Only scan dirs the user opted into as sync targets — surfacing a skill
  // from an unselected agent (e.g. ~/.cursor/skills when Cursor isn't a
  // target) would falsely suggest it'd get migrated, and migrate would
  // skip it because that dir isn't in scope.
  const targetDirs = targets
    .map((k) => KNOWN_TARGETS.find((t) => t.key === k)?.dir)
    .filter((d): d is string => !!d);
  const found = await discoverSkills({ sourceDirs: targetDirs });
  const newCandidates = found.filter(
    (c): c is Classification & { kind: "new" } => c.kind === "new",
  );

  if (newCandidates.length > 0) {
    const picked = await pickLocalSkillsToUpload(
      newCandidates.map((c) => c.skill),
    );
    if (picked.length > 0) {
      await migrateCommand({ yes: true, only: picked });
    }
  }

  // ---- 7. Done banner --------------------------------------------------
  printDoneBanner({ isFresh, databaseUrl });
}

// ---------- helpers ----------

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
    message: "Which agents do you use?",
    choices,
    required: true,
    validate: (vals) => (vals.length === 0 ? "Pick at least one." : true),
  });
  return picked.length > 0 ? picked : KNOWN_TARGETS.map((t) => t.key);
}

function printDoneBanner(args: { isFresh: boolean; databaseUrl: string }): void {
  const { isFresh, databaseUrl } = args;
  console.log("");
  console.log(chalk.green("✓ Setup complete."));
  console.log("");
  console.log(`Database: ${chalk.cyan(databaseUrl)}`);
  console.log("");
  if (isFresh) {
    console.log(`Add a row in Notion for each skill you want to share.`);
    console.log(`Each row needs a title, a Description, and instructions in the page body.`);
    console.log(`When ready, run ${chalk.bold("notion-skills sync")}.`);
  } else {
    console.log(`Day to day:`);
    console.log(`  · Edit skills in Notion`);
    console.log(`  · ${chalk.bold("notion-skills sync")} pulls updates`);
    console.log(`  · ${chalk.bold("notion-skills doctor")} if anything looks off`);
  }
}
