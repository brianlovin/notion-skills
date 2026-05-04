# notion-skills

Sync skills from a Notion database to your AI coding agents.

Edit your skills in Notion's UI (no git, no markdown editor). Run `notion-skills sync` and they land in your agent's skills directory ready for `/skill-name` invocation.

## Supported agents

Any of these can be picked as a sync target during `notion-skills init`. Multiple at once is fine — the same skills land in every selected agent's directory.

| Agent | Path | Docs |
|---|---|---|
| Claude Code | `~/.claude/skills/` | [code.claude.com](https://code.claude.com/docs/en/skills) |
| Codex CLI | `~/.codex/skills/` | [openai/codex](https://github.com/openai/codex) |
| OpenCode | `~/.config/opencode/skills/` | [opencode.ai](https://opencode.ai/docs/skills) |
| Cursor | `~/.cursor/skills/` | [docs.cursor.com](https://docs.cursor.com) |
| Gemini CLI | `~/.gemini/skills/` | [geminicli.com](https://geminicli.com/docs/cli/tutorials/skills-getting-started/) |

Adding a new agent is one entry in [`src/known-targets.ts`](src/known-targets.ts) — PRs welcome.

## Auth: piggybacks on ntn

notion-skills uses **[`ntn`](https://github.com/makenotion/ntn-cli)** — Notion's official CLI — for all Notion API access. There's no separate OAuth flow, no integration to register, no client secrets to manage. If you've already got `ntn login` working, you're done.

```bash
brew install ntn         # or however ntn ships
ntn login
npm install -g notion-skills
```

`notion-skills login` and `notion-skills logout` are thin wrappers around `ntn login` / `ntn logout` if you forget which CLI to reach for.

## Quick start

1. Create a Notion database called something like "Skills" with these properties:
   - **Title** — built in
   - **Description** — rich text. The skill's one-line "when to use" hint.
   - **Tags** — multi-select (optional). Used for filtering on sync.

2. Each row = one skill. Page body = the skill's instructions (markdown).

3. Make sure the database is shared with `ntn` (the integration row in Notion's "Connections" menu).

4. Pick the database and configure filters:

   ```bash
   notion-skills init
   ```

5. Sync:

   ```bash
   notion-skills sync
   ```

   Skills now live in `~/.claude/skills/<name>/SKILL.md`. Open Claude Code in any project and try `/<skill-name>`.

## Two scopes

### Global (default)

Skills sync to your personal `~/.claude/skills/` (and `~/.codex/skills/` if you have it). Configured per-machine.

### Project

Run `notion-skills init --project` inside a repo. Writes `.notion-skills.json` you can commit. Teammates clone the repo and run `notion-skills sync` to get the same skills under `<repo>/.claude/skills/`.

```
myrepo/
├── .notion-skills.json   ← commit this
└── .claude/
    └── skills/<name>/    ← gitignored, regenerated on sync
```

`notion-skills sync` from inside a repo with `.notion-skills.json` syncs the project scope. From elsewhere, it syncs the global scope. Pass `--global` / `--project` / `--all` to override.

## Filtering: only the skills you need

The Notion DB might have hundreds of skills. You probably only want a subset.

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

Resolution order per skill: `exclude_skills` → `include_skills` → `include_tags` → `exclude_tags` → keep.

Edit interactively:

```bash
notion-skills tags     # multi-select include / exclude tags
```

One-off override:

```bash
notion-skills sync docker terraform   # sync only these (ignores filter)
```

## Commands

| Command | What it does |
|---|---|
| `login` | Run `ntn login`. |
| `logout` | Run `ntn logout`. |
| `init [--global\|--project]` | Pick a Skills database, choose targets, set initial tag filters. |
| `sync [names...] [--global\|--project\|--all]` | Pull pages, write skills, reconcile target dirs. Skips unchanged pages by `last_edited_time`. |
| `list` | Show every page in the DB and whether it's synced, filtered out, or invalid. |
| `status` | Report ntn auth + scope + symlink health. |
| `tags` | Interactively edit include/exclude tag filters. |
| `migrate [--from <path>] [--overwrite] [--dry-run] [-y]` | Push existing local skills into Notion, then sync back as symlinks. Auto-extends `include_skills` so the round-trip lands on disk. Originals moved to a backup dir for reversibility. |

## Migrating existing skills

If you already have skills authored on disk (in `~/.claude/skills/`, `~/.codex/skills/`, an old shared repo, etc.), `notion-skills migrate` uploads them to your Skills database and replaces the local copies with symlinks to the central store.

```bash
# Preview what would happen
notion-skills migrate --dry-run

# Migrate locally-authored skills (skips ones already in Notion)
notion-skills migrate

# Pull in skills from another directory too
notion-skills migrate --from ~/Developer/some-old-skills-repo

# Force-replace Notion pages whose slug matches a local skill
notion-skills migrate --overwrite
```

Each candidate is classified as **new** (will create), **conflict** (already in Notion — skipped unless `--overwrite`), **managed** (already a symlink into our central store, ignored), or **invalid** (no SKILL.md or no Description property). After the upload step a sync runs automatically so the new symlinks land in your target dirs. Originals move to `~/.notion-skills/backup/migrate-<timestamp>/` so you can restore if anything looks wrong.

## How it works

- Pages with no Title or no Description are skipped with a warning.
- Skill name = slugified Title (`lowercase-with-hyphens`, max 64 chars). Duplicate slugs are skipped — rename in Notion.
- Page body is converted from Notion blocks to markdown (headings, lists, code blocks with language, quotes, callouts → blockquotes, tables, dividers; images render as links).
- Global scope keeps a single canonical copy at `~/.notion-skills/skills/<name>/SKILL.md` and symlinks each target dir at it. Project scope writes directly into `<repo>/.claude/skills/`.
- A manifest tracks `last_edited_time` per skill, so re-syncing only fetches changed pages.
- If a skill exists at the target as a non-symlink (you wrote it manually), sync skips it with a warning rather than overwriting.
- Every Notion API call is shelled through `ntn api`. Set `NOTION_API_TOKEN` to override the keychain token (useful in CI).

## Files this CLI touches

```
~/.notion-skills/
├── scope.json            # global scope: db, targets, filter
├── manifest.json         # global manifest
└── skills/<name>/        # central source-of-truth (global)

~/.claude/skills/<name>   → symlink → ~/.notion-skills/skills/<name>
~/.codex/skills/<name>    → symlink → ~/.notion-skills/skills/<name>

<repo>/.notion-skills.json    # project scope (committable)
<repo>/.notion-skills.lock    # project manifest (gitignore me)
<repo>/.claude/skills/<name>/ # project skills (gitignore me)
```

Auth lives entirely in `ntn`'s store (OS keychain by default). To wipe notion-skills state but keep auth: `rm -rf ~/.notion-skills`.

## License

MIT
