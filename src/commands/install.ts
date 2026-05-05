import chalk from "chalk";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { getScope } from "../scope.js";
import { NotionClient, readMultiSelect, readTitle } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import {
  buildSkillMarkdown,
  convertPageToSkill,
  slugify,
} from "../convert.js";
import {
  type Manifest,
  emptyManifest,
  hashContent,
  readManifest,
  writeManifest,
} from "../manifest.js";
import { HASH_V, hashBehaviorProperties, hashBody } from "../page-hash.js";
import {
  ensureSymlink,
  targetSkillPath,
  targetsForKeys,
} from "../targets.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import {
  collidingSlugSet,
  detectSlugCollisions,
} from "../slug-collisions.js";
import { startTask } from "./_progress.js";

interface InstallOptions {
  all?: boolean;
  tag?: string[];
}

/**
 * Pull a skill (or set of skills) from the workspace store onto this
 * machine. After install:
 *   - SKILL.md lives at ~/.notion-skills/skills/<slug>/SKILL.md
 *   - Symlinks fan out to every configured target dir
 *   - Manifest tracks the slug as installed
 *   - Type /<slug> in any agent CLI and it works
 */
export async function installCommand(
  slugs: string[],
  opts: InstallOptions,
): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  if (!opts.all && !opts.tag && slugs.length === 0) {
    throw new Error(
      "Usage: notion-skills install <slug...> | --tag <name> | --all",
    );
  }

  await assertNtnInstalled();
  const client = new NotionClient();

  // Fetch all pages once; we filter client-side. Cheaper than per-slug
  // queries and gives us tag info in the same response.
  const pages = await client.queryDataSource(scope.data_source_id);

  const manifest =
    (await readManifest(MANIFEST_FILE)) ??
    emptyManifest(scope.database_id, scope.data_source_id);
  const trackedNames = new Set(Object.keys(manifest.skills));

  // Detect colliding slugs before resolving candidates. Direct slug
  // installs of a colliding name MUST fail — we can't pick which page
  // the user meant. Bulk modes (--tag, --all) skip them with a warning
  // and proceed with the unambiguous remainder.
  const collisions = detectSlugCollisions(pages);
  const colliding = collidingSlugSet(collisions);

  // Build candidate set based on flags.
  interface Candidate {
    name: string;
    pageId: string;
    pageIndex: number;
  }
  const allCandidates: Candidate[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    if (page.archived || page.in_trash) continue;
    const title = readTitle(page.properties);
    if (!title) continue;
    const name = slugify(title);
    if (colliding.has(name)) continue;
    allCandidates.push({ name, pageId: page.id, pageIndex: i });
  }

  let candidates: Candidate[];
  if (slugs.length > 0) {
    const requested = new Set(slugs);

    // If any requested slug collides, fail loud — we won't silently
    // pick one of the duplicates.
    const collidingRequested = collisions.filter((c) => requested.has(c.slug));
    if (collidingRequested.length > 0) {
      const lines = collidingRequested.map(
        (c) =>
          `  ${c.slug}: ${c.titles.length} pages with the same title (${c.titles.join(", ")})`,
      );
      throw new Error(
        [
          `Cannot install: the following ${collidingRequested.length === 1 ? "slug is" : "slugs are"} ambiguous in the store.`,
          ...lines,
          `Rename one of the colliding pages in Notion, then re-run.`,
        ].join("\n"),
      );
    }

    candidates = allCandidates.filter((c) => requested.has(c.name));
    const found = new Set(candidates.map((c) => c.name));
    const missing = [...requested].filter((s) => !found.has(s));
    if (missing.length > 0) {
      throw new Error(
        `Cannot install: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the store. Run \`notion-skills list\` to see what's available.`,
      );
    }
  } else if (opts.tag && opts.tag.length > 0) {
    const wanted = opts.tag.flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
    candidates = allCandidates.filter((c) => {
      const tags = readMultiSelect(pages[c.pageIndex]!.properties, "Tags");
      return wanted.every((w) => tags.includes(w));
    });
    if (candidates.length === 0) {
      throw new Error(
        `No skills found with ${wanted.length === 1 ? "tag" : "all of tags"} ${wanted.join(", ")}.`,
      );
    }
  } else {
    candidates = allCandidates;
  }

  // Bulk-mode collision warning: name what we skipped so the user can
  // go fix it in Notion. Explicit-slug mode already errored above.
  if (collisions.length > 0 && slugs.length === 0) {
    console.log(
      chalk.yellow(
        `Skipping ${collisions.length} ambiguous ${collisions.length === 1 ? "slug" : "slugs"} (multiple pages share each): ${collisions.map((c) => c.slug).join(", ")}.`,
      ),
    );
  }

  // Filter out already-installed (idempotent install --all / --tag).
  const newCandidates = candidates.filter((c) => !trackedNames.has(c.name));
  const alreadyInstalled = candidates.filter((c) => trackedNames.has(c.name));

  if (newCandidates.length === 0) {
    if (alreadyInstalled.length === 0) {
      console.log(chalk.dim("No matching skills found."));
    } else if (alreadyInstalled.length === 1) {
      // Direct `install <slug>` on an already-installed skill — name
      // the skill explicitly instead of "All 1 matching skill is …".
      console.log(
        chalk.dim(`${alreadyInstalled[0]!.name} is already installed.`),
      );
    } else {
      console.log(
        chalk.dim(
          `All ${alreadyInstalled.length} matching skills are already installed.`,
        ),
      );
    }
    return;
  }

  if (newCandidates.length > 5 && !slugs.length) {
    // For bulk installs (tag/all), confirm.
    const ok = await confirm({
      message: `Install ${newCandidates.length} ${newCandidates.length === 1 ? "skill" : "skills"}?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim("Aborted."));
      return;
    }
  }

  console.log(
    chalk.bold(
      `Installing ${newCandidates.length} ${newCandidates.length === 1 ? "skill" : "skills"}:`,
    ),
  );

  // Make sure the Installs column exists on the data source before we
  // try to increment it. Backwards-compat for stores created before
  // this feature landed; cheap idempotent no-op for newer stores.
  await client.upgradeSchema(scope.data_source_id, {
    only: new Set(["Installs"]),
  });

  const nextManifest: Manifest = {
    ...manifest,
    last_synced_at: new Date().toISOString(),
    hash_v: HASH_V,
    skills: { ...manifest.skills },
  };

  for (const c of newCandidates) {
    const task = startTask(c.name);
    try {
      const page = pages[c.pageIndex]!;
      const converted = await convertPageToSkill(client, page);
      if (!converted.ok) {
        task.fail(converted.reason);
        continue;
      }
      const skill = converted.skill;
      const md = buildSkillMarkdown({
        properties: skill.properties,
        body: skill.body,
      });
      const dir = join(SKILLS_STORE, skill.properties.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), md, "utf8");

      nextManifest.skills[skill.properties.name] = {
        page_id: skill.pageId,
        last_edited_time: skill.lastEditedTime,
        props_hash: hashBehaviorProperties(page),
        body_hash: hashBody(skill.body),
        local_hash: hashContent(md),
      };

      // Fan symlinks out to every configured target dir.
      const targets = targetsForKeys(scope.targets);
      for (const t of targets) {
        const link = targetSkillPath(t, skill.properties.name);
        await ensureSymlink(dir, link);
      }

      // Bump the Installs counter so popular skills surface in `list`.
      // Fail-soft and fire-and-forget for drift purposes: the PATCH
      // bumps the page's last_edited_time, but we don't refetch — drift
      // detection now compares props_hash + body_hash, both of which are
      // unaffected by an Installs edit (Installs is metricOnly). The
      // stale last_edited_time on this entry just means the next `list`
      // takes the slow path once before re-caching.
      await client.incrementPageNumber(skill.pageId, "Installs");

      task.done();
    } catch (err) {
      task.fail((err as Error).message.split("\n")[0]);
    }
  }

  await writeManifest(MANIFEST_FILE, nextManifest);
  console.log("");
  console.log(chalk.green(`✓ Installed ${newCandidates.length} ${newCandidates.length === 1 ? "skill" : "skills"}.`));
  if (alreadyInstalled.length > 0) {
    console.log(
      chalk.dim(`  (${alreadyInstalled.length} already installed, skipped.)`),
    );
  }
}
