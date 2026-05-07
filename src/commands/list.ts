import chalk from "chalk";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
import { getScope, type Scope } from "../scope.js";
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
import { type Source, defaultSource } from "../sources.js";
import { pickSource } from "./_resolve.js";
import { readFrontmatterList, readFrontmatterString } from "../frontmatter.js";

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

type SkillState = "installed" | "outdated" | "draft" | "available" | "invalid";

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

/**
 * Top-level orchestrator. Each phase is a named helper below; the runner
 * just sequences them. Goal is "readable as a recipe" — if a phase needs
 * tweaking, it's obvious where to look.
 */
export async function listCommand(options: ListOptions = {}): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  await assertNtnInstalled();
  const client = new NotionClient();

  const sources = await resolveTargetSources(options, scope);
  const manifest = await loadManifest(scope);
  const pageCache = new Map<string, NotionPage[]>();

  await applyRenameDetection(client, scope, sources, manifest, pageCache);

  const rows = await buildRowsFromSources(client, sources, manifest, pageCache);

  await runDriftChecks(client, rows, manifest);

  if (!options.source) {
    await appendLocalDrafts(rows, manifest);
  }

  const filtered = applyFiltersAndSort(rows, options);

  if (options.json) {
    renderJson(filtered);
    return;
  }
  renderTable(filtered, rows, scope, sources, options);
}

// ---------- phase 1: target-source resolution ----------

async function resolveTargetSources(opts: ListOptions, scope: Scope): Promise<Source[]> {
  // --source narrows to one explicitly. --tag is source-scoped (each
  // Notion DB has its own tag set with its own semantics) so it falls
  // back to the standard picker too. Otherwise: cross-source view.
  if (opts.source || opts.tag) {
    return [await pickSource(opts.source, scope)];
  }
  return scope.sources;
}

async function loadManifest(scope: Scope): Promise<Manifest | null> {
  const defaultKey =
    defaultSource(scope.sources)?.key ?? scope.sources[0]?.key ?? "default";
  return readManifest(MANIFEST_FILE, defaultKey);
}

// ---------- phase 2: rename detection (mutates manifest in place) ----------

async function applyRenameDetection(
  client: NotionClient,
  scope: Scope,
  sources: Source[],
  manifest: Manifest | null,
  pageCache: Map<string, NotionPage[]>,
): Promise<void> {
  if (!manifest) return;
  let touched = false;
  for (const source of sources) {
    const pages = await fetchPagesCached(client, source, pageCache);
    const ops = detectRenames(manifest, source.key, pages);
    if (ops.length === 0) continue;
    const outcomes = await applyRenames(manifest, ops, SKILLS_STORE, scope.targets);
    touched = true;
    for (const outcome of outcomes) {
      if (outcome.status === "renamed") {
        const sameLocalName = outcome.newLocalSlug === outcome.op.localSlug;
        const sourceChanged = outcome.op.oldSourceSlug !== outcome.op.newSourceSlug;
        let line: string;
        if (sourceChanged && !sameLocalName) {
          line = `↪ ${outcome.op.oldSourceSlug} → ${outcome.op.newSourceSlug} ${chalk.dim(`(${source.key})`)}` +
            chalk.dim(` (local: ${outcome.op.localSlug} → ${outcome.newLocalSlug})`);
        } else if (!sourceChanged && !sameLocalName) {
          line = `↪ local: ${outcome.op.localSlug} → ${outcome.newLocalSlug} ${chalk.dim(`(${source.key}; catching up)`)}`;
        } else {
          line = `↪ ${outcome.op.oldSourceSlug} → ${outcome.op.newSourceSlug} ${chalk.dim(`(${source.key})`)}`;
        }
        console.log(chalk.cyan(line));
      } else {
        const reason =
          outcome.reason.kind === "collision-manifest"
            ? `local slug "${outcome.reason.conflictWith}" already in use`
            : `local dir "${outcome.reason.path}" already exists`;
        console.log(
          chalk.yellow(
            `⚠ ${outcome.op.oldSourceSlug} → ${outcome.op.newSourceSlug} (${source.key}): ${reason}. Local '${outcome.op.localSlug}' stays.`,
          ),
        );
      }
    }
  }
  if (!touched) return;
  try {
    await writeManifest(MANIFEST_FILE, manifest);
  } catch {
    // best-effort
  }
}

// ---------- phase 3: build rows from each source's pages ----------

async function buildRowsFromSources(
  client: NotionClient,
  sources: Source[],
  manifest: Manifest | null,
  pageCache: Map<string, NotionPage[]>,
): Promise<Row[]> {
  const installedLookup = buildInstalledLookup(manifest);
  const rows: Row[] = [];
  for (const source of sources) {
    const pages = await fetchPagesCached(client, source, pageCache);
    const publishedColumnExists = pages.some(
      (p) => p.properties.Published !== undefined,
    );
    for (const page of pages) {
      if (page.archived || page.in_trash) continue;
      const row = pageToRow(page, source, installedLookup, publishedColumnExists);
      rows.push(row);
    }
  }
  return rows;
}

function buildInstalledLookup(
  manifest: Manifest | null,
): Map<string, { localSlug: string; entry: ManifestEntry }> {
  const lookup = new Map<string, { localSlug: string; entry: ManifestEntry }>();
  if (!manifest) return lookup;
  for (const [localSlug, entry] of Object.entries(manifest.skills)) {
    lookup.set(`${entry.source_key}/${entry.source_slug}`, { localSlug, entry });
  }
  return lookup;
}

function pageToRow(
  page: NotionPage,
  source: Source,
  installedLookup: Map<string, { localSlug: string; entry: ManifestEntry }>,
  publishedColumnExists: boolean,
): Row {
  const title = readTitle(page.properties);
  if (!title) {
    return {
      name: "—",
      source_key: source.key,
      title: "(untitled)",
      description: "",
      tags: [],
      installs: 0,
      state: "invalid",
      reason: "no title",
      createdTime: page.created_time,
    };
  }
  const sourceSlug = slugify(title);
  const description = readRichText(page.properties, "Description");
  const tags = readMultiSelect(page.properties, "Tags");
  const installs = readNumber(page.properties, "Installs");
  const isDraft =
    publishedColumnExists && !readCheckbox(page.properties, "Published");

  const installed = installedLookup.get(`${source.key}/${sourceSlug}`);
  if (!installed) {
    return {
      name: sourceSlug,
      source_key: source.key,
      title,
      description,
      tags,
      installs,
      state: isDraft ? "draft" : "available",
      createdTime: page.created_time,
    };
  }
  return {
    name: installed.localSlug,
    source_key: source.key,
    title,
    description,
    tags,
    installs,
    state: "installed",
    _page: page,
    createdTime: page.created_time,
  };
}

// ---------- phase 4: drift check (turns "installed" into "outdated") ----------

async function runDriftChecks(
  client: NotionClient,
  rows: Row[],
  manifest: Manifest | null,
): Promise<void> {
  if (!manifest) return;
  const patches: Array<[string, Partial<ManifestEntry>]> = [];
  for (const row of rows) {
    if (row.state !== "installed" || !row._page) continue;
    const entry = manifest.skills[row.name];
    if (!entry) continue;
    const result = await checkDrift(client, row._page, entry, manifest);
    if (result.outdated) {
      row.state = "outdated";
    } else if (result.refreshedLastEditedTime || result.refreshedBodyHash !== undefined) {
      const patch: Partial<ManifestEntry> = {};
      if (result.refreshedLastEditedTime) patch.last_edited_time = result.refreshedLastEditedTime;
      if (result.refreshedBodyHash !== undefined) patch.body_hash = result.refreshedBodyHash;
      patches.push([row.name, patch]);
    }
    delete row._page;
  }
  if (patches.length === 0) return;
  // Persist refreshed cache so the next list takes the fast path.
  const next: Manifest = { ...manifest, hash_v: HASH_V, skills: { ...manifest.skills } };
  for (const [localSlug, patch] of patches) {
    const existing = next.skills[localSlug];
    if (existing) next.skills[localSlug] = { ...existing, ...patch };
  }
  try {
    await writeManifest(MANIFEST_FILE, next);
  } catch {
    // best-effort
  }
}

// ---------- phase 5: append local drafts (off-source skill dirs) ----------

async function appendLocalDrafts(rows: Row[], manifest: Manifest | null): Promise<void> {
  const contentRoot = SKILLS_STORE;
  if (!existsSync(contentRoot)) return;
  const knownLocalSlugs = new Set(rows.map((r) => r.name).filter((n) => n !== "—"));
  let entries: string[];
  try {
    entries = readdirSync(contentRoot);
  } catch {
    return;
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
    const draft = await loadDraftRow(entry, dir, manifest);
    rows.push(draft);
  }
}

async function loadDraftRow(
  localSlug: string,
  dir: string,
  manifest: Manifest | null,
): Promise<Row> {
  const file = join(dir, "SKILL.md");
  let description = "";
  let tags: string[] = [];
  try {
    const md = await readFile(file, "utf8");
    description = readFrontmatterString(md, "description");
    tags = readFrontmatterList(md, "tags");
  } catch {
    // ignore — a draft without a SKILL.md is still a valid row
  }
  const manifestEntry = manifest?.skills[localSlug];
  return {
    name: localSlug,
    source_key: manifestEntry?.source_key ?? null,
    title: localSlug,
    description,
    tags,
    installs: 0,
    createdTime: "",
    state: manifestEntry ? "installed" : "draft",
  };
}

// ---------- phase 6: filter + sort ----------

function applyFiltersAndSort(rows: Row[], opts: ListOptions): Row[] {
  const stateFilter = new Set<SkillState>();
  if (opts.installed) {
    stateFilter.add("installed");
    stateFilter.add("outdated");
  }
  if (opts.available) stateFilter.add("available");
  if (opts.outdated) stateFilter.add("outdated");
  if (opts.drafts) stateFilter.add("draft");

  const wantedTags =
    opts.tag && opts.tag.length > 0
      ? opts.tag.flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean)
      : [];

  const filtered = rows.filter((row) => {
    if (stateFilter.size > 0 && !stateFilter.has(row.state)) return false;
    if (wantedTags.length > 0 && !wantedTags.every((w) => row.tags.includes(w))) {
      return false;
    }
    return true;
  });

  const sortKey = normalizeSortKey(opts.sort);
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
  return filtered;
}

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

// ---------- phase 7: render ----------

function renderJson(filtered: Row[]): void {
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
}

function renderTable(
  filtered: Row[],
  allRows: Row[],
  scope: Scope,
  targetSources: Source[],
  opts: ListOptions,
): void {
  const isFiltered =
    opts.installed ||
    opts.available ||
    opts.outdated ||
    opts.drafts ||
    opts.source ||
    (opts.tag && opts.tag.length > 0);
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
        `${filtered.length} of ${allRows.length} ${allRows.length === 1 ? "skill" : "skills"} match.`,
      ),
    );
  } else {
    console.log(chalk.dim(`${allRows.length} ${allRows.length === 1 ? "skill" : "skills"} total`));
  }
  console.log("");

  const layout = computeTableLayout(filtered, scope);
  console.log(chalk.dim(layout.header));
  for (const row of filtered) {
    console.log(formatRow(row, layout));
  }

  console.log("");
  console.log(chalk.dim(`  ${formatSummaryLine(filtered) || "no skills"}`));
  console.log("");
}

interface TableLayout {
  header: string;
  namePad: number;
  sourceWidth: number; // 0 when source column is hidden
  installsWidth: number;
  descBudget: number;
}

function computeTableLayout(rows: Row[], scope: Scope): TableLayout {
  const showSourceColumn = scope.sources.length > 1;
  const INSTALLS_HEADER = "INSTALLS";
  const SOURCE_HEADER = "SOURCE";
  const DESC_CAP = 70;
  const installsWidth = INSTALLS_HEADER.length;
  const sourceWidth = showSourceColumn
    ? Math.max(SOURCE_HEADER.length, ...scope.sources.map((s) => s.key.length))
    : 0;
  const maxName = Math.max("NAME".length, ...rows.map((r) => r.name.length));
  const namePad = Math.min(40, Math.max(maxName, 12));
  const cols = process.stdout.columns ?? 120;
  const fixedPrefix =
    2 + 2 + namePad + 2 + (showSourceColumn ? sourceWidth + 2 : 0) + installsWidth + 2;
  const descBudget = Math.max(20, Math.min(DESC_CAP, cols - fixedPrefix - 4));

  let header = "  " + "  " + "NAME".padEnd(namePad);
  if (showSourceColumn) header += "  " + SOURCE_HEADER.padEnd(sourceWidth);
  header += "  " + INSTALLS_HEADER.padStart(installsWidth) + "  " + "DESCRIPTION";
  return { header, namePad, sourceWidth, installsWidth, descBudget };
}

function formatRow(row: Row, layout: TableLayout): string {
  const mark = stateMarker(row.state);
  const namePadded = row.name.padEnd(layout.namePad);
  const sourceCell =
    layout.sourceWidth > 0
      ? "  " + chalk.dim((row.source_key ?? "—").padEnd(layout.sourceWidth))
      : "";
  const installsCell =
    row.installs > 0
      ? chalk.cyan(String(row.installs).padStart(layout.installsWidth))
      : " ".repeat(layout.installsWidth);
  const desc = truncate(oneLine(row.description), layout.descBudget);
  const tagText = row.tags.length > 0 ? chalk.dim(` [${row.tags.join(", ")}]`) : "";
  const reason = row.reason ? chalk.dim(` (${row.reason})`) : "";
  return `  ${mark} ${namePadded}${sourceCell}  ${installsCell}  ${chalk.dim(desc)}${tagText}${reason}`;
}

function formatSummaryLine(rows: Row[]): string {
  const counts = rows.reduce(
    (acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }),
    {} as Record<SkillState, number>,
  );
  const parts: string[] = [];
  if (counts.installed) parts.push(`${counts.installed} installed`);
  if (counts.outdated) parts.push(`${counts.outdated} outdated`);
  if (counts.draft) parts.push(`${counts.draft} ${counts.draft === 1 ? "draft" : "drafts"}`);
  if (counts.available) parts.push(`${counts.available} available`);
  if (counts.invalid) parts.push(`${counts.invalid} invalid`);
  return parts.join(" · ");
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

// ---------- shared helpers ----------

async function fetchPagesCached(
  client: NotionClient,
  source: Source,
  cache: Map<string, NotionPage[]>,
): Promise<NotionPage[]> {
  const cached = cache.get(source.key);
  if (cached) return cached;
  const pages = await client.queryDataSource(source.data_source_id);
  cache.set(source.key, pages);
  return pages;
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

