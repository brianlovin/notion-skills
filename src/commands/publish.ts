import chalk from "chalk";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateCommand } from "./migrate.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import {
  buildSkillMarkdown,
  convertPageToSkill,
} from "../convert.js";
import {
  type Manifest,
  hashContent,
  readManifest,
  writeManifest,
} from "../manifest.js";
import { HASH_V, hashBehaviorProperties, hashBody } from "../page-hash.js";
import { NotionClient } from "../notion.js";
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
    // Pre-flight: warn if any of the requested slugs aren't on disk yet.
    const missing = slugs.filter(
      (s) => !existsSync(join(SKILLS_STORE, s, "SKILL.md")),
    );
    if (missing.length > 0) {
      throw new Error(
        `Cannot publish: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the central store.\n` +
          `Run \`notion-skills gen\` to create a draft, or check \`notion-skills list --drafts\`.`,
      );
    }

    // Split into updates (already in manifest) vs new drafts.
    const updateSlugs = slugs.filter((s) => trackedNames.has(s));
    const draftSlugs = slugs.filter((s) => !trackedNames.has(s));

    if (updateSlugs.length > 0 && manifest) {
      await pushUpdates(scope, manifest, updateSlugs);
    }
    if (draftSlugs.length > 0) {
      await migrateCommand({ yes: true, only: draftSlugs });
    }

    const total = updateSlugs.length + draftSlugs.length;
    if (total > 0 && updateSlugs.length > 0 && draftSlugs.length === 0) {
      // Pure-update flow already prints its own banner.
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
    parsed.push({
      name: slug,
      pageId: entry.page_id,
      body: result.skill.body,
      properties: result.skill.properties as unknown as Record<string, unknown>,
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

  // Push each.
  const pushed: { name: string; pageId: string }[] = [];
  for (const p of parsed) {
    const task = startTask(p.name);
    try {
      await client.updateSkillPageProperties(
        p.pageId,
        p.properties as never, // SkillProperties shape
      );
      if (p.body.trim()) {
        await ntnSetPageMarkdown(p.pageId, p.body);
      }
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
        body_hash: hashBody(converted.skill.body),
        local_hash: hashContent(md),
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
 * Walk the manifest, hash each local SKILL.md, return slugs whose
 * content has drifted from `local_hash`. These are the candidates for
 * `publish --all`'s update half.
 */
async function detectDriftedInstalled(manifest: Manifest): Promise<string[]> {
  const drifted: string[] = [];
  const { readFile } = await import("node:fs/promises");
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (entry.local_hash === undefined) continue;
    const file = join(SKILLS_STORE, name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const raw = await readFile(file, "utf8");
      if (hashContent(raw) !== entry.local_hash) drifted.push(name);
    } catch {
      // unreadable; skip
    }
  }
  return drifted;
}
