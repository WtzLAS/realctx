/**
 * End to end through the extension hooks: path-scoped memories appear at the end of
 * tool results by urgency tier, once per session branch, with a separate counter.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { normalizeSettings, saveSettings } from "../src/config.ts";
import { MemoryEngine } from "../src/engine.ts";
import { clearProjectCache } from "../src/project.ts";

type Handler = (event: any, ctx: any) => any;

let srv: Server;
let base: string;
let userHome: string;
let proj: string;
/** Urgency the mock judge returns, by caption keyword. */
const urgencyFor = (state: string) => {
	const caption = /Caption: (.*)/.exec(state)?.[1] ?? ""; // the candidate's own caption (neighbours follow later)
	return caption.startsWith("MIGRATE") ? 1.9 : caption.startsWith("HISTORY") ? 0.2 : 1.0;
};

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
			const answers: Record<string, unknown> = {};
			for (const [k, q] of Object.entries<any>(body.questions)) {
				if (q.type === "noul") answers[k] = { type: "noul", noul: k === "unsafe" ? 0.01 : 0.95 };
				else if (q.type === "score")
					answers[k] = { type: "score", score: k === "path_urgency" ? urgencyFor(body.state) : 2.5, legend: {}, probabilities: {}, confidence: 0.9 };
				else {
					const keys = Object.keys(q.criteria);
					const scope = /GLOBAL/.test(body.state) ? "Global" : "Project Shared";
					const pick = k === "action" ? "Add" : k === "scope" ? scope : "none";
					answers[k] = { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((x) => [x, x === pick ? 0.9 : 0.1 / keys.length])), confidence: 0.9 };
				}
			}
			res.end(JSON.stringify({ model: "mock", answers }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
	const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
	base = mkdtempSync(join(tmpdir(), "realctx-pn-"));
	proj = mkdtempSync(join(tmpdir(), "realctx-pnproj-"));
	userHome = mkdtempSync(join(tmpdir(), "realctx-pnhome-"));
	mkdirSync(join(userHome, ".config", "tool"), { recursive: true });
	writeFileSync(join(userHome, ".config", "tool", "config.toml"), "x = 1\n");
	process.env.REALCTX_USER_HOME = userHome;
	execFileSync("git", ["init", "-q"], { cwd: proj });
	mkdirSync(join(proj, "db", "migrations"), { recursive: true });
	mkdirSync(join(proj, "web"), { recursive: true });
	writeFileSync(join(proj, "db", "schema.sql"), "create table t();\n");
	writeFileSync(join(proj, "db", "migrations", "001.sql"), "select 1;\n");
	writeFileSync(join(proj, "web", "app.ts"), "export {};\n");
	execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "add", "."], { cwd: proj });
	execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: proj });
	process.env.REALCTX_HOME = base;
	saveSettings(
		join(base, "config.json"),
		normalizeSettings({ embedding: { endpoint: url, apiKey: "", model: "m", dimensions: 4 }, semif: { endpoint: url, apiKey: "", model: "m" } }),
	);
	clearProjectCache();
});

after(() => {
	srv.close();
	rmSync(base, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
	rmSync(userHome, { recursive: true, force: true });
	delete process.env.REALCTX_HOME;
	delete process.env.REALCTX_USER_HOME;
});

async function harness() {
	const { default: realctx } = await import("../extensions/realctx/index.ts");
	const tools = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ type: string; id: string; customType?: string; data?: unknown; firstKeptEntryId?: string }> = [];
	let seq = 0;
	const nextId = () => `e${++seq}`;
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: () => {},
		on: (e: string, h: Handler) => {
			handlers.set(e, [...(handlers.get(e) ?? []), h]);
			return () => {};
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", id: nextId(), customType, data }),
		getActiveTools: () => [],
		setActiveTools: () => {},
		sendUserMessage: () => {},
	};
	realctx(pi);
	const emit = async (e: string, ev: any, ctx: any) => {
		let last: any;
		for (const h of handlers.get(e) ?? []) last = (await h(ev, ctx)) ?? last;
		return last;
	};
	const ctx: any = {
		cwd: proj,
		hasUI: false,
		mode: "print",
		ui: { setStatus() {}, notify() {} },
		sessionManager: { getBranch: () => entries },
		modelRegistry: { find: () => undefined, complete: async () => ({}) },
		model: undefined,
	};
	const toolResult = async (toolName: string, input: Record<string, unknown>) => {
		const r = await emit("tool_result", { type: "tool_result", toolName, toolCallId: "t", input, content: [{ type: "text", text: "OUT" }], isError: false, details: undefined }, ctx);
		return r?.content?.map((c: any) => c.text).join("\n") as string | undefined;
	};
	const turnEnd = async () => {
		const r = await emit("turn_end", { type: "turn_end" }, ctx);
		for (const d of r?.entries ?? []) entries.push({ ...d, id: nextId() });
	};
	/** Simulate a model message entry (so compactions have something to keep). */
	const message = () => {
		const id = nextId();
		entries.push({ type: "message", id });
		return id;
	};
	const compact = async (firstKeptEntryId: string) => {
		entries.push({ type: "compaction", id: nextId(), firstKeptEntryId });
		await emit("session_compact", { type: "session_compact", reason: "threshold", fromExtension: false, willRetry: false }, ctx);
	};
	return { tools, emit, ctx, entries, toolResult, turnEnd, message, compact };
}

test("remember with paths → urgency judged → shown on touch by tier, once per branch", async () => {
	const h = await harness();
	await h.emit("session_start", { type: "session_start", reason: "startup" }, h.ctx);
	const remember = (caption: string, content: string, paths?: string[]) =>
		h.tools.get("realctx_remember").execute("r", { caption, content, ...(paths ? { paths } : {}) }, undefined, undefined, h.ctx);

	const r1 = await remember("MIGRATE before editing schema", "Run `make migrate` after changing db/schema.sql; CI checks drift.", ["db"]);
	assert.equal(r1.details.status, "added");
	assert.match(r1.content[0].text, /for db/);
	await remember("OWNER of the schema is the data team", "Ask #data before renaming tables.", ["db/schema.sql"]);
	await remember("HISTORY of the naming scheme", "Tables were prefixed tbl_ before 2023.", ["db"]);
	await remember("SQL files use 2-space indent", "Format SQL with sqlfluff.", ["**/*.sql"]);
	await remember("Migrations are numbered", "Name files as NNN.sql, never reuse numbers.", ["db/migrations"]);
	// No paths: the whole project root, never inferred (even when the text names paths).
	const plain = await remember("Project uses pnpm", "Install with pnpm install; see db/migrations for SQL.");
	assert.equal(plain.details.status, "added");
	assert.ok(!/ for /.test(plain.content[0].text), plain.content[0].text);
	// Global memories: `~` by default, `~/…` paths under the user directory.
	await remember("GLOBAL: prefers concise answers", "Keep replies short.");
	await remember("GLOBAL: tool config is TOML", "Edit ~/.config/tool/config.toml, not the JSON one.", ["~/.config/tool"]);

	const e = new MemoryEngine();
	const files = e.scopes(proj).stores;
	const rows = e.db.list(files.map((s) => s.id), { limit: 50, offset: 0 });
	const byCaption = (c: string) => rows.find((m) => m.caption.startsWith(c));
	assert.deepEqual(byCaption("Project uses pnpm")?.paths, ["."]);
	assert.equal(byCaption("GLOBAL: prefers")?.kind, "global");
	assert.deepEqual(byCaption("GLOBAL: prefers")?.paths, ["~"]);
	assert.deepEqual(byCaption("GLOBAL: tool config")?.paths, ["~/.config/tool"]);
	assert.match(readFileSync(byCaption("GLOBAL: prefers")?.file as string, "utf8"), /\npaths:\n {2}- "~"\n/);
	const st = e.status(proj) as any;
	assert.equal(st.paths.scoped, 6);
	assert.equal(st.paths.unjudged, 0, "urgency stored at remember time");
	e.close();

	// Touch the schema: HIGH in full, MID caption, LOW counted, glob note (default urgency 1.0 = mid) as caption.
	const t1 = await h.toolResult("read", { path: "db/schema.sql" });
	assert.ok(t1);
	assert.ok(t1.startsWith("OUT\n<realctx-path-notes"), "appended after the original output");
	assert.match(t1, /<memory id="[^"]+" scope="project-shared"[^>]*>\n# MIGRATE before editing schema\nRun `make migrate`/);
	assert.match(t1, /- \[[^\]]+\] OWNER of the schema/);
	assert.match(t1, /- \[[^\]]+\] SQL files use 2-space indent/);
	assert.ok(!t1.includes("HISTORY"), "low urgency only counted");
	assert.match(t1, /1 more memory is attached/);
	assert.ok(!t1.includes("Project uses pnpm"), "project-wide memories are not path notes");
	assert.ok(!t1.includes("Migrations are numbered"), "db/migrations note is not attached to db/schema.sql");
	assert.ok(t1.indexOf("OWNER") < t1.indexOf("SQL files"), "most specific first");

	// Same area again: nothing new is shown.
	assert.equal(await h.toolResult("read", { path: "db/schema.sql" }), undefined);
	// Migrations: only the not-yet-shown migrations memory appears.
	const t2 = await h.toolResult("bash", { command: "ls db/migrations" });
	assert.match(t2 ?? "", /Migrations are numbered/);
	assert.ok(!(t2 ?? "").includes("MIGRATE before"), "already shown on this branch");
	// Unrelated path: nothing.
	assert.equal(await h.toolResult("read", { path: "web/app.ts" }), undefined);
	// Global path notes work outside the project too (paths shown as ~/…).
	const g = (await h.toolResult("read", { path: join(userHome, ".config", "tool", "config.toml") })) ?? "";
	assert.match(g, /GLOBAL: tool config is TOML/);
	assert.match(g, /touched="~\/\.config\/tool\/config\.toml"/);
	assert.ok(!g.includes("prefers concise"), "`~` memories are whole-scope, not path notes");

	// Shown ids persist through turn_end entries: a reloaded runtime does not repeat them.
	await h.turnEnd();
	assert.ok(h.entries.some((x) => x.customType === "realctx-shown"));
	await h.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, h.ctx);
	await h.emit("session_start", { type: "session_start", reason: "reload" }, h.ctx);
	assert.equal(await h.toolResult("edit", { path: "db/schema.sql" }), undefined, "not repeated after reload");
	// A different branch (entries without the shown record) sees them again.
	const saved = [...h.entries];
	h.entries.length = 0;
	await h.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: null }, h.ctx);
	assert.match((await h.toolResult("read", { path: "db" })) ?? "", /MIGRATE before editing schema/);
	h.entries.push(...saved);

	// Counters: shown ≠ used.
	const e2 = new MemoryEngine();
	const row = e2.db.list(e2.scopes(proj).stores.map((s) => s.id), { limit: 50, offset: 0 }).find((m) => m.caption.startsWith("MIGRATE"));
	assert.ok(row);
	assert.equal(row.injectCount, 2);
	assert.equal(row.usedCount, 0, "being shown on touch does not count as use");
	e2.close();

	// recall by paths / ids.
	const byPath = await h.tools.get("realctx_recall").execute("q", { paths: ["db/schema.sql"] }, undefined, undefined, h.ctx);
	assert.match(byPath.content[0].text, /HISTORY of the naming scheme/);
	assert.ok(byPath.content[0].text.indexOf("OWNER") < byPath.content[0].text.indexOf("MIGRATE"), "most specific first");
	const byId = await h.tools.get("realctx_recall").execute("q", { ids: [row.id] }, undefined, undefined, h.ctx);
	assert.match(byId.content[0].text, /make migrate/);

	// Session prompt: path-scoped memories are not in the caption list; a path map is.
	const opts = { contextFiles: [], sections: {} as Record<string, string> };
	await h.emit("before_agent_start", { type: "before_agent_start", prompt: "x", systemPromptOptions: opts }, h.ctx);
	const section = opts.sections.realctx;
	assert.match(section, /Path notes \(shown when you touch these paths\): db \(\d\)/);
	assert.match(section, /Project uses pnpm/);
	assert.ok(!/- \[shared\] MIGRATE/.test(section), "path-scoped memories left out of the caption list");
	await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("hand-written scoped memories get urgency in the background; missing paths are flagged with a rename suggestion", async () => {
	clearProjectCache();
	const e = new MemoryEngine();
	try {
		const dir = join(proj, ".pi", "realctx");
		writeFileSync(
			join(dir, "01900000-0000-7000-8000-00000000000a.md"),
			"---\nid: 01900000-0000-7000-8000-00000000000a\ncaption: MIGRATE hand note\npaths:\n  - web/app.ts\n---\n\nKeep app.ts tiny.\n",
		);
		e.sync(proj);
		assert.equal((e.status(proj) as any).paths.unjudged, 1);
		assert.equal(await e.refreshUrgency(proj), 1);
		const m = e.db.getById("AZAAAAAAcACAAAAAAAAACg", undefined) ?? e.db.list(e.scopes(proj).stores.map((s) => s.id), { limit: 99, offset: 0 }).find((x) => x.caption === "MIGRATE hand note");
		assert.ok(m);
		assert.equal(e.db.getUrgency(m.store, m.id)?.score, 1.9);

		execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "mv", "web", "frontend"], { cwd: proj });
		execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "rename"], { cwd: proj });
		e.resetRepoCache();
		const res = e.checkPaths(proj);
		assert.equal(res.stale, 1);
		assert.deepEqual(e.db.getPathState(m.store, m.id), { missing: ["web/app.ts"], renames: { "web/app.ts": "frontend/app.ts" } });
		// Fixing the path clears the flag, and invalidates the urgency (judged for the old paths).
		const fixed = await e.updateMemory(proj, m, { paths: ["frontend/app.ts"] });
		e.checkPaths(proj);
		assert.equal(e.db.getPathState(fixed.store, fixed.id), undefined);
		assert.equal((e.status(proj) as any).paths.unjudged, 1, "re-judged for the new paths");
	} finally {
		e.close();
	}
});

test("prunePaths drops missing paths and unscopes memories whose paths are all gone; forget deletes by id", async () => {
	clearProjectCache();
	const e = new MemoryEngine();
	try {
		const dir = join(proj, ".pi", "realctx");
		writeFileSync(
			join(dir, "01900000-0000-7000-8000-0000000000b1.md"),
			"---\nid: 01900000-0000-7000-8000-0000000000b1\ncaption: PRUNE partial\npaths:\n  - gone/a.ts\n  - db\n---\n\nPartly stale.\n",
		);
		writeFileSync(
			join(dir, "01900000-0000-7000-8000-0000000000b2.md"),
			"---\nid: 01900000-0000-7000-8000-0000000000b2\ncaption: PRUNE all gone\npaths:\n  - gone/b.ts\n---\n\nFully stale.\n",
		);
		e.sync(proj);
		const stores = () => e.db.list(e.scopes(proj).stores.map((s) => s.id), { limit: 999, offset: 0 });
		const plan = e.planPrune(proj);
		assert.ok(plan.changes.some((c) => c.memory.caption === "PRUNE partial" && c.dropped.join() === "gone/a.ts" && c.paths.join() === "db"));
		assert.ok(plan.changes.some((c) => c.memory.caption === "PRUNE all gone" && c.paths.length === 0), "never known to git: deleted");
		assert.ok(stores().some((m) => m.caption === "PRUNE all gone" && m.paths?.join() === "gone/b.ts"), "planning changes nothing");
		const res = await e.prunePaths(proj);
		assert.equal(res.deleted.length, 0, "pruning without review never deletes a memory");
		const after = stores();
		const gone = after.find((m) => m.caption === "PRUNE all gone");
		assert.deepEqual(gone?.paths, ["."], "a memory without paths left becomes project-wide");
		await e.deleteMemory(gone!);
		const partial = after.find((m) => m.caption === "PRUNE partial");
		assert.deepEqual(partial?.paths, ["db"]);
		const r = await e.forget(proj, [partial!.id, "nonexistent-id"]);
		assert.equal(r.deleted.length, 1);
		assert.deepEqual(r.missing, ["nonexistent-id"]);
		assert.ok(!stores().some((m) => m.caption === "PRUNE partial"));
	} finally {
		e.close();
	}
});

const gitIn = (...args: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd: proj, encoding: "utf8" });

function writeMem(n: string, caption: string, paths: string[]): void {
	const id = `01900000-0000-7000-8000-0000000000${n}`;
	writeFileSync(
		join(proj, ".pi", "realctx", `${id}.md`),
		`---\nid: ${id}\ncaption: ${caption}\npaths:\n${paths.map((p) => `  - ${p}`).join("\n")}\n---\n\nBody of ${caption}.\n`,
	);
}

test("followRenames follows staged renames and plain moves (by content), several paths per memory", async () => {
	clearProjectCache();
	const e = new MemoryEngine();
	try {
		mkdirSync(join(proj, "mvsrc"), { recursive: true });
		mkdirSync(join(proj, "lib"), { recursive: true });
		writeFileSync(join(proj, "mvsrc", "one.ts"), "export const one = 1;\n");
		writeFileSync(join(proj, "mvsrc", "two.ts"), "export const two = 2;\n");
		writeFileSync(join(proj, "lib", "three.ts"), "export const three = 3;\n");
		gitIn("add", "mvsrc", "lib");
		gitIn("commit", "-qm", "files to move");
		writeMem("d1", "FOLLOW two files", ["mvsrc/one.ts", "mvsrc/two.ts"]);
		writeMem("d2", "FOLLOW directory", ["mvsrc"]);
		writeMem("d3", "FOLLOW staged", ["lib/three.ts", "db"]);
		e.sync(proj);

		renameSync(join(proj, "mvsrc"), join(proj, "moved")); // plain mv: untracked destination
		gitIn("mv", "lib/three.ts", "lib/3.ts"); // staged rename
		const moved = await e.followRenames(proj);
		assert.equal(moved.length, 3, JSON.stringify(moved.map((m) => m.renames)));
		const byCaption = (c: string) => e.db.list(e.scopes(proj).stores.map((s) => s.id), { limit: 999, offset: 0 }).find((m) => m.caption === c);
		assert.deepEqual([...(byCaption("FOLLOW two files")?.paths ?? [])].sort(), ["moved/one.ts", "moved/two.ts"]);
		assert.deepEqual(byCaption("FOLLOW directory")?.paths, ["moved"]);
		assert.deepEqual([...(byCaption("FOLLOW staged")?.paths ?? [])].sort(), ["db", "lib/3.ts"]);
		assert.equal(e.checkPaths(proj, true).stale, 0, "nothing left missing");
		assert.deepEqual(await e.followRenames(proj), [], "idempotent");
		for (const c of ["FOLLOW two files", "FOLLOW directory", "FOLLOW staged"]) await e.deleteMemory(byCaption(c)!);
		gitIn("add", "-A", "moved", "mvsrc", "lib");
		gitIn("commit", "-qm", "moved");
	} finally {
		e.close();
	}
});

test("prune review: deleted paths are dropped, other-branch paths kept, an all-gone memory is unscoped or deleted by choice", async () => {
	clearProjectCache();
	const e = new MemoryEngine();
	try {
		const main = gitIn("rev-parse", "--abbrev-ref", "HEAD").trim();
		gitIn("checkout", "-q", "-b", "feature-x");
		mkdirSync(join(proj, "feat"), { recursive: true });
		writeFileSync(join(proj, "feat", "only.ts"), "export const f = 1;\n");
		gitIn("add", "feat");
		gitIn("commit", "-qm", "feature only");
		gitIn("checkout", "-q", main);
		mkdirSync(join(proj, "del"), { recursive: true });
		writeFileSync(join(proj, "del", "x.ts"), "export const x = 1;\n");
		writeFileSync(join(proj, "del", "y.ts"), "export const y = 1;\n");
		gitIn("add", "del");
		gitIn("commit", "-qm", "to delete");
		gitIn("rm", "-q", "-r", "del");
		gitIn("commit", "-qm", "deleted");

		writeMem("e1", "PRUNEREV branch only", ["feat/only.ts"]);
		writeMem("e2", "PRUNEREV mixed", ["feat/only.ts", "del/x.ts", "db"]);
		writeMem("e3", "PRUNEREV unscope", ["del/x.ts"]);
		writeMem("e4", "PRUNEREV delete", ["del/y.ts"]);
		e.sync(proj);

		const plan = e.planPrune(proj);
		const change = (c: string) => plan.changes.find((x) => x.memory.caption === c);
		assert.deepEqual(plan.skipped.map((s) => s.memory.caption), ["PRUNEREV branch only"], "only on another branch: left alone");
		assert.deepEqual(change("PRUNEREV mixed")?.dropped, ["del/x.ts"]);
		assert.deepEqual(change("PRUNEREV mixed")?.kept, ["feat/only.ts"]);
		assert.deepEqual([...(change("PRUNEREV mixed")?.paths ?? [])].sort(), ["db", "feat/only.ts"]);
		assert.deepEqual(change("PRUNEREV unscope")?.paths, []);

		const { prunePathsCommand } = await import("../extensions/realctx/prune-page.ts");
		const notes: string[] = [];
		const titles: string[] = [];
		const ctx = {
			cwd: proj,
			hasUI: true,
			ui: {
				notify: (m: string) => notes.push(m),
				custom: async () => "review",
				select: async (title: string, options: string[]) => {
					titles.push(title);
					if (title.includes("PRUNEREV delete")) return "Delete the memory";
					return options[0];
				},
			},
		};
		await prunePathsCommand(ctx as any, e);
		assert.equal(titles.length, 3, titles.join("\n"));
		const rows = e.db.list(e.scopes(proj).stores.map((s) => s.id), { limit: 999, offset: 0 });
		const row = (c: string) => rows.find((m) => m.caption === c);
		assert.deepEqual(row("PRUNEREV branch only")?.paths, ["feat/only.ts"]);
		assert.deepEqual([...(row("PRUNEREV mixed")?.paths ?? [])].sort(), ["db", "feat/only.ts"]);
		assert.deepEqual(row("PRUNEREV unscope")?.paths, ["."]);
		assert.equal(row("PRUNEREV delete"), undefined, "deleted by choice");
		assert.match(notes.at(-1) ?? "", /updated paths of 1 memory, made 1 unscoped.*deleted 1, left 1 alone/);
		for (const c of ["PRUNEREV branch only", "PRUNEREV mixed", "PRUNEREV unscope"]) await e.deleteMemory(row(c)!);
	} finally {
		e.close();
	}
});

test("global absolute paths outside the user directory are checked as absolute, not under ~", async () => {
	clearProjectCache();
	const e = new MemoryEngine();
	try {
		const dir = join(base, "global");
		mkdirSync(dir, { recursive: true });
		const outside = join(proj, "db"); // exists, outside the user directory
		writeFileSync(
			join(dir, "01900000-0000-7000-8000-0000000000c1.md"),
			`---\nid: 01900000-0000-7000-8000-0000000000c1\ncaption: GLOBAL abs paths\npaths:\n  - ${outside}\n  - "~/.config/tool"\n  - /nonexistent-realctx/xyz\n---\n\nAbsolute scopes.\n`,
		);
		e.sync(proj);
		const m = e.db.list(e.scopes(proj).stores.map((s) => s.id), { limit: 999, offset: 0 }).find((x) => x.caption === "GLOBAL abs paths");
		assert.ok(m);
		assert.ok(m.paths?.includes(outside), `kept absolute: ${m.paths?.join(", ")}`);
		assert.ok(!m.paths?.some((p) => p.startsWith("~/") && p.includes(outside.slice(1))), "not re-rooted under ~");
		e.checkPaths(proj, true);
		assert.deepEqual(e.db.getPathState(m.store, m.id)?.missing, ["/nonexistent-realctx/xyz"]);
		const pruned = await e.prunePaths(proj);
		const after = pruned.updated.find((u) => u.id === m.id);
		assert.deepEqual([...(after?.paths ?? [])].sort(), [outside, "~/.config/tool"].sort());
		await e.deleteMemory(after ?? m);
	} finally {
		e.close();
	}
});

test("compaction resets the shown set; touching a parent directory does not trigger notes", async () => {
	clearProjectCache();
	const h = await harness();
	await h.emit("session_start", { type: "session_start", reason: "startup" }, h.ctx);

	// Parent directory: `db` does not show notes scoped to db/migrations or db/schema.sql.
	h.message();
	const parent = (await h.toolResult("bash", { command: "ls db" })) ?? "";
	assert.match(parent, /MIGRATE before editing schema/, "notes scoped to db itself are shown");
	assert.ok(!parent.includes("Migrations are numbered"), "db/migrations note needs a touch at or below db/migrations");
	assert.ok(!parent.includes("OWNER of the schema"), "db/schema.sql note needs that file");
	assert.ok(!parent.includes("SQL files use"), "a glob matches files, not their parent directory");
	await h.turnEnd();

	// Compaction that keeps the turn where the note was shown: still suppressed.
	const kept = h.message();
	await h.compact(h.entries[0].id);
	const again = (await h.toolResult("read", { path: "db" })) ?? "";
	assert.ok(!again.includes("MIGRATE before editing schema"), "kept in context: not repeated");
	await h.turnEnd();

	// Compaction that summarises that turn away: the note may be shown again.
	await h.compact(kept);
	const after = (await h.toolResult("read", { path: "db" })) ?? "";
	assert.match(after, /MIGRATE before editing schema/, "summarised away: shown again");
	// Shown in the current (unflushed) turn, then compacted: stays suppressed.
	const other = h.message();
	await h.compact(other);
	assert.equal(await h.toolResult("read", { path: "db" }), undefined, "shown in the current turn: kept");
	await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, h.ctx);
});
