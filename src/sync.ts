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
import { shouldSyncSkill } from "./filter.js";
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
import {
  HASH_V,
  hashBehaviorProperties,
  hashBody,
} from "./page-hash.js";
import { materializeFiles } from "./skill-files.js";
import {
  collidingSlugSet,
  detectSlugCollisions,
} from "./slug-collisions.js";
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
  const write = (s: string) => { if (!quiet) process.stdout.write(s); };

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

  write(chalk.dim(`Querying ${scope.database_title ?? "database"}... `));
  const pages = await client.queryDataSource(scope.data_source_id);
  log(chalk.green(`✓`) + chalk.dim(` ${pages.length} pages`));

  // Derive name + property hash without fetching block content.
  const summaries = pages
    .filter((p) => !p.archived && !p.in_trash)
    .map(summarisePage)
    .filter((s) => s !== null) as Array<PageSummary>;

  const collisions = detectSlugCollisions(pages);
  const colliding = collidingSlugSet(collisions);
  if (collisions.length > 0) {
    warn(
      chalk.yellow(
        `Skipping ${collisions.length} duplicate ${collisions.length === 1 ? "slug" : "slugs"}: ${collisions.map((c) => c.slug).join(", ")}. Rename one of the colliding pages in Notion.`,
      ),
    );
  }

  // App-store rule: sync only operates on skills the user has installed
  // (i.e. has a manifest entry). New pages in Notion appear in `list`
  // and have to be explicitly `install`-ed.
  //
  // Caller exception: `extraFetchIds` lets publish-style flows include
  // a page that was JUST uploaded (and therefore not in the manifest
  // yet) in the pull phase, so we round-trip through Notion's
  // normalisation and create the manifest entry for it.
  const trackedNames = new Set(
    Object.keys((await readManifest(MANIFEST_FILE))?.skills ?? {}),
  );
  const extraFetchIds = options.extraFetchIds ?? new Set<string>();
  const kept = summaries
    .filter((s) => !colliding.has(s.name))
    .filter((s) => shouldSyncSkill(s.name, scope.exclude_skills))
    .filter((s) => trackedNames.has(s.name) || extraFetchIds.has(s.id));

  // Load manifest, but only honour it if it belongs to the current DB.
  // Otherwise treat as fresh: we don't want a manifest from a previous
  // database to drive deletions against locals OR fake push-drift.
  const manifestPath = MANIFEST_FILE;
  const contentRoot = SKILLS_STORE;
  const onDiskManifest = await readManifest(manifestPath);
  const dbChanged =
    !!onDiskManifest && onDiskManifest.database_id !== scope.database_id;
  if (dbChanged) {
    log(
      chalk.dim(
        `Configured database changed since last sync — local skills will be preserved.`,
      ),
    );
  }
  const oldManifest =
    onDiskManifest && !dbChanged
      ? onDiskManifest
      : emptyManifest(scope.database_id, scope.data_source_id);

  const diff = diffManifest(
    oldManifest,
    kept.map((k) => ({
      name: k.name,
      pageId: k.id,
      lastEditedTime: k.lastEditedTime,
      propsHash: k.propsHash,
    })),
  );

  // ---- Detect local edits (drift in SKILL.md content hashes) -----------
  //
  // For each skill the manifest tracks, hash the current SKILL.md and
  // compare to what we stored at the last sync. Drift means the user
  // edited locally; missing files force a pull (recovery path).
  const { drift: localDrift, missingPageIds: missingLocalPageIds } =
    await detectLocalState(oldManifest, contentRoot);

  // ---- Drift handling ---------------------------------------------------
  //
  // App-store model: pull is implicit, push is explicit. Sync never pushes
  // local edits — that's `publish`. For each drifted skill:
  //   - If remote is unchanged: leave local as-is, surface a one-liner
  //     reminding the user to publish if they want their changes shared.
  //   - If remote ALSO changed: backup the local edit, then let the pull
  //     phase overwrite (Notion's version wins, user's local work is
  //     preserved on disk so they can recover).
  const remoteChangedNames = new Set<string>();
  for (const k of kept) if (diff.toFetch.includes(k.id)) remoteChangedNames.add(k.name);

  const localDriftReminders: string[] = [];
  for (const [name, drift] of localDrift) {
    const remoteChanged = remoteChangedNames.has(name);
    if (!remoteChanged) {
      localDriftReminders.push(name);
      continue;
    }
    // Local changed AND remote changed → pull will overwrite. Save the
    // local edit so the user can recover. Same pattern uninstall uses.
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

  // ---- Removal prompt (bias against deletion) -------------------------
  let approvedRemovals: string[] = [];
  if (diff.toRemove.length > 0 && process.stdin.isTTY && !quiet) {
    console.log("");
    console.log(
      chalk.yellow(
        `${diff.toRemove.length} ${diff.toRemove.length === 1 ? "skill is" : "skills are"} no longer in Notion:`,
      ),
    );
    for (const n of diff.toRemove) console.log(`  ${chalk.dim("·")} ${n}`);
    const ok = await confirm({
      message: "Remove them locally to match?",
      default: false,
    });
    if (ok) approvedRemovals = diff.toRemove;
  }

  // ---- Build next manifest from old, layer changes --------------------
  const nextManifest: Manifest = {
    version: 1,
    database_id: scope.database_id,
    data_source_id: scope.data_source_id,
    last_synced_at: new Date().toISOString(),
    hash_v: HASH_V,
    skills: { ...oldManifest.skills },
  };

  // Approved removals get dropped from manifest + central store + target
  // symlinks. Declined removals get dropped from MANIFEST only — the
  // central-store dirs and symlinks stay so the user keeps the content.
  for (const name of diff.toRemove) {
    delete nextManifest.skills[name];
  }

  // ---- Pull phase ------------------------------------------------------
  //
  // Build the to-fetch set: anything diff said to fetch, plus anything
  // whose local SKILL.md has gone missing (so the user can rm and
  // re-pull), plus anything the caller explicitly forced (publish-side
  // round-trip).
  const toFetchIds = new Set<string>([
    ...diff.toFetch,
    ...missingLocalPageIds,
    ...(options.extraFetchIds ?? []),
  ]);
  const toFetch = kept.filter((k) => toFetchIds.has(k.id));

  if (toFetch.length > 0) {
    log(chalk.dim(`Pulling ${toFetch.length} ${toFetch.length === 1 ? "page" : "pages"}:`));
  }

  const verbose = process.env.NOTION_SKILLS_DEBUG === "1";
  for (let i = 0; i < toFetch.length; i++) {
    const summary_page = toFetch[i]!;
    if (verbose) {
      console.error(`Fetching "${summary_page.title}" (${summary_page.id})...`);
    }
    const page = pages.find((p) => p.id === summary_page.id)!;
    const converted = await convertPageToSkill(client, page);
    if (!converted.ok) {
      summary.invalid.push({ title: summary_page.title, reason: converted.reason });
      log(`  ${chalk.yellow("!")} ${summary_page.title} ${chalk.dim(`(${converted.reason})`)}`);
      continue;
    }
    const skill = converted.skill;
    const md = buildSkillMarkdown({
      properties: skill.properties,
      body: skill.body,
    });
    const skillName = skill.properties.name;
    const skillDir = join(contentRoot, skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), md, "utf8");
    await materializeFiles(skillDir, skill.files);

    const wasNew = !oldManifest.skills[skillName];
    if (wasNew) summary.created.push(skillName);
    else summary.updated.push(skillName);

    const matchingSummary = kept.find((k) => k.id === skill.pageId);
    nextManifest.skills[skillName] = {
      page_id: skill.pageId,
      last_edited_time: skill.lastEditedTime,
      props_hash: matchingSummary?.propsHash ?? "",
      body_hash: hashBody(skill.body),
      local_hash: hashContent(md),
    };

    const mark = wasNew ? chalk.green("+") : chalk.cyan("↓");
    log(`  ${mark} ${skillName}`);
  }

  // ---- Backfill local_hash for skills the manifest already tracked ----
  //
  // After this loop runs, every entry the user's local matches what we
  // last wrote — so re-hash each on-disk SKILL.md and store. This catches
  // legacy manifests (no local_hash) AND skills that didn't need a pull
  // this round but should still get their hash recorded.
  for (const [name, entry] of Object.entries(nextManifest.skills)) {
    if (entry.local_hash !== undefined) continue;
    const file = join(contentRoot, name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const raw = await readFile(file, "utf8");
      nextManifest.skills[name] = { ...entry, local_hash: hashContent(raw) };
    } catch {
      // Read failure: leave local_hash unset so next sync retries.
    }
  }
  // Skills declined for removal from manifest may have stale local_hash
  // pointing at a now-different file. Drop the field so next sync rehashes.
  for (const name of diff.toRemove) {
    if (approvedRemovals.includes(name)) continue;
    if (nextManifest.skills[name]) {
      const { local_hash: _drop, ...rest } = nextManifest.skills[name];
      nextManifest.skills[name] = rest as Manifest["skills"][string];
    }
  }

  // ---- Approved removals from disk ------------------------------------
  for (const name of approvedRemovals) {
    const skillDir = join(contentRoot, name);
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: true, force: true });
    }
    summary.removed.push(name);
  }

  // ---- Reconcile target dirs ------------------------------------------
  const targets = targetsForKeys(scope.targets);
  for (const t of targets) {
    for (const name of Object.keys(nextManifest.skills)) {
      const real = join(contentRoot, name);
      const link = targetSkillPath(t, name);
      const result = await ensureSymlink(real, link);
      if (result === "skipped") {
        summary.conflicts.push({ name, target: link });
      }
    }
    for (const name of approvedRemovals) {
      const link = targetSkillPath(t, name);
      await removeSymlink(link);
    }
  }

  // Compute unchanged for the summary AFTER pull so the count reflects
  // only "neither side changed AND not force-pulled" entries.
  const touchedPageIds = new Set(toFetch.map((k) => k.id));
  summary.unchanged = diff.unchanged.filter((name) => {
    const entry = nextManifest.skills[name];
    if (entry && touchedPageIds.has(entry.page_id)) return false;
    return true;
  });

  // Surface drift reminders at the end, after the pull phase, so they
  // show up on the same screen as the rest of the summary.
  for (const name of localDriftReminders) {
    log(
      chalk.yellow(
        `↑ ${name}: you have local edits — run \`notion-skills publish ${name}\` to share them with your team.`,
      ),
    );
  }

  await writeManifest(manifestPath, nextManifest);
  return summary;
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
