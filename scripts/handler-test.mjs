#!/usr/bin/env node
/**
 * Deterministic handler harness for the /review command: mock pi + mock
 * ExtensionCommandContext, invoke the real registered handler, assert on the
 * emitted prompts. No model calls, no subagents, no writes outside an isolated
 * HOME and temp git repos (the harness refuses to run against a real home dir,
 * since /review config writes under ~/.pi).
 *
 * Three things are being protected here:
 *   1. the fidelity claim — upstream's verbatim template text must survive
 *      rendering, and our two override sections must actually replace omp-only
 *      instructions rather than sitting alongside them.
 *   2. the cross-product arithmetic — shards x families, capped, with shards
 *      (never families) reduced when the cap bites.
 *   3. the VCS layer, which is ours by necessity and therefore untested by
 *      upstream: run it against real git repos, not mocks.
 *
 * Run: npm test
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME BEFORE importing the module (config paths derive from it).
process.env.HOME = mkdtempSync(join(tmpdir(), "mmr-handler-test-"));

// Isolate git config on process.env, not just in FIXTURE_ENV below, and do it
// before the import too. src/vcs.ts spawns git with the INHERITED environment,
// so setting these only on the harness's own helper left the code under test
// reading the developer's real ~/.gitconfig — which decides whether this suite
// passes. `diff.noprefix` or `diff.mnemonicPrefix` change the diff header shape
// the parser matches, `core.excludesFile` hides fixture files, `diff.renames=false`
// defeats the rename cases, `status.showUntrackedFiles=no` defeats the new-file
// cases. CI has no global config and would pass while a contributor saw
// unrelated failures.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const CONFIG_DIR = join(process.env.HOME, ".pi", "agent", "multi-model-review");
const CONFIG = join(CONFIG_DIR, "config.json");
if (!CONFIG_DIR.startsWith(tmpdir())) throw new Error("refusing: HOME not isolated");

// The TUI branch picker builds a real SelectList, whose theme comes from the
// interactive theme singleton. Initialise it so test 17 exercises the real
// component rather than a stub.
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme(undefined, false);

const { default: mmrNS } = await import("../src/index.ts");
const mmr = mmrNS.default ?? mmrNS;

const commands = new Map();
const sent = [];
const notices = [];
const fakePi = {
	registerCommand: (name, def) => {
		commands.set(name, def);
	},
	sendUserMessage: (m) => sent.push(m),
};
mmr(fakePi);
for (const name of ["review", "review-multi-modal"]) {
	if (!commands.has(name)) throw new Error(`command not registered: ${name}`);
}
const command = { name: "review", def: commands.get("review") };
const multiModal = { name: "review-multi-modal", def: commands.get("review-multi-modal") };

const MODELS = [
	{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", provider: "ai-gw-anthropic-1m" },
	{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5 200k", provider: "ai-gw-anthropic-200k" },
	{ id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "ai-gw-openai" },
	{ id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", provider: "ai-gw-google" },
	{ id: "baseten/zai-org/GLM-5.3", name: "GLM 5.3", provider: "ai-gw-baseten" },
	{ id: "bedrock/qwen3-coder-480b", name: "Qwen3 Coder", provider: "ai-gw-bedrock" },
];

const editorCalls = [];
const selectCalls = [];
const inputCalls = [];
const customCalls = [];
const makeCtx = ({
	available = MODELS,
	cwd = "/tmp/mmr-not-a-repo-" + process.pid,
	hasUI = false,
	selectAnswers = {},
	inputAnswers = {},
	editorAnswer = undefined,
	entries = [],
	mode = "rpc",
	customPick = undefined,
} = {}) => ({
	hasUI,
	mode,
	cwd,
	ui: {
		notify: (m, s) => {
			notices.push(`${s}: ${m}`);
		},
		editor: async (title, prefill) => {
			editorCalls.push({ title, prefill });
			return editorAnswer;
		},
		select: async (title, options) => {
			selectCalls.push({ title, options });
			const answer = selectAnswers[title];
			if (typeof answer === "function") return answer(options);
			return answer;
		},
		// Terminal-only focused component. The harness drives it headlessly:
		// build the real component, feed it keystrokes, capture what it selects.
		custom: async (factory) => {
			let resolved;
			const tui = { requestRender: () => {} };
			const component = factory(tui, {}, {}, (r) => {
				resolved = r;
			});
			customCalls.push({ component });
			if (customPick) await customPick(component, () => resolved);
			return resolved;
		},
		input: async (title, placeholder) => {
			inputCalls.push({ title, placeholder });
			const answer = inputAnswers[title];
			return typeof answer === "function" ? answer() : answer;
		},
		confirm: async () => false,
	},
	sessionManager: { getBranch: () => entries },
	scopedModels: [],
	modelRegistry: {
		getAvailable: () => available,
		hasConfiguredAuth: () => true,
	},
});

let failures = 0;
let checks = 0;
function expect(cond, label) {
	checks++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures++;
}

/**
 * An uncaught throw used to end the run mid-way while every already-printed
 * PASS line stayed on screen — which reads as success to anything counting PASS
 * lines. Fail loudly instead, and assert the run reached the end.
 *
 * Kept close to the real count. A floor far below it (this was 100 against 289
 * actual checks) lets whole blocks stop running — deleted, or skipped by an
 * early return — without the guard ever noticing, which is the same
 * false-success it exists to prevent. Raise it when adding a block; lower it
 * only when deliberately removing coverage.
 */
const EXPECTED_MIN_CHECKS = 298;
process.on("uncaughtException", (err) => {
	console.error(`\nHARNESS CRASHED after ${checks} checks: ${err?.stack ?? err}`);
	process.exit(1);
});
function reset() {
	sent.length = 0;
	notices.length = 0;
	editorCalls.length = 0;
	selectCalls.length = 0;
	inputCalls.length = 0;
	customCalls.length = 0;
}

// ── temp git fixtures ───────────────────────────────────────────────────────
//
// These are throwaway repos in $TMPDIR that exist only to give git diff/show/
// merge-base something to parse, and are rm -rf'd at the end of the run. They
// are never pushed and are not project history.
//
// They are fully config-isolated: GIT_CONFIG_GLOBAL/SYSTEM are pointed at
// /dev/null (on process.env at the top of this file, so the git subprocesses
// inside src/vcs.ts inherit it too, not only the helper below) so the
// developer's global git config cannot influence a fixture or the code reading
// it, and identity is set per-repo. That isolation is also why no signing config
// appears here — with no global config in scope there is nothing to turn off,
// and requiring signed fixtures would make `npm test` depend on a live
// gpg-agent/1Password socket to test diff parsing, failing in CI and whenever
// signing is down. Real commits to THIS repo are signed as normal; that is a
// separate thing from fixture data.
const FIXTURE_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};
function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: FIXTURE_ENV });
}
function makeRepo({ commits = 1 } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "mmr-repo-"));
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "t@example.com"]);
	git(dir, ["config", "user.name", "T"]);
	for (let i = 0; i < commits; i++) {
		writeFileSync(join(dir, `f${i}.txt`), `line ${i}\n`);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", `commit ${i}`]);
	}
	return dir;
}
const repos = [];
function repo(opts) {
	const d = makeRepo(opts);
	repos.push(d);
	return d;
}

/**
 * Stub `gh` on PATH for the PR tests.
 *
 * The alternative — calling real `gh` — makes the suite depend on network,
 * auth and an installed binary, and can only ever assert "the PR path was
 * attempted" because the call fails. Stubbing it lets us assert the PR diff
 * actually reaches the prompt, and keeps the harness hermetic.
 */
const PR_STUB_DIFF = `diff --git a/src/pr-only.ts b/src/pr-only.ts
index 111..222 100644
--- a/src/pr-only.ts
+++ b/src/pr-only.ts
@@ -1,2 +1,3 @@
 const kept = 1;
-const removed = 2;
+const added = 3;
+const alsoAdded = 4;
`;
function withStubbedGh(fn) {
	const binDir = mkdtempSync(join(tmpdir(), "mmr-stub-bin-"));
	repos.push(binDir);
	const script = `#!/bin/sh
# stub gh: only \`gh pr diff <n> --repo <repo>\` is expected
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  cat <<'DIFF'
${PR_STUB_DIFF}DIFF
  exit 0
fi
echo "stub gh: unexpected args: $*" >&2
exit 1
`;
	writeFileSync(join(binDir, "gh"), script, { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${binDir}:${previousPath}`;
	return Promise.resolve(fn()).finally(() => {
		process.env.PATH = previousPath;
	});
}

// ────────────────────────────────────────────────────────────────────────────
// 1. DEFAULT is EXACTLY upstream: one model, one pass, upstream's own wording
// ────────────────────────────────────────────────────────────────────────────
rmSync(CONFIG, { force: true });
reset();
await command.def.handler("", makeCtx());
const p1 = sent[0] ?? "";
expect(p1.includes("## Code Review Request"), "1a: upstream heading present (verbatim template rendered)");
expect(p1.includes("omp-reviewer"), "1b: upstream's single reviewer agent named");
expect(!p1.includes("`task` tool"), "1c: omp-only `task` tool instruction replaced with subagent");
expect(!/incremental `yield`/.test(p1), "1d: omp-only yield findings channel replaced");
expect(!/model famil(y|ies) = /.test(p1), "1e: no multi-family fan-out arithmetic by default");
expect(!p1.includes("cross-check"), "1f: no second pass by default \u2014 upstream has none");
expect(!p1.includes("Step 1 \u2014 pick"), "1g: no model-picking step by default");
expect(!p1.includes("shardId"), "1h: no per-family seat machinery by default");
expect(p1.includes("reviewer task") || p1.includes("reviewer agents"), "1i: upstream's own distribution wording");
mkdirSync(CONFIG_DIR, { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ shardDepth: 3 }));
reset();
await command.def.handler("", makeCtx());
const p1multi = sent[0] ?? "";
expect(p1multi.includes("Group files by locality"), "1j: upstream's locality guidance preserved when sharding");
expect(p1multi.includes("Spawn **3 reviewer agents**"), "1j2: upstream's plural wording, with the configured depth");
// The phrase "model families" legitimately appears in the opt-in pointer, so
// assert the absence of the fan-out ARITHMETIC, which is what a panel adds.
expect(!/\d+ shards? x \d+ model famil/.test(p1multi), "1j3: still one model \u2014 shardDepth alone does not create a panel");
expect(!p1multi.includes("Step 1 \u2014 pick"), "1j4: no model-picking step when families is 1");
rmSync(CONFIG, { force: true });
expect(p1.includes("above 1"), "1k: tells you how to opt into the panel");

mkdirSync(CONFIG_DIR, { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ families: 3, crossCheck: true }));
reset();
await command.def.handler("", makeCtx());
const pPanel = sent[0] ?? "";
expect(/3 model families/.test(pPanel), "1m: opt-in renders the family fan-out");
expect(pPanel.includes("ai-gw-anthropic-1m/anthropic/claude-sonnet-5"), "1n: candidates come from the session registry");
expect(pPanel.includes('{ action: "list" }'), "1o: agent preflight present in panel mode");
expect(pPanel.includes("shardId"), "1p: per-family seat machinery present");
expect(/Independent agreement comes from `pass1` only/.test(pPanel), "1q: agreement counted from uncontaminated pass 1");
expect(pPanel.includes("pass1: done1.map"), "1r: skeleton returns pass-1 write-ups so the tally is computable");
expect(pPanel.includes("Unresolved disagreement is a result, not a failure"), "1s: split panel reported, not resolved away");
expect(pPanel.includes("cross-check"), "1t: cross-check section renders when enabled");

writeFileSync(CONFIG, JSON.stringify({ families: 1, crossCheck: true }));
reset();
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("needs at least 2 families"), "1u: crossCheck with one family is refused");

// families > 1 with crossCheck OFF must emit NO second pass. Gating only the
// Step 4 heading left the skeleton building pass2Items, resuming peers and
// running a second runs.all — silently doubling spend against the config.
writeFileSync(CONFIG, JSON.stringify({ families: 3, crossCheck: false }));
reset();
await command.def.handler("", makeCtx());
const pNoCross = sent[0] ?? "";
expect(/3 model families/.test(pNoCross), "1x: still a multi-family panel");
for (const machinery of ["pass2Items", "resume:", "runs.all(pass2Items)", "uncrossChecked", "Survival comes from"]) {
	expect(!pNoCross.includes(machinery), `1y-${machinery.replace(/[^a-z]/gi, "")}: no pass-2 machinery when crossCheck is off`);
}
expect(pNoCross.includes("One pass, so every seat"), "1z: single-pass synthesis branch renders");
expect(pNoCross.includes('Enable `"crossCheck"`'), "1z2: and points at the switch that would add a second pass");
rmSync(CONFIG, { force: true });

writeFileSync(CONFIG, JSON.stringify({ families: 2, shardDepth: 7 }));
reset();
await command.def.handler("", makeCtx());
expect(/7 shards/.test(sent[0] ?? ""), "1v: shardDepth overrides the heuristic");
expect((sent[0] ?? "").includes("overridden to 7 by config"), "1w: the override is disclosed in the prompt");
rmSync(CONFIG, { force: true });

// ────────────────────────────────────────────────────────────────────────────
// 2. /review config must teach fields that actually exist, with their cost
//    It previously named `familyCount`, which the parser REJECTS — the help was
//    instructing users to write an invalid config.
// ────────────────────────────────────────────────────────────────────────────
reset();
await command.def.handler("config", makeCtx());
const cfgHelp = sent[0] ?? "";
expect(cfgHelp.includes("panel rules live at"), "2a: config path shown");
expect(!/familyCount/.test(cfgHelp), "2b: does NOT name the rejected `familyCount` field");
expect(!/maxChildren/.test(cfgHelp), "2b2: nor the rejected `maxChildren` field");
for (const field of ["families", "shardDepth", "crossCheck", "confirmAboveRuns", "exclude"]) {
	expect(cfgHelp.includes(`\`${field}\``), `2c-${field}: help documents \`${field}\``);
}
expect(!cfgHelp.includes('"seats"'), "2d: no persona seats");
// cost is the constraint users actually manage
expect(/multiplies your run count/i.test(cfgHelp), "2e: says families multiplies cost");
expect(/DOUBLES invocations/i.test(cfgHelp), "2f: says crossCheck doubles cost");
// The old wording said "Total reviewer runs = shardDepth x families" while also
// warning that crossCheck doubles invocations — two different numbers presented
// as one. The help must state the figure the guard actually uses.
expect(cfgHelp.includes("Total model invocations = `shardDepth` x `families`"), "2g: states the invocation arithmetic");
expect(/doubled again when `crossCheck` is on/.test(cfgHelp), "2g2: ...including the doubling");
expect(/compared against that doubled figure/.test(cfgHelp), "2g3: and says the guard uses the doubled figure");
expect(/cheapest/.test(cfgHelp), "2h: names the cheapest option (upstream parity)");
expect(cfgHelp.includes("/review-multi-modal"), "2i: warns which command is the expensive one");

// The prefilled text handed to the user MUST round-trip through the parser —
// otherwise /review config offers a starting point that cannot be saved.
{
	const panelNS = await import("../src/panel.ts");
	const panel = panelNS.default ?? panelNS;
	const prefill = cfgHelp.slice(cfgHelp.indexOf("```json") + 7, cfgHelp.indexOf("```", cfgHelp.indexOf("```json") + 7));
	const round = panel.parsePanelConfig(prefill);
	expect(!round.error, `2j: the prefilled config parses cleanly (${round.error ?? "ok"})`);
	expect(round.config?.families === 1, "2k: default prefill is one model — upstream parity");
	expect(round.config?.shardDepth === "auto", "2l: default prefill defers to upstream's heuristic");
	expect(round.config?.crossCheck === false, "2m: default prefill has no second pass");
}

// ────────────────────────────────────────────────────────────────────────────
// 3. An old persona config blocks with an actionable message
// ────────────────────────────────────────────────────────────────────────────
mkdirSync(CONFIG_DIR, { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ seats: [{ key: "a", agent: "reviewer-primary" }] }));
reset();
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("/review blocked"), "3a: old seats config blocks");
expect((sent[0] ?? "").includes("/review-multi-modal"), "3b: points at the command that still runs personas");

// ────────────────────────────────────────────────────────────────────────────
// 4. Malformed JSON blocks; config editor prefills the RAW broken text
// ────────────────────────────────────────────────────────────────────────────
writeFileSync(CONFIG, "{ families: ");
reset();
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("/review blocked"), "4a: malformed config blocks review");
reset();
await command.def.handler("config", makeCtx());
expect((sent[0] ?? "").includes("{ families: "), "4b: raw broken text shown for repair");

// ────────────────────────────────────────────────────────────────────────────
// 5. Rule validation
// ────────────────────────────────────────────────────────────────────────────
writeFileSync(CONFIG, JSON.stringify({ families: 0 }));
reset();
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("between 1 and 8"), "5a: families range enforced");

writeFileSync(CONFIG, JSON.stringify({ families: 4, maxChildren: 2 }));
reset();
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("was renamed to"), "5b: retired maxChildren field blocks with a rename hint");

writeFileSync(CONFIG, JSON.stringify({ confirmAboveRuns: 0 }));
reset();
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("between 1 and 256"), "5c: confirmAboveRuns range enforced");

// ────────────────────────────────────────────────────────────────────────────
// 6. Excludes shrink the candidate pool; empty pool blocks
// ────────────────────────────────────────────────────────────────────────────
writeFileSync(CONFIG, JSON.stringify({ exclude: ["ai-gw-baseten/*", "ai-gw-anthropic-*"] }));
reset();
await command.def.handler("", makeCtx());
const p6 = sent[0] ?? "";
expect(!p6.includes("baseten"), "6a: baseten excluded from pool");
expect(!p6.includes("anthropic"), "6b: anthropic routes excluded from pool");
writeFileSync(CONFIG, JSON.stringify({ families: 3, exclude: ["ai-gw-baseten/*", "ai-gw-anthropic-*"] }));
reset();
await command.def.handler("", makeCtx());
const p6panel = sent[0] ?? "";
expect(p6panel.includes("ai-gw-openai"), "6c: unexcluded routes still offered (panel mode lists models)");
expect(!p6panel.includes("baseten"), "6c2: excludes still apply in panel mode");

rmSync(CONFIG, { force: true });
reset();
await command.def.handler("", makeCtx({ available: [] }));
expect((sent[0] ?? "").includes("/review blocked"), "6d: empty model pool blocks");

// ────────────────────────────────────────────────────────────────────────────
// 7. Not a repo → friendly message, not raw git noise
// ────────────────────────────────────────────────────────────────────────────
reset();
await command.def.handler("", makeCtx({ hasUI: true, cwd: tmpdir() }));
expect(notices.some((n) => n.includes("isn't a git or jj repository")), "7: friendly not-a-repo message");

// ────────────────────────────────────────────────────────────────────────────
// 8. UI: uncommitted mode against a real repo, incl. untracked files
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo();
	writeFileSync(join(dir, "f0.txt"), "line 0\nmodified\n");
	writeFileSync(join(dir, "brand-new.ts"), "export const x = 1;\n"); // untracked
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "2. Review uncommitted changes" },
		}),
	);
	const p = sent[0] ?? "";
	expect(p.includes("f0.txt"), "8a: modified file in the file table");
	// The untracked file must be absent from the REVIEWED content (upstream
	// behaviour) while being named as an exclusion. Checking the changed-files
	// section specifically, since a bare "not in the prompt" assertion would now
	// be satisfied for the wrong reason and would also forbid disclosing it.
	// New files ARE reviewed: `git add` is not a precondition for a review tool.
	const changedFilesSection = p.slice(p.indexOf("### Changed Files"), p.indexOf("### Distribution Guidelines"));
	expect(changedFilesSection.includes("brand-new.ts"), "8b: a brand-new untracked file IS reviewed");
	expect(p.includes("export const x = 1"), "8b2: its content reaches the reviewers");
	expect(!p.includes("Coverage gap"), "8b3: nothing disclosed when every new file could be diffed");
	expect(p.includes("### Diff"), "8c: small diff inlined");
	expect(p.includes("exactly **1 reviewer task**"), "8d: tiny diff => exactly one reviewer task, upstream wording");
}

// ────────────────────────────────────────────────────────────────────────────
// 9. UI: commit mode against a real repo
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 3 });
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: {
				"Review Mode": "3. Review a specific commit",
				"Select commit to review": (options) => options[0],
			},
		}),
	);
	const p = sent[0] ?? "";
	expect(p.includes("Reviewing commit"), "9a: commit mode prompt");
	expect(p.includes("f2.txt"), "9b: that commit's file present");
}

// ────────────────────────────────────────────────────────────────────────────
// 10. UI: base-branch mode — typed name first, short recent list as fallback
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 2 });
	git(dir, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(dir, "feature.ts"), "export const feature = true;\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "feature work"]);

	const baseTitle = "Base branch for `feature` — name, or text to filter:";

	// 10a-c: typing the branch name skips the list entirely
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
			inputAnswers: { [baseTitle]: "main" },
		}),
	);
	let p = sent[0] ?? "";
	expect(p.includes("(PR-style)"), "10a: base-branch mode prompt");
	expect(p.includes("feature.ts"), "10b: only branch-unique work reviewed");
	expect(!p.includes("f0.txt"), "10c: base-only commits excluded");
	expect(!selectCalls.some((c) => c.title.startsWith("Base branch")), "10d: typed name needs no branch list");

	// 10e: a typo is caught up front, not as a confusing merge-base failure
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
			inputAnswers: { [baseTitle]: "mian" },
		}),
	);
	expect(notices.some((n) => n.includes("No branch, tag or commit matches")), "10e: nonexistent base rejected clearly");

	// 10f-h: blank input falls back to a SHORT, recency-ordered list
	for (let i = 0; i < 40; i++) git(dir, ["branch", `noise-${String(i).padStart(2, "0")}`]);
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
			inputAnswers: { [baseTitle]: "" },
		}),
	);
	const list = selectCalls.find((c) => c.title.startsWith("Base branch"));
	expect(Boolean(list), "10f: blank input falls back to a branch list");
	expect(Boolean(list) && list.options.length <= 30, `10g: list capped (got ${list?.options.length}) — no endless scrolling`);
	expect(Boolean(list) && !list.options.includes("feature"), "10h: current branch excluded from the list");
	expect(Boolean(list) && list.title.includes("most recent of"), "10i: title says the list is truncated");

	// 10j: unrelated history => explicit block, not a tip-to-tip diff
	git(dir, ["checkout", "-q", "--orphan", "orphan"]);
	git(dir, ["rm", "-rq", "--cached", "."]);
	writeFileSync(join(dir, "only.txt"), "unrelated\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "orphan root"]);
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
			inputAnswers: { "Base branch for `orphan` — name, or text to filter:": "main" },
		}),
	);
	expect(notices.some((n) => n.includes("No common history")), "10j: unrelated histories blocked");
}

// ────────────────────────────────────────────────────────────────────────────
// 11. Cross-product arithmetic: shards x families, capped by reducing shards
// ────────────────────────────────────────────────────────────────────────────
{
	// A big, many-file diff drives upstream's heuristic above 1 shard.
	const dir = repo();
	let big = "";
	for (let f = 0; f < 30; f++) {
		let body = "";
		for (let i = 0; i < 300; i++) body += `export const v${f}_${i} = ${i};\n`;
		writeFileSync(join(dir, `mod${f}.ts`), body);
		big += body;
	}
	git(dir, ["add", "-A"]);

	writeFileSync(CONFIG, JSON.stringify({ families: 3, confirmAboveRuns: 12, crossCheck: true }));
	reset();
	await command.def.handler(
		"",
		makeCtx({ hasUI: true, cwd: dir, selectAnswers: { "Review Mode": "2. Review uncommitted changes" } }),
	);
	const p = sent[0] ?? "";
	const m = p.match(/\*\*(\d+) shards? x (\d+) model famil\w+ = (\d+) reviewer runs?\*\*/);
	expect(Boolean(m), "11a: fan-out arithmetic stated in the prompt");
	let shards = 0;
	if (m) {
		const [, s, families, children] = m.map(Number);
		shards = s;
		expect(families === 3, "11b: familyCount honoured");
		expect(shards > 1, "11c: heavy diff => multiple shards");
		expect(children === shards * families, "11d: children == shards x families");
	}
	expect(p.includes("Diff omitted") || p.includes("Diff Previews"), "11e: oversized diff not inlined");

	// A low threshold must NOT change the arithmetic — it asks the user instead.
	writeFileSync(CONFIG, JSON.stringify({ families: 3, confirmAboveRuns: 2, crossCheck: true }));
	reset();
	await command.def.handler(
		"",
		makeCtx({ hasUI: true, cwd: dir, selectAnswers: { "Review Mode": "2. Review uncommitted changes" } }),
	);
	const p2 = sent[0] ?? "";
	const m2 = p2.match(/\*\*(\d+) shards? x (\d+) model famil\w+ = (\d+) reviewer runs?\*\*/);
	expect(Boolean(m2) && Number(m2[2]) === 3, "11f: threshold does not reduce families");
	expect(Boolean(m2) && Number(m2[1]) === shards, "11g: threshold does not reduce upstream's shard count");
	expect(p2.includes("Confirm before launching"), "11h: large fan-out asks the user first");
	expect(p2.includes("Do NOT silently reduce"), "11i: prompt forbids quietly shrinking the panel");
	rmSync(CONFIG, { force: true });
}

// ────────────────────────────────────────────────────────────────────────────
// 12. PR references: from args and detected from conversation history
// ────────────────────────────────────────────────────────────────────────────
await withStubbedGh(async () => {
	reset();
	await command.def.handler("https://github.com/octo/repo/pull/42", makeCtx({ hasUI: true, cwd: tmpdir() }));
	const p = sent[0] ?? "";
	expect(p.includes("PR octo/repo#42"), "12a: PR url in args reviews that PR");
	expect(p.includes("src/pr-only.ts"), "12b: fetched PR diff reaches the prompt");
	expect(selectCalls.length === 0, "12c: PR path skips the menu entirely");
	expect(p.includes("gh pr diff 42 --repo octo/repo"), "12d: reviewers told to use gh, not omp's pr:// scheme");
	expect(!p.includes("pr://"), "12e: no unresolvable pr:// URLs survive");
	expect(p.includes("MUST NOT read local workspace files"), "12f: upstream PR context restriction preserved");

	const dir = repo();
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			entries: [
				{ type: "message", message: { role: "user", content: "please look at https://github.com/octo/repo/pull/7 later" } },
			],
			selectAnswers: { "Review Mode": (options) => options[0] },
		}),
	);
	const menu = selectCalls.find((c) => c.title === "Review Mode");
	expect(Boolean(menu) && menu.options[0].includes("Review PR octo/repo#7 from conversation"), "12g: PR detected from conversation history");
	expect(Boolean(menu) && menu.options.some((o) => o.startsWith("1. Review against a base branch")), "12h: upstream menu labels intact");
	expect((sent[0] ?? "").includes("PR octo/repo#7"), "12i: choosing the detected PR reviews it");
});

// ────────────────────────────────────────────────────────────────────────────
// 13. Extra instructions suppress the custom menu entry (upstream behaviour)
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo();
	reset();
	await command.def.handler("focus on error handling", makeCtx({ hasUI: true, cwd: dir, selectAnswers: {} }));
	const menu = selectCalls.find((c) => c.title === "Review Mode");
	expect(Boolean(menu) && !menu.options.some((o) => o.startsWith("4.")), "13a: no custom entry when args given");

	reset();
	await command.def.handler(
		"focus on error handling",
		makeCtx({ hasUI: true, cwd: dir, selectAnswers: { "Review Mode": "2. Review uncommitted changes" } }),
	);
	// clean tree => warning, no prompt
	expect(notices.some((n) => n.includes("No uncommitted changes found")), "13b: clean tree warns instead of prompting");
}

// ────────────────────────────────────────────────────────────────────────────
// 15. Base-branch mode reviews the NET parent -> working-tree state
//     Regression: a committed change later reverted in the tree must NOT be in
//     the payload. Concatenating base..HEAD with the tree diff shipped both the
//     obsolete hunk and its reversal, so reviewers re-litigated deleted code
//     and parseDiff listed the file twice with doubled stats.
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 2 });
	git(dir, ["checkout", "-q", "-b", "feature"]);

	// committed on the branch: one change we keep, one we will revert
	writeFileSync(join(dir, "keep.ts"), "export const keep = 1;\n");
	writeFileSync(join(dir, "rapid.go"), "package rapid\n\nfunc Risky() {}\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "committed work incl. a change we will revert"]);

	// in the working tree: revert rapid.go to its pre-branch state (it did not
	// exist at the base, so reverting means deleting it), plus a staged fix and
	// an unstaged edit
	execFileSync("git", ["rm", "-q", "rapid.go"], { cwd: dir, env: FIXTURE_ENV });
	writeFileSync(join(dir, "audit-fix.ts"), "export const auditFixed = true;\n");
	git(dir, ["add", "audit-fix.ts"]);
	writeFileSync(join(dir, "f0.txt"), "line 0\nunstaged edit\n");

	const baseTitle = "Base branch for `feature` — name, or text to filter:";
	const runBase = (cwd) =>
		command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				inputAnswers: { [baseTitle]: "main" },
			}),
		);

	reset();
	await runBase(dir);
	const p = sent[0] ?? "";

	// the point of the whole exercise
	expect(!p.includes("rapid.go"), "15a: a committed change reverted in the tree is ABSENT (no re-litigating deleted code)");
	expect(!p.includes("func Risky"), "15b: the obsolete hunk's content is absent too");

	expect(p.includes("keep.ts"), "15c: committed work that still stands is reviewed");
	expect(p.includes("audit-fix.ts"), "15d: staged-but-uncommitted fixes are reviewed");
	expect(p.includes("f0.txt"), "15e: unstaged edits are reviewed");

	// no file may appear twice in the changed-files table
	const tableRows = p
		.split("\n")
		.filter((l) => /^\|[^|]+\|\s*\+\d+\/-\d+/.test(l) || /^\|\s*\S+\.\w+\s*\|/.test(l));
	const paths = tableRows.map((l) => l.split("|")[1]?.trim()).filter(Boolean);
	expect(paths.length === new Set(paths).size, `15f: no duplicate rows in the file table (${paths.join(", ")})`);

	expect(p.includes("net state of the working tree"), "15g: mode states it is the net current state");
	// staged: the `git rm rapid.go` deletion + the audit-fix.ts add = 2.
	// unstaged: f0.txt modified but never staged = 1.
	expect(notices.some((n) => /2 staged/.test(n) && /1 unstaged/.test(n)), "15h: staged/unstaged counts reported");

	// reviewers who must pull the diff themselves get ONE command, and are told
	// not to also diff base..HEAD (which would reintroduce the reverted hunk)
	const big = repo({ commits: 1 });
	git(big, ["checkout", "-q", "-b", "feature"]);
	for (let i = 0; i < 25; i++) writeFileSync(join(big, `m${i}.ts`), `export const a${i} = ${i};\n`);
	git(big, ["add", "-A"]);
	git(big, ["commit", "-q", "-m", "many files"]);
	for (let i = 0; i < 25; i++) writeFileSync(join(big, `m${i}.ts`), `export const a${i} = ${i + 1};\n`);
	reset();
	await runBase(big);
	const bigPrompt = sent[0] ?? "";
	// The self-pull instruction must be the temp-index reproduction, not a plain
	// `git diff <base>` — see block 20, which executes it.
	expect(/D=\$\(mktemp -d\)/.test(bigPrompt), "15i: self-pulled diff reproduces the reviewed snapshot");
	expect(bigPrompt.includes("Do NOT diff"), "15j: reviewers warned off the stale committed range");

	// a clean tree stays byte-identical to upstream's PR-style behaviour
	const clean = repo({ commits: 2 });
	git(clean, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(clean, "only-committed.ts"), "export const x = 1;\n");
	git(clean, ["add", "-A"]);
	git(clean, ["commit", "-q", "-m", "work"]);
	reset();
	await runBase(clean);
	expect((sent[0] ?? "").includes("(PR-style)"), "15k: clean tree uses upstream's mode string");
	expect((sent[0] ?? "").includes("only-committed.ts"), "15l: clean tree reviews the committed work");
	expect(!notices.some((n) => n.includes("uncommitted")), "15m: clean tree says nothing about uncommitted work");
}

// ────────────────────────────────────────────────────────────────────────────
// 16. Base-branch picker: exact ref, type-to-filter, unique match, no matches
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 2 });
	git(dir, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(dir, "w.ts"), "export const w = 1;\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "work"]);
	// a monorepo-ish branch namespace
	for (let i = 0; i < 40; i++) git(dir, ["branch", `noise-${String(i).padStart(2, "0")}`]);
	git(dir, ["branch", "release/prod-2024"]);
	git(dir, ["branch", "release/prod-2025"]);
	git(dir, ["branch", "scott.meyer/embedded-app-config-api"]);

	const baseTitle = "Base branch for `feature` — name, or text to filter:";
	const run = (answer) =>
		command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd: dir,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				inputAnswers: { [baseTitle]: answer },
			}),
		);

	// exact ref: no list at all
	reset();
	await run("main");
	expect(!selectCalls.some((c) => c.title.startsWith("Base branch")), "16a: exact ref skips the list");

	// filter matching several: bounded, filtered list
	reset();
	await run("prod");
	const filtered = selectCalls.find((c) => c.title.startsWith("Base branch"));
	expect(Boolean(filtered), "16b: a fragment produces a filtered list");
	expect(Boolean(filtered) && filtered.options.length === 2, `16c: only matches shown (got ${filtered?.options.length})`);
	expect(Boolean(filtered) && filtered.options.every((o) => o.includes("prod")), "16d: every option matches the filter");
	expect(Boolean(filtered) && filtered.title.includes('matching `prod`'), "16e: title states the filter");

	// unique match: used directly, no list of one
	reset();
	await run("embedded");
	expect(!selectCalls.some((c) => c.title.startsWith("Base branch")), "16f: unique match needs no list");
	expect(notices.some((n) => n.includes("scott.meyer/embedded-app-config-api")), "16g: unique match is reported");

	// no match: actionable error, no silent fallthrough
	reset();
	await run("nonexistent-xyz");
	expect(notices.some((n) => n.includes("No branch, tag or commit matches")), "16h: unmatched filter errors clearly");
	expect(sent.length === 0, "16i: unmatched filter emits no review");

	// blank: recent locals, capped
	reset();
	await run("");
	const recent = selectCalls.find((c) => c.title.startsWith("Base branch"));
	expect(Boolean(recent) && recent.options.length <= 30, `16j: blank list capped (got ${recent?.options.length})`);
	expect(Boolean(recent) && !recent.options.includes("feature"), "16k: current branch excluded");
	expect(Boolean(recent) && recent.title.includes("most recent of"), "16l: title says the list is truncated");
}

// ────────────────────────────────────────────────────────────────────────────
// 14. Oversized diffs: sized before fetching, refused with real numbers
//     (regression guard for `spawnSync git ENOBUFS`, which named neither the
//     command nor the cause)
// ────────────────────────────────────────────────────────────────────────────
{
	// jiti nests a .ts module's named exports under `.default` for dynamic
	// import(), same as the extension import at the top of this file.
	const vcsNS = await import("../src/vcs.ts");
	const vcs = vcsNS.default ?? vcsNS;

	// the pure size check, exercised directly with monorepo-scale numbers
	const huge = { files: 4300, insertions: 900000, deletions: 300000 };
	const msg = vcs.diffTooLargeMessage(huge, "`old-release`..`feature`");
	expect(Boolean(msg), "14a: oversized diff is refused");
	expect(Boolean(msg) && msg.includes("4,300 files"), "14b: message states the measured file count");
	expect(Boolean(msg) && msg.includes("1,200,000 changed lines"), "14c: message states the measured line count");
	expect(Boolean(msg) && msg.includes("forked from"), "14d: message points at the likely cause");
	expect(vcs.diffTooLargeMessage({ files: 12, insertions: 400, deletions: 90 }, "x") === undefined, "14e: ordinary diffs pass");
	expect(
		vcs.diffTooLargeMessage({ files: 5, insertions: 10, deletions: 0 }, "x", { files: 2, lines: 1000 }) !== undefined,
		"14f: file ceiling enforced independently of the line ceiling",
	);

	// shortstat parses real git output and does not buffer the diff body
	const dir = repo();
	let body = "";
	for (let i = 0; i < 500; i++) body += `export const v${i} = ${i};\n`;
	writeFileSync(join(dir, "big.ts"), body);
	git(dir, ["add", "-A"]);
	const size = vcs.shortstat(dir, ["diff", "--cached"]);
	expect(size.files === 1 && size.insertions === 500, `14g: shortstat parses git output (got ${JSON.stringify(size)})`);

	// A real oversized diff is refused by the handler, not crashed on. This trips
	// the genuine 2,000-file ceiling rather than patching DIFF_LIMITS: jiti can
	// hold a second module instance, so a mutation here need not reach the
	// handler's copy — which is exactly how 14h/14i first passed while testing
	// nothing.
	const overflow = repo();
	for (let i = 0; i < 2100; i++) writeFileSync(join(overflow, `f${i}.txt`), `${i}\n`);
	git(overflow, ["add", "-A"]);
	reset();
	await command.def.handler(
		"",
		makeCtx({ hasUI: true, cwd: overflow, selectAnswers: { "Review Mode": "2. Review uncommitted changes" } }),
	);
	expect(notices.some((n) => n.includes("ceiling")), "14h: handler refuses an oversized diff with an explanation");
	expect(notices.some((n) => /2,1\d\d files/.test(n)), "14h2: refusal states the measured file count");
	expect(sent.length === 0, "14i: no review prompt emitted for an oversized diff");
}

// ────────────────────────────────────────────────────────────────────────────
// 17. TUI branch picker: bounded viewport + LIVE type-to-filter
//     (the original complaint was scrolling through thousands of rows; this
//     drives the real component, not a mock of it)
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 2 });
	git(dir, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(dir, "w.ts"), "export const w = 1;\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "work"]);
	for (let i = 0; i < 200; i++) git(dir, ["branch", `noise-${String(i).padStart(3, "0")}`]);
	git(dir, ["branch", "release/prod-2025"]);
	git(dir, ["branch", "scott.meyer/embedded-app-config-api"]);

	const type = (component, text) => {
		for (const ch of text) component.handleInput(ch);
	};
	const runTui = (drive) =>
		command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				mode: "tui",
				cwd: dir,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				customPick: drive,
			}),
		);

	// 17a-c: bounded viewport — 200+ branches must NOT render 200+ rows
	reset();
	let rendered = [];
	await runTui(async (component) => {
		rendered = component.render(100);
		type(component, "main");
		component.handleInput("\r");
	});
	expect(customCalls.length === 1, "17a: TUI mode uses the custom component, not ui.select");
	expect(rendered.length < 25, `17b: viewport bounded (rendered ${rendered.length} lines for 200+ branches)`);
	expect(rendered.join("\n").includes("type to filter"), "17c: filter affordance shown");
	expect((sent[0] ?? "").includes("(PR-style)"), "17d: typing a name and pressing enter starts the review");

	// 17e-g: filtering is live and narrows in place
	reset();
	let beforeFilter = 0;
	let afterFilter = 0;
	await runTui(async (component) => {
		beforeFilter = component.render(100).length;
		type(component, "prod");
		const after = component.render(100);
		afterFilter = after.length;
		expect(after.join("\n").includes("prod"), "17e: typed filter is echoed by the input field");
		expect(after.join("\n").includes("release/prod-2025"), "17f: matching branch visible after filtering");
		component.handleInput("\r");
	});
	expect(afterFilter < beforeFilter, `17g: filtering shrinks the list (${beforeFilter} -> ${afterFilter} lines)`);
	expect((sent[0] ?? "").includes("release/prod-2025") === false, "17h: chosen base is not echoed as a reviewed file");

	// 17i-j: backspace and ctrl+u edit the filter
	reset();
	await runTui(async (component) => {
		type(component, "prodX");
		expect(component.render(100).join("\n").includes("prodX"), "17i: filter accumulates characters");
		component.handleInput("\x7f"); // backspace -> "prod"
		const afterBs = component.render(100).join("\n");
		expect(afterBs.includes("prod") && !afterBs.includes("prodX"), "17j: backspace edits the filter");
		component.handleInput("\x15"); // ctrl+u -> cleared
		expect(!component.render(100).join("\n").includes("prod"), "17k: ctrl+u clears the filter text");
		expect(component.render(100).join("\n").includes("branches)"), "17k2: cleared filter shows the full count again");
		component.handleInput("\x1b"); // escape -> cancel
	});
	expect(sent.length === 0, "17l: escape cancels without launching a review");

	// 17n-q: input arrives as WHOLE STRINGS, not one key at a time. A
	// `data.length === 1` filter silently drops every one of these: a pasted
	// branch name, and — on Kitty-protocol terminals — every ordinary keypress,
	// which arrive as CSI-u sequences like \x1b[97u for "a".
	reset();
	await runTui(async (component) => {
		component.handleInput("prod"); // one multi-character event
		const text = component.render(100).join("\n");
		expect(text.includes("prod"), "17n: a multi-character input event reaches the filter");
		expect(text.includes("release/prod-2025"), "17o: and actually narrows the list");
		component.handleInput("\x1b");
	});

	reset();
	await runTui(async (component) => {
		// bracketed paste, exactly as a terminal delivers it
		component.handleInput("\x1b[200~scott.meyer/embedded-app-config-api\x1b[201~");
		const text = component.render(100).join("\n");
		expect(text.includes("scott.meyer/embedded-app-config-api"), "17p: bracketed paste reaches the filter");
		expect(text.includes("1 of"), "17q: pasted name narrows to the single match");
		component.handleInput("\x1b");
	});

	// Enter after a paste must actually confirm. Pasting `main` (which really
	// differs from `feature`) rather than a branch created at feature's own HEAD,
	// because an identical base yields an empty diff and would prove nothing
	// about whether the selection was confirmed.
	reset();
	await runTui(async (component) => {
		component.handleInput("\x1b[200~main\x1b[201~");
		component.handleInput("\r"); // CR, which is what terminals send
		return undefined;
	});
	expect((sent[0] ?? "").includes("(PR-style)"), "17r: CR after a paste confirms the selection and starts the review");
	expect((sent[0] ?? "").includes("w.ts"), "17r2: the review covers the branch work");

	reset();
	await runTui(async (component) => {
		// Kitty CSI-u for "p", "r", "o", "d" — what a modern terminal actually sends
		for (const code of [112, 114, 111, 100]) component.handleInput(`\x1b[${code}u`);
		const text = component.render(100).join("\n");
		expect(text.includes("prod"), "17s: Kitty CSI-u printable keys reach the filter");
		expect(text.includes("release/prod-2025"), "17t: and narrow the list");
		component.handleInput("\x1b");
	});

	// 17m: descriptions carry local/remote + age, which is why a bounded list works
	reset();
	await runTui(async (component) => {
		const text = component.render(100).join("\n");
		expect(/local ·/.test(text), "17m: rows annotated with local/remote and age");
		component.handleInput("\x1b");
	});
}

// ────────────────────────────────────────────────────────────────────────────
// 18. Net base -> DISK semantics, verified by CONTENT not by row counts
//     `git diff <base>` is index-aware and misreports the worktree: after
//     `git rm --cached f` it calls f deleted and loses edits made to it. A
//     "no duplicate rows" assertion passes on that wrong content, so these
//     tests assert what the payload actually says about each file.
// ────────────────────────────────────────────────────────────────────────────
{
	const baseTitle = (b) => `Base branch for \`${b}\` — name, or text to filter:`;
	const runBase = (cwd, branch) =>
		command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				inputAnswers: { [baseTitle(branch)]: "main" },
			}),
		);

	// brand-new files, no `git add`
	const onlyNew = repo({ commits: 2 });
	git(onlyNew, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(onlyNew, "brand-new-a.ts"), "export const a = 1;\n");
	writeFileSync(join(onlyNew, "brand-new-b.ts"), "export const b = 2;\n");
	reset();
	await runBase(onlyNew, "feature");
	let p = sent[0] ?? "";
	expect(p.includes("brand-new-a.ts") && p.includes("brand-new-b.ts"), "18a: untracked-only work is reviewed, no git add needed");
	expect(p.includes("export const a = 1"), "18b: their contents reach the reviewers as additions");
	expect(notices.some((n) => /2 new/.test(n)), "18c: the notice counts new files");

	// committed work + a forgotten new file
	const mixed = repo({ commits: 2 });
	git(mixed, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(mixed, "done.ts"), "export const done = 1;\n");
	git(mixed, ["add", "-A"]);
	git(mixed, ["commit", "-q", "-m", "committed work"]);
	writeFileSync(join(mixed, "forgot-to-add.ts"), "export const forgot = true;\n");
	reset();
	await runBase(mixed, "feature");
	p = sent[0] ?? "";
	expect(p.includes("done.ts"), "18d: committed work reviewed");
	expect(p.includes("forgot-to-add.ts"), "18e: the un-added file reviewed too");

	// THE case: `git rm --cached f` + edit f on disk + delete another file.
	// Correct answer: f is MODIFIED (not deleted), the edit is visible, and the
	// genuinely deleted file is reported deleted.
	const uncached = repo({ commits: 2 });
	git(uncached, ["checkout", "-q", "-b", "feature"]);
	execFileSync("git", ["rm", "-q", "--cached", "f0.txt"], { cwd: uncached, env: FIXTURE_ENV });
	writeFileSync(join(uncached, "f0.txt"), "line 0\nEDITED ON DISK\n");
	execFileSync("git", ["rm", "-q", "f1.txt"], { cwd: uncached, env: FIXTURE_ENV });
	reset();
	await runBase(uncached, "feature");
	p = sent[0] ?? "";
	const diffSection = p.slice(p.indexOf("<diff>") >= 0 ? p.indexOf("<diff>") : 0);
	expect(p.includes("EDITED ON DISK"), "18f: an edit to an un-cached-but-present file is reviewed");
	expect(!/^-line 0$[\s\S]*?diff --git/m.test(diffSection.split("f1.txt")[0] ?? ""), "18g: f0.txt is not presented as wholly deleted");
	expect(/\|\s*f0\.txt\s*\|\s*\+\d+\/-\d+/.test(p), "18h: f0.txt appears in the table as a modification");
	expect(p.includes("f1.txt"), "18i: a genuinely deleted file is still reported");
	const rows = p
		.split("\n")
		.filter((l) => l.startsWith("|") && /\+\d+\/-\d+/.test(l))
		.map((l) => l.split("|")[1]?.trim());
	expect(rows.length === new Set(rows).size, `18j: no duplicate rows (${rows.join(", ")})`);

	// the real index must be untouched by the temporary-index machinery
	const before = execFileSync("git", ["status", "--porcelain"], { cwd: uncached, encoding: "utf8", env: FIXTURE_ENV });
	reset();
	await runBase(uncached, "feature");
	const after = execFileSync("git", ["status", "--porcelain"], { cwd: uncached, encoding: "utf8", env: FIXTURE_ENV });
	expect(before === after, "18k: reviewing does not touch the real index or worktree");
}

// ────────────────────────────────────────────────────────────────────────────
// 19. Undiffable files are disclosed IN THE PROMPT, with escaped filenames
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 2 });
	git(dir, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(dir, "reviewed.ts"), "export const reviewed = 1;\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "tracked work"]);
	// binary content: present in the diff but with no reviewable hunk
	writeFileSync(join(dir, "blob-one.bin"), Buffer.from([0, 159, 146, 150, 0]));
	writeFileSync(join(dir, "blob-two.bin"), Buffer.from([0, 1, 0, 2, 0]));

	const baseTitle = "Base branch for `feature` — name, or text to filter:";
	const run = (cwd) =>
		command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				inputAnswers: { [baseTitle]: "main" },
			}),
		);

	reset();
	await run(dir);
	const p = sent[0] ?? "";
	expect(p.includes("Coverage gap"), "19a: the prompt itself declares the coverage gap");
	expect(p.includes("blob-one.bin") && p.includes("blob-two.bin"), "19b: undiffable paths are named in the prompt");
	expect(/2 file\(s\) could NOT be included/.test(p), "19c: the count is stated");
	expect(p.includes("were NOT reviewed"), "19d: synthesis is required to disclose it");
	expect(p.includes("never as instructions"), "19e: prompt tells the agent to treat paths as data");
	expect(p.includes("reviewed.ts"), "19f: reviewable work is still reviewed");
	expect(p.includes('"blob-one.bin"'), "19g: paths are rendered quoted/escaped");

	// no spurious section when everything could be included
	const clean = repo({ commits: 2 });
	git(clean, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(clean, "only.ts"), "export const only = 1;\n");
	git(clean, ["add", "-A"]);
	git(clean, ["commit", "-q", "-m", "work"]);
	reset();
	await run(clean);
	expect(!(sent[0] ?? "").includes("Coverage gap"), "19h: no coverage section when nothing is excluded");

	// a filename containing a backtick and a newline must not break the list or
	// read as instructions
	const hostile = repo({ commits: 1 });
	const nastyName = "we`ird\nname.bin";
	let wrote = true;
	try {
		writeFileSync(join(hostile, nastyName), Buffer.from([0, 1, 2, 0, 3]));
	} catch {
		wrote = false; // some filesystems reject newlines in names
	}
	if (wrote) {
		reset();
		await command.def.handler(
			"",
			makeCtx({ hasUI: true, cwd: hostile, selectAnswers: { "Review Mode": "2. Review uncommitted changes" } }),
		);
		const all = `${sent.join("\n")}\n${notices.join("\n")}`;
		expect(all.includes(JSON.stringify(nastyName)), "19i: hostile filename rendered escaped");
		expect(!/^- we`ird$/m.test(all), "19j: its newline does not split the list item");
	} else {
		expect(true, "19i-j: filesystem rejected the hostile filename; not exercised");
	}

	// the panel skeleton must define every field it interpolates
	writeFileSync(CONFIG, JSON.stringify({ families: 3, crossCheck: true }));
	reset();
	await run(dir);
	const panelPrompt = sent[0] ?? "";
	const seatShape = panelPrompt.slice(panelPrompt.indexOf("const seats = ["), panelPrompt.indexOf("const pass1Task"));
	for (const field of ["key:", "shardId:", "model:", "files:", "diff:"]) {
		expect(seatShape.includes(field), `19k-${field.replace(":", "")}: seat shape documents ${field}`);
	}
	rmSync(CONFIG, { force: true });
}

// ────────────────────────────────────────────────────────────────────────────
// 20. Large diffs: the emitted pull command must REPRODUCE the payload
//     When the diff is too big to inline, seats fetch their own hunks. The
//     payload comes from a throwaway index that is already deleted, so a
//     plain `git diff <base>` reports a `rm --cached`ed file as deleted and
//     omits new files — the reviewer would review a deletion that never
//     happened. This executes the instruction we actually emit.
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 1 });
	git(dir, ["checkout", "-q", "-b", "feature"]);
	// >20 files so skipDiff engages and reviewers must pull their own hunks
	for (let i = 0; i < 25; i++) writeFileSync(join(dir, `mod${i}.ts`), `export const v${i} = ${i};\n`);
	writeFileSync(join(dir, "target.txt"), "line 0\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "many files"]);
	// the adversarial state: un-cached but present on disk, and edited
	execFileSync("git", ["rm", "-q", "--cached", "target.txt"], { cwd: dir, env: FIXTURE_ENV });
	writeFileSync(join(dir, "target.txt"), "line 0\nEDITED ON DISK\n");
	writeFileSync(join(dir, "brand-new.ts"), "export const fresh = true;\n");

	const baseTitle = "Base branch for `feature` — name, or text to filter:";
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
			inputAnswers: { [baseTitle]: "main" },
		}),
	);
	const p = sent[0] ?? "";
	expect(p.includes("Diff Previews") || p.includes("Diff omitted"), "20a: diff is too large to inline (skipDiff path)");

	// pull the command out of the prompt exactly as a reviewer would read it
	const m = p.match(/D=\$\(mktemp -d\)[^`]*rm -rf "\$D"/);
	expect(Boolean(m), "20b: prompt emits a reproduction command");
	expect(!/MUST run `git diff [0-9a-f]+ -- <path>` for assigned files$/m.test(p), "20c: does not tell reviewers to use plain git diff");
	expect(!p.includes("mktemp -u"), "20c2: no race-prone `mktemp -u` in the emitted command");

	if (m) {
		// The emitted command takes ALL of a seat's paths in one invocation.
		const runFor = (...paths) =>
			execFileSync("bash", ["-c", m[0].replaceAll("<all your assigned paths>", paths.join(" "))], {
				cwd: dir,
				encoding: "utf8",
				env: FIXTURE_ENV,
			});

		// the un-cached-but-edited file: must be a modification with the real edit
		const target = runFor("target.txt");
		expect(target.includes("+EDITED ON DISK"), "20d: emitted command reproduces the on-disk edit");
		expect(!target.includes("deleted file"), "20e: and does NOT report the file as deleted");

		// a brand-new file: must be reproducible by the same command
		const fresh = runFor("brand-new.ts");
		expect(fresh.includes("+export const fresh = true;"), "20f: emitted command reproduces new-file content");

		// the wrong command that we explicitly warn against
		const wrong = execFileSync("git", ["diff", "--", "target.txt"], { cwd: dir, encoding: "utf8", env: FIXTURE_ENV });
		expect(!wrong.includes("EDITED ON DISK"), "20g: the plain command we warn against really is wrong here");

		// and it must not disturb the repository
		const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", env: FIXTURE_ENV });
		runFor("target.txt");
		const statusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", env: FIXTURE_ENV });
		expect(statusBefore === statusAfter, "20h: the command is read-only w.r.t. the real index");

		// RENAMES: reproduction must match the payload, which needs the whole tree
		// staged AND both halves passed to the diff.
		//
		// The renamed file must exist in the BASE, otherwise there is no rename to
		// detect relative to base — it is simply a new file, and the assertion
		// would be testing something the fixture cannot exhibit. The diff must
		// also be big enough for the heuristic to shard, since the "keep rename
		// pairs together" rule is sharding advice and only renders then.
		const ren = repo({ commits: 1 });
		let body = "";
		for (let i = 0; i < 200; i++) body += `export const moved${i} = ${i};\n`;
		writeFileSync(join(ren, "moved.ts"), body);
		for (let i = 0; i < 25; i++) writeFileSync(join(ren, `f${i}.ts`), "export const x = 0;\n");
		git(ren, ["add", "-A"]);
		git(ren, ["commit", "-q", "-m", "base content"]);
		git(ren, ["checkout", "-q", "-b", "feature"]);
		git(ren, ["mv", "moved.ts", "renamed.ts"]);
		for (let i = 0; i < 25; i++) {
			let changed = "";
			for (let k = 0; k < 12; k++) changed += `export const v${i}_${k} = ${k + 1};\n`;
			writeFileSync(join(ren, `f${i}.ts`), changed);
		}
		reset();
		await command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd: ren,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				inputAnswers: { "Base branch for `feature` — name, or text to filter:": "main" },
			}),
		);
		const rp = sent[0] ?? "";
		expect(/rename|renamed\.ts/.test(rp), "20i2: the payload itself sees the rename");
		expect(rp.includes("Keep both halves of a rename in the same shard"), "20n: sharding rule keeps rename pairs together");

		const rm = rp.match(/D=\$\(mktemp -d\)[^`]*rm -rf "\$D"/);
		expect(Boolean(rm), "20n2: multi-shard prompt still emits the reproduction command");
		if (rm) {
			const runRename = (...paths) =>
				execFileSync("bash", ["-c", rm[0].replaceAll("<all your assigned paths>", paths.join(" "))], {
					cwd: ren,
					encoding: "utf8",
					env: FIXTURE_ENV,
				});
			const bothSides = runRename("moved.ts", "renamed.ts");
			expect(bothSides.includes("rename from moved.ts"), "20j: with both halves, reproduction shows the rename");
			expect(bothSides.includes("rename to renamed.ts"), "20k: ...including the destination");
			// one half alone loses the pairing — the artefact the prompt warns about
			const oneSide = runRename("renamed.ts");
			expect(!oneSide.includes("rename from"), "20l: one half alone loses rename pairing");
			expect(rp.includes("artefact of path filtering"), "20m: prompt warns that a split rename is an artefact");
		}
	}
}

// ────────────────────────────────────────────────────────────────────────────
// 21. /review-multi-modal: the persona panel, single pass, no sharding
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 2 });
	git(dir, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(dir, "work.ts"), "export const work = 1;\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "work"]);

	rmSync(CONFIG, { force: true });
	reset();
	await multiModal.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
			inputAnswers: { "Base branch for `feature` — name, or text to filter:": "main" },
		}),
	);
	const p = sent[0] ?? "";
	expect(p.includes("## Code Review Request"), "21a: shares the verbatim upstream request template");
	expect(p.includes("work.ts"), "21b: same diff machinery as /review");

	// every persona seat is named
	for (const agent of ["reviewer-primary", "reviewer-linus", "reviewer-danluu", "reviewer-antagonist"]) {
		expect(p.includes(agent), `21c-${agent}: panel names ${agent}`);
	}
	expect(p.includes("cheapest"), "21d: extra personas go on the cheap families");
	expect(p.includes("say which families you picked as cheap"), "21e: and the agent must disclose its choice");
	expect(p.includes("No sharding"), "21f: no sharding — every seat sees the whole diff");
	expect(!p.includes("pass2"), "21g: single pass, no cross-check machinery");
	expect(!p.includes("shardId"), "21h: no shard grouping");
	expect(p.includes("there is no second pass and no seat has read another"), "21i: agreement is uncontaminated by construction");
	expect(p.includes("ai-gw-anthropic-1m/anthropic/claude-sonnet-5"), "21j: model candidates from the session registry");
	expect(p.includes("async: true"), "21k: launches in the background");
	expect(p.includes("Do not edit any files"), "21l: review-only instruction retained");

	// /review is unaffected by /review-multi-modal existing
	reset();
	await command.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
			inputAnswers: { "Base branch for `feature` — name, or text to filter:": "main" },
		}),
	);
	const shardedPrompt = sent[0] ?? "";
	expect(!shardedPrompt.includes("reviewer-linus"), "21m: /review still uses only upstream's reviewer");
	expect(shardedPrompt.includes("omp-reviewer"), "21n: ...namely omp-reviewer");
}

// ────────────────────────────────────────────────────────────────────────────
// 22. The default never pauses to confirm — upstream does not
//     Upstream's heuristic recommends up to 16 shards on a big diff. Gating
//     confirmation on run count alone made the DEFAULT stop and ask on exactly
//     the large changes where that heuristic matters, which is not upstream.
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 1 });
	git(dir, ["checkout", "-q", "-b", "feature"]);
	// >5000 changed lines across >=13 files => heuristic returns min(16, files)
	for (let i = 0; i < 20; i++) {
		let body = "";
		for (let k = 0; k < 300; k++) body += `export const f${i}_${k} = ${k};\n`;
		writeFileSync(join(dir, `big${i}.ts`), body);
	}
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "large change"]);

	const baseTitle = "Base branch for `feature` — name, or text to filter:";
	const run = () =>
		command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd: dir,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				inputAnswers: { [baseTitle]: "main" },
			}),
		);

	// default: 16 shards, well past the 12 threshold, and still no prompt
	rmSync(CONFIG, { force: true });
	reset();
	await run();
	const dflt = sent[0] ?? "";
	expect(/Spawn \*\*(1[3-9]|[2-9]\d) reviewer agents\*\*/.test(dflt), `22a: heuristic recommends >12 shards (${(dflt.match(/Spawn \*\*(\d+) reviewer agents/) ?? [])[1]})`);
	expect(!dflt.includes("Confirm before launching"), "22b: the default never pauses to confirm — upstream does not");

	// opt into families: now it is OUR multiplier, so it must confirm
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG, JSON.stringify({ families: 3 }));
	reset();
	await run();
	const panel = sent[0] ?? "";
	expect(panel.includes("Confirm before launching"), "22c: opting into families does confirm");
	expect(/= \d+ reviewer runs/.test(panel), "22d: and states the arithmetic");

	// an explicit shardDepth is the user's own number: still no prompt
	writeFileSync(CONFIG, JSON.stringify({ shardDepth: 20 }));
	reset();
	await run();
	expect(!(sent[0] ?? "").includes("Confirm before launching"), "22e: an explicit shardDepth is not second-guessed");
	rmSync(CONFIG, { force: true });

	// /review-multi-modal always states the threshold, since only the agent can
	// count its own seats
	reset();
	await multiModal.def.handler(
		"",
		makeCtx({
			hasUI: true,
			cwd: dir,
			selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
			inputAnswers: { [baseTitle]: "main" },
		}),
	);
	const mm = sent[0] ?? "";
	expect(mm.includes("more than 12 runs"), "22f: panel states the run threshold");
	expect(mm.includes("it is yours to count"), "22g: ...and says why the extension cannot precompute it");
}

// ────────────────────────────────────────────────────────────────────────────
// 23. /review-multi-modal must be the panel on EVERY path
//     The variant is threaded through the interactive builders, but the headless
//     and PR-URL paths use different builders. Missing the variant there made
//     /review-multi-modal silently render ordinary /review — the wrong fan-out,
//     with no error to notice.
// ────────────────────────────────────────────────────────────────────────────
{
	const panelMarkers = ["reviewer-linus", "reviewer-antagonist", "No sharding", "cheapest"];
	const shardedMarkers = ["Group files by locality", "omp-reviewer"];

	// headless
	rmSync(CONFIG, { force: true });
	reset();
	await multiModal.def.handler("", makeCtx({ hasUI: false }));
	const mmHeadless = sent[0] ?? "";
	for (const marker of panelMarkers) {
		expect(mmHeadless.includes(marker), `23a-${marker.replace(/\W/g, "")}: headless panel includes "${marker}"`);
	}
	expect(!mmHeadless.includes("Group files by locality"), "23b: headless panel does not shard");

	reset();
	await command.def.handler("", makeCtx({ hasUI: false }));
	const shHeadless = sent[0] ?? "";
	expect(shHeadless.includes("omp-reviewer"), "23c: headless /review still upstream's reviewer");
	expect(!shHeadless.includes("reviewer-linus"), "23d: headless /review has no persona seats");

	// PR URL path (gh stubbed so the fetch succeeds)
	await withStubbedGh(async () => {
		reset();
		await multiModal.def.handler("https://github.com/octo/repo/pull/9", makeCtx({ hasUI: true, cwd: tmpdir() }));
		const mmPr = sent[0] ?? "";
		expect(mmPr.includes("PR octo/repo#9"), "23e: PR path reached for the panel command");
		for (const marker of panelMarkers) {
			expect(mmPr.includes(marker), `23f-${marker.replace(/\W/g, "")}: PR panel includes "${marker}"`);
		}
		expect(!mmPr.includes("Group files by locality"), "23g: PR panel does not shard");

		reset();
		await command.def.handler("https://github.com/octo/repo/pull/9", makeCtx({ hasUI: true, cwd: tmpdir() }));
		const shPr = sent[0] ?? "";
		expect(shPr.includes("omp-reviewer"), "23h: PR /review still upstream's reviewer");
		expect(!shPr.includes("reviewer-linus"), "23i: PR /review has no persona seats");
	});

	// custom-instructions path, both commands
	{
		const dir = repo({ commits: 1 });
		writeFileSync(join(dir, "f0.txt"), "line 0\nedited\n");
		reset();
		await multiModal.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd: dir,
				selectAnswers: { "Review Mode": "4. Custom review instructions" },
				editorAnswer: "Look at error handling",
			}),
		);
		expect((sent[0] ?? "").includes("reviewer-linus"), "23j: custom-mode panel keeps persona seats");
		reset();
		await command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd: dir,
				selectAnswers: { "Review Mode": "4. Custom review instructions" },
				editorAnswer: "Look at error handling",
			}),
		);
		expect(!(sent[0] ?? "").includes("reviewer-linus"), "23k: custom-mode /review stays upstream");
	}
	void shardedMarkers;
}

// ────────────────────────────────────────────────────────────────────────────
// 24. The cost guard counts INVOCATIONS, not seats
//     crossCheck resumes every surviving seat, so the real spend is up to 2x the
//     seat count. Guarding on seats let N=3,K=3,crossCheck spend up to 18 under
//     a 12 threshold with no prompt — the most expensive configuration was the
//     one the guard undercounted.
// ────────────────────────────────────────────────────────────────────────────
{
	const dir = repo({ commits: 2 });
	git(dir, ["checkout", "-q", "-b", "feature"]);
	writeFileSync(join(dir, "work.ts"), "export const work = 1;\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "work"]);
	const baseTitle = "Base branch for `feature` — name, or text to filter:";
	const run = () =>
		command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd: dir,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				inputAnswers: { [baseTitle]: "main" },
			}),
		);

	mkdirSync(CONFIG_DIR, { recursive: true });

	// 9 seats is under the threshold; 18 invocations is not. ONLY the doubled
	// total crosses it, so this fails if the guard counts seats.
	writeFileSync(CONFIG, JSON.stringify({ families: 3, shardDepth: 3, crossCheck: true, confirmAboveRuns: 12 }));
	reset();
	await run();
	const doubled = sent[0] ?? "";
	expect(doubled.includes("Confirm before launching"), "24a: doubled total crosses the threshold and prompts");
	expect(doubled.includes("up to 18 model invocations"), "24b: states the real invocation count, not the seat count");
	expect(doubled.includes("turn off crossCheck"), "24c: offers the switch that halves the cost");

	// same seats, no second pass: 9 invocations, under the threshold, no prompt
	writeFileSync(CONFIG, JSON.stringify({ families: 3, shardDepth: 3, crossCheck: false, confirmAboveRuns: 12 }));
	reset();
	await run();
	expect(!(sent[0] ?? "").includes("Confirm before launching"), "24d: without crossCheck the same seats stay under");

	// the fan-out line must not claim a total it does not mean
	writeFileSync(CONFIG, JSON.stringify({ families: 2, shardDepth: 2, crossCheck: true, confirmAboveRuns: 99 }));
	reset();
	await run();
	const small = sent[0] ?? "";
	expect(small.includes("up to 8 model invocations"), "24e: cross-checked runs disclose the doubled figure even under the threshold");
	expect(!small.includes("Confirm before launching"), "24f: ...without prompting when it is affordable");
	rmSync(CONFIG, { force: true });
}

// ────────────────────────────────────────────────────────────────────────────
// 25. Install story: `pi install` must be sufficient, with nothing to copy
//     pi-subagents discovers package agents from the manifest. If that entry is
//     missing, the extension installs but every agent its prompts name is
//     absent — and the tool is unusable until the user hand-copies into ~/.pi.
// ────────────────────────────────────────────────────────────────────────────
{
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const roots = [pkg["pi-subagents"], pkg.pi?.subagents].filter((r) => r && typeof r === "object" && !Array.isArray(r));
	const dirs = roots.flatMap((r) => (Array.isArray(r.agents) ? r.agents : []));
	expect(dirs.length > 0, "25a: manifest exposes an agents directory to pi-subagents");

	// every agent the prompts reference must actually exist in that directory
	const shipped = new Set(
		dirs.flatMap((d) => readdirSync(new URL(`../${d}/`, import.meta.url)).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))),
	);
	for (const agent of ["omp-reviewer", "reviewer-primary", "reviewer-linus", "reviewer-danluu", "reviewer-antagonist"]) {
		expect(shipped.has(agent), `25b-${agent}: ${agent} ships in the package`);
	}

	// and the prompts must not name an agent the package does not ship
	const named = new Set();
	for (const file of ["pi-distribution.md", "pi-multimodal-distribution.md"]) {
		const text = readFileSync(new URL(`../src/prompts/${file}`, import.meta.url), "utf8");
		for (const m of text.matchAll(/`(omp-reviewer|reviewer-[a-z]+)`/g)) named.add(m[1]);
		for (const m of text.matchAll(/agent: "([^"]+)"/g)) named.add(m[1]);
	}
	expect(named.size > 0, "25c: prompts reference agents by name");
	for (const agent of named) {
		expect(shipped.has(agent), `25d-${agent}: prompt references ${agent}, which the package ships`);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// 26. Regressions. Each check below corresponds to a defect that shipped and
//     was found in review; they assert observable behaviour (a rendered line, a
//     prompt's content, a produced count) rather than how the fix is written.
// ────────────────────────────────────────────────────────────────────────────
{
	const { visibleWidth } = await import("@earendil-works/pi-tui");

	// 26a-d: every picker line must fit the terminal width.
	//
	// pi's main screen THROWS on an over-width changed line, and because that
	// happens in a render callback the uncaughtException handler exits the
	// process — an over-wide line killed the user's session outright. Three
	// hand-built lines (title, no-match, footer hint) did not truncate. The
	// fixture uses a deliberately long branch name and a long filter, and the
	// widths include values narrower than the untruncated footer's 54 columns.
	const pdir = repo({ commits: 1 });
	git(pdir, ["checkout", "-q", "-b", "scott.meyer/a-deliberately-long-feature-branch-name-for-width"]);
	writeFileSync(join(pdir, "p.ts"), "export const p = 1;\n");
	git(pdir, ["add", "-A"]);
	git(pdir, ["commit", "-q", "-m", "work"]);
	git(pdir, ["branch", "another/quite-long-branch-name-to-filter-against"]);

	// Returns the widest rendered line, and THROWS if the picker never rendered.
	// Without that guard these four checks are vacuous on bypass: `pickBaseBranch`
	// skips the custom component whenever mode is not "tui" or the lazy pi-tui
	// import fails (an explicit warning-only fallback), `worst` stays 0, and
	// `0 <= width` passes while the component under test never ran — green tests
	// for the crash this block exists to catch.
	const overflowsAt = async (width, filterText) => {
		let worst = 0;
		await command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				mode: "tui",
				cwd: pdir,
				selectAnswers: { "Review Mode": "1. Review against a base branch (PR Style)" },
				customPick: async (component) => {
					for (const ch of filterText) component.handleInput(ch);
					for (const line of component.render(width)) worst = Math.max(worst, visibleWidth(line));
					component.handleInput("\x1b");
				},
			}),
		);
		if (customCalls.length !== 1) {
			throw new Error(`26: branch picker never rendered at width ${width} — width checks would be vacuous`);
		}
		return worst;
	};

	reset();
	const wideNoFilter = await overflowsAt(80, "");
	expect(wideNoFilter <= 80, `26a: long branch name fits 80 cols (worst line ${wideNoFilter})`);

	reset();
	const narrow = await overflowsAt(40, "");
	expect(narrow <= 40, `26b: footer hint fits a 40-col terminal (worst line ${narrow})`);

	reset();
	const longFilter = await overflowsAt(80, "a-filter-string-long-enough-to-overflow-the-no-match-line");
	expect(longFilter <= 80, `26c: unbounded filter text cannot overflow (worst line ${longFilter})`);

	reset();
	const veryNarrow = await overflowsAt(20, "zzz-no-such-branch");
	expect(veryNarrow <= 20, `26d: no-match line fits a 20-col terminal (worst line ${veryNarrow})`);

	// 26e-f: a rename must not be double-counted.
	//
	// `git status --porcelain -z` emits a rename as TWO NUL-terminated fields,
	// `R  new\0old\0`. Reading the bare origin path as a status entry counted one
	// `git mv` as both a staged AND an unstaged change, and those counts go into
	// the `mode` line every reviewer seat reads.
	const vcsNS2 = await import("../src/vcs.ts");
	const vcs2 = vcsNS2.default ?? vcsNS2;
	const rdir = repo({ commits: 1 });
	writeFileSync(join(rdir, "old.ts"), "export const v = 1;\n");
	git(rdir, ["add", "-A"]);
	git(rdir, ["commit", "-q", "-m", "add"]);
	git(rdir, ["mv", "old.ts", "new.ts"]);
	const rstat = vcs2.workingTreeStatus(rdir);
	expect(rstat.staged === 1, `26e: a rename counts as ONE staged change (got ${rstat.staged})`);
	expect(rstat.unstaged === 0, `26f: a rename creates no phantom unstaged change (got ${rstat.unstaged})`);

	// 26g-h: review works in a repository with no commits.
	//
	// `git read-tree HEAD` fails with `fatal: Not a valid object name HEAD`
	// before the first commit, which surfaced as a raw git error — in exactly the
	// case this port stages the worktree to support. Both object formats are
	// covered because the well-known empty-tree SHA is sha1-only.
	for (const fmt of ["sha1", "sha256"]) {
		const udir = mkdtempSync(join(tmpdir(), `mmr-unborn-${fmt}-`));
		repos.push(udir);
		git(udir, ["init", "-q", "-b", "main", `--object-format=${fmt}`]);
		git(udir, ["config", "user.email", "t@example.com"]);
		git(udir, ["config", "user.name", "T"]);
		writeFileSync(join(udir, "brand-new.ts"), "export const fresh = 1;\n");
		reset();
		await command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd: udir,
				selectAnswers: { "Review Mode": "2. Review uncommitted changes" },
			}),
		);
		const p = sent[0] ?? "";
		expect(p.includes("brand-new.ts"), `26g-${fmt}: pre-first-commit review reaches the prompt`);
		expect(
			!notices.some((n) => /Not a valid object name|Git command failed/.test(n)),
			`26h-${fmt}: unborn HEAD produces no raw git error`,
		);
	}

	// 26i-k: a hostile ~/.gitconfig must not silently empty the review.
	//
	// parseDiff matches `diff --git a/<p> b/<p>` exactly (verbatim upstream).
	// diff.noprefix, diff.mnemonicPrefix and color.ui=always each change that
	// header, which made every file fail to parse and the whole review abort with
	// "all changes filtered out". Set per-repo here, which is the same
	// configuration layer the flags must override.
	for (const [key, value] of [
		["diff.noprefix", "true"],
		["diff.mnemonicPrefix", "true"],
		["color.ui", "always"],
	]) {
		const hdir = repo({ commits: 1 });
		git(hdir, ["config", key, value]);
		writeFileSync(join(hdir, "hostile.ts"), "export const h = 1;\n");
		reset();
		await command.def.handler(
			"",
			makeCtx({
				hasUI: true,
				cwd: hdir,
				selectAnswers: { "Review Mode": "2. Review uncommitted changes" },
			}),
		);
		expect((sent[0] ?? "").includes("hostile.ts"), `26i-${key}: review survives ${key}=${value}`);
	}

	// 26w: `status.showUntrackedFiles=no` must not make a new-files-only tree read
	// as clean. `hasAnyChanges` gates the whole uncommitted path, so without -uall
	// it answered "no uncommitted changes" for exactly the case this port stages
	// the worktree to support.
	const nodir = repo({ commits: 1 });
	git(nodir, ["config", "status.showUntrackedFiles", "no"]);
	writeFileSync(join(nodir, "brand-new.ts"), "export const fresh = 1;\n");
	reset();
	await command.def.handler(
		"",
		makeCtx({ hasUI: true, cwd: nodir, selectAnswers: { "Review Mode": "2. Review uncommitted changes" } }),
	);
	expect((sent[0] ?? "").includes("brand-new.ts"), "26w: new-files-only tree is reviewed under showUntrackedFiles=no");

	// 26x-z: `diff.relative=true` narrows a diff to the cwd. Run from a
	// subdirectory it silently shrank the review, and because the size probe and
	// the --name-only path list were narrowed with the payload, coverageGaps could
	// not notice. Both halves must agree or the gap report itself goes wrong.
	const reldir = repo({ commits: 1 });
	mkdirSync(join(reldir, "sub"), { recursive: true });
	writeFileSync(join(reldir, "root.txt"), "a\n");
	writeFileSync(join(reldir, "sub", "deep.txt"), "b\n");
	git(reldir, ["add", "-A"]);
	git(reldir, ["commit", "-q", "-m", "seed"]);
	git(reldir, ["config", "diff.relative", "true"]);
	writeFileSync(join(reldir, "root.txt"), "a\nchanged\n");
	writeFileSync(join(reldir, "sub", "deep.txt"), "b\nchanged\n");
	const relOut = vcs2.uncommittedDiff(join(reldir, "sub"));
	expect(relOut.diffText.includes("root.txt"), "26x: diff.relative does not drop paths outside the cwd");
	expect(relOut.size.files === 2, `26y: size probe agrees with the payload (got ${relOut.size.files} files)`);
	expect(
		relOut.changedPaths.includes("root.txt") && relOut.changedPaths.includes("sub/deep.txt"),
		`26z: path list is repo-relative, not cwd-relative (got ${JSON.stringify(relOut.changedPaths)})`,
	);

	// 26aa: a rename whose ORIGIN path starts with `??` must not be mistaken for
	// an untracked file. Same two-field porcelain shape as 26e-f, different
	// consumer: untrackedFiles fed a nonexistent path into the coverage report.
	const oddDir = repo({ commits: 1 });
	writeFileSync(join(oddDir, "??odd.ts"), "export const odd = 1;\n");
	git(oddDir, ["add", "-A"]);
	git(oddDir, ["commit", "-q", "-m", "odd"]);
	git(oddDir, ["mv", "??odd.ts", "renamed.ts"]);
	const oddUntracked = vcs2.untrackedFiles(oddDir);
	expect(
		oddUntracked.length === 0,
		`26aa: a rename origin is not reported as untracked (got ${JSON.stringify(oddUntracked)})`,
	);

	// 26ab-ad: the snapshot command a seat is handed must actually fetch its files
	// when pi was launched in a SUBDIRECTORY. Paths we hand out are repo-root
	// relative (that is what --name-only reports) while git resolves pathspecs
	// against the cwd, so `sub/x.ts` from inside `sub/` looked for `sub/sub/x.ts`
	// and returned nothing — an empty review indistinguishable from a clean one.
	// Executed for real, because this is a shell string no type checker can verify.
	const subRepo = repo({ commits: 1 });
	mkdirSync(join(subRepo, "sub"), { recursive: true });
	writeFileSync(join(subRepo, "sub", "tracked.ts"), "export const t = 1;\n");
	git(subRepo, ["add", "-A"]);
	git(subRepo, ["commit", "-q", "-m", "seed sub"]);
	writeFileSync(join(subRepo, "sub", "tracked.ts"), "export const t = 2;\n");
	writeFileSync(join(subRepo, "sub", "untracked.ts"), "export const u = 1;\n");
	const subCwd = join(subRepo, "sub");
	const runSnapshot = (cmd, cwd, paths) =>
		execFileSync("sh", ["-c", cmd.replace("<all your assigned paths>", paths)], {
			cwd,
			encoding: "utf8",
			env: FIXTURE_ENV,
		});
	const subOut = runSnapshot(vcs2.reproduceSnapshotCommand("HEAD"), subCwd, "sub/tracked.ts sub/untracked.ts");
	expect(subOut.includes("sub/tracked.ts"), "26ab: snapshot command fetches a modified file from a subdirectory");
	expect(subOut.includes("sub/untracked.ts"), "26ac: snapshot command fetches a NEW file from a subdirectory");

	// 26ad: and the unborn-HEAD form of the same command must run too.
	const freshSub = mkdtempSync(join(tmpdir(), "mmr-fresh-sub-"));
	repos.push(freshSub);
	git(freshSub, ["init", "-q", "-b", "main"]);
	git(freshSub, ["config", "user.email", "t@example.com"]);
	git(freshSub, ["config", "user.name", "T"]);
	mkdirSync(join(freshSub, "nested"), { recursive: true });
	writeFileSync(join(freshSub, "nested", "first.ts"), "export const f = 1;\n");
	const freshOut = runSnapshot(vcs2.reproduceSnapshotCommand(null), join(freshSub, "nested"), "nested/first.ts");
	expect(freshOut.includes("nested/first.ts"), "26ad: unborn-HEAD snapshot command works from a subdirectory");

	// 26ae-ag: the headless prompt must hand over a command that WORKS, and must
	// not prescribe `git diff HEAD` — that omits never-added files (the whole point
	// of this port's staging deviation) and fails before the first commit.
	const headlessCmd = vcs2.headlessSnapshotCommand();
	const headlessOut = execFileSync("sh", ["-c", headlessCmd], { cwd: subCwd, encoding: "utf8", env: FIXTURE_ENV });
	expect(headlessOut.includes("sub/untracked.ts"), "26ae: headless snapshot command includes never-added files");
	const headlessFresh = execFileSync("sh", ["-c", headlessCmd], {
		cwd: join(freshSub, "nested"),
		encoding: "utf8",
		env: FIXTURE_ENV,
	});
	expect(headlessFresh.includes("nested/first.ts"), "26af: headless snapshot command works on an unborn HEAD");

	// 26l-n: coverage gaps are honest in BOTH directions.
	const rcNS = await import("../src/review-core.ts");
	const rc = rcNS.default ?? rcNS;
	const gapDiff = `diff --git a/blob.dat b/blob.dat
new file mode 100644
Binary files /dev/null and b/blob.dat differ
diff --git a/moved.ts b/renamed.ts
similarity index 100%
rename from moved.ts
rename to renamed.ts
diff --git a/mode.sh b/mode.sh
old mode 100644
new mode 100755
diff --git a/real.ts b/real.ts
--- a/real.ts
+++ b/real.ts
@@ -1 +1,2 @@
 a
+b
`;
	const gapStats = rc.parseDiff(gapDiff);
	const gaps = rc.unreviewablePaths(gapStats);
	expect(gaps.includes("blob.dat"), "26l: a binary is still reported as unreviewable");
	expect(
		!gaps.includes("renamed.ts") && !gaps.includes("mode.sh"),
		`26m: renames and mode-only changes are NOT false coverage gaps (got ${JSON.stringify(gaps)})`,
	);

	// 26n: the panel variant must disclose gaps too. It computed them and then
	// rendered nothing, so /review-multi-modal reported whole-change verdicts on
	// partially-reviewed changes.
	const panelCtx = {
		families: 3,
		shardDepth: "auto",
		crossCheck: false,
		confirmAboveRuns: 12,
		modelsText: "- `p/m` (M)",
	};
	for (const variant of ["sharded", "panel"]) {
		const rendered = rc.buildReviewPrompt("Reviewing X", gapStats, gapDiff, panelCtx, { untracked: gaps, variant });
		expect(
			rendered.includes('"blob.dat"') && /NOT reviewed/.test(rendered),
			`26n-${variant}: prompt discloses the unreviewable path`,
		);
	}

	// 26o-q: the custom-instructions prompt.
	//
	// It was spliced with the sharded reviewer instructions, which deleted
	// "Follow custom instructions" (the entire point of the mode), pointed the
	// reviewer at "diff hunks below" in a template containing no diff, and left a
	// bare "3." because two template variables were never supplied — the vendored
	// renderer resolves unknown names to empty rather than throwing.
	const custom = rc.buildCustomReviewPrompt("Check the auth flow", panelCtx, [], "sharded");
	expect(/[Ff]ollow (the )?custom instructions/.test(custom), "26o: custom review says to follow the instructions");
	expect(!/diff hunks below/.test(custom), "26p: custom review does not cite a diff it has no diff for");
	expect(!/^\d+\.\s*$/m.test(custom), "26q: custom review renders no empty numbered instruction");
	// The reviewer sees only its own task text, so "follow the custom instructions"
	// is worthless unless the orchestrator is told to put them IN that task.
	expect(
		/task .*MUST contain the custom instructions/.test(custom),
		"26q2: custom review requires the instructions to be carried into the child task",
	);
	expect(custom.includes("Check the auth flow"), "26q3: the custom instructions themselves are in the prompt");

	// 26r: the headless prompt must still say WHAT to review. Upstream's
	// distribution line carried "for recent code changes" and was replaced
	// wholesale, leaving fan-out mechanics and no scope at all.
	const headless = rc.buildHeadlessReviewPrompt(panelCtx, "auth", "sharded");
	expect(/recent code changes/i.test(headless), "26r: headless prompt states its review scope");
	// It must also hand over the working command, not a paraphrase of one.
	expect(headless.includes("GIT_INDEX_FILE"), "26r2: headless prompt carries the real snapshot command");
	expect(
		!/run `git diff HEAD`|^run `git diff HEAD`/m.test(headless),
		"26r3: headless prompt does not prescribe plain `git diff HEAD`",
	);

	// 26r4-r5: cross-check synthesis must filter pass 2 on ok and report pass-2
	// failures. Otherwise a failed cross-check's error receipt is presented as a
	// reconsidered review, and the seat reads as fully cross-checked.
	const ccPrompt = rc.buildReviewPrompt("m", gapStats, gapDiff, { ...panelCtx, crossCheck: true }, { variant: "sharded" });
	expect(ccPrompt.includes("pass2.filter((r) => r.ok)"), "26r4: pass 2 results are filtered on ok");
	// Matches the CODE line, not the prose that explains it — asserting on `pass: 2`
	// alone passed off the synthesis bullet even with the failure line deleted.
	expect(
		ccPrompt.includes("pass2.filter((r) => !r.ok)"),
		"26r5: pass-2 failures are collected into the failed report",
	);

	// 26s-t: a failed seat must not be reported as a completed review. `runId` is
	// the resumable id and survives failure, so it is not a success flag; `ok` is.
	for (const variant of ["sharded", "panel"]) {
		const rendered = rc.buildReviewPrompt("m", gapStats, gapDiff, panelCtx, { variant });
		expect(!rendered.includes("r.runId"), `26s-${variant}: launch script does not treat runId as success`);
		expect(rendered.includes("r.ok"), `26t-${variant}: launch script filters survivors on ok`);
	}

	// 26u-v: with crossCheck off the prompt must not promise two passes. The
	// rendered script has one pass, so telling the user otherwise misdescribed
	// both the wait and the spend, and the hand-run fallback instructed a
	// cross-check pass the user never enabled.
	const onePass = rc.buildReviewPrompt("m", gapStats, gapDiff, { ...panelCtx, crossCheck: false }, { variant: "sharded" });
	expect(!/two passes/.test(onePass), "26u: single-pass run never mentions two passes");
	const twoPass = rc.buildReviewPrompt("m", gapStats, gapDiff, { ...panelCtx, crossCheck: true }, { variant: "sharded" });
	expect(/two passes/.test(twoPass), "26v: cross-checked run does describe two passes");
}

// ── cleanup ────────────────────────────────────────────────────────────────
rmSync(join(process.env.HOME, ".pi"), { recursive: true, force: true });
for (const d of repos) rmSync(d, { recursive: true, force: true });
if (checks < EXPECTED_MIN_CHECKS) {
	console.error(`\nINCOMPLETE RUN: only ${checks} checks executed, expected at least ${EXPECTED_MIN_CHECKS}.`);
	process.exit(1);
}
console.log(
	failures === 0
		? `\nall green — ${checks} checks, isolated HOME ${process.env.HOME} and ${repos.length} temp dirs removed`
		: `\n${failures} FAILURES out of ${checks} checks`,
);
process.exit(failures === 0 ? 0 : 1);
