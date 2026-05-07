import chalk from "chalk";
import { confirm } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getScope } from "../scope.js";
import { NotionClient } from "../notion.js";
import { assertNtnInstalled, ntnSetPageMarkdown } from "../ntn.js";
import {
  type Classification,
  discoverSkills,
  markConflicts,
  resolveSourceDirs,
  sourceIsInScope,
} from "../migrate.js";
import { SCHEMA, notionPropsForSkill } from "../schema.js";
import { findTargetByKey } from "../known-targets.js";
import { MANIFEST_FILE, ROOT_DIR, SKILLS_STORE } from "../paths.js";
import { readManifest } from "../manifest.js";
import { runSync, printSummary } from "../sync.js";
import {
  readLocalSkillFiles,
  type SkillFile,
  upsertSkillFilePages,
} from "../skill-files.js";
import { startTask } from "./_progress.js";
import { pickSource } from "./_resolve.js";
import type { Source } from "../sources.js";

interface MigrateOptions {
  from?: string[];
  overwrite?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** Source key to push to. Resolved via the standard picker. */
  source?: string;
  /**
   * Restrict the migration to these slugs. Skills not in the set are
   * silently dropped (managed/invalid are also dropped). Used by `init`
   * after its multiselect picker has curated the list; don't re-
   * litigate it here.
   */
  only?: string[];
}

export async function migrateCommand(opts: MigrateOptions): Promise<void> {
  await assertNtnInstalled();

  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }
  const source = await pickSource(opts.source, scope);
  const client = new NotionClient();

  const scopeTargetDirs = scope.targets
    .map((k) => findTargetByKey(k)?.dir)
    .filter((d): d is string => !!d);

  // Caller-curated runs (init/sync) suppress the source/probe prelude.
  const verbose = !opts.only;

  const classifications = await discoverAndClassify(
    client,
    source,
    opts,
    scopeTargetDirs,
    verbose,
  );

  if (verbose) printClassifications(classifications, opts);

  const willCreate = classifications.filter((c) => c.kind === "new");
  const conflicts = classifications.filter((c) => c.kind === "conflict");
  const willOverwrite = opts.overwrite ? conflicts : [];
  const total = willCreate.length + willOverwrite.length;

  if (total === 0) {
    console.log(chalk.dim("Nothing to migrate.\n"));
    if (conflicts.length > 0 && !opts.overwrite) {
      console.log(chalk.dim("Pass --overwrite to replace the existing Notion pages."));
    }
    return;
  }
  if (opts.dryRun) {
    console.log(chalk.dim("\n--dry-run: not creating anything."));
    return;
  }
  if (!(await confirmIntent(willCreate.length, willOverwrite.length, source.name, opts))) {
    return;
  }

  await prepareSchemaAndOptions(client, source, [...willCreate, ...willOverwrite]);

  console.log(chalk.bold(`\nUploading ${total} ${total === 1 ? "skill" : "skills"}:`));

  // Phase 1: write to Notion. Locals are untouched on failure.
  const dataSource = await client.getDataSource(source.data_source_id);
  const existingColumns = new Set(Object.keys(dataSource.properties));
  const { created, updated, failed } = await pushAllPages(
    client,
    source,
    willCreate,
    willOverwrite,
    existingColumns,
  );

  // Phase 2: back up local sources that lived inside scope target dirs.
  const { backupRoot, backupCreated, backupWarnings } = await backupOriginalSources(
    [...created, ...updated],
    scopeTargetDirs,
  );

  // ---------- Phase 3: silent reconciliation ----------
  //
  // Pull the freshly-written pages back into the central store and link
  // them into the user's target dirs. The just-published pages don't
  // have manifest entries yet, so sync's narrow "installed only" filter
  // would skip them — pass extraFetchIds to opt them in for this run.
  const justPushedIds = new Set(
    [...created, ...updated].map((r) => r.pageId),
  );
  const reconcile = startTask("Linking skills locally");
  let summary;
  try {
    summary = await runSync(scope, {
      quiet: true,
      extraFetchIds: justPushedIds,
    });
    reconcile.done();
  } catch (err) {
    reconcile.fail((err as Error).message.split("\n")[0]);
    throw err;
  }

  // ---------- Summary ----------
  const totalDone = created.length + updated.length;
  console.log("");
  // Verb is "Published" not "Migrated" — every code path that calls
  // this is now in service of `publish`. Migrate is a hidden alias
  // and even there the user-facing intent is "I'm publishing skills."
  if (failed.length === 0) {
    console.log(
      chalk.green(`✓ Published ${totalDone} ${totalDone === 1 ? "skill" : "skills"}.`),
    );
  } else {
    console.log(
      chalk.yellow(
        `Published ${totalDone} of ${totalDone + failed.length} skills (${failed.length} failed):`,
      ),
    );
    for (const name of failed) console.log(`  ${chalk.red("✗")} ${name}`);
  }
  if (backupCreated) {
    console.log(chalk.dim(`Backup saved to ${home(backupRoot)}`));
  }
  for (const w of backupWarnings) {
    console.warn(chalk.yellow(`  ! could not back up ${w}`));
  }
  if (summary.invalid.length > 0 || summary.conflicts.length > 0) {
    // Surface anything runSync flagged in its (otherwise-quiet) pass.
    printSummary(summary);
  }
}

// ---------- phases extracted from the orchestrator above ----------

async function discoverAndClassify(
  client: NotionClient,
  source: Source,
  opts: MigrateOptions,
  scopeTargetDirs: string[],
  verbose: boolean,
): Promise<Classification[]> {
  const sourceDirs = resolveSourceDirs({
    extras: [SKILLS_STORE, ...(opts.from ?? [])],
    targetDirs: scopeTargetDirs,
  });

  // Skills already in the central store + already in this source's
  // manifest are tracked — they're sync targets, not migrate candidates.
  const manifest = await readManifest(MANIFEST_FILE, source.key);
  const trackedNames = new Set(
    manifest
      ? Object.values(manifest.skills)
          .filter((e) => e.source_key === source.key)
          .map((e) => e.source_slug)
      : [],
  );

  if (verbose) {
    console.log(chalk.bold(`Sources:`));
    for (const dir of sourceDirs) {
      console.log(`  ${dir}${existsSync(dir) ? "" : chalk.dim(" (does not exist)")}`);
    }
    console.log("");
  }

  let classifications = await discoverSkills({ sourceDirs, trackedNames });

  // Conflict detection: the title slugs of pages currently in Notion.
  if (verbose) process.stdout.write(chalk.dim("Checking Notion for existing skills... "));
  const existing = await client.queryDataSource(source.data_source_id);
  if (verbose) console.log(chalk.green("✓") + chalk.dim(` ${existing.length} pages`));

  const existingByName = new Map<string, { pageId: string; title: string }>();
  const { slugify } = await import("../convert.js");
  for (const page of existing) {
    if (page.archived || page.in_trash) continue;
    const titleProp = Object.values(page.properties).find((p) => p.type === "title");
    const title = (titleProp?.title ?? [])
      .map((r) => r.plain_text)
      .join("")
      .trim();
    if (!title) continue;
    existingByName.set(slugify(title), { pageId: page.id, title });
  }
  classifications = markConflicts(classifications, existingByName);

  if (opts.only) {
    const onlySet = new Set(opts.only);
    classifications = classifications.filter(
      (c) => (c.kind === "new" || c.kind === "conflict") && onlySet.has(c.skill.name),
    );
  }
  return classifications;
}

async function confirmIntent(
  newCount: number,
  overwriteCount: number,
  sourceName: string,
  opts: MigrateOptions,
): Promise<boolean> {
  if (opts.yes) return true;
  const newWord = newCount === 1 ? "page" : "pages";
  const ok = await confirm({
    message: `Create ${newCount} new ${newWord}${
      overwriteCount ? ` and overwrite ${overwriteCount}` : ""
    } in "${sourceName}"?`,
    default: true,
  });
  if (!ok) console.log(chalk.dim("Aborted."));
  return ok;
}

async function prepareSchemaAndOptions(
  client: NotionClient,
  source: Source,
  candidates: Classification[],
): Promise<void> {
  // Progressive schema: only add columns the about-to-upload skills
  // actually need. Spec defaults are filtered by notionPropsForSkill so
  // we don't surface columns where every cell would be the default.
  const neededProps = new Set<string>();
  for (const c of candidates) {
    if (c.kind !== "new" && c.kind !== "conflict") continue;
    for (const name of notionPropsForSkill(
      c.skill.properties as unknown as Record<string, unknown>,
    )) {
      neededProps.add(name);
    }
  }
  if (neededProps.size > 0) {
    await client.upgradeSchema(source.data_source_id, { only: neededProps });
  }
  // Self-heal selects: any unknown agent / model values referenced by
  // the migration get added to the option list before the page-create
  // call. Must run AFTER upgradeSchema so the columns exist.
  const selfHealing = collectSelfHealingValues(candidates);
  if (selfHealing.size > 0) {
    await client.ensureSelectOptions(source.data_source_id, selfHealing);
  }
}

interface PushResult {
  name: string;
  pageId: string;
  sources: string[];
}

interface PushSummary {
  created: PushResult[];
  updated: PushResult[];
  failed: string[];
}

async function pushAllPages(
  client: NotionClient,
  source: Source,
  willCreate: Classification[],
  willOverwrite: Classification[],
  existingColumns: Set<string>,
): Promise<PushSummary> {
  const created: PushResult[] = [];
  const updated: PushResult[] = [];
  const failed: string[] = [];

  for (const c of willCreate) {
    if (c.kind !== "new") continue;
    const result = await pushOnePage(client, source, c, false, existingColumns);
    if (result) created.push(result);
    else failed.push(c.skill.name);
  }
  for (const c of willOverwrite) {
    if (c.kind !== "conflict") continue;
    const result = await pushOnePage(client, source, c, true, existingColumns);
    if (result) updated.push(result);
    else failed.push(c.skill.name);
  }
  return { created, updated, failed };
}

async function pushOnePage(
  client: NotionClient,
  source: Source,
  c: Classification,
  isOverwrite: boolean,
  existingColumns: Set<string>,
): Promise<PushResult | null> {
  if (c.kind !== "new" && c.kind !== "conflict") return null;
  const task = startTask(c.skill.name);
  try {
    const pageId =
      c.kind === "conflict"
        ? c.existingPageId
        : await client.createSkillPage(
            source.data_source_id,
            // CLI publish is an explicit "ship it" gesture — start as
            // Published=true. Notion-side drafts (created in the UI)
            // default to Published=false instead.
            { ...c.skill.properties, published: true },
            existingColumns,
          );
    if (c.kind === "conflict") {
      await client.updateSkillPageProperties(pageId, c.skill.properties, existingColumns);
    }
    if (c.skill.body.trim()) {
      await ntnSetPageMarkdown(pageId, c.skill.body);
    }
    await pushSkillFiles(client, pageId, c.skill.source);
    task.done(isOverwrite ? "(updated)" : undefined);
    return { name: c.skill.name, pageId, sources: allSources(c) };
  } catch (err) {
    task.fail((err as Error).message.split("\n")[0]);
    return null;
  }
}

function allSources(c: Classification): string[] {
  if (c.kind !== "new" && c.kind !== "conflict") return [];
  return [
    c.skill.source,
    ...(c.skill.additionalSources ?? []),
    ...(c.skill.conflictingSources ?? []),
  ];
}

interface BackupResult {
  backupRoot: string;
  backupCreated: boolean;
  backupWarnings: string[];
}

async function backupOriginalSources(
  results: PushResult[],
  scopeTargetDirs: string[],
): Promise<BackupResult> {
  // Move sources living inside scope target dirs (e.g.
  // ~/.claude/skills/foo) to backup; they need to be replaced by
  // symlinks to the central store. Central-store sources are already
  // in their permanent home; --from sources may be the user's
  // authoritative authoring repo and stay untouched.
  const backupRoot = join(ROOT_DIR, "backup", `migrate-${timestamp()}`);
  let backupCreated = false;
  const backupWarnings: string[] = [];
  for (const result of results) {
    let copyIndex = 0;
    for (const src of result.sources) {
      if (!sourceIsInScope(src, scopeTargetDirs)) continue;
      if (!backupCreated) {
        await mkdir(backupRoot, { recursive: true });
        backupCreated = true;
      }
      const destName =
        copyIndex === 0 ? result.name : `${result.name}.${copyIndex}`;
      const dest = join(backupRoot, destName);
      try {
        await mkdir(dirname(dest), { recursive: true });
        await rename(src, dest);
      } catch (err) {
        backupWarnings.push(`${src}: ${(err as Error).message}`);
      }
      copyIndex++;
    }
  }
  return { backupRoot, backupCreated, backupWarnings };
}

function printClassifications(
  classifications: Classification[],
  opts: MigrateOptions,
): void {
  const groups = {
    new: classifications.filter((c) => c.kind === "new"),
    conflict: classifications.filter((c) => c.kind === "conflict"),
    managed: classifications.filter((c) => c.kind === "managed"),
    invalid: classifications.filter((c) => c.kind === "invalid"),
  };

  console.log(chalk.bold("Found:"));
  console.log(`  new        ${groups.new.length}`);
  console.log(`  conflict   ${groups.conflict.length}${
    groups.conflict.length === 0
      ? ""
      : opts.overwrite
        ? chalk.dim(" (will overwrite)")
        : chalk.dim(" (will skip; pass --overwrite)")
  }`);
  console.log(`  managed    ${groups.managed.length}${groups.managed.length === 0 ? "" : chalk.dim(" (already in central store)")}`);
  console.log(`  invalid    ${groups.invalid.length}`);
  console.log("");

  if (groups.new.length) {
    console.log(chalk.bold(`New (will create ${groups.new.length === 1 ? "this skill" : "these skills"}):`));
    for (const c of groups.new) {
      if (c.kind !== "new") continue;
      printSkillLine(c.skill, "+");
    }
    console.log("");
  }

  if (groups.conflict.length) {
    console.log(chalk.bold("Conflicts in Notion:"));
    for (const c of groups.conflict) {
      if (c.kind !== "conflict") continue;
      const tag = opts.overwrite ? chalk.yellow("~") : chalk.red("!");
      console.log(`  ${tag} ${c.skill.name.padEnd(40)} ${chalk.dim(`exists in Notion as "${c.existingTitle}"`)}`);
    }
    console.log("");
  }

  if (groups.invalid.length) {
    console.log(chalk.bold("Invalid (skipped):"));
    for (const c of groups.invalid) {
      if (c.kind !== "invalid") continue;
      console.log(`  ${chalk.dim("·")} ${c.sourceDisplay.padEnd(60)} ${chalk.dim(c.reason)}`);
    }
    console.log("");
  }
}

/**
 * Print one skill line in the discovery preview, including which target
 * dirs it was found in and whether any duplicates have conflicting content.
 *
 * Paths come from sourceDisplay (where we scanned) not realpath, so users
 * see the dir they control (e.g. ~/.claude/skills), not whatever deep
 * symlink target the skill happens to resolve to.
 */
function printSkillLine(skill: import("../migrate.js").ParsedSkill, mark: string): void {
  const dirs = sourceDirSummary(skill);
  const namePadded = skill.name.padEnd(40);
  const conflicts = skill.conflictingSourceDisplays;
  const conflictNote = conflicts && conflicts.length > 0
    ? chalk.yellow(
        ` ⚠ also in ${conflicts.map(parentDir).map(home).join(", ")} with different content — using ${home(parentDir(skill.sourceDisplay))}`,
      )
    : "";
  console.log(`  ${chalk.green(mark)} ${namePadded} ${chalk.dim(dirs)}${conflictNote}`);
}

function sourceDirSummary(skill: import("../migrate.js").ParsedSkill): string {
  const all = [skill.sourceDisplay, ...(skill.additionalSourceDisplays ?? [])];
  return all.map((p) => home(parentDir(p))).join(", ");
}

function parentDir(p: string): string {
  return dirname(p);
}

function home(p: string): string {
  const h = process.env.HOME;
  return h && p.startsWith(h) ? "~" + p.slice(h.length) : p;
}

/**
 * Walk every candidate's properties and collect the values it would write
 * into a self-healing select column. Returned as a Notion-column-name →
 * value-set map so the caller can extend the option lists in one PATCH.
 */
function collectSelfHealingValues(
  classifications: Classification[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of classifications) {
    if (c.kind !== "new" && c.kind !== "conflict") continue;
    const props = c.skill.properties as unknown as Record<string, unknown>;
    for (const def of SCHEMA) {
      if (def.kind !== "select" || !def.selfHealing) continue;
      const value = props[def.frontmatterKey];
      if (typeof value !== "string" || value === "" || value === "default") continue;
      let bag = out.get(def.notionName);
      if (!bag) {
        bag = new Set();
        out.set(def.notionName, bag);
      }
      bag.add(value);
    }
  }
  return out;
}

/**
 * After creating or updating a parent skill page, push every non-
 * SKILL.md file from the source directory as a child page on that
 * row. Existing child pages with matching titles are PATCHed in place;
 * orphans whose title no longer matches a local file are archived
 * (publish is the source of truth — local removed = remote removed).
 *
 * Unsupported files (binaries, unknown extensions) are surfaced as a
 * yellow warning and skipped.
 */
async function pushSkillFiles(
  client: NotionClient,
  pageId: string,
  sourceDir: string,
): Promise<void> {
  const files = await readLocalSkillFiles(sourceDir);
  const unsupported = files.filter((f) => f.kind === "unsupported");
  if (unsupported.length > 0) {
    console.log(
      chalk.yellow(
        `  ⚠ skipping ${unsupported.length} unsupported ${unsupported.length === 1 ? "file" : "files"}: ${unsupported.map((f) => f.path).join(", ")}`,
      ),
    );
  }
  const supported = files.filter((f) => f.kind !== "unsupported");
  await upsertSkillFilePages(client, ntnSetPageMarkdown, pageId, supported);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}
