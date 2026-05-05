/**
 * Pure decision logic for bidirectional sync. Given whether each side
 * changed since the last sync and the relevant timestamps, decide what
 * action to take for a single skill.
 *
 * Last-edit-wins on conflict. Notion's page history is the safety net
 * for the loser; we don't try to merge.
 */
export type SyncAction =
  | "skip"           // both sides unchanged
  | "push"           // local changed, remote didn't
  | "pull"           // remote changed, local didn't
  | "conflict-push"  // both changed, local mtime is newer
  | "conflict-pull"; // both changed, remote last_edited_time is newer

export function decideSyncAction(args: {
  localChanged: boolean;
  remoteChanged: boolean;
  /** File mtime of the local SKILL.md. Required only when both sides changed. */
  localMtime?: Date;
  /** Notion's `last_edited_time` parsed as a Date. Required only when both sides changed. */
  remoteEdited?: Date;
}): SyncAction {
  const { localChanged, remoteChanged, localMtime, remoteEdited } = args;
  if (!localChanged && !remoteChanged) return "skip";
  if (localChanged && !remoteChanged) return "push";
  if (!localChanged && remoteChanged) return "pull";
  // Both changed → conflict. Newer side wins.
  // If timestamps are missing or equal, default to remote (safer: Notion
  // is the canonical store, and the user always has Notion's history).
  if (!localMtime || !remoteEdited) return "conflict-pull";
  return localMtime.getTime() > remoteEdited.getTime()
    ? "conflict-push"
    : "conflict-pull";
}
