/**
 * Image token cost (§6): what one image in a request costs, from its pixel size and the model
 * that receives it. Sizes are read from the encoded header (PNG, JPEG, GIF, WebP, BMP) by
 * decoding only as much of the base64 payload as needed; unknown formats count as the largest
 * image Pi sends (2000×2000 after its auto-resize). Nothing here touches Pi or the disk.
 *
 * Provider rules (as documented by the providers; `detail: "auto"` is treated as high):
 * - Anthropic: downscaled to fit the long-edge and pixel limits, then ⌈w·h / 750⌉. Claude ≥ 4.7
 *   accepts high-resolution images (long edge 2576 px, ~3.75 MP).
 * - OpenAI tile models (gpt-4o, gpt-4.1, gpt-5, o-series): fit 2048², shortest side to 768,
 *   then base + per-tile cost for 512-px tiles. Patch models (gpt-4.1-mini/nano, gpt-5-mini/nano,
 *   o4-mini): 32-px patches, at most 1536.
 * - Gemini 3: 1120 per image (default high media resolution). Gemini ≤ 2.x: 258 when both sides
 *   ≤ 384, else 258 per crop tile.
 * - Anything else: ⌈w·h / 750⌉ without a cap (a conservative upper bound for patch encoders).
 */

export interface ImageSize {
	width: number;
	height: number;
}

export interface ImageCost {
	/** Profile name, for diagnostics. */
	readonly name: string;
	/** Tokens for an image of this size. */
	tokens(width: number, height: number): number;
	/** Tokens when the size cannot be read. */
	readonly fallback: number;
}

/** The largest image Pi sends by default (its auto-resize bound). */
export const PI_MAX_IMAGE = 2000;

/** Minimal model view: Pi's `Model` has these fields. */
export interface ImageModel {
	provider?: string;
	id?: string;
	api?: string;
}

function profile(name: string, tokens: (w: number, h: number) => number): ImageCost {
	return { name, tokens, fallback: tokens(PI_MAX_IMAGE, PI_MAX_IMAGE) };
}

function anthropic(longEdge: number, maxPixels: number, name: string): ImageCost {
	return profile(name, (w, h) => {
		const scale = Math.min(1, longEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
		return Math.max(1, Math.ceil((Math.floor(w * scale) * Math.floor(h * scale)) / 750));
	});
}

function openaiTiles(base: number, perTile: number, name: string): ImageCost {
	return profile(name, (w0, h0) => {
		let w = w0;
		let h = h0;
		const fit = Math.min(1, 2048 / Math.max(w, h));
		w *= fit;
		h *= fit;
		const shortSide = Math.min(1, 768 / Math.min(w, h));
		w *= shortSide;
		h *= shortSide;
		return base + perTile * Math.ceil(w / 512) * Math.ceil(h / 512);
	});
}

function openaiPatches(name: string): ImageCost {
	return profile(name, (w0, h0) => {
		const patches = Math.ceil(w0 / 32) * Math.ceil(h0 / 32);
		if (patches <= 1536) return patches;
		// Shrink until the patch grid fits the budget.
		let scale = Math.sqrt((1536 * 32 * 32) / (w0 * h0));
		const w = w0 * scale;
		const h = h0 * scale;
		scale *= Math.min(Math.floor(w / 32) / (w / 32), Math.floor(h / 32) / (h / 32));
		return Math.min(1536, Math.ceil((w0 * scale) / 32) * Math.ceil((h0 * scale) / 32));
	});
}

const GEMINI_TILES = profile("gemini", (w, h) => {
	if (w <= 384 && h <= 384) return 258;
	const tile = Math.min(768, Math.max(256, Math.floor(Math.min(w, h) / 1.5)));
	return 258 * Math.ceil(w / tile) * Math.ceil(h / tile);
});
const GEMINI_3 = profile("gemini-3", () => 1120);
const CLAUDE = anthropic(1568, 1_200_000, "anthropic");
const CLAUDE_HIRES = anthropic(2576, 3_750_000, "anthropic-hires");
const OPENAI_TILES = openaiTiles(85, 170, "openai");
const OPENAI_GPT5 = openaiTiles(70, 140, "openai-gpt5");
const OPENAI_PATCHES = openaiPatches("openai-patches");
/** Unknown models: ⌈w·h / 750⌉, uncapped. */
export const GENERIC_IMAGE_COST: ImageCost = profile("generic", (w, h) => Math.max(1, Math.ceil((w * h) / 750)));

/** Claude version from ids like `claude-opus-4-7`, `claude-sonnet-4-5-20250929`, `anthropic/claude-3.5-sonnet`. */
function claudeVersion(id: string): number | undefined {
	const m = /claude-(?:(?:opus|sonnet|haiku)-)?(\d+)(?:[.-](\d{1,2})(?!\d))?/.exec(id);
	if (!m) return undefined;
	return Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
}

/** The cost profile of a model (by model id first: routers serve every family). */
export function imageCostFor(model: ImageModel | undefined): ImageCost {
	const id = (model?.id ?? "").toLowerCase();
	const provider = (model?.provider ?? "").toLowerCase();
	const api = (model?.api ?? "").toLowerCase();
	if (id.includes("claude")) return (claudeVersion(id) ?? 0) >= 4.7 ? CLAUDE_HIRES : CLAUDE;
	if (id.includes("gemini")) return Number(/gemini-(\d+)/.exec(id)?.[1] ?? 0) >= 3 ? GEMINI_3 : GEMINI_TILES;
	if (/(^|\/)(gpt-4\.1-(mini|nano)|gpt-5(\.\d+)?-(mini|nano)|o4-mini)/.test(id)) return OPENAI_PATCHES;
	if (/(^|\/)gpt-5/.test(id)) return OPENAI_GPT5;
	if (/(^|\/)(gpt-|o\d|chatgpt|codex)/.test(id)) return OPENAI_TILES;
	if (provider === "anthropic" || api.startsWith("anthropic")) return CLAUDE;
	if (provider.startsWith("google") || provider.includes("gemini") || provider.includes("vertex") || api.startsWith("google")) return GEMINI_TILES;
	if (provider === "openai" || provider.startsWith("azure") || provider === "openai-codex") return OPENAI_TILES;
	return GENERIC_IMAGE_COST;
}

// ---------------------------------------------------------------------------
// Size from the encoded header
// ---------------------------------------------------------------------------

/** Decodes a base64 prefix on demand (whole quanta only). */
class B64Prefix {
	private buf = Buffer.alloc(0);
	private readonly data: string;
	constructor(data: string) {
		this.data = data;
	}
	/** At least `n` bytes (fewer when the payload is shorter). */
	bytes(n: number): Buffer {
		if (this.buf.length >= n || this.buf.length * 4 >= this.data.length * 3) return this.buf;
		const want = Math.max(n, this.buf.length * 2, 64);
		const chars = Math.min(this.data.length, Math.ceil(want / 3) * 4);
		this.buf = Buffer.from(this.data.slice(0, chars - (chars % 4)), "base64");
		return this.buf;
	}
}

const JPEG_SCAN_LIMIT = 4 * 1024 * 1024;

function jpegSize(r: B64Prefix): ImageSize | undefined {
	let off = 2;
	while (off < JPEG_SCAN_LIMIT) {
		let b = r.bytes(off + 10);
		if (off + 4 > b.length) return undefined;
		if (b[off] !== 0xff) return undefined;
		const marker = b[off + 1];
		if (marker === 0xff) {
			off++; // fill byte
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			off += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return undefined; // end / start of scan before any frame
		const len = b.readUInt16BE(off + 2);
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			b = r.bytes(off + 9);
			if (off + 9 > b.length) return undefined;
			const height = b.readUInt16BE(off + 5);
			const width = b.readUInt16BE(off + 7);
			return width > 0 && height > 0 ? { width, height } : undefined;
		}
		off += 2 + len;
	}
	return undefined;
}

/** Pixel size of a base64-encoded image, or undefined when the format is not recognised. */
export function imageSize(data: string): ImageSize | undefined {
	if (typeof data !== "string" || data.length < 16) return undefined;
	const r = new B64Prefix(data);
	const b = r.bytes(32);
	if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR") {
		return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
	}
	if (b.length >= 10 && b.toString("latin1", 0, 4) === "GIF8") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
	if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
		const kind = b.toString("latin1", 12, 16);
		if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
		if (kind === "VP8L") {
			const bits = b.readUInt32LE(21);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
		return undefined;
	}
	if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(r);
	return undefined;
}

/** Sizes by payload fingerprint: the same image is measured on every request. */
const sizeCache = new Map<string, ImageSize | null>();
const SIZE_CACHE_MAX = 512;

function fingerprint(data: string): string {
	const mid = Math.floor(data.length / 2);
	return `${data.length}:${data.slice(0, 48)}:${data.slice(mid, mid + 32)}:${data.slice(-48)}`;
}

export function cachedImageSize(data: string): ImageSize | undefined {
	if (typeof data !== "string") return undefined;
	const key = fingerprint(data);
	const hit = sizeCache.get(key);
	if (hit !== undefined) return hit ?? undefined;
	const size = imageSize(data);
	if (sizeCache.size >= SIZE_CACHE_MAX) sizeCache.delete(sizeCache.keys().next().value as string);
	sizeCache.set(key, size ?? null);
	return size;
}

/** Tokens one image part costs under `cost`. */
export function imageTokens(part: { data?: unknown }, cost: ImageCost = GENERIC_IMAGE_COST): number {
	const size = typeof part?.data === "string" ? cachedImageSize(part.data) : undefined;
	if (!size || !(size.width > 0) || !(size.height > 0)) return cost.fallback;
	return cost.tokens(size.width, size.height);
}
