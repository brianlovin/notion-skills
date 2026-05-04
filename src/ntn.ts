import { spawn } from "node:child_process";

export class NtnNotInstalledError extends Error {
  constructor() {
    super(
      "`ntn` is not installed.\n" +
        "notion-skills uses Notion's official CLI for authentication.\n\n" +
        "Install: https://github.com/makenotion/ntn-cli\n" +
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
 * Returns parsed JSON. Throws NtnAuthError on auth failure or NtnApiError otherwise.
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

  const stdin = body === undefined ? undefined : JSON.stringify(body);
  if (stdin !== undefined) {
    // Pass body via stdin to avoid argv length limits and quoting issues.
  }

  const result = await spawnNtn(args, stdin);

  if (result.code === 4 || /API token is invalid/i.test(result.stderr)) {
    throw new NtnAuthError();
  }
  if (result.code !== 0) {
    throw new NtnApiError(
      `ntn api ${method} ${path} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      result.code,
      result.stderr,
    );
  }

  if (!result.stdout.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new NtnApiError(
      `ntn returned non-JSON stdout for ${method} ${path}: ${result.stdout.slice(0, 200)}`,
      result.code,
      result.stderr,
    );
  }
}

/**
 * Verify ntn is installed. Doesn't probe auth — let the first real API call
 * surface auth errors with a clear message.
 */
export async function assertNtnInstalled(): Promise<void> {
  try {
    const result = await spawnNtn(["--version"]);
    if (result.code !== 0) {
      throw new NtnNotInstalledError();
    }
  } catch (err) {
    if (err instanceof NtnNotInstalledError) throw err;
    throw new NtnNotInstalledError();
  }
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
