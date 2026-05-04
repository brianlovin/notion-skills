#!/usr/bin/env node
import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { initCommand } from "./commands/init.js";
import { syncCommand } from "./commands/sync.js";
import { listCommand } from "./commands/list.js";
import { statusCommand } from "./commands/status.js";
import { tagsCommand } from "./commands/tags.js";
import { migrateCommand } from "./commands/migrate.js";
import { upgradeCommand } from "./commands/upgrade.js";

const program = new Command();

program
  .name("notion-skills")
  .description("Sync skills from a Notion database to your AI coding agents.")
  .version("0.1.0");

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
  .option("--global", "force global scope")
  .option("--project", "force project scope (writes .notion-skills.json here)")
  .action(initCommand);

program
  .command("sync")
  .description("Sync skills from Notion to local agent directories")
  .argument("[names...]", "specific skill names to include this run")
  .option("--global", "sync the global scope")
  .option("--project", "sync the project scope")
  .option("--all", "sync both global and project scopes")
  .action(syncCommand);

program
  .command("list")
  .description("List skills in the configured database with sync status")
  .action(listCommand);

program
  .command("status")
  .description("Show what skills are currently synced and where")
  .action(statusCommand);

program
  .command("tags")
  .description("Edit tag include/exclude filters interactively")
  .action(tagsCommand);

program
  .command("upgrade")
  .description("Add any missing skill-spec properties to your Notion database schema")
  .action(upgradeCommand);

program
  .command("migrate")
  .description("Push existing local skills into Notion, then sync back as symlinks")
  .option("--from <path...>", "extra directories to scan, e.g. an old skills repo")
  .option("--overwrite", "replace Notion pages whose slug matches a local skill")
  .option("--dry-run", "show what would happen without changing anything")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(migrateCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
