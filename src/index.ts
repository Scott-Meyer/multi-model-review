/**
 * /review — interactive multi-model code review launcher.
 *
 * This is multi-model-review: a port of omp's (github.com/can1357/oh-my-pi)
 * bundled `/review` command onto pi's own extension API — same interactive
 * menu, same diff-stat computation, same noise-file exclusion list. See
 * ../PROVENANCE.md for the file-level breakdown and every deliberate
 * deviation. The improvement over the original: instead of handing the diff
 * to N reviewer copies of one model, this fans the SAME diff out to a panel
 * of reviewer subagents pinned to different models (Claude, GPT, Gemini,
 * GLM, Qwen — plus a pass-1-only antagonist voice) and asks the parent to
 * synthesize a single verdict across all of them, flagging where they
 * disagree.
 *
 * This extension only builds a prompt and hands it to the current agent via
 * pi.sendUserMessage(). All the actual reviewing happens through the normal
 * `subagent` tool (pi-subagents), using the reviewer-claude / reviewer-gpt /
 * reviewer-gemini / reviewer-glm / reviewer-qwen / reviewer-gemini-antagonist
 * agents. Example definitions ship in ../agents/ — install them into
 * ~/.pi/agent/agents/ (scripts/bootstrap-machine.sh does this) and adjust
 * each `model:` line to your own provider registry.
 */
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Reviewer roster — edit here to change who sits on the panel.
//
// CORE_REVIEWERS run both passes: independent pass-1 review, then a pass-2
// resume where each cross-checks all pass-1 write-ups (including its own)
// against the real code. EXTRA_PASS1_REVIEWERS run pass 1 only — their
// write-up still gets folded into what every core reviewer sees in pass 2,
// unlabeled and mixed in with the rest, but they don't get a pass-2 round
// of their own. Good for a cheap, deliberately differently-instructed voice
// (e.g. a lighter-touch antagonistic pass) whose value is a different
// pass-1 angle, not a second-guessing round on itself.
// ─────────────────────────────────────────────────────────────────────────────

const CORE_REVIEWERS = [
	{ key: "claude", agent: "reviewer-claude", label: "Claude Sonnet 5" },
	{ key: "gpt", agent: "reviewer-gpt", label: "GPT-5.6 Sol" },
	{ key: "gemini", agent: "reviewer-gemini", label: "Gemini 3.7 Flash" },
	{ key: "glm", agent: "reviewer-glm", label: "GLM 5.2 (Linus)" },
	{ key: "qwen", agent: "reviewer-qwen", label: "Qwen3 Coder 480B (Dan Luu)" },
] as const;

const EXTRA_PASS1_REVIEWERS = [
	{ key: "gemini-antagonist", agent: "reviewer-gemini-antagonist", label: "Gemini 3.7 Flash, antagonist" },
] as const;

const PASS1_REVIEWERS = [...CORE_REVIEWERS, ...EXTRA_PASS1_REVIEWERS];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface FileDiff {
	path: string;
	linesAdded: number;
	linesRemoved: number;
}

interface DiffStats {
	files: FileDiff[];
	totalAdded: number;
	totalRemoved: number;
	excluded: { path: string; reason: string }[];
	/** Diff text with excluded (noise) file chunks stripped out. */
	filteredDiffText: string;
}

type ReviewChoice = "base-branch" | "uncommitted" | "commit" | "custom";

// ─────────────────────────────────────────────────────────────────────────────
// Noise-file exclusion (ported from omp's review command)
// ─────────────────────────────────────────────────────────────────────────────

const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif|svg)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

function getExclusionReason(path: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(path)) return reason;
	}
	return undefined;
}

/**
 * Extract the file path from one `diff --git ...` chunk.
 *
 * Prefers the `+++ b/<path>` (or `--- a/<path>` for deletions) line over the
 * `diff --git a/<path> b/<path>` header line: the header line is ambiguous
 * for paths containing spaces (the non-greedy `a/(.+?) b/(.+)` match used by
 * the original omp port breaks on `a/my file b/my file`), while `+++`/`---`
 * lines are unambiguous — everything after the marker and mode prefix is the
 * path. Also unwraps git's C-style quoting (used for paths with tabs,
 * quotes, or when core.quotePath is on) for the common escape sequences.
 */
function extractPath(chunk: string): string | undefined {
	const lines = chunk.split(/\r?\n/);
	const plusLine = lines.find((l) => l.startsWith("+++ "));
	const minusLine = lines.find((l) => l.startsWith("--- "));

	const fromMarker = (line: string | undefined, prefix: "a/" | "b/"): string | undefined => {
		if (!line) return undefined;
		let raw = line.slice(4).trim(); // strip "+++ " / "--- "
		if (raw === "/dev/null") return undefined;
		raw = unquoteGitPath(raw);
		return raw.startsWith(prefix) ? raw.slice(2) : raw;
	};

	const markerPath = fromMarker(plusLine, "b/") ?? fromMarker(minusLine, "a/");
	if (markerPath) return markerPath;

	const headerMatch = lines[0]?.match(/^(?:"(?:\\.|[^"\\])*"|a\/.+?) ("(?:\\.|[^"\\])*"|b\/.+)$/);
	if (!headerMatch) return undefined;
	const raw = unquoteGitPath(headerMatch[1]);
	return raw.startsWith("b/") ? raw.slice(2) : raw;
}

/** Reverse git's core.quotePath C-style quoting for the common escapes. */
function unquoteGitPath(raw: string): string {
	if (!(raw.startsWith('"') && raw.endsWith('"'))) return raw;
	const inner = raw.slice(1, -1);
	return inner.replace(/\\([abtnvfr"\\]|[0-7]{3})/g, (_, esc: string) => {
		switch (esc) {
			case "a":
				return "\x07";
			case "b":
				return "\b";
			case "t":
				return "\t";
			case "n":
				return "\n";
			case "v":
				return "\v";
			case "f":
				return "\f";
			case "r":
				return "\r";
			case '"':
				return '"';
			case "\\":
				return "\\";
			default:
				return String.fromCharCode(Number.parseInt(esc, 8));
		}
	});
}

function parseDiff(diffOutput: string): DiffStats {
	const files: FileDiff[] = [];
	const excluded: DiffStats["excluded"] = [];
	const keptChunks: string[] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const chunk of fileChunks) {
		const path = extractPath(chunk);
		if (!path) continue;

		let linesAdded = 0;
		let linesRemoved = 0;
		for (const line of chunk.split(/\r?\n/)) {
			if (line.startsWith("+") && !line.startsWith("+++ ")) linesAdded++;
			else if (line.startsWith("-") && !line.startsWith("--- ")) linesRemoved++;
		}

		const reason = getExclusionReason(path);
		if (reason) {
			excluded.push({ path, reason });
		} else {
			files.push({ path, linesAdded, linesRemoved });
			totalAdded += linesAdded;
			totalRemoved += linesRemoved;
			keptChunks.push(`diff --git ${chunk}`);
		}
	}

	return { files, totalAdded, totalRemoved, excluded, filteredDiffText: keptChunks.join("\n") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Git helpers
// ─────────────────────────────────────────────────────────────────────────────

class GitCommandError extends Error {}

interface ExecFileError {
	status?: number | null;
	stdout?: string;
	stderr?: string;
	message?: string;
}

/** Run a git command; throw GitCommandError on real failure instead of silently returning "". */
function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} catch (err) {
		const e = err as ExecFileError;
		throw new GitCommandError(e.stderr?.trim() || e.message || `git ${args.join(" ")} failed`);
	}
}

/** Like git(), but exit code 1 is success (git diff --no-index exits 1 when the compared files differ). */
function gitDiffAllowingExit1(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} catch (err) {
		const e = err as ExecFileError;
		if (e.status === 1 && typeof e.stdout === "string") return e.stdout;
		throw new GitCommandError(e.stderr?.trim() || e.message || `git ${args.join(" ")} failed`);
	}
}

/**
 * Local branch names only (refs/heads), for the optional autocomplete list
 * offered when picking a base branch. Deliberately local-only (no
 * refs/remotes, no merge-base ranking, no fork-point detection) -- that
 * kind of "clever" auto-detection is exactly what used to make this command
 * slow and occasionally wrong; a plain list of local branch names the user
 * can pick from (or ignore and type their own) is fast and predictable.
 */
function gitLocalBranches(cwd: string): string[] {
	const out = git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function gitCurrentBranch(cwd: string): string {
	return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "HEAD";
}

function gitRecentCommits(cwd: string, count: number): string[] {
	const out = git(cwd, ["log", `-${count}`, "--oneline"]);
	return out.split("\n").filter(Boolean);
}

/**
 * Fork point of `current` off `base`, pinned once as a concrete commit sha.
 *
 * This is deliberately NOT `git diff base...current` (triple-dot): triple-dot
 * re-resolves `base` and recomputes the merge-base fresh every time it runs,
 * which is exactly right for "diff against wherever base is" but wrong for
 * "diff my branch" on a fast-moving trunk (e.g. a monorepo's `preprod`) --
 * ambiguous history, multiple merge-bases, or `base` meaning a local branch
 * in one place and a remote-tracking ref in another all make the implicit
 * recomputation flaky. Pinning the sha once up front and diffing explicitly
 * from it means the reviewed range is always exactly "every commit unique to
 * my branch", full stop, independent of what `base` resolves to elsewhere.
 */
function gitMergeBase(cwd: string, base: string, current: string): string {
	return git(cwd, ["merge-base", base, current]).trim();
}

/** Unstaged + staged + untracked working-tree diff, no commit range involved. */
function getWorkingTreeDiff(cwd: string): string {
	if (!gitHasAnyChanges(cwd)) return "";
	const unstaged = git(cwd, ["diff"]);
	const staged = git(cwd, ["diff", "--cached"]);
	const untrackedPaths = gitUntrackedFiles(cwd);
	const untracked = untrackedPaths.length > 0 ? buildUntrackedDiff(cwd, untrackedPaths) : "";
	return [unstaged, staged, untracked].filter(Boolean).join("\n");
}

/** Untracked, non-ignored file paths from `git status`, NUL-separated so no quoting ambiguity. */
function gitUntrackedFiles(cwd: string): string[] {
	const out = git(cwd, ["status", "--porcelain", "-z", "-uall"]);
	const paths: string[] = [];
	for (const entry of out.split("\0")) {
		if (!entry) continue;
		if (entry.startsWith("??")) paths.push(entry.slice(3));
	}
	return paths;
}

function gitHasAnyChanges(cwd: string): boolean {
	return git(cwd, ["status", "--porcelain", "-z"]).length > 0;
}

/** Synthetic unified diffs for untracked files, via `git diff --no-index -- /dev/null <path>`. */
function buildUntrackedDiff(cwd: string, paths: string[]): string {
	const chunks: string[] = [];
	for (const p of paths) {
		try {
			const out = gitDiffAllowingExit1(cwd, ["diff", "--no-index", "--", "/dev/null", p]);
			if (out.trim()) chunks.push(out);
		} catch {
			// Skip files git can't diff this way (e.g. binary) rather than failing the whole review.
		}
	}
	return chunks.join("\n");
}

interface UncommittedDiff {
	diffText: string;
	mode: string;
	diffInstruction: string;
}

function getUncommittedDiff(cwd: string): UncommittedDiff {
	const diffInstruction = "runs `git diff -- <path>`, `git diff --cached -- <path>`, and (untracked) `git diff --no-index -- /dev/null <path>`";
	const mode = "Reviewing uncommitted changes (staged + unstaged + untracked)";
	return { diffText: getWorkingTreeDiff(cwd), mode, diffInstruction };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

const MAX_DIFF_CHARS = 50_000;
const MAX_FILES_FOR_INLINE_DIFF = 20;

function formatStats(stats: DiffStats): string {
	const lines: string[] = [];
	lines.push(`Files changed: ${stats.files.length} (+${stats.totalAdded} / -${stats.totalRemoved})`);
	for (const f of stats.files) {
		lines.push(`  - ${f.path} (+${f.linesAdded} / -${f.linesRemoved})`);
	}
	if (stats.excluded.length > 0) {
		lines.push(
			`Excluded as noise (${stats.excluded.length}, not sent to reviewers): ${stats.excluded.map((e) => `${e.path} [${e.reason}]`).join(", ")}`,
		);
	}
	return lines.join("\n");
}

/** Longest run of consecutive backticks in `text`, so the wrapping fence can always be longer. */
function longestBacktickRun(text: string): number {
	let max = 0;
	for (const run of text.match(/`+/g) ?? []) max = Math.max(max, run.length);
	return max;
}

function fence(text: string): string {
	return "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
}

/**
 * The two-pass fan-out recipe, shared by diff-based and custom reviews.
 *
 * Pass 1: all three reviewers look at the diff/code independently, fresh
 * context, no sharding. Pass 2: each reviewer's own pass-1 child is resumed
 * (cheaper than a fresh child -- the diff/files are still in its context)
 * and handed all three raw pass-1 write-ups, explicitly told to distrust
 * all of them -- including its own -- and re-verify against the real code
 * before agreeing. The final report is built from the three pass-2 outputs,
 * not pass 1; pass 1 is just the raw material pass 2 cross-examines.
 */
function reviewerListText(items: readonly { agent: string; label: string }[]): string {
	return items.map((r) => `\`${r.agent}\` (${r.label})`).join(", ");
}

/**
 * A literal, copy-paste-ready workflowScript skeleton for the two-pass fan-out,
 * generated from the actual reviewer roster above.
 *
 * Why this exists instead of just describing the API in prose: every observed
 * failure of this workflow (twice, independently, across different repos) was
 * the exact same JavaScript bug — treating the array `runs.all` resolves to
 * as if it were an object keyed by run key (`pass1["pass1-claude"].output`
 * instead of `pass1.find(r => r.key === "pass1-claude").output`). A prose
 * warning about this got skimmed past both times. A literal template that
 * already does it correctly, with a helper function baked in, removes the
 * chance to misremember the shape — the model copies working code instead of
 * reconstructing the API from a paragraph.
 */
function jsVarName(key: string): string {
	// Reviewer keys can contain hyphens (e.g. "gemini-antagonist"), which are
	// not valid in a bare JS identifier. Camel-case them for use as variable
	// names in the generated template; the actual runs.all `key:` string
	// values are left untouched.
	return key.replace(/-([a-z0-9])/gi, (_, c) => c.toUpperCase());
}

function twoPassCodeTemplate(): string {
	const pass1Items = PASS1_REVIEWERS.map((r) => `  { key: "pass1-${r.key}", agent: "${r.agent}", task: pass1Task },`).join("\n");
	const pass2Items = CORE_REVIEWERS.map((r) => `  { key: "pass2-${r.key}", resume: ${jsVarName(r.key)}1.runId, task: pass2Task },`).join("\n");
	const pass1Lookups = PASS1_REVIEWERS.map((r) => `const ${jsVarName(r.key)}1 = findRun(pass1, "pass1-${r.key}");`).join("\n");
	const pass2Lookups = CORE_REVIEWERS.map((r) => `const ${jsVarName(r.key)}2 = findRun(pass2, "pass2-${r.key}");`).join("\n");
	const writeupList = PASS1_REVIEWERS.map((r) => `${jsVarName(r.key)}1`).join(", ");
	const returnFields = CORE_REVIEWERS.map((r) => `  ${jsVarName(r.key)}2: ${jsVarName(r.key)}2.output,`).join("\n");

	return [
		"```javascript",
		"// runs.all / runs.run resolve to RESULT OBJECTS with their own .key, .output, .runId.",
		"// runs.all resolves to a plain ARRAY in input order, NOT an object keyed by run key.",
		'// pass1["pass1-claude"] is undefined on an array -- ALWAYS look up by .key like this:',
		"function findRun(results, key) {",
		"  const r = results.find((x) => x.key === key);",
		'  if (!r) throw new Error(`missing result for key \'${key}\'`);',
		"  return r;",
		"}",
		"",
		"const pass1Task = `...full pass-1 task text as instructed above...`;",
		"",
		"const pass1 = await runs.all([",
		pass1Items,
		"]);",
		"",
		pass1Lookups,
		"",
		`const rawWriteups = [${writeupList}]`,
		'  .map((r, i) => `--- Peer write-up ${i + 1} ---\n${r.output}`)',
		'  .join("\\n\\n");',
		"",
		"const pass2Task = `...full pass-2 follow-up task text as instructed below, with rawWriteups pasted in...`;",
		"",
		"const pass2 = await runs.all([",
		pass2Items,
		"]);",
		"",
		pass2Lookups,
		"",
		"return {",
		returnFields,
		"};",
		"```",
		"",
		"The launch: one top-level `subagent` tool call -- this script as `workflowScript`, a short",
		"`name`, and `async: true`. That's the whole call.",
		"",
		"Why `async`: the panel runs several reviewers through two passes of cross-checking -- minutes of",
		"work. Blocking means the user watches a dead conversation until it's done. Async means you hand",
		"back a receipt and get woken with the pass-2 results; no polling, no subagent_wait for this.",
		"",
		"Why only three keys: the subagent schema is long because it serves every kind of run, and the",
		"extra fields all mean things that fight this one. `gate` and `acceptance` are evidence contracts",
		"for write runs -- this review only reads. `model` pins every child to one model, which quietly",
		"cancels the point of a multi-model panel. `isolation: worktree` gives each reviewer its own",
		"checkout, so they'd review different files than the user is about to merge. A validator checks",
		"all this -- anything beyond the three keys bounces the launch.",
		"",
		"And if it bounces: a rejected call stays in the history, and the next attempt tends to pick the",
		"same bad shape back out of it instead of starting clean. One bounce means the shape is wrong.",
		"Tell the user what the validator said and stop -- a fresh conversation launches clean; retrying in",
		"place just relives the rejection.",
	].join("\n");
}

function twoPassInstructions(diffInstruction: string): string[] {
	const pass1List = reviewerListText(PASS1_REVIEWERS);

	return [
		"## What to do — two-pass review",
		"",
		`**Pass 1 (independent), ${PASS1_REVIEWERS.length} reviewers:** ${pass1List}. Fan out via \`runs.all\` in one \`workflowScript\`, fresh context, identical task text for all. Full diff/code is above; if omitted, each pulls it itself: ${diffInstruction}.`,
		"",
		`**Pass 2 (cross-check), ${CORE_REVIEWERS.length} reviewers:** resume each core reviewer's own pass-1 run (\`runs.run(newKey, { resume, task })\`, fresh key — reusing a pass-1 key fails) with all pass-1 write-ups pasted in unlabeled and anonymized, including its own. Re-verify against the real code and end with a reconsidered Verdict.`,
		"",
		"Before you launch, tell the user the panel is starting in the background and you'll report back when it's done -- several models cross-checking takes a few minutes, and nobody should stare at a silent screen wondering whether anything is running.",
		"",
		"**Skeleton** (fill in the task strings, keep the lookup shape as-is):",
		"",
		twoPassCodeTemplate(),
		"",
		"**Synthesis:** build the report from pass-2 outputs, sorted by severity then confidence. Flag anything walked back between passes or still disagreed on after cross-checking. One overall verdict.",
		"",
		"Do not edit any files. Review only.",
	];
}

function buildReviewPrompt(mode: string, stats: DiffStats, options: { additionalInstructions?: string; diffInstruction: string }): string {
	const skipDiff = stats.filteredDiffText.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;

	const parts: string[] = [];
	parts.push(`# Multi-model code review — ${mode}`);
	parts.push("");
	parts.push(formatStats(stats));
	parts.push("");

	if (options.additionalInstructions) {
		parts.push(`Additional focus requested: ${options.additionalInstructions}`);
		parts.push("");
	}

	if (!skipDiff && stats.filteredDiffText.trim()) {
		const f = fence(stats.filteredDiffText);
		parts.push(`${f}diff`);
		parts.push(stats.filteredDiffText.trim());
		parts.push(f);
		parts.push("");
	} else {
		parts.push(`(Diff omitted here — too large to inline, or noise-filtered down to nothing. Each reviewer subagent ${options.diffInstruction}.)`);
		parts.push("");
	}

	parts.push(...twoPassInstructions(options.diffInstruction));

	return parts.join("\n");
}

function buildCustomPrompt(instructions: string): string {
	return [
		"# Multi-model code review — custom instructions",
		"",
		instructions,
		"",
		...twoPassInstructions(
			"pulls the relevant diff/state itself (`git diff`, `git diff --cached`, or as directed above) and reviews it per the instructions above",
		),
	].join("\n");
}

function notifyGitError(ctx: ExtensionCommandContext, err: unknown): void {
	const message = err instanceof GitCommandError ? err.message : err instanceof Error ? err.message : String(err);
	ctx.ui.notify(`Git command failed: ${message}`, "error");
}

// ─────────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────────

export default function reviewExtension(pi: ExtensionAPI) {
	pi.registerCommand("review", {
		description: "Launch a multi-model interactive code review (Claude + GPT + Gemini + GLM + Qwen panel)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const extraInstructions = args.trim() || undefined;

			if (!ctx.hasUI) {
				pi.sendUserMessage(buildCustomPrompt(extraInstructions ?? "Review uncommitted changes for bugs."));
				return;
			}

			const choices: { label: string; value: ReviewChoice }[] = [
				{ label: "1. Review against a base branch (PR style)", value: "base-branch" },
				{ label: "2. Review uncommitted changes", value: "uncommitted" },
				{ label: "3. Review a specific commit", value: "commit" },
				{ label: "4. Custom review instructions", value: "custom" },
			];

			const selected = await ctx.ui.select(
				"Review Mode",
				choices.map((c) => c.label),
			);
			if (!selected) return;
			const choice = choices.find((c) => c.label === selected)?.value;
			if (!choice) return;

			try {
				switch (choice) {
					case "base-branch": {
						const current = gitCurrentBranch(ctx.cwd);

						// No auto-detection here on purpose: ranking every other branch by
						// merge-base recency used to be "clever" but was slow on big repos
						// and occasionally guessed the wrong fork point. Just ask for the
						// parent branch name directly; leave it blank to instead pick from
						// a plain, unranked list of local branches.
						let base = (await ctx.ui.input(`Parent branch for \`${current}\`:`, "leave blank to choose a local branch"))?.trim();
						if (base === undefined) return; // cancelled
						if (!base) {
							const localBranches = gitLocalBranches(ctx.cwd).filter((b) => b !== current);
							if (localBranches.length === 0) {
								ctx.ui.notify("No other local branches found", "error");
								return;
							}
							const picked = await ctx.ui.select("Base branch", localBranches);
							if (!picked) return;
							base = picked;
						}

						let mergeBase: string;
						try {
							mergeBase = gitMergeBase(ctx.cwd, base, current);
						} catch (err) {
							notifyGitError(ctx, err);
							return;
						}

						// Pin the fork point once, up front, as a concrete sha. See gitMergeBase()
						// for why this beats `git diff base...current` on a fast-moving trunk: this
						// guarantees the reviewed range is exactly "every commit unique to my
						// branch", plus whatever's uncommitted on top of it right now -- not
						// whatever `base` happens to resolve to by the time the diff runs.
						const committedDiff = git(ctx.cwd, ["diff", `${mergeBase}..${current}`]);
						const workingTreeDiff = getWorkingTreeDiff(ctx.cwd);
						const diffText = [committedDiff, workingTreeDiff].filter(Boolean).join("\n");

						if (!diffText.trim()) {
							ctx.ui.notify(`No changes on \`${current}\` since it forked from \`${base}\` (${mergeBase.slice(0, 12)})`, "warning");
							return;
						}
						const stats = parseDiff(diffText);
						if (stats.files.length === 0) {
							ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
							return;
						}
						pi.sendUserMessage(
							buildReviewPrompt(
								`branch \`${current}\`, everything since it forked from \`${base}\` at \`${mergeBase.slice(0, 12)}\` (committed + uncommitted)`,
								stats,
								{
									additionalInstructions: extraInstructions,
									diffInstruction: `runs \`git diff ${mergeBase}..${current} -- <path>\` (not \`${base}...${current}\`, which re-resolves) for committed changes, plus \`git diff -- <path>\` / \`git diff --cached -- <path>\` for uncommitted`,
								},
							),
						);
						return;
					}

					case "uncommitted": {
						const result = getUncommittedDiff(ctx.cwd);
						if (!result.diffText.trim()) {
							ctx.ui.notify("No uncommitted changes found", "warning");
							return;
						}
						const stats = parseDiff(result.diffText);
						if (stats.files.length === 0) {
							ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
							return;
						}
						pi.sendUserMessage(
							buildReviewPrompt(result.mode, stats, {
								additionalInstructions: extraInstructions,
								diffInstruction: result.diffInstruction,
							}),
						);
						return;
					}

					case "commit": {
						const commits = gitRecentCommits(ctx.cwd, 20);
						if (commits.length === 0) {
							ctx.ui.notify("No commits found", "error");
							return;
						}
						const selectedCommit = await ctx.ui.select("Select commit to review", commits);
						if (!selectedCommit) return;
						const hash = selectedCommit.split(" ")[0];
						const diffText = git(ctx.cwd, ["show", hash, "--format="]);
						if (!diffText.trim()) {
							ctx.ui.notify("Commit has no diff content", "warning");
							return;
						}
						const stats = parseDiff(diffText);
						if (stats.files.length === 0) {
							ctx.ui.notify("No reviewable files in commit (all changes filtered out)", "warning");
							return;
						}
						pi.sendUserMessage(
							buildReviewPrompt(`commit \`${hash}\``, stats, {
								additionalInstructions: extraInstructions,
								diffInstruction: `runs \`git show ${hash} -- <path>\``,
							}),
						);
						return;
					}

					case "custom": {
						const instructions = await ctx.ui.editor("Enter custom review instructions", "Review the following:\n\n");
						if (!instructions?.trim()) return;
						pi.sendUserMessage(buildCustomPrompt(instructions));
						return;
					}
				}
			} catch (err) {
				if (err instanceof GitCommandError) {
					notifyGitError(ctx, err);
					return;
				}
				throw err;
			}
		},
	});
}
