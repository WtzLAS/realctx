/**
 * realctx — working context and long-term memory for Pi (design: docs/realctx-design-v2.md).
 *
 * Context layer: captures tool outputs, drops spent ones behind byte-stable placeholders,
 * restores them with real_expand. Memory layer (realmem): surprise-gated Markdown facts,
 * path notes, a frozen per-session system prompt section. Plus the /realctx command and a skill.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { formatPlan, planSummary } from "../../src/consolidate.ts";
import { MemoryEngine } from "../../src/engine.ts";
import type { ScopeKind } from "../../src/files.ts";
import { formatContextStatus, formatPathNotes, formatStatus } from "../../src/format.ts";
import { canonicalEntryType } from "../../src/migrate.ts";
import { type ContentPart, fmtTokens } from "../../src/outputs.ts";
import type { Settings } from "../../src/config.ts";
import { describeIgnoreProblem, SHARED_REL } from "../../src/gitignore.ts";
import { displayPath } from "../../src/paths.ts";
import { buildSessionPrompt, SNAPSHOT_ENTRY, SNAPSHOT_VERSION, type SessionSnapshot } from "../../src/prompt.ts";
import { sha256 } from "../../src/text.ts";
import { ContextLayer, detectConflicts, type MessageView } from "./context-layer.ts";
import { openDebug } from "./debug-page.ts";
import { PathNoteState } from "./path-notes.ts";
import { openManage } from "./manage-page.ts";
import { openSettings } from "./settings-page.ts";
import { registerTools, rewriterFor } from "./tools.ts";
import { runWithLoader, showText } from "./ui.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, "..", "..", "skills");
const CONTEXT_FILE_RE = /(?:^|[\\/])(?:AGENTS(?:\.override)?|CLAUDE)\.md$/i;

const SUBCOMMANDS: Array<{ name: string; description: string }> = [
	{ name: "status", description: "context usage, queued drops, memory counts, warnings" },
	{ name: "manage", description: "browse, read, edit, move and delete memories; review captured facts" },
	{ name: "outputs", description: "this session's captured outputs, verdicts and drops" },
	{ name: "flush", description: "apply queued drops at the next request, ignoring the cache TTL" },
	{ name: "captures", description: "approve or reject facts captured from dropped outputs" },
	{ name: "settings", description: "judge, embedder, rewrite model, thresholds, context layer" },
	{ name: "debug", description: "dry-run the remember path, or a drop decision with `debug #N`" },
	{ name: "add", description: "remember a fact yourself (runs the full gate)" },
	{ name: "import", description: "import AGENTS.md / CLAUDE.md into realctx via the agent" },
	{ name: "embed", description: "embed memories that have no vector yet" },
	{ name: "reindex", description: "clear the embedding cache and re-embed everything" },
	{ name: "retry", description: "retry candidates queued while the judge was unreachable" },
	{ name: "prune-paths", description: "drop paths that no longer exist; delete memories whose paths are all gone" },
	{ name: "consolidate", description: "SemIf reviews every memory to forget, merge and revise; the Edit/Merge model revises paths from a repo summary" },
	{ name: "fix-gitignore", description: "check whether .pi/realctx is ignored by git and add the fix to .gitignore" },
];

export default function realctx(pi: ExtensionAPI) {
	let engine: MemoryEngine | undefined;
	let snapshot: SessionSnapshot | undefined;
	let pendingImport: { files: Array<{ path: string; hash: string }>; results: string[] } | undefined;
	let draining = false;
	const notes = new PathNoteState();

	const getEngine = (): MemoryEngine => {
		engine ??= new MemoryEngine();
		return engine;
	};

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			const e = getEngine();
			const sc = e.scopes(ctx.cwd);
			const n = e.db.count(sc.stores.map((s) => s.id));
			const pending = e.db.countPending(sc.project?.root);
			const setup = e.semifClient.configured ? "" : " · setup: /realctx settings";
			const st = layer.status();
			const ctxPart = st.active ? ` · ctx ${st.applied ? `−${fmtTokens(st.reclaimed)}` : "0"}${st.queued ? ` (+${st.queued} queued)` : ""}${st.shadow ? " shadow" : ""}` : "";
			ctx.ui.setStatus("realctx", `🧠 ${n}${pending ? ` (+${pending} queued)` : ""}${ctxPart}${setup}`);
		} catch {
			ctx.ui.setStatus("realctx", "🧠 !");
		}
	};

	const drain = (ctx: ExtensionContext) => {
		if (draining) return;
		const e = getEngine();
		if (e.pendingCount(ctx.cwd) === 0) return;
		draining = true;
		const rw = rewriterFor(e, ctx);
		const cwd = ctx.cwd;
		void e
			.drainPending(cwd, rw.rewriter)
			.then((done) => {
				if (done.length > 0 && ctx.hasUI) ctx.ui.notify(`realctx: processed ${done.length} queued memor${done.length === 1 ? "y" : "ies"}`, "info");
			})
			.catch(() => {})
			.finally(() => {
				draining = false;
				try {
					refreshStatus(ctx);
				} catch {
					// session replaced meanwhile
				}
			});
	};

	const layer = new ContextLayer({
		engine: () => getEngine(),
		settings: () => getEngine().settings,
		unshowNotes: (ids) => notes.unshow(ids),
		notify: (ctx, text, level) => {
			if (ctx.hasUI) ctx.ui.notify(text, level);
		},
	});

	const contextStatus = (): string[] => formatContextStatus(layer.status());

	let aliasMode: Settings["compat"]["aliases"] = "deferred";
	try {
		aliasMode = getEngine().settings.compat.aliases;
	} catch {
		// engine unavailable at load: keep the default
	}

	registerTools(pi, {
		engine: () => getEngine(),
		recentPaths: () => notes.recentPaths(),
		markSeen: (ids) => notes.markShown(ids),
		afterRemember: (ctx, status) => {
			pendingImport?.results.push(status);
			refreshStatus(ctx);
			if (status !== "queued") drain(ctx);
		},
		context: () => layer,
		contextStatus,
		aliasMode: () => aliasMode,
	});

	pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIR] }));

	pi.on("session_start", async (_event, ctx) => {
		snapshot = undefined;
		notes.reset(ctx.sessionManager.getBranch());
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && canonicalEntryType(entry.customType) === SNAPSHOT_ENTRY) {
				const data = entry.data as SessionSnapshot | undefined;
				if (typeof data?.v === "number" && data.v >= 1 && typeof data.prompt === "string") snapshot = data; // older snapshots stay valid: never change a running session's prompt
			}
		}
		let e: MemoryEngine;
		try {
			e = getEngine();
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`realctx failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}
		// Context layer: refuse to run next to another context manager (§12.3).
		let conflicts: string[] = [];
		try {
			conflicts = detectConflicts(pi.getAllTools(), e.settings.context.conflictTools);
		} catch {
			conflicts = [];
		}
		try {
			layer.reset(ctx, conflicts);
		} catch (err) {
			layer.disabledReason = `failed to start: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (conflicts.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				e.settings.context.ignoreConflicts
					? `realctx: running the context layer next to ${conflicts.join(", ")} (context.ignoreConflicts); expect both to rewrite the context`
					: `realctx: context layer off because ${conflicts.join(", ")} also manages the context; the memory layer stays on. Disable ${conflicts.join(", ")} to let realctx drop spent outputs.`,
				"warning",
			);
		}
		for (const n of e.notices.splice(0)) if (ctx.hasUI) ctx.ui.notify(n, "info");
		// Other memory systems' tools are hidden so the model only uses realctx.
		const hide = new Set(e.settings.prompt.hideTools);
		if (hide.size > 0) {
			const active = pi.getActiveTools();
			if (active.some((t) => hide.has(t))) pi.setActiveTools(active.filter((t) => !hide.has(t)));
		}
		try {
			const report = e.sync(ctx.cwd);
			if (report.flagged > 0 && ctx.hasUI) {
				ctx.ui.notify(`realctx: ${report.flagged} memor${report.flagged === 1 ? "y was" : "ies were"} quarantined by the safety scan; review with /realctx manage or clean up with /realctx prune-paths`, "warning");
			}
			if (report.errors.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`realctx: ${report.errors.length} unreadable memory file(s), e.g. ${report.errors[0].file}: ${report.errors[0].error}`, "warning");
			}
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`realctx sync failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
		if (!e.semifClient.configured && ctx.hasUI) {
			ctx.ui.notify("realctx: no SemIf judge endpoint is set, so new memories are only queued. Configure it (and the embedding API) in /realctx settings.", "warning");
		}
		try {
			e.resetRepoCache();
			const project = e.scopes(ctx.cwd).project;
			const ignored = project?.isGit ? e.sharedIgnored(project.root) : undefined;
			if (ignored && ctx.hasUI) {
				ctx.ui.notify(`realctx: ${describeIgnoreProblem(ignored)}\nOr run /realctx fix-gitignore to apply it.`, "warning");
			}
			const paths = e.checkPaths(ctx.cwd);
			if (paths.stale > 0 && ctx.hasUI) {
				ctx.ui.notify(`realctx: ${paths.stale} memor${paths.stale === 1 ? "y refers" : "ies refer"} to paths that no longer exist; review with /realctx manage`, "warning");
			}
		} catch {
			// git unavailable: skip
		}
		refreshStatus(ctx);
		void e.embedInBackground().then(() => refreshStatus(ctx)).catch(() => {});
		void e.refreshUrgencyInBackground(ctx.cwd);
		drain(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		let e: MemoryEngine;
		try {
			e = getEngine();
		} catch {
			return;
		}
		const opts = event.systemPromptOptions;
		if (!snapshot) {
			// First prompt of the session: compute the realctx section once and freeze it,
			// so the prompt prefix never changes for the rest of the session.
			const strip: string[] = [];
			const mode = e.settings.prompt.stripContextFiles;
			if (mode !== "never") {
				for (const f of opts.contextFiles) {
					if (!CONTEXT_FILE_RE.test(f.path)) continue;
					if (mode === "always" || e.db.isContextImported(sha256(f.content))) strip.push(f.path);
				}
			}
			let top: ReturnType<MemoryEngine["topMemories"]> = [];
			let total = 0;
			let pathMap: ReturnType<MemoryEngine["pathMap"]> = [];
			try {
				top = e.topMemories(ctx.cwd, e.settings.prompt.topCaptions);
				total = e.db.count(e.scopes(ctx.cwd).stores.map((s) => s.id));
				if (e.settings.paths.inject) pathMap = e.pathMap(ctx.cwd, 10);
			} catch {
				// index unavailable: prompt without captions
			}
			const project = e.scopes(ctx.cwd).project;
			snapshot = {
				v: SNAPSHOT_VERSION,
				prompt: buildSessionPrompt({ top, total, projectName: project?.name, stripped: strip, pathMap, contextLayer: layer.active }),
				strip,
				createdAt: new Date().toISOString(),
			};
			pi.appendEntry(SNAPSHOT_ENTRY, snapshot);
		}
		if (snapshot.strip.length > 0) {
			const strip = new Set(snapshot.strip);
			opts.contextFiles = opts.contextFiles.filter((f) => !strip.has(f.path));
		}
		opts.sections.realctx = snapshot.prompt;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!pendingImport) return;
		const e = getEngine();
		const { files, results } = pendingImport;
		pendingImport = undefined;
		const stored = results.filter((s) => s === "added" || s === "edited" || s === "merged" || s === "reinforced" || s === "queued").length;
		if (stored === 0) {
			if (ctx.hasUI) ctx.ui.notify("realctx: the import stored no memories; context files were not marked as imported", "warning");
			return;
		}
		for (const f of files) e.db.markContextImported(f.hash, f.path);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`realctx: import stored ${stored} fact(s); marked ${files.length} context file(s) as imported${e.settings.prompt.stripContextFiles === "imported" ? " (left out of the prompt from the next session on)" : ""}`,
				"info",
			);
		}
		refreshStatus(ctx);
	});

	// Path notes (memories attached to the touched paths, appended to the result) and
	// capture of the original output for the context layer.
	pi.on("tool_result", (event, ctx) => {
		if (!engine) return;
		const e = engine;
		const own = event.toolName.startsWith("real_") || event.toolName.startsWith("realmem_");
		const original = event.content as ContentPart[];
		let noteIds: string[] = [];
		let appended: string | undefined;
		// Path tracker: computed once per call and shared by notes, drop rules and expansion (§13.4).
		const touched = layer.trackCall(event.toolCallId, event.toolName, event.input, ctx.cwd);
		if (!own && e.settings.paths.inject && touched.length > 0) {
			notes.touch(touched);
			// Pick up memories pulled via git or edited by hand (cheap when nothing changed).
			if (Date.now() - notes.lastSync > 5_000) {
				notes.lastSync = Date.now();
				try {
					e.sync(ctx.cwd);
				} catch {
					// index busy: use what we have
				}
			}
			const found = e.notesForPaths(ctx.cwd, touched, notes.shownIds);
			const rendered = formatPathNotes(
				touched.map((t) => displayPath(t, ctx.cwd)),
				found,
				e.settings.paths,
			);
			if (rendered) {
				notes.markShown([...rendered.displayed, ...rendered.hinted]);
				if (rendered.displayed.length > 0) e.db.bumpUsage(rendered.displayed, "inject");
				noteIds = [...rendered.displayed, ...rendered.hinted];
				appended = rendered.text;
			}
		}
		// The original is stored without path notes: they do not count towards its size (§13.3).
		layer.capture({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, content: original, isError: event.isError }, touched, noteIds, ctx.cwd);
		if (event.toolName === "real_expand") layer.linkExpansion(event.toolCallId, event.input.ids);
		if (!appended) return;
		return { content: [...event.content, { type: "text" as const, text: appended }] };
	});

	pi.on("message_end", (event) => {
		const m = event.message as MessageView;
		if (m.role === "assistant") layer.onAssistant(m);
	});

	// Apply queued drops (when the cache is cold or the window is filling) and render placeholders.
	pi.on("context", (event, ctx) => {
		// SAFETY: MessageView only names optional fields of AgentMessage; transform returns the same
		// array (mutated in place or with whole tool-result messages replaced by same-role copies).
		const out = layer.transform(event.messages as unknown as MessageView[], ctx);
		return out ? { messages: out as unknown as typeof event.messages } : undefined;
	});

	// realctx replaces threshold compaction: it never pauses the session to summarise (§4).
	pi.on("session_before_compact", (event) => {
		if (!engine || !layer.active || !engine.settings.context.cancelCompaction) return;
		if (event.reason !== "threshold") return; // manual /compact and overflow recovery still run
		layer.requestFlush();
		return { cancel: true };
	});

	// Persist the ids shown on this branch so a resumed or reloaded session does not repeat them,
	// the output registry and the drop set; then judge spent outputs in the background.
	pi.on("turn_end", (_event, ctx) => {
		const entries = layer.flushEntries();
		const draft = notes.flush();
		if (draft) entries.push(draft as (typeof entries)[number]);
		layer.judgeInBackground(ctx);
		refreshStatus(ctx);
		return entries.length > 0 ? { entries } : undefined;
	});

	pi.on("session_tree", (_event, ctx) => {
		notes.reset(ctx.sessionManager.getBranch());
		layer.reset(ctx, layer.conflicts);
	});

	// After a compaction the summarised tool results (and their path notes) are gone:
	// notes shown before the first kept entry may be shown again.
	pi.on("session_compact", (_event, ctx) => {
		notes.reset(ctx.sessionManager.getBranch(), { keepUnflushed: true });
		layer.reset(ctx, layer.conflicts);
	});

	// Calls to other memory systems' tools are refused, even when they stay active.
	pi.on("tool_call", (event) => {
		if (!engine) return;
		if (!engine.settings.prompt.hideTools.includes(event.toolName)) return;
		return {
			block: true,
			reason: `${event.toolName} is disabled: realctx is the only long-term memory and context manager. Use real_recall / real_remember / real_expand instead.`,
		};
	});

	pi.on("session_shutdown", () => {
		pendingImport = undefined;
		snapshot = undefined;
		if (engine) {
			engine.close();
			engine = undefined;
		}
	});

	// ---------------------------------------------------------------------------
	// /realctx command
	// ---------------------------------------------------------------------------

	const importContext = async (ctx: ExtensionCommandContext, e: MemoryEngine) => {
		const files = ctx.getSystemPromptOptions().contextFiles?.filter((f) => CONTEXT_FILE_RE.test(f.path)) ?? [];
		const todo = files.filter((f) => !e.db.isContextImported(sha256(f.content)));
		if (todo.length === 0) {
			ctx.ui.notify(files.length ? "realctx: all AGENTS.md / CLAUDE.md files are already imported" : "realctx: no AGENTS.md / CLAUDE.md files in context", "info");
			return;
		}
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Import context files into realctx?",
				`${todo.map((f) => `• ${f.path}`).join("\n")}\n\nThe agent will split them into facts and store each with real_remember. The files themselves are not modified.`,
			);
			if (!ok) return;
		}
		pendingImport = { files: todo.map((f) => ({ path: f.path, hash: sha256(f.content) })), results: [] };
		const agentDir = dirname(e.paths.base);
		const body = todo
			.map((f) => {
				const hint = f.path.startsWith(agentDir) ? "global (user-level file)" : "project-shared unless a fact is machine- or user-specific";
				return `<instruction_file path="${f.path}" default_scope="${hint}">\n${f.content}\n</instruction_file>`;
			})
			.join("\n\n");
		pi.sendUserMessage(
			[
				"Import these instruction files into realctx long-term memory.",
				"Split them into self-contained facts (one topic each: setup, build/test commands, architecture, conventions, release steps, preferences, pitfalls) and call real_remember once per fact with a specific caption and complete content (keep commands and paths verbatim), user_requested=true, and the scope given by default_scope.",
				"Skip generic advice that any competent agent follows anyway, and anything that only restates how to use other memory systems. Do not change any files. When done, reply with a short summary of what was stored.",
				"",
				body,
			].join("\n"),
		);
	};

	const addFact = async (ctx: ExtensionCommandContext, e: MemoryEngine, initial: string) => {
		const text = initial.trim() ? initial : await ctx.ui.editor("Remember: first line = caption, the rest = content", "");
		if (!text?.trim()) return;
		const lines = text.replace(/\r\n/g, "\n").split("\n");
		const first = lines.findIndex((l) => l.trim());
		const caption = lines[first].replace(/^#+\s*/, "").trim();
		const content = lines.slice(first + 1).join("\n").trim() || caption;
		const rw = rewriterFor(e, ctx);
		const r = await runWithLoader(ctx, "remembering", (signal, setMessage) =>
			e.remember({ caption, content, source: "user", force: true }, { cwd: ctx.cwd, rewriter: rw.rewriter, signal, queueOnFailure: true, onStep: setMessage }),
		);
		if (r.error) ctx.ui.notify(`realctx: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
		else if (r.value) ctx.ui.notify(`realctx: ${r.value.message}`, r.value.status === "rejected" ? "warning" : "info");
		refreshStatus(ctx);
	};

	/** `/realctx debug #N`: dry-run a drop decision, showing the state and raw judge answers. */
	const debugDrop = async (ctx: ExtensionCommandContext, ord: number) => {
		const state = layer.debugState(ord, ctx);
		if (!state) {
			ctx.ui.notify(`realctx: no captured output #${ord} on this branch`, "warning");
			return;
		}
		const lines = ["State sent to the judge:", ...JSON.stringify(state, null, 2).split("\n"), ""];
		const r = await runWithLoader(ctx, `judging #${ord} (dry run)`, (signal) => layer.judgeOne(state, signal));
		if (r.cancelled) return;
		if (r.error) lines.push(`Judge failed: ${r.error instanceof Error ? r.error.message : String(r.error)}`);
		else if (r.value) {
			lines.push("Raw answers:", ...JSON.stringify(r.value.answers, null, 2).split("\n"), "");
			lines.push("Verdict:", ...(r.value.verdict?.reasons ?? ["(answers incomplete: keep)"]));
			if (getEngine().settings.judge.shadow) lines.push("", "judge.shadow is on: judge verdicts are only logged.");
		}
		if (ctx.mode === "tui") await showText(ctx, `realctx debug #${ord}`, () => lines);
		else ctx.ui.notify(lines.join("\n"), "info");
	};

	/** Approve or reject facts captured from dropped outputs (capture mode `suggest`, §13.1). */
	const reviewSuggestions = async (ctx: ExtensionCommandContext, e: MemoryEngine) => {
		const root = e.scopes(ctx.cwd).project?.root;
		for (;;) {
			const list = e.db.listSuggestions(root);
			if (list.length === 0) {
				ctx.ui.notify("realctx: no captured facts awaiting approval", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(list.map((s) => `${s.seq}. ${s.caption}`).join("\n"), "info");
				return;
			}
			const pick = await ctx.ui.select(
				`realctx captures (${list.length})`,
				list.map((s) => `${s.seq}. ${s.caption}${s.paths?.length ? ` (${s.paths.map((p) => displayPath(p, ctx.cwd)).join(", ")})` : ""}`),
			);
			if (!pick) return;
			const sug = list.find((s) => pick.startsWith(`${s.seq}.`));
			if (!sug) return;
			const act = await ctx.ui.select(`${sug.caption}\n\n${sug.content}`, ["approve — run it through the remember gate", "edit — edit, then approve", "reject — discard it", "back"]);
			if (!act || act.startsWith("back")) continue;
			if (act.startsWith("reject")) {
				e.db.deleteSuggestion(sug.seq);
				e.db.logEvent(layer.sessionKey, "capture_rejected", sug.toolCallId, 0);
				continue;
			}
			let caption = sug.caption;
			let content = sug.content;
			if (act.startsWith("edit")) {
				const text = await ctx.ui.editor("First line = caption, the rest = content", `${caption}\n${content}`);
				if (!text?.trim()) continue;
				const lines = text.replace(/\r\n/g, "\n").split("\n");
				caption = lines[0].replace(/^#+\s*/, "").trim();
				content = lines.slice(1).join("\n").trim() || caption;
			}
			const rw = rewriterFor(e, ctx);
			const r = await runWithLoader(ctx, "remembering", (signal, setMessage) =>
				e.remember({ caption, content, paths: sug.paths, source: "capture" }, { cwd: sug.cwd, rewriter: rw.rewriter, signal, queueOnFailure: true, onStep: setMessage }),
			);
			if (r.error) ctx.ui.notify(`realctx: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
			else if (r.value) {
				ctx.ui.notify(`realctx: ${r.value.message}`, r.value.status === "rejected" || r.value.status === "skipped" ? "warning" : "info");
				e.db.deleteSuggestion(sug.seq);
				e.db.logEvent(layer.sessionKey, "capture_approved", sug.toolCallId, 0, { status: r.value.status });
			}
		}
	};

	const realctxCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description: "realctx context + memory: status, outputs, flush, manage, settings, debug, add, import, embed, reindex, retry, prune-paths, consolidate",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const p = prefix.trim().toLowerCase();
			if (p.includes(" ")) return null;
			const items = SUBCOMMANDS.filter((s) => s.name.startsWith(p)).map((s) => ({ value: s.name, label: s.name, description: s.description }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			let e: MemoryEngine;
			try {
				e = getEngine();
			} catch (err) {
				ctx.ui.notify(`realctx failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			const trimmed = args.trim();
			let sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
			const rest = trimmed.slice(sub.length).trim();
			if (!sub) {
				if (!ctx.hasUI) sub = "status";
				else {
					const pick = await ctx.ui.select(
						"realctx",
						SUBCOMMANDS.map((s) => `${s.name} — ${s.description}`),
					);
					if (!pick) return;
					sub = pick.split(" ")[0];
				}
			}
			try {
				switch (sub) {
					case "manage":
					case "list":
						if (e.db.countSuggestions(e.scopes(ctx.cwd).project?.root) > 0 && ctx.hasUI && !rest) {
							const pick = await ctx.ui.select("realctx manage", ["memories — browse, read, edit, move and delete", "captures — review facts captured from dropped outputs"]);
							if (!pick) break;
							if (pick.startsWith("captures")) {
								await reviewSuggestions(ctx, e);
								break;
							}
						}
						await openManage(ctx, e, rest);
						break;
					case "settings":
					case "config":
						await openSettings(ctx, e);
						drain(ctx);
						break;
					case "debug": {
						const m = /^#?(\d+)$/.exec(rest);
						if (m) await debugDrop(ctx, Number(m[1]));
						else await openDebug(ctx, e, () => refreshStatus(ctx));
						break;
					}
					case "outputs": {
						const lines = layer.listing(ctx);
						if (ctx.mode === "tui") await showText(ctx, "realctx outputs", () => lines);
						else ctx.ui.notify(lines.join("\n"), "info");
						break;
					}
					case "flush": {
						if (!layer.active) {
							ctx.ui.notify(`realctx: context layer is off (${layer.status().reason})`, "warning");
							break;
						}
						const n = layer.requestFlush();
						ctx.ui.notify(n > 0 ? `realctx: ${n} queued drop(s) apply at the next request` : "realctx: nothing queued; rule-based drops found at the next request apply then", "info");
						break;
					}
					case "suggestions":
					case "captures":
						await reviewSuggestions(ctx, e);
						break;
					case "add":
					case "remember":
						await addFact(ctx, e, rest);
						break;
					case "import":
						await importContext(ctx, e);
						break;
					case "status": {
						const text = [...contextStatus(), "", formatStatus(e.status(ctx.cwd))].join("\n");
						if (ctx.mode === "tui") await showText(ctx, "realctx status", () => text.split("\n"));
						else ctx.ui.notify(text, "info");
						break;
					}
					case "embed":
					case "reindex": {
						if (sub === "reindex") {
							const ok = !ctx.hasUI || (await ctx.ui.confirm("Re-embed everything?", "This clears the embedding cache and embeds every memory again."));
							if (!ok) return;
							e.db.clearEmbeddings();
							e.index.checkFingerprint();
						}
						e.sync(ctx.cwd);
						const r = await runWithLoader(ctx, "embedding memories", (signal) => e.index.embedMissing(signal));
						if (r.error) ctx.ui.notify(`realctx: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
						else if (r.value) ctx.ui.notify(r.value.error ? `realctx: embedded ${r.value.embedded}, then failed: ${r.value.error}` : `realctx: embedded ${r.value.embedded} memories (${r.value.tokens} tokens)`, r.value.error ? "warning" : "info");
						break;
					}
					case "retry": {
						const rw = rewriterFor(e, ctx);
						const r = await runWithLoader(ctx, "retrying queued memories", (signal) => e.drainPending(ctx.cwd, rw.rewriter, signal));
						if (r.error) ctx.ui.notify(`realctx: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
						else ctx.ui.notify(`realctx: processed ${r.value?.length ?? 0} queued candidate(s); ${e.pendingCount(ctx.cwd)} left`, "info");
						break;
					}
					case "prune-paths":
					case "prune": {
						const preview = await e.prunePaths(ctx.cwd, { dryRun: true });
						if (preview.updated.length === 0 && preview.deleted.length === 0) {
							ctx.ui.notify("realctx: no memory refers to a missing path", "info");
							break;
						}
						const lines = [
							...preview.updated.map((u) => `edit   ${u.memory.caption}: drop ${u.removed.join(", ")}`),
							...preview.deleted.map((m) => `delete ${m.caption}: ${(m.paths ?? []).join(", ")}`),
						];
						if (ctx.hasUI && !(await ctx.ui.confirm(`Prune ${lines.length} memor${lines.length === 1 ? "y" : "ies"}?`, lines.join("\n")))) return;
						const r = await e.prunePaths(ctx.cwd);
						ctx.ui.notify(`realctx: removed missing paths from ${r.updated.length} memor${r.updated.length === 1 ? "y" : "ies"}, deleted ${r.deleted.length}`, "info");
						break;
					}
					case "consolidate":
						await consolidate(ctx, e, rest);
						break;
					case "fix-gitignore":
						await fixGitignore(ctx, e);
						break;
					default:
						ctx.ui.notify(`realctx: unknown subcommand "${sub}". Try: ${SUBCOMMANDS.map((s) => s.name).join(", ")}`, "warning");
				}
			} catch (err) {
				ctx.ui.notify(`realctx: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			refreshStatus(ctx);
		},
	};
	pi.registerCommand("realctx", realctxCommand);
	pi.registerCommand("realmem", { ...realctxCommand, description: "alias of /realctx (realmem was renamed to realctx)" });
}

/**
 * /realctx consolidate [global|shared|personal ...] [--no-paths]: plan with SemIf and the
 * Edit/Merge model and write the result at once, without any review or confirmation.
 */
async function consolidate(ctx: ExtensionCommandContext, e: MemoryEngine, args: string): Promise<void> {
	const words = args.toLowerCase().split(/\s+/).filter(Boolean);
	const SCOPE_WORDS: Record<string, ScopeKind> = { global: "global", shared: "shared", "project-shared": "shared", personal: "personal", "project-personal": "personal" };
	const scopes = [...new Set(words.map((w) => SCOPE_WORDS[w]).filter((k): k is ScopeKind => !!k))];
	const unknown = words.filter((w) => !SCOPE_WORDS[w] && w !== "--no-paths");
	if (unknown.length > 0) {
		ctx.ui.notify(`realctx: unknown consolidate argument(s): ${unknown.join(", ")}. Usage: /realctx consolidate [global] [shared] [personal] [--no-paths]`, "warning");
		return;
	}
	const rw = rewriterFor(e, ctx);
	if (rw.error) ctx.ui.notify(`realctx: ${rw.error}; merges fall back to appending and paths are not revised.`, "warning");
	const r = await runWithLoader(ctx, "consolidating", async (signal, setMessage) => {
		const plan = await e.planConsolidation({
			cwd: ctx.cwd,
			scopes: scopes.length ? scopes : undefined,
			rewriter: rw.rewriter,
			completer: rw.completer,
			paths: words.includes("--no-paths") ? false : undefined,
			signal,
			onStep: setMessage,
		});
		setMessage("writing");
		const done = plan.ops.length ? await e.applyConsolidation(ctx.cwd, plan) : undefined;
		return { plan, done };
	});
	if (r.cancelled) return;
	if (r.error || !r.value) {
		ctx.ui.notify(`realctx: ${r.error instanceof Error ? r.error.message : String(r.error)}`, "error");
		return;
	}
	const { plan, done } = r.value;
	const lines = formatPlan(plan);
	const head = done
		? `consolidated: updated ${done.updated}, deleted ${done.deleted}${done.stale.length ? `; skipped ${done.stale.length} changed meanwhile` : ""} (${planSummary(plan)})`
		: `nothing to consolidate (${planSummary(plan)})`;
	ctx.ui.notify(`realctx: ${head}${lines.length ? `\n${lines.join("\n")}` : ""}`, plan.warnings.length ? "warning" : "info");
}

/** Show the gitignore problem for the shared store and, after confirmation, append the verified fix. */
async function fixGitignore(ctx: ExtensionCommandContext, e: MemoryEngine): Promise<void> {
	const project = e.scopes(ctx.cwd).project;
	if (!project?.isGit) {
		ctx.ui.notify("realctx: not in a git repository; nothing to fix", "info");
		return;
	}
	const problem = e.sharedIgnored(project.root, true);
	if (!problem) {
		ctx.ui.notify(`realctx: ${SHARED_REL}/ is not ignored by git; project-shared memories will be committed`, "info");
		return;
	}
	const text = describeIgnoreProblem(problem);
	const fix = problem.fix;
	if (!fix || !ctx.hasUI) {
		ctx.ui.notify(`realctx: ${text}`, "warning");
		return;
	}
	const target = isAbsolute(fix.file) ? fix.file : join(project.root, fix.file);
	const ok = await ctx.ui.confirm(`Append to ${fix.file}?`, `${text}\n\nAppend the lines above to ${target}?`);
	if (!ok) return;
	const before = existsSync(target) ? readFileSync(target, "utf8") : "";
	const block = `${before && !before.endsWith("\n") ? "\n" : ""}${before ? "\n" : ""}# realctx: share project memories (${SHARED_REL}) through git\n${fix.lines.join("\n")}\n`;
	writeFileSync(target, before + block);
	const after = e.sharedIgnored(project.root, true);
	if (after) ctx.ui.notify(`realctx: ${fix.file} was updated, but ${SHARED_REL}/ is still ignored:\n${describeIgnoreProblem(after)}`, "error");
	else ctx.ui.notify(`realctx: updated ${fix.file}; ${SHARED_REL}/ is no longer ignored. Commit ${fix.file} and ${SHARED_REL}/ to share memories.`, "info");
}
