import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalEntryType, migrateBaseDir, migrateSharedStore } from "../src/migrate.ts";

test("realmem base dir moves to realctx, database renamed (with WAL files)", () => {
	const agent = mkdtempSync(join(tmpdir(), "realctx-mig-"));
	try {
		const legacy = join(agent, "realmem");
		mkdirSync(join(legacy, "global"), { recursive: true });
		writeFileSync(join(legacy, "realmem.sqlite"), "db");
		writeFileSync(join(legacy, "realmem.sqlite-wal"), "wal");
		writeFileSync(join(legacy, "config.json"), "{}");
		writeFileSync(join(legacy, "global", "a.md"), "fact");
		const base = join(agent, "realctx");
		assert.match(migrateBaseDir(agent, base) ?? "", /moved realmem data/);
		assert.ok(!existsSync(legacy));
		assert.equal(readFileSync(join(base, "realctx.sqlite"), "utf8"), "db");
		assert.equal(readFileSync(join(base, "realctx.sqlite-wal"), "utf8"), "wal");
		assert.equal(readFileSync(join(base, "global", "a.md"), "utf8"), "fact");
		assert.equal(migrateBaseDir(agent, base), undefined, "idempotent");
	} finally {
		rmSync(agent, { recursive: true, force: true });
	}
});

test("both dirs exist: only a missing database is brought over", () => {
	const agent = mkdtempSync(join(tmpdir(), "realctx-mig-"));
	try {
		mkdirSync(join(agent, "realmem"), { recursive: true });
		mkdirSync(join(agent, "realctx"), { recursive: true });
		writeFileSync(join(agent, "realmem", "realmem.sqlite"), "old");
		assert.match(migrateBaseDir(agent, join(agent, "realctx")) ?? "", /moved the realmem database/);
		assert.equal(readFileSync(join(agent, "realctx", "realctx.sqlite"), "utf8"), "old");
		writeFileSync(join(agent, "realmem", "realmem.sqlite"), "newer");
		assert.equal(migrateBaseDir(agent, join(agent, "realctx")), undefined, "an existing realctx database is never overwritten");
		assert.equal(readFileSync(join(agent, "realctx", "realctx.sqlite"), "utf8"), "old");
	} finally {
		rmSync(agent, { recursive: true, force: true });
	}
});

test("project .pi/realmem moves (or merges) into .pi/realctx", () => {
	const root = mkdtempSync(join(tmpdir(), "realctx-migp-"));
	try {
		mkdirSync(join(root, ".pi", "realmem"), { recursive: true });
		writeFileSync(join(root, ".pi", "realmem", "a.md"), "a");
		assert.match(migrateSharedStore(root) ?? "", /moved project memories/);
		assert.equal(readFileSync(join(root, ".pi", "realctx", "a.md"), "utf8"), "a");
		mkdirSync(join(root, ".pi", "realmem"), { recursive: true });
		writeFileSync(join(root, ".pi", "realmem", "a.md"), "clash");
		writeFileSync(join(root, ".pi", "realmem", "b.md"), "b");
		assert.match(migrateSharedStore(root) ?? "", /merged 1 file/);
		assert.equal(readFileSync(join(root, ".pi", "realctx", "a.md"), "utf8"), "a", "clashes are not overwritten");
		assert.equal(readFileSync(join(root, ".pi", "realctx", "b.md"), "utf8"), "b");
		assert.ok(existsSync(join(root, ".pi", "realmem", "a.md")), "clashing leftover stays for review");
		assert.equal(migrateSharedStore(join(root, "nope")), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("realmem-* session entries read as realctx-*", () => {
	assert.equal(canonicalEntryType("realmem-shown"), "realctx-shown");
	assert.equal(canonicalEntryType("realmem-snapshot"), "realctx-snapshot");
	assert.equal(canonicalEntryType("realctx-ids"), "realctx-ids");
	assert.equal(canonicalEntryType(undefined), undefined);
});
