import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { KNOWN_TARGETS, findTargetByKey } from "../dist/known-targets.js";

const HOME = homedir();

test("registry contains the v0.2 launch targets", () => {
  const keys = KNOWN_TARGETS.map((t) => t.key).sort();
  assert.deepEqual(keys.sort(), ["claude", "codex", "cursor", "gemini", "opencode"]);
});

test("every target has a non-empty label and dir", () => {
  for (const t of KNOWN_TARGETS) {
    assert.ok(t.label.length > 0, `label missing for ${t.key}`);
    assert.ok(t.dir.length > 0, `dir missing for ${t.key}`);
    assert.equal(t.kind, "skill_dir", `${t.key} should be skill_dir`);
  }
});

test("all target dirs are absolute paths under HOME or XDG", () => {
  for (const t of KNOWN_TARGETS) {
    assert.ok(t.dir.startsWith("/"), `${t.key} dir should be absolute`);
  }
});

test("claude path", () => {
  assert.equal(findTargetByKey("claude")?.dir, `${HOME}/.claude/skills`);
});

test("codex path", () => {
  assert.equal(findTargetByKey("codex")?.dir, `${HOME}/.codex/skills`);
});

test("opencode path follows XDG", () => {
  const expected = (process.env.XDG_CONFIG_HOME || `${HOME}/.config`) + "/opencode/skills";
  assert.equal(findTargetByKey("opencode")?.dir, expected);
});

test("cursor path", () => {
  assert.equal(findTargetByKey("cursor")?.dir, `${HOME}/.cursor/skills`);
});

test("gemini path", () => {
  assert.equal(findTargetByKey("gemini")?.dir, `${HOME}/.gemini/skills`);
});

test("findTargetByKey: unknown returns undefined", () => {
  assert.equal(findTargetByKey("does-not-exist"), undefined);
});

test("each target has a docs URL", () => {
  for (const t of KNOWN_TARGETS) {
    assert.ok(t.docs, `${t.key} missing docs link`);
    assert.match(t.docs, /^https?:\/\//);
  }
});
