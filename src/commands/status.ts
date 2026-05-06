import chalk from "chalk";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { getScope } from "../scope.js";
import { ntnDoctor, ntnVersion } from "../ntn.js";
import { readManifest } from "../manifest.js";
import { KNOWN_TARGETS } from "../known-targets.js";
import { MANIFEST_FILE, SKILLS_STORE } from "../paths.js";
import { targetsForKeys } from "../targets.js";
import { defaultSource } from "../sources.js";

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
  console.log(chalk.bold("Sources"));
  if (scope && scope.sources.length > 0) {
    for (const s of scope.sources) {
      const flag = s.default ? chalk.green("default ") : "";
      console.log(`  ${flag}${chalk.bold(s.key)} ${chalk.dim(`— ${s.name}`)}`);
    }
    console.log(`  targets: ${scope.targets.join(", ") || chalk.dim("(none)")}`);

    const defKey = defaultSource(scope.sources)?.key ?? scope.sources[0]!.key;
    const manifest = await readManifest(MANIFEST_FILE, defKey);
    if (manifest) {
      const count = Object.keys(manifest.skills).length;
      console.log(`  synced: ${count} skills, last ${manifest.last_synced_at}`);

      const targets = targetsForKeys(scope.targets);
      for (const t of targets) {
        let ok = 0;
        let broken = 0;
        let missing = 0;
        for (const localSlug of Object.keys(manifest.skills)) {
          const link = join(t.dir, localSlug);
          const real = join(SKILLS_STORE, localSlug);
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

function safeLstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
