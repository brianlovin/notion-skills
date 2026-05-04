import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksToMarkdown } from "../dist/convert.js";

// ---------- helpers ----------

const para = (text, anns = {}) => ({
  type: "paragraph",
  has_children: false,
  paragraph: { rich_text: [{ plain_text: text, annotations: anns }] },
});

const heading = (level, text) => ({
  type: `heading_${level}`,
  has_children: false,
  [`heading_${level}`]: { rich_text: [{ plain_text: text }] },
});

const bulleted = (text, children) => ({
  type: "bulleted_list_item",
  has_children: !!children?.length,
  bulleted_list_item: { rich_text: [{ plain_text: text }] },
  children,
});

const numbered = (text, children) => ({
  type: "numbered_list_item",
  has_children: !!children?.length,
  numbered_list_item: { rich_text: [{ plain_text: text }] },
  children,
});

const code = (text, language) => ({
  type: "code",
  has_children: false,
  code: { rich_text: [{ plain_text: text }], language },
});

const quote = (text) => ({
  type: "quote",
  has_children: false,
  quote: { rich_text: [{ plain_text: text }] },
});

const callout = (text, emoji) => ({
  type: "callout",
  has_children: false,
  callout: {
    rich_text: [{ plain_text: text }],
    icon: emoji ? { emoji } : undefined,
  },
});

const divider = () => ({ type: "divider", has_children: false, divider: {} });

const todo = (text, checked) => ({
  type: "to_do",
  has_children: false,
  to_do: { rich_text: [{ plain_text: text }], checked },
});

const tableRow = (cells) => ({
  type: "table_row",
  has_children: false,
  table_row: { cells: cells.map((c) => [{ plain_text: c }]) },
});

const table = (rows) => ({
  type: "table",
  has_children: true,
  table: {},
  children: rows,
});

// ---------- tests ----------

test("renderBlocks: empty", () => {
  assert.equal(blocksToMarkdown([]), "");
});

test("renderBlocks: paragraph", () => {
  assert.equal(blocksToMarkdown([para("Hello world.")]), "Hello world.");
});

test("renderBlocks: headings 1-3", () => {
  const out = blocksToMarkdown([
    heading(1, "Title"),
    heading(2, "Section"),
    heading(3, "Sub"),
  ]);
  assert.equal(out, "# Title\n\n## Section\n\n### Sub");
});

test("renderBlocks: bullet list with children", () => {
  const out = blocksToMarkdown([
    bulleted("First", [bulleted("Nested-A"), bulleted("Nested-B")]),
    bulleted("Second"),
  ]);
  assert.equal(
    out,
    "- First\n  - Nested-A\n  - Nested-B\n- Second",
  );
});

test("renderBlocks: numbered list increments", () => {
  const out = blocksToMarkdown([
    numbered("First"),
    numbered("Second"),
    numbered("Third"),
  ]);
  assert.equal(out, "1. First\n2. Second\n3. Third");
});

test("renderBlocks: code block with language", () => {
  const out = blocksToMarkdown([code("const x = 1;", "typescript")]);
  assert.equal(out, "```typescript\nconst x = 1;\n```");
});

test("renderBlocks: quote", () => {
  assert.equal(blocksToMarkdown([quote("It works.")]), "> It works.");
});

test("renderBlocks: callout with emoji", () => {
  const out = blocksToMarkdown([callout("Be careful", "⚠️")]);
  assert.equal(out, "> ⚠️ Be careful");
});

test("renderBlocks: divider", () => {
  assert.equal(blocksToMarkdown([divider()]), "---");
});

test("renderBlocks: todo checked / unchecked", () => {
  const out = blocksToMarkdown([todo("done", true), todo("pending", false)]);
  // Lists aren't grouped here because they're to_do not bulleted/numbered
  assert.match(out, /^- \[x\] done/);
  assert.match(out, /- \[ \] pending/);
});

test("renderBlocks: table with header", () => {
  const out = blocksToMarkdown([
    table([
      tableRow(["A", "B"]),
      tableRow(["1", "2"]),
      tableRow(["3", "4"]),
    ]),
  ]);
  assert.equal(
    out,
    "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
  );
});

test("renderBlocks: table escapes pipe in cell", () => {
  const out = blocksToMarkdown([
    table([tableRow(["A", "B"]), tableRow(["x | y", "z"])]),
  ]);
  assert.match(out, /x \\\| y/);
});

test("renderBlocks: bold/italic span across runs (no asterisk noise)", () => {
  // This is the regression case — old converter produced
  // "**Never use ****`ignore`**** patterns**" (4-asterisk noise).
  // New converter keeps the bold span unbroken.
  const block = {
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        { plain_text: "Never use ", annotations: { bold: true } },
        { plain_text: "ignore", annotations: { bold: true, code: true } },
        { plain_text: " patterns", annotations: { bold: true } },
      ],
    },
  };
  assert.equal(blocksToMarkdown([block]), "**Never use `ignore` patterns**");
});

test("renderBlocks: italic spans runs", () => {
  const block = {
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        { plain_text: "hello ", annotations: { italic: true } },
        { plain_text: "world", annotations: { italic: true } },
      ],
    },
  };
  assert.equal(blocksToMarkdown([block]), "*hello world*");
});

test("renderBlocks: bold opens then closes when run loses annotation", () => {
  const block = {
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        { plain_text: "bold ", annotations: { bold: true } },
        { plain_text: "plain", annotations: {} },
        { plain_text: " bold", annotations: { bold: true } },
      ],
    },
  };
  assert.equal(blocksToMarkdown([block]), "**bold **plain** bold**");
});

test("renderBlocks: link via href", () => {
  const block = {
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        { plain_text: "click ", annotations: {} },
        {
          plain_text: "here",
          annotations: {},
          href: "https://example.com",
        },
      ],
    },
  };
  assert.equal(blocksToMarkdown([block]), "click [here](https://example.com)");
});

test("renderBlocks: code annotation wraps in backticks", () => {
  const block = {
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        { plain_text: "use ", annotations: {} },
        { plain_text: "npm install", annotations: { code: true } },
      ],
    },
  };
  assert.equal(blocksToMarkdown([block]), "use `npm install`");
});

test("renderBlocks: strikethrough spans runs", () => {
  const block = {
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        { plain_text: "old ", annotations: { strikethrough: true } },
        { plain_text: "stuff", annotations: { strikethrough: true } },
      ],
    },
  };
  assert.equal(blocksToMarkdown([block]), "~~old stuff~~");
});

test("renderBlocks: combined bold+italic on a single run", () => {
  const block = {
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        { plain_text: "wow", annotations: { bold: true, italic: true } },
      ],
    },
  };
  assert.equal(blocksToMarkdown([block]), "***wow***");
});

test("renderBlocks: paragraphs separated by blank line", () => {
  const out = blocksToMarkdown([para("First"), para("Second")]);
  assert.equal(out, "First\n\nSecond");
});

test("renderBlocks: divider between paragraphs", () => {
  const out = blocksToMarkdown([para("Before"), divider(), para("After")]);
  assert.equal(out, "Before\n\n---\n\nAfter");
});

test("renderBlocks: image with caption", () => {
  const block = {
    type: "image",
    has_children: false,
    image: {
      external: { url: "https://example.com/x.png" },
      caption: [{ plain_text: "Diagram" }],
    },
  };
  assert.equal(
    blocksToMarkdown([block]),
    "![Diagram](https://example.com/x.png)",
  );
});

test("renderBlocks: bookmark", () => {
  const block = {
    type: "bookmark",
    has_children: false,
    bookmark: { url: "https://example.com" },
  };
  assert.equal(
    blocksToMarkdown([block]),
    "[https://example.com](https://example.com)",
  );
});
