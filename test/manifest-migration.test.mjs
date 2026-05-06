import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateV1ToV2, emptyManifest } from "../dist/manifest.js";

test("emptyManifest: v2 shape, hash_v=3, no top-level db fields", () => {
  const m = emptyManifest();
  assert.equal(m.version, 2);
  assert.equal(m.hash_v, 3);
  assert.deepEqual(m.skills, {});
  assert.equal("database_id" in m, false);
  assert.equal("data_source_id" in m, false);
});

test("migrateV1ToV2: attaches every entry to the default source key", () => {
  const v1 = {
    version: 1,
    database_id: "db-uuid",
    data_source_id: "ds-uuid",
    last_synced_at: "2026-01-01T00:00:00Z",
    hash_v: 2,
    skills: {
      deploy: {
        page_id: "page-1",
        last_edited_time: "2026-01-02T00:00:00Z",
        props_hash: "abc",
        body_hash: "def",
        local_hash: "ghi",
        files: ["scripts/x.ts"],
      },
      lint: {
        page_id: "page-2",
        last_edited_time: "2026-01-03T00:00:00Z",
        props_hash: "xyz",
      },
    },
  };
  const v2 = migrateV1ToV2(v1, "team");
  assert.equal(v2.version, 2);
  assert.equal(v2.skills.deploy.source_key, "team");
  assert.equal(v2.skills.deploy.source_slug, "deploy");
  assert.equal(v2.skills.deploy.page_id, "page-1");
  assert.deepEqual(v2.skills.deploy.files, ["scripts/x.ts"]);
  assert.equal(v2.skills.lint.source_key, "team");
  assert.equal(v2.skills.lint.source_slug, "lint");
  assert.equal(v2.skills.lint.body_hash, undefined);
});

test("migrateV1ToV2: preserves last_synced_at + hash_v", () => {
  const v2 = migrateV1ToV2(
    {
      version: 1,
      database_id: "db",
      data_source_id: "ds",
      last_synced_at: "2026-01-01T00:00:00Z",
      hash_v: 2,
      skills: {},
    },
    "default",
  );
  assert.equal(v2.last_synced_at, "2026-01-01T00:00:00Z");
  assert.equal(v2.hash_v, 2);
});

test("migrateV1ToV2: tolerates missing hash_v / last_synced_at", () => {
  const v2 = migrateV1ToV2(
    {
      database_id: "db",
      data_source_id: "ds",
      skills: { foo: { page_id: "p", last_edited_time: "t", props_hash: "h" } },
    },
    "default",
  );
  assert.equal(v2.hash_v, 2);
  assert.equal(typeof v2.last_synced_at, "string");
  assert.equal(v2.skills.foo.source_key, "default");
});

test("migrateV1ToV2: empty skills works", () => {
  const v2 = migrateV1ToV2({ database_id: "db", data_source_id: "ds", skills: {} }, "x");
  assert.deepEqual(v2.skills, {});
});
