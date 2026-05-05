# Local state model

All client state lives under `~/.notion-skills/`:

```
~/.notion-skills/
├── scope.json                  # database_id, sync targets, exclude_skills, gen_agent
├── manifest.json               # per-installed-skill sync state
├── skills/<slug>/              # every skill on this machine (installed + drafts)
└── backup/                     # auto-backups from uninstall + sync-overwrite
```

Symlinks fan out from `~/.notion-skills/skills/<slug>/` to every configured target dir (`~/.claude/skills/`, etc.) for both states. **Drafts are immediately invokable** because the symlink is created at gen-time, not publish-time.

## Manifest entry

Each `skills.<slug>` entry tracks:

- `page_id` — Notion page UUID
- `last_edited_time` — fast-path drift hint (NOT authoritative; bumps on metric edits)
- `props_hash` — hash of behavior-affecting properties (excludes Tags + Installs)
- `body_hash` — hash of rendered markdown body
- `local_hash` — hash of the on-disk SKILL.md (drift detection on the local side)

Top-level `hash_v: 2` marks the current drift-hash scheme. Pre-`hash_v=2` manifests still load; sync rebaselines them on first run.

## App-store invariants

- A skill is in two states: **installed** (manifest entry) or **not installed**. No detach/fork in v1.
- **Pull is implicit** (`sync` updates installed skills) — **push is explicit** (`publish` is the only way edits go upstream).
- Manifest entry = installed; no manifest entry = draft.
- Per-machine install state. No cross-device sync layer.
- Anyone can edit any installed skill. Page-level Notion permissions are the eventual access-control story.
