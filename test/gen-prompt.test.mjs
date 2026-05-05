import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGenPrompt } from "../dist/gen-prompt.js";

// buildGenPrompt is the wrapper that turns the user's `gen` argument
// into the full prompt handed to the coding agent. The tests pin the
// invariants the prompt template must keep so future edits to the
// template don't quietly break the gen flow.

test("buildGenPrompt: includes user input verbatim", () => {
  const out = buildGenPrompt("https://example.com/blog/post");
  assert.match(out, /https:\/\/example\.com\/blog\/post/);
});

test("buildGenPrompt: preserves multi-line input", () => {
  const out = buildGenPrompt("first line\nsecond line\nthird line");
  assert.ok(out.includes("first line\nsecond line\nthird line"));
});

test("buildGenPrompt: special characters survive the substitution", () => {
  const tricky = "build $1 ${VAR} `cmd` $(cmd) \\n {INPUT}";
  const out = buildGenPrompt(tricky);
  assert.ok(out.includes(tricky));
});

test("buildGenPrompt: instructs SKILL.md to land in the central store", () => {
  // The central store is the one place skills live on disk. The agent
  // writes there directly; migrate picks it up because there's no
  // manifest entry yet for that slug.
  const out = buildGenPrompt("foo");
  assert.match(out, /~\/\.notion-skills\/skills\/<slug>\/SKILL\.md/);
});

test("buildGenPrompt: instructs the agent to stop after writing the file", () => {
  // The agent's only job is to write a SKILL.md. After it stops
  // turning (in headless mode this means exiting the run), gen takes
  // over and runs migrate itself — that step is fully deterministic
  // and doesn't need to round-trip through the agent.
  const out = buildGenPrompt("foo");
  assert.match(out, /\b(stop turning|done)\b/i);
});

test("buildGenPrompt: forbids the agent from running shell commands", () => {
  // Regression: previous versions instructed the agent to run
  // `notion-skills migrate -y`, which triggered permission prompts and
  // path confusion. The agent must NOT run shell commands.
  const out = buildGenPrompt("foo");
  assert.match(out, /[Dd]o not run shell commands|do not run.*migrate/i);
});

test("buildGenPrompt: notionSkillsBin override threads through to the migrate-handoff message", () => {
  const out = buildGenPrompt("foo", { notionSkillsBin: "my-cli" });
  assert.match(out, /my-cli will pick the new skill up/);
});

test("buildGenPrompt: explains the URL/path/prompt branching", () => {
  // The agent has to dispatch on input shape — tests pin that the
  // template covers each case so users can pass any of the three.
  const out = buildGenPrompt("foo");
  assert.match(out, /URL/);
  assert.match(out, /File path/);
  assert.match(out, /Natural-language description/);
});

test("buildGenPrompt: emphasises the description field", () => {
  // Description is the make-or-break field for skill discoverability.
  // The template must call this out explicitly.
  const out = buildGenPrompt("foo");
  assert.match(out, /description.+(important|critical|trigger)/i);
});

test("buildGenPrompt: forbids clarifying questions (autonomous run)", () => {
  // gen is fire-and-forget. The agent must not block waiting for the
  // user once it's been spawned.
  const out = buildGenPrompt("foo");
  assert.match(out, /[Dd]on't ask clarifying/);
});

test("buildGenPrompt: each call substitutes only once (no template injection)", () => {
  // If a user's input contains "{INPUT}" we must not re-substitute.
  const out = buildGenPrompt("the literal {INPUT} marker");
  // The user's input should appear; the marker placeholder should not
  // remain after the single replace.
  assert.ok(out.includes("the literal {INPUT} marker"));
  // The first occurrence of "{INPUT}" comes from the user's text, not
  // an unsubstituted template slot.
  const firstMarker = out.indexOf("{INPUT}");
  assert.ok(firstMarker >= 0);
  // No second occurrence (the template only had one slot).
  const secondMarker = out.indexOf("{INPUT}", firstMarker + 1);
  assert.equal(secondMarker, -1);
});
