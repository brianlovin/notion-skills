import chalk from "chalk";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import {
  NotionClient,
  type NotionPage,
  readRichText,
  readSelect,
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
  ensureSymlink,
  removeSymlink,
  targetSkillPath,
  targetsForKeys,
} from "./targets.js";
import { MANIFEST_FILE, SKILLS_STORE } from "./paths.js";
import type { Scope } from "./scope.js";

export interface SyncSummary {
  created: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
  invalid: { title: string; reason: string }[];
  conflicts: { name: string; target: string }[];
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
 * Pull from Notion to local. Bias against deletion: when Notion has fewer
 * skills than the local manifest expected, prompt before removing locals.
 *
 * Safety rule: if the on-disk manifest references a different database
 * than the current scope, treat as fresh — don't apply that manifest's
 * "missing" set as deletions, since those entries belong to a different
 * DB. Locals are preserved; the user can offer to upload them to the new
 * DB after the pull completes.
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
    removed: [],
    unchanged: [],
    invalid: [],
    conflicts: [],
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
        `Skipping ${colliding.size} duplicate slug(s): ${[...colliding].join(", ")}. Rename one of the colliding pages in Notion.`,
      ),
    );
  }

  const kept = summaries
    .filter((s) => !colliding.has(s.name))
    .filter((s) => shouldSyncSkill(s.name, scope.exclude_skills));

  // Load manifest, but only honour it if it belongs to the current DB.
  // Otherwise treat as fresh: we don't want a manifest from a previous
  // database to drive deletions against locals.
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

  summary.unchanged = diff.unchanged;

  // Decide which (if any) manifest entries to actually remove. We bias
  // against deletion: prompt the user with default N. Pages that are no
  // longer in Notion are typically intentional (the user trashed them),
  // but we never want to silently nuke locals.
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

  // Build the next manifest from the old, then layer changes.
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
  // On the next sync those locals appear as "not in Notion" and are
  // offered for upload.
  for (const name of diff.toRemove) {
    delete nextManifest.skills[name];
  }

  // Write/update content for changed pages.
  const toFetch = kept.filter((k) => diff.toFetch.includes(k.id));
  const verbose = process.env.NOTION_SKILLS_DEBUG === "1";

  if (toFetch.length > 0) {
    log(chalk.dim(`Converting ${toFetch.length} page(s):`));
  }

  for (let i = 0; i < toFetch.length; i++) {
    const summary_page = toFetch[i]!;
    const counter = chalk.dim(`[${i + 1}/${toFetch.length}]`);
    if (verbose) {
      console.error(`${counter} Fetching "${summary_page.title}" (${summary_page.id})...`);
    }
    const page = pages.find((p) => p.id === summary_page.id)!;
    const converted = await convertPageToSkill(client, page);
    if (!converted.ok) {
      summary.invalid.push({ title: summary_page.title, reason: converted.reason });
      log(`  ${counter} ${chalk.yellow("!")} ${summary_page.title} ${chalk.dim(`(${converted.reason})`)}`);
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

    const wasNew = !oldManifest.skills[skillName];
    if (wasNew) summary.created.push(skillName);
    else summary.updated.push(skillName);

    const matchingSummary = kept.find((k) => k.id === skill.pageId);
    nextManifest.skills[skillName] = {
      page_id: skill.pageId,
      last_edited_time: skill.lastEditedTime,
      props_hash: matchingSummary?.propsHash ?? "",
    };

    const mark = wasNew ? chalk.green("+") : chalk.cyan("~");
    log(`  ${counter} ${mark} ${skillName}`);
  }

  // Remove only the approved set from disk.
  for (const name of approvedRemovals) {
    const skillDir = join(contentRoot, name);
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: true, force: true });
    }
    summary.removed.push(name);
  }

  // Reconcile target dirs.
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
  if (summary.created.length) {
    console.log(chalk.green(`+ Created (${summary.created.length}):`));
    for (const n of summary.created) console.log(`    ${n}`);
  }
  if (summary.updated.length) {
    console.log(chalk.cyan(`~ Updated (${summary.updated.length}):`));
    for (const n of summary.updated) console.log(`    ${n}`);
  }
  if (summary.removed.length) {
    console.log(chalk.red(`- Removed (${summary.removed.length}):`));
    for (const n of summary.removed) console.log(`    ${n}`);
  }
  if (summary.unchanged.length) {
    console.log(chalk.dim(`= Unchanged (${summary.unchanged.length})`));
  }
  if (summary.invalid.length) {
    console.log(chalk.yellow(`! Skipped invalid (${summary.invalid.length}):`));
    for (const i of summary.invalid) console.log(`    "${i.title}" — ${i.reason}`);
  }
  if (summary.conflicts.length) {
    console.log(chalk.yellow(`! Conflicts (${summary.conflicts.length}):`));
    for (const c of summary.conflicts) {
      console.log(`    ${c.name} — existing non-symlink at ${c.target} (skipped)`);
    }
  }
  console.log("");
}
