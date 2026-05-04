import { existsSync, lstatSync } from "node:fs";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KNOWN_TARGETS, findTargetByKey, type TargetDef } from "./known-targets.js";
import type { TargetKey } from "./paths.js";

export interface DetectedTarget {
  key: TargetKey;
  label: string;
  dir: string;
  installed: boolean;
}

export function detectTargets(): DetectedTarget[] {
  return KNOWN_TARGETS.map((t) => ({
    key: t.key,
    label: t.label,
    dir: t.dir,
    installed: existsSync(dirname(t.dir)), // parent (~/.claude, etc.) exists
  }));
}

export function targetsForKeys(keys: TargetKey[]): DetectedTarget[] {
  const out: DetectedTarget[] = [];
  for (const key of keys) {
    const t = findTargetByKey(key);
    if (!t) {
      // Skip unknown keys silently — could be left over from an older
      // scope.json after a target was renamed/removed.
      continue;
    }
    out.push({
      key: t.key,
      label: t.label,
      dir: t.dir,
      installed: existsSync(dirname(t.dir)),
    });
  }
  return out;
}

/** Re-export so callers can pick up the registry without juggling imports. */
export { KNOWN_TARGETS, findTargetByKey };
export type { TargetDef };

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
