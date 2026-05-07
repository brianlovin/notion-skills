import chalk from "chalk";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateCommand } from "./migrate.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import {
  buildSkillMarkdown,
  convertPageToSkill,
  slugify,
} from "../convert.js";
import {
  type Manifest,
  loadManifest,
  writeManifest,
} from "../manifest.js";
import {
  HASH_V,
  hashBehaviorProperties,
  hashSkillContent,
} from "../page-hash.js";
import { NotionClient, readCheckbox, readTitle } from "../notion.js";
import {
  hashLocalSkillDir,
  readLocalSkillFiles,
  type SkillFile,
  upsertSkillFilePages,
} from "../skill-files.js";
import { assertNtnInstalled, ntnSetPageMarkdown } from "../ntn.js";
import { parseSkillFile } from "../migrate.js";
import { SCHEMA, notionPropsForSkill } from "../schema.js";
import { getScope } from "../scope.js";
import { startTask } from "./_progress.js";
import { type Source, findByKey } from "../sources.js";
import { pickSource } from "./_resolve.js";

interface PublishOptions {
  all?: boolean;
  yes?: boolean;
  source?: string;
}

/**
 * Push local skills to the workspace skill store.
 *
 * Three flavors of push, all routed through this verb:
 *   - **First-time publish** (no manifest entry, local SKILL.md exists):
 *     create a new Notion page in the chosen source. Source picker
 *     fires when 2+ sources exist and `--source` is not set.
 *   - **Update publish** (manifest entry exists): PATCH the existing
 *     Notion page. Re-publishes to the entry's recorded source — never
 *     prompts. `--source` is ignored here.
 *   - **Notion-side draft** (page exists in Notion with Published=false,
 *     no local presence): flip Published=true. Search scoped to the
 *     picked source.
 */
export async function publishCommand(
  slugs: string[],
  opts: PublishOptions,
): Promise<void> {
  if (!opts.all && slugs.length === 0) {
    throw new Error(
      "Usage: notion-skills publish <slug...> | --all\n" +
        "Pass one or more skill slugs, or --all to publish every local-only skill.",
    );
  }
  if (opts.all && slugs.length > 0) {
    throw new Error("Pass either <slug>... or --all, not both.");
  }

  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }

  const manifest = await loadManifest(scope.sources);
  const trackedNames = new Set(manifest ? Object.keys(manifest.skills) : []);

  if (slugs.length > 0) {
    const updateSlugs = slugs.filter((s) => trackedNames.has(s));
    const localDraftSlugs = slugs.filter(
      (s) =>
        !trackedNames.has(s) &&
        existsSync(join(SKILLS_STORE, s, "SKILL.md")),
    );
    const unresolved = slugs.filter(
      (s) => !trackedNames.has(s) && !existsSync(join(SKILLS_STORE, s, "SKILL.md")),
    );

    // For unresolved slugs, search Notion as potential Notion-side drafts.
    // Tag/source semantics differ per source, so this is scoped via the
    // picker (uses default unless --source is set).
    const notionDraftSlugs: { slug: string; pageId: string; source: Source }[] = [];
    const stillMissing: string[] = [];
    if (unresolved.length > 0) {
      await assertNtnInstalled();
      const client = new NotionClient();
      const draftSource = await pickSource(opts.source, scope);
      const pages = await client.queryDataSource(draftSource.data_source_id);
      const wantedSet = new Set(unresolved);
      const found = new Map<string, string>(); // slug → pageId
      for (const page of pages) {
        if (page.archived || page.in_trash) continue;
        const title = readTitle(page.properties);
        if (!title) continue;
        const pageSlug = slugify(title);
        if (!wantedSet.has(pageSlug)) continue;
        if (!readCheckbox(page.properties, "Published")) {
          found.set(pageSlug, page.id);
        }
      }
      for (const slug of unresolved) {
        const pageId = found.get(slug);
        if (pageId) notionDraftSlugs.push({ slug, pageId, source: draftSource });
        else stillMissing.push(slug);
      }
    }

    if (stillMissing.length > 0) {
      throw new Error(
        `Cannot publish: ${stillMissing.join(", ")} ${stillMissing.length === 1 ? "is" : "are"} not in the central store and not a draft in any source.\n` +
          `Run \`notion-skills gen\` to create a draft locally, or check \`notion-skills list --drafts\` for what's available.`,
      );
    }

    if (updateSlugs.length > 0 && manifest) {
      // Group by source: each entry knows its own source from manifest.
      const bySource = new Map<string, string[]>();
      for (const slug of updateSlugs) {
        const key = manifest.skills[slug]!.source_key;
        let bag = bySource.get(key);
        if (!bag) bySource.set(key, (bag = []));
        bag.push(slug);
      }
      for (const [sourceKey, slugsForSource] of bySource) {
        const source = findByKey(scope.sources, sourceKey);
        if (!source) {
          console.log(
            chalk.yellow(
              `! Skipping ${slugsForSource.length} skills from unknown source "${sourceKey}". Configure it via \`source add\` or \`source rename\`.`,
            ),
          );
          continue;
        }
        await pushUpdates(source, manifest, slugsForSource);
      }
    }
    if (localDraftSlugs.length > 0) {
      const target = await pickSource(opts.source, scope);
      await migrateCommand({ yes: true, only: localDraftSlugs, source: target.key });
    }
    if (notionDraftSlugs.length > 0) {
      await flipPublishedForDrafts(notionDraftSlugs);
    }
    return;
  }

  // --all mode. Push all drafts + all installed-with-drift.
  if (manifest) {
    const drifted = await detectDriftedInstalled(manifest);
    if (drifted.length > 0) {
      // Group by source.
      const bySource = new Map<string, string[]>();
      for (const slug of drifted) {
        const key = manifest.skills[slug]!.source_key;
        let bag = bySource.get(key);
        if (!bag) bySource.set(key, (bag = []));
        bag.push(slug);
      }
      for (const [sourceKey, slugsForSource] of bySource) {
        const source = findByKey(scope.sources, sourceKey);
        if (!source) continue;
        await pushUpdates(source, manifest, slugsForSource);
      }
    }
  }
  // For local drafts, route through migrate. Picks a single source.
  const target = await pickSource(opts.source, scope);
  await migrateCommand({ yes: opts.yes, source: target.key });
  console.log(chalk.dim("\nRun `notion-skills list` to verify."));
}

/**
 * For each slug already in the manifest, push the local SKILL.md to
 * its existing Notion page (PATCH properties + body), then re-fetch
 * to capture Notion's normalised formatting and update the manifest.
 */
async function pushUpdates(
  source: Source,
  manifest: Manifest,
  slugs: string[],
): Promise<void> {
  await assertNtnInstalled();
  const client = new NotionClient();

  console.log(
    chalk.bold(
      `Publishing ${slugs.length} ${slugs.length === 1 ? "update" : "updates"} → ${source.key}:`,
    ),
  );

  interface Parsed {
    localSlug: string;
    sourceSlug: string;
    pageId: string;
    body: string;
    properties: Record<string, unknown>;
    files: SkillFile[];
  }
  const parsed: Parsed[] = [];
  const failed: string[] = [];

  for (const localSlug of slugs) {
    const dir = join(SKILLS_STORE, localSlug);
    const file = join(dir, "SKILL.md");
    const result = await parseSkillFile(file, dir, file, localSlug);
    if ("error" in result) {
      failed.push(localSlug);
      console.log(
        `  ${chalk.red("✗")} ${localSlug} ${chalk.dim(`(${result.error})`)}`,
      );
      continue;
    }
    const entry = manifest.skills[localSlug]!;
    const files = await readLocalSkillFiles(dir);
    const unsupported = files.filter((f) => f.kind === "unsupported");
    if (unsupported.length > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ ${localSlug}: ${unsupported.length} unsupported file ${unsupported.length === 1 ? "type" : "types"} (${unsupported.map((f) => f.path).join(", ")}) — skipping.`,
        ),
      );
    }
    parsed.push({
      localSlug,
      sourceSlug: entry.source_slug,
      pageId: entry.page_id,
      body: result.skill.body,
      properties: result.skill.properties as unknown as Record<string, unknown>,
      files: files.filter((f) => f.kind !== "unsupported"),
    });
  }

  if (parsed.length === 0) return;

  const neededProps = new Set<string>();
  const selectValues = new Map<string, Set<string>>();
  for (const p of parsed) {
    for (const c of notionPropsForSkill(p.properties)) neededProps.add(c);
    for (const def of SCHEMA) {
      if (def.kind !== "select" && def.kind !== "multi_select") continue;
      if (!def.selfHealing) continue;
      const v = p.properties[def.frontmatterKey];
      const values = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      for (const value of values) {
        if (!value || value === "" || value === "default") continue;
        let bag = selectValues.get(def.notionName);
        if (!bag) { bag = new Set(); selectValues.set(def.notionName, bag); }
        bag.add(value);
      }
    }
  }
  if (neededProps.size > 0) {
    await client.upgradeSchema(source.data_source_id, { only: neededProps });
  }
  if (selectValues.size > 0) {
    await client.ensureSelectOptions(source.data_source_id, selectValues);
  }

  const dataSource = await client.getDataSource(source.data_source_id);
  const existingColumns = new Set(Object.keys(dataSource.properties));

  const pushed: { localSlug: string; sourceSlug: string; pageId: string }[] = [];
  for (const p of parsed) {
    const task = startTask(p.localSlug);
    try {
      await client.updateSkillPageProperties(
        p.pageId,
        { ...p.properties, published: true } as never,
        existingColumns,
      );
      if (p.body.trim()) {
        await ntnSetPageMarkdown(p.pageId, p.body);
      }
      await upsertSkillFilePages(client, ntnSetPageMarkdown, p.pageId, p.files);
      pushed.push({ localSlug: p.localSlug, sourceSlug: p.sourceSlug, pageId: p.pageId });
      task.done();
    } catch (err) {
      failed.push(p.localSlug);
      task.fail((err as Error).message.split("\n")[0]);
    }
  }

  // Round-trip: refetch and update manifest entries.
  const nextManifest: Manifest = {
    ...manifest,
    last_synced_at: new Date().toISOString(),
    hash_v: HASH_V,
    skills: { ...manifest.skills },
  };
  for (const p of pushed) {
    try {
      const fresh = await client.getPage(p.pageId);
      const converted = await convertPageToSkill(client, fresh);
      if (!converted.ok) continue;
      const md = buildSkillMarkdown({
        properties: converted.skill.properties,
        body: converted.skill.body,
      });
      const dir = join(SKILLS_STORE, p.localSlug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), md, "utf8");
      nextManifest.skills[p.localSlug] = {
        source_key: source.key,
        source_slug: converted.skill.properties.name,
        page_id: p.pageId,
        last_edited_time: converted.skill.lastEditedTime,
        props_hash: hashBehaviorProperties(fresh),
        body_hash: hashSkillContent(
          converted.skill.body,
          converted.skill.files,
        ),
        local_hash: hashSkillContent(md, converted.skill.files),
        files: converted.skill.files.map((f) => f.path).sort(),
      };
    } catch {
      // Refresh failure is non-fatal.
    }
  }
  await writeManifest(MANIFEST_FILE, nextManifest);

  console.log("");
  if (failed.length === 0) {
    console.log(
      chalk.green(`✓ Published ${pushed.length} ${pushed.length === 1 ? "update" : "updates"}.`),
    );
  } else {
    console.log(
      chalk.yellow(
        `Published ${pushed.length} of ${pushed.length + failed.length} (${failed.length} failed):`,
      ),
    );
    for (const name of failed) console.log(`  ${chalk.red("✗")} ${name}`);
  }
}

async function flipPublishedForDrafts(
  drafts: { slug: string; pageId: string; source: Source }[],
): Promise<void> {
  const client = new NotionClient();
  console.log(
    chalk.bold(
      `Publishing ${drafts.length} Notion ${drafts.length === 1 ? "draft" : "drafts"}:`,
    ),
  );
  for (const d of drafts) {
    const task = startTask(`${d.slug} ${chalk.dim(`[${d.source.key}]`)}`);
    try {
      await client.setPublished(d.pageId, true);
      task.done();
    } catch (err) {
      task.fail((err as Error).message.split("\n")[0]);
    }
  }
  console.log("");
  console.log(
    chalk.green(
      `✓ Marked ${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"} as ready.`,
    ),
  );
}

async function detectDriftedInstalled(manifest: Manifest): Promise<string[]> {
  const drifted: string[] = [];
  for (const [localSlug, entry] of Object.entries(manifest.skills)) {
    if (entry.local_hash === undefined) continue;
    const skillDir = join(SKILLS_STORE, localSlug);
    if (!existsSync(join(skillDir, "SKILL.md"))) continue;
    try {
      const currentHash = await hashLocalSkillDir(skillDir);
      if (currentHash !== entry.local_hash) drifted.push(localSlug);
    } catch {
      // unreadable; skip
    }
  }
  return drifted;
}
