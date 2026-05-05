/**
 * Registry of agent-CLI targets that notion-skills can sync skills into.
 *
 * Adding a new agent: append a TargetDef entry. Every agent currently
 * uses the same `<dir>/<skill-name>/SKILL.md` layout, so there's nothing
 * else to configure.
 *
 * Sources:
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

export interface TargetDef {
  /** Stable key stored in scope.json's `targets` array. */
  key: string;
  /** Human-readable label shown in init's checkbox prompt. */
  label: string;
  /** The directory we write or symlink skills into. */
  dir: string;
  /** Optional doc link for users. */
  docs?: string;
}

export const KNOWN_TARGETS: TargetDef[] = [
  {
    key: "claude",
    label: "Claude",
    dir: join(HOME, ".claude", "skills"),
    docs: "https://code.claude.com/docs/en/skills",
  },
  {
    key: "codex",
    label: "Codex",
    dir: join(HOME, ".codex", "skills"),
    docs: "https://github.com/openai/codex",
  },
  {
    // OpenCode also reads ~/.claude/skills as a fallback, so users syncing
    // to "claude" already cover OpenCode for free. This entry is for users
    // who want OpenCode-only skills.
    key: "opencode",
    label: "OpenCode",
    dir: join(XDG_CONFIG, "opencode", "skills"),
    docs: "https://opencode.ai/docs/skills",
  },
  {
    key: "cursor",
    label: "Cursor",
    dir: join(HOME, ".cursor", "skills"),
    docs: "https://docs.cursor.com",
  },
  {
    key: "gemini",
    label: "Gemini",
    dir: join(HOME, ".gemini", "skills"),
    docs: "https://geminicli.com/docs/cli/tutorials/skills-getting-started/",
  },
];

export function findTargetByKey(key: string): TargetDef | undefined {
  return KNOWN_TARGETS.find((t) => t.key === key);
}
