/**
 * Wrap the user's `gen` argument with a skill-creation template that
 * teaches the agent to follow agentskills.io best practices. The
 * template has two phases:
 *
 *   1. Draft the SKILL.md to ~/.notion-skills/skills/<slug>/SKILL.md
 *   2. Self-review against a short rubric and revise in place
 *
 * The agent's only side effect is writing files in the draft path.
 * No shell commands, no publish step — that's the user's call.
 */
const TEMPLATE = String.raw`You are authoring a new skill for notion-skills, a CLI that syncs Agent Skills (https://agentskills.io) between a Notion database and local AI-agent dirs (Claude Code, Codex, OpenCode, Cursor, Gemini).

A skill is a directory containing a SKILL.md file with YAML frontmatter and a markdown body. AI agents read the frontmatter to decide when to load the skill, and the body for the instructions to follow once it's loaded.

---
USER INPUT (could be a URL, file path, or natural-language prompt):

{INPUT}
---

PHASE 1 — DRAFT THE SKILL

1. Understand the input:
   - URL → fetch it; distill the substance into a useful skill (don't just summarise).
   - File path → read it. If it's already a SKILL.md, polish it; otherwise synthesise.
   - Natural-language description → design a useful skill matching the user's intent.

2. Pick the slug. Spec rules from https://agentskills.io/specification:
   - 1-64 characters, lowercase letters / numbers / hyphens only.
   - Must not start or end with a hyphen.
   - Must not contain consecutive hyphens.
   - Must match the parent directory name.
   - Specific enough to disambiguate; short enough to type as a slash-command.

3. Write to ~/.notion-skills/skills/<slug>/SKILL.md. That's the only allowed write target.

4. Frontmatter rules:

   Required:
   ` + "```yaml\n" +
`   ---
   name: <slug>           # must match the directory name
   description: <...>     # max 1024 characters
   ---
` + "   ```\n" + `

   The description is the highest-leverage field — it's the only thing agents see at startup, and it's the gate for whether your skill loads. Spec guidance from https://agentskills.io/skill-creation/optimizing-descriptions:
   - **Imperative phrasing.** "Use this skill when…" not "This skill does…".
   - **Focus on user intent**, not implementation. Describe what the user is trying to achieve.
   - **List trigger contexts explicitly**, including cases where the user doesn't name the domain. Example: "Use when the user has a CSV, TSV, or Excel file and wants to explore, transform, or visualize the data — even if they don't explicitly mention 'CSV' or 'analysis'."
   - **Specific keywords** that match real user prompts.
   - Concise (a few sentences); under the 1024-char hard limit.

   Optional spec fields (use only when meaningful — don't pad):
   - ` + "`license`" + `: license name or path to a bundled LICENSE file.
   - ` + "`compatibility`" + `: environment requirements, max 500 chars (e.g., "Requires Python 3.14+ and uv").
   - ` + "`allowed-tools`" + `: space-separated string of pre-approved tools.
   - ` + "`metadata`" + `: arbitrary YAML key-value map for additional properties not in the spec.

   Claude Code's frontmatter extensions — use when the user is on Claude Code and the field is genuinely useful:
   ` + "`when_to_use`, `argument-hint`, `arguments`, `paths`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context`, `agent`, `shell`" + `.

5. Body content. Best practices from https://agentskills.io/skill-creation/best-practices:

   **Add what the agent lacks; omit what it knows.** Don't explain what a PDF is, how HTTP works, what database migrations do. Focus on project-specific conventions, domain-specific procedures, non-obvious edge cases, and the particular tools/APIs to use.

   **Provide defaults, not menus.** "Use pdfplumber for text extraction" beats "You can use pypdf, pdfplumber, PyMuPDF, or pdf2image…".

   **Calibrate specificity to fragility.** Be flexible (and explain *why*) when multiple approaches work. Be prescriptive when operations are fragile or a specific sequence matters.

   **Useful section patterns** (use the ones that fit; not all of them):
   - **Gotchas** — list of environment-specific facts that defy reasonable assumptions. The most valuable section in many skills.
   - **Templates** — for output formats, give a concrete template the agent can pattern-match against.
   - **Checklists** — for multi-step workflows where steps have dependencies.
   - **Validation loops** — do the work, run a validator, fix issues, repeat.
   - **Plan-validate-execute** — for batch or destructive operations, write the plan to a file, validate it, then execute.

   **Length.** Keep SKILL.md under 500 lines and ~5000 tokens. If a skill legitimately needs more, move detail to ` + "`scripts/`" + `, ` + "`references/`" + `, or ` + "`assets/`" + ` (see Phase 1, step 6) and reference those files from SKILL.md when the agent should load them.

6. Multi-file structure (only if the skill genuinely needs more than a SKILL.md). The spec defines three optional directories:
   - ` + "`scripts/`" + ` — executable code the agent runs (Python, Bash, JS, etc.). Self-contained or with documented dependencies. Avoid interactive prompts; use ` + "`--help`" + `; write helpful error messages.
   - ` + "`references/`" + ` — additional documentation the agent loads on demand. Tell the agent *when* to load each file ("Read references/api-errors.md if the API returns a non-200 status code").
   - ` + "`assets/`" + ` — static resources (templates, schemas, lookup tables).

   Skip these unless the skill clearly needs them. Most skills are just SKILL.md.

ANTI-PATTERNS:
- Don't write generic advice ("handle errors appropriately", "follow best practices for X"). Be concrete.
- Don't explain things the agent already knows from training (HTTP, JSON, common APIs).
- Don't present multiple equally-valid options without picking a default.
- Don't fabricate source material. If the input is vague, draft a minimal skeleton the user can flesh out.
- Don't ask clarifying questions. ` + "`gen`" + ` runs autonomously; default to reasonable choices about scope and structure.
- Do not run shell commands. Your only allowed side effect is writing the SKILL.md (and any spec-dir files in the same directory tree).
- Don't publish the skill. ` + "`{NOTION_SKILLS}`" + ` does that as a separate step the user runs themselves.

PHASE 2 — SELF-REVIEW

After writing the SKILL.md, re-read it from disk and grade yourself against this rubric. If any check fails, revise the file and re-grade.

- [ ] Description uses imperative phrasing ("Use this skill when…").
- [ ] Description lists at least one trigger context where the user might not name the domain directly.
- [ ] Description is under 1024 characters.
- [ ] Body teaches things the agent wouldn't know without this skill (project-specific conventions, gotchas, non-obvious procedures). No generic advice.
- [ ] Body picks a default approach where multiple are valid.
- [ ] Body is under 500 lines.
- [ ] If the skill could fail in non-obvious ways, a Gotchas section calls them out.
- [ ] No fabricated facts. Every concrete claim either came from the input or is genuinely common knowledge.

When the rubric passes, you're done. Print a one-line summary (the slug + a one-sentence pitch) and stop turning. The skill is local-only at this point — the user will run ` + "`{NOTION_SKILLS} publish <slug>`" + ` themselves to share with their team.
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
