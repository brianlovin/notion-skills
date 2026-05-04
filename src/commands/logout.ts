import chalk from "chalk";
import { spawn } from "node:child_process";
import { assertNtnInstalled } from "../ntn.js";

export async function logoutCommand(): Promise<void> {
  await assertNtnInstalled();

  console.log(chalk.dim("Running `ntn logout`...\n"));

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ntn", ["logout"], { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ntn logout exited with code ${code}`));
    });
  });
}
