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

// Target keys are validated against the registry in src/known-targets.ts
// at runtime. Stored in scope.json's `targets: ["claude", "codex", ...]`.
export type TargetKey = string;
