import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { migrateCommand } from "./migrate.js";
import { SKILLS_STORE } from "../paths.js";

interface PublishOptions {
  all?: boolean;
  yes?: boolean;
}

/**
 * Push local skills to the workspace skill store. Two modes:
 *
 * - `publish <slug>` — push the named skill (must exist in the central
 *   store; gen or hand-author it first). Updates the existing Notion
 *   page if there is one, or creates it.
 * - `publish --all` — discover every local-only skill (in the central
 *   store but not yet in the manifest) and push them.
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
  }

  await migrateCommand({
    yes: opts.yes,
    only: opts.all ? undefined : slugs,
  });

  if (opts.all && slugs.length === 0) {
    // After --all, point the user at next steps.
    console.log(chalk.dim("\nRun `notion-skills list` to verify."));
  }
}
