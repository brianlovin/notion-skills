import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNotionId } from "../dist/parse-id.js";

const HEX = "12345678-90ab-cdef-1234-567890abcdef";

test("parseNotionId: dashed UUID", () => {
  assert.equal(parseNotionId(HEX), HEX);
});

test("parseNotionId: bare 32 hex", () => {
  assert.equal(parseNotionId("1234567890abcdef1234567890abcdef"), HEX);
});

test("parseNotionId: notion URL with title slug", () => {
  assert.equal(
    parseNotionId("https://www.notion.so/Brian/Skills-1234567890abcdef1234567890abcdef?v=abc"),
    HEX,
  );
});

test("parseNotionId: notion URL bare", () => {
  assert.equal(
    parseNotionId("https://www.notion.so/1234567890abcdef1234567890abcdef"),
    HEX,
  );
});

test("parseNotionId: trims whitespace", () => {
  assert.equal(parseNotionId(`  ${HEX}  `), HEX);
});

test("parseNotionId: case-insensitive uppercase", () => {
  assert.equal(parseNotionId("DEADBEEF1234567890ABCDEF12345678"), "deadbeef-1234-5678-90ab-cdef12345678");
});

test("parseNotionId: hex letters in slug don't bleed", () => {
  // "Title-DEADBEEF..." — the hex letters of "Title" would corrupt a naive
  // strip-then-match approach. Make sure we get the right ID.
  assert.equal(
    parseNotionId("https://www.notion.so/Title-DEADBEEF1234567890ABCDEF12345678?v=foo"),
    "deadbeef-1234-5678-90ab-cdef12345678",
  );
});

test("parseNotionId: returns null for non-id input", () => {
  assert.equal(parseNotionId("garbage"), null);
  assert.equal(parseNotionId(""), null);
  assert.equal(parseNotionId("   "), null);
});

test("parseNotionId: hex too short returns null", () => {
  assert.equal(parseNotionId("12345678"), null);
});
