#!/usr/bin/env node
/**
 * Guards the packaging failure that is invisible from a checkout: the npm
 * tarball must contain the extension entry point, the reviewer agent, the
 * vendored upstream renderer and every prompt template, and must not ship
 * tests or local junk. Run: npm run verify:package
 *
 * The prompt files matter more than usual here: they are not decoration, they
 * ARE the command. A tarball missing src/prompts/ installs cleanly and then
 * throws on first use, since the templates are read from disk at render time.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Enumerate an asset directory instead of listing its files by hand.
 *
 * A hand-written inventory only guards the files that existed when it was
 * written: adding a seventh prompt or a sixth agent silently gets no coverage,
 * and if `package.json#files` is ever narrowed from directory globs to explicit
 * entries, the new template drops out of the tarball, the install still
 * succeeds, and `readPrompt()` throws ENOENT on first `/review`. Reading the
 * directory keeps the guard honest for free. Fails loudly on an empty result so
 * a moved directory cannot quietly empty the list.
 */
function assetsIn(dir) {
  const files = readdirSync(new URL(`../${dir}`, import.meta.url))
    .filter((f) => f.endsWith(".md") || f.endsWith(".ts"))
    .sort()
    .map((f) => `${dir}/${f}`);
  if (files.length === 0) throw new Error(`verify-package: ${dir}/ has no assets — did it move?`);
  return files;
}

const REQUIRED = [
  "package.json",
  "src/index.ts",
  "src/review-core.ts",
  "src/overrides.ts",
  "src/panel.ts",
  "src/vcs.ts",
  "src/branch-picker.ts",
  // Verbatim upstream templates + our override sections. Read at runtime, so a
  // missing one is a first-use crash rather than an install failure.
  ...assetsIn("src/prompts"),
  // The launch scripts. Also read from disk at render time (embed.ts extracts
  // the emitted region from the source), so they are runtime assets too.
  ...assetsIn("src/launch"),
  // Verbatim upstream renderer (zero-dependency).
  ...assetsIn("vendor"),
  ...assetsIn("agents"),
  "UPSTREAM",
  "LICENSE",
  "PROVENANCE.md",
  "README.md",
];

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const parsed = JSON.parse(raw);

// npm has shipped both shapes: an array of package objects (npm 8/9) and an
// object keyed by package name (npm 10+). Accept either.
const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
if (entries.length === 0) {
  console.error("verify-package: npm pack --dry-run --json returned no packages");
  process.exit(1);
}

const files = entries.flatMap(entry =>
  (entry.files ?? []).map(f => (typeof f === "string" ? f : f.path)).filter(Boolean),
);
if (files.length === 0) {
  console.error("verify-package: could not read a file list from npm pack output");
  process.exit(1);
}

let failed = false;

const missing = REQUIRED.filter(f => !files.includes(f));
if (missing.length > 0) {
  console.error(`verify-package: missing from the npm tarball:\n  ${missing.join("\n")}`);
  failed = true;
}

// A module imported directly must be declared, or a strict/non-hoisted install
// resolves it only by luck of hoisting. This is cheap to check and easy to
// forget when adding an import.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);
// Statement-position matches only. A looser regex also matches prose: the
// phrase `from "a/path b/path"` inside a doc comment is not an import.
// A `from` clause is required for export forms, because `export type Phase =
// "pre-render"` is a string literal in a type, not a module specifier.
const IMPORT_PATTERNS = [
  /^[ \t]*import[ \t]+(?:[^"'\n]*?\bfrom[ \t]+)?["']([^"'\n]+)["']/gm, // import ... from "x" / import "x"
  /^[ \t]*export[^"'\n]*?\bfrom[ \t]+["']([^"'\n]+)["']/gm, // export ... from "x"
  /^[ \t]*\}[ \t]*from[ \t]+["']([^"'\n]+)["']/gm, // closing brace of a multi-line import
  /\bimport[ \t]*\([ \t]*["']([^"'\n]+)["']/g, // await import("x")
];
const undeclared = new Map();
for (const rel of files.filter(f => /^(src|vendor)\/.*\.ts$/.test(f))) {
  const source = readFileSync(rel, "utf8");
  for (const pattern of IMPORT_PATTERNS) {
    for (const m of source.matchAll(pattern)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!declared.has(name)) {
        if (!undeclared.has(name)) undeclared.set(name, new Set());
        undeclared.get(name).add(rel);
      }
    }
  }
}
if (undeclared.size > 0) {
  for (const [name, where] of undeclared) {
    console.error(`verify-package: "${name}" is imported by ${[...where].join(", ")} but is not in dependencies/peerDependencies`);
  }
  failed = true;
}

// The install story depends on this manifest entry: pi-subagents discovers
// package agents from `pi.subagents.agents` (or `pi-subagents.agents`). Without
// it, `pi install` puts the extension in place but every agent the prompts name
// is missing, and users have to hand-copy files into ~/.pi to use the tool.
const subagentRoots = [pkg["pi-subagents"], pkg.pi?.subagents].filter(
  (r) => r && typeof r === "object" && !Array.isArray(r),
);
const agentDirs = subagentRoots.flatMap(r => (Array.isArray(r.agents) ? r.agents : []));
if (agentDirs.length === 0) {
  console.error(
    'verify-package: package.json does not expose an agents directory to pi-subagents.\n' +
    '  Add { "pi": { "subagents": { "agents": ["./agents"] } } } or users will have to copy agents into ~/.pi by hand.',
  );
  failed = true;
} else {
  const shippedAgents = files.filter(f => /^agents\/.*\.md$/.test(f));
  if (shippedAgents.length === 0) {
    console.error("verify-package: an agents directory is declared but no agents/*.md ship in the tarball");
    failed = true;
  }
}

// Renamed config fields must not survive in user-facing text. This has already
// happened twice: /review config taught `familyCount` after the parser started
// rejecting it, and the README kept a second "Panel rules" section doing the
// same. Docs that teach an invalid config are worse than no docs.
const REJECTED_FIELDS = ["familyCount", "maxChildren"];
// README plus the prompt templates. src/index.ts is deliberately excluded: it
// names the old fields on purpose, in its rename-error messages and in comments
// recording why. The user-facing config help is covered behaviourally by the
// handler harness, which renders it and asserts the rejected names are absent.
const DOC_FILES = ["README.md", "src/prompts/pi-distribution.md", "src/prompts/pi-multimodal-distribution.md"];
for (const rel of DOC_FILES) {
  if (!files.includes(rel)) continue;
  const source = readFileSync(rel, "utf8");
  for (const field of REJECTED_FIELDS) {
    // src/index.ts legitimately names them in its rename-error messages.
    const lines = source.split("\n").filter(l => l.includes(field));
    if (lines.length > 0) {
      console.error(`verify-package: ${rel} still names the rejected config field "${field}":`);
      for (const l of lines.slice(0, 3)) console.error(`    ${l.trim().slice(0, 110)}`);
      failed = true;
    }
  }
}

const tests = files.filter(f => /\.test\.ts$/.test(f));
if (tests.length > 0) {
  console.error(`verify-package: tests must not ship:\n  ${tests.join("\n")}`);
  failed = true;
}

if (failed) process.exit(1);
console.log(`verify-package: OK — ${files.length} files, all runtime assets present, no tests.`);
