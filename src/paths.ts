import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const ROOT_DIR = join(HOME, ".notion-skills");
export const SCOPE_FILE = join(ROOT_DIR, "scope.json");
export const MANIFEST_FILE = join(ROOT_DIR, "manifest.json");
export const SKILLS_STORE = join(ROOT_DIR, "skills");

export const PROJECT_SCOPE_FILENAME = ".notion-skills.json";
export const PROJECT_LOCK_FILENAME = ".notion-skills.lock";
export const PROJECT_SKILLS_RELATIVE = ".claude/skills";

export const KNOWN_TARGETS = {
  claude: { label: "Claude Code", dir: join(HOME, ".claude", "skills") },
  codex: { label: "Codex CLI", dir: join(HOME, ".codex", "skills") },
} as const;

export type TargetKey = keyof typeof KNOWN_TARGETS;
