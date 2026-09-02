/**
 * Panel rules + per-session model discovery — the original part of this
 * package (upstream has no notion of picking models).
 *
 * Nothing here names a model. The candidate list is read fresh from the
 * session's own registry at review time, auth-filtered, because hardcoded
 * model names go stale and travel badly between machines. The prompt then asks
 * for K distinct model FAMILIES out of that list.
 *
 * Rules live at ~/.pi/agent/multi-model-review/config.json and are just:
 * how many families per shard, a ceiling on total reviewer runs, and excludes
 * that shrink the discovery pool. No file means the defaults below. Once a file
 * exists it IS the rules: anything wrong with it blocks the review with an
 * actionable error rather than silently launching a different panel, because a
 * saved exclude can encode cost or policy intent.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type ShardDepth = "auto" | number;

export interface PanelConfig {
	/** K — distinct model families per shard. 1 is upstream: a single model. */
	families: number;
	/** N — "auto" uses upstream's diff-weight heuristic; a number overrides it. */
	shardDepth: ShardDepth;
	/** Second pass where seats cross-examine each other. Upstream has none. */
	crossCheck: boolean;
	/** Above this many total reviewer runs, confirm with the user before launching. */
	confirmAboveRuns: number;
	/** Globs matched against `<provider>/<model-id>` (or a bare provider name). */
	exclude: string[];
}

/**
 * Defaults are EXACTLY upstream's `/review`: one model, upstream's own shard
 * count, one pass. Nothing about the default run is this package's invention.
 *
 * The multi-model panel is opt-in — raise `families`, or switch on `crossCheck`,
 * or use `/review-multi-modal` for the full persona panel. That ordering is
 * deliberate: a port whose default behaviour differs from the thing it ports is
 * not really a port, and "faithful unless you ask otherwise" is a promise that
 * can be kept.
 */
export const DEFAULT_CONFIG: PanelConfig = {
	families: 1,
	shardDepth: "auto",
	crossCheck: false,
	confirmAboveRuns: 12,
	exclude: [],
};

export function panelConfigPath(): string {
	return join(homedir(), ".pi", "agent", "multi-model-review", "config.json");
}

function fail(message: string): { error: string } {
	return { error: message };
}

/** Renamed fields, so an old config fails loudly instead of silently meaning something else. */
const RENAMED: Record<string, string> = {
	familyCount: "families",
	maxChildren: "confirmAboveRuns",
};

/** Strict parse. Any structural problem is an error naming the offending field. */
export function parsePanelConfig(raw: string): { config?: PanelConfig; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return fail(`not valid JSON: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return fail(`must be a JSON object with "families", "shardDepth", "crossCheck" and "exclude"`);
	}
	const obj = parsed as Record<string, unknown>;

	// Old persona-panel configs would otherwise validate as "no recognised keys"
	// and silently get defaults, spending a different panel than was written down.
	if ("seats" in obj) {
		return fail(
			`this is an old persona-panel config ("seats"). /review now runs upstream's single reviewer; the persona panel ` +
				`moved to /review-multi-modal, which needs no config. Replace this file with ` +
				`{ "families": 1, "shardDepth": "auto", "crossCheck": false } or delete it for the defaults.`,
		);
	}
	for (const [old, now] of Object.entries(RENAMED)) {
		if (old in obj) return fail(`"${old}" was renamed to "${now}". Update the field name.`);
	}

	const config: PanelConfig = { ...DEFAULT_CONFIG, exclude: [] };

	if (obj.families !== undefined) {
		if (typeof obj.families !== "number" || !Number.isInteger(obj.families)) {
			return fail(`"families" must be an integer (distinct model families per shard; 1 = upstream)`);
		}
		if (obj.families < 1 || obj.families > 8) return fail(`"families" must be between 1 and 8 — got ${obj.families}`);
		config.families = obj.families;
	}

	if (obj.shardDepth !== undefined) {
		if (obj.shardDepth === "auto") {
			config.shardDepth = "auto";
		} else if (typeof obj.shardDepth === "number" && Number.isInteger(obj.shardDepth)) {
			if (obj.shardDepth < 1 || obj.shardDepth > 32) {
				return fail(`"shardDepth" must be between 1 and 32, or "auto" — got ${obj.shardDepth}`);
			}
			config.shardDepth = obj.shardDepth;
		} else {
			return fail(`"shardDepth" must be "auto" (upstream's diff-weight heuristic) or an integer`);
		}
	}

	if (obj.crossCheck !== undefined) {
		if (typeof obj.crossCheck !== "boolean") return fail(`"crossCheck" must be true or false`);
		config.crossCheck = obj.crossCheck;
	}

	if (obj.confirmAboveRuns !== undefined) {
		if (typeof obj.confirmAboveRuns !== "number" || !Number.isInteger(obj.confirmAboveRuns)) {
			return fail(`"confirmAboveRuns" must be an integer (total runs above which to confirm first)`);
		}
		if (obj.confirmAboveRuns < 1 || obj.confirmAboveRuns > 256) {
			return fail(`"confirmAboveRuns" must be between 1 and 256 — got ${obj.confirmAboveRuns}`);
		}
		config.confirmAboveRuns = obj.confirmAboveRuns;
	}

	if (obj.crossCheck === true && config.families < 2) {
		return fail(
			`"crossCheck" needs at least 2 families — with one family there are no peers to cross-examine. ` +
				`Raise "families", or leave crossCheck off (upstream has no second pass).`,
		);
	}

	if (obj.exclude !== undefined) {
		if (!Array.isArray(obj.exclude)) return fail(`"exclude" must be an array of glob strings`);
		for (const e of obj.exclude) {
			if (typeof e !== "string" || !e.trim()) return fail(`"exclude" contains a non-string or empty entry`);
			config.exclude.push(e.trim());
		}
	}

	return { config };
}

/**
 * Load the rules. Only "file doesn't exist" yields defaults; anything else
 * wrong with a SAVED config blocks, because a saved setting can encode cost or
 * policy intent and spending it differently is not this command's call.
 */
export function loadPanelConfig(): { status: "default" | "ok" | "error"; config?: PanelConfig; error?: string } {
	let raw: string;
	try {
		raw = readFileSync(panelConfigPath(), "utf8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return { status: "default", config: DEFAULT_CONFIG };
		return { status: "error", error: `cannot read ${panelConfigPath()}: ${(err as Error).message}` };
	}
	const parsed = parsePanelConfig(raw);
	if (parsed.error) {
		return {
			status: "error",
			error: `${panelConfigPath()}: ${parsed.error} Fix it with /review config, or delete the file to return to the defaults.`,
		};
	}
	return { status: "ok", config: parsed.config };
}

/** Atomic save: temp file in the same directory, then rename. */
export function savePanelConfig(config: PanelConfig): void {
	const dir = join(homedir(), ".pi", "agent", "multi-model-review");
	mkdirSync(dir, { recursive: true });
	const target = panelConfigPath();
	const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	renameSync(tmp, target);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Glob match for excludes: `*` matches any run of characters, everything else
 * is literal. Matched against `<provider>/<model-id>` and against the bare
 * provider name, so a provider name alone excludes that whole route.
 */
export function isExcluded(provider: string, id: string, exclude: string[]): boolean {
	const full = `${provider}/${id}`;
	return exclude.some((pattern) => {
		const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
		return re.test(full) || re.test(provider);
	});
}

/**
 * The models this session can actually reach, formatted for the prompt.
 *
 * Read fresh from the session's registry (or its scoped subset when the session
 * was started with model scoping), auth-filtered so the panel can never pick a
 * model this machine cannot call, then narrowed by the user's excludes.
 * Grouped by provider route for readability — but the prompt's rule is about
 * families, and two routes to one family count once.
 */
export function modelCandidatesText(ctx: ExtensionCommandContext, exclude: string[]): string {
	try {
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
		return [...byProvider].map(([provider, refs]) => `- ${provider}: ${refs.join(", ")}`).join("\n");
	} catch {
		// A registry this extension API cannot read must not kill the review;
		// the caller blocks with an explicit message instead.
		return "";
	}
}
