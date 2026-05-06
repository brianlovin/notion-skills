import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateKey,
  findByKey,
  findByDatabaseId,
  defaultSource,
  deriveKey,
  parseSkillRef,
  formatRef,
  resolveTargetSource,
  sanitiseSources,
} from "../dist/sources.js";

// ---------- validateKey ----------

test("validateKey: rejects empty", () => {
  assert.match(validateKey(""), /empty/);
});

test("validateKey: rejects too long", () => {
  assert.match(validateKey("a".repeat(33)), /32 characters/);
});

test("validateKey: rejects uppercase", () => {
  assert.match(validateKey("Team"), /lowercase/);
});

test("validateKey: rejects underscores", () => {
  assert.match(validateKey("my_team"), /lowercase/);
});

test("validateKey: rejects leading hyphen", () => {
  assert.match(validateKey("-team"), /lowercase/);
});

test("validateKey: accepts plain word", () => {
  assert.equal(validateKey("team"), null);
});

test("validateKey: accepts hyphens + digits", () => {
  assert.equal(validateKey("team-1-engineering"), null);
});

test("validateKey: accepts single character", () => {
  assert.equal(validateKey("t"), null);
});

// ---------- deriveKey ----------

test("deriveKey: basic title → slug", () => {
  assert.equal(deriveKey("Engineering Skills", new Set()), "engineering-skills");
});

test("deriveKey: strips punctuation + collapses runs", () => {
  assert.equal(deriveKey("Team's @ Skills!", new Set()), "team-s-skills");
});

test("deriveKey: empty title → 'source'", () => {
  assert.equal(deriveKey("", new Set()), "source");
});

test("deriveKey: numeric suffix on collision", () => {
  const existing = new Set(["team", "team-2"]);
  assert.equal(deriveKey("team", existing), "team-3");
});

test("deriveKey: long title truncates to 32", () => {
  const out = deriveKey("a".repeat(50), new Set());
  assert.equal(out.length, 32);
});

// ---------- findByKey / findByDatabaseId / defaultSource ----------

const fixtures = () => [
  { key: "team", name: "Team", database_id: "db-team", data_source_id: "ds-team", default: true, added_at: "t1" },
  { key: "personal", name: "Me", database_id: "db-me", data_source_id: "ds-me", added_at: "t2" },
];

test("findByKey: hit", () => {
  assert.equal(findByKey(fixtures(), "team")?.name, "Team");
});

test("findByKey: miss", () => {
  assert.equal(findByKey(fixtures(), "nope"), undefined);
});

test("findByDatabaseId: hit", () => {
  assert.equal(findByDatabaseId(fixtures(), "db-me")?.key, "personal");
});

test("defaultSource: returns the default", () => {
  assert.equal(defaultSource(fixtures())?.key, "team");
});

test("defaultSource: undefined when none flagged", () => {
  const without = fixtures().map((s) => ({ ...s, default: false }));
  assert.equal(defaultSource(without), undefined);
});

// ---------- parseSkillRef / formatRef ----------

test("parseSkillRef: bare slug", () => {
  assert.deepEqual(parseSkillRef("deploy"), { slug: "deploy" });
});

test("parseSkillRef: qualified", () => {
  assert.deepEqual(parseSkillRef("team/deploy"), { sourceKey: "team", slug: "deploy" });
});

test("parseSkillRef: handles slug with extra slashes (only first counts)", () => {
  assert.deepEqual(parseSkillRef("team/sub/path"), { sourceKey: "team", slug: "sub/path" });
});

test("formatRef: joins with slash", () => {
  assert.equal(formatRef("team", "deploy"), "team/deploy");
});

// ---------- resolveTargetSource ----------

test("resolveTargetSource: no sources", () => {
  const r = resolveTargetSource(undefined, []);
  assert.deepEqual(r, { ok: false, reason: "no_sources" });
});

test("resolveTargetSource: explicit flag → that source", () => {
  const r = resolveTargetSource("personal", fixtures());
  assert.equal(r.ok && r.source.key, "personal");
});

test("resolveTargetSource: explicit unknown key", () => {
  const r = resolveTargetSource("nope", fixtures());
  assert.deepEqual(r, { ok: false, reason: "unknown_key", key: "nope" });
});

test("resolveTargetSource: one source, no flag → that source", () => {
  const r = resolveTargetSource(undefined, [fixtures()[0]]);
  assert.equal(r.ok && r.source.key, "team");
});

test("resolveTargetSource: many sources, default set → default", () => {
  const r = resolveTargetSource(undefined, fixtures());
  assert.equal(r.ok && r.source.key, "team");
});

test("resolveTargetSource: many sources, no default → ambiguous", () => {
  const without = fixtures().map((s) => ({ ...s, default: false }));
  const r = resolveTargetSource(undefined, without);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "ambiguous");
  assert.equal(r.ok === false && r.reason === "ambiguous" && r.sources.length, 2);
});

// ---------- sanitiseSources ----------

test("sanitiseSources: dedupes by database_id (first wins)", () => {
  const dupes = [
    { key: "a", name: "A", database_id: "shared", data_source_id: "ds", added_at: "t1" },
    { key: "b", name: "B", database_id: "shared", data_source_id: "ds", added_at: "t2" },
  ];
  const out = sanitiseSources(dupes);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "a");
});

test("sanitiseSources: collapses multiple defaults to first", () => {
  const corrupt = [
    { key: "a", name: "A", database_id: "db-a", data_source_id: "ds", default: true, added_at: "t" },
    { key: "b", name: "B", database_id: "db-b", data_source_id: "ds", default: true, added_at: "t" },
  ];
  const out = sanitiseSources(corrupt);
  assert.equal(out[0].default, true);
  assert.equal(out[1].default, false);
});

test("sanitiseSources: empty in → empty out", () => {
  assert.deepEqual(sanitiseSources([]), []);
});
