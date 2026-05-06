import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSkillMarkdown } from "../dist/convert.js";
import { buildPagePropertiesPayload } from "../dist/notion.js";
import {
  hashBehaviorProperties,
  readBehaviorPropertyBag,
} from "../dist/page-hash.js";

// buildSkillMarkdown ──────────────────────────────────────────────────

test("metadata appears in frontmatter when set", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      metadata: { author: "alice", version: "1.0" },
    },
    body: "body",
  });
  assert.match(md, /metadata:/);
  assert.match(md, /author: alice/);
  assert.match(md, /version: '1\.0'|version: "1\.0"/);
});

test("metadata is omitted when empty", () => {
  const md = buildSkillMarkdown({
    properties: { name: "x", description: "ok", metadata: {} },
    body: "body",
  });
  assert.doesNotMatch(md, /metadata:/);
});

test("metadata is omitted when undefined", () => {
  const md = buildSkillMarkdown({
    properties: { name: "x", description: "ok" },
    body: "body",
  });
  assert.doesNotMatch(md, /metadata:/);
});

// buildPagePropertiesPayload ─────────────────────────────────────────

test("metadata key matches existing column → written to payload", () => {
  const payload = buildPagePropertiesPayload(
    {
      name: "x",
      description: "ok",
      metadata: { Author: "Brian Lovin" },
    },
    new Set(["Name", "Description", "Author"]),
  );
  assert.ok(payload.Author, "Author should be in payload");
  assert.deepEqual(payload.Author, {
    rich_text: [{ type: "text", text: { content: "Brian Lovin" } }],
  });
});

test("metadata key without matching column → silently skipped", () => {
  const payload = buildPagePropertiesPayload(
    {
      name: "x",
      description: "ok",
      metadata: { Mystery: "value" },
    },
    new Set(["Name", "Description"]),
  );
  assert.equal(payload.Mystery, undefined);
});

test("metadata: numbers, booleans, arrays coerce to natural Notion types", () => {
  const payload = buildPagePropertiesPayload(
    {
      name: "x",
      description: "ok",
      metadata: {
        Year: 2026,
        Active: true,
        Topics: ["one", "two"],
      },
    },
    new Set(["Name", "Description", "Year", "Active", "Topics"]),
  );
  assert.deepEqual(payload.Year, { number: 2026 });
  assert.deepEqual(payload.Active, { checkbox: true });
  assert.deepEqual(payload.Topics, {
    multi_select: [{ name: "one" }, { name: "two" }],
  });
});

test("when existingColumns is omitted, all metadata keys are written", () => {
  // This is the create-time path; caller has just made the DB or
  // doesn't have a schema snapshot. Metadata flows through.
  const payload = buildPagePropertiesPayload({
    name: "x",
    description: "ok",
    metadata: { CustomField: "hi" },
  });
  assert.ok(payload.CustomField);
});

// readBehaviorPropertyBag — drift detection includes metadata ────────

function pageWith(props = {}) {
  return {
    object: "page",
    id: "p",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    archived: false,
    in_trash: false,
    properties: {
      Name: {
        type: "title",
        title: [{ type: "text", plain_text: "test" }],
      },
      Description: {
        type: "rich_text",
        rich_text: [{ type: "text", plain_text: "desc" }],
      },
      ...props,
    },
  };
}

test("non-SCHEMA Notion column shows up under 'metadata' in the behavior bag", () => {
  const page = pageWith({
    Author: {
      type: "rich_text",
      rich_text: [{ type: "text", plain_text: "Alice" }],
    },
  });
  const bag = readBehaviorPropertyBag(page);
  assert.ok(bag.metadata);
  assert.equal(bag.metadata.Author, "Alice");
});

test("derived auto-properties (Created by, etc.) are NOT in metadata", () => {
  const page = pageWith({
    "Created by": { type: "created_by", created_by: { id: "u" } },
    "Created time": {
      type: "created_time",
      created_time: "2026-01-01T00:00:00Z",
    },
  });
  const bag = readBehaviorPropertyBag(page);
  // The bag may or may not have metadata depending on filtering. We
  // assert the derived keys aren't surfaced.
  if (bag.metadata) {
    assert.equal(bag.metadata["Created by"], undefined);
    assert.equal(bag.metadata["Created time"], undefined);
  }
});

test("editing a metadata value bumps the props_hash (drift detection)", () => {
  const before = hashBehaviorProperties(
    pageWith({
      Author: {
        type: "rich_text",
        rich_text: [{ type: "text", plain_text: "Alice" }],
      },
    }),
  );
  const after = hashBehaviorProperties(
    pageWith({
      Author: {
        type: "rich_text",
        rich_text: [{ type: "text", plain_text: "Bob" }],
      },
    }),
  );
  assert.notEqual(before, after);
});

test("metadata bag is sorted by key for stable hashing", () => {
  const a = hashBehaviorProperties(
    pageWith({
      Foo: { type: "rich_text", rich_text: [{ type: "text", plain_text: "1" }] },
      Bar: { type: "rich_text", rich_text: [{ type: "text", plain_text: "2" }] },
    }),
  );
  const b = hashBehaviorProperties(
    pageWith({
      Bar: { type: "rich_text", rich_text: [{ type: "text", plain_text: "2" }] },
      Foo: { type: "rich_text", rich_text: [{ type: "text", plain_text: "1" }] },
    }),
  );
  assert.equal(a, b);
});
