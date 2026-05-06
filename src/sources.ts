/**
 * A "source" is one Notion database that holds skill pages. Multi-source
 * support means a user can configure several of these (engineering DB +
 * personal DB, etc.) and resolve commands across them.
 *
 * The `key` is a stable, user-chosen handle (defaults to a slug derived
 * from the database title). It's used in CLI args (`team/deploy`,
 * `--source team`), in manifest entries, and as the namespace for slug
 * collision avoidance. Renaming a source rewrites every manifest entry's
 * `source_key` field.
 *
 * `default: true` on at most one source. The default is the implicit
 * target for bare commands; if no default is set and multiple sources
 * exist, commands that need exactly one source will prompt the user.
 */
export interface Source {
  key: string;
  name: string;
  database_id: string;
  data_source_id: string;
  default?: boolean;
  added_at: string;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const KEY_MAX = 32;

export function validateKey(key: string): string | null {
  if (!key || key.length === 0) return "key cannot be empty";
  if (key.length > KEY_MAX) return `key must be ${KEY_MAX} characters or fewer`;
  if (!KEY_RE.test(key)) {
    return "key must be lowercase letters, digits, and hyphens (starting with a letter or digit)";
  }
  return null;
}

export function findByKey(sources: Source[], key: string): Source | undefined {
  return sources.find((s) => s.key === key);
}

export function findByDatabaseId(sources: Source[], databaseId: string): Source | undefined {
  return sources.find((s) => s.database_id === databaseId);
}

export function defaultSource(sources: Source[]): Source | undefined {
  return sources.find((s) => s.default);
}

/**
 * Pure slug-from-title transform. No collision handling; caller decides
 * what to do when this collides with an existing key. Used by `source
 * add` so it can detect "would collide?" and only prompt in that case.
 */
export function slugifyDbTitle(databaseTitle: string): string {
  return (
    databaseTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, KEY_MAX) || "source"
  );
}

/**
 * Slug-from-title with collision avoidance. Suffix `-2`, `-3`, … until
 * unique. Used at v1→v2 migration time and as the prompt default in
 * `source add` when a collision forces re-prompting.
 */
export function deriveKey(databaseTitle: string, existingKeys: Set<string>): string {
  const base = slugifyDbTitle(databaseTitle);
  if (!existingKeys.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, KEY_MAX);
    if (!existingKeys.has(candidate)) return candidate;
  }
  // Pathological: 1000+ collisions. Fall through to a hashlike suffix.
  return `${base}-${Date.now().toString(36)}`.slice(0, KEY_MAX);
}

/**
 * Parse a CLI ref like "team/deploy" into its parts. Returns `slug` only
 * for bare refs ("deploy"); `sourceKey` is undefined in that case and
 * the caller resolves it against scope.
 */
export function parseSkillRef(input: string): { sourceKey?: string; slug: string } {
  const idx = input.indexOf("/");
  if (idx === -1) return { slug: input };
  return { sourceKey: input.slice(0, idx), slug: input.slice(idx + 1) };
}

/**
 * Build the global identifier used in user-facing output: "team/deploy".
 * This is the canonical way to print a skill across sources; the manifest
 * itself is keyed by local_slug, not this string.
 */
export function formatRef(sourceKey: string, sourceSlug: string): string {
  return `${sourceKey}/${sourceSlug}`;
}

export type ResolveTargetResult =
  | { ok: true; source: Source }
  | { ok: false; reason: "no_sources" }
  | { ok: false; reason: "unknown_key"; key: string }
  | { ok: false; reason: "ambiguous"; sources: Source[] };

/**
 * Pick the single source a command should target. Used by every
 * command that operates on exactly one source (publish, source-scoped
 * install, etc.).
 *
 * Order:
 *   1. Explicit `--source <key>` → that source (or unknown_key error).
 *   2. Exactly one configured source → it.
 *   3. A source has `default: true` → it.
 *   4. Otherwise → ambiguous; caller decides whether to prompt or error.
 */
export function resolveTargetSource(
  flag: string | undefined,
  sources: Source[],
): ResolveTargetResult {
  if (sources.length === 0) return { ok: false, reason: "no_sources" };
  if (flag !== undefined) {
    const s = findByKey(sources, flag);
    return s ? { ok: true, source: s } : { ok: false, reason: "unknown_key", key: flag };
  }
  if (sources.length === 1) return { ok: true, source: sources[0]! };
  const def = defaultSource(sources);
  if (def) return { ok: true, source: def };
  return { ok: false, reason: "ambiguous", sources };
}

/**
 * Sanitise a sources array: enforce at-most-one default, dedupe by key
 * (last wins), and dedupe by database_id (first wins). Used at scope-
 * read time so a hand-edited or partially-corrupt scope.json still
 * produces a coherent in-memory state.
 */
export function sanitiseSources(input: Source[]): Source[] {
  const byKey = new Map<string, Source>();
  const seenDbs = new Set<string>();
  for (const s of input) {
    if (seenDbs.has(s.database_id)) continue;
    seenDbs.add(s.database_id);
    byKey.set(s.key, s);
  }
  const out = [...byKey.values()];
  // Collapse multiple defaults to the first.
  let seenDefault = false;
  for (const s of out) {
    if (s.default) {
      if (seenDefault) s.default = false;
      else seenDefault = true;
    }
  }
  return out;
}
