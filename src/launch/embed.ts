/**
 * Turn a type-checked launch function into the script text a prompt embeds.
 *
 * The scripts in this directory are real code: `tsc` checks them and the test
 * suite executes them against a fake `runs`. The prompt needs them as text, so
 * rather than keeping a second hand-maintained copy in markdown (which is how
 * the survivor-filter and pass-2 bugs shipped), the text is derived from the
 * checked source at render time.
 *
 * Each script marks its emitted region with sentinels and keeps the logic free
 * of type annotations, so the extracted region is valid JavaScript for the
 * workflowScript sandbox. The declaration the model fills in is supplied
 * separately as a placeholder, because it carries no logic to check.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCH_DIR = dirname(fileURLToPath(import.meta.url));

const BEGIN = "// >>> script";
const END = "// <<< script";

export class EmbedError extends Error {}

/** Strip the common leading indentation so the region reads as top-level code. */
function dedent(lines: string[]): string[] {
	const indents = lines.filter((l) => l.trim().length > 0).map((l) => /^[\t ]*/.exec(l)?.[0].length ?? 0);
	const common = indents.length > 0 ? Math.min(...indents) : 0;
	return lines.map((l) => l.slice(common));
}

/**
 * Read the emitted region out of a launch module.
 *
 * Throws rather than returning a partial script: a silently empty launch section
 * would tell the orchestrator to fan out with no code at all.
 */
export function scriptBody(moduleFile: string): string {
	const source = readFileSync(join(LAUNCH_DIR, moduleFile), "utf8");
	const start = source.indexOf(BEGIN);
	const end = source.indexOf(END);
	if (start < 0 || end < 0 || end < start) {
		throw new EmbedError(`${moduleFile}: missing or inverted ${BEGIN} / ${END} sentinels`);
	}
	const between = source.slice(source.indexOf("\n", start) + 1, end);
	const body = dedent(between.replace(/\n[\t ]*$/, "").split("\n")).join("\n");
	if (body.trim().length === 0) throw new EmbedError(`${moduleFile}: emitted region is empty`);
	// A type annotation would not parse in the JS sandbox. Cheap smoke check for
	// the shapes most likely to slip in.
	if (/:\s*(?:RunResult|Seat|Shard|PanelSeat|WorkflowRuns|string|number|boolean)\b/.test(body)) {
		throw new EmbedError(`${moduleFile}: emitted region contains a type annotation, which is not valid JavaScript`);
	}
	return body;
}

/** Placeholder declaration + checked logic, ready to paste into a code fence. */
export function launchScript(moduleFile: string, placeholder: string): string {
	return `${placeholder.trimEnd()}\n\n${scriptBody(moduleFile)}`;
}
