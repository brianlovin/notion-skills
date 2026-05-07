import { test } from "node:test";
import assert from "node:assert/strict";
import { auditSkill, summariseIssues } from "../dist/audit.js";

const target = (overrides = {}) => ({
  localSlug: "test-skill",
  frontmatter: {
    name: "test-skill",
    description: "Use when the user wants to test something. Triggers on the word 'test'.",
  },
  body: "Run the test suite, then report the results back to the user.",
  files: [],
  ...overrides,
});

// ---------- structural / hard errors ----------

test("frontmatter-missing-name fires when name is absent", () => {
  const issues = auditSkill(target({ frontmatter: { description: "OK" } }));
  assert.ok(issues.some((i) => i.ruleId === "frontmatter-missing-name"));
});

test("description-empty fires for empty description", () => {
  const issues = auditSkill(target({ frontmatter: { name: "x", description: "" } }));
  assert.ok(issues.some((i) => i.ruleId === "description-empty"));
});

test("body-empty fires when body is whitespace only", () => {
  const issues = auditSkill(target({ body: "   \n\n  " }));
  assert.ok(issues.some((i) => i.ruleId === "body-empty"));
});

// ---------- description quality ----------

test("description-short fires for <30 char descriptions", () => {
  const issues = auditSkill(
    target({ frontmatter: { name: "x", description: "Too short." } }),
  );
  assert.ok(issues.some((i) => i.ruleId === "description-short"));
});

test("description-too-long fires past 1024 chars", () => {
  const long = "a".repeat(1100);
  const issues = auditSkill(target({ frontmatter: { name: "x", description: long } }));
  assert.ok(issues.some((i) => i.ruleId === "description-too-long"));
});

test("description-no-trigger fires when description omits trigger keywords", () => {
  const issues = auditSkill(
    target({
      frontmatter: {
        name: "x",
        description: "A skill that performs some specific action without a clear hint.",
      },
    }),
  );
  assert.ok(issues.some((i) => i.ruleId === "description-no-trigger"));
});

test("description-no-trigger silent when description includes 'use when'", () => {
  const issues = auditSkill(
    target({
      frontmatter: {
        name: "x",
        description: "Use when the user wants to do the thing.",
      },
    }),
  );
  assert.equal(issues.some((i) => i.ruleId === "description-no-trigger"), false);
});

// ---------- body content ----------

test("body-test-marker catches MATRIX-* leftovers with line number", () => {
  const issues = auditSkill(
    target({ body: "intro line\nMATRIX-CONFLICT-NOTION-EDIT-LATER\nsome more text" }),
  );
  const issue = issues.find((i) => i.ruleId === "body-test-marker");
  assert.ok(issue);
  assert.equal(issue.line, 2);
});

test("body-test-marker catches TODO-DELETE", () => {
  const issues = auditSkill(target({ body: "real body\nTODO-DELETE before shipping\nmore" }));
  assert.ok(issues.some((i) => i.ruleId === "body-test-marker"));
});

test("body-short fires for stub bodies", () => {
  const issues = auditSkill(target({ body: "Just a short stub." }));
  assert.ok(issues.some((i) => i.ruleId === "body-short"));
});

test("arg-ref-without-arguments fires when body uses $1 with no schema", () => {
  const issues = auditSkill(
    target({ body: "Run the suite for $1 and check the result." }),
  );
  assert.ok(issues.some((i) => i.ruleId === "arg-ref-without-arguments"));
});

test("arg-ref-without-arguments silent when argument-hint is present", () => {
  const issues = auditSkill(
    target({
      frontmatter: {
        name: "x",
        description: "Use when running the suite.",
        "argument-hint": "<package-name>",
      },
      body: "Run the suite for $1 and check the result.",
    }),
  );
  assert.equal(issues.some((i) => i.ruleId === "arg-ref-without-arguments"), false);
});

test("arg-ref-without-arguments silent when arguments list is present", () => {
  const issues = auditSkill(
    target({
      frontmatter: {
        name: "x",
        description: "Use when running the suite.",
        arguments: ["package"],
      },
      body: "Run the suite for $1.",
    }),
  );
  assert.equal(issues.some((i) => i.ruleId === "arg-ref-without-arguments"), false);
});

test("tool-ref-without-allow fires when body uses Bash but allowed-tools omits it", () => {
  const issues = auditSkill(
    target({
      frontmatter: {
        name: "x",
        description: "Use when running tests.",
        "allowed-tools": "Read Edit",
      },
      body: "Run `Bash(git status)` to inspect the tree.",
    }),
  );
  assert.ok(issues.some((i) => i.ruleId === "tool-ref-without-allow"));
});

test("tool-ref-without-allow silent when tool is unconstrained (no allowed-tools)", () => {
  const issues = auditSkill(
    target({
      frontmatter: {
        name: "x",
        description: "Use when running tests.",
      },
      body: "Run `Bash(git status)` to inspect.",
    }),
  );
  assert.equal(issues.some((i) => i.ruleId === "tool-ref-without-allow"), false);
});

// ---------- multi-file ----------

test("empty-sibling-file fires when a sibling file is 0 bytes", () => {
  const issues = auditSkill(
    target({ files: [{ path: "scripts/foo.ts", size: 0 }] }),
  );
  assert.ok(issues.some((i) => i.ruleId === "empty-sibling-file"));
});

test("empty-sibling-file silent for non-empty siblings", () => {
  const issues = auditSkill(
    target({ files: [{ path: "scripts/foo.ts", size: 200 }] }),
  );
  assert.equal(issues.some((i) => i.ruleId === "empty-sibling-file"), false);
});

// ---------- summarise ----------

test("summariseIssues counts severities", () => {
  const summary = summariseIssues([
    { ruleId: "a", severity: "error", message: "x" },
    { ruleId: "b", severity: "warning", message: "y" },
    { ruleId: "c", severity: "warning", message: "z" },
    { ruleId: "d", severity: "info", message: "w" },
  ]);
  assert.deepEqual(summary, { errors: 1, warnings: 2, infos: 1 });
});

// ---------- happy path ----------

test("clean skill produces no issues", () => {
  const issues = auditSkill(
    target({
      body:
        "Use when triggered. Steps:\n\n" +
        "1. Read the input.\n2. Process it.\n3. Write output.\n\n" +
        "More detail follows in subsequent paragraphs that ensure the body comfortably exceeds the 100-char minimum.",
    }),
  );
  assert.deepEqual(issues, []);
});
