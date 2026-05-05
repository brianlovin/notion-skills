import chalk from "chalk";
import { getScope } from "../scope.js";
import { printSummary, runSync } from "../sync.js";
import { discoverSkills } from "../migrate.js";
import { migrateCommand } from "./migrate.js";
import { KNOWN_TARGETS } from "../known-targets.js";
import { pickLocalSkillsToUpload } from "./_pick-locals.js";

export async function syncCommand(): Promise<void> {
  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  console.log(chalk.bold(`\nSyncing ${scope.database_title ?? "database"}`));
  const summary = await runSync(scope);
  printSummary(summary);

  // After the pull half completes, look for local skills that aren't in
  // Notion. These could be either freshly-authored locals or skills the
  // user declined to delete during the bias-against-deletion prompt.
  // Scope to the user's configured target dirs only — surfacing a skill
  // from an agent the user didn't pick would suggest migrating it, but
  // migrate runs against scope.targets and would skip it.
  const targetDirs = scope.targets
    .map((k) => KNOWN_TARGETS.find((t) => t.key === k)?.dir)
    .filter((d): d is string => !!d);
  const found = await discoverSkills({ sourceDirs: targetDirs });
  const newCandidates = found.filter((c) => c.kind === "new");

  if (newCandidates.length > 0 && process.stdin.isTTY) {
    const picked = await pickLocalSkillsToUpload(
      newCandidates.flatMap((c) => (c.kind === "new" ? [c.skill] : [])),
    );
    if (picked.length > 0) {
      await migrateCommand({ yes: true, only: picked });
    }
  }
}
