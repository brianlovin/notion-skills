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
export const HASH_V = 2;

/**
 * Hash over the page's behavior-affecting properties: anything that
 * changes how a model executes the skill. Excludes:
 *   - title         (covered by the slug, not user content drift)
 *   - metricOnly    (Installs — store-managed counter)
 *   - taxonomyOnly  (Tags — discovery sugar, doesn't affect execution)
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
  return out;
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
