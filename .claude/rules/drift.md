# Drift detection

The drift signal is content-based, not timestamp-based. A skill is "outdated" when what an agent will execute has changed.

## What counts as drift

| Change | Counts? | Why |
|---|---|---|
| Body markdown edited in Notion | yes | changes what the agent reads |
| Description / when_to_use / model / agent / allowed-tools / etc. | yes | changes how/when the model runs the skill |
| Tags edited | **no** | discovery sugar, doesn't affect execution |
| Installs counter incremented | **no** | store-managed metric, not user content |
| Local SKILL.md edited on disk | yes (different signal) | tracked by `local_hash`, surfaces as a publish reminder, not pull-outdated |

The `taxonomyOnly` and `metricOnly` flags in `src/schema.ts` are what excludes Tags and Installs from `props_hash`. Don't add new excluded properties without thinking about the failure mode.

## Two-phase outdated check (`list`)

1. **Fast path**: `page.last_edited_time === entry.last_edited_time` → not outdated. Most common case, no API calls.
2. **Slow path**: `props_hash` differs → outdated. Else fetch blocks, compare `body_hash`. If both match, the page was touched by a metric or tag edit; cache the fresh `last_edited_time` + `body_hash` so the next `list` short-circuits on the fast path.

`list` writing to the manifest is intentional (transparent perf cache update). The next run is faster; the data on disk is always at least as fresh.

## Hash version (`hash_v`)

`HASH_V` lives in `src/page-hash.ts`. Bump it when:
- the property set contributing to `props_hash` changes
- any reader for those properties changes shape
- the hash function itself changes

Pre-`hash_v=2` manifests show as "not outdated" until `sync` rebaselines them — better than mass false positives.

## Time rounding gotcha

Notion's `last_edited_time` rounds to the minute. Time-sensitive tests need a ≥ 1-minute gap between local and remote edits, or fast-path can mask a legitimate edit. Both the test suite and the live matrix tests hit this.
