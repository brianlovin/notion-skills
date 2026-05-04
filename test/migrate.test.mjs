import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSkills, markConflicts, resolveSourceDirs, parseSkillFile, sourceIsInScope } from "../dist/migrate.js";

// ---------- helpers ----------

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "notion-skills-test-"));
  return root;
}

function writeSkill(root, name, frontmatter, body) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n\n${body}`);
  return dir;
}

// ---------- parseSkillFile ----------

test("parseSkillFile: valid frontmatter + body", async () => {
  const root = makeFixture();
  const dir = writeSkill(
    root,
    "foo-skill",
    { name: "foo-skill", description: "Does foo." },
    "# Foo Skill\n\nBody content here.",
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "foo-skill",
  );
  assert.ok("skill" in result);
  assert.equal(result.skill.name, "foo-skill");
  assert.equal(result.skill.title, "foo-skill");
  assert.equal(result.skill.description, "Does foo.");
  // The H1 matching the name should be stripped (ntn does it server-side anyway).
  assert.equal(result.skill.body, "Body content here.");
  rmSync(root, { recursive: true });
});

test("parseSkillFile: keeps H1 if it doesn't match the name", async () => {
  const root = makeFixture();
  const dir = writeSkill(
    root,
    "foo",
    { name: "foo", description: "Does foo." },
    "# Different Title\n\nBody.",
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "foo",
  );
  assert.ok("skill" in result);
  assert.match(result.skill.body, /^# Different Title/);
  rmSync(root, { recursive: true });
});

test("parseSkillFile: missing description → invalid", async () => {
  const root = makeFixture();
  const dir = writeSkill(root, "foo", { name: "foo" }, "Body.");
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "foo",
  );
  assert.ok("error" in result);
  assert.match(result.error, /description/);
  rmSync(root, { recursive: true });
});

test("parseSkillFile: no frontmatter → invalid", async () => {
  const root = makeFixture();
  const dir = join(root, "noFM");
  mkdirSync(dir);
  writeFileSync(join(dir, "SKILL.md"), "Just plain markdown.");
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "noFM",
  );
  assert.ok("error" in result);
  assert.match(result.error, /frontmatter/);
  rmSync(root, { recursive: true });
});

test("parseSkillFile: parses all spec fields into properties", async () => {
  const root = makeFixture();
  const dir = join(root, "fancy");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: fancy
description: Does things.
when_to_use: When the user asks for fancy.
argument-hint: "[issue]"
arguments: issue branch
allowed-tools: Read Edit Bash(git *)
paths: src/*.ts, test/*.ts
disable-model-invocation: true
user-invocable: false
model: claude-opus-4-7
effort: high
context: fork
agent: Explore
shell: bash
---

Body.`,
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "fancy",
  );
  assert.ok("skill" in result);
  const p = result.skill.properties;
  assert.equal(p.name, "fancy");
  assert.equal(p.description, "Does things.");
  assert.equal(p.when_to_use, "When the user asks for fancy.");
  assert.equal(p["argument-hint"], "[issue]");
  assert.deepEqual(p.arguments, ["issue", "branch"]);
  assert.deepEqual(p["allowed-tools"], ["Read", "Edit", "Bash(git *)"]); // paren-aware split
  assert.deepEqual(p.paths, ["src/*.ts", "test/*.ts"]); // comma-split
  assert.equal(p["disable-model-invocation"], "true");
  assert.equal(p["user-invocable"], "false");
  assert.equal(p.model, "claude-opus-4-7");
  assert.equal(p.effort, "high");
  assert.equal(p.context, "fork");
  assert.equal(p.agent, "Explore");
  assert.equal(p.shell, "bash");
  rmSync(root, { recursive: true });
});

test("parseSkillFile: arguments as YAML list", async () => {
  const root = makeFixture();
  const dir = join(root, "yamlist");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: yamlist
description: x.
arguments:
  - issue
  - branch
allowed-tools:
  - Read
  - Edit
---
body`,
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "yamlist",
  );
  assert.ok("skill" in result);
  assert.deepEqual(result.skill.properties.arguments, ["issue", "branch"]);
  assert.deepEqual(result.skill.properties["allowed-tools"], ["Read", "Edit"]);
  rmSync(root, { recursive: true });
});

test("parseSkillFile: boolean-style frontmatter values for spec booleans", async () => {
  // YAML lets users write `disable-model-invocation: true` (boolean) instead
  // of `: "true"` (string). We should accept both and normalise to strings.
  const root = makeFixture();
  const dir = join(root, "bool");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: bool
description: x.
disable-model-invocation: true
user-invocable: false
---
body`,
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "bool",
  );
  assert.ok("skill" in result);
  assert.equal(result.skill.properties["disable-model-invocation"], "true");
  assert.equal(result.skill.properties["user-invocable"], "false");
  rmSync(root, { recursive: true });
});

test("parseSkillFile: omitted spec fields are undefined", async () => {
  const root = makeFixture();
  const dir = writeSkill(
    root,
    "minimal",
    { name: "minimal", description: "Just the basics." },
    "Body.",
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "minimal",
  );
  assert.ok("skill" in result);
  const p = result.skill.properties;
  assert.equal(p.when_to_use, undefined);
  assert.equal(p.model, undefined);
  assert.equal(p.arguments, undefined);
  assert.equal(p["disable-model-invocation"], undefined);
  rmSync(root, { recursive: true });
});

test("parseSkillFile: falls back to dir name if frontmatter omits name", async () => {
  const root = makeFixture();
  const dir = writeSkill(
    root,
    "anon",
    { description: "Has no name field." },
    "Body.",
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "fallback-name",
  );
  assert.ok("skill" in result);
  assert.equal(result.skill.name, "fallback-name");
  rmSync(root, { recursive: true });
});

// ---------- discoverSkills ----------

test("discoverSkills: classifies new vs invalid", async () => {
  const root = makeFixture();
  const sourceDir = join(root, "skills");
  mkdirSync(sourceDir);
  writeSkill(
    sourceDir,
    "valid",
    { name: "valid", description: "ok." },
    "Body.",
  );
  // Invalid: no SKILL.md
  mkdirSync(join(sourceDir, "no-md"));
  // Invalid: no description
  mkdirSync(join(sourceDir, "no-desc"));
  writeFileSync(join(sourceDir, "no-desc", "SKILL.md"), "---\nname: no-desc\n---\nbody");
  // Hidden dir → ignored
  mkdirSync(join(sourceDir, ".hidden"));

  const results = await discoverSkills({ sourceDirs: [sourceDir] });

  const byKind = results.reduce(
    (acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }),
    {},
  );
  assert.equal(byKind.new, 1);
  assert.equal(byKind.invalid, 2); // no-md + no-desc
  assert.equal(byKind.managed, undefined);

  rmSync(root, { recursive: true });
});

test("discoverSkills: deduplicates by realpath when same skill is in two dirs", async () => {
  const root = makeFixture();
  const real = join(root, "real");
  mkdirSync(real);
  writeSkill(real, "shared", { name: "shared", description: "x." }, "body");

  const dirA = join(root, "a");
  const dirB = join(root, "b");
  mkdirSync(dirA);
  mkdirSync(dirB);
  symlinkSync(join(real, "shared"), join(dirA, "shared"));
  symlinkSync(join(real, "shared"), join(dirB, "shared"));

  const results = await discoverSkills({ sourceDirs: [dirA, dirB] });
  const news = results.filter((r) => r.kind === "new");
  assert.equal(news.length, 1, "should dedup the same realpath");
  rmSync(root, { recursive: true });
});

test("discoverSkills: missing source dir is silently skipped", async () => {
  const results = await discoverSkills({
    sourceDirs: ["/path/that/does/not/exist"],
  });
  assert.deepEqual(results, []);
});

// ---------- markConflicts ----------

test("markConflicts: turns 'new' into 'conflict' when slug matches", () => {
  const skill = {
    name: "foo",
    title: "foo",
    description: "x",
    body: "",
    source: "/x",
    sourceDisplay: "/x",
  };
  const out = markConflicts(
    [{ kind: "new", skill }],
    new Map([["foo", { pageId: "page-id", title: "Foo" }]]),
  );
  assert.equal(out[0].kind, "conflict");
  assert.equal(out[0].existingPageId, "page-id");
});

test("markConflicts: leaves 'managed' alone", () => {
  const out = markConflicts(
    [{ kind: "managed", sourceDisplay: "/x", name: "foo" }],
    new Map([["foo", { pageId: "page-id", title: "Foo" }]]),
  );
  assert.equal(out[0].kind, "managed");
});

test("markConflicts: leaves 'invalid' alone", () => {
  const out = markConflicts(
    [{ kind: "invalid", sourceDisplay: "/x", reason: "broken" }],
    new Map(),
  );
  assert.equal(out[0].kind, "invalid");
});

// ---------- resolveSourceDirs ----------

test("resolveSourceDirs: global pulls in target dirs and extras", () => {
  const dirs = resolveSourceDirs("global", {
    targetDirs: ["/a", "/b"],
    extras: ["/c"],
  });
  assert.deepEqual(dirs.sort(), ["/a", "/b", "/c"]);
});

test("resolveSourceDirs: project uses projectSkillsDir, ignores targetDirs", () => {
  const dirs = resolveSourceDirs("project", {
    targetDirs: ["/should-not-appear"],
    projectSkillsDir: "/myrepo/.claude/skills",
  });
  assert.deepEqual(dirs, ["/myrepo/.claude/skills"]);
});

test("resolveSourceDirs: dedups duplicate paths", () => {
  const dirs = resolveSourceDirs("global", {
    targetDirs: ["/a", "/b"],
    extras: ["/a"],
  });
  assert.deepEqual(dirs.sort(), ["/a", "/b"]);
});

// ---------- sourceIsInScope (regression: don't delete --from sources) ----------

test("sourceIsInScope: source inside a target dir is in scope", () => {
  assert.equal(
    sourceIsInScope("/Users/me/.claude/skills/foo", [
      "/Users/me/.claude/skills",
      "/Users/me/.codex/skills",
    ]),
    true,
  );
});

test("sourceIsInScope: source from --from path is NOT in scope", () => {
  // This is the regression case: an agent-config repo passed via --from
  // resolves through a symlink so its realpath is /Users/me/Developer/agent-config/skills/foo.
  // We must NOT consider that "in scope" — moving it would delete the user's repo.
  assert.equal(
    sourceIsInScope("/Users/me/Developer/agent-config/skills/foo", [
      "/Users/me/.claude/skills",
      "/Users/me/.codex/skills",
    ]),
    false,
  );
});

test("sourceIsInScope: doesn't false-positive on prefix match", () => {
  // /Users/me/.claude/skills-extra is NOT inside /Users/me/.claude/skills
  assert.equal(
    sourceIsInScope("/Users/me/.claude/skills-extra/foo", [
      "/Users/me/.claude/skills",
    ]),
    false,
  );
});

test("sourceIsInScope: trailing slash on target dir is tolerated", () => {
  assert.equal(
    sourceIsInScope("/a/b/skill", ["/a/b/"]),
    true,
  );
});

test("sourceIsInScope: source equal to target dir itself", () => {
  // Pathological but valid: source === target dir.
  assert.equal(sourceIsInScope("/a/b", ["/a/b"]), true);
});
