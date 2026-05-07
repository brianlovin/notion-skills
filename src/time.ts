/**
 * Human-friendly relative-time formatter ("3d ago", "just now").
 * Used in feed + feedback output where exact timestamps are noise.
 *
 * Past-only by design — every caller is reading historical events
 * (when a comment was posted, when a skill was last edited). Future
 * dates fall through to the "just now" branch rather than printing
 * gibberish; surfaces a clock-skew bug as the most-recent timestamp.
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.max(0, Math.round(diffMs / 1000));

  if (diffSec < 60) return "just now";

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w ago`;

  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;

  const diffYear = Math.round(diffDay / 365);
  return `${diffYear}y ago`;
}

/**
 * Parse a "since" duration like `7d`, `2w`, `48h`, `30m` into a Date
 * representing now-minus-duration. Used by `feed` to bound the
 * activity window.
 *
 * Accepts: ms, m (minute), h, d, w. Rejects empty / unknown / negative.
 * Bare digits default to days (`7` = `7d`) — the most common feed
 * window. Returns null on parse failure so callers can show a tailored
 * error message.
 */
export function parseDurationToDate(
  input: string,
  now: Date = new Date(),
): Date | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Require a positive integer — `0d` would render as "Activity in
  // the last 0 minutes" which is gibberish.
  const match = /^([1-9]\d*)\s*(ms|m|h|d|w)?$/.exec(trimmed);
  if (!match) return null;

  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = match[2] ?? "d";
  const factor = UNIT_TO_MS[unit];
  if (factor === undefined) return null;
  const ms = n * factor;

  return new Date(now.getTime() - ms);
}

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};
