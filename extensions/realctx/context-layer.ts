/**
 * Context layer runtime (§6–§9, §13): captures tool outputs, judges spent ones in the
 * background, applies queued drops in one pass at the right moment, renders byte-stable
 * placeholders, and restores originals through realctx_expand.
 *
 * Everything that reaches the model is derived from immutable data (the frozen
 * placeholder text of each applied drop), so the rendered prefix stays byte-identical
 * between requests and the provider's prompt cache survives.
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { embeddingFingerprint, parseDuration, type Settings } from "../../src/config.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { chunkQuestions } from "../../src/judge.ts";
import {
	argsSignature,
	type ContentPart,
	contentText,
	contentTokens,
	fmtTokens,
	mtimesOf,
	type OutputMeta,
	OutputFiles,
	readStored,
	storedExists,
	summarizeArgs,
} from "../../src/outputs.ts";
import { displayPath, touchedPaths } from "../../src/paths.ts";
import {
	type AppliedDrop,
	buildExtractPrompt,
	buildSummaryPrompt,
	type CallInfo,
	cleanSummary,
	decideDrop,
	type DropState,
	dropQuestions,
	EXTRACT_SYSTEM,
	excerpt,
	fallbackSummary,
	filterOutputs,
	isMutating,
	isReading,
	buildUserExtractPrompt,
	parseFacts,
	USER_EXTRACT_SYSTEM,
	USER_FACT_CUE,
	userFactQuestion,
	userMessageWorthJudging,
	readDropSignals,
	type RuleReason,
	renderPlaceholder,
	stripForged,
	stripPathNotes,
	SUMMARY_SYSTEM,
	type Verdict,
	viewOriginal,
} from "../../src/policy.ts";
import { parseJsonObject } from "../../src/rewrite.ts";
import { redactSecrets, sanitizeForPrompt } from "../../src/safety.ts";
import { estimateTokens, ftsQuery, oneLine, sha256 } from "../../src/text.ts";
import { familyRoot, takeCaptureBudget } from "../../src/shared.ts";
import { estimateMessage, type MessageView, textOf } from "../../src/history.ts";
import { HistoryManager } from "./history-layer.ts";
import { rewriterFor } from "./tools.ts";

export type { MessageView };

export const IDS_ENTRY = "realctx-ids";
export const DROPS_ENTRY = "realctx-drops";

/** Loose views of Pi's agent messages: only the fields the context layer reads. */
interface TextPart {
	type: "text";
	text: string;
}
interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

interface BranchEntryView {
	type: string;
	customType?: string;
	data?: unknown;
	message?: MessageView;
}

interface PendingDrop {
	id: string;
	kind: AppliedDrop["kind"];
	source: AppliedDrop["source"];
	reason?: RuleReason;
	by?: number;
	summary?: string;
	savedAs?: string[];
}

interface Pin {
	/** Original output id that was expanded. */
	id: string;
	/** Turn of the expansion. */
	turn: number;
	/** Ordinal of the expansion's own result (when captured). */
	resultOrd?: number;
}

interface DropsData {
	drops?: AppliedDrop[];
	pins?: Pin[];
}

interface IdsData {
	metas?: OutputMeta[];
}

export interface LayerStatus {
	active: boolean;
	reason?: string;
	session?: string;
	parent?: string;
	subagent?: boolean;
	shadow: boolean;
	captured: number;
	applied: number;
	queued: number;
	reclaimed: number;
	usage?: { tokens: number; window: number; share: number };
	lastApply?: number;
	captureMode: string;
	pendingCaptures: number;
	judging: boolean;
	history?: ReturnType<HistoryManager["status"]>;
}

export interface LayerHost {
	engine(): MemoryEngine;
	settings(): Settings;
	/** Path-note ids whose tool result left the context (§13.3). */
	unshowNotes(ids: string[]): void;
	notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void;
	/** Facts were captured (status line refresh). */
	onCaptured?(ctx: ExtensionContext): void;
}

function branchEntries(ctx: ExtensionContext): BranchEntryView[] {
	// SAFETY: SessionEntry is a union whose members all have `type`; message entries carry
	// `message` (an AgentMessage) and custom entries `customType`/`data`. BranchEntryView only
	// names those optional fields, and every read below checks `type` before using them.
	return ctx.sessionManager.getBranch() as unknown as BranchEntryView[];
}

function usageTokens(u: NonNullable<MessageView["usage"]>): number {
	if (u.totalTokens && u.totalTokens > 0) return u.totalTokens;
	return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

export class ContextLayer {
	/** Captured outputs on this branch by toolCallId. */
	private metas = new Map<string, OutputMeta>();
	private byOrd = new Map<number, OutputMeta>();
	private applied = new Map<string, AppliedDrop>();
	private pending = new Map<string, PendingDrop>();
	private pins = new Map<string, Pin>();
	/** Tracker cache: paths and signature of every tool call seen (captured or not). */
	private callPaths = new Map<string, { paths: string[]; sig: string }>();
	private unflushedMetas: OutputMeta[] = [];
	private unflushedDrops: AppliedDrop[] = [];
	private unflushedPins: Pin[] = [];
	private assistants = 0;
	private files: OutputFiles | undefined;
	private sessionId = "";
	private projectKey = "";
	private generation = 0;
	private judging = false;
	private flushRequested = false;
	private lastApplyAt = 0;
	private lastRequestApplied = false;
	/** Parent session id when this session is a child (fork, clone, subagent). */
	parent: string | undefined;
	/** Started by another agent (subagent): its "user" messages are the parent agent's, not the user's. */
	subagent = false;
	/** Hashes of user-role messages sent by extensions (not typed by the user): never captured. */
	private extensionSent = new Set<string>();
	/** User messages already considered for capture (entry key → true). */
	private userSeen = new Set<string>();
	private embedding = false;
	private lastUsage: LayerStatus["usage"];
	/** Why the layer is off (conflict, disabled, store unavailable); undefined = active. */
	disabledReason: string | undefined;
	conflicts: string[] = [];

	private readonly host: LayerHost;
	/** History compression (§9.4): the historian's summaries of old turns. */
	readonly history: HistoryManager;

	constructor(host: LayerHost) {
		this.host = host;
		this.history = new HistoryManager({
			engine: () => host.engine(),
			settings: () => host.settings(),
			sessionId: () => this.sessionId,
			subagent: () => this.subagent,
			output: (id) => {
				const m = this.metas.get(id);
				if (!m) return undefined;
				return { ord: m.ord, label: oneLine(`${m.tool}${m.args ? ` ${m.args}` : ""}`, 60), placeholder: this.applied.get(id)?.text };
			},
			usage: () => this.lastUsage,
			assistants: () => this.assistants,
			onCaptured: (ctx) => host.onCaptured?.(ctx),
		});
	}

	get active(): boolean {
		return this.disabledReason === undefined;
	}

	private get cfg(): Settings["context"] {
		return this.host.settings().context;
	}

	// -------------------------------------------------------------------------
	// session lifecycle
	// -------------------------------------------------------------------------

	/** Rebuild the registry, drop set and pins from the current branch (session start, tree navigation, reload). */
	reset(ctx: ExtensionContext, conflicts: string[], family: { parent?: string; subagent?: boolean } = {}): void {
		this.parent = family.parent;
		this.subagent = !!family.subagent;
		this.generation++;
		this.metas.clear();
		this.byOrd.clear();
		this.applied.clear();
		this.pending.clear();
		this.pins.clear();
		this.unflushedMetas = [];
		this.unflushedDrops = [];
		this.unflushedPins = [];
		this.flushRequested = false;
		this.lastUsage = undefined;
		this.conflicts = conflicts;
		const s = this.host.settings();
		this.disabledReason = !s.context.enabled
			? "disabled in settings"
			: conflicts.length > 0 && s.context.conflictAction !== "ignore"
				? `another context manager is loaded: ${conflicts.join(", ")}${s.context.conflictAction === "disable" ? " (disabled; /reload to finish)" : ""}`
				: undefined;
		const sm = ctx.sessionManager;
		this.sessionId = typeof sm.getSessionId === "function" ? sm.getSessionId() : "";
		if (!this.sessionId) this.disabledReason ??= "no session id (ephemeral session)";
		try {
			const e = this.host.engine();
			this.projectKey = e.scopes(ctx.cwd).project?.key ?? `cwd-${sha256(ctx.cwd).slice(0, 16)}`;
			this.files = new OutputFiles(join(e.paths.base, "sessions"), this.projectKey, this.sessionId);
			e.db.touchOutputSession(this.sessionId, this.projectKey, this.files.dir);
		} catch (err) {
			this.files = undefined;
			this.disabledReason ??= `output store unavailable: ${err instanceof Error ? err.message : String(err)}`;
		}
		const branch = branchEntries(ctx);
		this.assistants = 0;
		const resultIds: string[] = [];
		for (const entry of branch) {
			if (entry.type === "message" && entry.message) {
				if (entry.message.role === "assistant") this.assistants++;
				if (entry.message.role === "toolResult" && entry.message.toolCallId) resultIds.push(entry.message.toolCallId);
			}
			if (entry.type !== "custom") continue;
			if (entry.customType === IDS_ENTRY) for (const m of (entry.data as IdsData | undefined)?.metas ?? []) this.addMeta(m);
			if (entry.customType === DROPS_ENTRY) {
				const d = entry.data as DropsData | undefined;
				for (const a of d?.drops ?? []) if (a && typeof a.id === "string" && typeof a.text === "string") this.applied.set(a.id, a);
				for (const p of d?.pins ?? []) if (p && typeof p.id === "string") this.pins.set(p.id, p);
			}
		}
		// Outputs captured but not yet persisted on the branch (crash, reload mid-turn): recover from the database.
		try {
			const db = this.host.engine().db;
			for (const id of resultIds) {
				if (this.metas.has(id)) continue;
				const row = db.getOutputMeta(this.sessionId, id);
				if (row) {
					const m = row.meta as OutputMeta;
					if (m && typeof m.ord === "number" && !this.byOrd.has(m.ord)) {
						this.addMeta(m);
						this.unflushedMetas.push(m);
					}
				}
			}
		} catch {
			// database busy: the registry entries are enough
		}
		// A child session (fork, clone) inherits its parent's registry: take copies of the
		// originals into its own store, so the two context layers never share files and the
		// parent's retention cannot break the child's placeholders.
		if (this.files) this.adoptInherited(this.files);
		this.history.reset(branch);
		// Never keep a drop whose original cannot be restored.
		for (const id of [...this.applied.keys()]) {
			const m = this.metas.get(id);
			if (!m || !storedExists(m.file)) this.applied.delete(id);
		}
	}

	private adoptInherited(files: OutputFiles): void {
		for (const m of [...this.metas.values()]) {
			if (m.file.startsWith(`${files.dir}/`) || !storedExists(m.file)) continue;
			const file = files.fileFor(m.ord, m.id);
			try {
				mkdirSync(files.dir, { recursive: true, mode: 0o700 });
				copyFileSync(m.file, file);
			} catch {
				continue;
			}
			const own: OutputMeta = { ...m, file };
			this.addMeta(own);
			this.unflushedMetas.push(own);
			try {
				const db = this.host.engine().db;
				const stored = readStored(file);
				const text = stored ? contentText(stored.content) : "";
				db.putOutput({ toolCallId: m.id, session: this.sessionId, project: this.projectKey, ord: m.ord, meta: own, file, head: `${m.tool} ${m.args}`, body: text.slice(0, 200_000) });
			} catch {
				// index unavailable: the registry entry is enough to restore
			}
		}
	}

	private addMeta(m: OutputMeta): void {
		if (!m || typeof m.id !== "string" || typeof m.ord !== "number") return;
		this.metas.set(m.id, m);
		this.byOrd.set(m.ord, m);
	}

	private nextOrd(): number {
		let max = 0;
		for (const k of this.byOrd.keys()) if (k > max) max = k;
		return max + 1;
	}

	/** Called on every assistant message_end. */
	onAssistant(m: MessageView): void {
		this.assistants++;
		if (!this.active || !m.usage) return;
		try {
			this.host.engine().db.logEvent(this.sessionId, "usage", undefined, m.usage.cacheRead ?? 0, {
				input: m.usage.input ?? 0,
				cacheWrite: m.usage.cacheWrite ?? 0,
				applied: this.lastRequestApplied,
			});
		} catch {
			// telemetry is best effort
		}
		this.lastRequestApplied = false;
	}

	/** Session entries to persist at turn end. */
	flushEntries(): Array<{ type: "custom"; customType: string; data: unknown }> {
		const out: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		if (this.unflushedMetas.length > 0) out.push({ type: "custom", customType: IDS_ENTRY, data: { metas: this.unflushedMetas } satisfies IdsData });
		if (this.unflushedDrops.length > 0 || this.unflushedPins.length > 0) {
			const data: DropsData = {};
			if (this.unflushedDrops.length > 0) data.drops = this.unflushedDrops;
			if (this.unflushedPins.length > 0) data.pins = this.unflushedPins;
			out.push({ type: "custom", customType: DROPS_ENTRY, data });
		}
		this.unflushedMetas = [];
		this.unflushedDrops = [];
		this.unflushedPins = [];
		out.push(...this.history.flushEntries());
		return out;
	}

	// -------------------------------------------------------------------------
	// capture (§6)
	// -------------------------------------------------------------------------

	/** Path tracker: paths touched by a call, computed once and cached (§13.4). */
	trackCall(toolCallId: string, tool: string, input: Record<string, unknown>, cwd: string): string[] {
		const sig = argsSignature(tool, input);
		const hit = this.callPaths.get(toolCallId);
		if (hit && hit.sig === sig) return hit.paths;
		let paths: string[] = [];
		try {
			paths = touchedPaths(tool, input, cwd);
		} catch {
			paths = [];
		}
		this.callPaths.set(toolCallId, { paths, sig });
		return paths;
	}

	/** Store the original of a tool output (before path notes are appended). */
	capture(
		ev: { toolCallId: string; toolName: string; input: Record<string, unknown>; content: ContentPart[]; isError: boolean },
		paths: string[],
		noteIds: string[],
		cwd: string,
	): void {
		if (!this.active || !this.files || this.metas.has(ev.toolCallId)) return;
		const tokens = contentTokens(ev.content);
		if (tokens < this.cfg.captureMinTokens) return;
		const ord = this.nextOrd();
		const file = this.files.fileFor(ord, ev.toolCallId);
		const capturedAt = Date.now();
		const expandOf =
			ev.toolName === "realctx_expand"
				? (Array.isArray(ev.input.ids) ? ev.input.ids : []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
				: undefined;
		const meta: OutputMeta = {
			id: ev.toolCallId,
			ord,
			tool: ev.toolName,
			args: summarizeArgs(ev.input, cwd),
			sig: argsSignature(ev.toolName, ev.input),
			tokens,
			turn: this.assistants,
			isError: ev.isError,
			paths: paths.slice(0, 32),
			mtimes: mtimesOf(paths),
			noteIds,
			file,
			capturedAt,
			...(expandOf && expandOf.length > 0 ? { expandOf } : {}),
		};
		try {
			this.files.write(file, { v: 1, id: ev.toolCallId, tool: ev.toolName, input: ev.input, content: ev.content, isError: ev.isError, capturedAt });
		} catch {
			return; // never register what cannot be restored
		}
		this.addMeta(meta);
		this.unflushedMetas.push(meta);
		try {
			const text = contentText(ev.content);
			this.host.engine().db.putOutput({
				toolCallId: ev.toolCallId,
				session: this.sessionId,
				project: this.projectKey,
				ord,
				meta,
				file,
				head: `${ev.toolName} ${meta.args}`,
				body: text.length > 200_000 ? `${text.slice(0, 150_000)}\n…\n${text.slice(-50_000)}` : text,
			});
		} catch {
			// index unavailable: the branch registry still restores it
		}
	}

	// -------------------------------------------------------------------------
	// transcript view
	// -------------------------------------------------------------------------

	private buildCalls(messages: MessageView[], cwd: string): CallInfo[] {
		const calls: CallInfo[] = [];
		const byId = new Map<string, CallInfo>();
		let turn = 0;
		let seq = 0;
		// Count turns from the end so they match the absolute counter even when the
		// transcript starts after an (uncancelled) compaction.
		const assistantsInView = messages.filter((m) => m.role === "assistant").length;
		const offset = Math.max(0, this.assistants - assistantsInView);
		for (const m of messages) {
			if (m.role === "assistant") {
				turn++;
				if (!Array.isArray(m.content)) continue;
				for (const p of m.content as ToolCallPart[]) {
					if (p?.type !== "toolCall" || typeof p.id !== "string") continue;
					const input = p.arguments ?? {};
					const paths = this.trackCall(p.id, p.name, input, cwd);
					const c: CallInfo = { id: p.id, tool: p.name, input, turn: turn + offset, seq: seq++, paths, sig: this.callPaths.get(p.id)?.sig };
					calls.push(c);
					byId.set(p.id, c);
				}
			} else if (m.role === "toolResult" && m.toolCallId) {
				const c = byId.get(m.toolCallId);
				if (!c) continue;
				c.isError = m.isError === true;
				const first = textOf(m.content)
					.split("\n")
					.find((l) => l.trim());
				c.firstLine = first ? oneLine(first, 100) : undefined;
			}
		}
		return calls;
	}

	private branchMessages(ctx: ExtensionContext): MessageView[] {
		const out: MessageView[] = [];
		for (const e of branchEntries(ctx)) if (e.type === "message" && e.message) out.push(e.message);
		return out;
	}

	private activePins(turn: number): Set<string> {
		const out = new Set<string>();
		for (const p of this.pins.values()) {
			if (turn - p.turn > this.cfg.repinTurns) continue;
			out.add(p.id);
			if (p.resultOrd !== undefined) {
				const r = this.byOrd.get(p.resultOrd);
				if (r) out.add(r.id);
			}
		}
		// Expansion results captured in the pin window are kept too.
		for (const m of this.metas.values()) if (m.expandOf && turn - m.turn <= this.cfg.repinTurns) out.add(m.id);
		return out;
	}

	private filter(messages: MessageView[], cwd: string) {
		const turn = this.assistants + 1;
		const calls = this.buildCalls(messages, cwd);
		const inView = new Set(calls.map((c) => c.id));
		const outputs = [...this.metas.values()].filter((m) => inView.has(m.id)).sort((a, b) => a.ord - b.ord);
		const done = new Set<string>([...this.applied.keys(), ...this.pending.keys()]);
		return { turn, calls, outputs, ...filterOutputs({ outputs, calls, turn, done, pinned: this.activePins(turn), settings: this.cfg }) };
	}

	// -------------------------------------------------------------------------
	// the `context` hook: apply and render (§8, §9)
	// -------------------------------------------------------------------------

	/** Transform the messages of one request. Never throws: on error the input passes through unchanged. */
	transform(messages: MessageView[], ctx: ExtensionContext): MessageView[] | undefined {
		try {
			let changed = false;
			// §9.2: forged placeholders / notes in assistant text are removed whole.
			for (const m of messages) {
				if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
				for (const p of m.content as TextPart[]) {
					if (p?.type !== "text" || typeof p.text !== "string") continue;
					const clean = stripForged(p.text);
					if (clean !== p.text) {
						p.text = clean;
						changed = true;
					}
				}
			}
			if (!this.active) return changed ? messages : undefined;

			const f = this.filter(messages, ctx.cwd);
			for (const r of f.rules) this.pending.set(r.id, { id: r.id, kind: r.kind, source: "rule", reason: r.reason, by: r.by });

			const usage = this.estimateUsage(messages, ctx);
			const now = Date.now();
			const lastResponse = [...messages].reverse().find((m) => m.role === "assistant")?.timestamp ?? 0;
			const cold = lastResponse > 0 && now - lastResponse >= this.ttlMs(ctx);
			const share = usage?.share ?? 0;
			const emergency = share >= this.cfg.emergencyThreshold;
			// Drops and history summaries apply together, so the prefix is rebuilt once (§8.2).
			const trigger = this.flushRequested || cold || share >= this.cfg.applyThreshold || emergency;
			this.flushRequested = false;
			if ((trigger && this.pending.size > 0) || emergency) {
				const before = this.applied.size;
				this.applyPending(f.turn);
				if (emergency && usage) this.emergencyReclaim(f.gray, usage, f.turn);
				if (this.applied.size > before) {
					this.lastApplyAt = now;
					this.lastRequestApplied = true;
				}
			}
			// The historian works from the transcript as Pi sent it (dropped outputs are labelled).
			const raw = messages.slice();
			this.history.observe(raw, this.assistants);

			// Render: frozen placeholders replace dropped results.
			if (this.applied.size > 0) {
				for (let i = 0; i < messages.length; i++) {
					const m = messages[i];
					if (m.role !== "toolResult" || !m.toolCallId) continue;
					const a = this.applied.get(m.toolCallId);
					if (!a) continue;
					messages[i] = { ...m, content: [{ type: "text", text: a.text }] };
					changed = true;
				}
			}
			// History: chunks the historian prepared replace old turns; at the emergency threshold a
			// deterministic outline is used when nothing is ready (§9.4).
			const afterDrops = usage ? this.estimateUsage(messages, ctx) : undefined;
			const historyEmergency = !!afterDrops && afterDrops.share >= this.cfg.emergencyThreshold;
			const appliedBefore = this.history.status().applied;
			const withHistory = this.history.transform(messages, { apply: trigger, emergency: historyEmergency, turn: f.turn });
			if (this.history.status().applied > appliedBefore) {
				this.lastApplyAt = now;
				this.lastRequestApplied = true;
			}
			if (withHistory) {
				messages = withHistory;
				changed = true;
			}
			this.lastUsage = usage ? this.estimateUsage(messages, ctx) : undefined;
			return changed ? messages : undefined;
		} catch (err) {
			// §18: pass messages through unchanged, log loudly.
			console.error(`[realctx] context transform failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
			return undefined;
		}
	}

	/** Request `/realctx flush`: apply queued drops at the next request, ignoring the cache TTL. */
	requestFlush(): number {
		this.flushRequested = true;
		return this.pending.size + this.history.status().ready;
	}

	private ttlMs(ctx: ExtensionContext): number {
		const c = this.cfg;
		const m = ctx.model;
		const spec = (m && (c.cacheTtlByModel[`${m.provider}/${m.id}`] ?? c.cacheTtlByModel[m.id])) ?? c.cacheTtl;
		return parseDuration(spec, 300_000);
	}

	private estimateUsage(messages: MessageView[], ctx: ExtensionContext): LayerStatus["usage"] {
		const window = ctx.model?.contextWindow ?? 0;
		if (!window) return undefined;
		const reserve = Math.min(ctx.model?.maxTokens ?? 0, Math.floor(window * 0.25));
		const safe = Math.max(1, window - reserve);
		let idx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant" && m.usage && m.stopReason !== "error" && m.stopReason !== "aborted" && usageTokens(m.usage) > 0) {
				idx = i;
				break;
			}
		}
		let tokens: number;
		if (idx >= 0) {
			const at = messages[idx];
			tokens = usageTokens(at.usage as NonNullable<MessageView["usage"]>);
			for (let i = idx + 1; i < messages.length; i++) tokens += estimateMessage(messages[i]);
			const stamp = at.timestamp ?? 0;
			for (const a of this.applied.values()) if (a.at > stamp) tokens -= a.saved;
			tokens -= this.history.savedSince(stamp);
		} else {
			tokens = estimateTokens(ctx.getSystemPrompt?.() ?? "");
			for (const m of messages) tokens += estimateMessage(m);
		}
		tokens = Math.max(0, tokens);
		return { tokens, window: safe, share: tokens / safe };
	}

	private placeholderFor(p: PendingDrop, meta: OutputMeta): string {
		return renderPlaceholder(meta, p.kind, {
			summary: p.summary,
			savedAs: p.savedAs,
			reason: p.reason,
			by: p.by,
		});
	}

	private applyPending(turn: number): void {
		const db = this.safeDb();
		for (const p of this.pending.values()) {
			const meta = this.metas.get(p.id);
			if (!meta || !storedExists(meta.file)) continue; // never drop what cannot be restored
			const text = this.placeholderFor(p, meta);
			const saved = Math.max(0, meta.tokens - estimateTokens(text));
			const a: AppliedDrop = { id: p.id, ord: meta.ord, kind: p.kind, source: p.source, text, saved, turn, at: Date.now(), ...(p.savedAs ? { savedAs: p.savedAs } : {}) };
			this.applied.set(p.id, a);
			this.unflushedDrops.push(a);
			if (meta.noteIds.length > 0) this.host.unshowNotes(meta.noteIds);
			db?.logEvent(this.sessionId, p.source, p.id, saved, { kind: p.kind, reason: p.reason });
		}
		this.pending.clear();
		this.embedDroppedInBackground();
	}

	/** §8.3: drop the largest unprotected outputs until usage is under the apply threshold. */
	private emergencyReclaim(gray: OutputMeta[], usage: NonNullable<LayerStatus["usage"]>, turn: number): void {
		let tokens = usage.tokens;
		const target = this.cfg.applyThreshold * usage.window;
		const savedNow = [...this.applied.values()].filter((a) => a.turn === turn).reduce((s, a) => s + a.saved, 0);
		tokens -= savedNow;
		const order = [...gray].filter((o) => !this.applied.has(o.id)).sort((a, b) => b.tokens - a.tokens || a.ord - b.ord);
		for (const o of order) {
			if (tokens <= target) break;
			this.pending.set(o.id, { id: o.id, kind: "drop", source: "emergency" });
			tokens -= o.tokens;
		}
		this.applyPending(turn);
	}

	/** Verdict cache key: tool call ids are only unique within a session. */
	private verdictKey(toolCallId: string): string {
		return `${this.sessionId}:${toolCallId}`;
	}

	private safeDb() {
		try {
			return this.host.engine().db;
		} catch {
			return undefined;
		}
	}

	// -------------------------------------------------------------------------
	// background judging (§7.2–§7.5, §13.1)
	// -------------------------------------------------------------------------

	/** Queue drop candidates in the background after a turn. Never blocks the agent. */
	judgeInBackground(ctx: ExtensionContext): void {
		if (!this.active || this.judging) return;
		const s = this.host.settings();
		if (s.judge.maxPerPass === 0) return;
		this.judging = true;
		const gen = this.generation;
		void this.judgePass(ctx, gen)
			.catch((err) => console.error(`[realctx] judge pass failed: ${err instanceof Error ? err.message : String(err)}`))
			.finally(() => {
				this.judging = false;
			});
	}

	private goalOf(messages: MessageView[]): { text: string; key: string } {
		let user = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "user") {
				user = textOf(m.content).trim();
				if (user) break;
			}
		}
		const protectedTools = new Set(this.cfg.protectedTools.map((t) => t.toLowerCase()));
		let todo = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "toolResult" && m.toolName && protectedTools.has(m.toolName.toLowerCase()) && /todo|plan/i.test(m.toolName)) {
				todo = textOf(m.content).trim();
				break;
			}
		}
		const goal = oneLine(redactSecrets(user), 1200) + (todo ? `\nTodo: ${oneLine(redactSecrets(todo), 800)}` : "");
		return { text: sanitizeForPrompt(goal), key: sha256(user).slice(0, 16) };
	}

	private sinceThen(calls: CallInfo[], after: number, cwd: string): string[] {
		const out: string[] = [];
		for (const c of calls) {
			if (c.seq <= after) continue;
			const p = (c.paths ?? []).slice(0, 2).map((x) => displayPath(x, cwd));
			const where = p.join(", ");
			let line: string;
			if (isMutating(c.tool)) line = `edited ${where || summarizeArgs(c.input, cwd, 60)}`;
			else if (isReading(c.tool)) line = `read ${where || summarizeArgs(c.input, cwd, 60)}`;
			else if (c.tool === "bash") line = `ran ${summarizeArgs(c.input, cwd, 60)}`;
			else line = `${c.tool} ${summarizeArgs(c.input, cwd, 60)}`;
			if (c.isError) line += " (failed)";
			if (c.firstLine && !isReading(c.tool)) line += `: ${sanitizeForPrompt(redactSecrets(c.firstLine)).slice(0, 80)}`;
			out.push(oneLine(line, 160));
		}
		return out.slice(-12);
	}

	private knownMemories(meta: OutputMeta, cwd: string): string[] {
		try {
			const e = this.host.engine();
			const ids = new Set(meta.noteIds);
			const rows = meta.paths.length > 0 ? e.notesForPaths(cwd, meta.paths, new Set()).map((n) => n.memory) : [];
			const byId = new Map(rows.map((m) => [m.id, m]));
			if (ids.size > 0) for (const m of e.getMemories(cwd, [...ids]).found) byId.set(m.id, m);
			return [...byId.values()].slice(0, 12).map((m) => `[${m.id.slice(0, 4)}…] ${sanitizeForPrompt(oneLine(m.caption, 140))}`);
		} catch {
			return [];
		}
	}

	/** Judge state for one candidate (also used by `/realctx debug`). */
	buildState(meta: OutputMeta, calls: CallInfo[], goal: string, turn: number, cwd: string): DropState | undefined {
		const stored = readStored(meta.file);
		if (!stored) return undefined;
		const call = calls.find((c) => c.id === meta.id);
		const args: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(stored.input ?? {})) {
			if (typeof v === "string") args[k] = oneLine(redactSecrets(/path|file/i.test(k) ? displayPath(v, cwd) : v), 200);
			else if (typeof v === "number" || typeof v === "boolean") args[k] = v;
		}
		return {
			current_goal: goal,
			candidate: {
				id: `t${meta.ord}`,
				tool: meta.tool,
				args,
				tokens: meta.tokens,
				turns_ago: Math.max(0, turn - meta.turn),
				...(meta.isError ? { error: true } : {}),
				excerpt: excerpt(stripPathNotes(contentText(stored.content))),
			},
			since_then: this.sinceThen(calls, call?.seq ?? -1, cwd),
			known_memories: this.knownMemories(meta, cwd),
		};
	}

	/** Ask the judge about one candidate. Returns the raw answers and the verdict. */
	async judgeOne(state: DropState, signal?: AbortSignal): Promise<{ answers: Record<string, unknown>; verdict?: Verdict }> {
		const e = this.host.engine();
		const s = this.host.settings();
		const answers: Record<string, unknown> = {};
		for (const chunk of chunkQuestions(dropQuestions(), s.semif.maxQuestions)) {
			const r = await e.semifClient.evaluate(JSON.stringify(state), chunk, signal, "drop");
			Object.assign(answers, r.response.answers);
		}
		const signals = readDropSignals(answers as Parameters<typeof readDropSignals>[0]);
		return { answers, verdict: signals ? decideDrop(signals, s.context, s.capture.pDurable) : undefined };
	}

	private async judgePass(ctx: ExtensionContext, gen: number): Promise<void> {
		const e = this.host.engine();
		const s = this.host.settings();
		const messages = this.branchMessages(ctx);
		const f = this.filter(messages, ctx.cwd);
		const goal = this.goalOf(messages);
		const db = e.db;
		let judged = 0;
		for (const meta of f.gray) {
			if (gen !== this.generation) return;
			if (this.applied.has(meta.id) || this.pending.has(meta.id)) continue;
			const cached = db.getVerdict(this.verdictKey(meta.id));
			let verdict: (Verdict & { summary?: string; savedAs?: string[] }) | undefined;
			if (cached && cached.goal === goal.key) {
				verdict = cached.data as Verdict & { summary?: string; savedAs?: string[] };
				if (verdict.action === "keep") continue;
			} else {
				if (!e.semifClient.configured || judged >= s.judge.maxPerPass) continue;
				const state = this.buildState(meta, f.calls, goal.text, f.turn, ctx.cwd);
				if (!state) continue;
				judged++;
				let r: Awaited<ReturnType<ContextLayer["judgeOne"]>>;
				try {
					r = await this.judgeOne(state);
				} catch {
					return; // §13.5: judge unavailable → keep everything, re-judge later
				}
				if (!r.verdict || gen !== this.generation) continue;
				verdict = r.verdict;
				if (verdict.capture && s.capture.mode !== "off") {
					const cap = await this.captureFacts(ctx, meta, gen);
					if (cap.memoryBacked && r.verdict.action !== "drop") {
						const again = decideDrop(r.verdict.signals, s.context, s.capture.pDurable, true);
						verdict = { ...again, capture: true };
					}
					if (cap.savedAs.length > 0) verdict.savedAs = cap.savedAs;
				}
				if (verdict.action === "summarize") verdict.summary = await this.summarize(ctx, meta);
				db.putVerdict(this.verdictKey(meta.id), goal.key, verdict);
				db.logEvent(this.sessionId, s.judge.shadow ? "shadow" : "verdict", meta.id, meta.tokens, { action: verdict.action, reasons: verdict.reasons });
			}
			if (gen !== this.generation || s.judge.shadow || verdict.action === "keep") continue;
			this.pending.set(meta.id, {
				id: meta.id,
				kind: verdict.action === "summarize" ? "summary" : "drop",
				source: "judge",
				summary: verdict.summary,
				savedAs: verdict.savedAs,
			});
		}
	}

	private async summarize(ctx: ExtensionContext, meta: OutputMeta): Promise<string> {
		const stored = readStored(meta.file);
		const text = stored ? stripPathNotes(contentText(stored.content)) : "";
		const paths = meta.paths.map((p) => displayPath(p, ctx.cwd));
		try {
			const rw = rewriterFor(this.host.engine(), ctx);
			if (rw.completer) {
				const r = await rw.completer({ system: SUMMARY_SYSTEM, prompt: buildSummaryPrompt(meta, text), maxTokens: 300 });
				const clean = cleanSummary(r.text);
				if (clean) return clean;
			}
		} catch {
			// fall back below
		}
		return cleanSummary(fallbackSummary(text, paths));
	}

	/** §13.1: extract durable facts from an output about to be dropped. */
	private async captureFacts(ctx: ExtensionContext, meta: OutputMeta, gen: number): Promise<{ savedAs: string[]; memoryBacked: boolean }> {
		const none = { savedAs: [], memoryBacked: false };
		const s = this.host.settings();
		const e = this.host.engine();
		const rw = rewriterFor(e, ctx);
		if (!rw.completer) return none;
		const stored = readStored(meta.file);
		if (!stored) return none;
		if (!takeCaptureBudget(familyRoot(this.sessionId), s.capture.maxPerSessionHour)) return none;
		const text = stripPathNotes(contentText(stored.content));
		let facts: ReturnType<typeof parseFacts>;
		try {
			const r = await rw.completer({ system: EXTRACT_SYSTEM, prompt: buildExtractPrompt(meta, redactSecrets(text), meta.paths.map((p) => displayPath(p, ctx.cwd))), maxTokens: 1200 });
			facts = parseFacts(parseJsonObject(r.text));
		} catch {
			return none;
		}
		if (facts.length === 0 || gen !== this.generation) return none;
		const project = e.scopes(ctx.cwd).project;
		e.db.logEvent(this.sessionId, "capture", meta.id, 0, { facts: facts.length, mode: s.capture.mode });
		if (s.capture.mode === "suggest") {
			for (const fct of facts) {
				e.db.addSuggestion({ projectRoot: project?.root, session: this.sessionId, toolCallId: meta.id, caption: fct.caption, content: fct.content, paths: fct.paths ?? this.defaultPaths(meta, project?.root), cwd: ctx.cwd });
			}
			return none;
		}
		const savedAs: string[] = [];
		let backed = true;
		for (const fct of facts) {
			try {
				const out = await e.remember(
					{ caption: fct.caption, content: fct.content, paths: fct.paths ?? this.defaultPaths(meta, project?.root), source: "capture", origin: "output" },
					{ cwd: ctx.cwd, rewriter: rw.rewriter, queueOnFailure: true },
				);
				if (out.status !== "reinforced") backed = false;
				if (out.memory && ["added", "edited", "merged", "reinforced"].includes(out.status)) savedAs.push(out.memory.id);
			} catch {
				backed = false;
			}
		}
		return { savedAs: [...new Set(savedAs)].slice(0, 3), memoryBacked: backed && savedAs.length > 0 };
	}

	/** Tracker paths inside the project, as default `paths` for captured facts. */
	private defaultPaths(meta: OutputMeta, root: string | undefined): string[] | undefined {
		if (!root) return undefined;
		const inside = meta.paths.filter((p) => p === root || p.startsWith(`${root}/`)).filter((p) => p !== root);
		return inside.length > 0 && inside.length <= 4 ? inside : undefined;
	}

	// -------------------------------------------------------------------------
	// realctx_expand (§9.3) and output recall
	// -------------------------------------------------------------------------

	expand(params: { ids: number[]; lines?: string; grep?: string }, cwd: string, ctx: ExtensionContext): { content: ContentPart[]; details: Record<string, unknown> } {
		const turn = this.assistants;
		const ids = [...new Set(params.ids.map((n) => Math.trunc(Number(n))).filter((n) => n > 0))].slice(0, 16);
		if (ids.length === 0) throw new Error("pass ids, e.g. ids=[42] for a placeholder [#42 …]");
		const budget = Math.max(200, Math.floor(this.cfg.expandMaxTokens / ids.length));
		const parts: ContentPart[] = [];
		const restored: number[] = [];
		const missing: number[] = [];
		const calls = this.buildCalls(this.branchMessages(ctx), cwd);
		for (const ord of ids) {
			const meta = this.byOrd.get(ord);
			const stored = meta ? readStored(meta.file) : undefined;
			if (!meta || !stored) {
				missing.push(ord);
				continue;
			}
			// Expanding a dropped expansion restores what it restored.
			const pin = this.pins.get(meta.id);
			if (pin && turn - pin.turn <= this.cfg.repinTurns && !params.lines && !params.grep) {
				const r = pin.resultOrd !== undefined ? this.byOrd.get(pin.resultOrd) : undefined;
				if (!r || !this.applied.has(r.id)) {
					parts.push({ type: "text", text: `#${ord} was already restored at turn ${pin.turn}${r ? ` (#${r.ord})` : ""}; see that result above.` });
					continue;
				}
			}
			const head = [`#${ord} · ${meta.tool}${meta.args ? ` ${meta.args}` : ""} · turn ${meta.turn} · ${fmtTokens(meta.tokens)}${meta.isError ? " · error" : ""}`];
			const stale = this.staleness(meta, calls);
			if (stale) head.push(stale);
			const text = stripPathNotes(contentText(stored.content.filter((p) => p.type === "text")));
			const view = viewOriginal(text, { lines: params.lines, grep: params.grep, maxTokens: budget });
			if (view.truncated) {
				head.push(
					`(truncated: first ~${fmtTokens(budget)} of ${view.totalLines} lines shown)`,
				);
			}
			parts.push({ type: "text", text: `${head.join("\n")}\n\n${view.text}` });
			if (!params.lines && !params.grep) for (const p of stored.content) if (p.type === "image") parts.push(p);
			restored.push(ord);
			const a = this.applied.get(meta.id);
			const p: Pin = { id: meta.id, turn };
			this.pins.set(meta.id, p);
			this.unflushedPins.push(p);
			this.safeDb()?.logEvent(this.sessionId, "expand", meta.id, meta.tokens, { turnsSinceDrop: a ? turn - a.turn : undefined, partial: !!(params.lines || params.grep) });
		}
		if (missing.length > 0) parts.push({ type: "text", text: `Not found: ${missing.map((n) => `#${n}`).join(", ")} (only outputs captured in this session can be expanded).` });
		return { content: parts.length ? parts : [{ type: "text", text: "nothing to expand" }], details: { restored, missing } };
	}

	/** Transcripts of history parts (realctx_expand(history=[n])). */
	expandHistory(parts: number[], opts: { lines?: string; grep?: string }, ctx: ExtensionContext): string[] {
		const branch = this.branchMessages(ctx);
		const unique = [...new Set(parts.map((n) => Math.trunc(Number(n))).filter((n) => n > 0))].slice(0, 4);
		const budget = Math.max(400, Math.floor(this.cfg.expandMaxTokens / Math.max(1, unique.length)));
		return unique.map((n) => this.history.expand(n, branch, { ...opts, maxTokens: budget }));
	}

	/** Link a pin to the captured result of the realctx_expand call that created it. */
	linkExpansion(toolCallId: string, ids: unknown): void {
		const result = this.metas.get(toolCallId);
		if (!result || !Array.isArray(ids)) return;
		for (const n of ids) {
			const meta = this.byOrd.get(Number(n));
			const pin = meta ? this.pins.get(meta.id) : undefined;
			if (pin && pin.resultOrd === undefined) {
				pin.resultOrd = result.ord;
				this.unflushedPins.push(pin);
			}
		}
	}

	private staleness(meta: OutputMeta, calls: CallInfo[]): string | undefined {
		const callSeq = calls.find((c) => c.id === meta.id)?.seq ?? -1;
		const edited = calls.find((c) => c.seq > callSeq && isMutating(c.tool) && (c.paths ?? []).some((p) => meta.paths.includes(p)));
		let changed = !!edited;
		if (!changed) {
			for (const [p, mt] of Object.entries(meta.mtimes)) {
				try {
					if (statSync(p).mtimeMs !== mt) changed = true;
				} catch {
					changed = true;
				}
				if (changed) break;
			}
		}
		if (!changed) return undefined;
		return `Note: file edited since turn ${meta.turn}${edited ? ` (turn ${edited.turn})` : ""}; re-read for the current version.`;
	}

	/**
	 * Dropped outputs of THIS session's branch matching the queries (realctx_recall
	 * sources=output): BM25 and, when the embedding endpoint is set, vector search, fused
	 * by reciprocal rank. Other sessions' outputs are never searched.
	 */
	async searchDropped(queries: string[], limit = 8, signal?: AbortSignal): Promise<Array<{ meta: OutputMeta; drop: AppliedDrop; score: number; via: string }>> {
		const ids = [...this.applied.keys()];
		if (ids.length === 0 || queries.length === 0) return [];
		this.host.engine().reloadSettingsIfChanged();
		const db = this.safeDb();
		if (!db) return [];
		const lists: Array<{ kind: "fts" | "vec"; hits: Array<{ toolCallId: string; score: number }> }> = [];
		const q = ftsQuery(queries);
		if (q) lists.push({ kind: "fts", hits: db.searchOutputs(this.sessionId, ids, q, limit * 3) });
		const e = this.host.engine();
		if (this.cfg.embedDropped && e.embeddingClient.configured) {
			try {
				await this.embedDropped(signal);
				const fp = embeddingFingerprint(e.settings);
				const { vectors } = await e.embeddingClient.embed(queries.slice(0, 4), "query", signal);
				const best = new Map<string, number>();
				for (const v of vectors) for (const h of db.vecSearchOutputs(this.sessionId, ids, fp, v, limit * 3)) best.set(h.toolCallId, Math.max(best.get(h.toolCallId) ?? -1, h.score));
				lists.push({
					kind: "vec",
					hits: [...best.entries()]
						.filter(([, sc]) => sc >= 0.3)
						.map(([toolCallId, score]) => ({ toolCallId, score }))
						.sort((a, b) => b.score - a.score),
				});
			} catch {
				// embedding API down: keyword hits only
			}
		}
		const fused = new Map<string, { score: number; via: Set<string> }>();
		for (const l of lists) {
			l.hits.forEach((h, i) => {
				const cur = fused.get(h.toolCallId) ?? { score: 0, via: new Set<string>() };
				cur.score += 1 / (60 + i + 1);
				cur.via.add(l.kind);
				fused.set(h.toolCallId, cur);
			});
		}
		const out: Array<{ meta: OutputMeta; drop: AppliedDrop; score: number; via: string }> = [];
		for (const [id, f] of fused) {
			const meta = this.metas.get(id);
			const drop = this.applied.get(id);
			if (!meta || !drop) continue;
			// Relevance first, recency breaks ties.
			out.push({ meta, drop, score: f.score + meta.ord / Math.max(1, this.byOrd.size) / 1e4, via: [...f.via].sort().join("+") });
		}
		return out.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Embed dropped outputs of this session that have no vector yet (bounded per call). */
	private async embedDropped(signal?: AbortSignal): Promise<number> {
		const e = this.host.engine();
		if (!this.cfg.embedDropped || !e.embeddingClient.configured) return 0;
		const fp = embeddingFingerprint(e.settings);
		const ids = e.db.outputsWithoutVec(this.sessionId, [...this.applied.keys()], fp).slice(0, 32);
		if (ids.length === 0) return 0;
		const texts: string[] = [];
		const keep: string[] = [];
		for (const id of ids) {
			const t = e.db.outputText(this.sessionId, id);
			if (!t) continue;
			// Redacted, bounded: head of the output is what identifies it best.
			texts.push(redactSecrets(t).slice(0, 6000));
			keep.push(id);
		}
		if (texts.length === 0) return 0;
		const { vectors } = await e.embeddingClient.embed(texts, "document", signal);
		vectors.forEach((v, i) => e.db.putOutputVec(keep[i], this.sessionId, fp, v));
		return vectors.length;
	}

	private embedDroppedInBackground(): void {
		if (this.embedding) return;
		this.embedding = true;
		void this.embedDropped()
			.catch(() => {})
			.finally(() => {
				this.embedding = false;
			});
	}

	// -------------------------------------------------------------------------
	// user-message capture (§13.1, extended to what the user says)
	// -------------------------------------------------------------------------

	/**
	 * After a turn: consider the latest user message of the branch for capture. The judge
	 * (when configured) decides whether it states a lasting fact; without one, a keyword
	 * cue is required. Extraction uses the rewrite model; results follow capture.mode.
	 */
	/** Mark the next user message with this text as sent by an extension (not the user). */
	skipNextUser(text: string): void {
		this.extensionSent.add(sha256(text.trim()));
		if (this.extensionSent.size > 64) this.extensionSent.delete(this.extensionSent.values().next().value as string);
	}

	captureUserInBackground(ctx: ExtensionContext): void {
		const s = this.host.settings();
		if (!this.active || this.subagent || s.capture.mode === "off" || !s.capture.userMessages) return;
		const entries = branchEntries(ctx);
		let user: { key: string; text: string } | undefined;
		let prevReply: string | undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			const m = entries[i].message;
			if (entries[i].type !== "message" || !m) continue;
			if (!user && m.role === "user") {
				const text = textOf(m.content).trim();
				user = { key: `${m.timestamp ?? i}:${sha256(text).slice(0, 12)}`, text };
				continue;
			}
			if (user && m.role === "assistant") {
				prevReply = textOf(m.content).trim() || undefined;
				break;
			}
		}
		if (!user || this.userSeen.has(user.key)) return;
		this.userSeen.add(user.key);
		if (this.extensionSent.delete(sha256(user.text))) return;
		if (!userMessageWorthJudging(user.text, s.capture.userMinChars)) return;
		const gen = this.generation;
		const u = user;
		void this.captureUser(ctx, u.key, u.text, prevReply, gen).catch((err) => console.error(`[realctx] user capture failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	private async captureUser(ctx: ExtensionContext, key: string, text: string, prevReply: string | undefined, gen: number): Promise<void> {
		const e = this.host.engine();
		const s = this.host.settings();
		const clean = redactSecrets(text);
		if (e.semifClient.configured) {
			const state = JSON.stringify({ user_message: sanitizeForPrompt(clean).slice(0, 6000), previous_agent_reply: prevReply ? sanitizeForPrompt(redactSecrets(prevReply)).slice(0, 2000) : undefined });
			const r = await e.semifClient.evaluate(state, userFactQuestion(), undefined, "drop");
			const a = r.response.answers.durable_user_fact;
			const p = a?.type === "noul" ? a.noul : 0;
			e.db.logEvent(this.sessionId, "user_judged", undefined, 0, { key, p });
			if (p < s.capture.pDurable) return;
		} else if (!USER_FACT_CUE.test(clean)) return;
		const rw = rewriterFor(e, ctx);
		if (!rw.completer || gen !== this.generation) return;
		if (!takeCaptureBudget(familyRoot(this.sessionId), s.capture.maxPerSessionHour)) return;
		let facts: ReturnType<typeof parseFacts>;
		try {
			const r = await rw.completer({ system: USER_EXTRACT_SYSTEM, prompt: buildUserExtractPrompt(clean, prevReply ? redactSecrets(prevReply) : undefined), maxTokens: 1000 });
			facts = parseFacts(parseJsonObject(r.text));
		} catch {
			return;
		}
		if (facts.length === 0 || gen !== this.generation) return;
		const project = e.scopes(ctx.cwd).project;
		e.db.logEvent(this.sessionId, "capture", undefined, 0, { facts: facts.length, mode: s.capture.mode, origin: "user" });
		for (const fct of facts) {
			if (s.capture.mode === "suggest") {
				e.db.addSuggestion({ projectRoot: project?.root, session: this.sessionId, caption: fct.caption, content: fct.content, paths: fct.paths, cwd: ctx.cwd, origin: "user" });
				continue;
			}
			try {
				await e.remember({ caption: fct.caption, content: fct.content, paths: fct.paths, source: "capture", origin: "user" }, { cwd: ctx.cwd, rewriter: rw.rewriter, queueOnFailure: true });
			} catch {
				// refused by the safety scan or the gate: nothing to do
			}
		}
		this.host.onCaptured?.(ctx);
	}

	// -------------------------------------------------------------------------
	// status and listings
	// -------------------------------------------------------------------------

	status(): LayerStatus {
		const s = this.host.settings();
		let pendingCaptures = 0;
		try {
			const e = this.host.engine();
			pendingCaptures = e.db.countSuggestions(undefined);
		} catch {
			// ignore
		}
		return {
			active: this.active,
			reason: this.disabledReason,
			session: this.sessionId,
			parent: this.parent,
			subagent: this.subagent,
			shadow: s.judge.shadow,
			captured: this.metas.size,
			applied: this.applied.size,
			queued: this.pending.size,
			reclaimed: [...this.applied.values()].reduce((n, a) => n + a.saved, 0),
			usage: this.lastUsage,
			lastApply: this.lastApplyAt || undefined,
			captureMode: s.capture.mode,
			pendingCaptures,
			judging: this.judging,
			history: this.history.status(),
		};
	}

	/** Lines for `/realctx outputs`. */
	listing(ctx: ExtensionContext): string[] {
		const messages = this.branchMessages(ctx);
		const f = this.filter(messages, ctx.cwd);
		const db = this.safeDb();
		const lines: string[] = [];
		const prot = f.protected;
		const rules = new Map(f.rules.map((r) => [r.id, r]));
		for (const m of [...this.metas.values()].sort((a, b) => a.ord - b.ord)) {
			const a = this.applied.get(m.id);
			const p = this.pending.get(m.id);
			const v = db?.getVerdict(this.verdictKey(m.id))?.data as Verdict | undefined;
			let state: string;
			if (a) state = `${a.kind === "summary" ? "summarized" : a.kind === "shrink" ? "superseded" : "dropped"} (${a.source}, turn ${a.turn}, −${fmtTokens(a.saved)})`;
			else if (p) state = `queued ${p.kind} (${p.source}${p.reason ? `: ${p.reason}` : ""})`;
			else if (rules.has(m.id)) state = `rule: ${rules.get(m.id)?.reason}`;
			else if (prot.has(m.id)) state = `protected: ${prot.get(m.id)}`;
			else state = "gray zone";
			const verdict = v ? ` · judge: ${v.action}${this.host.settings().judge.shadow ? " (shadow)" : ""}` : "";
			lines.push(`#${m.ord}  ${m.tool} ${m.args}  · turn ${m.turn} · ${fmtTokens(m.tokens)}  → ${state}${verdict}`);
		}
		if (lines.length === 0) lines.push(`No outputs captured yet (outputs under ${this.cfg.captureMinTokens} tokens are not captured).`);
		return lines;
	}

	metaByOrd(ord: number): OutputMeta | undefined {
		return this.byOrd.get(ord);
	}

	/** Dry-run state for `/realctx debug #N`. */
	debugState(ord: number, ctx: ExtensionContext): DropState | undefined {
		const meta = this.byOrd.get(ord);
		if (!meta) return undefined;
		const messages = this.branchMessages(ctx);
		const f = this.filter(messages, ctx.cwd);
		return this.buildState(meta, f.calls, this.goalOf(messages).text, f.turn, ctx.cwd);
	}

	/** Remove stored originals of this session (used by tests and `/realctx outputs` cleanup). */
	get sessionKey(): string {
		return this.sessionId;
	}
}
