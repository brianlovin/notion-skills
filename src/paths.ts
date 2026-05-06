import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const ROOT_DIR = join(HOME, ".notion-skills");
export const SCOPE_FILE = join(ROOT_DIR, "scope.json");
export const MANIFEST_FILE = join(ROOT_DIR, "manifest.json");
export const LOGS_DIR = join(ROOT_DIR, "logs");
export const NTN_ERROR_LOG = join(LOGS_DIR, "ntn-errors.log");
/**
 * The one and only place skills live on disk. Skills synced from Notion
 * land here; skills authored locally (by `gen` or by hand) are written
 * here directly. The manifest tells us which entries are also in Notion;
 * everything else is a local-only skill that `migrate` will push.
 */
export const SKILLS_STORE = join(ROOT_DIR, "skills");

// Target keys are validated against the registry in src/known-targets.ts at
// runtime; stored in scope.json's `targets: ["claude", "codex", ...]`.
export type TargetKey = string;
