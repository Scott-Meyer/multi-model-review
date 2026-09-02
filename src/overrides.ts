/**
 * Section overrides — the seam between verbatim upstream prompts and pi.
 *
 * src/prompts/review-*.md are byte-identical upstream files (enforced by
 * scripts/check-upstream-drift.sh). Two things in them cannot survive the move
 * to pi, because they name omp machinery that does not exist here:
 *
 *   - the distribution section tells the agent to use the `task` tool with a
 *     `tasks` array. pi's equivalent is the `subagent` tool, and this is also
 *     exactly where the multi-model extension belongs.
 *   - the last reviewer instruction says to report findings through incremental
 *     `yield` sections. pi has no yield channel; a reviewer subagent returns
 *     one structured output at the end.
 *
 * So rather than forking the templates (which would quietly turn "verbatim
 * upstream" into "our fork"), we keep them untouched on disk and replace those
 * two sections at load time from src/prompts/pi-*.md. The replacement is
 * addressed by exact heading text and FAILS LOUDLY if the heading is gone: a
 * silently-skipped override would ship a prompt telling the agent to call a
 * tool it does not have, which is worse than not running at all.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class OverrideError extends Error {}

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

function readPrompt(name: string): string {
	return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

/**
 * Replace everything between two exact anchor lines, keeping both anchors.
 *
 * Both ends are explicit on purpose. Inferring the end of a section from the
 * next heading looks fine and is quietly wrong on these templates: the heading
 * after "### Reviewer Instructions" is "### Diff Previews", which lives INSIDE
 * a `{{#if skipDiff}}` block. Cutting there swallows the block opener and
 * leaves an orphan `{{else}}`, which fails at render time — and a
 * depth-aware scan has the opposite failure, running to end-of-file and
 * eating the diff sections. So the caller names the end anchor, both are
 * asserted, and drift is caught by scripts/check-upstream-drift.sh.
 */
function replaceBetween(text: string, startAnchor: string, endAnchor: string, body: string): string {
	const lines = text.split("\n");
	const start = lines.indexOf(startAnchor);
	if (start === -1) throw missingAnchor(startAnchor);
	const end = lines.indexOf(endAnchor, start + 1);
	if (end === -1) throw missingAnchor(endAnchor);
	return [...lines.slice(0, start + 1), "", body.trim(), "", ...lines.slice(end)].join("\n");
}

function missingAnchor(anchor: string): OverrideError {
	return new OverrideError(
		`upstream template no longer contains the anchor line "${anchor}" — the pi override cannot be applied. ` +
			`Bump the pin in ./UPSTREAM and re-derive src/prompts/pi-*.md against the new upstream text.`,
	);
}

/** Replace a whole line identified by its prefix. Throws when absent. */
function replaceLine(text: string, prefix: string, replacement: string): string {
	const lines = text.split("\n");
	const idx = lines.findIndex((l) => l.startsWith(prefix));
	if (idx === -1) {
		throw new OverrideError(
			`upstream template no longer contains a line starting with "${prefix}" — the pi override cannot be applied. ` +
				`Bump the pin in ./UPSTREAM and re-derive src/prompts/pi-*.md.`,
		);
	}
	lines[idx] = replacement;
	return lines.join("\n");
}

/**
 * Which distribution section to splice in.
 *
 * `sharded` is /review: upstream's flow, optionally widened to several model
 * families. `panel` is /review-multi-modal: no sharding, one seat per family
 * plus persona seats, single pass.
 *
 * Deliberately has NO default anywhere it is passed. A default of "sharded" is
 * what let /review-multi-modal silently render ordinary /review on the headless
 * and PR paths: every un-threaded call site compiled fine and produced plausible
 * output, so `tsc` was clean while two commands were wrong. Required means the
 * compiler enumerates the paths instead of a reviewer having to find them.
 */
export type ReviewVariant = "sharded" | "panel";

const DISTRIBUTION: Record<ReviewVariant, string> = {
	sharded: "pi-distribution.md",
	panel: "pi-multimodal-distribution.md",
};

const cachedReview = new Map<ReviewVariant, string>();
const cachedCustom = new Map<ReviewVariant, string>();
const cachedHeadless = new Map<ReviewVariant, string>();

/** Upstream's review-request.md with the two pi-incompatible sections swapped. */
export function reviewRequestTemplate(variant: ReviewVariant): string {
	const hit = cachedReview.get(variant);
	if (hit) return hit;
	let text = readPrompt("review-request.md");
	text = replaceBetween(
		text,
		"### Distribution Guidelines",
		"### Reviewer Instructions",
		readPrompt(DISTRIBUTION[variant]),
	);
	// Ends at the conditional diff block, not at the next heading — see
	// replaceBetween's comment for why that distinction matters here.
	text = replaceBetween(text, "### Reviewer Instructions", "{{#if skipDiff}}", readPrompt("pi-reviewer-instructions.md"));
	cachedReview.set(variant, text);
	return text;
}

/**
 * Upstream's review-custom-request.md, same two sections (h2 here).
 *
 * Uses its OWN reviewer-instruction body, not review-request.md's. Upstream's
 * custom list is genuinely different — "Follow custom instructions" / "Read
 * referenced files/workspace context needed to evaluate them" / the `yield`
 * line — and only the `yield` line describes omp machinery pi lacks. Splicing
 * the sharded body in here replaced all three: the reviewer stopped being told
 * to follow the custom instructions at all (the entire point of the mode), was
 * pointed at "diff hunks below" in a template that contains no diff, and got a
 * bare "3." because this caller supplies neither `skipDiff` nor
 * `contextInstruction` — which the vendored renderer resolves to empty rather
 * than throwing, so nothing surfaced it.
 */
export function reviewCustomRequestTemplate(variant: ReviewVariant): string {
	const hit = cachedCustom.get(variant);
	if (hit) return hit;
	let text = readPrompt("review-custom-request.md");
	text = replaceBetween(text, "## Distribution", "## Reviewer Instructions", readPrompt(DISTRIBUTION[variant]));
	text = replaceBetween(
		text,
		"## Reviewer Instructions",
		"## Custom Instructions",
		readPrompt("pi-custom-reviewer-instructions.md"),
	);
	cachedCustom.set(variant, text);
	return text;
}

/**
 * Upstream's review-headless-request.md. Its distribution guidance is a single
 * inline line rather than a section, so it is replaced by prefix.
 *
 * That one line also carried the only statement of WHAT to review ("for recent
 * code changes"). This template has no file table, no stats and no diff, so
 * after a naive swap the prompt went straight from "Mode: headless review
 * request." into fan-out mechanics that reference "every file above" — leaving
 * the orchestrator a mechanism with dangling references and no scope.
 *
 * So the replacement does two jobs: it restates the scope, and it tells the
 * orchestrator to PRODUCE the diff those references point at. Headless is the
 * one path where nothing upstream of the prompt builds a diff, so without this
 * every launch instruction ("every file above", "paste that shard's diff hunks",
 * "the whole diff") refers to something that does not exist yet.
 *
 * The command comes from `vcs.headlessSnapshotCommand()` rather than being
 * written out here, so there is one definition of "how this command snapshots a
 * worktree" instead of a prose paraphrase that can drift from it.
 */
const HEADLESS_SCOPE = [
	"Review recent code changes in this repository.",
	"",
	"There is no file table or diff below — produce it yourself before fanning out,",
	"with this exact command (read-only: it writes a throwaway index, never yours):",
	"",
	"```bash",
	"{{snapshotCommand}}",
	"```",
	"",
	"Use that, not `git diff HEAD`: the plain form omits files that were never",
	"`git add`ed, which this command reviews, and fails before the first commit.",
	"Paths it reports are repo-root-relative. Every reference to files or diff hunks",
	"in the section that follows means that diff, and each reviewer's task must carry",
	"the hunks for its own files, because a reviewer sees only its own task text.",
].join("\n");

export function reviewHeadlessRequestTemplate(variant: ReviewVariant): string {
	const hit = cachedHeadless.get(variant);
	if (hit) return hit;
	let text = readPrompt("review-headless-request.md");
	text = replaceLine(
		text,
		"Distribution: Use `task`",
		`${HEADLESS_SCOPE}\n\n${readPrompt(DISTRIBUTION[variant]).trim()}`,
	);
	cachedHeadless.set(variant, text);
	return text;
}

/** Test hook: drop the memoised templates so overrides re-apply from disk. */
export function resetTemplateCache(): void {
	cachedReview.clear();
	cachedCustom.clear();
	cachedHeadless.clear();
}
