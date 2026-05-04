import { test } from "node:test";
import assert from "node:assert/strict";
import { translateError } from "../dist/errors.js";

test("translates ntn auth failure", () => {
  const f = translateError(
    new Error("Public API request failed: API token is invalid."),
  );
  assert.match(f.summary, /auth/i);
  assert.ok(f.recovery, "recovery should be offered");
  assert.match(f.recovery.label, /ntn login/);
});

test("translates schema-type mismatch", () => {
  const f = translateError(
    new Error("validation_error: Tags is expected to be select."),
  );
  assert.match(f.summary, /schema/i);
  assert.ok(f.recovery, "recovery should be offered");
  assert.match(f.recovery.label, /upgrade/);
});

test("translates archived page", () => {
  const f = translateError(
    new Error("Can't edit block that is archived. You must unarchive..."),
  );
  assert.match(f.summary, /trash/i);
  // No automated recovery — user has to click in Notion.
  assert.equal(f.recovery, undefined);
});

test("translates 'no scope' into init recovery", () => {
  const f = translateError(new Error("No scope configured. Run init first."));
  assert.match(f.summary, /(not configured|isn't configured)/i);
  assert.ok(f.recovery);
  assert.match(f.recovery.label, /init/);
});

test("translates network failure", () => {
  const f = translateError(new Error("getaddrinfo ENOTFOUND api.notion.com"));
  assert.match(f.summary, /reach/i);
});

test("translates 'not found' as missing-page guidance", () => {
  const f = translateError(new Error("Could not find page with ID: abc123"));
  assert.match(f.summary, /find/i);
});

test("preserves raw message even when translated", () => {
  const raw = "Public API request failed: API token is invalid.";
  const f = translateError(new Error(raw));
  assert.equal(f.raw, raw);
});

test("falls through unmatched errors as-is", () => {
  const f = translateError(new Error("Some unexpected error xyz"));
  assert.equal(f.summary, "Some unexpected error xyz");
  assert.equal(f.recovery, undefined);
});

test("handles non-Error values", () => {
  const f = translateError("plain string error");
  assert.equal(f.summary, "plain string error");
  assert.equal(f.raw, "plain string error");
});
