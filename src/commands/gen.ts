import chalk from "chalk";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { select } from "@inquirer/prompts";
import { getScope, writeScope } from "../scope.js";
import {
  GEN_AGENTS,
  buildAgentSpawnArgs,
  detectAvailableAgents,
  findGenAgent,
  type GenAgentDef,
} from "../gen-agents.js";
import { buildGenPrompt } from "../gen-prompt.js";
import { SKILLS_STORE } from "../paths.js";
import { migrateCommand } from "./migrate.js";

interface GenOptions {
  agent?: string;
}

export async function genCommand(
  input: string,
  options: GenOptions,
): Promise<void> {
  if (!input || !input.trim()) {
    throw new Error("Usage: notion-skills gen <url|path|prompt>");
  }

  const scope = await getScope();
  if (!scope) {
    throw new Error(
      "No scope configured. Run `notion-skills init` first.",
    );
  }

  // Resolve agent: --agent flag wins, then scope.gen_agent, then prompt.
  let agentKey = options.agent ?? scope.gen_agent;
  if (!agentKey) {
    agentKey = await pickAgent(scope.targets);
    // Persist the choice so subsequent `gen` runs are zero-config.
    await writeScope({ ...scope, gen_agent: agentKey });
    console.log(chalk.dim(`Saved gen_agent = ${agentKey} to scope.json`));
  }

  const agent = findGenAgent(agentKey);
  if (!agent) {
    const valid = GEN_AGENTS.map((a) => a.key).join(", ");
    throw new Error(
      `Unknown coding agent "${agentKey}". Valid options: ${valid}`,
    );
  }

  await mkdir(SKILLS_STORE, { recursive: true });

  const prompt = buildGenPrompt(input);
  const { args, stdin } = buildAgentSpawnArgs(agent, prompt);

  console.log(chalk.bold(`Handing off to ${agent.label}.`));
  console.log(chalk.dim(`Input: ${truncate(input, 100)}`));
  console.log(
    chalk.dim(
      `The agent will write a SKILL.md to ~/.notion-skills/skills/<slug>/ and exit. notion-skills will then push it to Notion.`,
    ),
  );
  console.log("");

  await runAgent(agent, args, stdin);

  // Always reconcile after the agent exits. Migrate is a no-op when
  // every local skill is already in Notion, so it costs nothing in the
  // happy case; in the recovery case (a previous gen left a local-only
  // skill behind) it pushes what the user expected to ship. Don't try
  // to detect "did this gen produce something new" — that's a guess
  // and the user expects gen-then-migrate to be a single atomic step.
  console.log("");
  console.log(chalk.bold(`Pushing local skills to Notion...`));
  await migrateCommand({ yes: true });
}

async function pickAgent(scopeTargets: string[]): Promise<string> {
  const available = detectAvailableAgents();
  if (available.length === 0) {
    const valid = GEN_AGENTS.map((a) => a.bin).join(", ");
    throw new Error(
      `No supported coding agents found on PATH. Install one of: ${valid}.`,
    );
  }

  const choices = available.map((a) => {
    const inTargets = scopeTargets.includes(a.key);
    return {
      name: inTargets ? `${a.label} ${chalk.dim("(your sync target)")}` : a.label,
      value: a.key,
    };
  });
  // Bias the default toward an agent that's also a sync target — these
  // are the tools the user actively uses.
  const def =
    available.find((a) => scopeTargets.includes(a.key))?.key ??
    available[0]!.key;

  return select({
    message: "Which agent should generate skills?",
    choices,
    default: def,
  });
}

function runAgent(
  agent: GenAgentDef,
  args: string[],
  stdin?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(agent.bin, args, {
      stdio: [stdin !== undefined ? "pipe" : "inherit", "inherit", "inherit"],
      env: process.env,
    });
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(new Error(`Could not find \`${agent.bin}\` on PATH.`));
      } else {
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${agent.bin} exited with code ${code}`));
    });
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
