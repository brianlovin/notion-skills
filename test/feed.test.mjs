import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionFeed, formatWindowHeader } from "../dist/commands/feed.js";
import { hashBehaviorProperties } from "../dist/page-hash.js";

const NOW = new Date("2026-05-07T12:00:00.000Z");
const SINCE = new Date(NOW.getTime() - 7 * 24 * 60 * 60_000); // 7d ago

const SOURCE = {
  key: "team",
  name: "Team Skills",
  database_id: "db1",
  data_source_id: "ds1",
  added_at: "2026-01-01T00:00:00.000Z",
};

function page(opts) {
  return {
    id: opts.id,
    created_time: opts.created_time,
    last_edited_time: opts.last_edited_time ?? opts.created_time,
    archived: opts.archived ?? false,
    in_trash: opts.in_trash ?? false,
    url: `https://notion.so/${opts.id}`,
    properties: {
      Name: { type: "title", title: [{ plain_text: opts.title }] },
      Description: {
        type: "rich_text",
        rich_text: [{ plain_text: opts.description ?? "" }],
      },
      Published: { type: "checkbox", checkbox: opts.published ?? true },
    },
  };
}

const emptyManifest = () => ({
  version: 2,
  last_synced_at: new Date(0).toISOString(),
  hash_v: 3,
  skills: {},
});

test("partitionFeed: new skill = published, created in window, not installed", () => {
  const pages = [
    page({
      id: "p1",
      title: "Migration Helper",
      description: "Helps migrate db schemas",
      created_time: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000).toISOString(), // 2d ago
    }),
  ];
  const out = partitionFeed(pages, emptyManifest(), SOURCE, SINCE);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].kind, "new");
  assert.equal(out.items[0].slug, "migration-helper");
  assert.equal(out.items[0].description, "Helps migrate db schemas");
});

test("partitionFeed: drafts (Published=false) are dropped", () => {
  const pages = [
    page({
      id: "p1",
      title: "WIP Skill",
      published: false,
      created_time: new Date(NOW.getTime() - 1 * 24 * 60 * 60_000).toISOString(),
    }),
  ];
  const out = partitionFeed(pages, emptyManifest(), SOURCE, SINCE);
  assert.equal(out.items.length, 0);
});

test("partitionFeed: archived / trashed pages are dropped", () => {
  const pages = [
    page({
      id: "p1",
      title: "Old",
      archived: true,
      created_time: new Date(NOW.getTime() - 1 * 24 * 60 * 60_000).toISOString(),
    }),
    page({
      id: "p2",
      title: "Old2",
      in_trash: true,
      created_time: new Date(NOW.getTime() - 1 * 24 * 60 * 60_000).toISOString(),
    }),
  ];
  const out = partitionFeed(pages, emptyManifest(), SOURCE, SINCE);
  assert.equal(out.items.length, 0);
});

test("partitionFeed: skills created before window are not 'new'", () => {
  const pages = [
    page({
      id: "p1",
      title: "Old Skill",
      created_time: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
    }),
  ];
  const out = partitionFeed(pages, emptyManifest(), SOURCE, SINCE);
  assert.equal(out.items.length, 0);
});

test("partitionFeed: updated = installed + edited in window + props_hash drift", () => {
  const editedAt = new Date(NOW.getTime() - 4 * 60 * 60_000).toISOString();
  const manifest = emptyManifest();
  manifest.skills["deploy"] = {
    source_key: "team",
    source_slug: "deploy",
    page_id: "p1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    props_hash: "stale-hash-from-pre-edit-state", // doesn't match live hash
  };
  const pages = [
    page({
      id: "p1",
      title: "Deploy",
      description: "post-edit description",
      created_time: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
      last_edited_time: editedAt,
    }),
  ];
  const out = partitionFeed(pages, manifest, SOURCE, SINCE);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].kind, "updated");
});

test("partitionFeed: install-counter bump alone does NOT trigger updated", () => {
  // Regression for the "boy who cried wolf" bug: every install bumps
  // the page's last_edited_time, but the Installs counter is excluded
  // from props_hash. So a metric-only edit must NOT show as 📝.
  const editedAt = new Date(NOW.getTime() - 4 * 60 * 60_000).toISOString();
  const livePage = page({
    id: "p1",
    title: "Deploy",
    description: "unchanged",
    created_time: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
    last_edited_time: editedAt,
  });
  const manifest = emptyManifest();
  manifest.skills["deploy"] = {
    source_key: "team",
    source_slug: "deploy",
    page_id: "p1",
    // Manifest's stored hash matches the live page's hash — so even
    // though last_edited_time differs (counter was bumped), no drift.
    last_edited_time: "2026-01-01T00:00:00.000Z",
    props_hash: hashBehaviorProperties(livePage),
  };
  const out = partitionFeed([livePage], manifest, SOURCE, SINCE);
  assert.equal(out.items.length, 0);
});

test("partitionFeed: pre-HASH_V manifest gets a free pass on updates", () => {
  // After a hash_v bump, manifest entries hold hashes from an older
  // scheme. Comparing them against fresh hashes would mass-false-
  // positive across an upgrade. Treat as "not outdated"; sync rebases.
  const livePage = page({
    id: "p1",
    title: "Deploy",
    created_time: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
    last_edited_time: new Date(NOW.getTime() - 4 * 60 * 60_000).toISOString(),
  });
  const manifest = emptyManifest();
  manifest.hash_v = 2; // older than current
  manifest.skills["deploy"] = {
    source_key: "team",
    source_slug: "deploy",
    page_id: "p1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    props_hash: "old-scheme-hash",
  };
  const out = partitionFeed([livePage], manifest, SOURCE, SINCE);
  assert.equal(out.items.length, 0);
});

test("partitionFeed: freshly-installed skill doesn't double-bucket", () => {
  // Created within window AND installed: not "new" (installed), not
  // "updated" (manifest props_hash matches → no drift). No bucket.
  const createdAt = new Date(NOW.getTime() - 1 * 24 * 60 * 60_000).toISOString();
  const livePage = page({
    id: "p1",
    title: "Fresh",
    created_time: createdAt,
    last_edited_time: createdAt,
  });
  const manifest = emptyManifest();
  manifest.skills["fresh"] = {
    source_key: "team",
    source_slug: "fresh",
    page_id: "p1",
    last_edited_time: createdAt,
    props_hash: hashBehaviorProperties(livePage),
  };
  const out = partitionFeed([livePage], manifest, SOURCE, SINCE);
  assert.equal(out.items.length, 0);
});

test("partitionFeed: items sorted by activity descending", () => {
  const pages = [
    page({
      id: "p1",
      title: "Older",
      created_time: new Date(NOW.getTime() - 5 * 24 * 60 * 60_000).toISOString(),
    }),
    page({
      id: "p2",
      title: "Newer",
      created_time: new Date(NOW.getTime() - 1 * 24 * 60 * 60_000).toISOString(),
    }),
  ];
  const out = partitionFeed(pages, emptyManifest(), SOURCE, SINCE);
  assert.equal(out.items[0].slug, "newer");
  assert.equal(out.items[1].slug, "older");
});

test("formatWindowHeader: picks the largest fully-contained unit", () => {
  const now = new Date("2026-05-07T12:00:00.000Z");
  // 12h is sub-day → render in hours, not "last day"
  assert.equal(
    formatWindowHeader(new Date(now.getTime() - 12 * 60 * 60_000), now),
    "Activity in the last 12 hours",
  );
  // 7d → 1 week, not "7 days"
  assert.equal(
    formatWindowHeader(new Date(now.getTime() - 7 * 24 * 60 * 60_000), now),
    "Activity in the last week",
  );
  // 14d → 2 weeks
  assert.equal(
    formatWindowHeader(new Date(now.getTime() - 14 * 24 * 60 * 60_000), now),
    "Activity in the last 2 weeks",
  );
  // 30d → 1 month
  assert.equal(
    formatWindowHeader(new Date(now.getTime() - 30 * 24 * 60 * 60_000), now),
    "Activity in the last month",
  );
  // 1h → singular hour
  assert.equal(
    formatWindowHeader(new Date(now.getTime() - 60 * 60_000), now),
    "Activity in the last hour",
  );
  // 30m → minutes
  assert.equal(
    formatWindowHeader(new Date(now.getTime() - 30 * 60_000), now),
    "Activity in the last 30 minutes",
  );
});

test("partitionFeed: only items from this source are considered installed", () => {
  // An installed entry in a DIFFERENT source shouldn't suppress a "new"
  // bucket for the same page_id (different source = different page in
  // the underlying Notion DB).
  const manifest = emptyManifest();
  manifest.skills["deploy"] = {
    source_key: "personal", // different source
    source_slug: "deploy",
    page_id: "p1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    props_hash: "x",
  };
  const pages = [
    page({
      id: "p1",
      title: "Deploy",
      created_time: new Date(NOW.getTime() - 1 * 24 * 60 * 60_000).toISOString(),
    }),
  ];
  const out = partitionFeed(pages, manifest, SOURCE, SINCE);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].kind, "new");
});
