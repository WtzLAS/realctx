import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { registerTools } from "../extensions/realctx/tools.ts";
import { embeddingFingerprint, normalizeSettings } from "../src/config.ts";
import { MemoryEngine } from "../src/engine.ts";
import { type StoreRef, serializeMemory } from "../src/files.ts";
import { newId } from "../src/ids.ts";
import { clearProjectCache, scopeContext } from "../src/project.ts";
import { textHash } from "../src/text.ts";

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "realctx-roots-")));
	const cwd = join(dir, "current");
	const other = join(dir, "other");
	for (const root of [cwd, other]) {
		mkdirSync(join(root, "src"), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: root });
	}
	clearProjectCache();
	const engine = new MemoryEngine(join(dir, "data"));
	const tools = new Map<string, any>();
	const calls = { engine: 0, seen: [] as string[], focus: 0, context: 0, status: 0, remembered: 0 };
	registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
		engine: () => { calls.engine++; return engine; },
		afterRemember: () => { calls.remembered++; },
		markSeen: (ids) => { calls.seen.push(...ids); },
		recentPaths: () => { calls.focus++; return [join(cwd, "src")]; },
		context: () => { calls.context++; return { searchDropped: async () => [], status: () => ({ active: true }) } as any; },
		contextStatus: () => { calls.status++; return ["CURRENT SESSION CONTEXT"]; },
	});
	const ctx = { cwd, modelRegistry: { find: () => undefined }, model: undefined };
	return {
		dir, cwd, other, engine, tools, calls,
		scopes: (root: string) => scopeContext(root, engine.paths.globalDir, engine.paths.personalRoot),
		call: (name: string, params: Record<string, unknown> = {}) => tools.get(`realctx_${name}`).execute("test", params, undefined, undefined, ctx),
		close: () => { engine.close(); rmSync(dir, { recursive: true, force: true }); clearProjectCache(); },
	};
}

function seed(store: StoreRef, caption: string, paths?: string[]) {
	const memory = { id: newId(), caption, content: `${caption}: durable build instructions.`, paths };
	mkdirSync(store.dir, { recursive: true });
	writeFileSync(join(store.dir, `${memory.id}.md`), serializeMemory(memory, store.kind));
	return memory;
}

/** Include bytes and mtimes, so even rewriting unchanged memory files is caught. */
function diskState(root: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const name of readdirSync(root).sort()) {
		// SQLite updates WAL reader marks in shared memory even for SELECT-only reads.
		if (name === "realctx.sqlite-shm") continue;
		const file = join(root, name);
		const stat = statSync(file);
		out[name] = stat.isDirectory() ? diskState(file) : { data: createHash("sha256").update(readFileSync(file)).digest("hex"), mtime: stat.mtimeMs };
	}
	return out;
}

const changes = (e: MemoryEngine) => e.db.db.prepare("SELECT total_changes() AS n").get()!.n;

test("root selects foreign shared/personal/global memories without persistent writes or session effects", async () => {
	const f = fixture();
	try {
		const local = seed(f.scopes(f.cwd).shared!, "Current deployment", ["src"]);
		const shared = seed(f.scopes(f.other).shared!, "Foreign deployment", ["src"]);
		const personal = seed(f.scopes(f.other).personal!, "Personal deployment", ["src"]);
		const global = seed(f.scopes(f.other).global, "Global deployment");
		// Only the current project is indexed. Foreign files must be discovered from disk.
		f.engine.sync(f.cwd);
		f.engine.db.bumpUsage([shared.id], "recall", 7);
		const before = diskState(f.dir);
		const writes = changes(f.engine);

		const list = await f.call("list", { root: "../other" });
		assert.equal(list.details.readOnly, true);
		assert.equal(list.details.root, f.other);
		assert.deepEqual(new Set(list.details.memories.map((m: any) => m.id)), new Set([shared.id, personal.id, global.id]));
		assert.match(list.content[0].text, /Read-only memory root:/);
		assert.doesNotMatch(list.content[0].text, /Current deployment/);

		const recall = await f.call("recall", { root: f.other, queries: ["deployment"], scope: "project-shared" });
		assert.deepEqual(recall.details.ids, [shared.id]);
		assert.match(recall.content[0].text, /used="7"/);
		assert.equal(recall.details.outputs, undefined);
		const byPath = await f.call("recall", { root: f.other, paths: ["src"], scope: "project-personal" });
		assert.deepEqual(byPath.details.ids, [personal.id]);
		const byId = await f.call("recall", { root: f.other, ids: [shared.id.slice(0, 12), local.id] });
		assert.deepEqual(byId.details.ids, [shared.id]);
		assert.deepEqual(byId.details.missing, [local.id]);

		const status = await f.call("status", { root: f.other });
		assert.equal(status.details.project.root, f.other);
		assert.equal(status.details.context, undefined);
		assert.doesNotMatch(status.content[0].text, /CURRENT SESSION CONTEXT/);
		assert.equal(status.details.stores.reduce((n: number, s: any) => n + s.memories, 0), 3);
		assert.equal(changes(f.engine), writes);
		assert.deepEqual(diskState(f.dir), before);
		assert.equal(f.engine.db.getById(shared.id), undefined, "foreign files did not enter the persistent index");
		assert.deepEqual(f.calls.seen, []);
		assert.equal(f.calls.focus, 0);
		assert.equal(f.calls.context, 0);
		assert.equal(f.calls.status, 0);
		for (const sources of [["output"], ["memory", "output"]]) {
			await assert.rejects(f.call("recall", { root: f.other, queries: ["deployment"], sources }), /Dropped outputs are only available/);
		}
		assert.equal(f.calls.context, 0);
	} finally { f.close(); }
});

test("foreign writes are rejected before reaching the engine, even for global scope or the same repository", async () => {
	const f = fixture();
	try {
		symlinkSync(f.other, join(f.cwd, "foreign-link"), "dir");
		const before = diskState(join(f.dir, "data"));
		for (const root of [f.other, "../other", "foreign-link", "src"]) {
			for (const scope of [undefined, "global", "project-shared", "project-personal"]) {
				await assert.rejects(f.call("remember", { root, scope, caption: "Forbidden update", content: "Do not store this.", user_requested: true }), /read-only/);
			}
			await assert.rejects(f.call("forget", { root, ids: [newId()] }), /read-only/);
		}
		assert.equal(f.calls.engine, 0);
		assert.equal(f.calls.remembered, 0);
		assert.deepEqual(diskState(join(f.dir, "data")), before);
		assert.equal(f.tools.get("realctx_expand").parameters.properties.root, undefined, "expand stays session-local");
	} finally { f.close(); }
});

test("omitted root, dot, normalized paths and symlink aliases of cwd retain normal behavior", async () => {
	const f = fixture();
	try {
		const memory = seed(f.scopes(f.cwd).shared!, "Local lookup", ["src"]);
		symlinkSync(f.cwd, join(f.dir, "current-link"), "dir");
		for (const root of [undefined, ".", "src/..", f.cwd + "/", "../current-link"]) {
			const r = await f.call("recall", { root, ids: [memory.id] });
			assert.equal(r.details.readOnly, false);
			assert.deepEqual(r.details.ids, [memory.id]);
		}
		assert.equal(f.engine.db.getById(memory.id)!.usedCount, 5);
		assert.equal(f.calls.seen.length, 5);
		await f.call("recall", { root: ".", queries: ["lookup"] });
		assert.equal(f.calls.focus, 1);
		assert.equal(f.calls.context, 1);
		assert.match((await f.call("status", { root: "." })).content[0].text, /CURRENT SESSION CONTEXT/);
		const saved = await f.call("remember", { root: "../current-link", caption: "Compile local artifacts", content: "Run make local-artifacts to compile this project.", user_requested: true, scope: "project-shared" });
		assert.equal(saved.details.status, "added");
		await f.engine.embedInBackground();
		const deleted = await f.call("forget", { root: ".", ids: [saved.details.id] });
		assert.deepEqual(deleted.details.deleted, [saved.details.id]);
	} finally { f.close(); }
});

test("root validates existing directories, supports tilde, and browses empty directories without creating stores", async () => {
	const f = fixture();
	const home = process.env.REALCTX_USER_HOME;
	try {
		writeFileSync(join(f.cwd, "file.txt"), "not a directory");
		for (const root of ["", "   ", "../missing", "file.txt"]) {
			for (const name of ["list", "recall", "status", "remember", "forget"]) {
				await assert.rejects(f.call(name, { root }), /existing directory/);
			}
		}
		assert.equal(f.calls.engine, 0);
		process.env.REALCTX_USER_HOME = f.dir;
		assert.equal((await f.call("status", { root: "~/other" })).details.root, f.other);
		const empty = join(f.dir, "empty");
		mkdirSync(empty);
		const before = diskState(f.dir);
		assert.equal((await f.call("list", { root: relative(f.cwd, empty) })).details.total, 0);
		await f.call("status", { root: empty });
		assert.equal((await f.call("recall", { root: empty, queries: ["nothing"] })).details.total, 0);
		assert.deepEqual(diskState(f.dir), before);
	} finally {
		if (home === undefined) delete process.env.REALCTX_USER_HOME;
		else process.env.REALCTX_USER_HOME = home;
		f.close();
	}
});

test("foreign browsing skips shared/personal/config migrations and supports pagination", async () => {
	const f = fixture();
	try {
		const old = f.scopes(f.other);
		seed(old.personal!, "Path-key memory");
		mkdirSync(join(f.other, ".pi", "realmem"), { recursive: true });
		writeFileSync(join(f.other, ".pi", "realmem", "legacy.md"), "legacy file must not move");
		execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "initial"], { cwd: f.other });
		clearProjectCache();
		const sc = f.scopes(f.other);
		assert.notEqual(sc.personal!.dir, old.personal!.dir);
		for (let i = 0; i < 3; i++) seed(sc.shared!, `Paginated build ${i}`);
		f.engine.applySettings(normalizeSettings({ list: { pageSize: 1 }, recall: { pageSize: 1 } }));
		writeFileSync(f.engine.paths.config, JSON.stringify({ version: 1 }));
		const before = diskState(f.dir);
		const writes = changes(f.engine);
		const list = await f.call("list", { root: f.other, page: 2, scope: "project-shared" });
		assert.equal(list.details.total, 3);
		assert.equal(list.details.page, 2);
		assert.equal(list.details.pages, 3);
		assert.equal(list.details.memories.length, 1);
		const r = await f.call("recall", { root: f.other, queries: ["Paginated"], page: 2 });
		assert.equal(r.details.page, 2);
		assert.equal(r.details.ids.length, 1);
		await f.call("status", { root: f.other });
		assert.equal(changes(f.engine), writes);
		assert.deepEqual(diskState(f.dir), before);
		assert.deepEqual(f.engine.notices, []);
	} finally { f.close(); }
});

test("read-only hybrid recall reuses cached vectors, never embeds documents, and leaves the index untouched", async () => {
	const f = fixture();
	try {
		f.engine.applySettings(normalizeSettings({ embedding: { endpoint: "http://unused.invalid", model: "test", dimensions: 4 } }));
		const memory = seed(f.scopes(f.other).shared!, "Remote compile recipe");
		f.engine.db.putEmbedding(textHash(memory.caption, memory.content), embeddingFingerprint(f.engine.settings), new Float32Array([1, 0, 0, 0]));
		const kinds: string[] = [];
		f.engine.embeddingClient.embed = async (_texts, kind) => {
			kinds.push(kind);
			return { vectors: [new Float32Array([1, 0, 0, 0])], tokens: 0, traces: [] };
		};
		const before = diskState(f.dir);
		const writes = changes(f.engine);
		const r = await f.call("recall", { root: f.other, queries: ["unrelatedword"] });
		assert.deepEqual(r.details.ids, [memory.id], "vector search works even without keyword overlap");
		assert.deepEqual(kinds, ["query"]);
		assert.equal(changes(f.engine), writes);
		assert.deepEqual(diskState(f.dir), before);
		assert.equal(f.engine.db.getById(memory.id), undefined);
	} finally { f.close(); }
});
