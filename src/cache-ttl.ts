/** Per-model prompt-cache lifetimes. Catalog pricing is evidence of caching, NOT a TTL. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDuration, type Settings } from "./config.ts";

export const MODEL_CATALOG_URL = "https://models.dev/api.json";
const REFRESH_MS = 24 * 60 * 60_000;
const RETRY_MS = 15 * 60_000;
const PLACEHOLDER_TTL_MS = 5 * 60_000;

type ModelRef = { provider?: string; id?: string; cost?: { cacheRead?: number; cacheWrite?: number } };
type CatalogEntry = { ttlMs?: number; caching: boolean };
export interface CacheLifetime {
	/** Effective lifetime; missing metadata falls back to a labeled five-minute placeholder. */
	ms: number;
	source: "override" | "catalog" | "provider estimate" | "placeholder";
}

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Exact provider/model matches only: a gateway may have a different cache than the vendor. */
export function parseModelCatalog(data: unknown): Record<string, CatalogEntry> {
	const entries: Record<string, CatalogEntry> = {};
	for (const [provider, value] of Object.entries(object(data))) {
		for (const [id, raw] of Object.entries(object(object(value).models))) {
			const model = object(raw);
			const cost = object(model.cost);
			// models.dev currently publishes cache pricing, not TTLs. Accept an explicit duration
			// if supplied by a future catalog; never infer lifetime from the write price.
			const ttl = model.cache_ttl ?? object(model.cache).ttl;
			const ttlMs = typeof ttl === "string" || typeof ttl === "number" ? parseDuration(ttl, NaN) : NaN;
			const caching = finite(cost.cache_read) || finite(cost.cache_write);
			if (Number.isFinite(ttlMs) || caching) entries[`${provider}/${id}`.toLowerCase()] = { caching, ...(Number.isFinite(ttlMs) ? { ttlMs } : {}) };
		}
	}
	return entries;
}

/** Provider defaults, not promises of cache retention. No guesses for gateways or unknown APIs.
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching (default 5m)
 * https://developers.openai.com/api/docs/guides/prompt-caching (in-memory idle expiry)
 * Extended retention must be set as a per-model override to match the actual request policy.
 */
function providerEstimate(provider: string): number | undefined {
	if (provider === "anthropic" || provider === "openai") return 5 * 60_000;
	return undefined;
}

export class ModelCacheTtls {
	private entries: Record<string, CatalogEntry> = {};
	private fetchedAt = 0;
	private attemptedAt = -Infinity;
	private pending?: Promise<void>;
	lastError?: string;

	private file: string;
	private fetcher: typeof fetch;
	private now: () => number;

	constructor(file: string, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
		this.file = file;
		this.fetcher = fetcher;
		this.now = now;
		try {
			const saved = object(JSON.parse(readFileSync(file, "utf8")));
			if (saved.version !== 1 || !finite(saved.fetchedAt)) return;
			this.entries = Object.fromEntries(Object.entries(object(saved.entries)).flatMap(([key, raw]) => {
				const entry = object(raw);
				return typeof entry.caching === "boolean" && (entry.ttlMs === undefined || finite(entry.ttlMs))
					? [[key, entry as CatalogEntry]] : [];
			}));
			this.fetchedAt = saved.fetchedAt;
		} catch { /* missing/corrupt cache: start offline, refresh in background */ }
	}

	resolve(model: ModelRef | undefined, settings: Settings["context"]): CacheLifetime {
		if (!model?.id) return { ms: PLACEHOLDER_TTL_MS, source: "placeholder" };
		const provider = model.provider?.toLowerCase() ?? "";
		const full = `${provider}/${model.id}`.toLowerCase();
		const overrides = Object.entries(settings.cacheTtlByModel);
		const value = overrides.find(([key]) => key.toLowerCase() === full)?.[1]
			?? overrides.find(([key]) => key.toLowerCase() === model.id!.toLowerCase())?.[1];
		const override = parseDuration(value, NaN);
		if (Number.isFinite(override)) return { ms: override, source: "override" };
		if (!settings.cacheTtlAuto) return { ms: PLACEHOLDER_TTL_MS, source: "placeholder" };
		const entry = this.entries[full];
		if (entry?.ttlMs !== undefined) return { ms: entry.ttlMs, source: "catalog" };
		const caching = entry?.caching || (model.cost?.cacheRead ?? 0) > 0 || (model.cost?.cacheWrite ?? 0) > 0;
		const estimate = caching ? providerEstimate(provider) : undefined;
		return estimate === undefined ? { ms: PLACEHOLDER_TTL_MS, source: "placeholder" } : { ms: estimate, source: "provider estimate" };
	}

	/** Shared in-flight request, daily disk cache, bounded timeout and failure backoff. Never throws. */
	refresh(force = false): Promise<void> {
		if (this.pending) return this.pending;
		const now = this.now();
		if (!force && ((this.fetchedAt > 0 && now - this.fetchedAt < REFRESH_MS) || now - this.attemptedAt < RETRY_MS)) return Promise.resolve();
		this.attemptedAt = now;
		this.pending = this.fetchCatalog().finally(() => { this.pending = undefined; });
		return this.pending;
	}

	private async fetchCatalog(): Promise<void> {
		try {
			const response = await this.fetcher(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(8000) });
			if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
			const entries = parseModelCatalog(await response.json());
			if (!Object.keys(entries).length) throw new Error("catalog contained no cache metadata");
			this.entries = entries;
			this.fetchedAt = this.now();
			this.lastError = undefined;
			try {
				mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
				const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
				writeFileSync(tmp, JSON.stringify({ version: 1, fetchedAt: this.fetchedAt, entries }), { mode: 0o600 });
				renameSync(tmp, this.file);
			} catch { /* read-only cache: keep the live catalog in memory */ }
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			// Keep the last good snapshot on timeout, offline, HTTP or schema failures.
		}
	}
}

export function formatCacheLifetime(value: CacheLifetime): string {
	const duration = value.ms === 0 ? "0s (always cold)" : value.ms % 3_600_000 === 0 ? `${value.ms / 3_600_000}h`
		: value.ms % 60_000 === 0 ? `${value.ms / 60_000}m` : `${value.ms / 1000}s`;
	if (value.source === "placeholder") return `${duration} (placeholder)`;
	return value.source === "override" ? `${duration} (overrided)` : `${duration} · ${value.source}`;
}
