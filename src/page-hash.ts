import { createHash } from "node:crypto";
import {
  type NotionPage,
  readMultiSelect,
  readNumber,
  readRichText,
  readSelect,
} from "./notion.js";
import { SCHEMA, type PropertyDef } from "./schema.js";
import type { SkillFile } from "./skill-files.js";

/**
 * Drift detection signal version. Bump when:
 *   - The set of properties contributing to the hash changes
 *   - Any reader for those properties changes shape
 *   - The hash function itself changes
 *
 * On version mismatch, the manifest entry is recomputed from current
 * page state without flagging drift (silent rebase). v2 dropped tags
 * (taxonomyOnly) and added body_hash alongside props_hash.
 */
export const HASH_V = 3;

/**
 * Hash over the page's behavior-affecting properties: anything that
 * changes how a model executes the skill. Excludes:
 *   - title         (covered by the slug, not user content drift)
 *   - metricOnly    (Installs, Published — store-managed)
 *   - taxonomyOnly  (Tags — discovery sugar, doesn't affect execution)
 *
 * Includes any non-SCHEMA Notion column the user added (surfaced as
 * `metadata.<column>` in SKILL.md frontmatter) — these ARE user
 * content, so editing them counts as drift.
 *
 * Order is fixed by SCHEMA so the hash is stable across runs.
 */
export function readBehaviorPropertyBag(
  page: NotionPage,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of SCHEMA) {
    if (prop.kind === "title") continue;
    if (prop.metricOnly) continue;
    if (prop.taxonomyOnly) continue;
    out[prop.frontmatterKey] = readPropertyValue(page, prop);
  }
  // Metadata: hash any non-SCHEMA property (excluding derived/auto
  // types) so users adding custom columns get drift detection too.
  const schemaNames = new Set(SCHEMA.map((p) => p.notionName));
  const metadata: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(page.properties)) {
    if (schemaNames.has(name)) continue;
    if (NON_USER_PROPERTY_TYPES.has(prop.type)) continue;
    metadata[name] = readGenericValue(prop);
  }
  if (Object.keys(metadata).length > 0) {
    // Stable order by sorted keys for determinism.
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(metadata).sort()) sorted[key] = metadata[key];
    out["metadata"] = sorted;
  }
  return out;
}

/** Property types that are derived/auto-managed and excluded from
 * user-content drift detection. */
const NON_USER_PROPERTY_TYPES = new Set([
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "formula",
  "rollup",
  "relation",
  "unique_id",
  "people",
  "files",
  "verification",
  "button",
]);

function readGenericValue(prop: { type: string; [k: string]: unknown }): unknown {
  switch (prop.type) {
    case "rich_text": {
      const rt = prop.rich_text as Array<{ plain_text?: string }> | undefined;
      return (rt ?? []).map((r) => r.plain_text ?? "").join("");
    }
    case "select": {
      const sel = prop.select as { name?: string } | null | undefined;
      return sel?.name ?? null;
    }
    case "multi_select": {
      const items = prop.multi_select as Array<{ name?: string }> | undefined;
      return (items ?? [])
        .map((opt) => opt.name)
        .filter((s): s is string => !!s)
        .sort();
    }
    case "number":
      return typeof prop.number === "number" ? prop.number : null;
    case "checkbox":
      return prop.checkbox === true;
    case "url":
    case "email":
    case "phone_number":
      return (prop[prop.type] as string | null | undefined) ?? null;
    case "date": {
      const d = prop.date as { start?: string; end?: string } | null | undefined;
      if (!d?.start) return null;
      return d.end ? `${d.start}/${d.end}` : d.start;
    }
    default:
      return null;
  }
}

function readPropertyValue(page: NotionPage, prop: PropertyDef): unknown {
  switch (prop.kind) {
    case "rich_text":
    case "list_text":
      return readRichText(page.properties, prop.notionName);
    case "select":
      return readSelect(page.properties, prop.notionName);
    case "multi_select":
      return readMultiSelect(page.properties, prop.notionName).slice().sort();
    case "number":
      return readNumber(page.properties, prop.notionName);
    case "checkbox":
    case "title":
      return undefined;
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function hashBehaviorProperties(page: NotionPage): string {
  return hash(JSON.stringify(readBehaviorPropertyBag(page)));
}

export function hashBody(body: string): string {
  return hash(body);
}

/**
 * Drift signal for the WHOLE skill — parent body plus every sibling
 * file's content. Backward-compatible: with `files=[]`, the result
 * equals `hashBody(body)`, so single-file skills keep their existing
 * hash and don't trigger spurious drift on upgrade.
 *
 * Files are sorted by path so the hash is order-independent. Each
 * file is delimited by a sentinel line including its path so that
 * renaming a file (different path, same content) yields a different
 * hash.
 */
export function hashSkillContent(
  body: string,
  files: SkillFile[],
): string {
  if (files.length === 0) return hash(body);
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const parts: string[] = [body];
  for (const f of sorted) {
    parts.push(`\n---FILE:${f.path}---\n`);
    parts.push(f.content);
  }
  return hash(parts.join(""));
}

export interface ContentHashes {
  hash_v: number;
  props_hash: string;
  body_hash: string;
}

/**
 * Snapshot a page's content fingerprint. Both halves are stored on the
 * manifest entry and compared against the live page on every drift check.
 */
export function computeContentHashes(
  page: NotionPage,
  body: string,
): ContentHashes {
  return {
    hash_v: HASH_V,
    props_hash: hashBehaviorProperties(page),
    body_hash: hashBody(body),
  };
}
