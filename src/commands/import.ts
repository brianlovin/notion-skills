import { migrateCommand } from "./migrate.js";

interface ImportOptions {
  from?: string[];
  yes?: boolean;
}

/**
 * Bring pre-existing local skills into the workspace store.
 *
 * The default scan path is the user's known agent dirs (~/.claude/skills,
 * ~/.codex/skills, etc.) plus the central store. `--from <path>` adds
 * extra source dirs (e.g. an old skills repo). The flow is:
 *
 *   1. Discover skill dirs across all source paths.
 *   2. Show the user a count of new pages and ask Y/n to confirm
 *      (`--yes` skips the prompt). All discovered skills are imported;
 *      there's no per-skill picker today — drop unwanted ones from the
 *      source dir before running, or use a narrower `--from` path.
 *   3. For each skill: copy into the central store, push to Notion,
 *      replace the original target-dir entry with a symlink pointing
 *      at the central store.
 *
 * Import claims source-of-truth — the user's daily flow goes through
 * notion-skills after import. External authoritative sources (a
 * git-managed agent-config, etc.) become decoupled.
 */
export async function importCommand(opts: ImportOptions): Promise<void> {
  await migrateCommand({
    from: opts.from,
    yes: opts.yes,
  });
}
