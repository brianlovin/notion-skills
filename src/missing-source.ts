/**
 * Detection + classification for sources that 404 during sync.
 *
 * A source 404 can mean two very different things:
 *   - the source was deleted in Notion (teammate cleanup, intentional);
 *   - `ntn` is logged into a different workspace than when we cached the
 *     source's data_source_id (user switched workspaces).
 *
 * Auto-disconnecting on the first 404 risks silently nuking the user's
 * config in the workspace-mismatch case. We instead use a cross-source
 * signal: if some sources succeeded in the same sync, auth is healthy
 * for THIS workspace, so the 404'd ones are genuinely deleted. If
 * NOTHING succeeded, we can't distinguish — surface a warning, but
 * don't auto-act.
 */

export type MissingClassification = "deleted" | "ambiguous";

export interface MissingSourceRecord {
  key: string;
  classification: MissingClassification;
  /** Original ntn error text, preserved for debugging. */
  raw: string;
}

/**
 * True if `err`'s message looks like Notion's `object_not_found` 404.
 * Matches both data-source and database 404s (Notion returns the same
 * "Could not find database with ID" wording for both).
 */
export function isNotionNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    /object_not_found/i.test(msg) &&
    /Could not find (database|data[_ ]source|page)/i.test(msg)
  );
}

/**
 * Classify a set of in-sync 404s using the cross-source signal.
 * `succeededCount > 0` proves auth is good for this workspace, so any
 * 404 is genuinely a deleted source. Otherwise it's ambiguous.
 */
export function classifyMissing(args: {
  succeededCount: number;
  missingCount: number;
}): MissingClassification {
  if (args.missingCount === 0) return "deleted";
  return args.succeededCount > 0 ? "deleted" : "ambiguous";
}
