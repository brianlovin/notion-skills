import chalk from "chalk";
import { confirm, input, select } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getScope, writeScope } from "../scope.js";
import { NotionClient } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import { readManifest, writeManifest } from "../manifest.js";
import { targetSkillPath, removeSymlink, targetsForKeys } from "../targets.js";
import {
  type Source,
  defaultSource,
  deriveKey,
  findByDatabaseId,
  findByKey,
  validateKey,
} from "../sources.js";
import { pickOrCreateDatabase } from "./_db-picker.js";

// ---------- source add ----------

interface SourceAddOptions {
  key?: string;
}

export async function sourceAddCommand(opts: SourceAddOptions = {}): Promise<void> {
  await assertNtnInstalled();
  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "notion-skills isn't configured yet. Run `notion-skills init` first.",
    );
  }
  const client = new NotionClient();
  const picked = await pickOrCreateDatabase(client);

  if (findByDatabaseId(scope.sources, picked.databaseId)) {
    const existing = findByDatabaseId(scope.sources, picked.databaseId)!;
    throw new Error(
      `That database is already linked as source "${existing.key}". Run \`notion-skills source list\` to see all sources.`,
    );
  }

  const existingKeys = new Set(scope.sources.map((s) => s.key));
  let key = opts.key ?? deriveKey(picked.databaseTitle, existingKeys);
  if (process.stdin.isTTY) {
    key = await input({
      message: "Source key (used in CLI args + manifest):",
      default: key,
      validate: (v) => {
        const e = validateKey(v);
        if (e) return e;
        if (existingKeys.has(v)) return `key "${v}" is already in use`;
        return true;
      },
    });
  } else {
    const e = validateKey(key);
    if (e) throw new Error(`Invalid source key: ${e}`);
    if (existingKeys.has(key)) throw new Error(`key "${key}" is already in use`);
  }

  const newSource: Source = {
    key,
    name: picked.databaseTitle,
    database_id: picked.databaseId,
    data_source_id: picked.dataSourceId,
    // First source is implicitly default; subsequent ones are not (per
    // user spec: don't auto-promote).
    default: scope.sources.length === 0,
    added_at: new Date().toISOString(),
  };

  scope.sources.push(newSource);
  await writeScope({
    sources: scope.sources,
    targets: scope.targets,
    gen_agent: scope.gen_agent,
  });

  console.log(chalk.green(`✓ Added source "${key}" → ${picked.databaseTitle}`));
  if (scope.sources.length > 1) {
    const def = defaultSource(scope.sources);
    if (def) {
      console.log(
        chalk.dim(`  Default source remains "${def.key}". Use \`notion-skills source default ${key}\` to switch.`),
      );
    }
  }
}

// ---------- source list ----------

interface SourceListOptions {
  json?: boolean;
}

export async function sourceListCommand(opts: SourceListOptions = {}): Promise<void> {
  const scope = await getScope();
  if (!scope || scope.sources.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ sources: [] }, null, 2));
      return;
    }
    console.log(chalk.dim("No sources configured. Run `notion-skills init` to add one."));
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify({ sources: scope.sources }, null, 2));
    return;
  }
  for (const s of scope.sources) {
    const flag = s.default ? chalk.green("default ") : "";
    console.log(`${flag}${chalk.bold(s.key)} ${chalk.dim(`— ${s.name}`)}`);
    console.log(chalk.dim(`  database: https://www.notion.so/${s.database_id.replace(/-/g, "")}`));
    console.log(chalk.dim(`  added: ${s.added_at}`));
  }
}

// ---------- source remove ----------

interface SourceRemoveOptions {
  yes?: boolean;
  keepSkills?: boolean;
}

export async function sourceRemoveCommand(
  key: string,
  opts: SourceRemoveOptions = {},
): Promise<void> {
  const scope = await getScope();
  if (!scope) throw new Error("notion-skills isn't configured yet.");
  const target = findByKey(scope.sources, key);
  if (!target) {
    throw new Error(
      `Unknown source "${key}". Configured: ${scope.sources.map((s) => s.key).join(", ") || "(none)"}.`,
    );
  }

  const manifest = await readManifest(MANIFEST_FILE, scope.sources[0]!.key);
  const installedFromSource = manifest
    ? Object.entries(manifest.skills).filter(([, e]) => e.source_key === key)
    : [];

  let mode: "uninstall" | "keep" | "no-skills" = "no-skills";
  if (installedFromSource.length > 0) {
    if (opts.yes) {
      mode = opts.keepSkills ? "keep" : "uninstall";
    } else if (process.stdin.isTTY) {
      const decision = await select<"uninstall" | "keep" | "cancel">({
        message: `${installedFromSource.length} skills are installed from "${key}". What now?`,
        choices: [
          { name: "Uninstall them (delete dirs + symlinks)", value: "uninstall" },
          { name: "Keep them as local-only drafts", value: "keep" },
          { name: "Cancel", value: "cancel" },
        ],
        default: "uninstall",
      });
      if (decision === "cancel") {
        console.log(chalk.dim("Cancelled."));
        return;
      }
      mode = decision;
    } else {
      throw new Error(
        `${installedFromSource.length} skills are installed from "${key}". Pass --yes (uninstalls) or --yes --keep-skills (demotes to local drafts).`,
      );
    }
  }

  // Apply.
  if (manifest) {
    if (mode === "uninstall") {
      const targets = targetsForKeys(scope.targets);
      for (const [localSlug] of installedFromSource) {
        const dir = join(SKILLS_STORE, localSlug);
        if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
        for (const t of targets) {
          await removeSymlink(targetSkillPath(t, localSlug));
        }
      }
    }
    // Both modes: drop the manifest entries for this source. Keep mode
    // leaves the on-disk dirs and symlinks (they become local drafts).
    for (const [localSlug] of installedFromSource) {
      delete manifest.skills[localSlug];
    }
    await writeManifest(MANIFEST_FILE, manifest);
  }

  // Drop from scope. If we're removing the default, leave the rest
  // without a default — user must explicitly set a new one.
  scope.sources = scope.sources.filter((s) => s.key !== key);
  await writeScope({
    sources: scope.sources,
    targets: scope.targets,
    gen_agent: scope.gen_agent,
  });

  console.log(chalk.green(`✓ Removed source "${key}"${target.default ? " (was default — set a new one with `source default <key>`)" : ""}`));
  if (mode === "uninstall") {
    console.log(chalk.dim(`  Uninstalled ${installedFromSource.length} skills.`));
  } else if (mode === "keep") {
    console.log(chalk.dim(`  Demoted ${installedFromSource.length} skills to local drafts.`));
  }
}

// ---------- source default ----------

export async function sourceDefaultCommand(key: string): Promise<void> {
  const scope = await getScope();
  if (!scope) throw new Error("notion-skills isn't configured yet.");
  if (!findByKey(scope.sources, key)) {
    throw new Error(
      `Unknown source "${key}". Configured: ${scope.sources.map((s) => s.key).join(", ") || "(none)"}.`,
    );
  }
  for (const s of scope.sources) s.default = s.key === key;
  await writeScope({
    sources: scope.sources,
    targets: scope.targets,
    gen_agent: scope.gen_agent,
  });
  console.log(chalk.green(`✓ Default source is now "${key}".`));
}

// ---------- source rename ----------

export async function sourceRenameCommand(oldKey: string, newKey: string): Promise<void> {
  const scope = await getScope();
  if (!scope) throw new Error("notion-skills isn't configured yet.");
  const source = findByKey(scope.sources, oldKey);
  if (!source) {
    throw new Error(`Unknown source "${oldKey}".`);
  }
  const e = validateKey(newKey);
  if (e) throw new Error(`Invalid new key: ${e}`);
  if (oldKey === newKey) {
    console.log(chalk.dim("No change."));
    return;
  }
  if (findByKey(scope.sources, newKey)) {
    throw new Error(`key "${newKey}" is already in use`);
  }
  source.key = newKey;
  await writeScope({
    sources: scope.sources,
    targets: scope.targets,
    gen_agent: scope.gen_agent,
  });

  // Rewrite manifest entries' source_key field.
  const manifest = await readManifest(MANIFEST_FILE, newKey);
  if (manifest) {
    let touched = 0;
    for (const entry of Object.values(manifest.skills)) {
      if (entry.source_key === oldKey) {
        entry.source_key = newKey;
        touched++;
      }
    }
    if (touched > 0) await writeManifest(MANIFEST_FILE, manifest);
    console.log(
      chalk.green(`✓ Renamed "${oldKey}" → "${newKey}"${touched ? ` (updated ${touched} manifest entries)` : ""}.`),
    );
  } else {
    console.log(chalk.green(`✓ Renamed "${oldKey}" → "${newKey}".`));
  }
}

/**
 * Default action when `notion-skills source` runs with no subcommand:
 * print a friendly summary that doubles as command help. Avoids commander's
 * default "missing subcommand" error which is unhelpful here since `source`
 * is itself a useful inspection command.
 */
export async function sourceHelpCommand(): Promise<void> {
  await sourceListCommand();
  console.log("");
  console.log(chalk.dim("Subcommands:"));
  console.log(chalk.dim("  source add                       link or create another source"));
  console.log(chalk.dim("  source list [--json]             show configured sources"));
  console.log(chalk.dim("  source remove <key>              remove a source (prompts for installed skills)"));
  console.log(chalk.dim("  source default <key>             set the default source"));
  console.log(chalk.dim("  source rename <old> <new>        rename a source key"));
}
