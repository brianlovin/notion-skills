/**
 * Skill quality audit. Run a set of pure rules against a parsed skill;
 * surface issues with a severity. Used by `notion-skills audit` and
 * (in the future) by `publish` as a pre-flight quality gate.
 *
 * Rules are deliberately conservative: they catch the common stub /
 * test-leftover / agent-routing problems we've seen in real skill
 * stores. Each rule explains *why* it exists in its `description`.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Optional 1-based line number for body-anchored issues. */
  line?: number;
}

export interface AuditTarget {
  /** local_slug (the dir name on disk). */
  localSlug: string;
  /** Frontmatter parsed as a key→value map. Strings only at this layer. */
  frontmatter: Record<string, unknown>;
  /** Full body text, NOT including the frontmatter block. */
  body: string;
  /** Sibling files (multi-file skills); paths relative to skill dir. */
  files: { path: string; size: number }[];
}

export interface RuleDef {
  id: string;
  severity: Severity;
  description: string;
  run(target: AuditTarget): Issue | null;
}

// ---------- rule registry ----------

export const RULES: RuleDef[] = [
  // -------- structural / hard errors --------

  {
    id: "frontmatter-missing-name",
    severity: "error",
    description: "Frontmatter must include a `name` field — required by the spec.",
    run(t) {
      const name = stringOrEmpty(t.frontmatter["name"]);
      if (!name) {
        return mk("frontmatter-missing-name", "error", "frontmatter is missing the required `name` field");
      }
      return null;
    },
  },
  {
    id: "description-empty",
    severity: "error",
    description: "Frontmatter must include a non-empty `description`. Without it, agents can't decide when to load the skill.",
    run(t) {
      const desc = stringOrEmpty(t.frontmatter["description"]);
      if (!desc.trim()) {
        return mk("description-empty", "error", "frontmatter `description` is missing or empty");
      }
      return null;
    },
  },
  {
    id: "body-empty",
    severity: "error",
    description: "A skill with no body is unusable — agents have nothing to act on.",
    run(t) {
      if (t.body.trim().length === 0) {
        return mk("body-empty", "error", "skill body is empty (frontmatter only)");
      }
      return null;
    },
  },

  // -------- description quality --------

  {
    id: "description-short",
    severity: "warning",
    description: "Spec recommends a 1–2 sentence description with specific trigger keywords.",
    run(t) {
      const desc = stringOrEmpty(t.frontmatter["description"]).trim();
      if (desc.length === 0) return null; // covered by description-empty
      if (desc.length < 30) {
        return mk(
          "description-short",
          "warning",
          `description is ${desc.length} chars; spec recommends 1–2 sentences with trigger keywords`,
        );
      }
      return null;
    },
  },
  {
    id: "description-too-long",
    severity: "warning",
    description: "Descriptions over 1024 chars hit the agentskills.io spec ceiling and can hurt routing.",
    run(t) {
      const desc = stringOrEmpty(t.frontmatter["description"]);
      if (desc.length > 1024) {
        return mk(
          "description-too-long",
          "warning",
          `description is ${desc.length} chars; spec ceiling is 1024 — split into multiple skills or trim`,
        );
      }
      return null;
    },
  },
  {
    id: "description-no-trigger",
    severity: "info",
    description: "Effective descriptions name the trigger explicitly ('Use when…', 'Use to…', etc.) so agents route reliably.",
    run(t) {
      const desc = stringOrEmpty(t.frontmatter["description"]).toLowerCase();
      if (!desc.trim()) return null;
      // Trigger keywords from spec guidance + common patterns: "use
      // when…", "use to…", "use after…", "use this skill when…",
      // "invoke when…", "for …" (e.g. "for X workflows"). Coverage
      // matters more than precision here — false positives just
      // suppress an info-level hint.
      const triggers = [
        "use when",
        "use to",
        "use for",
        "use after",
        "use before",
        "use this",
        "invoke when",
        "trigger",
        "when the user",
        "when you",
        "for ",
      ];
      if (!triggers.some((t) => desc.includes(t))) {
        return mk(
          "description-no-trigger",
          "info",
          "description doesn't include trigger keywords (e.g. 'Use when…') — agents may underuse this skill",
        );
      }
      return null;
    },
  },

  // -------- body content checks --------

  {
    id: "body-test-marker",
    severity: "warning",
    description: "Test scaffolding artifacts ('MATRIX-', 'TODO-DELETE', etc.) shouldn't ship in a published skill.",
    run(t) {
      const patterns = [
        /MATRIX-[A-Z][A-Z0-9_-]+/,
        /TODO[-_ ]DELETE/i,
        /\bPLACEHOLDER\b/,
        /\bDO NOT SHIP\b/i,
      ];
      const lines = t.body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const re of patterns) {
          const match = line.match(re);
          if (match) {
            return mk(
              "body-test-marker",
              "warning",
              `test marker "${match[0]}" found in body`,
              i + 1,
            );
          }
        }
      }
      return null;
    },
  },
  {
    id: "body-short",
    severity: "info",
    description: "A body under 100 chars is usually a stub. Add concrete steps / examples.",
    run(t) {
      const trimmed = t.body.trim();
      if (trimmed.length === 0) return null; // covered by body-empty
      if (trimmed.length < 100) {
        return mk("body-short", "info", `body is ${trimmed.length} chars — likely a stub`);
      }
      return null;
    },
  },
  {
    id: "arg-ref-without-arguments",
    severity: "warning",
    description: "Body references positional args ($1, $2, $ARGUMENTS) but the frontmatter doesn't declare an `arguments:` schema or `argument-hint`.",
    run(t) {
      // The spec also accepts `argument-hint:` as a substitute for the
      // structured `arguments:` list — it's a free-form string that
      // tells the user what to pass. Either satisfies this rule.
      const hasArgs =
        Array.isArray(t.frontmatter["arguments"]) ||
        (typeof t.frontmatter["argument-hint"] === "string" &&
          t.frontmatter["argument-hint"].trim().length > 0);
      if (hasArgs) return null;
      const argRefs = /\$ARGUMENTS\b|\$\d+\b/;
      const lines = t.body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i]!.match(argRefs);
        if (match) {
          return mk(
            "arg-ref-without-arguments",
            "warning",
            `body references "${match[0]}" but no \`arguments:\` or \`argument-hint:\` is declared`,
            i + 1,
          );
        }
      }
      return null;
    },
  },
  {
    id: "tool-ref-without-allow",
    severity: "info",
    description: "Body mentions a specific tool (Bash, WebFetch, etc.) but `allowed-tools` doesn't list it. May surface as a runtime denial.",
    run(t) {
      const allowed = stringOrEmpty(t.frontmatter["allowed-tools"]).split(/\s+/).filter(Boolean);
      if (allowed.length === 0) return null; // unconstrained skill
      const knownTools = ["Bash", "WebFetch", "WebSearch", "Read", "Edit", "Write"];
      for (const tool of knownTools) {
        const re = new RegExp(`\\b${tool}\\b`);
        if (re.test(t.body) && !allowed.some((a) => a === tool || a.startsWith(`${tool}(`))) {
          return mk(
            "tool-ref-without-allow",
            "info",
            `body references "${tool}" but it's not in \`allowed-tools\``,
          );
        }
      }
      return null;
    },
  },

  // -------- multi-file checks --------

  {
    id: "empty-sibling-file",
    severity: "warning",
    description: "Empty sibling files round-trip as empty Notion sub-pages — usually a stub the author forgot to fill.",
    run(t) {
      for (const f of t.files) {
        if (f.size === 0) {
          return mk(
            "empty-sibling-file",
            "warning",
            `sibling file "${f.path}" is empty`,
          );
        }
      }
      return null;
    },
  },
];

// ---------- runner ----------

export function auditSkill(target: AuditTarget): Issue[] {
  const issues: Issue[] = [];
  for (const rule of RULES) {
    const issue = rule.run(target);
    if (issue) issues.push(issue);
  }
  return issues;
}

export function summariseIssues(issues: Issue[]): {
  errors: number;
  warnings: number;
  infos: number;
} {
  const out = { errors: 0, warnings: 0, infos: 0 };
  for (const i of issues) {
    if (i.severity === "error") out.errors++;
    else if (i.severity === "warning") out.warnings++;
    else out.infos++;
  }
  return out;
}

// ---------- on-disk loader ----------

/**
 * Load a skill on disk into the pure AuditTarget shape. Used by the
 * `audit` command; pure helpers don't read disk.
 */
export async function loadAuditTarget(
  localSlug: string,
  skillDir: string,
): Promise<AuditTarget | null> {
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return null;
  const raw = await readFile(skillFile, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const files = await listSiblingFiles(skillDir);
  return { localSlug, frontmatter, body, files };
}

function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const stripped = text.replace(/^﻿/, "");
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: stripped };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { frontmatter: {}, body: match[2] ?? "" };
  }
  const fm =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter: fm, body: match[2] ?? "" };
}

async function listSiblingFiles(skillDir: string): Promise<{ path: string; size: number }[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const out: { path: string; size: number }[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "SKILL.md" && prefix === "") continue;
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          out.push({ path: rel, size: s.size });
        } catch {
          // skip unreadable
        }
      }
    }
  }
  await walk(skillDir, "");
  return out;
}

// ---------- helpers ----------

function mk(ruleId: string, severity: Severity, message: string, line?: number): Issue {
  return line !== undefined
    ? { ruleId, severity, message, line }
    : { ruleId, severity, message };
}

function stringOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}
