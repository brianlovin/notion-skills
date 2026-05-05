import { execSync } from "node:child_process";

/**
 * Registry of coding-agent CLIs we know how to hand a generation prompt
 * to. Each entry knows the binary name plus how to pass the prompt
 * (positional, stdin, or a specific flag) and any extra args.
 *
 * Keep keys aligned with src/known-targets.ts where applicable, so we
 * can bias the picker toward the user's existing sync targets.
 *
 * Every agent here launches **headless** — runs once, writes the
 * SKILL.md, and exits. Interactive mode looks live but leaves the
 * agent sitting in a REPL after its turn, which means our post-exit
 * migrate step never fires until the user manually `/exit`s. The flags
 * below pre-approve file writes so the agent can complete its job
 * without permission prompts that would block in non-TTY mode anyway.
 */
export interface GenAgentDef {
  /** Stable key persisted in scope.json's `gen_agent` field. */
  key: string;
  /** Human-readable label for the picker. */
  label: string;
  /** Binary name as installed on PATH. */
  bin: string;
  /** Where to put the prompt when invoking. */
  passPromptVia: "stdin" | "positional" | "-p";
  /** Extra args injected before the prompt. */
  extraArgs: readonly string[];
}

export const GEN_AGENTS: GenAgentDef[] = [
  {
    // claude --print --output-format text --allowedTools=Write,Read,WebFetch "<prompt>"
    //   --print:                run once, print response, exit.
    //   --output-format text:   stream text output to stdout so the user
    //                           sees progress live.
    //   --allowedTools=Write,…: pre-approve exactly the tools the agent
    //                           needs to write a SKILL.md. Without this,
    //                           Write of a new file falls through the
    //                           default permission gate and the agent
    //                           prints "(pending your approval)" then
    //                           exits without writing.
    //   We use the `=` syntax (vs. space-separated) because
    //   `--allowedTools` is variadic and would otherwise eat the prompt.
    //   `--permission-mode acceptEdits` doesn't help here — it covers
    //   editing existing files but not creating new ones.
    key: "claude",
    label: "Claude",
    bin: "claude",
    passPromptVia: "-p",
    extraArgs: [
      "--output-format",
      "text",
      "--allowedTools=Write,Read,WebFetch",
    ],
  },
  {
    // codex exec --full-auto "<prompt>"
    //   exec:        non-interactive run-and-exit mode.
    //   --full-auto: low-friction sandboxed automatic execution
    //                (auto-approve everything codex will do, sandboxed
    //                to the working dir).
    key: "codex",
    label: "Codex",
    bin: "codex",
    passPromptVia: "positional",
    extraArgs: ["exec", "--full-auto"],
  },
  {
    // opencode run "<prompt>" — non-interactive run.
    key: "opencode",
    label: "OpenCode",
    bin: "opencode",
    passPromptVia: "positional",
    extraArgs: ["run"],
  },
  {
    // gemini --prompt "<prompt>" — non-interactive print mode.
    key: "gemini",
    label: "Gemini",
    bin: "gemini",
    passPromptVia: "-p",
    extraArgs: [],
  },
];

export function findGenAgent(key: string): GenAgentDef | undefined {
  return GEN_AGENTS.find((a) => a.key === key);
}

export function isAgentInstalled(agent: GenAgentDef): boolean {
  try {
    execSync(`command -v ${agent.bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectAvailableAgents(): GenAgentDef[] {
  return GEN_AGENTS.filter(isAgentInstalled);
}

export interface SpawnArgs {
  args: string[];
  stdin?: string;
}

/**
 * Build the argv (and stdin payload, if applicable) for handing `prompt`
 * to `agent`. Pure function — no spawning, no FS access — so the contract
 * is unit-testable for every supported agent.
 */
export function buildAgentSpawnArgs(
  agent: GenAgentDef,
  prompt: string,
): SpawnArgs {
  const args = [...agent.extraArgs];
  if (agent.passPromptVia === "stdin") {
    return { args, stdin: prompt };
  }
  if (agent.passPromptVia === "-p") {
    return { args: [...args, "-p", prompt] };
  }
  return { args: [...args, prompt] };
}
