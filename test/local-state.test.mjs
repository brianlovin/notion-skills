import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectLocalState } from "../dist/local-state.js";
import { hashContent } from "../dist/manifest.js";

// detectLocalState scans the central skill store and reports:
//   - drift:           SKILL.md hash differs from manifest's local_hash
//   - missingPageIds:  SKILL.md is gone (force-pull recovery path)
//
// Manifest entries with no local_hash (legacy or just-migrated) must NOT
// fire drift, since there's no baseline to compare against.

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "notion-skills-local-state-"));
}

function writeSkill(root, name, content) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
  return content;
}

function manifestEntry(pageId, content, opts = {}) {
  return {
    page_id: pageId,
    last_edited_time: opts.last_edited_time ?? "2026-05-05T00:00:00.000Z",
    props_hash: opts.props_hash ?? "props-hash",
    ...(opts.includeLocalHash !== false
      ? { local_hash: hashContent(content) }
      : {}),
  };
}

function manifestOf(skills) {
  return {
    version: 1,
    database_id: "test-db",
    data_source_id: "test-ds",
    last_synced_at: "2026-05-05T00:00:00.000Z",
    skills,
  };
}

test("detectLocalState: no drift when files match manifest hashes", async () => {
  const root = makeRoot();
  const a = writeSkill(root, "alpha", "---\nname: alpha\n---\nbody A");
  const b = writeSkill(root, "beta", "---\nname: beta\n---\nbody B");

  const manifest = manifestOf({
    alpha: manifestEntry("page-a", a),
    beta: manifestEntry("page-b", b),
  });

  const { drift, missingPageIds } = await detectLocalState(manifest, root);
  assert.equal(drift.size, 0);
  assert.equal(missingPageIds.size, 0);

  rmSync(root, { recursive: true });
});

test("detectLocalState: drift when SKILL.md is edited", async () => {
  const root = makeRoot();
  const original = "---\nname: alpha\n---\nbody before";
  writeSkill(root, "alpha", original);
  const manifest = manifestOf({
    alpha: manifestEntry("page-a", original),
  });

  // User edits the file post-sync.
  writeSkill(root, "alpha", "---\nname: alpha\n---\nbody after");

  const { drift } = await detectLocalState(manifest, root);
  assert.equal(drift.size, 1);
  const entry = drift.get("alpha");
  assert.ok(entry, "alpha should be in drift map");
  assert.equal(entry.pageId, "page-a");
  assert.match(entry.mdContent, /body after/);
  assert.ok(entry.mtime instanceof Date);

  rmSync(root, { recursive: true });
});

test("detectLocalState: missingPageIds includes pages whose SKILL.md is gone", async () => {
  // Regression: previously a deleted SKILL.md was silently ignored, leaving
  // the user with no way to recover by re-syncing. The fix is to surface
  // the page id so runSync force-pulls it from Notion.
  const root = makeRoot();
  const a = writeSkill(root, "alpha", "---\nname: alpha\n---\nbody");
  // Beta is in the manifest but its directory was deleted.
  const manifest = manifestOf({
    alpha: manifestEntry("page-a", a),
    beta: manifestEntry("page-b", "doesn't matter"),
  });

  const { drift, missingPageIds } = await detectLocalState(manifest, root);
  assert.equal(drift.size, 0);
  assert.deepEqual([...missingPageIds], ["page-b"]);

  rmSync(root, { recursive: true });
});

test("detectLocalState: legacy manifest (no local_hash) does NOT fire drift", async () => {
  // Regression guard: when the on-disk manifest predates the bidirectional
  // sync feature it has no `local_hash` field. Triggering a push would be
  // a guess against an unknown baseline. Detection must opt out until the
  // next write installs a real hash.
  const root = makeRoot();
  writeSkill(root, "alpha", "---\nname: alpha\n---\nbody");
  const manifest = manifestOf({
    alpha: manifestEntry("page-a", "ignored", { includeLocalHash: false }),
  });

  const { drift } = await detectLocalState(manifest, root);
  assert.equal(drift.size, 0);

  rmSync(root, { recursive: true });
});

test("detectLocalState: empty manifest produces no drift, no missing", async () => {
  const root = makeRoot();
  const manifest = manifestOf({});
  const { drift, missingPageIds } = await detectLocalState(manifest, root);
  assert.equal(drift.size, 0);
  assert.equal(missingPageIds.size, 0);
  rmSync(root, { recursive: true });
});

test("detectLocalState: mtime reflects the file mtime, not the manifest", async () => {
  const root = makeRoot();
  const original = "---\nname: alpha\n---\nbody";
  writeSkill(root, "alpha", original);
  const manifest = manifestOf({ alpha: manifestEntry("page-a", original) });

  // Edit + force a known mtime.
  writeSkill(root, "alpha", "---\nname: alpha\n---\nbody changed");
  const expected = new Date("2026-06-01T12:00:00Z");
  utimesSync(join(root, "alpha", "SKILL.md"), expected, expected);

  const { drift } = await detectLocalState(manifest, root);
  const entry = drift.get("alpha");
  assert.ok(entry);
  assert.equal(entry.mtime.toISOString(), expected.toISOString());

  rmSync(root, { recursive: true });
});

test("detectLocalState: drift + missing can co-exist for different skills", async () => {
  const root = makeRoot();
  const aOriginal = "---\nname: alpha\n---\nbody alpha";
  writeSkill(root, "alpha", aOriginal);
  // Beta in manifest, dir not on disk.
  const manifest = manifestOf({
    alpha: manifestEntry("page-a", aOriginal),
    beta: manifestEntry("page-b", "doesn't matter"),
  });

  // Drift alpha.
  writeSkill(root, "alpha", "---\nname: alpha\n---\nbody alpha edited");

  const { drift, missingPageIds } = await detectLocalState(manifest, root);
  assert.equal(drift.size, 1);
  assert.ok(drift.get("alpha"));
  assert.deepEqual([...missingPageIds], ["page-b"]);

  rmSync(root, { recursive: true });
});
