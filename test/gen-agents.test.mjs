import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEN_AGENTS,
  buildAgentSpawnArgs,
  findGenAgent,
} from "../dist/gen-agents.js";

// gen-agents is the registry + invocation contract for handing a prompt
// to a coding-agent CLI. The mapping is regression-sensitive: each agent
// has a specific way to receive prompts and the tests pin those shapes.

test("GEN_AGENTS: includes claude, codex, opencode, gemini", () => {
  const keys = GEN_AGENTS.map((a) => a.key).sort();
  assert.deepEqual(keys, ["claude", "codex", "gemini", "opencode"]);
});

test("findGenAgent: returns the matching def", () => {
  const claude = findGenAgent("claude");
  assert.ok(claude);
  assert.equal(claude.bin, "claude");
});

test("findGenAgent: returns undefined for unknown keys", () => {
  assert.equal(findGenAgent("nonexistent"), undefined);
});

test("buildAgentSpawnArgs: claude runs in print mode with allowed-tools pre-approval and text streaming", () => {
  // Regression: claude has to exit after its turn so gen's post-exit
  // migrate step fires (hence -p). The agent has to be able to Write
  // a brand-new SKILL.md without hitting a permission prompt that
  // can't be answered in headless mode (hence --allowedTools=). We
  // pre-approve only Write/Read/WebFetch — no Bash, no MCP, no
  // arbitrary command execution. Note `--permission-mode acceptEdits`
  // does NOT cover creating new files, only modifying existing ones,
  // so we deliberately don't use it.
  const claude = findGenAgent("claude");
  const { args, stdin } = buildAgentSpawnArgs(claude, "hello world");
  assert.deepEqual(args, [
    "--output-format",
    "text",
    "--allowedTools=Write,Read,WebFetch",
    "-p",
    "hello world",
  ]);
  assert.equal(stdin, undefined);
});

test("buildAgentSpawnArgs: codex uses 'exec --full-auto' for hands-off run", () => {
  const codex = findGenAgent("codex");
  const { args } = buildAgentSpawnArgs(codex, "hello world");
  assert.deepEqual(args, ["exec", "--full-auto", "hello world"]);
});

test("buildAgentSpawnArgs: opencode uses 'run' subcommand", () => {
  const oc = findGenAgent("opencode");
  const { args } = buildAgentSpawnArgs(oc, "hello world");
  assert.deepEqual(args, ["run", "hello world"]);
});

test("buildAgentSpawnArgs: gemini uses -p print mode", () => {
  const gemini = findGenAgent("gemini");
  const { args } = buildAgentSpawnArgs(gemini, "hello world");
  assert.deepEqual(args, ["-p", "hello world"]);
});

test("buildAgentSpawnArgs: claude pre-approves Write so the SKILL.md actually lands", () => {
  // Regression: previously we relied on `--permission-mode acceptEdits`
  // for write permission, which DOESN'T cover creating new files. The
  // agent would print "(pending your approval)" and exit without
  // writing anything, leaving migrate with nothing to push. The fix
  // is `--allowedTools=Write,…`. This test pins that the Write tool
  // shows up in claude's argv so a future flag refactor can't silently
  // regress it.
  const claude = findGenAgent("claude");
  const { args } = buildAgentSpawnArgs(claude, "x");
  const allowedTools = args.find((a) => a.startsWith("--allowedTools"));
  assert.ok(
    allowedTools,
    `claude args should include --allowedTools= (got: ${args.join(" ")})`,
  );
  assert.match(allowedTools, /\bWrite\b/, "Write tool must be allow-listed");
});

test("buildAgentSpawnArgs: every agent uses a headless invocation (no agent left in REPL)", () => {
  // The whole point of this overhaul: each agent must exit after its
  // turn. There is no agent in this registry that should drop into a
  // REPL after generating the skill — gen's migrate step only fires
  // once the agent process exits.
  const headlessMarkers = {
    claude: "-p",
    codex: "exec",
    opencode: "run",
    gemini: "-p",
  };
  for (const [key, marker] of Object.entries(headlessMarkers)) {
    const agent = findGenAgent(key);
    const { args } = buildAgentSpawnArgs(agent, "x");
    assert.ok(
      args.includes(marker),
      `${key} args (${args.join(" ")}) should include the headless marker "${marker}"`,
    );
  }
});

test("buildAgentSpawnArgs: stdin pass mode (synthetic def)", () => {
  // Future-proofing the contract: any agent we register with
  // passPromptVia: "stdin" should hand back stdin and an empty positional.
  const synthetic = {
    key: "test",
    label: "Test",
    bin: "test",
    passPromptVia: "stdin",
    extraArgs: ["chat"],
  };
  const { args, stdin } = buildAgentSpawnArgs(synthetic, "hello");
  assert.deepEqual(args, ["chat"]);
  assert.equal(stdin, "hello");
});

test("buildAgentSpawnArgs: special characters survive the boundary", () => {
  // The agent invocation must not eat shell-meaningful characters; we
  // pass the prompt as an exec argv element, not through a shell.
  const claude = findGenAgent("claude");
  const tricky = "build $1 ${VAR} `cmd` $(cmd) | && \"quoted\"";
  const { args } = buildAgentSpawnArgs(claude, tricky);
  assert.equal(args[args.length - 1], tricky);
});
