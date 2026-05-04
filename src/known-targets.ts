/**
 * Registry of agent-CLI targets that notion-skills can sync skills into.
 *
 * # Adding a new target
 *
 * Append a TargetDef entry to KNOWN_TARGETS. If the agent reads
 * `<dir>/<skill-name>/SKILL.md` (the de-facto convention every modern AI
 * CLI has settled on), set `kind: "skill_dir"` and you're done.
 *
 * The `kind` field is here so a future agent that wraps skills in some
 * manifest format can plug in a different adapter without churning
 * KNOWN_TARGETS' shape.
 *
 * Sources for paths:
 *  - Claude Code: https://code.claude.com/docs/en/skills
 *  - Codex: https://github.com/openai/codex
 *  - OpenCode: https://opencode.ai/docs/skills
 *  - Cursor: https://docs.cursor.com
 *  - Gemini CLI: https://geminicli.com/docs/cli/tutorials/skills-getting-started/
 */

import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || join(HOME, ".config");

/**
 * How skills are laid out under a target's root dir.
 *   skill_dir → <dir>/<skill-name>/SKILL.md
 */
export type TargetKind = "skill_dir";

export interface TargetDef {
  /** Stable key stored in scope.json's `targets` array. */
  key: string;
  /** Human-readable label shown in init's checkbox prompt. */
  label: string;
  /** The directory we write or symlink skills into. */
  dir: string;
  /** Layout shape under that dir. */
  kind: TargetKind;
  /** Optional doc link for users. */
  docs?: string;
}

export const KNOWN_TARGETS: TargetDef[] = [
  {
    key: "claude",
    label: "Claude Code",
    dir: join(HOME, ".claude", "skills"),
    kind: "skill_dir",
    docs: "https://code.claude.com/docs/en/skills",
  },
  {
    key: "codex",
    label: "Codex CLI",
    dir: join(HOME, ".codex", "skills"),
    kind: "skill_dir",
    docs: "https://github.com/openai/codex",
  },
  {
    key: "opencode",
    // OpenCode also reads ~/.claude/skills as a fallback, so syncing to
    // "claude" already covers OpenCode for free. This entry is for users
    // who want OpenCode-only skills.
    label: "OpenCode",
    dir: join(XDG_CONFIG, "opencode", "skills"),
    kind: "skill_dir",
    docs: "https://opencode.ai/docs/skills",
  },
  {
    key: "cursor",
    label: "Cursor",
    dir: join(HOME, ".cursor", "skills"),
    kind: "skill_dir",
    docs: "https://docs.cursor.com",
  },
  {
    key: "gemini",
    label: "Gemini CLI",
    dir: join(HOME, ".gemini", "skills"),
    kind: "skill_dir",
    docs: "https://geminicli.com/docs/cli/tutorials/skills-getting-started/",
  },
];

export function findTargetByKey(key: string): TargetDef | undefined {
  return KNOWN_TARGETS.find((t) => t.key === key);
}
