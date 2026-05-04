import { ntnApi } from "./ntn.js";

const NOTION_API_VERSION = "2025-09-03";

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
   * Create a new database (with a default data source) for storing skills.
   * Schema: Name (title), Description (rich_text), Tags (multi_select).
   */
  async createSkillsDatabase(parentPageId: string, title: string): Promise<NotionDatabaseSummary> {
    const body = {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      initial_data_source: {
        properties: {
          Name: { title: {} },
          Description: { rich_text: {} },
          Tags: { multi_select: { options: [] } },
        },
      },
    };
    const created = await this.request<{
      id: string;
      title?: NotionRichText[];
      data_sources?: { id: string; name: string }[];
    }>("POST", "/v1/databases", body);
    return {
      id: created.id,
      title: (created.title ?? []).map((t) => t.plain_text).join("") || title,
      data_sources: created.data_sources ?? [],
    };
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

export function readMultiSelect(
  props: Record<string, NotionProperty>,
  name: string,
): string[] {
  const p = props[name];
  if (!p || p.type !== "multi_select" || !Array.isArray(p.multi_select)) return [];
  return p.multi_select.map((s) => s.name);
}

export function findMultiSelectProperty(
  dataSource: { properties: Record<string, { type: string; name: string; multi_select?: { options: { name: string }[] } }> },
  preferredName: string,
): { name: string; options: string[] } | null {
  const props = dataSource.properties;
  // Prefer exact match (case-insensitive)
  for (const [_, def] of Object.entries(props)) {
    if (def.type === "multi_select" && def.name.toLowerCase() === preferredName.toLowerCase()) {
      return { name: def.name, options: (def.multi_select?.options ?? []).map((o) => o.name) };
    }
  }
  return null;
}
