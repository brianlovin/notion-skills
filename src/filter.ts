/**
 * Sync defaults to syncing every skill in the database. The scope's
 * `exclude_skills` denylist is the only mechanism to opt out — useful for
 * "I don't want this team skill on my machine" without editing Notion.
 *
 * No UI for setting it; users edit ~/.notion-skills/scope.json directly.
 */

export function shouldSyncSkill(name: string, excludeSkills?: string[]): boolean {
  if (!excludeSkills || excludeSkills.length === 0) return true;
  return !excludeSkills.includes(name);
}
