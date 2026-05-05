import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HASH_V,
  computeContentHashes,
  hashBehaviorProperties,
  hashBody,
  readBehaviorPropertyBag,
} from "../dist/page-hash.js";

// Build a minimal NotionPage stub. Only properties consumed by the
// hashers need to be present; everything else is irrelevant.
function pageWith(props = {}) {
  return {
    object: "page",
    id: "test-page",
    created_time: "2026-05-05T00:00:00.000Z",
    last_edited_time: "2026-05-05T00:00:00.000Z",
    archived: false,
    in_trash: false,
    properties: {
      Name: {
        type: "title",
        title: [{ type: "text", plain_text: "test" }],
      },
      Description: {
        type: "rich_text",
        rich_text: [{ type: "text", plain_text: "Default description." }],
      },
      ...props,
    },
  };
}

function richText(value) {
  return {
    type: "rich_text",
    rich_text: [{ type: "text", plain_text: value }],
  };
}

function multiSelect(values) {
  return {
    type: "multi_select",
    multi_select: values.map((v) => ({ id: v, name: v })),
  };
}

function number(n) {
  return { type: "number", number: n };
}

// --- HASH_V is the version stamp; bumps when the bag shape changes. ---

test("HASH_V is exposed and integral", () => {
  assert.equal(typeof HASH_V, "number");
  assert.ok(Number.isInteger(HASH_V));
  assert.ok(HASH_V >= 2);
});

// --- readBehaviorPropertyBag — what goes in vs what stays out. ---

test("Tags are excluded from the behavior bag (taxonomyOnly)", () => {
  const a = pageWith({ Tags: multiSelect([]) });
  const b = pageWith({ Tags: multiSelect(["productivity", "engineering"]) });
  assert.deepEqual(readBehaviorPropertyBag(a), readBehaviorPropertyBag(b));
});

test("Installs are excluded from the behavior bag (metricOnly)", () => {
  const a = pageWith({ Installs: number(0) });
  const b = pageWith({ Installs: number(999) });
  assert.deepEqual(readBehaviorPropertyBag(a), readBehaviorPropertyBag(b));
});

test("Description IS in the behavior bag", () => {
  const bag = readBehaviorPropertyBag(
    pageWith({ Description: richText("hi") }),
  );
  assert.equal(bag.description, "hi");
});

test("title is excluded from the behavior bag", () => {
  const bag = readBehaviorPropertyBag(pageWith());
  assert.ok(!("name" in bag));
});

// --- hashBehaviorProperties — behavioral signal ---

test("hashBehaviorProperties is stable for the same input", () => {
  const p = pageWith({ Description: richText("constant") });
  assert.equal(hashBehaviorProperties(p), hashBehaviorProperties(p));
});

test("hashBehaviorProperties: tag changes do NOT bump the hash", () => {
  const without = pageWith();
  const withTags = pageWith({ Tags: multiSelect(["x", "y"]) });
  assert.equal(hashBehaviorProperties(without), hashBehaviorProperties(withTags));
});

test("hashBehaviorProperties: install count changes do NOT bump the hash", () => {
  const a = pageWith({ Installs: number(1) });
  const b = pageWith({ Installs: number(42) });
  assert.equal(hashBehaviorProperties(a), hashBehaviorProperties(b));
});

test("hashBehaviorProperties: description change DOES bump the hash", () => {
  const a = pageWith({ Description: richText("a") });
  const b = pageWith({ Description: richText("b") });
  assert.notEqual(hashBehaviorProperties(a), hashBehaviorProperties(b));
});

test("hashBehaviorProperties: when_to_use change DOES bump the hash", () => {
  const a = pageWith({ "When To Use": richText("when a") });
  const b = pageWith({ "When To Use": richText("when b") });
  assert.notEqual(hashBehaviorProperties(a), hashBehaviorProperties(b));
});

// --- hashBody --------------------------------------------------------

test("hashBody produces stable, distinct hashes", () => {
  assert.equal(hashBody("Hello"), hashBody("Hello"));
  assert.notEqual(hashBody("Hello"), hashBody("Hello!"));
});

// --- computeContentHashes — bundle accessor ---

test("computeContentHashes carries the version stamp", () => {
  const result = computeContentHashes(pageWith(), "body");
  assert.equal(result.hash_v, HASH_V);
  assert.equal(typeof result.props_hash, "string");
  assert.equal(typeof result.body_hash, "string");
});
