import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRelativeTime, parseDurationToDate } from "../dist/time.js";

const NOW = new Date("2026-05-07T12:00:00.000Z");

test("formatRelativeTime: just now for sub-minute", () => {
  assert.equal(formatRelativeTime(new Date(NOW.getTime() - 30_000), NOW), "just now");
  assert.equal(formatRelativeTime(NOW, NOW), "just now");
});

test("formatRelativeTime: minutes", () => {
  assert.equal(
    formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW),
    "5m ago",
  );
});

test("formatRelativeTime: hours", () => {
  assert.equal(
    formatRelativeTime(new Date(NOW.getTime() - 3 * 60 * 60_000), NOW),
    "3h ago",
  );
});

test("formatRelativeTime: days", () => {
  assert.equal(
    formatRelativeTime(new Date(NOW.getTime() - 2 * 24 * 60 * 60_000), NOW),
    "2d ago",
  );
});

test("formatRelativeTime: weeks", () => {
  // 10 days = ~1.4 weeks → rounds to 1w
  assert.equal(
    formatRelativeTime(new Date(NOW.getTime() - 10 * 24 * 60 * 60_000), NOW),
    "1w ago",
  );
});

test("formatRelativeTime: months", () => {
  // ~60 days → 2mo
  assert.equal(
    formatRelativeTime(new Date(NOW.getTime() - 60 * 24 * 60 * 60_000), NOW),
    "2mo ago",
  );
});

test("formatRelativeTime: years", () => {
  // ~400 days → 1y
  assert.equal(
    formatRelativeTime(new Date(NOW.getTime() - 400 * 24 * 60 * 60_000), NOW),
    "1y ago",
  );
});

test("formatRelativeTime: future dates fall through to 'just now'", () => {
  // Skew protection: don't print "-3d ago" when client clock is wrong.
  const future = new Date(NOW.getTime() + 5 * 60_000);
  assert.equal(formatRelativeTime(future, NOW), "just now");
});

test("parseDurationToDate: bare digit defaults to days", () => {
  const d = parseDurationToDate("7", NOW);
  assert.ok(d);
  assert.equal(d.getTime(), NOW.getTime() - 7 * 24 * 60 * 60_000);
});

test("parseDurationToDate: hours, days, weeks, minutes", () => {
  assert.equal(
    parseDurationToDate("12h", NOW)?.getTime(),
    NOW.getTime() - 12 * 60 * 60_000,
  );
  assert.equal(
    parseDurationToDate("30d", NOW)?.getTime(),
    NOW.getTime() - 30 * 24 * 60 * 60_000,
  );
  assert.equal(
    parseDurationToDate("2w", NOW)?.getTime(),
    NOW.getTime() - 2 * 7 * 24 * 60 * 60_000,
  );
  assert.equal(
    parseDurationToDate("45m", NOW)?.getTime(),
    NOW.getTime() - 45 * 60_000,
  );
});

test("parseDurationToDate: case-insensitive + whitespace tolerant", () => {
  assert.equal(
    parseDurationToDate("  7D  ", NOW)?.getTime(),
    NOW.getTime() - 7 * 24 * 60 * 60_000,
  );
});

test("parseDurationToDate: rejects garbage", () => {
  assert.equal(parseDurationToDate("", NOW), null);
  assert.equal(parseDurationToDate("abc", NOW), null);
  assert.equal(parseDurationToDate("7y", NOW), null); // years not supported
  assert.equal(parseDurationToDate("-3d", NOW), null);
  assert.equal(parseDurationToDate("3d4h", NOW), null);
  assert.equal(parseDurationToDate("0", NOW), null);
  assert.equal(parseDurationToDate("0d", NOW), null);
  assert.equal(parseDurationToDate("0h", NOW), null);
});
