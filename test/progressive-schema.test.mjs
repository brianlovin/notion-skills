import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildViewConfiguration,
  notionPropsForSkill,
  SCHEMA,
} from "../dist/schema.js";

// notionPropsForSkill drives migrate's progressive schema-add step.
// Given a single skill's frontmatter values, it returns the Notion
// column names that must exist before that skill can be uploaded.

test("notionPropsForSkill: minimal skill needs no extra columns", () => {
  // Name + Description are scaffolded at DB-create time, never returned.
  const result = notionPropsForSkill({
    name: "foo",
    description: "Does foo.",
  });
  assert.deepEqual([...result], []);
});

test("notionPropsForSkill: model triggers Model column", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    model: "claude-opus-4-7",
  });
  assert.deepEqual([...result], ["Model"]);
});

test("notionPropsForSkill: agent triggers Agent column", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    agent: "Explore",
  });
  assert.deepEqual([...result], ["Agent"]);
});

test("notionPropsForSkill: list_text fields with values trigger their column", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    "allowed-tools": ["Read", "Edit"],
  });
  assert.deepEqual([...result], ["Allowed Tools"]);
});

test("notionPropsForSkill: empty arrays don't trigger columns", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    "allowed-tools": [],
    arguments: [],
    paths: [],
  });
  assert.deepEqual([...result], []);
});

test("notionPropsForSkill: spec-default values don't trigger columns", () => {
  // disable-model-invocation: false IS the spec default; no column needed.
  // shell: bash IS the spec default; no column needed.
  // user-invocable: true IS the spec default; no column needed.
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    "disable-model-invocation": "false",
    "user-invocable": "true",
    shell: "bash",
  });
  assert.deepEqual([...result], []);
});

test("notionPropsForSkill: non-default boolean values DO trigger columns", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    "disable-model-invocation": "true",
    "user-invocable": "false",
  });
  assert.deepEqual(
    [...result].sort(),
    ["Disable Model Invocation", "User Invocable"].sort(),
  );
});

test("notionPropsForSkill: 'default' select sentinel doesn't trigger columns", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    model: "default",
    agent: "default",
  });
  assert.deepEqual([...result], []);
});

test("notionPropsForSkill: undefined / null / empty string values are ignored", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    when_to_use: "",
    model: undefined,
    agent: null,
  });
  assert.deepEqual([...result], []);
});

test("notionPropsForSkill: multiple non-default fields", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    when_to_use: "When the user asks for foo.",
    model: "claude-opus-4-7",
    effort: "high",
    arguments: ["issue"],
  });
  assert.deepEqual(
    [...result].sort(),
    ["Arguments", "Effort", "Model", "When To Use"].sort(),
  );
});

test("notionPropsForSkill: unknown frontmatter keys are ignored", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    custom_field_we_dont_know_about: "x",
  });
  assert.deepEqual([...result], []);
});

// Sanity check that the schema no longer ships hallucinated select options
// (regression for v0.4 — Model and Agent should self-heal from real values
// only, not be pre-populated with invented model IDs / subagent names).

test("schema: Model has no pre-populated values beyond the default sentinel", () => {
  const def = SCHEMA.find((p) => p.notionName === "Model");
  assert.equal(def.options.length, 1);
  assert.equal(def.options[0].name, "default");
});

test("schema: Agent has no pre-populated subagent names", () => {
  const def = SCHEMA.find((p) => p.notionName === "Agent");
  assert.equal(def.options.length, 1);
  assert.equal(def.options[0].name, "default");
});

// buildViewConfiguration shapes the Notion default-view PATCH payload.
// Only properties that exist on the data source are emitted (skipping any
// progressive columns we haven't added yet); all extant ones appear in
// SCHEMA order with the title column frozen.

test("buildViewConfiguration: empty data source → empty properties", () => {
  const config = buildViewConfiguration({});
  assert.equal(config.type, "table");
  assert.deepEqual(config.properties, []);
  assert.equal(config.frozen_column_index, 1);
});

test("buildViewConfiguration: only Name + Description present", () => {
  const config = buildViewConfiguration({
    Name: { id: "title-id" },
    Description: { id: "desc-id" },
  });
  assert.deepEqual(config.properties, [
    { property_id: "title-id", visible: true },
    { property_id: "desc-id", visible: true },
  ]);
});

test("buildViewConfiguration: emits properties in SCHEMA order regardless of input order", () => {
  const config = buildViewConfiguration({
    Effort: { id: "effort-id" },
    Description: { id: "desc-id" },
    Name: { id: "title-id" },
    Model: { id: "model-id" },
  });
  // SCHEMA order: Name, Description, ..., Model, Effort, ...
  const ids = config.properties.map((p) => p.property_id);
  assert.equal(ids[0], "title-id");
  assert.equal(ids[1], "desc-id");
  // Model comes before Effort in SCHEMA
  const modelIdx = ids.indexOf("model-id");
  const effortIdx = ids.indexOf("effort-id");
  assert.ok(modelIdx < effortIdx, "Model should sort before Effort");
});

test("buildViewConfiguration: skips properties with no id", () => {
  const config = buildViewConfiguration({
    Name: { id: "title-id" },
    Description: {}, // no id — skip
    Model: { id: "model-id" },
  });
  assert.deepEqual(
    config.properties.map((p) => p.property_id),
    ["title-id", "model-id"],
  );
});

test("buildViewConfiguration: ignores unknown columns the user added in Notion", () => {
  const config = buildViewConfiguration({
    Name: { id: "title-id" },
    Description: { id: "desc-id" },
    "Some Custom Column": { id: "custom-id" }, // not in SCHEMA
  });
  assert.deepEqual(
    config.properties.map((p) => p.property_id),
    ["title-id", "desc-id"],
  );
});
