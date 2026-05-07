import chalk from "chalk";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import {
  NotionClient,
  type NotionPage,
  readRichText,
  readTitle,
} from "./notion.js";
import { assertNtnInstalled } from "./ntn.js";
import {
  buildSkillMarkdown,
  convertPageToSkill,
  slugify,
} from "./convert.js";
import {
  type Manifest,
  diffManifest,
  emptyManifest,
  hashContent,
  readManifest,
  writeManifest,
} from "./manifest.js";
import type { Source } from "./sources.js";
import { defaultSource } from "./sources.js";
import {
  HASH_V,
  hashBehaviorProperties,
  hashSkillContent,
} from "./page-hash.js";
import { materializeFiles } from "./skill-files.js";
import {
  collidingSlugSet,
  detectSlugCollisions,
} from "./slug-collisions.js";
import { applyRenames, detectRenames } from "./renames.js";
import {
  ensureSymlink,
  removeSymlink,
  targetSkillPath,
  targetsForKeys,
} from "./targets.js";
import { MANIFEST_FILE, SKILLS_STORE } from "./paths.js";
import type { Scope } from "./scope.js";
import { detectLocalState } from "./local-state.js";

export interface SyncSummary {
  created: string[];
  updated: string[];
  pushed: string[];
  removed: string[];
  unchanged: string[];
  invalid: { title: string; reason: string }[];
  conflicts: { name: string; target: string }[];
  /** Per-skill detail when both sides changed since last sync. */
  resolutions: ConflictResolution[];
}

export interface ConflictResolution {
  name: string;
  winner: "local" | "remote";
  localEditedAt: string;
  remoteEditedAt: string;
}

export interface RunSyncOptions {
  /**
   * When true, suppress all console output and skip the
   * bias-against-deletion confirm prompt (locals are preserved by default).
   * Used by `migrate` after it's already shown its own per-skill UI.
   */
  quiet?: boolean;
  /**
   * Page IDs to force-refetch even if the manifest's last_edited_time
   * matches Notion's. Used by `publish`-style flows where a skill's
   * manifest entry was just written (so the diff says "unchanged") but
   * we still want to round-trip through Notion's normaliser to capture
   * the canonical formatting.
   */
  extraFetchIds?: Set<string>;
}

/**
 * Bidirectional sync between Notion and the local central store.
 *
 *   - Pull: Notion's pages → ~/.notion-skills/skills/<name>/SKILL.md
 *   - Push: locally-edited SKILL.md → Notion page properties + body
 *
 * Local edits are detected by comparing each SKILL.md's current content
 * hash against `local_hash` stored in the manifest from the last sync.
 * Remote edits are detected by Notion's `last_edited_time` + the
 * `props_hash` summary (Notion does NOT bump last_edited_time for
 * property-only edits).
 *
 * Conflicts (both sides drifted since last sync) are resolved
 * last-edit-wins via `localMtime` vs `remoteEditedAt`. The loser's
 * content is preserved by Notion's own page history; we don't try to
 * merge.
 *
 * Bias against deletion: when Notion has fewer skills than the local
 * manifest expected, prompt before removing locals.
 *
 * Safety rule: if the on-disk manifest references a different database
 * than the current scope, treat as fresh — don't apply that manifest's
 * "missing" set as deletions, and don't run any pushes (the manifest's
 * `local_hash` belongs to a different DB so drift signals are bogus).
 */
export async function runSync(
  scope: Scope,
  options: RunSyncOptions = {},
): Promise<SyncSummary> {
  await assertNtnInstalled();
  const client = new NotionClient();
  const quiet = !!options.quiet;
  const log = (s: string) => { if (!quiet) console.log(s); };
  const warn = (s: string) => { if (!quiet) console.warn(s); };

  const summary: SyncSummary = {
    created: [],
    updated: [],
    pushed: [],
    removed: [],
    unchanged: [],
    invalid: [],
    conflicts: [],
    resolutions: [],
  };

  if (scope.sources.length === 0) {
    return summary;
  }

  // Iterate every configured source. Each source's pages are scoped to
  // its data_source_id; the manifest carries source_key per entry so
  // we know which entries are in scope at each step.
  for (const source of scope.sources) {
    await runSyncForSource(client, scope, source, summary, options, { log, warn, quiet });
  }
  return summary;
}

/**
 * Sync a single source into the shared manifest. Each phase is a named
 * helper below; the orchestrator just sequences them. The shared
 * manifest mutates across phases — sync's job is to converge it toward
 * Notion's state for this source.
 */
async function runSyncForSource(
  client: NotionClient,
  scope: Scope,
  source: Source,
  summary: SyncSummary,
  options: RunSyncOptions,
  io: SyncIO,
): Promise<void> {
  const contentRoot = SKILLS_STORE;
  const queried = await queryAndSummarise(client, source, scope, io);

  const manifest = await loadOrEmptyManifest(scope);
  applyRenamesForSource(manifest, source, queried.pages, io.log);

  const kept = filterKept(queried.summaries, queried.colliding, manifest, source, options);
  const diff = computeFetchSet(manifest, source, kept);
  forceMultiFileRefetch(manifest, source, kept, diff);

  const { drift, missingPageIds } = await detectLocalState(manifest, contentRoot);
  const driftReminders = await handleDriftBackups(
    drift,
    diff.toFetch,
    kept,
    contentRoot,
    io.log,
  );

  const approvedRemovals = await confirmRemovals(diff.toRemove, io);

  manifest.last_synced_at = new Date().toISOString();
  manifest.hash_v = HASH_V;
  for (const localSlug of diff.toRemove) {
    delete manifest.skills[localSlug];
  }

  const toFetch = kept.filter((k) =>
    new Set([...diff.toFetch, ...missingPageIds, ...(options.extraFetchIds ?? [])]).has(k.id),
  );
  await pullPages(client, source, queried.pages, toFetch, kept, manifest, contentRoot, summary, io.log);

  await backfillLocalHash(manifest, source, contentRoot);
  dropStaleLocalHash(manifest, diff.toRemove, approvedRemovals);

  await removeApprovedFromDisk(approvedRemovals, contentRoot, summary);
  await reconcileTargets(scope, manifest, source, approvedRemovals, contentRoot, summary);

  recordUnchanged(diff.unchanged, manifest, toFetch, summary);
  printDriftReminders(driftReminders, io.log);

  await writeManifest(MANIFEST_FILE, manifest);
}

interface SyncIO {
  log: (s: string) => void;
  warn: (s: string) => void;
  quiet: boolean;
}

// ---------- phase: query the source + summarise pages ----------

async function queryAndSummarise(
  client: NotionClient,
  source: Source,
  scope: Scope,
  io: SyncIO,
): Promise<{
  pages: NotionPage[];
  summaries: PageSummary[];
  colliding: Set<string>;
}> {
  const sourceLabel = scope.sources.length === 1 ? "" : ` ${chalk.dim(`[${source.key}]`)}`;
  if (!io.quiet) process.stdout.write(chalk.dim(`Querying ${source.name}${sourceLabel}... `));
  const pages = await client.queryDataSource(source.data_source_id);
  io.log(chalk.green(`✓`) + chalk.dim(` ${pages.length} pages`));

  const summaries = pages
    .filter((p) => !p.archived && !p.in_trash)
    .map(summarisePage)
    .filter((s) => s !== null) as PageSummary[];

  const collisions = detectSlugCollisions(pages);
  const colliding = collidingSlugSet(collisions);
  if (collisions.length > 0) {
    io.warn(
      chalk.yellow(
        `Skipping ${collisions.length} duplicate ${collisions.length === 1 ? "slug" : "slugs"}: ${collisions.map((c) => c.slug).join(", ")}. Rename one of the colliding pages in Notion.`,
      ),
    );
  }
  return { pages, summaries, colliding };
}

async function loadOrEmptyManifest(scope: Scope): Promise<Manifest> {
  const defaultKey = defaultSource(scope.sources)?.key ?? scope.sources[0]?.key ?? "default";
  return (await readManifest(MANIFEST_FILE, defaultKey)) ?? emptyManifest();
}

// ---------- phase: rename detection (mutates manifest in place) ----------

function applyRenamesForSource(
  manifest: Manifest,
  source: Source,
  pages: NotionPage[],
  log: (s: string) => void,
): void {
  const ops = detectRenames(manifest, source.key, pages);
  if (ops.length === 0) return;
  applyRenames(manifest, ops);
  for (const op of ops) {
    log(
      chalk.cyan(
        `↪ ${op.oldSourceSlug} → ${op.newSourceSlug} ${chalk.dim(`(renamed in Notion; local '${op.localSlug}' stays)`)}`,
      ),
    );
  }
}

// ---------- phase: narrow to skills the user has installed ----------

function filterKept(
  summaries: PageSummary[],
  colliding: Set<string>,
  manifest: Manifest,
  source: Source,
  options: RunSyncOptions,
): PageSummary[] {
  // Sync is install-narrowed: only operate on skills the user has
  // installed for THIS source. extraFetchIds is the publish-side escape
  // hatch — a just-published page hasn't landed in the manifest yet,
  // but we want to round-trip its content through Notion's normaliser.
  const trackedSourceSlugs = new Set<string>();
  for (const entry of Object.values(manifest.skills)) {
    if (entry.source_key === source.key) trackedSourceSlugs.add(entry.source_slug);
  }
  const extraFetchIds = options.extraFetchIds ?? new Set<string>();
  return summaries
    .filter((s) => !colliding.has(s.name))
    .filter((s) => trackedSourceSlugs.has(s.name) || extraFetchIds.has(s.id));
}

// ---------- phase: compute the diff against the manifest ----------

function computeFetchSet(
  manifest: Manifest,
  source: Source,
  kept: PageSummary[],
): { toFetch: string[]; toRemove: string[]; unchanged: string[] } {
  return diffManifest(
    manifest,
    kept.map((k) => ({
      name: k.name,
      source_key: source.key,
      pageId: k.id,
      lastEditedTime: k.lastEditedTime,
      propsHash: k.propsHash,
    })),
    new Set([source.key]),
  );
}

function forceMultiFileRefetch(
  manifest: Manifest,
  source: Source,
  kept: PageSummary[],
  diff: { toFetch: string[]; unchanged: string[] },
): void {
  // Notion doesn't always bump the parent's last_edited_time when only
  // a child page edits — so for any tracked multi-file skill we force-
  // include it in the refetch set on every sync. That moves it from
  // unchanged → toFetch; the body hash check then either confirms no
  // drift or flags it as outdated.
  for (const [localSlug, entry] of Object.entries(manifest.skills)) {
    if (entry.source_key !== source.key) continue;
    if ((entry.files?.length ?? 0) === 0) continue;
    const summary = kept.find((k) => k.name === entry.source_slug);
    if (!summary || diff.toFetch.includes(summary.id)) continue;
    diff.toFetch.push(summary.id);
    const idx = diff.unchanged.indexOf(localSlug);
    if (idx >= 0) diff.unchanged.splice(idx, 1);
  }
}

// ---------- phase: backup local edits when conflict ----------

async function handleDriftBackups(
  localDrift: Map<string, { mdContent: string }>,
  remoteFetchIds: string[],
  kept: PageSummary[],
  contentRoot: string,
  log: (s: string) => void,
): Promise<string[]> {
  // App-store rule: sync never pushes — that's `publish`. For each
  // drifted skill: if remote ALSO changed, back up the local edit
  // before the pull phase overwrites; if remote unchanged, surface a
  // one-liner reminding the user to publish.
  const remoteChangedNames = new Set<string>();
  for (const k of kept) if (remoteFetchIds.includes(k.id)) remoteChangedNames.add(k.name);

  const reminders: string[] = [];
  for (const [name, drift] of localDrift) {
    if (!remoteChangedNames.has(name)) {
      reminders.push(name);
      continue;
    }
    try {
      const backupDir = join(
        contentRoot,
        "..",
        "backup",
        "sync-overwrite",
        `${name}-${conflictBackupTimestamp()}`,
      );
      await mkdir(backupDir, { recursive: true });
      await writeFile(join(backupDir, "SKILL.md"), drift.mdContent, "utf8");
      log(
        chalk.yellow(
          `⚠ ${name}: had local edits AND a newer version was published. Backed up your edit to ${backupDir} before pulling.`,
        ),
      );
    } catch {
      log(
        chalk.yellow(
          `⚠ ${name}: had local edits AND a newer version was published. Backup failed; pull will overwrite.`,
        ),
      );
    }
  }
  return reminders;
}

// ---------- phase: confirm removals (TTY only) ----------

async function confirmRemovals(toRemove: string[], io: SyncIO): Promise<string[]> {
  if (toRemove.length === 0 || !process.stdin.isTTY || io.quiet) return [];
  console.log("");
  console.log(
    chalk.yellow(
      `${toRemove.length} ${toRemove.length === 1 ? "skill is" : "skills are"} no longer in Notion:`,
    ),
  );
  for (const n of toRemove) console.log(`  ${chalk.dim("·")} ${n}`);
  const ok = await confirm({
    message: "Remove them locally to match?",
    default: false,
  });
  return ok ? toRemove : [];
}

// ---------- phase: pull pages from Notion ----------

async function pullPages(
  client: NotionClient,
  source: Source,
  pages: NotionPage[],
  toFetch: PageSummary[],
  kept: PageSummary[],
  manifest: Manifest,
  contentRoot: string,
  summary: SyncSummary,
  log: (s: string) => void,
): Promise<void> {
  if (toFetch.length === 0) return;
  log(chalk.dim(`Pulling ${toFetch.length} ${toFetch.length === 1 ? "page" : "pages"}:`));

  const verbose = process.env.NOTION_SKILLS_DEBUG === "1";
  for (const summaryPage of toFetch) {
    if (verbose) console.error(`Fetching "${summaryPage.title}" (${summaryPage.id})...`);
    const page = pages.find((p) => p.id === summaryPage.id)!;
    const converted = await convertPageToSkill(client, page);
    if (!converted.ok) {
      summary.invalid.push({ title: summaryPage.title, reason: converted.reason });
      log(`  ${chalk.yellow("!")} ${summaryPage.title} ${chalk.dim(`(${converted.reason})`)}`);
      continue;
    }
    await applySkillPullResult(converted.skill, source, manifest, kept, contentRoot, summary, log);
  }
}

async function applySkillPullResult(
  skill: import("./convert.js").ConvertedSkill,
  source: Source,
  manifest: Manifest,
  kept: PageSummary[],
  contentRoot: string,
  summary: SyncSummary,
  log: (s: string) => void,
): Promise<void> {
  const md = buildSkillMarkdown({ properties: skill.properties, body: skill.body });
  const sourceSlug = skill.properties.name;
  // Preserve local_slug across re-fetches by matching on stable
  // page_id. New entries — only ever created via extraFetchIds —
  // adopt source_slug as their initial local_slug.
  const existing = Object.entries(manifest.skills).find(
    ([, e]) => e.source_key === source.key && e.page_id === skill.pageId,
  );
  const localSlug = existing ? existing[0]! : sourceSlug;
  const skillDir = join(contentRoot, localSlug);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), md, "utf8");
  await materializeFiles(skillDir, skill.files);

  const wasNew = !existing;
  if (wasNew) summary.created.push(localSlug);
  else summary.updated.push(localSlug);

  const matchingSummary = kept.find((k) => k.id === skill.pageId);
  manifest.skills[localSlug] = {
    source_key: source.key,
    source_slug: sourceSlug,
    page_id: skill.pageId,
    last_edited_time: skill.lastEditedTime,
    props_hash: matchingSummary?.propsHash ?? "",
    body_hash: hashSkillContent(skill.body, skill.files),
    local_hash: hashSkillContent(md, skill.files),
    files: skill.files.map((f) => f.path).sort(),
  };

  log(`  ${wasNew ? chalk.green("+") : chalk.cyan("↓")} ${localSlug}`);
}

// ---------- phase: backfill / drop local hashes ----------

async function backfillLocalHash(
  manifest: Manifest,
  source: Source,
  contentRoot: string,
): Promise<void> {
  // After the pull, every tracked entry from this source has a fresh
  // SKILL.md on disk that matches what we just wrote — record the hash
  // so the next sync's drift check can short-circuit. Scope to this
  // source so we don't keep retrying entries belonging to sources we
  // haven't synced yet.
  for (const [localSlug, entry] of Object.entries(manifest.skills)) {
    if (entry.source_key !== source.key) continue;
    if (entry.local_hash !== undefined) continue;
    const file = join(contentRoot, localSlug, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const raw = await readFile(file, "utf8");
      manifest.skills[localSlug] = { ...entry, local_hash: hashContent(raw) };
    } catch {
      // Read failure: leave local_hash unset so next sync retries.
    }
  }
}

function dropStaleLocalHash(
  manifest: Manifest,
  proposedRemoves: string[],
  approved: string[],
): void {
  // Skills declined for removal stay on disk but their local_hash now
  // points at content that no longer matches Notion. Drop the field so
  // the next sync rehashes from the live file.
  for (const localSlug of proposedRemoves) {
    if (approved.includes(localSlug)) continue;
    if (!manifest.skills[localSlug]) continue;
    const { local_hash: _drop, ...rest } = manifest.skills[localSlug];
    manifest.skills[localSlug] = rest as Manifest["skills"][string];
  }
}

// ---------- phase: filesystem reconcile ----------

async function removeApprovedFromDisk(
  approved: string[],
  contentRoot: string,
  summary: SyncSummary,
): Promise<void> {
  for (const localSlug of approved) {
    const skillDir = join(contentRoot, localSlug);
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: true, force: true });
    }
    summary.removed.push(localSlug);
  }
}

async function reconcileTargets(
  scope: Scope,
  manifest: Manifest,
  source: Source,
  approved: string[],
  contentRoot: string,
  summary: SyncSummary,
): Promise<void> {
  const targets = targetsForKeys(scope.targets);
  for (const t of targets) {
    for (const [localSlug, entry] of Object.entries(manifest.skills)) {
      if (entry.source_key !== source.key) continue;
      const real = join(contentRoot, localSlug);
      const link = targetSkillPath(t, localSlug);
      const result = await ensureSymlink(real, link);
      if (result === "skipped") summary.conflicts.push({ name: localSlug, target: link });
    }
    for (const localSlug of approved) {
      await removeSymlink(targetSkillPath(t, localSlug));
    }
  }
}

// ---------- phase: tail bookkeeping ----------

function recordUnchanged(
  unchanged: string[],
  manifest: Manifest,
  toFetch: PageSummary[],
  summary: SyncSummary,
): void {
  // "Unchanged" reflects what neither side touched and we didn't
  // force-pull — computed AFTER the pull phase so the count is honest.
  const touched = new Set(toFetch.map((k) => k.id));
  for (const localSlug of unchanged) {
    const entry = manifest.skills[localSlug];
    if (entry && !touched.has(entry.page_id)) summary.unchanged.push(localSlug);
  }
}

function printDriftReminders(reminders: string[], log: (s: string) => void): void {
  for (const localSlug of reminders) {
    log(
      chalk.yellow(
        `↑ ${localSlug}: you have local edits — run \`notion-skills publish ${localSlug}\` to share them with your team.`,
      ),
    );
  }
}

interface PageSummary {
  id: string;
  title: string;
  name: string;
  description: string;
  lastEditedTime: string;
  /** Hash over every spec-mapped property; used by manifest diff. */
  propsHash: string;
}

function summarisePage(page: NotionPage): PageSummary | null {
  const title = readTitle(page.properties);
  if (!title) return null;
  const description = readRichText(page.properties, "Description");

  return {
    id: page.id,
    title,
    name: slugify(title),
    description,
    lastEditedTime: page.last_edited_time,
    propsHash: hashBehaviorProperties(page),
  };
}

function conflictBackupTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "_" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

export function printSummary(summary: SyncSummary): void {
  console.log("");
  if (summary.pushed.length) {
    console.log(chalk.green(`↑ Pushed (${summary.pushed.length}):`));
    for (const n of summary.pushed) console.log(`    ${n}`);
  }
  if (summary.created.length) {
    console.log(chalk.green(`+ Created (${summary.created.length}):`));
    for (const n of summary.created) console.log(`    ${n}`);
  }
  if (summary.updated.length) {
    console.log(chalk.cyan(`↓ Updated (${summary.updated.length}):`));
    for (const n of summary.updated) console.log(`    ${n}`);
  }
  if (summary.removed.length) {
    console.log(chalk.red(`- Removed (${summary.removed.length}):`));
    for (const n of summary.removed) console.log(`    ${n}`);
  }
  if (summary.resolutions.length) {
    console.log(chalk.yellow(`⚠ Conflicts resolved (${summary.resolutions.length}):`));
    for (const r of summary.resolutions) {
      const kept = r.winner === "local" ? "kept local" : "kept Notion";
      console.log(`    ${r.name} — ${kept}`);
    }
  }
  if (summary.unchanged.length) {
    console.log(chalk.dim(`= Unchanged (${summary.unchanged.length})`));
  }
  if (summary.invalid.length) {
    console.log(chalk.yellow(`! Skipped invalid (${summary.invalid.length}):`));
    for (const i of summary.invalid) console.log(`    "${i.title}" — ${i.reason}`);
  }
  if (summary.conflicts.length) {
    console.log(chalk.yellow(`! Symlink conflicts (${summary.conflicts.length}):`));
    for (const c of summary.conflicts) {
      console.log(`    ${c.name} — existing non-symlink at ${c.target} (skipped)`);
    }
  }
  console.log("");
}
