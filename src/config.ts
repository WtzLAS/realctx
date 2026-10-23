import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SecretAction = "reject" | "redact";
export type StripMode = "imported" | "always" | "never";

export interface Settings {
	embedding: {
		/** Base URL, with or without a trailing `/v1`. */
		endpoint: string;
		/** API key; `$VAR` or `env:VAR` reads an environment variable. */
		apiKey: string;
		model: string;
		/** Matryoshka dimensions (32..4096). */
		dimensions: number;
		/** Instruction used when embedding recall queries. */
		queryInstruction: string;
		timeoutMs: number;
		/** Max inputs per embedding request. */
		batchSize: number;
	};
	semif: {
		endpoint: string;
		apiKey: string;
		model: string;
		timeoutMs: number;
		/** Questions per /v1/systemone request (the server's --max-questions). */
		maxQuestions: number;
	};
	/** `provider/model` used for Edit/Merge rewrites, fact extraction and output summaries. Empty = current session model. */
	rewriteModel: string;
	/** Shared System One judge behaviour (the connection lives in `semif`). */
	judge: {
		/** Context layer logs judge verdicts without acting on them (rule and emergency drops still act). */
		shadow: boolean;
		/** Parallel judge requests across all layers. */
		concurrency: number;
		/** Minimum milliseconds between two judge requests (rate limit). */
		minIntervalMs: number;
		/** Request path: `auto` tries /v1/systemone, then /v1/decisions on 404. */
		api: "auto" | "systemone" | "decisions";
		/** Gray-zone outputs judged per background pass. */
		maxPerPass: number;
	};
	/** Context layer: dropping spent tool outputs (§6–§9). */
	context: {
		enabled: boolean;
		/** Smaller outputs are not stored (and so never dropped). */
		captureMinTokens: number;
		/** Never drop an output smaller than this. */
		dropMinTokens: number;
		/** Outputs of the last N model turns are never dropped. */
		protectTurns: number;
		/** Tools whose latest result is never dropped (older ones are superseded). */
		protectedTools: string[];
		/** Max P(still_needed) to drop. */
		pDrop: number;
		/** Max P(unique_info) to drop. */
		pUnique: number;
		/** P(still_needed) at or above which an output is always kept. */
		pKeep: number;
		/** Min P(action ∈ drop/summarize) to act on a drop. */
		minConfidence: number;
		/** Share of the safe input window at which queued drops are applied. */
		applyThreshold: number;
		/** Share of the safe input window that triggers an emergency reclaim. */
		emergencyThreshold: number;
		/** Provider prompt-cache lifetime, e.g. "5m", "1h", "300s". */
		cacheTtl: string;
		/** Per-model cache lifetime overrides: `provider/model` or `model` → duration. */
		cacheTtlByModel: Record<string, string>;
		/** Max tokens one real_expand call returns. */
		expandMaxTokens: number;
		/** Expanded items stay pinned for this many turns. */
		repinTurns: number;
		/** Cancel Pi's threshold compaction while the context layer is active. */
		cancelCompaction: boolean;
		/** Extra tool names that identify a foreign context manager. */
		conflictTools: string[];
		/** Run the context layer even when a foreign context manager is detected. */
		ignoreConflicts: boolean;
	};
	/** Drop-time capture of durable facts (§13.1). */
	capture: {
		mode: "off" | "suggest" | "auto";
		/** P(durable_fact) needed to attempt capture. */
		pDurable: number;
		/** Minimum importance (0..3) for captured facts. */
		minImportance: number;
		/** Minimum P(durable) for captured facts. */
		minDurable: number;
		/** Extractions per session and hour. */
		maxPerSessionHour: number;
	};
	compat: {
		/** realmem_* tool aliases (one release): `deferred` = callable but not declared, `active` = declared too, `off`. */
		aliases: "deferred" | "active" | "off";
	};
	thresholds: {
		/** Minimum expected importance (0..3 score) to Add or Merge. */
		minImportance: number;
		/** Minimum P(durable) to change the memory base (Reinforce is exempt). */
		minDurable: number;
		/** Maximum P(unsafe) (secret or prompt injection per SemIf) before a candidate is refused. */
		maxUnsafe: number;
		/** Minimum probability for a `covered_by` pick to count. */
		covered: number;
		/** Minimum probability for a `conflict_with` pick to count. */
		conflict: number;
		/** Minimum probability for a `merge_with` pick to count. */
		merge: number;
		/** Minimum scope probability for moving a fact out of its target's store (Add instead of Edit/Merge). */
		scopeMove: number;
		/** Minimum cosine similarity for a vector hit to count as relevant during recall. */
		recallMinSimilarity: number;
		/** Path urgency score (0 Low .. 2 High) at or above which a memory is shown in full on touch. */
		urgencyHigh: number;
		/** Path urgency score at or above which a memory's caption is shown on touch (below: counted only). */
		urgencyMid: number;
	};
	candidates: {
		/** Max similar memories sent to SemIf (1..254). */
		max: number;
		/** Approximate token budget for the SemIf state (each question prompt must fit the server cache). */
		stateTokenBudget: number;
		/** Max characters of one memory's content inside the SemIf state. */
		perMemoryChars: number;
	};
	recall: {
		pageSize: number;
		/** Size of the relevant set that is then ordered by used_count and paginated. */
		maxResults: number;
	};
	list: {
		pageSize: number;
	};
	paths: {
		/** Show path-scoped memories when a tool call touches their paths. */
		inject: boolean;
		/** Max memories shown in full per tool result (the rest fall back to captions). */
		maxFull: number;
		/** Max captions per tool result (the rest are only counted). */
		maxCaptions: number;
		/** Character budget for full memory contents per tool result. */
		charBudget: number;
		/** Check path scopes against the working tree and flag missing ones. */
		staleCheck: boolean;
	};
	prompt: {
		/** Number of most-used captions injected into the session system prompt. */
		topCaptions: number;
		/**
		 * Remove AGENTS.md / CLAUDE.md context files from the system prompt:
		 * `imported` = only files whose current content was imported with /realctx import.
		 */
		stripContextFiles: StripMode;
		/** Tools of other memory systems to deactivate at session start. */
		hideTools: string[];
	};
	safety: {
		secretAction: SecretAction;
	};
	/** /realctx consolidate. */
	consolidate: {
		/** Minimum P(forget) (obsolete, transient, trivial) to delete a memory. */
		forget: number;
		/** Delete a memory whose expected importance (0..3) is below this. 0 = never on importance alone. */
		minImportance: number;
		/** Minimum P(revise) to rewrite a memory on its own with the Edit/Merge model. */
		revise: number;
		/** Similar memories (same store) each memory is reviewed against (1..254). */
		neighbors: number;
		/** Revise project memories' paths from a model summary of the repository's file tree. */
		paths: boolean;
		/** Memories per path-revision request. */
		pathBatch: number;
		/** Max lines of the file tree sent to the model. */
		treeLines: number;
	};
}

export const DEFAULT_SETTINGS: Settings = {
	embedding: {
		endpoint: "",
		apiKey: "",
		model: "",
		dimensions: 1024,
		queryInstruction: "Given a question or keywords about a software project, retrieve memory notes that answer it",
		timeoutMs: 60_000,
		batchSize: 32,
	},
	semif: {
		endpoint: "",
		apiKey: "",
		model: "",
		timeoutMs: 180_000,
		maxQuestions: 16,
	},
	rewriteModel: "",
	judge: {
		shadow: true,
		concurrency: 1,
		minIntervalMs: 0,
		api: "auto",
		maxPerPass: 6,
	},
	context: {
		enabled: true,
		captureMinTokens: 1000,
		dropMinTokens: 1000,
		protectTurns: 4,
		protectedTools: ["todo", "todo_write", "TodoWrite", "skill"],
		pDrop: 0.15,
		pUnique: 0.3,
		pKeep: 0.5,
		minConfidence: 0.7,
		applyThreshold: 0.65,
		emergencyThreshold: 0.9,
		cacheTtl: "5m",
		cacheTtlByModel: {},
		expandMaxTokens: 4000,
		repinTurns: 10,
		cancelCompaction: true,
		conflictTools: [],
		ignoreConflicts: false,
	},
	capture: {
		mode: "suggest",
		pDurable: 0.7,
		minImportance: 1.5,
		minDurable: 0.7,
		maxPerSessionHour: 6,
	},
	compat: {
		aliases: "deferred",
	},
	thresholds: {
		minImportance: 0.8,
		minDurable: 0.5,
		maxUnsafe: 0.5,
		covered: 0.5,
		conflict: 0.5,
		merge: 0.5,
		scopeMove: 0.7,
		recallMinSimilarity: 0.35,
		urgencyHigh: 1.5,
		urgencyMid: 0.75,
	},
	candidates: {
		max: 40,
		stateTokenBudget: 7000,
		perMemoryChars: 800,
	},
	recall: {
		pageSize: 8,
		maxResults: 32,
	},
	list: {
		pageSize: 50,
	},
	paths: {
		inject: true,
		maxFull: 3,
		maxCaptions: 8,
		charBudget: 6000,
		staleCheck: true,
	},
	prompt: {
		topCaptions: 20,
		stripContextFiles: "imported",
		hideTools: ["ctx_memory"],
	},
	safety: {
		secretAction: "reject",
	},
	consolidate: {
		forget: 0.7,
		minImportance: 0.5,
		revise: 0.7,
		neighbors: 12,
		paths: true,
		pathBatch: 20,
		treeLines: 400,
	},
};

export function agentDirFromEnv(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return resolve(env.replace(/^~(?=$|[\\/])/, homedir()));
	return join(homedir(), ".pi", "agent");
}

export interface RealctxPaths {
	base: string;
	config: string;
	db: string;
	globalDir: string;
	personalRoot: string;
}

export function realctxPaths(base: string): RealctxPaths {
	return {
		base,
		config: join(base, "config.json"),
		db: join(base, "realctx.sqlite"),
		globalDir: join(base, "global"),
		personalRoot: join(base, "personal"),
	};
}

/** Project-relative directory of the shared (git-synced) store. */
export const SHARED_SUBDIR = join(".pi", "realctx");

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeInto<T>(defaults: T, patch: unknown): T {
	if (!isObject(defaults) || !isObject(patch)) {
		if (patch === undefined || patch === null) return defaults;
		if (Array.isArray(defaults)) return (Array.isArray(patch) ? patch.filter((x) => typeof x === "string") : defaults) as T;
		if (typeof patch === typeof defaults) return patch as T;
		return defaults;
	}
	const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
	for (const key of Object.keys(defaults as Record<string, unknown>)) {
		out[key] = mergeInto((defaults as Record<string, unknown>)[key], patch[key]);
	}
	return out as T;
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** The design doc names the judge connection `judge.{endpoint,model,key,timeout_ms,max_questions}`; realmem called it `semif`. */
type RawConfig = Record<string, unknown>;

function liftJudgeConnection(input: unknown): RawConfig {
	if (!isObject(input)) return {};
	const raw: RawConfig = input;
	if (!isObject(raw.judge)) return raw;
	const j = raw.judge;
	const semif: Record<string, unknown> = { ...(isObject(raw.semif) ? raw.semif : {}) };
	const take = (from: string[], to: string) => {
		for (const k of from) if (j[k] !== undefined && semif[to] === undefined) semif[to] = j[k];
	};
	take(["endpoint"], "endpoint");
	take(["model"], "model");
	take(["key", "apiKey"], "apiKey");
	take(["timeout_ms", "timeoutMs"], "timeoutMs");
	take(["max_questions", "maxQuestions"], "maxQuestions");
	return { ...raw, semif };
}

/** Parse a duration such as `5m`, `1h`, `300s`, `1500ms` or a number of seconds. */
export function parseDuration(v: string | number | undefined, fallbackMs = 300_000): number {
	if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v * 1000 : fallbackMs;
	const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(v ?? "");
	if (!m) return fallbackMs;
	const n = Number(m[1]);
	const unit = (m[2] ?? "s").toLowerCase();
	return Math.round(n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000));
}

export function normalizeSettings(input: unknown): Settings {
	const raw = liftJudgeConnection(input);
	const s = mergeInto(structuredClone(DEFAULT_SETTINGS), raw);
	const ttlRaw = isObject(raw) && isObject(raw.context) && isObject(raw.context.cacheTtlByModel) ? raw.context.cacheTtlByModel : {};
	s.context.cacheTtlByModel = Object.fromEntries(Object.entries(ttlRaw).filter((e): e is [string, string] => typeof e[1] === "string"));
	s.judge.concurrency = Math.round(clamp(s.judge.concurrency, 1, 16));
	s.judge.minIntervalMs = Math.round(clamp(s.judge.minIntervalMs, 0, 60_000));
	s.judge.maxPerPass = Math.round(clamp(s.judge.maxPerPass, 0, 64));
	if (!["auto", "systemone", "decisions"].includes(s.judge.api)) s.judge.api = "auto";
	const c = s.context;
	c.captureMinTokens = Math.round(clamp(c.captureMinTokens, 0, 1_000_000));
	c.dropMinTokens = Math.round(clamp(c.dropMinTokens, 0, 1_000_000));
	c.protectTurns = Math.round(clamp(c.protectTurns, 0, 1000));
	for (const k of ["pDrop", "pUnique", "pKeep", "minConfidence"] as const) c[k] = clamp(c[k], 0, 1);
	c.emergencyThreshold = clamp(c.emergencyThreshold, 0.1, 1);
	c.applyThreshold = Math.min(clamp(c.applyThreshold, 0.05, 1), c.emergencyThreshold);
	c.expandMaxTokens = Math.round(clamp(c.expandMaxTokens, 200, 200_000));
	c.repinTurns = Math.round(clamp(c.repinTurns, 0, 1000));
	if (!["off", "suggest", "auto"].includes(s.capture.mode)) s.capture.mode = "suggest";
	s.capture.pDurable = clamp(s.capture.pDurable, 0, 1);
	s.capture.minDurable = clamp(s.capture.minDurable, 0, 1);
	s.capture.minImportance = clamp(s.capture.minImportance, 0, 3);
	s.capture.maxPerSessionHour = Math.round(clamp(s.capture.maxPerSessionHour, 0, 1000));
	if (!["deferred", "active", "off"].includes(s.compat.aliases)) s.compat.aliases = "deferred";
	s.embedding.dimensions = Math.round(clamp(s.embedding.dimensions, 32, 4096));
	s.embedding.batchSize = Math.round(clamp(s.embedding.batchSize, 1, 2048));
	s.embedding.timeoutMs = Math.round(clamp(s.embedding.timeoutMs, 1000, 600_000));
	s.semif.timeoutMs = Math.round(clamp(s.semif.timeoutMs, 1000, 1_800_000));
	s.semif.maxQuestions = Math.round(clamp(s.semif.maxQuestions, 1, 255));
	for (const k of ["covered", "conflict", "merge", "scopeMove", "minDurable", "maxUnsafe", "recallMinSimilarity"] as const) {
		s.thresholds[k] = clamp(s.thresholds[k], 0, 1);
	}
	s.thresholds.minImportance = clamp(s.thresholds.minImportance, 0, 3);
	s.thresholds.urgencyHigh = clamp(s.thresholds.urgencyHigh, 0, 2);
	s.thresholds.urgencyMid = Math.min(clamp(s.thresholds.urgencyMid, 0, 2), s.thresholds.urgencyHigh);
	s.paths.maxFull = Math.round(clamp(s.paths.maxFull, 0, 20));
	s.paths.maxCaptions = Math.round(clamp(s.paths.maxCaptions, 0, 50));
	s.paths.charBudget = Math.round(clamp(s.paths.charBudget, 500, 100_000));
	s.candidates.max = Math.round(clamp(s.candidates.max, 1, 254));
	s.candidates.stateTokenBudget = Math.round(clamp(s.candidates.stateTokenBudget, 500, 1_000_000));
	s.candidates.perMemoryChars = Math.round(clamp(s.candidates.perMemoryChars, 80, 20_000));
	s.recall.pageSize = Math.round(clamp(s.recall.pageSize, 1, 100));
	s.recall.maxResults = Math.round(clamp(s.recall.maxResults, 1, 500));
	s.list.pageSize = Math.round(clamp(s.list.pageSize, 1, 500));
	s.prompt.topCaptions = Math.round(clamp(s.prompt.topCaptions, 0, 200));
	s.consolidate.forget = clamp(s.consolidate.forget, 0, 1);
	s.consolidate.revise = clamp(s.consolidate.revise, 0, 1);
	s.consolidate.minImportance = clamp(s.consolidate.minImportance, 0, 3);
	s.consolidate.neighbors = Math.round(clamp(s.consolidate.neighbors, 1, 254));
	s.consolidate.pathBatch = Math.round(clamp(s.consolidate.pathBatch, 1, 200));
	s.consolidate.treeLines = Math.round(clamp(s.consolidate.treeLines, 20, 5000));
	if (s.safety.secretAction !== "redact") s.safety.secretAction = "reject";
	if (!["imported", "always", "never"].includes(s.prompt.stripContextFiles)) s.prompt.stripContextFiles = "imported";
	return s;
}

export function loadSettings(file: string): Settings {
	if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
	try {
		return normalizeSettings(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return structuredClone(DEFAULT_SETTINGS);
	}
}

export function saveSettings(file: string, settings: Settings): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
	try {
		chmodSync(file, 0o600);
	} catch {
		// best effort
	}
}

export function settingsMtime(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

/** Resolve `$VAR` / `env:VAR` references. */
export function resolveSecret(value: string): string {
	const v = value.trim();
	const m = /^(?:\$\{?|env:)([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v);
	if (m) return process.env[m[1]] ?? "";
	return v;
}

/** Normalize an API base URL: strip trailing slashes and a trailing `/v1`. */
export function normalizeEndpoint(url: string): string {
	return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Identity of the embedding space. Changing it invalidates every cached vector. */
export function embeddingFingerprint(s: Settings): string {
	return `${normalizeEndpoint(s.embedding.endpoint)}|${s.embedding.model.toLowerCase()}|${s.embedding.dimensions}`;
}

export function maskSecret(value: string): string {
	const v = value.trim();
	if (!v) return "(none)";
	if (/^(?:\$\{?|env:)[A-Za-z_]/.test(v)) return v;
	if (v.length <= 8) return "•".repeat(v.length);
	return `${v.slice(0, 3)}…${v.slice(-3)}`;
}
