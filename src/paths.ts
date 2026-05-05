import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const ROOT_DIR = join(HOME, ".notion-skills");
export const SCOPE_FILE = join(ROOT_DIR, "scope.json");
export const MANIFEST_FILE = join(ROOT_DIR, "manifest.json");
export const SKILLS_STORE = join(ROOT_DIR, "skills");

// Target keys are validated against the registry in src/known-targets.ts at
// runtime; stored in scope.json's `targets: ["claude", "codex", ...]`.
export type TargetKey = string;
