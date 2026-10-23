/**
 * Context layer, pure parts: deterministic filter, judge policy, placeholders,
 * forged-tag stripping, expansion views, scheduler priority.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, parseDuration } from "../src/config.ts";
import type { OutputMeta } from "../src/outputs.ts";
import { argsSignature, fmtTokens, summarizeArgs } from "../src/outputs.ts";
import {
	type CallInfo,
	decideDrop,
	fallbackSummary,
	filterOutputs,
	parseFacts,
	readDropSignals,
	renderPlaceholder,
	stripForged,
	stripPathNotes,
	viewOriginal,
} from "../src/policy.ts";
import { JudgeScheduler } from "../src/scheduler.ts";

const cfg = DEFAULT_SETTINGS.context;

function meta(ord: number, tool: string, input: Record<string, unknown>, o: Partial<OutputMeta> = {}): OutputMeta {
	return {
		id: `c${ord}`,
		ord,
		tool,
		args: summarizeArgs(input, "/p"),
		sig: argsSignature(tool, input),
		tokens: 3000,
		turn: ord,
		isError: false,
		paths: typeof input.path === "string" ? [`/p/${input.path}`] : [],
		mtimes: {},
		noteIds: [],
		file: `/tmp/none-${ord}`,
		capturedAt: 0,
		...o,
	};
}

function callOf(m: OutputMeta, input: Record<string, unknown>, seq: number, isError = false): CallInfo {
	return { id: m.id, tool: m.tool, input, turn: m.turn, seq, isError, paths: m.paths, sig: m.sig };
}

test("filter: re-read, re-edit, duplicates and protections", () => {
	const ins = [
		{ path: "a.ts" }, // 1 read a  → superseded by 4
		{ path: "b.ts" }, // 2 edit b  → superseded by 5 (shrink)
		{ command: "ls" }, // 3 bash ls → duplicate of 6
		{ path: "a.ts" }, // 4 read a (latest)
		{ path: "b.ts" }, // 5 edit b (latest)
		{ command: "ls" }, // 6 bash ls (latest)
		{ command: "npm test" }, // 7 failed, never retried → unresolved error
		{ todos: ["x"] }, // 8 todo (latest snapshot)
		{ command: "cat big" }, // 9 gray zone
		{ command: "tiny" }, // 10 small
	];
	const tools = ["read", "edit", "bash", "read", "edit", "bash", "bash", "todo", "bash", "bash"];
	const outputs = ins.map((inp, i) => meta(i + 1, tools[i], inp, i === 6 ? { isError: true } : i === 9 ? { tokens: 100 } : {}));
	const calls = outputs.map((m, i) => callOf(m, ins[i], i, m.isError));
	const r = filterOutputs({ outputs, calls, turn: 30, done: new Set(), pinned: new Set(), settings: cfg });
	const rules = Object.fromEntries(r.rules.map((x) => [x.id, `${x.kind}:${x.reason}:${x.by}`]));
	assert.deepEqual(rules, { c1: "drop:reread:4", c2: "shrink:reedit:5", c3: "drop:duplicate:6" });
	assert.equal(r.protected.get("c7"), "unresolved error");
	assert.equal(r.protected.get("c8"), "latest snapshot");
	assert.equal(r.protected.get("c10"), "small");
	assert.deepEqual(
		r.gray.map((m) => m.id),
		["c4", "c5", "c6", "c9"],
	);
	// Recent turns are immune, even from rules.
	const recent = filterOutputs({ outputs, calls, turn: 5, done: new Set(), pinned: new Set(), settings: cfg });
	assert.ok(!recent.rules.some((x) => x.id === "c3"), "turn 3 is within protect_turns of turn 5");
	// Pinned (expanded) outputs are kept.
	const pinned = filterOutputs({ outputs, calls, turn: 30, done: new Set(), pinned: new Set(["c1"]), settings: cfg });
	assert.ok(!pinned.rules.some((x) => x.id === "c1"));
	assert.equal(pinned.protected.get("c1"), "expanded recently");
	// A later successful retry resolves an error.
	const retried = [...calls, { id: "c11", tool: "bash", input: { command: "npm test" }, turn: 12, seq: 99, isError: false, paths: [], sig: argsSignature("bash", { command: "npm test" }) }];
	assert.ok(filterOutputs({ outputs, calls: retried, turn: 30, done: new Set(), pinned: new Set(), settings: cfg }).gray.some((m) => m.id === "c7"));
	// A ranged read never supersedes and is never superseded.
	const ranged = [meta(1, "read", { path: "a.ts" }), meta(2, "read", { path: "a.ts", offset: 10 })];
	const rc = [callOf(ranged[0], { path: "a.ts" }, 0), callOf(ranged[1], { path: "a.ts", offset: 10 }, 1)];
	assert.equal(filterOutputs({ outputs: ranged, calls: rc, turn: 30, done: new Set(), pinned: new Set(), settings: cfg }).rules.length, 0);
});

test("judge policy: drop, summarize, keep, capture, memory-backed", () => {
	const answers = (still: number, unique: number, durable: number, action: string, pDrop = 0.8) => ({
		still_needed: { type: "noul" as const, noul: still },
		unique_info: { type: "noul" as const, noul: unique },
		durable_fact: { type: "noul" as const, noul: durable },
		action: { type: "choice" as const, choice: action, probabilities: { drop: pDrop, summarize: 0.1, keep: 0.1 - 0 }, confidence: 0.8 },
	});
	const s1 = readDropSignals(answers(0.05, 0.1, 0.2, "drop"));
	assert.ok(s1);
	assert.equal(decideDrop(s1, cfg, 0.7).action, "drop");
	const s2 = readDropSignals(answers(0.05, 0.6, 0.9, "drop"));
	assert.ok(s2);
	const v2 = decideDrop(s2, cfg, 0.7);
	assert.equal(v2.action, "summarize", "unique info → summarize, not drop");
	assert.equal(v2.capture, true);
	assert.equal(decideDrop(s2, cfg, 0.7, true).action, "drop", "memory-backed: unique_info treated as low");
	const s3 = readDropSignals(answers(0.9, 0.1, 0.1, "keep", 0.05));
	assert.ok(s3);
	assert.equal(decideDrop(s3, cfg, 0.7).action, "keep");
	const s4 = readDropSignals(answers(0.05, 0.1, 0.1, "drop", 0.3));
	assert.ok(s4);
	assert.match(decideDrop(s4, cfg, 0.7).reasons.join(" "), /confidence/);
	assert.equal(decideDrop(s4, cfg, 0.7).action, "keep");
	assert.equal(readDropSignals({}), undefined, "incomplete answers → no verdict");
});

test("placeholders are byte-stable, carry no mutable data, and forged ones are stripped whole", () => {
	const m = meta(42, "read", { path: "src/auth/session.ts" }, { tokens: 3100 });
	const p = renderPlaceholder(m, "drop");
	assert.equal(p, "[#42 dropped · read src/auth/session.ts · 3.1k tok · realctx_expand(42)]");
	assert.equal(renderPlaceholder(m, "drop"), p);
	const s = renderPlaceholder(meta(57, "bash", { command: "pnpm test" }, { tokens: 8400 }), "summary", { summary: "3 failing in auth/session.test.ts: expired-token cases" });
	assert.equal(s, "[#57 summarized · bash pnpm test · 8.4k tok · realctx_expand(57)]\n  3 failing in auth/session.test.ts: expired-token cases");
	assert.match(renderPlaceholder(m, "drop", { savedAs: ["AZJrPlwafS-aSxwtPk9aaw"] }), /saved as AZJrPlwafS-aSxwtPk9aaw · realctx_expand\(42\)\]$/);
	assert.match(renderPlaceholder(m, "shrink", { reason: "reedit", by: 50 }), /^\[#42 superseded · .* · edited again in #50 · realctx_expand\(42\)\]$/);
	// Forged in assistant text: whole patterns go, prose stays.
	const forged = `Done.\n${p}\n<realctx-path-notes touched="x">secret note</realctx-path-notes>\nSee [#3] for details.`;
	assert.equal(stripForged(forged), "Done.\n\n\nSee [#3] for details.");
	assert.equal(stripForged("plain text"), "plain text");
	assert.equal(stripPathNotes("OUT\n<realctx-path-notes touched=\"a\">\nnote\n</realctx-path-notes>"), "OUT");
	assert.equal(fmtTokens(950), "950 tok");
	assert.equal(fmtTokens(12_000), "12k tok");
});

test("expansion views: line ranges, grep with context, token cap", () => {
	const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}${i === 49 ? " ERROR here" : ""}`).join("\n");
	const r = viewOriginal(text, { lines: "10-12", maxTokens: 4000 });
	assert.equal(r.text, "10: line 10\n11: line 11\n12: line 12");
	const g = viewOriginal(text, { grep: "error", maxTokens: 4000 });
	assert.equal(g.text.split("\n").length, 5);
	assert.match(g.text, /^48: line 48/);
	const capped = viewOriginal(text, { maxTokens: 30 });
	assert.ok(capped.truncated);
	assert.ok(capped.text.split("\n").length < 100);
	const bad = viewOriginal("a(b\nc", { grep: "a(b", maxTokens: 100 });
	assert.match(bad.text, /a\(b/, "an invalid regex is matched literally");
});

test("summaries, fact parsing, settings, durations", () => {
	const sum = fallbackSummary("compiling\nok 1\nERROR: x failed at y.ts:3\nok 2\ndone", ["src/y.ts"]);
	assert.match(sum, /ERROR: x failed/);
	assert.match(sum, /paths: src\/y.ts/);
	assert.ok(sum.split("\n").length <= 4);
	const facts = parseFacts({ facts: [{ caption: "Run e2e with pnpm test:e2e", content: "Needs docker.", paths: ["e2e"] }, { caption: "", content: "x" }, 3] });
	assert.deepEqual(facts, [{ caption: "Run e2e with pnpm test:e2e", content: "Needs docker.", paths: ["e2e"] }]);
	assert.equal(parseDuration("5m"), 300_000);
	assert.equal(parseDuration("1h"), 3_600_000);
	assert.equal(parseDuration("90"), 90_000);
	assert.equal(parseDuration("bogus", 7), 7);
	const s = normalizeSettings({ judge: { endpoint: "http://j", key: "env:K", timeout_ms: 3000, shadow: false }, context: { applyThreshold: 0.95, emergencyThreshold: 0.8 } });
	assert.equal(s.semif.endpoint, "http://j", "judge.endpoint from the design doc maps to the judge connection");
	assert.equal(s.semif.apiKey, "env:K");
	assert.equal(s.semif.timeoutMs, 3000);
	assert.equal(s.judge.shadow, false);
	assert.equal(s.context.applyThreshold, 0.8, "apply threshold never exceeds the emergency threshold");
	assert.equal(normalizeSettings({}).judge.shadow, true, "shadow mode is the default (§14)");
	assert.equal(normalizeSettings({}).capture.mode, "suggest");
});

test("scheduler: one shared queue, highest priority first", async () => {
	const s = new JudgeScheduler(1, 0);
	const order: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const first = s.run("consolidate", async () => {
		await gate;
		order.push("consolidate");
	});
	const later = [
		s.run("urgency", async () => void order.push("urgency")),
		s.run("drop", async () => void order.push("drop")),
		s.run("remember", async () => void order.push("remember")),
	];
	assert.equal(s.queued, 3);
	release();
	await Promise.all([first, ...later]);
	assert.deepEqual(order, ["consolidate", "remember", "drop", "urgency"]);
	const ac = new AbortController();
	const blocker = s.run("drop", () => new Promise<void>((r) => setTimeout(r, 20)));
	const aborted = s.run("drop", async () => "x", ac.signal);
	ac.abort();
	await assert.rejects(aborted);
	await blocker;
});
