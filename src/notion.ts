import { ntnApi } from "./ntn.js";
import { SCHEMA, SELECT_DEFAULT, type PropertyDef } from "./schema.js";

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
    properties: Record<string, { id: string; name: string; type: string; multi_select?: { options: { id: string; name: string; color?: string }[] } }>;
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
   * Notion orders database columns by property creation timestamp, so to
   * keep a clean layout we create with just the title property, then call
   * upgradeSchema() to add the rest one batch later.
   */
  async createSkillsDatabase(opts: {
    title: string;
    parentPageId?: string;
  }): Promise<NotionDatabaseSummary & { url: string; data_source_id: string }> {
    const parent = opts.parentPageId
      ? { type: "page_id", page_id: opts.parentPageId }
      : { type: "workspace", workspace: true };

    const titleProp = SCHEMA.find((p) => p.kind === "title")!;
    const body = {
      parent,
      title: [{ type: "text", text: { content: opts.title } }],
      initial_data_source: {
        properties: {
          [titleProp.notionName]: { title: {} },
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

    // Add the rest of the schema in one PATCH for deterministic column order.
    await this.upgradeSchema(dataSourceId);

    return {
      id: created.id,
      title: (created.title ?? []).map((t) => t.plain_text).join("") || opts.title,
      data_sources: created.data_sources,
      data_source_id: dataSourceId,
      url: created.url ?? `https://www.notion.so/${created.id.replace(/-/g, "")}`,
    };
  }

  /**
   * Reconcile the data source schema with src/schema.ts.
   * Idempotent. Two flavours of change:
   *   - Add a missing property
   *   - Convert a property whose Notion type doesn't match the schema kind
   *     (e.g. Agent went from rich_text to select between releases)
   */
  async upgradeSchema(dataSourceId: string): Promise<{
    added: string[];
    retyped: string[];
  }> {
    const current = await this.getDataSource(dataSourceId);
    const additions: Record<string, unknown> = {};
    const added: string[] = [];
    const retyped: string[] = [];

    for (const prop of SCHEMA) {
      if (prop.kind === "title") continue;
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
    return { added, retyped };
  }

  /**
   * For each self-healing select property, ensure that all the option names
   * we're about to set on pages exist in the data source's option list.
   * Adds missing ones via PATCH. Used by migrate before page creation so
   * Notion doesn't reject values for unknown options (e.g. a new model ID).
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
        | { type: string; select?: { options: Array<{ id: string; name: string; color?: string }> } }
        | undefined;
      if (!def || def.type !== "select") continue;
      const existing = new Set((def.select?.options ?? []).map((o) => o.name));
      const missing = [...wantedValues].filter((v) => !existing.has(v) && v !== "");
      if (missing.length === 0) continue;

      // Preserve existing options + add the missing ones.
      const newOptions = [
        ...(def.select?.options ?? []).map((o) => ({ name: o.name, color: o.color })),
        ...missing.map((name) => ({ name, color: "default" })),
      ];
      propertyPayload[notionName] = { select: { options: newOptions } };
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
    case "select": return "select";
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
    case "select":
      return {
        select: { options: prop.options ?? [{ name: SELECT_DEFAULT }] },
      };
  }
}
