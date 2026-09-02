/**
 * Upstream's shape: one model, files split by weight, one pass.
 *
 * The sentinel region is the ONLY copy of the logic. It is what `tsc` checks,
 * what the suite compiles and executes, and what the prompt embeds. PLACEHOLDER
 * carries the data declaration the orchestrator fills in and nothing else \u2014 no
 * helpers, no task construction \u2014 because a second executable copy there could
 * drift from the tested one without any test noticing.
 */
import { launchScript } from "./embed.ts";
import type { Shard, WorkflowRuns } from "./types.ts";

/** Data only. Illustrative, so there is no logic here to check or execute. */
const PLACEHOLDER = `// runs.all resolves to a plain ARRAY in input order — items have .key, .output,
// .runId. It is NEVER keyed by run key.
const shards = [
  // { key: "s1", files: ["src/a.ts"], diff: "<hunks for those files, or the documented fetch command>" },
];`;

export async function run(
	runs: WorkflowRuns,
	shards: Shard[],
): Promise<{ reviews: { shard: string; output: string }[]; failed: { shard: string; error: string | null }[] }> {
	// >>> script
	// A fresh subagent CANNOT see this prompt. Everything it needs goes in its
	// task text: the scope, its files, and the diff content for those files.
	const results = await runs.all(
		shards.map((s) => ({
			key: s.key,
			agent: "omp-reviewer",
			task: `...review scope and focus from above...\nYour files: ${s.files.join(", ")}\n${s.diff}`,
		})),
	);
	// `ok` is the success flag, not `runId`: a shard that started and then failed
	// still HAS a runId (it stays resumable), so filtering on runId reports its
	// error receipt as a review and leaves `failed` empty.
	return {
		reviews: results.filter((r) => r.ok).map((r) => ({ shard: r.key, output: r.output })),
		failed: results.filter((r) => !r.ok).map((r) => ({ shard: r.key, error: r.error ?? null })),
	};
	// <<< script
}

/** Script text for the prompt: data placeholder + the checked logic. */
export function script(): string {
	return launchScript("upstream-shard.ts", PLACEHOLDER);
}
