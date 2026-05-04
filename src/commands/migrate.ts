import chalk from "chalk";
import ora from "ora";
import { confirm } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  findProjectScopePath,
  readGlobalScope,
  readProjectScope,
  writeGlobalScope,
  writeProjectScope,
  type Scope,
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
import {
  KNOWN_TARGETS,
  PROJECT_SKILLS_RELATIVE,
  ROOT_DIR,
} from "../paths.js";
import { runSync, printSummary } from "../sync.js";

interface MigrateOptions {
  from?: string[];
  overwrite?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export async function migrateCommand(opts: MigrateOptions): Promise<void> {
  await assertNtnInstalled();

  const scope = await currentScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  // Resolve sources.
  const scopeTargetDirs =
    scope.type === "global"
      ? scope.targets.map((k) => KNOWN_TARGETS[k].dir)
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
  const queryProgress = ora("Checking Notion for existing skills...").start();
  const existing = await client.queryDataSource(scope.data_source_id);
  queryProgress.succeed(`Notion has ${existing.length} pages.`);

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

  // Move local copies to backup before any writes to Notion.
  //
  // Only move sources that live INSIDE a configured scope target dir
  // (e.g. ~/.claude/skills/foo when foo is a real dir authored locally).
  // Sources that came from --from paths, or sources reached via a symlink
  // pointing at a different location (e.g. an agent-config repo), are
  // left untouched — sync's symlink reconciler will repoint the symlink
  // in the target dir without us needing to mutate the real source.
  const ts = timestamp();
  const backupRoot = join(ROOT_DIR, "backup", `migrate-${ts}`);
  let backupCreated = false;

  for (const c of [...willCreate, ...willOverwrite]) {
    if (c.kind !== "new" && c.kind !== "conflict") continue;
    if (!sourceIsInScope(c.skill.source, scopeTargetDirs)) continue;

    if (!backupCreated) {
      await mkdir(backupRoot, { recursive: true });
      console.log(chalk.dim(`Backing up local copies to ${backupRoot}`));
      backupCreated = true;
    }

    const dest = join(backupRoot, c.skill.name);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await rename(c.skill.source, dest);
    } catch (err) {
      console.warn(
        chalk.yellow(
          `  ! could not back up ${c.skill.source}: ${(err as Error).message}`,
        ),
      );
    }
  }

  // Self-heal select properties: any agent / model values referenced by
  // the migration that aren't already options on the data source need to
  // be added before the page-create call (Notion rejects unknown options).
  const selfHealing = collectSelfHealingValues([...willCreate, ...willOverwrite]);
  if (selfHealing.size > 0) {
    const healSpinner = ora("Adding new select options...").start();
    try {
      const reports = await client.ensureSelectOptions(
        scope.data_source_id,
        selfHealing,
      );
      if (reports.length === 0) {
        healSpinner.stop();
      } else {
        healSpinner.succeed("Added select options:");
        for (const r of reports) {
          console.log(`  ${chalk.green("+")} ${r.column}: ${r.added.join(", ")}`);
        }
      }
    } catch (err) {
      healSpinner.fail(`Could not extend select options: ${(err as Error).message}`);
      throw err;
    }
  }

  // Push to Notion.
  const created: { name: string; pageId: string }[] = [];
  const updated: { name: string; pageId: string }[] = [];

  for (const c of willCreate) {
    if (c.kind !== "new") continue;
    const spinner = ora(`Creating ${c.skill.name}...`).start();
    try {
      const pageId = await client.createSkillPage(
        scope.data_source_id,
        c.skill.properties,
      );
      if (c.skill.body.trim()) {
        await ntnSetPageMarkdown(pageId, c.skill.body);
      }
      created.push({ name: c.skill.name, pageId });
      spinner.succeed(`Created ${c.skill.name}`);
    } catch (err) {
      spinner.fail(
        `Failed to create ${c.skill.name}: ${(err as Error).message}`,
      );
    }
  }

  for (const c of willOverwrite) {
    if (c.kind !== "conflict") continue;
    const spinner = ora(`Overwriting ${c.skill.name}...`).start();
    try {
      await client.updateSkillPageProperties(
        c.existingPageId,
        c.skill.properties,
      );
      if (c.skill.body.trim()) {
        await ntnSetPageMarkdown(c.existingPageId, c.skill.body);
      }
      updated.push({ name: c.skill.name, pageId: c.existingPageId });
      spinner.succeed(`Overwrote ${c.skill.name}`);
    } catch (err) {
      spinner.fail(
        `Failed to overwrite ${c.skill.name}: ${(err as Error).message}`,
      );
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
  const reloaded = await currentScope();
  if (!reloaded) throw new Error("scope vanished mid-migration");
  const summary = await runSync(reloaded);
  printSummary(summary);

  console.log(
    chalk.green(
      `✓ Migrated ${created.length + updated.length} skill(s).` +
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
    opts.overwrite ? chalk.dim(" (will overwrite)") : chalk.dim(" (will skip; pass --overwrite)")
  }`);
  console.log(`  managed    ${groups.managed.length}${chalk.dim(" (already in central store)")}`);
  console.log(`  invalid    ${groups.invalid.length}`);
  console.log("");

  if (groups.new.length) {
    console.log(chalk.bold("New (will create):"));
    for (const c of groups.new) {
      if (c.kind === "new") {
        console.log(`  ${chalk.green("+")} ${c.skill.name.padEnd(40)} ${chalk.dim(c.skill.sourceDisplay)}`);
      }
    }
    console.log("");
  }

  if (groups.conflict.length) {
    console.log(chalk.bold("Conflicts:"));
    for (const c of groups.conflict) {
      if (c.kind === "conflict") {
        const tag = opts.overwrite ? chalk.yellow("~") : chalk.red("!");
        console.log(`  ${tag} ${c.skill.name.padEnd(40)} ${chalk.dim(`exists in Notion as "${c.existingTitle}"`)}`);
      }
    }
    console.log("");
  }

  if (groups.invalid.length) {
    console.log(chalk.bold("Invalid (skipped):"));
    for (const c of groups.invalid) {
      if (c.kind === "invalid") {
        console.log(`  ${chalk.dim("·")} ${c.sourceDisplay.padEnd(60)} ${chalk.dim(c.reason)}`);
      }
    }
    console.log("");
  }
}

async function currentScope(): Promise<Scope | null> {
  const projPath = findProjectScopePath(process.cwd());
  if (projPath) return readProjectScope(projPath);
  return readGlobalScope();
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
