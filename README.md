# notion-skills

> Sync agent skills from a Notion database to Claude Code, Codex, OpenCode, Cursor, and Gemini CLI.

[![npm](https://img.shields.io/npm/v/@brianlovin/notion-skills.svg?cacheSeconds=300)](https://www.npmjs.com/package/@brianlovin/notion-skills)

## What is this?

Modern AI coding agents (Claude Code, Codex, OpenCode, Cursor, Gemini CLI) all read **skills** — directories with a `SKILL.md` file that tells the agent what to do and when to do it. They all use the same convention but each looks in a different folder, and authoring skills as files in your `~/.claude/skills/` directory means using a code editor + git for what's basically content management.

`notion-skills` lets your team author skills as **rows in a Notion database**, then syncs them down to whichever agent CLIs you use:

- ✏️ **Author in Notion's UI** — page title is the skill name, properties map to frontmatter, page body is the SKILL.md content. No git, no markdown editor, no PR review.
- 👥 **Share across a team** — point teammates at the same Notion DB; each runs `sync` to get the same skills.
- 🎯 **Multi-agent** — one source of truth, fan out to every agent CLI you use. Skills land via symlinks so an edit in Notion updates every CLI on the next sync.

## Prerequisites

You need three things before installing:

1. **macOS or Linux.** Windows isn't supported yet (symlinks need admin/dev mode).
2. **Node.js 18+.** Check with `node --version`.
3. **`ntn` 0.12 or newer + `ntn login`.** This is Notion's official CLI; `notion-skills` piggybacks on it for all API access (no separate OAuth flow, no integration to register).

### Install and authenticate `ntn`

```bash
# Install ntn (one of):
brew install ntn
# or download from https://github.com/makenotion/cli

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

1. **Database** — by default, creates a new Skills database at your workspace root and opens it in your browser. You can also link an existing one by URL.
2. **Schema upgrade** — auto-runs if your DB is missing the properties the skill spec needs.
3. **Targets** — which agent CLIs to sync to (Claude Code, Codex, OpenCode, Cursor, Gemini). Defaults to whichever you have installed.
4. **Migrate locals** — if you already have skills in `~/.claude/skills/` etc., it offers to push them up to Notion in one shot.

Then run `notion-skills sync` to pull everything down as symlinks into your selected target dirs.

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
| `notion-skills sync` | Pull pages, write skills, reconcile target dirs. Skips unchanged pages. Offers to upload local-only skills after pulling. |
| `notion-skills status` | Show auth, scope, per-target symlink health. |
| `notion-skills doctor [--fix]` | Inspect for drift; safe auto-repairs with `--fix`. |
| `notion-skills list` | Print every page in the DB with status: ✓ synced / ✗ excluded / ○ available / ! invalid. |
| `notion-skills upgrade` | Add any missing skill-spec properties to your Notion DB schema. |
| `notion-skills migrate [--from <path>] [--overwrite] [--dry-run]` | Push existing local skills into Notion, sync back as symlinks. |
| `notion-skills login` / `logout` | Thin wrappers over `ntn login` / `ntn logout`. |

Run any command with `--help` for full options.

### `init` — first-time setup

```bash
notion-skills init
```

Walks you through connecting (or creating) a Notion database, picking which agent CLIs to sync to, and uploading any local skills you already have. Idempotent — safe to re-run.

### `sync` — pull skills from Notion

```bash
notion-skills sync                    # pull the latest from Notion
```

`sync` is incremental — it only re-fetches pages whose `last_edited_time` or properties have changed since the last sync.

If a page in Notion has been trashed since the last sync, `sync` prompts before deleting the local copy (default: keep). Local skills that don't exist in Notion are surfaced after the pull, with an option to upload them.

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

### One scope, per machine

State lives at `~/.notion-skills/` and fans out via symlinks to your home-dir agent paths (`~/.claude/skills/`, `~/.codex/skills/`, etc.). The same skills are available across every repo and every agent CLI you use.

> **For repo-specific skills**, just author SKILL.md files directly in `<repo>/.claude/skills/` and commit them. Notion is great for cross-repo skills you author and share with your team; git is the right tool for skills tied to a single codebase.

### Five supported agents

| Agent | Skills directory |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Codex CLI | `~/.codex/skills/` |
| OpenCode | `~/.config/opencode/skills/` |
| Cursor | `~/.cursor/skills/` |
| Gemini CLI | `~/.gemini/skills/` |

Pick any combination during `init`. Adding a new agent is one entry in [`src/known-targets.ts`](src/known-targets.ts) — PRs welcome.

### Excluding specific skills

`sync` syncs every skill in the database by default. If there's a skill you don't want on this machine, add its slug to the optional `exclude_skills` array in `~/.notion-skills/scope.json`:

```jsonc
{
  "database_id": "...",
  "data_source_id": "...",
  "targets": ["claude", "codex"],
  "exclude_skills": ["broken-skill"]
}
```

There's no command for this — denylists are rare enough that hand-editing the JSON is the right knob.

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

### Sharing a curated skill set with a team

Everyone on the team runs `notion-skills init` once and points at the team's Notion database. From then on, `notion-skills sync` keeps everyone aligned. Editing in Notion is the canonical path; new skills authored by anyone propagate to teammates the next time they sync.

### Migrating from `~/.claude/skills/` files

If you've been authoring skills as files (or symlinks from a shared repo like agent-config), `init` already detects them and offers to upload in one shot. To re-run that step later:

```bash
notion-skills migrate                              # scan your configured target dirs
notion-skills migrate --from ~/Developer/agents    # plus a custom path
```

Locals are moved to `~/.notion-skills/backup/migrate-<ts>/` after Notion confirms each write. The next sync re-creates them as symlinks pointing at your central store.

## Files this CLI touches

```
~/.notion-skills/
├── scope.json              # database id, sync targets, optional exclude list
├── manifest.json           # sync state (atomic writes)
├── skills/<name>/          # central source-of-truth
└── backup/migrate-<ts>/    # local copies displaced during migrate

~/.claude/skills/<name>          → symlink → ~/.notion-skills/skills/<name>
~/.codex/skills/<name>           → symlink → ~/.notion-skills/skills/<name>
~/.cursor/skills/<name>          → symlink → ~/.notion-skills/skills/<name>
~/.config/opencode/skills/<name> → symlink → ~/.notion-skills/skills/<name>
~/.gemini/skills/<name>          → symlink → ~/.notion-skills/skills/<name>
```

Auth lives in `ntn`'s store (OS keychain by default). `rm -rf ~/.notion-skills` wipes notion-skills state without affecting auth.

## Troubleshooting

`notion-skills doctor` is the first stop. It reports status across ntn auth, scope, schema, manifest consistency, and symlink health.

### Common errors

Errors print a one-line summary plus a suggested next command. The most common cases:

| Error | Fix |
|---|---|
| "Notion auth has expired" or "API token is invalid" | `ntn logout && ntn login` (the full reset; `ntn login` alone sometimes leaves a stuck token even when `ntn doctor` reports green) |
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

Auth uses [npm OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — no `NPM_TOKEN` secret. npm mints a short-lived token at publish time, verified against this repo + the `release.yml` workflow path via the GitHub OIDC provider. The trusted publisher config lives at the [package's npm access page](https://www.npmjs.com/package/@brianlovin/notion-skills/access).

## License

MIT
