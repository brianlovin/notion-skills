import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateV1ToV2 } from "../dist/scope.js";

// migrateV1ToV2 is the in-memory transform applied on read. We test the
// shape contract here; on-disk round-trip is integration-tested via the
// CLI's first command after upgrade.

test("migrateV1ToV2: wraps single DB into a source array", () => {
  const v2 = migrateV1ToV2({
    database_id: "db-uuid",
    data_source_id: "ds-uuid",
    database_title: "Skills Store",
    targets: ["claude", "codex"],
    gen_agent: "claude",
  });
  assert.equal(v2.version, 2);
  assert.equal(v2.sources.length, 1);
  assert.equal(v2.sources[0].database_id, "db-uuid");
  assert.equal(v2.sources[0].data_source_id, "ds-uuid");
  assert.equal(v2.sources[0].name, "Skills Store");
  assert.equal(v2.sources[0].default, true);
  assert.equal(v2.targets.length, 2);
  assert.equal(v2.gen_agent, "claude");
});

test("migrateV1ToV2: derives a key slug from the database title", () => {
  const v2 = migrateV1ToV2({
    database_id: "db",
    data_source_id: "ds",
    database_title: "Engineering Skills",
  });
  assert.equal(v2.sources[0].key, "engineering-skills");
});

test("migrateV1ToV2: missing title falls back to a 'Skills Store' default", () => {
  const v2 = migrateV1ToV2({ database_id: "db", data_source_id: "ds" });
  // Name falls back to "Skills Store"; key is derived from it.
  assert.equal(v2.sources[0].name, "Skills Store");
  assert.equal(v2.sources[0].key, "skills-store");
});

test("migrateV1ToV2: targets default to empty array when absent", () => {
  const v2 = migrateV1ToV2({ database_id: "db", data_source_id: "ds" });
  assert.deepEqual(v2.targets, []);
});

test("migrateV1ToV2: tolerates deprecated fields without crashing", () => {
  const v2 = migrateV1ToV2({
    database_id: "db",
    data_source_id: "ds",
    database_title: "Old Setup",
    exclude_skills: ["legacy"],
    filter: { exclude_skills: ["older"] },
  });
  assert.equal(v2.sources[0].database_id, "db");
  // Migrated payload doesn't carry deprecated fields forward.
  assert.equal("exclude_skills" in v2, false);
});
