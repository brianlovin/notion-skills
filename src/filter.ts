import type { FilterConfig } from "./scope.js";

export interface FilterableSkill {
  name: string;
  tags: string[];
}

export type FilterDecision =
  | { keep: true; reason: "include_skills" | "default" }
  | { keep: false; reason: "exclude_skills" | "include_tags" | "exclude_tags" };

export function decide(
  skill: FilterableSkill,
  filter: FilterConfig,
  ephemeralIncludeNames?: string[],
): FilterDecision {
  // Names passed on the CLI for this run act as a force-include. They
  // augment the regular filter — they do NOT replace it, so users can't
  // accidentally delete already-synced skills by running `sync foo`.
  if (ephemeralIncludeNames && ephemeralIncludeNames.includes(skill.name)) {
    return { keep: true, reason: "include_skills" };
  }

  const exSkills = filter.exclude_skills ?? [];
  if (exSkills.includes(skill.name)) {
    return { keep: false, reason: "exclude_skills" };
  }

  const incSkills = filter.include_skills ?? [];
  if (incSkills.includes(skill.name)) {
    return { keep: true, reason: "include_skills" };
  }

  const incTags = filter.include_tags ?? [];
  if (incTags.length > 0) {
    const overlap = skill.tags.some((t) => incTags.includes(t));
    if (!overlap) return { keep: false, reason: "include_tags" };
  }

  const exTags = filter.exclude_tags ?? [];
  if (exTags.length > 0 && skill.tags.some((t) => exTags.includes(t))) {
    return { keep: false, reason: "exclude_tags" };
  }

  return { keep: true, reason: "default" };
}
