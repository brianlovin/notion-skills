import chalk from "chalk";
import ora from "ora";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  NotionClient,
  type NotionPage,
  readMultiSelect,
  readRichText,
  readSelect,
  readTitle,
} from "./notion.js";
import { assertNtnInstalled } from "./ntn.js";
import { decide } from "./filter.js";
import {
  type ConvertedPage,
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
import {
  MANIFEST_FILE,
  PROJECT_LOCK_FILENAME,
  PROJECT_SKILLS_RELATIVE,
  SKILLS_STORE,
} from "./paths.js";
import type { Scope } from "./scope.js";

const TAGS_PROPERTY = "Tags";

export interface SyncSummary {
  scope: Scope["type"];
  created: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
  invalid: { title: string; reason: string }[];
  conflicts: { name: string; target: string }[];
}

export async function runSync(
  scope: Scope,
  ephemeralNames: string[] = [],
): Promise<SyncSummary> {
  await assertNtnInstalled();
  const client = new NotionClient();

  const summary: SyncSummary = {
    scope: scope.type,
    created: [],
    updated: [],
    removed: [],
    unchanged: [],
    invalid: [],
    conflicts: [],
  };

  const spinner = ora(`Querying ${scope.database_title ?? "database"}...`).start();
  const pages = await client.queryDataSource(scope.data_source_id);
  spinner.succeed(`Fetched ${pages.length} pages.`);

  // First pass: derive name + tags + description + edited time without
  // fetching block content. We need the property data here so the manifest
  // diff can detect property-only changes (tags, description) which Notion
  // does NOT reflect in last_edited_time.
  const summaries = pages
    .filter((p) => !p.archived && !p.in_trash)
    .map(summarisePage)
    .filter((s) => s !== null) as Array<PageSummary>;

  // Detect slug collisions.
  const slugCounts = new Map<string, number>();
  for (const s of summaries) {
    slugCounts.set(s.name, (slugCounts.get(s.name) ?? 0) + 1);
  }
  const colliding = new Set(
    [...slugCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name),
  );
  if (colliding.size > 0) {
    console.warn(
      chalk.yellow(
        `Skipping ${colliding.size} duplicate slug(s): ${[...colliding].join(", ")}. Rename one of the colliding pages in Notion.`,
      ),
    );
  }
  const uniqueSummaries = summaries.filter((s) => !colliding.has(s.name));

  // Apply filter.
  const kept = uniqueSummaries.filter(
    (s) => decide({ name: s.name, tags: s.tags }, scope.filter, ephemeralNames).keep,
  );

  const dirs = layoutFor(scope);

  // Load/init manifest.
  const manifestPath = dirs.manifestPath;
  const oldManifest =
    (await readManifest(manifestPath)) ??
    emptyManifest(scope.database_id, scope.data_source_id);

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

  // Update manifest as we go.
  const nextManifest: Manifest = {
    version: 1,
    database_id: scope.database_id,
    data_source_id: scope.data_source_id,
    last_synced_at: new Date().toISOString(),
    skills: { ...oldManifest.skills },
  };

  // Drop entries for skills that fell out of the keep set.
  for (const name of diff.toRemove) {
    delete nextManifest.skills[name];
  }

  // Write/update content for changed pages.
  const toFetch = kept.filter((k) => diff.toFetch.includes(k.id));
  const verbose = process.env.NOTION_SKILLS_DEBUG === "1";

  if (toFetch.length > 0) {
    console.log(chalk.dim(`Converting ${toFetch.length} page(s):`));
  }

  for (let i = 0; i < toFetch.length; i++) {
    const summary_page = toFetch[i]!;
    const counter = chalk.dim(`[${i + 1}/${toFetch.length}]`);
    if (verbose) {
      console.error(`${counter} Fetching "${summary_page.title}" (${summary_page.id})...`);
    }
    const page = pages.find((p) => p.id === summary_page.id)!;
    const converted = await convertPageToSkill(client, page, {
      tagsProperty: TAGS_PROPERTY,
    });
    if (!converted.ok) {
      summary.invalid.push({ title: summary_page.title, reason: converted.reason });
      console.log(`  ${counter} ${chalk.yellow("!")} ${summary_page.title} ${chalk.dim(`(${converted.reason})`)}`);
      continue;
    }
    const skill = converted.skill;
    const md = buildSkillMarkdown({
      properties: skill.properties,
      body: skill.body,
    });
    const skillName = skill.properties.name;
    const skillDir = join(dirs.contentRoot, skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), md, "utf8");

    const wasNew = !oldManifest.skills[skillName];
    if (wasNew) summary.created.push(skillName);
    else summary.updated.push(skillName);

    const matchingSummary = kept.find((k) => k.id === skill.pageId);
    nextManifest.skills[skillName] = {
      page_id: skill.pageId,
      last_edited_time: skill.lastEditedTime,
      hash: hashContent(md),
      tags: skill.properties.tags ?? [],
      description: skill.properties.description,
      props_hash: matchingSummary?.propsHash,
    };

    const mark = wasNew ? chalk.green("+") : chalk.cyan("~");
    console.log(`  ${counter} ${mark} ${skillName}`);
  }

  // Remove obsolete skills from disk.
  for (const name of diff.toRemove) {
    const skillDir = join(dirs.contentRoot, name);
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: true, force: true });
    }
    summary.removed.push(name);
  }

  // Reconcile targets.
  if (scope.type === "global") {
    const targets = targetsForKeys(scope.targets);
    for (const t of targets) {
      // Ensure links for current keep set.
      for (const name of Object.keys(nextManifest.skills)) {
        const real = join(dirs.contentRoot, name);
        const link = targetSkillPath(t, name);
        const result = await ensureSymlink(real, link);
        if (result === "skipped") {
          summary.conflicts.push({ name, target: link });
        }
      }
      // Remove links for dropped skills.
      for (const name of diff.toRemove) {
        const link = targetSkillPath(t, name);
        await removeSymlink(link);
      }
    }
  }
  // For project scope, we wrote directly into <repo>/.claude/skills — no
  // symlink reconciliation needed. Removed dirs were rm'd above.

  await writeManifest(manifestPath, nextManifest);
  return summary;
}

interface PageSummary {
  id: string;
  title: string;
  name: string;
  tags: string[];
  description: string;
  lastEditedTime: string;
  /** Hash over every spec-mapped property; used by manifest diff. */
  propsHash: string;
}

function summarisePage(page: NotionPage): PageSummary | null {
  const title = readTitle(page.properties);
  if (!title) return null;
  const tags = readMultiSelect(page.properties, TAGS_PROPERTY);
  const description = readRichText(page.properties, "Description");

  // Build a stable hash key from every spec-mapped property.
  const propBag = readSpecPropertyBag(page);
  const propsHash = hashContent(JSON.stringify(propBag));

  return {
    id: page.id,
    title,
    name: slugify(title),
    tags,
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
  out.tags = [...readMultiSelect(page.properties, TAGS_PROPERTY)].sort();
  return out;
}

interface ScopeLayout {
  contentRoot: string;
  manifestPath: string;
}

function layoutFor(scope: Scope): ScopeLayout {
  if (scope.type === "global") {
    return { contentRoot: SKILLS_STORE, manifestPath: MANIFEST_FILE };
  }
  return {
    contentRoot: resolve(scope.root, PROJECT_SKILLS_RELATIVE),
    manifestPath: resolve(scope.root, PROJECT_LOCK_FILENAME),
  };
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

// Re-export for command files
export { lstatSync };
