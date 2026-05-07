import chalk from "chalk";
import { getScope } from "../scope.js";
import { loadManifest, type Manifest } from "../manifest.js";
import {
  NotionClient,
  readCheckbox,
  readRichText,
  readTitle,
  type NotionPage,
} from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { slugify } from "../convert.js";
import { type Source } from "../sources.js";
import { withSpinner } from "./_progress.js";
import { formatRelativeTime, parseDurationToDate } from "../time.js";
import { HASH_V, hashBehaviorProperties } from "../page-hash.js";

interface FeedOptions {
  since?: string;
  source?: string;
  json?: boolean;
}

/**
 * `notion-skills feed` — what's new across your skill stores.
 *
 * Two buckets per source:
 *   - 🆕 New skills published since the window cutoff that you don't
 *     have installed. Discovery surface — "try this."
 *   - 📝 Updates to skills you do have installed. Reminder surface —
 *     "you should sync."
 *
 * Drafts (`Published=false`) are filtered out — the feed is for
 * team-ready content. Window defaults to 7 days; override with
 * `--since 30d`, `--since 2w`, etc.
 *
 * Drift detection for the 📝 bucket uses `props_hash` — the same
 * primitive list/sync use. Comparing timestamps alone would fire on
 * every Installs-counter bump (each install PATCHes the page, which
 * bumps last_edited_time but not props_hash). The hash comparison
 * makes feed trustworthy: if it says updated, sync will agree.
 *
 * Known false negative: body-only edits to multi-file skills. The
 * parent's last_edited_time bumps but neither the parent's props_hash
 * nor (per Notion's quirk) reliably its last_edited_time bumps when
 * only a child page is edited. Same gap list/sync handle via slow-path
 * body fetches; deferred for feed pending real-world demand.
 */
export async function feedCommand(opts: FeedOptions): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }
  if (scope.sources.length === 0) {
    throw new Error(
      "No sources configured. Run `notion-skills source add` to link a Notion database.",
    );
  }
  await assertNtnInstalled();

  const sinceInput = opts.since ?? "7d";
  const since = parseDurationToDate(sinceInput);
  if (!since) {
    throw new Error(
      `Invalid --since "${sinceInput}". Use forms like 7d, 30d, 2w, 12h.`,
    );
  }

  const sources = opts.source
    ? scope.sources.filter((s) => s.key === opts.source)
    : scope.sources;
  if (opts.source && sources.length === 0) {
    throw new Error(
      `Unknown source "${opts.source}". Configured: ${scope.sources.map((s) => s.key).join(", ")}.`,
    );
  }

  const manifest = await loadManifest(scope.sources);

  const client = new NotionClient();
  const items: PerSourceFeed[] = [];

  for (const source of sources) {
    const pages = await withSpinner(
      `Reading ${source.key}`,
      () => client.queryDataSource(source.data_source_id),
      { noteFor: (p) => `${p.length} page${p.length === 1 ? "" : "s"}` },
    );
    items.push(partitionFeed(pages, manifest, source, since));
  }

  if (opts.json) {
    renderJson(items, since);
    return;
  }
  renderFeed(items, since);
}

// ---------- pure helpers (tested) ----------

export interface FeedItem {
  /** Source the item belongs to. */
  source_key: string;
  /** Slug derived from the Notion page title. */
  slug: string;
  /** Display title from Notion. */
  title: string;
  /** Description, may be empty. */
  description: string;
  page_id: string;
  /** When the page was created (ISO timestamp). */
  created_time: string;
  /** When the page was last edited (ISO timestamp). */
  last_edited_time: string;
  kind: "new" | "updated";
}

export interface PerSourceFeed {
  source: Source;
  items: FeedItem[];
}

/**
 * Partition a single source's pages into feed items. Pure — takes the
 * already-fetched pages and decides which bucket they fall into.
 *
 * - "new" = created within window AND not installed AND Published=true
 * - "updated" = installed AND drifted (current props_hash differs from
 *   the manifest's stored value) AND edited within window
 *
 * The 📝 bucket gates on `props_hash` rather than `last_edited_time`
 * because Notion bumps `last_edited_time` on every PATCH — including
 * the Installs counter that fires on every install. Hash comparison
 * filters out those metric-only bumps; only edits to behavior-affecting
 * properties make it through.
 *
 * Manifests older than the current `HASH_V` get a free pass — sync
 * will rebaseline their hashes on its next run. Treating them as
 * outdated would mass-false-positive across an upgrade.
 *
 * Drafts (`Published=false`) are dropped. Items are sorted within the
 * source by activity descending (most-recent first).
 */
export function partitionFeed(
  pages: NotionPage[],
  manifest: Manifest | null,
  source: Source,
  since: Date,
): PerSourceFeed {
  // Map page_id → manifest entry for this source. Used to look up
  // both installed-ness and the stored props_hash for drift detection.
  const entryByPageId = new Map<string, { props_hash: string }>();
  if (manifest) {
    for (const entry of Object.values(manifest.skills)) {
      if (entry.source_key === source.key) {
        entryByPageId.set(entry.page_id, { props_hash: entry.props_hash });
      }
    }
  }
  // Pre-HASH_V manifests have hashes from an older scheme — comparing
  // them against fresh hashes would fire across the board. Sync
  // rebaselines on its next run; until then, no 📝 bucket.
  const hashesTrustworthy = manifest ? manifest.hash_v >= HASH_V : false;

  const sinceMs = since.getTime();
  const items: FeedItem[] = [];

  for (const page of pages) {
    if (page.archived || page.in_trash) continue;
    // Drafts are filtered out — feed is for team-ready content.
    if (!readCheckbox(page.properties, "Published")) continue;

    const title = readTitle(page.properties);
    if (!title) continue;
    const slug = slugify(title);
    const description = readRichText(page.properties, "Description");

    const createdMs = new Date(page.created_time).getTime();
    const editedMs = new Date(page.last_edited_time).getTime();
    const installedEntry = entryByPageId.get(page.id);
    const isInstalled = installedEntry !== undefined;

    // New: created within window, not installed.
    if (!isInstalled && createdMs >= sinceMs) {
      items.push({
        source_key: source.key,
        slug,
        title,
        description,
        page_id: page.id,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time,
        kind: "new",
      });
      continue;
    }

    // Updated: installed, edited within window, AND props_hash actually
    // diverges. Skip pages where last_edited_time bumped but props are
    // unchanged (Installs counter bumps, Tags edits, etc.).
    if (
      isInstalled &&
      editedMs >= sinceMs &&
      hashesTrustworthy &&
      hashBehaviorProperties(page) !== installedEntry.props_hash
    ) {
      items.push({
        source_key: source.key,
        slug,
        title,
        description,
        page_id: page.id,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time,
        kind: "updated",
      });
    }
  }

  // Most-recent activity first.
  items.sort((a, b) => activityTime(b) - activityTime(a));

  return { source, items };
}

function activityTime(item: FeedItem): number {
  return item.kind === "new"
    ? new Date(item.created_time).getTime()
    : new Date(item.last_edited_time).getTime();
}

// ---------- rendering ----------

function renderFeed(perSource: PerSourceFeed[], since: Date): void {
  const total = perSource.reduce((n, s) => n + s.items.length, 0);
  console.log();
  console.log(chalk.bold(formatWindowHeader(since)));
  console.log();

  if (total === 0) {
    console.log(chalk.dim("Nothing new."));
    console.log();
    return;
  }

  for (const { source, items } of perSource) {
    if (items.length === 0) continue;
    console.log(chalk.bold(source.key) + chalk.dim(` — ${source.name}`));

    for (const item of items) {
      const icon = item.kind === "new" ? chalk.green("🆕") : chalk.yellow("📝");
      const when = formatRelativeTime(
        new Date(item.kind === "new" ? item.created_time : item.last_edited_time),
      );
      console.log(`  ${icon} ${chalk.cyan(item.slug)} ${chalk.dim(when)}`);
      if (item.kind === "new" && item.description) {
        console.log(`     ${chalk.dim(truncate(item.description, 80))}`);
      }
    }
    console.log();
  }

  // Action summary — what the user can do with this output.
  const newCount = perSource.flatMap((s) => s.items).filter((i) => i.kind === "new").length;
  const updatedCount = total - newCount;
  const hints: string[] = [];
  if (newCount > 0) hints.push(`Try one with ${chalk.cyan("notion-skills install <slug>")}`);
  if (updatedCount > 0) hints.push(`Pull updates with ${chalk.cyan("notion-skills sync")}`);
  if (hints.length > 0) {
    console.log(chalk.dim(hints.join(". ") + "."));
    console.log();
  }
}

/**
 * Render a "since" window in human-readable form for the feed header.
 * Picks the largest unit that fully contains the window (a 12-hour
 * window reads "last 12 hours," not "last day"), then rounds the
 * value within that unit.
 */
export function formatWindowHeader(since: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - since.getTime());
  const ONE_HOUR = 60 * 60_000;
  const ONE_DAY = 24 * ONE_HOUR;
  const ONE_WEEK = 7 * ONE_DAY;
  const ONE_MONTH = 30 * ONE_DAY;
  const ONE_YEAR = 365 * ONE_DAY;

  if (diffMs >= ONE_YEAR) {
    const y = Math.round(diffMs / ONE_YEAR);
    return `Activity in the last ${y === 1 ? "year" : `${y} years`}`;
  }
  if (diffMs >= ONE_MONTH) {
    const months = Math.round(diffMs / ONE_MONTH);
    return `Activity in the last ${months === 1 ? "month" : `${months} months`}`;
  }
  if (diffMs >= ONE_WEEK) {
    const weeks = Math.round(diffMs / ONE_WEEK);
    return `Activity in the last ${weeks === 1 ? "week" : `${weeks} weeks`}`;
  }
  if (diffMs >= ONE_DAY) {
    const days = Math.round(diffMs / ONE_DAY);
    return `Activity in the last ${days === 1 ? "day" : `${days} days`}`;
  }
  if (diffMs >= ONE_HOUR) {
    const hours = Math.round(diffMs / ONE_HOUR);
    return `Activity in the last ${hours === 1 ? "hour" : `${hours} hours`}`;
  }
  const minutes = Math.max(1, Math.round(diffMs / 60_000));
  return `Activity in the last ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
}

function renderJson(perSource: PerSourceFeed[], since: Date): void {
  const payload = {
    since: since.toISOString(),
    sources: perSource.map(({ source, items }) => ({
      key: source.key,
      name: source.name,
      items,
    })),
  };
  console.log(JSON.stringify(payload, null, 2));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
