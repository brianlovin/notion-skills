import chalk from "chalk";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { getScope } from "../scope.js";
import {
  type Manifest,
  hashContent,
  readManifest,
  writeManifest,
} from "../manifest.js";
import { NotionClient, readMultiSelect, readTitle } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { slugify } from "../convert.js";
import {
  removeSymlink,
  targetSkillPath,
  targetsForKeys,
} from "../targets.js";
import { MANIFEST_FILE, ROOT_DIR, SKILLS_STORE } from "../paths.js";
import { startTask } from "./_progress.js";

interface UninstallOptions {
  all?: boolean;
  tag?: string[];
  yes?: boolean;
}

/**
 * Remove skills from this machine.
 *
 *   - Deletes ~/.notion-skills/skills/<slug>/.
 *   - Drops the manifest entry if present.
 *   - Removes symlinks from every target dir.
 *
 * Surface mirrors `install`: pass slugs, `--tag <name>` (AND across
 * tags), or `--all`. Bulk modes confirm before destruction. Auto-backs
 * up local edits per skill before deletion if SKILL.md has drifted
 * from the manifest's `local_hash`. Saves to
 * ~/.notion-skills/backup/uninstall-<ts>/<slug>/. Notion pages are
 * untouched (use `unpublish` to retire from the store).
 *
 * Works for installed skills AND drafts (central-store entries with no
 * manifest record). Same operation: remove from machine.
 */
export async function uninstallCommand(
  slugs: string[],
  opts: UninstallOptions,
): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  if (!opts.all && !opts.tag?.length && slugs.length === 0) {
    throw new Error(
      "Usage: notion-skills uninstall <slug...> | --tag <name> | --all",
    );
  }

  const manifest = await readManifest(MANIFEST_FILE);
  const targetSlugs = await resolveTargets(slugs, opts, manifest, scope);
  if (targetSlugs.length === 0) {
    console.log(chalk.dim("No matching skills to remove."));
    return;
  }

  // Bulk modes (--all / --tag) get an explicit confirmation. Single-
  // slug uninstalls (the historical interactive path) skip it for
  // muscle-memory parity with `npm uninstall`.
  const isBulk = !!opts.all || (opts.tag && opts.tag.length > 0);
  if (isBulk && !opts.yes) {
    const ok = await confirm({
      message: `Remove ${targetSlugs.length} ${
        targetSlugs.length === 1 ? "skill" : "skills"
      } from this machine?`,
      default: false,
    });
    if (!ok) {
      console.log(chalk.dim("Aborted."));
      return;
    }
  }

  console.log(
    chalk.bold(
      `Removing ${targetSlugs.length} ${targetSlugs.length === 1 ? "skill" : "skills"}:`,
    ),
  );

  const targets = targetsForKeys(scope.targets);
  const removedInstalled: string[] = [];
  const removedDrafts: string[] = [];
  const failed: string[] = [];

  // Build the next-manifest copy once and mutate per skill so a partial
  // failure leaves a coherent state for the survivors.
  const nextManifest: Manifest | null = manifest
    ? { ...manifest, skills: { ...manifest.skills } }
    : null;

  for (const slug of targetSlugs) {
    const task = startTask(slug);
    try {
      const skillDir = join(SKILLS_STORE, slug);
      const skillFile = join(skillDir, "SKILL.md");
      const entry = manifest?.skills[slug];

      if (existsSync(skillFile) && entry?.local_hash) {
        try {
          const current = await readFile(skillFile, "utf8");
          if (hashContent(current) !== entry.local_hash) {
            const backupDir = join(
              ROOT_DIR,
              "backup",
              `uninstall-${timestamp()}`,
              slug,
            );
            await mkdir(backupDir, { recursive: true });
            await writeFile(join(backupDir, "SKILL.md"), current, "utf8");
          }
        } catch {
          // Backup is best-effort; never block the uninstall.
        }
      }

      for (const t of targets) {
        const link = targetSkillPath(t, slug);
        if (existsSync(link) || symlinkExists(link)) {
          await removeSymlink(link);
        }
      }

      if (existsSync(skillDir)) {
        await rm(skillDir, { recursive: true, force: true });
      }

      if (nextManifest && entry) {
        delete nextManifest.skills[slug];
        removedInstalled.push(slug);
      } else {
        removedDrafts.push(slug);
      }

      task.done();
    } catch (err) {
      failed.push(slug);
      task.fail((err as Error).message.split("\n")[0]);
    }
  }

  if (nextManifest) {
    nextManifest.last_synced_at = new Date().toISOString();
    await writeManifest(MANIFEST_FILE, nextManifest);
  }

  console.log("");
  const ok = removedInstalled.length + removedDrafts.length;
  if (failed.length === 0) {
    const parts: string[] = [];
    if (removedInstalled.length > 0) {
      parts.push(
        `Uninstalled ${removedInstalled.length} ${removedInstalled.length === 1 ? "skill" : "skills"}`,
      );
    }
    if (removedDrafts.length > 0) {
      parts.push(
        `removed ${removedDrafts.length} ${removedDrafts.length === 1 ? "draft" : "drafts"}`,
      );
    }
    console.log(chalk.green(`✓ ${parts.join(", ")}.`));
  } else {
    console.log(
      chalk.yellow(
        `Removed ${ok}; ${failed.length} failed: ${failed.join(", ")}`,
      ),
    );
  }
}

/**
 * Translate a (slugs[], --tag, --all) request into the concrete set of
 * slugs to remove. Validates that requested slugs are actually on this
 * machine; tags are matched against installed-skill metadata pulled
 * fresh from Notion (so newly-added tags are visible without sync).
 */
async function resolveTargets(
  slugs: string[],
  opts: UninstallOptions,
  manifest: Manifest | null,
  scope: { data_source_id: string },
): Promise<string[]> {
  // Dir-based discovery covers both installed (manifest entry) and
  // drafts (no manifest entry). Both are valid uninstall targets.
  const onDisk = listSkillDirs();
  const installed = new Set(Object.keys(manifest?.skills ?? {}));

  if (opts.all) {
    if (opts.tag && opts.tag.length > 0) {
      throw new Error("--all and --tag are mutually exclusive.");
    }
    if (slugs.length > 0) {
      throw new Error("--all and explicit slugs are mutually exclusive.");
    }
    // --all means "every installed skill on this machine." Drafts are
    // intentionally excluded — wiping unpublished work without an
    // explicit slug would be surprising.
    return [...installed].sort();
  }

  if (opts.tag && opts.tag.length > 0) {
    if (slugs.length > 0) {
      throw new Error("--tag and explicit slugs are mutually exclusive.");
    }
    await assertNtnInstalled();
    const client = new NotionClient();
    const pages = await client.queryDataSource(scope.data_source_id);
    const wanted = opts.tag
      .flatMap((t) => t.split(","))
      .map((t) => t.trim())
      .filter(Boolean);
    const matched: string[] = [];
    for (const page of pages) {
      if (page.archived || page.in_trash) continue;
      const title = readTitle(page.properties);
      if (!title) continue;
      const slug = slugify(title);
      if (!installed.has(slug)) continue;
      const tags = readMultiSelect(page.properties, "Tags");
      if (wanted.every((w) => tags.includes(w))) matched.push(slug);
    }
    if (matched.length === 0) {
      throw new Error(
        `No installed skills found with ${wanted.length === 1 ? "tag" : "all of tags"} ${wanted.join(", ")}.`,
      );
    }
    return matched.sort();
  }

  // Explicit slug list: validate every entry is on this machine
  // (installed OR draft). We don't auto-skip missing — surfaces typos.
  const valid = new Set(onDisk);
  const missing = slugs.filter((s) => !valid.has(s));
  if (missing.length > 0) {
    throw new Error(
      `Cannot remove: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on this machine. Run \`notion-skills list --installed\` to see what's installed.`,
    );
  }
  return slugs;
}

function listSkillDirs(): string[] {
  if (!existsSync(SKILLS_STORE)) return [];
  try {
    return readdirSync(SKILLS_STORE, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function symlinkExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "_" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}
