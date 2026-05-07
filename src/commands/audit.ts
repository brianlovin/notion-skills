import chalk from "chalk";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getScope } from "../scope.js";
import { loadManifest } from "../manifest.js";
import { SKILLS_STORE } from "../paths.js";
import {
  type AuditTarget,
  type Issue,
  auditSkill,
  loadAuditTarget,
  summariseIssues,
} from "../audit.js";

interface AuditOptions {
  drafts?: boolean;
  installed?: boolean;
  source?: string;
  json?: boolean;
}

interface SkillReport {
  localSlug: string;
  state: "installed" | "draft";
  source_key: string | null;
  issues: Issue[];
}

/**
 * Run the audit rules against every skill on this machine. Default
 * scope: every local skill (installed + drafts). `--drafts` /
 * `--installed` / `--source` narrow the scope. JSON output for
 * automation; otherwise a tabular summary.
 *
 * Hard errors exit non-zero; warnings + infos do not (matches `npm
 * audit` behavior).
 */
export async function auditCommand(
  args: string[],
  options: AuditOptions = {},
): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  const manifest = await loadManifest(scope.sources);

  const targets = await collectTargets(args, options, manifest);
  if (targets.length === 0) {
    console.log(chalk.dim("No skills match the audit scope."));
    return;
  }

  const reports: SkillReport[] = targets.map((t) => ({
    localSlug: t.target.localSlug,
    state: t.state,
    source_key: t.source_key,
    issues: auditSkill(t.target),
  }));

  if (options.json) {
    console.log(JSON.stringify(reports, null, 2));
    if (reports.some((r) => r.issues.some((i) => i.severity === "error"))) {
      process.exit(1);
    }
    return;
  }

  renderReports(reports);
  if (reports.some((r) => r.issues.some((i) => i.severity === "error"))) {
    process.exit(1);
  }
}

interface TargetWithMeta {
  target: AuditTarget;
  state: "installed" | "draft";
  source_key: string | null;
}

async function collectTargets(
  args: string[],
  options: AuditOptions,
  manifest: import("../manifest.js").Manifest | null,
): Promise<TargetWithMeta[]> {
  // Explicit slugs: audit just those (one or more).
  if (args.length > 0) {
    const out: TargetWithMeta[] = [];
    for (const slug of args) {
      const dir = join(SKILLS_STORE, slug);
      if (!existsSync(join(dir, "SKILL.md"))) {
        throw new Error(`Skill "${slug}" not found on this machine. Run \`notion-skills list\` to see what's installed.`);
      }
      const target = await loadAuditTarget(slug, dir);
      if (!target) continue;
      const entry = manifest?.skills[slug];
      out.push({
        target,
        state: entry ? "installed" : "draft",
        source_key: entry?.source_key ?? null,
      });
    }
    return out;
  }

  // No explicit slugs: walk the central store.
  if (!existsSync(SKILLS_STORE)) return [];

  const entries = readdirSync(SKILLS_STORE).filter((name) => {
    if (name.startsWith(".")) return false;
    try {
      return statSync(join(SKILLS_STORE, name)).isDirectory();
    } catch {
      return false;
    }
  });

  const out: TargetWithMeta[] = [];
  for (const localSlug of entries) {
    const dir = join(SKILLS_STORE, localSlug);
    const target = await loadAuditTarget(localSlug, dir);
    if (!target) continue;
    const entry = manifest?.skills[localSlug];
    const state: "installed" | "draft" = entry ? "installed" : "draft";
    const source_key = entry?.source_key ?? null;

    if (options.drafts && state !== "draft") continue;
    if (options.installed && state !== "installed") continue;
    if (options.source && source_key !== options.source) continue;

    out.push({ target, state, source_key });
  }
  return out;
}

function renderReports(reports: SkillReport[]): void {
  console.log(chalk.bold("notion-skills audit"));
  console.log(chalk.dim("─".repeat(50)));
  console.log("");

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfos = 0;
  let cleanCount = 0;

  for (const r of reports) {
    const summary = summariseIssues(r.issues);
    totalErrors += summary.errors;
    totalWarnings += summary.warnings;
    totalInfos += summary.infos;
    if (r.issues.length === 0) {
      cleanCount++;
      // Only show clean rows when total skill count is small; otherwise
      // they crowd out the issues. Still print under -v in the future.
      if (reports.length <= 10) {
        console.log(`${chalk.green("✓")} ${r.localSlug} ${chalk.dim("clean")}`);
      }
      continue;
    }
    const tags: string[] = [];
    if (summary.errors > 0) tags.push(chalk.red(`${summary.errors} ${pluralise("error", summary.errors)}`));
    if (summary.warnings > 0) tags.push(chalk.yellow(`${summary.warnings} ${pluralise("warning", summary.warnings)}`));
    if (summary.infos > 0) tags.push(chalk.cyan(`${summary.infos} info`));
    console.log(`${markFor(r.issues)} ${chalk.bold(r.localSlug)} ${chalk.dim(`[${tags.join(", ")}]`)}`);
    for (const issue of r.issues) {
      const sev = severityLabel(issue.severity);
      const id = chalk.dim(issue.ruleId.padEnd(28));
      const lineHint = issue.line ? chalk.dim(` (line ${issue.line})`) : "";
      console.log(`  ${sev} ${id} ${issue.message}${lineHint}`);
    }
  }

  console.log("");
  const parts: string[] = [`${reports.length} ${pluralise("skill", reports.length)} audited`];
  if (cleanCount > 0) parts.push(`${cleanCount} clean`);
  if (totalErrors > 0) parts.push(chalk.red(`${totalErrors} ${pluralise("error", totalErrors)}`));
  if (totalWarnings > 0) parts.push(chalk.yellow(`${totalWarnings} ${pluralise("warning", totalWarnings)}`));
  if (totalInfos > 0) parts.push(chalk.cyan(`${totalInfos} info`));
  console.log(chalk.dim(parts.join(" · ")));
}

function severityLabel(s: Issue["severity"]): string {
  if (s === "error") return chalk.red("error");
  if (s === "warning") return chalk.yellow("warn ");
  return chalk.cyan("info ");
}

function markFor(issues: Issue[]): string {
  if (issues.some((i) => i.severity === "error")) return chalk.red("✗");
  if (issues.some((i) => i.severity === "warning")) return chalk.yellow("⚠");
  return chalk.cyan("ℹ");
}

function pluralise(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}
