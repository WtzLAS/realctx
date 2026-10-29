/**
 * Background jobs shared by every session of a process (memory layer): the daily output store
 * sweep (§6, stored originals expire after `context.retentionDays` without activity; orphaned
 * store folders and leftover temp files go too) and the scheduled consolidation suggestion
 * (§10, never writes without the user).
 */
import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ConsolidationPlan } from "./consolidate.ts";
import type { MemoryEngine } from "./engine.ts";
import { once } from "./shared.ts";
import type { Completer, Rewriter } from "./rewrite.ts";

const DAY = 86_400_000;

export interface SweepResult {
	/** Sessions whose originals expired. */
	sessions: number;
	/** Original files deleted with them. */
	files: number;
	/** Store folders no index row points to, deleted. */
	orphans: number;
	/** Leftover temp files of interrupted writes, deleted. */
	temps: number;
}

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(dir, d.name));
	} catch {
		return [];
	}
}

/** Newest modification time of a folder and the files directly in it. */
function newestMtime(dir: string): number {
	let newest = 0;
	try {
		newest = statSync(dir).mtimeMs;
		for (const name of readdirSync(dir)) {
			try {
				newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
			} catch {
				// vanished meanwhile
			}
		}
	} catch {
		return 0;
	}
	return newest;
}

/**
 * Delete stored originals (files, index rows, vectors, verdicts) of sessions inactive for
 * longer than the retention period, then folders under the store root that no index row knows
 * and that were not written to within the retention period (index lost, crashes, older
 * versions), and temp files older than a day. `keep` = sessions open in this process. With
 * `retentionDays` 0 nothing is deleted.
 */
export function pruneOutputs(engine: MemoryEngine, keep: string[], now = Date.now()): SweepResult {
	const out: SweepResult = { sessions: 0, files: 0, orphans: 0, temps: 0 };
	const days = engine.settings.context.retentionDays;
	if (!(days > 0)) return out;
	const cutoff = now - days * DAY;
	const stale = engine.db.staleOutputSessions(cutoff, keep);
	for (const s of stale) {
		const list = engine.db.purgeOutputSession(s.session);
		out.files += list.length;
		try {
			rmSync(s.dir, { recursive: true, force: true });
		} catch {
			for (const f of list) rmSync(f, { force: true });
		}
	}
	out.sessions = stale.length;

	const root = join(engine.paths.base, "sessions");
	const known = new Set(engine.db.outputSessionDirs().map((d) => resolve(d)));
	for (const project of listDirs(root)) {
		for (const dir of listDirs(project)) {
			if (known.has(resolve(dir))) {
				// Temp files of writes that never finished.
				try {
					for (const name of readdirSync(dir)) {
						if (!name.includes(".tmp-")) continue;
						const f = join(dir, name);
						if (now - statSync(f).mtimeMs > DAY) {
							rmSync(f, { force: true });
							out.temps++;
						}
					}
				} catch {
					// unreadable: skip
				}
				continue;
			}
			const newest = newestMtime(dir);
			if (newest === 0 || newest >= cutoff) continue;
			try {
				rmSync(dir, { recursive: true, force: true });
				out.orphans++;
			} catch {
				// in use or permissions: next sweep
			}
		}
		try {
			rmdirSync(project); // only succeeds when empty
		} catch {
			// not empty
		}
	}
	return out;
}

/** Run the store sweep at most once a day across all processes (shared schedule). */
export async function pruneOutputsThrottled(engine: MemoryEngine, keep: string[], now = Date.now()): Promise<SweepResult | undefined> {
	const last = engine.db.getSchedule("retention")?.at ?? 0;
	if (now - last < DAY) return undefined;
	return once("retention", async () => {
		engine.db.setSchedule("retention", now);
		return pruneOutputs(engine, keep, now);
	});
}

export interface ConsolidationSuggestion {
	/** Stores the suggestion covers (visible from the cwd). */
	key: string;
	memories: number;
	/** Days since the last consolidation or suggestion; undefined = never. */
	sinceDays?: number;
	/** Dry-run plan made in the background (mode `plan` with a judge). */
	plan?: ConsolidationPlan;
	error?: string;
}

/** Schedule key of the stores visible from `cwd`. */
export function consolidationKey(engine: MemoryEngine, cwd: string): { key: string; storeIds: string[] } {
	const storeIds = engine
		.scopes(cwd)
		.stores.map((s) => s.id)
		.sort();
	return { key: `consolidate:${storeIds.join("|")}`, storeIds };
}

/** Record that the stores of `cwd` were consolidated (or the suggestion handled) now. */
export function markConsolidated(engine: MemoryEngine, cwd: string): void {
	engine.db.setSchedule(consolidationKey(engine, cwd).key, Date.now());
}

/** A stored background plan for the stores of `cwd`, if still within the schedule period. */
export function storedPlan(engine: MemoryEngine, cwd: string): { plan: ConsolidationPlan; at: number } | undefined {
	const { key } = consolidationKey(engine, cwd);
	const row = engine.db.getSchedule(key);
	const data = row?.data as { plan?: ConsolidationPlan } | undefined;
	if (!row || !data?.plan || !Array.isArray(data.plan.ops)) return undefined;
	if (Date.now() - row.at > engine.settings.consolidate.schedule.everyDays * DAY) return undefined;
	return { plan: data.plan, at: row.at };
}

/**
 * Check whether a consolidation is due for the stores of `cwd` and, in mode `plan`, make a
 * dry-run plan in the background. Returns a suggestion to show, or undefined when not due.
 * Never writes memories.
 */
export async function checkConsolidation(
	engine: MemoryEngine,
	cwd: string,
	opts: { rewriter?: Rewriter; completer?: Completer; signal?: AbortSignal } = {},
): Promise<ConsolidationSuggestion | undefined> {
	const cfg = engine.settings.consolidate.schedule;
	if (cfg.mode === "off") return undefined;
	const { key, storeIds } = consolidationKey(engine, cwd);
	if (storeIds.length === 0) return undefined;
	const row = engine.db.getSchedule(key);
	const now = Date.now();
	const memories = engine.db.count(storeIds);
	if (memories < cfg.minMemories) return undefined;
	if (!row) {
		// First sight of these stores: start the clock instead of nagging right away.
		engine.db.setSchedule(key, now);
		return undefined;
	}
	if (now - row.at < cfg.everyDays * DAY) return undefined;
	const sinceDays = Math.floor((now - row.at) / DAY);
	return once(`consolidate-check:${key}`, async () => {
		if (cfg.mode === "remind" || !engine.semifClient.configured) {
			engine.db.setSchedule(key, now);
			return { key, memories, sinceDays };
		}
		try {
			const plan = await engine.planConsolidation({ cwd, rewriter: opts.rewriter, completer: opts.completer, signal: opts.signal });
			engine.db.setSchedule(key, now, { plan });
			return { key, memories, sinceDays, plan };
		} catch (err) {
			// Judge down: try again next session; remember the attempt so we do not retry in a loop.
			engine.db.setSchedule(key, now - (cfg.everyDays - 1) * DAY);
			return { key, memories, sinceDays, error: err instanceof Error ? err.message : String(err) };
		}
	});
}
