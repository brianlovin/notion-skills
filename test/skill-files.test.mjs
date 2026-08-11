import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPEC_CATEGORY_DIRS,
  childPageIdsFrom,
  classifyExtension,
  hashLocalSkillDir,
  isSafeRelativePath,
  isSpecCategoryName,
  maxChildPageEdited,
  notionPageUrl,
  parseFromChildPage,
  readLocalSkillFiles,
  renderForChildPage,
  specCategoryOf,
  specWrapperIds,
  upsertSkillFilePages,
  withPreservedChildPages,
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

// SPEC_CATEGORY_DIRS + specCategoryOf ─────────────────────────────────

test("SPEC_CATEGORY_DIRS exports the spec's three optional dirs", () => {
  assert.deepEqual([...SPEC_CATEGORY_DIRS], ["scripts", "references", "assets"]);
});

test("specCategoryOf: paths under spec dirs are classified", () => {
  assert.deepEqual(specCategoryOf("scripts/extract.py"), {
    category: "scripts",
    pathWithinCategory: "extract.py",
  });
  assert.deepEqual(specCategoryOf("references/REFERENCE.md"), {
    category: "references",
    pathWithinCategory: "REFERENCE.md",
  });
  assert.deepEqual(specCategoryOf("assets/templates/report.html"), {
    category: "assets",
    pathWithinCategory: "templates/report.html",
  });
});

test("specCategoryOf: root files and non-spec dirs return null", () => {
  assert.equal(specCategoryOf("LANGUAGE.md"), null);
  assert.equal(specCategoryOf("tools/foo.sh"), null);
  assert.equal(specCategoryOf("Scripts/foo.py"), null); // case-sensitive
});

test("specCategoryOf: bare category name (no path within) returns null", () => {
  // "scripts" alone is the wrapper page itself, not a file.
  assert.equal(specCategoryOf("scripts"), null);
  assert.equal(specCategoryOf("scripts/"), null);
});

test("isSpecCategoryName recognises the three lowercase names", () => {
  assert.equal(isSpecCategoryName("scripts"), true);
  assert.equal(isSpecCategoryName("references"), true);
  assert.equal(isSpecCategoryName("assets"), true);
  assert.equal(isSpecCategoryName("Scripts"), false); // strict
  assert.equal(isSpecCategoryName("docs"), false);
});

// upsertSkillFilePages — uses a fake client to verify the plan ────────

function fakeClient() {
  const pagesByParent = new Map(); // parentId → [{id, type, child_page: {title}}]
  const archived = new Set();
  let nextId = 1;
  return {
    pagesByParent,
    archived,
    async getBlockChildren(blockId) {
      return pagesByParent.get(blockId) ?? [];
    },
    async createChildPage(parentPageId, title) {
      const id = `page-${nextId++}`;
      const block = {
        id,
        type: "child_page",
        child_page: { title },
      };
      const arr = pagesByParent.get(parentPageId) ?? [];
      arr.push(block);
      pagesByParent.set(parentPageId, arr);
      return id;
    },
    async archivePage(pageId) {
      archived.add(pageId);
    },
  };
}

test("upsertSkillFilePages: scripts file lands inside scripts wrapper", async () => {
  const client = fakeClient();
  const writes = [];
  const setMd = async (id, md) => writes.push({ id, md });

  await upsertSkillFilePages(client, setMd, "parent", [
    { path: "scripts/extract.py", kind: "code", lang: "python", content: "print(1)" },
  ]);

  // A "scripts" wrapper was created on the parent.
  const parentChildren = client.pagesByParent.get("parent") ?? [];
  assert.equal(parentChildren.length, 1);
  assert.equal(parentChildren[0].child_page.title, "scripts");

  // The script lives INSIDE the wrapper, with title "extract.py".
  const wrapperId = parentChildren[0].id;
  const wrapperChildren = client.pagesByParent.get(wrapperId) ?? [];
  assert.equal(wrapperChildren.length, 1);
  assert.equal(wrapperChildren[0].child_page.title, "extract.py");
});

test("upsertSkillFilePages: root-level file stays flat at parent", async () => {
  const client = fakeClient();
  const setMd = async () => {};

  await upsertSkillFilePages(client, setMd, "parent", [
    { path: "LANGUAGE.md", kind: "markdown", content: "# Language" },
  ]);

  const parentChildren = client.pagesByParent.get("parent") ?? [];
  assert.equal(parentChildren.length, 1);
  assert.equal(parentChildren[0].child_page.title, "LANGUAGE.md");
});

test("upsertSkillFilePages: mixed files create wrappers + flat", async () => {
  const client = fakeClient();
  const setMd = async () => {};

  await upsertSkillFilePages(client, setMd, "parent", [
    { path: "scripts/extract.py", kind: "code", lang: "python", content: "x" },
    { path: "references/api.md", kind: "markdown", content: "# API" },
    { path: "LANGUAGE.md", kind: "markdown", content: "# Lang" },
  ]);

  const parentChildren = (client.pagesByParent.get("parent") ?? []).map(
    (b) => b.child_page.title,
  );
  // Two wrappers + one flat file.
  assert.deepEqual(parentChildren.sort(), [
    "LANGUAGE.md",
    "references",
    "scripts",
  ]);
});

test("upsertSkillFilePages: empty category wrapper gets archived", async () => {
  const client = fakeClient();
  const setMd = async () => {};

  // Pre-existing scripts wrapper with one stale child.
  const wrapperId = await client.createChildPage("parent", "scripts");
  await client.createChildPage(wrapperId, "old.py");

  // Now publish with NO scripts files — the wrapper should be archived
  // along with its child.
  await upsertSkillFilePages(client, setMd, "parent", [
    { path: "LANGUAGE.md", kind: "markdown", content: "x" },
  ]);

  // The wrapper itself + its child are both archived.
  assert.ok(client.archived.has(wrapperId), "scripts wrapper archived");
  // The child of the wrapper was also archived.
  const wrapperChildren = client.pagesByParent.get(wrapperId) ?? [];
  assert.ok(client.archived.has(wrapperChildren[0].id), "stale child archived");
});

test("upsertSkillFilePages: spec category names at root never archived as orphans", async () => {
  const client = fakeClient();
  const setMd = async () => {};

  // Pre-existing scripts wrapper with one valid child.
  const wrapperId = await client.createChildPage("parent", "scripts");
  await client.createChildPage(wrapperId, "extract.py");

  // Re-publish with the same scripts file.
  await upsertSkillFilePages(client, setMd, "parent", [
    { path: "scripts/extract.py", kind: "code", lang: "python", content: "x" },
  ]);

  // The wrapper sub-page should NOT be archived (it's still in use).
  assert.ok(!client.archived.has(wrapperId), "wrapper preserved");
});

// child page preservation across a body replace ──────────────────────

test("childPageIdsFrom: picks out child pages, ignores content blocks", () => {
  assert.deepEqual(
    childPageIdsFrom([
      { id: "b1", type: "paragraph" },
      { id: "b2", type: "child_page" },
      { id: "b3", type: "heading_2" },
      { id: "b4", type: "child_page" },
    ]),
    ["b2", "b4"],
  );
});

test("childPageIdsFrom: no child pages yields empty list", () => {
  assert.deepEqual(
    childPageIdsFrom([{ id: "b1", type: "paragraph" }]),
    [],
  );
});

test("notionPageUrl: strips dashes from a page id", () => {
  assert.equal(
    notionPageUrl("3b9c711c-0ceb-81dd-b3bb-dd9c8974ea42"),
    "https://www.notion.so/3b9c711c0ceb81ddb3bbdd9c8974ea42",
  );
  // Already-bare ids pass through unchanged.
  assert.equal(
    notionPageUrl("3b9c711c0ceb81ddb3bbdd9c8974ea42"),
    "https://www.notion.so/3b9c711c0ceb81ddb3bbdd9c8974ea42",
  );
});

test("withPreservedChildPages: no ids leaves markdown untouched", () => {
  assert.equal(withPreservedChildPages("# Body\n", []), "# Body\n");
});

// Regression: a body push used to replace the parent page wholesale,
// deleting the child pages that hold the skill's sibling files. Every
// re-publish then recreated all of them from scratch.
test("withPreservedChildPages: appends a self-closing tag per child page", () => {
  const out = withPreservedChildPages("# Body\n\nText.", ["aaa-bbb", "ccc-ddd"]);
  assert.equal(
    out,
    "# Body\n\nText.\n\n" +
      '<page url="https://www.notion.so/aaabbb" />\n' +
      '<page url="https://www.notion.so/cccddd" />\n',
  );
});

// The API rejects `<page url="...">` without the trailing slash with the
// same "would delete N child page(s)" error as omitting the tag, so the
// self-closing form is load-bearing, not cosmetic.
test("withPreservedChildPages: tags are self-closing", () => {
  const out = withPreservedChildPages("# Body", ["aaa"]);
  assert.match(out, /<page url="[^"]+" \/>/);
  assert.doesNotMatch(out, /<page url="[^"]+">/);
});

test("withPreservedChildPages: body keeps its content, tags go last", () => {
  const out = withPreservedChildPages("# Body\n\nKeep me.\n\n\n", ["aaa"]);
  assert.ok(out.startsWith("# Body\n\nKeep me."), "body preserved");
  assert.ok(out.trimEnd().endsWith('" />'), "tags appended at the end");
  // Trailing whitespace collapses to exactly one blank line before tags.
  assert.ok(!out.includes("\n\n\n"), "no runaway blank lines");
});

// multi-file drift signals ────────────────────────────────────────────

test("maxChildPageEdited: newest child page timestamp wins", () => {
  assert.equal(
    maxChildPageEdited([
      { id: "a", type: "child_page", last_edited_time: "2026-08-11T17:08:00.000Z" },
      { id: "b", type: "child_page", last_edited_time: "2026-08-11T17:30:00.000Z" },
      { id: "c", type: "child_page", last_edited_time: "2026-08-11T17:12:00.000Z" },
    ]),
    "2026-08-11T17:30:00.000Z",
  );
});

// The parent's own body blocks move independently of its child pages,
// so they must not contribute to the file-edit signal.
test("maxChildPageEdited: content blocks are ignored", () => {
  assert.equal(
    maxChildPageEdited([
      { id: "a", type: "paragraph", last_edited_time: "2099-01-01T00:00:00.000Z" },
      { id: "b", type: "child_page", last_edited_time: "2026-08-11T17:08:00.000Z" },
    ]),
    "2026-08-11T17:08:00.000Z",
  );
});

test("maxChildPageEdited: no child pages yields empty string", () => {
  assert.equal(maxChildPageEdited([{ id: "a", type: "paragraph" }]), "");
  assert.equal(maxChildPageEdited([]), "");
});

test("maxChildPageEdited: tolerates a child page with no timestamp", () => {
  assert.equal(
    maxChildPageEdited([
      { id: "a", type: "child_page" },
      { id: "b", type: "child_page", last_edited_time: "2026-08-11T17:08:00.000Z" },
    ]),
    "2026-08-11T17:08:00.000Z",
  );
});

// Files under scripts/ references/ assets/ are grandchildren: editing
// one bumps its own block, never the wrapper's. Miss the wrapper and
// those edits go undetected.
test("specWrapperIds: finds spec category wrappers only", () => {
  assert.deepEqual(
    specWrapperIds([
      { id: "w1", type: "child_page", child_page: { title: "references" } },
      { id: "f1", type: "child_page", child_page: { title: "LANGUAGE.md" } },
      { id: "w2", type: "child_page", child_page: { title: "scripts" } },
      { id: "w3", type: "child_page", child_page: { title: "assets" } },
      { id: "p1", type: "paragraph" },
    ]),
    ["w1", "w2", "w3"],
  );
});

test("specWrapperIds: non-spec dirs are not wrappers", () => {
  // `lib/` is not a spec dir, so its files are flat children titled
  // "lib/foo.mjs" — already covered by the top-level scan.
  assert.deepEqual(
    specWrapperIds([
      { id: "a", type: "child_page", child_page: { title: "lib/util.mjs" } },
      { id: "b", type: "child_page", child_page: { title: "Scripts" } },
    ]),
    [],
  );
});

test("specWrapperIds: titles are trimmed before matching", () => {
  assert.deepEqual(
    specWrapperIds([
      { id: "w", type: "child_page", child_page: { title: " scripts " } },
    ]),
    ["w"],
  );
});
