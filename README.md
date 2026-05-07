# notion-skills

> A skill store for your AI coding agents. Create and collaborate on skills in Notion, then install them on your computer.

[![npm](https://img.shields.io/npm/v/@brianlovin/notion-skills.svg?cacheSeconds=300)](https://www.npmjs.com/package/@brianlovin/notion-skills)

## Why

AI coding agents (Claude Code, Codex, OpenCode, Cursor, Gemini) all read [skills](https://agentskills.io/home) — small `SKILL.md` files that tell an agent what to do and when. The format is shared, but each agent reads from its own folder, and authoring usually means tending markdown files in git to keep them synced across machines and teammates.

`notion-skills` puts your skills in a Notion database. You browse a shared store, install only what you want on each machine, and edit skills the way you edit any other Notion page.

- 🏪 **Browse a shared store.** Pick the skills that fit your workflow instead of syncing everything.
- ✏️ **Edit in Notion.** Use the rich editor; collaborate live; no IDE, no git, no PR review.
- 👥 **Built for teams.** One store, shared with everyone; each person installs what's relevant to them.
- 🤖 **Generate with your agent.** `gen` hands an idea off to your coding agent and writes you a draft.
- 🎯 **Install once, every agent reads it.** The same skill works in Claude, Codex, Cursor, and the rest.

## Get started

```bash
brew install ntn               # the Notion CLI we shell out to
ntn login

npm install -g @brianlovin/notion-skills
notion-skills init             # interactive setup: pick a database + agents
```

Then:

```bash
notion-skills list                    # browse the store
notion-skills install <slug>          # install one skill
notion-skills install --tag featured  # install everything tagged "featured"
notion-skills sync                    # pull updates for installed skills
notion-skills publish <slug>          # share a local skill with the team
```

Type `/skill-name` in any agent CLI to invoke an installed skill.

Requires macOS or Linux and Node.js 18+.

## Commands

| Command | What it does |
|---|---|
| `init` | First-time setup: create or link a Notion skill store. Re-run to add another source. |
| `list` | See what's in the store(s). Filter with `--installed`, `--available`, `--outdated`, `--drafts`, `--tag`, `--source`. Sort with `--sort name\|popular\|new`. |
| `install <slug>` | Pull a skill onto your machine. Refs are bare (`deploy`) or qualified (`team/deploy`). Bulk: `--tag`, `--all` (source-scoped). |
| `uninstall <slug>` | Remove from your machine. The Notion page stays. |
| `sync` | Pull updates for installed skills across every source. |
| `gen <input>` | Generate a new skill from a URL, file, or prompt. Local-only until you `publish`. |
| `add <owner/repo>` | Pull a public skill from a GitHub repo (mirrors [skills.sh](https://skills.sh) syntax). Lands as a local draft; `--publish` chains straight to a Notion source. |
| `audit [slugs...]` | Quality checks (description, body, test markers, agent-routing keywords). Like `npm audit`. |
| `publish <slug>` | Push a local skill (or edits) to the store. Bulk: `--all`. Source picker fires for new drafts when 2+ sources exist; `--source` skips. |
| `unpublish <slug>` | Archive a skill in the store. |
| `open <slug>` | Open the skill in Notion. Use `--local` to open the file in your editor. |
| `source` | Manage Notion sources: `add`, `list`, `remove`, `default`, `rename`. |
| `doctor` | Diagnose problems across every source. `--fix` repairs safe issues. |

Run any command with `--help` for the full list of options.

## Drafts

A skill is **ready** or a **draft**. Drafts aren't yet ready for the team — they live on your machine without a Notion row, or in Notion with the `Published` checkbox off. Drafts are skipped by default in install flows; pass `--drafts` to see them or install one by name. Run `publish` to mark a draft ready.

## Multiple sources

A "source" is one Notion database. Most users have one (the team store) and never think about it. Larger workflows want more — engineering store, personal store, a department-specific store. Run `notion-skills source add` to link or create another database; bare commands target the **default** source (the first one you set up). Use a qualified ref (`team/deploy`) or `--source <key>` when you want to be explicit. Tags are source-scoped (each Notion DB has its own tag set), so `--tag` always operates on a single source.

When you install two skills with the same slug from different sources, the second one auto-namespaces (`personal-deploy`) so both can coexist. Override with `--as <name>`.

## What's in a skill?

A directory with a `SKILL.md` file. You can ship extra files alongside it. The [Agent Skills spec](https://agentskills.io/specification) defines three optional category directories:

- `scripts/` — executable code the agent runs
- `references/` — documentation the agent loads on demand
- `assets/` — static resources (templates, schemas, etc.)

Files in spec dirs round-trip through Notion as nested sub-pages of a same-named wrapper. Files outside spec dirs become flat root-level child pages.

## Supported agents

Claude, Codex, OpenCode, Cursor, Gemini, plus a generic `~/.agents/skills/` catch-all. Skills land as symlinks from one central directory, so every agent on your machine sees the same set.

## Troubleshooting

`notion-skills doctor` is the first stop. Common fixes:

- **Auth expired** → `ntn logout && ntn login`
- **Schema out of date** → `notion-skills upgrade`
- **Reset everything** → `rm -rf ~/.notion-skills && notion-skills init` (your Notion store is untouched)

## License

MIT
