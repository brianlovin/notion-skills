import chalk from "chalk";
import { dirname } from "node:path";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { NotionClient, findMultiSelectProperty } from "../notion.js";
import {
  findProjectScopePath,
  getScope,
  writeGlobalScope,
  writeProjectScope,
} from "../scope.js";
import { detectTargets } from "../targets.js";
import { KNOWN_TARGETS } from "../known-targets.js";
import { PROJECT_SCOPE_FILENAME, type TargetKey } from "../paths.js";
import { assertNtnInstalled } from "../ntn.js";
import { parseNotionId } from "../parse-id.js";
import { discoverSkills, type Classification, type ParsedSkill } from "../migrate.js";
import { migrateCommand } from "./migrate.js";
import { runSync, printSummary } from "../sync.js";

interface InitOptions {
  global?: boolean;
  project?: boolean;
}

/**
 * Wizard flow:
 *
 *   1. Pick scope (global / project)
 *   2. "Already have a Skills database in Notion?"
 *      yes → paste URL → connect
 *      no  → name → create at workspace root
 *   3. Auto-upgrade schema (no warnings — just make it right)
 *   4. Pick sync targets and tag filter
 *   5. Save scope
 *   6. Run sync (populates manifest; for connect-existing this also pulls
 *      down any pages already in the DB as symlinks)
 *   7. Scan local skills NOT yet in the DB; if any exist, show preview
 *      with sources / conflicts and ask if the user wants to upload them
 *   8. Print a per-intent summary with the DB URL
 */
export async function initCommand(opts: InitOptions): Promise<void> {
  await assertNtnInstalled();
  const client = new NotionClient();

  // ---- 1. Scope ---------------------------------------------------------
  const mode = await chooseMode(opts);

  // ---- 2. Connect or create the database -------------------------------
  const useExisting = await select({
    message: "Already have a Skills database in Notion?",
    choices: [
      { name: "No — create one for me", value: false },
      { name: "Yes — I have a database I want to use", value: true },
    ],
    default: false,
  });

  const { databaseId, dataSourceId, databaseTitle, databaseUrl, isFresh } =
    useExisting
      ? { ...(await pickExistingDatabase(client)), isFresh: false }
      : { ...(await createNewDatabase(client)), isFresh: true };

  // ---- 3. Auto-upgrade schema ------------------------------------------
  process.stdout.write(chalk.dim("Reconciling schema... "));
  const { added, retyped } = await client.upgradeSchema(dataSourceId);
  if (added.length === 0 && retyped.length === 0) {
    console.log(chalk.dim("up to date"));
  } else {
    console.log(chalk.green(`✓ added ${added.length}, retyped ${retyped.length}`));
  }

  // ---- 4. Tags + targets -----------------------------------------------
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

  // ---- 5. Persist scope ------------------------------------------------
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

  // ---- 6. Initial sync -------------------------------------------------
  // For connect-existing this pulls down whatever's in the DB. For create-new
  // it's a no-op against an empty DB but populates the manifest so subsequent
  // local-skill detection knows what's "managed" vs "new".
  if (!isFresh) {
    const reloaded = await getScope();
    if (reloaded) {
      const summary = await runSync(reloaded);
      printSummary(summary);
    }
  }

  // ---- 7. Detect local skills not yet in Notion ------------------------
  if (mode === "global") {
    const targetDirs = KNOWN_TARGETS.map((t) => t.dir);
    const found = await discoverSkills({ sourceDirs: targetDirs });
    const newCandidates = found.filter(
      (c): c is Classification & { kind: "new" } => c.kind === "new",
    );

    if (newCandidates.length > 0) {
      printLocalSkillPreview(newCandidates.map((c) => c.skill));
      const upload = await confirm({
        message: `Upload ${newCandidates.length === 1 ? "this skill" : `these ${newCandidates.length} skills`} to Notion now?`,
        default: true,
      });
      if (upload) {
        await migrateCommand({ yes: true });
      }
    }
  }

  // ---- 8. Done banner --------------------------------------------------
  printDoneBanner({ isFresh, databaseUrl });
}

// ---------- helpers ----------

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

/**
 * Render the discovered local skills as a preview the user can scan
 * before opting into migration. Shows source dirs and flags any
 * multi-target conflicts (same slug, different content).
 */
function printLocalSkillPreview(skills: ParsedSkill[]): void {
  const total = skills.length;
  console.log("");
  console.log(
    chalk.bold(
      total === 1
        ? `Found 1 local skill on this machine that isn't in Notion yet:`
        : `Found ${total} local skills on this machine that aren't in Notion yet:`,
    ),
  );
  console.log("");
  for (const s of skills) {
    const dirs = describeSources(s);
    const namePadded = s.name.padEnd(36);
    const desc = chalk.dim(s.description.slice(0, 60));
    console.log(`  ${chalk.green("•")} ${namePadded} ${chalk.dim(dirs)}`);
    if (desc) console.log(`    ${desc}`);
    if (s.conflictingSources && s.conflictingSources.length > 0) {
      const conflicts = s.conflictingSources.map((p) => homeRelative(parentOf(p))).join(", ");
      console.log(
        chalk.yellow(
          `    ⚠ also exists in ${conflicts} with different content — ${homeRelative(parentOf(s.source))} version will win`,
        ),
      );
    }
  }
  console.log("");
}

function describeSources(s: ParsedSkill): string {
  const all = [s.source, ...(s.additionalSources ?? [])];
  return all.map((p) => homeRelative(parentOf(p))).join(", ");
}

function parentOf(realpath: string): string {
  return dirname(realpath);
}

function homeRelative(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
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
