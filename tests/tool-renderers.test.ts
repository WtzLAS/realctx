import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { toolRenderers } from "../extensions/realctx/tool-renderers.ts";

const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t } as Theme;
const body = "SECRET_MEMORY_BODY_DO_NOT_RENDER";
const names = ["recall", "remember", "expand", "status", "list", "forget"];
function render(name: string, details: unknown, expanded = false, content = body, extra = {}) {
	const renderer = toolRenderers(`realctx_${name}`).renderResult!;
	const component = renderer({ content: [{ type: "text", text: content }], details }, { expanded, isPartial: false }, theme, extra as any);
	for (const width of [1, 12, 40, 80]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, line);
	return component.render(200).join("\n");
}

test("recall/list: IDs and captions, bounded collapse, no bodies even expanded", () => {
	const memories = Array.from({ length: 10 }, (_, i) => ({ id: `id${i}`, caption: `Caption ${i}` }));
	for (const name of ["recall", "list"]) {
		const details = { memories, total: 30, page: 2, pages: 3, embedError: "offline", missing: ["missing-id"], outputs: [42] };
		const small = render(name, details);
		assert.match(small, /10 of 30 memories · page 2\/3/);
		assert.match(small, /id0  Caption 0/);
		assert.match(small, /\+4 more/);
		assert.match(small, /Keyword search only/);
		assert.match(small, /missing-id/);
		assert.match(small, /#42/);
		assert.doesNotMatch(small, /Caption 9|SECRET_MEMORY_BODY/);
		assert.match(render(name, details, true), /Caption 9/);
		assert.doesNotMatch(render(name, details, true), /SECRET_MEMORY_BODY/);
	}
	const legacy = render("recall", undefined, false, `<memory id="old-id" scope="global">\n# Old caption\n${body}\n</memory>`);
	assert.match(legacy, /old-id  Old caption/);
	assert.doesNotMatch(legacy, /SECRET_MEMORY_BODY/);
	assert.match(render("recall", { memories: [] }), /0 memories/);
});

test("all calls and collapsed results stay concise; errors, progress and expansions remain useful", () => {
	for (const name of names) {
		const r = toolRenderers(`realctx_${name}`);
		const call = r.renderCall!({ caption: "A caption", content: body, queries: ["a query"], ids: [42] }, theme, {} as any);
		assert.doesNotMatch(call.render(200).join("\n"), /SECRET_MEMORY_BODY/);
		assert.doesNotMatch(render(name, undefined), /SECRET_MEMORY_BODY/);
		assert.match(render(name, undefined, false, "network failed", { isError: true }), /✗ network failed/);
		const progress = r.renderResult!({ content: [{ type: "text", text: "judging…" }], details: undefined }, { expanded: false, isPartial: true }, theme, {} as any);
		assert.match(progress.render(80).join("\n"), /judging/);
	}
	const remember = render("remember", { status: "edited", id: "abc", caption: "Stored title", scope: "global", warnings: ["Secrets redacted before storing"] });
	assert.match(remember, /✓ edited  abc  Stored title/);
	assert.match(remember, /Secrets redacted/);
	assert.match(render("forget", { deleted: ["abc"], memories: [{ id: "abc", caption: "Removed" }], missing: ["xyz"] }), /1 deleted[\s\S]*abc  Removed[\s\S]*xyz/);
	assert.match(render("expand", { restored: [42], history: [3] }), /Restored 1 outputs · history h3/);
	assert.match(render("expand", { restored: [42] }, true), /SECRET_MEMORY_BODY/, "explicit expansion previews originals only on demand");
	assert.match(render("status", { stores: [{ memories: 3 }], pending: 2, project: { name: "project" } }), /3 memories · 2 queued · project/);
});

test("untrusted captions cannot inject terminal controls or extra rows", () => {
	const out = render("recall", { memories: [{ id: "id", caption: "Good\n\x1b[2Jbad\x07 title" }] });
	assert.doesNotMatch(out, /\x1b|\x07/);
	assert.equal(out.split("\n").length, 2);
});
