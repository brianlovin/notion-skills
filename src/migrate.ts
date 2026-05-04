import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import { slugify, splitToolsRespectingParens } from "./convert.js";
import type { SkillProperties } from "./notion.js";
import { SKILLS_STORE } from "./paths.js";

export interface ParsedSkill {
  name: string;          // slugified
  title: string;         // raw frontmatter name or dir name
  description: string;
  body: string;          // markdown body, frontmatter stripped
  source: string;        // realpath to skill dir
  sourceDisplay: string; // human-friendly path (link path, not realpath)
  /** Full spec frontmatter, ready to push to Notion. */
  properties: SkillProperties;
}

export type Classification =
  | { kind: "new"; skill: ParsedSkill }
  | { kind: "conflict"; skill: ParsedSkill; existingPageId: string; existingTitle: string }
  | { kind: "managed"; sourceDisplay: string; name: string }
  | { kind: "invalid"; sourceDisplay: string; reason: string };

// ---------- discovery ----------

export interface DiscoverOptions {
  /** Directories that contain `<skill-name>/SKILL.md` children. */
  sourceDirs: string[];
}

export async function discoverSkills(opts: DiscoverOptions): Promise<Classification[]> {
  const out: Classification[] = [];
  const seenRealpaths = new Set<string>();

  for (const dir of opts.sourceDirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const sourceDisplay = join(dir, entry);

      let realpath: string;
      try {
        realpath = realpathSync(sourceDisplay);
      } catch {
        out.push({ kind: "invalid", sourceDisplay, reason: "broken symlink" });
        continue;
      }

      // Skip already-managed skills (point into our central store).
      if (realpath.startsWith(SKILLS_STORE + "/") || realpath === SKILLS_STORE) {
        out.push({ kind: "managed", sourceDisplay, name: entry });
        continue;
      }

      // Dedup by realpath: same skill symlinked from multiple targets.
      if (seenRealpaths.has(realpath)) continue;
      seenRealpaths.add(realpath);

      // Must be a directory.
      try {
        if (!lstatSync(realpath).isDirectory()) {
          out.push({ kind: "invalid", sourceDisplay, reason: "not a directory" });
          continue;
        }
      } catch {
        out.push({ kind: "invalid", sourceDisplay, reason: "stat failed" });
        continue;
      }

      const skillMdPath = join(realpath, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        out.push({ kind: "invalid", sourceDisplay, reason: "no SKILL.md" });
        continue;
      }

      const parsed = await parseSkillFile(skillMdPath, realpath, sourceDisplay, entry);
      if ("error" in parsed) {
        out.push({ kind: "invalid", sourceDisplay, reason: parsed.error });
      } else {
        out.push({ kind: "new", skill: parsed.skill });
      }
    }
  }

  return out;
}

// ---------- frontmatter ----------

interface ParseError { error: string }
interface ParseOk { skill: ParsedSkill }

export async function parseSkillFile(
  skillMdPath: string,
  sourceRealpath: string,
  sourceDisplay: string,
  fallbackName: string,
): Promise<ParseOk | ParseError> {
  let raw: string;
  try {
    raw = await readFile(skillMdPath, "utf8");
  } catch (err) {
    return { error: `read failed: ${(err as Error).message}` };
  }

  const fm = extractFrontmatter(raw);
  if (!fm) {
    return {
      error: "no frontmatter — expected `---` delimited YAML at top of SKILL.md",
    };
  }

  let parsedFm: Record<string, unknown>;
  try {
    parsedFm = (yamlParse(fm.text) ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { error: `frontmatter YAML parse error: ${(err as Error).message}` };
  }

  const titleRaw = (parsedFm.name as string | undefined) ?? fallbackName;
  const description = String(parsedFm.description ?? "").trim();
  if (!description) {
    return { error: "frontmatter has no `description`" };
  }

  const body = stripLeadingTitle(fm.body, titleRaw).trim();
  const slug = slugify(titleRaw);
  if (!slug) return { error: "could not derive a valid slug from name" };

  const properties: SkillProperties = {
    name: slug,
    description,
    when_to_use: optionalString(parsedFm.when_to_use),
    "argument-hint": optionalString(parsedFm["argument-hint"]),
    arguments: optionalList(parsedFm.arguments, /\s+/),
    "allowed-tools": optionalToolsList(parsedFm["allowed-tools"]),
    paths: optionalList(parsedFm.paths, /\s*,\s*/),
    "disable-model-invocation": optionalBoolString(parsedFm["disable-model-invocation"]),
    "user-invocable": optionalBoolString(parsedFm["user-invocable"]),
    model: optionalString(parsedFm.model),
    effort: optionalString(parsedFm.effort),
    context: optionalString(parsedFm.context),
    agent: optionalString(parsedFm.agent),
    shell: optionalString(parsedFm.shell),
  };

  return {
    skill: {
      name: slug,
      title: String(titleRaw),
      description,
      body,
      source: sourceRealpath,
      sourceDisplay,
      properties,
    },
  };
}

function optionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function optionalBoolString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "false") return s;
  return undefined;
}

function optionalList(v: unknown, splitOn: RegExp): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const items = v.map((x) => String(x).trim()).filter(Boolean);
    return items.length === 0 ? undefined : items;
  }
  const s = String(v).trim();
  if (!s) return undefined;
  const items = s.split(splitOn).map((x) => x.trim()).filter(Boolean);
  return items.length === 0 ? undefined : items;
}

/**
 * Like optionalList but uses a paren-aware splitter for the
 * `allowed-tools` field, where tools like `Bash(git *)` contain spaces.
 */
function optionalToolsList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const items = v.map((x) => String(x).trim()).filter(Boolean);
    return items.length === 0 ? undefined : items;
  }
  const s = String(v).trim();
  if (!s) return undefined;
  const items = splitToolsRespectingParens(s);
  return items.length === 0 ? undefined : items;
}

interface ExtractedFrontmatter {
  text: string;
  body: string;
}

function extractFrontmatter(raw: string): ExtractedFrontmatter | null {
  // Allow optional BOM and leading whitespace before the opening `---`.
  const normalized = raw.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return null;
  // Find the matching closing delimiter on its own line.
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;
  return { text: match[1] ?? "", body: match[2] ?? "" };
}

/**
 * If the body's first non-blank line is `# <Title>` matching the skill name,
 * drop it. ntn strips the first H1 server-side when we set page content, so
 * this avoids the round-trip writing-then-losing the H1.
 */
function stripLeadingTitle(body: string, title: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length) return body;
  const first = lines[i]!.trim();
  const m = first.match(/^#\s+(.+)$/);
  if (!m) return body;
  // Drop if the H1 text roughly matches the title (case-insensitive, slug-equal).
  const h1 = m[1]!.trim();
  if (
    h1.toLowerCase() === title.toLowerCase() ||
    slugify(h1) === slugify(title)
  ) {
    lines.splice(i, 1);
    // Also eat one blank line after the heading.
    if (i < lines.length && lines[i]!.trim() === "") lines.splice(i, 1);
    return lines.join("\n");
  }
  return body;
}

// ---------- conflict detection ----------

/**
 * Given a set of new skills and a map of name → page_id from the live data
 * source, mark conflicts. Mutates and returns the input list.
 */
export function markConflicts(
  classifications: Classification[],
  existingPagesByName: Map<string, { pageId: string; title: string }>,
): Classification[] {
  return classifications.map((c) => {
    if (c.kind !== "new") return c;
    const existing = existingPagesByName.get(c.skill.name);
    if (existing) {
      return {
        kind: "conflict",
        skill: c.skill,
        existingPageId: existing.pageId,
        existingTitle: existing.title,
      };
    }
    return c;
  });
}

// ---------- safety check ----------

/**
 * True iff the source path lives inside one of the configured scope target
 * dirs (e.g. ~/.claude/skills). Migration may safely move such sources to
 * a backup because the user expects skills there to be replaced by symlinks.
 *
 * Sources outside the scope (--from paths, symlinks reaching into a separate
 * repo) must never be moved — that would silently delete the user's
 * authoritative content.
 */
export function sourceIsInScope(source: string, scopeTargetDirs: string[]): boolean {
  return scopeTargetDirs.some((d) => {
    const normalized = d.endsWith("/") ? d : d + "/";
    return source === d || source.startsWith(normalized);
  });
}

// ---------- source resolution ----------

/**
 * Resolve which dirs to scan based on scope + --from flags.
 * For a global scope we pull in target dirs (~/.claude/skills, etc).
 * For a project scope we use <repo>/.claude/skills.
 * Extras from --from are always appended.
 */
export function resolveSourceDirs(
  scopeKind: "global" | "project",
  options: { extras?: string[]; targetDirs?: string[]; projectSkillsDir?: string },
): string[] {
  const dirs: string[] = [];
  if (scopeKind === "global" && options.targetDirs) {
    dirs.push(...options.targetDirs);
  }
  if (scopeKind === "project" && options.projectSkillsDir) {
    dirs.push(options.projectSkillsDir);
  }
  for (const extra of options.extras ?? []) {
    dirs.push(resolve(extra));
  }
  // Dedup paths.
  return [...new Set(dirs)];
}
