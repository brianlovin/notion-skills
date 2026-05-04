import { stringify as yamlStringify } from "yaml";
import type { NotionBlock, NotionPage, NotionRichText } from "./notion.js";
import {
  NotionClient,
  readMultiSelect,
  readRichText,
  readTitle,
} from "./notion.js";

export interface SkillFile {
  name: string;
  description: string;
  body: string;
  pageId: string;
  lastEditedTime: string;
  tags: string[];
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

export function buildSkillMarkdown(opts: {
  name: string;
  description: string;
  body: string;
}): string {
  const fm = yamlStringify({
    name: opts.name,
    description: opts.description,
  }).trimEnd();
  const body = opts.body.trim();
  return `---\n${fm}\n---\n\n${body}\n`;
}

// ---------- page → skill ----------

export type ConvertedPage =
  | { ok: true; skill: SkillFile }
  | { ok: false; reason: string };

export async function convertPageToSkill(
  client: NotionClient,
  page: NotionPage,
  options: { tagsProperty?: string } = {},
): Promise<ConvertedPage> {
  if (page.archived || page.in_trash) return { ok: false, reason: "archived" };

  const title = readTitle(page.properties);
  if (!title) return { ok: false, reason: "missing title" };

  const description = readRichText(page.properties, "Description");
  if (!description) return { ok: false, reason: `missing "Description" property` };

  const blocks = await fetchBlockTree(client, page.id);
  const body = renderBlocks(blocks, 0);

  const tags = options.tagsProperty
    ? readMultiSelect(page.properties, options.tagsProperty)
    : [];

  const slug = slugify(title);
  return {
    ok: true,
    skill: {
      name: slug,
      description,
      body,
      pageId: page.id,
      lastEditedTime: page.last_edited_time,
      tags,
    },
  };
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
