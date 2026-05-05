import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collidingSlugSet,
  detectSlugCollisions,
} from "../dist/slug-collisions.js";

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

test("no collisions when every title slugifies uniquely", () => {
  const collisions = detectSlugCollisions([
    page({ id: "a", title: "Foo Bar" }),
    page({ id: "b", title: "Baz Qux" }),
  ]);
  assert.deepEqual(collisions, []);
});

test("two pages with the same title collide", () => {
  const collisions = detectSlugCollisions([
    page({ id: "a", title: "deslop" }),
    page({ id: "b", title: "deslop" }),
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].slug, "deslop");
  assert.deepEqual(collisions[0].titles, ["deslop", "deslop"]);
  assert.deepEqual(collisions[0].pageIds, ["a", "b"]);
});

test("titles that slugify to the same string collide (whitespace + casing)", () => {
  // Slugify lowercases, strips punctuation, collapses whitespace —
  // so "Foo Bar", "foo-bar", "FOO BAR", "Foo  Bar!" all collapse to "foo-bar".
  const collisions = detectSlugCollisions([
    page({ id: "a", title: "Foo Bar" }),
    page({ id: "b", title: "FOO BAR" }),
    page({ id: "c", title: "foo-bar" }),
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].slug, "foo-bar");
  assert.equal(collisions[0].pageIds.length, 3);
});

test("archived and trashed pages are ignored", () => {
  const collisions = detectSlugCollisions([
    page({ id: "a", title: "deslop" }),
    page({ id: "b", title: "deslop", archived: true }),
    page({ id: "c", title: "deslop", in_trash: true }),
  ]);
  assert.deepEqual(collisions, []);
});

test("pages with empty / missing titles don't participate", () => {
  const collisions = detectSlugCollisions([
    page({ id: "a", title: "" }),
    page({ id: "b" }),
    page({ id: "c", title: "" }),
  ]);
  assert.deepEqual(collisions, []);
});

test("multiple distinct collision groups are surfaced separately", () => {
  const collisions = detectSlugCollisions([
    page({ id: "a", title: "alpha" }),
    page({ id: "b", title: "alpha" }),
    page({ id: "c", title: "beta" }),
    page({ id: "d", title: "beta" }),
    page({ id: "e", title: "gamma" }),
  ]);
  assert.equal(collisions.length, 2);
  const slugs = new Set(collisions.map((c) => c.slug));
  assert.ok(slugs.has("alpha") && slugs.has("beta"));
});

test("collidingSlugSet returns just the slug strings", () => {
  const collisions = detectSlugCollisions([
    page({ id: "a", title: "alpha" }),
    page({ id: "b", title: "alpha" }),
    page({ id: "c", title: "beta" }),
  ]);
  const set = collidingSlugSet(collisions);
  assert.ok(set.has("alpha"));
  assert.ok(!set.has("beta"));
  assert.ok(!set.has("gamma"));
});
