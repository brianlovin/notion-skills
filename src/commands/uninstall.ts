import chalk from "chalk";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getScope } from "../scope.js";
import {
  hashContent,
  readManifest,
  writeManifest,
} from "../manifest.js";
import {
  removeSymlink,
  targetSkillPath,
  targetsForKeys,
} from "../targets.js";
import { MANIFEST_FILE, ROOT_DIR, SKILLS_STORE } from "../paths.js";

interface UninstallOptions {
  force?: boolean;
}

/**
 * Hard-remove a skill from this machine.
 *
 *   - Deletes ~/.notion-skills/skills/<slug>/.
 *   - Drops the manifest entry if present.
 *   - Removes symlinks from every target dir.
 *
 * Auto-backs up local edits before deletion if the SKILL.md content
 * has drifted from what the manifest stored at the last sync. Saves
 * to ~/.notion-skills/backup/uninstall-<ts>/<slug>/. The Notion page
 * is untouched (use `unpublish` to retire from the store).
 *
 * Works for installed skills AND drafts (central-store entries with
 * no manifest record). Same operation: remove from machine.
 */
export async function uninstallCommand(
  slug: string,
  _opts: UninstallOptions,
): Promise<void> {
  if (!slug) {
    throw new Error("Usage: notion-skills uninstall <slug>");
  }

  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  const skillDir = join(SKILLS_STORE, slug);
  if (!existsSync(skillDir)) {
    throw new Error(`Skill "${slug}" is not on this machine.`);
  }

  const manifest = await readManifest(MANIFEST_FILE);
  const entry = manifest?.skills[slug];

  // Auto-backup drift before destruction. Mirrors the safety net we
  // ship for sync's pull-overwrite path: any local edit gets a
  // timestamped copy in backup/ before we delete it.
  const skillFile = join(skillDir, "SKILL.md");
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
        console.log(
          chalk.dim(
            `Backed up local edits to ${homeRelative(dirname(backupDir))}`,
          ),
        );
      }
    } catch {
      // Backup is best-effort; never block the uninstall.
    }
  }

  // Remove symlinks first so a half-uninstall doesn't leave dangling links.
  const targets = targetsForKeys(scope.targets);
  for (const t of targets) {
    const link = targetSkillPath(t, slug);
    if (existsSync(link) || symlinkExists(link)) {
      await removeSymlink(link);
    }
  }

  // Wipe the central-store dir.
  await rm(skillDir, { recursive: true, force: true });

  // Drop manifest entry if present.
  if (manifest && entry) {
    const next = { ...manifest, skills: { ...manifest.skills } };
    delete next.skills[slug];
    next.last_synced_at = new Date().toISOString();
    await writeManifest(MANIFEST_FILE, next);
  }

  const wasInstalled = !!entry;
  console.log(
    chalk.green(
      `✓ ${wasInstalled ? "Uninstalled" : "Removed draft"} ${slug}.`,
    ),
  );
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

function homeRelative(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
