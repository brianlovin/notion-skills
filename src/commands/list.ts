import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  NotionClient,
  readMultiSelect,
  readTitle,
} from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { decide } from "../filter.js";
import { slugify } from "../convert.js";
import { getScope } from "../scope.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import { readManifest } from "../manifest.js";

const TAGS_PROPERTY = "Tags";

export async function listCommand(): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  await assertNtnInstalled();
  const client = new NotionClient();
  const pages = await client.queryDataSource(scope.data_source_id);

  const manifest = await readManifest(MANIFEST_FILE);
  const contentRoot = SKILLS_STORE;

  console.log(chalk.bold(`\n${scope.database_title ?? scope.database_id}`));
  console.log(chalk.dim(`${pages.length} pages\n`));

  type Row = {
    name: string;
    title: string;
    tags: string[];
    state: "synced" | "filtered" | "invalid" | "available";
    reason?: string;
  };

  const rows: Row[] = [];

  for (const page of pages) {
    if (page.archived || page.in_trash) continue;
    const title = readTitle(page.properties);
    if (!title) {
      rows.push({ name: "—", title: "(untitled)", tags: [], state: "invalid", reason: "no title" });
      continue;
    }
    const name = slugify(title);
    const tags = readMultiSelect(page.properties, TAGS_PROPERTY);
    const decision = decide({ name, tags }, scope.filter);

    if (!decision.keep) {
      rows.push({ name, title, tags, state: "filtered", reason: decision.reason });
      continue;
    }

    const onDisk = existsSync(join(contentRoot, name));
    const inManifest = manifest?.skills[name];
    rows.push({
      name,
      title,
      tags,
      state: onDisk && inManifest ? "synced" : "available",
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  for (const row of rows) {
    const mark =
      row.state === "synced"
        ? chalk.green("✓")
        : row.state === "filtered"
          ? chalk.red("✗")
          : row.state === "invalid"
            ? chalk.yellow("!")
            : chalk.dim("○");

    const tagStr = row.tags.length ? chalk.dim(`  [${row.tags.join(", ")}]`) : "";
    const reason =
      row.state === "filtered" ? chalk.dim(`  (${row.reason})`) : row.state === "invalid" ? chalk.dim(`  (${row.reason})`) : "";

    console.log(`  ${mark} ${row.name.padEnd(40)} ${chalk.dim(row.title.length > 50 ? row.title.slice(0, 47) + "..." : row.title)}${tagStr}${reason}`);
  }

  const counts = rows.reduce(
    (acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }),
    {} as Record<Row["state"], number>,
  );

  console.log("");
  console.log(
    chalk.dim(
      `  ${counts.synced ?? 0} synced · ${counts.available ?? 0} available · ${counts.filtered ?? 0} filtered out · ${counts.invalid ?? 0} invalid`,
    ),
  );
}

