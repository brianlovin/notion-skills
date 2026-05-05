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
  renderForChildPage,
  type SkillFile,
} from "../skill-files.js";
import { startTask } from "./_progress.js";

interface MigrateOptions {
  from?: string[];
  overwrite?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /**
   * Restrict the migration to these slugs. Skills not in the set are
   * silently dropped (managed/invalid are also dropped). Used by `init`
   * and `sync` after they've shown a multiselect picker; the user has
   * already curated the list, so don't re-litigate it here.
   */
  only?: string[];
}

export async function migrateCommand(opts: MigrateOptions): Promise<void> {
  await assertNtnInstalled();

  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  // Resolve sources. The central store is always scanned: a SKILL.md
  // sitting there with no manifest entry is a local-only skill that
  // needs uploading (AI-authored via `gen`, or written by hand).
  const scopeTargetDirs = scope.targets
    .map((k) => findTargetByKey(k)?.dir)
    .filter((d): d is string => !!d);

  const sourceDirs = resolveSourceDirs({
    extras: [SKILLS_STORE, ...(opts.from ?? [])],
    targetDirs: scopeTargetDirs,
  });

  // Manifest tells us which central-store entries are already synced
  // from Notion (so they aren't candidates for re-upload).
  const manifest = await readManifest(MANIFEST_FILE);
  const trackedNames = new Set(
    manifest ? Object.keys(manifest.skills) : [],
  );

  // Caller-curated runs (init/sync) suppress the source/probe prelude —
  // they already showed the user the picker, so an extra "Sources:" +
  // "Checking Notion..." preamble is just noise.
  const verbose = !opts.only;

  if (verbose) {
    console.log(chalk.bold(`Sources:`));
    for (const dir of sourceDirs) {
      console.log(`  ${dir}${existsSync(dir) ? "" : chalk.dim(" (does not exist)")}`);
    }
    console.log("");
  }

  // Discovery + initial classification.
  let classifications = await discoverSkills({ sourceDirs, trackedNames });

  // Conflict detection: query Notion for existing slugs.
  const client = new NotionClient();
  if (verbose) {
    process.stdout.write(chalk.dim("Checking Notion for existing skills... "));
  }
  const existing = await client.queryDataSource(scope.data_source_id);
  if (verbose) {
    console.log(chalk.green("✓") + chalk.dim(` ${existing.length} pages`));
  }

  const existingByName = new Map<string, { pageId: string; title: string }>();
  for (const page of existing) {
    if (page.archived || page.in_trash) continue;
    const titleProp = Object.values(page.properties).find(
      (p) => p.type === "title",
    );
    const title = (titleProp?.title ?? [])
      .map((r) => r.plain_text)
      .join("")
      .trim();
    if (!title) continue;
    const { slugify } = await import("../convert.js");
    existingByName.set(slugify(title), { pageId: page.id, title });
  }

  classifications = markConflicts(classifications, existingByName);

  if (opts.only) {
    const onlySet = new Set(opts.only);
    classifications = classifications.filter((c) => {
      if (c.kind === "new" || c.kind === "conflict") {
        return onlySet.has(c.skill.name);
      }
      return false;
    });
  }

  // Print classification summary only for standalone runs. The picker
  // already summarised the selection in init/sync.
  if (verbose) {
    printClassifications(classifications, opts);
  }

  // Determine candidates to act on.
  const willCreate = classifications.filter((c) => c.kind === "new");
  const conflicts = classifications.filter((c) => c.kind === "conflict");
  const willOverwrite = opts.overwrite ? conflicts : [];
  const total = willCreate.length + willOverwrite.length;

  if (total === 0) {
    console.log(chalk.dim("Nothing to migrate.\n"));
    if (conflicts.length > 0 && !opts.overwrite) {
      console.log(
        chalk.dim("Pass --overwrite to replace the existing Notion pages."),
      );
    }
    return;
  }

  if (opts.dryRun) {
    console.log(chalk.dim("\n--dry-run: not creating anything."));
    return;
  }

  if (!opts.yes) {
    const newWord = willCreate.length === 1 ? "page" : "pages";
    const ok = await confirm({
      message: `Create ${willCreate.length} new ${newWord}${
        willOverwrite.length ? ` and overwrite ${willOverwrite.length}` : ""
      } in "${scope.database_title ?? "Skills"}"?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim("Aborted."));
      return;
    }
  }

  // Progressive schema: figure out which Notion columns the about-to-
  // upload skills actually need, and add only those. Spec defaults
  // (e.g. shell: bash) get filtered out by notionPropsForSkill so we
  // don't surface columns where every cell would be the default.
  const neededProps = new Set<string>();
  for (const c of [...willCreate, ...willOverwrite]) {
    if (c.kind !== "new" && c.kind !== "conflict") continue;
    for (const name of notionPropsForSkill(
      c.skill.properties as unknown as Record<string, unknown>,
    )) {
      neededProps.add(name);
    }
  }
  if (neededProps.size > 0) {
    await client.upgradeSchema(scope.data_source_id, { only: neededProps });
  }

  // Self-heal select properties: any agent / model values referenced by
  // the migration that aren't already options on the data source need to
  // be added before the page-create call (Notion rejects unknown options).
  // Must run AFTER upgradeSchema so the columns exist to attach options to.
  const selfHealing = collectSelfHealingValues([...willCreate, ...willOverwrite]);
  if (selfHealing.size > 0) {
    await client.ensureSelectOptions(scope.data_source_id, selfHealing);
  }

  // ---------- Phase 1: write to Notion ----------
  //
  // We do all Notion writes BEFORE touching local files. If a create fails
  // partway, locals stay intact; the user can re-run migrate after fixing
  // the underlying issue (the failed skill becomes a no-op since
  // its slug now exists in Notion as a partial page — caught next run).
  //
  // `sources` collects every realpath that should be moved to backup
  // when the Notion write succeeds: the canonical source + any
  // identical-content duplicates + any conflicting copies. We back them
  // ALL up so no stale non-symlink dirs are left in target dirs.
  console.log(chalk.bold(`\nUploading ${total} ${total === 1 ? "skill" : "skills"}:`));

  const created: { name: string; pageId: string; sources: string[] }[] = [];
  const updated: { name: string; pageId: string; sources: string[] }[] = [];
  const failed: string[] = [];

  const allSources = (s: Classification): string[] => {
    if (s.kind !== "new" && s.kind !== "conflict") return [];
    return [
      s.skill.source,
      ...(s.skill.additionalSources ?? []),
      ...(s.skill.conflictingSources ?? []),
    ];
  };

  for (const c of willCreate) {
    if (c.kind !== "new") continue;
    const task = startTask(c.skill.name);
    try {
      const pageId = await client.createSkillPage(
        scope.data_source_id,
        c.skill.properties,
      );
      if (c.skill.body.trim()) {
        await ntnSetPageMarkdown(pageId, c.skill.body);
      }
      await pushSkillFiles(client, pageId, c.skill.source);
      created.push({ name: c.skill.name, pageId, sources: allSources(c) });
      task.done();
    } catch (err) {
      failed.push(c.skill.name);
      task.fail((err as Error).message.split("\n")[0]);
    }
  }

  for (const c of willOverwrite) {
    if (c.kind !== "conflict") continue;
    const task = startTask(c.skill.name);
    try {
      await client.updateSkillPageProperties(
        c.existingPageId,
        c.skill.properties,
      );
      if (c.skill.body.trim()) {
        await ntnSetPageMarkdown(c.existingPageId, c.skill.body);
      }
      await pushSkillFiles(client, c.existingPageId, c.skill.source);
      updated.push({
        name: c.skill.name,
        pageId: c.existingPageId,
        sources: allSources(c),
      });
      task.done("(updated)");
    } catch (err) {
      failed.push(c.skill.name);
      task.fail((err as Error).message.split("\n")[0]);
    }
  }

  // ---------- Phase 2: back up local copies whose Notion write succeeded ----------
  //
  // Only move sources that live INSIDE a configured scope target dir
  // (e.g. ~/.claude/skills/foo). Those need to be replaced by symlinks
  // to the central store. Central-store sources (~/.notion-skills/skills/)
  // are already in their permanent home — moving them would erase the
  // skill we just uploaded. Sources from --from paths are also left
  // untouched since they may be a user's authoritative authoring repo.
  const ts = timestamp();
  const backupRoot = join(ROOT_DIR, "backup", `migrate-${ts}`);
  let backupCreated = false;
  const backupWarnings: string[] = [];

  for (const result of [...created, ...updated]) {
    let copyIndex = 0;
    for (const src of result.sources) {
      if (!sourceIsInScope(src, scopeTargetDirs)) continue;

      if (!backupCreated) {
        await mkdir(backupRoot, { recursive: true });
        backupCreated = true;
      }

      // First source goes to backup/<name>; subsequent ones (multi-target
      // duplicates) get a numeric suffix so they don't collide.
      const destName = copyIndex === 0 ? result.name : `${result.name}.${copyIndex}`;
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

  const blocks = await client.getBlockChildren(pageId);
  const existingByTitle = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "child_page") continue;
    const cp = (block as { child_page?: { title?: string } }).child_page;
    const title = cp?.title?.trim();
    if (title) existingByTitle.set(title, block.id);
  }

  const desiredTitles = new Set(supported.map((f) => f.path));

  for (const file of supported) {
    const body = renderForChildPage(file);
    const existingId = existingByTitle.get(file.path);
    if (existingId) {
      await ntnSetPageMarkdown(existingId, body);
    } else {
      const newId = await client.createChildPage(pageId, file.path);
      if (body.trim()) {
        await ntnSetPageMarkdown(newId, body);
      }
    }
  }

  for (const [title, id] of existingByTitle) {
    if (!desiredTitles.has(title)) {
      await client.archivePage(id);
    }
  }
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
