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
import {
  ensureSymlink,
  targetSkillPath,
  targetsForKeys,
} from "../targets.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
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
    allCandidates.push({ name, pageId: page.id, pageIndex: i });
  }

  let candidates: Candidate[];
  if (slugs.length > 0) {
    const requested = new Set(slugs);
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

  const nextManifest: Manifest = {
    ...manifest,
    last_synced_at: new Date().toISOString(),
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

      // Compute props_hash from the same property bag we'd see in sync.
      // We don't have summarisePage here; recompute inline.
      const propsHash = hashContent(
        JSON.stringify(skill.properties),
      );

      nextManifest.skills[skill.properties.name] = {
        page_id: skill.pageId,
        last_edited_time: skill.lastEditedTime,
        props_hash: propsHash,
        local_hash: hashContent(md),
      };

      // Fan symlinks out to every configured target dir.
      const targets = targetsForKeys(scope.targets);
      for (const t of targets) {
        const link = targetSkillPath(t, skill.properties.name);
        await ensureSymlink(dir, link);
      }
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
