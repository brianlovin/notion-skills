---
name: notion-skills-usage
description: >
  Use the notion-skills CLI to manage AI agent skills from one or more
  Notion-backed workspace stores. Invoke when the user wants to install
  a skill from their team's store, publish a local skill they authored,
  sync installed skills, generate a new skill via their coding agent,
  manage Notion sources (one database per source), or inspect the state
  of installed/available/outdated/draft skills. Triggers on commands
  like install, publish, sync, gen, list, uninstall, unpublish, doctor,
  init, upgrade, open, import, source.
type: core
library: notion-skills
library_version: "0.17.0"
sources:
  - README.md
  - CLAUDE.md
  - .claude/rules/state.md
  - .claude/rules/drift.md
  - .claude/rules/gotchas.md
---

# Using notion-skills

`notion-skills` is an app-store-style CLI for AI coding agent skills. Each Notion database the user has linked is a "source"; they `install` what they want from any source, `publish` to a chosen source, `sync` keeps installed skills fresh across all sources.

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
| Pull a public skill from GitHub | `add <owner/repo>` (mirrors `npx skills add` syntax) |
| Audit skill quality (npm-audit-style) | `audit [slugs...]` |
| Push local edits or new skills to the team store | `publish <slug>` (or `--all`) |
| See what's available + what's installed | `list` |
| Pull a skill from the store onto this machine | `install <slug>` (or `--tag <name>`, or `--all`) |
| Pull updates for installed skills | `sync` |
| What's new across stores (last 7d) | `feed` (or `--since 30d`, `--since 2w`) |
| Read or post comments on a skill | `feedback <slug> [message...]` |
| Remove from this machine | `uninstall <slug>` |
| Retire from the team store | `unpublish <slug>` |
| Open a skill in Notion (or in a local editor) | `open <slug>` (or `--local`, `--with <cmd>`, `-a <App>`, `--reveal`) |
| First-time setup | `init` |
| Diagnose problems | `doctor [--fix]` |
| Manage Notion sources (databases) | `source add` / `list` / `remove <key>` / `default <key>` / `rename <old> <new>` |

**Key invariants:**

- **Pull is implicit** (`sync`), **push is explicit** (`publish`). `sync` will never push the user's local edits — it only surfaces them as a reminder.
- `gen` writes a local-first draft. The agent never publishes automatically; the user runs `publish` themselves.
- Per-machine install state — install on laptop A doesn't propagate to laptop B without explicit install on B.
- All Notion API access goes through the `ntn` CLI. Auth is `ntn login`.
- **Sources** are independent Notion databases. Each has its own schema, tags, and pages. The first source linked is the default; bare commands target it. Use `<source>/<slug>` or `--source <key>` to scope explicitly.
- **Tags are source-scoped.** `--tag` always operates on a single source (one Notion DB's tag set; semantics differ across sources).
- **Slug auto-namespace on install collision.** Installing `personal/deploy` while `team/deploy` is installed creates `personal-deploy/` on disk. Override with `--as <name>`.

## Common workflows

### Add another Notion source (database)

```bash
notion-skills source add               # interactive: link or create
notion-skills source list              # show what's configured
notion-skills source default <key>     # set the default source
```

### Install a specific skill the user named

```bash
notion-skills install <slug>           # bare; cross-source ref resolution
notion-skills install <source>/<slug>  # qualified; targets that source
notion-skills install <slug> --as my-deploy   # override local slug
```

Bare slugs that exist in multiple sources error with a "did you mean…" hint pointing to qualified refs. If the slug collides with an already-installed skill from another source, install auto-namespaces (`<source>-<slug>`) and prints what happened.

### Install everything tagged X (source-scoped)

```bash
notion-skills install --tag <name>                 # default source
notion-skills install --tag <name> --source team   # explicit
```

Multiple tags = AND. Tags are scoped to a single source (each Notion DB has its own tag option set with its own semantics).

### Show what's installed / available / outdated

```bash
notion-skills list                  # everything, grouped by state
notion-skills list --installed      # only installed (includes outdated)
notion-skills list --outdated       # only installed-and-outdated
notion-skills list --drafts         # only local drafts (not yet published)
notion-skills list --available      # only in store but not installed
notion-skills list --tag <name>     # filter by tag
notion-skills list --sort popular   # popular first (synonyms: installs, downloads)
notion-skills list --sort new       # most recently created first (synonyms: latest, recent)
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

### What's new across stores

```bash
notion-skills feed              # last 7d, all sources
notion-skills feed --since 30d  # last month
notion-skills feed --since 2w   # last two weeks
notion-skills feed --since 12h  # last 12 hours
notion-skills feed --source team
notion-skills feed --json       # machine-readable
```

`feed` is the discovery surface. It splits activity into two buckets per source: **🆕 new** (skills published in the window the user doesn't have installed) and **📝 updated** (installed skills that changed in the window). Drafts are filtered out — feed is for team-ready content. Suggest `feed` when the user asks "what's new?" / "anything I should try?" / "did anything change recently?".

### Read or post comments on a skill

```bash
notion-skills feedback <slug>                       # list comments
notion-skills feedback <slug> "broke on Node 18"    # post a comment
notion-skills feedback team/deploy "thanks!"        # qualified ref
```

`feedback` writes a Notion comment on the skill's page; the maintainer sees it in Notion's UI like any other comment thread. Bare invocation lists comments newest-first by relative time. The CLI shows when, not who — Notion's UI shows full author info if it matters; jump there with `notion-skills open <slug>`.

**Use it during workflows, not just on user request.** When you (an AI agent) invoke a skill and notice something worth flagging, post feedback proactively — the maintainer can act on it without you having to surface it through chat. Good triggers:

- The skill's instructions were wrong, ambiguous, or out of date for the situation you hit
- You worked around a missing feature or edge case the skill didn't handle
- The skill produced a great outcome that's worth crediting (positive feedback fuels iteration too)
- A user asks you to "let X know" / "leave a note" about a skill they just used

When posting feedback that came from an agent's own observation (not the user's words), say so plainly so the maintainer can weigh it: e.g. `notion-skills feedback deploy "agent-observed: the rollback step assumes a single-region deploy and fails silently in multi-region setups."` Brevity > prose; one paragraph max.

Drafts (no Notion page yet) can't be commented on; the command tells the user to publish first.

### Pull a public skill from GitHub

```bash
notion-skills add vercel-labs/agent-skills                       # all skills in the repo
notion-skills add vercel-labs/agent-skills@web-design-guidelines # one specific skill
notion-skills add owner/repo#v1.2.0                              # pin to a tag/branch
notion-skills add owner/repo --preview                           # see content without writing
notion-skills add owner/repo --publish --source team             # add + push to a Notion source
```

Mirrors [skills.sh](https://skills.sh) syntax for cross-ecosystem familiarity. Lands as a local draft; the user runs `publish` (or passes `--publish`) to push to a Notion source. Origin (`owner/repo#ref`) is recorded in `metadata.origin` and round-trips as a Notion column for provenance.

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

`publish` always sets `Published = true` and resolves to one of three paths:

| State | What `publish <slug>` does |
|---|---|
| Local draft (no Notion row) | Creates the Notion page |
| Installed (manifest entry exists) | Updates body + properties |
| Notion-side draft (page exists, no local presence) | Flips `Published = true`. No body upload. |

`--all` publishes everything that diverges from the store. After publish, the local SKILL.md is rewritten with Notion's normalised version (round-trip).

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

A skill is a directory. Beyond `SKILL.md`, the spec defines three optional category directories that round-trip through Notion as nested sub-pages:

- `scripts/` — executable code (Python, Bash, JS, etc.)
- `references/` — documentation the agent loads on demand
- `assets/` — static resources (templates, schemas, lookup tables)

Files placed in these dirs nest under a same-named wrapper sub-page in Notion. Files outside spec dirs are direct flat-title children of the parent skill row.

```
my-skill/
├── SKILL.md
├── LANGUAGE.md              ← root-level markdown
├── scripts/search-icons.ts  ← nested under "scripts" wrapper in Notion
└── references/api-spec.md   ← nested under "references" wrapper in Notion
```

Round-trip rules:
- **Markdown** sibling files round-trip verbatim. (Caveat: a top-level `# Heading` gets absorbed into the Notion page title; H2+ survive.)
- **Source code** files (.ts, .py, .sh, etc.) round-trip as a single fenced code block — no prose, just the source.
- **Unsupported** file types (binary, unknown extension): `publish` skips with a warning.

`publish` upserts the wrapper pages and their nested child pages. `install` / `sync` materialize everything back to disk at the correct relative paths. Deleting a local file and re-publishing archives the matching Notion sub-page.

## Drafts

`install --all` and `install --tag` skip drafts. `install <slug>` works regardless of state — if a user typed the slug, they want it.

If the data source has no `Published` column, every row is treated as ready. Suggest `notion-skills upgrade` (or adding the column in Notion) to opt in to drafts.

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
