# notion-skills

> Author agent skills in Notion. Sync them to Claude, Codex, OpenCode, Cursor, and Gemini.

[![npm](https://img.shields.io/npm/v/@brianlovin/notion-skills.svg?cacheSeconds=300)](https://www.npmjs.com/package/@brianlovin/notion-skills)

## Why notion-skills?

AI coding agents all read **skills** — small `SKILL.md` files that tell the agent what to do and when to do it. The format is shared, but each agent reads from its own folder, and authoring skills means tending little markdown files in git.

`notion-skills` flips that: skills live as rows in a Notion database, and one command syncs them to every agent CLI you use.

- ✏️ **Edit in Notion's UI.** Title is the skill name, properties become frontmatter, page body is the SKILL.md content. No editor, no git, no PR review.
- 👥 **Share with a team.** Point teammates at the same database; everyone runs `sync` and stays aligned.
- 🎯 **One source, many agents.** Skills land as symlinks, so one edit in Notion updates Claude, Codex, Cursor, OpenCode, and Gemini at once.
- ⚡ **Incremental.** Only changed pages re-fetch on `sync`.

## Requirements

- macOS or Linux. Windows isn't supported yet (symlinks).
- Node.js 18+.
- [`ntn`](https://github.com/makenotion/cli) 0.12+, logged in. `notion-skills` uses it for every Notion API call — no separate OAuth, no integration to register.

```bash
brew install ntn   # or download from github.com/makenotion/cli
ntn login
```

## Install

```bash
npm install -g @brianlovin/notion-skills
```

## Quick start

```bash
notion-skills init
```

The wizard walks you through:

1. **Database** — creates a new Skills database (default, opens in your browser) or links one you already have.
2. **Targets** — auto-checks every agent CLI installed on your machine.
3. **Migrate** — if you already have skills on disk, picks which to upload to Notion.

Then any time you want to pull updates:

```bash
notion-skills sync
```

Type `/skill-name` in any agent CLI to use them.

## What's a skill?

A directory with a `SKILL.md` file. Frontmatter tells the agent when to use the skill; body is the content the agent reads.

```markdown
---
name: deslop
description: Remove AI-generated code slop from the current branch.
---

Check the diff against main and remove unnecessary comments,
defensive checks, and inconsistent style introduced in this branch.
```

In Notion that's a row with the title `deslop`, a `Description` property, and the body written in the page itself. `notion-skills sync` reads each row, writes a `SKILL.md` to a central store at `~/.notion-skills/skills/`, and symlinks it into every target dir.

## Commands

| Command | What it does |
|---|---|
| `init` | Guided first-time setup. |
| `sync` | Pull from Notion AND push local edits to skills already in Notion. New local skills (not yet tracked) need `init` or `migrate`. Conflicts resolved last-edit-wins; Notion's page history is the safety net. |
| `migrate` | Push existing local skills to Notion in bulk. Flags: `--from <path>` (extra source), `--overwrite`, `--dry-run`, `-y` (skip confirm). |
| `list` | Print every page with sync status. |
| `status` | Show auth, scope, and per-target symlink health. |
| `doctor [--fix]` | Inspect for drift. `--fix` repairs safe issues. |
| `upgrade` | Add any missing skill-spec properties to your Notion DB schema. |
| `login` / `logout` | Wrappers over `ntn login` / `ntn logout`. |

Add `--help` to any command for full options.

## Supported agents

| Agent | Skills directory |
|---|---|
| Claude | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| OpenCode | `~/.config/opencode/skills/` |
| Cursor | `~/.cursor/skills/` |
| Gemini | `~/.gemini/skills/` |

Adding another is one entry in [`src/known-targets.ts`](src/known-targets.ts) — PRs welcome.

## Excluding skills

`sync` syncs every skill in the database. To skip one on this machine, add its slug to `exclude_skills` in `~/.notion-skills/scope.json`:

```jsonc
{
  "database_id": "...",
  "data_source_id": "...",
  "targets": ["claude", "codex"],
  "exclude_skills": ["broken-skill"]
}
```

There's no command for this — denylists are rare enough that hand-editing is the right knob.

## File layout

```
~/.notion-skills/
├── scope.json              database id, sync targets, optional excludes
├── manifest.json           sync state
├── skills/<name>/          central source-of-truth (Notion → here)
└── backup/migrate-<ts>/    local copies displaced during migrate

~/.claude/skills/<name>          → symlink → ~/.notion-skills/skills/<name>
~/.codex/skills/<name>           → symlink
~/.cursor/skills/<name>          → symlink
~/.config/opencode/skills/<name> → symlink
~/.gemini/skills/<name>          → symlink
```

Auth lives in `ntn`'s store (OS keychain). `rm -rf ~/.notion-skills` wipes local state without touching your auth or your Notion database.

## Troubleshooting

`notion-skills doctor` is the first stop. It checks ntn auth, scope, schema, manifest, and symlinks.

| Error | Fix |
|---|---|
| Notion auth expired / token invalid | `ntn logout && ntn login` |
| Schema doesn't match | `notion-skills upgrade` |
| isn't configured yet | `notion-skills init` |
| Could not find database | Check the URL; verify `ntn doctor` is in the right workspace |
| ntn is too old | `ntn update` |

**Reset from scratch:**

```bash
rm -rf ~/.notion-skills    # keeps auth + Notion DB intact
notion-skills init
```

**Restore a migrate backup:**

`migrate` moves originals to `~/.notion-skills/backup/migrate-<ts>/`. Restore by hand:

```bash
ls ~/.notion-skills/backup/
mv ~/.notion-skills/backup/migrate-<ts>/<skill-name> ~/.claude/skills/
```

## Schema reference

`init` and `upgrade` maintain these properties. You don't author them by hand.

| Property | Frontmatter key | Type |
|---|---|---|
| `Name` | `name` (slug from title) | title |
| `Description` | `description` | rich_text |
| `When To Use` | `when_to_use` | rich_text |
| `Argument Hint` | `argument-hint` | rich_text |
| `Arguments` | `arguments` | rich_text (space-sep) |
| `Allowed Tools` | `allowed-tools` | rich_text (space-sep, paren-aware) |
| `Paths` | `paths` | rich_text (comma-sep) |
| `Disable Model Invocation` | `disable-model-invocation` | select |
| `User Invocable` | `user-invocable` | select |
| `Model` | `model` | select (self-healing) |
| `Effort` | `effort` | select |
| `Context` | `context` | select |
| `Agent` | `agent` | select (self-healing) |
| `Shell` | `shell` | select |

**Self-healing selects** (`Model`, `Agent`) auto-add new options on migrate, so `agent: my-custom-subagent` works without pre-registering.

**Defaults** (`disable-model-invocation: false`, `user-invocable: true`, `shell: bash`) are omitted from frontmatter when syncing back to disk.

## Limitations

- **macOS and Linux only.** Windows symlink support is on the list.
- **Round-trip normalisation.** Notion's markdown parser tweaks some content on ingest — long YAML descriptions wrap, multi-line paragraphs split into blocks, code-language aliases expand (`ts` → `typescript`), bare domains autolink. After a push, `sync` immediately re-pulls so your local file matches Notion's normalised version; expect minor reformatting of pushed edits.
- **Conflict resolution is dumb.** When a skill changed on both sides since the last sync, the newer side wins outright — no merge. Notion's page history can restore the loser.
- **Removing a frontmatter key locally doesn't clear it in Notion.** Local pushes only set values that are present; an absent key is treated as "no change" rather than "clear". To unset a property, edit the Notion page directly.
- **Performance.** Each API call shells out to `ntn` (~50–100 ms). A first sync of 100 deeply-nested skills takes minutes; subsequent syncs are fast (incremental).

## Contributing

```bash
git clone https://github.com/brianlovin/notion-skills
cd notion-skills
npm install && npm test
npm link    # use locally
```

Source layout:

- `src/cli.ts` — commander entry
- `src/commands/` — one file per subcommand
- `src/notion.ts` — Notion API client (shells out to `ntn`)
- `src/sync.ts`, `src/migrate.ts` — orchestration
- `src/schema.ts` — single source of truth for property → frontmatter mapping
- `src/known-targets.ts` — registry of supported agent CLIs

PRs run `Build + test` against Node 18 / 20 / 22 on Ubuntu. All checks must pass.

## Releasing

Push to `main` with a bumped `version` in `package.json`. The release workflow ([npm OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — no `NPM_TOKEN`) detects the bump, builds, tests, publishes with provenance, and creates a GitHub Release.

## License

MIT
