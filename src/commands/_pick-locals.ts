import chalk from "chalk";
import { Separator, checkbox } from "@inquirer/prompts";
import { dirname } from "node:path";
import type { ParsedSkill } from "../migrate.js";

/**
 * Render a multiselect of local skills not yet in Notion, grouped by
 * source directory. Returns the slugs the user kept (empty array if
 * they deselected everything).
 *
 * Used by both `init` and `sync` after they discover skills on disk
 * that aren't represented in the configured database.
 */
export async function pickLocalSkillsToUpload(
  skills: ParsedSkill[],
): Promise<string[]> {
  if (skills.length === 0) return [];

  // Group by the joined-source-dir signature so skills present in the
  // same set of agent dirs render under one header.
  type Group = { label: string; skills: ParsedSkill[] };
  const byKey = new Map<string, Group>();
  for (const s of skills) {
    const dirs = [s.sourceDisplay, ...(s.additionalSourceDisplays ?? [])]
      .map((p) => homeRelative(dirname(p)))
      .sort();
    const key = dirs.join("\n");
    let g = byKey.get(key);
    if (!g) {
      g = { label: dirs.join(", "), skills: [] };
      byKey.set(key, g);
    }
    g.skills.push(s);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.skills.sort((a, b) => a.name.localeCompare(b.name));

  const total = skills.length;
  const message =
    total === 1
      ? `Found 1 local skill not in Notion. Upload it?`
      : `Found ${total} local skills not in Notion. Pick which to upload:`;

  const cols = process.stdout.columns ?? 100;
  const longestName = Math.max(...skills.map((s) => s.name.length));
  // pad so descriptions line up; cap at 32 so a wildly long name doesn't
  // squeeze the description column to nothing.
  const namePad = Math.min(32, longestName + 2);
  const descMax = Math.max(20, cols - namePad - 10);

  type Choice =
    | { name: string; value: string; checked: boolean }
    | InstanceType<typeof Separator>;
  const choices: Choice[] = [];
  const showHeaders = groups.length > 1;
  for (const g of groups) {
    if (showHeaders) {
      choices.push(new Separator(chalk.dim(`  ${g.label}`)));
    }
    for (const skill of g.skills) {
      const desc = truncate(oneLine(skill.description), descMax);
      const name = `${skill.name.padEnd(namePad)} ${chalk.dim(desc)}`;
      choices.push({ name, value: skill.name, checked: true });
    }
  }

  return checkbox({
    message,
    choices,
    pageSize: Math.min(25, choices.length + 1),
    // After submit, inquirer echoes the selected values back on the prompt
    // line. With 17+ skill names that wraps into a paragraph and clutters
    // the transcript. Replace it with a compact "(N of M selected)" line.
    theme: {
      style: {
        renderSelectedChoices: (selected: ReadonlyArray<unknown>) =>
          chalk.dim(`(${selected.length} of ${total} selected)`),
      },
    },
  });
}

function homeRelative(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3).trimEnd() + "...";
}
