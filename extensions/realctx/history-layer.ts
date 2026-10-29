/**
 * History compression runtime (§9.4): a historian model summarizes old conversation turns in
 * the background; the `context` hook later swaps each prepared chunk for its frozen summary
 * block, at the same moments queued drops are applied (cold cache, pressure, flush), so the
 * prompt prefix is rebuilt at most once per apply pass. Applied chunks are persisted on the
 * branch and render byte-identically after reload and resume.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Settings } from "../../src/config.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import {
	boundaries,
	buildHistorianPrompt,
	estimateMessage,
	fallbackHistory,
	HISTORIAN_SYSTEM,
	HISTORY_TYPE,
	type HistoryChunk,
	type MessageView,
	messageKey,
	nextStart,
	type OutputLabel,
	parseHistorian,
	pickChunk,
	protectFrom,
	renderChunk,
	renderHistory,
	renderTranscript,
	textOf,
	userImageId,
} from "../../src/history.ts";
import type { ImageCost } from "../../src/images.ts";
import { fmtTokens } from "../../src/outputs.ts";
import { viewOriginal } from "../../src/policy.ts";
import { familyRoot, takeCaptureBudget } from "../../src/shared.ts";
import { estimateTokens } from "../../src/text.ts";
import { historianFor, rewriterFor } from "./tools.ts";

export const HISTORY_ENTRY = HISTORY_TYPE;

interface HistoryData {
	chunks?: HistoryChunk[];
}

export interface HistoryHost {
	engine(): MemoryEngine;
	settings(): Settings;
	sessionId(): string;
	subagent(): boolean;
	/** Label of a captured output (and its placeholder when dropped). */
	output(toolCallId: string): OutputLabel | undefined;
	/** Current usage of the safe input window, as of the last request. */
	usage(): { tokens: number; window: number; share: number } | undefined;
	/** Image token cost of the session model. */
	imageCost?(): ImageCost;
	/** Absolute assistant-turn counter. */
	assistants(): number;
	onCaptured?(ctx: ExtensionContext): void;
}

export interface HistoryStatus {
	enabled: boolean;
	applied: number;
	ready: number;
	preparing: boolean;
	saved: number;
	model?: string;
	lastError?: string;
}

function isChunk(c: unknown): c is HistoryChunk {
	if (!c || typeof c !== "object") return false;
	const r = c as Record<string, unknown>;
	return typeof r.n === "number" && typeof r.startKey === "string" && typeof r.endKey === "string" && typeof r.text === "string" && typeof r.count === "number";
}

export class HistoryManager {
	private chunks = new Map<number, HistoryChunk>();
	private unflushed: HistoryChunk[] = [];
	/** Messages of the last request as Pi sent them (before realctx rendered anything). */
	private lastInput: MessageView[] = [];
	/** Assistant turns before the first message of `lastInput`. */
	private inputTurnOffset = 0;
	private preparing = false;
	private generation = 0;
	private lastError: string | undefined;
	private lastModel: string | undefined;
	private readonly host: HistoryHost;

	constructor(host: HistoryHost) {
		this.host = host;
	}

	private get cfg(): Settings["history"] {
		return this.host.settings().history;
	}

	get enabled(): boolean {
		return this.cfg.enabled;
	}

	reset(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): void {
		this.generation++;
		this.chunks.clear();
		this.unflushed = [];
		this.lastInput = [];
		this.lastError = undefined;
		for (const e of entries) {
			if (e.type !== "custom" || e.customType !== HISTORY_ENTRY) continue;
			for (const c of (e.data as HistoryData | undefined)?.chunks ?? []) if (isChunk(c)) this.chunks.set(c.n, c);
		}
	}

	flushEntries(): Array<{ type: "custom"; customType: string; data: unknown }> {
		if (this.unflushed.length === 0) return [];
		// The latest state of each chunk (prepared, then applied), as plain copies.
		const byN = new Map(this.unflushed.map((c) => [c.n, c]));
		const data: HistoryData = { chunks: [...byN.values()].map((c) => structuredClone(c)) };
		this.unflushed = [];
		return [{ type: "custom", customType: HISTORY_ENTRY, data }];
	}

	private applied(): HistoryChunk[] {
		return [...this.chunks.values()].filter((c) => c.appliedAt !== undefined).sort((a, b) => a.n - b.n);
	}

	private ready(): HistoryChunk[] {
		return [...this.chunks.values()].filter((c) => c.appliedAt === undefined).sort((a, b) => a.n - b.n);
	}

	/** Tokens saved by chunks applied after `stamp` (not yet reflected in reported usage). */
	savedSince(stamp: number): number {
		let n = 0;
		for (const c of this.applied()) if ((c.appliedAt ?? 0) > stamp) n += Math.max(0, c.tokensBefore - c.tokensAfter);
		return n;
	}

	/** Remember what Pi sent, for background preparation. Call before anything is rendered. */
	observe(messages: MessageView[], assistantsTotal: number): void {
		this.lastInput = messages.slice();
		const inView = messages.filter((m) => m.role === "assistant").length;
		this.inputTurnOffset = Math.max(0, assistantsTotal - inView);
	}

	/**
	 * In the `context` hook: apply ready chunks when `apply` is true (and, in an emergency, build a
	 * deterministic one), then render every applied chunk. Returns the new messages, or undefined.
	 */
	transform(messages: MessageView[], opts: { apply: boolean; emergency: boolean; turn: number; keys?: string[] }): MessageView[] | undefined {
		if (!this.enabled) return undefined;
		const now = Date.now();
		if (opts.apply || opts.emergency) {
			for (const c of this.ready()) {
				// Only a chunk that still matches this transcript, contiguous with what is applied.
				const probe = renderHistory(messages, [...this.applied(), c], opts.keys);
				if (!probe.rendered.includes(c)) continue;
				c.appliedAt = now;
				c.appliedTurn = opts.turn;
				this.unflushed.push(c);
			}
			if (opts.emergency && this.cfg.emergencyFallback && this.ready().length === 0) this.emergencyChunk(messages, opts.turn, now);
		}
		const r = renderHistory(messages, this.applied(), opts.keys);
		return r.rendered.length > 0 ? r.messages : undefined;
	}

	/** Labels and sizes as the model saw them (dropped outputs count as their placeholder). */
	private tokensOf(messages: MessageView[]) {
		const cost = this.host.imageCost?.();
		return (i: number): number => {
			const m = messages[i];
			if (m.role === "toolResult" && m.toolCallId) {
				const o = this.host.output(m.toolCallId);
				if (o?.placeholder) return estimateTokens(o.placeholder) + 8;
			}
			const userImages = userImageId(m);
			const o = userImages ? this.host.output(userImages) : undefined;
			if (o?.placeholder) return estimateTokens(`${textOf(m.content)}\n${o.placeholder}`) + 8;
			return estimateMessage(m, cost);
		};
	}

	private planChunk(messages: MessageView[], force: boolean): { start: number; end: number; tokens: number } | undefined {
		const c = this.cfg;
		const start = nextStart(messages, [...this.chunks.values()]);
		const protect = protectFrom(messages, c.protectTurns);
		return pickChunk(messages, start, protect, force ? Math.min(c.minChunkTokens, 1500) : c.minChunkTokens, c.maxChunkTokens, this.tokensOf(messages));
	}

	private chunkFrom(messages: MessageView[], pick: { start: number; end: number; tokens: number }, summary: string, model: string): HistoryChunk {
		const part = messages.slice(pick.start, pick.end);
		const before = messages.slice(0, pick.start).filter((m) => m.role === "assistant").length;
		const inside = part.filter((m) => m.role === "assistant").length;
		const first = this.inputTurnOffset + before + 1;
		const turns: [number, number] = [first, Math.max(first, this.inputTurnOffset + before + inside)];
		const outputs: number[] = [];
		const labels = new Map<number, string>();
		for (const m of part) {
			const id = m.role === "toolResult" ? m.toolCallId : userImageId(m);
			if (!id) continue;
			const o = this.host.output(id);
			if (!o) continue;
			outputs.push(o.ord);
			labels.set(o.ord, o.label);
		}
		const n = Math.max(0, ...this.chunks.keys()) + 1;
		const base = { n, turns, tokensBefore: pick.tokens, outputs };
		const text = renderChunk(base, summary, labels);
		return {
			...base,
			startKey: messageKey(part[0]),
			endKey: messageKey(part[part.length - 1]),
			count: part.length,
			tokensAfter: estimateTokens(text) + 8,
			text,
			model,
			at: Date.now(),
			timestamp: part[0].timestamp ?? Date.now(),
		};
	}

	private emergencyChunk(messages: MessageView[], turn: number, now: number): void {
		const pick = this.planChunk(messages, true);
		if (!pick) return;
		const part = messages.slice(pick.start, pick.end);
		const summary = fallbackHistory(part, { turnOffset: this.inputTurnOffset, output: (id) => this.host.output(id) });
		const c = this.chunkFrom(messages, pick, `${summary}\n\n(Deterministic outline: the window was nearly full before the historian finished.)`, "fallback");
		c.appliedAt = now;
		c.appliedTurn = turn;
		this.chunks.set(c.n, c);
		this.unflushed.push(c);
	}

	/** After a turn: prepare chunks in the background while usage is above the prepare threshold. */
	prepareInBackground(ctx: ExtensionContext, opts: { force?: boolean } = {}): void {
		if (!this.enabled || this.preparing) return;
		const usage = this.host.usage();
		if (!opts.force && (!usage || usage.share < this.cfg.prepareThreshold)) return;
		this.preparing = true;
		const gen = this.generation;
		void this.prepare(ctx, gen, !!opts.force)
			.catch((err) => {
				this.lastError = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				this.preparing = false;
			});
	}

	/** Prepare chunks now (for `/realctx compress`). Resolves with the number prepared. */
	async prepareNow(ctx: ExtensionContext): Promise<{ prepared: number; error?: string }> {
		if (this.preparing) return { prepared: 0, error: "the historian is already running" };
		this.preparing = true;
		try {
			return { prepared: await this.prepare(ctx, this.generation, true) };
		} catch (err) {
			return { prepared: 0, error: err instanceof Error ? err.message : String(err) };
		} finally {
			this.preparing = false;
		}
	}

	private async prepare(ctx: ExtensionContext, gen: number, force: boolean): Promise<number> {
		const messages = this.lastInput;
		if (messages.length === 0) return 0;
		const usage = this.host.usage();
		let projected = usage ? usage.tokens - this.ready().reduce((s, c) => s + c.tokensBefore - c.tokensAfter, 0) : 0;
		let prepared = 0;
		for (let round = 0; round < 4; round++) {
			if (gen !== this.generation) return prepared;
			if (!force && usage && projected / usage.window < this.cfg.prepareThreshold) break;
			const pick = this.planChunk(messages, force);
			if (!pick) break;
			const c = await this.summarize(ctx, messages, pick);
			if (!c || gen !== this.generation) break;
			this.chunks.set(c.n, c);
			this.unflushed.push(c);
			projected -= c.tokensBefore - c.tokensAfter;
			prepared++;
			if (force && round >= 0 && !usage) break;
		}
		return prepared;
	}

	private storySoFar(): string[] {
		const out: string[] = [];
		let budget = this.cfg.storyTokens;
		for (const c of [...this.chunks.values()].sort((a, b) => b.n - a.n)) {
			const t = estimateTokens(c.text);
			if (t > budget) break;
			out.unshift(c.text);
			budget -= t;
		}
		return out;
	}

	private async summarize(ctx: ExtensionContext, messages: MessageView[], pick: { start: number; end: number; tokens: number }): Promise<HistoryChunk | undefined> {
		const e = this.host.engine();
		const s = this.host.settings();
		const h = historianFor(e, ctx);
		const part = messages.slice(pick.start, pick.end);
		const output = (id: string) => this.host.output(id);
		const before = messages.slice(0, pick.start).filter((m) => m.role === "assistant").length;
		const inside = part.filter((m) => m.role === "assistant").length;
		const turns: [number, number] = [this.inputTurnOffset + before + 1, this.inputTurnOffset + before + Math.max(1, inside)];
		if (!h.completer) {
			this.lastError = h.error ?? "no historian model";
			return undefined; // without a model, only the emergency fallback compresses
		}
		const wantFacts = s.history.captureFacts && s.capture.mode !== "off" && !this.host.subagent();
		const transcript = renderTranscript(part, { turnOffset: this.inputTurnOffset + before, output, maxTokens: Math.min(pick.tokens, s.history.maxChunkTokens) });
		const r = await h.completer({
			system: HISTORIAN_SYSTEM,
			prompt: buildHistorianPrompt({ transcript, storySoFar: this.storySoFar(), turns, summaryTokens: s.history.summaryMaxTokens, facts: wantFacts }),
			maxTokens: s.history.summaryMaxTokens * 2 + 600,
		});
		const parsed = parseHistorian(r.text, s.history.summaryMaxTokens);
		if (!parsed.summary) {
			this.lastError = "the historian returned no summary";
			return undefined;
		}
		this.lastError = undefined;
		this.lastModel = r.model;
		const c = this.chunkFrom(messages, pick, parsed.summary, r.model);
		if (c.tokensAfter >= c.tokensBefore) return undefined; // nothing gained
		try {
			e.db.logEvent(this.host.sessionId(), "history", undefined, c.tokensBefore - c.tokensAfter, { n: c.n, turns: c.turns, model: r.model, facts: parsed.facts.length });
		} catch {
			// telemetry is best effort
		}
		if (wantFacts && parsed.facts.length > 0) void this.captureFacts(ctx, parsed.facts).catch(() => {});
		return c;
	}

	private async captureFacts(ctx: ExtensionContext, facts: ReturnType<typeof parseHistorian>["facts"]): Promise<void> {
		const e = this.host.engine();
		const s = this.host.settings();
		const session = this.host.sessionId();
		const project = e.scopes(ctx.cwd).project;
		for (const f of facts) {
			if (!takeCaptureBudget(familyRoot(session), s.capture.maxPerSessionHour)) break;
			if (s.capture.mode === "suggest") {
				e.db.addSuggestion({ projectRoot: project?.root, session, caption: f.caption, content: f.content, paths: f.paths, cwd: ctx.cwd, origin: "history" });
				continue;
			}
			try {
				await e.remember({ caption: f.caption, content: f.content, paths: f.paths, source: "capture", origin: "history" }, { cwd: ctx.cwd, rewriter: rewriterFor(e, ctx).rewriter, queueOnFailure: true });
			} catch {
				// refused by the safety scan or the gate
			}
		}
		this.host.onCaptured?.(ctx);
	}

	// -------------------------------------------------------------------------
	// realctx_expand(history=[n]) and listings
	// -------------------------------------------------------------------------

	/** The original transcript of an applied (or ready) chunk, from the session branch. */
	expand(n: number, branch: MessageView[], opts: { lines?: string; grep?: string; maxTokens: number }): string {
		const c = this.chunks.get(n);
		if (!c) return `Not found: h${n} (parts: ${[...this.chunks.keys()].map((k) => `h${k}`).join(", ") || "none"})`;
		const keys = branch.map(messageKey);
		const s = keys.indexOf(c.startKey);
		const e = keys.indexOf(c.endKey, Math.max(0, s));
		if (s < 0 || e < 0) return `h${n} (turns ${c.turns[0]}-${c.turns[1]}) is not on the current branch any more.`;
		const offset = branch.slice(0, s).filter((m) => m.role === "assistant").length;
		const transcript = renderTranscript(branch.slice(s, e + 1), { turnOffset: offset, output: (id) => this.host.output(id), maxTokens: 1_000_000 });
		const view = viewOriginal(transcript, { lines: opts.lines, grep: opts.grep, maxTokens: opts.maxTokens });
		const head = `h${n} · turns ${c.turns[0]}-${c.turns[1]} · ${c.count} messages · ${fmtTokens(c.tokensBefore)} (tool outputs shortened)`;
		const more = view.truncated ? `\n(truncated: ${view.totalLines} lines in total)` : "";
		return `${head}${more}\n\n${view.text}`;
	}

	status(): HistoryStatus {
		const applied = this.applied();
		return {
			enabled: this.enabled,
			applied: applied.length,
			ready: this.ready().length,
			preparing: this.preparing,
			saved: applied.reduce((s, c) => s + Math.max(0, c.tokensBefore - c.tokensAfter), 0),
			model: this.lastModel,
			lastError: this.lastError,
		};
	}

	listing(): string[] {
		const all = [...this.chunks.values()].sort((a, b) => a.n - b.n);
		if (all.length === 0) {
			const u = this.host.usage();
			return [`No history compressed yet (the historian starts at ${Math.round(this.cfg.prepareThreshold * 100)}% of the safe window${u ? `; now ${Math.round(u.share * 100)}%` : ""}).`];
		}
		return all.map(
			(c) =>
				`h${c.n}  turns ${c.turns[0]}-${c.turns[1]} · ${c.count} msgs · ${fmtTokens(c.tokensBefore)} → ${fmtTokens(c.tokensAfter)} · ${c.model} · ${c.appliedAt !== undefined ? `applied at turn ${c.appliedTurn}` : "ready (applies with the next drop pass)"}`,
		);
	}

	/** Whether cutting the current transcript is possible at all (for diagnostics). */
	static cuttable(messages: MessageView[]): number {
		return boundaries(messages).size;
	}
}
