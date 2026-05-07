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
import { openCommand } from "./commands/open.js";
import { auditCommand } from "./commands/audit.js";
import { addCommand } from "./commands/add.js";
import { feedbackCommand } from "./commands/feedback.js";
import { feedCommand } from "./commands/feed.js";
import {
  sourceAddCommand,
  sourceDefaultCommand,
  sourceHelpCommand,
  sourceListCommand,
  sourceRemoveCommand,
  sourceRenameCommand,
} from "./commands/source.js";

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
  .description("A skill store for your AI coding agents. Author once in Notion, install only what you need, share with your team.")
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
  .description("Connect to (or create) your workspace skill store")
  .action(initCommand);

program
  .command("sync")
  .description("Pull updates for skills you have installed (pull-only — use `publish` to push)")
  .option("--no-diff", "hide per-skill content diffs")
  .action(syncCommand);

program
  .command("list")
  .description("List skills in the store with state (installed, available, outdated, draft)")
  .option("--installed", "only skills installed on this machine")
  .option("--available", "only skills in the store that aren't installed")
  .option("--outdated", "only installed skills with newer versions in the store")
  .option("--drafts", "only local drafts (not yet published)")
  .option("--tag <tag...>", "filter by tag (source-scoped; matches all)")
  .option("--source <key>", "scope to a specific source")
  .option("--sort <key>", "sort order: name (default), popular (by install count), new (most recently created)", "name")
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
  .command("audit")
  .description("Run quality checks against your skills (description, body, test markers, agent-routing keywords). Like `npm audit`.")
  .argument("[slugs...]", "audit specific local slugs (defaults to every skill on this machine)")
  .option("--drafts", "only audit local drafts (pre-publish quality check)")
  .option("--installed", "only audit installed skills")
  .option("--source <key>", "only audit skills installed from this source")
  .option("--json", "machine-readable JSON output")
  .action(auditCommand);

program
  .command("upgrade")
  .description("Add any missing skill-spec properties to your Notion database schema")
  .option("--source <key>", "scope to a specific source")
  .option("--all", "run against every configured source")
  .action(upgradeCommand);

program
  .command("gen")
  .description("Generate a new skill from a URL, file path, or natural-language prompt via your coding agent")
  .argument("<input>", "URL, file path, or natural-language description")
  .option("--agent <key>", "override the configured coding agent (claude, codex, opencode, gemini)")
  .action(genCommand);

program
  .command("add")
  .description("Pull a skill from a public GitHub repo into the central store as a local draft. Mirrors `npx skills add` syntax.")
  .argument("<ref>", "GitHub source: `owner/repo`, `owner/repo@skill`, `owner/repo#ref`, or full URL")
  .option("--skill <name...>", "filter to one or more skills in a multi-skill repo")
  .option("--preview", "print skill metadata + body without writing to disk")
  .option("--as <name>", "override the local slug (single-skill add only)")
  .option("--publish", "after add, publish straight to a Notion source")
  .option("--source <key>", "source for --publish (default: default source)")
  .option("--skip-existing", "drop colliding skills silently; install only new ones (otherwise: rename them)")
  .option("-y, --yes", "skip prompts (multi-skill repos add all)")
  .action((ref, opts) => addCommand([ref], opts));

program
  .command("install")
  .description("Pull a skill from the workspace store onto this machine. Refs can be bare (`deploy`) or qualified (`team/deploy`).")
  .argument("[slugs...]", "skill refs to install")
  .option("--all", "install every skill in the source (source-scoped)")
  .option("--tag <tag...>", "install all skills matching these tags (source-scoped; all-must-match)")
  .option("--source <key>", "scope --all/--tag to this source; ignored for explicit refs")
  .option("--as <name>", "override the local slug (single-skill installs only)")
  .action(installCommand);

program
  .command("feedback")
  .description("Read or post comments on a skill's Notion page (no Notion required for teammates).")
  .argument("<slug>", "skill slug — bare (`deploy`) or qualified (`team/deploy`)")
  .argument("[message...]", "if provided, post this comment; otherwise list existing comments")
  .option("--source <key>", "scope a bare slug to a specific source")
  .action((slug, messageParts, opts) => feedbackCommand(slug, messageParts, opts));

program
  .command("feed")
  .description("What's new across your skill stores: newly published skills + updates to skills you have installed.")
  .option("--since <window>", "time window (e.g. 7d, 30d, 2w, 12h)", "7d")
  .option("--source <key>", "scope to a specific source")
  .option("--json", "machine-readable JSON output")
  .action(feedCommand);

program
  .command("open")
  .description("Open a skill in Notion (default), in a local editor, or reveal its directory")
  .argument("<slug>", "skill slug to open")
  .option("--local", "open the local SKILL.md with $VISUAL or $EDITOR (fallback `vi`)")
  .option("--with <command>", "open the local SKILL.md with the given command (e.g. `cursor`, `code -n`)")
  .option("-a, --app <name>", "macOS-only: open the local SKILL.md in the named app (alias for `open -a`)")
  .option("--reveal", "reveal the skill's directory in the OS file manager")
  .action(openCommand);

program
  .command("uninstall")
  .description("Remove a skill from this machine — works for installed skills AND local drafts. Notion pages are untouched. Pass slugs, --tag, or --all.")
  .argument("[slugs...]", "skill local slugs to remove")
  .option("--all", "remove every installed skill on this machine (--source narrows to one source)")
  .option("--tag <tag...>", "remove all installed skills matching these tags (source-scoped)")
  .option("--source <key>", "scope --all/--tag to one source")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(uninstallCommand);

program
  .command("publish")
  .description("Push a local skill to the workspace store. Pass slugs or --all.")
  .argument("[slugs...]", "skill slugs to publish")
  .option("--all", "publish every local-only skill in the central store")
  .option("--source <key>", "target a specific source (default: default source / picker)")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(publishCommand);

program
  .command("unpublish")
  .description("Remove a skill from the workspace store (archives the Notion page)")
  .argument("<slug>", "skill slug to remove from the store")
  .option("--source <key>", "scope to one source when looking up a non-installed slug")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(unpublishCommand);

program
  .command("import")
  .description("Bulk-import pre-existing local skills into the store")
  .option("--from <path...>", "extra directories to scan, e.g. an old skills repo")
  .option("--source <key>", "target source for the import")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(importCommand);

const sourceCmd = program
  .command("source")
  .description("Manage Notion skill sources (databases) configured on this machine")
  .action(sourceHelpCommand);

sourceCmd
  .command("add")
  .description("Link or create another Notion database as a source")
  .option("--key <key>", "explicit source key (defaults to a slug derived from the database title)")
  .action(sourceAddCommand);

sourceCmd
  .command("list")
  .description("Show all configured sources")
  .option("--json", "machine-readable JSON output")
  .action(sourceListCommand);

sourceCmd
  .command("remove <key>")
  .description("Remove a source. Prompts for installed skills (uninstall vs keep as drafts).")
  .option("-y, --yes", "skip the prompt; default action is uninstall")
  .option("--keep-skills", "demote installed skills from this source to local-only drafts")
  .action((key, opts) => sourceRemoveCommand(key, opts));

sourceCmd
  .command("default <key>")
  .description("Set the default source for unscoped commands")
  .action(sourceDefaultCommand);

sourceCmd
  .command("rename <old> <new>")
  .description("Rename a source key. Rewrites manifest entries.")
  .action(sourceRenameCommand);

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
