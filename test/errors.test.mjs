import { test } from "node:test";
import assert from "node:assert/strict";
import { translateError } from "../dist/errors.js";

test("translates ntn auth failure", () => {
  const f = translateError(
    new Error("Public API request failed: API token is invalid."),
  );
  assert.match(f.summary, /auth/i);
  assert.match(f.suggest, /ntn login/);
});

test("translates schema-type mismatch", () => {
  const f = translateError(
    new Error("validation_error: Tags is expected to be select."),
  );
  assert.match(f.summary, /schema/i);
  assert.match(f.suggest, /upgrade/);
});

test("translates archived page", () => {
  const f = translateError(
    new Error("Can't edit block that is archived. You must unarchive..."),
  );
  assert.match(f.summary, /trash/i);
  // No automated suggestion — user has to fix in Notion UI.
  assert.equal(f.suggest, undefined);
});

test("translates 'no scope' into init suggestion", () => {
  const f = translateError(new Error("No scope configured. Run init first."));
  assert.match(f.summary, /(not configured|isn't configured)/i);
  assert.match(f.suggest, /init/);
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
  assert.equal(f.suggest, undefined);
});

test("handles non-Error values", () => {
  const f = translateError("plain string error");
  assert.equal(f.summary, "plain string error");
  assert.equal(f.raw, "plain string error");
});

test("translates GitHub rate limit hit", () => {
  const f = translateError(
    new Error("GitHub rate limit hit (403). Set GITHUB_TOKEN…"),
  );
  assert.match(f.summary, /rate limit/i);
  assert.match(f.suggest, /GITHUB_TOKEN/);
});

test("translates GitHub fetch timeout", () => {
  const f = translateError(
    new Error("GitHub fetch timed out after 10s (https://...)."),
  );
  assert.match(f.summary, /too long/i);
  assert.match(f.suggest, /NOTION_SKILLS_FETCH_TIMEOUT_MS/);
});

test("translates GitHub 404 with private-repo hint", () => {
  const f = translateError(
    new Error("GitHub API returned 404 for owner/repo @ main."),
  );
  assert.match(f.summary, /find/i);
  assert.match(f.detail, /private/i);
});

test("translates non-github host rejection", () => {
  const f = translateError(
    new Error("Only github.com URLs are supported (got gitlab.com)."),
  );
  assert.match(f.summary, /github\.com/i);
});

test("translates unknown source key", () => {
  const f = translateError(
    new Error('Unknown source "team". Configured sources: skills, runbooks.'),
  );
  assert.match(f.summary, /isn't configured/i);
  assert.match(f.suggest, /source list/);
});

test("translates 'multiple sources, no default'", () => {
  const f = translateError(
    new Error("Multiple sources configured and no default set.\n  Pass --source <key>…"),
  );
  assert.match(f.summary, /which to use/i);
  assert.match(f.detail, /--source/);
});
