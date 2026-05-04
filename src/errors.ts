/**
 * Error translation: turn raw exceptions from ntn / Notion / our internals
 * into human-readable messages with optional recovery hints.
 *
 * Pattern matching is keyed off the message text rather than instanceof
 * checks because errors cross language and process boundaries (ntn shells
 * out, Notion returns JSON, we wrap with our own classes). The matchers
 * are dumb regexes — when they fire, the original message is shown
 * alongside the friendly version so we never hide context.
 *
 * Recoveries are PRINTED, not executed. Spawning a re-entrant CLI from
 * inside a failing command was clever; printing the command the user can
 * type is dumb and obviously correct.
 */

import chalk from "chalk";

export interface FriendlyError {
  /** One-line summary of what went wrong. */
  summary: string;
  /** Optional second line: how to fix or why it happened. */
  detail?: string;
  /** Suggested next command for the user to type. */
  suggest?: string;
  /** Original message, preserved for debugging. */
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
      summary: "Notion auth has expired or `ntn` is in a stuck state.",
      detail:
        "Sometimes `ntn doctor` reports a valid token while API calls still fail. " +
        "The reliable fix is a full re-login.",
      suggest: "ntn logout && ntn login",
    }),
  },
  {
    match: (t) => /ntn` is not installed/i.test(t) || /NtnNotInstalledError/.test(t),
    build: () => ({
      summary: "`ntn` isn't installed.",
      detail: "notion-skills uses Notion's official CLI for API access.",
      suggest: "Install: https://github.com/makenotion/cli",
    }),
  },
  {
    match: (t) =>
      /is expected to be (select|rich_text|checkbox|multi_select|title)/i.test(t),
    build: () => ({
      summary: "Notion's database schema doesn't match what notion-skills expects.",
      detail:
        "A property's type is different in Notion than in our schema. " +
        "This usually happens after upgrading the CLI.",
      suggest: "notion-skills upgrade",
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
      suggest: "notion-skills init",
    }),
  },
  {
    match: (t) => /Not logged in/i.test(t),
    build: () => ({
      summary: "Not logged in to Notion.",
      suggest: "ntn login",
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
 * Print a translated error to stderr. Recovery commands are SUGGESTED,
 * never executed automatically. Returns 1 (process exit code).
 */
export function reportError(err: unknown): number {
  const f = translateError(err);

  console.error("");
  console.error(chalk.red(`✗ ${f.summary}`));
  if (f.detail) {
    for (const line of f.detail.split("\n")) {
      console.error(chalk.dim(`  ${line}`));
    }
  }
  if (f.suggest) {
    console.error(chalk.dim(`  → ${f.suggest}`));
  }
  if (f.summary !== f.raw) {
    console.error(chalk.dim(`  (raw: ${f.raw.split("\n")[0]})`));
  }
  return 1;
}
