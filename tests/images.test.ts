/**
 * Images: size detection from encoded headers, per-model token cost, image-aware drop rules,
 * placeholders, historian transcripts and fallback outlines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/config.ts";
import { estimateMessage, fallbackHistory, type MessageView, messageKey, renderHistory, renderTranscript, userImageId } from "../src/history.ts";
import { GENERIC_IMAGE_COST, imageCostFor, imageSize, imageTokens } from "../src/images.ts";
import { contentTokens, type OutputMeta } from "../src/outputs.ts";
import { filterOutputs, renderPlaceholder } from "../src/policy.ts";
import { gif, image, jpeg, png, webpLossless, webpVp8x } from "./fixtures-images.ts";

test("image sizes come from the encoded header (PNG, JPEG past large APP segments, GIF, WebP)", () => {
	assert.deepEqual(imageSize(png(1920, 1080)), { width: 1920, height: 1080 });
	assert.deepEqual(imageSize(jpeg(2000, 1500)), { width: 2000, height: 1500 });
	assert.deepEqual(imageSize(jpeg(640, 480, 60_000)), { width: 640, height: 480 }, "frame header after a 60 KB EXIF block");
	assert.deepEqual(imageSize(gif(320, 200)), { width: 320, height: 200 });
	assert.deepEqual(imageSize(webpVp8x(3000, 2000)), { width: 3000, height: 2000 });
	assert.deepEqual(imageSize(webpLossless(800, 600)), { width: 800, height: 600 });
	assert.equal(imageSize(Buffer.from("not an image at all, just text").toString("base64")), undefined);
	assert.equal(imageSize(""), undefined);
});

test("image token cost follows the model that receives the image", () => {
	const claude = imageCostFor({ provider: "anthropic", id: "claude-sonnet-4-5-20250929" });
	assert.equal(claude.tokens(1000, 1000), 1334);
	// Downscaled to ~1.15 MP first.
	assert.equal(claude.tokens(2000, 1500), 1598);
	// Claude ≥ 4.7 keeps high-resolution images.
	assert.equal(imageCostFor({ provider: "anthropic", id: "claude-opus-4-7" }).tokens(2000, 1500), 4000);
	assert.equal(imageCostFor({ provider: "anthropic", id: "claude-opus-4-20250514" }).name, "anthropic");
	assert.equal(imageCostFor({ provider: "openrouter", id: "anthropic/claude-3.5-sonnet" }).name, "anthropic");
	// OpenAI tiles: 1024² → 768² → 4 tiles.
	assert.equal(imageCostFor({ provider: "openai", id: "gpt-4o" }).tokens(1024, 1024), 765);
	assert.equal(imageCostFor({ provider: "openai", id: "gpt-5" }).tokens(1024, 1024), 630);
	assert.equal(imageCostFor({ provider: "openai", id: "gpt-4.1-mini" }).tokens(1024, 1024), 1024);
	assert.ok(imageCostFor({ provider: "openai", id: "gpt-4.1-mini" }).tokens(4000, 4000) <= 1536);
	// Gemini.
	assert.equal(imageCostFor({ provider: "google", id: "gemini-2.5-pro" }).tokens(300, 300), 258);
	assert.equal(imageCostFor({ provider: "google", id: "gemini-3-pro-preview" }).tokens(4000, 3000), 1120);
	// Unknown: w·h/750, no cap; unreadable sizes count as the largest image Pi sends.
	assert.equal(GENERIC_IMAGE_COST.tokens(1500, 1000), 2000);
	assert.equal(imageTokens({ data: "garbage" }), GENERIC_IMAGE_COST.tokens(2000, 2000));
	// Content and messages use it.
	const parts = [{ type: "text", text: "x" }, image(png(1500, 1000))];
	assert.equal(contentTokens(parts) - contentTokens([{ type: "text", text: "x" }]), 2000);
	assert.equal(contentTokens(parts, claude) - contentTokens([{ type: "text", text: "x" }]), 1599);
	const small = { role: "user", content: [{ type: "text", text: "hi" }, image(png(200, 100))], timestamp: 1 } as MessageView;
	const large = { role: "user", content: [{ type: "text", text: "hi" }, image(png(2000, 2000))], timestamp: 1 } as MessageView;
	assert.ok(estimateMessage(large) - estimateMessage(small) > 5000);
});

const cfg = normalizeSettings({ context: { imageMaxTurns: 3, protectTurns: 2, dropMinTokens: 1000 } }).context;

function meta(ord: number, o: Partial<OutputMeta>): OutputMeta {
	return { id: `c${ord}`, ord, tool: "read", args: `shot${ord}.png`, sig: `s${ord}`, tokens: 3000, turn: ord, isError: false, paths: [], mtimes: {}, noteIds: [], file: "/none", capturedAt: 0, ...o };
}

test("drop rules: old images drop by rule; small images may still drop; recent ones are protected", () => {
	const outputs = [
		meta(1, { images: 1, turn: 1 }), // old image → rule
		meta(2, { images: 1, tokens: 400, turn: 2 }), // small but an image: above IMAGE_DROP_MIN → rule
		meta(3, { images: 1, tokens: 150, turn: 2 }), // tiny image → small
		meta(4, { turn: 2 }), // old text → gray zone (judge)
		meta(5, { images: 2, tool: "user", args: "", turn: 7 }), // within imageMaxTurns, outside protectTurns → gray zone
		meta(6, { images: 1, turn: 9 }), // recent → protected
	];
	const r = filterOutputs({ outputs, calls: [], turn: 10, done: new Set(), pinned: new Set(), settings: cfg });
	assert.deepEqual(
		r.rules.map((x) => [x.id, x.reason]),
		[
			["c1", "image"],
			["c2", "image"],
		],
	);
	assert.equal(r.protected.get("c3"), "small");
	assert.deepEqual(
		r.gray.map((g) => g.id),
		["c4", "c5"],
	);
	assert.match(r.protected.get("c6") ?? "", /last 2 turns/);
	// imageMaxTurns 0 turns the rule off: images go to the judge.
	const off = filterOutputs({ outputs, calls: [], turn: 10, done: new Set(), pinned: new Set(), settings: { ...cfg, imageMaxTurns: 0 } });
	assert.equal(off.rules.length, 0);
	assert.ok(off.gray.some((g) => g.id === "c1"));
	assert.equal(DEFAULT_SETTINGS.context.imageMaxTurns, 6);
});

test("placeholders say when images are in an output; user images read as such", () => {
	assert.equal(renderPlaceholder(meta(7, { images: 1, tokens: 1600 }), "drop"), "[#7 dropped · read shot7.png · 1.6k tok · image]");
	assert.equal(renderPlaceholder(meta(8, { images: 3, tokens: 4800 }), "drop", { reason: "image" }), "[#8 dropped · read shot8.png · 4.8k tok · 3 images · old image]");
	assert.equal(renderPlaceholder(meta(9, { tool: "user", args: "", images: 2, tokens: 3200 }), "drop"), "[#9 dropped · 2 user images · 3.2k tok]");
	assert.equal(renderPlaceholder(meta(10, { tool: "user", args: "", images: 1, tokens: 1600 }), "drop"), "[#10 dropped · user image · 1.6k tok]");
});

test("historian transcripts and fallback outlines mark images (with their #N when stored)", () => {
	let t = 100;
	const userMsg: MessageView = { role: "user", content: [{ type: "text", text: "why is the button misaligned here?" }, image(png(800, 600)), image(png(800, 600))], timestamp: t++ };
	const plainUser: MessageView = { role: "user", content: [image(png(10, 10))], timestamp: t++ };
	const messages: MessageView[] = [
		userMsg,
		{ role: "assistant", content: [{ type: "toolCall", id: "s1", name: "screenshot", arguments: { url: "http://localhost" } }], timestamp: t++ },
		{ role: "toolResult", toolCallId: "s1", toolName: "screenshot", content: [image(png(1200, 800))], isError: false, timestamp: t++ },
		{ role: "assistant", content: [{ type: "text", text: "The flex container lacks align-items." }], timestamp: t++ },
		plainUser,
	];
	const uid = userImageId(userMsg);
	assert.ok(uid?.startsWith("user-image:"));
	assert.equal(userImageId({ role: "user", content: "text only", timestamp: 1 }), undefined);
	assert.equal(userImageId(userMsg), uid, "stable");
	const output = (id: string) => (id === uid ? { ord: 4, label: "2 user images" } : id === "s1" ? { ord: 5, label: "screenshot url=http://localhost" } : undefined);
	const tr = renderTranscript(messages, { turnOffset: 0, output, maxTokens: 4000 });
	assert.match(tr, /USER: why is the button misaligned here\?\n\[2 images #4\]/);
	assert.match(tr, /← #5 screenshot \(screenshot url=http:\/\/localhost\): \[image\]/);
	assert.match(tr, /USER: \[image\]/, "an image-only message still shows up");
	// A dropped user image appears as its placeholder.
	const dropped = renderTranscript(messages, { turnOffset: 0, output: (id) => (id === uid ? { ord: 4, label: "x", placeholder: "[#4 dropped · 2 user images · 1.3k tok]" } : undefined), maxTokens: 4000 });
	assert.match(dropped, /misaligned here\?\n\[#4 dropped · 2 user images · 1\.3k tok\]/);
	// Images count as markers for the transcript budget (no shortening of the text).
	assert.ok(!/…/.test(tr));
	const outline = fallbackHistory(messages, { turnOffset: 0, output });
	assert.match(outline, /- user \(turn 1\): why is the button misaligned here\? \[2 images #4\]/);
	assert.match(outline, / {2}screenshot: \[image #5\]/);
});

test("history chunks still match when a user message's images were rendered as a placeholder", () => {
	const msg: MessageView = { role: "user", content: [{ type: "text", text: "look" }, image(png(100, 100))], timestamp: 5 };
	const rendered: MessageView = { ...msg, content: [{ type: "text", text: "look" }, { type: "text", text: "[#1 dropped · user image · 14 tok]" }] };
	const reply: MessageView = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 6 };
	const chunk = { n: 1, turns: [1, 1] as [number, number], startKey: messageKey(msg), endKey: messageKey(reply), count: 2, tokensBefore: 100, tokensAfter: 10, text: "<summary/>", model: "m", at: 0, timestamp: 5, outputs: [1], appliedAt: 1 };
	assert.notEqual(messageKey(rendered), messageKey(msg));
	assert.equal(renderHistory([rendered, reply], [chunk]).rendered.length, 0, "keys of the rendered message do not match");
	assert.equal(renderHistory([rendered, reply], [chunk], [messageKey(msg), messageKey(reply)]).rendered.length, 1, "keys as Pi sent them do");
});
