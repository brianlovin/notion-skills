# notion-skills

App-store-style CLI for AI coding agent skills. A Notion database is the workspace skill store; users `install` what they want, `publish` what they author, `sync` to keep installed skills up to date. See [README](README.md) for the user-facing docs and command reference.

## Rules

- [Architecture](.claude/rules/architecture.md) — invariants: ntn-only, schema SoT, pure helpers, build boundary
- [State](.claude/rules/state.md) — `~/.notion-skills/` layout, manifest entry shape, app-store rules
- [Drift detection](.claude/rules/drift.md) — props_hash + body_hash, two-phase outdated check, `hash_v` migration
- [Gotchas](.claude/rules/gotchas.md) — sync orchestration, gen contract, default views, Notion API quirks

## Verification

After making changes:

- `npm test` — runs `tsc` then `node --test test/*.test.mjs`.
- For CLI/UX changes, exercise via `notion-skills <subcommand>` against the live Notion store (`npm link` resolves it to the local build).
- If you edit `skills/notion-skills-usage/SKILL.md`, run `npx intent validate` — it runs in `prepublishOnly` and gates publish.

When fixing a bug, prefer "extract pure helper, write regression test, fix" over patching the orchestrator in place.

## Workflow

For non-trivial work, the global workflow skill at `~/.claude/skills/workflow/SKILL.md` is the playbook (plan mode, subagents, self-improvement loop, verification, elegance checks). Don't duplicate it here.
