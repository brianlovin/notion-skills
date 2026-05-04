import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../dist/convert.js";

test("slugify: simple title", () => {
  assert.equal(slugify("Bun Runtime"), "bun-runtime");
});

test("slugify: strips punctuation", () => {
  assert.equal(slugify("My Skill, with punctuation!"), "my-skill-with-punctuation");
});

test("slugify: collapses whitespace", () => {
  assert.equal(slugify("  trailing  spaces  "), "trailing-spaces");
});

test("slugify: lowercases", () => {
  assert.equal(slugify("UPPER CASE"), "upper-case");
});

test("slugify: drops unicode/emoji", () => {
  assert.equal(slugify("unicode café ☕"), "unicode-cafe");
});

test("slugify: empty falls back to 'untitled'", () => {
  assert.equal(slugify(""), "untitled");
});

test("slugify: caps at 64 chars", () => {
  const out = slugify("a".repeat(100));
  assert.equal(out.length, 64);
  assert.equal(out, "a".repeat(64));
});

test("slugify: collapses multiple separators", () => {
  assert.equal(slugify("foo___bar  baz"), "foo-bar-baz");
});

test("slugify: keeps numbers", () => {
  assert.equal(slugify("Skill v2"), "skill-v2");
});

test("slugify: preserves underscores in input but converts to hyphens", () => {
  assert.equal(slugify("hello_world"), "hello-world");
});
