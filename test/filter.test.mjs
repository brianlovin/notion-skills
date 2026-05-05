import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSyncSkill } from "../dist/filter.js";

test("filter: undefined excludes — sync everything", () => {
  assert.equal(shouldSyncSkill("foo"), true);
});

test("filter: empty excludes — sync everything", () => {
  assert.equal(shouldSyncSkill("foo", []), true);
});

test("filter: skip when in excludes", () => {
  assert.equal(shouldSyncSkill("foo", ["foo"]), false);
});

test("filter: keep when not in excludes", () => {
  assert.equal(shouldSyncSkill("bar", ["foo"]), true);
});
