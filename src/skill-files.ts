/**
 * Multi-file skill support: each non-SKILL.md file in a skill dir is
 * round-tripped through Notion as a child page on the skill's row.
 *
 *   - Page title = the file's relative path from the skill dir
 *     (e.g. `LANGUAGE.md`, `scripts/search.ts`).
 *   - Page body shape depends on the file kind:
 *       · "markdown" → body is the file content verbatim
 *       · "code"     → body is a single fenced code block, language
 *                      tag derived from the extension. No prose,
 *                      so the agent reads the file as pure code.
 *       · "unsupported" → publish skips with a warning. v2 will
 *                      handle binary files via Notion file uploads.
 */

export type SkillFileKind = "markdown" | "code" | "unsupported";

/**
 * Agent Skills spec category directories. Files placed in these
 * conventional dirs round-trip through Notion as child pages of a
 * named wrapper sub-page (per the spec's progressive-disclosure
 * model: scripts run by the agent, references the agent loads on
 * demand, assets the agent uses as templates).
 *
 * https://agentskills.io/specification#optional-directories
 */
export const SPEC_CATEGORY_DIRS = ["scripts", "references", "assets"] as const;
export type SpecCategoryDir = (typeof SPEC_CATEGORY_DIRS)[number];

/**
 * Match a relative path against the spec dirs. Returns the category
 * name + the path within it, or null if the path doesn't fall under
 * a spec dir. Strict lowercase match — a path under "Scripts/" or
 * "SCRIPTS/" stays as a flat root-level file.
 */
export function specCategoryOf(
  path: string,
): { category: SpecCategoryDir; pathWithinCategory: string } | null {
  for (const cat of SPEC_CATEGORY_DIRS) {
    const prefix = cat + "/";
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      if (rest.length === 0) continue;
      return { category: cat, pathWithinCategory: rest };
    }
  }
  return null;
}

export function isSpecCategoryName(name: string): name is SpecCategoryDir {
  return (SPEC_CATEGORY_DIRS as readonly string[]).includes(name);
}

export interface SkillFile {
  /** Relative path from the skill directory (POSIX-style). */
  path: string;
  kind: SkillFileKind;
  /** Code-fence language tag for "code" files (e.g. "typescript"). */
  lang?: string;
  /**
   * The raw file content. For markdown files this is the .md body;
   * for code files this is the source code (NOT the wrapped fenced
   * block — wrapping happens in renderForChildPage).
   */
  content: string;
}

/**
 * Extension → fenced-block language tag. Keep this list narrow and
 * deterministic; everything not on it is "unsupported" until we ship
 * Notion file uploads. Aliases follow the highlight.js convention
 * since that's what Notion's code-block rendering expects.
 */
const CODE_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  jsonc: "json",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  lua: "lua",
  r: "r",
  jl: "julia",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  scala: "scala",
  zig: "zig",
};

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

export function classifyExtension(path: string): {
  kind: SkillFileKind;
  lang?: string;
} {
  const ext = extension(path);
  if (!ext) return { kind: "unsupported" };
  if (MARKDOWN_EXTENSIONS.has(ext)) return { kind: "markdown" };
  const lang = CODE_LANGUAGES[ext];
  if (lang) return { kind: "code", lang };
  return { kind: "unsupported" };
}

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return "";
  return path.slice(dot + 1).toLowerCase();
}

/**
 * Render a SkillFile's content as the body markdown for its child
 * page in Notion. Code files become a single fenced block; markdown
 * files pass through verbatim.
 */
export function renderForChildPage(file: SkillFile): string {
  if (file.kind === "code") {
    const lang = file.lang ?? "";
    return "```" + lang + "\n" + file.content.replace(/\n+$/, "") + "\n```";
  }
  return file.content;
}

/**
 * Parse a child page's rendered body back into a SkillFile.
 *
 *   - Title carries the relative path (used as `path`).
 *   - Body is interpreted based on the path's extension. For code
 *     files we strip a single surrounding fenced block if present;
 *     a body without a fence is treated as raw code (defensive).
 */
export function parseFromChildPage(
  pathFromTitle: string,
  body: string,
): SkillFile {
  const { kind, lang } = classifyExtension(pathFromTitle);
  if (kind === "code") {
    return {
      path: pathFromTitle,
      kind,
      lang,
      content: stripFencedBlock(body, lang),
    };
  }
  if (kind === "markdown") {
    return {
      path: pathFromTitle,
      kind,
      content: body,
    };
  }
  return {
    path: pathFromTitle,
    kind: "unsupported",
    content: body,
  };
}

/**
 * If the body is a single fenced code block (with optional surrounding
 * blank lines), return its inner content. Otherwise return the body
 * unchanged. We're permissive: we accept fences with or without a
 * language tag, and tolerate trailing whitespace.
 */
function stripFencedBlock(body: string, _lang?: string): string {
  const trimmed = body.replace(/^\s+|\s+$/g, "");
  const fence = /^```[a-zA-Z0-9_+\-]*\n([\s\S]*?)\n```$/;
  const m = trimmed.match(fence);
  if (m && m[1] !== undefined) return m[1];
  return body;
}

/**
 * Reject paths that escape the skill directory or use absolute paths.
 * Defensive: titles come from Notion and we don't want a malicious or
 * fat-fingered title (`../../etc/passwd`) writing outside the central
 * store.
 */
/**
 * Drift signal for the local on-disk state of a skill. Combines the
 * SKILL.md and every sibling file's content via hashSkillContent, so
 * a local edit anywhere in the skill dir bumps the hash.
 *
 * Backward-compatible with hashContent(SKILL.md) for skills with no
 * sibling files — when files=[], hashSkillContent collapses to the
 * single-file hash.
 */
export async function hashLocalSkillDir(
  skillDir: string,
): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { hashSkillContent } = await import("./page-hash.js");
  let skillMd = "";
  try {
    skillMd = await readFile(join(skillDir, "SKILL.md"), "utf8");
  } catch {
    // Missing SKILL.md is a higher-level error; treat content as empty
    // for hashing so callers see "different from anything we expect."
  }
  const files = await readLocalSkillFiles(skillDir);
  return hashSkillContent(skillMd, files);
}

/**
 * Upsert a parent skill page's child pages to match a desired set of
 * SkillFiles, applying spec category nesting:
 *
 *   - Files at `scripts/`, `references/`, `assets/` are nested inside
 *     a same-named wrapper sub-page on the parent. Wrapper sub-pages
 *     are auto-created when needed and archived when their category
 *     becomes empty locally.
 *   - Files outside spec dirs are direct top-level children of the
 *     parent skill page (flat-title scheme).
 *   - Orphan child pages (titles with no matching local file) are
 *     archived.
 *
 * Caller passes a NotionClient with the methods we need. We pass a
 * minimal interface here rather than importing NotionClient to keep
 * skill-files.ts free of tight coupling.
 */
export interface UpsertClient {
  getBlockChildren(blockId: string): Promise<
    Array<{ id: string; type: string; [k: string]: unknown }>
  >;
  createChildPage(parentPageId: string, title: string): Promise<string>;
  archivePage(pageId: string): Promise<void>;
}

export async function upsertSkillFilePages(
  client: UpsertClient,
  setPageMarkdown: (pageId: string, markdown: string) => Promise<void>,
  parentPageId: string,
  files: SkillFile[],
): Promise<void> {
  // Group files by category. Files in spec dirs land in their wrapper;
  // everything else stays flat at the parent.
  type Group = { wrapperTitle: string; files: SkillFile[] };
  const groups = new Map<SpecCategoryDir, Group>();
  const rootFiles: SkillFile[] = [];

  for (const file of files) {
    const cat = specCategoryOf(file.path);
    if (cat) {
      let g = groups.get(cat.category);
      if (!g) {
        g = { wrapperTitle: cat.category, files: [] };
        groups.set(cat.category, g);
      }
      g.files.push({
        ...file,
        // Within the wrapper, the page's title is the path within the
        // category (so "scripts/extract.py" → "extract.py" on the
        // child of the "scripts" wrapper).
        path: cat.pathWithinCategory,
      });
    } else {
      rootFiles.push(file);
    }
  }

  // Snapshot existing top-level children of parent.
  const parentBlocks = await client.getBlockChildren(parentPageId);
  const existingTopLevel = new Map<string, string>();
  for (const block of parentBlocks) {
    if (block.type !== "child_page") continue;
    const cp = (block as { child_page?: { title?: string } }).child_page;
    const title = cp?.title?.trim();
    if (title) existingTopLevel.set(title, block.id);
  }

  // Process each spec category that has local files.
  const desiredTopLevelTitles = new Set<string>();
  for (const file of rootFiles) desiredTopLevelTitles.add(file.path);

  for (const [category, group] of groups) {
    desiredTopLevelTitles.add(category);
    let wrapperId = existingTopLevel.get(category);
    if (!wrapperId) {
      wrapperId = await client.createChildPage(parentPageId, category);
    }
    await upsertChildPagesIn(
      client,
      setPageMarkdown,
      wrapperId,
      group.files,
    );
  }

  // Empty category wrappers (existed before but now have no files
  // locally) get archived so they don't linger.
  for (const cat of SPEC_CATEGORY_DIRS) {
    if (groups.has(cat)) continue;
    const wrapperId = existingTopLevel.get(cat);
    if (wrapperId) {
      // Archive children first so they don't dangle. Then archive the
      // wrapper itself.
      const inner = await client.getBlockChildren(wrapperId);
      for (const block of inner) {
        if (block.type !== "child_page") continue;
        await client.archivePage(block.id);
      }
      await client.archivePage(wrapperId);
    }
  }

  // Root-level (non-spec-dir) files: upsert flat-title children.
  await upsertChildPagesIn(
    client,
    setPageMarkdown,
    parentPageId,
    rootFiles,
    {
      // Don't archive top-level children that are spec category names
      // — those are managed above and may still be valid wrappers.
      preserveTitles: new Set([...SPEC_CATEGORY_DIRS]),
      existingByTitle: existingTopLevel,
    },
  );
}

/**
 * Lower-level helper: upserts a flat list of files as child pages of
 * a single parent (the parent could be the skill row itself for root
 * files or a spec category wrapper for nested files).
 *
 *   - opts.existingByTitle lets the caller pass in a pre-fetched list
 *     to avoid an extra getBlockChildren call when they already have
 *     it. When omitted, we fetch.
 *   - opts.preserveTitles names titles that should never be archived
 *     even if they're not in the desired set — used by the parent
 *     pass to leave spec category wrappers alone.
 */
async function upsertChildPagesIn(
  client: UpsertClient,
  setPageMarkdown: (pageId: string, markdown: string) => Promise<void>,
  parentId: string,
  files: SkillFile[],
  opts: {
    existingByTitle?: Map<string, string>;
    preserveTitles?: Set<string>;
  } = {},
): Promise<void> {
  let existingByTitle = opts.existingByTitle;
  if (!existingByTitle) {
    const blocks = await client.getBlockChildren(parentId);
    existingByTitle = new Map<string, string>();
    for (const block of blocks) {
      if (block.type !== "child_page") continue;
      const cp = (block as { child_page?: { title?: string } }).child_page;
      const title = cp?.title?.trim();
      if (title) existingByTitle.set(title, block.id);
    }
  }

  const desired = new Set(files.map((f) => f.path));

  for (const file of files) {
    const body = renderForChildPage(file);
    const existingId = existingByTitle.get(file.path);
    if (existingId) {
      await setPageMarkdown(existingId, body);
    } else {
      const newId = await client.createChildPage(parentId, file.path);
      if (body.trim()) {
        await setPageMarkdown(newId, body);
      }
    }
  }

  for (const [title, id] of existingByTitle) {
    if (desired.has(title)) continue;
    if (opts.preserveTitles?.has(title)) continue;
    await client.archivePage(id);
  }
}

/**
 * Walk a local skill directory and collect every non-SKILL.md file
 * as a SkillFile. Recurses into subdirectories; skips dotfiles
 * (.DS_Store, .gitignore, etc.) and the SKILL.md itself.
 *
 * Files are classified by extension. "unsupported" files are still
 * surfaced in the result so the caller can warn — publish rejects
 * them rather than silently dropping their contents.
 */
export async function readLocalSkillFiles(
  skillDir: string,
): Promise<SkillFile[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const out: SkillFile[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relPath === "SKILL.md") continue;
      const { kind, lang } = classifyExtension(relPath);
      const content = await readFile(fullPath, "utf8");
      out.push({ path: relPath, kind, lang, content });
    }
  }

  await walk(skillDir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Write a skill's sibling files to disk, rooted at `skillDir`. Used
 * by install + sync after the parent SKILL.md has been written.
 *
 *   - Skips files whose path isn't safely relative (defensive against
 *     titles that traverse outside the skill dir).
 *   - Skips files marked "unsupported" (binary etc.) — those didn't
 *     round-trip cleanly and we don't want to re-write garbage.
 *   - Creates intermediate directories as needed for nested paths.
 */
export async function materializeFiles(
  skillDir: string,
  files: SkillFile[],
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  for (const file of files) {
    if (file.kind === "unsupported") continue;
    if (!isSafeRelativePath(file.path)) continue;
    const target = join(skillDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length === 0) return false;
  if (p === "SKILL.md") return false; // reserved for the parent's body
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // Normalise separators and reject any segment of "..".
  const segments = p.replace(/\\/g, "/").split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}
