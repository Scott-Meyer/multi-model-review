#!/usr/bin/env node
/**
 * Deterministic handler harness for the /review command: mock pi + mock
 * ExtensionCommandContext, invoke the real registered handler, assert on the
 * emitted prompts/messages. No model calls, no subagents, no writes outside
 * an isolated HOME (set below — the harness refuses to run against a real
 * home dir, since /review config writes config files under ~/.pi).
 *
 * Run: npm test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME BEFORE importing the module (config paths derive from it).
process.env.HOME = mkdtempSync(join(tmpdir(), "mmr-handler-test-"));
const CONFIG_DIR = join(process.env.HOME, ".pi", "agent", "multi-model-review");
const CONFIG = join(CONFIG_DIR, "config.json");
if (!CONFIG_DIR.startsWith(tmpdir())) throw new Error("refusing: HOME not isolated");

const { default: mmrNS } = await import("../src/index.ts");
const mmr = mmrNS.default ?? mmrNS;

let command = null;
const sent = [];
const fakePi = {
	registerCommand: (name, def) => {
		command = { name, def };
	},
	sendUserMessage: (m) => sent.push(m),
};
mmr(fakePi);
if (!command || command.name !== "review") throw new Error("command not registered");

const MODELS = [
	{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", provider: "ai-gw-anthropic-1m" },
	{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5 200k", provider: "ai-gw-anthropic-200k" },
	{ id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "ai-gw-openai" },
	{ id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", provider: "ai-gw-google" },
	{ id: "baseten/zai-org/GLM-5.3", name: "GLM 5.3", provider: "ai-gw-baseten" },
	{ id: "bedrock/qwen3-coder-480b", name: "Qwen3 Coder", provider: "ai-gw-bedrock" },
];

const editorCalls = [];
const makeCtx = ({ available = MODELS, cwd = "/tmp/mmr-e2e" } = {}) => ({
	hasUI: false,
	cwd,
	ui: {
		notify: (m, s) => console.log(`  [notify:${s}] ${m.slice(0, 100)}`),
		editor: async (title, prefill) => {
			editorCalls.push({ title, prefill });
			return undefined;
		},
		select: async () => undefined,
		input: async () => undefined,
		confirm: async () => false,
	},
	scopedModels: [],
	modelRegistry: {
		getAvailable: () => available,
		hasConfiguredAuth: () => true,
	},
});

let failures = 0;
function expect(cond, label) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures++;
}

// ── 1. no config → smart default review prompt ─────────────────────────────
rmSync(CONFIG, { force: true });
sent.length = 0;
await command.def.handler("", makeCtx());
const p1 = sent[0] ?? "";
expect(p1.includes("Multi-model code review"), "1: prompt built");
expect(p1.includes("one model FAMILY per seat"), "1: family rule present");
expect(p1.includes("ai-gw-anthropic-1m/anthropic/claude-sonnet-5"), "1: candidates from registry");
expect(p1.includes("reviewer-primary"), "1: persona seats present");
expect(p1.includes("seatPlans"), "1: data-driven skeleton present");
expect(p1.includes("pass1Only: true"), "1: antagonist marked pass1Only");
expect(p1.includes('{ action: "list" }'), "1: agent preflight present");
expect(p1.includes("{ agent, model, task }"), "1: fallback recipe present");
expect(p1.includes('model: "<model from the list above>"'), "1: unpinned placeholders");
expect(!p1.includes("~/.pi/agent/models.json"), "1: no models.json detour");

// ── 2. /review config (non-UI) shows rules; default seats serialized ───────
sent.length = 0;
await command.def.handler("config", makeCtx());
expect((sent[0] ?? "").includes("panel rules live at"), "2: config path shown");
expect((sent[0] ?? "").includes("reviewer-antagonist"), "2: default seats serialized");

// ── 3. unreachable pin blocks ──────────────────────────────────────────────
mkdirSync(CONFIG_DIR, { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ seats: [{ key: "a", agent: "reviewer-primary" }, { key: "l", agent: "reviewer-linus", model: "nope/nope" }] }));
sent.length = 0;
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("/review blocked"), "3: unreachable pin blocks");
expect((sent[0] ?? "").includes("nope/nope"), "3: pin named in error");

// ── 4. malformed JSON blocks; config editor prefills the RAW broken text ───
writeFileSync(CONFIG, "{ seats: [");
sent.length = 0;
editorCalls.length = 0;
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("/review blocked"), "4a: malformed config blocks review");
sent.length = 0;
await command.def.handler("config", makeCtx());
// non-UI: the message shows the raw saved text, not the serialized default
expect((sent[0] ?? "").includes("{ seats: ["), "4b: raw broken text shown for repair");

// ── 5. custom seats: pins serialized, excludes honored, pass1Only counted ───
writeFileSync(
	CONFIG,
	JSON.stringify({
		seats: [
			{ key: "a", agent: "reviewer-primary" },
			{ key: "b", agent: "reviewer-danluu", model: "ai-gw-openai/openai/gpt-5.6-sol" },
			{ key: "x", agent: "reviewer-antagonist", pass1Only: true },
		],
		exclude: ["ai-gw-baseten/*", "ai-gw-anthropic-*"],
	}),
);
sent.length = 0;
await command.def.handler("", makeCtx());
const p5 = sent[0] ?? "";
expect(p5.includes("reviewer-danluu"), "5: custom seats honored");
expect(p5.includes('"ai-gw-openai/openai/gpt-5.6-sol"'), "5: pin serialized into seatPlans");
expect(!p5.includes("baseten"), "5: baseten excluded");
expect(!p5.includes("anthropic"), "5: anthropic routes excluded");
expect(p5.includes("Pinned seats"), "5: pinned-seat note");
expect(p5.split("pass1Only: true").length - 1 === 1, "5: one pass1Only seat");

// ── 6. bad seat-key charset blocks (pi-subagents run-key contract) ─────────
writeFileSync(CONFIG, JSON.stringify({ seats: [{ key: "bad key!", agent: "reviewer-primary" }] }));
sent.length = 0;
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("/review blocked"), "6a: bad key blocks");
expect((sent[0] ?? "").includes("run-key rule"), "6b: run-key rule named");

// ── 7. all-pass1Only config blocks (pass 2 would be empty) ─────────────────
writeFileSync(CONFIG, JSON.stringify({ seats: [{ key: "x", agent: "reviewer-antagonist", pass1Only: true }] }));
sent.length = 0;
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("no core seats"), "7: all-pass1Only blocks");

// ── 8. empty discovery pool + unpinned seats blocks (no models.json path) ───
rmSync(CONFIG, { force: true });
sent.length = 0;
await command.def.handler("", makeCtx({ available: [] }));
expect((sent[0] ?? "").includes("/review blocked"), "8a: empty pool blocks");
expect((sent[0] ?? "").includes("no discovery pool"), "8b: actionable message");

// ── 8c. empty pool + all seats pinned proceeds ──────────────────────────────
// the real scenario: the pinned model exists in the registry, but the user's
// excludes empty the candidate pool — all seats pinned, so no pool needed
writeFileSync(
	CONFIG,
	JSON.stringify({
		seats: [{ key: "a", agent: "reviewer-primary", model: "ai-gw-openai/openai/gpt-5.6-sol" }],
		exclude: ["ai-gw-openai/*"],
	}),
);
sent.length = 0;
await command.def.handler("", makeCtx());
expect((sent[0] ?? "").includes("Multi-model code review"), "8c: all-pinned runs without discovery pool");

// ── 9. not a git repo → friendly message, not raw git noise ────────────────
rmSync(CONFIG, { force: true });
sent.length = 0;
await command.def.handler("", makeCtx({ cwd: "/tmp" }));
expect((sent[0] ?? "").includes("isn't a git repository"), "9: friendly not-a-repo message");

// cleanup isolated HOME
rmSync(join(process.env.HOME, ".pi"), { recursive: true, force: true });
console.log(failures === 0 ? `\nall green — isolated HOME at ${process.env.HOME} removed` : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
