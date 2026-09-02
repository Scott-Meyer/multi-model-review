/**
 * Diff parsing, weighting and prompt construction — ported 1:1 from omp's
 * bundled `/review` command (see ./UPSTREAM for the pinned version).
 *
 * Structure, names, thresholds, heuristics and the exclusion table are
 * upstream's. Doc comments that describe upstream behaviour are upstream's
 * words. Nothing here changes what upstream reviews or how it weights it; the
 * only differences are the two forced by pi's platform:
 *
 *   ADAPTED    PR diff instructions name `gh pr diff` instead of omp's
 *              internal `pr://` resource scheme, which pi cannot resolve
 *   ADAPTED    findRecentPrRefs reads pi's SessionManager instead of omp's
 *
 * Upstream limitations are preserved rather than fixed, deliberately — see
 * PROVENANCE.md "Upstream limitations preserved". A "harmless" local fix is
 * how a port stops being a port.
 *
 * The prompt templates themselves are verbatim upstream files rendered by
 * upstream's own renderer; see ./overrides.ts for the two sections we replace
 * and why.
 */
import * as prompt from "../vendor/prompt.ts";
import {
	OverrideError,
	type ReviewVariant,
	reviewCustomRequestTemplate,
	reviewHeadlessRequestTemplate,
	reviewRequestTemplate,
} from "./overrides.ts";
import * as panelCrossCheck from "./launch/panel-cross-check.ts";
import * as panelMultimodal from "./launch/panel-multimodal.ts";
import * as panelSinglePass from "./launch/panel-single-pass.ts";
import * as upstreamShard from "./launch/upstream-shard.ts";

/**
 * A template referenced a name its builder does not supply.
 *
 * Exists because the vendored renderer cannot tell us. `vendor/template.ts` is a
 * reimplementation of handlebars whose `strict` option is declared in the type
 * (line 32) and never honoured, so an unsupplied variable renders as the empty
 * string and the prompt ships subtly wrong. That is not hypothetical: it is how
 * the custom-instructions prompt shipped a numbered instruction with no text and
 * a reference to a diff it does not contain, and how the headless prompt shipped
 * fan-out mechanics with no statement of scope. Both were invisible to `tsc`, to
 * the renderer, and to every test that did not happen to read that exact line.
 *
 * The engine is verbatim upstream by contract, so it cannot be made strict.
 * Validating at the three call sites is the next best place: one check, applied
 * to every prompt, that turns a silent content bug into a loud failure.
 *
 * Subclasses OverrideError so index.ts reports it through the existing
 * "prompt override failed" path — a missing variable IS a prompt-assembly bug.
 */
export class PromptContractError extends OverrideError {}

/**
 * Wrap a render context so a lookup of a name it does not have THROWS.
 *
 * Deliberately not a template parser. An earlier attempt at this re-derived the
 * mustache grammar here — helper-vs-path classification, item-scope tracking, a
 * hand-maintained list of registered helper names — and that is unsafe in
 * production for a specific reason: a helper the list does not know gets
 * misread as a context path, so registering a new helper would make a valid
 * template throw and break the command outright. Duplicating a grammar that
 * `vendor/template.ts` already implements is how that class of bug arrives.
 *
 * This instead lets the renderer's own resolver do the work. `property()`
 * (vendor/template.ts:325-332) resolves every path segment with
 * `Object.hasOwn(record, key) ? record[key] : undefined` — so a Proxy whose
 * `getOwnPropertyDescriptor` trap throws on an absent string key turns that
 * silent `undefined` into a loud failure, using the engine's real grammar for
 * free. `length` and the prototype keys are special-cased before that call, so
 * they never reach the trap.
 *
 * Own keys holding `undefined` stay valid: an absent `focus` or a missing
 * snapshot command is supplied-and-empty on purpose. Never-supplied is the bug.
 */
function strictContext<T>(value: T, where: string): T {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date || value instanceof RegExp) return value;
	return new Proxy(value as object, {
		getOwnPropertyDescriptor(target, key) {
			if (typeof key === "string" && !Object.hasOwn(target, key)) {
				throw new PromptContractError(
					`${where} reads template variable "${key}", which its builder does not supply. ` +
						`The renderer would substitute an empty string, shipping a prompt with a ` +
						`missing instruction rather than failing. Supply the key (undefined is fine ` +
						`if absence is intended) or stop referencing it.`,
				);
			}
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		get(target, key, receiver) {
			const result = Reflect.get(target, key, receiver);
			// Wrap nested values too, so `{{#table files}}{{path}}{{/table}}` holds
			// item objects to the same contract as the top-level context.
			return typeof key === "string" ? strictContext(result, where) : result;
		},
	}) as T;
}

/**
 * Render, failing loudly when the template reads a name the context lacks.
 *
 * Exported so the suite can exercise the contract at its real boundary: the
 * builders below always spread a complete context, so a violation can only be
 * introduced by editing a TEMPLATE to read something new — which is exactly what
 * happened twice. A test needs to render a real template against a deliberately
 * incomplete context to prove the guard fires.
 */
export function renderChecked(template: string, context: Record<string, unknown>, what: string): string {
	return prompt.render(template, strictContext(context, what));
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FileDiff {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	hunks: string;
}

export interface DiffStats {
	files: FileDiff[];
	totalAdded: number;
	totalRemoved: number;
	excluded: { path: string; reason: string; linesAdded: number; linesRemoved: number }[];
}

export interface ReviewPrRef {
	repo: string;
	number: number;
	raw: string;
	kind: "github-url" | "pr-url";
}

export interface ParsedReviewArgs {
	prRef: ReviewPrRef | undefined;
	extraInstructions: string;
}

/** Everything the override sections need to render. */
export interface PanelContext {
	/** Rendered candidate-model list for this session, grouped by provider. */
	modelsText: string;
	/** K — distinct model families per shard. 1 means upstream: a single model. */
	families: number;
	/** N — "auto" defers to upstream's diff-weight heuristic. */
	shardDepth: "auto" | number;
	/** Whether to run the second, cross-examining pass. Upstream does not. */
	crossCheck: boolean;
	/** Above this many total runs (N x K), confirm with the user before launching. */
	confirmAboveRuns: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exclusion patterns for noise files (verbatim upstream, including order)
// ─────────────────────────────────────────────────────────────────────────────

const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
	// Lock files
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /flake\.lock$/, reason: "lock file" },

	// Generated/build artifacts
	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },

	// Binary/assets (usually shown as binary in diff anyway)
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

/**
 * Check if a file path should be excluded from review.
 * Returns the exclusion reason if excluded, undefined otherwise.
 */
export function getExclusionReason(path: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(path)) return reason;
	}
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse unified diff output into per-file stats.
 * Splits on file boundaries, counts +/- lines, and filters excluded files.
 */
export function parseDiff(diffOutput: string): DiffStats {
	const files: FileDiff[] = [];
	const excluded: DiffStats["excluded"] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	// Split by file boundary: "diff --git a/... b/..."
	const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const chunk of fileChunks) {
		// Extract file path from "a/path b/path" line. Upstream's regex, kept as
		// is: it is ambiguous for paths containing spaces, but preserving
		// upstream's exact file-selection behaviour is the point of this port,
		// and a silently different set of reviewed files is a worse failure than
		// a known shared limitation. See PROVENANCE.md.
		const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
		if (!headerMatch) continue;

		const path = headerMatch[2];

		// Count added/removed lines (lines starting with + or - but not ++ or --)
		let linesAdded = 0;
		let linesRemoved = 0;

		const lines = chunk.split("\n");
		for (const line of lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				linesAdded++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				linesRemoved++;
			}
		}

		const exclusionReason = getExclusionReason(path);
		if (exclusionReason) {
			excluded.push({ path, reason: exclusionReason, linesAdded, linesRemoved });
		} else {
			files.push({
				path,
				linesAdded,
				linesRemoved,
				hunks: `diff --git ${chunk}`,
			});
			totalAdded += linesAdded;
			totalRemoved += linesRemoved;
		}
	}

	return { files, totalAdded, totalRemoved, excluded };
}

/**
 * Metadata-only chunk: git fully described the change without showing content.
 *
 * A pure rename (`similarity index 100%` + `rename from`/`rename to`) and a
 * mode-only change (`old mode`/`new mode`) both produce a chunk with no `@@`
 * hunk, exactly like a binary file does — but they are not coverage gaps. The
 * diff already says everything there is to say: the file moved, or its exec bit
 * flipped, and its contents did not change. Reporting them as "nobody reviewed
 * this" was a false alarm on every refactor that moves a file, and a coverage
 * disclosure that cries wolf is one users learn to skip past.
 */
const METADATA_ONLY = /^(?:similarity index|dissimilarity index|rename from|rename to|copy from|copy to|old mode|new mode|new file mode|deleted file mode|index )/;

function isMetadataOnly(hunks: string): boolean {
	// Drop the `diff --git a/x b/x` header, then require every remaining
	// non-empty line to be metadata. A binary chunk fails this on its
	// `Binary files ... differ` line, which is the distinction that matters.
	const body = hunks.split("\n").slice(1).filter((l) => l.trim().length > 0);
	return body.length > 0 && body.every((l) => METADATA_ONLY.test(l));
}

/**
 * Files present in the diff that carry no reviewable content.
 *
 * A binary file's chunk is a header plus `Binary files ... differ` with no `@@`
 * hunk. Such a path is in the file table but there is nothing for a reviewer to
 * read, so it must be disclosed rather than counted as covered. Derived from the
 * parsed diff, which means tracked binaries are caught too, not just new ones.
 *
 * Renames and mode-only changes are excluded — see METADATA_ONLY.
 */
export function unreviewablePaths(stats: DiffStats): string[] {
	return stats.files.filter((f) => !f.hunks.includes("@@") && !isMetadataOnly(f.hunks)).map((f) => f.path);
}

/**
 * Get file extension for display purposes.
 */
function getFileExt(path: string): string {
	const match = path.match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

/**
 * Determine recommended number of reviewer agents based on diff weight.
 * Uses total lines changed as the primary metric.
 *
 * Under the cross-product fan-out this is the SHARD count (N). Each shard is
 * then reviewed by K model families, so the child count is N x K — the
 * heuristic keeps its original meaning of "how finely should this diff be cut
 * up", and model diversity is a second, independent axis.
 */
export function getRecommendedAgentCount(stats: DiffStats): number {
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const fileCount = stats.files.length;

	// Heuristics:
	// - Tiny (<100 lines or 1-2 files): 1 agent
	// - Small (<500 lines): 1-2 agents
	// - Medium (<2000 lines): 2-4 agents
	// - Large (<5000 lines): 4-8 agents
	// - Huge (>5000 lines): 8-16 agents

	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

/**
 * Extract first N lines of actual diff content (excluding headers) for preview.
 */
function getDiffPreview(hunks: string, maxLines: number): string {
	const lines = hunks.split("\n");
	const contentLines: string[] = [];

	for (const line of lines) {
		// Skip diff headers, keep actual content
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@")
		) {
			continue;
		}
		contentLines.push(line);
		if (contentLines.length >= maxLines) break;
	}

	return contentLines.join("\n");
}

// Thresholds for diff inclusion
const MAX_DIFF_CHARS = 50_000; // Don't include diff above this
const MAX_FILES_FOR_INLINE_DIFF = 20; // Don't include diff if more files than this
const DEFAULT_LARGE_DIFF_INSTRUCTION = "MUST run `git diff`/`git show` for assigned files";
const DEFAULT_CONTEXT_INSTRUCTION = "MAY read full file context as needed via `read`";

/**
 * Build the full review prompt with diff stats and distribution guidance.
 */
export function buildReviewPrompt(
	mode: string,
	stats: DiffStats,
	rawDiff: string,
	panel: PanelContext,
	options: {
		additionalInstructions?: string;
		diffInstruction?: string;
		contextInstruction?: string;
		/** Untracked paths excluded from `rawDiff`, disclosed in the prompt. */
		untracked?: readonly string[];
		/** Which distribution section to render. Required: see ReviewVariant. */
		variant: ReviewVariant;
	},
): string {
	const agentCount = getRecommendedAgentCount(stats);
	const skipDiff = rawDiff.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / stats.files.length)) : 0;

	const filesWithExt = stats.files.map((f) => ({
		...f,
		ext: getFileExt(f.path),
		hunksPreview: skipDiff ? getDiffPreview(f.hunks, linesPerFile) : "",
	}));

	return renderChecked(reviewRequestTemplate(options.variant), {
		mode,
		files: filesWithExt,
		excluded: stats.excluded,
		totalAdded: stats.totalAdded,
		totalRemoved: stats.totalRemoved,
		totalLines,
		agentCount,
		multiAgent: agentCount > 1,
		skipDiff,
		rawDiff: rawDiff.trim(),
		linesPerFile,
		additionalInstructions: options.additionalInstructions,
		diffInstruction: options.diffInstruction ?? DEFAULT_LARGE_DIFF_INSTRUCTION,
		contextInstruction: options.contextInstruction ?? DEFAULT_CONTEXT_INSTRUCTION,
		// The multi-model delta, consumed only by our override sections.
		...panelTemplateContext(panel, agentCount, options.variant),
		...untrackedTemplateContext(options.untracked),
	}, `review-request.md (${options.variant})`);
}

export function buildCustomReviewPrompt(
	instructions: string,
	panel: PanelContext,
	untracked: readonly string[],
	variant: ReviewVariant,
): string {
	return renderChecked(reviewCustomRequestTemplate(variant), {
		instructions,
		...panelTemplateContext(panel, 1, variant),
		...untrackedTemplateContext(untracked),
	}, `review-custom-request.md (${variant})`);
}

/**
 * `snapshotCommand` is passed in rather than computed here: it depends on which
 * VCS the working directory actually uses, and this module deliberately does no
 * I/O. The caller has `ctx.cwd`; see vcs.snapshotCommandFor.
 */
export function buildHeadlessReviewPrompt(
	panel: PanelContext,
	focus: string | undefined,
	variant: ReviewVariant,
	/** Undefined when cwd is neither a git nor a jj checkout. */
	snapshotCommand: string | undefined,
): string {
	return renderChecked(reviewHeadlessRequestTemplate(variant), {
		focus,
		// Headless has no pre-built diff, so the prompt carries the command that
		// makes one.
		snapshotCommand,
		...panelTemplateContext(panel, 1, variant),
		...untrackedTemplateContext(),
	}, `review-headless-request.md (${variant})`);
}

/**
 * Paths that could not be included in the review, rendered for the PROMPT.
 *
 * This belongs in the prompt, not only in a terminal notice. A notice is seen by
 * the human for a moment; the prompt is what every reviewer and the synthesising
 * agent actually read. Without it, a review that covered part of a change
 * reports as if it covered all of it, and nothing in the artifact can contradict
 * that.
 *
 * Paths are escaped with JSON.stringify rather than wrapped in backticks. Git
 * filenames are arbitrary bytes — `untrackedFiles` reads them NUL-separated
 * precisely so odd names survive — and a name containing a newline or a backtick
 * would otherwise break out of its list item, or worse, read as further
 * instructions to the orchestrating agent. Quoting also makes trailing spaces
 * and control characters visible instead of invisible.
 */
function untrackedTemplateContext(untracked: readonly string[] = []): Record<string, unknown> {
	const MAX_LISTED = 20;
	const shown = untracked.slice(0, MAX_LISTED);
	const lines = shown.map((path) => `- ${JSON.stringify(path)}`);
	if (untracked.length > shown.length) lines.push(`- …and ${untracked.length - shown.length} more`);
	return {
		hasExcludedUntracked: untracked.length > 0,
		untrackedCount: untracked.length,
		untrackedList: lines.join("\n"),
	};
}

/**
 * Derive the fan-out arithmetic once, here, rather than asking the model to do
 * it in the prompt.
 *
 * The shard count is upstream's `getRecommendedAgentCount`, used verbatim and
 * never adjusted. An earlier version silently reduced it to respect a run
 * ceiling, which quietly replaced upstream's sharding decision with our own —
 * exactly the kind of invisible divergence this port exists to avoid. The
 * ceiling is now a CONFIRMATION threshold: a large fan-out is surfaced to the
 * user before launch, and they decide, rather than the code redefining N or K
 * on their behalf.
 */
/**
 * Pick the launch script for a configuration.
 *
 * The scripts are real modules under ./launch, type-checked and executed by the
 * suite against a fake `runs`; this only chooses which one the prompt embeds.
 * They used to live as JavaScript inside markdown code fences, interleaved by
 * `{{#if crossCheck}}`, where nothing compiled or ran them — which is how a
 * survivor filter testing `runId` instead of `ok`, an unfiltered pass-2 map, and
 * cross-check text on single-pass runs all shipped.
 */
function launchScriptFor(variant: ReviewVariant, upstreamShape: boolean, crossCheck: boolean): string {
	if (variant === "panel") return panelMultimodal.script();
	if (upstreamShape) return upstreamShard.script();
	return crossCheck ? panelCrossCheck.script() : panelSinglePass.script();
}

function panelTemplateContext(
	panel: PanelContext,
	agentCount: number,
	variant: ReviewVariant,
): Record<string, unknown> {
	const families = Math.max(1, panel.families);
	const crossCheckOn = panel.crossCheck && families > 1;
	// "auto" is upstream's own recommendation, used verbatim. An explicit number
	// is the user overriding how finely to cut the diff.
	const shardCount = panel.shardDepth === "auto" ? agentCount : Math.max(1, panel.shardDepth);
	const childCount = shardCount * families;
	// What this will actually SPEND. Cross-checking resumes every surviving seat,
	// so the real figure is up to double the seat count — and the guard has to
	// compare against that, not against the seat count. Guarding on seats alone
	// let N=3,K=3,crossCheck spend up to 18 invocations under a 12 threshold
	// without asking, which is precisely the most expensive configuration.
	const plannedInvocations = crossCheckOn ? childCount * 2 : childCount;
	return {
		modelsText: panel.modelsText,
		families,
		shardCount,
		childCount,
		multiShard: shardCount > 1,
		// The two switches that take this away from upstream behaviour. When both
		// are off the rendered prompt is upstream's flow with `task` -> `subagent`.
		multiFamily: families > 1,
		crossCheck: crossCheckOn,
		plannedInvocations,
		upstreamShape: families === 1 && !panel.crossCheck,
		launchScript: launchScriptFor(variant, families === 1 && !panel.crossCheck, crossCheckOn),
		shardDepthOverridden: panel.shardDepth !== "auto",
		recommendedShards: agentCount,
		confirmAboveRuns: panel.confirmAboveRuns,
		// Only OUR multipliers earn a confirmation prompt. Upstream never pauses,
		// and its heuristic can recommend up to 16 shards on a large diff — so
		// asking in the upstream shape would make the default not-upstream for
		// exactly the big changes where the heuristic matters most. A run is
		// "ours" when families > 1 or crossCheck doubles the invocations; an
		// explicit shardDepth is the user's own number and needs no confirming.
		needsConfirmation: !(families === 1 && !panel.crossCheck) && plannedInvocations > panel.confirmAboveRuns,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// PR references (verbatim upstream, except the two instruction builders)
// ─────────────────────────────────────────────────────────────────────────────

export const REVIEW_CONTEXT_PR_LIMIT = 3;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const PR_SCHEME_PATTERN = /^pr:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([1-9]\d*)(?:\/diff(?:\/(?:all|[1-9]\d*))?)?$/;
const PR_REF_TEXT_PATTERN = /https:\/\/github\.com\/[^\s<>"']+|pr:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[^\s<>"']+/g;

function stripTrailingPrRefPunctuation(text: string): string {
	return text.replace(/[.,)\]>]+$/g, "");
}

function isValidRepoSegment(segment: string | undefined): segment is string {
	return segment !== undefined && REPO_SEGMENT_PATTERN.test(segment);
}

function parsePositivePrNumber(value: string | undefined): number | undefined {
	if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseGithubPrUrl(text: string): ReviewPrRef | undefined {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}

	if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;

	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 4 || parts[2] !== "pull") return undefined;

	const [owner, repo, , numberPart] = parts;
	if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return undefined;

	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;

	return { repo: `${owner}/${repo}`, number, raw: text, kind: "github-url" };
}

function parsePrSchemeRef(text: string): ReviewPrRef | undefined {
	const match = PR_SCHEME_PATTERN.exec(text);
	if (!match) return undefined;

	const [, owner, repo, numberPart] = match;
	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;

	return { repo: `${owner}/${repo}`, number, raw: text, kind: "pr-url" };
}

export function parseReviewPrRef(text: string): ReviewPrRef | undefined {
	const candidate = stripTrailingPrRefPunctuation(text);
	return parseGithubPrUrl(candidate) ?? parsePrSchemeRef(candidate);
}

/**
 * ADAPTED: upstream points reviewers at `pr://<repo>/<n>/diff/all` and per-file
 * `pr://.../diff/<index>`. That scheme is resolved by omp's own resource layer;
 * pi has no resolver for it, so a verbatim copy would hand every reviewer a
 * dead URL. Same intent — read the PR's diff, never the local workspace —
 * expressed with the `gh` CLI.
 */
export function buildPrLargeDiffInstruction(ref: ReviewPrRef): string {
	return `MUST read assigned PR file diffs from \`gh pr diff ${ref.number} --repo ${ref.repo}\`; NEVER use local \`git diff\`/\`git show\` for PR diff content`;
}

export function buildPrContextInstruction(ref: ReviewPrRef): string {
	return `MUST NOT read local workspace files for PR file context; use the fetched PR diff and \`gh pr diff ${ref.number} --repo ${ref.repo}\` only`;
}

export function extractReviewPrRefFromArgs(args: string[]): ParsedReviewArgs {
	let prRef: ReviewPrRef | undefined;
	let prRefIndex = -1;
	for (const [idx, arg] of args.entries()) {
		const parsed = parseReviewPrRef(arg);
		if (parsed) {
			prRef = parsed;
			prRefIndex = idx;
			break;
		}
	}

	return {
		prRef,
		extraInstructions: args.filter((_, idx) => idx !== prRefIndex).join(" "),
	};
}

export function extractReviewPrRefsFromText(text: string): ReviewPrRef[] {
	return Array.from(text.matchAll(PR_REF_TEXT_PATTERN), (match) => parseReviewPrRef(match[0])).filter(
		(ref): ref is ReviewPrRef => ref !== undefined,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getTextContentParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		}
	}
	return parts;
}

/**
 * Most recent PR references mentioned in the conversation, newest first.
 *
 * ADAPTED only in where the entries come from: upstream reads its own
 * `ctx.sessionManager.getBranch()`; pi exposes the same call on its
 * ReadonlySessionManager, with the same message-entry shape, so the scan logic
 * itself is upstream's unchanged.
 */
export function findRecentPrRefs(entries: readonly unknown[], limit: number): ReviewPrRef[] {
	const refs: ReviewPrRef[] = [];
	const seen = new Set<string>();

	for (let idx = entries.length - 1; idx >= 0 && refs.length < limit; idx--) {
		const entry = entries[idx];
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const parts = getTextContentParts(message.content);
		for (let partIdx = parts.length - 1; partIdx >= 0; partIdx--) {
			const part = parts[partIdx];
			const partRefs = extractReviewPrRefsFromText(part);
			for (let refIdx = partRefs.length - 1; refIdx >= 0; refIdx--) {
				const ref = partRefs[refIdx];
				const key = `${ref.repo.toLowerCase()}#${ref.number}`;
				if (seen.has(key)) continue;
				seen.add(key);
				refs.push(ref);
				if (refs.length >= limit) break;
			}
			if (refs.length >= limit) break;
		}
	}

	return refs;
}
