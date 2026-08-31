#!/usr/bin/env node
/**
 * Guards the packaging failure that is invisible from a checkout: the npm
 * tarball must contain the extension entry point and the example reviewer
 * agents, and must not ship tests or local junk. Run: npm run verify:package
 */
import { execFileSync } from "node:child_process";

const REQUIRED = [
  "package.json",
  "src/index.ts",
  "agents/reviewer-primary.md",
  "agents/reviewer-linus.md",
  "agents/reviewer-danluu.md",
  "agents/reviewer-antagonist.md",
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

const tests = files.filter(f => /\.test\.ts$/.test(f));
if (tests.length > 0) {
  console.error(`verify-package: tests must not ship:\n  ${tests.join("\n")}`);
  failed = true;
}

if (failed) process.exit(1);
console.log(`verify-package: OK — ${files.length} files, all runtime assets present, no tests.`);
