/**
 * Wrap the user's `gen` argument with a skill-creation template.
 *
 * The agent has exactly one job: write a SKILL.md to
 * `~/.notion-skills/skills/<slug>/SKILL.md`, then exit. No shell
 * commands, no migrate hand-off, no permission gates. After the
 * agent exits, `gen` runs migrate itself — that step is fully
 * deterministic and doesn't need to round-trip through the agent.
 */
const TEMPLATE = String.raw`You are generating a new skill for notion-skills, a CLI that syncs skills between a Notion database and local agent dirs (Claude, Codex, OpenCode, Cursor, Gemini).

A skill is a directory containing a SKILL.md file with YAML frontmatter and a markdown body. AI agents read the frontmatter to decide when to invoke the skill, and the body for the actual instructions.

---
USER INPUT (could be a URL, file path, or natural-language prompt):

{INPUT}
---

WHAT TO DO:

1. Read the input and figure out what skill the user wants:
   - URL → fetch it, distill its content into a useful skill.
   - File path → read it. If it's already a SKILL.md, polish it; otherwise synthesise a skill from its content.
   - Natural-language description → invent a useful skill matching the description.

2. Pick a kebab-case slug for the skill (max 64 chars, only [a-z0-9-]). Specific enough to disambiguate, short enough to type as a slash-command.

3. Write a SKILL.md to:

   ~/.notion-skills/skills/<slug>/SKILL.md

   That path is the only thing you need to do. Don't write anywhere else; don't run any shell commands.

   Required frontmatter:
   ` + "```\n" +
`   ---
   name: <slug>
   description: <one-liner that triggers the skill correctly>
   ---
` + "   ```\n" + `
   The ` + "`description`" + ` is the most important field — it's how AI agents decide when to invoke the skill. Use trigger words ("Use when…", "Triggers on…") when activation is narrow.

   Optional frontmatter keys (use only when meaningful — don't pad):
   ` + "`when_to_use`, `argument-hint`, `arguments`, `allowed-tools`, `paths`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context`, `agent`, `shell`" + `.
   See https://code.claude.com/docs/en/skills for the spec.

   Body:
   - Concise, action-oriented markdown aimed at an AI agent (not a human reader).
   - Reproduce the source material's key insights — don't just link to it.
   - For URLs, include the source URL at the bottom so users can reference the original.

4. Once the file is written, you're done. Print a one-line summary and stop turning. {NOTION_SKILLS} will pick the new skill up automatically and push it to Notion.

CONSTRAINTS:
- Default to reasonable choices about scope, slug, and structure — don't ask clarifying questions about intent.
- Don't over-engineer the skill — most skills are 30-100 lines. Aim for usefulness, not completeness.
- Don't fabricate source material. If the input is too vague, draft a minimal skeleton skill the user can refine later.
- Do not run shell commands or migrate steps. Your only side effect is writing the SKILL.md to the drafts path above.
`;

export interface BuildGenPromptOptions {
  /**
   * The user-facing name for notion-skills, mentioned in the agent's
   * exit instructions ("exit so the terminal returns to {NOTION_SKILLS}").
   * Defaults to "notion-skills".
   */
  notionSkillsBin?: string;
}

export function buildGenPrompt(
  input: string,
  options: BuildGenPromptOptions = {},
): string {
  const bin = options.notionSkillsBin ?? "notion-skills";
  return TEMPLATE.replace("{INPUT}", input).replaceAll("{NOTION_SKILLS}", bin);
}
