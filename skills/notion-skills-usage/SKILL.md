---
name: notion-skills-usage
description: Use the notion-skills CLI to manage AI agent skills from a Notion-backed workspace store. Invoke when the user wants to install a skill from their team's store, publish a local skill they authored, sync installed skills, generate a new skill via their coding agent, or inspect the state of installed/available/outdated/draft skills.
metadata:
  sources:
    - README.md
    - CLAUDE.md
    - .claude/rules/state.md
    - .claude/rules/drift.md
---

# Using notion-skills

`notion-skills` is an app-store-style CLI for AI coding agent skills. A Notion database is the workspace skill store; users `install` what they want, `publish` what they author, `sync` to keep installed skills fresh.

## Mental model

A skill is in one of three states:

- **Installed** — has a manifest entry. Invokable via the agent CLI's `/<slug>` shortcut.
- **Draft** — not yet ready for team consumption. Two flavors: (1) local-only (central-store dir exists, no manifest entry, no Notion row), or (2) Notion-side (page exists with `Published = false`). Both share the `✎` marker in `list`.
- **Available** — Notion row with `Published = true`, not installed on this machine.

Two further sub-states for installed skills:

- **Outdated** — the Notion page has changed since the user last synced.
- **Local-edited** — the user edited any file in the skill dir (SKILL.md or sibling) without publishing.

The verb mapping:

| User intent | Verb |
|---|---|
| Author a new skill via the user's coding agent | `gen <input>` |
| Push local edits or new skills to the team store | `publish <slug>` (or `--all`) |
| See what's available + what's installed | `list` |
| Pull a skill from the store onto this machine | `install <slug>` (or `--tag <name>`, or `--all`) |
| Pull updates for installed skills | `sync` |
| Remove from this machine | `uninstall <slug>` |
| Retire from the team store | `unpublish <slug>` |
| Open a skill in Notion (or in a local editor) | `open <slug>` (or `--local`, `--with <cmd>`, `-a <App>`, `--reveal`) |
| First-time setup | `init` |
| Diagnose problems | `doctor [--fix]` |

**Key invariants:**

- **Pull is implicit** (`sync`), **push is explicit** (`publish`). `sync` will never push the user's local edits — it only surfaces them as a reminder.
- `gen` writes a local-first draft. The agent never publishes automatically; the user runs `publish` themselves.
- Per-machine install state — install on laptop A doesn't propagate to laptop B without explicit install on B.
- All Notion API access goes through the `ntn` CLI. Auth is `ntn login`.

## Common workflows

### Install a specific skill the user named

```bash
notion-skills install <slug>
```

If the user gives a name that's not a valid slug, suggest running `notion-skills list` first so they can copy the exact slug. The error message from `install` will list missing slugs.

### Install everything tagged X

```bash
notion-skills install --tag <name>
```

Multiple tags = AND. `--tag a --tag b` installs only skills with both.

### Show what's installed / available / outdated

```bash
notion-skills list                  # everything, grouped by state
notion-skills list --installed      # only installed (includes outdated)
notion-skills list --outdated       # only installed-and-outdated
notion-skills list --drafts         # only local drafts (not yet published)
notion-skills list --available      # only in store but not installed
notion-skills list --tag <name>     # filter by tag
notion-skills list --sort popular   # popular first (alias: --sort installs)
notion-skills list --json           # machine-readable
```

State markers in the human-readable output:

- `✓` installed
- `↑` outdated (newer version in the store)
- `✎` draft (local-only OR Notion-side `Published=false`)
- `·` available (in store, ready, not installed)
- `!` invalid (Notion page missing required fields)
- `<n>` install count appears in the Installs column

`list --available` filters out drafts; `--drafts` shows only drafts; `--installed` includes outdated.

### Pull updates

```bash
notion-skills sync
```

`sync` is pull-only. If the user has local edits, `sync` prints a "you have local edits — run `publish`" reminder per drifted skill but **does not** push or overwrite. If the user has BOTH local edits AND the page changed remotely, `sync` backs up the local file to `~/.notion-skills/backup/sync-overwrite-<ts>/` before pulling.

### Generate a new skill

```bash
notion-skills gen <url|filepath|natural-language description>
```

`gen` hands a wrapped prompt to the user's coding agent (claude / codex / opencode / gemini, configured per-user in `~/.notion-skills/scope.json` or via `--agent <key>`). The agent's contract: write a SKILL.md to `~/.notion-skills/skills/<slug>/`, exit. Don't run shell commands, don't publish — that's the user's call.

After `gen` finishes, the skill is a **draft**: invokable on the local machine via the symlink fanout, but not in the team store. Tell the user to run `notion-skills publish <slug>` when they're ready to share.

### Publish

```bash
notion-skills publish <slug>             # one
notion-skills publish slug-a slug-b      # several
notion-skills publish --all              # every drafted-or-locally-edited skill
```

`--all` is the convenient way to publish everything that diverges from the store: drafts (no manifest entry yet) get created as new pages; installed-with-local-edits get PATCHed onto their existing page. After publish, the local SKILL.md is rewritten with Notion's normalised version (round-trip).

### Uninstall

```bash
notion-skills uninstall <slug>
```

Removes manifest entry + on-disk SKILL.md + symlinks. **Notion page is untouched** — the skill stays in the store, just not on this machine. If the user has local edits, uninstall backs the file up to `~/.notion-skills/backup/uninstall-<ts>/` before removing.

`unpublish <slug>` is the inverse: archives the Notion page (Notion-side delete with recovery), then removes the local copy. Use with care.

## Disambiguating "this skill is X-state"

When the user says "skill X isn't working" or "is skill X up to date":

1. Run `notion-skills list <slug>` (or `list | grep <slug>`) to see the state marker.
2. If `↑ outdated` → run `notion-skills sync` to pull, OR ask if the user has local edits worth publishing first.
3. If `✎ draft` (local-only) → tell them they need to `publish <slug>` to share.
4. If `✎ draft` (Notion-side, `Published=false`) → the page exists in Notion but isn't ready. They can `publish <slug>` to flip the checkbox, or check it directly in Notion's UI.
5. If `· available` → not installed yet; offer to `install <slug>`.
6. If `! invalid` → the Notion page is missing required fields (no title or no Description). The user has to fix it in Notion.

## Troubleshooting

`notion-skills doctor` is the first stop — it checks ntn auth, scope, schema, manifest, and symlinks. `doctor --fix` auto-repairs warnings where safe.

Common errors:

| Error | Fix |
|---|---|
| Notion auth expired / token invalid | `ntn logout && ntn login` |
| Schema doesn't match | `notion-skills upgrade` |
| isn't configured yet | `notion-skills init` |
| Could not find database | Check the URL; verify `ntn doctor` is in the right workspace |
| ntn is too old | `ntn update` |

To wipe local state without losing auth or affecting the Notion store:

```bash
rm -rf ~/.notion-skills
notion-skills init
```

Backups in `~/.notion-skills/backup/` survive this only if you copy them out first.

## What lives where

```
~/.notion-skills/
├── scope.json                  database id, sync targets, gen_agent
├── manifest.json               per-installed-skill sync state (page_id, hashes, files, last_edited_time)
├── skills/<slug>/              every skill on this machine (installed + drafts)
└── backup/                     auto-backups from uninstall + sync-overwrite

~/.claude/skills/<slug>          → symlink → ~/.notion-skills/skills/<slug>
~/.codex/skills/<slug>           → symlink
~/.cursor/skills/<slug>          → symlink
~/.config/opencode/skills/<slug> → symlink
~/.gemini/skills/<slug>          → symlink
~/.agents/skills/<slug>          → symlink
```

A `manifest.json` entry is what distinguishes installed from draft. Both are real on-disk skills with symlinks; the manifest just records sync state.

## Multi-file skills

A skill is a directory. Beyond `SKILL.md`, sibling files (e.g. `LANGUAGE.md`, `scripts/search.ts`) round-trip through Notion as child pages on the skill's row.

- **Markdown** sibling files: child page body = file content verbatim.
- **Source code** files (.ts, .py, .sh, etc.): child page body = a single fenced code block, no prose.
- **Unsupported** file types (binary, unknown extension): publish skips with a warning.

When users ask about authoring a multi-file skill, the layout to use:

```
my-skill/
├── SKILL.md
├── LANGUAGE.md            (markdown sibling)
└── scripts/search.ts      (code sibling, lives at scripts/search.ts on disk)
```

`publish` upserts the child pages. `install` / `sync` materializes them back to disk. Deleting a local sibling file and re-publishing archives the matching child page in Notion.

## Drafts

A skill is either **ready** or a **draft**. Both kinds show the `✎` marker in `list`. Two ways a skill can be a draft:

- **Local-only**: skill dir exists at `~/.notion-skills/skills/<slug>/` but no Notion row yet (gen output, hand-authored).
- **Notion-side**: row exists in Notion but its `Published` checkbox is unchecked.

`publish` always sets `Published = true`. Three paths it handles:

| State the user is in | What `publish <slug>` does |
|---|---|
| Local draft (no Notion row) | Creates the Notion page with `Published = true` |
| Installed (manifest entry exists) | Updates the page body / properties **and** sets `Published = true` |
| Notion-side draft (page exists, no local presence) | Flips `Published = true`. No body upload. |

`install --all` and `install --tag` skip drafts. `install <slug>` works regardless of state — if a user typed the slug, they want it.

When the data source doesn't have a `Published` column, every row is treated as ready. Suggest the user run `notion-skills upgrade` (or add the column manually) to opt in to drafts.

## Slug stability

The slug is derived from the page title, but identity is keyed by Notion's stable `page_id`. When a user renames a page in Notion, the next `list` or `sync` automatically migrates local state: central-store directory, every agent CLI's symlink, and the manifest entry all move to the new slug. Install count and drift hashes are preserved. The user sees `↪ old-slug → new-slug (renamed in Notion)`.

Renames are refused if the new slug collides with another tracked skill or an existing local draft.

If two pages share a title, both slugify to the same string. `sync` skips them with a warning, `install` refuses them, `doctor` flags them. Resolution: rename one of the pages in Notion.

## What NOT to do

- Don't manually edit `~/.notion-skills/manifest.json` — it gets rewritten by every command. Hand-edit `scope.json` only.
- Don't symlink directly between agent dirs (e.g. `~/.codex/skills/foo` → `~/.claude/skills/foo`). The CLI fans out from a single central directory; cross-target symlinks confuse the reconciler.
- Don't `git clone` skills into a target dir hoping the CLI will manage them. Skills come from the Notion store; if the user wants to bring local skills in, run `notion-skills import [--from <path>]`.
- Don't run `publish` after `gen` automatically. Drafts are intentional — give the user a chance to review.
- Don't suggest renaming a Notion page without warning the user about the slug-stability consequences (see above).
