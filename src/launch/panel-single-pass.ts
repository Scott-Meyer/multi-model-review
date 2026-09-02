/**
 * Panel, one pass: every (shard x model family) seat reviews independently.
 *
 * Separate module from panel-cross-check.ts rather than one templated file with
 * `{{#if crossCheck}}` branches. Interleaving the two flows in markdown produced
 * instructions promising a second pass on runs that only had one, and a
 * `shardId` comment explaining cross-check grouping in a single-pass render.
 *
 * As in the sibling modules, PLACEHOLDER is data only: the logic lives once, in
 * the sentinel region that is checked, executed and embedded.
 */
import { launchScript } from "./embed.ts";
import type { Seat, WorkflowRuns } from "./types.ts";

const PLACEHOLDER = `// runs.all resolves to a plain ARRAY in input order — each item an object with
// .key, .output, .runId. It is NEVER keyed by run key. Look results up by key.
//
// One entry per (shard x family). shardId records which files a seat read; it is
// reported with each review so synthesis can compute per-shard agreement
// denominators.
const seats = [
  // { key: "s1-claude", shardId: 1, model: "<provider/id from the list above>",
  //   files: ["src/a.ts", "src/b.ts"],
  //   diff: "<the diff hunks for THOSE files, verbatim — or the documented command to fetch them>" },
  // ...one entry per shard x family. Seats in the same shard share files and diff,
  // and differ only in key and model.
];`;

export async function run(
	runs: WorkflowRuns,
	seats: Seat[],
): Promise<{
	reviews: { seat: string; shardId: number | null; output: string }[];
	failed: { seat: string; error: string | null }[];
}> {
	// >>> script
	// A fresh subagent CANNOT see this prompt. Everything it needs goes in its
	// task text: the scope, its assigned files, and the actual diff content for
	// those files — pasted in when the diff appears above, or the exact command to
	// obtain it when the diff was omitted as too large. A reviewer told to "use
	// the hunks below" with no hunks attached, and forbidden from re-running git,
	// has nothing to review.
	const pass1 = await runs.all(
		seats.map((s) => ({
			key: `pass1-${s.key}`,
			agent: "omp-reviewer",
			model: s.model,
			task: `...review scope and focus from above...\nYour assigned files: ${s.files.join(", ")}\n${s.diff}`,
		})),
	);

	// A seat that failed (transient model error, rate limit, bad route) has
	// ok:false. Test `ok`, never `runId` — a failed seat KEEPS its runId so it
	// stays resumable, so filtering on runId would treat an error receipt as
	// review output and report coverage for files nobody read.
	const done1 = pass1.filter((r) => r.ok);

	// Single pass: no seat reads another's write-up, so these findings are
	// independent by construction and their agreement counts need no caveat.
	return {
		reviews: done1.map((r) => {
			const seat = seats.find((s) => `pass1-${s.key}` === r.key);
			return { seat: r.key, shardId: seat ? seat.shardId : null, output: r.output };
		}),
		failed: pass1.filter((r) => !r.ok).map((r) => ({ seat: r.key, error: r.error ?? null })),
	};
	// <<< script
}

export function script(): string {
	return launchScript("panel-single-pass.ts", PLACEHOLDER);
}
