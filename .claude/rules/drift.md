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

The `taxonomyOnly` and `metricOnly` flags in `src/schema.ts` are what excludes Tags and Installs from `props_hash`. Don't add new excluded properties without thinking about the failure mode.

## Two-phase outdated check (`list`)

1. **Fast path**: `page.last_edited_time === entry.last_edited_time` → not outdated. Most common case, no API calls.
2. **Slow path**: `props_hash` differs → outdated. Else fetch parent body + every child page, compare `hashSkillContent`. If both match, the page was touched by a metric or tag edit; cache the fresh `last_edited_time` + `body_hash` so the next `list` short-circuits on the fast path.

**Multi-file skills always take the slow path.** Notion doesn't reliably bump the parent's `last_edited_time` when only a child page is edited, so the fast path can silently miss those edits. The manifest entry's `files: string[]` carries the list of sibling files; whenever it's non-empty, drift checks fetch children unconditionally. Same rule applies in `sync.ts`: every multi-file skill is force-included in the refetch set.

`list` writing to the manifest is intentional (transparent perf cache update). The next run is faster; the data on disk is always at least as fresh.

## Hash version (`hash_v`)

`HASH_V` lives in `src/page-hash.ts`. Bump it when:
- the property set contributing to `props_hash` changes
- any reader for those properties changes shape
- the hash function itself changes

Pre-`hash_v=2` manifests show as "not outdated" until `sync` rebaselines them — better than mass false positives.

## Time rounding gotcha

Notion's `last_edited_time` rounds to the minute. Time-sensitive tests need a ≥ 1-minute gap between local and remote edits, or fast-path can mask a legitimate edit. Both the test suite and the live matrix tests hit this.
