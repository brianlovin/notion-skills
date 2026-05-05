import chalk from "chalk";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import {
  NotionClient,
  type NotionPage,
  type SkillProperties,
  readRichText,
  readSelect,
  readTitle,
} from "./notion.js";
import { assertNtnInstalled, ntnSetPageMarkdown } from "./ntn.js";
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
  ensureSymlink,
  removeSymlink,
  targetSkillPath,
  targetsForKeys,
} from "./targets.js";
import { MANIFEST_FILE, SKILLS_STORE } from "./paths.js";
import type { Scope } from "./scope.js";
import { decideSyncAction } from "./sync-decision.js";
import { detectLocalState, type LocalDriftEntry } from "./local-state.js";
import { SCHEMA, notionPropsForSkill } from "./schema.js";
import { parseSkillFile } from "./migrate.js";

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

  // Detect slug collisions in the database itself.
  const slugCounts = new Map<string, number>();
  for (const s of summaries) {
    slugCounts.set(s.name, (slugCounts.get(s.name) ?? 0) + 1);
  }
  const colliding = new Set(
    [...slugCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name),
  );
  if (colliding.size > 0) {
    warn(
      chalk.yellow(
        `Skipping ${colliding.size} duplicate ${colliding.size === 1 ? "slug" : "slugs"}: ${[...colliding].join(", ")}. Rename one of the colliding pages in Notion.`,
      ),
    );
  }

  const kept = summaries
    .filter((s) => !colliding.has(s.name))
    .filter((s) => shouldSyncSkill(s.name, scope.exclude_skills));

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

  // ---- Decide what to do for each tracked skill -----------------------
  const pushCandidates: LocalDriftEntry[] = [];
  const remoteChangedNames = new Set<string>();
  for (const k of kept) if (diff.toFetch.includes(k.id)) remoteChangedNames.add(k.name);

  for (const [name, drift] of localDrift) {
    const remoteSummary = kept.find((k) => k.name === name);
    if (!remoteSummary) {
      // Page is missing in Notion (will fall through to the toRemove
      // bias-against-deletion path). Don't try to push to a deleted page.
      continue;
    }
    const remoteEdited = new Date(remoteSummary.lastEditedTime);
    const action = decideSyncAction({
      localChanged: true,
      remoteChanged: remoteChangedNames.has(name),
      localMtime: drift.mtime,
      remoteEdited,
    });

    if (action === "push") {
      pushCandidates.push(drift);
    } else if (action === "conflict-push") {
      pushCandidates.push(drift);
      summary.resolutions.push({
        name,
        winner: "local",
        localEditedAt: drift.mtime.toISOString(),
        remoteEditedAt: remoteSummary.lastEditedTime,
      });
      log(
        chalk.yellow(
          `⚠ ${name}: both sides changed — keeping local (mtime ${drift.mtime.toISOString()} > Notion ${remoteSummary.lastEditedTime}). Notion's page history can restore the prior version.`,
        ),
      );
    } else if (action === "conflict-pull") {
      summary.resolutions.push({
        name,
        winner: "remote",
        localEditedAt: drift.mtime.toISOString(),
        remoteEditedAt: remoteSummary.lastEditedTime,
      });
      // Save the local file before overwriting it. The user can recover
      // their lost edit from ~/.notion-skills/backup/conflicts/<name>-<ts>/.
      // Notion's history won't help — that shows Notion's previous state,
      // not the user's discarded local edit.
      try {
        const backupDir = join(
          contentRoot,
          "..",
          "backup",
          "conflicts",
          `${name}-${conflictBackupTimestamp()}`,
        );
        await mkdir(backupDir, { recursive: true });
        await writeFile(join(backupDir, "SKILL.md"), drift.mdContent, "utf8");
        log(
          chalk.yellow(
            `⚠ ${name}: both sides changed — keeping Notion (Notion ${remoteSummary.lastEditedTime} > local ${drift.mtime.toISOString()}). Your local edit was saved to ${backupDir}.`,
          ),
        );
      } catch {
        log(
          chalk.yellow(
            `⚠ ${name}: both sides changed — keeping Notion (Notion ${remoteSummary.lastEditedTime} > local ${drift.mtime.toISOString()}). Your local edit was overwritten; check Notion's page history if you need to recover.`,
          ),
        );
      }
      // Pull will overwrite local; the toFetch path already includes this
      // page id (since remoteChanged). No extra work needed here.
    }
    // skip / pull: no-op here.
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
    skills: { ...oldManifest.skills },
  };

  // Approved removals get dropped from manifest + central store + target
  // symlinks. Declined removals get dropped from MANIFEST only — the
  // central-store dirs and symlinks stay so the user keeps the content.
  for (const name of diff.toRemove) {
    delete nextManifest.skills[name];
  }

  // ---- Push phase ------------------------------------------------------
  //
  // Phase 1: parse all locals and aggregate schema/option needs (one
  //          PATCH each, not N).
  // Phase 2: per-skill push (properties + body).
  // Phase 3: re-fetch each pushed page so the next pull writes Notion's
  //          normalised version back to local. Subsequent syncs see no
  //          drift and don't loop.
  const pushedPageIds = new Set<string>();
  const pushedNames = new Set<string>();
  if (pushCandidates.length > 0) {
    log(chalk.bold(`Pushing ${pushCandidates.length} local ${pushCandidates.length === 1 ? "edit" : "edits"}:`));

    interface ParsedPush {
      name: string;
      pageId: string;
      props: SkillProperties;
      body: string;
    }
    const parsed: ParsedPush[] = [];
    for (const c of pushCandidates) {
      const file = join(contentRoot, c.name, "SKILL.md");
      const result = await parseSkillFile(file, join(contentRoot, c.name), file, c.name);
      if ("error" in result) {
        summary.invalid.push({ title: c.name, reason: `local edit: ${result.error}` });
        log(`  ${chalk.yellow("!")} ${c.name} ${chalk.dim(`(local edit: ${result.error})`)}`);
        continue;
      }
      parsed.push({
        name: c.name,
        pageId: c.pageId,
        props: result.skill.properties,
        body: result.skill.body,
      });
    }

    // Aggregate schema + option needs.
    const neededProps = new Set<string>();
    const selectValues = new Map<string, Set<string>>();
    for (const p of parsed) {
      const propBag = p.props as unknown as Record<string, unknown>;
      for (const c of notionPropsForSkill(propBag)) neededProps.add(c);
      for (const def of SCHEMA) {
        if (def.kind !== "select" || !def.selfHealing) continue;
        const v = propBag[def.frontmatterKey];
        if (typeof v !== "string" || v === "" || v === "default") continue;
        let bag = selectValues.get(def.notionName);
        if (!bag) { bag = new Set(); selectValues.set(def.notionName, bag); }
        bag.add(v);
      }
    }
    if (neededProps.size > 0) {
      await client.upgradeSchema(scope.data_source_id, { only: neededProps });
    }
    if (selectValues.size > 0) {
      await client.ensureSelectOptions(scope.data_source_id, selectValues);
    }

    // Push each.
    for (const p of parsed) {
      try {
        await client.updateSkillPageProperties(p.pageId, p.props);
        if (p.body.trim()) {
          await ntnSetPageMarkdown(p.pageId, p.body);
        }
        pushedPageIds.add(p.pageId);
        pushedNames.add(p.name);
        summary.pushed.push(p.name);
        log(`  ${chalk.green("↑")} ${p.name}`);
      } catch (err) {
        summary.invalid.push({ title: p.name, reason: `push failed: ${(err as Error).message.split("\n")[0]}` });
        log(`  ${chalk.red("✗")} ${p.name} ${chalk.dim(`(push failed: ${(err as Error).message.split("\n")[0]})`)}`);
      }
    }

    // Refresh pushed pages so the pull phase writes Notion's normalised
    // version (and we capture the post-push last_edited_time / props_hash).
    for (const pageId of pushedPageIds) {
      try {
        const fresh = await client.getPage(pageId);
        const pidx = pages.findIndex((p) => p.id === pageId);
        if (pidx >= 0) pages[pidx] = fresh;
        const newSummary = summarisePage(fresh);
        if (!newSummary) continue;
        const kidx = kept.findIndex((k) => k.id === pageId);
        if (kidx >= 0) kept[kidx] = newSummary;
      } catch {
        // Refresh failure is non-fatal: the next sync will reconcile.
      }
    }
  }

  // ---- Pull phase ------------------------------------------------------
  //
  // Build the to-fetch set: anything diff said to fetch, plus everything
  // we just pushed (so we round-trip through Notion's normaliser), plus
  // anything whose local SKILL.md has gone missing (so the user can rm
  // and re-pull).
  const toFetchIds = new Set<string>([
    ...diff.toFetch,
    ...pushedPageIds,
    ...missingLocalPageIds,
  ]);
  const toFetch = kept.filter((k) => toFetchIds.has(k.id));

  // Visible pulls: pages we'd print a per-skill line for (i.e. not just
  // post-push round-trips, which we suppress to avoid double-counting).
  const visiblePullCount = toFetch.filter(
    (k) => !pushedPageIds.has(k.id),
  ).length;
  if (visiblePullCount > 0) {
    log(chalk.dim(`Pulling ${visiblePullCount} ${visiblePullCount === 1 ? "page" : "pages"}:`));
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

    const wasPush = pushedPageIds.has(skill.pageId);
    const wasNew = !oldManifest.skills[skillName];
    if (!wasPush) {
      // A push already counted this skill in `summary.pushed`; don't
      // double-count it as updated/created.
      if (wasNew) summary.created.push(skillName);
      else summary.updated.push(skillName);
    }

    const matchingSummary = kept.find((k) => k.id === skill.pageId);
    nextManifest.skills[skillName] = {
      page_id: skill.pageId,
      last_edited_time: skill.lastEditedTime,
      props_hash: matchingSummary?.propsHash ?? "",
      local_hash: hashContent(md),
    };

    // Per-skill mark: ↑ if just pushed (round-tripped), ↓ for pull-only.
    if (!wasPush) {
      const mark = wasNew ? chalk.green("+") : chalk.cyan("↓");
      log(`  ${mark} ${skillName}`);
    }
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

  // Compute unchanged for the summary AFTER push/pull resolution so the
  // count reflects only "neither side changed AND not force-pulled"
  // entries. A force-pull (pushed-then-roundtripped, or restored after
  // local file went missing) shouldn't count as unchanged.
  const touchedPageIds = new Set(toFetch.map((k) => k.id));
  summary.unchanged = diff.unchanged.filter((name) => {
    if (pushedNames.has(name)) return false;
    const entry = nextManifest.skills[name];
    if (entry && touchedPageIds.has(entry.page_id)) return false;
    return true;
  });

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

  const propBag = readSpecPropertyBag(page);
  const propsHash = hashContent(JSON.stringify(propBag));

  return {
    id: page.id,
    title,
    name: slugify(title),
    description,
    lastEditedTime: page.last_edited_time,
    propsHash,
  };
}

/**
 * Read every property the schema cares about into a deterministic, sorted
 * record for hashing. Order-stable so the same page always hashes the same.
 */
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

function readSpecPropertyBag(page: NotionPage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.description = readRichText(page.properties, "Description");
  out.when_to_use = readRichText(page.properties, "When To Use");
  out.argument_hint = readRichText(page.properties, "Argument Hint");
  out.arguments = readRichText(page.properties, "Arguments");
  out.allowed_tools = readRichText(page.properties, "Allowed Tools");
  out.paths = readRichText(page.properties, "Paths");
  out.disable_model_invocation = readSelect(page.properties, "Disable Model Invocation");
  out.user_invocable = readSelect(page.properties, "User Invocable");
  out.model = readSelect(page.properties, "Model");
  out.effort = readSelect(page.properties, "Effort");
  out.context = readSelect(page.properties, "Context");
  out.agent = readSelect(page.properties, "Agent");
  out.shell = readSelect(page.properties, "Shell");
  return out;
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
