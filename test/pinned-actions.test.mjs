import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDir, findUnpinnedUses, unpinnedReason } from "../scripts/check-pinned-actions.mjs";

const SHA = "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09";

test("unpinnedReason: full SHA, local, and docker digest are pinned", () => {
  assert.equal(unpinnedReason(`actions/checkout@${SHA}`), null);
  assert.equal(unpinnedReason(`github/codeql-action/init@${SHA}`), null);
  assert.equal(unpinnedReason(`octo/repo/.github/workflows/ci.yml@${SHA}`), null);
  assert.equal(unpinnedReason("./.github/actions/setup"), null);
  assert.equal(unpinnedReason(`docker://alpine@sha256:${"a".repeat(64)}`), null);
});

test("unpinnedReason: tags, branches, short SHAs, and docker tags are unpinned", () => {
  assert.ok(unpinnedReason("actions/checkout@v5"));
  assert.ok(unpinnedReason("actions/checkout@v5.1.0"));
  assert.ok(unpinnedReason("some/action@main"));
  assert.ok(unpinnedReason("some/action@fbc6f39"));
  assert.ok(unpinnedReason(`some/action@${SHA.toUpperCase()}`));
  assert.ok(unpinnedReason("some/action"));
  assert.ok(unpinnedReason("docker://alpine:3.20"));
});

test("findUnpinnedUses: reports line numbers and handles quotes/comments", () => {
  const yaml = [
    "steps:",
    `  - uses: actions/checkout@${SHA} # v5`,
    "  - name: Node",
    '    uses: "actions/setup-node@v5"',
    "  - uses: ./local-action",
    "  # uses: commented/out@v1",
  ].join("\n");
  assert.deepEqual(findUnpinnedUses(yaml), [
    { line: 4, ref: "actions/setup-node@v5", reason: "ref is not a full 40-character commit SHA" },
  ]);
});

test("repo's own .github/ has no unpinned uses", () => {
  assert.deepEqual(checkDir(".github"), []);
});
