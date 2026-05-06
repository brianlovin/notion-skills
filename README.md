# notion-skills

> A skill store for your AI coding agents. Create and collaborate on skills in Notion, then install them on your computer or connect to your agents through the Notion MCP.

[![npm](https://img.shields.io/npm/v/@brianlovin/notion-skills.svg?cacheSeconds=300)](https://www.npmjs.com/package/@brianlovin/notion-skills)

## Why

AI coding agents (Claude Code, Codex, OpenCode, Cursor, Gemini) all read [skills](https://agentskills.io/home) — small `SKILL.md` files that tell an agent what to do and when. The format is shared across agents, but each one reads from its own folder, and authoring usually means tending markdown files in git to keep them synced across machines and teammates.

`notion-skills` puts your skills in a Notion database. You browse a shared store, install only what you want on each machine, and edit skills the way you edit any other Notion page.

- 🏪 **Browse a shared store.** Pick the skills that fit your workflow instead of syncing everything.
- ✏️ **Edit in Notion.** Use the rich editor; collaborate live; no IDE, no git, no PR review.
- 👥 **Built for teams.** One store, shared with everyone; each person installs what's relevant to them.
- 🤖 **Generate with your agent.** `gen` hands an idea off to your coding agent and writes you a draft.
- 🎯 **One source, every agent.** The same skill works in Claude, Codex, Cursor, and the rest.

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
| `init` | First-time setup: create or link a Notion skill store. |
| `list` | See what's in the store. Filter with `--installed`, `--available`, `--outdated`, `--drafts`, `--tag`. Sort with `--sort name\|popular\|new`. |
| `install <slug>` | Pull a skill onto your machine. Bulk: `--tag`, `--all`. |
| `uninstall <slug>` | Remove from your machine. The Notion page stays. |
| `sync` | Pull updates for installed skills. |
| `gen <input>` | Generate a new skill from a URL, file, or prompt. |
| `publish <slug>` | Push a local skill (or edits) to the store. Bulk: `--all`. |
| `unpublish <slug>` | Archive a skill in the store. |
| `open <slug>` | Open the skill in Notion. Use `--local` to open the file in your editor. |
| `doctor` | Diagnose problems. `--fix` repairs safe issues. |

Run any command with `--help` for the full list of options.

## Drafts

A skill is **ready** or a **draft**. Drafts aren't yet ready for the team — they live on your machine without a Notion row, or in Notion with the `Published` checkbox off. Drafts are skipped by default in install flows; pass `--drafts` to see them or install one by name. Run `publish` to mark a draft ready.

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
