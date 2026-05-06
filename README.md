# notion-skills

> A skill store for your AI coding agents. Create and collaborate on your skills in Notion, then install specific skills to your computer or connect to your agents with the Notion MCP.

[![npm](https://img.shields.io/npm/v/@brianlovin/notion-skills.svg?cacheSeconds=300)](https://www.npmjs.com/package/@brianlovin/notion-skills)

## Why notion-skills?

AI coding agents (Claude Code, Codex, OpenCode, Cursor, Gemini) all read [**skills**](https://agentskills.io/home) — small `SKILL.md` files that tell the agent what to do and when to do it. The format is shared across agents, but each one reads from its own folder. Authoring skills usually requires tending markdown files in git to keep them synced across computers, projects, and team members.

`notion-skills` flips that: skills live as rows in a Notion database — your **workspace skill store** — and you `install` only the ones you want on each machine.

- 🏪 **Browse your team's skill store.** Don't sync everything; pick the skills that fit your workflow.
- ✏️ **Edit in Notion.** Use Notion's rich text editor to collaboratively draft and and publish skills for you and your team.
- 👥 **Share with a team.** Point teammates at the shared skill store so they can install the skills most relevant to their workflows.
- 🤖 **Generate skills via your coding agent.** `notion-skills gen <url|path|prompt>` hands off to Claude / Codex / OpenCode / Gemini, which writes a skill from as a local-first draft you can review and publish.
- 🎯 **One source, many agents.** Skills land as symlinks, so every agent CLI on your machine sees the same set with one command.

## Requirements

- macOS or Linux.
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

The wizard will guide you through:

1. **Database setup** — create a new skill store, or link an existing one.
2. **AI agent targets** — auto-checks every agent CLI installed on your machine (Claude, Codex, OpenCode, Cursor, Gemini, plus the generic `~/.agents/` catch-all).
3. **Import** — if you have skills already on disk, optionally publish them to the store.

Then:

```bash
notion-skills list                  # browse the store
notion-skills list --sort popular   # sort by install count (most popular first)
notion-skills install <slug>        # install one
notion-skills install --tag featured  # install all skills tagged "featured"
notion-skills install --all         # install everything (power-user)
```

## Lifecycle

`notion-skills` turns your team's skill files into an app store. Skills move between three states:

- **In the store** (a Notion page) — ready for your team to install.
- **Installed** (on your machine) — invokable by your agent CLIs.
- **Drafted** — either local-only (no Notion row yet) or in Notion with `Published = false`. Either way: not yet ready for the team. See [Drafts](#drafts).

**Verbs:**

| Action | Verb |
|---|---|
| Author a new skill via your coding agent | `gen <input>` |
| Author by hand | edit `~/.notion-skills/skills/<slug>/SKILL.md` directly |
| Push your work to the store | `publish <slug>` (or `--all`) |
| See what's available + what's installed | `list` |
| Pull a skill from the store onto this machine | `install <slug>` (or `--tag` / `--all`) |
| Pull updates for installed skills | `sync` |
| Remove from this machine | `uninstall <slug>` |
| Retire from the store entirely | `unpublish <slug>` |
| Bulk-import pre-existing local skills | `import [--from <path>]` |

A skill you have edited locally won't push automatically — `notion-skills sync` is pull-only. When you're ready to share your edits, run `notion-skills publish <slug>`.

## Commands

| Command | What it does |
|---|---|
| `init` | Connect to (or create) your workspace skill store. |
| `list` | Browse what's in the store with state markers (installed, available, outdated, draft). The Installs column shows the install count. Supports `--installed`, `--available`, `--outdated`, `--drafts`, `--tag <name>`, `--sort <key>` (`name` / `popular` / `new`, plus synonyms), `--json`. |
| `install <slug>` / `--tag` / `--all` | Pull a skill from the store onto this machine. |
| `uninstall <slug>` | Remove a skill from this machine (Notion page is untouched). Auto-backs up local edits. |
| `gen <input>` | Generate a new skill from a URL, file path, or prompt. The agent writes a local-first draft; review and `publish` when ready. |
| `publish <slug>` / `--all` | Push local skills to the store. |
| `unpublish <slug>` | Remove a skill from the store (Notion page archived). Local copy untouched. |
| `sync` | Pull updates for installed skills. Pull-only — local edits never flow upstream until you `publish`. |
| `import [--from <path>]` | Bulk-bring-in pre-existing local skills via a multiselect picker. |
| `open <slug> [--local\|--with <cmd>\|-a <app>\|--reveal]` | Default: open the Notion page. `--local` uses `$EDITOR`; `--with <cmd>` is portable; `-a <app>` is macOS-style; `--reveal` opens the directory. |
| `doctor [--fix]` | Inspect for drift; auto-fix safe issues. |
| `status` | Show auth, scope, and per-target symlink health. |
| `upgrade` | Add any missing skill-spec properties to your Notion DB schema. |
| `login` / `logout` | Wrappers over `ntn login` / `ntn logout`. |

Add `--help` to any command for full options.

## Supported agents

| Agent | Skills directory |
|---|---|
| Generic catch-all | `~/.agents/skills/` |
| Claude | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| OpenCode | `~/.config/opencode/skills/` |
| Cursor | `~/.cursor/skills/` |
| Gemini | `~/.gemini/skills/` |

Adding another is one entry in [`src/known-targets.ts`](src/known-targets.ts) — PRs welcome.

## Generating skills (`gen`)

`gen <input>` turns a URL, file path, or natural-language prompt into a new local-first skill via your coding agent:

```bash
notion-skills gen https://www.aihero.dev/grill-with-docs
notion-skills gen ~/notes/playwright-tips.md
notion-skills gen "skill to help me check the weather"
```

The first run prompts you to pick a coding agent (Claude, Codex, OpenCode, or Gemini, biased toward your sync targets) and saves the choice to `~/.notion-skills/scope.json`. Subsequent runs hand off automatically. Override per-run with `--agent <key>`.

The agent writes the SKILL.md to `~/.notion-skills/skills/<slug>/`, exits, and `notion-skills` fans out symlinks so the new skill is invokable in your agent CLIs immediately. The skill is local-only at this point — review it, iterate, then `notion-skills publish <slug>` when you're happy. This way every "let me try this" experiment doesn't end up broadcast to your team.

## File layout

```
~/.notion-skills/
├── scope.json                  database id, sync targets, gen agent
├── manifest.json               sync state for installed skills
├── skills/<slug>/              every skill on this machine (installed + drafts)
└── backup/
    ├── uninstall-<ts>/         local edits saved when uninstalling
    └── sync-overwrite-<ts>/    local edits saved when sync would overwrite

~/.claude/skills/<slug>          → symlink → ~/.notion-skills/skills/<slug>
~/.codex/skills/<slug>           → symlink
~/.cursor/skills/<slug>          → symlink
~/.config/opencode/skills/<slug> → symlink
~/.gemini/skills/<slug>          → symlink
~/.agents/skills/<slug>          → symlink
```

Auth lives in `ntn`'s store (OS keychain). `rm -rf ~/.notion-skills` wipes local state without touching your auth or your Notion store.

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
rm -rf ~/.notion-skills    # keeps auth + Notion store intact
notion-skills init
```

**Recover a backup:**

`uninstall` and `sync` (when overwriting drift) save local edits to `~/.notion-skills/backup/`. Recover by hand:

```bash
ls ~/.notion-skills/backup/
cp ~/.notion-skills/backup/uninstall-<ts>/<slug>/SKILL.md \
   ~/.notion-skills/skills/<slug>/SKILL.md
notion-skills publish <slug>   # if you want it back in the store
```

## Drafts

A skill is either **ready** or a **draft**. Drafts are skills that aren't ready for team consumption yet — either because they're local-only (gen output, hand-authored, not yet pushed) or because they exist in Notion but the `Published` checkbox is unchecked. Both kinds appear with the `✎` marker in `list`.

```
~/.notion-skills/skills/foo/SKILL.md  →  exists locally, no Notion row     →  draft
foo (Notion row, Published = false)   →  exists in Notion, marked unready  →  draft
foo (Notion row, Published = true)    →  ready                            →  visible / installable by default
```

`Published` is a Notion-side checkbox. The CLI never asks you to manage it via frontmatter — set it via Notion's UI, or via `publish`.

**Default behavior:**

- `list` shows drafts at the bottom with `✎`. They're not hidden — you can see your own work.
- `list --available` shows ready-and-not-installed only (no drafts).
- `install --all` and `install --tag <name>` skip drafts. They're explicit-only.
- `install <slug>` works on any state — if you typed it, you want it.
- `publish` always sets `Published = true`. The verb is "publish."
  - Local draft + `publish <slug>` → creates Notion page with `Published = true`
  - Installed skill + `publish <slug>` → updates the page **and** ensures `Published = true`
  - Notion-side draft + `publish <slug>` → flips `Published = true` (no body changes; the user has been editing in Notion's UI)
- `unpublish <slug>` archives the Notion page (unchanged from before — drafts don't change this).

**Backward compatibility**: if your data source doesn't have the `Published` column, every row is treated as ready. No behavior change unless you opt in. Add the column via `notion-skills upgrade` (or by hand in Notion), then mark existing rows ready in bulk.

## Multi-file skills

A skill is a directory: alongside `SKILL.md`, you can ship sibling files (e.g. `LANGUAGE.md`, `scripts/search-icons.ts`). On publish, each non-`SKILL.md` file becomes a child page on the skill's row in Notion. The page's title carries the relative path; the body shape depends on the file kind:

- **Markdown** sibling files round-trip verbatim.
- **Source code** files (`.ts`, `.py`, `.sh`, etc.) round-trip as a single fenced code block — no prose, just the source — so installing brings the file back byte-identical.

Unsupported file types (binaries, unknown extensions) are skipped on publish with a warning. Native Notion file uploads are a future addition.

When the local file is deleted and you `publish` again, the matching child page in Notion is archived. When a child page in Notion is archived (or never existed), the next `install` / `sync` won't materialize it locally.

```
my-skill/
├── SKILL.md              ← row body
├── LANGUAGE.md           ← child page "LANGUAGE.md"
└── scripts/
    └── search.ts         ← child page "scripts/search.ts"
```

## Renaming a skill in Notion

The slug is derived from the page title, but identity is keyed by Notion's stable `page_id`. When you rename a page in Notion, the next `list` or `sync` detects the title change, **renames the central-store directory + every target's symlink, and moves the manifest entry to the new slug** — install count, drift hashes, and per-machine state are preserved.

Output looks like:

```
↪ old-slug → new-slug (renamed in Notion)
```

Renames are refused (with a warning) if the target slug is already in use by another skill or by an existing local draft.

If two pages share a title, both slugify to the same string. Sync skips them with a warning, `install` refuses them with an error listing the conflicting titles, and `doctor` flags them. Resolve by renaming one of the pages.

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
