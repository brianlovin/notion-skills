import chalk from "chalk";
import { confirm } from "@inquirer/prompts";
import { getScope } from "../scope.js";
import { NotionClient, readTitle } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { ntnApi } from "../ntn.js";
import { slugify } from "../convert.js";
import { loadManifest, writeManifest } from "../manifest.js";
import { MANIFEST_FILE } from "../paths.js";
import { findByKey } from "../sources.js";
import { pickSource } from "./_resolve.js";
import { resolveInstalledRef } from "../resolvers.js";

interface UnpublishOptions {
  yes?: boolean;
  source?: string;
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

  // First check the manifest: an installed skill knows its own source.
  // Skip the cross-source search in that case.
  const manifestEarly = await loadManifest(scope.sources);
  let pageId: string | undefined;
  let resolvedSourceKey: string | undefined;

  if (manifestEarly) {
    const ref = resolveInstalledRef(slug, scope.sources, manifestEarly);
    if (ref.ok) {
      pageId = ref.entry.page_id;
      resolvedSourceKey = ref.source.key;
      slug = ref.localSlug;
    }
  }

  if (!pageId) {
    // Not installed — search a chosen source for the slug.
    const source = await pickSource(opts.source, scope);
    const pages = await client.queryDataSource(source.data_source_id);
    const match = pages.find((p) => {
      if (p.archived || p.in_trash) return false;
      const title = readTitle(p.properties);
      return slugify(title) === slug;
    });
    if (!match) {
      throw new Error(
        `Skill "${slug}" is not in source "${source.key}" (or already unpublished).`,
      );
    }
    pageId = match.id;
    resolvedSourceKey = source.key;
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
  await ntnApi("PATCH", `/v1/pages/${pageId}`, { in_trash: true }, "2025-09-03");

  // Drop the manifest entry too — the skill is no longer in the store,
  // so it shouldn't be tracked as installed. Local copy stays on disk
  // (effectively a draft); user can re-publish or uninstall.
  const manifest = await loadManifest(scope.sources);
  if (manifest && manifest.skills[slug]) {
    const next = { ...manifest, skills: { ...manifest.skills } };
    delete next.skills[slug];
    next.last_synced_at = new Date().toISOString();
    await writeManifest(MANIFEST_FILE, next);
  }

  console.log(chalk.green(`✓ Unpublished ${slug}.`));
  console.log(
    chalk.dim(
      `  Notion's page history can restore it. Your local copy is preserved as a draft — run \`notion-skills publish ${slug}\` to re-publish or \`notion-skills uninstall ${slug}\` to remove it from this machine.`,
    ),
  );
}
