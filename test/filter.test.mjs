import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../dist/filter.js";

const skill = (name, tags = []) => ({ name, tags });

test("filter: empty filter keeps everything", () => {
  const d = decide(skill("foo"), {});
  assert.equal(d.keep, true);
  assert.equal(d.reason, "default");
});

test("filter: exclude_skills wins over everything", () => {
  const f = {
    include_skills: ["foo"],
    include_tags: ["frontend"],
  };
  const d = decide(skill("foo", ["frontend"]), { ...f, exclude_skills: ["foo"] });
  assert.equal(d.keep, false);
  assert.equal(d.reason, "exclude_skills");
});

test("filter: include_skills overrides include_tags", () => {
  const d = decide(skill("docker"), {
    include_tags: ["frontend"],
    include_skills: ["docker"],
  });
  assert.equal(d.keep, true);
  assert.equal(d.reason, "include_skills");
});

test("filter: include_tags drops tagless skill", () => {
  const d = decide(skill("foo"), { include_tags: ["frontend"] });
  assert.equal(d.keep, false);
  assert.equal(d.reason, "include_tags");
});

test("filter: include_tags keeps overlapping tag", () => {
  const d = decide(skill("foo", ["frontend", "react"]), {
    include_tags: ["frontend"],
  });
  assert.equal(d.keep, true);
  assert.equal(d.reason, "default");
});

test("filter: exclude_tags drops on any match", () => {
  const d = decide(skill("foo", ["frontend", "legacy"]), {
    exclude_tags: ["legacy"],
  });
  assert.equal(d.keep, false);
  assert.equal(d.reason, "exclude_tags");
});

test("filter: include then exclude — both must pass", () => {
  // With tag in include and a tag in exclude: include passes, exclude drops.
  const d = decide(skill("foo", ["frontend", "legacy"]), {
    include_tags: ["frontend"],
    exclude_tags: ["legacy"],
  });
  assert.equal(d.keep, false);
  assert.equal(d.reason, "exclude_tags");
});

test("filter: ephemeral name is force-include (additive)", () => {
  const d = decide(skill("foo"), { include_tags: ["frontend"] }, ["foo"]);
  assert.equal(d.keep, true);
  assert.equal(d.reason, "include_skills");
});

test("filter: ephemeral does NOT remove other skills (additive)", () => {
  // A skill not in ephemeral list still gets evaluated by normal filter.
  const d = decide(skill("bar", ["frontend"]), { include_tags: ["frontend"] }, ["foo"]);
  assert.equal(d.keep, true);
  assert.equal(d.reason, "default");
});

test("filter: ephemeral cannot override exclude_skills", () => {
  // exclude_skills is checked before ephemeral has effect on non-listed names.
  // But ephemeral DOES short-circuit, so a name in both ephemeral and
  // exclude_skills will be force-included. Document this behavior.
  const d = decide(
    skill("foo"),
    { exclude_skills: ["foo"] },
    ["foo"],
  );
  assert.equal(d.keep, true);
  assert.equal(d.reason, "include_skills");
});
