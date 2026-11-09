import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatCacheLifetime, MODEL_CATALOG_URL, ModelCacheTtls, parseModelCatalog } from "../src/cache-ttl.ts";
import { normalizeSettings } from "../src/config.ts";

const catalog = {
	anthropic: { models: { claude: { cost: { cache_read: 0.3 } } } },
	openai: { models: { gpt: { cost: { cache_read: 0.1 } }, explicit: { cache_ttl: "1h" } } },
	google: { models: { gemini: { cost: { cache_read: 0.1 } } } },
	custom: { models: { short: { cache: { ttl: 90 } }, bad: { cache_ttl: -1 }, invalid: { cache_ttl: "oops" }, none: { cost: { input: 1 } } } },
};
const cfg = normalizeSettings({}).context;

test("catalog TTLs are not inferred from prices; exact models, overrides, unknown and offline", async () => {
	const dir = mkdtempSync(join(tmpdir(), "realctx-ttl-"));
	try {
		const file = join(dir, "cache.json");
		let calls = 0;
		const fetcher: typeof fetch = async (url, init) => {
			calls++;
			assert.equal(url, MODEL_CATALOG_URL);
			assert.ok(init?.signal);
			assert.equal(init?.headers, undefined, "no secrets sent to public catalog");
			return Response.json(catalog);
		};
		const cache = new ModelCacheTtls(file, fetcher);
		assert.deepEqual(cache.resolve({ provider: "unknown", id: "x" }, cfg), { ms: 300_000, source: "placeholder" });
		assert.equal(cache.resolve({ provider: "anthropic", id: "claude", cost: { cacheRead: 1 } }, cfg).source, "provider estimate", "local registry works offline");
		await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
		assert.equal(calls, 1, "deduplicate in-flight refresh");
		await cache.refresh();
		assert.equal(calls, 1, "daily TTL cache");
		assert.deepEqual(cache.resolve({ provider: "openai", id: "explicit" }, cfg), { ms: 3_600_000, source: "catalog" });
		assert.deepEqual(cache.resolve({ provider: "custom", id: "short" }, cfg), { ms: 90_000, source: "catalog" });
		assert.deepEqual(cache.resolve({ provider: "anthropic", id: "claude" }, cfg), { ms: 300_000, source: "provider estimate" });
		assert.deepEqual(cache.resolve({ provider: "openai", id: "gpt" }, cfg), { ms: 300_000, source: "provider estimate" });
		assert.deepEqual(cache.resolve({ provider: "google", id: "gemini" }, cfg), { ms: 300_000, source: "placeholder" }, "no fixed TTL for implicit caching");
		assert.deepEqual(cache.resolve({ provider: "gateway", id: "anthropic/claude" }, cfg), { ms: 300_000, source: "placeholder" }, "never match another provider's cache");
		assert.equal(cache.resolve({ provider: "openai", id: "explicit" }, { ...cfg, cacheTtlAuto: false }).ms, 300_000);
		const manual = { ...cfg, cacheTtlAuto: false, cacheTtlByModel: { "OPENAI/EXPLICIT": "2h", explicit: "10m" } };
		assert.deepEqual(cache.resolve({ provider: "openai", id: "explicit" }, manual), { ms: 7_200_000, source: "override" });
		assert.deepEqual(cache.resolve({ provider: "else", id: "explicit" }, manual), { ms: 600_000, source: "override" });
		assert.equal(cache.resolve({ provider: "p", id: "m" }, { ...cfg, cacheTtlByModel: { "p/m": "0" } }).ms, 0);
		assert.match(formatCacheLifetime({ ms: 600_000, source: "override" }), /^10m \(overrided\)$/);
		assert.equal(formatCacheLifetime(cache.resolve({ provider: "unknown", id: "x" }, cfg)), "5m (placeholder)");
		const fromDisk = new ModelCacheTtls(file, async () => { throw new Error("offline"); });
		assert.deepEqual(fromDisk.resolve({ provider: "openai", id: "explicit" }, cfg), { ms: 3_600_000, source: "catalog" });
		await fromDisk.refresh(true);
		assert.match(fromDisk.lastError ?? "", /offline/);
		assert.equal(fromDisk.resolve({ provider: "openai", id: "explicit" }, cfg).ms, 3_600_000, "keep last good snapshot");
		assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("catalog malformed data, HTTP failures, corrupt disk and retry backoff", async () => {
	const dir = mkdtempSync(join(tmpdir(), "realctx-ttl-"));
	try {
		assert.deepEqual(parseModelCatalog(null), {});
		const entries = parseModelCatalog(catalog);
		assert.equal(entries["custom/bad"], undefined);
		assert.equal(entries["custom/invalid"], undefined);
		assert.equal(entries["custom/none"], undefined);
		const file = join(dir, "cache.json");
		writeFileSync(file, "broken JSON");
		let now = 1_000_000;
		let calls = 0;
		const cache = new ModelCacheTtls(file, async () => { calls++; return new Response("failure", { status: 503 }); }, () => now);
		await cache.refresh();
		assert.match(cache.lastError ?? "", /HTTP 503/);
		assert.deepEqual(cache.resolve({ provider: "openai", id: "explicit" }, cfg), { ms: 300_000, source: "placeholder" }, "failed first fetch uses 5m");
		assert.deepEqual(cache.resolve(undefined, cfg), { ms: 300_000, source: "placeholder" });
		await cache.refresh();
		assert.equal(calls, 1);
		now += 16 * 60_000;
		await cache.refresh();
		assert.equal(calls, 2);
		const malformed = new ModelCacheTtls(file, async () => Response.json({}));
		await malformed.refresh();
		assert.match(malformed.lastError ?? "", /no cache metadata/);
		assert.deepEqual(malformed.resolve({ provider: "custom", id: "short" }, cfg), { ms: 300_000, source: "placeholder" }, "missing catalog metadata uses 5m");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
