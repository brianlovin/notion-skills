/**
 * Error translation: turn raw exceptions from ntn / Notion / our internals
 * into human-readable messages with optional auto-run recovery actions.
 *
 * Pattern matching is keyed off the message text rather than instanceof
 * checks because errors cross language and process boundaries (ntn shells
 * out, Notion returns JSON, we wrap with our own classes). The matchers
 * are dumb regexes — when they fire, the original error message is shown
 * alongside the friendly version so we never hide context.
 */

import chalk from "chalk";
import { confirm } from "@inquirer/prompts";

export interface RecoveryAction {
  /** Short label rendered as `Run X? [Y/n]`. */
  label: string;
  /** Function that performs the recovery, typically by invoking another
   *  command. Throws on failure. */
  run: () => Promise<void>;
}

export interface FriendlyError {
  /** One-line summary of what went wrong. */
  summary: string;
  /** Optional second line: how to fix or why it happened. */
  detail?: string;
  /** Optional recovery action the user can opt into. */
  recovery?: RecoveryAction;
  /** Always preserve the original message so we never hide context. */
  raw: string;
}

interface Pattern {
  match: (text: string) => boolean;
  build: (text: string) => Omit<FriendlyError, "raw">;
}

const PATTERNS: Pattern[] = [
  {
    match: (t) => /API token is invalid/i.test(t) || /NtnAuthError/.test(t),
    build: () => ({
      summary: "Notion auth has expired or `ntn` isn't logged in.",
      detail: "Your `ntn` session needs to be refreshed.",
      recovery: {
        label: "Run `ntn login` now",
        run: async () => {
          const { spawn } = await import("node:child_process");
          await new Promise<void>((resolve, reject) => {
            const child = spawn("ntn", ["login"], {
              stdio: "inherit",
              env: process.env,
            });
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`ntn login exit ${code}`)),
            );
          });
        },
      },
    }),
  },
  {
    match: (t) => /ntn` is not installed/i.test(t) || /NtnNotInstalledError/.test(t),
    build: () => ({
      summary: "`ntn` isn't installed.",
      detail:
        "notion-skills uses Notion's official CLI for API access.\n" +
        "Install: https://github.com/makenotion/ntn-cli",
    }),
  },
  {
    match: (t) =>
      /is expected to be (select|rich_text|checkbox|multi_select|title)/i.test(t),
    build: () => ({
      summary: "The Notion database schema doesn't match what notion-skills expects.",
      detail:
        "A property's type is different in Notion than in our schema. " +
        "This usually happens after upgrading the CLI.",
      recovery: {
        label: "Run `notion-skills upgrade` to reconcile the schema",
        run: async () => {
          const { upgradeCommand } = await import("./commands/upgrade.js");
          await upgradeCommand();
        },
      },
    }),
  },
  {
    match: (t) => /Could not find database/i.test(t) || /Could not find page/i.test(t),
    build: () => ({
      summary: "Notion couldn't find the database or page you referenced.",
      detail:
        "Either the URL/ID is wrong, the page was deleted, or `ntn` is " +
        "logged in to a different workspace than the one containing it.",
    }),
  },
  {
    match: (t) => /Can't edit block that is archived/i.test(t),
    build: () => ({
      summary: "That page is in Notion's trash.",
      detail: "Restore it from Notion's trash or recreate the page.",
    }),
  },
  {
    match: (t) => /ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed/i.test(t),
    build: () => ({
      summary: "Couldn't reach the Notion API.",
      detail: "Network looks unavailable. Check your connection and try again.",
    }),
  },
  {
    match: (t) => /No scope configured/i.test(t),
    build: () => ({
      summary: "notion-skills isn't configured yet.",
      recovery: {
        label: "Run `notion-skills init` now",
        run: async () => {
          const { initCommand } = await import("./commands/init.js");
          await initCommand({});
        },
      },
    }),
  },
  {
    match: (t) => /Not logged in/i.test(t),
    build: () => ({
      summary: "Not logged in to Notion.",
      recovery: {
        label: "Run `ntn login` now",
        run: async () => {
          const { spawn } = await import("node:child_process");
          await new Promise<void>((resolve, reject) => {
            const child = spawn("ntn", ["login"], {
              stdio: "inherit",
              env: process.env,
            });
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`ntn login exit ${code}`)),
            );
          });
        },
      },
    }),
  },
];

export function translateError(err: unknown): FriendlyError {
  const raw = err instanceof Error ? err.message : String(err);
  for (const p of PATTERNS) {
    if (p.match(raw)) {
      return { ...p.build(raw), raw };
    }
  }
  return { summary: raw, raw };
}

/**
 * Print a translated error to stderr. If a recovery action is available
 * and stdin is a TTY, prompt the user to run it. Returns the desired
 * process exit code (0 if recovery succeeded, 1 otherwise).
 */
export async function reportError(err: unknown): Promise<number> {
  const f = translateError(err);

  console.error("");
  console.error(chalk.red(`✗ ${f.summary}`));
  if (f.detail) {
    for (const line of f.detail.split("\n")) {
      console.error(chalk.dim(`  ${line}`));
    }
  }

  if (f.summary !== f.raw) {
    console.error(chalk.dim(`  (raw: ${f.raw.split("\n")[0]})`));
  }

  if (f.recovery && process.stdin.isTTY) {
    console.error("");
    let runIt = false;
    try {
      runIt = await confirm({
        message: f.recovery.label,
        default: true,
      });
    } catch {
      // User Ctrl-C'd or prompt failed — abort recovery.
      return 1;
    }
    if (runIt) {
      try {
        await f.recovery.run();
        return 0;
      } catch (recoveryErr) {
        console.error(chalk.red("Recovery failed:"));
        console.error(
          recoveryErr instanceof Error ? recoveryErr.message : recoveryErr,
        );
        return 1;
      }
    }
  } else if (f.recovery) {
    console.error("");
    console.error(chalk.dim(`Try: ${f.recovery.label}`));
  }

  return 1;
}
