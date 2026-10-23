/**
 * Context layer end to end through the extension hooks: capture, rule drops, judge drops
 * (shadow vs live), apply timing, byte-stable placeholders, realctx_expand, persistence,
 * path-note survival, compaction cancel, conflicts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { normalizeSettings, saveSettings } from "../src/config.ts";
import { clearProjectCache } from "../src/project.ts";

type Handler = (event: any, ctx: any) => any;

let srv: Server;
let base: string;
let proj: string;
let url = "";
let judgeCalls = 0;
/** P(still_needed) the mock judge answers for drop questions. */
let stillNeeded = 0.02;

before(async () => {
	srv = createServer((req, res) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			const body = data ? JSON.parse(data) : {};
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/embeddings") {
				const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
				return res.end(JSON.stringify({ data: inputs.map((t, index) => ({ index, embedding: [1, (t.length % 13) / 13, 0.3, 0.1] })) }));
			}
			if (req.url !== "/v1/systemone") {
				res.statusCode = 404;
				return res.end("{}");
			}
			const answers: Record<string, unknown> = {};
			const isDrop = "still_needed" in body.questions || "unique_info" in body.questions;
			if (isDrop) judgeCalls++;
			for (const [k, q] of Object.entries<any>(body.questions)) {
				if (q.type === "noul") {
					const v = k === "still_needed" ? stillNeeded : k === "unique_info" ? 0.05 : k === "durable_fact" ? 0.1 : k === "durable_user_fact" ? userFact : k === "unsafe" ? 0.01 : 0.95;
					answers[k] = { type: "noul", noul: v };
				} else if (q.type === "score") answers[k] = { type: "score", score: 1, legend: {}, probabilities: {}, confidence: 0.9 };
				else {
					const keys = Object.keys(q.criteria);
					const pick = k === "action" ? (isDrop ? "drop" : "Add") : k === "scope" ? "Project Shared" : "none";
					answers[k] = { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((x) => [x, x === pick ? 0.9 : 0.1 / keys.length])), confidence: 0.9 };
				}
			}
			res.end(JSON.stringify({ model: "mock", answers }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
	url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
	base = mkdtempSync(join(tmpdir(), "realctx-ctx-"));
	proj = mkdtempSync(join(tmpdir(), "realctx-ctxproj-"));
	execFileSync("git", ["init", "-q"], { cwd: proj });
	mkdirSync(join(proj, "src"), { recursive: true });
	writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(proj, "src", "b.ts"), "export const b = 1;\n");
	execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "add", "."], { cwd: proj });
	execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: proj });
	process.env.REALCTX_HOME = base;
	writeSettings({});
	clearProjectCache();
});

after(() => {
	srv.close();
	rmSync(base, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
	delete process.env.REALCTX_HOME;
});

function writeSettings(extra: Record<string, unknown>) {
	saveSettings(
		join(base, "config.json"),
		normalizeSettings({
			embedding: { endpoint: url, apiKey: "", model: "m", dimensions: 4 },
			semif: { endpoint: url, apiKey: "", model: "m" },
			context: { captureMinTokens: 100, dropMinTokens: 100, protectTurns: 2 },
			capture: { mode: "off" },
			...extra,
		}),
	);
}

const big = (tag: string) => Array.from({ length: 200 }, (_, i) => `${tag} line ${i} with some words`).join("\n");

/** Answers of the mock rewrite model (fact extraction, summaries). */
let completeText = '{"facts": []}';
let completeCalls = 0;
/** P(durable_user_fact) the mock judge answers. */
let userFact = 0.9;

async function harness(opts: { tools?: Array<{ name: string; sourceInfo?: { path: string } }>; sessionId?: string; parentSession?: string } = {}) {
	const { default: realctx } = await import("../extensions/realctx/index.ts");
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const entries: any[] = [];
	const notices: string[] = [];
	let seq = 0;
	const nextId = () => `e${++seq}`;
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		on: (e: string, h: Handler) => {
			handlers.set(e, [...(handlers.get(e) ?? []), h]);
			return () => {};
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", id: nextId(), customType, data }),
		getActiveTools: () => [],
		getAllTools: () => opts.tools ?? [],
		setActiveTools: () => {},
		sendUserMessage: () => {},
	};
	realctx(pi);
	const emit = async (e: string, ev: any, ctx: any) => {
		let last: any;
		for (const h of handlers.get(e) ?? []) last = (await h(ev, ctx)) ?? last;
		return last;
	};
	const sessionId = opts.sessionId ?? `s-${Math.random().toString(36).slice(2)}`;
	const ctx: any = {
		cwd: proj,
		hasUI: true,
		mode: "print",
		ui: { setStatus() {}, notify: (t: string) => notices.push(t) },
		sessionManager: { getBranch: () => entries, getSessionId: () => sessionId, getHeader: () => ({ type: "session", id: sessionId, parentSession: opts.parentSession }) },
		modelRegistry: {
			find: () => undefined,
			complete: async () => {
				completeCalls++;
				return { stopReason: "stop", content: [{ type: "text", text: completeText }], usage: {} };
			},
		},
		model: { provider: "p", id: "m", contextWindow: 200_000, maxTokens: 20_000 },
		getSystemPrompt: () => "",
	};
	let now = Date.now() - 3_600_000;
	/** One assistant turn calling one tool, then its result. */
	const turn = async (name: string, input: Record<string, unknown>, text: string, isError = false) => {
		const id = `call${++seq}`;
		now += 1000;
		const assistant = { role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], timestamp: now, usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010 }, stopReason: "toolUse" };
		entries.push({ type: "message", id: nextId(), message: assistant });
		await emit("message_end", { type: "message_end", message: assistant }, ctx);
		const r = await emit("tool_result", { type: "tool_result", toolName: name, toolCallId: id, input, content: [{ type: "text", text }], isError, details: undefined }, ctx);
		const content = r?.content ?? [{ type: "text", text }];
		entries.push({ type: "message", id: nextId(), message: { role: "toolResult", toolCallId: id, toolName: name, content, isError, timestamp: now } });
		const te = await emit("turn_end", { type: "turn_end" }, ctx);
		for (const d of te?.entries ?? []) entries.push({ ...d, id: nextId() });
		return id;
	};
	const user = (text: string) => entries.push({ type: "message", id: nextId(), message: { role: "user", content: text, timestamp: now } });
	/** Run the `context` hook over the branch messages, like a provider request. */
	const request = async () => {
		const messages = structuredClone(entries.filter((e) => e.type === "message").map((e) => e.message));
		const r = await emit("context", { type: "context", messages }, ctx);
		return (r?.messages ?? messages) as any[];
	};
	const resultText = (msgs: any[], id: string) =>
		msgs
			.find((m) => m.role === "toolResult" && m.toolCallId === id)
			?.content.map((c: any) => c.text)
			.join("\n") as string;
	const settle = () => new Promise((r) => setTimeout(r, 150));
	await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	const shutdown = () => emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	return { tools, commands, emit, ctx, entries, turn, user, request, resultText, settle, notices, sessionId, shutdown };
}

test("rule drops apply only when the cache is cold, render byte-stable placeholders, and restore with realctx_expand", async () => {
	writeSettings({});
	const h = await harness();
	h.user("refactor a.ts");
	const r1 = await h.turn("read", { path: "src/a.ts" }, big("first read of a"));
	await h.turn("bash", { command: "echo 1" }, big("unrelated"));
	const r2 = await h.turn("read", { path: "src/a.ts" }, big("second read of a"));
	await h.turn("bash", { command: "echo 2" }, big("x"));
	await h.turn("bash", { command: "echo 3" }, big("y"));
	await h.settle();

	// The last response is old (cache cold): the queued re-read drop applies now.
	const m1 = await h.request();
	const p = h.resultText(m1, r1);
	assert.match(p, /^\[#1 dropped · read src\/a\.ts · [\d.]+k tok · re-read in #3 · realctx_expand\(1\)\]$/);
	assert.match(h.resultText(m1, r2), /second read of a line 0/, "the newer read stays");
	// Byte-stable across requests.
	const m2 = await h.request();
	assert.equal(h.resultText(m2, r1), p);

	// The drop is persisted on the branch.
	assert.ok(h.entries.some((e) => e.customType === "realctx-ids"));
	await h.turn("bash", { command: "echo 4" }, big("z"));
	assert.ok(h.entries.some((e) => e.customType === "realctx-drops" && e.data.drops?.some((d: any) => d.ord === 1)));

	// realctx_expand returns the original as a new result, with a staleness hint when the file changed.
	writeFileSync(join(proj, "src", "a.ts"), "export const a = 2;\n");
	const ex = await h.tools.get("realctx_expand").execute("x1", { ids: [1] }, undefined, undefined, h.ctx);
	assert.match(ex.content[0].text, /^#1 · read src\/a\.ts · turn 1/);
	assert.match(ex.content[0].text, /file edited since turn 1; re-read for the current version/);
	assert.match(ex.content[0].text, /first read of a line 0/);
	assert.ok(ex.content[0].text.length < big("first read of a").length + 400);
	// A repeat within repin_turns points to the first expansion.
	const again = await h.tools.get("realctx_expand").execute("x2", { ids: [1] }, undefined, undefined, h.ctx);
	assert.match(again.content[0].text, /already restored/);
	// Partial views always work.
	const part = await h.tools.get("realctx_expand").execute("x3", { ids: [1], grep: "line 150 " }, undefined, undefined, h.ctx);
	assert.match(part.content[0].text, /151: first read of a line 150 with some words/);
	const missing = await h.tools.get("realctx_expand").execute("x4", { ids: [99] }, undefined, undefined, h.ctx);
	assert.match(missing.content.at(-1).text, /Not found: #99/);

	// Dropped outputs are searchable through realctx_recall.
	const rec = await h.tools.get("realctx_recall").execute("r", { queries: ["first read"], sources: ["output"] }, undefined, undefined, h.ctx);
	assert.match(rec.content[0].text, /output #1 read src\/a\.ts \(turn 1\)/);

	// Reload: a fresh extension instance rebuilds the drop set from the branch and renders the same bytes.
	const { default: realctx } = await import("../extensions/realctx/index.ts");
	const handlers = new Map<string, Handler[]>();
	realctx({
		registerTool() {},
		registerCommand() {},
		on: (e: string, fn: Handler) => void handlers.set(e, [...(handlers.get(e) ?? []), fn]),
		appendEntry() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools() {},
		sendUserMessage() {},
	} as any);
	for (const fn of handlers.get("session_start") ?? []) await fn({ type: "session_start", reason: "reload" }, h.ctx);
	const messages = structuredClone(h.entries.filter((e) => e.type === "message").map((e) => e.message));
	let out: any;
	for (const fn of handlers.get("context") ?? []) out = (await fn({ type: "context", messages }, h.ctx)) ?? out;
	assert.equal(h.resultText(out?.messages ?? messages, r1), p, "same placeholder bytes after reload");
});

test("judge drops: shadow mode only logs; live mode queues and applies at pressure, path notes are re-shown", async () => {
	writeSettings({ judge: { shadow: true } });
	judgeCalls = 0;
	stillNeeded = 0.02;
	const h = await harness();
	h.user("fix the build");
	const id = await h.turn("bash", { command: "cat build.log" }, big("build log"));
	for (let i = 0; i < 3; i++) await h.turn("bash", { command: `echo ${i}` }, big(`filler ${i}`));
	await h.settle();
	assert.ok(judgeCalls > 0, "the judge was asked in the background");
	const m = await h.request();
	assert.match(h.resultText(m, id), /build log line 0/, "shadow mode: nothing dropped");
	const listing = h.commands.get("realctx");
	assert.ok(listing);

	writeSettings({ judge: { shadow: false } });
	const live = await harness();
	live.user("fix the build");
	const id2 = await live.turn("bash", { command: "cat build.log" }, big("build log"));
	for (let i = 0; i < 3; i++) await live.turn("bash", { command: `echo ${i}` }, big(`filler ${i}`));
	await live.settle();
	await live.turn("bash", { command: "echo last" }, big("last"));
	await live.settle();
	const m2 = await live.request();
	assert.match(live.resultText(m2, id2), /^\[#1 dropped · bash cat build\.log · .* · realctx_expand\(1\)\]$/);

	// A judge that says "still needed" keeps the output.
	stillNeeded = 0.9;
	const keep = await harness();
	keep.user("fix the build");
	const id3 = await keep.turn("bash", { command: "cat build.log" }, big("build log"));
	for (let i = 0; i < 3; i++) await keep.turn("bash", { command: `echo ${i}` }, big(`filler ${i}`));
	await keep.settle();
	assert.match(keep.resultText(await keep.request(), id3), /build log line 0/);
	stillNeeded = 0.02;
});

test("forged placeholders in assistant text are stripped; compaction is cancelled; conflicts disable the context layer", async () => {
	writeSettings({});
	const h = await harness();
	h.entries.push({ type: "message", id: "fx", message: { role: "assistant", content: [{ type: "text", text: "ok\n[#9 dropped · read x · 1k tok · realctx_expand(9)]" }], timestamp: Date.now() } });
	const m = await h.request();
	assert.equal(m.at(-1).content[0].text, "ok\n");
	assert.deepEqual(await h.emit("session_before_compact", { type: "session_before_compact", reason: "threshold" }, h.ctx), { cancel: true });
	assert.equal(await h.emit("session_before_compact", { type: "session_before_compact", reason: "manual" }, h.ctx), undefined, "manual /compact still runs");
	const st = await h.tools.get("realctx_status").execute("s", {}, undefined, undefined, h.ctx);
	assert.match(st.content[0].text, /Context layer: on/);

	const c = await harness({ tools: [{ name: "ctx_reduce", sourceInfo: { path: "/x/node_modules/@cortexkit/magic-context/index.js" } }] });
	assert.ok(c.notices.some((n) => /context layer off because Magic Context/.test(n)));
	const st2 = await c.tools.get("realctx_status").execute("s", {}, undefined, undefined, c.ctx);
	assert.match(st2.content[0].text, /Context layer: off \(another context manager is active: Magic Context\)/);
	assert.equal(await c.emit("session_before_compact", { type: "session_before_compact", reason: "threshold" }, c.ctx), undefined);
	const id = await c.turn("read", { path: "src/b.ts" }, big("b"));
	await c.turn("read", { path: "src/b.ts" }, big("b again"));
	for (let i = 0; i < 3; i++) await c.turn("bash", { command: `echo ${i}` }, big("f"));
	assert.match(c.resultText(await c.request(), id), /b line 0/, "conflict: nothing is dropped");
	// A generic tool name alone (e.g. some other "prune") is not a conflict.
	const g = await harness({ tools: [{ name: "prune", sourceInfo: { path: "/x/my-tools/index.js" } }] });
	assert.ok(!g.notices.some((n) => /context layer off/.test(n)));
});

test("realctx_recall finds dropped outputs by meaning (vector) and never searches other sessions", async () => {
	writeSettings({});
	const a = await harness();
	a.user("look at the logs");
	const r1 = await a.turn("read", { path: "src/a.ts" }, big("zebra unicorn telemetry"));
	await a.turn("read", { path: "src/a.ts" }, big("second"));
	for (let i = 0; i < 3; i++) await a.turn("bash", { command: `echo ${i}` }, big("f"));
	await a.request();
	await a.settle();
	assert.match(a.resultText(await a.request(), r1), /^\[#1 dropped/);
	const rec = await a.tools.get("realctx_recall").execute("r", { queries: ["zebra"], sources: ["output"] }, undefined, undefined, a.ctx);
	assert.match(rec.content.at(-1).text, /output #1 read src\/a\.ts/);
	// No shared word with the output: only the vector search (mock embedder) can find it.
	const vec = await a.tools.get("realctx_recall").execute("r", { queries: ["qqqqxxxx"], sources: ["output"] }, undefined, undefined, a.ctx);
	assert.match(vec.content.at(-1).text, /output #1 read src\/a\.ts/);
	writeSettings({ context: { captureMinTokens: 100, dropMinTokens: 100, protectTurns: 2, embedDropped: false } });
	const noVec = await a.tools.get("realctx_recall").execute("r", { queries: ["qqqqxxxx"], sources: ["output"] }, undefined, undefined, a.ctx);
	assert.ok(!/output #1/.test(noVec.content.map((c: any) => c.text).join("\n")), "keyword-only without vectors");
	writeSettings({});

	// Another session with the same tool call ids sees none of a's outputs.
	const b = await harness();
	b.user("other work");
	const rb = await b.turn("read", { path: "src/b.ts" }, big("other session"));
	await b.turn("read", { path: "src/b.ts" }, big("other session again"));
	for (let i = 0; i < 3; i++) await b.turn("bash", { command: `echo ${i}` }, big("g"));
	await b.request();
	assert.match(b.resultText(await b.request(), rb), /^\[#1 dropped/);
	const recB = await b.tools.get("realctx_recall").execute("r", { queries: ["zebra unicorn telemetry"], sources: ["output"] }, undefined, undefined, b.ctx);
	assert.ok(!/zebra|src\/a\.ts/.test(recB.content.map((c: any) => c.text).join("\n")), "no hits from session a");
	await a.shutdown();
	await b.shutdown();
});

test("output retention deletes originals of inactive sessions; open sessions are kept", async () => {
	writeSettings({ context: { captureMinTokens: 100, dropMinTokens: 100, protectTurns: 2, retentionDays: 7 } });
	const old = await harness();
	await old.turn("bash", { command: "cat x" }, big("old"));
	await old.shutdown();
	const { MemoryEngine } = await import("../src/engine.ts");
	const { pruneOutputs } = await import("../src/jobs.ts");
	const e = new MemoryEngine();
	try {
		// Pretend the old session was last active 8 days ago.
		e.db.touchOutputSession(old.sessionId, "p", join(base, "sessions", "gone"));
		const db: any = e.db;
		db.db.prepare("UPDATE output_sessions SET last_active = ? WHERE session = ?").run(Date.now() - 8 * 86_400_000, old.sessionId);
		assert.ok(e.db.getOutputMeta(old.sessionId, old.entries.find((x: any) => x.message?.role === "toolResult").message.toolCallId));
		const live = await harness();
		await live.turn("bash", { command: "cat y" }, big("live"));
		db.db.prepare("UPDATE output_sessions SET last_active = ? WHERE session = ?").run(Date.now() - 8 * 86_400_000, live.sessionId);
		const r = pruneOutputs(e, [live.sessionId]);
		assert.equal(r.sessions, 1);
		assert.equal(e.db.getOutputMeta(old.sessionId, old.entries.find((x: any) => x.message?.role === "toolResult").message.toolCallId), undefined);
		assert.ok(e.db.getOutputMeta(live.sessionId, live.entries.find((x: any) => x.message?.role === "toolResult").message.toolCallId), "open session kept");
		await live.shutdown();
	} finally {
		e.close();
	}
});

test("user messages: judged facts are captured as suggestions; acknowledgements, extension input and subagents are not", async () => {
	// Earlier tests leave sessions open (no session_shutdown): forget their parent announcement.
	delete process.env.REALCTX_PARENT_SESSION;
	writeSettings({ capture: { mode: "suggest", userMessages: true, pDurable: 0.7 } });
	completeText = '{"facts": [{"caption": "Use pnpm, not npm", "content": "This repo uses pnpm; never run npm install."}]}';
	completeCalls = 0;
	userFact = 0.9;
	const h = await harness();
	h.user("From now on always use pnpm instead of npm in this repo, please.");
	await h.turn("bash", { command: "echo hi" }, "hi");
	await h.settle();
	const { MemoryEngine } = await import("../src/engine.ts");
	const e = new MemoryEngine();
	try {
		const root = e.scopes(proj).project?.root;
		const list = e.db.listSuggestions(root);
		const s = list.find((x) => x.caption === "Use pnpm, not npm");
		assert.ok(s, "suggestion queued");
		assert.equal(s?.origin, "user");
		const calls = completeCalls;
		// Acknowledgement: not even judged.
		h.user("ok thanks");
		await h.turn("bash", { command: "echo 2" }, "2");
		// Extension-sent message: skipped.
		await h.emit("input", { type: "input", text: "Please always summarize the build log for me in detail.", source: "extension" }, h.ctx);
		h.user("Please always summarize the build log for me in detail.");
		await h.turn("bash", { command: "echo 3" }, "3");
		await h.settle();
		assert.equal(completeCalls, calls, "no extraction for ack or extension input");
		// The judge says "one-off": nothing extracted.
		userFact = 0.1;
		h.user("Now rename the helper in src/a.ts to parseThing and update callers.");
		await h.turn("bash", { command: "echo 4" }, "4");
		await h.settle();
		assert.equal(completeCalls, calls);
		await h.shutdown();

		// A subagent (started while another session announces itself as parent) never captures its
		// "user" messages: they are the parent agent's prompts.
		userFact = 0.9;
		const top = await harness();
		const sub = await harness();
		const st = (await sub.tools.get("realctx_status").execute("s", {}, undefined, undefined, sub.ctx)).details.context;
		assert.equal(st.subagent, true);
		assert.equal(st.parent, top.sessionId);
		const before = completeCalls;
		sub.user("Always run the integration tests with --runInBand in this repository.");
		await sub.turn("bash", { command: "echo s" }, "s");
		await sub.settle();
		assert.equal(completeCalls, before, "subagent prompts are not captured");
		await sub.shutdown();
		await top.shutdown();
		const after = await harness();
		assert.equal((await after.tools.get("realctx_status").execute("s", {}, undefined, undefined, after.ctx)).details.context.subagent, false, "parent announcement removed on shutdown");
		await after.shutdown();
	} finally {
		e.close();
		userFact = 0.9;
		completeText = '{"facts": []}';
	}
});

test("child sessions: own context layer (copied originals, separate drops); memory layer shared", async () => {
	writeSettings({});
	const parent = await harness();
	parent.user("work");
	const r1 = await parent.turn("read", { path: "src/a.ts" }, big("parent read"));
	await parent.turn("read", { path: "src/a.ts" }, big("parent read 2"));
	for (let i = 0; i < 3; i++) await parent.turn("bash", { command: `echo ${i}` }, big("f"));
	await parent.request();
	// Fork: the child starts with the parent's branch (same entries) and a parentSession header.
	const childId = `child-${Math.random().toString(36).slice(2)}`;
	const child = await harness({ sessionId: childId, parentSession: `/x/sessions/2026-01-01T00-00-00_${parent.sessionId}.jsonl` });
	for (const e of parent.entries) child.entries.push(structuredClone(e));
	await child.emit("session_start", { type: "session_start", reason: "fork" }, child.ctx);
	const st = (await child.tools.get("realctx_status").execute("s", {}, undefined, undefined, child.ctx)).details.context;
	assert.equal(st.parent, parent.sessionId);
	// The child's placeholder is byte-identical and restorable from its own copy.
	assert.equal(child.resultText(await child.request(), r1), parent.resultText(await parent.request(), r1));
	const ex = await child.tools.get("realctx_expand").execute("x", { ids: [1] }, undefined, undefined, child.ctx);
	assert.match(ex.content[0].text, /parent read line 0/);
	const ids = child.entries.filter((e: any) => e.customType === "realctx-ids").flatMap((e: any) => e.data.metas);
	await child.turn("bash", { command: "echo c" }, "c");
	const adopted = child.entries.filter((e: any) => e.customType === "realctx-ids").flatMap((e: any) => e.data.metas);
	assert.ok(adopted.length > ids.length && adopted.some((m: any) => m.file.includes(childId)), "child owns copies of the originals");
	// Memory layer is shared: a memory written in the parent is visible in the child.
	const rem = await parent.tools.get("realctx_remember").execute("m", { caption: "Shared fact for children", content: "Parent and child share memories through one engine." }, undefined, undefined, parent.ctx);
	assert.match(rem.content[0].text, /remembered|reinforced|added/i);
	const rec = await child.tools.get("realctx_recall").execute("r", { queries: ["Shared fact for children"], sources: ["memory"] }, undefined, undefined, child.ctx);
	assert.match(rec.content[0].text, /Shared fact for children/);
	await child.shutdown();
	await parent.shutdown();
});

test("scheduled consolidation: suggested after everyDays, never applied without the user", async () => {
	writeSettings({ consolidate: { schedule: { mode: "remind", everyDays: 14, minMemories: 1 } } });
	const { MemoryEngine } = await import("../src/engine.ts");
	const { checkConsolidation, consolidationKey } = await import("../src/jobs.ts");
	const e = new MemoryEngine();
	try {
		await e.remember({ caption: "Fact for schedule", content: "Something durable about the build.", source: "agent" }, { cwd: proj });
		assert.equal(await checkConsolidation(e, proj), undefined, "first sight starts the clock");
		assert.equal(await checkConsolidation(e, proj), undefined, "not due yet");
		const { key } = consolidationKey(e, proj);
		e.db.setSchedule(key, Date.now() - 15 * 86_400_000);
		const before = e.db.count(e.scopes(proj).stores.map((s) => s.id));
		const sug = await checkConsolidation(e, proj);
		assert.ok(sug && sug.sinceDays === 15 && !sug.plan, "remind mode suggests without planning");
		assert.equal(await checkConsolidation(e, proj), undefined, "suggested once per period");
		assert.equal(e.db.count(e.scopes(proj).stores.map((s) => s.id)), before, "nothing written");
	} finally {
		e.close();
	}
	const h = await harness();
	h.notices.length = 0;
	await h.shutdown();
});
