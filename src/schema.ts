/**
 * Single source of truth for the Notion → SKILL.md frontmatter mapping.
 *
 * Each entry describes how a Notion property column corresponds to a key in
 * one of three tiers of the skills ecosystem:
 *
 *   - "core"   — canonical Agent Skills spec (https://agentskills.io).
 *                Required: name, description. Optional: license,
 *                compatibility, allowed-tools, metadata.
 *   - "claude" — Claude Code's frontmatter conventions on top of the spec
 *                (when_to_use, model, agent, effort, etc.). Other agent
 *                providers may add their own tier in the future.
 *   - "notion" — notion-skills infrastructure that lives only in Notion
 *                (Tags, Installs, Published) and never round-trips to
 *                SKILL.md frontmatter.
 *
 * Anything a user adds to the Notion data source that isn't in SCHEMA is
 * surfaced as `metadata.<column-name>` in SKILL.md frontmatter — the spec's
 * official extension point.
 *
 * `kind` controls the type-specific read/write logic:
 *   - "title"        → page title; the only required, name-bearing property
 *   - "rich_text"    → plain string; empty cell omits the frontmatter key
 *   - "checkbox"     → boolean
 *   - "number"       → integer; used for metric-only props like Installs
 *   - "select"       → string from a fixed option set; "default" / empty omit
 *   - "multi_select" → list of strings from an open option set; new options
 *                      auto-added on publish
 *   - "list_text"    → list serialised as space- or comma-separated rich_text
 *
 * Selects that have a spec default expose a "default" option; the empty cell
 * also maps to "default" for users who haven't picked anything.
 */

export const SELECT_DEFAULT = "default";

export type PropertyKind =
  | "title"
  | "rich_text"
  | "checkbox"
  | "number"
  | "select"
  | "multi_select"
  | "list_text";

/**
 * Where this property comes from in the broader skills ecosystem.
 *
 *   - "core"   — defined by the Agent Skills spec.
 *   - "claude" — Claude Code's frontmatter extensions.
 *   - "notion" — notion-skills' own UX/infra (never in SKILL.md).
 *
 * New providers (Codex, Cursor, Gemini, OpenCode) would each get their
 * own tier rather than piling onto "claude". This keeps the spec layer
 * cleanly separable from any one provider's conventions.
 */
export type PropertyTier = "core" | "claude" | "notion";

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
  /** Which layer of the skills ecosystem owns this property. */
  tier: PropertyTier;
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
  /**
   * When true the property exists in Notion but is NOT round-tripped to
   * SKILL.md frontmatter — it's metric/store-managed data, not user
   * content. Examples: Installs (number incremented per install).
   * Frontmatter parsers, payload builders, and progressive-schema
   * derivation all skip these.
   */
  metricOnly?: boolean;
  /**
   * When true the property is round-tripped (it lives in SKILL.md) but
   * doesn't affect how a model executes the skill — it's discovery/
   * curation sugar (Tags). Excluded from the content drift hash so
   * editing tags in Notion never marks a skill as "outdated."
   */
  taxonomyOnly?: boolean;
  /**
   * Visibility default for the table-view list of skills. The four
   * scaffolded views (All / Popular / New / Drafts) only surface a
   * handful of columns by default — most skill-spec properties are
   * relevant when authoring or inspecting a single skill, not when
   * browsing the store. Default is false; flip to true for properties
   * users care about at-a-glance.
   */
  defaultVisibleInListView?: boolean;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Order matters for two reasons:
 *   1. The first entry must be the title property.
 *   2. Frontmatter is emitted in this order, giving stable output.
 */
export const SCHEMA: PropertyDef[] = [
  // ---------- core (Agent Skills spec) ----------
  {
    notionName: "Name",
    frontmatterKey: "name",
    kind: "title",
    tier: "core",
    defaultVisibleInListView: true,
    description: "Skill slug (page title). Spec-required.",
  },
  {
    notionName: "Description",
    frontmatterKey: "description",
    kind: "rich_text",
    tier: "core",
    defaultVisibleInListView: true,
    description: "What the skill does and when to use it. Spec-required, max 1024 chars.",
  },
  {
    notionName: "License",
    frontmatterKey: "license",
    kind: "rich_text",
    tier: "core",
    description: "License name or reference to a bundled LICENSE file. Spec-optional.",
  },
  {
    notionName: "Compatibility",
    frontmatterKey: "compatibility",
    kind: "rich_text",
    tier: "core",
    description: "Environment requirements (intended product, system packages, etc.). Spec-optional, max 500 chars.",
  },
  {
    notionName: "Allowed Tools",
    frontmatterKey: "allowed-tools",
    kind: "list_text",
    tier: "core",
    listSeparator: " ",
    description: "Pre-approved tools the skill may use. Spec-experimental.",
  },
  // ---------- claude (Claude Code conventions) ----------
  {
    notionName: "When To Use",
    frontmatterKey: "when_to_use",
    kind: "rich_text",
    tier: "claude",
    description: "Additional trigger context appended to description (Claude Code).",
  },
  {
    notionName: "Argument Hint",
    frontmatterKey: "argument-hint",
    kind: "rich_text",
    tier: "claude",
    description: "Autocomplete hint, e.g. [filename] [format] (Claude Code).",
  },
  {
    notionName: "Arguments",
    frontmatterKey: "arguments",
    kind: "list_text",
    tier: "claude",
    listSeparator: " ",
    description: "Named positional arguments, space-separated (Claude Code).",
  },
  {
    notionName: "Paths",
    frontmatterKey: "paths",
    kind: "list_text",
    tier: "claude",
    listSeparator: ", ",
    description: "Glob patterns to scope auto-activation, comma-separated (Claude Code).",
  },
  {
    notionName: "Disable Model Invocation",
    frontmatterKey: "disable-model-invocation",
    kind: "select",
    tier: "claude",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "true", color: "red" },
      { name: "false", color: "gray" },
    ],
    description: "Set to true to make manual-only (Claude Code; default: false).",
  },
  {
    notionName: "User Invocable",
    frontmatterKey: "user-invocable",
    kind: "select",
    tier: "claude",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "true", color: "gray" },
      { name: "false", color: "red" },
    ],
    description: "Set to false to hide from / menu (Claude Code; default: true).",
  },
  {
    notionName: "Model",
    frontmatterKey: "model",
    kind: "select",
    tier: "claude",
    // Options start empty; real model IDs are added when migrate encounters
    // them. We don't ship a default list because we can't know which models
    // a user wants to pin to. (selfHealing fills it as you go.)
    options: [{ name: SELECT_DEFAULT, color: "default" }],
    selfHealing: true,
    description: "Model override (Claude Code). Self-healing — model IDs auto-added on publish.",
  },
  {
    notionName: "Effort",
    frontmatterKey: "effort",
    kind: "select",
    tier: "claude",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      ...EFFORTS.map((e) => ({ name: e, color: "yellow" })),
    ],
    description: "Effort level when this skill is active (Claude Code).",
  },
  {
    notionName: "Context",
    frontmatterKey: "context",
    kind: "select",
    tier: "claude",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "fork", color: "purple" },
    ],
    description: "Set to 'fork' to run in a forked subagent context (Claude Code).",
  },
  {
    notionName: "Agent",
    frontmatterKey: "agent",
    kind: "select",
    tier: "claude",
    // Options start empty; subagent type names are added when migrate
    // encounters them. We don't ship a default list because subagent
    // names are project-specific.
    options: [{ name: SELECT_DEFAULT, color: "default" }],
    selfHealing: true,
    description: "Subagent type (Claude Code; used with context: fork). Self-healing.",
  },
  {
    notionName: "Shell",
    frontmatterKey: "shell",
    kind: "select",
    tier: "claude",
    options: [
      { name: SELECT_DEFAULT, color: "default" },
      { name: "bash", color: "default" },
      { name: "powershell", color: "blue" },
    ],
    description: "Shell for inline command injection (Claude Code; default: bash).",
  },
  // ---------- notion (notion-skills infrastructure; never round-tripped) ----------
  {
    // Discovery / curation primitive for the app-store layer. Workspace
    // admins use tags like `featured`, `engineering`, `productivity` to
    // group skills; users filter on them via `notion-skills list --tag`
    // and `notion-skills install --tag`. Options auto-grow on publish
    // (selfHealing) so any new tag a user types becomes a real Notion
    // multi-select option without an upgrade step.
    notionName: "Tags",
    frontmatterKey: "tags",
    kind: "multi_select",
    tier: "notion",
    options: [],
    selfHealing: true,
    taxonomyOnly: true,
    defaultVisibleInListView: true,
    description: "Discovery tags. Self-healing — new tags auto-added on publish.",
  },
  {
    // Per-skill install counter. Incremented +1 by `notion-skills install`
    // on each successful install. Surfaced in `list` so users can spot
    // popular skills. Metric-only — never round-trips into SKILL.md
    // frontmatter (it's store-managed data, not user content).
    notionName: "Installs",
    frontmatterKey: "installs",
    kind: "number",
    tier: "notion",
    metricOnly: true,
    defaultVisibleInListView: true,
    description: "Install count. Auto-incremented by `notion-skills install`.",
  },
  {
    // Draft / ready gate. Unchecked = draft (hidden from `--available`,
    // skipped by bulk install, sorted last in `list`). The act of
    // running `notion-skills publish` checks this; `unpublish` archives
    // the page entirely (separate verb). Backward-compat: when this
    // column is absent from the data source, every row is treated as
    // ready — teams who haven't added the column see no behavior
    // change.
    notionName: "Published",
    frontmatterKey: "published",
    kind: "checkbox",
    tier: "notion",
    metricOnly: true,
    description: "Mark a skill as ready for team consumption. Unchecked = draft.",
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

/**
 * Properties that get created eagerly when a fresh database is set up
 * (or when `init` / `upgrade` runs against a linked DB). The set covers
 * the canonical spec fields plus our notion-skills infrastructure
 * properties — anything users would expect to "just be there" without
 * having to publish a skill that uses each one.
 *
 * Claude-tier properties (when_to_use, model, etc.) are progressive:
 * they get added on demand the first time a skill uses them. This
 * keeps the database UI from looking like a wall of empty Claude-
 * specific columns for users who don't use Claude Code.
 */
export const EAGERLY_CREATED_PROPERTIES = SCHEMA
  .filter((p) => p.tier === "core" || p.tier === "notion")
  .map((p) => p.notionName);

/**
 * Build the `configuration` payload for a Notion table view that pins
 * Name + Description to the left, surfaces only the high-signal
 * columns (Name / Description / Tags / Installs), and hides the rest.
 *
 *   - Visible-by-default columns are emitted in SCHEMA order with
 *     visible: true.
 *   - Other present columns are still listed (so Notion's UI can
 *     render the toggle) but with visible: false.
 *   - Properties not present on the data source (progressive columns
 *     that haven't been added yet) are skipped — Notion would reject
 *     unknown property IDs.
 *
 * The four scaffolded views (All / Popular / New / Drafts) all use
 * this configuration. Users can flip any column on per-view via
 * Notion's UI without losing other view settings.
 */
export interface ViewProperty {
  property_id: string;
  visible: boolean;
}

export interface ViewConfiguration {
  type: "table";
  properties: ViewProperty[];
  frozen_column_index: number;
}

export function buildViewConfiguration(
  propertiesByName: Record<string, { id?: string }>,
): ViewConfiguration {
  const visible: ViewProperty[] = [];
  const hidden: ViewProperty[] = [];
  for (const prop of SCHEMA) {
    const found = propertiesByName[prop.notionName];
    if (!found?.id) continue;
    if (prop.defaultVisibleInListView) {
      visible.push({ property_id: found.id, visible: true });
    } else {
      hidden.push({ property_id: found.id, visible: false });
    }
  }
  // Visible columns first (so they sort in SCHEMA order at the left),
  // then the hidden ones. Frozen column index counts visible columns
  // from the start: Name + Description = 2 frozen.
  return {
    type: "table",
    properties: [...visible, ...hidden],
    frozen_column_index: 2,
  };
}

/**
 * Given a single skill's frontmatter values, return the Notion column
 * names that must exist on the data source for those values to be
 * writable.
 *
 * - `name` and `description` are always present (the database is
 *   created with them) so they're never returned.
 * - Empty / unset values don't need a column.
 * - Values matching a spec default also don't need a column — there's
 *   no point in surfacing a column where every row repeats the default.
 *
 * Used by migrate to grow the schema progressively: users only see
 * columns they're actually using.
 */
export function notionPropsForSkill(
  properties: Record<string, unknown>,
): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(properties)) {
    if (key === "name" || key === "description") continue;
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value === SELECT_DEFAULT) continue;
    const specDefault = SPEC_DEFAULTS[key];
    if (specDefault !== undefined && value === specDefault) continue;
    const def = SCHEMA.find((p) => p.frontmatterKey === key);
    if (!def) continue;
    if (def.metricOnly) continue;
    out.add(def.notionName);
  }
  return out;
}
