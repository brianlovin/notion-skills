/**
 * Tiny LCS-based line diff used to surface "what changed" when sync
 * pulls an updated skill. We don't ship this as a general-purpose
 * library — sync's specific needs are small files (SKILL.md typically
 * <500 lines), output rendered to the terminal, no need for the
 * Myers-Hunt-McIlroy bells and whistles.
 *
 * Pure: no I/O. Deterministic for a given input pair.
 */

export type DiffHunkType = "context" | "add" | "remove";

export interface DiffHunk {
  type: DiffHunkType;
  text: string;
}

/**
 * Line-by-line diff via standard LCS dynamic programming. Returns one
 * hunk per line in the merged result; callers usually fold consecutive
 * adds/removes into blocks for rendering.
 *
 * O(m·n) time + memory. Fine for skill-sized inputs.
 */
export function computeLineDiff(oldText: string, newText: string): DiffHunk[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // Suffix-LCS table: lcs[i][j] = LCS length of oldLines[i..] vs newLines[j..].
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i]![j] = lcs[i + 1]![j + 1]! + 1;
      } else {
        lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      hunks.push({ type: "context", text: oldLines[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      hunks.push({ type: "remove", text: oldLines[i]! });
      i++;
    } else {
      hunks.push({ type: "add", text: newLines[j]! });
      j++;
    }
  }
  while (i < m) hunks.push({ type: "remove", text: oldLines[i++]! });
  while (j < n) hunks.push({ type: "add", text: newLines[j++]! });
  return hunks;
}

/**
 * Render a unified-diff-style block from a hunk stream. Context lines
 * around adds/removes are kept (default 2); long stretches of unchanged
 * content are collapsed into a `…` separator. Returns an array of
 * { type, text } entries the caller paints to the terminal — colors
 * stay in the caller so this module is render-target-agnostic.
 *
 * If the diff has no changes, returns an empty array.
 */
export interface RenderedLine {
  type: DiffHunkType | "elide";
  text: string;
}

export function renderUnifiedDiff(
  hunks: DiffHunk[],
  options: { context?: number; maxLines?: number } = {},
): RenderedLine[] {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? Infinity;

  // First pass: figure out which context lines to keep. A context line
  // is kept if it's within `context` lines of any change.
  const keep = new Array<boolean>(hunks.length).fill(false);
  for (let i = 0; i < hunks.length; i++) {
    if (hunks[i]!.type !== "context") {
      const lo = Math.max(0, i - context);
      const hi = Math.min(hunks.length - 1, i + context);
      for (let k = lo; k <= hi; k++) keep[k] = true;
    }
  }

  if (!keep.some(Boolean)) return [];

  // Second pass: emit kept lines, with elide separators wherever a run
  // of skipped (out-of-context) lines exists — including before the
  // first kept line and after the last kept line. The leading/trailing
  // elides matter for our use case ("show me diff context"); without
  // them the user can't tell whether they're seeing the start of the
  // file or just the first change.
  const firstKept = keep.findIndex((k) => k);
  const lastKept = keep.length - 1 - [...keep].reverse().findIndex((k) => k);
  const out: RenderedLine[] = [];
  if (firstKept > 0) out.push({ type: "elide", text: "…" });
  let prev = -1;
  for (let i = firstKept; i <= lastKept; i++) {
    if (!keep[i]) continue;
    if (prev >= 0 && i > prev + 1) out.push({ type: "elide", text: "…" });
    out.push({ type: hunks[i]!.type, text: hunks[i]!.text });
    prev = i;
  }
  if (lastKept < hunks.length - 1) out.push({ type: "elide", text: "…" });

  if (out.length <= maxLines) return out;
  // Truncation: keep the first maxLines-1 entries and add a tail
  // marker. Simpler than balancing head + tail since users can re-run
  // with --no-diff (or scroll back to the file) for the full picture.
  return [
    ...out.slice(0, maxLines - 1),
    { type: "elide", text: `…(+${out.length - (maxLines - 1)} more lines)` },
  ];
}

/** True iff the diff contains any non-context hunks. */
export function hasChanges(hunks: DiffHunk[]): boolean {
  return hunks.some((h) => h.type !== "context");
}
