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
  hashContent,
  readManifest,
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

interface PublishOptions {
  all?: boolean;
  yes?: boolean;
}

/**
 * Push local skills to the workspace skill store.
 *
 * Two flavors of push, both handled by this verb:
 *   - **First-time publish** (no manifest entry): create a new Notion
 *     page. Routes through `migrateCommand` which already does the
 *     create-page + symlink-fanout dance.
 *   - **Update publish** (manifest entry exists): PATCH the existing
 *     Notion page with the local SKILL.md content. Re-fetches after
 *     so local matches Notion's normalised version.
 *
 * Modes:
 *   - `publish <slug...>` — explicit per-slug push.
 *   - `publish --all` — every local skill: drafts (no manifest entry)
 *     + installed skills with local edits.
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

  const manifest = await readManifest(MANIFEST_FILE);
  const trackedNames = new Set(
    manifest ? Object.keys(manifest.skills) : [],
  );

  if (slugs.length > 0) {
    // Three paths a slug can take:
    //   1. Installed (manifest entry exists)        → pushUpdates
    //   2. Local draft (central-store dir, no entry)→ migrateCommand
    //   3. Notion-side draft (page exists w/ Published=false, no local
    //      presence)                                → flip Published=true
    // Anything that doesn't match any of the three is a typo / wrong
    // slug; we error.
    const updateSlugs = slugs.filter((s) => trackedNames.has(s));
    const localDraftSlugs = slugs.filter(
      (s) =>
        !trackedNames.has(s) &&
        existsSync(join(SKILLS_STORE, s, "SKILL.md")),
    );
    const unresolved = slugs.filter(
      (s) => !trackedNames.has(s) && !existsSync(join(SKILLS_STORE, s, "SKILL.md")),
    );

    // For unresolved slugs, look them up in Notion as potential
    // Notion-side drafts. One query covers all of them.
    const notionDraftSlugs: { slug: string; pageId: string }[] = [];
    const stillMissing: string[] = [];
    if (unresolved.length > 0) {
      await assertNtnInstalled();
      const client = new NotionClient();
      const pages = await client.queryDataSource(scope.data_source_id);
      const wantedSet = new Set(unresolved);
      const found = new Map<string, string>(); // slug → pageId of a draft match
      for (const page of pages) {
        if (page.archived || page.in_trash) continue;
        const title = readTitle(page.properties);
        if (!title) continue;
        const pageSlug = slugify(title);
        if (!wantedSet.has(pageSlug)) continue;
        // Only treat as "publishable from CLI" if it's actually a draft.
        // A non-draft slug that's neither installed nor local is a state
        // we can't fix from the CLI — surface it as missing.
        if (!readCheckbox(page.properties, "Published")) {
          found.set(pageSlug, page.id);
        }
      }
      for (const slug of unresolved) {
        const pageId = found.get(slug);
        if (pageId) notionDraftSlugs.push({ slug, pageId });
        else stillMissing.push(slug);
      }
    }

    if (stillMissing.length > 0) {
      throw new Error(
        `Cannot publish: ${stillMissing.join(", ")} ${stillMissing.length === 1 ? "is" : "are"} not in the central store and not a draft in Notion.\n` +
          `Run \`notion-skills gen\` to create a draft locally, or check \`notion-skills list --drafts\` for what's available.`,
      );
    }

    if (updateSlugs.length > 0 && manifest) {
      await pushUpdates(scope, manifest, updateSlugs);
    }
    if (localDraftSlugs.length > 0) {
      await migrateCommand({ yes: true, only: localDraftSlugs });
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
      await pushUpdates(scope, manifest, drifted);
    }
  }
  // migrate handles creating new pages for drafts (skills in central
  // store with no manifest entry).
  await migrateCommand({ yes: opts.yes });
  console.log(chalk.dim("\nRun `notion-skills list` to verify."));
}

/**
 * For each slug already in the manifest, push the local SKILL.md to
 * its existing Notion page (PATCH properties + body), then re-fetch
 * to capture Notion's normalised formatting and update the manifest.
 */
async function pushUpdates(
  scope: { data_source_id: string },
  manifest: Manifest,
  slugs: string[],
): Promise<void> {
  await assertNtnInstalled();
  const client = new NotionClient();

  console.log(
    chalk.bold(
      `Publishing ${slugs.length} ${slugs.length === 1 ? "update" : "updates"}:`,
    ),
  );

  // Parse all locals first so we can aggregate schema/option needs and
  // do a single PATCH for new columns / select options.
  interface Parsed {
    name: string;
    pageId: string;
    body: string;
    properties: Record<string, unknown>;
    files: SkillFile[];
  }
  const parsed: Parsed[] = [];
  const failed: string[] = [];

  for (const slug of slugs) {
    const dir = join(SKILLS_STORE, slug);
    const file = join(dir, "SKILL.md");
    const result = await parseSkillFile(file, dir, file, slug);
    if ("error" in result) {
      failed.push(slug);
      console.log(
        `  ${chalk.red("✗")} ${slug} ${chalk.dim(`(${result.error})`)}`,
      );
      continue;
    }
    const entry = manifest.skills[slug]!;
    const files = await readLocalSkillFiles(dir);
    const unsupported = files.filter((f) => f.kind === "unsupported");
    if (unsupported.length > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ ${slug}: ${unsupported.length} unsupported file ${unsupported.length === 1 ? "type" : "types"} (${unsupported.map((f) => f.path).join(", ")}) — skipping. Binary / unknown extensions are not yet supported.`,
        ),
      );
    }
    parsed.push({
      name: slug,
      pageId: entry.page_id,
      body: result.skill.body,
      properties: result.skill.properties as unknown as Record<string, unknown>,
      files: files.filter((f) => f.kind !== "unsupported"),
    });
  }

  if (parsed.length === 0) return;

  // Aggregate schema + select-option needs across all updates so we
  // make at most one PATCH for each.
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
    await client.upgradeSchema(scope.data_source_id, { only: neededProps });
  }
  if (selectValues.size > 0) {
    await client.ensureSelectOptions(scope.data_source_id, selectValues);
  }

  // Snapshot the data source's columns once per batch so the metadata
  // round-trip can match frontmatter `metadata.<key>` against existing
  // columns. Keys without a matching column are silently skipped (no
  // auto-creation from metadata — user adds columns intentionally).
  const dataSource = await client.getDataSource(scope.data_source_id);
  const existingColumns = new Set(Object.keys(dataSource.properties));

  // Push each.
  const pushed: { name: string; pageId: string }[] = [];
  for (const p of parsed) {
    const task = startTask(p.name);
    try {
      await client.updateSkillPageProperties(
        p.pageId,
        // Running `publish` is an explicit "ship it" gesture — always
        // ensures Published=true. Skills installed from a Notion-side
        // draft and then edited locally publish forward, not back into
        // draft state. (Path 2 of publish; mirrors paths 1 + 3.)
        { ...p.properties, published: true } as never,
        existingColumns,
      );
      if (p.body.trim()) {
        await ntnSetPageMarkdown(p.pageId, p.body);
      }
      await upsertSkillFilePages(client, ntnSetPageMarkdown, p.pageId, p.files);
      pushed.push({ name: p.name, pageId: p.pageId });
      task.done();
    } catch (err) {
      failed.push(p.name);
      task.fail((err as Error).message.split("\n")[0]);
    }
  }

  // Round-trip: refetch each pushed page to capture Notion's normalised
  // version, write back to central store, and update the manifest with
  // the fresh last_edited_time / props_hash / local_hash.
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
      const dir = join(SKILLS_STORE, p.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), md, "utf8");
      nextManifest.skills[p.name] = {
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
      // Refresh failure is non-fatal; the next sync reconciles.
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

/**
 * Path-3 publish: the user passed a slug that resolves to a Notion-side
 * draft (page exists with Published=false, no local presence). Flip the
 * Published checkbox to true. No body upload, no manifest entry — the
 * skill stays remote-only until someone explicitly `install`s it.
 */
async function flipPublishedForDrafts(
  drafts: { slug: string; pageId: string }[],
): Promise<void> {
  const client = new NotionClient();
  console.log(
    chalk.bold(
      `Publishing ${drafts.length} Notion ${drafts.length === 1 ? "draft" : "drafts"}:`,
    ),
  );
  for (const d of drafts) {
    const task = startTask(d.slug);
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

/**
 * Walk the manifest and return slugs whose on-disk content has drifted
 * from the recorded `local_hash`. The hash covers the full skill dir
 * (SKILL.md + every sibling file), so editing a sibling, adding a new
 * file, or deleting an existing one all show up as drift.
 */
async function detectDriftedInstalled(manifest: Manifest): Promise<string[]> {
  const drifted: string[] = [];
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (entry.local_hash === undefined) continue;
    const skillDir = join(SKILLS_STORE, name);
    if (!existsSync(join(skillDir, "SKILL.md"))) continue;
    try {
      const currentHash = await hashLocalSkillDir(skillDir);
      if (currentHash !== entry.local_hash) drifted.push(name);
    } catch {
      // unreadable; skip
    }
  }
  return drifted;
}
