/**
 * Output store (§6): originals of tool outputs, kept per session outside the project
 * (`~/.pi/agent/realctx/sessions/<project-key>/<session>/`), plus the metadata that the
 * context layer needs to drop, render and restore them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { displayPath } from "./paths.ts";
import { redactSecrets } from "./safety.ts";
import { estimateTokens, oneLine, sha256 } from "./text.ts";

export type ContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Tokens counted for one image in a tool result (rough; providers differ). */
export const IMAGE_TOKENS = 1200;

/** Immutable facts about one captured output. Persisted in the `realctx-ids` registry. */
export interface OutputMeta {
	/** Pi toolCallId: the stable key. */
	id: string;
	/** Session ordinal, shown to the model as `#ord`. */
	ord: number;
	tool: string;
	/** One-line argument summary (secrets redacted), e.g. `src/auth/session.ts` or `pnpm test`. */
	args: string;
	/** Hash of the canonical arguments (exact-duplicate detection). */
	sig: string;
	/** Size of the original in tokens (computed once). */
	tokens: number;
	/** Absolute turn (assistant message count) of the call. */
	turn: number;
	isError: boolean;
	/** Absolute paths the call touched. */
	paths: string[];
	/** File mtimes (ms) at capture time, for paths that were files. */
	mtimes: Record<string, number>;
	/** Path-note memory ids appended to this result (§11.2). */
	noteIds: string[];
	/** Absolute path of the stored original. */
	file: string;
	capturedAt: number;
	/** For realctx_expand results: ordinals of the outputs they restored. */
	expandOf?: number[];
}

export interface StoredOutput {
	v: 1;
	id: string;
	tool: string;
	input: Record<string, unknown>;
	content: ContentPart[];
	isError: boolean;
	capturedAt: number;
}

const PRIMARY_KEYS = ["path", "file_path", "filePath", "file", "command", "cmd", "pattern", "query", "url", "glob", "paths", "ids", "queries", "symbol", "name"];

/** Canonical JSON (sorted keys) for signatures. */
export function canonicalJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v ?? null);
}

export function argsSignature(tool: string, input: Record<string, unknown> | undefined): string {
	return sha256(`${tool}\n${canonicalJson(input ?? {})}`).slice(0, 24);
}

function fmtValue(v: unknown, cwd: string, key: string): string | undefined {
	if (typeof v === "string") {
		if (/path|file/i.test(key) && (v.startsWith("/") || v.startsWith("~"))) return displayPath(v.startsWith("~") ? v : v, cwd);
		return v;
	}
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) {
		const parts = v.slice(0, 4).map((x) => fmtValue(x, cwd, key)).filter((x): x is string => !!x);
		return parts.length ? parts.join(", ") + (v.length > 4 ? ", …" : "") : undefined;
	}
	return undefined;
}

/** One-line argument summary for placeholders and listings. Never contains secrets or newlines. */
export function summarizeArgs(input: Record<string, unknown> | undefined, cwd: string, max = 80): string {
	if (!input) return "";
	const keys = Object.keys(input);
	const ordered = [...PRIMARY_KEYS.filter((k) => keys.includes(k)), ...keys.filter((k) => !PRIMARY_KEYS.includes(k))];
	const parts: string[] = [];
	for (const k of ordered) {
		const s = fmtValue(input[k], cwd, k);
		if (s === undefined || s === "") continue;
		parts.push(parts.length === 0 ? s : `${k}=${s}`);
		if (parts.join(" ").length > max) break;
	}
	return oneLine(redactSecrets(parts.join(" ")).replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")")), max);
}

/** Text of the content parts (images as a marker). */
export function contentText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content.map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type}]`)).join("\n");
}

export function contentTokens(content: ReadonlyArray<{ type: string; text?: string }>): number {
	let n = 0;
	for (const p of content) n += p.type === "text" ? estimateTokens(p.text ?? "") : IMAGE_TOKENS;
	return n;
}

/** `3.1k tok` style size. */
export function fmtTokens(n: number): string {
	if (n < 1000) return `${n} tok`;
	if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k tok`;
	return `${Math.round(n / 1000)}k tok`;
}

export function mtimesOf(paths: string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const p of paths.slice(0, 16)) {
		try {
			const st = statSync(p);
			if (st.isFile()) out[p] = st.mtimeMs;
		} catch {
			// missing: nothing to compare later
		}
	}
	return out;
}

/** Files of one session's originals. */
export class OutputFiles {
	readonly dir: string;

	constructor(root: string, projectKey: string, sessionId: string) {
		this.dir = join(root, safeSegment(projectKey), safeSegment(sessionId));
	}

	fileFor(ord: number, toolCallId: string): string {
		return join(this.dir, `${String(ord).padStart(5, "0")}-${sha256(toolCallId).slice(0, 12)}.json`);
	}

	write(file: string, data: StoredOutput): void {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
		renameSync(tmp, file);
	}
}

function safeSegment(s: string): string {
	const clean = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
	return clean || "unknown";
}

export function readStored(file: string): StoredOutput | undefined {
	try {
		const d = JSON.parse(readFileSync(file, "utf8")) as StoredOutput;
		if (d && d.v === 1 && Array.isArray(d.content)) return d;
	} catch {
		// unreadable
	}
	return undefined;
}

export function storedExists(file: string): boolean {
	return existsSync(file);
}

export function removeStored(files: string[]): void {
	for (const f of files) rmSync(f, { force: true });
}
