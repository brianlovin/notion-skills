import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Manifest, readManifest, writeManifest } from "./manifest.js";
import { MANIFEST_FILE, SKILLS_STORE } from "./paths.js";
import { type Scope, writeScope } from "./scope.js";
import { removeSymlink, targetSkillPath, targetsForKeys } from "./targets.js";

export type SourceRemovalMode = "uninstall" | "keep";

export interface SourceRemovalResult {
  mode: SourceRemovalMode;
  affectedLocalSlugs: string[];
}

/**
 * Drop a source from scope.json and reconcile manifest + filesystem.
 *
 *   - mode = "uninstall": delete skill dirs and target symlinks too.
 *   - mode = "keep": leave dirs and symlinks; just clear the manifest
 *     entries so the skills become local-only drafts.
 *
 * Mutates `scope.sources` in place and writes both files. Used by the
 * `source remove` command and by sync's deleted-source disconnect flow.
 */
export async function applySourceRemoval(
  scope: Scope,
  key: string,
  mode: SourceRemovalMode,
): Promise<SourceRemovalResult> {
  const manifest = await loadManifestForKey(scope, key);
  const installedFromSource = manifest
    ? Object.entries(manifest.skills).filter(([, e]) => e.source_key === key)
    : [];

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
    for (const [localSlug] of installedFromSource) {
      delete manifest.skills[localSlug];
    }
    await writeManifest(MANIFEST_FILE, manifest);
  }

  scope.sources = scope.sources.filter((s) => s.key !== key);
  await writeScope({
    sources: scope.sources,
    targets: scope.targets,
    gen_agent: scope.gen_agent,
  });

  return {
    mode,
    affectedLocalSlugs: installedFromSource.map(([slug]) => slug),
  };
}

async function loadManifestForKey(scope: Scope, key: string): Promise<Manifest | null> {
  const fallbackKey = scope.sources[0]?.key ?? key;
  return readManifest(MANIFEST_FILE, fallbackKey);
}
