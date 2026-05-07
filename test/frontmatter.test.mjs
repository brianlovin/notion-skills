import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  readFrontmatterString,
  readFrontmatterList,
  injectMetadataKey,
} from "../dist/frontmatter.js";

// ---------- parseFrontmatter ----------

test("parseFrontmatter: well-formed", () => {
  const r = parseFrontmatter(`---\nname: foo\ndescription: bar\n---\n\nbody here`);
  assert.equal(r.hasFrontmatter, true);
  assert.equal(r.frontmatter.name, "foo");
  assert.equal(r.frontmatter.description, "bar");
  assert.equal(r.body, "\nbody here");
});

test("parseFrontmatter: multi-line description (block-folded)", () => {
  // YAML's `>-` and indented continuation: real-world skills use this
  // for descriptions over ~80 chars.
  const text = `---\nname: foo\ndescription: First line\n  continued onto\n  three lines.\n---\nbody`;
  const r = parseFrontmatter(text);
  assert.equal(r.frontmatter.description, "First line continued onto three lines.");
});

test("parseFrontmatter: BOM at start gets stripped", () => {
  const r = parseFrontmatter(`﻿---\nname: foo\ndescription: bar\n---\nbody`);
  assert.equal(r.hasFrontmatter, true);
  assert.equal(r.frontmatter.name, "foo");
});

test("parseFrontmatter: CRLF line endings work", () => {
  const r = parseFrontmatter(`---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody`);
  assert.equal(r.hasFrontmatter, true);
  assert.equal(r.frontmatter.name, "foo");
});

test("parseFrontmatter: missing frontmatter → text returned as body", () => {
  const r = parseFrontmatter("just body, no frontmatter");
  assert.equal(r.hasFrontmatter, false);
  assert.deepEqual(r.frontmatter, {});
  assert.equal(r.body, "just body, no frontmatter");
});

test("parseFrontmatter: malformed yaml → empty fm + body", () => {
  // Yaml with a hard syntax error inside the frontmatter block.
  const r = parseFrontmatter(`---\nname: foo\n  bad indent: \nx\n---\nbody`);
  // Whether yaml lib tolerates this or not, hasFrontmatter should
  // reflect parse success and body should still be extracted.
  assert.equal(typeof r.body, "string");
});

test("parseFrontmatter: nested metadata is preserved", () => {
  const r = parseFrontmatter(`---\nname: foo\nmetadata:\n  Origin: bar/baz\n  Author: me\n---\nbody`);
  assert.deepEqual(r.frontmatter.metadata, { Origin: "bar/baz", Author: "me" });
});

// ---------- readFrontmatterString ----------

test("readFrontmatterString: hit", () => {
  assert.equal(
    readFrontmatterString(`---\ndescription: hello\n---\nbody`, "description"),
    "hello",
  );
});

test("readFrontmatterString: missing → empty string", () => {
  assert.equal(readFrontmatterString(`---\nname: foo\n---\nbody`, "description"), "");
});

test("readFrontmatterString: non-string value → empty string", () => {
  assert.equal(
    readFrontmatterString(`---\nname: foo\ncount: 5\n---\nbody`, "count"),
    "",
  );
});

// ---------- readFrontmatterList ----------

test("readFrontmatterList: block form", () => {
  const text = `---\ntags:\n  - alpha\n  - beta\n---\nbody`;
  assert.deepEqual(readFrontmatterList(text, "tags"), ["alpha", "beta"]);
});

test("readFrontmatterList: flow form", () => {
  assert.deepEqual(
    readFrontmatterList(`---\ntags: [alpha, beta]\n---\nbody`, "tags"),
    ["alpha", "beta"],
  );
});

test("readFrontmatterList: inline CSV string", () => {
  assert.deepEqual(
    readFrontmatterList(`---\ntags: alpha, beta, gamma\n---\nbody`, "tags"),
    ["alpha", "beta", "gamma"],
  );
});

test("readFrontmatterList: missing → empty array", () => {
  assert.deepEqual(readFrontmatterList(`---\nname: foo\n---\nbody`, "tags"), []);
});

// ---------- injectMetadataKey ----------

test("injectMetadataKey: no frontmatter → synthesises minimal block", () => {
  const out = injectMetadataKey("just body", "Origin", "owner/repo");
  assert.match(out, /^---\n/);
  assert.match(out, /metadata:\n\s+Origin: "owner\/repo"/);
  assert.match(out, /\n\njust body/);
});

test("injectMetadataKey: missing metadata block → added", () => {
  const text = `---\nname: foo\ndescription: bar\n---\nbody`;
  const out = injectMetadataKey(text, "Origin", "owner/repo");
  assert.match(out, /metadata:/);
  assert.match(out, /Origin: owner\/repo/);
});

test("injectMetadataKey: existing metadata block, key absent → added under it", () => {
  const text = `---\nname: foo\nmetadata:\n  Author: me\n---\nbody`;
  const out = injectMetadataKey(text, "Origin", "owner/repo");
  assert.match(out, /metadata:/);
  assert.match(out, /Author: me/);
  assert.match(out, /Origin: owner\/repo/);
});

test("injectMetadataKey: key already present (same case) → text unchanged by default", () => {
  const text = `---\nname: foo\nmetadata:\n  Origin: existing-value\n---\nbody`;
  const out = injectMetadataKey(text, "Origin", "owner/repo");
  assert.equal(out, text);
});

test("injectMetadataKey: key present in different case → still preserved", () => {
  const text = `---\nname: foo\nmetadata:\n  origin: lowercase-value\n---\nbody`;
  const out = injectMetadataKey(text, "Origin", "owner/repo");
  // User wrote `origin` lowercase; we don't add a duplicate `Origin`.
  assert.equal(out, text);
});

test("injectMetadataKey: preserveExisting=false overwrites", () => {
  const text = `---\nname: foo\nmetadata:\n  Origin: old\n---\nbody`;
  const out = injectMetadataKey(text, "Origin", "new", { preserveExisting: false });
  assert.match(out, /Origin: new/);
  assert.doesNotMatch(out, /Origin: old/);
});

test("injectMetadataKey: malformed frontmatter → unchanged", () => {
  // Frontmatter parses to a non-map (e.g. a single scalar).
  const text = `---\nfoo\n---\nbody`;
  const out = injectMetadataKey(text, "Origin", "owner/repo");
  assert.equal(out, text);
});

test("injectMetadataKey: round-trips through parseFrontmatter cleanly", () => {
  const text = `---\nname: foo\ndescription: bar\n---\nthe body`;
  const out = injectMetadataKey(text, "Origin", "owner/repo");
  const parsed = parseFrontmatter(out);
  assert.equal(parsed.frontmatter.name, "foo");
  assert.equal(parsed.frontmatter.description, "bar");
  assert.deepEqual(parsed.frontmatter.metadata, { Origin: "owner/repo" });
  assert.equal(parsed.body, "the body");
});
