/**
 * Panel, two passes: independent review, then cross-examination within a shard.
 *
 * See panel-single-pass.ts for why the two flows are separate modules. As there,
 * PLACEHOLDER is data only. An earlier version put an executable `findRun` and
 * the task builders in the placeholder while `run()` used its own typed copies —
 * two implementations of the same helpers, only one of them tested. The lookup is
 * inlined below instead, so the emitted helper IS the executed helper.
 */
import { launchScript } from "./embed.ts";
import type { Seat, WorkflowRuns } from "./types.ts";

const PLACEHOLDER = `// runs.all resolves to a plain ARRAY in input order — each item an object with
// .key, .output, .runId. It is NEVER keyed by run key. Look results up by key.
//
// One entry per (shard x family). shardId is what groups peers for the
// cross-check: reviewers only cross-examine others who read the same files.
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
	pass1: { seat: string; shardId: number | null; output: string }[];
	pass2: { seat: string; output: string }[];
	uncrossChecked: { seat: string; shardId: number; output: string }[];
	failed: { seat: string; pass: number; error: string | null }[];
}> {
	// >>> script
	// A fresh subagent CANNOT see this prompt. Everything it needs goes in its
	// task text: the scope, its assigned files, and the actual diff content for
	// those files — pasted in when the diff appears above, or the exact command to
	// obtain it when the diff was omitted as too large.
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
	// review output.
	const done1 = pass1.filter((r) => r.ok);

	const pass2Items = [];
	const noCrossCheck = []; // seats with no surviving peer: still real review output
	for (const seat of seats) {
		const mine = done1.find((r) => r.key === `pass1-${seat.key}`);
		if (!mine) continue;
		const peers = seats
			.filter((p) => p.shardId === seat.shardId && p.key !== seat.key)
			.map((p) => done1.find((r) => r.key === `pass1-${p.key}`))
			.filter((r) => r !== undefined);
		if (peers.length === 0) {
			// Sole survivor of its shard (one family, or every peer failed). There is
			// nothing to cross-check against, but its pass-1 findings are the ONLY
			// coverage those files got — carry them into synthesis, never drop them.
			noCrossCheck.push({ seat: seat.key, shardId: seat.shardId, output: mine.output });
			continue;
		}
		const writeups = peers.map((r, i) => `--- Peer write-up ${i + 1} ---\n${r.output}`).join("\n\n");
		pass2Items.push({
			key: `pass2-${seat.key}`,
			resume: mine.runId,
			task: `...pass-2 cross-check task text as described below, with these write-ups pasted in:\n\n${writeups}`,
		});
	}

	const pass2 = pass2Items.length > 0 ? await runs.all(pass2Items) : [];

	return {
		// BOTH passes are returned on purpose. Pass 1 is the only UNCONTAMINATED
		// record: once a reviewer has read its peers' write-ups it can no longer be
		// used as an independent witness. The per-finding independent agreement
		// count must be computed from pass1, never from pass2.
		pass1: done1.map((r) => {
			const seat = seats.find((s) => `pass1-${s.key}` === r.key);
			return { seat: r.key, shardId: seat ? seat.shardId : null, output: r.output };
		}),
		// Filtered on ok, exactly like pass 1: a pass-2 child that failed still
		// returns an entry whose `output` is an error receipt. Mapping it unfiltered
		// would present that receipt to synthesis as a reconsidered review.
		pass2: pass2.filter((r) => r.ok).map((r) => ({ seat: r.key, output: r.output })),
		// Reviewed, but never cross-checked. Report as lower-confidence, not absent.
		uncrossChecked: noCrossCheck,
		// Tag which pass died, or a seat whose cross-check failed reads as fully
		// cross-checked.
		failed: [
			...pass1.filter((r) => !r.ok).map((r) => ({ seat: r.key, pass: 1, error: r.error ?? null })),
			...pass2.filter((r) => !r.ok).map((r) => ({ seat: r.key, pass: 2, error: r.error ?? null })),
		],
	};
	// <<< script
}

export function script(): string {
	return launchScript("panel-cross-check.ts", PLACEHOLDER);
}
