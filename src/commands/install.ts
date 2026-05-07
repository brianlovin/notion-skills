import chalk from "chalk";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { getScope } from "../scope.js";
import {
  NotionClient,
  type NotionPage,
  readCheckbox,
  readMultiSelect,
  readTitle,
} from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import {
  buildSkillMarkdown,
  convertPageToSkill,
  slugify,
} from "../convert.js";
import {
  type Manifest,
  emptyManifest,
  loadManifest,
  writeManifest,
} from "../manifest.js";
import {
  HASH_V,
  hashBehaviorProperties,
  hashSkillContent,
} from "../page-hash.js";
import {
  ensureSymlink,
  targetSkillPath,
  targetsForKeys,
} from "../targets.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import { materializeFiles } from "../skill-files.js";
import {
  collidingSlugSet,
  detectSlugCollisions,
} from "../slug-collisions.js";
import { startTask } from "./_progress.js";
import { type Source, parseSkillRef } from "../sources.js";
import { chooseLocalSlug } from "../resolvers.js";
import { pickSource } from "./_resolve.js";

interface InstallOptions {
  all?: boolean;
  tag?: string[];
  source?: string;
  /** Override the local slug for a single-skill install (collision dodge). */
  as?: string;
}

interface Candidate {
  source: Source;
  page: NotionPage;
  /** source-side slug (slugify(title)). */
  sourceSlug: string;
  isDraft: boolean;
}

/**
 * Pull a skill (or set of skills) from the workspace store onto this
 * machine. Single-skill mode resolves refs cross-source; bulk modes
 * (--tag, --all) scope to a single source via the resolver.
 */
export async function installCommand(
  refs: string[],
  opts: InstallOptions,
): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }
  if (!opts.all && !opts.tag && refs.length === 0) {
    throw new Error(
      "Usage: notion-skills install <slug...> | --tag <name> | --all",
    );
  }
  if (opts.as && refs.length !== 1) {
    throw new Error("--as only applies when installing exactly one skill.");
  }

  await assertNtnInstalled();
  const client = new NotionClient();

  const manifest = (await loadManifest(scope.sources)) ?? emptyManifest();

  // Decide which sources to query and how candidates get matched.
  let candidates: Candidate[];
  if (opts.tag || opts.all) {
    const source = await pickSource(opts.source, scope);
    candidates = await collectCandidates(client, [source]);
    candidates = filterBulk(candidates, opts);
  } else {
    // Single-skill mode: parse each ref, fan out to required sources.
    candidates = await resolveSingleRefs(client, scope.sources, refs);
  }

  if (candidates.length === 0) {
    console.log(chalk.dim("No matching skills found."));
    return;
  }

  // Filter out already-installed (by source + source_slug match against
  // existing manifest entries).
  const installedBySource = new Map<string, Set<string>>();
  for (const e of Object.values(manifest.skills)) {
    let bag = installedBySource.get(e.source_key);
    if (!bag) installedBySource.set(e.source_key, (bag = new Set()));
    bag.add(e.source_slug);
  }
  const fresh: Candidate[] = [];
  const already: Candidate[] = [];
  for (const c of candidates) {
    if (installedBySource.get(c.source.key)?.has(c.sourceSlug)) {
      already.push(c);
    } else {
      fresh.push(c);
    }
  }

  if (fresh.length === 0) {
    if (already.length === 1) {
      console.log(chalk.dim(`${already[0]!.sourceSlug} is already installed.`));
    } else {
      console.log(chalk.dim(`All ${already.length} matching skills are already installed.`));
    }
    return;
  }

  if (fresh.length > 5 && refs.length === 0) {
    const ok = await confirm({
      message: `Install ${fresh.length} ${fresh.length === 1 ? "skill" : "skills"}?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim("Aborted."));
      return;
    }
  }

  console.log(
    chalk.bold(
      `Installing ${fresh.length} ${fresh.length === 1 ? "skill" : "skills"}:`,
    ),
  );

  // Pre-warm Installs column on every source we're about to install from.
  const sourcesTouched = new Set(fresh.map((c) => c.source));
  for (const s of sourcesTouched) {
    await client.upgradeSchema(s.data_source_id, { only: new Set(["Installs"]) });
  }

  const nextManifest: Manifest = {
    ...manifest,
    last_synced_at: new Date().toISOString(),
    hash_v: HASH_V,
    skills: { ...manifest.skills },
  };

  for (const c of fresh) {
    const sourceTag = scope.sources.length > 1 ? chalk.dim(` [${c.source.key}]`) : "";
    const task = startTask(c.sourceSlug + sourceTag);
    try {
      const converted = await convertPageToSkill(client, c.page);
      if (!converted.ok) {
        task.fail(converted.reason);
        continue;
      }
      const skill = converted.skill;
      const md = buildSkillMarkdown({
        properties: skill.properties,
        body: skill.body,
      });

      // Choose the on-disk slug. Source-slug if free; else
      // <source-key>-<slug>; else numeric suffix. --as overrides.
      const choice = chooseLocalSlug(c.source.key, c.sourceSlug, nextManifest, opts.as);

      const dir = join(SKILLS_STORE, choice.slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), md, "utf8");
      await materializeFiles(dir, skill.files);

      nextManifest.skills[choice.slug] = {
        source_key: c.source.key,
        source_slug: c.sourceSlug,
        page_id: skill.pageId,
        last_edited_time: skill.lastEditedTime,
        props_hash: hashBehaviorProperties(c.page),
        body_hash: hashSkillContent(skill.body, skill.files),
        local_hash: hashSkillContent(md, skill.files),
        files: skill.files.map((f) => f.path).sort(),
      };

      const targets = targetsForKeys(scope.targets);
      for (const t of targets) {
        const link = targetSkillPath(t, choice.slug);
        await ensureSymlink(dir, link);
      }

      await client.incrementPageNumber(skill.pageId, "Installs");

      if (choice.autoNamespaced) {
        task.done(`(installed as '${choice.slug}' to avoid collision)`);
      } else {
        task.done();
      }
    } catch (err) {
      task.fail((err as Error).message.split("\n")[0]);
    }
  }

  await writeManifest(MANIFEST_FILE, nextManifest);
  console.log("");
  console.log(chalk.green(`✓ Installed ${fresh.length} ${fresh.length === 1 ? "skill" : "skills"}.`));
  if (already.length > 0) {
    console.log(chalk.dim(`  (${already.length} already installed, skipped.)`));
  }
}

// ---------- helpers ----------

/**
 * Query every given source's data source and return a flat list of
 * candidates, each tagged with the originating Source. Skips archived/
 * trashed pages and ones missing a title.
 */
async function collectCandidates(client: NotionClient, sources: Source[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const source of sources) {
    const pages = await client.queryDataSource(source.data_source_id);
    const collisions = detectSlugCollisions(pages);
    const colliding = collidingSlugSet(collisions);
    const publishedColumn = pages.some((p) => p.properties.Published !== undefined);
    for (const page of pages) {
      if (page.archived || page.in_trash) continue;
      const title = readTitle(page.properties);
      if (!title) continue;
      const sourceSlug = slugify(title);
      if (colliding.has(sourceSlug)) continue;
      const isDraft = publishedColumn && !readCheckbox(page.properties, "Published");
      out.push({ source, page, sourceSlug, isDraft });
    }
  }
  return out;
}

/**
 * Bulk-mode filter: --tag and --all both skip drafts and (for --tag)
 * apply tag set intersection.
 */
function filterBulk(candidates: Candidate[], opts: InstallOptions): Candidate[] {
  const out = candidates.filter((c) => !c.isDraft);
  if (!opts.tag || opts.tag.length === 0) return out;
  const wanted = opts.tag.flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
  return out.filter((c) => {
    const tags = readMultiSelect(c.page.properties, "Tags");
    return wanted.every((w) => tags.includes(w));
  });
}

/**
 * Resolve a list of refs against all configured sources. Each ref can
 * be:
 *   - bare slug (`deploy`): search all sources, error on ambiguity
 *   - qualified (`team/deploy`): scope to that source
 *
 * Drafts are allowed in single-skill mode (the user named them).
 */
async function resolveSingleRefs(
  client: NotionClient,
  sources: Source[],
  refs: string[],
): Promise<Candidate[]> {
  // Cache pages-by-source — avoid refetching on multiple refs.
  const pagesBySource = new Map<string, Candidate[]>();
  async function load(s: Source): Promise<Candidate[]> {
    const cached = pagesBySource.get(s.key);
    if (cached) return cached;
    const cs = await collectCandidates(client, [s]);
    pagesBySource.set(s.key, cs);
    return cs;
  }

  const out: Candidate[] = [];
  for (const ref of refs) {
    const { sourceKey, slug } = parseSkillRef(ref);
    if (sourceKey !== undefined) {
      const source = sources.find((s) => s.key === sourceKey);
      if (!source) {
        throw new Error(
          `Unknown source "${sourceKey}". Configured: ${sources.map((s) => s.key).join(", ")}.`,
        );
      }
      const pool = await load(source);
      const hit = pool.find((c) => c.sourceSlug === slug);
      if (!hit) {
        throw new Error(`${ref}: not found in source "${sourceKey}".`);
      }
      out.push(hit);
    } else {
      // Bare slug — search every source.
      const matches: Candidate[] = [];
      for (const source of sources) {
        const pool = await load(source);
        for (const c of pool) {
          if (c.sourceSlug === slug) matches.push(c);
        }
      }
      if (matches.length === 0) {
        throw new Error(
          `${ref}: not found in any source. Run \`notion-skills list\` to see what's available.`,
        );
      }
      if (matches.length > 1) {
        const refs = matches.map((m) => `${m.source.key}/${m.sourceSlug}`).join(", ");
        throw new Error(
          `${ref}: ambiguous, exists in multiple sources (${refs}). Qualify with <source>/<slug>.`,
        );
      }
      out.push(matches[0]!);
    }
  }
  return out;
}
