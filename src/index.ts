/**
 * /review — multi-model code review launcher.
 *
 * A port of omp's bundled `/review` command (github.com/can1357/oh-my-pi) onto
 * pi's extension API, pinned at the version in ./UPSTREAM, extended along
 * exactly one axis: every shard of the diff is reviewed independently by
 * several different model families, which then cross-check each other.
 *
 * What "port" means here, precisely:
 *
 *   - the prompt templates are VERBATIM upstream files (src/prompts/review-*.md),
 *     rendered by VERBATIM upstream code (vendor/prompt.ts, vendor/template.ts).
 *     scripts/check-upstream-drift.sh proves it against the pinned tarballs.
 *   - the diff parsing, weighting heuristic, exclusion table, PR-reference
 *     handling and menu flow are ported 1:1 in ./review-core.ts, with three
 *     marked deviations and their reasons.
 *   - two prompt sections are replaced (./overrides.ts) because they name omp
 *     machinery pi does not have: the `task` tool and yield-section findings.
 *   - the VCS layer (./vcs.ts) is ours by necessity: upstream's is a native
 *     module that cannot be vendored into a pi extension.
 *   - model discovery and the panel rules (./panel.ts) are original — upstream
 *     has no notion of choosing models.
 *
 * This extension only builds a prompt and hands it to the current session via
 * pi.sendUserMessage(). All reviewing happens through the normal `subagent`
 * tool, using the `reviewer` agent adapted from upstream's in ../agents/.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CustomUiHost } from "./branch-picker.ts";
import { OverrideError, type ReviewVariant } from "./overrides.ts";
import {
	DEFAULT_CONFIG,
	loadPanelConfig,
	modelCandidatesText,
	panelConfigPath,
	parsePanelConfig,
	savePanelConfig,
} from "./panel.ts";
import {
	buildCustomReviewPrompt,
	buildHeadlessReviewPrompt,
	buildPrContextInstruction,
	buildPrLargeDiffInstruction,
	buildReviewPrompt,
	extractReviewPrRefFromArgs,
	findRecentPrRefs,
	type DiffStats,
	type PanelContext,
	parseDiff,
	REVIEW_CONTEXT_PR_LIMIT,
	unreviewablePaths,
	type ReviewPrRef,
} from "./review-core.ts";
import * as vcs from "./vcs.ts";

type ReviewMenuChoice =
	| { kind: "detected-pr"; ref: ReviewPrRef }
	| { kind: "base-branch" }
	| { kind: "uncommitted" }
	| { kind: "commit" }
	| { kind: "custom" };

/**
 * Size a diff before fetching it, and report clearly when it is too big.
 *
 * Without this, an oversized diff surfaces as `spawnSync git ENOBUFS` from deep
 * inside execFileSync — a message that names neither the command nor the cause.
 * Returns true when the caller should stop.
 */
function tooLarge(ctx: ExtensionCommandContext, diffArgs: string[], what: string): boolean {
	const size = vcs.shortstat(ctx.cwd, diffArgs);
	const message = vcs.diffTooLargeMessage(size, what);
	if (!message) return false;
	ctx.ui.notify(message, "error");
	return true;
}

const BRANCH_LIST_LIMIT = 30;

/**
 * Pick the base branch.
 *
 * In a terminal this is a live-filtered, fixed-height list (see
 * ./branch-picker.ts): type to narrow, arrows scroll a window, Enter selects.
 * That is the only flow that actually scales to a monorepo's branch namespace,
 * because pi's plain `ui.select` renders every option it is given.
 *
 * Everywhere else (RPC has dialogs but no custom components) it degrades to one
 * input that doubles as an exact ref and a filter, then a bounded plain list.
 */
async function pickBaseBranch(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
	// Terminal only: custom components need a TUI. `mode` is checked here rather
	// than in the picker module so this file never has to load it (and therefore
	// never has to resolve pi-tui) outside a terminal.
	if (ctx.mode === "tui") {
		const branches = vcs.allBranchesWithAge(ctx.cwd).filter((b) => b.name !== current);
		if (branches.length === 0) {
			ctx.ui.notify("No other branches found", "error");
			return undefined;
		}

		// The picker is imported lazily because it is the only thing here that
		// imports pi-tui directly. pi-tui is a declared peer dependency, but under
		// a strict or non-hoisted install it can still be unresolvable — and a
		// dead `/review` would be a much worse outcome than a plainer branch
		// prompt, so fall back instead of failing.
		try {
			const { pickFromList } = await import("./branch-picker.ts");
			return await pickFromList(
				ctx as unknown as CustomUiHost,
				`Base branch for \`${current}\``,
				branches.map((b) => ({
					value: b.name,
					description: `${b.remote ? "remote" : "local"} · ${b.age}`,
				})),
			);
		} catch (err) {
			ctx.ui.notify(
				`Falling back to the plain branch prompt — the filtered picker could not load ` +
					`(${err instanceof Error ? err.message : String(err)}). Installing \`@earendil-works/pi-tui\` restores it.`,
				"warning",
			);
		}
	}

	return pickBaseBranchWithoutCustomUi(ctx, current);
}

/**
 * Fallback for non-terminal front ends: one prompt that serves as both an exact
 * ref and a filter, so nothing becomes unreachable without a custom component.
 */
async function pickBaseBranchWithoutCustomUi(
	ctx: ExtensionCommandContext,
	current: string,
): Promise<string | undefined> {
	const typed = (
		await ctx.ui.input(
			`Base branch for \`${current}\` — name, or text to filter:`,
			"e.g. main, origin/main, or 'prod' to filter — blank for recent",
		)
	)?.trim();
	if (typed === undefined) return undefined; // cancelled

	// Exact ref wins: `main` means `main`, even if other branches contain "main".
	if (typed && vcs.refExists(ctx.cwd, typed)) return typed;

	let candidates: string[];
	let title: string;

	if (typed) {
		const needle = typed.toLowerCase();
		const matches = vcs
			.allBranchesByRecency(ctx.cwd)
			.filter((b) => b !== current && b.toLowerCase().includes(needle));
		if (matches.length === 0) {
			ctx.ui.notify(
				`No branch, tag or commit matches \`${typed}\`. Leave the box blank to pick from your recent branches.`,
				"error",
			);
			return undefined;
		}
		if (matches.length === 1) {
			ctx.ui.notify(`Base branch: \`${matches[0]}\` (only match for \`${typed}\`)`, "info");
			return matches[0];
		}
		candidates = matches.slice(0, BRANCH_LIST_LIMIT);
		title =
			matches.length > candidates.length
				? `Base branch — ${candidates.length} of ${matches.length} matching \`${typed}\`, newest first (Esc to refine)`
				: `Base branch — ${matches.length} matching \`${typed}\`, newest first`;
	} else {
		candidates = vcs
			.recentLocalBranches(ctx.cwd, BRANCH_LIST_LIMIT + 1)
			.filter((b) => b !== current)
			.slice(0, BRANCH_LIST_LIMIT);
		if (candidates.length === 0) {
			ctx.ui.notify("No other local branches found", "error");
			return undefined;
		}
		const total = vcs.localBranchCount(ctx.cwd);
		title =
			total > candidates.length + 1
				? `Base branch — ${candidates.length} most recent of ${total} (Esc to type a name or filter)`
				: "Select base branch to compare against";
	}

	const picked = await ctx.ui.select(title, candidates);
	return picked ?? undefined;
}

/**
 * State which paths could NOT be reviewed, whatever the reason.
 *
 * Note what this is NOT about: new files. This port stages the whole worktree
 * into a throwaway index (see vcs.netWorktreeDiff), so untracked files ARE in
 * the diff and ARE reviewed — a deliberate deviation from upstream, whose diff
 * covers staged + unstaged only.
 *
 * What lands here is the genuinely unreviewable residue, from `coverageGaps`:
 * binaries and other paths git will not produce a text hunk for, plus paths
 * git reports as changed that upstream's header regex cannot parse. Those are
 * in the file table but no reviewer can read them, so the omission has to be
 * said out loud instead of counted as covered.
 *
 * This has to be independent of tracked dirtiness. A tree whose ONLY change is
 * an unreviewable path has zero ordinary edits to report, so gating the notice
 * on "is the tree dirty" would hide exactly the case where the gap is total.
 */
function untrackedSuffix(untracked: readonly string[]): string {
	if (untracked.length === 0) return "";
	// JSON.stringify, not raw: git filenames are arbitrary bytes and may contain
	// newlines or control characters that would garble the notification.
	const shown = untracked.slice(0, 5).map((p) => JSON.stringify(p)).join(", ");
	const more = untracked.length > 5 ? ` (+${untracked.length - 5} more)` : "";
	return ` ${untracked.length} file(s) could NOT be included: ${shown}${more}.`;
}

/** Emit the combined "what was included / what was left out" notice. */
function notifyScope(ctx: ExtensionCommandContext, included: string, untracked: readonly string[]): void {
	const suffix = untrackedSuffix(untracked);
	const message = `${included}${suffix}`.trim();
	if (!message) return;
	ctx.ui.notify(message, suffix ? "warning" : "info");
}

/**
 * Paths present in the change that no reviewer will actually read.
 *
 * Two sources, both of which would otherwise be silent:
 *   - files with no reviewable hunk (binaries), and
 *   - files git reports as changed that the diff parser could not surface at
 *     all. Upstream's header regex does not match git's quoted form for names
 *     containing newlines/quotes, so such a file is dropped from the table, the
 *     stats and the diff. Reconciling against git's own path list makes that a
 *     declared gap instead of a disappearance.
 */
function coverageGaps(diffText: string, changedPaths: readonly string[] = []): string[] {
	if (!diffText.trim()) return [...changedPaths];
	const stats = parseDiff(diffText);
	const surfaced = new Set([...stats.files.map((f) => f.path), ...stats.excluded.map((e) => e.path)]);
	const unparsed = changedPaths.filter((path) => !surfaced.has(path));
	return [...unreviewablePaths(stats), ...unparsed];
}

/**
 * Report a blocking outcome the same way whether or not there is a UI.
 *
 * Blocking is not the same as broken, so severity is a parameter. "No reviewable
 * changes between X and Y" stops the command but is a perfectly ordinary answer,
 * and reporting it in red trains users to ignore red. Genuine failures — a fetch
 * that died, a malformed config, not a repository — keep the default.
 */
function block(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	message: string,
	severity: "error" | "warning" = "error",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, severity);
	else pi.sendUserMessage(`# /review blocked\n\n${message}`);
}

/**
 * Upstream's buildReviewPromptFromDiff: empty diff and fully-filtered diff are
 * distinct warnings, and neither produces a prompt.
 *
 * Reports through `block`, not `ctx.ui.notify`, because one caller runs before
 * the headless branch — see prReviewPrompt. A `hasUI`-only warning there meant a
 * headless `/review <pr-url>` on an empty or fully-filtered diff returned
 * undefined, sent nothing, and produced no output whatsoever.
 */
function promptFromDiff(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	panel: PanelContext,
	mode: string,
	diffText: string,
	extraInstructions: string | undefined,
	emptyMessage: string,
	options: {
		diffInstruction?: string;
		filteredMessage?: string;
		contextInstruction?: string;
		/** Untracked paths excluded from `diffText`, disclosed in the prompt. */
		untracked?: readonly string[];
		variant: ReviewVariant;
	},
): string | undefined {
	// "warning": nothing to review is an answer, not a malfunction. Upstream and
	// this port's earlier UI-only code both reported these at warning severity.
	if (!diffText.trim()) {
		block(pi, ctx, emptyMessage, "warning");
		return undefined;
	}

	const stats: DiffStats = parseDiff(diffText);
	if (stats.files.length === 0) {
		block(pi, ctx, options.filteredMessage ?? "No reviewable files (all changes filtered out)", "warning");
		return undefined;
	}

	return buildReviewPrompt(mode, stats, diffText, panel, {
		additionalInstructions: extraInstructions,
		diffInstruction: options.diffInstruction,
		contextInstruction: options.contextInstruction,
		untracked: options.untracked,
		variant: options.variant,
	});
}

/**
 * PR review. Reachable headlessly: the PR short-circuit in the handler runs
 * BEFORE the `!ctx.hasUI` branch, so this must never fail silently. It used to —
 * a headless `/review <pr-url>` with no `gh` auth, no network, or a private repo
 * returned undefined and the command emitted nothing at all, leaving only gh's
 * raw stderr on the terminal. Upstream returned the failure text.
 */
function prReviewPrompt(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	panel: PanelContext,
	ref: ReviewPrRef,
	extraInstructions: string,
	variant: ReviewVariant,
): string | undefined {
	let diffText: string;
	try {
		diffText = vcs.fetchPrDiff(ctx.cwd, ref.repo, ref.number);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		block(pi, ctx, `Failed to fetch PR diff for ${ref.repo}#${ref.number}: ${message}`);
		return undefined;
	}

	return promptFromDiff(
		pi,
		ctx,
		panel,
		`PR ${ref.repo}#${ref.number}`,
		diffText,
		extraInstructions || undefined,
		`PR ${ref.repo}#${ref.number} has no diff content available`,
		{
			diffInstruction: buildPrLargeDiffInstruction(ref),
			contextInstruction: buildPrContextInstruction(ref),
			variant,
		},
	);
}

/** /review config — edit the panel rules. */
async function runConfigSubcommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const load = loadPanelConfig();

	// Prefill with the user's OWN saved text when a file exists — even broken
	// text, because that is the text they need to fix in front of them.
	// Serializing defaults back over a broken file would discard their rules
	// along with their typo.
	let currentText: string;
	if (load.status === "default") {
		currentText = JSON.stringify(load.config, null, "\t");
	} else {
		try {
			currentText = readFileSync(panelConfigPath(), "utf8");
		} catch {
			currentText = JSON.stringify(DEFAULT_CONFIG, null, "\t");
		}
	}

	// Every field, with its cost implication. Cost is the constraint that decides
	// this config: run count is `shardDepth x families`, roughly doubled again by
	// crossCheck, and users range from monthly limits in the hundreds to the tens
	// of thousands. Naming a field that the parser rejects — as this help did
	// while it still said "familyCount" — is worse than saying nothing.
	const FIELD_HELP = [
		"- **`families`** (1-8) — how many distinct model families review EACH shard. This multiplies your run count. `1` is upstream/omp exactly, and the cheapest option.",
		'- **`shardDepth`** (`"auto"` or 1-32) — how finely to split the files. `"auto"` is upstream\'s diff-weight heuristic (1 to 16 by size). More shards means more runs, but each reviewer reads less.',
		"- **`crossCheck`** (true/false) — a second pass where seats re-examine each other's findings against the code. Roughly DOUBLES invocations. Needs `families` of 2 or more. Upstream has no second pass.",
		"- **`confirmAboveRuns`** (1-256) — the cost guard: above this many runs, /review states the arithmetic and asks first. Applies only once you opt into extra families or crossCheck; a default upstream-shaped run never pauses.",
		'- **`exclude`** — globs against `<provider>/<model-id>` (or a bare provider name), e.g. `"ai-gw-baseten/*"`. Use it to keep expensive routes out of the candidate pool.',
		"",
		"Total model invocations = `shardDepth` x `families`, doubled again when `crossCheck` is on (each seat is resumed once). `confirmAboveRuns` is compared against that doubled figure, not the seat count. `/review-multi-modal` ignores this file's N/K and instead seats every reachable family plus persona seats, so it is the expensive one — it respects `confirmAboveRuns` and `exclude`.",
	].join("\n");

	if (!ctx.hasUI) {
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
				...(load.status === "error" ? [`The saved config is invalid and BLOCKS the review: ${load.error}`, ""] : []),
				FIELD_HELP,
			].join("\n"),
		);
		return;
	}

	const edited = await ctx.ui.editor(
		load.status === "error"
			? `Panel rules — the SAVED config is broken and blocks the review; fix it below (or delete the file for the defaults)\n${load.error}`
			: [
					"Panel rules. Defaults are upstream/omp exactly: one model, one pass, upstream's shard count.",
					"families = models per shard (multiplies runs; 1 = omp). shardDepth = \"auto\" or a number (how finely to split files).",
					"crossCheck = second pass (doubles invocations, needs families >= 2). confirmAboveRuns = ask before spending more than N invocations.",
					"exclude = globs to keep routes out of the pool. Invocations = shardDepth x families, x2 with crossCheck. Delete the file to return to the defaults.",
				].join("\n"),
		currentText,
	);
	if (!edited?.trim()) return;

	const parsed = parsePanelConfig(edited);
	if (parsed.error) {
		ctx.ui.notify(`Not saved — ${parsed.error}`, "error");
		return;
	}
	savePanelConfig(parsed.config!);
	ctx.ui.notify(`Saved panel rules to ${panelConfigPath()}`, "info");
}

export default function reviewExtension(pi: ExtensionAPI) {
	// Both commands share every step except which distribution section the prompt
	// renders: the menu, the diff snapshot, the size ceiling, the coverage
	// disclosures and the config are identical. Only the fan-out shape differs.
	const runReview = async (variant: ReviewVariant, args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const trimmed = args.trim();

			if (trimmed.toLowerCase() === "config" || trimmed.toLowerCase() === "models") {
				await runConfigSubcommand(pi, ctx);
				return;
			}

			// ── panel rules ────────────────────────────────────────────────────
			const load = loadPanelConfig();
			if (load.status === "error") {
				block(pi, ctx, load.error!);
				return;
			}
			const config = load.config!;
			const modelsText = modelCandidatesText(ctx, config.exclude);
			if (!modelsText) {
				block(
					pi,
					ctx,
					"no models this session can actually reach (registry empty, unreadable, or everything excluded) — " +
						"the panel has no models to pick from. Fix the excludes with /review config.",
				);
				return;
			}
			const panel: PanelContext = {
				modelsText,
				families: config.families,
				shardDepth: config.shardDepth,
				crossCheck: config.crossCheck,
				confirmAboveRuns: config.confirmAboveRuns,
			};

			// ── argument parsing (upstream: extractReviewPrRefFromArgs) ────────
			const parsedArgs = extractReviewPrRefFromArgs(trimmed ? trimmed.split(/\s+/) : []);
			const extraInstructions = parsedArgs.extraInstructions.trim() || undefined;

			try {
				// A PR reference short-circuits the menu entirely, and does not
				// need a local repo.
				if (parsedArgs.prRef) {
					const promptText = prReviewPrompt(pi, ctx, panel, parsedArgs.prRef, parsedArgs.extraInstructions, variant);
					if (promptText) pi.sendUserMessage(promptText);
					return;
				}

				if (!ctx.hasUI) {
					pi.sendUserMessage(buildHeadlessReviewPrompt(panel, extraInstructions, variant));
					return;
				}

				// Everything below reviews local history, so require a repo and say
				// the actual thing instead of leaking raw git noise.
				if (!vcs.isGitRepo(ctx.cwd) && !vcs.isJjRepo(ctx.cwd)) {
					block(
						pi,
						ctx,
						"this isn't a git or jj repository — /review reviews local diffs, so run it from inside the repo whose changes you want reviewed (or pass a GitHub PR URL).",
					);
					return;
				}

				const choices: { label: string; value: ReviewMenuChoice }[] = [
					...findRecentPrRefs(ctx.sessionManager.getBranch(), REVIEW_CONTEXT_PR_LIMIT).map((ref) => ({
						label: `Review PR ${ref.repo}#${ref.number} from conversation`,
						value: { kind: "detected-pr" as const, ref },
					})),
					{ label: "1. Review against a base branch (PR Style)", value: { kind: "base-branch" } },
					{ label: "2. Review uncommitted changes", value: { kind: "uncommitted" } },
					{ label: "3. Review a specific commit", value: { kind: "commit" } },
				];
				if (!extraInstructions) {
					choices.push({ label: "4. Custom review instructions", value: { kind: "custom" } });
				}

				const selected = await ctx.ui.select(
					"Review Mode",
					choices.map((c) => c.label),
				);
				if (!selected) return;
				const choice = choices.find((c) => c.label === selected)?.value;
				if (!choice) return;

				switch (choice.kind) {
					case "detected-pr": {
						const promptText = prReviewPrompt(pi, ctx, panel, choice.ref, extraInstructions ?? "", variant);
						if (promptText) pi.sendUserMessage(promptText);
						return;
					}

					case "base-branch": {
						const currentBranchName = vcs.currentBranch(ctx.cwd);

						const baseBranch = await pickBaseBranch(ctx, currentBranchName);
						if (!baseBranch) return;

						// PR-style means the merge base against the current branch, so
						// commits that exist only on the base are excluded. A null merge
						// base means unrelated histories: upstream stops here rather
						// than comparing unrelated trees tip-to-tip.
						const base = vcs.mergeBase(ctx.cwd, baseBranch, currentBranchName);
						if (!base) {
							ctx.ui.notify(`No common history between ${baseBranch} and ${currentBranchName}`, "error");
							return;
						}

						// ONE snapshot: parent -> working tree.
						//
						// One correct snapshot: base -> what is on disk. See
						// vcs.netWorktreeDiff for why `git diff <base>` is not usable here.
						const net = vcs.netWorktreeDiff(ctx.cwd, base);
						if (net.diff === undefined) {
							const message = vcs.diffTooLargeMessage(net.size, `\`${baseBranch}\`..\`${currentBranchName}\``);
							ctx.ui.notify(message ?? "That change is too large to review in one pass.", "error");
							return;
						}
						const diffText = net.diff;

						const status = vcs.workingTreeStatus(ctx.cwd);
						const dirtyCount = status.staged + status.unstaged + status.untracked;

						let mode = `Reviewing changes between \`${baseBranch}\` and \`${currentBranchName}\` (PR-style)`;
						const reproduce = vcs.reproduceSnapshotCommand(base);
						let diffInstruction = `MUST run \`${reproduce}\` once, listing every assigned file`;

						let included = "";
						if (dirtyCount > 0) {
							const parts = [
								status.staged > 0 ? `${status.staged} staged` : undefined,
								status.unstaged > 0 ? `${status.unstaged} unstaged` : undefined,
								status.untracked > 0 ? `${status.untracked} new` : undefined,
							].filter(Boolean);
							included = `Reviewing the net working-tree state (${parts.join(", ")}).`;
							mode =
								`Reviewing \`${currentBranchName}\` against \`${baseBranch}\`: the net state of the working tree, ` +
								`including ${parts.join(", ")} uncommitted change(s). Committed work that has since been ` +
								`changed or reverted in the tree does NOT appear here — this is the code as it stands now.`;
							diffInstruction =
								`MUST reproduce the reviewed snapshot with \`${reproduce}\` — one invocation listing ALL ` +
								`your assigned paths (read-only: it writes a throwaway index, never the real one). That ` +
								`is the exact base-to-working-tree state these stats came from. Do NOT use plain ` +
								`\`git diff ${base} -- <path>\`: it is index-aware, so it reports a \`git rm --cached\`ed ` +
								`file as deleted and omits new files entirely. Do NOT diff ` +
								`\`${base}..${currentBranchName}\`, which reintroduces committed hunks since changed. ` +
								`If a rename's other half is not among your paths, git will show your side as a bare ` +
								`add or delete — that is an artefact of path filtering, not a defect to report.`;
						}

						const gaps = coverageGaps(diffText, net.changedPaths);
						notifyScope(ctx, included, gaps);

						const promptText = promptFromDiff(
							pi,
							ctx,
							panel,
							mode,
							diffText,
							extraInstructions,
							`No reviewable changes between ${baseBranch} and ${currentBranchName}`,
							{ diffInstruction, untracked: gaps, variant },
						);
						if (promptText) pi.sendUserMessage(promptText);
						return;
					}

					case "uncommitted": {
						const reviewDiff = vcs.uncommittedDiff(ctx.cwd);
						if (reviewDiff.tooLarge) {
							const message = vcs.diffTooLargeMessage(reviewDiff.size, "Your uncommitted changes");
							ctx.ui.notify(message ?? "That change is too large to review in one pass.", "error");
							return;
						}

						// New files ARE included here (the worktree is staged into a temp
						// index), so what this reports is the unreviewable residue: binaries
						// and paths the diff parser cannot surface. Say so rather than
						// letting them read as covered.
						const uncommittedGaps = coverageGaps(reviewDiff.diffText, reviewDiff.changedPaths);
						notifyScope(ctx, "", uncommittedGaps);

						const promptText = promptFromDiff(
							pi,
							ctx,
							panel,
							reviewDiff.mode,
							reviewDiff.diffText,
							extraInstructions,
							reviewDiff.emptyMessage,
							{ diffInstruction: reviewDiff.diffInstruction, untracked: uncommittedGaps, variant },
						);
						if (promptText) pi.sendUserMessage(promptText);
						return;
					}

					case "commit": {
						const commits = vcs.recentCommits(ctx.cwd, 20);
						if (commits.length === 0) {
							ctx.ui.notify("No commits found", "error");
							return;
						}
						const selectedCommit = await ctx.ui.select("Select commit to review", commits);
						if (!selectedCommit) return;

						const hash = selectedCommit.split(" ")[0];
						if (tooLarge(ctx, ["show", "--format=", hash], `Commit \`${hash}\``)) return;

						const diffText = vcs.showCommit(ctx.cwd, hash);
						const promptText = promptFromDiff(
							pi,
							ctx,
							panel,
							`Reviewing commit \`${hash}\``,
							diffText,
							extraInstructions,
							"Commit has no diff content",
							{
								diffInstruction: `MUST run \`git show ${hash} -- <path>\` for assigned files`,
								filteredMessage: "No reviewable files in commit (all changes filtered out)",
								variant,
							},
						);
						if (promptText) pi.sendUserMessage(promptText);
						return;
					}

					case "custom": {
						const instructions = await ctx.ui.editor("Enter custom review instructions", "Review the following:\n\n");
						if (!instructions?.trim()) return;

						// Upstream attaches the working-copy diff when there is one, so a
						// custom request still gets concrete changes to look at, and only
						// falls back to the instructions-only template when the tree is
						// clean.
						let reviewDiff: vcs.UncommittedDiff | undefined;
						try {
							reviewDiff = vcs.uncommittedDiff(ctx.cwd);
						} catch {
							reviewDiff = undefined;
						}

						const customGaps = reviewDiff ? coverageGaps(reviewDiff.diffText, reviewDiff.changedPaths) : [];
						if (reviewDiff) notifyScope(ctx, "", customGaps);

						if (reviewDiff?.diffText.trim()) {
							const stats = parseDiff(reviewDiff.diffText);
							if (stats.files.length > 0) {
								pi.sendUserMessage(
									buildReviewPrompt(
										`Custom review: ${instructions.split("\n")[0].slice(0, 60)}…`,
										stats,
										reviewDiff.diffText,
										panel,
										{
											additionalInstructions: instructions,
											diffInstruction: reviewDiff.diffInstruction,
											untracked: customGaps,
											variant,
										},
									),
								);
								return;
							}
						}

						pi.sendUserMessage(buildCustomReviewPrompt(instructions, panel, customGaps, variant));
						return;
					}
				}
			} catch (err) {
				// An override that can no longer find its anchor is a packaging bug,
				// not a user error: say so precisely rather than surfacing a stack.
				if (err instanceof OverrideError) {
					block(pi, ctx, `prompt override failed: ${err.message}`);
					return;
				}
				if (err instanceof vcs.VcsError) {
					block(pi, ctx, `Git command failed: ${err.message}`);
					return;
				}
				throw err;
			}
	};

	pi.registerCommand("review", {
		description:
			"Code review, upstream's way by default: files split by diff weight across reviewer subagents, one model, one pass (/review config to add model families)",
		handler: (args: string, ctx: ExtensionCommandContext) => runReview("sharded", args, ctx),
	});

	pi.registerCommand("review-multi-modal", {
		description:
			"Multi-model panel review: every reachable model family reviews the whole diff, plus persona seats on the cheap families, synthesised into one verdict",
		handler: (args: string, ctx: ExtensionCommandContext) => runReview("panel", args, ctx),
	});
}
