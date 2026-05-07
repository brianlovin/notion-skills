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

test("https URL: blob/<ref>/<path>/SKILL.md → strips SKILL.md, keeps dir as subpath", () => {
  // The most common user-share link: paste from the GitHub file view
  // when they're looking at the SKILL.md itself.
  assert.deepEqual(
    parseGitHubSource(
      "https://github.com/mattpocock/skills/blob/main/skills/engineering/diagnose/SKILL.md",
    ),
    {
      owner: "mattpocock",
      repo: "skills",
      ref: "main",
      subpath: "skills/engineering/diagnose",
    },
  );
});

test("https URL: blob/<ref>/<path> to a non-SKILL.md keeps the path as-is", () => {
  // Edge case — pasting a sibling file URL. We don't strip; user
  // probably meant to scope to the file's parent dir but our
  // discoverer scopes to the dir anyway via subpath matching.
  assert.deepEqual(
    parseGitHubSource("https://github.com/owner/repo/blob/main/skills/foo/scripts/x.ts"),
    {
      owner: "owner",
      repo: "repo",
      ref: "main",
      subpath: "skills/foo/scripts/x.ts",
    },
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

test("malformed % escapes degrade gracefully (no crash)", () => {
  // Bare decodeURIComponent throws "URI malformed" on a lone `%`. We
  // want to hand the raw value back instead of crashing the CLI.
  assert.equal(parseGitHubSource("owner/repo#feature%").ref, "feature%");
});

test("URL with query string parses correctly (query is dropped)", () => {
  // GitHub UI sometimes adds query params (e.g. ?ref_type=...). Our
  // earlier regex-based parser matched up to the first `?` and
  // failed; the URL-constructor path now handles them naturally.
  assert.deepEqual(
    parseGitHubSource("https://github.com/vercel-labs/agent-skills?ref=copy-link"),
    { owner: "vercel-labs", repo: "agent-skills" },
  );
});

test("URL with query string + tree path parses correctly", () => {
  assert.deepEqual(
    parseGitHubSource(
      "https://github.com/vercel-labs/agent-skills/tree/main/skills/foo?utm=share",
    ),
    {
      owner: "vercel-labs",
      repo: "agent-skills",
      ref: "main",
      subpath: "skills/foo",
    },
  );
});

test("URL with non-github.com host is rejected", () => {
  assert.throws(
    () => parseGitHubSource("https://gitlab.com/owner/repo"),
    /Only github\.com/,
  );
});

test("URL with www.github.com is accepted", () => {
  assert.deepEqual(parseGitHubSource("https://www.github.com/owner/repo"), {
    owner: "owner",
    repo: "repo",
  });
});

test("malformed URL is reported as unrecognised source", () => {
  assert.throws(
    () => parseGitHubSource("https://[badhost"),
    /Unrecognised source/,
  );
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
