import chalk from "chalk";
import { input, select } from "@inquirer/prompts";
import type { NotionClient } from "../notion.js";
import { parseNotionId } from "../parse-id.js";
import { EAGERLY_CREATED_PROPERTIES } from "../schema.js";
import { withSpinner } from "./_progress.js";

export interface PickedDatabase {
  databaseId: string;
  dataSourceId: string;
  databaseTitle: string;
  databaseUrl: string;
  /** True when we created the DB; false when linking an existing one. */
  isFresh: boolean;
}

/**
 * Shared "create new database OR link existing one" prompt sequence.
 * Used by `init` (first source) and `source add` (subsequent sources).
 *
 * On linked databases, ensures the eagerly-created columns and the
 * default views are present (idempotent). On freshly-created
 * databases, those are set up at create time.
 */
export async function pickOrCreateDatabase(client: NotionClient): Promise<PickedDatabase> {
  const useExisting = await select({
    message: "Set up a skills database:",
    choices: [
      { name: "Create a new skills database", value: false },
      { name: "Link an existing skills database", value: true },
    ],
    default: false,
  });
  if (useExisting) {
    const r = await pickExistingDatabase(client);
    // Reconcile schema + views progressively.
    const { added, retyped } = await client.upgradeSchema(r.dataSourceId, {
      only: new Set(EAGERLY_CREATED_PROPERTIES),
    });
    if (added.length || retyped.length) {
      const total = added.length + retyped.length;
      console.log(
        chalk.dim(
          `Added ${total} required ${total === 1 ? "column" : "columns"} to existing database.`,
        ),
      );
    }
    await client.ensureDefaultViews(r.databaseId, r.dataSourceId);
    return { ...r, isFresh: false };
  }
  const r = await createNewDatabase(client);
  return { ...r, isFresh: true };
}

async function pickExistingDatabase(client: NotionClient): Promise<Omit<PickedDatabase, "isFresh">> {
  const raw = await input({
    message: "Paste the Notion database URL or ID:",
    validate: (v) =>
      parseNotionId(v) !== null ||
      "Couldn't find a 32-char Notion ID in that input. Use the database's full URL.",
  });
  const databaseId = parseNotionId(raw)!;

  let db;
  try {
    db = await withSpinner("Looking up database", () => client.getDatabase(databaseId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        `Couldn't load that database from Notion.`,
        ``,
        `Common causes:`,
        `  · The URL points to a page, not a database — check it ends in /...?v=... (a database view URL)`,
        `  · ntn is logged in to a different workspace than the one with this DB — run \`ntn doctor\``,
        `  · The database was archived/deleted`,
        ``,
        `Original error: ${msg.split("\n")[0]}`,
      ].join("\n"),
    );
  }
  if (db.data_sources.length === 0) {
    throw new Error(
      `Database "${db.title}" has no data sources, which is unexpected for the 2025-09-03 API. Try refreshing ntn (\`ntn logout && ntn login\`) and re-running.`,
    );
  }
  let dataSourceId: string;
  if (db.data_sources.length === 1) {
    dataSourceId = db.data_sources[0]!.id;
  } else {
    dataSourceId = await select({
      message: "This database has multiple data sources — pick one:",
      choices: db.data_sources.map((ds) => ({ name: ds.name, value: ds.id })),
    });
  }
  console.log(chalk.dim(`  Connected to "${db.title}"`));
  return {
    databaseId: db.id,
    dataSourceId,
    databaseTitle: db.title,
    databaseUrl: `https://www.notion.so/${db.id.replace(/-/g, "")}`,
  };
}

async function createNewDatabase(client: NotionClient): Promise<Omit<PickedDatabase, "isFresh">> {
  const title = await input({
    message: "Name for the new database:",
    default: "Skills",
  });
  const db = await withSpinner("Creating database in your workspace", () =>
    client.createSkillsDatabase({ title }),
  );
  console.log(chalk.dim(`  ${db.url}`));
  return {
    databaseId: db.id,
    dataSourceId: db.data_source_id,
    databaseTitle: db.title,
    databaseUrl: db.url,
  };
}
