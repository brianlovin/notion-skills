import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyExtension,
  hashLocalSkillDir,
  isSafeRelativePath,
  parseFromChildPage,
  readLocalSkillFiles,
  renderForChildPage,
} from "../dist/skill-files.js";
import { hashSkillContent } from "../dist/page-hash.js";

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

// readLocalSkillFiles + hashLocalSkillDir — disk-walking helpers.

async function makeSkillDir(layout) {
  const dir = await mkdtemp(join(tmpdir(), "notion-skills-test-"));
  for (const [path, content] of Object.entries(layout)) {
    const full = join(dir, path);
    await mkdir(join(full, "..").endsWith("/.") ? dir : join(full, ".."), {
      recursive: true,
    });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

test("readLocalSkillFiles: SKILL.md is excluded; siblings are surfaced", async () => {
  const dir = await makeSkillDir({
    "SKILL.md": "---\nname: x\ndescription: y\n---\n\nbody",
    "LANGUAGE.md": "lang content",
    "scripts/run.ts": "console.log('hi');",
  });
  try {
    const files = await readLocalSkillFiles(dir);
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["LANGUAGE.md", "scripts/run.ts"]);
    const lang = files.find((f) => f.path === "LANGUAGE.md");
    assert.equal(lang.kind, "markdown");
    assert.equal(lang.content, "lang content");
    const script = files.find((f) => f.path === "scripts/run.ts");
    assert.equal(script.kind, "code");
    assert.equal(script.lang, "typescript");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLocalSkillFiles: dotfiles are skipped", async () => {
  const dir = await makeSkillDir({
    "SKILL.md": "x",
    ".DS_Store": "garbage",
    ".gitignore": "*.log",
    "LANGUAGE.md": "real",
  });
  try {
    const files = await readLocalSkillFiles(dir);
    assert.deepEqual(files.map((f) => f.path), ["LANGUAGE.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hashLocalSkillDir: agrees with hashSkillContent on the same content", async () => {
  const skillMd = "---\nname: x\ndescription: y\n---\n\nbody text";
  const langContent = "lang content";
  const dir = await makeSkillDir({
    "SKILL.md": skillMd,
    "LANGUAGE.md": langContent,
  });
  try {
    const fromDir = await hashLocalSkillDir(dir);
    const expected = hashSkillContent(skillMd, [
      { path: "LANGUAGE.md", kind: "markdown", content: langContent },
    ]);
    assert.equal(fromDir, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hashLocalSkillDir: editing a sibling changes the hash", async () => {
  const dir = await makeSkillDir({
    "SKILL.md": "x",
    "LANGUAGE.md": "v1",
  });
  try {
    const before = await hashLocalSkillDir(dir);
    await writeFile(join(dir, "LANGUAGE.md"), "v2", "utf8");
    const after = await hashLocalSkillDir(dir);
    assert.notEqual(before, after);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hashLocalSkillDir: adding a new sibling file changes the hash", async () => {
  const dir = await makeSkillDir({
    "SKILL.md": "x",
  });
  try {
    const before = await hashLocalSkillDir(dir);
    await writeFile(join(dir, "NEW.md"), "added", "utf8");
    const after = await hashLocalSkillDir(dir);
    assert.notEqual(before, after);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hashLocalSkillDir: removing a sibling changes the hash", async () => {
  const dir = await makeSkillDir({
    "SKILL.md": "x",
    "LANGUAGE.md": "y",
  });
  try {
    const before = await hashLocalSkillDir(dir);
    await rm(join(dir, "LANGUAGE.md"));
    const after = await hashLocalSkillDir(dir);
    assert.notEqual(before, after);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
