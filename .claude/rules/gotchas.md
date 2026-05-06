# Gotchas

Surprising behaviors that have bitten us before. New work that touches these areas should re-read this file.

## Sync orchestration

- `runSync(scope, { quiet: true })` is the silent path used by `migrate` / `publish` after upload. Surface-level commands log; the inner sync after a publish does not.
- `extraFetchIds` is the escape hatch for force-refetching just-published pages that aren't in the manifest yet. Don't add a separate "push then pull just this one" code path; pass the IDs through.
- `sync` is **pull-only and narrowed to installed skills**. New pages in Notion don't auto-install — they show up in `list` and require explicit `install <slug>`. Local edits never push automatically; `publish` is the only push path.

## Gen contract

`gen` hands its wrapped prompt to a coding-agent CLI (claude, codex, opencode, gemini) defined in `src/gen-agents.ts`. The agent's only job is to write a SKILL.md to `~/.notion-skills/skills/<slug>/`; **the agent never runs shell commands**. After agent exit, `gen` creates symlinks for new central-store entries — but does NOT publish. The user runs `publish` themselves. The contract is in `src/gen-prompt.ts`.

## Spec category dirs (multi-file skills)

The spec defines three optional dirs: `scripts/` / `references/` / `assets/`. We round-trip them as nested sub-pages: the category becomes a wrapper sub-page on the parent skill row, and files within it become children of the wrapper. Files outside spec dirs stay as flat-title children of the parent.

`src/skill-files.ts:upsertSkillFilePages` is the single shared helper for the push side; both `publish` and `migrate` use it. Don't reintroduce parallel implementations.

The spec category match is **strict lowercase** — a folder named `Scripts/` (capital S) won't be recognized; document this when authoring.

## Default views

Fresh databases get four views scaffolded at create-time (and reconciled on `init` / `upgrade` for linked DBs): **All** (alphabetical), **Popular** (Installs descending), **New** (recent additions), **Drafts** (filter: `Published=false`). Logic in `src/notion.ts:ensureDefaultViews`. Fail-soft — Views API errors are swallowed (logged in `NOTION_SKILLS_DEBUG=1`) so users still get a working DB if their workspace blocks the endpoint.

Each view shows only the high-signal columns by default (Name / Description / Tags / Installs) with Name + Description frozen; the rest are toggleable in Notion's UI per-view. The `defaultVisibleInListView` flag in `SCHEMA` controls which columns surface.

## Publish has three paths

`publish <slug>` resolves to one of three operations, all of which set `Published=true`:

1. **Local draft** (central-store dir, no manifest entry) → create the Notion page
2. **Installed skill** (manifest entry exists) → update body + properties
3. **Notion-side draft** (page exists with `Published=false`, no local presence) → flip the checkbox; no body upload

Anything else is an error.

## Notion API constraints

- `last_edited_time` rounds to the minute. See `.claude/rules/drift.md`.
- `incrementPageNumber` (used for the Installs counter) is fail-soft — install succeeds even if the metric PATCH fails. Don't await its result for control flow.
- Self-healing selects (`Tags`, `Model`, `Agent`) auto-add unknown options on publish via `ensureSelectOptions`. Don't pre-populate the option list in `SCHEMA`; let it grow naturally.

## Build / test loop

`npm test` runs `tsc` first, then `node --test test/*.test.mjs`. Tests import from `dist/`, so a stale build silently runs the old code. When debugging "test pass on my machine but fails in CI," run `npm run build && npm test` clean first.
