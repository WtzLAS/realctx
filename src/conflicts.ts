/**
 * Other context managers in the same Pi (§12.3). realctx owns context management, so when
 * Magic Context, billion-context or a DCP-style pruner is loaded next to it, realctx warns
 * and disables them: their tools are deactivated and blocked at once, and their package is
 * turned off in Pi's settings (an `extensions: []` filter) so it unloads on the next
 * `/reload` or start. Everything is undoable with `/realctx conflicts enable`.
 */
import { resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Known context managers by tool name (§12.3). */
const CONFLICT_TOOLS: Record<string, string> = {
	ctx_reduce: "Magic Context",
	ctx_expand: "Magic Context",
	ctx_note: "Magic Context",
	bc_expand: "billion-context",
	bc_recall: "billion-context",
	billion_context_expand: "billion-context",
	discard: "DCP",
	extract: "DCP",
	prune: "DCP",
};

/** Known context managers by source path or package name. */
const CONFLICT_SOURCES: Array<[RegExp, string]> = [
	[/magic-context/i, "Magic Context"],
	[/billion-context/i, "billion-context"],
	[/dynamic-context-pruning|opencode-dcp|[\\/]dcp[\\/-]|pi-dcp/i, "DCP"],
	[/[\\/@:]realmem(?:[\\/.@-]|$)/i, "realmem"],
];

/** Plugins that only duplicate the memory layer (realctx replaces them); they do not turn the context layer off. */
const MEMORY_ONLY = new Set(["realmem"]);

/** Tool names too generic to identify a pruner on their own. */
const GENERIC = new Set(["discard", "extract", "prune"]);

export interface ToolSource {
	path?: string;
	source?: string;
	scope?: string;
	origin?: string;
}

export interface ConflictPlugin {
	/** Display name, e.g. "Magic Context". */
	name: string;
	/** Pi source of the extension: a package source (`npm:@x/y`, git URL, local path) or a file path. */
	source: string;
	/** `user` (~/.pi/agent/settings.json), `project` (.pi/settings.json) or `temporary` (-e flag). */
	scope: string;
	/** `package` = listed in `packages`; `top-level` = an `extensions` path or `-e`. */
	origin: string;
	path: string;
	/** Every tool this extension registered (all of them are deactivated, not only the matching ones). */
	tools: string[];
	/** `context` = rewrites the context (realctx's context layer must not run next to it); `memory` = a memory system realctx replaces. */
	kind: "context" | "memory";
}

/** Group the registered tools by extension and pick the ones that belong to a foreign context manager. */
export function detectConflictPlugins(tools: ReadonlyArray<{ name: string; sourceInfo?: ToolSource }>, extraTools: string[] = []): ConflictPlugin[] {
	const extra = new Set(extraTools);
	const bySource = new Map<string, { info: ToolSource; tools: string[]; name?: string }>();
	for (const t of tools) {
		if (t.name.startsWith("realctx_")) continue;
		const info = t.sourceInfo ?? {};
		const key = info.source || info.path || `tool:${t.name}`;
		const g = bySource.get(key) ?? { info, tools: [] };
		g.tools.push(t.name);
		const where = `${info.path ?? ""} ${info.source ?? ""}`;
		const sourceName = CONFLICT_SOURCES.find(([re]) => re.test(where))?.[1];
		const toolName = CONFLICT_TOOLS[t.name];
		if (toolName && (!GENERIC.has(t.name) || sourceName)) g.name ??= toolName;
		else if (sourceName) g.name ??= sourceName;
		else if (t.name.startsWith("realmem_")) g.name ??= "realmem";
		else if (extra.has(t.name)) g.name ??= t.name;
		bySource.set(key, g);
	}
	const out: ConflictPlugin[] = [];
	for (const [key, g] of bySource) {
		if (!g.name) continue;
		// Never report realctx itself or Pi's built-ins.
		if (/[\\/@:]realctx(?:[\\/.@-]|$)/i.test(`${g.info.path ?? ""} ${g.info.source ?? ""}`) || (g.info.path ?? "").startsWith("builtin:")) continue;
		out.push({
			name: g.name,
			source: g.info.source || key,
			scope: g.info.scope ?? "temporary",
			origin: g.info.origin ?? "top-level",
			path: g.info.path ?? "",
			tools: [...new Set(g.tools)].sort(),
			kind: MEMORY_ONLY.has(g.name) ? "memory" : "context",
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Package identity ignoring version or ref, the way Pi deduplicates packages. */
export function packageIdentity(source: string, cwd = process.cwd()): string {
	const s = source.trim();
	if (s.startsWith("npm:")) {
		const spec = s.slice(4);
		const m = /^(@[^/@]+\/[^@]+|[^@]+)(?:@.*)?$/.exec(spec);
		return `npm:${(m?.[1] ?? spec).toLowerCase()}`;
	}
	if (/^(git:|git\+|https?:\/\/|ssh:\/\/|git@)/.test(s)) {
		return s
			.replace(/^git\+/, "")
			.replace(/^git:/, "")
			.replace(/#.*$/, "")
			// A trailing @ref (tag, branch, commit) after the repository path.
			.replace(/@[^/@:]+$/, "")
			.replace(/\.git$/, "")
			.replace(/\/+$/, "")
			.toLowerCase();
	}
	return resolve(cwd, s.replace(/^~(?=$|[\\/])/, process.env.HOME ?? "~"));
}

type PackageEntry = string | { source: string; [k: string]: unknown };

function entrySource(e: PackageEntry): string {
	return typeof e === "string" ? e : e.source;
}

function isDisabled(e: PackageEntry): boolean {
	return typeof e !== "string" && Array.isArray(e.extensions) && e.extensions.length === 0;
}

export interface SettingsChange {
	ok: boolean;
	/** The settings file that was (or would be) changed. */
	file: string;
	/** The package entry before the change (to restore it). */
	previous?: PackageEntry;
	/** Why nothing was changed. */
	reason?: string;
	/** Already in the wanted state. */
	unchanged?: boolean;
}

function settingsFile(scope: string, cwd: string, agentDir: string): string {
	return scope === "project" ? resolve(cwd, ".pi", "settings.json") : resolve(agentDir, "settings.json");
}

async function editPackages(
	plugin: Pick<ConflictPlugin, "source" | "scope" | "origin">,
	cwd: string,
	agentDir: string,
	edit: (entry: PackageEntry) => PackageEntry | undefined,
): Promise<SettingsChange> {
	const file = settingsFile(plugin.scope, cwd, agentDir);
	if (plugin.origin !== "package") {
		return { ok: false, file, reason: plugin.scope === "temporary" ? "loaded with -e on the command line" : "loaded from the `extensions` setting, not a package" };
	}
	if (plugin.scope !== "user" && plugin.scope !== "project") return { ok: false, file, reason: `loaded from a ${plugin.scope} source` };
	const sm = SettingsManager.create(cwd, agentDir);
	const scoped = plugin.scope === "project" ? sm.getProjectSettings() : sm.getGlobalSettings();
	const packages = [...((scoped.packages ?? []) as PackageEntry[])];
	const id = packageIdentity(plugin.source, cwd);
	const idx = packages.findIndex((e) => entrySource(e) === plugin.source || packageIdentity(entrySource(e), cwd) === id);
	if (idx < 0) return { ok: false, file, reason: `no "${plugin.source}" entry in ${file}` };
	const previous = packages[idx];
	const next = edit(previous);
	if (next === undefined) return { ok: true, file, previous, unchanged: true };
	packages[idx] = next;
	if (plugin.scope === "project") sm.setProjectPackages(packages as never);
	else sm.setPackages(packages as never);
	await sm.flush();
	const errors = sm.drainErrors();
	if (errors.length > 0) return { ok: false, file, previous, reason: errors.map((e) => String((e as { error?: unknown }).error ?? e)).join("; ") };
	return { ok: true, file, previous };
}

/** Turn the plugin's package off in Pi's settings (an `extensions: []` filter). Takes effect on /reload. */
export function disableInSettings(plugin: Pick<ConflictPlugin, "source" | "scope" | "origin">, cwd: string, agentDir: string): Promise<SettingsChange> {
	return editPackages(plugin, cwd, agentDir, (e) => {
		if (isDisabled(e)) return undefined;
		return typeof e === "string" ? { source: e, extensions: [] } : { ...e, extensions: [] };
	});
}

/** Restore the package entry realctx replaced (or just lift the `extensions: []` filter). */
export function enableInSettings(plugin: Pick<ConflictPlugin, "source" | "scope" | "origin">, previous: PackageEntry | undefined, cwd: string, agentDir: string): Promise<SettingsChange> {
	return editPackages(plugin, cwd, agentDir, (e) => {
		if (!isDisabled(e)) return undefined;
		if (previous !== undefined && !isDisabled(previous)) return previous;
		const { extensions: _gone, ...rest } = e as { source: string; extensions?: unknown };
		return Object.keys(rest).length === 1 ? rest.source : rest;
	});
}

/** Where realctx records the plugins it disabled (database schedule key). */
export function disabledKey(source: string): string {
	return `conflict-disabled:${source}`;
}

export interface DisabledRecord {
	name: string;
	source: string;
	scope: string;
	origin: string;
	file: string;
	previous?: PackageEntry;
}
