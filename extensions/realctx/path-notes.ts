/**
 * Per-session state for path notes: which memories were already shown on this
 * branch, which paths the agent touched recently, and the text appended to tool results.
 */
import type { CustomEntryDraft } from "@earendil-works/pi-coding-agent";

export const SHOWN_ENTRY = "realctx-shown";

interface ShownData {
	ids: string[];
	/** Ids whose notes left the context (their tool result was dropped, §13.3): show them again. */
	unshow?: string[];
}

const LEGACY_SHOWN = "realmem-shown";

export interface BranchEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	firstKeptEntryId?: string | null;
}

export class PathNoteState {
	private shown = new Set<string>();
	private unflushed: string[] = [];
	private recent: string[] = [];
	lastSync = 0;

	/**
	 * Rebuild from the entries of the current branch (session start, tree navigation,
	 * compaction). A compaction summarises everything before its first kept entry, so
	 * notes recorded there are no longer in context and may be shown again: only ids
	 * recorded from the first kept entry onwards stay marked.
	 */
	reset(branch: ReadonlyArray<BranchEntry>, opts: { keepUnflushed?: boolean } = {}): void {
		const pending = opts.keepUnflushed ? this.unflushed : [];
		this.shown.clear();
		this.unflushed = [];
		const index = new Map<string, number>();
		branch.forEach((e, i) => {
			if (e.id) index.set(e.id, i);
		});
		// Only the last compaction on the branch matters.
		let keptFrom = 0;
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type !== "compaction") continue;
			keptFrom = e.firstKeptEntryId && index.has(e.firstKeptEntryId) ? (index.get(e.firstKeptEntryId) as number) : i;
			break;
		}
		for (let i = keptFrom; i < branch.length; i++) {
			const e = branch[i];
			if (e.type !== "custom" || (e.customType !== SHOWN_ENTRY && e.customType !== LEGACY_SHOWN)) continue;
			const data = e.data as ShownData | undefined;
			if (Array.isArray(data?.ids)) for (const id of data.ids) if (typeof id === "string") this.shown.add(id);
			if (Array.isArray(data?.unshow)) for (const id of data.unshow) if (typeof id === "string") this.shown.delete(id);
		}
		// Shown in the current turn and not yet persisted: those tool results are still in context.
		for (const id of pending) {
			this.shown.add(id);
			this.unflushed.push(id);
		}
		if (opts.keepUnflushed) for (const id of this.unshown) this.shown.delete(id);
		else this.unshown = [];
	}

	get shownIds(): Set<string> {
		return this.shown;
	}

	markShown(ids: string[]): void {
		for (const id of ids) {
			if (this.shown.has(id)) continue;
			this.shown.add(id);
			this.unflushed.push(id);
		}
	}

	/**
	 * The tool results that carried these notes were dropped from the context (§13.3):
	 * forget that they were shown, so the next touch of their paths shows them again.
	 */
	unshow(ids: string[]): void {
		const gone = ids.filter((id) => this.shown.has(id));
		if (gone.length === 0) return;
		for (const id of gone) this.shown.delete(id);
		this.unflushed = this.unflushed.filter((id) => !gone.includes(id));
		this.unshown.push(...gone);
	}

	private unshown: string[] = [];

	/** Entry recording newly shown (and un-shown) ids on the branch, or undefined when nothing changed. */
	flush(): CustomEntryDraft | undefined {
		if (this.unflushed.length === 0 && this.unshown.length === 0) return undefined;
		const data: ShownData = { ids: this.unflushed };
		if (this.unshown.length > 0) data.unshow = this.unshown;
		const draft: CustomEntryDraft = { type: "custom", customType: SHOWN_ENTRY, data };
		this.unflushed = [];
		this.unshown = [];
		return draft;
	}

	touch(paths: string[]): void {
		for (const p of paths) {
			if (!p) continue;
			const i = this.recent.indexOf(p);
			if (i >= 0) this.recent.splice(i, 1);
			this.recent.unshift(p);
		}
		if (this.recent.length > 48) this.recent.length = 48;
	}

	/** Recently touched absolute paths, most recent first. */
	recentPaths(n = 24): string[] {
		return this.recent.slice(0, n);
	}
}
