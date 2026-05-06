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

test("schema: Tags is a multi_select with no pre-populated options (selfHealing)", () => {
  // Tags drive discovery for the app-store layer. Options grow on
  // publish — we don't ship a default tag list because tags are
  // workspace-specific (engineering vs marketing vs personal etc).
  const def = SCHEMA.find((p) => p.notionName === "Tags");
  assert.ok(def, "Tags must be in SCHEMA");
  assert.equal(def.kind, "multi_select");
  assert.equal(def.frontmatterKey, "tags");
  assert.equal(def.selfHealing, true);
  assert.deepEqual(def.options, []);
});

test("notionPropsForSkill: tags trigger the Tags column", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    tags: ["engineering", "productivity"],
  });
  assert.deepEqual([...result], ["Tags"]);
});

test("notionPropsForSkill: empty tag array doesn't trigger Tags column", () => {
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    tags: [],
  });
  assert.deepEqual([...result], []);
});

test("schema: Installs is a metric-only number property", () => {
  // Installs is the per-skill install counter. It lives in Notion (so
  // teams can spot popular skills) but never round-trips into SKILL.md
  // frontmatter — it's store-managed metric data, not user content.
  const def = SCHEMA.find((p) => p.notionName === "Installs");
  assert.ok(def, "Installs must be in SCHEMA");
  assert.equal(def.kind, "number");
  assert.equal(def.metricOnly, true);
});

test("notionPropsForSkill: metric-only props (Installs) never trigger column creation from frontmatter", () => {
  // Even if a user somehow puts `installs: 42` in their SKILL.md,
  // notionPropsForSkill should not surface "Installs" — that property
  // is managed by the install machinery, not user content.
  const result = notionPropsForSkill({
    name: "foo",
    description: "ok",
    installs: 42,
  });
  assert.ok(!result.has("Installs"));
});

// buildViewConfiguration shapes the Notion default-view PATCH payload.
// Only properties present on the data source are emitted; the four
// "high-signal" columns (Name / Description / Tags / Installs) come
// first with visible: true; everything else is included with
// visible: false so users can flip them on per-view if they want.
// Name + Description are frozen (frozen_column_index: 2).

test("buildViewConfiguration: empty data source → empty properties", () => {
  const config = buildViewConfiguration({});
  assert.equal(config.type, "table");
  assert.deepEqual(config.properties, []);
  assert.equal(config.frozen_column_index, 2);
});

test("buildViewConfiguration: only Name + Description present (both visible-by-default)", () => {
  const config = buildViewConfiguration({
    Name: { id: "title-id" },
    Description: { id: "desc-id" },
  });
  assert.deepEqual(config.properties, [
    { property_id: "title-id", visible: true },
    { property_id: "desc-id", visible: true },
  ]);
  assert.equal(config.frozen_column_index, 2);
});

test("buildViewConfiguration: visible-by-default columns first, others hidden", () => {
  const config = buildViewConfiguration({
    Effort: { id: "effort-id" },
    Description: { id: "desc-id" },
    Name: { id: "title-id" },
    Model: { id: "model-id" },
    Tags: { id: "tags-id" },
    Installs: { id: "installs-id" },
  });
  // Visible-by-default come first in SCHEMA order: Name, Description, Tags, Installs
  const visibleIds = config.properties.filter((p) => p.visible).map((p) => p.property_id);
  assert.deepEqual(visibleIds, ["title-id", "desc-id", "tags-id", "installs-id"]);
  // Hidden ones still present (so the toggle exists in Notion's UI)
  const hiddenIds = config.properties.filter((p) => !p.visible).map((p) => p.property_id);
  assert.ok(hiddenIds.includes("model-id"));
  assert.ok(hiddenIds.includes("effort-id"));
});

test("buildViewConfiguration: skips properties with no id", () => {
  const config = buildViewConfiguration({
    Name: { id: "title-id" },
    Description: {}, // no id — skip
    Model: { id: "model-id" },
  });
  const ids = config.properties.map((p) => p.property_id);
  assert.deepEqual(ids, ["title-id", "model-id"]);
});

test("buildViewConfiguration: ignores unknown columns the user added in Notion", () => {
  const config = buildViewConfiguration({
    Name: { id: "title-id" },
    Description: { id: "desc-id" },
    "Some Custom Column": { id: "custom-id" }, // not in SCHEMA
  });
  const ids = config.properties.map((p) => p.property_id);
  assert.deepEqual(ids, ["title-id", "desc-id"]);
});
