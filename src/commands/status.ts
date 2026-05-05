import chalk from "chalk";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { getScope } from "../scope.js";
import { ntnDoctor, ntnVersion } from "../ntn.js";
import { readManifest } from "../manifest.js";
import { KNOWN_TARGETS } from "../known-targets.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import { targetsForKeys } from "../targets.js";

export async function statusCommand(): Promise<void> {
  console.log(chalk.bold("Auth (via ntn)"));
  const version = await ntnVersion();
  if (version) {
    const versionLabel = version.replace(/^ntn\s+/, "");
    const doctor = await ntnDoctor();
    if (doctor.ok) {
      console.log(chalk.green(`  ✓ ntn ${versionLabel} authenticated`));
    } else {
      console.log(chalk.yellow(`  ! ntn ${versionLabel} not authenticated — run \`ntn login\``));
    }
  } else {
    console.log(chalk.red("  ✗ ntn not installed"));
    console.log(chalk.dim("    Install: https://github.com/makenotion/cli"));
  }
  console.log("");

  const scope = await getScope();
  console.log(chalk.bold("Scope"));
  if (scope) {
    console.log(`  database: ${scope.database_title ?? scope.database_id}`);
    console.log(`  targets:  ${scope.targets.join(", ") || chalk.dim("(none)")}`);
    const filterDesc = describeFilter(scope.filter);
    if (filterDesc) console.log(`  filter:   ${filterDesc}`);

    const manifest = await readManifest(MANIFEST_FILE);
    if (manifest) {
      const count = Object.keys(manifest.skills).length;
      console.log(`  synced:   ${count} skills, last ${manifest.last_synced_at}`);

      const targets = targetsForKeys(scope.targets);
      for (const t of targets) {
        let ok = 0;
        let broken = 0;
        let missing = 0;
        for (const name of Object.keys(manifest.skills)) {
          const link = join(t.dir, name);
          const real = join(SKILLS_STORE, name);
          if (!existsSync(link) && !safeLstatExists(link)) {
            missing++;
          } else if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === real) {
            ok++;
          } else {
            broken++;
          }
        }
        console.log(
          chalk.dim(
            `    ${t.label.padEnd(14)} ${ok} ok, ${broken} broken, ${missing} missing`,
          ),
        );
      }
    } else {
      console.log(chalk.dim("  never synced"));
    }
  } else {
    console.log(chalk.dim("  not configured — run `notion-skills init`"));
  }
  console.log("");

  console.log(chalk.dim("Known target dirs:"));
  for (const t of KNOWN_TARGETS) {
    const exists = existsSync(t.dir);
    console.log(chalk.dim(`  ${t.label.padEnd(14)} ${t.dir} ${exists ? "✓" : "○"}`));
  }
}

function describeFilter(filter: {
  include_tags?: string[];
  exclude_tags?: string[];
  include_skills?: string[];
  exclude_skills?: string[];
}): string {
  const parts: string[] = [];
  if (filter.include_tags?.length) parts.push(`+tags=${filter.include_tags.join(",")}`);
  if (filter.exclude_tags?.length) parts.push(`-tags=${filter.exclude_tags.join(",")}`);
  if (filter.include_skills?.length) parts.push(`+${filter.include_skills.join(",")}`);
  if (filter.exclude_skills?.length) parts.push(`-${filter.exclude_skills.join(",")}`);
  return parts.length === 0 ? chalk.dim("(none)") : parts.join("  ");
}

function safeLstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
