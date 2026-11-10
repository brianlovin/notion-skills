#!/usr/bin/env node
// Fails if any `uses:` under .github/ isn't pinned to an immutable ref.
// Tags and branches can be re-pointed by whoever controls the action repo;
// a full commit SHA (or a sha256 digest for docker://) cannot.
//
// Usage: node scripts/check-pinned-actions.mjs [dir]   (default: .github)
// Dependency-free so CI can run it without `npm ci`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const USES_LINE = /^\s*(?:-\s+)?uses:\s*(["']?)([^\s"'#]+)\1/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const DOCKER_DIGEST = /@sha256:[0-9a-f]{64}$/;

/** Returns null if `ref` is pinned (or local), otherwise a reason string. */
export function unpinnedReason(ref) {
  if (ref.startsWith("./")) return null;
  if (ref.startsWith("docker://")) {
    return DOCKER_DIGEST.test(ref) ? null : "docker image not pinned to an @sha256 digest";
  }
  const at = ref.lastIndexOf("@");
  if (at === -1) return "missing @<ref>";
  return FULL_SHA.test(ref.slice(at + 1)) ? null : "ref is not a full 40-character commit SHA";
}

/** Scans YAML text; returns [{ line, ref, reason }] for each unpinned `uses:`. */
export function findUnpinnedUses(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = USES_LINE.exec(raw);
    if (!m) return;
    const reason = unpinnedReason(m[2]);
    if (reason) problems.push({ line: i + 1, ref: m[2], reason });
  });
  return problems;
}

function yamlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(name) ? [path] : [];
  });
}

/** Returns a list of "file:line: ref (reason)" strings for every unpinned `uses:` under `dir`. */
export function checkDir(dir) {
  return yamlFiles(dir).flatMap((file) =>
    findUnpinnedUses(readFileSync(file, "utf8")).map(
      (p) => `${relative(process.cwd(), file)}:${p.line}: ${p.ref} (${p.reason})`,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? ".github";
  const problems = checkDir(dir);
  if (problems.length) {
    console.error(`Unpinned action references in ${dir}/:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "\nPin each to a full commit SHA with the version as a trailing comment, e.g.\n" +
        "  uses: actions/checkout@<40-char-sha> # v5",
    );
    process.exit(1);
  }
  console.log(`All \`uses:\` references in ${dir}/ are pinned.`);
}
