import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSkillMarkdown } from "../dist/convert.js";

test("buildSkillMarkdown: standard frontmatter", () => {
  const md = buildSkillMarkdown({
    properties: { name: "test-skill", description: "Does a thing." },
    body: "# Heading\n\nSome content.",
  });
  assert.match(md, /^---\nname: test-skill\ndescription: Does a thing\.\n---\n/);
  assert.match(md, /\n# Heading\n\nSome content\.\n$/);
});

test("buildSkillMarkdown: long description folds via YAML", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description:
        "A long description that exceeds the typical line length and should fold into YAML's folded scalar form across multiple lines.",
    },
    body: "body",
  });
  assert.match(md, /^---/);
  assert.match(md, /^description:/m);
  assert.match(md, /\nbody\n$/);
});

test("buildSkillMarkdown: omits unset spec fields", () => {
  const md = buildSkillMarkdown({
    properties: { name: "x", description: "ok" },
    body: "body",
  });
  // None of the optional spec keys should be present
  assert.doesNotMatch(md, /^when_to_use:/m);
  assert.doesNotMatch(md, /^model:/m);
  assert.doesNotMatch(md, /^arguments:/m);
});

test("buildSkillMarkdown: emits when_to_use when set", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      when_to_use: "Use when the user asks for X.",
    },
    body: "body",
  });
  assert.match(md, /^when_to_use:/m);
});

test("buildSkillMarkdown: emits arguments as YAML list", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      arguments: ["issue", "branch"],
    },
    body: "body",
  });
  assert.match(md, /arguments:\n  - issue\n  - branch/);
});

test("buildSkillMarkdown: emits allowed-tools as YAML list", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      "allowed-tools": ["Read", "Edit", "Bash(git *)"],
    },
    body: "body",
  });
  assert.match(md, /allowed-tools:\n  - Read\n  - Edit\n  - Bash\(git \*\)/);
});

test("buildSkillMarkdown: skips select == default value", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      "disable-model-invocation": "false", // matches spec default
      "user-invocable": "true",             // matches spec default
      shell: "bash",                        // matches spec default
    },
    body: "body",
  });
  assert.doesNotMatch(md, /^disable-model-invocation:/m);
  assert.doesNotMatch(md, /^user-invocable:/m);
  assert.doesNotMatch(md, /^shell:/m);
});

test("buildSkillMarkdown: emits select != default value", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      "disable-model-invocation": "true",  // override
      "user-invocable": "false",
      shell: "powershell",
    },
    body: "body",
  });
  // YAML stringify quotes the boolean-string values (true/false) to keep
  // them as strings rather than being parsed back as booleans.
  assert.match(md, /^disable-model-invocation: ["']true["']/m);
  assert.match(md, /^user-invocable: ["']false["']/m);
  assert.match(md, /^shell: powershell/m);
});

test("buildSkillMarkdown: emits model + effort + context + agent", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      model: "claude-sonnet-4-6",
      effort: "high",
      context: "fork",
      agent: "Explore",
    },
    body: "body",
  });
  assert.match(md, /^model: claude-sonnet-4-6/m);
  assert.match(md, /^effort: high/m);
  assert.match(md, /^context: fork/m);
  assert.match(md, /^agent: Explore/m);
});

test("buildSkillMarkdown: emits tags as a YAML list", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      tags: ["engineering", "productivity"],
    },
    body: "body",
  });
  assert.match(md, /tags:\n  - engineering\n  - productivity/);
});

test("buildSkillMarkdown: empty tags don't get emitted", () => {
  const md = buildSkillMarkdown({
    properties: { name: "x", description: "ok", tags: [] },
    body: "body",
  });
  assert.doesNotMatch(md, /^tags:/m);
});

test("buildSkillMarkdown: empty arrays don't get emitted", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      arguments: [],
      "allowed-tools": [],
      paths: [],
    },
    body: "body",
  });
  assert.doesNotMatch(md, /^arguments:/m);
  assert.doesNotMatch(md, /^allowed-tools:/m);
  assert.doesNotMatch(md, /^paths:/m);
});

test("buildSkillMarkdown: preserves spec key order", () => {
  const md = buildSkillMarkdown({
    properties: {
      name: "x",
      description: "ok",
      shell: "powershell",
      "argument-hint": "[file]",
      when_to_use: "When asked about Windows.",
    },
    body: "body",
  });
  // Order should be: name, description, when_to_use, argument-hint, ..., shell
  const wtuIdx = md.indexOf("when_to_use:");
  const ahIdx = md.indexOf("argument-hint:");
  const shellIdx = md.indexOf("shell:");
  assert.ok(wtuIdx > 0, "when_to_use present");
  assert.ok(wtuIdx < ahIdx, "when_to_use before argument-hint");
  assert.ok(ahIdx < shellIdx, "argument-hint before shell");
});
