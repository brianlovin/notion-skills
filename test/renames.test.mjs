import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRenameCollision,
  detectRenames,
} from "../dist/renames.js";

function page(opts) {
  return {
    object: "page",
    id: opts.id,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    archived: !!opts.archived,
    in_trash: !!opts.in_trash,
    properties: opts.title
      ? {
          Name: {
            type: "title",
            title: [{ type: "text", plain_text: opts.title }],
          },
        }
      : { Name: { type: "title", title: [] } },
  };
}

function manifest(skills) {
  return {
    version: 1,
    database_id: "db",
    data_source_id: "ds",
    last_synced_at: "2026-01-01T00:00:00.000Z",
    hash_v: 2,
    skills: Object.fromEntries(
      Object.entries(skills).map(([slug, page_id]) => [
        slug,
        {
          page_id,
          last_edited_time: "2026-01-01T00:00:00.000Z",
          props_hash: "x",
        },
      ]),
    ),
  };
}

// detectRenames ——————————————————————————————————————————————————————

test("no renames when slugs match Notion titles", () => {
  const m = manifest({ alpha: "page-a", beta: "page-b" });
  const pages = [page({ id: "page-a", title: "alpha" }), page({ id: "page-b", title: "beta" })];
  assert.deepEqual(detectRenames(m, pages), []);
});

test("title rename in Notion produces a RenameOp", () => {
  const m = manifest({ alpha: "page-a" });
  const pages = [page({ id: "page-a", title: "Alpha Renamed" })];
  const ops = detectRenames(m, pages);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], {
    pageId: "page-a",
    oldSlug: "alpha",
    newSlug: "alpha-renamed",
  });
});

test("page archived in Notion → no rename op (handled by removal flow)", () => {
  const m = manifest({ alpha: "page-a" });
  const pages = [page({ id: "page-a", title: "alpha", archived: true })];
  assert.deepEqual(detectRenames(m, pages), []);
});

test("page missing title → no rename op", () => {
  const m = manifest({ alpha: "page-a" });
  const pages = [page({ id: "page-a", title: "" })];
  assert.deepEqual(detectRenames(m, pages), []);
});

test("multiple renames sort by oldSlug", () => {
  const m = manifest({ "z-skill": "page-z", "a-skill": "page-a" });
  const pages = [
    page({ id: "page-z", title: "Z Renamed" }),
    page({ id: "page-a", title: "A Renamed" }),
  ];
  const ops = detectRenames(m, pages);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].oldSlug, "a-skill");
  assert.equal(ops[1].oldSlug, "z-skill");
});

test("manifest entry whose page_id isn't in current Notion query → no rename", () => {
  // Skill exists on this machine but not in the queried store.
  // Could be: scope changed, page archived, or page deleted. Not
  // a rename — handled elsewhere.
  const m = manifest({ alpha: "page-a" });
  const pages = [];
  assert.deepEqual(detectRenames(m, pages), []);
});

// classifyRenameCollision —————————————————————————————————————————————

test("no collision when target slug is free", () => {
  const op = { pageId: "p", oldSlug: "alpha", newSlug: "beta" };
  const m = manifest({ alpha: "p" });
  assert.equal(classifyRenameCollision(op, m, false), null);
});

test("collision when target slug already exists in manifest", () => {
  const op = { pageId: "p", oldSlug: "alpha", newSlug: "beta" };
  const m = manifest({ alpha: "p", beta: "q" });
  const result = classifyRenameCollision(op, m, false);
  assert.equal(result?.kind, "collision-manifest");
  assert.equal(result?.conflictWith, "beta");
});

test("collision when target slug exists on disk (draft etc.)", () => {
  const op = { pageId: "p", oldSlug: "alpha", newSlug: "beta" };
  const m = manifest({ alpha: "p" });
  const result = classifyRenameCollision(op, m, true);
  assert.equal(result?.kind, "collision-disk");
});
