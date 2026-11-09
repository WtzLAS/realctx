/** TUI-only summaries. Model-facing content remains complete and unchanged. */
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

type Preview = { id: string; caption: string; scope?: string };
export const memoryPreview = (m: { id: string; caption: string; kind: string }): Preview => ({ id: m.id, caption: m.caption, scope: m.kind });

// Captions and arguments are untrusted terminal data; never allow embedded control sequences.
const clean = (value: unknown, max = 200): string => String(value ?? "").replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const record = (v: unknown): Record<string, any> => v && typeof v === "object" ? v as Record<string, any> : {};
const array = (v: unknown): any[] => Array.isArray(v) ? v : [];
const compact = (v: unknown, prefix = ""): string => array(v).slice(0, 3).map((x) => `${prefix}${clean(x, 64)}`).join(", ") + (array(v).length > 3 ? ` +${array(v).length - 3}` : "");

class Summary implements Component {
	constructor(privateLines: string[]) { this.lines = privateLines; }
	private lines: string[];
	set(lines: string[]): this { this.lines = lines; return this; }
	render(width: number): string[] { return this.lines.map((line) => truncateToWidth(line, Math.max(1, width))); }
	invalidate(): void {}
}

function callSummary(name: string, a: Record<string, any>): string {
	const parts: string[] = [];
	if (name === "realctx_remember") parts.push(clean(a.caption, 120));
	else {
		if (a.queries) parts.push(compact(a.queries));
		if (a.ids) parts.push(compact(a.ids, name === "realctx_expand" ? "#" : ""));
		if (a.history) parts.push(compact(a.history, "h"));
	}
	if (a.paths) parts.push(compact(a.paths));
	if (a.scope) parts.push(clean(a.scope));
	if (a.page) parts.push(`page ${clean(a.page)}`);
	if (a.lines) parts.push(`lines ${clean(a.lines)}`);
	if (a.grep) parts.push(`grep ${clean(a.grep, 60)}`);
	return parts.filter(Boolean).join(" · ");
}

/** Resume old sessions without details: extract ONLY envelope headers, never memory bodies. */
function legacyMemories(raw: string): Preview[] {
	return [...raw.matchAll(/<memory id="([^"]+)"[^>]*>\s*\n# ([^\n]+)/g)].map((m) => ({ id: m[1], caption: m[2] }));
}

function memoryLines(memories: Preview[], expanded: boolean, theme: Theme): string[] {
	const shown = expanded ? memories : memories.slice(0, 6);
	const lines = shown.map((m) => `  ${theme.fg("accent", clean(m.id, 40))}  ${theme.fg("text", clean(m.caption, 180))}`);
	if (shown.length < memories.length) lines.push(theme.fg("dim", `  +${memories.length - shown.length} more · expand for all captions`));
	return lines;
}

export function toolRenderers(name: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(args, theme, context) {
			const title = theme.fg("toolTitle", theme.bold(`realctx ${name.replace("realctx_", "")}`));
			const detail = callSummary(name, record(args));
			const lines = [title + (detail ? `  ${theme.fg("muted", detail)}` : "")];
			return context?.lastComponent instanceof Summary ? context.lastComponent.set(lines) : new Summary(lines);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const d = record(result.details);
			const raw = result.content.filter((c) => c.type === "text").map((c) => c.type === "text" ? c.text : "").join("\n");
			const muted = (s: string) => theme.fg("muted", s);
			let lines: string[];
			if (context?.isError || d.error) lines = [theme.fg("error", `✗ ${clean(d.error ?? raw, 240) || "Tool failed"}`)];
			else if (isPartial) lines = [muted(`⟳ ${clean(raw, 160) || "Working…"}`)];
			else if (name === "realctx_recall" || name === "realctx_list") {
				const memories = Array.isArray(d.memories) ? d.memories as Preview[] : legacyMemories(raw);
				const unique = [...new Map(memories.map((m) => [m.id, m])).values()];
				const total = typeof d.total === "number" ? ` of ${d.total}` : "";
				lines = [muted(`${unique.length}${total} memories${d.pages ? ` · page ${d.page}/${d.pages}` : ""}`), ...memoryLines(unique, expanded, theme)];
				if (array(d.outputs).length) lines.push(muted(`Dropped outputs: ${compact(d.outputs, "#")}`));
				if (d.embedError) lines.push(theme.fg("warning", `Keyword search only · ${clean(d.embedError, 160)}`));
				if (array(d.missing).length) lines.push(theme.fg("warning", `Not found: ${compact(d.missing)}`));
			} else if (name === "realctx_remember") {
				const state = clean(d.status) || "Completed";
				const warning = ["queued", "skipped", "rejected"].includes(state);
				lines = [theme.fg(warning ? "warning" : "success", `${warning ? "•" : "✓"} ${state}`)
					+ (d.id ? `  ${theme.fg("accent", clean(d.id))}` : "") + (d.caption ? `  ${muted(clean(d.caption, 160))}` : "")];
				if (d.scope) lines.push(theme.fg("dim", clean(d.scope)));
				if (expanded && d.message) lines.push(muted(clean(d.message, 240)));
				if (array(d.warnings).length) lines.push(...array(d.warnings).map((w) => theme.fg("warning", clean(w, 200))));
			} else if (name === "realctx_forget") {
				lines = [muted(`${array(d.deleted).length} deleted`), ...memoryLines(array(d.memories), expanded, theme)];
				if (array(d.missing).length) lines.push(theme.fg("warning", `Not found: ${compact(d.missing)}`));
			} else if (name === "realctx_expand") {
				lines = [muted(`Restored ${array(d.restored).length} outputs${array(d.history).length ? ` · history ${compact(d.history, "h")}` : ""}`)];
				if (array(d.missing).length) lines.push(theme.fg("warning", `Not found: ${compact(d.missing, "#")}`));
				lines.push(...raw.split("\n").filter((l) => /^Not found: h|^h\d+ .*not on the current branch/.test(l)).map((l) => theme.fg("warning", clean(l, 200))));
				const images = result.content.filter((c) => c.type === "image").length;
				if (images) lines.push(muted(`${images} images restored`));
				if (expanded) lines.push(...raw.split("\n").slice(0, 80).map((l) => muted(clean(l, 400))));
				else lines.push(theme.fg("dim", "Original content sent to model · expand to preview"));
			} else {
				const stores = array(d.stores);
				const ctx = record(d.context);
				lines = [muted(`${stores.reduce((n, s) => n + (Number(s.memories) || 0), 0)} memories · ${Number(d.pending) || 0} queued · ${clean(d.project?.name) || "global"}`)];
				if (ctx.active !== undefined) lines.push(muted(`Context ${ctx.active ? "on" : "off"} · ${Number(ctx.applied) || 0} dropped · ${Number(ctx.queued) || 0} queued`));
				if (expanded) lines = raw.split("\n").slice(0, 80).map((l) => muted(clean(l, 400)));
				else lines.push(...raw.split("\n").filter((l) => /warning|not configured|error/i.test(l)).slice(0, 3).map((l) => theme.fg("warning", clean(l, 200))));
			}
			return context?.lastComponent instanceof Summary ? context.lastComponent.set(lines) : new Summary(lines);
		},
	};
}
