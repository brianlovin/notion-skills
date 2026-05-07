import chalk from "chalk";
import { lstatSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkbox, confirm } from "@inquirer/prompts";
import { getScope } from "../scope.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import { readManifest } from "../manifest.js";
import { defaultSource } from "../sources.js";
import { ensureSymlink, targetSkillPath, targetsForKeys } from "../targets.js";
import { migrateCommand } from "./migrate.js";
import {
  type ParsedGitHubSource,
  type RepoTreeEntry,
  fetchFileContent,
  fetchRepoTree,
  formatSourceRef,
  parseGitHubSource,
  resolveDefaultBranch,
} from "../github.js";
import { auditSkill, loadAuditTarget, summariseIssues } from "../audit.js";
import { pickSource } from "./_resolve.js";
import { injectMetadataKey, parseFrontmatter } from "../frontmatter.js";
import { classifyExtension } from "../skill-files.js";
import { withSpinner } from "./_progress.js";

interface AddOptions {
  /** Filter to one or more skills in a multi-skill repo (also: `owner/repo@skill`). */
  skill?: string[];
  /** Print skill metadata + body without writing to disk. */
  preview?: boolean;
  /** Override the local slug (single-skill installs only). */
  as?: string;
  /** Publish to a Notion source after add. */
  publish?: boolean;
  /** Source key for `--publish`. */
  source?: string;
  /** Skip prompts. */
  yes?: boolean;
  /** Drop colliding skills silently; install only the new ones. */
  skipExisting?: boolean;
}

/**
 * Per-candidate decision made before any disk writes happen. Lets us
 * render the full plan to the user (and get a single confirm) instead
 * of surprising them with collisions skill-by-skill.
 *
 * Replacing a skill in-place is intentionally NOT a path here — the
 * explicit two-step (`uninstall <slug>` then `add <source>`) keeps
 * destructive operations aligned with the verb the user already has
 * for "remove from machine". It also avoids duplicating uninstall's
 * backup-on-drift logic.
 */
type AddAction = "install-new" | "rename" | "skip";

interface AddPlanItem {
  hydrated: HydratedSkill;
  action: AddAction;
  /** local_slug we'll write to (or that we're skipping). */
  proposedSlug: string;
  /** When action is "rename" or "overwrite": the existing slug we collide with. */
  conflictWith?: string;
}

/**
 * Pull a public skill from a GitHub repo into the central store as a
 * local draft. Mirrors skills.sh syntax for cross-ecosystem
 * familiarity but lands the skill in notion-skills' world: the user
 * can review locally, then `publish` to a configured Notion source
 * (or pass `--publish` to chain straight through).
 */
export async function addCommand(refs: string[], opts: AddOptions = {}): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }
  if (refs.length !== 1) {
    throw new Error("Usage: notion-skills add <ref>  (e.g. `vercel-labs/agent-skills`)");
  }

  const source = parseGitHubSource(refs[0]!);

  // Resolve the ref. If the user pinned, honour it; otherwise probe
  // for the repo's default branch (main/master/canonical fallback).
  // resolveDefaultBranch may opportunistically return the tree it
  // already had to fetch in the process — we reuse it to avoid a
  // second roundtrip.
  let ref: string;
  let tree;
  if (source.ref !== undefined) {
    ref = source.ref;
    tree = null;
  } else {
    const resolved = await resolveDefaultBranch(source);
    if (!resolved) {
      throw new Error(
        `Couldn't reach ${source.owner}/${source.repo}. Check the spelling, or set GITHUB_TOKEN if it's private.`,
      );
    }
    ref = resolved.ref;
    tree = resolved.cachedTree;
  }

  if (!tree) {
    tree = await withSpinner(
      `Fetching ${formatSourceRef({ ...source, ref })}`,
      () => fetchRepoTree(source, ref),
    );
  }
  if (tree.truncated) {
    console.log(
      chalk.yellow(
        "⚠ GitHub returned a truncated tree (>100k entries). Some skills may not appear.",
      ),
    );
  }

  const candidates = discoverSkillCandidates(tree.entries, source);
  if (candidates.length === 0) {
    throw new Error(
      `No skills found in ${formatSourceRef({ ...source, ref })}. Looked for SKILL.md at the root and under skills/<name>/.`,
    );
  }

  // Hydrate frontmatter on every candidate so we can filter, display,
  // and slug from the canonical `name` field. Filtering against the
  // dir name alone misses cases where dir != frontmatter name (e.g.
  // anthropics/skills/template/ has `name: template-skill` inside).
  // For repos with hundreds of skills this means many parallel fetches
  // up front, but `add` is interactive and the cost is bounded.
  const hydratedAll = await withSpinner(
    `Reading ${candidates.length} ${candidates.length === 1 ? "skill" : "skills"}`,
    () => hydrateCandidates(source, ref, candidates),
  );

  const skillNames = collectSkillFilter(opts, source);
  const hydrated = filterHydratedByName(hydratedAll, skillNames);

  if (hydrated.length === 0) {
    const known = hydratedAll.map((c) => c.frontmatterName ?? c.skillName).sort().join(", ");
    throw new Error(
      `No matches for ${skillNames.join(", ")}. Available: ${known}`,
    );
  }

  if (opts.preview) {
    await renderPreview(hydrated, source, ref);
    return;
  }

  const picked = await pickSkillsForAdd(
    hydrated,
    opts,
    formatSourceRef({ ...source, ref }),
  );
  if (picked.length === 0) {
    console.log(chalk.dim("Nothing to add."));
    return;
  }
  if (picked.length > 1 && opts.as) {
    throw new Error("--as only applies when adding exactly one skill.");
  }

  const defaultKey =
    defaultSource(scope.sources)?.key ?? scope.sources[0]?.key ?? "default";
  const manifest = await readManifest(MANIFEST_FILE, defaultKey);

  // Classify every picked candidate up front. The user sees the full
  // plan in a summary and confirms once; we never surprise them
  // skill-by-skill.
  const plan = buildAddPlan(picked, source, manifest, opts);
  const sourceRef = formatSourceRef({ ...source, ref });
  renderAddPlan(plan, sourceRef);

  // Two failure modes from confirmAddPlan:
  //   - "nothing to do": plan reduced to zero work (e.g. --skip-existing
  //     with all collisions). That's a success — exit clean.
  //   - "user declined": they pressed n at the prompt. Print Aborted.
  const willActOn = plan.filter((p) => p.action !== "skip").length;
  if (willActOn === 0) {
    console.log(chalk.dim("Nothing to add."));
    return;
  }
  if (!(await confirmAddPlan(plan, opts))) {
    console.log(chalk.dim("Aborted."));
    return;
  }

  const addedSlugs: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const item of plan) {
    if (item.action === "skip") continue;
    try {
      await materialiseSkill(source, ref, item.hydrated, item.proposedSlug);
      await fanoutSymlinks(item.proposedSlug, scope.targets);
      addedSlugs.push(item.proposedSlug);
      const note = renderActionNote(item);
      console.log(`  ${chalk.green("+")} ${item.proposedSlug}${note}`);
    } catch (err) {
      const partial = join(SKILLS_STORE, item.proposedSlug);
      try {
        await rm(partial, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      const reason = (err as Error).message.split("\n")[0] ?? "unknown error";
      failed.push({ name: item.proposedSlug, reason });
      console.log(`  ${chalk.red("✗")} ${item.proposedSlug} ${chalk.dim(`(${reason})`)}`);
    }
  }

  if (failed.length > 0) {
    console.log("");
    const total = plan.filter((p) => p.action !== "skip").length;
    console.log(
      chalk.yellow(
        `${failed.length} of ${total} ${total === 1 ? "skill" : "skills"} failed. Re-run with the same source to retry.`,
      ),
    );
  }
  if (addedSlugs.length === 0) return;

  // Audit each added draft and surface counts inline. Errors don't
  // block — the draft is on disk and re-runnable; we just inform.
  const auditCounts = await runAuditSummary(addedSlugs);

  if (opts.publish) {
    // Publish gate: errors block. Draft stays on disk so the user
    // can fix in place (`open <slug> --local`) and `publish <slug>`
    // when ready. This matches the principle that destructive /
    // irrecoverable operations (pushing to a shared Notion store)
    // should require a clean skill.
    if (auditCounts.errors > 0) {
      const slugs = auditCounts.slugsWithErrors.join(", ");
      console.log("");
      console.log(
        chalk.red(
          `✗ Refusing to publish: ${auditCounts.errors} audit ${auditCounts.errors === 1 ? "error" : "errors"} in ${slugs}.`,
        ),
      );
      console.log(
        chalk.dim(
          `  Fix with \`notion-skills audit ${auditCounts.slugsWithErrors[0]}\` (or open + edit), then \`notion-skills publish <slug>\`.`,
        ),
      );
      return;
    }
    const target = await pickSource(opts.source, scope);
    console.log("");
    console.log(
      chalk.dim(`Publishing ${addedSlugs.length} ${addedSlugs.length === 1 ? "skill" : "skills"} to "${target.name}"…`),
    );
    await migrateCommand({ yes: true, only: addedSlugs, source: target.key });
  } else {
    console.log("");
    if (addedSlugs.length === 1) {
      console.log(
        chalk.dim("→ run ") + chalk.bold(`notion-skills publish ${addedSlugs[0]}`) + chalk.dim(" to share with your team."),
      );
    } else {
      console.log(
        chalk.dim("→ run ") + chalk.bold(`notion-skills publish --all`) + chalk.dim(" to share with your team."),
      );
    }
  }
}

// ---------- discovery in the GitHub tree ----------

interface SkillCandidate {
  /** Full path to the SKILL.md in the repo (e.g. `skills/foo/SKILL.md`). */
  skillMdPath: string;
  /** Dir containing the SKILL.md (e.g. `skills/foo`). Empty for root. */
  skillDir: string;
  /** Source-side slug — last segment of skillDir, or repo name if root. */
  skillName: string;
  /** Sibling files (paths relative to the repo root). */
  siblingFiles: RepoTreeEntry[];
}

/**
 * Find SKILL.md occurrences in the tree. Two layouts are supported:
 *   - `SKILL.md` at the (sub)root → single-skill repo
 *   - `skills/<name>/SKILL.md` → multi-skill repo (also `<subpath>/<name>/SKILL.md`)
 */
function discoverSkillCandidates(
  entries: RepoTreeEntry[],
  source: ParsedGitHubSource,
): SkillCandidate[] {
  const root = source.subpath ? source.subpath.replace(/\/+$/, "") : "";
  const prefix = root ? `${root}/` : "";

  const skillMdPaths: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (!entry.path.endsWith("/SKILL.md") && entry.path !== "SKILL.md") continue;
    // Subpath-scoped: only include SKILL.md files at or under the
    // resolved subpath. The "<subpath>/SKILL.md" case is the user
    // pointing directly at a single skill via tree URL.
    if (root && !entry.path.startsWith(prefix) && entry.path !== `${root}/SKILL.md`) continue;
    if (root && entry.path === "SKILL.md") continue;
    skillMdPaths.push(entry.path);
  }

  const out: SkillCandidate[] = [];
  for (const skillMdPath of skillMdPaths) {
    const skillDir = skillMdPath === "SKILL.md" ? "" : dirname(skillMdPath);
    const skillName = deriveSkillName(skillDir, root, source.repo);
    const siblings = entries.filter((e) => isSibling(e, skillDir));
    out.push({ skillMdPath, skillDir, skillName, siblingFiles: siblings });
  }

  // De-dupe by skill name; longer skillDir wins (more specific).
  const dedup = new Map<string, SkillCandidate>();
  for (const c of out) {
    const existing = dedup.get(c.skillName);
    if (!existing || c.skillDir.length > existing.skillDir.length) {
      dedup.set(c.skillName, c);
    }
  }
  return [...dedup.values()].sort((a, b) => a.skillName.localeCompare(b.skillName));
}

function deriveSkillName(skillDir: string, root: string, repoName: string): string {
  // Root-of-repo SKILL.md → use the repo name as the skill name.
  // Skill nested under a (sub)root → use its dir's last segment.
  if (skillDir === "" || skillDir === root) {
    // For a subpath like "skills/foo" pointing directly at a skill,
    // skillDir === root. The leaf segment is the skill name.
    if (root && skillDir === root) {
      return root.split("/").pop() || repoName;
    }
    return repoName;
  }
  return skillDir.split("/").pop() || skillDir;
}

function isSibling(entry: RepoTreeEntry, skillDir: string): boolean {
  if (entry.type !== "blob") return false;
  const base = skillDir === "" ? "" : `${skillDir}/`;
  if (!entry.path.startsWith(base)) return false;
  const rel = entry.path.slice(base.length);
  if (rel === "SKILL.md") return false;
  if (rel.length === 0) return false;
  return true;
}

// ---------- filtering + hydration ----------

function collectSkillFilter(opts: AddOptions, source: ParsedGitHubSource): string[] {
  const fromFlag = opts.skill ?? [];
  const fromSource = source.skillFilter ? [source.skillFilter] : [];
  return [...new Set([...fromFlag, ...fromSource])];
}

function filterHydratedByName(hydrated: HydratedSkill[], wanted: string[]): HydratedSkill[] {
  if (wanted.length === 0) return hydrated;
  const wantedLower = wanted.map((s) => s.toLowerCase());
  return hydrated.filter((c) => {
    const fm = c.frontmatterName?.toLowerCase();
    const dir = c.skillName.toLowerCase();
    const subdir = c.skillDir.toLowerCase();
    return wantedLower.some((w) => w === "*" || w === fm || w === dir || w === subdir);
  });
}

interface HydratedSkill extends SkillCandidate {
  /** The skill's frontmatter name (overrides skillName when present). */
  frontmatterName: string | null;
  description: string | null;
  rawSkillMd: string;
}

async function hydrateCandidates(
  source: ParsedGitHubSource,
  ref: string,
  candidates: SkillCandidate[],
): Promise<HydratedSkill[]> {
  // Parallelise the SKILL.md fetches — each is an independent HTTP
  // call to raw.githubusercontent and the network is the bottleneck.
  // For an 18-skill repo this drops the wall time from ~15s to ~1s.
  const results = await Promise.all(
    candidates.map(async (c) => {
      const raw = await fetchFileContent(source, ref, c.skillMdPath);
      if (raw === null) return null;
      const fm = readFrontmatter(raw);
      return {
        ...c,
        frontmatterName: typeof fm["name"] === "string" ? fm["name"] : null,
        description: typeof fm["description"] === "string" ? fm["description"] : null,
        rawSkillMd: raw,
      } satisfies HydratedSkill;
    }),
  );
  return results.filter((r): r is HydratedSkill => r !== null);
}

function readFrontmatter(text: string): Record<string, unknown> {
  return parseFrontmatter(text).frontmatter;
}

// ---------- preview ----------

async function renderPreview(
  skills: HydratedSkill[],
  source: ParsedGitHubSource,
  ref: string,
): Promise<void> {
  console.log(
    chalk.bold(`\n${formatSourceRef({ ...source, ref })}`) +
      chalk.dim(` — ${skills.length} ${skills.length === 1 ? "skill" : "skills"}:`),
  );
  console.log("");

  if (skills.length === 1) {
    const s = skills[0]!;
    console.log(chalk.bold(s.frontmatterName ?? s.skillName));
    if (s.description) console.log(chalk.dim(s.description));
    console.log("");
    console.log(chalk.dim(`Path:     ${s.skillMdPath}`));
    console.log(chalk.dim(`Siblings: ${s.siblingFiles.length}`));
    console.log("");
    console.log(s.rawSkillMd.trim());
    return;
  }

  const maxName = Math.max(...skills.map((s) => (s.frontmatterName ?? s.skillName).length));
  const namePad = Math.min(40, Math.max(maxName + 2, 12));
  for (const s of skills) {
    const name = (s.frontmatterName ?? s.skillName).padEnd(namePad);
    const desc = oneLine(s.description ?? "");
    console.log(`  ${chalk.bold(name)} ${chalk.dim(truncate(desc, 80))}`);
  }
  console.log("");
  console.log(
    chalk.dim("→ run ") +
      chalk.bold(`notion-skills add ${formatSourceRef({ ...source, ref })} --skill <name>`) +
      chalk.dim(" to add a specific one."),
  );
}

// ---------- picker ----------

async function pickSkillsForAdd(
  skills: HydratedSkill[],
  opts: AddOptions,
  sourceRef: string,
): Promise<HydratedSkill[]> {
  if (skills.length === 1) return skills;
  if (opts.yes) return skills; // bulk-confirm = "all"

  // Non-TTY refuses to pick silently for multi-skill repos. Auto-
  // adding 18 skills under a script's nose is the kind of surprise
  // that kicks off Slack threads. Force the operator to be explicit:
  // pick a single skill via @<name>/--skill, or pass --yes to claim
  // "all of them".
  if (!process.stdin.isTTY) {
    const names = skills.map((s) => s.frontmatterName ?? s.skillName).join(", ");
    throw new Error(
      [
        `${skills.length} skills found in this repo and stdin isn't a TTY.`,
        `  → pass \`--skill <name>\` (or \`@<name>\` in the source) to add a specific one`,
        `  → or pass \`--yes\` to add all of them: ${names}`,
      ].join("\n"),
    );
  }

  // Inquirer's checkbox already handles 'a' (toggle-all) and 'i'
  // (invert) — we just have to mention them in the help text so
  // users discover the shortcuts. With every skill pre-checked, the
  // common "I want all of them" path is just <enter>; the "I want
  // just two" path is 'a' (deselect all) then <space> the picks.
  const cols = process.stdout.columns ?? 100;
  const longestName = Math.max(
    ...skills.map((s) => (s.frontmatterName ?? s.skillName).length),
  );
  const namePad = Math.min(40, longestName + 2);
  const descMax = Math.max(20, cols - namePad - 12);

  const choices = skills.map((s) => {
    const name = (s.frontmatterName ?? s.skillName).padEnd(namePad);
    const desc = s.description
      ? chalk.dim(` ${truncate(oneLine(s.description), descMax)}`)
      : "";
    return { name: `${name}${desc}`, value: s, checked: true };
  });

  return (await checkbox({
    message: `Skills from ${chalk.bold(sourceRef)} ${chalk.dim(`(${skills.length} found, all selected)`)}`,
    instructions: chalk.dim(
      "  ↑↓ navigate · <space> toggle · 'a' all/none · 'i' invert · <enter> confirm · ^C cancel",
    ),
    choices,
    pageSize: Math.min(25, choices.length + 2),
    theme: {
      // Show the help line on every render — by default inquirer
      // only shows it on first paint, and the shortcuts are exactly
      // what we want users to discover as they navigate.
      helpMode: "always",
    },
  })) as HydratedSkill[];
}

// ---------- materialise ----------

/**
 * Classify every picked candidate into an explicit action — never
 * silently destructive. The default for a colliding skill is "rename"
 * (auto-namespace, both versions kept). Users opt out via:
 *   --skip-existing  → drop the colliding ones, install only news
 *   uninstall + add  → the explicit two-step for "replace existing"
 *
 * `--as` is a single-skill override: if it doesn't collide, use it.
 * If it DOES collide, we error rather than fall back — the user
 * explicitly named the skill, and silently producing a different
 * name (`<owner>-<source-slug>`) would be surprising.
 */
function buildAddPlan(
  picked: HydratedSkill[],
  source: ParsedGitHubSource,
  manifest: import("../manifest.js").Manifest | null,
  opts: AddOptions,
): AddPlanItem[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const inFlight = new Set<string>();
  const taken = (slug: string): boolean => {
    if (inFlight.has(slug)) return true;
    if (manifest?.skills[slug]) return true;
    const dir = join(SKILLS_STORE, slug);
    try {
      lstatSync(dir);
      return true;
    } catch {
      return false;
    }
  };

  const plan: AddPlanItem[] = [];
  for (const c of picked) {
    const baseSlug = norm(c.frontmatterName ?? c.skillName);
    const override = picked.length === 1 ? opts.as : undefined;

    if (override) {
      // `--as` is the user's explicit name. We honour it OR refuse —
      // never silently pick a different one. Pass through the same
      // normalisation as auto-derived slugs so case-insensitive
      // filesystems don't see `Foo` and `foo` as different.
      const normedOverride = norm(override);
      if (taken(normedOverride)) {
        throw new Error(
          `--as "${normedOverride}" is already taken on this machine. Pick a different name, or run \`notion-skills uninstall ${normedOverride}\` first.`,
        );
      }
      inFlight.add(normedOverride);
      plan.push({ hydrated: c, action: "install-new", proposedSlug: normedOverride });
      continue;
    }

    const desiredSlug = baseSlug;
    if (!taken(desiredSlug)) {
      inFlight.add(desiredSlug);
      plan.push({ hydrated: c, action: "install-new", proposedSlug: desiredSlug });
      continue;
    }

    // Collision. --skip-existing drops it; otherwise default to rename.
    if (opts.skipExisting) {
      plan.push({ hydrated: c, action: "skip", proposedSlug: desiredSlug, conflictWith: desiredSlug });
      continue;
    }
    const namespaced = norm(`${source.owner}-${baseSlug}`);
    const renamed = !taken(namespaced) ? namespaced : appendUntilFree(namespaced, taken);
    inFlight.add(renamed);
    plan.push({ hydrated: c, action: "rename", proposedSlug: renamed, conflictWith: desiredSlug });
  }
  return plan;
}

function appendUntilFree(base: string, taken: (slug: string) => boolean): string {
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Print the plan summary so the user sees what's about to happen
 * before we touch any files. Quiet when there are no collisions —
 * a flat add of new skills doesn't need ceremony.
 */
/**
 * Render the pre-flight plan, but only when there's something
 * non-trivial to surface. A flat add of new skills doesn't need a
 * summary header — the per-skill `+ slug` lines after confirm are
 * the result, and a "+ N new" summary on top is just noise.
 */
function renderAddPlan(plan: AddPlanItem[], sourceRef: string): void {
  const renames = plan.filter((p) => p.action === "rename");
  const skips = plan.filter((p) => p.action === "skip");
  const hasCollisions = renames.length > 0 || skips.length > 0;
  if (!hasCollisions) return;

  console.log("");
  console.log(chalk.bold(`Adding from ${sourceRef}:`));
  if (renames.length > 0) {
    console.log(
      chalk.yellow(
        `  ⚠ ${renames.length} ${renames.length === 1 ? "collides" : "collide"} with existing — will be renamed:`,
      ),
    );
    const widest = Math.max(...renames.map((r) => (r.conflictWith ?? "").length));
    for (const r of renames) {
      console.log(
        `      ${chalk.dim(r.conflictWith?.padEnd(widest) ?? "")} → ${r.proposedSlug}`,
      );
    }
  }
  if (skips.length > 0) {
    console.log(
      chalk.dim(
        `  ⊘ ${skips.length} skipped (already exists): ${skips.map((s) => s.conflictWith).join(", ")}`,
      ),
    );
  }
  // Hint only on the default rename path. If --skip-existing was
  // given, no hint needed (they already made a choice).
  if (renames.length > 0 && skips.length === 0) {
    console.log(
      chalk.dim(
        "  (use --skip-existing to drop collisions, or `uninstall <slug>` then add to refresh in place)",
      ),
    );
  }
}

async function confirmAddPlan(plan: AddPlanItem[], opts: AddOptions): Promise<boolean> {
  const renames = plan.some((p) => p.action === "rename");
  const needsConfirm = renames;

  if (opts.yes) return true;

  // No collisions + --yes-eligible flat add → no need to nag.
  if (!needsConfirm) return true;

  if (!process.stdin.isTTY) {
    // Non-TTY without --yes when collisions exist: refuse rather
    // than proceed with a surprising rename no one signed off on.
    throw new Error(
      [
        "Collisions detected and stdin isn't a TTY. Choose explicitly:",
        "  --yes              accept the rename plan above",
        "  --skip-existing    drop collisions, install only the new ones",
        "  uninstall + add    explicit two-step to refresh in place",
      ].join("\n"),
    );
  }

  return await confirm({ message: "Continue?", default: true });
}

function renderActionNote(item: AddPlanItem): string {
  if (item.action === "rename") {
    return chalk.yellow(` (was ${item.conflictWith} — kept alongside existing)`);
  }
  return "";
}

async function materialiseSkill(
  source: ParsedGitHubSource,
  ref: string,
  skill: HydratedSkill,
  localSlug: string,
): Promise<void> {
  const dir = join(SKILLS_STORE, localSlug);
  await mkdir(dir, { recursive: true });

  // Inject metadata.origin so the SKILL.md carries provenance forward
  // through publish + sync. Round-trips as a Notion column once
  // published (per existing metadata round-trip mechanics) so
  // teammates see "this is from <owner>/<repo>" without us inventing
  // a new schema property.
  const originRef = formatSourceRef({ ...source, ref });
  const transformed = injectOriginMetadata(skill.rawSkillMd, originRef);
  await writeFile(join(dir, "SKILL.md"), transformed, "utf8");

  // Write every sibling file at its repo-relative path. We strip the
  // `<skillDir>/` prefix so relative paths land correctly under the
  // local skill dir.
  //
  // Skip files whose extension we don't recognise as markdown or
  // source code: fetching a PDF / PNG / .docx / etc. via raw.github
  // returns the bytes as a UTF-8 string, which would corrupt the
  // file when we write back. Same classifier publish uses to
  // round-trip multi-file skills, so what we accept here matches
  // what we can later push to Notion.
  for (const sibling of skill.siblingFiles) {
    const rel =
      skill.skillDir === ""
        ? sibling.path
        : sibling.path.slice(skill.skillDir.length + 1);
    if (rel.startsWith("..") || rel.length === 0) continue;

    const cls = classifyExtension(rel);
    if (cls.kind === "unsupported") {
      console.log(
        chalk.yellow(
          `    ⚠ ${rel}: unsupported file type — skipped (binary content would corrupt on text fetch).`,
        ),
      );
      continue;
    }

    const dest = join(dir, rel);
    await mkdir(dirname(dest), { recursive: true });
    const content = await fetchFileContent(source, ref, sibling.path);
    if (content === null) {
      console.log(
        chalk.yellow(`    ⚠ ${rel}: not fetched (404). Skill may be incomplete.`),
      );
      continue;
    }
    await writeFile(dest, content, "utf8");
  }
}

/**
 * Inject `metadata.Origin = "<source ref>"` so the SKILL.md carries
 * provenance forward through publish (where it round-trips as a
 * Notion column). Delegates to the shared frontmatter helper, which
 * preserves the user's hand-authored `Origin`/`origin` if present.
 */
function injectOriginMetadata(text: string, originRef: string): string {
  return injectMetadataKey(text, "Origin", originRef);
}

async function fanoutSymlinks(localSlug: string, targetKeys: string[]): Promise<void> {
  const targets = targetsForKeys(targetKeys);
  const real = join(SKILLS_STORE, localSlug);
  for (const t of targets) {
    await ensureSymlink(real, targetSkillPath(t, localSlug));
  }
}

// ---------- audit summary ----------

interface AuditTotals {
  errors: number;
  warnings: number;
  slugsWithErrors: string[];
}

async function runAuditSummary(localSlugs: string[]): Promise<AuditTotals> {
  let any = false;
  const totals: AuditTotals = { errors: 0, warnings: 0, slugsWithErrors: [] };
  for (const slug of localSlugs) {
    const target = await loadAuditTarget(slug, join(SKILLS_STORE, slug));
    if (!target) continue;
    const issues = auditSkill(target);
    const s = summariseIssues(issues);
    totals.errors += s.errors;
    totals.warnings += s.warnings;
    if (s.errors > 0) totals.slugsWithErrors.push(slug);
    // Suppress info-only audits — most public skills lack the
    // "Use when…" trigger phrasing (a notion-skills convention,
    // not a spec requirement), so info-only would fire on every
    // import. Warnings + errors actually need attention.
    if (s.errors === 0 && s.warnings === 0) continue;
    if (!any) {
      console.log("");
      any = true;
    }
    const tag = s.errors > 0 ? chalk.red(`✗ ${slug}`) : chalk.yellow(`⚠ ${slug}`);
    const counts = [
      s.errors > 0 ? `${s.errors} ${s.errors === 1 ? "error" : "errors"}` : "",
      s.warnings > 0 ? `${s.warnings} ${s.warnings === 1 ? "warning" : "warnings"}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${tag} ${chalk.dim(`(${counts} — run \`notion-skills audit ${slug}\`)`)}`);
  }
  return totals;
}

// ---------- shared mini-helpers ----------

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3).trimEnd() + "...";
}
