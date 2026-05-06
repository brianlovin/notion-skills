# Local state model

All client state lives under `~/.notion-skills/`:

```
~/.notion-skills/
├── scope.json                  # database_id, sync targets, gen_agent
├── manifest.json               # per-installed-skill sync state
├── skills/<slug>/              # every skill on this machine (installed + drafts)
└── backup/                     # auto-backups from uninstall + sync-overwrite
```

Symlinks fan out from `~/.notion-skills/skills/<slug>/` to every configured target dir (`~/.claude/skills/`, etc.) for both states. **Drafts are immediately invokable** because the symlink is created at gen-time, not publish-time.

## Manifest entry

Each `skills.<slug>` entry tracks:

- `page_id` — Notion page UUID. Stable identifier; survives title renames. Slug is for users; `page_id` is the source of truth for change detection.
- `last_edited_time` — fast-path drift hint (NOT authoritative; bumps on metric edits, not multi-file children)
- `props_hash` — hash of behavior-affecting properties (excludes Tags, Installs, Published)
- `body_hash` — hash over the parent body + every sibling file's content (`hashSkillContent`)
- `local_hash` — hash of the whole on-disk skill dir (SKILL.md + every sibling file)
- `files` — relative paths of sibling files round-tripped through child pages. Non-empty means "multi-file skill" → drift checks always slow-path

Top-level `hash_v: 2` marks the current drift-hash scheme. Pre-`hash_v=2` manifests still load; sync rebaselines them on first run.

## App-store invariants

- **Pull is implicit** (`sync` updates installed skills) — **push is explicit** (`publish` is the only way edits go upstream).
- Three local states from the user's POV: **installed** (manifest entry), **draft** (local-only, no manifest entry, OR Notion row with `Published=false`), **available** (in the store, ready, not installed).
- Per-machine install state. No cross-device sync layer.
- Anyone can edit any installed skill. Page-level Notion permissions are the eventual access-control story.

## Renames

When the user renames a page in Notion, the next `list` or `sync` detects the title change via stable `page_id`, renames the central-store dir + every target's symlink, and moves the manifest entry to the new slug. Install count + drift hashes preserved. Refused on collision.
