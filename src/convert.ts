import { stringify as yamlStringify } from "yaml";
import type { NotionBlock, NotionPage, NotionRichText } from "./notion.js";
import {
  NotionClient,
  readRichText,
  readSelect,
  readTitle,
} from "./notion.js";

export interface SkillFile {
  /** Full set of frontmatter fields from the Notion page. */
  properties: SkillProperties;
  body: string;
  pageId: string;
  lastEditedTime: string;
}

// ---------- slugify ----------

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-_ ]+/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
    || "untitled";
}

// ---------- frontmatter ----------

import type { SkillProperties } from "./notion.js";
import { SCHEMA, SELECT_DEFAULT, SPEC_DEFAULTS } from "./schema.js";

/**
 * Build a SKILL.md document from a SkillProperties value plus body.
 * Emits frontmatter keys in SCHEMA order (stable for round-trips).
 * Skips keys that are unset or match the spec default.
 */
export function buildSkillMarkdown(opts: {
  properties: SkillProperties;
  body: string;
}): string {
  const fm: Record<string, unknown> = {};
  for (const prop of SCHEMA) {
    const key = prop.frontmatterKey;
    const value = (opts.properties as unknown as Record<string, unknown>)[key];

    if (value === undefined) continue;

    // Skip select values that mean "use spec default"
    if (prop.kind === "select") {
      if (value === "" || value === SELECT_DEFAULT) continue;
      // For booleans (disable-model-invocation, user-invocable), also skip
      // when the selected value matches the spec default — keeps SKILL.md
      // tidy by only emitting non-default state.
      const specDefault = SPEC_DEFAULTS[key];
      if (specDefault !== undefined && value === specDefault) continue;
    }

    if (prop.kind === "rich_text" || prop.kind === "list_text") {
      if (value === "" || (Array.isArray(value) && value.length === 0)) continue;
    }

    fm[key] = value;
  }

  const fmText = yamlStringify(fm).trimEnd();
  const body = opts.body.trim();
  return `---\n${fmText}\n---\n\n${body}\n`;
}

// ---------- page → skill ----------

export type ConvertedPage =
  | { ok: true; skill: SkillFile }
  | { ok: false; reason: string };

export async function convertPageToSkill(
  client: NotionClient,
  page: NotionPage,
): Promise<ConvertedPage> {
  if (page.archived || page.in_trash) return { ok: false, reason: "archived" };

  const title = readTitle(page.properties);
  if (!title) return { ok: false, reason: "missing title" };

  const description = readRichText(page.properties, "Description");
  if (!description) return { ok: false, reason: `missing "Description" property` };

  const blocks = await fetchBlockTree(client, page.id);
  const body = renderBlocks(blocks, 0);

  const properties = readSkillPropertiesFromPage(page, slugify(title), description);
  return {
    ok: true,
    skill: {
      properties,
      body,
      pageId: page.id,
      lastEditedTime: page.last_edited_time,
    },
  };
}

/**
 * Read every spec-mapped property off a Notion page into a SkillProperties.
 *
 * Defaults:
 *   - Empty rich_text / list_text → undefined
 *   - Select == "default" or unset → undefined
 *   - Otherwise the cell's value passes through
 *
 * The slug + description are passed in from the caller so we don't reread
 * them; everything else is read fresh.
 */
function readSkillPropertiesFromPage(
  page: NotionPage,
  name: string,
  description: string,
): SkillProperties {
  const props: SkillProperties = { name, description };

  const richText = (notionName: string): string | undefined => {
    const v = readRichText(page.properties, notionName);
    return v ? v : undefined;
  };
  const listFromText = (
    notionName: string,
    splitOn: RegExp,
  ): string[] | undefined => {
    const v = readRichText(page.properties, notionName);
    if (!v) return undefined;
    const items = v.split(splitOn).map((s) => s.trim()).filter(Boolean);
    return items.length ? items : undefined;
  };
  /**
   * Tool patterns like `Bash(git *)` contain whitespace inside parentheses,
   * so naive whitespace splitting wrecks them. Parse with paren-depth
   * awareness instead — splits only on whitespace at depth 0.
   */
  const toolsList = (notionName: string): string[] | undefined => {
    const v = readRichText(page.properties, notionName);
    if (!v) return undefined;
    return splitToolsRespectingParens(v);
  };
  const select = (notionName: string): string | undefined => {
    const v = readSelect(page.properties, notionName);
    if (!v || v === "default") return undefined;
    return v;
  };

  props.when_to_use = richText("When To Use");
  props["argument-hint"] = richText("Argument Hint");
  props.arguments = listFromText("Arguments", /\s+/);
  props["allowed-tools"] = toolsList("Allowed Tools");
  props.paths = listFromText("Paths", /\s*,\s*/);
  props["disable-model-invocation"] = select("Disable Model Invocation");
  props["user-invocable"] = select("User Invocable");
  props.model = select("Model");
  props.effort = select("Effort");
  props.context = select("Context");
  props.agent = select("Agent");
  props.shell = select("Shell");

  return props;
}

/**
 * Split a string on whitespace, ignoring whitespace inside parens.
 * `Read Edit Bash(git *)` → `["Read", "Edit", "Bash(git *)"]`.
 * Used for the `allowed-tools` frontmatter field, where tool patterns
 * may contain spaces inside parenthesised argument matchers.
 */
export function splitToolsRespectingParens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const start = i;
    let depth = 0;
    while (i < s.length && (depth > 0 || !/\s/.test(s[i]!))) {
      const ch = s[i]!;
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      i++;
    }
    out.push(s.slice(start, i));
  }
  return out;
}

// ---------- block tree fetch ----------

interface NodeWithChildren extends NotionBlock {
  children?: NodeWithChildren[];
}

async function fetchBlockTree(
  client: NotionClient,
  blockId: string,
  depth = 0,
  visited: Set<string> = new Set(),
): Promise<NodeWithChildren[]> {
  if (visited.has(blockId)) return [];
  visited.add(blockId);

  const verbose = process.env.NOTION_SKILLS_DEBUG === "1";
  if (verbose) {
    console.error(`${"  ".repeat(depth)}↳ fetching children of ${blockId}`);
  }

  const blocks = await client.getBlockChildren(blockId);
  const result: NodeWithChildren[] = [];
  for (const block of blocks) {
    const node: NodeWithChildren = block;
    if (block.has_children && shouldRecurseInto(block.type) && depth < 10) {
      node.children = await fetchBlockTree(client, block.id, depth + 1, visited);
    }
    result.push(node);
  }
  return result;
}

function shouldRecurseInto(type: string): boolean {
  // Skip child_page / child_database — they reference distinct content,
  // not nested blocks of the current page.
  if (type === "child_page" || type === "child_database") return false;
  return true;
}

// ---------- block rendering ----------

/**
 * Render a tree of Notion blocks (with attached children) to markdown.
 * Exposed for tests; sync uses convertPageToSkill which calls this internally.
 */
export function blocksToMarkdown(blocks: NodeWithChildren[]): string {
  return renderBlocks(blocks, 0);
}

function renderBlocks(blocks: NodeWithChildren[], indent: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;

    // Group consecutive list items of the same type for proper numbering
    if (block.type === "numbered_list_item" || block.type === "bulleted_list_item") {
      const groupType = block.type;
      const group: NodeWithChildren[] = [];
      while (i < blocks.length && blocks[i]!.type === groupType) {
        group.push(blocks[i]!);
        i++;
      }
      out.push(renderList(group, groupType, indent));
      continue;
    }

    out.push(renderBlock(block, indent));
    i++;
  }
  return out.filter((s) => s !== "").join("\n\n");
}

function renderBlock(block: NodeWithChildren, indent: number): string {
  const pad = " ".repeat(indent);
  const t = block.type;
  const data = (block as any)[t] ?? {};

  switch (t) {
    case "paragraph":
      return pad + renderRichText(data.rich_text ?? []);
    case "heading_1":
      return pad + "# " + renderRichText(data.rich_text ?? []);
    case "heading_2":
      return pad + "## " + renderRichText(data.rich_text ?? []);
    case "heading_3":
      return pad + "### " + renderRichText(data.rich_text ?? []);
    case "quote":
      return prefixLines(renderRichText(data.rich_text ?? []), pad + "> ");
    case "callout": {
      const icon = data.icon?.emoji ? data.icon.emoji + " " : "";
      const text = renderRichText(data.rich_text ?? []);
      return prefixLines(icon + text, pad + "> ");
    }
    case "divider":
      return pad + "---";
    case "code": {
      const lang = data.language ?? "";
      const text = (data.rich_text ?? [])
        .map((r: NotionRichText) => r.plain_text)
        .join("");
      return pad + "```" + lang + "\n" + text + "\n" + pad + "```";
    }
    case "to_do": {
      const checked = data.checked ? "x" : " ";
      const inner = renderRichText(data.rich_text ?? []);
      const head = `${pad}- [${checked}] ${inner}`;
      const children = block.children?.length
        ? "\n" + renderBlocks(block.children, indent + 2)
        : "";
      return head + children;
    }
    case "toggle": {
      const summary = renderRichText(data.rich_text ?? []);
      const inner = block.children?.length
        ? renderBlocks(block.children, 0)
        : "";
      return (
        pad +
        "<details>\n" +
        pad +
        `<summary>${escapeHtml(summary)}</summary>\n\n` +
        indentText(inner, pad) +
        "\n" +
        pad +
        "</details>"
      );
    }
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = data.url ?? "";
      return pad + (url ? `[${url}](${url})` : "");
    }
    case "image": {
      const url = (data.file?.url ?? data.external?.url ?? "") as string;
      const caption = renderRichText(data.caption ?? []) || "image";
      return pad + (url ? `![${caption}](${url})` : "");
    }
    case "video":
    case "audio":
    case "file":
    case "pdf": {
      const url = (data.file?.url ?? data.external?.url ?? "") as string;
      const caption = renderRichText(data.caption ?? []) || t;
      return pad + (url ? `[${caption}](${url})` : "");
    }
    case "table": {
      const rows = (block.children ?? []).filter((b) => b.type === "table_row");
      return renderTable(rows, indent);
    }
    case "column_list":
    case "column":
    case "synced_block":
      return block.children?.length ? renderBlocks(block.children, indent) : "";
    case "child_page":
      return pad + `*(child page: ${data.title ?? ""})*`;
    case "child_database":
      return pad + `*(child database: ${data.title ?? ""})*`;
    case "equation":
      return pad + "$$" + (data.expression ?? "") + "$$";
    case "table_of_contents":
    case "breadcrumb":
      return "";
    case "unsupported":
      return pad + "*(unsupported block)*";
    default: {
      const rich = data.rich_text;
      if (Array.isArray(rich)) return pad + renderRichText(rich);
      return "";
    }
  }
}

function renderList(
  group: NodeWithChildren[],
  type: "numbered_list_item" | "bulleted_list_item",
  indent: number,
): string {
  const pad = " ".repeat(indent);
  return group
    .map((item, idx) => {
      const data = (item as any)[type] ?? {};
      const marker = type === "numbered_list_item" ? `${idx + 1}.` : "-";
      const head = `${pad}${marker} ${renderRichText(data.rich_text ?? [])}`;
      const children = item.children?.length
        ? "\n" + renderBlocks(item.children, indent + (type === "numbered_list_item" ? 3 : 2))
        : "";
      return head + children;
    })
    .join("\n");
}

function renderTable(rows: NodeWithChildren[], indent: number): string {
  if (rows.length === 0) return "";
  const pad = " ".repeat(indent);
  const cellsFor = (row: NodeWithChildren): string[] => {
    const data = (row as any).table_row;
    const cells: NotionRichText[][] = data?.cells ?? [];
    return cells.map((c) => renderRichText(c).replace(/\|/g, "\\|"));
  };

  const lines: string[] = [];
  const header = cellsFor(rows[0]!);
  lines.push(pad + "| " + header.join(" | ") + " |");
  lines.push(pad + "| " + header.map(() => "---").join(" | ") + " |");
  for (let i = 1; i < rows.length; i++) {
    lines.push(pad + "| " + cellsFor(rows[i]!).join(" | ") + " |");
  }
  return lines.join("\n");
}

// ---------- rich text ----------

/**
 * Notion returns rich text as an array of runs, each carrying its own
 * annotations. A naive per-run render emits opening/closing markers
 * around every run, so a phrase like "**bold** **`code`** **bold**" becomes
 * "**bold ****`code`**** bold**" — four-asterisk noise. We merge spanning
 * annotations (bold, italic, strikethrough) across consecutive runs and
 * keep per-run wrappers for things that don't span (code, href).
 */
function renderRichText(rt: NotionRichText[]): string {
  if (rt.length === 0) return "";
  const out: string[] = [];
  const state = { bold: false, italic: false, strikethrough: false };

  for (const run of rt) {
    const a = (run.annotations ?? {}) as Record<string, boolean>;
    const want = {
      bold: !!a.bold,
      italic: !!a.italic,
      strikethrough: !!a.strikethrough,
    };

    if (state.strikethrough && !want.strikethrough) { out.push("~~"); state.strikethrough = false; }
    if (state.italic && !want.italic)               { out.push("*");  state.italic = false; }
    if (state.bold && !want.bold)                   { out.push("**"); state.bold = false; }

    if (!state.bold && want.bold)                   { out.push("**"); state.bold = true; }
    if (!state.italic && want.italic)               { out.push("*");  state.italic = true; }
    if (!state.strikethrough && want.strikethrough) { out.push("~~"); state.strikethrough = true; }

    let text = run.plain_text;
    if (a.code) text = "`" + text + "`";
    if (run.href) text = `[${text}](${run.href})`;
    out.push(text);
  }

  if (state.strikethrough) out.push("~~");
  if (state.italic) out.push("*");
  if (state.bold) out.push("**");

  return out.join("");
}

// ---------- helpers ----------

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function indentText(text: string, prefix: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
