/**
 * The workflowScript environment, typed.
 *
 * These declarations exist so the launch scripts in this directory are REAL
 * type-checked code instead of prose. The scripts used to live as JavaScript
 * inside markdown code fences, where nothing compiled them, nothing executed
 * them, and tests could only grep them for substrings. Three shipped bugs came
 * from exactly that: a survivor filter that tested `runId` (which a failed child
 * keeps, because it stays resumable) instead of `ok`, an unfiltered pass-2 map
 * that presented a failed cross-check's error receipt as a reconsidered review,
 * and cross-check instructions rendered for single-pass runs.
 *
 * Mirrors `WorkflowScriptChildResult` in pi-subagents
 * (src/workflows/scripted-workflow.ts). `runs.all` is launched with
 * `collectFailure: true`, so a failed child RESOLVES with `ok: false` rather
 * than rejecting — which is why `ok` is the success signal and `runId` is not.
 */

/** One child's result. `ok` is the success flag; `runId` survives failure. */
export interface RunResult {
	key: string;
	/** True only when the child completed successfully. THE success signal. */
	ok: boolean;
	/** The child's final message. An error receipt when `ok` is false. */
	output: string;
	/** Present whenever the child started, failed or not: it stays resumable. */
	runId?: string;
	error?: string | null;
}

/** A child to launch. */
export interface RunSpec {
	key: string;
	agent?: string;
	model?: string;
	task?: string;
	/** Resume an existing run instead of starting a new one. */
	resume?: string;
}

/** The `runs` object available to a workflowScript. */
export interface WorkflowRuns {
	all(items: RunSpec[]): Promise<RunResult[]>;
}

/** A shard in the upstream-shaped (one model, files split by weight) flow. */
export interface Shard {
	key: string;
	files: string[];
	diff: string;
}

/** A seat in the panel flows: one (shard x model family) pair. */
export interface Seat {
	key: string;
	shardId: number;
	model: string;
	files: string[];
	diff: string;
}

/** A seat in the multimodal panel: whole diff, one agent persona per seat. */
export interface PanelSeat {
	key: string;
	agent: string;
	model: string;
}
