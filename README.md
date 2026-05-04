# notion-skills

> Sync agent skills from a Notion database to Claude Code, Codex, OpenCode, Cursor, and Gemini CLI.

[![npm](https://img.shields.io/npm/v/@brianlovin/notion-skills.svg)](https://www.npmjs.com/package/@brianlovin/notion-skills)

## What is this?

Modern AI coding agents (Claude Code, Codex, OpenCode, Cursor, Gemini CLI) all read **skills** — directories with a `SKILL.md` file that tells the agent what to do and when to do it. They all use the same convention but each looks in a different folder, and authoring skills as files in your `~/.claude/skills/` directory means using a code editor + git for what's basically content management.

`notion-skills` lets your team author skills as **rows in a Notion database**, then syncs them down to whichever agent CLIs you use:

- ✏️ **Author in Notion's UI** — page title is the skill name, properties map to frontmatter, page body is the SKILL.md content. No git, no markdown editor, no PR review.
- 👥 **Share across a team** — point teammates at the same Notion DB; each runs `sync` to get the same skills.
- 🎯 **Multi-agent** — one source of truth, fan out to every agent CLI you use. Skills land via symlinks so an edit in Notion updates every CLI on the next sync.
- 🔍 **Selectively sync** — tag-based filtering means a 200-skill team DB can hand each engineer just the 30 they care about.

## Prerequisites

You need three things before installing:

1. **macOS or Linux.** Windows isn't supported yet (symlinks need admin/dev mode).
2. **Node.js 18+.** Check with `node --version`.
3. **`ntn` 0.12 or newer + `ntn login`.** This is Notion's official CLI; `notion-skills` piggybacks on it for all API access (no separate OAuth flow, no integration to register).

### Install and authenticate `ntn`

```bash
# Install ntn (one of):
brew install ntn
# or download from https://github.com/makenotion/ntn-cli

# Verify version
ntn --version
# → ntn 0.12.0 (or newer)

# Log in to your Notion workspace
ntn login

# Confirm everything's wired up
ntn doctor
# → CLI version        ✔
# → Default workspace  ✔
# → Token valid        ✔
```

If `ntn doctor` is green, you're ready.

## Install

```bash
npm install -g @brianlovin/notion-skills
notion-skills --version
# → 0.1.0
```

## Quick start

The fastest path from zero to skills syncing in under five minutes:

```bash
# 1. Install ntn + log in (see Prerequisites)
brew install ntn && ntn login

# 2. Install notion-skills
npm install -g @brianlovin/notion-skills

# 3. Run the wizard — it does everything
notion-skills init
```

`init` is a guided wizard. It asks:

1. **Scope** — global (per-machine, syncs to `~/.claude/skills/` etc.) or project (per-repo, syncs to `<repo>/.claude/skills/`).
2. **Database** — paste the URL of an existing Notion database, or create a fresh one under a parent page.
3. **Schema upgrade** — auto-runs if your DB is missing the properties skill spec needs.
4. **Targets** — which agent CLIs to sync to (Claude Code, Codex, OpenCode, Cursor, Gemini).
5. **Tag filter** — optional. Pick include/exclude tags so you only get the skills you care about.
6. **Migrate locals** — if you already have skills in `~/.claude/skills/`, it offers to push them up to Notion.
7. **First sync** — pulls everything down as symlinks.

Now you can:

- Edit skills in Notion's UI.
- Run `notion-skills sync` to pick up changes.
- Type `/skill-name` in any of your agent CLIs to use them.

## What's a "skill"?

A skill is a directory containing a `SKILL.md` file. The frontmatter tells the agent CLI what the skill does and when to use it; the body is the content the agent reads when invoked.

```markdown
---
name: deslop
description: Remove AI-generated code slop from the current branch. Use after writing code to clean up unnecessary comments, defensive checks, and inconsistent style.
---

# Remove AI code slop

Check the diff against main and remove all AI-generated slop introduced in this branch...
```

In Notion, that becomes a database row:
- **Page title**: `deslop`
- **Description property**: the one-liner that goes in the frontmatter
- **Page body**: the markdown content

`notion-skills sync` reads each row and writes a `SKILL.md` to your central store, then symlinks it into every target CLI's directory.

## Commands

| Command | What it does |
|---|---|
| `notion-skills init` | Guided wizard for first-time setup. |
| `notion-skills sync [names…]` | Pull pages, write skills, reconcile target dirs. Skips unchanged pages. |
| `notion-skills status` | Show auth, scope, filter, per-target symlink health. |
| `notion-skills doctor [--fix]` | Inspect for drift; safe auto-repairs with `--fix`. |
| `notion-skills list` | Print every page in the DB with status: ✓ synced / ✗ filtered / ○ available / ! invalid. |
| `notion-skills upgrade` | Add any missing skill-spec properties to your Notion DB schema. |
| `notion-skills migrate [--from <path>] [--overwrite] [--dry-run]` | Push existing local skills into Notion, sync back as symlinks. |
| `notion-skills tags` | Interactive include/exclude tag filter editor. |
| `notion-skills login` / `logout` | Thin wrappers over `ntn login` / `ntn logout`. |

Run any command with `--help` for full options.

### `init` — first-time setup

```bash
notion-skills init                    # auto-detect scope (project if found, else global)
notion-skills init --global           # force global scope (~/.notion-skills/scope.json)
notion-skills init --project          # force project scope (./notion-skills.json)
```

### `sync` — pull skills from Notion

```bash
notion-skills sync                    # sync the active scope
notion-skills sync docker terraform   # one-off: force-include these skills for this run
notion-skills sync --global           # sync the global scope explicitly
notion-skills sync --project          # sync the project scope explicitly
notion-skills sync --all              # sync both global and project (rare)
```

`sync` is incremental — it only re-fetches pages whose `last_edited_time` or properties have changed since the last sync.

### `migrate` — move existing skills into Notion

If you already have skills authored on disk:

```bash
notion-skills migrate                                   # scans your scope's target dirs
notion-skills migrate --from ~/Developer/skill-repo     # plus an extra source
notion-skills migrate --overwrite                       # replace existing Notion pages
notion-skills migrate --dry-run                         # preview, don't write anything
notion-skills migrate -y                                # skip confirmation
```

`migrate` writes Notion pages first; only after every page is created does it move local copies to a backup at `~/.notion-skills/backup/migrate-<timestamp>/`. A failure mid-flight leaves locals untouched.

### `doctor` — diagnose drift

```bash
notion-skills doctor                  # read-only: prints status of every check
notion-skills doctor --fix            # auto-fix safe issues (interactive y/n per fix)
```

Checks: ntn install + auth, scope existence, schema match, manifest vs central-store consistency, per-target symlink health.

## Concepts

### Two scopes

**Global scope** is per-machine. State lives at `~/.notion-skills/` and syncs to your home-dir agent paths (`~/.claude/skills/`, `~/.codex/skills/`, etc.). Configured via `notion-skills init` (default).

**Project scope** is per-repo. State is split:
- `<repo>/.notion-skills.json` — committable config (database ID, filter)
- `<repo>/.notion-skills.lock` — local sync manifest (gitignore me)
- `<repo>/.claude/skills/<name>/` — generated skills (gitignore me)

Use project scope to share a fixed skill set across a team via the repo. Configured via `notion-skills init --project`.

### Five supported agents

| Agent | Skills directory |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Codex CLI | `~/.codex/skills/` |
| OpenCode | `~/.config/opencode/skills/` |
| Cursor | `~/.cursor/skills/` |
| Gemini CLI | `~/.gemini/skills/` |

Pick any combination during `init`. Adding a new agent is one entry in [`src/known-targets.ts`](src/known-targets.ts) — PRs welcome.

### Filtering — only the skills you care about

A team's Notion DB might have hundreds of skills. Edit `~/.notion-skills/scope.json` to filter:

```jsonc
{
  "filter": {
    "include_tags": ["frontend", "tooling"],
    "exclude_tags": ["legacy"],
    "include_skills": ["docker"],   // always include, regardless of tags
    "exclude_skills": ["broken"]    // always exclude
  }
}
```

Resolution order: `exclude_skills` → `include_skills` → `include_tags` → `exclude_tags` → keep.

Or use the interactive editor:

```bash
notion-skills tags
```

### Schema

`init` and `upgrade` provision/maintain these Notion database properties. You don't author them by hand.

| Property | Frontmatter key | Type |
|---|---|---|
| `Name` | `name` (slugified from title) | title |
| `Description` | `description` | rich_text |
| `When To Use` | `when_to_use` | rich_text |
| `Argument Hint` | `argument-hint` | rich_text |
| `Arguments` | `arguments` | rich_text (space-sep) |
| `Allowed Tools` | `allowed-tools` | rich_text (space-sep, paren-aware) |
| `Paths` | `paths` | rich_text (comma-sep) |
| `Disable Model Invocation` | `disable-model-invocation` | select (default/true/false) |
| `User Invocable` | `user-invocable` | select (default/true/false) |
| `Model` | `model` | select (self-healing) |
| `Effort` | `effort` | select |
| `Context` | `context` | select |
| `Agent` | `agent` | select (self-healing) |
| `Shell` | `shell` | select |
| `Tags` | (internal — used for filtering) | multi_select |

**Self-healing selects** (`Model`, `Agent`) auto-add new options when migrate encounters them — so you can use `agent: my-custom-subagent` without pre-registering the option.

**Spec defaults** for `Disable Model Invocation`, `User Invocable`, `Shell`, etc. are encoded as a `default` option. Empty cells also count as default — both omit the frontmatter key when syncing back to disk.

## Common workflows

### Adding a new skill

1. In Notion, add a row to your skills DB.
2. Set `Name` (becomes the slug), `Description` (the when-to-use hint), and any other properties you care about.
3. Write the skill instructions in the page body.
4. Run `notion-skills sync` (or wait until your next sync).

### Editing a skill

1. Edit the page in Notion.
2. Run `notion-skills sync`.

`sync` is incremental — only edited pages are re-fetched.

### Sharing a curated skill set with a team via a repo

```bash
cd my-team-repo
notion-skills init --project
# pick the team's Notion DB
# pick targets and tags
# config gets written to ./.notion-skills.json
git add .notion-skills.json
echo ".notion-skills.lock" >> .gitignore
echo ".claude/skills/" >> .gitignore
git commit -m "Configure notion-skills"
```

Teammates clone the repo and run `notion-skills sync` — they get the same skill set under `<repo>/.claude/skills/`.

### Migrating from `~/.claude/skills/` files

If you've been authoring skills as files (or symlinks from a shared repo like agent-config), upload them into Notion in one shot:

```bash
notion-skills migrate                              # scan your scope's target dirs
notion-skills migrate --from ~/Developer/agents    # plus a custom path
```

Locals are moved to `~/.notion-skills/backup/migrate-<ts>/` after Notion confirms each write. The next sync re-creates them as symlinks pointing at your central store.

## Files this CLI touches

```
~/.notion-skills/
├── scope.json              # global: db, targets, filter
├── manifest.json           # global sync state (atomic writes)
├── skills/<name>/          # global central source-of-truth
└── backup/migrate-<ts>/    # local copies displaced during migrate

~/.claude/skills/<name>     → symlink → ~/.notion-skills/skills/<name>
~/.codex/skills/<name>      → symlink → ~/.notion-skills/skills/<name>
~/.cursor/skills/<name>     → symlink → ~/.notion-skills/skills/<name>
~/.config/opencode/skills/<name> → symlink → ~/.notion-skills/skills/<name>
~/.gemini/skills/<name>     → symlink → ~/.notion-skills/skills/<name>

<repo>/.notion-skills.json     # project: committable scope config
<repo>/.notion-skills.lock     # project sync state (gitignore me)
<repo>/.claude/skills/<name>/  # project skills (gitignore me)
```

Auth lives in `ntn`'s store (OS keychain by default). `rm -rf ~/.notion-skills` wipes notion-skills state without affecting auth.

## Troubleshooting

`notion-skills doctor` is the first stop. It reports status across ntn auth, scope, schema, manifest consistency, and symlink health.

### Common errors

Errors print a one-line summary plus a suggested next command. The most common cases:

| Error | Fix |
|---|---|
| "Notion auth has expired" | `ntn login` |
| "Schema doesn't match" | `notion-skills upgrade` |
| "isn't configured yet" | `notion-skills init` |
| "Could not find database" | Check the URL/ID; ensure ntn is in the right workspace (`ntn doctor`). |
| "ntn is too old" | `ntn update` |
| "Couldn't reach the Notion API" | Check your network. |

### Resetting from scratch

```bash
# Wipe all notion-skills local state (keeps auth and your Notion DB intact)
rm -rf ~/.notion-skills
notion-skills init
```

### Restoring a migrate backup

`migrate` moves originals to `~/.notion-skills/backup/migrate-<ts>/`. To restore:

```bash
ls ~/.notion-skills/backup/
# pick the timestamp you want to restore from
mv ~/.notion-skills/backup/migrate-<ts>/<skill-name> ~/.claude/skills/
```

## Limitations

- **macOS and Linux only.** Windows symlink support is on the list.
- **Round-trip normalisation.** Notion's markdown parser normalises some content on ingest:
  - YAML wraps long descriptions across lines
  - Multi-line markdown paragraphs become separate Notion blocks
  - Code-language aliases get expanded (`ts` → `typescript`)
  - Table separators get standardised
  - Bare domains (`example.com`) get auto-linked
- **Performance.** Each Notion call shells out to `ntn`, which adds ~50–100ms per call. A sync of 100 skills with deeply-nested blocks takes a few minutes. Subsequent syncs are fast (incremental).
- **Auth scope.** `notion-skills` sees whatever `ntn` is logged into. Switch workspaces with `ntn login`.

## Contributing

```bash
git clone https://github.com/brianlovin/notion-skills
cd notion-skills
npm install
npm run build
npm test                # 105 tests
npm link                # use the local build globally
```

Source layout:
- `src/cli.ts` — commander entry point
- `src/commands/` — one file per CLI subcommand
- `src/notion.ts` — Notion API client (shells out to `ntn`)
- `src/sync.ts`, `src/migrate.ts` — pure logic; importable from anywhere
- `src/schema.ts` — single source of truth for the property → frontmatter mapping
- `src/known-targets.ts` — the registry of supported agent CLIs
- `src/errors.ts` — friendly error translator

Adding a new agent: append a `TargetDef` to `KNOWN_TARGETS` in `src/known-targets.ts`. Tests in `test/known-targets.test.mjs` will pin the change.

PRs run `Build + test` against Node 18 / 20 / 22 on Ubuntu via [`.github/workflows/test.yml`](.github/workflows/test.yml). All checks must pass before merge.

## Releasing

Releases are automated. To cut a new version:

```bash
npm version patch          # 0.1.0 → 0.1.1 (or `minor`, `major`)
git push --follow-tags
```

The `Release` workflow on `main` ([`.github/workflows/release.yml`](.github/workflows/release.yml)) detects the version bump in `package.json`, builds, tests, publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements), and creates a GitHub Release with auto-generated notes.

Setup (one-time, already done for this repo):
1. Generate a Granular Access Token at https://www.npmjs.com/settings/~/tokens with publish access scoped to `@brianlovin/notion-skills`.
2. Add it to the repo as `NPM_TOKEN`: `gh secret set NPM_TOKEN`.

## License

MIT
