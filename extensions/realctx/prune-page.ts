/**
 * /realctx prune-paths: review what happens to memories that refer to missing paths.
 * Moved paths follow git, deleted ones are dropped, a memory left without paths becomes
 * project-wide (or is deleted, when chosen in the review), and paths that only exist on
 * other branches are left alone.
 */
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { MemoryEngine, PathPruneChange, PathPrunePlan, PathPruneResult } from "../../src/engine.ts";
import { SCOPE_LABEL } from "../../src/files.ts";
import { oneLine } from "../../src/text.ts";
import { showText } from "./ui.ts";

type Group = "moved" | "dropped" | "unscoped";

function groupOf(c: PathPruneChange): Group {
	if (c.paths.length === 0) return "unscoped";
	return c.dropped.length > 0 ? "dropped" : "moved";
}

const GROUP_TITLE: Record<Group, string> = {
	moved: "Moved: paths follow the files",
	dropped: "Deleted: paths dropped",
	unscoped: "No paths left: memory becomes project-wide (global memories: ~)",
};

function changeDetails(c: PathPruneChange): string[] {
	return [
		...Object.entries(c.renames).map(([from, to]) => `${from} → ${to}`),
		...c.dropped.map((p) => `${p} ✗ deleted`),
		...c.kept.map((p) => `${p} (kept: only on another branch)`),
	];
}

/** One-line summary of a change, for the review prompt. */
export function describeChange(c: PathPruneChange): string {
	const parts = changeDetails(c);
	return `${oneLine(c.memory.caption, 60)}: ${parts.join("; ")}${c.paths.length === 0 ? "; no paths left" : ""}`;
}

function planLines(plan: PathPrunePlan): (t: Theme) => string[] {
	return (t) => {
		const out: string[] = [];
		for (const g of ["moved", "dropped", "unscoped"] as Group[]) {
			const list = plan.changes.filter((c) => groupOf(c) === g);
			if (list.length === 0) continue;
			if (out.length) out.push("");
			out.push(t.bold(`${GROUP_TITLE[g]} (${list.length})`));
			for (const c of list) {
				out.push(`  ${c.memory.caption} ${t.fg("dim", `[${SCOPE_LABEL[c.memory.kind]}]`)}`);
				for (const d of changeDetails(c)) out.push(t.fg(d.includes("✗") ? "warning" : "muted", `      ${d}`));
			}
		}
		if (plan.skipped.length > 0) {
			if (out.length) out.push("");
			out.push(t.bold(`Skipped: paths only exist on other branches (${plan.skipped.length})`));
			for (const s of plan.skipped) out.push(`  ${s.memory.caption} ${t.fg("muted", `(${s.paths.join(", ")})`)}`);
		}
		return out;
	};
}

export function pruneSummary(plan: PathPrunePlan, r: PathPruneResult): string {
	const parts = [`updated paths of ${r.updated.length} memor${r.updated.length === 1 ? "y" : "ies"}`];
	if (r.unscoped.length) parts.push(`made ${r.unscoped.length} unscoped (whole project, or ~ for global)`);
	if (r.deleted.length) parts.push(`deleted ${r.deleted.length}`);
	if (plan.skipped.length) parts.push(`left ${plan.skipped.length} alone (paths on other branches)`);
	if (r.stale.length) parts.push(`skipped ${r.stale.length} changed meanwhile`);
	return parts.join(", ");
}

const APPLY = "Apply";
const DELETE = "Delete the memory";
const SKIP = "Skip";
const APPLY_REST = "Apply this and all remaining";
const SKIP_REST = "Skip this and all remaining";

async function review(ctx: ExtensionCommandContext, plan: PathPrunePlan): Promise<Array<{ change: PathPruneChange; action: "apply" | "delete" }> | undefined> {
	const out: Array<{ change: PathPruneChange; action: "apply" | "delete" }> = [];
	for (let i = 0; i < plan.changes.length; i++) {
		const c = plan.changes[i];
		const unscoped = c.paths.length === 0;
		const apply = unscoped ? (c.memory.kind === "global" ? "Make it global (~)" : "Make it project-wide") : APPLY;
		const choice = await ctx.ui.select(`(${i + 1}/${plan.changes.length}) ${describeChange(c)}`, [apply, ...(unscoped ? [DELETE] : []), SKIP, APPLY_REST, SKIP_REST]);
		if (choice === undefined) return undefined;
		if (choice === apply) out.push({ change: c, action: "apply" });
		else if (choice === DELETE) out.push({ change: c, action: "delete" });
		else if (choice === APPLY_REST) {
			for (const rest of plan.changes.slice(i)) out.push({ change: rest, action: "apply" });
			break;
		} else if (choice === SKIP_REST) break;
	}
	return out;
}

export async function prunePathsCommand(ctx: ExtensionCommandContext, e: MemoryEngine): Promise<void> {
	const plan = e.planPrune(ctx.cwd);
	if (plan.changes.length === 0) {
		const left = plan.skipped.length;
		ctx.ui.notify(
			left > 0
				? `realctx: nothing to prune; ${left} memor${left === 1 ? "y refers" : "ies refer"} to paths that only exist on other branches`
				: "realctx: no memory refers to a missing path",
			"info",
		);
		return;
	}
	let decisions: Array<{ change: PathPruneChange; action: "apply" | "delete" }> | undefined;
	if (!ctx.hasUI) {
		// Without a UI: only the non-destructive plan (follow moves, drop deleted paths, unscope).
		decisions = plan.changes.map((change) => ({ change, action: "apply" }));
	} else {
		const action = await showText(ctx, `realctx · prune paths · ${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"}`, planLines(plan), [
			{ id: "all" as const, key: "a", label: "apply all" },
			{ id: "review" as const, key: "r", label: "review one by one" },
		]);
		if (!action) return;
		decisions = action === "all" ? plan.changes.map((change) => ({ change, action: "apply" })) : await review(ctx, plan);
		if (!decisions) return;
	}
	if (decisions.length === 0) {
		ctx.ui.notify("realctx: nothing applied", "info");
		return;
	}
	const r = await e.applyPrune(ctx.cwd, decisions);
	ctx.ui.notify(`realctx: ${pruneSummary(plan, r)}`, r.stale.length ? "warning" : "info");
}
