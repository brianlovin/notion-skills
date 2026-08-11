# Drift detection

The drift signal is content-based, not timestamp-based. A skill is "outdated" when what an agent will execute has changed.

## What counts as drift

| Change | Counts? | Why |
|---|---|---|
| Body markdown edited in Notion | yes | changes what the agent reads |
| Description / when_to_use / model / agent / allowed-tools / etc. | yes | changes how/when the model runs the skill |
| **Child page edited in Notion** (multi-file skill) | yes | child = sibling file; covered by `body_hash` |
| **Local sibling file edited / added / removed on disk** | yes | covered by `local_hash` (whole-dir hash) |
| Tags edited | **no** | discovery sugar, doesn't affect execution |
| Installs counter incremented | **no** | store-managed metric, not user content |
| Published checkbox flipped | **no** | draft/ready gate, doesn't change skill content |

The `taxonomyOnly` and `metricOnly` flags in `src/schema.ts` are what excludes Tags and Installs from `props_hash`. Don't add new excluded properties without thinking about the failure mode.

## Two-phase outdated check (`list`)

1. **Fast path**: `page.last_edited_time === entry.last_edited_time` → not outdated. Most common case, no API calls.
2. **Slow path**: `props_hash` differs → outdated. Else fetch parent body + every child page, compare `hashSkillContent`. If both match, the page was touched by a metric or tag edit; cache the fresh `last_edited_time` + `body_hash` (+ `files_edited_max`) so the next `list` short-circuits on the fast path.

**Multi-file skills get their own fast path.** Notion doesn't bump the *parent's* `last_edited_time` when only a child page is edited, so the single-file fast path can't see those edits. But each `child_page` block carries its own `last_edited_time`, and that one does move — so the pair (parent timestamp, newest child timestamp) answers "did anything change?" without downloading content. `files_edited_max` on the manifest entry caches the newest child timestamp; when both halves match, `list` short-circuits.

Cost is one block listing per skill, plus one per spec-category wrapper. **The wrapper hop is load-bearing**: files under `scripts/` `references/` `assets/` are grandchildren, and editing one bumps its own block, never the wrapper's. Depth stops there — `upsertSkillFilePages` flattens deeper paths into the wrapper's direct children (`support-topics/foo.md`).

Entries written before `files_edited_max` existed simply take the slow path once and get rebaselined, same as `body_hash`. The hash comparison remains the source of truth; the timestamps only decide whether it's worth computing.

`sync.ts` still force-includes every multi-file skill in the refetch set — it hasn't been moved onto this signal yet.

`list` writing to the manifest is intentional (transparent perf cache update). The next run is faster; the data on disk is always at least as fresh.

## Hash version (`hash_v`)

`HASH_V` lives in `src/page-hash.ts`. Bump it when:
- the property set contributing to `props_hash` changes
- any reader for those properties changes shape
- the hash function itself changes

Pre-`hash_v=2` manifests show as "not outdated" until `sync` rebaselines them — better than mass false positives.

## Time rounding gotcha

Notion's `last_edited_time` rounds to the minute. Time-sensitive tests need a ≥ 1-minute gap between local and remote edits, or fast-path can mask a legitimate edit. Both the test suite and the live matrix tests hit this.
