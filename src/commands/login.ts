import chalk from "chalk";
import { spawn } from "node:child_process";
import { assertNtnInstalled } from "../ntn.js";

export async function loginCommand(): Promise<void> {
  await assertNtnInstalled();

  console.log(
    chalk.dim(
      "notion-skills uses Notion's official CLI for authentication.\n" +
        "Running `ntn login`...\n",
    ),
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ntn", ["login"], { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ntn login exited with code ${code}`));
    });
  });

  console.log(chalk.green(`\n✓ Authenticated. Run \`notion-skills init\` next.`));
}
