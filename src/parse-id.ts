/**
 * Extract a 32-char Notion ID from a URL, dashed UUID, or bare hex.
 * Returns the dashed UUID form Notion's API accepts, or null if no ID found.
 */
export function parseNotionId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Dashed UUID: 8-4-4-4-12
  const dashed = trimmed.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (dashed) return formatId(dashed[0].replace(/-/g, ""));

  // Bare 32 hex bounded by non-hex characters (or string boundary).
  // Anchored boundary keeps a slug like "Title-DEADBEEF..." from bleeding the
  // hex letters of "Title" into the match.
  const bare = trimmed.match(/(?:^|[^0-9a-f])([0-9a-f]{32})(?=[^0-9a-f]|$)/i);
  if (bare && bare[1]) return formatId(bare[1]);

  return null;
}

function formatId(hex32: string): string {
  const id = hex32.toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
