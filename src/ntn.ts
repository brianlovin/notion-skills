import { spawn } from "node:child_process";

export class NtnNotInstalledError extends Error {
  constructor() {
    super(
      "`ntn` is not installed.\n" +
        "notion-skills uses Notion's official CLI for authentication.\n\n" +
        "Install: https://github.com/makenotion/cli\n" +
        "Then run: ntn login",
    );
    this.name = "NtnNotInstalledError";
  }
}

export class NtnAuthError extends Error {
  constructor() {
    super(
      "`ntn` is installed but not authenticated.\n" +
        "Run `ntn login` and try again.",
    );
    this.name = "NtnAuthError";
  }
}

export class NtnApiError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "NtnApiError";
  }
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function spawnNtn(args: string[], stdin?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ntn", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new NtnNotInstalledError());
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/**
 * Call a Notion public API endpoint via `ntn api`.
 * Returns parsed JSON. Throws NtnAuthError on auth failure or NtnApiError
 * otherwise. Retries on 429 / rate_limited with exponential backoff.
 */
export async function ntnApi<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  notionVersion?: string,
): Promise<T> {
  const args = ["api", "-X", method.toUpperCase(), path];
  if (notionVersion) {
    args.push("--notion-version", notionVersion);
  }

  // Body goes via stdin to avoid argv length limits and shell quoting issues.
  const stdin = body === undefined ? undefined : JSON.stringify(body);

  // 3 attempts total: 0s, 1s, 4s — matches Notion's typical rate-limit window.
  const delays = [0, 1000, 4000];
  let lastErr: NtnApiError | null = null;

  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const result = await spawnNtn(args, stdin);

    if (result.code === 4 || /API token is invalid/i.test(result.stderr)) {
      throw new NtnAuthError();
    }

    if (result.code === 0) {
      if (!result.stdout.trim()) return {} as T;
      try {
        return JSON.parse(result.stdout) as T;
      } catch {
        throw new NtnApiError(
          `ntn returned non-JSON stdout for ${method} ${path}: ${result.stdout.slice(0, 200)}`,
          result.code,
          result.stderr,
        );
      }
    }

    lastErr = new NtnApiError(
      `ntn api ${method} ${path} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      result.code,
      result.stderr,
    );

    // Only retry on rate limits — every other failure mode is permanent
    // for this attempt set.
    if (!isRateLimited(result.stderr)) break;
  }

  throw lastErr ?? new NtnApiError(`ntn api ${method} ${path} failed`, -1, "");
}

function isRateLimited(stderr: string): boolean {
  return /\b(429|rate[_ -]?limit)/i.test(stderr);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimum ntn version we require. ntn 0.12 introduced data-source APIs and
 *  the `pages update --content` flag we depend on. */
const MIN_NTN_VERSION: [number, number, number] = [0, 12, 0];

/**
 * Verify ntn is installed AND new enough. Doesn't probe auth — let the
 * first real API call surface auth errors with a clear message.
 */
export async function assertNtnInstalled(): Promise<void> {
  let result;
  try {
    result = await spawnNtn(["--version"]);
  } catch (err) {
    if (err instanceof NtnNotInstalledError) throw err;
    throw new NtnNotInstalledError();
  }
  if (result.code !== 0) {
    throw new NtnNotInstalledError();
  }

  const parsed = parseSemver(result.stdout.trim());
  if (parsed && compareSemver(parsed, MIN_NTN_VERSION) < 0) {
    throw new Error(
      `\`ntn\` is too old (${parsed.join(".")} < ${MIN_NTN_VERSION.join(".")}). ` +
        `notion-skills requires ntn ${MIN_NTN_VERSION.join(".")} or newer for ` +
        `data-source APIs. Run \`ntn update\` and try again.`,
    );
  }
}

function parseSemver(text: string): [number, number, number] | null {
  // Accept "ntn 0.12.0", "0.12.0", "v0.12.0", and trailing pre-release tags.
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export async function ntnDoctor(): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await spawnNtn(["doctor"]);
    return { ok: result.code === 0, output: result.stdout + result.stderr };
  } catch (err) {
    if (err instanceof NtnNotInstalledError) {
      return { ok: false, output: "ntn not installed" };
    }
    throw err;
  }
}

export async function ntnVersion(): Promise<string | null> {
  try {
    const result = await spawnNtn(["--version"]);
    if (result.code !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Replace a page's content with markdown. ntn does the markdown → blocks
 * conversion server-side. Used by `migrate` to push a local SKILL.md body
 * into a freshly-created Notion page.
 */
export async function ntnSetPageMarkdown(pageId: string, markdown: string): Promise<void> {
  const result = await spawnNtn(
    ["pages", "update", pageId, "--content", markdown, "--allow-deleting-content"],
  );
  if (result.code === 4 || /API token is invalid/i.test(result.stderr)) {
    throw new NtnAuthError();
  }
  if (result.code !== 0) {
    throw new NtnApiError(
      `ntn pages update ${pageId} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      result.code,
      result.stderr,
    );
  }
}
