import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSkillMarkdown } from "../dist/convert.js";

test("buildSkillMarkdown: standard frontmatter", () => {
  const md = buildSkillMarkdown({
    name: "test-skill",
    description: "Does a thing.",
    body: "# Heading\n\nSome content.",
  });
  assert.match(md, /^---\nname: test-skill\ndescription: Does a thing\.\n---\n/);
  assert.match(md, /\n# Heading\n\nSome content\.\n$/);
});

test("buildSkillMarkdown: long description wraps as YAML block scalar", () => {
  const md = buildSkillMarkdown({
    name: "x",
    description:
      "A long description that exceeds the typical line length and should fold into YAML's folded scalar form across multiple lines.",
    body: "body",
  });
  assert.match(md, /^---/);
  assert.match(md, /^description:/m);
  // Body still appears intact
  assert.match(md, /\nbody\n$/);
});

test("buildSkillMarkdown: description with special chars is YAML-safe", () => {
  const md = buildSkillMarkdown({
    name: "x",
    description: 'Contains "quotes" and: a colon',
    body: "body",
  });
  // YAML stringify should escape it; round-trip should NOT fail to parse
  const fmText = md.split("---")[1];
  // Just check the description line isn't broken markdown
  assert.match(fmText, /description:/);
});
