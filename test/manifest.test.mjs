import { test } from "node:test";
import assert from "node:assert/strict";
import { diffManifest, emptyManifest, hashContent } from "../dist/manifest.js";

const baseManifest = () => ({
  ...emptyManifest("db", "ds"),
  skills: {
    foo: {
      page_id: "p-foo",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      hash: "abc",
      tags: ["tooling"],
      description: "Foo desc",
    },
    bar: {
      page_id: "p-bar",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      hash: "def",
      tags: [],
      description: "Bar desc",
    },
  },
});

const summary = (overrides = {}) => ({
  name: "foo",
  pageId: "p-foo",
  lastEditedTime: "2026-01-01T00:00:00.000Z",
  description: "Foo desc",
  tags: ["tooling"],
  ...overrides,
});

test("diff: unchanged when everything matches", () => {
  const r = diffManifest(baseManifest(), [summary()]);
  assert.deepEqual(r.toFetch, []);
  assert.deepEqual(r.unchanged, ["foo"]);
});

test("diff: re-fetch when last_edited_time changes", () => {
  const r = diffManifest(baseManifest(), [
    summary({ lastEditedTime: "2026-02-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(r.toFetch, ["p-foo"]);
});

test("diff: re-fetch when description changes (Notion property-only edit)", () => {
  const r = diffManifest(baseManifest(), [summary({ description: "new desc" })]);
  assert.deepEqual(r.toFetch, ["p-foo"]);
});

test("diff: re-fetch when tags change (Notion property-only edit)", () => {
  const r = diffManifest(baseManifest(), [summary({ tags: ["tooling", "review"] })]);
  assert.deepEqual(r.toFetch, ["p-foo"]);
});

test("diff: tag order does not matter", () => {
  const m = baseManifest();
  m.skills.foo.tags = ["a", "b", "c"];
  const r = diffManifest(m, [summary({ tags: ["c", "a", "b"] })]);
  assert.deepEqual(r.unchanged, ["foo"]);
});

test("diff: new skill goes to toFetch", () => {
  const m = baseManifest();
  delete m.skills.foo;
  const r = diffManifest(m, [summary()]);
  assert.deepEqual(r.toFetch, ["p-foo"]);
});

test("diff: missing skill goes to toRemove", () => {
  const r = diffManifest(baseManifest(), [summary()]);
  // bar is in old manifest but not in current
  assert.deepEqual(r.toRemove, ["bar"]);
});

test("diff: page_id change forces re-fetch (page recreated under same name)", () => {
  const r = diffManifest(baseManifest(), [summary({ pageId: "p-foo-v2" })]);
  assert.deepEqual(r.toFetch, ["p-foo-v2"]);
});

test("hashContent: stable for same input", () => {
  const a = hashContent("hello world");
  const b = hashContent("hello world");
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test("hashContent: differs for different input", () => {
  assert.notEqual(hashContent("a"), hashContent("b"));
});
