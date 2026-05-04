import { existsSync, lstatSync } from "node:fs";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KNOWN_TARGETS, type TargetKey } from "./paths.js";

export interface DetectedTarget {
  key: TargetKey;
  label: string;
  dir: string;
  installed: boolean;
}

export function detectTargets(): DetectedTarget[] {
  return (Object.entries(KNOWN_TARGETS) as [TargetKey, (typeof KNOWN_TARGETS)[TargetKey]][])
    .map(([key, info]) => ({
      key,
      label: info.label,
      dir: info.dir,
      installed: existsSync(dirname(info.dir)), // ~/.claude exists, etc.
    }));
}

export function targetsForKeys(keys: TargetKey[]): DetectedTarget[] {
  return keys.map((key) => ({
    key,
    label: KNOWN_TARGETS[key].label,
    dir: KNOWN_TARGETS[key].dir,
    installed: existsSync(dirname(KNOWN_TARGETS[key].dir)),
  }));
}

/**
 * Ensure a symlink at `linkPath` points to `realPath`.
 *
 * Returns:
 *   - "created"   if a new symlink was made
 *   - "ok"        if the symlink already existed and was correct
 *   - "skipped"   if a non-symlink (manually authored skill) is in the way
 *   - "fixed"     if a stale symlink was replaced
 */
export async function ensureSymlink(
  realPath: string,
  linkPath: string,
): Promise<"created" | "ok" | "skipped" | "fixed"> {
  await mkdir(dirname(linkPath), { recursive: true });

  if (!existsSync(linkPath)) {
    try {
      await symlink(realPath, linkPath);
      return "created";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return ensureSymlink(realPath, linkPath);
      }
      throw err;
    }
  }

  const stat = lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    return "skipped";
  }

  const current = await readlink(linkPath);
  if (current === realPath) return "ok";

  await rm(linkPath, { force: true });
  await symlink(realPath, linkPath);
  return "fixed";
}

export async function removeSymlink(linkPath: string): Promise<"removed" | "skipped" | "absent"> {
  if (!existsSync(linkPath)) {
    // Could be a dangling symlink — lstat through manual check
    try {
      lstatSync(linkPath);
    } catch {
      return "absent";
    }
  }
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return "absent";
  }
  if (!stat.isSymbolicLink()) return "skipped";
  await rm(linkPath, { force: true });
  return "removed";
}

export function targetSkillPath(target: DetectedTarget, skillName: string): string {
  return join(target.dir, skillName);
}
