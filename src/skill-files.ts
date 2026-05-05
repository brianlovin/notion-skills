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
