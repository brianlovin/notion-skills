import { ntnApi } from "./ntn.js";
import { SCHEMA, SELECT_DEFAULT, buildViewConfiguration, type PropertyDef } from "./schema.js";

const NOTION_API_VERSION = "2025-09-03";

/**
 * The full set of frontmatter values for a single skill, as carried between
 * disk and Notion. Optional values map to "unset / use spec default".
 *
 * The keys mirror the SKILL.md frontmatter keys exactly so callers can pass
 * a parsed-frontmatter object straight through.
 */
export interface SkillProperties {
  /** Required. Slugified page title. */
  name: string;
  description: string;
  when_to_use?: string;
  "argument-hint"?: string;
  arguments?: string[];
  "allowed-tools"?: string[];
  paths?: string[];
  "disable-model-invocation"?: string; // "true" | "false" — strings so callers can pass spec values directly
  "user-invocable"?: string;
  model?: string;
  effort?: string;
  context?: string;
  agent?: string;
  shell?: string;
  /** Discovery tags (Notion multi_select). Empty / undefined means untagged. */
  tags?: string[];
}

export interface NotionPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  in_trash?: boolean;
  url: string;
  properties: Record<string, NotionProperty>;
}

export interface NotionDatabaseSummary {
  id: string;
  title: string;
  data_sources: { id: string; name: string }[];
}

export interface NotionProperty {
  id?: string;
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  multi_select?: { id: string; name: string; color?: string }[];
  select?: { id: string; name: string; color?: string } | null;
  number?: number | null;
  [k: string]: unknown;
}

export interface NotionRichText {
  plain_text: string;
  annotations?: Record<string, unknown>;
  href?: string | null;
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  archived?: boolean;
  in_trash?: boolean;
  [k: string]: unknown;
}

export class NotionClient {
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return ntnApi<T>(method, path, body, NOTION_API_VERSION);
  }

  async getDatabase(databaseId: string): Promise<NotionDatabaseSummary> {
    const json = await this.request<{
      id: string;
      title?: NotionRichText[];
      data_sources?: { id: string; name: string }[];
    }>("GET", `/v1/databases/${databaseId}`);
    return {
      id: json.id,
      title: (json.title ?? []).map((t) => t.plain_text).join("") || "Untitled",
      data_sources: json.data_sources ?? [],
    };
  }

  async getDataSource(dataSourceId: string): Promise<{
    id: string;
    properties: Record<
      string,
      {
        id: string;
        name: string;
        type: string;
        select?: { options: { id: string; name: string; color?: string }[] };
        multi_select?: { options: { id: string; name: string; color?: string }[] };
      }
    >;
  }> {
    return this.request("GET", `/v1/data_sources/${dataSourceId}`);
  }

  /**
   * Create a page in the Skills data source with the full set of spec
   * properties. Body is set separately via `ntnSetPageMarkdown` because the
   * Notion REST API requires children-as-blocks (not markdown).
   */
  async createSkillPage(
    dataSourceId: string,
    props: SkillProperties,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: buildPagePropertiesPayload(props),
      children: [],
    };
    const created = await this.request<{ id: string }>("POST", "/v1/pages", body);
    return created.id;
  }

  /**
   * Create an empty child page under a parent page. Used to publish
   * sibling files (e.g. LANGUAGE.md, scripts/search.ts) as child pages
   * on a skill row. Body is set separately via `ntnSetPageMarkdown`.
   *
   * The title is the file's relative path from the skill dir; we store
   * it verbatim in the page title (Notion accepts slashes in titles).
   */
  async createChildPage(
    parentPageId: string,
    title: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      parent: { type: "page_id", page_id: parentPageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }],
        },
      },
      children: [],
    };
    const created = await this.request<{ id: string }>("POST", "/v1/pages", body);
    return created.id;
  }

  /**
   * Archive (soft-delete) a page. Used to retire orphaned child
   * pages whose underlying file no longer exists locally.
   */
  async archivePage(pageId: string): Promise<void> {
    await this.request("PATCH", `/v1/pages/${pageId}`, { archived: true });
  }

  /** Patch a page's properties without touching its content. */
  async updateSkillPageProperties(
    pageId: string,
    props: SkillProperties,
  ): Promise<void> {
    await this.request("PATCH", `/v1/pages/${pageId}`, {
      properties: buildPagePropertiesPayload(props),
    });
  }

  /**
   * Create a new Skills database for the user.
   *
   * If `parentPageId` is omitted, the database lands at the workspace root
   * (Notion's `parent: { type: "workspace", workspace: true }` shape), which
   * is what most users want — no need to pre-create a parent page.
   *
   * The DB initialises with only the two properties required by every
   * skill — `Name` (title) and `Description`. Optional spec properties
   * (Model, Agent, Effort, etc.) are added progressively by `migrate`
   * when it sees skills that actually use them. This keeps the Notion
   * UI from being a wall of empty columns.
   */
  async createSkillsDatabase(opts: {
    title: string;
    parentPageId?: string;
  }): Promise<NotionDatabaseSummary & { url: string; data_source_id: string }> {
    const parent = opts.parentPageId
      ? { type: "page_id", page_id: opts.parentPageId }
      : { type: "workspace", workspace: true };

    const titleProp = SCHEMA.find((p) => p.kind === "title")!;
    const descriptionProp = SCHEMA.find((p) => p.notionName === "Description")!;
    const tagsProp = SCHEMA.find((p) => p.notionName === "Tags")!;
    const installsProp = SCHEMA.find((p) => p.notionName === "Installs")!;
    const body = {
      parent,
      title: [{ type: "text", text: { content: opts.title } }],
      initial_data_source: {
        // Eager properties: Name + Description (skill spec) + Tags (Notion-only
        // discovery filter, never round-tripped to SKILL.md so it won't be
        // created on demand) + Installs (store metric). Everything else is
        // added progressively by `publish`.
        properties: {
          [titleProp.notionName]: { title: {} },
          [descriptionProp.notionName]: propertyDefinitionPayload(descriptionProp),
          [tagsProp.notionName]: propertyDefinitionPayload(tagsProp),
          [installsProp.notionName]: propertyDefinitionPayload(installsProp),
        },
      },
    };
    const created = await this.request<{
      id: string;
      url?: string;
      title?: NotionRichText[];
      data_sources?: { id: string; name: string }[];
    }>("POST", "/v1/databases", body);

    if (!created.data_sources?.length) {
      throw new Error("Notion returned a database without any data sources.");
    }
    const dataSourceId = created.data_sources[0]!.id;

    // Scaffold the All / Popular / New default views. Fail-soft: a
    // missing Views API or a stricter workspace shouldn't stop the user
    // from getting a working database.
    await this.ensureDefaultViews(created.id, dataSourceId);

    return {
      id: created.id,
      title: (created.title ?? []).map((t) => t.plain_text).join("") || opts.title,
      data_sources: created.data_sources,
      data_source_id: dataSourceId,
      url: created.url ?? `https://www.notion.so/${created.id.replace(/-/g, "")}`,
    };
  }

  /**
   * Make sure the workspace store has the three canonical views the
   * app-store framing relies on:
   *   - "All"     — sorted alphabetically by Name (default browse).
   *   - "Popular" — sorted by Installs descending (which skills are
   *                 catching on across the team).
   *   - "New"     — sorted by created_time descending (recent additions).
   *
   * Idempotent: if a view by name already exists, PATCH its sort +
   * column order. Otherwise POST to create it. Skips "Popular" if the
   * Installs column doesn't exist yet (the install metric layer adds
   * it on demand).
   *
   * Fail-soft: any Views-API error is swallowed (logged in debug mode).
   * Users still get a working database even if their workspace doesn't
   * support the Views API.
   */
  async ensureDefaultViews(
    databaseId: string,
    dataSourceId: string,
  ): Promise<void> {
    try {
      const dataSource = await this.getDataSource(dataSourceId);
      const propertiesByName = dataSource.properties as Record<
        string,
        { id?: string }
      >;
      const configuration = buildViewConfiguration(propertiesByName);
      if (configuration.properties.length === 0) return;

      // List existing views; resolve each to its name via a follow-up
      // GET (the list endpoint returns minimal references — id only).
      const search = new URLSearchParams({ data_source_id: dataSourceId });
      const list = await this.request<{
        results?: Array<{ id: string }>;
      }>("GET", `/v1/views?${search.toString()}`);
      const existingByName = new Map<string, string>();
      for (const v of list.results ?? []) {
        try {
          const detail = await this.request<{
            id: string;
            name?: string;
          }>("GET", `/v1/views/${v.id}`);
          if (detail.name) existingByName.set(detail.name, v.id);
        } catch {
          // Skip views we can't fetch.
        }
      }

      const desired: Array<{
        name: string;
        sorts: Array<{
          property?: string;
          timestamp?: string;
          direction: "ascending" | "descending";
        }>;
        skipIf?: () => boolean;
      }> = [
        {
          name: "All",
          sorts: [{ property: "Name", direction: "ascending" }],
        },
        {
          name: "Popular",
          sorts: [{ property: "Installs", direction: "descending" }],
          skipIf: () => !propertiesByName["Installs"]?.id,
        },
        {
          name: "New",
          sorts: [{ timestamp: "created_time", direction: "descending" }],
        },
      ];

      for (const view of desired) {
        if (view.skipIf?.()) continue;
        const existingId = existingByName.get(view.name);
        const payload: Record<string, unknown> = {
          name: view.name,
          type: "table",
          sorts: view.sorts,
          configuration,
        };
        if (existingId) {
          await this.request("PATCH", `/v1/views/${existingId}`, payload);
        } else {
          await this.request("POST", `/v1/views`, {
            database_id: databaseId,
            data_source_id: dataSourceId,
            ...payload,
          });
        }
      }
    } catch (err) {
      if (process.env.NOTION_SKILLS_DEBUG === "1") {
        console.error("ensureDefaultViews failed:", err);
      }
    }
  }

  /**
   * Reconcile the data source schema with src/schema.ts.
   * Idempotent. Two flavours of change:
   *   - Add a missing property
   *   - Convert a property whose Notion type doesn't match the schema kind
   *     (e.g. Agent went from rich_text to select between releases)
   *
   * Pass `options.only` to scope the reconciliation to a specific subset
   * of Notion column names. Migrate uses this to add only the columns
   * the about-to-upload skills actually need, instead of pre-populating
   * every spec property up front.
   */
  async upgradeSchema(
    dataSourceId: string,
    options: { only?: Set<string> } = {},
  ): Promise<{
    added: string[];
    retyped: string[];
  }> {
    const current = await this.getDataSource(dataSourceId);
    const additions: Record<string, unknown> = {};
    const added: string[] = [];
    const retyped: string[] = [];

    for (const prop of SCHEMA) {
      if (prop.kind === "title") continue;
      if (options.only && !options.only.has(prop.notionName)) continue;
      const existing = current.properties[prop.notionName] as
        | { type: string }
        | undefined;
      if (!existing) {
        additions[prop.notionName] = propertyDefinitionPayload(prop);
        added.push(prop.notionName);
        continue;
      }
      const expectedType = expectedNotionType(prop.kind);
      if (existing.type !== expectedType) {
        additions[prop.notionName] = propertyDefinitionPayload(prop);
        retyped.push(prop.notionName);
      }
    }

    if (added.length === 0 && retyped.length === 0) {
      return { added: [], retyped: [] };
    }

    await this.request("PATCH", `/v1/data_sources/${dataSourceId}`, {
      properties: additions,
    });
    // View configuration is owned by ensureDefaultViews — called from
    // createSkillsDatabase + init. We don't auto-refresh views on every
    // schema change because it'd mean an extra round of Notion API
    // calls during install (which itself runs upgradeSchema for the
    // Installs column). View drift in the rare case of a property-only
    // schema change is handled by re-running init.
    return { added, retyped };
  }

  /**
   * For each self-healing select / multi_select property, ensure that all
   * the option names we're about to set on pages exist in the data
   * source's option list. Adds missing ones via PATCH. Used by publish
   * before page creation so Notion doesn't reject values for unknown
   * options (e.g. a new model ID, a new tag).
   *
   * `valuesByNotionName` maps Notion column name → set of values that need
   * to exist in that column's option list.
   */
  async ensureSelectOptions(
    dataSourceId: string,
    valuesByNotionName: Map<string, Set<string>>,
  ): Promise<{ column: string; added: string[] }[]> {
    if (valuesByNotionName.size === 0) return [];
    const current = await this.getDataSource(dataSourceId);
    const propertyPayload: Record<string, unknown> = {};
    const report: { column: string; added: string[] }[] = [];

    for (const [notionName, wantedValues] of valuesByNotionName) {
      const def = current.properties[notionName] as
        | {
            type: string;
            select?: { options: Array<{ id: string; name: string; color?: string }> };
            multi_select?: { options: Array<{ id: string; name: string; color?: string }> };
          }
        | undefined;
      if (!def) continue;
      const isSelect = def.type === "select";
      const isMulti = def.type === "multi_select";
      if (!isSelect && !isMulti) continue;

      const existingOptions = isSelect ? def.select?.options : def.multi_select?.options;
      const existing = new Set((existingOptions ?? []).map((o) => o.name));
      const missing = [...wantedValues].filter((v) => !existing.has(v) && v !== "");
      if (missing.length === 0) continue;

      const newOptions = [
        ...(existingOptions ?? []).map((o) => ({ name: o.name, color: o.color })),
        ...missing.map((name) => ({ name, color: "default" })),
      ];
      const optionsPayload = { options: newOptions };
      propertyPayload[notionName] = isSelect
        ? { select: optionsPayload }
        : { multi_select: optionsPayload };
      report.push({ column: notionName, added: missing });
    }

    if (report.length === 0) return [];
    await this.request("PATCH", `/v1/data_sources/${dataSourceId}`, {
      properties: propertyPayload,
    });
    return report;
  }

  async queryDataSource(
    dataSourceId: string,
    options: { pageSize?: number } = {},
  ): Promise<NotionPage[]> {
    const results: NotionPage[] = [];
    let cursor: string | undefined;

    do {
      const body: Record<string, unknown> = { page_size: options.pageSize ?? 100 };
      if (cursor) body.start_cursor = cursor;

      const json = await this.request<{
        results: NotionPage[];
        next_cursor: string | null;
        has_more: boolean;
      }>("POST", `/v1/data_sources/${dataSourceId}/query`, body);

      results.push(...json.results);
      cursor = json.has_more ? (json.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return results;
  }

  async getPage(pageId: string): Promise<NotionPage> {
    return this.request("GET", `/v1/pages/${pageId}`);
  }

  /**
   * Increment a number property on a page by 1. Used by `install` to
   * bump the Installs counter. Read-then-write (Notion has no atomic
   * increment); concurrent installs from two machines could step on
   * each other but the data fidelity is acceptable for v1 — popular
   * skills get more installs and that's what matters, exact counts
   * within ±1 don't.
   *
   * Fail-soft: returns the new count or null if the page or property
   * doesn't exist. Never throws — install shouldn't fail because the
   * counter couldn't be bumped.
   */
  async incrementPageNumber(
    pageId: string,
    propertyName: string,
  ): Promise<number | null> {
    try {
      const page = await this.getPage(pageId);
      const prop = page.properties[propertyName];
      const current =
        prop && prop.type === "number" && typeof prop.number === "number"
          ? prop.number
          : 0;
      const next = current + 1;
      await this.request("PATCH", `/v1/pages/${pageId}`, {
        properties: { [propertyName]: { number: next } },
      });
      return next;
    } catch {
      return null;
    }
  }

  async getBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const results: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const search = new URLSearchParams({ page_size: "100" });
      if (cursor) search.set("start_cursor", cursor);
      const json = await this.request<{
        results: NotionBlock[];
        next_cursor: string | null;
        has_more: boolean;
      }>("GET", `/v1/blocks/${blockId}/children?${search.toString()}`);

      results.push(...json.results);
      cursor = json.has_more ? (json.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return results;
  }
}

// ---------- Property accessors ----------

export function readTitle(props: Record<string, NotionProperty>): string {
  for (const v of Object.values(props)) {
    if (v.type === "title" && Array.isArray(v.title)) {
      return v.title.map((r) => r.plain_text).join("").trim();
    }
  }
  return "";
}

export function readRichText(
  props: Record<string, NotionProperty>,
  name: string,
): string {
  const p = props[name];
  if (!p || p.type !== "rich_text" || !Array.isArray(p.rich_text)) return "";
  return p.rich_text.map((r) => r.plain_text).join("").trim();
}

export function readSelect(
  props: Record<string, NotionProperty>,
  name: string,
): string | null {
  const p = props[name];
  if (!p || p.type !== "select") return null;
  const sel = p.select as { name?: string } | null | undefined;
  return sel?.name ?? null;
}

export function readMultiSelect(
  props: Record<string, NotionProperty>,
  name: string,
): string[] {
  const p = props[name];
  if (!p || p.type !== "multi_select" || !Array.isArray(p.multi_select)) return [];
  return p.multi_select.map((opt) => opt.name).filter((s): s is string => !!s);
}

export function readNumber(
  props: Record<string, NotionProperty>,
  name: string,
): number {
  const p = props[name];
  if (!p || p.type !== "number") return 0;
  const n = p.number;
  return typeof n === "number" ? n : 0;
}

// ---------- Schema payload builders ----------

/**
 * Build the `properties` block for POST /v1/pages or PATCH /v1/pages/<id>
 * from a SkillProperties value.
 *
 * Only emits properties that have a value to set; absent fields are left
 * untouched (so partial updates work).
 */
export function buildPagePropertiesPayload(
  props: SkillProperties,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    Name: { title: [{ type: "text", text: { content: props.name } }] },
    Description: {
      rich_text: [{ type: "text", text: { content: props.description } }],
    },
  };

  // rich_text fields
  pushRichText(payload, "When To Use", props.when_to_use);
  pushRichText(payload, "Argument Hint", props["argument-hint"]);

  // list_text fields (joined into rich_text)
  pushList(payload, "Arguments", props.arguments, " ");
  pushList(payload, "Allowed Tools", props["allowed-tools"], " ");
  pushList(payload, "Paths", props.paths, ", ");

  // select fields (Agent is a self-healing select per schema)
  pushSelect(payload, "Disable Model Invocation", props["disable-model-invocation"]);
  pushSelect(payload, "User Invocable", props["user-invocable"]);
  pushSelect(payload, "Model", props.model);
  pushSelect(payload, "Effort", props.effort);
  pushSelect(payload, "Context", props.context);
  pushSelect(payload, "Agent", props.agent);
  pushSelect(payload, "Shell", props.shell);

  // multi_select fields
  pushMultiSelect(payload, "Tags", props.tags);

  return payload;
}

function pushRichText(
  payload: Record<string, unknown>,
  notionName: string,
  value: string | undefined,
): void {
  if (value === undefined || value === "") return;
  payload[notionName] = {
    rich_text: [{ type: "text", text: { content: value } }],
  };
}

function pushList(
  payload: Record<string, unknown>,
  notionName: string,
  value: string[] | undefined,
  separator: string,
): void {
  if (value === undefined || value.length === 0) return;
  payload[notionName] = {
    rich_text: [{ type: "text", text: { content: value.join(separator) } }],
  };
}

function pushSelect(
  payload: Record<string, unknown>,
  notionName: string,
  value: string | undefined,
): void {
  if (value === undefined || value === "") return;
  payload[notionName] = { select: { name: value } };
}

function pushMultiSelect(
  payload: Record<string, unknown>,
  notionName: string,
  value: string[] | undefined,
): void {
  if (value === undefined || value.length === 0) return;
  payload[notionName] = {
    multi_select: value.filter((v) => v && v.trim() !== "").map((name) => ({ name })),
  };
}

/**
 * Build the `initial_data_source.properties` block for creating a new
 * database with the full schema.
 */
export function buildInitialDataSourceProperties(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of SCHEMA) {
    out[prop.notionName] = propertyDefinitionPayload(prop);
  }
  return out;
}

/** Notion's `properties.<name>.type` string for each schema kind. */
function expectedNotionType(kind: PropertyDef["kind"]): string {
  switch (kind) {
    case "title": return "title";
    case "rich_text":
    case "list_text": return "rich_text";
    case "checkbox": return "checkbox";
    case "number": return "number";
    case "select": return "select";
    case "multi_select": return "multi_select";
  }
}

/**
 * Notion property *definition* (vs. a property *value*) for use in a
 * create-database or PATCH /v1/data_sources call.
 */
export function propertyDefinitionPayload(prop: PropertyDef): unknown {
  switch (prop.kind) {
    case "title":
      return { title: {} };
    case "rich_text":
    case "list_text":
      return { rich_text: {} };
    case "checkbox":
      return { checkbox: {} };
    case "number":
      return { number: { format: "number" } };
    case "select":
      return {
        select: { options: prop.options ?? [{ name: SELECT_DEFAULT }] },
      };
    case "multi_select":
      return {
        multi_select: { options: prop.options ?? [] },
      };
  }
}
