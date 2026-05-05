import { slugify } from "./convert.js";
import { type NotionPage, readTitle } from "./notion.js";

/**
 * One record per colliding slug. `titles` and `pageIds` are parallel
 * arrays — same length, ordered by appearance in the source list.
 */
export interface SlugCollision {
  slug: string;
  titles: string[];
  pageIds: string[];
}

/**
 * Group active pages by slugified title and return only the groups
 * with more than one member. `null`/empty titles are skipped (those
 * pages surface as "invalid" elsewhere). Archived / trashed pages
 * never participate.
 *
 * Slugs are the primary identifier on the local machine; two Notion
 * pages slugifying to the same string is unambiguously a problem.
 * sync skips them with a warning, install refuses them, doctor
 * surfaces them so the user can rename one in Notion.
 */
export function detectSlugCollisions(pages: NotionPage[]): SlugCollision[] {
  const groups = new Map<string, { titles: string[]; pageIds: string[] }>();
  for (const page of pages) {
    if (page.archived || page.in_trash) continue;
    const title = readTitle(page.properties);
    if (!title) continue;
    const slug = slugify(title);
    const group = groups.get(slug) ?? { titles: [], pageIds: [] };
    group.titles.push(title);
    group.pageIds.push(page.id);
    groups.set(slug, group);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.pageIds.length > 1)
    .map(([slug, g]) => ({ slug, titles: g.titles, pageIds: g.pageIds }));
}

export function collidingSlugSet(collisions: SlugCollision[]): Set<string> {
  return new Set(collisions.map((c) => c.slug));
}
