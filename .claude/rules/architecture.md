# Architecture invariants

Single-sentence rules that must not be silently broken.

## Notion API access

**All Notion API calls shell out to `ntn`** (Notion's official CLI) via `src/notion.ts`. Auth lives in `ntn login`. Do not add an HTTP client, an OAuth flow, or a separate `@notionhq/client` import — bypassing `ntn` breaks every workflow downstream and forks the auth story.

## Single sources of truth

- `src/schema.ts` — property ↔ frontmatter mapping. Add new properties to `SCHEMA`, never to ad-hoc helpers. The `metricOnly` and `taxonomyOnly` flags determine what's excluded from drift hashing.
- `src/known-targets.ts` — the registry of supported agent CLIs. Adding one is a single entry; don't fan logic out elsewhere.
- `src/page-hash.ts` — content-hash derivation (`hashBehaviorProperties`, `hashBody`, `HASH_V`). Drift detection across `sync`, `install`, `publish`, and `list` all funnel through here so the hash is stable.

## Pure helpers stay pure

`sync-decision.ts`, `local-state.ts`, `page-hash.ts`, schema utilities — these own logic that's testable without spinning up an `ntn` mock. Orchestration (`sync.ts`, `migrate.ts`, the command files) consumes them. When you fix a bug, prefer "extract pure helper, write regression test, fix" over "patch the orchestrator."

## Migrate is the publish/import engine

`migrate.ts` is the workhorse. `publish.ts` and `import.ts` thin-wrap it. `migrate` survives as a hidden deprecated alias. Don't reintroduce parallel implementations.

## Build boundary

The published npm artifact is the contents of `dist/`. Tests live in `test/*.test.mjs` and import from `dist/` (so `npm test` runs `tsc` first). **Never import from `dist/` in `src/`** — that'd create a build cycle.
