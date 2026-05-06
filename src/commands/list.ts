import chalk from "chalk";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  NotionClient,
  type NotionPage,
  readCheckbox,
  readMultiSelect,
  readNumber,
  readRichText,
  readTitle,
} from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
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
import { applyRenames, detectRenames } from "../renames.js";
import { readFile } from "node:fs/promises";
import { type Source, defaultSource, findByKey } from "../sources.js";
import { pickSource } from "./_resolve.js";

interface ListOptions {
  installed?: boolean;
  available?: boolean;
  outdated?: boolean;
  drafts?: boolean;
  tag?: string[];
  source?: string;
  sort?: "name" | "popular" | "installs";
  json?: boolean;
}

type SkillState =
  | "installed"
  | "outdated"
  | "draft"
  | "available"
  | "invalid";

interface Row {
  /** local_slug for installed/draft, source_slug for available. */
  name: string;
  source_key: string | null; // null = local-only draft
  title: string;
  description: string;
  tags: string[];
  installs: number;
  state: SkillState;
  reason?: string;
  createdTime: string;
  _page?: NotionPage;
}

type SortKey = "name" | "popular" | "new";

function normalizeSortKey(raw?: string): SortKey {
  if (!raw) return "name";
  const lower = raw.toLowerCase();
  if (lower === "name" || lower === "alphabetical" || lower === "alpha") return "name";
  if (lower === "popular" || lower === "installs" || lower === "downloads") return "popular";
  if (lower === "new" || lower === "latest" || lower === "recent") return "new";
  throw new Error(
    `Unknown --sort value "${raw}". Options: name (alphabetical), popular (by install count), new (most recently created).`,
  );
}

export async function listCommand(options: ListOptions = {}): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  await assertNtnInstalled();
  const client = new NotionClient();

  // Tag/source filter scopes the source set we query. Otherwise we
  // query every configured source for a cross-source view.
  const targetSources: Source[] = options.source || options.tag
    ? [await pickSource(options.source, scope)]
    : scope.sources;

  const defaultKey =
    defaultSource(scope.sources)?.key ?? scope.sources[0]?.key ?? "default";
  const manifest = await readManifest(MANIFEST_FILE, defaultKey);
  const contentRoot = SKILLS_STORE;

  // Apply rename detection per-source: a Notion-side title change
  // updates entry.source_slug in-place. local_slug never moves.
  if (manifest) {
    let touched = false;
    for (const source of targetSources) {
      const pages = await getOrFetchPages(client, source);
      const ops = detectRenames(manifest, source.key, pages);
      if (ops.length > 0) {
        applyRenames(manifest, ops);
        touched = true;
        for (const op of ops) {
          console.log(
            chalk.cyan(
              `↪ ${op.oldSourceSlug} → ${op.newSourceSlug} ${chalk.dim(`(${source.key}; local '${op.localSlug}' stays)`)}`,
            ),
          );
        }
      }
    }
    if (touched) {
      try {
        await writeManifest(MANIFEST_FILE, manifest);
      } catch {
        // best-effort cache update
      }
    }
  }

  // Build a quick lookup for installed entries: (source_key, source_slug)
  // → local_slug + entry.
  const installedLookup = new Map<string, { localSlug: string; entry: ManifestEntry }>();
  if (manifest) {
    for (const [localSlug, entry] of Object.entries(manifest.skills)) {
      installedLookup.set(`${entry.source_key}/${entry.source_slug}`, { localSlug, entry });
    }
  }

  const rows: Row[] = [];

  // Pass 1: rows from each source's data source.
  for (const source of targetSources) {
    const pages = await getOrFetchPages(client, source);
    const publishedColumnExists = pages.some(
      (p) => p.properties.Published !== undefined,
    );
    for (const page of pages) {
      if (page.archived || page.in_trash) continue;
      const title = readTitle(page.properties);
      if (!title) {
        rows.push({
          name: "—",
          source_key: source.key,
          title: "(untitled)",
          description: "",
          tags: [],
          installs: 0,
          state: "invalid",
          reason: "no title",
          createdTime: page.created_time,
        });
        continue;
      }
      const sourceSlug = slugify(title);
      const description = readRichText(page.properties, "Description");
      const tags = readMultiSelect(page.properties, "Tags");
      const installs = readNumber(page.properties, "Installs");
      const isDraft =
        publishedColumnExists && !readCheckbox(page.properties, "Published");

      const installed = installedLookup.get(`${source.key}/${sourceSlug}`);
      if (!installed) {
        rows.push({
          name: sourceSlug,
          source_key: source.key,
          title,
          description,
          tags,
          installs,
          state: isDraft ? "draft" : "available",
          createdTime: page.created_time,
        });
        continue;
      }
      rows.push({
        name: installed.localSlug,
        source_key: source.key,
        title,
        description,
        tags,
        installs,
        state: "installed",
        _page: page,
        createdTime: page.created_time,
      });
    }
  }

  // Pass 1.5: drift-check installed rows.
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
      if (result.refreshedLastEditedTime) patch.last_edited_time = result.refreshedLastEditedTime;
      if (result.refreshedBodyHash !== undefined) patch.body_hash = result.refreshedBodyHash;
      manifestPatches.push([row.name, patch]);
    }
    delete row._page;
  }
  if (manifest && manifestPatches.length > 0) {
    const next: Manifest = { ...manifest, hash_v: HASH_V, skills: { ...manifest.skills } };
    for (const [localSlug, patch] of manifestPatches) {
      const existing = next.skills[localSlug];
      if (existing) next.skills[localSlug] = { ...existing, ...patch };
    }
    try {
      await writeManifest(MANIFEST_FILE, next);
    } catch {
      // best-effort
    }
  }

  // Pass 2: drafts — central-store dirs not represented anywhere above.
  // Local-only drafts have source_key = null; their installed cousins
  // appeared in pass 1 already.
  if (existsSync(contentRoot)) {
    const knownLocalSlugs = new Set(rows.map((r) => r.name).filter((n) => n !== "—"));
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
      if (knownLocalSlugs.has(entry)) continue;
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
      // If a manifest entry exists for this dir but its source isn't in
      // our query window (e.g. user filtered to one source), it counts
      // as an installed-elsewhere row; otherwise it's a local draft.
      const manifestEntry = manifest?.skills[entry];
      rows.push({
        name: entry,
        source_key: manifestEntry?.source_key ?? null,
        title: entry,
        description,
        tags,
        installs: 0,
        createdTime: "",
        state: manifestEntry ? "installed" : "draft",
      });
    }
  }

  // Filter by --installed / --available / --outdated / --drafts.
  const stateFilter = new Set<SkillState>();
  if (options.installed) stateFilter.add("installed");
  if (options.installed) stateFilter.add("outdated");
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

  const sortKey = normalizeSortKey(options.sort);
  if (sortKey === "popular") {
    filtered.sort((a, b) => {
      if (b.installs !== a.installs) return b.installs - a.installs;
      return a.name.localeCompare(b.name);
    });
  } else if (sortKey === "new") {
    filtered.sort((a, b) => {
      if (a.createdTime !== b.createdTime) return b.createdTime.localeCompare(a.createdTime);
      return a.name.localeCompare(b.name);
    });
  } else {
    const order: Record<SkillState, number> = {
      installed: 0,
      outdated: 1,
      draft: 2,
      available: 3,
      invalid: 4,
    };
    filtered.sort((a, b) => {
      if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
      return a.name.localeCompare(b.name);
    });
  }

  if (options.json) {
    const out = filtered.map((r) => ({
      name: r.name,
      source: r.source_key,
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

  // Header.
  const isFiltered =
    options.installed ||
    options.available ||
    options.outdated ||
    options.drafts ||
    options.source ||
    (options.tag && options.tag.length > 0);
  const headerLabel =
    scope.sources.length === 1
      ? scope.sources[0]!.name
      : targetSources.length === 1
        ? `${targetSources[0]!.name} ${chalk.dim(`(--source ${targetSources[0]!.key})`)}`
        : `${scope.sources.length} sources`;
  console.log(chalk.bold(`\n${headerLabel}`));
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

  const showSourceColumn = scope.sources.length > 1;
  const DESC_CAP = 70;
  const INSTALLS_HEADER = "INSTALLS";
  const installsWidth = INSTALLS_HEADER.length;
  const SOURCE_HEADER = "SOURCE";
  const sourceWidth = showSourceColumn
    ? Math.max(SOURCE_HEADER.length, ...scope.sources.map((s) => s.key.length))
    : 0;
  const maxName = Math.max("NAME".length, ...filtered.map((r) => r.name.length));
  const namePad = Math.min(40, Math.max(maxName, 12));
  const cols = process.stdout.columns ?? 120;
  const fixedPrefix =
    2 + 2 + namePad + 2 + (showSourceColumn ? sourceWidth + 2 : 0) + installsWidth + 2;
  const descBudget = Math.max(20, Math.min(DESC_CAP, cols - fixedPrefix - 4));

  let header = "  " + "  " + "NAME".padEnd(namePad);
  if (showSourceColumn) header += "  " + SOURCE_HEADER.padEnd(sourceWidth);
  header += "  " + INSTALLS_HEADER.padStart(installsWidth) + "  " + "DESCRIPTION";
  console.log(chalk.dim(header));

  for (const row of filtered) {
    const mark = stateMarker(row.state);
    const namePadded = row.name.padEnd(namePad);
    const sourceCell = showSourceColumn
      ? "  " + chalk.dim((row.source_key ?? "—").padEnd(sourceWidth))
      : "";
    const installsCell =
      row.installs > 0
        ? chalk.cyan(String(row.installs).padStart(installsWidth))
        : " ".repeat(installsWidth);
    const desc = truncate(oneLine(row.description), descBudget);
    const tagText = row.tags.length > 0 ? chalk.dim(` [${row.tags.join(", ")}]`) : "";
    const reason = row.reason ? chalk.dim(` (${row.reason})`) : "";
    console.log(
      `  ${mark} ${namePadded}${sourceCell}  ${installsCell}  ${chalk.dim(desc)}${tagText}${reason}`,
    );
  }

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
  if (counts.invalid) parts.push(`${counts.invalid} invalid`);
  console.log(chalk.dim(`  ${parts.join(" · ") || "no skills"}`));
  console.log("");
  // Avoid unused-import noise.
  void findByKey;
}

// Per-list page cache so the rename pass and pass 1 share fetched pages.
const pageCache = new WeakMap<Source, NotionPage[]>();
async function getOrFetchPages(client: NotionClient, source: Source): Promise<NotionPage[]> {
  const cached = pageCache.get(source);
  if (cached) return cached;
  const pages = await client.queryDataSource(source.data_source_id);
  pageCache.set(source, pages);
  return pages;
}

function stateMarker(state: SkillState): string {
  switch (state) {
    case "installed": return chalk.green("✓");
    case "outdated": return chalk.cyan("↑");
    case "draft": return chalk.yellow("✎");
    case "available": return chalk.dim("·");
    case "invalid": return chalk.yellow("!");
  }
}

interface DriftResult {
  outdated: boolean;
  refreshedLastEditedTime?: string;
  refreshedBodyHash?: string;
}

async function checkDrift(
  client: NotionClient,
  page: NotionPage,
  entry: ManifestEntry,
  manifest: Manifest,
): Promise<DriftResult> {
  if ((manifest.hash_v ?? 1) < HASH_V) return { outdated: false };
  const isMultiFile = (entry.files?.length ?? 0) > 0;
  if (!isMultiFile && page.last_edited_time === entry.last_edited_time) {
    return { outdated: false };
  }
  const currentPropsHash = hashBehaviorProperties(page);
  if (currentPropsHash !== entry.props_hash) return { outdated: true };
  let body: string;
  let files: import("../skill-files.js").SkillFile[];
  try {
    const result = await fetchPageContent(client, page);
    body = result.body;
    files = result.files;
  } catch {
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
