/**
 * One shared budget for every judge call (§13.5): a priority queue with a concurrency
 * limit and an optional minimum interval between requests. Priority, highest first:
 * remember path, drop decisions, path urgency, consolidation.
 */

export type JudgePriority = "remember" | "drop" | "urgency" | "consolidate";

const RANK: Record<JudgePriority, number> = { remember: 0, drop: 1, urgency: 2, consolidate: 3 };

interface Waiter {
	rank: number;
	seq: number;
	start: () => void;
	reject: (err: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface SchedulerStats {
	running: number;
	queued: number;
	calls: Record<JudgePriority, number>;
	ms: Record<JudgePriority, number>;
	failures: Record<JudgePriority, number>;
}

export class JudgeScheduler {
	concurrency: number;
	minIntervalMs: number;
	private running = 0;
	private seq = 0;
	private lastStart = 0;
	private waiting: Waiter[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	readonly stats: SchedulerStats = {
		running: 0,
		queued: 0,
		calls: { remember: 0, drop: 0, urgency: 0, consolidate: 0 },
		ms: { remember: 0, drop: 0, urgency: 0, consolidate: 0 },
		failures: { remember: 0, drop: 0, urgency: 0, consolidate: 0 },
	};

	constructor(concurrency = 1, minIntervalMs = 0) {
		this.concurrency = Math.max(1, concurrency);
		this.minIntervalMs = Math.max(0, minIntervalMs);
	}

	configure(concurrency: number, minIntervalMs: number): void {
		this.concurrency = Math.max(1, Math.round(concurrency));
		this.minIntervalMs = Math.max(0, minIntervalMs);
		this.pump();
	}

	/** Number of calls waiting for a slot. */
	get queued(): number {
		return this.waiting.length;
	}

	async run<T>(priority: JudgePriority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquire(priority, signal);
		const t0 = Date.now();
		try {
			const out = await fn();
			this.stats.calls[priority]++;
			return out;
		} catch (err) {
			this.stats.failures[priority]++;
			throw err;
		} finally {
			this.stats.ms[priority] += Date.now() - t0;
			this.running--;
			this.stats.running = this.running;
			this.pump();
		}
	}

	private acquire(priority: JudgePriority, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
		return new Promise<void>((resolve, reject) => {
			const w: Waiter = { rank: RANK[priority], seq: this.seq++, start: resolve, reject, signal };
			if (signal) {
				w.onAbort = () => {
					const i = this.waiting.indexOf(w);
					if (i >= 0) {
						this.waiting.splice(i, 1);
						this.stats.queued = this.waiting.length;
						reject(signal.reason ?? new Error("aborted"));
					}
				};
				signal.addEventListener("abort", w.onAbort, { once: true });
			}
			this.waiting.push(w);
			this.waiting.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
			this.stats.queued = this.waiting.length;
			this.pump();
		});
	}

	private pump(): void {
		while (this.running < this.concurrency && this.waiting.length > 0) {
			const wait = this.lastStart + this.minIntervalMs - Date.now();
			if (wait > 0) {
				if (!this.timer) {
					this.timer = setTimeout(() => {
						this.timer = undefined;
						this.pump();
					}, wait);
					this.timer.unref?.();
				}
				return;
			}
			const w = this.waiting.shift() as Waiter;
			this.stats.queued = this.waiting.length;
			if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
			this.running++;
			this.stats.running = this.running;
			this.lastStart = Date.now();
			w.start();
		}
	}
}

/** The process-wide scheduler shared by every judge client. */
export const judgeScheduler = new JudgeScheduler();
