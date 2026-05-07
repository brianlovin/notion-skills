import chalk from "chalk";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
import { loadManifest } from "../manifest.js";
import {
  ensureSymlink,
  targetSkillPath,
  targetsForKeys,
} from "../targets.js";

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
  const skillsBefore = listSkillDirs(SKILLS_STORE);

  const prompt = buildGenPrompt(input);
  const { args, stdin } = buildAgentSpawnArgs(agent, prompt);

  console.log(chalk.bold(`Handing off to ${agent.label}.`));
  console.log(chalk.dim(`Input: ${truncate(input, 100)}`));
  console.log(
    chalk.dim(
      `The agent will write a SKILL.md to ~/.notion-skills/skills/<slug>/ and exit. The new skill is local-first — review it, then run \`notion-skills publish <slug>\` to share with your team.`,
    ),
  );
  console.log("");

  await runAgent(agent, args, stdin);

  // Fan symlinks out to every configured target dir for any new
  // central-store entry. This makes the draft immediately invokable
  // (`/<slug>` in Claude Code, etc.) so the user can test before
  // publishing. We don't push to Notion — that's the publish step.
  const added = newSkillDirs(SKILLS_STORE, skillsBefore);
  if (added.length > 0) {
    const manifest = await loadManifest(scope.sources);
    const trackedNames = new Set(
      manifest ? Object.keys(manifest.skills) : [],
    );
    const targets = targetsForKeys(scope.targets);

    for (const slug of added) {
      const real = join(SKILLS_STORE, slug);
      for (const t of targets) {
        const link = targetSkillPath(t, slug);
        await ensureSymlink(real, link);
      }
    }

    console.log("");
    const newDrafts = added.filter((s) => !trackedNames.has(s));
    if (newDrafts.length === 1) {
      console.log(
        chalk.green(`✓ Drafted ${newDrafts[0]}.`) +
          chalk.dim(` Test it locally, then run `) +
          chalk.bold(`notion-skills publish ${newDrafts[0]}`) +
          chalk.dim(` to share.`),
      );
    } else if (newDrafts.length > 1) {
      console.log(chalk.green(`✓ Drafted ${newDrafts.length} skills:`));
      for (const slug of newDrafts) {
        console.log(`  ${chalk.dim("•")} ${slug}`);
      }
      console.log(
        chalk.dim(`Test locally, then run `) +
          chalk.bold(`notion-skills publish --all`) +
          chalk.dim(` to share.`),
      );
    }

    // Auto-audit each new draft. Surface issues here (gen-time) so
    // the user can fix before publish, not after. Errors don't block
    // gen — the draft is on disk regardless.
    if (newDrafts.length > 0) {
      const { auditSkill, loadAuditTarget, summariseIssues } = await import(
        "../audit.js"
      );
      let any = false;
      for (const slug of newDrafts) {
        const target = await loadAuditTarget(slug, join(SKILLS_STORE, slug));
        if (!target) continue;
        const issues = auditSkill(target);
        if (issues.length === 0) continue;
        if (!any) {
          console.log("");
          any = true;
        }
        const s = summariseIssues(issues);
        const tag =
          s.errors > 0
            ? chalk.red(`✗ ${slug}`)
            : s.warnings > 0
              ? chalk.yellow(`⚠ ${slug}`)
              : chalk.cyan(`ℹ ${slug}`);
        console.log(`  ${tag} ${chalk.dim(`(${issues.length} audit ${issues.length === 1 ? "issue" : "issues"} — run \`notion-skills audit ${slug}\`)`)}`);
      }
    }
  } else {
    console.log("");
    console.log(
      chalk.dim(
        `No new skill written. (Did the agent finish? Try \`notion-skills list --drafts\`.)`,
      ),
    );
  }
}

function listSkillDirs(root: string): Set<string> {
  if (!existsSync(root)) return new Set();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return new Set();
  }
  return new Set(
    entries.filter((e) => {
      if (e.startsWith(".")) return false;
      try {
        return statSync(join(root, e)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
}

function newSkillDirs(root: string, before: Set<string>): string[] {
  return [...listSkillDirs(root)].filter((name) => !before.has(name)).sort();
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
