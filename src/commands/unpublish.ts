import chalk from "chalk";
import { confirm } from "@inquirer/prompts";
import { getScope } from "../scope.js";
import { NotionClient, readTitle } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { ntnApi } from "../ntn.js";
import { slugify } from "../convert.js";

interface UnpublishOptions {
  yes?: boolean;
}

/**
 * Remove a skill from the workspace store. Archives the Notion page
 * (sets `in_trash: true`). The local copy is untouched — if the user
 * also wants it off their machine, they run `uninstall` separately.
 *
 * Anyone with edit access in Notion can unpublish (matches the broader
 * "anyone can edit" rule from the design grilling). Other users with
 * the skill installed see a one-line "no longer published" note on
 * their next sync; their local copy stays.
 */
export async function unpublishCommand(
  slug: string,
  opts: UnpublishOptions,
): Promise<void> {
  if (!slug) {
    throw new Error("Usage: notion-skills unpublish <slug>");
  }

  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  await assertNtnInstalled();
  const client = new NotionClient();

  // Find the page in the workspace store.
  const pages = await client.queryDataSource(scope.data_source_id);
  const match = pages.find((p) => {
    if (p.archived || p.in_trash) return false;
    const title = readTitle(p.properties);
    return slugify(title) === slug;
  });

  if (!match) {
    throw new Error(
      `Skill "${slug}" is not in the store (or already unpublished).`,
    );
  }

  if (!opts.yes && process.stdin.isTTY) {
    console.log("");
    console.log(
      chalk.yellow(
        `Unpublishing "${slug}" archives the Notion page. Anyone who has it installed will see "no longer published" on their next sync; their local copy is preserved.`,
      ),
    );
    const ok = await confirm({
      message: `Archive "${slug}" from the store?`,
      default: false,
    });
    if (!ok) {
      console.log(chalk.dim("Aborted."));
      return;
    }
  }

  // ntn's PATCH /v1/pages with in_trash: true archives the page.
  await ntnApi("PATCH", `/v1/pages/${match.id}`, { in_trash: true }, "2025-09-03");

  console.log(chalk.green(`✓ Unpublished ${slug}.`));
  console.log(
    chalk.dim(
      `  Notion's page history can restore it. Your local copy is unchanged — run \`notion-skills uninstall ${slug}\` to remove it from this machine.`,
    ),
  );
}
