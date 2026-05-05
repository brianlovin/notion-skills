import chalk from "chalk";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
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
 * Wizard flow (app-store framing):
 *
 *   1. "Create a new database, or link an existing one?" (default = create)
 *   2. Reconcile minimum schema (Name + Description); rest is added by
 *      `publish` as skills with those properties show up.
 *   3. Pick sync targets (parent dir of each known target gates default-on).
 *   4. Save scope.
 *   5. Detect local skills outside the central store. If any exist, ask
 *      whether to import them — explicit confirmation, then multiselect.
 *      Imports nothing by default; the store starts empty for new users
 *      so they pick what to install rather than getting everything.
 *   6. Print a done banner that points at next steps (`list`, `gen`,
 *      `install --all`, etc.) so the empty default never feels lost.
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
  // Fresh DBs already have Name + Description + Installs from
  // createSkillsDatabase. For linked DBs, ensure Description AND
  // Installs exist — anything else is added progressively by publish
  // as skills using those properties show up. Stay silent unless we
  // actually changed something.
  if (!isFresh) {
    const { added, retyped } = await client.upgradeSchema(dataSourceId, {
      only: new Set(["Description", "Installs"]),
    });
    if (added.length || retyped.length) {
      const total = added.length + retyped.length;
      console.log(
        chalk.dim(
          `Added ${total} required ${total === 1 ? "column" : "columns"} to existing database.`,
        ),
      );
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

  // ---- 5. Offer to import any local skills found on this machine -------
  //
  // App-store rule: init does NOT auto-import or auto-install anything.
  // The store starts empty for the user — they pick what to install.
  // We do, however, look for skills already on disk and offer to bring
  // them in, since that's the realistic on-ramp for users who have
  // existing scattered skill files.
  const targetDirs = targets
    .map((k) => KNOWN_TARGETS.find((t) => t.key === k)?.dir)
    .filter((d): d is string => !!d);
  const found = await discoverSkills({ sourceDirs: targetDirs });
  const newCandidates = found.filter(
    (c): c is Classification & { kind: "new" } => c.kind === "new",
  );

  if (newCandidates.length > 0) {
    console.log("");
    console.log(
      chalk.dim(
        `Found ${newCandidates.length} ${newCandidates.length === 1 ? "skill" : "skills"} on this machine that ${newCandidates.length === 1 ? "isn't" : "aren't"} in your store yet.`,
      ),
    );
    const wantsImport = await confirm({
      message: `Import ${newCandidates.length === 1 ? "it" : "them"} into the store now?`,
      default: true,
    });
    if (wantsImport) {
      const picked = await pickLocalSkillsToUpload(
        newCandidates.map((c) => c.skill),
      );
      if (picked.length > 0) {
        await migrateCommand({ yes: true, only: picked });
      }
    }
  }

  // ---- 6. Done banner --------------------------------------------------
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
  console.log(`Store: ${chalk.cyan(databaseUrl)}`);
  console.log("");
  if (isFresh) {
    console.log(`Your skill store is empty. To add skills:`);
    console.log(`  · ${chalk.bold("notion-skills gen <input>")}     — author a new skill via your coding agent`);
    console.log(`  · Edit pages in Notion directly, then ${chalk.bold("notion-skills install <slug>")}`);
  } else {
    console.log(`Browse and install:`);
    console.log(`  · ${chalk.bold("notion-skills list")}                  — see what's in the store`);
    console.log(`  · ${chalk.bold("notion-skills install <slug>")}        — install a single skill`);
    console.log(`  · ${chalk.bold("notion-skills install --tag <name>")}  — install all skills with a tag`);
    console.log(`  · ${chalk.bold("notion-skills install --all")}         — install everything (power-user)`);
  }
}
