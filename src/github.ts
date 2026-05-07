/**
 * GitHub source parsing + fetch helpers for `notion-skills add`.
 *
 * We mirror the syntax skills.sh users are already familiar with —
 * `owner/repo`, `owner/repo#ref`, `owner/repo@skill`, full URLs — but
 * scope to GitHub for v0. GitLab + generic git URLs land later if
 * users ask. We use the GitHub Trees API and raw.githubusercontent
 * for fetches; no `simple-git` dependency.
 *
 * Auth is best-effort: GITHUB_TOKEN / GH_TOKEN env, or shell out to
 * `gh auth token` if available. Anonymous requests work for public
 * repos but hit a 60-req/hour rate limit.
 */

import { spawnSync } from "node:child_process";

// ---------- parsing ----------

export interface ParsedGitHubSource {
  owner: string;
  repo: string;
  /** Branch, tag, or commit SHA. Undefined = repo default branch. */
  ref?: string;
  /** Subdir within the repo to scan for skills. Undefined = repo root. */
  subpath?: string;
  /**
   * Filter to a specific skill name in a multi-skill repo. Set via
   * `owner/repo@skill-name` syntax or via the `--skill` CLI flag at
   * a higher layer.
   */
  skillFilter?: string;
}

const HEAD_FRAGMENT_RE = /^([^#@]+)(?:#([^@]*))?(?:@(.+))?$/;
// Regex for the path-only portion of a GitHub URL, after the URL
// constructor has stripped the protocol/host/query/fragment.
// `tree/<ref>/<path>` is the folder view; `blob/<ref>/<path>` is the
// file view — users paste either depending on where they were in
// the GitHub UI.
const URL_PATH_RE = /^([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?$/;
const SHORT_RE = /^([^/]+)\/([^/#@]+)(?:\/(.+?))?$/;
const SSH_RE = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;

/**
 * Parse one of the user-facing source shapes:
 *   - `owner/repo`
 *   - `owner/repo/subpath`
 *   - `owner/repo#ref`
 *   - `owner/repo@skill`
 *   - `owner/repo#ref@skill`
 *   - `github:owner/repo` (prefix)
 *   - `https://github.com/owner/repo[/tree/<ref>[/<subpath>]]`
 *   - `git@github.com:owner/repo.git`
 *
 * Throws with a friendly message on unrecognised input. Pure: no I/O.
 */
export function parseGitHubSource(input: string): ParsedGitHubSource {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error("Empty source");

  // `github:owner/repo` prefix → strip and re-parse.
  if (trimmed.startsWith("github:")) {
    return parseGitHubSource(trimmed.slice("github:".length));
  }

  // Full URL form (https://github.com/...). Use the URL constructor
  // so query strings + URL fragments don't trip the path regex —
  // pasting `https://github.com/owner/repo?something=...` is common
  // when grabbing links from GitHub's filtered views.
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      throw new Error(`Unrecognised source "${input}". Use \`owner/repo\` or a GitHub URL.`);
    }
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
      throw new Error(`Only github.com URLs are supported (got ${u.hostname}).`);
    }
    const path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    const m = path.match(URL_PATH_RE);
    if (!m) {
      throw new Error(`Unrecognised source "${input}". Expected \`/owner/repo\` or \`/owner/repo/(tree|blob)/<ref>[/<path>]\`.`);
    }
    const [, owner, repo, ref, subpath] = m;
    return cleanSource({ owner: owner!, repo: repo!, ref, subpath });
  }

  // SSH form (git@github.com:owner/repo.git).
  const sshMatch = trimmed.match(SSH_RE);
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    return cleanSource({ owner: owner!, repo: repo! });
  }

  // Shorthand: split off optional #ref and @skill, then match owner/repo[/subpath].
  const fragmented = trimmed.match(HEAD_FRAGMENT_RE);
  if (!fragmented) {
    throw new Error(`Unrecognised source "${input}". Use \`owner/repo\` or a GitHub URL.`);
  }
  const [, head, ref, skillFilter] = fragmented;
  const m = head!.match(SHORT_RE);
  if (!m) {
    throw new Error(`Unrecognised source "${input}". Use \`owner/repo\` or a GitHub URL.`);
  }
  const [, owner, repo, subpath] = m;
  return cleanSource({ owner: owner!, repo: repo!, ref, subpath, skillFilter });
}

function cleanSource(source: ParsedGitHubSource): ParsedGitHubSource {
  // Strip trailing `.git` from the repo name and any leading/trailing
  // slashes from the subpath. Reject `..` segments to prevent the
  // skills.sh-style path-traversal escape.
  const repo = source.repo.replace(/\.git$/, "");
  const segments = source.subpath
    ?.replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments?.some((s) => s === "..")) {
    throw new Error(`Unsafe subpath "${source.subpath}" — segments cannot include "..".`);
  }
  // If the user pasted a `/blob/<ref>/.../SKILL.md` URL, the subpath
  // points at the file. Strip it so we end up scoped to the skill's
  // dir — that's the meaningful scope at the discovery layer.
  const trimmed =
    segments && segments[segments.length - 1] === "SKILL.md"
      ? segments.slice(0, -1)
      : segments;
  return {
    owner: source.owner,
    repo,
    ...(source.ref !== undefined ? { ref: safeDecodeURI(source.ref) } : {}),
    ...(trimmed && trimmed.length > 0 ? { subpath: trimmed.join("/") } : {}),
    ...(source.skillFilter !== undefined ? { skillFilter: source.skillFilter } : {}),
  };
}

/**
 * decodeURIComponent throws on malformed percent escapes (e.g. a
 * lone `%`). For ref names we'd rather degrade gracefully — the
 * original raw string is more useful to the user than a crash.
 */
function safeDecodeURI(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Display string for the parsed source, used in `metadata.origin`
 * frontmatter and in CLI output. Round-trips through `parseGitHubSource`.
 */
export function formatSourceRef(source: ParsedGitHubSource): string {
  let out = `${source.owner}/${source.repo}`;
  if (source.subpath) out += `/${source.subpath}`;
  if (source.ref) out += `#${source.ref}`;
  if (source.skillFilter) out += `@${source.skillFilter}`;
  return out;
}

// ---------- fetch ----------

export interface RepoTreeEntry {
  /** Path relative to the repo root. */
  path: string;
  /** "blob" (file) or "tree" (directory). */
  type: "blob" | "tree";
  /** Tree SHA (for both files and dirs). */
  sha: string;
  /** Byte size, only present on blobs. */
  size?: number;
}

export interface RepoTree {
  /** Resolved ref (branch/tag/sha). When the input ref was undefined,
   *  this is the repo's default branch. */
  ref: string;
  entries: RepoTreeEntry[];
  /** True when GitHub's response indicated the tree was truncated
   *  (>100k entries). For skill repos, basically never the case. */
  truncated: boolean;
}

/**
 * Resolve the repo's default branch when the user didn't specify one.
 * Returns null if the repo is unreachable / private without auth.
 *
 * Optimisation path: 99% of public repos default to `main` or
 * (legacy) `master`. We try those branches' tree endpoints directly
 * — a successful 200 means the branch exists AND we now have the
 * tree we'd need next anyway, so we cache it. Only when both miss
 * do we hit /repos/<owner>/<repo> for the canonical default_branch.
 *
 * The cached tree is opportunistic — caller checks `cachedTree` and
 * skips the second fetchRepoTree call when present.
 */
export async function resolveDefaultBranch(
  source: ParsedGitHubSource,
): Promise<{ ref: string; cachedTree: RepoTree | null } | null> {
  for (const candidate of ["main", "master"]) {
    const tree = await tryFetchRepoTree(source, candidate);
    if (tree) return { ref: candidate, cachedTree: tree };
  }
  // Neither convention hit — the repo likely uses a non-standard
  // default branch (e.g. `develop`, `trunk`). Fall back to the
  // metadata endpoint.
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  const res = await ghFetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as { default_branch?: string };
  if (!body.default_branch) return null;
  return { ref: body.default_branch, cachedTree: null };
}

async function tryFetchRepoTree(
  source: ParsedGitHubSource,
  ref: string,
): Promise<RepoTree | null> {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${ref}?recursive=1`;
  const res = await ghFetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as {
    tree?: Array<{ path: string; type: string; sha: string; size?: number }>;
    truncated?: boolean;
  };
  const entries: RepoTreeEntry[] = (body.tree ?? [])
    .filter((e) => e.type === "blob" || e.type === "tree")
    .map((e) => ({
      path: e.path,
      type: e.type as "blob" | "tree",
      sha: e.sha,
      ...(e.size !== undefined ? { size: e.size } : {}),
    }));
  return { ref, entries, truncated: !!body.truncated };
}

/**
 * Fetch the recursive tree for the resolved ref. Used to discover
 * skill dirs without cloning. The Trees API truncates at ~100k
 * entries; we throw a friendly message if that ever bites.
 */
export async function fetchRepoTree(
  source: ParsedGitHubSource,
  ref: string,
): Promise<RepoTree> {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${ref}?recursive=1`;
  const res = await ghFetch(url);
  if (!res.ok) {
    throw new Error(
      `GitHub API returned ${res.status} for ${source.owner}/${source.repo} @ ${ref}. ${
        res.status === 404 ? "Repo, branch, or tag may not exist (or may be private — set GITHUB_TOKEN)." : ""
      }`,
    );
  }
  const body = (await res.json()) as {
    tree?: Array<{ path: string; type: string; sha: string; size?: number }>;
    truncated?: boolean;
  };
  const entries: RepoTreeEntry[] = (body.tree ?? [])
    .filter((e) => e.type === "blob" || e.type === "tree")
    .map((e) => ({
      path: e.path,
      type: e.type as "blob" | "tree",
      sha: e.sha,
      ...(e.size !== undefined ? { size: e.size } : {}),
    }));
  return { ref, entries, truncated: !!body.truncated };
}

/**
 * Fetch a single file's UTF-8 content via raw.githubusercontent.
 * Returns null on 404 so callers can probe optional paths cleanly.
 */
export async function fetchFileContent(
  source: ParsedGitHubSource,
  ref: string,
  path: string,
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${ref}/${path}`;
  const res = await ghFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path} from ${source.owner}/${source.repo}: ${res.status}`);
  }
  return await res.text();
}

// ---------- auth + low-level fetch ----------

let cachedToken: string | null | undefined;

function readGitHubToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env && env.trim().length > 0) {
    cachedToken = env.trim();
    return cachedToken;
  }
  // Shell out to `gh auth token` as a last resort. Suppresses stderr
  // because non-installed `gh` is a normal anonymous case.
  try {
    const result = spawnSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && result.stdout) {
      const token = result.stdout.trim();
      if (token.length > 0) {
        cachedToken = token;
        return token;
      }
    }
  } catch {
    // gh not installed, etc.
  }
  cachedToken = null;
  return null;
}

/**
 * Thrown by ghFetch when GitHub responds with a rate-limit signal —
 * either an explicit 429 or a 403 with `x-ratelimit-remaining: 0`.
 * The CLI surfaces the message + a hint to set GITHUB_TOKEN, and
 * (in `add`'s per-skill loop) lets the rest of the batch continue.
 */
export class GitHubRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

const FETCH_TIMEOUT_MS = 10_000;

async function ghFetch(url: string): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": "notion-skills",
    Accept: "application/vnd.github+json",
  };
  const token = readGitHubToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  // AbortSignal.timeout (Node 17.3+) caps any single fetch — a hung
  // CDN or stuck connection can't block the whole add forever.
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(
        `GitHub fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s (${url}).`,
      );
    }
    throw err;
  }

  // GitHub returns 403 with x-ratelimit-remaining: 0 for anonymous
  // rate limits, and 429 for secondary limits. Both look like
  // "request failed" but the user's recovery is the same: wait, or
  // set GITHUB_TOKEN. Distinguish them from 404 ("file missing")
  // which is a normal probe outcome.
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    const reset = res.headers.get("x-ratelimit-reset");
    const resetMsg = reset
      ? ` Resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}.`
      : "";
    throw new GitHubRateLimitError(
      `GitHub rate limit hit (${res.status}).${resetMsg} Set GITHUB_TOKEN (or run \`gh auth login\`) for higher limits.`,
    );
  }
  return res;
}
