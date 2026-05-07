import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRenameOps, detectRenames } from "../dist/renames.js";

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

function manifest(entries) {
  return {
    version: 2,
    last_synced_at: "2026-01-01T00:00:00.000Z",
    hash_v: 3,
    skills: Object.fromEntries(
      Object.entries(entries).map(([localSlug, e]) => [
        localSlug,
        {
          source_key: e.source_key ?? "team",
          source_slug: e.source_slug,
          page_id: e.page_id,
          last_edited_time: "2026-01-01T00:00:00.000Z",
          props_hash: "x",
        },
      ]),
    ),
  };
}

// detectRenames ——————————————————————————————————————————————————————

test("no renames when slugs match Notion titles", () => {
  const m = manifest({
    alpha: { source_slug: "alpha", page_id: "page-a" },
    beta: { source_slug: "beta", page_id: "page-b" },
  });
  const pages = [
    page({ id: "page-a", title: "alpha" }),
    page({ id: "page-b", title: "beta" }),
  ];
  assert.deepEqual(detectRenames(m, "team", pages), []);
});

test("title rename in Notion produces a RenameOp", () => {
  const m = manifest({ alpha: { source_slug: "alpha", page_id: "page-a" } });
  const pages = [page({ id: "page-a", title: "Alpha Renamed" })];
  const ops = detectRenames(m, "team", pages);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], {
    pageId: "page-a",
    localSlug: "alpha",
    oldSourceSlug: "alpha",
    newSourceSlug: "alpha-renamed",
  });
});

test("page archived in Notion → no rename op (handled by removal flow)", () => {
  const m = manifest({ alpha: { source_slug: "alpha", page_id: "page-a" } });
  const pages = [page({ id: "page-a", title: "alpha", archived: true })];
  assert.deepEqual(detectRenames(m, "team", pages), []);
});

test("page missing title → no rename op", () => {
  const m = manifest({ alpha: { source_slug: "alpha", page_id: "page-a" } });
  const pages = [page({ id: "page-a", title: "" })];
  assert.deepEqual(detectRenames(m, "team", pages), []);
});

test("multiple renames sort by localSlug", () => {
  const m = manifest({
    "z-skill": { source_slug: "z-skill", page_id: "page-z" },
    "a-skill": { source_slug: "a-skill", page_id: "page-a" },
  });
  const pages = [
    page({ id: "page-z", title: "Z Renamed" }),
    page({ id: "page-a", title: "A Renamed" }),
  ];
  const ops = detectRenames(m, "team", pages);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].localSlug, "a-skill");
  assert.equal(ops[1].localSlug, "z-skill");
});

test("entries from a different source are ignored", () => {
  // Entry belongs to "personal" but we ask about "team".
  const m = manifest({
    p: { source_key: "personal", source_slug: "p", page_id: "page-p" },
  });
  const pages = [page({ id: "page-p", title: "Renamed" })];
  assert.deepEqual(detectRenames(m, "team", pages), []);
});

test("page_id not in current query → no rename op", () => {
  const m = manifest({ alpha: { source_slug: "alpha", page_id: "page-a" } });
  assert.deepEqual(detectRenames(m, "team", []), []);
});

// classifyRenameOps ———————————————————————————————————————————————————

test("classifyRenameOps: no collision → renamed with new local_slug", () => {
  const m = manifest({ alpha: { source_slug: "alpha", page_id: "page-a" } });
  const outcomes = classifyRenameOps(
    [{ pageId: "page-a", localSlug: "alpha", oldSourceSlug: "alpha", newSourceSlug: "renamed" }],
    m,
    () => false,
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "renamed");
  assert.equal(outcomes[0].newLocalSlug, "renamed");
});

test("classifyRenameOps: manifest collision → source-only with reason", () => {
  const m = manifest({
    alpha: { source_slug: "alpha", page_id: "page-a" },
    renamed: { source_slug: "renamed", page_id: "page-r" },
  });
  const outcomes = classifyRenameOps(
    [{ pageId: "page-a", localSlug: "alpha", oldSourceSlug: "alpha", newSourceSlug: "renamed" }],
    m,
    () => false,
  );
  assert.equal(outcomes[0].status, "source-only");
  if (outcomes[0].status === "source-only") {
    assert.equal(outcomes[0].reason.kind, "collision-manifest");
  }
});

test("classifyRenameOps: disk collision → source-only with disk reason", () => {
  const m = manifest({ alpha: { source_slug: "alpha", page_id: "page-a" } });
  const outcomes = classifyRenameOps(
    [{ pageId: "page-a", localSlug: "alpha", oldSourceSlug: "alpha", newSourceSlug: "renamed" }],
    m,
    (slug) => slug === "renamed",
  );
  assert.equal(outcomes[0].status, "source-only");
  if (outcomes[0].status === "source-only") {
    assert.equal(outcomes[0].reason.kind, "collision-disk");
  }
});

test("classifyRenameOps: in-flight collision when two ops claim the same target", () => {
  const m = manifest({
    alpha: { source_slug: "alpha", page_id: "page-a" },
    beta: { source_slug: "beta", page_id: "page-b" },
  });
  const outcomes = classifyRenameOps(
    [
      { pageId: "page-a", localSlug: "alpha", oldSourceSlug: "alpha", newSourceSlug: "shared" },
      { pageId: "page-b", localSlug: "beta", oldSourceSlug: "beta", newSourceSlug: "shared" },
    ],
    m,
    () => false,
  );
  // First wins; second is refused as collision-manifest (the target's
  // already-spoken-for in this batch).
  assert.equal(outcomes[0].status, "renamed");
  assert.equal(outcomes[1].status, "source-only");
});

test("classifyRenameOps: noop when newSourceSlug equals localSlug", () => {
  // Edge case: source_slug was stale but local_slug already matches
  // the new source title (from a previous partial state). Should still
  // succeed as "renamed" without claiming a different slug.
  const m = manifest({ renamed: { source_slug: "alpha", page_id: "page-a" } });
  const outcomes = classifyRenameOps(
    [{ pageId: "page-a", localSlug: "renamed", oldSourceSlug: "alpha", newSourceSlug: "renamed" }],
    m,
    () => false,
  );
  assert.equal(outcomes[0].status, "renamed");
});
