import chalk from "chalk";
import { checkbox, confirm } from "@inquirer/prompts";
import { NotionClient } from "../notion.js";
import { getScope, writeScope } from "../scope.js";
import { detectTargets } from "../targets.js";
import { KNOWN_TARGETS } from "../known-targets.js";
import { type TargetKey } from "../paths.js";
import { assertNtnInstalled } from "../ntn.js";
import { discoverSkills, type Classification } from "../migrate.js";
import { migrateCommand } from "./migrate.js";
import { pickLocalSkillsToUpload } from "./_pick-locals.js";
import { pickOrCreateDatabase } from "./_db-picker.js";
import { sourceAddCommand } from "./source.js";
import { deriveKey, type Source } from "../sources.js";

/**
 * Wizard flow (app-store framing):
 *
 *   1. If a scope already exists: print preamble + delegate to `source add`.
 *      `init` is the first-time setup; subsequent invocations route to
 *      add-another-source rather than overwriting an existing config.
 *   2. Otherwise (fresh machine): pick targets, create or link a
 *      database, save scope with the new source marked default. Offer
 *      to import existing local skills.
 */
export async function initCommand(): Promise<void> {
  await assertNtnInstalled();

  const existing = await getScope();
  if (existing && existing.sources.length > 0) {
    console.log(
      chalk.dim(
        `notion-skills already configured (${existing.sources.length} source${existing.sources.length === 1 ? "" : "s"}: ${existing.sources.map((s) => s.key).join(", ")}).`,
      ),
    );
    console.log(chalk.dim("Adding a new source..."));
    console.log("");
    await sourceAddCommand();
    return;
  }

  const client = new NotionClient();

  // ---- Pick targets first --------------------------------------------
  // (Order: targets before DB so we know where symlinks will land
  // before we save scope.)
  const targets = await pickTargets();

  // ---- Create or link the first database -----------------------------
  const picked = await pickOrCreateDatabase(client);

  const firstSource: Source = {
    key: deriveKey(picked.databaseTitle, new Set()),
    name: picked.databaseTitle,
    database_id: picked.databaseId,
    data_source_id: picked.dataSourceId,
    default: true,
    added_at: new Date().toISOString(),
  };

  await writeScope({
    sources: [firstSource],
    targets,
  });
  console.log(
    chalk.green(`✓ Saved scope (source: ${firstSource.key}, targets: ${targets.join(", ")})`),
  );

  // ---- Offer to import any local skills found on this machine -------
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
        await migrateCommand({ yes: true, only: picked, source: firstSource.key });
      }
    }
  }

  printDoneBanner({ isFresh: picked.isFresh, databaseUrl: picked.databaseUrl });
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
