/**
 * Multimodal panel: every family sees the whole diff, one pass, plus persona
 * seats on the cheap families.
 */
import { launchScript } from "./embed.ts";
import type { PanelSeat, WorkflowRuns } from "./types.ts";

const PLACEHOLDER = `// runs.all resolves to a plain ARRAY in input order — each item has .key,
// .output, .runId. It is NEVER keyed by run key.
const seats = [
  // one per family:
  // { key: "claude", agent: "reviewer-primary", model: "<provider/id>" },
  // { key: "gpt",    agent: "reviewer-primary", model: "<provider/id>" },
  // ...then extra personas on the cheap families:
  // { key: "linus-cheap",      agent: "reviewer-linus",      model: "<cheap provider/id>" },
  // { key: "danluu-cheap",     agent: "reviewer-danluu",     model: "<cheap provider/id>" },
  // { key: "antagonist-cheap", agent: "reviewer-antagonist", model: "<cheap provider/id>" },
];

// Every seat gets the SAME task: the whole scope and the whole diff. A fresh
// subagent sees only its own task text, not this prompt, so the diff (or the
// documented command to fetch it) must be pasted into the task itself.
const task = \`...review scope and focus from above, then the full diff or the documented fetch command...\`;`;

export async function run(
	runs: WorkflowRuns,
	seats: PanelSeat[],
	task: string,
): Promise<{ reviews: { seat: string; output: string }[]; failed: { seat: string; error: string | null }[] }> {
	// >>> script
	const results = await runs.all(seats.map((s) => ({ key: s.key, agent: s.agent, model: s.model, task })));

	// `ok` is the success flag, not `runId`. A seat that started and then failed
	// still HAS a runId (it stays resumable), so filtering on runId would report
	// its error receipt as a review and leave `failed` empty — claiming coverage
	// for code nobody read.
	return {
		reviews: results.filter((r) => r.ok).map((r) => ({ seat: r.key, output: r.output })),
		failed: results.filter((r) => !r.ok).map((r) => ({ seat: r.key, error: r.error ?? null })),
	};
	// <<< script
}

export function script(): string {
	return launchScript("panel-multimodal.ts", PLACEHOLDER);
}

