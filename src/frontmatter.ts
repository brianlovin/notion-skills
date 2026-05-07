/**
 * Single helper for splitting + reading + editing skill frontmatter.
 *
 * Several call sites (audit, add, list, migrate) had their own
 * variants — some regex-based, some yaml-based, with subtly
 * different fallback behavior. Consolidating here means:
 *   - one yaml dependency point (we already use the `yaml` lib
 *     elsewhere; no new dep)
 *   - consistent handling of multi-line descriptions, BOM, edge
 *     cases like missing closing `---`
 *   - one place to update if the spec changes
 */

import { Document, parseDocument, isMap, type YAMLMap, parse as parseYaml } from "yaml";

export interface SplitResult {
  /** The frontmatter as a key→value map. Empty when frontmatter is
   *  missing or malformed. Values are whatever yaml parsed them to
   *  (string / number / bool / list / nested map). */
  frontmatter: Record<string, unknown>;
  /** The body following the closing `---`. When no frontmatter is
   *  detected, this is the original text (BOM-stripped). */
  body: string;
  /** True when a well-formed `---\n...\n---` block was found and
   *  yaml-parsed successfully. False when the file lacks frontmatter
   *  OR the YAML failed to parse. */
  hasFrontmatter: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Strip BOM, locate the frontmatter block, parse it as YAML, return
 * a structured view. Tolerant: malformed YAML or missing frontmatter
 * → returns `hasFrontmatter: false`, body = full original text.
 */
export function parseFrontmatter(text: string): SplitResult {
  const stripped = text.replace(/^﻿/, "");
  const match = stripped.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: stripped, hasFrontmatter: false };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { frontmatter: {}, body: match[2] ?? "", hasFrontmatter: false };
  }
  const frontmatter =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: match[2] ?? "", hasFrontmatter: true };
}

/**
 * Read a single field from the frontmatter as a string. Returns
 * empty string when the field is missing or non-string. Useful for
 * cheap checks like `description` length, where you don't need to
 * walk a whole structure.
 */
export function readFrontmatterString(text: string, key: string): string {
  const { frontmatter } = parseFrontmatter(text);
  const value = frontmatter[key];
  return typeof value === "string" ? value : "";
}

/**
 * Read a frontmatter field as a list of strings. Accepts:
 *   - block-form: `key:\n  - a\n  - b`
 *   - flow-form:  `key: [a, b]`
 *   - inline csv: `key: a, b, c`
 * Non-string values are dropped. Missing key → empty array.
 */
export function readFrontmatterList(text: string, key: string): string[] {
  const { frontmatter } = parseFrontmatter(text);
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    // Inline CSV form (`key: a, b, c`) round-tripped through yaml as
    // a string. Split on commas and trim.
    return value
      .split(/\s*,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export interface InjectMetadataOptions {
  /** When true and the key already exists, leave the value alone
   *  (user-authored wins). When false, overwrite. Defaults to true. */
  preserveExisting?: boolean;
}

/**
 * Inject `metadata.<key> = <value>` into a SKILL.md's frontmatter
 * non-destructively. Preserves the rest of the frontmatter's
 * formatting (quoting, key order, comments) by editing through
 * yaml's `Document` API rather than splicing strings.
 *
 * Cases handled:
 *   - No frontmatter at all: synthesise a minimal block with the
 *     metadata.<key> set. The skill is still broken at the spec
 *     level (no name/description) but at least preserves whatever
 *     body the caller wrote.
 *   - Malformed frontmatter / non-map root: return text unchanged.
 *     Better to leave the skill alone than rewrite something that
 *     might be hand-edited weirdly.
 *   - Metadata block missing entirely: add it with just the new key.
 *   - Metadata block exists, key absent: add the key inside.
 *   - Key (or its case-insensitive equivalent) already present and
 *     `preserveExisting` is true: return text unchanged. The user's
 *     value wins.
 */
export function injectMetadataKey(
  text: string,
  key: string,
  value: string,
  options: InjectMetadataOptions = {},
): string {
  const preserveExisting = options.preserveExisting ?? true;

  const stripped = text.replace(/^﻿/, "");
  const match = stripped.match(FRONTMATTER_RE);
  if (!match) {
    return `---\nmetadata:\n  ${key}: ${JSON.stringify(value)}\n---\n\n${stripped}`;
  }
  const [, fmText, body] = match;
  let doc;
  try {
    doc = parseDocument(fmText ?? "");
  } catch {
    return text;
  }
  if (!doc.contents || !isMap(doc.contents)) return text;

  let metadata = doc.get("metadata") as YAMLMap | undefined;
  if (!metadata || !isMap(metadata)) {
    metadata = new Document().createNode({}) as YAMLMap;
    doc.set("metadata", metadata);
  }

  if (preserveExisting) {
    // Respect any pre-existing key (case-insensitive — covers users
    // who hand-wrote `origin` lowercase even though we now ship
    // `Origin`).
    const lower = key.toLowerCase();
    for (const item of metadata.items) {
      const k = String(item.key);
      if (k === key || k.toLowerCase() === lower) return text;
    }
  }

  metadata.set(key, value);
  return `---\n${doc.toString().trimEnd()}\n---\n${body ?? ""}`;
}
