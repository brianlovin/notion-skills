/**
 * Single source of truth for the Notion → SKILL.md frontmatter mapping.
 *
 * Each entry describes how a Notion property column corresponds to a key in
 * the Claude Code skill spec (https://code.claude.com/docs/en/skills).
 *
 * `kind` controls the type-specific read/write logic:
 *   - "title"      → page title; the only required, name-bearing property
 *   - "rich_text"  → plain string; empty cell omits the frontmatter key
 *   - "checkbox"   → boolean
 *   - "select"     → string from a fixed option set; "default" / empty omit
 *   - "list_text"  → list serialised as space- or comma-separated rich_text
 *
 * Selects that have a spec default expose a "default" option; the empty cell
 * also maps to "default" for users who haven't picked anything.
 */

export const SELECT_DEFAULT = "default";

export type PropertyKind =
  | "title"
  | "rich_text"
  | "checkbox"
  | "select"
  | "list_text";

export interface SelectOption {
  name: string;
  color?: string;
}

export interface PropertyDef {
  /** Notion column name. Title-cased. */
  notionName: string;
  /** SKILL.md frontmatter key. Spec-canonical (kebab-case where applicable). */
  frontmatterKey: string;
  kind: PropertyKind;
  /** For "select" kind. The first option, by convention, is "default". */
  options?: SelectOption[];
  /** For "list_text", how to serialise list ↔ rich_text */
  listSeparator?: " " | ", ";
  /** Human description shown in upgrade output */
  description?: string;
  /**
   * For "select" kind: whether unknown option values encountered during
   * migrate should be added to the property's option list automatically.
   * Used for fields with open-ended values (custom agent names, new
   * model IDs) where Notion's strict select would otherwise reject the
   * value.
   */
  selfHealing?: boolean;
}

const MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "inherit"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Order matters for two reasons:
 *   1. The first entry must be the title property.
 *   2. Frontmatter is emitted in this order, giving stable output.
 */
export const SCHEMA: PropertyDef[] = [
  {
    notionName: "Name",
    frontmatterKey: "name",
    kind: "title",
    description: "Skill slug (page title)",
  },
  {
    notionName: "Description",
    frontmatterKey: "description",
    kind: "rich_text",
    description: "When-to-use one-liner for Claude (recommended)",
  },
  {
    notionName: "When To Use",
    frontmatterKey: "when_to_use",
    kind: "rich_text",
    description: "Additional trigger context appended to description",
  },
  {
    notionName: "Argument Hint",
    frontmatterKey: "argument-hint",
    kind: "rich_text",
    description: "Autocomplete hint, e.g. [filename] [format]",
  },
  {
    notionName: "Arguments",
    frontmatterKey: "arguments",
    kind: "list_text",
    listSeparator: " ",
    description: "Named positional arguments, space-separated",
  },
  {
    notionName: "Allowed Tools",
    frontmatterKey: "allowed-tools",
    kind: "list_text",
    listSeparator: " ",
    description: "Tools usable without permission, space-separated",
  },
  {
    notionName: "Paths",
    frontmatterKey: "paths",
    kind: "list_text",
    listSeparator: ", ",
    description: "Glob patterns to scope auto-activation, comma-separated",
  },
  {
    notionName: "Disable Model Invocation",
    frontmatterKey: "disable-model-invocation",
    kind: "select",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "true", color: "red" },
      { name: "false", color: "gray" },
    ],
    description: "Set to true to make manual-only (default: false)",
  },
  {
    notionName: "User Invocable",
    frontmatterKey: "user-invocable",
    kind: "select",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "true", color: "gray" },
      { name: "false", color: "red" },
    ],
    description: "Set to false to hide from / menu (default: true)",
  },
  {
    notionName: "Model",
    frontmatterKey: "model",
    kind: "select",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      ...MODELS.map((m) => ({ name: m, color: "blue" })),
    ],
    selfHealing: true,
    description: "Model override. Self-healing — new model IDs auto-added on migrate.",
  },
  {
    notionName: "Effort",
    frontmatterKey: "effort",
    kind: "select",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      ...EFFORTS.map((e) => ({ name: e, color: "yellow" })),
    ],
    description: "Effort level when this skill is active",
  },
  {
    notionName: "Context",
    frontmatterKey: "context",
    kind: "select",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "fork", color: "purple" },
    ],
    description: "Set to 'fork' to run in a forked subagent context",
  },
  {
    notionName: "Agent",
    frontmatterKey: "agent",
    kind: "select",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "general-purpose", color: "gray" },
      { name: "Explore", color: "blue" },
      { name: "Plan", color: "purple" },
    ],
    selfHealing: true,
    description: "Subagent type (used with context: fork). Self-healing — new options auto-added on sync.",
  },
  {
    notionName: "Shell",
    frontmatterKey: "shell",
    kind: "select",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "bash", color: "default" },
      { name: "powershell", color: "blue" },
    ],
    description: "Shell for inline command injection (default: bash)",
  },
];

/**
 * Spec defaults. Sync omits the frontmatter key when the read value matches
 * the default; migrate leaves the property unset when the frontmatter omits
 * the key. Booleans are spec-canonical strings so they parse cleanly from
 * select options.
 */
export const SPEC_DEFAULTS: Record<string, string | undefined> = {
  "disable-model-invocation": "false",
  "user-invocable": "true",
  shell: "bash",
};

export function findProperty(notionName: string): PropertyDef | undefined {
  return SCHEMA.find((p) => p.notionName === notionName);
}

export function findPropertyByFrontmatterKey(key: string): PropertyDef | undefined {
  return SCHEMA.find((p) => p.frontmatterKey === key);
}
