import chalk from "chalk";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getScope } from "../scope.js";
import { readManifest } from "../manifest.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import { NotionClient, readTitle } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { slugify } from "../convert.js";

interface OpenOptions {
  local?: boolean;
  with?: string;
  app?: string;
  reveal?: boolean;
}

/**
 * Open a skill — in Notion (default), in a local editor, or reveal
 * its directory in the OS file manager.
 *
 * Modes (mutually exclusive; at most one):
 *   - default        : open the Notion page URL in the user's browser
 *   - --local        : open SKILL.md with $VISUAL || $EDITOR (fallback `vi`)
 *   - --with <cmd>   : open SKILL.md with `<cmd> <path>` (shell parses cmd)
 *   - -a / --app <n> : macOS-only sugar for `open -a "<n>" <path>`
 *   - --reveal       : open the skill's directory in Finder / xdg-open
 *
 * The default targets Notion because that's what only this CLI can do
 * — `vi`, `code`, `xdg-open` are already on the user's PATH.
 */
export async function openCommand(
  slug: string,
  opts: OpenOptions,
): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  const modes = [
    opts.local ? "local" : null,
    opts.with ? "with" : null,
    opts.app ? "app" : null,
    opts.reveal ? "reveal" : null,
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new Error(
      `--local, --with, -a/--app, and --reveal are mutually exclusive (got ${modes.join(", ")}).`,
    );
  }

  const skillDir = join(SKILLS_STORE, slug);
  const skillFile = join(skillDir, "SKILL.md");

  // Default mode: open the Notion page. Fast path uses the manifest
  // (no network call). For uninstalled skills we fall back to a
  // Notion query so users can preview store skills before installing.
  // Drafts can't be opened in Notion (they don't exist there yet) —
  // point the user at --local.
  if (modes.length === 0) {
    const manifest = await readManifest(MANIFEST_FILE);
    const entry = manifest?.skills[slug];
    let pageId = entry?.page_id;

    if (!pageId) {
      if (existsSync(skillDir)) {
        throw new Error(
          `${slug} is a local draft — there's no Notion page yet. Open the file with \`notion-skills open ${slug} --local\` (or publish first).`,
        );
      }
      const found = await findPageIdInStore(scope.data_source_id, slug);
      if (!found) {
        throw new Error(
          `Skill "${slug}" not found. Run \`notion-skills list\` to see what's in the store, or check the slug.`,
        );
      }
      pageId = found;
    }

    const url = notionPageUrl(pageId);
    console.log(chalk.dim(`Opening ${url}`));
    await launch(platformOpener(), [url]);
    return;
  }

  // All other modes operate on the local file. Slug must be on disk.
  if (!existsSync(skillDir)) {
    throw new Error(
      `${slug} is not on this machine. Run \`notion-skills install ${slug}\` first.`,
    );
  }

  if (opts.reveal) {
    console.log(chalk.dim(`Revealing ${skillDir}`));
    await launch(platformOpener(), [skillDir]);
    return;
  }

  if (!existsSync(skillFile)) {
    throw new Error(`${skillFile} does not exist (skill directory is empty).`);
  }

  if (opts.app) {
    if (process.platform !== "darwin") {
      throw new Error(
        `-a/--app is macOS-only. Use \`--with <command>\` instead (e.g. \`--with cursor\`).`,
      );
    }
    console.log(chalk.dim(`Opening ${skillFile} in ${opts.app}`));
    await launch("open", ["-a", opts.app, skillFile]);
    return;
  }

  if (opts.with) {
    const cmd = `${opts.with} ${shellQuote(skillFile)}`;
    console.log(chalk.dim(`$ ${opts.with} ${skillFile}`));
    await launchShell(cmd);
    return;
  }

  if (opts.local) {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const cmd = `${editor} ${shellQuote(skillFile)}`;
    console.log(chalk.dim(`$ ${editor} ${skillFile}`));
    await launchShell(cmd);
    return;
  }
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

/**
 * Slow-path slug lookup: the user is opening a not-yet-installed
 * skill. Query the data source and slugify titles to find a match.
 */
async function findPageIdInStore(
  dataSourceId: string,
  slug: string,
): Promise<string | null> {
  await assertNtnInstalled();
  const client = new NotionClient();
  const pages = await client.queryDataSource(dataSourceId);
  for (const page of pages) {
    if (page.archived || page.in_trash) continue;
    const title = readTitle(page.properties);
    if (!title) continue;
    if (slugify(title) === slug) return page.id;
  }
  return null;
}

function platformOpener(): string {
  return process.platform === "darwin" ? "open" : "xdg-open";
}

function shellQuote(p: string): string {
  // Single-quote and escape embedded single quotes (POSIX-safe).
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * Spawn a command with explicit args and inherit stdio so terminal
 * editors (vim, nano) work cleanly. Resolves on exit; rejects on
 * non-zero. Used for `open <url>`, `open -a App file`, `xdg-open dir`.
 */
function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

/**
 * Shell-mode spawn, used for `--with` and `--local` so users can pass
 * complex commands like `--with "code -n"` or `EDITOR='code -n'`.
 */
function launchShell(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [], { stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Command exited with code ${code}`));
    });
  });
}
