import chalk from "chalk";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  NotionClient,
  readMultiSelect,
  readRichText,
  readTitle,
} from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { shouldSyncSkill } from "../filter.js";
import { slugify } from "../convert.js";
import { getScope } from "../scope.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import { readManifest } from "../manifest.js";
import { readFile } from "node:fs/promises";

interface ListOptions {
  installed?: boolean;
  available?: boolean;
  outdated?: boolean;
  drafts?: boolean;
  tag?: string[];
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
  state: SkillState;
  reason?: string;
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
        state: "invalid",
        reason: "no title",
      });
      continue;
    }
    const name = slugify(title);
    const description = readRichText(page.properties, "Description");
    const tags = readMultiSelect(page.properties, "Tags");

    if (!shouldSyncSkill(name, scope.exclude_skills)) {
      rows.push({ name, title, description, tags, state: "excluded", reason: "exclude_skills" });
      continue;
    }

    const inManifest = trackedNames.has(name);
    if (!inManifest) {
      rows.push({ name, title, description, tags, state: "available" });
      continue;
    }

    // Installed. Check for outdated by comparing manifest's last_edited_time
    // and props_hash against the page. (Cheap remote-change check.)
    const entry = manifest?.skills[name];
    const remoteEdited = page.last_edited_time;
    const isOutdated = entry !== undefined && remoteEdited !== entry.last_edited_time;
    rows.push({
      name,
      title,
      description,
      tags,
      state: isOutdated ? "outdated" : "installed",
    });
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

  filtered.sort((a, b) => {
    // Group by state for readability: installed → outdated → draft → available → excluded → invalid.
    const order: Record<SkillState, number> = {
      installed: 0,
      outdated: 1,
      draft: 2,
      available: 3,
      excluded: 4,
      invalid: 5,
    };
    if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
    return a.name.localeCompare(b.name);
  });

  if (options.json) {
    const out = filtered.map((r) => ({
      name: r.name,
      title: r.title,
      description: r.description,
      tags: r.tags,
      state: r.state,
      ...(r.reason ? { reason: r.reason } : {}),
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Human / agent-friendly text output.
  console.log(chalk.bold(`\n${scope.database_title ?? scope.database_id}`));
  console.log(chalk.dim(`${rows.length} ${rows.length === 1 ? "skill" : "skills"} total`));
  console.log("");

  for (const row of filtered) {
    const mark = stateMarker(row.state);
    const namePadded = row.name.padEnd(40);
    const desc = truncate(oneLine(row.description), Math.max(20, (process.stdout.columns ?? 100) - 70));
    const tagText =
      row.tags.length > 0 ? ` ${chalk.dim(`[${row.tags.join(", ")}]`)}` : "";
    const reason = row.reason ? chalk.dim(` (${row.reason})`) : "";
    console.log(`  ${mark} ${namePadded} ${chalk.dim(desc)}${tagText}${reason}`);
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
  if (value === "") {
    // YAML list form, look for following indented lines.
    const blockRe = new RegExp(`^${key}\\s*:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m");
    const block = fm.match(blockRe);
    if (!block || !block[1]) return [];
    return block[1]
      .split("\n")
      .map((line) => line.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean);
  }
  return value.split(/\s*,\s*/).filter(Boolean);
}
