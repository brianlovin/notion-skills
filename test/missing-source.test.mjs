import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMissing, isNotionNotFound } from "../dist/missing-source.js";

// isNotionNotFound matches the wording ntn relays from Notion's
// `object_not_found` 404. The exact format we observed in the wild is:
//   "Public API request failed (404 Not Found object_not_found):
//    Could not find database with ID: <uuid>. Make sure …"
//
// The matcher must be tight enough that auth, network, or schema errors
// don't trigger the deleted-source path.

test("isNotionNotFound: matches the data-source 404 text we saw in the wild", () => {
  const err = new Error(
    `ntn api POST /v1/data_sources/abc/query failed (exit 5): error: Public API request failed (404 Not Found object_not_found): Could not find database with ID: abc. Make sure the relevant pages and databases are shared with your integration "Notion CLI".`,
  );
  assert.equal(isNotionNotFound(err), true);
});

test("isNotionNotFound: matches the page 404 variant", () => {
  const err = new Error(
    `Public API request failed (404 Not Found object_not_found): Could not find page with ID: abc.`,
  );
  assert.equal(isNotionNotFound(err), true);
});

test("isNotionNotFound: ignores auth failure", () => {
  const err = new Error("API token is invalid (exit 4)");
  assert.equal(isNotionNotFound(err), false);
});

test("isNotionNotFound: ignores schema-mismatch error", () => {
  const err = new Error('property "Name" is expected to be title');
  assert.equal(isNotionNotFound(err), false);
});

test("isNotionNotFound: ignores random network error", () => {
  const err = new Error("ENOTFOUND api.notion.com");
  assert.equal(isNotionNotFound(err), false);
});

test("isNotionNotFound: tolerates non-Error inputs", () => {
  assert.equal(isNotionNotFound(null), false);
  assert.equal(isNotionNotFound(undefined), false);
  assert.equal(isNotionNotFound("Could not find database"), false);
});

// classifyMissing: cross-source signal. If at least one source synced
// in the same run, auth is healthy → 404'd sources are deleted.
// If nothing synced, ambiguous (could be workspace mismatch).

test("classifyMissing: some succeeded + some missing → deleted", () => {
  assert.equal(classifyMissing({ succeededCount: 1, missingCount: 1 }), "deleted");
  assert.equal(classifyMissing({ succeededCount: 3, missingCount: 2 }), "deleted");
});

test("classifyMissing: zero succeeded + some missing → ambiguous", () => {
  assert.equal(classifyMissing({ succeededCount: 0, missingCount: 1 }), "ambiguous");
  assert.equal(classifyMissing({ succeededCount: 0, missingCount: 5 }), "ambiguous");
});

test("classifyMissing: nothing missing returns deleted (no-op default)", () => {
  // The caller skips the resolution path when missingCount is 0; the
  // exact return for that branch doesn't matter, but document it.
  assert.equal(classifyMissing({ succeededCount: 5, missingCount: 0 }), "deleted");
});
