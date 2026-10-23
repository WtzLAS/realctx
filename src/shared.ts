/**
 * Process-wide realctx state shared by every session in the process (§5 open question:
 * subagents). Each Pi session has its own extension runtime and so its own context
 * layer; the memory layer is shared: one MemoryEngine (database, index, judge clients),
 * one pending-queue drain, one capture budget per session family.
 */
import { MemoryEngine } from "./engine.ts";

interface Shared {
	engines: Map<string, { engine: MemoryEngine; refs: number }>;
	/** Capture timestamps per session family (root session id). */
	capture: Map<string, number[]>;
	/** Process-wide flags (e.g. "draining", "retention", "consolidate-check"). */
	busy: Set<string>;
	/** Session id → parent session id, for sessions started in this process. */
	parents: Map<string, string>;
	/** Sessions currently open in this process (never pruned by retention). */
	open: Set<string>;
}

const KEY = Symbol.for("realctx.shared.v1");

/** Holder on globalThis, typed without a cast: Reflect reads/writes an untyped slot. */
function shared(): Shared {
	const found: unknown = Reflect.get(globalThis, KEY);
	if (isShared(found)) return found;
	const s: Shared = { engines: new Map(), capture: new Map(), busy: new Set(), parents: new Map(), open: new Set() };
	Reflect.set(globalThis, KEY, s);
	return s;
}

function isShared(v: unknown): v is Shared {
	return typeof v === "object" && v !== null && "engines" in v && v.engines instanceof Map && "busy" in v && v.busy instanceof Set;
}

function baseKey(baseDir?: string): string {
	return baseDir ?? process.env.REALCTX_HOME ?? "";
}

/** Get (or open) the engine shared by every session of this process. Pair with releaseEngine. */
export function acquireEngine(baseDir?: string): MemoryEngine {
	const s = shared();
	const key = baseKey(baseDir);
	const hit = s.engines.get(key);
	if (hit) {
		hit.refs++;
		return hit.engine;
	}
	const engine = new MemoryEngine(baseDir);
	s.engines.set(key, { engine, refs: 1 });
	return engine;
}

/** Drop one reference; the engine closes when no session uses it any more. */
export function releaseEngine(engine: MemoryEngine): void {
	const s = shared();
	for (const [key, v] of s.engines) {
		if (v.engine !== engine) continue;
		v.refs--;
		if (v.refs <= 0) {
			s.engines.delete(key);
			engine.close();
		}
		return;
	}
	engine.close();
}

/** Take one unit of the hourly capture budget of a session family. Returns false when exhausted. */
export function takeCaptureBudget(family: string, perHour: number, now = Date.now()): boolean {
	const s = shared();
	const times = (s.capture.get(family) ?? []).filter((t) => now - t < 3_600_000);
	if (times.length >= perHour) {
		s.capture.set(family, times);
		return false;
	}
	times.push(now);
	s.capture.set(family, times);
	return true;
}

/** Run `fn` unless a job with the same name is already running in this process. */
export async function once<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
	const s = shared();
	if (s.busy.has(name)) return undefined;
	s.busy.add(name);
	try {
		return await fn();
	} finally {
		s.busy.delete(name);
	}
}

export function isBusy(name: string): boolean {
	return shared().busy.has(name);
}

/** Record which session started a child session (in-process subagents). */
export function setParent(child: string, parent: string): void {
	shared().parents.set(child, parent);
}

/** Root of a session family: follow parents recorded in this process. */
export function familyRoot(session: string): string {
	const p = shared().parents;
	let cur = session;
	for (let i = 0; i < 32; i++) {
		const next = p.get(cur);
		if (!next || next === cur) break;
		cur = next;
	}
	return cur;
}

/** Environment variable through which a session tells child processes it is their parent. */
export const PARENT_ENV = "REALCTX_PARENT_SESSION";

/**
 * Parent agent session announced through REALCTX_PARENT_SESSION: set by a running realctx
 * session for everything it starts (subprocess subagents inherit the environment, in-process
 * SDK sessions see it directly). `self` is ignored so a session never becomes its own child.
 */
export function announcedParent(self: string): string | undefined {
	const v = process.env[PARENT_ENV]?.trim();
	return v && v !== self ? v : undefined;
}

/** Announce `id` as the parent for sessions started from now on. Returns an undo function. */
export function announceParent(id: string): () => void {
	const prev = process.env[PARENT_ENV];
	process.env[PARENT_ENV] = id;
	return () => {
		if (process.env[PARENT_ENV] !== id) return; // a later session took over; leave it
		if (prev === undefined) delete process.env[PARENT_ENV];
		else process.env[PARENT_ENV] = prev;
	};
}

export function openSession(id: string): void {
	shared().open.add(id);
}

export function closeSession(id: string): void {
	shared().open.delete(id);
}

export function openSessions(): string[] {
	return [...shared().open];
}

/** Session id from a Pi session file path (`…/<timestamp>_<id>.jsonl`), or the value itself. */
export function sessionIdFromRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const m = /_([0-9A-Za-z-]{8,})\.jsonl$/.exec(ref);
	if (m) return m[1];
	return /^[0-9A-Za-z-]{8,}$/.test(ref) ? ref : undefined;
}
