import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getScope } from "../scope.js";
import { loadManifest } from "../manifest.js";
import { SKILLS_STORE } from "../paths.js";
import { NotionClient, type NotionComment } from "../notion.js";
import { assertNtnInstalled } from "../ntn.js";
import { parseSkillRef, type Source } from "../sources.js";
import { findPageInSource } from "./_resolve.js";
import { withSpinner } from "./_progress.js";
import { formatRelativeTime } from "../time.js";

interface FeedbackOptions {
  source?: string;
}

/**
 * Read or post comments on a skill's Notion page. Comments are how
 * teammates and agents leave feedback without leaving their workflow —
 * the maintainer sees them where they already live (in Notion).
 *
 * - `feedback <slug>` — list existing comments newest-first
 * - `feedback <slug> "<message>"` — post a comment
 *
 * Slug resolution mirrors `open`: prefer the manifest's local_slug,
 * fall back to scanning configured sources by slugified title. Drafts
 * (no Notion page) error out with a hint to publish first.
 *
 * Author attribution is intentionally absent from the CLI output —
 * Personal Access Tokens (which `ntn login` produces) can only resolve
 * the calling user's identity, so we'd be rendering "you" vs "someone"
 * which is more misleading than informative. Notion's UI shows the
 * full author of every comment; jump there with `notion-skills open`
 * if attribution matters.
 */
export async function feedbackCommand(
  slug: string,
  messageParts: string[],
  opts: FeedbackOptions,
): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error("No scope configured. Run `notion-skills init` first.");
  }
  if (scope.sources.length === 0) {
    throw new Error("No sources configured. Run `notion-skills source add` to link a Notion database.");
  }
  await assertNtnInstalled();

  // Slugs are lowercase by convention (slugify lowercases titles); be
  // permissive on input so case mismatches don't cause "not found."
  const normalisedSlug = slug.toLowerCase();

  // Distinguish read-mode (no message provided at all) from a typo'd
  // post (message provided but whitespace-only after trim). Falling
  // through to read silently would surprise the user who clearly
  // wanted to post.
  const messageProvided = messageParts.length > 0;
  const message = messageParts.join(" ").trim();
  if (messageProvided && !message) {
    throw new Error(
      "Comment is empty after trimming. Pass a non-empty message, or drop the argument to read existing comments.",
    );
  }

  const resolved = await resolvePage(normalisedSlug, scope.sources, opts.source);

  const client = new NotionClient();

  if (message) {
    await postFeedback(client, resolved, message);
    return;
  }
  await readFeedback(client, resolved);
}

interface ResolvedPage {
  pageId: string;
  source: Source;
  /** What we'll show the user — `team/deploy` style. */
  ref: string;
}

async function resolvePage(
  slug: string,
  sources: Source[],
  sourceFlag: string | undefined,
): Promise<ResolvedPage> {
  const ref = parseSkillRef(slug);
  // Explicit `--source` or `team/deploy` qualified ref both narrow
  // search to a single source.
  const sourceKey = sourceFlag ?? ref.sourceKey;
  const candidates = sourceKey
    ? sources.filter((s) => s.key === sourceKey)
    : sources;
  if (sourceKey && candidates.length === 0) {
    throw new Error(
      `Unknown source "${sourceKey}". Configured sources: ${sources.map((s) => s.key).join(", ")}.`,
    );
  }

  // Fast path: manifest hit on local_slug. The manifest's source_key
  // is what tells us which Source the page lives in.
  const manifest = await loadManifest(sources);
  const entry = manifest?.skills[ref.slug];
  if (entry) {
    const source = sources.find((s) => s.key === entry.source_key);
    if (source && (!sourceKey || source.key === sourceKey)) {
      return {
        pageId: entry.page_id,
        source,
        ref: `${source.key}/${entry.source_slug}`,
      };
    }
  }

  // Local draft (on disk, no manifest entry) → no Notion page yet.
  if (existsSync(join(SKILLS_STORE, ref.slug))) {
    throw new Error(
      `${ref.slug} is a local draft — there's no Notion page to comment on yet. Run \`notion-skills publish ${ref.slug}\` first.`,
    );
  }

  // Slow path: scan source data sources for a matching slugified title.
  const client = new NotionClient();
  for (const s of candidates) {
    const found = await withSpinner(
      `Searching ${s.key} for "${ref.slug}"`,
      () => findPageInSource(client, s, ref.slug),
    );
    if (found) {
      return { pageId: found, source: s, ref: `${s.key}/${ref.slug}` };
    }
  }

  throw new Error(
    `Skill "${slug}" not found. Run \`notion-skills list\` to see what's in the store.`,
  );
}

async function postFeedback(
  client: NotionClient,
  resolved: ResolvedPage,
  message: string,
): Promise<void> {
  const comment = await withSpinner(
    `Posting comment on ${resolved.ref}`,
    () => client.postComment(resolved.pageId, message),
  );
  const url = notionPageUrl(resolved.pageId);
  console.log();
  console.log(chalk.green("✓") + ` Posted to ${chalk.bold(resolved.ref)}`);
  console.log(`  ${chalk.dim(url)}`);
  // Suppress unused warning — `comment` is the postComment response;
  // we don't need its id beyond confirming the call succeeded.
  void comment;
}

async function readFeedback(
  client: NotionClient,
  resolved: ResolvedPage,
): Promise<void> {
  const comments = await withSpinner(
    `Reading comments on ${resolved.ref}`,
    () => client.listComments(resolved.pageId),
    { noteFor: (c) => `${c.length} comment${c.length === 1 ? "" : "s"}` },
  );

  console.log();
  console.log(chalk.bold(`Comments on ${resolved.ref}`));
  console.log(chalk.dim(notionPageUrl(resolved.pageId)));
  console.log();

  if (comments.length === 0) {
    console.log(chalk.dim("  No comments yet."));
    console.log();
  } else {
    // Newest-first reads more naturally — most recent feedback is what
    // the user wants to see when they're triaging a skill.
    for (const c of [...comments].reverse()) renderComment(c);
  }

  console.log(
    chalk.dim(
      `To post: ${chalk.cyan(`notion-skills feedback ${resolved.ref} "<message>"`)}`,
    ),
  );
}

function renderComment(comment: NotionComment): void {
  const when = formatRelativeTime(new Date(comment.created_time));
  const body = comment.rich_text.map((r) => r.plain_text).join("").trim();

  console.log(`  ${chalk.dim(when)}`);
  // Indent each line of the body so multi-line comments stay grouped.
  for (const line of body.split("\n")) {
    console.log(`    ${line}`);
  }
  console.log();
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}
