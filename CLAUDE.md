# notion-skills

CLI that syncs agent skills between a Notion database and local agent CLI dirs (Claude, Codex, OpenCode, Cursor, Gemini).

## Architecture

- **All Notion API calls shell out to `ntn`** (Notion's official CLI) via `src/ntn.ts`. **Do not add an HTTP client.** Auth lives in `ntn login`; bypassing it breaks every workflow.
- `src/schema.ts` is the single source of truth for the property ↔ frontmatter mapping. Add new properties to `SCHEMA`, not to ad-hoc helpers.
- `src/known-targets.ts` is the registry of supported agent CLIs. Adding one is a single entry; don't fan logic out elsewhere.
- Pure helpers (`sync-decision.ts`, `local-state.ts`, schema utilities) live in their own files so the orchestration glue in `sync.ts` / `migrate.ts` stays testable.

## State

- `~/.notion-skills/scope.json` — database id, sync targets, optional `exclude_skills`.
- `~/.notion-skills/manifest.json` — per-skill sync state. Each entry tracks `page_id`, `last_edited_time`, `props_hash` (Notion-side change detection), and `local_hash` (drift detection for push).
- `~/.notion-skills/skills/<name>/` — central source-of-truth. Targets get symlinks in.

## Tests

Tests are `test/*.test.mjs` and import from `dist/`. `npm test` runs `tsc` first. When fixing a bug, extract the buggy logic into a pure helper, then write the regression test against it before fixing.

## Verification

After making changes:

- `npm test` — TypeScript compile + 145 tests via `node --test`.
- For CLI/UX changes, exercise via `node dist/cli.js <subcommand>` against the live Notion DB. The live binary `notion-skills` may be older than the local build.

## Gotchas

- `runSync(scope, { quiet: true })` is the silent path used by migrate after upload. New output should respect the flag.
- Notion's `last_edited_time` rounds to the minute. Conflict-resolution tests need a ≥ 1-minute gap between local and remote edits.
- Sync's push reuses `parseSkillFile` from `src/migrate.ts` and the progressive `upgradeSchema(only)` + `ensureSelectOptions` flow. Don't duplicate that pipeline.
- The published npm artifact is the contents of `dist/`. Don't import from `dist/` in `src/`.

## Workflow

For non-trivial work, the global workflow skill at `~/.claude/skills/workflow/SKILL.md` is the playbook (plan mode, subagents, self-improvement loop, verification, elegance checks). Don't duplicate it here.
