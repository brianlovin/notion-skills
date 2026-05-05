#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { initCommand } from "./commands/init.js";
import { syncCommand } from "./commands/sync.js";
import { listCommand } from "./commands/list.js";
import { statusCommand } from "./commands/status.js";
import { migrateCommand } from "./commands/migrate.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { doctorCommand } from "./commands/doctor.js";
import { genCommand } from "./commands/gen.js";
import { publishCommand } from "./commands/publish.js";
import { importCommand } from "./commands/import.js";
import { installCommand } from "./commands/install.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { unpublishCommand } from "./commands/unpublish.js";

// Read version from package.json so `--version` stays in sync with bumps
// without us remembering to edit two places.
const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { version: string };

const program = new Command();

program
  .name("notion-skills")
  .description("Sync skills from a Notion database to your AI coding agents.")
  .version(pkg.version);

program
  .command("login")
  .description("Authorize with Notion (delegates to `ntn login`)")
  .action(loginCommand);

program
  .command("logout")
  .description("Sign out of Notion (delegates to `ntn logout`)")
  .action(logoutCommand);

program
  .command("init")
  .description("Configure a Skills database for sync")
  .action(initCommand);

program
  .command("sync")
  .description("Sync skills from Notion to local agent directories")
  .action(syncCommand);

program
  .command("list")
  .description("List skills in the store with state (installed, available, outdated, draft)")
  .option("--installed", "only skills installed on this machine")
  .option("--available", "only skills in the store that aren't installed")
  .option("--outdated", "only installed skills with newer versions in the store")
  .option("--drafts", "only local drafts (not yet published)")
  .option("--tag <tag...>", "filter by tag (repeatable; matches all)")
  .option("--json", "machine-readable JSON output")
  .action(listCommand);

program
  .command("status")
  .description("Show what skills are currently synced and where")
  .action(statusCommand);

program
  .command("doctor")
  .description("Inspect notion-skills state and surface actionable issues")
  .option("--fix", "auto-repair warnings where safe")
  .action(doctorCommand);

program
  .command("upgrade")
  .description("Add any missing skill-spec properties to your Notion database schema")
  .action(upgradeCommand);

program
  .command("gen")
  .description("Generate a new skill from a URL, file path, or natural-language prompt via your coding agent")
  .argument("<input>", "URL, file path, or natural-language description")
  .option("--agent <key>", "override the configured coding agent (claude, codex, opencode, gemini)")
  .action(genCommand);

program
  .command("install")
  .description("Pull a skill from the workspace store onto this machine")
  .argument("[slugs...]", "skill slugs to install")
  .option("--all", "install every skill in the store that isn't already installed")
  .option("--tag <tag...>", "install all skills matching these tags (all-must-match)")
  .action(installCommand);

program
  .command("uninstall")
  .description("Remove a skill from this machine (Notion page is untouched)")
  .argument("<slug>", "skill slug to remove")
  .action(uninstallCommand);

program
  .command("publish")
  .description("Push a local skill to the workspace store. Pass slugs or --all.")
  .argument("[slugs...]", "skill slugs to publish")
  .option("--all", "publish every local-only skill in the central store")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(publishCommand);

program
  .command("unpublish")
  .description("Remove a skill from the workspace store (archives the Notion page)")
  .argument("<slug>", "skill slug to remove from the store")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(unpublishCommand);

program
  .command("import")
  .description("Bulk-import pre-existing local skills into the store (interactive multiselect)")
  .option("--from <path...>", "extra directories to scan, e.g. an old skills repo")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(importCommand);

program
  .command("migrate", { hidden: true })
  .description("[deprecated] Use `publish --all` or `import` instead")
  .option("--from <path...>", "extra directories to scan")
  .option("--overwrite", "replace Notion pages whose slug matches a local skill")
  .option("--dry-run", "show what would happen without changing anything")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(async (opts) => {
    const chalk = (await import("chalk")).default;
    console.warn(
      chalk.yellow(
        `\n[deprecated] \`notion-skills migrate\` will be removed in a future release. Use \`notion-skills publish --all\` (push local skills) or \`notion-skills import\` (bring in external skills) instead.\n`,
      ),
    );
    await migrateCommand(opts);
  });

program.parseAsync(process.argv).catch(async (err) => {
  // ExitPromptError is what @inquirer/prompts throws on Ctrl-C — treat as
  // a clean abort, no error rendering.
  if (err && typeof err === "object" && (err as { name?: string }).name === "ExitPromptError") {
    process.exit(130);
  }
  const { reportError } = await import("./errors.js");
  process.exit(reportError(err));
});
