import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSyncAction } from "../dist/sync-decision.js";

// decideSyncAction is the bidirectional-sync decision oracle. Given drift
// flags + timestamps, it returns one of:
//   skip / push / pull / conflict-push / conflict-pull
// Last-edit-wins on conflict; ties default to remote (Notion is canonical).

test("neither side changed → skip", () => {
  const action = decideSyncAction({ localChanged: false, remoteChanged: false });
  assert.equal(action, "skip");
});

test("local-only change → push", () => {
  const action = decideSyncAction({ localChanged: true, remoteChanged: false });
  assert.equal(action, "push");
});

test("remote-only change → pull", () => {
  const action = decideSyncAction({ localChanged: false, remoteChanged: true });
  assert.equal(action, "pull");
});

test("both changed, local newer → conflict-push", () => {
  const action = decideSyncAction({
    localChanged: true,
    remoteChanged: true,
    localMtime: new Date("2026-05-05T12:00:01Z"),
    remoteEdited: new Date("2026-05-05T12:00:00Z"),
  });
  assert.equal(action, "conflict-push");
});

test("both changed, remote newer → conflict-pull", () => {
  const action = decideSyncAction({
    localChanged: true,
    remoteChanged: true,
    localMtime: new Date("2026-05-05T12:00:00Z"),
    remoteEdited: new Date("2026-05-05T12:00:01Z"),
  });
  assert.equal(action, "conflict-pull");
});

test("both changed, ties default to remote (Notion is canonical)", () => {
  // Defaulting to local would risk overwriting Notion content based on a
  // file mtime that may have been touched by a tool, not a real edit.
  const ts = new Date("2026-05-05T12:00:00Z");
  const action = decideSyncAction({
    localChanged: true,
    remoteChanged: true,
    localMtime: ts,
    remoteEdited: ts,
  });
  assert.equal(action, "conflict-pull");
});

test("both changed but timestamps missing → conflict-pull", () => {
  // Defensive default: if we can't compare, prefer Notion (the user always
  // has Notion's history to recover from).
  const action = decideSyncAction({ localChanged: true, remoteChanged: true });
  assert.equal(action, "conflict-pull");
});

test("local-only change ignores timestamp arguments", () => {
  // Sanity: timestamps are only consulted when both sides changed.
  const action = decideSyncAction({
    localChanged: true,
    remoteChanged: false,
    localMtime: new Date("1970-01-01"),
    remoteEdited: new Date("2099-01-01"),
  });
  assert.equal(action, "push");
});

test("remote-only change ignores timestamp arguments", () => {
  const action = decideSyncAction({
    localChanged: false,
    remoteChanged: true,
    localMtime: new Date("2099-01-01"),
    remoteEdited: new Date("1970-01-01"),
  });
  assert.equal(action, "pull");
});
