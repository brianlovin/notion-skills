import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLineDiff,
  renderUnifiedDiff,
  hasChanges,
} from "../dist/diff.js";

test("computeLineDiff: identical inputs → all context", () => {
  const hunks = computeLineDiff("a\nb\nc", "a\nb\nc");
  assert.deepEqual(
    hunks.map((h) => h.type),
    ["context", "context", "context"],
  );
  assert.equal(hasChanges(hunks), false);
});

test("computeLineDiff: pure addition", () => {
  const hunks = computeLineDiff("a\nb", "a\nb\nc");
  assert.deepEqual(hunks, [
    { type: "context", text: "a" },
    { type: "context", text: "b" },
    { type: "add", text: "c" },
  ]);
  assert.equal(hasChanges(hunks), true);
});

test("computeLineDiff: pure removal", () => {
  const hunks = computeLineDiff("a\nb\nc", "a\nc");
  assert.deepEqual(hunks, [
    { type: "context", text: "a" },
    { type: "remove", text: "b" },
    { type: "context", text: "c" },
  ]);
});

test("computeLineDiff: replacement (remove + add interleaved)", () => {
  const hunks = computeLineDiff("a\nfoo\nc", "a\nbar\nc");
  assert.equal(hunks[0].type, "context");
  assert.equal(hunks[hunks.length - 1].type, "context");
  // The middle line "foo" became "bar" — must include both a remove
  // for foo and an add for bar somewhere in the middle.
  const adds = hunks.filter((h) => h.type === "add");
  const removes = hunks.filter((h) => h.type === "remove");
  assert.deepEqual(
    adds.map((h) => h.text),
    ["bar"],
  );
  assert.deepEqual(
    removes.map((h) => h.text),
    ["foo"],
  );
});

test("computeLineDiff: empty old → all adds", () => {
  // Splitting "" yields [""] (one empty line) which doesn't match any
  // line of newText, so we expect one remove for the empty line plus
  // adds for every newText line.
  const hunks = computeLineDiff("", "a\nb");
  assert.deepEqual(
    hunks.map((h) => h.text),
    ["", "a", "b"],
  );
  assert.deepEqual(
    hunks.map((h) => h.type),
    ["remove", "add", "add"],
  );
});

test("renderUnifiedDiff: hides untouched runs beyond context", () => {
  // 10 unchanged lines, 1 change in the middle.
  const oldText = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
  const newText = oldText.replace("line5", "LINE5");
  const hunks = computeLineDiff(oldText, newText);
  const rendered = renderUnifiedDiff(hunks, { context: 1 });
  // Should include line4, remove line5, add LINE5, line6 — plus elide
  // markers for the parts we skipped.
  const types = rendered.map((r) => r.type);
  assert.ok(types.includes("elide"));
  assert.ok(types.includes("remove"));
  assert.ok(types.includes("add"));
  // No more than ~7 lines total (2 context before/after, change pair, elides).
  assert.ok(rendered.length <= 8);
});

test("renderUnifiedDiff: empty when no changes", () => {
  const hunks = computeLineDiff("a\nb\nc", "a\nb\nc");
  assert.deepEqual(renderUnifiedDiff(hunks), []);
});

test("renderUnifiedDiff: maxLines truncates with a tail marker", () => {
  // Force a giant diff: 50 distinct removes + 50 distinct adds.
  const oldText = Array.from({ length: 50 }, (_, i) => `old-${i}`).join("\n");
  const newText = Array.from({ length: 50 }, (_, i) => `new-${i}`).join("\n");
  const hunks = computeLineDiff(oldText, newText);
  const rendered = renderUnifiedDiff(hunks, { context: 0, maxLines: 10 });
  assert.equal(rendered.length, 10);
  assert.equal(rendered[rendered.length - 1].type, "elide");
  assert.match(rendered[rendered.length - 1].text, /more lines/);
});
