import chalk from "chalk";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  NotionClient,
  type NotionPage,
  readMultiSelect,
  readNumber,
  readRichText,
  readTitle,
} from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { shouldSyncSkill } from "../filter.js";
import { fetchPageContent, slugify } from "../convert.js";
import { getScope } from "../scope.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import {
  type Manifest,
  type ManifestEntry,
  readManifest,
  writeManifest,
} from "../manifest.js";
import {
  HASH_V,
  hashBehaviorProperties,
  hashSkillContent,
} from "../page-hash.js";
import { readFile } from "node:fs/promises";

interface ListOptions {
  installed?: boolean;
  available?: boolean;
  outdated?: boolean;
  drafts?: boolean;
  tag?: string[];
  sort?: "name" | "installs";
  json?: boolean;
}

/**
 * Skill state in the unified discovery surface:
 *   - installed:  on this machine + tracked by the manifest + in the store
 *   - outdated:   installed but the store has a newer version
 *   - draft:      on this machine but not in the store yet (gen output, etc.)
 *   - available:  in the store but not on this machine
 *   - excluded:   in scope.exclude_skills (skipped from any sync)
 *   - invalid:    page in Notion is missing required fields (no title)
 */
type SkillState =
  | "installed"
  | "outdated"
  | "draft"
  | "available"
  | "excluded"
  | "invalid";

interface Row {
  name: string;
  title: string;
  description: string;
  tags: string[];
  installs: number;
  state: SkillState;
  reason?: string;
  /** Carried internally so pass 2 can run drift checks without re-querying. */
  _page?: NotionPage;
}

export async function listCommand(options: ListOptions = {}): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  await assertNtnInstalled();
  const client = new NotionClient();
  const pages = await client.queryDataSource(scope.data_source_id);

  const manifest = await readManifest(MANIFEST_FILE);
  const contentRoot = SKILLS_STORE;
  const trackedNames = new Set(
    manifest ? Object.keys(manifest.skills) : [],
  );

  const rows: Row[] = [];

  // Pass 1: rows from the Notion store (installed / outdated / available / excluded / invalid).
  for (const page of pages) {
    if (page.archived || page.in_trash) continue;
    const title = readTitle(page.properties);
    if (!title) {
      rows.push({
        name: "—",
        title: "(untitled)",
        description: "",
        tags: [],
        installs: 0,
        state: "invalid",
        reason: "no title",
      });
      continue;
    }
    const name = slugify(title);
    const description = readRichText(page.properties, "Description");
    const tags = readMultiSelect(page.properties, "Tags");
    const installs = readNumber(page.properties, "Installs");

    if (!shouldSyncSkill(name, scope.exclude_skills)) {
      rows.push({ name, title, description, tags, installs, state: "excluded", reason: "exclude_skills" });
      continue;
    }

    const inManifest = trackedNames.has(name);
    if (!inManifest) {
      rows.push({ name, title, description, tags, installs, state: "available" });
      continue;
    }

    // Installed — defer the (potentially network-bound) drift check
    // to a second pass so we can issue concurrent block fetches.
    rows.push({
      name,
      title,
      description,
      tags,
      installs,
      state: "installed",
      _page: page,
    });
  }

  // Pass 1.5: drift-check installed skills. Fast path is the common
  // case (matches when nothing changed in Notion); the slow path
  // fetches blocks per skill that failed fast path so body edits
  // surface as outdated. Side effect: caches refreshed
  // last_edited_time + body_hash on the manifest so subsequent lists
  // short-circuit on the fast path. This is a benign read-cache
  // update from a read-mostly command.
  const manifestPatches: Array<[string, Partial<ManifestEntry>]> = [];
  for (const row of rows) {
    if (row.state !== "installed" || !row._page || !manifest) continue;
    const entry = manifest.skills[row.name];
    if (!entry) continue;
    const result = await checkDrift(client, row._page, entry, manifest);
    if (result.outdated) {
      row.state = "outdated";
    } else if (
      result.refreshedLastEditedTime ||
      result.refreshedBodyHash !== undefined
    ) {
      const patch: Partial<ManifestEntry> = {};
      if (result.refreshedLastEditedTime) {
        patch.last_edited_time = result.refreshedLastEditedTime;
      }
      if (result.refreshedBodyHash !== undefined) {
        patch.body_hash = result.refreshedBodyHash;
      }
      manifestPatches.push([row.name, patch]);
    }
    delete row._page;
  }
  if (manifest && manifestPatches.length > 0) {
    const next: Manifest = {
      ...manifest,
      hash_v: HASH_V,
      skills: { ...manifest.skills },
    };
    for (const [name, patch] of manifestPatches) {
      const existing = next.skills[name];
      if (existing) next.skills[name] = { ...existing, ...patch };
    }
    try {
      await writeManifest(MANIFEST_FILE, next);
    } catch {
      // Cache update failure is non-fatal — list still renders correctly.
    }
  }

  // Pass 2: drafts — central-store entries not in the manifest and not in
  // the Notion query result. These are local-only (gen output, hand-authored
  // skills awaiting publish).
  if (existsSync(contentRoot)) {
    const knownPageNames = new Set(
      rows.map((r) => r.name).filter((n) => n !== "—"),
    );
    let entries: string[];
    try {
      entries = readdirSync(contentRoot);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dir = join(contentRoot, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (knownPageNames.has(entry)) continue;
      // Try to read description from the local SKILL.md.
      const file = join(dir, "SKILL.md");
      let description = "";
      let tags: string[] = [];
      try {
        const md = await readFile(file, "utf8");
        const fm = extractFrontmatterText(md);
        description = readFmString(fm, "description");
        tags = readFmList(fm, "tags");
      } catch {
        // ignore
      }
      rows.push({
        name: entry,
        title: entry,
        description,
        tags,
        installs: 0,
        state: "draft",
      });
    }
  }

  // Filter by --installed / --available / --outdated / --drafts.
  const stateFilter = new Set<SkillState>();
  if (options.installed) stateFilter.add("installed");
  if (options.installed) stateFilter.add("outdated"); // outdated is a sub-state of installed
  if (options.available) stateFilter.add("available");
  if (options.outdated) stateFilter.add("outdated");
  if (options.drafts) stateFilter.add("draft");
  const filtered = rows.filter((row) => {
    if (stateFilter.size > 0 && !stateFilter.has(row.state)) return false;
    if (options.tag && options.tag.length > 0) {
      const wanted = options.tag.flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
      if (wanted.length > 0 && !wanted.every((w) => row.tags.includes(w))) return false;
    }
    return true;
  });

  if (options.sort === "installs") {
    // Sorted by install count, descending — surface popular skills first.
    // Within the same count, alphabetical.
    filtered.sort((a, b) => {
      if (b.installs !== a.installs) return b.installs - a.installs;
      return a.name.localeCompare(b.name);
    });
  } else {
    // Default: group by state for readability, then alphabetical.
    const order: Record<SkillState, number> = {
      installed: 0,
      outdated: 1,
      draft: 2,
      available: 3,
      excluded: 4,
      invalid: 5,
    };
    filtered.sort((a, b) => {
      if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
      return a.name.localeCompare(b.name);
    });
  }

  if (options.json) {
    const out = filtered.map((r) => ({
      name: r.name,
      title: r.title,
      description: r.description,
      tags: r.tags,
      installs: r.installs,
      state: r.state,
      ...(r.reason ? { reason: r.reason } : {}),
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Human / agent-friendly text output.
  const isFiltered =
    options.installed ||
    options.available ||
    options.outdated ||
    options.drafts ||
    (options.tag && options.tag.length > 0);
  console.log(chalk.bold(`\n${scope.database_title ?? scope.database_id}`));
  if (isFiltered) {
    if (filtered.length === 0) {
      console.log(chalk.dim(`No skills match the filter.`));
      console.log("");
      return;
    }
    console.log(
      chalk.dim(
        `${filtered.length} of ${rows.length} ${rows.length === 1 ? "skill" : "skills"} match.`,
      ),
    );
  } else {
    console.log(chalk.dim(`${rows.length} ${rows.length === 1 ? "skill" : "skills"} total`));
  }
  console.log("");

  // Tabular layout: a header row followed by columns aligned by
  // padding. State marker (1 char) sits in the gutter so the visual
  // column boundary matches the header. Description is capped so wide
  // terminals don't sprawl into unreadable lines.
  const DESC_CAP = 70;
  const INSTALLS_HEADER = "INSTALLS";
  const installsWidth = INSTALLS_HEADER.length;
  const maxName = Math.max(
    "NAME".length,
    ...filtered.map((r) => r.name.length),
  );
  const namePad = Math.min(40, Math.max(maxName, 12));
  const cols = process.stdout.columns ?? 120;
  // 2 (indent) + 2 (marker + space) + namePad + 2 (gap) + installsWidth + 2 (gap)
  const fixedPrefix = 2 + 2 + namePad + 2 + installsWidth + 2;
  const descBudget = Math.max(20, Math.min(DESC_CAP, cols - fixedPrefix - 4));

  const header =
    "  " +
    "  " +
    "NAME".padEnd(namePad) +
    "  " +
    INSTALLS_HEADER.padStart(installsWidth) +
    "  " +
    "DESCRIPTION";
  console.log(chalk.dim(header));

  for (const row of filtered) {
    const mark = stateMarker(row.state);
    const namePadded = row.name.padEnd(namePad);
    const installsCell =
      row.installs > 0
        ? chalk.cyan(String(row.installs).padStart(installsWidth))
        : " ".repeat(installsWidth);
    const desc = truncate(oneLine(row.description), descBudget);
    const tagText =
      row.tags.length > 0 ? chalk.dim(` [${row.tags.join(", ")}]`) : "";
    const reason = row.reason ? chalk.dim(` (${row.reason})`) : "";
    console.log(
      `  ${mark} ${namePadded}  ${installsCell}  ${chalk.dim(desc)}${tagText}${reason}`,
    );
  }

  // Summary line.
  const counts = filtered.reduce(
    (acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }),
    {} as Record<SkillState, number>,
  );
  console.log("");
  const parts: string[] = [];
  if (counts.installed) parts.push(`${counts.installed} installed`);
  if (counts.outdated) parts.push(`${counts.outdated} outdated`);
  if (counts.draft) parts.push(`${counts.draft} ${counts.draft === 1 ? "draft" : "drafts"}`);
  if (counts.available) parts.push(`${counts.available} available`);
  if (counts.excluded) parts.push(`${counts.excluded} excluded`);
  if (counts.invalid) parts.push(`${counts.invalid} invalid`);
  console.log(chalk.dim(`  ${parts.join(" · ") || "no skills"}`));
  console.log("");
}

function stateMarker(state: SkillState): string {
  switch (state) {
    case "installed": return chalk.green("✓");
    case "outdated": return chalk.cyan("↑");
    case "draft": return chalk.yellow("✎");
    case "available": return chalk.dim("·");
    case "excluded": return chalk.red("✗");
    case "invalid": return chalk.yellow("!");
  }
}

interface DriftResult {
  outdated: boolean;
  /** Updated cache values to record on the manifest entry when no drift. */
  refreshedLastEditedTime?: string;
  refreshedBodyHash?: string;
}

/**
 * Two-phase drift detection.
 *
 *   1. Fast path: if `last_edited_time` matches what we last cached, the
 *      page hasn't been touched since — definitely not outdated.
 *   2. Slow path: behavior props differ → outdated. Else fetch blocks
 *      and compare body hashes; differ → outdated. Match → refresh the
 *      cache so the next list takes the fast path.
 *
 * Manifests written before HASH_V=2 carry `props_hash` values that aren't
 * comparable to the current scheme (they included Tags / used different
 * keys). We treat those as "not outdated" until the next sync rebases.
 */
async function checkDrift(
  client: NotionClient,
  page: NotionPage,
  entry: ManifestEntry,
  manifest: Manifest,
): Promise<DriftResult> {
  if ((manifest.hash_v ?? 1) < HASH_V) {
    return { outdated: false };
  }
  // Single-file skills can use the fast path: parent's last_edited_time
  // is the authoritative drift signal because there are no children to
  // edit. Multi-file skills MUST take the slow path — Notion doesn't
  // bump the parent's last_edited_time when only a child page is
  // edited, so the fast path would silently miss those changes.
  const isMultiFile = (entry.files?.length ?? 0) > 0;
  if (!isMultiFile && page.last_edited_time === entry.last_edited_time) {
    return { outdated: false };
  }
  const currentPropsHash = hashBehaviorProperties(page);
  if (currentPropsHash !== entry.props_hash) {
    return { outdated: true };
  }
  // Props match but last_edited_time differs — could be a metadata-only
  // edit (Installs, Tags), a parent body edit, or an edit to one of
  // the sibling-file child pages. Fetch the full content so we can
  // hash everything together and compare.
  let body: string;
  let files: import("../skill-files.js").SkillFile[];
  try {
    const result = await fetchPageContent(client, page);
    body = result.body;
    files = result.files;
  } catch {
    // Fetch failed — be conservative: don't flag drift, don't cache.
    return { outdated: false };
  }
  const currentBodyHash = hashSkillContent(body, files);
  if (entry.body_hash !== undefined && currentBodyHash !== entry.body_hash) {
    return { outdated: true };
  }
  return {
    outdated: false,
    refreshedLastEditedTime: page.last_edited_time,
    refreshedBodyHash: currentBodyHash,
  };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3).trimEnd() + "...";
}

// Minimal frontmatter parsing for draft preview. Skill format already has
// helpers in migrate.ts but we don't want to pull all that in for a list
// command. Cheap-and-cheerful here.
function extractFrontmatterText(md: string): string {
  const match = md.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] ?? "" : "";
}

function readFmString(fm: string, key: string): string {
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m");
  const m = fm.match(re);
  if (!m || !m[1]) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function readFmList(fm: string, key: string): string[] {
  // Try the block form first — `key:` on its own line followed by
  // indented `- value` lines. The previous "inline first" approach
  // missed this case because the inline regex requires content after
  // the colon, and YAML's block-list form has nothing after the colon.
  const blockRe = new RegExp(
    `^${key}\\s*:\\s*\\r?\\n((?:[ \\t]+-\\s+.+\\r?\\n?)+)`,
    "m",
  );
  const block = fm.match(blockRe);
  if (block && block[1]) {
    return block[1]
      .split("\n")
      .map((line) => line.replace(/^[ \t]+-\s+/, "").trim())
      .filter(Boolean);
  }

  // Fall back to inline forms: `key: [a, b]`, `key: a, b`, `key: x`.
  const inline = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m");
  const m = fm.match(inline);
  if (!m || m[1] === undefined) return [];
  const value = m[1].trim();
  if (value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (value.startsWith("-")) return [];
  return value.split(/\s*,\s*/).filter(Boolean);
}
