import { test } from "node:test";
import assert from "node:assert/strict";
import { diffManifest, emptyManifest, hashContent } from "../dist/manifest.js";

const FOO_HASH = "props-hash-foo";
const BAR_HASH = "props-hash-bar";

const baseManifest = () => ({
  ...emptyManifest("db", "ds"),
  skills: {
    foo: {
      page_id: "p-foo",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      props_hash: FOO_HASH,
    },
    bar: {
      page_id: "p-bar",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      props_hash: BAR_HASH,
    },
  },
});

const summary = (overrides = {}) => ({
  name: "foo",
  pageId: "p-foo",
  lastEditedTime: "2026-01-01T00:00:00.000Z",
  propsHash: FOO_HASH,
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

test("diff: re-fetch when properties hash changes", () => {
  // A property-only edit in Notion (e.g. tag added, model changed) does
  // NOT bump last_edited_time, so the props_hash diff is what catches it.
  const r = diffManifest(baseManifest(), [summary({ propsHash: "new-hash" })]);
  assert.deepEqual(r.toFetch, ["p-foo"]);
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

test("diff: missing props_hash on old entry triggers refetch (legacy manifest)", () => {
  const m = baseManifest();
  delete m.skills.foo.props_hash;
  const r = diffManifest(m, [summary()]);
  // old.props_hash is undefined; current is FOO_HASH → mismatch → refetch.
  assert.deepEqual(r.toFetch, ["p-foo"]);
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
