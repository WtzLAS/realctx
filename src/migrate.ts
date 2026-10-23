/**
 * Migration from realmem (§16): `~/.pi/agent/realmem/` becomes `~/.pi/agent/realctx/`
 * (database renamed, tables kept) and project stores at `.pi/realmem/` move to
 * `.pi/realctx/`. Memory ids and file contents are unchanged.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_DIR = "realmem";
export const LEGACY_DB = "realmem.sqlite";
export const LEGACY_SHARED = join(".pi", "realmem");

/** Move a legacy realmem base directory into the realctx one. Returns a notice, or undefined when nothing moved. */
export function migrateBaseDir(agentDir: string, base: string): string | undefined {
	const legacy = join(agentDir, LEGACY_DIR);
	if (!existsSync(legacy)) return undefined;
	if (existsSync(base)) {
		// Both exist (e.g. an earlier partial run): only bring over a database that is missing.
		const db = join(base, "realctx.sqlite");
		if (!existsSync(db) && existsSync(join(legacy, LEGACY_DB))) {
			for (const sfx of ["", "-wal", "-shm"]) if (existsSync(join(legacy, LEGACY_DB + sfx))) renameSync(join(legacy, LEGACY_DB + sfx), db + sfx);
			return `realctx: moved the realmem database into ${base}`;
		}
		return undefined;
	}
	mkdirSync(agentDir, { recursive: true });
	renameSync(legacy, base);
	for (const sfx of ["", "-wal", "-shm"]) {
		const from = join(base, LEGACY_DB + sfx);
		if (existsSync(from)) renameSync(from, join(base, `realctx.sqlite${sfx}`));
	}
	return `realctx: moved realmem data from ${legacy} to ${base}`;
}

/** Move a project's `.pi/realmem/` store to `.pi/realctx/`. Returns a one-line notice, or undefined. */
export function migrateSharedStore(root: string): string | undefined {
	const from = join(root, LEGACY_SHARED);
	const to = join(root, ".pi", "realctx");
	if (!existsSync(from)) return undefined;
	if (!existsSync(to)) {
		renameSync(from, to);
		return `realctx: moved project memories from .pi/realmem/ to .pi/realctx/ (commit the move)`;
	}
	let moved = 0;
	for (const name of readdirSync(from)) {
		const dest = join(to, name);
		if (existsSync(dest)) continue;
		renameSync(join(from, name), dest);
		moved++;
	}
	try {
		rmdirSync(from);
	} catch {
		// clashing leftovers stay for manual review
	}
	return moved > 0 ? `realctx: merged ${moved} file(s) from .pi/realmem/ into .pi/realctx/ (commit the move)` : undefined;
}

/** Session entry types written by realmem, read as their realctx equivalents. */
export function canonicalEntryType(customType: string | undefined): string | undefined {
	if (!customType) return customType;
	return customType.startsWith("realmem-") ? `realctx-${customType.slice("realmem-".length)}` : customType;
}
