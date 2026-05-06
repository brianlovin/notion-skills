# Local state model

All client state lives under `~/.notion-skills/`:

```
~/.notion-skills/
├── scope.json                  # version: 2, sources[], targets, gen_agent
├── manifest.json               # per-installed-skill sync state (v2)
├── skills/<local_slug>/        # every skill on this machine (installed + drafts)
└── backup/                     # auto-backups from uninstall + sync-overwrite
```

`scope.json` is keyed by `version: 2` and carries a `sources[]` array. Each source: `{ key, name, database_id, data_source_id, default?, added_at }`. v1 (single-DB top-level fields) auto-migrates on read. `sanitiseSources` collapses corrupt-state edge cases (multiple defaults, duplicate database_ids). At most one source has `default: true`; if 2+ sources exist with no default, single-source commands prompt the user.

Symlinks fan out from `~/.notion-skills/skills/<local_slug>/` to every configured target dir (`~/.claude/skills/`, etc.). **Drafts are immediately invokable** because the symlink is created at gen-time, not publish-time.

## Manifest entry (v2)

Manifest is keyed by `local_slug` — the dir name on disk and what every agent CLI sees. Each entry:

- `source_key` — which configured source this entry belongs to. Stable across renames; rewritten by `source rename`.
- `source_slug` — the slug derived from the Notion page title. Auto-updates on Notion-side rename detection. Equals `local_slug` in the common case; differs when collision avoidance forced auto-namespace at install time.
- `page_id` — Notion page UUID. Stable identifier; survives title renames.
- `last_edited_time` — fast-path drift hint (NOT authoritative).
- `props_hash` — hash of behavior-affecting properties.
- `body_hash` — hash over body + sibling file content.
- `local_hash` — hash of the on-disk skill dir.
- `files` — sibling file paths (multi-file skill marker).

Top-level `hash_v: 3` marks the current drift-hash scheme. Pre-`hash_v=3` manifests still load; sync rebaselines them.

## App-store invariants

- **Pull is implicit** (`sync` updates installed skills across every source) — **push is explicit** (`publish` is the only way edits go upstream).
- Three local states from the user's POV: **installed** (manifest entry), **draft** (local-only, no manifest entry, OR Notion row with `Published=false`), **available** (in any configured source, ready, not installed).
- Per-machine install state. No cross-device sync layer.
- Slug auto-namespace on install collision: `team/deploy` already installed → `personal/deploy` installs as `personal-deploy`. Override with `--as <name>`.
- Bulk filters (`--tag`, `--all`) are source-scoped via the standard resolver; single-skill ops can be cross-source via ref resolution (`team/deploy` qualified or `deploy` bare).

## Renames

When the user renames a page in Notion, the next `list` or `sync` detects the title change via stable `page_id` and updates `entry.source_slug`. **The on-disk dir and every symlink stay pinned to `local_slug`** — muscle memory rules. To realign on-disk to a new title, uninstall and reinstall.

When the user renames a configured source via `source rename`, every manifest entry's `source_key` is rewritten. `local_slug` stays unchanged (auto-namespaced names like `team-deploy` stay as-is even after `team` → `engineering`).
