import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExtension,
  isSafeRelativePath,
  parseFromChildPage,
  renderForChildPage,
} from "../dist/skill-files.js";

// classifyExtension —————————————————————————————————————————————————

test("markdown extensions are classified as markdown", () => {
  assert.deepEqual(classifyExtension("LANGUAGE.md"), { kind: "markdown" });
  assert.deepEqual(classifyExtension("notes.markdown"), { kind: "markdown" });
  assert.deepEqual(classifyExtension("docs/intro.mdx"), { kind: "markdown" });
});

test("known code extensions get language tags", () => {
  assert.deepEqual(classifyExtension("scripts/search.ts"), {
    kind: "code",
    lang: "typescript",
  });
  assert.deepEqual(classifyExtension("a.py"), { kind: "code", lang: "python" });
  assert.deepEqual(classifyExtension("script.sh"), { kind: "code", lang: "bash" });
  assert.deepEqual(classifyExtension("Cargo.toml"), { kind: "code", lang: "toml" });
});

test("unknown extensions are unsupported", () => {
  assert.equal(classifyExtension("logo.png").kind, "unsupported");
  assert.equal(classifyExtension("data.bin").kind, "unsupported");
  assert.equal(classifyExtension("README").kind, "unsupported"); // no extension
});

// renderForChildPage —————————————————————————————————————————————————

test("markdown files render as their content verbatim", () => {
  const body = renderForChildPage({
    path: "LANGUAGE.md",
    kind: "markdown",
    content: "# Heading\n\nSome prose.",
  });
  assert.equal(body, "# Heading\n\nSome prose.");
});

test("code files render as a single fenced block with language tag", () => {
  const body = renderForChildPage({
    path: "scripts/search.ts",
    kind: "code",
    lang: "typescript",
    content: "import { foo } from 'bar';\nconsole.log(foo);",
  });
  assert.equal(
    body,
    "```typescript\nimport { foo } from 'bar';\nconsole.log(foo);\n```",
  );
});

test("code rendering trims trailing newlines but preserves leading", () => {
  const body = renderForChildPage({
    path: "x.sh",
    kind: "code",
    lang: "bash",
    content: "#!/bin/bash\necho hi\n\n",
  });
  assert.equal(body, "```bash\n#!/bin/bash\necho hi\n```");
});

// parseFromChildPage —————————————————————————————————————————————————

test("parsing a markdown file body returns the content unchanged", () => {
  const file = parseFromChildPage("LANGUAGE.md", "# Heading\n\nText.");
  assert.equal(file.kind, "markdown");
  assert.equal(file.path, "LANGUAGE.md");
  assert.equal(file.content, "# Heading\n\nText.");
});

test("parsing a code file body strips the surrounding fenced block", () => {
  const file = parseFromChildPage(
    "scripts/search.ts",
    "```typescript\nconst x = 1;\nconsole.log(x);\n```",
  );
  assert.equal(file.kind, "code");
  assert.equal(file.lang, "typescript");
  assert.equal(file.content, "const x = 1;\nconsole.log(x);");
});

test("parsing a code file body tolerates surrounding whitespace and missing language tag", () => {
  const file = parseFromChildPage(
    "x.py",
    "\n\n```\nprint('hi')\n```\n\n",
  );
  assert.equal(file.kind, "code");
  assert.equal(file.content, "print('hi')");
});

test("parsing a code page with prose around the fence keeps the body verbatim", () => {
  // Defensive: if a user manually edited the child page in Notion to
  // add prose, we don't try to be clever — pass it through. The user
  // can fix it on the next round-trip.
  const body = "Inline prose.\n\n```typescript\nconst x = 1;\n```";
  const file = parseFromChildPage("scripts/x.ts", body);
  assert.equal(file.kind, "code");
  assert.equal(file.content, body);
});

// Round-trip ——————————————————————————————————————————————————————————

test("round-trip: markdown file → page body → SkillFile", () => {
  const original = {
    path: "DEEPENING.md",
    kind: "markdown",
    content: "Deep notes.\n\n- bullet\n- another",
  };
  const body = renderForChildPage(original);
  const parsed = parseFromChildPage(original.path, body);
  assert.deepEqual(parsed, original);
});

test("round-trip: code file → page body → SkillFile", () => {
  const original = {
    path: "scripts/run.ts",
    kind: "code",
    lang: "typescript",
    content: "export const run = () => 42;",
  };
  const body = renderForChildPage(original);
  const parsed = parseFromChildPage(original.path, body);
  assert.deepEqual(parsed, original);
});

// isSafeRelativePath —————————————————————————————————————————————————

test("safe paths are accepted", () => {
  assert.equal(isSafeRelativePath("LANGUAGE.md"), true);
  assert.equal(isSafeRelativePath("scripts/search.ts"), true);
  assert.equal(isSafeRelativePath("a/b/c.md"), true);
});

test("path traversal and absolute paths are rejected", () => {
  assert.equal(isSafeRelativePath(""), false);
  assert.equal(isSafeRelativePath("/etc/passwd"), false);
  assert.equal(isSafeRelativePath("../escape.md"), false);
  assert.equal(isSafeRelativePath("a/../b.md"), false);
  assert.equal(isSafeRelativePath("./foo.md"), false);
  assert.equal(isSafeRelativePath("a//b.md"), false);
});

test("SKILL.md at the root is reserved (parent body, not a sibling file)", () => {
  assert.equal(isSafeRelativePath("SKILL.md"), false);
  // But nested SKILL.md (in a subdir) is fine — that's a sub-skill,
  // not the root parent.
  assert.equal(isSafeRelativePath("subdir/SKILL.md"), true);
});
