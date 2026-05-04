import chalk from "chalk";
import { confirm } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  findProjectScopePath,
  getScope,
  writeGlobalScope,
  writeProjectScope,
} from "../scope.js";
import { NotionClient } from "../notion.js";
import { assertNtnInstalled, ntnSetPageMarkdown } from "../ntn.js";
import {
  type Classification,
  discoverSkills,
  markConflicts,
  resolveSourceDirs,
  sourceIsInScope,
} from "../migrate.js";
import { SCHEMA } from "../schema.js";
import { findTargetByKey } from "../known-targets.js";
import { PROJECT_SKILLS_RELATIVE, ROOT_DIR } from "../paths.js";
import { runSync, printSummary } from "../sync.js";

interface MigrateOptions {
  from?: string[];
  overwrite?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export async function migrateCommand(opts: MigrateOptions): Promise<void> {
  await assertNtnInstalled();

  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  // Resolve sources.
  const scopeTargetDirs =
    scope.type === "global"
      ? scope.targets
          .map((k) => findTargetByKey(k)?.dir)
          .filter((d): d is string => !!d)
      : [resolve(scope.root, PROJECT_SKILLS_RELATIVE)];

  const sourceDirs = resolveSourceDirs(scope.type, {
    extras: opts.from ?? [],
    targetDirs: scope.type === "global" ? scopeTargetDirs : undefined,
    projectSkillsDir:
      scope.type === "project" ? scopeTargetDirs[0] : undefined,
  });

  console.log(chalk.bold(`Sources:`));
  for (const dir of sourceDirs) {
    console.log(`  ${dir}${existsSync(dir) ? "" : chalk.dim(" (does not exist)")}`);
  }
  console.log("");

  // Discovery + initial classification.
  let classifications = await discoverSkills({ sourceDirs });

  // Conflict detection: query Notion for existing slugs.
  const client = new NotionClient();
  process.stdout.write(chalk.dim("Checking Notion for existing skills... "));
  const existing = await client.queryDataSource(scope.data_source_id);
  console.log(chalk.green("✓") + chalk.dim(` ${existing.length} pages`));

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

  // Print classification summary.
  printClassifications(classifications, opts);

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
    const ok = await confirm({
      message: `Create ${willCreate.length} new page(s)${
        willOverwrite.length ? ` and overwrite ${willOverwrite.length}` : ""
      } in "${scope.database_title ?? "Skills"}"?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim("Aborted."));
      return;
    }
  }

  // Self-heal select properties: any agent / model values referenced by
  // the migration that aren't already options on the data source need to
  // be added before the page-create call (Notion rejects unknown options).
  const selfHealing = collectSelfHealingValues([...willCreate, ...willOverwrite]);
  if (selfHealing.size > 0) {
    const reports = await client.ensureSelectOptions(
      scope.data_source_id,
      selfHealing,
    );
    if (reports.length > 0) {
      console.log(chalk.dim("Added select options:"));
      for (const r of reports) {
        console.log(`  ${chalk.green("+")} ${r.column}: ${r.added.join(", ")}`);
      }
    }
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
  const created: { name: string; pageId: string; sources: string[] }[] = [];
  const updated: { name: string; pageId: string; sources: string[] }[] = [];

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
    try {
      const pageId = await client.createSkillPage(
        scope.data_source_id,
        c.skill.properties,
      );
      if (c.skill.body.trim()) {
        await ntnSetPageMarkdown(pageId, c.skill.body);
      }
      created.push({ name: c.skill.name, pageId, sources: allSources(c) });
      console.log(`  ${chalk.green("+")} ${c.skill.name}`);
    } catch (err) {
      console.log(
        `  ${chalk.red("✗")} ${c.skill.name} ${chalk.dim(`(${(err as Error).message.split("\n")[0]})`)}`,
      );
    }
  }

  for (const c of willOverwrite) {
    if (c.kind !== "conflict") continue;
    try {
      await client.updateSkillPageProperties(
        c.existingPageId,
        c.skill.properties,
      );
      if (c.skill.body.trim()) {
        await ntnSetPageMarkdown(c.existingPageId, c.skill.body);
      }
      updated.push({
        name: c.skill.name,
        pageId: c.existingPageId,
        sources: allSources(c),
      });
      console.log(`  ${chalk.cyan("~")} ${c.skill.name}`);
    } catch (err) {
      console.log(
        `  ${chalk.red("✗")} ${c.skill.name} ${chalk.dim(`(${(err as Error).message.split("\n")[0]})`)}`,
      );
    }
  }

  // ---------- Phase 2: back up local copies whose Notion write succeeded ----------
  //
  // Only move sources that live INSIDE a configured scope target dir
  // (e.g. ~/.claude/skills/foo when foo is a real dir authored locally).
  // Sources from --from paths or symlinks pointing elsewhere are left
  // untouched — sync's reconciler handles those without us mutating the
  // real source.
  const ts = timestamp();
  const backupRoot = join(ROOT_DIR, "backup", `migrate-${ts}`);
  let backupCreated = false;

  for (const result of [...created, ...updated]) {
    let copyIndex = 0;
    for (const src of result.sources) {
      if (!sourceIsInScope(src, scopeTargetDirs)) continue;

      if (!backupCreated) {
        await mkdir(backupRoot, { recursive: true });
        console.log(chalk.dim(`Backing up local copies to ${backupRoot}`));
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
        console.warn(
          chalk.yellow(
            `  ! could not back up ${src}: ${(err as Error).message}`,
          ),
        );
      }
      copyIndex++;
    }
  }

  // Auto-extend include_skills so filter doesn't hide the freshly-migrated
  // skills on the next sync.
  const newIncludeSkills = new Set(scope.filter.include_skills ?? []);
  for (const c of [...willCreate, ...willOverwrite]) {
    if (c.kind === "new" || c.kind === "conflict") {
      newIncludeSkills.add(c.skill.name);
    }
  }
  const updatedFilter = {
    ...scope.filter,
    include_skills: [...newIncludeSkills],
  };
  if (scope.type === "global") {
    await writeGlobalScope({
      database_id: scope.database_id,
      data_source_id: scope.data_source_id,
      database_title: scope.database_title,
      targets: scope.targets,
      filter: updatedFilter,
    });
  } else {
    await writeProjectScope(scope.root, {
      database_id: scope.database_id,
      data_source_id: scope.data_source_id,
      database_title: scope.database_title,
      filter: updatedFilter,
    });
  }
  if (newIncludeSkills.size > (scope.filter.include_skills?.length ?? 0)) {
    console.log(
      chalk.dim(
        `Extended scope.filter.include_skills with: ${[...willCreate, ...willOverwrite]
          .map((c) => (c.kind === "new" || c.kind === "conflict" ? c.skill.name : ""))
          .filter(Boolean)
          .join(", ")}`,
      ),
    );
  }

  // Final sync to populate central store + symlinks.
  console.log(chalk.bold(`\nSyncing...`));
  // Reload scope so sync sees the updated filter.
  const reloaded = await getScope();
  if (!reloaded) throw new Error("scope vanished mid-migration");
  const summary = await runSync(reloaded);
  printSummary(summary);

  const totalDone = created.length + updated.length;
  console.log(
    chalk.green(
      `✓ Migrated ${totalDone} ${totalDone === 1 ? "skill" : "skills"}.` +
        (backupCreated ? ` Backup at ${backupRoot}` : ""),
    ),
  );
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
 */
function printSkillLine(skill: import("../migrate.js").ParsedSkill, mark: string): void {
  const dirs = sourceDirSummary(skill);
  const namePadded = skill.name.padEnd(40);
  const conflictNote = skill.conflictingSources && skill.conflictingSources.length > 0
    ? chalk.yellow(
        ` ⚠ also in ${skill.conflictingSources.map(parentDir).map(home).join(", ")} with different content — using ${home(parentDir(skill.source))}`,
      )
    : "";
  console.log(`  ${chalk.green(mark)} ${namePadded} ${chalk.dim(dirs)}${conflictNote}`);
}

function sourceDirSummary(skill: import("../migrate.js").ParsedSkill): string {
  const all = [skill.source, ...(skill.additionalSources ?? [])];
  return all.map((p) => home(parentDir(p))).join(", ");
}

function parentDir(realpath: string): string {
  // /Users/blovin/.claude/skills/bun → /Users/blovin/.claude/skills
  return dirname(realpath);
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
