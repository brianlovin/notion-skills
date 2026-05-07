import chalk from "chalk";
import { lstatSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkbox } from "@inquirer/prompts";
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
import { parse as parseYaml } from "yaml";

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

  // Resolve the ref. If the user pinned, honour it; otherwise ask
  // GitHub for the repo's default branch — we record an explicit ref
  // in metadata.origin so future updates know what to re-fetch.
  const ref = source.ref ?? (await resolveDefaultBranch(source));
  if (!ref) {
    throw new Error(
      `Couldn't reach ${source.owner}/${source.repo}. Check the spelling, or set GITHUB_TOKEN if it's private.`,
    );
  }

  console.log(
    chalk.dim(
      `Fetching ${formatSourceRef({ ...source, ref })}${chalk.dim(" …")}`,
    ),
  );
  const tree = await fetchRepoTree(source, ref);
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

  // Apply CLI/source filters.
  const skillNames = collectSkillFilter(opts, source);
  const filtered = filterByName(candidates, skillNames);

  if (filtered.length === 0) {
    const known = candidates.map((c) => c.skillName).join(", ");
    throw new Error(
      `No matches for ${skillNames.join(", ")}. Available: ${known}`,
    );
  }

  // Hydrate metadata (parse SKILL.md to get name + description) so
  // preview/picker have something useful to show.
  const hydrated = await hydrateCandidates(source, ref, filtered);

  if (opts.preview) {
    await renderPreview(hydrated, source, ref);
    return;
  }

  const picked = await pickSkillsForAdd(hydrated, opts);
  if (picked.length === 0) {
    console.log(chalk.dim("Nothing to add."));
    return;
  }
  if (picked.length > 1 && opts.as) {
    throw new Error("--as only applies when adding exactly one skill.");
  }

  console.log(
    chalk.bold(
      `\nAdding ${picked.length} ${picked.length === 1 ? "skill" : "skills"}:`,
    ),
  );

  const defaultKey =
    defaultSource(scope.sources)?.key ?? scope.sources[0]?.key ?? "default";
  const manifest = await readManifest(MANIFEST_FILE, defaultKey);

  const addedSlugs: string[] = [];
  // Track in-flight slugs so two adds in the same batch can't claim
  // the same name (would write into each other's dir otherwise).
  const inFlight = new Set<string>();
  for (const c of picked) {
    const baseSlug = (c.frontmatterName ?? c.skillName).toLowerCase();
    const { slug, namespaced } = pickAddSlug(
      source.owner,
      baseSlug,
      manifest,
      inFlight,
      picked.length === 1 ? opts.as : undefined,
    );
    inFlight.add(slug);
    await materialiseSkill(source, ref, c, slug);
    await fanoutSymlinks(slug, scope.targets);
    addedSlugs.push(slug);
    const note = namespaced
      ? chalk.yellow(` (collided; added as '${slug}')`)
      : chalk.dim(` (from ${formatSourceRef({ ...source, ref })})`);
    console.log(`  ${chalk.green("+")} ${slug}${note}`);
  }

  // Audit each added draft and surface counts inline. Errors don't
  // block — the draft is on disk and re-runnable; we just inform.
  await runAuditSummary(addedSlugs);

  if (opts.publish) {
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

function filterByName(candidates: SkillCandidate[], wanted: string[]): SkillCandidate[] {
  if (wanted.length === 0) return candidates;
  const wantedLower = wanted.map((s) => s.toLowerCase());
  return candidates.filter((c) =>
    wantedLower.some(
      (w) => w === "*" || w === c.skillName.toLowerCase() || w === c.skillDir.toLowerCase(),
    ),
  );
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
  const out: HydratedSkill[] = [];
  for (const c of candidates) {
    const raw = await fetchFileContent(source, ref, c.skillMdPath);
    if (raw === null) continue;
    const fm = readFrontmatter(raw);
    out.push({
      ...c,
      frontmatterName: typeof fm["name"] === "string" ? fm["name"] : null,
      description: typeof fm["description"] === "string" ? fm["description"] : null,
      rawSkillMd: raw,
    });
  }
  return out;
}

function readFrontmatter(text: string): Record<string, unknown> {
  const stripped = text.replace(/^﻿/, "");
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1] ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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

async function pickSkillsForAdd(skills: HydratedSkill[], opts: AddOptions): Promise<HydratedSkill[]> {
  if (skills.length === 1) return skills;
  if (opts.yes) return skills; // bulk-confirm = "all"
  if (!process.stdin.isTTY) return skills;

  const choices = skills.map((s) => ({
    name: `${s.frontmatterName ?? s.skillName}${s.description ? chalk.dim(` — ${truncate(oneLine(s.description), 70)}`) : ""}`,
    value: s,
    checked: true,
  }));
  return (await checkbox({
    message: `Pick which skills to add (${skills.length} found):`,
    choices,
    pageSize: Math.min(20, choices.length + 2),
  })) as HydratedSkill[];
}

// ---------- materialise ----------

/**
 * Pick the local_slug for a skill being added. Mirrors the
 * collision-then-namespace pattern of `chooseLocalSlug` (used by
 * install) but with the GitHub owner as the prefix instead of the
 * Notion source key, since that's what carries the most provenance
 * signal for an imported skill. Override always wins.
 *
 * Collision targets:
 *   - manifest entries (already-installed skills)
 *   - on-disk dirs in the central store (drafts)
 *   - in-flight slugs (other skills being added in this same batch)
 */
function pickAddSlug(
  owner: string,
  baseSlug: string,
  manifest: import("../manifest.js").Manifest | null,
  inFlight: Set<string>,
  override: string | undefined,
): { slug: string; namespaced: boolean } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
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
  if (override) {
    if (taken(override)) {
      // Even the override collides — fall through to numeric suffix.
      return { slug: appendUntilFree(override, taken), namespaced: false };
    }
    return { slug: override, namespaced: false };
  }
  const candidate = norm(baseSlug);
  if (!taken(candidate)) return { slug: candidate, namespaced: false };
  const namespaced = norm(`${owner}-${baseSlug}`);
  if (!taken(namespaced)) return { slug: namespaced, namespaced: true };
  return { slug: appendUntilFree(namespaced, taken), namespaced: true };
}

function appendUntilFree(base: string, taken: (slug: string) => boolean): string {
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
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
  for (const sibling of skill.siblingFiles) {
    const rel =
      skill.skillDir === ""
        ? sibling.path
        : sibling.path.slice(skill.skillDir.length + 1);
    if (rel.startsWith("..") || rel.length === 0) continue;
    const dest = join(dir, rel);
    await mkdir(dirname(dest), { recursive: true });
    const content = await fetchFileContent(source, ref, sibling.path);
    if (content === null) continue;
    await writeFile(dest, content, "utf8");
  }
}

/**
 * Patch the SKILL.md frontmatter to record `metadata.origin = "<source ref>"`.
 * If the user-authored frontmatter already has a `metadata.origin`,
 * we leave it alone — they're presumably adapting an upstream skill
 * and want their own provenance to win.
 */
function injectOriginMetadata(text: string, originRef: string): string {
  const stripped = text.replace(/^﻿/, "");
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter at all — synthesise the bare minimum. This path
    // is rare; agents that author skills without frontmatter are
    // already broken at the spec level.
    return `---\nmetadata:\n  origin: ${JSON.stringify(originRef)}\n---\n\n${stripped}`;
  }
  const [, fmText, body] = match;
  if (/(^|\n)metadata:[\s\S]*?\n\s+origin:/.test(fmText ?? "")) {
    return text;
  }
  // Two cases:
  //   - metadata block exists but no origin: append `  origin: ...` under it.
  //   - no metadata block: append a new `metadata:` block.
  let nextFm: string;
  if (/(^|\n)metadata:\s*\n/.test(fmText ?? "")) {
    nextFm = (fmText ?? "").replace(
      /(^|\n)(metadata:\s*\n)/,
      `$1$2  origin: ${JSON.stringify(originRef)}\n`,
    );
  } else {
    nextFm = `${(fmText ?? "").replace(/\s+$/, "")}\nmetadata:\n  origin: ${JSON.stringify(originRef)}`;
  }
  return `---\n${nextFm}\n---\n${body ?? ""}`;
}

async function fanoutSymlinks(localSlug: string, targetKeys: string[]): Promise<void> {
  const targets = targetsForKeys(targetKeys);
  const real = join(SKILLS_STORE, localSlug);
  for (const t of targets) {
    await ensureSymlink(real, targetSkillPath(t, localSlug));
  }
}

// ---------- audit summary ----------

async function runAuditSummary(localSlugs: string[]): Promise<void> {
  let any = false;
  for (const slug of localSlugs) {
    const target = await loadAuditTarget(slug, join(SKILLS_STORE, slug));
    if (!target) continue;
    const issues = auditSkill(target);
    if (issues.length === 0) continue;
    if (!any) {
      console.log("");
      any = true;
    }
    const s = summariseIssues(issues);
    const tag =
      s.errors > 0
        ? chalk.red(`✗ ${slug}`)
        : s.warnings > 0
          ? chalk.yellow(`⚠ ${slug}`)
          : chalk.cyan(`ℹ ${slug}`);
    const detail = `${issues.length} audit ${issues.length === 1 ? "issue" : "issues"} — run \`notion-skills audit ${slug}\``;
    console.log(`  ${tag} ${chalk.dim(`(${detail})`)}`);
  }
}

// ---------- shared mini-helpers ----------

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3).trimEnd() + "...";
}
