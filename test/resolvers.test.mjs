import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInstalledRef, chooseLocalSlug } from "../dist/resolvers.js";

const sources = () => [
  { key: "team", name: "Team", database_id: "db1", data_source_id: "ds1", default: true, added_at: "t" },
  { key: "personal", name: "Me", database_id: "db2", data_source_id: "ds2", added_at: "t" },
];

const manifest = (skills) => ({ version: 2, last_synced_at: "t", hash_v: 3, skills });

const entry = (source_key, source_slug, page_id = "p") => ({
  source_key,
  source_slug,
  page_id,
  last_edited_time: "t",
  props_hash: "h",
});

// ---------- resolveInstalledRef ----------

test("resolveInstalledRef: qualified ref hit", () => {
  const m = manifest({ deploy: entry("team", "deploy") });
  const r = resolveInstalledRef("team/deploy", sources(), m);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.localSlug, "deploy");
  assert.equal(r.ok && r.source.key, "team");
});

test("resolveInstalledRef: qualified ref miss in known source", () => {
  const m = manifest({ deploy: entry("team", "deploy") });
  const r = resolveInstalledRef("team/missing", sources(), m);
  assert.deepEqual(r, { ok: false, reason: "not_found" });
});

test("resolveInstalledRef: qualified ref unknown source key", () => {
  const m = manifest({ deploy: entry("team", "deploy") });
  const r = resolveInstalledRef("nope/deploy", sources(), m);
  assert.deepEqual(r, { ok: false, reason: "unknown_source", key: "nope" });
});

test("resolveInstalledRef: bare ref hits local_slug exactly", () => {
  // When the local_slug differs from source_slug (auto-namespace), bare
  // input matching the local_slug wins.
  const m = manifest({ "personal-deploy": entry("personal", "deploy") });
  const r = resolveInstalledRef("personal-deploy", sources(), m);
  assert.equal(r.ok && r.localSlug, "personal-deploy");
  assert.equal(r.ok && r.source.key, "personal");
});

test("resolveInstalledRef: bare ref matches single source_slug", () => {
  const m = manifest({ "personal-deploy": entry("personal", "deploy") });
  const r = resolveInstalledRef("deploy", sources(), m);
  assert.equal(r.ok && r.localSlug, "personal-deploy");
});

test("resolveInstalledRef: bare ref ambiguous across sources", () => {
  const m = manifest({
    deploy: entry("team", "deploy", "p1"),
    "personal-deploy": entry("personal", "deploy", "p2"),
  });
  // local_slug "deploy" hits → not ambiguous (local_slug-first wins).
  const r1 = resolveInstalledRef("deploy", sources(), m);
  assert.equal(r1.ok && r1.source.key, "team");

  // For a pure source_slug-only collision case (no local_slug match),
  // construct a manifest where neither local_slug equals the input.
  const m2 = manifest({
    "team-foo": entry("team", "foo", "p1"),
    "personal-foo": entry("personal", "foo", "p2"),
  });
  const r2 = resolveInstalledRef("foo", sources(), m2);
  assert.equal(r2.ok, false);
  assert.equal(r2.ok === false && r2.reason, "ambiguous");
  assert.deepEqual(
    r2.ok === false && r2.reason === "ambiguous" && r2.matches.sort(),
    ["personal/foo", "team/foo"],
  );
});

test("resolveInstalledRef: bare ref no match", () => {
  const m = manifest({ deploy: entry("team", "deploy") });
  const r = resolveInstalledRef("missing", sources(), m);
  assert.deepEqual(r, { ok: false, reason: "not_found" });
});

// ---------- chooseLocalSlug ----------

test("chooseLocalSlug: free slug → use it as-is", () => {
  const m = manifest({});
  const r = chooseLocalSlug("team", "deploy", m);
  assert.deepEqual(r, { slug: "deploy", autoNamespaced: false });
});

test("chooseLocalSlug: collision → namespaced", () => {
  const m = manifest({ deploy: entry("team", "deploy") });
  const r = chooseLocalSlug("personal", "deploy", m);
  assert.deepEqual(r, { slug: "personal-deploy", autoNamespaced: true });
});

test("chooseLocalSlug: collision + namespaced collision → numeric suffix", () => {
  const m = manifest({
    deploy: entry("team", "deploy"),
    "personal-deploy": entry("personal", "old"),
  });
  const r = chooseLocalSlug("personal", "deploy", m);
  assert.deepEqual(r, { slug: "personal-deploy-2", autoNamespaced: true });
});

test("chooseLocalSlug: --as override applied verbatim", () => {
  const m = manifest({ deploy: entry("team", "deploy") });
  const r = chooseLocalSlug("personal", "deploy", m, "my-deploy");
  assert.deepEqual(r, { slug: "my-deploy", autoNamespaced: false });
});

test("chooseLocalSlug: --as override that collides falls through to numeric", () => {
  const m = manifest({
    deploy: entry("team", "deploy"),
    "my-deploy": entry("other", "x"),
  });
  const r = chooseLocalSlug("personal", "deploy", m, "my-deploy");
  assert.deepEqual(r, { slug: "my-deploy-2", autoNamespaced: false });
});
