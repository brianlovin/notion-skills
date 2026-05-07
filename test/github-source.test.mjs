import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubSource, formatSourceRef } from "../dist/github.js";

// ---------- shorthand ----------

test("owner/repo: bare shorthand", () => {
  assert.deepEqual(parseGitHubSource("vercel-labs/agent-skills"), {
    owner: "vercel-labs",
    repo: "agent-skills",
  });
});

test("owner/repo/subpath: subdir scoping", () => {
  assert.deepEqual(parseGitHubSource("vercel-labs/agent-skills/skills/web-design"), {
    owner: "vercel-labs",
    repo: "agent-skills",
    subpath: "skills/web-design",
  });
});

test("owner/repo#ref: branch/tag pinning", () => {
  assert.deepEqual(parseGitHubSource("vercel-labs/agent-skills#v1.0"), {
    owner: "vercel-labs",
    repo: "agent-skills",
    ref: "v1.0",
  });
});

test("owner/repo@skill: filter to one skill", () => {
  assert.deepEqual(parseGitHubSource("vercel-labs/agent-skills@frontend-design"), {
    owner: "vercel-labs",
    repo: "agent-skills",
    skillFilter: "frontend-design",
  });
});

test("owner/repo#ref@skill: combined", () => {
  assert.deepEqual(parseGitHubSource("vercel-labs/agent-skills#v1.0@frontend-design"), {
    owner: "vercel-labs",
    repo: "agent-skills",
    ref: "v1.0",
    skillFilter: "frontend-design",
  });
});

test("github: prefix is stripped + re-parsed", () => {
  assert.deepEqual(parseGitHubSource("github:owner/repo"), { owner: "owner", repo: "repo" });
});

// ---------- urls ----------

test("https URL: bare repo", () => {
  assert.deepEqual(parseGitHubSource("https://github.com/vercel-labs/agent-skills"), {
    owner: "vercel-labs",
    repo: "agent-skills",
  });
});

test("https URL: with .git suffix", () => {
  assert.deepEqual(parseGitHubSource("https://github.com/vercel-labs/agent-skills.git"), {
    owner: "vercel-labs",
    repo: "agent-skills",
  });
});

test("https URL: tree/ref/subpath", () => {
  assert.deepEqual(
    parseGitHubSource("https://github.com/vercel-labs/agent-skills/tree/main/skills/foo"),
    {
      owner: "vercel-labs",
      repo: "agent-skills",
      ref: "main",
      subpath: "skills/foo",
    },
  );
});

test("https URL: tree/ref only (no subpath)", () => {
  assert.deepEqual(
    parseGitHubSource("https://github.com/vercel-labs/agent-skills/tree/main"),
    { owner: "vercel-labs", repo: "agent-skills", ref: "main" },
  );
});

test("ssh URL: git@github.com form", () => {
  assert.deepEqual(parseGitHubSource("git@github.com:vercel-labs/agent-skills.git"), {
    owner: "vercel-labs",
    repo: "agent-skills",
  });
});

// ---------- safety + edge cases ----------

test("rejects path traversal in subpath", () => {
  assert.throws(() => parseGitHubSource("owner/repo/../escape"), /Unsafe subpath/);
});

test("rejects empty input", () => {
  assert.throws(() => parseGitHubSource(""), /Empty source/);
});

test("rejects malformed input", () => {
  assert.throws(() => parseGitHubSource("nope"), /Unrecognised source/);
});

test("decodes URL-encoded refs", () => {
  // `%20` is a space — Notion-style refs sometimes have spaces in branch names.
  assert.equal(parseGitHubSource("owner/repo#feature%20branch").ref, "feature branch");
});

// ---------- formatSourceRef ----------

test("formatSourceRef: bare shorthand round-trips", () => {
  const s = parseGitHubSource("owner/repo");
  assert.equal(formatSourceRef(s), "owner/repo");
});

test("formatSourceRef: full form round-trips", () => {
  const s = parseGitHubSource("owner/repo/sub/path#main@skill");
  assert.equal(formatSourceRef(s), "owner/repo/sub/path#main@skill");
});

test("formatSourceRef: parsed-from-URL emits shorthand", () => {
  const s = parseGitHubSource("https://github.com/owner/repo/tree/main/skills/foo");
  assert.equal(formatSourceRef(s), "owner/repo/skills/foo#main");
});
