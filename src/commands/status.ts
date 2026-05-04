import chalk from "chalk";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findProjectScopePath,
  readGlobalScope,
  readProjectScope,
} from "../scope.js";
import { ntnDoctor, ntnVersion } from "../ntn.js";
import { readManifest } from "../manifest.js";
import {
  KNOWN_TARGETS,
  MANIFEST_FILE,
  PROJECT_LOCK_FILENAME,
  PROJECT_SKILLS_RELATIVE,
  SKILLS_STORE,
} from "../paths.js";
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
    console.log(chalk.dim("    Install: https://github.com/makenotion/ntn-cli"));
  }
  console.log("");

  const global = await readGlobalScope();
  console.log(chalk.bold("Global scope"));
  if (global) {
    console.log(`  database: ${global.database_title ?? global.database_id}`);
    console.log(`  targets:  ${global.targets.join(", ") || chalk.dim("(none)")}`);
    const filterDesc = describeFilter(global.filter);
    if (filterDesc) console.log(`  filter:   ${filterDesc}`);

    const manifest = await readManifest(MANIFEST_FILE);
    if (manifest) {
      const count = Object.keys(manifest.skills).length;
      console.log(`  synced:   ${count} skills, last ${manifest.last_synced_at}`);

      const targets = targetsForKeys(global.targets);
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
    console.log(chalk.dim("  not configured"));
  }
  console.log("");

  const projPath = findProjectScopePath(process.cwd());
  console.log(chalk.bold("Project scope"));
  if (projPath) {
    const project = await readProjectScope(projPath);
    if (project) {
      console.log(`  config:   ${project.path}`);
      console.log(`  database: ${project.database_title ?? project.database_id}`);
      const filterDesc = describeFilter(project.filter);
      if (filterDesc) console.log(`  filter:   ${filterDesc}`);
      const manifest = await readManifest(resolve(project.root, PROJECT_LOCK_FILENAME));
      if (manifest) {
        const count = Object.keys(manifest.skills).length;
        console.log(`  synced:   ${count} skills, last ${manifest.last_synced_at}`);
        console.log(chalk.dim(`    written to ${resolve(project.root, PROJECT_SKILLS_RELATIVE)}`));
      } else {
        console.log(chalk.dim("  never synced"));
      }
    }
  } else {
    console.log(chalk.dim("  none in current tree"));
  }
  console.log("");

  console.log(chalk.dim("Known target dirs:"));
  for (const [, info] of Object.entries(KNOWN_TARGETS)) {
    const exists = existsSync(info.dir);
    console.log(chalk.dim(`  ${info.label.padEnd(14)} ${info.dir} ${exists ? "✓" : "○"}`));
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
