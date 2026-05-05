import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
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

test("parseSkillFile: tags as YAML list parsed into properties.tags", async () => {
  const root = makeFixture();
  const dir = join(root, "tagged");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: tagged
description: ok.
tags:
  - engineering
  - productivity
---
body`,
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "tagged",
  );
  assert.ok("skill" in result);
  assert.deepEqual(result.skill.properties.tags, ["engineering", "productivity"]);
  rmSync(root, { recursive: true });
});

test("parseSkillFile: comma-separated tags parsed into properties.tags", async () => {
  // Some authors will write `tags: engineering, productivity` instead of
  // a YAML list. Accept the comma form too.
  const root = makeFixture();
  const dir = writeSkill(
    root,
    "comma-tagged",
    { name: "comma-tagged", description: "ok", tags: "engineering, productivity" },
    "body",
  );
  const result = await parseSkillFile(
    join(dir, "SKILL.md"),
    dir,
    dir,
    "comma-tagged",
  );
  assert.ok("skill" in result);
  assert.deepEqual(result.skill.properties.tags, ["engineering", "productivity"]);
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

test("discoverSkills: same slug + same content across two real dirs collapses with additionalSources", async () => {
  // Two REAL dirs (not symlinks) with identical SKILL.md content.
  // Should collapse to one classification with additionalSources populated.
  const root = makeFixture();
  const dirA = join(root, "a");
  const dirB = join(root, "b");
  mkdirSync(dirA);
  mkdirSync(dirB);
  const fmA = { name: "twin", description: "twins." };
  writeSkill(dirA, "twin", fmA, "Same body.");
  writeSkill(dirB, "twin", fmA, "Same body.");

  const results = await discoverSkills({ sourceDirs: [dirA, dirB] });
  const news = results.filter((r) => r.kind === "new");
  assert.equal(news.length, 1, "should collapse to one entry");
  assert.equal(news[0].skill.name, "twin");
  assert.equal(news[0].skill.additionalSources?.length, 1);
  assert.equal(news[0].skill.conflictingSources, undefined);
  rmSync(root, { recursive: true });
});

test("discoverSkills: same slug + DIFFERENT content flags conflictingSources", async () => {
  const root = makeFixture();
  const dirA = join(root, "a");
  const dirB = join(root, "b");
  mkdirSync(dirA);
  mkdirSync(dirB);
  writeSkill(dirA, "split", { name: "split", description: "first." }, "Body A.");
  writeSkill(dirB, "split", { name: "split", description: "second." }, "Body B (different).");

  const results = await discoverSkills({ sourceDirs: [dirA, dirB] });
  const news = results.filter((r) => r.kind === "new");
  assert.equal(news.length, 1, "should collapse to one canonical entry");
  // Exactly one extra path, in conflictingSources, NOT in additionalSources.
  assert.equal(news[0].skill.conflictingSources?.length, 1);
  assert.deepEqual(news[0].skill.additionalSources ?? [], []);
  rmSync(root, { recursive: true });
});

test("discoverSkills: missing source dir is silently skipped", async () => {
  const results = await discoverSkills({
    sourceDirs: ["/path/that/does/not/exist"],
  });
  assert.deepEqual(results, []);
});

test("discoverSkills: central-store entry not in trackedNames classifies as new", async () => {
  // Regression: this is the path `gen` relies on. The agent writes to
  // <central_store>/<slug>/SKILL.md and migrate must classify it as a
  // candidate for upload, not as already-synced.
  const root = makeFixture();
  const centralStore = join(root, "skills");
  mkdirSync(centralStore);
  writeSkill(centralStore, "fresh-local", { name: "fresh-local", description: "ok" }, "body");

  const results = await discoverSkills({
    sourceDirs: [centralStore],
    centralStore,
    trackedNames: new Set(),
  });
  const news = results.filter((r) => r.kind === "new");
  assert.equal(news.length, 1);
  assert.equal(news[0].skill.name, "fresh-local");
  rmSync(root, { recursive: true });
});

test("discoverSkills: central-store entry in trackedNames classifies as managed", async () => {
  // Regression: skills synced from Notion shouldn't look like upload
  // candidates. Once a skill is in the manifest it's considered tracked,
  // so re-running migrate over the central store is a no-op for it.
  const root = makeFixture();
  const centralStore = join(root, "skills");
  mkdirSync(centralStore);
  writeSkill(centralStore, "synced-already", { name: "synced-already", description: "ok" }, "body");

  const results = await discoverSkills({
    sourceDirs: [centralStore],
    centralStore,
    trackedNames: new Set(["synced-already"]),
  });
  const news = results.filter((r) => r.kind === "new");
  const managed = results.filter((r) => r.kind === "managed");
  assert.equal(news.length, 0);
  assert.equal(managed.length, 1);
  rmSync(root, { recursive: true });
});

test("discoverSkills: managed entries dedupe by name across multiple target dirs", async () => {
  // Regression: previously a skill present in N target dirs (as
  // symlinks into the central store) plus the real entry in the
  // central store produced N+1 "managed" classifications, which
  // surfaced as confusing counts like "76 managed" for 19 skills.
  // The dedup keys on slug, so each skill shows up at most once.
  const root = realpathSync(makeFixture());
  const centralStore = join(root, "skills");
  const claudeDir = join(root, "claude-skills");
  const codexDir = join(root, "codex-skills");
  mkdirSync(centralStore);
  mkdirSync(claudeDir);
  mkdirSync(codexDir);
  writeSkill(centralStore, "shared", { name: "shared", description: "ok" }, "body");
  symlinkSync(join(centralStore, "shared"), join(claudeDir, "shared"));
  symlinkSync(join(centralStore, "shared"), join(codexDir, "shared"));

  const results = await discoverSkills({
    sourceDirs: [centralStore, claudeDir, codexDir],
    centralStore,
    trackedNames: new Set(["shared"]),
  });
  const managed = results.filter((r) => r.kind === "managed");
  assert.equal(managed.length, 1, "managed entries should dedupe by name");
  assert.equal(managed[0].name, "shared");
  rmSync(root, { recursive: true });
});

test("discoverSkills: symlink in target dir pointing into central store stays managed", async () => {
  // The classic post-migrate state: ~/.claude/skills/foo is a symlink
  // into ~/.notion-skills/skills/foo. The symlink scan should classify
  // it as managed regardless of whether `foo` is in trackedNames at
  // discovery time, because the symlink itself isn't a candidate for
  // upload — its target is.
  const root = realpathSync(makeFixture());
  const centralStore = join(root, "skills");
  const targetDir = join(root, "claude-skills");
  mkdirSync(centralStore);
  mkdirSync(targetDir);
  writeSkill(centralStore, "real-foo", { name: "real-foo", description: "ok" }, "body");
  symlinkSync(join(centralStore, "real-foo"), join(targetDir, "real-foo"));

  const results = await discoverSkills({
    sourceDirs: [targetDir],
    centralStore,
    trackedNames: new Set(),
  });
  // The symlink should be classified as managed (not as a "new" upload
  // candidate) — its realpath is in the central store.
  assert.ok(results.some((r) => r.kind === "managed" && r.name === "real-foo"));
  assert.ok(!results.some((r) => r.kind === "new"));
  rmSync(root, { recursive: true });
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

test("resolveSourceDirs: target dirs + extras combined", () => {
  const dirs = resolveSourceDirs({
    targetDirs: ["/a", "/b"],
    extras: ["/c"],
  });
  assert.deepEqual(dirs.sort(), ["/a", "/b", "/c"]);
});

test("resolveSourceDirs: dedups duplicate paths", () => {
  const dirs = resolveSourceDirs({
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

