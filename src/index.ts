/**
 * /review — interactive multi-model code review launcher.
 *
 * This is multi-model-review: a port of omp's (github.com/can1357/oh-my-pi)
 * bundled `/review` command onto pi's own extension API — same interactive
 * menu, same diff-stat computation, same noise-file exclusion list. See
 * ../PROVENANCE.md for the file-level breakdown and every deliberate
 * deviation. The improvement over the original: instead of handing the diff
 * to N reviewer copies of one model, this fans the SAME diff out to a panel
 * of reviewer subagents on different models and asks the parent to
 * synthesize a single verdict across all of them, flagging where they
 * disagree.
 *
 * Nothing in this package names a model. The panel picks its models fresh
 * at review time from whatever the current session's model registry can
 * actually reach (the command handler reads ctx.modelRegistry /
 * ctx.scopedModels and injects the candidate list into the prompt) —
 * diversity across model FAMILIES is the product, and hardcoded model names
 * go stale and travel badly between machines. Reviewer personas ship
 * unpinned in ../agents/ and take their model per launch from the panel
 * choice.
 *
 * The panel itself is rules: ~/.pi/agent/multi-model-review/config.json
 * (seats — personas, count, optional model pins, pass1Only flags — plus
 * exclude globs for the discovery pool). No file → the smart default
 * seeded below. /review config opens the rules in an editor. A SAVED
 * config is the rules: anything wrong with it blocks the review with an
 * actionable error, never a silently different panel — a saved pin or
 * exclude can encode cost or policy intent.
 *
 * The fan-out recipe is a composite workflowScript whose panel lives in
 * one data array (delete a seat line to shrink the panel — pass 2 derives
 * itself from what actually ran), with a single-child fallback spelled
 * out for models whose tool-call emission can't get a large composed
 * script out cleanly (observed in the wild; the recipe's ancestors failed
 * there).
 *
 * This extension only builds a prompt and hands it to the current agent via
 * pi.sendUserMessage(). All the actual reviewing happens through the normal
 * `subagent` tool (pi-subagents), using the reviewer-persona agents defined
 * alongside this extension. Example definitions ship in ../agents/ —
 * install them into ~/.pi/agent/agents/ (scripts/bootstrap-machine.sh does
 * this).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────────
// Panel seats & the smart default — edit here to change the default panel.
//
// Seats define review VOICES, not models. Each unpinned seat gets a model
// from panel discovery at review time, one model FAMILY per seat. Three
// identically-instructed primary seats isolate pure model diversity; the
// persona seats add differently-shaped criticism on top of it; the
// antagonist is deliberately pass-1-only raw material.
//
// Core seats (pass1Only unset/false) run both passes: independent pass-1
// review, then a pass-2 resume where each cross-checks all pass-1 write-ups
// (including its own) against the real code. Pass-1-only seats don't get a
// cross-check round — their write-up is folded into what every core seat
// sees in pass 2, unlabeled and mixed in with the rest.
// ─────────────────────────────────────────────────────────────────────────────

/** One panel seat: a reviewer persona, optionally pinned to a model. */
interface PanelSeat {
	/** Short key — unique per config; also the fan-out run-key prefix. */
	key: string;
	/** pi agent name (persona .md file, e.g. ~/.pi/agent/agents/reviewer-primary.md). */
	agent: string;
	/** Pass-1-only seat: its write-up is raw material for pass 2, but it gets no cross-check round. */
	pass1Only?: boolean;
	/** Optional model pin (full provider/id). Pinned seats skip panel discovery. */
	model?: string;
	/** Human note used only in the prompt's seat list. */
	what?: string;
}

/**
 * The smart default. Seeded with personas and a count that fits a machine
 * with ~5 reachable model families; the session shrinks the panel or the
 * user edits the rules via /review config as needed.
 */
const DEFAULT_SEATS: PanelSeat[] = [
	{ key: "primary-a", agent: "reviewer-primary", what: "standard bug-hunting pass, seat A" },
	{ key: "primary-b", agent: "reviewer-primary", what: "standard bug-hunting pass, seat B" },
	{ key: "primary-c", agent: "reviewer-primary", what: "standard bug-hunting pass, seat C" },
	{ key: "linus", agent: "reviewer-linus", what: "blunt, taste-obsessed pass" },
	{ key: "danluu", agent: "reviewer-danluu", what: "measured, evidence-obsessed pass" },
	{ key: "antagonist", agent: "reviewer-antagonist", what: "free-form antagonistic pass", pass1Only: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// Panel config — user rules, seeded with the smart default above.
//
// ~/.pi/agent/multi-model-review/config.json is the rules file. No file →
// smart default (exactly that config serialized). Once a file exists it IS
// the rules: malformed JSON, missing/invalid seats, or unreachable pinned
// models BLOCK the review with an actionable error rather than silently
// launching a different panel — a saved exclude or pin can encode cost or
// policy intent, and spending it differently is not this command's call.
// /review config opens the effective config in an editor and saves the
// user's rules back atomically.
//
// Persona agent names are NOT filesystem-validated here — pi-subagents
// resolves agents from user/project/package sources with its own
// precedence, and a directory scan would reject valid configured personas.
// The prompt carries an authoritative preflight (subagent {action:"list"})
// so a missing persona surfaces as an actionable error at review time.
// ─────────────────────────────────────────────────────────────────────────────

interface PanelConfig {
	seats: PanelSeat[];
	exclude: string[];
}

const SMART_DEFAULT: PanelConfig = { seats: DEFAULT_SEATS, exclude: [] };

function panelConfigPath(): string {
	return join(homedir(), ".pi", "agent", "multi-model-review", "config.json");
}

/**
 * Parse panel rules text (shared by config load and /review config save).
 * Strict: any structural problem is an error naming the offending seat —
 * never silently repaired.
 */
function parsePanelConfig(raw: string): { config?: PanelConfig; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { error: `not valid JSON: ${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { error: `must be a JSON object with "seats" and optional "exclude"` };
	}
	const obj = parsed as { seats?: unknown; exclude?: unknown };
	if (!Array.isArray(obj.seats) || obj.seats.length === 0) {
		return { error: `no seats array — a config with no seats would launch an empty panel` };
	}
	const seats: PanelSeat[] = [];
	const seen = new Set<string>();
	for (const [i, s] of obj.seats.entries()) {
		if (typeof s !== "object" || s === null) return { error: `seat #${i + 1} is not an object` };
		const { key, agent, pass1Only, model, what } = s as Record<string, unknown>;
		if (typeof key !== "string" || !key.trim()) return { error: `seat #${i + 1} is missing a non-empty "key"` };
		// Keys become workflow run keys ("pass1-" + key), so they must satisfy
		// pi-subagents' run-key contract exactly — anything else saves fine and
		// then breaks every launch at runtime.
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key.trim())) {
			return {
				error: `seat key "${key}" must match pi-subagents' run-key rule: 1-128 chars, letters/digits/dots/hyphens/underscores, starting with a letter or digit`,
			};
		}
		if (typeof agent !== "string" || !agent.trim()) {
			return { error: `seat "${key}" is missing a non-empty "agent" (a pi agent name, e.g. reviewer-primary)` };
		}
		if (seen.has(key.trim())) return { error: `duplicate seat key "${key}" — seat keys must be unique` };
		seen.add(key.trim());
		if (model !== undefined && (typeof model !== "string" || !model.trim())) {
			return { error: `seat "${key}" has a "model" that is not a non-empty string` };
		}
		if (pass1Only !== undefined && typeof pass1Only !== "boolean") {
			return { error: `seat "${key}" has a "pass1Only" that is not a boolean` };
		}
		if (what !== undefined && (typeof what !== "string" || !what.trim())) {
			return { error: `seat "${key}" has a "what" that is not a non-empty string` };
		}
		seats.push({
			key: key.trim(),
			agent: agent.trim(),
			...(pass1Only === true ? { pass1Only: true } : {}),
			...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
			...(typeof what === "string" && what.trim() ? { what: what.trim() } : {}),
		});
	}
	if (!seats.some((s) => !s.pass1Only)) {
		return {
			error: `no core seats — at least one seat must leave "pass1Only" unset/false, or pass 2 has nothing to cross-check and the review can't produce a verdict`,
		};
	}
	const exclude: string[] = [];
	if (obj.exclude !== undefined) {
		if (!Array.isArray(obj.exclude)) return { error: `"exclude" must be an array of glob strings` };
		for (const e of obj.exclude) {
			if (typeof e !== "string" || !e.trim()) return { error: `"exclude" contains a non-string or empty entry` };
			exclude.push(e.trim());
		}
	}
	return { config: { seats, exclude } };
}

/**
 * Load the panel rules. Only "file doesn't exist" yields the smart default;
 * anything else wrong with a SAVED config is a blocking error.
 */
function loadPanelConfig(): { status: "default" | "ok" | "error"; config?: PanelConfig; error?: string } {
	let raw: string;
	try {
		raw = readFileSync(panelConfigPath(), "utf8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return { status: "default", config: SMART_DEFAULT };
		return { status: "error", error: `cannot read ${panelConfigPath()}: ${(err as Error).message}` };
	}
	const parsed = parsePanelConfig(raw);
	if (parsed.error) {
		return {
			status: "error",
			error: `${panelConfigPath()}: ${parsed.error}. Fix it with /review config, or delete the file to return to the smart default.`,
		};
	}
	return { status: "ok", config: parsed.config };
}

/** Atomic save for /review config: temp file in the same dir, then rename. */
function savePanelConfig(config: PanelConfig): void {
	const dir = join(homedir(), ".pi", "agent", "multi-model-review");
	mkdirSync(dir, { recursive: true });
	const target = panelConfigPath();
	const tmp = `${target}.tmp-${Date.now()}`;
	writeFileSync(tmp, JSON.stringify(config, null, "\t") + "\n", "utf8");
	renameSync(tmp, target);
}

/**
 * Runtime validation of loaded rules against this session: pinned models
 * must be reachable (scoped-or-available, auth included). Blocking — a
 * saved pin encodes intent; silently substituting a model spends it.
 */
function validatePanelPins(config: PanelConfig, ctx: ExtensionCommandContext): string[] {
	const errors: string[] = [];
	const scoped = ctx.scopedModels?.map((s) => s.model) ?? [];
	const reachable = (scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable()).filter((m) =>
		ctx.modelRegistry.hasConfiguredAuth(m),
	);
	const reachableRefs = new Set(reachable.map((m) => `${m.provider}/${m.id}`));
	for (const seat of config.seats) {
		if (seat.model && !reachableRefs.has(seat.model)) {
			errors.push(
				`seat "${seat.key}" pins model \`${seat.model}\`, which this session cannot reach (not in the available + authed model set${
					scoped.length > 0 ? " — the session is model-scoped" : ""
				}). Re-pin it with /review config, or remove the pin and let panel discovery choose.`,
			);
		}
	}
	return errors;
}

/**
 * Glob match for the exclude rules: "*" matches any run of characters,
 * everything else is literal. Matched against `<provider>/<model-id>`
 * (and the bare provider name, so "ai-gw-baseten" alone works).
 */
function isExcluded(provider: string, id: string, exclude: string[]): boolean {
	const full = `${provider}/${id}`;
	return exclude.some((pattern) => {
		const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
		return re.test(full) || re.test(provider);
	});
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
function seatListText(seats: readonly PanelSeat[]): string {
	return seats.map((s) => `\`${s.agent}\` (${s.what ?? "reviewer persona"})`).join(", ");
}

/**
 * The candidate models this session can actually reach, formatted for the
 * prompt. Fresh at /review time from the session's own registry (or scoped
 * list when the session is model-scoped), auth-filtered — so the panel never
 * picks a model this machine can't call. The user's exclude rules shrink
 * this pool before the panel ever sees it. Grouped by provider route for
 * readability, but the prompt's diversity rule is about model FAMILIES, not
 * routes: two provider routes to the same underlying model (e.g. the same
 * family at two context sizes) count as one family for seat purposes.
 */
function modelCandidatesText(ctx: ExtensionCommandContext, exclude: string[]): string {
	try {
		// A session with `--models` / enabledModels scoping only gets that
		// subset; unscoped sessions get the whole available catalogue.
		const scoped = ctx.scopedModels?.map((s) => s.model) ?? [];
		const models = (scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable())
			.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m))
			.filter((m) => !isExcluded(m.provider, m.id, exclude));
		if (models.length === 0) return "";
		const byProvider = new Map<string, string[]>();
		for (const m of models) {
			const list = byProvider.get(m.provider) ?? [];
			list.push(`\`${m.provider}/${m.id}\` (${m.name})`);
			byProvider.set(m.provider, list);
		}
		const lines: string[] = [];
		for (const [provider, refs] of byProvider) {
			lines.push(`- ${provider}: ${refs.join(", ")}`);
		}
		return lines.join("\n");
	} catch {
		// A registry this extension API can't read shouldn't kill the review;
		// the prompt carries a fallback instruction for this case.
		return "";
	}
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
/**
 * A literal, copy-paste-ready workflowScript skeleton for the two-pass
 * fan-out, generated from the panel rules. The panel lives in ONE data
 * array: delete a seat's line to shrink the panel (fewer distinct model
 * families than seats) and pass 2 derives itself from what actually ran.
 *
 * Why a literal template instead of describing the API in prose: every
 * observed failure of this workflow (twice, independently, across different
 * repos) was the exact same JavaScript bug — treating the array `runs.all`
 * resolves to as if it were an object keyed by run key. A prose warning got
 * skimmed past both times. A literal template with the lookup done right
 * removes the chance to misremember the shape — the model copies working
 * code instead of reconstructing the API from a paragraph. The data-driven
 * form also means the template can't contradict the shrink rule: there are
 * no hardcoded per-seat lookups to go stale when seats are deleted.
 */
function twoPassCodeTemplate(seats: readonly PanelSeat[]): string {
	const planLines = seats
		.map((s) => {
			// All config-controlled strings go through JSON.stringify: keys,
			// agent names, and pins can contain anything the user typed, and a
			// raw interpolation could break (or inject into) the workflowScript.
			const model = s.model ? JSON.stringify(s.model) : '"<model from the list above>"';
			return `  { key: ${JSON.stringify(s.key)}, agent: ${JSON.stringify(s.agent)}, model: ${model}, pass1Only: ${s.pass1Only ? "true" : "false"} },`;
		})
		.join("\n");

	return [
		"```javascript",
		"// The panel lives in ONE array. To shrink the panel (fewer distinct model",
		"// families than seats), DELETE a seat's line — pass 2 derives itself from",
		"// what actually ran. runs.all resolves to a plain ARRAY in input order,",
		"// each item an object with .key, .output, .runId — never keyed by run key.",
		"function findRun(results, key) {",
		"  const r = results.find((x) => x.key === key);",
		'  if (!r) throw new Error(`missing result for key \`${key}\``);',
		"  return r;",
		"}",
		"",
		"const pass1Task = `...full pass-1 task text as instructed above...`;",
		"",
		"const seatPlans = [",
		planLines,
		"];",
		"",
		"const pass1 = await runs.all(",
		'  seatPlans.map((p) => ({ key: "pass1-" + p.key, agent: p.agent, model: p.model, task: pass1Task })),',
		");",
		"",
		"// A failed pass-1 seat (transient model error, rate limit, bad route) carries",
		"// no resumable runId. Pass 2 cross-checks the SURVIVORS and reports failures.",
		"const done1 = pass1.filter((r) => r.runId);",
		"",
		"const rawWriteups = done1",
		'  .map((r, i) => `--- Peer write-up ${i + 1} ---\n${r.output}`)',
		'  .join("\\n\\n");',
		"",
		"const pass2Task = `...full pass-2 cross-check task text as instructed below, with rawWriteups pasted in...`;",
		"",
		"const core = seatPlans",
		"  .filter((p) => !p.pass1Only)",
		'  .map((p) => ({ p, r: findRun(done1, "pass1-" + p.key) }))',
		"  .filter((x) => x.r);",
		'if (core.length === 0) throw new Error("every core seat failed pass 1 — report the pass-1 failures and stop");',
		"",
		"const pass2 = await runs.all(",
		'  core.map((x) => ({ key: "pass2-" + x.p.key, resume: x.r.runId, task: pass2Task })),',
		");",
		"",
		"return {",
		"  pass2: pass2.map((r) => ({ seat: r.key, output: r.output })),",
		'  pass1Failed: pass1.filter((r) => !r.runId).map((r) => ({ seat: r.key, error: r.error ?? null })),',
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
		"extra fields all mean things that fight this one -- and most of them won't bounce, they'll be",
		"forwarded as defaults to every reviewer and silently change the run. `model` pins every child to",
		"one model, which quietly cancels the point of a multi-model panel. `isolation: worktree` gives",
		"each reviewer its own checkout, so they'd review different files than the user is about to merge.",
		"`gate` and `acceptance` are evidence contracts for write runs -- this review only reads, and those",
		"two DO bounce the launch when they're malformed. If a bounce happens, a rejected call stays in",
		"the history, and the next attempt tends to pick the same bad shape back out of it instead of",
		"starting clean. One bounce means the shape is wrong. Tell the user what the validator said and",
		"stop -- a fresh conversation launches clean; retrying in place just relives the rejection.",
	].join("\n");
}

function twoPassInstructions(diffInstruction: string, modelsText: string, seats: readonly PanelSeat[]): string[] {
	const pinnedSeats = seats.filter((s) => s.model);
	const unpinnedCount = seats.length - pinnedSeats.length;
	const pass1OnlySeats = seats.filter((s) => s.pass1Only);

	return [
		"## What to do — two-pass review",
		"",
		"### Before anything else",
		"",
		`Check the panel's personas exist: run \`subagent\` with \`{ action: "list" }\` and confirm every seat's agent below is listed. If a persona is missing, tell the user which one and where the package ships example definitions (its agents/ directory) instead of launching a wrong panel. Then tell the user the panel is starting in the background and you'll report back when it's done — several models cross-checking takes a few minutes, and nobody should stare at a silent screen wondering whether anything is running.`,
		"",
		"### Picking the panel's models",
		"",
		"Diversity is the product: the point of the panel is models from genuinely different lineages arguing about the same diff. Model names go stale and travel badly between machines, so the panel picks fresh, in this session. These are the models this session can actually reach (auth included) — each entry is exactly what a child's `model` argument wants:",
		"",
		modelsText ||
			"(The registry lookup came back empty for this session — every seat must be model-pinned in the panel rules, or the review cannot run.)",
		"",
		`The rule is one model FAMILY per seat — Claude vs GPT vs Gemini vs GLM vs Qwen, the totally different models — not one provider route per seat. Two routes to the same underlying model (say, the same family offered through two gateways, or at two context sizes) are one family: pick one of them and move on. Breadth beats "best" — an older model from a family nobody else on the panel is using is worth more than a second pick from the same family. If fewer distinct families exist than the ${unpinnedCount} unpinned seats, shrink the panel by DELETING that seat's line from the panel array in the skeleton — several seats on one family is a single-model review with extra steps.`,
		...(pinnedSeats.length > 0
			? [
				"",
				`Pinned seats (${seatListText(pinnedSeats)}) keep their pinned model — family diversity applies to the unpinned seats only.`,
			]
			: []),
		"",
		"### Pass 1 — independent",
		"",
		`Fan out every seat via \`runs.all\` in one \`workflowScript\`, fresh context, identical task text for all, each item carrying the model picked for that seat. Seats: ${seatListText(seats)}. Compose the shared pass-1 task from the diff information above (scope, files, focus); if the diff was omitted there, the task tells each reviewer to pull it itself: ${diffInstruction}.`,
		"",
		"### Pass 2 — cross-check",
		"",
		`Resume each core seat's own pass-1 run inside the same workflow (the skeleton does this — fresh pass-2 keys, \`resume: <that seat's pass-1 runId>\`), with all pass-1 write-ups pasted in unlabeled and anonymized, including its own. A revived child keeps its stored model, so the panel stays diverse without re-pinning anything. Re-verify against the real code and end with a reconsidered Verdict.${pass1OnlySeats.length > 0 ? ` Pass-1-only seats (${seatListText(pass1OnlySeats)}) don't get a cross-check round — their write-up is raw material for the core seats, not a voice in pass 2.` : ""}`,
		"",
		"**Skeleton** (fill every unpinned seat's model from the list above, fill in the task strings, keep the lookup shape as-is):",
		"",
		twoPassCodeTemplate(seats),
		"",
		"The launch: one top-level `subagent` tool call — the script as `workflowScript`, a short `name`, and `async: true`. That's the whole call. Why `async`: the panel runs several reviewers through two passes of cross-checking — minutes of work. Blocking means the user watches a dead conversation until it's done; async means you hand back a receipt and get woken with the pass-2 results. Why only three keys: the subagent schema is long because it serves every kind of run, and the extra fields all mean things that fight this one — most are forwarded as child defaults and silently change the run (\`model\` at the top would pin every child to one model, quietly cancelling the point of the panel), while a malformed \`gate\`/\`acceptance\` bounces the launch outright. If a bounce happens, a rejected call stays in the history, and the next attempt tends to pick the same bad shape back out of it — one bounce means the shape is wrong; say so and stop rather than retrying in place.",
		"",
		"**Synthesis:** build the report from pass-2 outputs, sorted by severity then confidence. If some pass-1 seats failed, the skeleton returns them under `pass1Failed` — say plainly which voices are missing from the cross-check rather than pretending the panel was whole. Flag anything walked back between passes or still in genuine disagreement after cross-checking. One overall verdict.",
		"",
		"### If the launch won't go out",
		"",
		"The composite is the right shape for this panel — one launch, all pass-1 seats in parallel, pass-2 resumes awaited together. But some models can't get a big composed script out of their tool-call channel cleanly (stuffing it with stray schema fields, or dropping the script entirely). If the validator rejects the composite, don't retry it in place (rejected shapes poison retries) — same panel, smaller calls: launch each seat as its own single-child `subagent` call, `{ agent, model, task }`; keep each receipt's run id; when all pass-1 seats have finished, resume each core seat with `{ action: \"resume\", id: <that seat's run id>, message: <pass-2 task with all write-ups pasted in> }` and synthesize from the resumed outputs. The panel is the same — you're just carrying the two passes by hand instead of in one script.",
		"",
		"Do not edit any files. Review only.",
	];
}

function buildReviewPrompt(
	mode: string,
	stats: DiffStats,
	options: { additionalInstructions?: string; diffInstruction: string; modelsText: string; seats: readonly PanelSeat[] },
): string {
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

	parts.push(...twoPassInstructions(options.diffInstruction, options.modelsText, options.seats));

	return parts.join("\n");
}

function buildCustomPrompt(instructions: string, modelsText: string, seats: readonly PanelSeat[]): string {
	return [
		"# Multi-model code review — custom instructions",
		"",
		instructions,
		"",
		...twoPassInstructions(
			"pulls the relevant diff/state itself (`git diff`, `git diff --cached`, or as directed above) and reviews it per the instructions above",
			modelsText,
			seats,
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
		description:
			"Launch a multi-model interactive code review — a diverse panel picked from the models this session can reach (/review config to edit the panel)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();

			// ── /review config — edit the panel rules ─────────────────────────────
			if (arg === "config" || arg === "models") {
				const load = loadPanelConfig();
				// Prefill with the user's OWN saved text when a file exists — even
				// broken text, because that's the text they need to fix in front of
				// them. The smart default is only for "no file yet". Serializing a
				// broken file back to the default would silently discard their
				// rules (and their typo, which is the thing to repair).
				let currentText: string;
				if (load.status === "default") {
					currentText = JSON.stringify(load.config, null, "\t");
				} else {
					try {
						currentText = readFileSync(panelConfigPath(), "utf8");
					} catch {
						currentText = JSON.stringify(SMART_DEFAULT, null, "\t");
					}
				}

				if (!ctx.hasUI) {
					// Headless: no editor — show the rules and where they live.
				pi.sendUserMessage(
						[
							"# /review config",
							"",
							`The panel rules live at \`${panelConfigPath()}\`:`,
							"",
							"```json",
							currentText,
							"```",
							"",
							...(load.status === "error"
								? [`The saved config is invalid and BLOCKS the review: ${load.error}`]
								: []),
							"Edit that file directly. Seats: personas + optional model pins + pass1Only. Exclude: globs matched against provider/model-id.",
						].join("\n"),
					);
					return;
				}

				const edited = await ctx.ui.editor(
					load.status === "error"
						? `Panel rules — the SAVED config is broken and blocks the review; fix your saved text below (or delete the file for the smart default)\n${load.error}`
						: "Panel rules — seats (personas, optional model pins, pass1Only) and exclude globs. Delete the file to return to the smart default.",
					currentText,
				);
				if (!edited?.trim()) return;
				const parsed = parsePanelConfig(edited);
				if (parsed.error) {
					ctx.ui.notify(`Not saved — ${parsed.error}`, "error");
					return;
				}
				const config = parsed.config!;
				savePanelConfig(config);
				// Pin reachability is a session property — warn now, block at review time.
				const pinErrors = validatePanelPins(config, ctx);
				if (pinErrors.length > 0) {
					ctx.ui.notify(
						`Saved — but note: ${pinErrors.join("; ")}. /review will block with this error until the pin is reachable or removed.`,
						"warning",
					);
				} else {
					ctx.ui.notify(`Saved panel rules to ${panelConfigPath()}`, "info");
				}
				return;
			}

			// ── /review [focus...] — a review ──────────────────────────────────────
			const extraInstructions = args.trim() || undefined;

			// The rules are the rules: a broken SAVED config blocks rather than
			// silently launching a different panel.
			const load = loadPanelConfig();
			if (load.status === "error") {
				if (ctx.hasUI) ctx.ui.notify(load.error!, "error");
				else pi.sendUserMessage(`# /review blocked\n\n${load.error}`);
				return;
			}
			const config = load.config!;

			const pinErrors = validatePanelPins(config, ctx);
			if (pinErrors.length > 0) {
				const msg = `Panel config error: ${pinErrors.join("; ")}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else pi.sendUserMessage(`# /review blocked\n\n${msg}`);
				return;
			}

			const modelsText = modelCandidatesText(ctx, config.exclude);
			const seats = config.seats;

			// No discovery pool and unpinned seats = a review that can't run.
			// Explicit error, never a models.json detour that would bypass the
			// session's scoping and auth filtering.
			if (!modelsText && seats.some((s) => !s.model)) {
				const msg =
					"no models this session can actually reach (registry empty, unreadable, or all excluded) — the panel has no discovery pool for its unpinned seats. Fix the excludes with /review config, or pin every seat's model.";
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else pi.sendUserMessage(`# /review blocked\n\n${msg}`);
				return;
			}

			// /review reviews git diffs; running it outside a repo just yields
			// raw git noise. Say the actual thing.
			try {
				git(ctx.cwd, ["rev-parse", "--is-inside-work-tree"]);
			} catch (err) {
				const msg =
					err instanceof GitCommandError && err.message.includes("not a git repository")
						? "this isn't a git repository — /review reviews git diffs, so run it from inside the repo whose changes you want reviewed."
						: err instanceof Error
							? err.message
							: String(err);
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else pi.sendUserMessage(`# /review blocked\n\n${msg}`);
				return;
			}

			if (!ctx.hasUI) {
				pi.sendUserMessage(
					buildCustomPrompt(extraInstructions ?? "Review uncommitted changes for bugs.", modelsText, seats),
				);
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
									modelsText,
									seats,
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
									modelsText,
									seats,
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
								modelsText,
								seats,
							}),
						);
						return;
					}

					case "custom": {
						const instructions = await ctx.ui.editor("Enter custom review instructions", "Review the following:\n\n");
						if (!instructions?.trim()) return;
						pi.sendUserMessage(buildCustomPrompt(instructions, modelsText, seats));
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
