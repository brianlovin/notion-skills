# notion-skills

App-store-style CLI for AI coding agent skills. A Notion database is the workspace skill store; users `install` what they want, `publish` what they author, `sync` to keep installed skills up to date.

## Mental model

The model is intentionally close to npm / iOS App Store:

- **A skill is in two states**: `installed` (in the manifest) or `not installed`. There is no detach/fork in v1.
- **Pull is implicit** (`sync` updates installed skills) — **push is explicit** (`publish` is the only way edits go upstream).
- **`gen` produces local-first drafts** — the agent writes to `~/.notion-skills/skills/<slug>/` and exits; `publish` is a separate step.
- **Anyone can edit any installed skill.** Page-level Notion permissions are the eventual access-control story; we don't enforce author-only edits in v1.
- **Per-machine install state.** No cross-device install sync.

## Architecture

- **All Notion API calls shell out to `ntn`** (Notion's official CLI) via `src/ntn.ts`. **Do not add an HTTP client.** Auth lives in `ntn login`; bypassing it breaks every workflow.
- `src/schema.ts` is the single source of truth for the property ↔ frontmatter mapping. Add new properties to `SCHEMA`, not to ad-hoc helpers.
- `src/known-targets.ts` is the registry of supported agent CLIs. Adding one is a single entry; don't fan logic out elsewhere.
- Pure helpers (`sync-decision.ts`, `local-state.ts`, schema utilities) live in their own files so the orchestration glue in `sync.ts` / `migrate.ts` stays testable.
- `migrate.ts` is the publish/import engine. `publish.ts` and `import.ts` thin-wrap it; `migrate` survives as a hidden deprecated alias.

## State

- `~/.notion-skills/scope.json` — database id, sync targets, optional `exclude_skills`, `gen_agent`.
- `~/.notion-skills/manifest.json` — per-installed-skill sync state. Each entry tracks `page_id`, `last_edited_time`, `props_hash` (Notion-side change detection), and `local_hash` (drift detection).
- `~/.notion-skills/skills/<slug>/` — every skill on this machine, installed or draft. The presence of a manifest entry distinguishes the two.
- `~/.notion-skills/backup/` — auto-backups from `uninstall` (when local edits drift) and `sync` (when a pull would overwrite drift).

## Tests

Tests are `test/*.test.mjs` and import from `dist/`. `npm test` runs `tsc` first. When fixing a bug, extract the buggy logic into a pure helper, then write the regression test against it before fixing.

## Verification

After making changes:

- `npm test` — TypeScript compile + tests via `node --test`.
- For CLI/UX changes, exercise via `node dist/cli.js <subcommand>` against the live Notion store. `npm link` is set up so `notion-skills` resolves to the local build.

## Gotchas

- `runSync(scope, { quiet: true })` is the silent path used by migrate/publish after upload. `extraFetchIds` is the escape hatch for force-refetching just-published pages that aren't in the manifest yet.
- `sync` is **pull-only and narrowed to installed skills**. New pages in Notion don't auto-install — they show up in `list` and require explicit `install <slug>`. Local edits never push automatically; `publish` is the only push path.
- Notion's `last_edited_time` rounds to the minute. Time-sensitive tests need a ≥ 1-minute gap between local and remote edits.
- `gen` hands its wrapped prompt to a coding-agent CLI (claude, codex, opencode, gemini) defined in `src/gen-agents.ts`. The agent's only job is to write a SKILL.md to `~/.notion-skills/skills/<slug>/`; the agent never runs shell commands. After agent exit, gen creates symlinks for new central-store entries — but does NOT publish. The user runs `publish` themselves. The contract lives in `src/gen-prompt.ts`.
- The central store (`~/.notion-skills/skills/`) is the only place skills live on disk. Manifest entry = installed; no manifest entry = draft. Symlinks fan out from central store to every target dir for both states (drafts are immediately invokable).
- The published npm artifact is the contents of `dist/`. Don't import from `dist/` in `src/`.

## Workflow

For non-trivial work, the global workflow skill at `~/.claude/skills/workflow/SKILL.md` is the playbook (plan mode, subagents, self-improvement loop, verification, elegance checks). Don't duplicate it here.
