import { test } from "node:test";
import assert from "node:assert/strict";
import { diffManifest, emptyManifest, hashContent } from "../dist/manifest.js";

const FOO_HASH = "props-hash-foo";
const BAR_HASH = "props-hash-bar";

const SOURCE_KEYS = new Set(["team"]);

const baseManifest = () => ({
  ...emptyManifest(),
  skills: {
    foo: {
      source_key: "team",
      source_slug: "foo",
      page_id: "p-foo",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      props_hash: FOO_HASH,
    },
    bar: {
      source_key: "team",
      source_slug: "bar",
      page_id: "p-bar",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      props_hash: BAR_HASH,
    },
  },
});

const summary = (overrides = {}) => ({
  name: "foo",
  source_key: "team",
  pageId: "p-foo",
  lastEditedTime: "2026-01-01T00:00:00.000Z",
  propsHash: FOO_HASH,
  ...overrides,
});

test("diff: unchanged when everything matches", () => {
  const r = diffManifest(baseManifest(), [summary()], SOURCE_KEYS);
  assert.deepEqual(r.toFetch, []);
  // unchanged returns local_slugs (same as source_slug here).
  assert.deepEqual(r.unchanged, ["foo"]);
});

test("diff: re-fetch when last_edited_time changes", () => {
  const r = diffManifest(
    baseManifest(),
    [summary({ lastEditedTime: "2026-02-01T00:00:00.000Z" })],
    SOURCE_KEYS,
  );
  assert.deepEqual(r.toFetch, ["p-foo"]);
});

test("diff: re-fetch when properties hash changes", () => {
  const r = diffManifest(
    baseManifest(),
    [summary({ propsHash: "new-hash" })],
    SOURCE_KEYS,
  );
  assert.deepEqual(r.toFetch, ["p-foo"]);
});

test("diff: new skill goes to toFetch", () => {
  const m = baseManifest();
  delete m.skills.foo;
  // A "new" skill (no manifest entry) is silently skipped — sync is
  // install-narrowed. The diff returns nothing for it.
  const r = diffManifest(m, [summary()], SOURCE_KEYS);
  // No tracked entry for foo → not in toFetch (sync is install-narrowed).
  // bar is tracked but not in current → goes to toRemove.
  assert.deepEqual(r.toFetch, []);
  assert.deepEqual(r.toRemove, ["bar"]);
});

test("diff: missing skill goes to toRemove", () => {
  const r = diffManifest(baseManifest(), [summary()], SOURCE_KEYS);
  assert.deepEqual(r.toRemove, ["bar"]);
});

test("diff: page_id change forces re-fetch (page recreated under same name)", () => {
  const r = diffManifest(
    baseManifest(),
    [summary({ pageId: "p-foo-v2" })],
    SOURCE_KEYS,
  );
  assert.deepEqual(r.toFetch, ["p-foo-v2"]);
});

test("diff: missing props_hash on old entry triggers refetch (legacy manifest)", () => {
  const m = baseManifest();
  delete m.skills.foo.props_hash;
  const r = diffManifest(m, [summary()], SOURCE_KEYS);
  assert.deepEqual(r.toFetch, ["p-foo"]);
});

test("diff: entries from out-of-scope sources are ignored", () => {
  // Other sources' entries are left alone — sync iterates each source
  // independently; one source's diff doesn't affect another's.
  const m = baseManifest();
  m.skills.personal_x = {
    source_key: "personal",
    source_slug: "x",
    page_id: "p-x",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    props_hash: "h",
  };
  const r = diffManifest(m, [summary()], SOURCE_KEYS);
  // personal_x not in toRemove because its source isn't in scope.
  assert.equal(r.toRemove.includes("personal_x"), false);
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
