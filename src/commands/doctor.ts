import chalk from "chalk";
import { existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import {
  findProjectScopePath,
  readGlobalScope,
  readProjectScope,
  type Scope,
} from "../scope.js";
import { ntnDoctor, ntnVersion } from "../ntn.js";
import { readManifest } from "../manifest.js";
import {
  MANIFEST_FILE,
  PROJECT_LOCK_FILENAME,
  PROJECT_SKILLS_RELATIVE,
  SKILLS_STORE,
} from "../paths.js";
import { findTargetByKey, KNOWN_TARGETS } from "../known-targets.js";
import { NotionClient } from "../notion.js";
import { SCHEMA } from "../schema.js";

interface DoctorOptions {
  fix?: boolean;
}

interface CheckResult {
  status: "ok" | "warn" | "fail";
  label: string;
  detail?: string;
  /** Optional auto-repair. Only invoked when `--fix` is passed. */
  fix?: () => Promise<string>;
}

export async function doctorCommand(opts: DoctorOptions): Promise<void> {
  const checks: CheckResult[] = [];

  // 1. ntn auth
  checks.push(...(await checkNtn()));

  // 2. Scope
  const scope = await currentScope();
  if (!scope) {
    checks.push({
      status: "fail",
      label: "No scope configured",
      detail: "Run `notion-skills init` to connect a Notion database.",
    });
    printAndExit(checks);
    return;
  }
  checks.push({
    status: "ok",
    label: `Scope: ${scope.type} (${scope.database_title ?? scope.database_id})`,
  });

  // 3. Schema (only if ntn is authenticated)
  const ntnOk = checks.every((c) => !c.label.startsWith("ntn") || c.status === "ok");
  if (ntnOk) {
    checks.push(...(await checkSchema(scope)));
  }

  // 4. Manifest / disk consistency
  checks.push(...(await checkManifestVsDisk(scope)));

  // 5. Symlinks (global scope only)
  if (scope.type === "global") {
    checks.push(...(await checkSymlinks(scope)));
  }

  // Run fixes if asked.
  if (opts.fix) {
    const fixable = checks.filter((c) => c.fix && c.status !== "ok");
    if (fixable.length === 0) {
      console.log(chalk.dim("Nothing to fix."));
    } else {
      console.log(chalk.bold(`\nApplying ${fixable.length} fix(es):`));
      for (const c of fixable) {
        if (!c.fix) continue;
        if (process.stdin.isTTY) {
          const ok = await confirm({
            message: `Fix: ${c.label}?`,
            default: true,
          });
          if (!ok) continue;
        }
        try {
          const msg = await c.fix();
          console.log(`  ${chalk.green("✓")} ${msg}`);
        } catch (err) {
          console.log(
            `  ${chalk.red("✗")} ${c.label}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  printAndExit(checks);
}

// ---------- checks ----------

async function checkNtn(): Promise<CheckResult[]> {
  const version = await ntnVersion();
  if (!version) {
    return [
      {
        status: "fail",
        label: "ntn is not installed",
        detail: "Install: https://github.com/makenotion/ntn-cli",
      },
    ];
  }
  const versionLabel = version.replace(/^ntn\s+/, "");
  const doc = await ntnDoctor();
  if (!doc.ok) {
    return [
      {
        status: "fail",
        label: `ntn ${versionLabel} not authenticated`,
        detail: "Run `ntn login` to refresh.",
      },
    ];
  }
  return [{ status: "ok", label: `ntn ${versionLabel} authenticated` }];
}

async function checkSchema(scope: Scope): Promise<CheckResult[]> {
  try {
    const client = new NotionClient();
    const ds = await client.getDataSource(scope.data_source_id);
    const present = new Set(Object.keys(ds.properties));
    const missing = SCHEMA.filter(
      (p) => p.kind !== "title" && !present.has(p.notionName),
    );
    if (missing.length === 0) {
      return [{ status: "ok", label: "Schema matches notion-skills spec" }];
    }
    return [
      {
        status: "warn",
        label: `Schema missing ${missing.length} property(ies): ${missing.map((m) => m.notionName).join(", ")}`,
        detail: "Run `notion-skills upgrade` to add them.",
      },
    ];
  } catch (err) {
    return [
      {
        status: "fail",
        label: "Couldn't reach the Notion database",
        detail: (err as Error).message.split("\n")[0],
      },
    ];
  }
}

async function checkManifestVsDisk(scope: Scope): Promise<CheckResult[]> {
  const manifestPath =
    scope.type === "global"
      ? MANIFEST_FILE
      : resolve(scope.root, PROJECT_LOCK_FILENAME);
  const contentRoot =
    scope.type === "global"
      ? SKILLS_STORE
      : resolve(scope.root, PROJECT_SKILLS_RELATIVE);

  const manifest = await readManifest(manifestPath);
  if (!manifest) {
    return [
      {
        status: "warn",
        label: "Manifest missing — never synced from this machine",
        detail: "Run `notion-skills sync` to create one.",
      },
    ];
  }

  const onDisk = existsSync(contentRoot)
    ? new Set(
        readdirSync(contentRoot).filter((n) =>
          existsSync(join(contentRoot, n, "SKILL.md")),
        ),
      )
    : new Set<string>();
  const inManifest = new Set(Object.keys(manifest.skills));

  const orphans = [...onDisk].filter((n) => !inManifest.has(n));
  const phantoms = [...inManifest].filter((n) => !onDisk.has(n));

  const out: CheckResult[] = [];
  out.push({
    status: "ok",
    label: `Manifest tracks ${inManifest.size} skill(s); central store has ${onDisk.size}`,
  });

  if (orphans.length > 0) {
    out.push({
      status: "warn",
      label: `${orphans.length} central-store dir(s) not in manifest: ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? "…" : ""}`,
      detail: "Probably stale from a previous DB. Safe to remove.",
      fix: async () => {
        for (const name of orphans) {
          await rm(join(contentRoot, name), { recursive: true, force: true });
        }
        return `Removed ${orphans.length} orphaned central-store dir(s)`;
      },
    });
  }

  if (phantoms.length > 0) {
    out.push({
      status: "warn",
      label: `${phantoms.length} manifest entry(ies) point to missing files: ${phantoms.slice(0, 5).join(", ")}${phantoms.length > 5 ? "…" : ""}`,
      detail: "Re-run sync to repopulate.",
    });
  }

  return out;
}

async function checkSymlinks(scope: Scope): Promise<CheckResult[]> {
  if (scope.type !== "global") return [];
  const manifest = await readManifest(MANIFEST_FILE);
  if (!manifest) return [];

  const out: CheckResult[] = [];
  for (const key of scope.targets) {
    const target = findTargetByKey(key);
    if (!target) {
      out.push({
        status: "warn",
        label: `Unknown target in scope: "${key}"`,
        detail: "Edit ~/.notion-skills/scope.json or run init again.",
      });
      continue;
    }

    const expected = new Set(Object.keys(manifest.skills));
    const dir = target.dir;
    let ok = 0;
    let dangling: string[] = [];
    let foreign: string[] = [];
    let missing: string[] = [];

    for (const name of expected) {
      const link = join(dir, name);
      if (!existsSync(link)) {
        // Existence checks the link target, so a dangling symlink fails too.
        try {
          lstatSync(link);
          // Link exists but target doesn't — dangling.
          dangling.push(name);
        } catch {
          missing.push(name);
        }
        continue;
      }
      const stat = lstatSync(link);
      if (!stat.isSymbolicLink()) {
        foreign.push(name);
        continue;
      }
      const realPath = readlinkSync(link);
      const expectedReal = join(SKILLS_STORE, name);
      if (realPath === expectedReal) ok++;
      else dangling.push(name);
    }

    out.push({
      status:
        missing.length + dangling.length + foreign.length > 0 ? "warn" : "ok",
      label: `${target.label}: ${ok}/${expected.size} symlinks ok${
        missing.length ? `, ${missing.length} missing` : ""
      }${dangling.length ? `, ${dangling.length} broken` : ""}${
        foreign.length ? `, ${foreign.length} non-symlink` : ""
      }`,
      detail:
        missing.length + dangling.length + foreign.length > 0
          ? "Run `notion-skills sync` to repair."
          : undefined,
      fix:
        missing.length + dangling.length > 0
          ? async () => {
              const { runSync } = await import("../sync.js");
              await runSync(scope);
              return `Re-synced into ${target.label}`;
            }
          : undefined,
    });
  }
  return out;
}

// ---------- helpers ----------

async function currentScope(): Promise<Scope | null> {
  const projPath = findProjectScopePath(process.cwd());
  if (projPath) return readProjectScope(projPath);
  return readGlobalScope();
}

function printAndExit(checks: CheckResult[]): void {
  console.log(chalk.bold("notion-skills doctor"));
  console.log(chalk.dim("─".repeat(50)));
  for (const c of checks) {
    const mark =
      c.status === "ok"
        ? chalk.green("✓")
        : c.status === "warn"
          ? chalk.yellow("⚠")
          : chalk.red("✗");
    console.log(`${mark} ${c.label}`);
    if (c.detail) {
      for (const line of c.detail.split("\n")) {
        console.log(chalk.dim(`  → ${line}`));
      }
    }
  }

  const counts = {
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
  const totalIssues = counts.warn + counts.fail;

  console.log("");
  if (totalIssues === 0) {
    console.log(chalk.green(`✓ All ${counts.ok} checks passed.`));
  } else {
    const fixable = checks.filter((c) => c.fix && c.status !== "ok").length;
    console.log(
      `${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} failure(s).`,
    );
    if (fixable > 0) {
      console.log(
        chalk.dim(
          `${fixable} issue(s) can be auto-fixed: run \`notion-skills doctor --fix\``,
        ),
      );
    }
  }

  // Don't exit non-zero for warnings; only failures.
  if (counts.fail > 0) process.exit(1);
}

// Avoid unused-import errors for KNOWN_TARGETS (used only in the symlink check above).
void KNOWN_TARGETS;
