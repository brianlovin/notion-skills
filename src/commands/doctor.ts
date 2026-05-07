import chalk from "chalk";
import { existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { getScope, type Scope } from "../scope.js";
import { ntnDoctor, ntnVersion } from "../ntn.js";
import { loadManifest } from "../manifest.js";
import { SKILLS_STORE } from "../paths.js";
import { findTargetByKey, KNOWN_TARGETS } from "../known-targets.js";
import { NotionClient } from "../notion.js";
import { SCHEMA } from "../schema.js";
import { detectSlugCollisions } from "../slug-collisions.js";
import { type Source } from "../sources.js";

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
  const scope = await getScope();
  if (!scope || scope.sources.length === 0) {
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
    label: `Scope: ${scope.sources.length} ${scope.sources.length === 1 ? "source" : "sources"} (${scope.sources.map((s) => s.key).join(", ")})`,
  });

  // 3. Per-source schema + collision health (only if ntn is authenticated)
  const ntnOk = checks.every((c) => !c.label.startsWith("ntn") || c.status === "ok");
  if (ntnOk) {
    for (const source of scope.sources) {
      checks.push(...(await checkSchema(source)));
      checks.push(...(await checkSlugCollisions(source)));
    }
  }

  // 4. Manifest / disk consistency
  checks.push(...(await checkManifestVsDisk(scope)));

  // 5. Symlinks
  checks.push(...(await checkSymlinks(scope)));

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

async function checkSchema(source: Source): Promise<CheckResult[]> {
  try {
    const client = new NotionClient();
    const ds = await client.getDataSource(source.data_source_id);
    const present = new Set(Object.keys(ds.properties));
    // Hard requirements: Name + Description. Without these the store
    // can't function. Everything else is added progressively when a
    // skill that uses it gets published — absent properties aren't a
    // problem, they're the design.
    const required = ["Name", "Description"];
    const missingRequired = required.filter((name) => !present.has(name));
    if (missingRequired.length > 0) {
      return [
        {
          status: "fail",
          label: `${source.key}: missing required ${missingRequired.length === 1 ? "property" : "properties"}: ${missingRequired.join(", ")}`,
          detail: `Run \`notion-skills upgrade --source ${source.key}\` to repair.`,
        },
      ];
    }
    const optionalPresent = SCHEMA.filter(
      (p) => p.kind !== "title" && p.notionName !== "Description" && present.has(p.notionName),
    ).length;
    return [
      {
        status: "ok",
        label: `${source.key}: schema healthy (Name + Description + ${optionalPresent} optional)`,
      },
    ];
  } catch (err) {
    return [
      {
        status: "fail",
        label: `${source.key}: couldn't reach the Notion database`,
        detail: (err as Error).message.split("\n")[0],
      },
    ];
  }
}

async function checkSlugCollisions(source: Source): Promise<CheckResult[]> {
  try {
    const client = new NotionClient();
    const pages = await client.queryDataSource(source.data_source_id);
    const collisions = detectSlugCollisions(pages);
    if (collisions.length === 0) {
      return [{ status: "ok", label: `${source.key}: no slug collisions` }];
    }
    const lines = collisions.map(
      (c) => `  ${c.slug}: ${c.titles.join(", ")}`,
    );
    return [
      {
        status: "warn",
        label: `${source.key}: ${collisions.length} slug ${collisions.length === 1 ? "collision" : "collisions"}: ${collisions.map((c) => c.slug).join(", ")}`,
        detail:
          [
            "Multiple Notion pages slugify to the same name and are skipped by sync / refused by install.",
            ...lines,
            "Rename one page in each group to disambiguate.",
          ].join("\n"),
      },
    ];
  } catch (err) {
    return [
      {
        status: "warn",
        label: `${source.key}: couldn't check slug collisions`,
        detail: (err as Error).message.split("\n")[0],
      },
    ];
  }
}

async function checkManifestVsDisk(scope: Scope): Promise<CheckResult[]> {
  const contentRoot = SKILLS_STORE;
  const manifest = await loadManifest(scope.sources);
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
    label: `Manifest tracks ${inManifest.size} ${inManifest.size === 1 ? "skill" : "skills"}; central store has ${onDisk.size}`,
  });

  if (orphans.length > 0) {
    // Under the v0.5 app-store model these aren't orphans — they're
    // drafts (local skills not yet published). Surface as info, not a
    // warning, and don't suggest removing them.
    out.push({
      status: "ok",
      label: `${orphans.length} ${orphans.length === 1 ? "draft" : "drafts"} (local-only, not yet published): ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? "…" : ""}`,
      detail: `Run \`notion-skills publish <slug>\` to share with your team, or \`notion-skills uninstall <slug>\` to discard.`,
    });
  }

  if (phantoms.length > 0) {
    out.push({
      status: "warn",
      label: `${phantoms.length} manifest ${phantoms.length === 1 ? "entry points" : "entries point"} to missing files: ${phantoms.slice(0, 5).join(", ")}${phantoms.length > 5 ? "…" : ""}`,
      detail: "Re-run sync to repopulate.",
    });
  }

  return out;
}

async function checkSymlinks(scope: Scope): Promise<CheckResult[]> {
  const manifest = await loadManifest(scope.sources);
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
    const warnWord = counts.warn === 1 ? "warning" : "warnings";
    const failWord = counts.fail === 1 ? "failure" : "failures";
    console.log(
      `${counts.ok} ok, ${counts.warn} ${warnWord}, ${counts.fail} ${failWord}.`,
    );
    if (fixable > 0) {
      console.log(
        chalk.dim(
          `${fixable} ${fixable === 1 ? "issue" : "issues"} can be auto-fixed: run \`notion-skills doctor --fix\``,
        ),
      );
    }
  }

  // Don't exit non-zero for warnings; only failures.
  if (counts.fail > 0) process.exit(1);
}

// Avoid unused-import errors for KNOWN_TARGETS (used only in the symlink check above).
void KNOWN_TARGETS;
