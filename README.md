# notion-skills

Sync skills from a Notion database to your AI coding agents.

Edit your skills in Notion's UI (no git, no markdown editor). Run `notion-skills sync` and they land in your agent's skills directory ready for `/skill-name` invocation.

## Supported agents

Pick any combination as sync targets during `notion-skills init`. The same skills land in every selected agent's directory.

| Agent | Path | Docs |
|---|---|---|
| Claude Code | `~/.claude/skills/` | [code.claude.com](https://code.claude.com/docs/en/skills) |
| Codex CLI | `~/.codex/skills/` | [openai/codex](https://github.com/openai/codex) |
| OpenCode | `~/.config/opencode/skills/` | [opencode.ai](https://opencode.ai/docs/skills) |
| Cursor | `~/.cursor/skills/` | [docs.cursor.com](https://docs.cursor.com) |
| Gemini CLI | `~/.gemini/skills/` | [geminicli.com](https://geminicli.com/docs/cli/tutorials/skills-getting-started/) |

Adding a new agent is one entry in [`src/known-targets.ts`](src/known-targets.ts) — PRs welcome.

## Auth: piggybacks on `ntn`

notion-skills uses **[`ntn`](https://github.com/makenotion/ntn-cli)** — Notion's official CLI — for all Notion API access. There's no separate OAuth flow, no integration to register, no client secrets to manage.

```bash
brew install ntn          # or however ntn ships
ntn login
npm install -g notion-skills
notion-skills init
```

Requires `ntn` 0.12 or newer (data-source APIs).

## Quick start

1. **Create a Notion database.** Any title — `Skills`, `Team Skills`, etc. notion-skills will provision the right schema for you.

2. **Run init.** It walks you through everything:
   ```bash
   notion-skills init
   ```
   - picks scope (global or project)
   - picks an existing DB or creates a new one
   - upgrades the schema to current spec
   - detects local skills already on disk and offers to migrate them
   - runs the first sync

3. **Edit skills in Notion.** Each row is a skill. The page title is the slug; the `Description` property is shown to Claude/Codex/etc.; the page body is the SKILL.md content.

4. **Re-sync whenever:**
   ```bash
   notion-skills sync
   ```

## Schema

`notion-skills init` and `notion-skills upgrade` create/maintain these properties. You don't have to set them up yourself.

| Property | Frontmatter key | Notion type |
|---|---|---|
| `Name` | `name` (slugified) | title |
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
| `Tags` | (internal — used by filter) | multi_select |

Selects with a `default` option mean "use the spec default" — empty cells equal default too. Self-healing selects auto-add new options when migrate encounters them.

## Two scopes

### Global

Skills sync to `~/.claude/skills/`, `~/.codex/skills/`, etc. — wherever you picked. Configured per-machine. State at `~/.notion-skills/`.

### Project

Run `notion-skills init --project` inside a repo. Writes `.notion-skills.json` you can commit. Teammates clone the repo, run `notion-skills sync`, and get the same skills under `<repo>/.claude/skills/`.

```
myrepo/
├── .notion-skills.json   ← commit this
└── .claude/
    └── skills/<name>/    ← gitignored, regenerated on sync
```

`notion-skills sync` from inside a repo with `.notion-skills.json` syncs the project scope. From elsewhere, the global scope. Pass `--global` / `--project` / `--all` to override.

## Filters

The DB might have hundreds of skills; you probably want a subset.

```jsonc
// ~/.notion-skills/scope.json
{
  "filter": {
    "include_tags": ["frontend", "tooling"],
    "exclude_tags": ["legacy"],
    "include_skills": ["docker"],   // always include, ignoring tags
    "exclude_skills": ["broken"]    // always exclude
  }
}
```

Resolution: `exclude_skills` → `include_skills` → `include_tags` → `exclude_tags` → keep.

```bash
notion-skills tags                    # interactive include/exclude
notion-skills sync docker terraform   # one-off force-include for this run
```

## Migrating existing skills

If you already have skills on disk:

```bash
notion-skills migrate                                   # scans configured target dirs
notion-skills migrate --from ~/Developer/skill-repo     # plus an extra source
notion-skills migrate --overwrite                       # replace existing Notion pages
notion-skills migrate --dry-run                         # preview only
```

Notion writes happen first; local sources are only moved to backup *after* Notion confirms the writes. If anything fails, locals stay intact. Backup lands at `~/.notion-skills/backup/migrate-<ts>/`.

## Commands

| Command | What it does |
|---|---|
| `init` | Wizard: pick DB, pick targets, upgrade schema, migrate locals, run first sync. |
| `sync [names…]` | Pull pages, write skills, reconcile target dirs. Skips unchanged pages. |
| `list` | Print every page in the DB with status: ✓ synced / ✗ filtered / ○ available / ! invalid. |
| `status` | Show auth, scope, filter, and per-target symlink health. |
| `doctor [--fix]` | Inspect for drift; safe auto-repairs with `--fix`. |
| `upgrade` | Add any missing skill-spec properties to your Notion DB schema. |
| `migrate [--from <path>] [--overwrite]` | Push existing local skills into Notion, sync back as symlinks. |
| `tags` | Interactive include/exclude tag filter editor. |
| `login` / `logout` | Thin wrappers over `ntn login` / `ntn logout`. |

## Files this CLI touches

```
~/.notion-skills/
├── scope.json              # global scope: db, targets, filter
├── manifest.json           # global manifest (atomic writes)
├── skills/<name>/          # central source-of-truth for global scope
└── backup/migrate-<ts>/    # local copies displaced during migrate

~/.claude/skills/<name>     → symlink → ~/.notion-skills/skills/<name>
~/.codex/skills/<name>      → symlink → ~/.notion-skills/skills/<name>
~/.cursor/skills/<name>     → symlink → ~/.notion-skills/skills/<name>
~/.config/opencode/skills/<name> → symlink → ~/.notion-skills/skills/<name>
~/.gemini/skills/<name>     → symlink → ~/.notion-skills/skills/<name>

<repo>/.notion-skills.json     # project scope (committable)
<repo>/.notion-skills.lock     # project manifest (gitignore me)
<repo>/.claude/skills/<name>/  # project skills (gitignore me)
```

Auth lives in `ntn`'s store (OS keychain by default). `rm -rf ~/.notion-skills` wipes notion-skills state without affecting auth.

## Troubleshooting

```bash
notion-skills doctor          # inspect everything; print actionable hints
notion-skills doctor --fix    # auto-repair safe cases
```

Common errors print a one-line summary plus a suggested next command. Examples: schema drift → `notion-skills upgrade`; auth expired → `ntn login`; missing scope → `notion-skills init`.

## Limitations

- macOS and Linux only for now (Windows symlink support is on the list).
- Long markdown paragraphs round-trip as separate Notion blocks — Notion treats line breaks as block boundaries.
- ntn must be installed and authenticated; all Notion API access goes through it.

## License

MIT
