import type { Manifest, ManifestEntry } from "./manifest.js";
import type { Source } from "./sources.js";
import { findByKey, parseSkillRef, formatRef } from "./sources.js";

/**
 * Resolve a CLI-supplied ref ("team/deploy" or just "deploy") against
 * the installed manifest. Used by every command that operates on a
 * single installed skill: uninstall, open, publish (re-publish path),
 * and per-skill list lookups.
 *
 * Resolution order:
 *   - Qualified `<source>/<source-slug>`: exact match by source_key +
 *     source_slug. Returns not_found if no match.
 *   - Bare `<input>`:
 *       1. Exact local_slug match (the dir name on disk). One match → win.
 *       2. Otherwise, scan source_slug across all sources. Multiple →
 *          ambiguous (caller renders disambiguation hint).
 *
 * The local_slug-first rule means a user can always type the dir name
 * they see in `~/.claude/skills/` and get the expected entry, even when
 * the original source-side title has since been renamed.
 */
export type ResolveInstalledResult =
  | { ok: true; localSlug: string; entry: ManifestEntry; source: Source }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "unknown_source"; key: string }
  | { ok: false; reason: "ambiguous"; matches: string[] };

export function resolveInstalledRef(
  input: string,
  sources: Source[],
  manifest: Manifest,
): ResolveInstalledResult {
  const { sourceKey, slug } = parseSkillRef(input);

  if (sourceKey !== undefined) {
    const source = findByKey(sources, sourceKey);
    if (!source) return { ok: false, reason: "unknown_source", key: sourceKey };
    for (const [localSlug, entry] of Object.entries(manifest.skills)) {
      if (entry.source_key === sourceKey && entry.source_slug === slug) {
        return { ok: true, localSlug, entry, source };
      }
    }
    return { ok: false, reason: "not_found" };
  }

  // Bare input: local_slug exact match wins.
  const direct = manifest.skills[input];
  if (direct) {
    const source = findByKey(sources, direct.source_key);
    if (!source) return { ok: false, reason: "unknown_source", key: direct.source_key };
    return { ok: true, localSlug: input, entry: direct, source };
  }

  // Otherwise scan source_slug across all sources.
  const matches: Array<{ localSlug: string; entry: ManifestEntry }> = [];
  for (const [localSlug, entry] of Object.entries(manifest.skills)) {
    if (entry.source_slug === input) matches.push({ localSlug, entry });
  }
  if (matches.length === 0) return { ok: false, reason: "not_found" };
  if (matches.length === 1) {
    const m = matches[0]!;
    const source = findByKey(sources, m.entry.source_key);
    if (!source) return { ok: false, reason: "unknown_source", key: m.entry.source_key };
    return { ok: true, localSlug: m.localSlug, entry: m.entry, source };
  }
  return {
    ok: false,
    reason: "ambiguous",
    matches: matches.map((m) => formatRef(m.entry.source_key, m.entry.source_slug)),
  };
}

/**
 * Pick a non-colliding local_slug for a freshly-installed skill from a
 * source. Default = source_slug; if that's already taken on disk,
 * auto-namespace as `<source-key>-<slug>`. If THAT also collides,
 * append numeric suffix (-2, -3, ...).
 *
 * Returns:
 *   - `{ slug: <chosen>, autoNamespaced: false }` when the source slug
 *     was free
 *   - `{ slug: <chosen>, autoNamespaced: true }` when collision forced
 *     a prefix or numeric suffix
 *
 * A pure helper — caller decides whether to print a warning.
 */
export function chooseLocalSlug(
  sourceKey: string,
  sourceSlug: string,
  manifest: Manifest,
  override?: string,
): { slug: string; autoNamespaced: boolean } {
  if (override) {
    if (manifest.skills[override]) {
      // Override collides too — keep going. Caller is expected to have
      // already validated this won't happen, but be defensive.
      return appendUntilFree(override, manifest);
    }
    return { slug: override, autoNamespaced: false };
  }
  if (!manifest.skills[sourceSlug]) {
    return { slug: sourceSlug, autoNamespaced: false };
  }
  const namespaced = `${sourceKey}-${sourceSlug}`;
  if (!manifest.skills[namespaced]) {
    return { slug: namespaced, autoNamespaced: true };
  }
  return appendUntilFree(namespaced, manifest, true);
}

function appendUntilFree(
  base: string,
  manifest: Manifest,
  autoNamespaced = false,
): { slug: string; autoNamespaced: boolean } {
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!manifest.skills[candidate]) {
      return { slug: candidate, autoNamespaced };
    }
  }
  return { slug: `${base}-${Date.now().toString(36)}`, autoNamespaced };
}
