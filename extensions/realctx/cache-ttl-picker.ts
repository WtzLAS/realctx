import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, TUI } from "@earendil-works/pi-tui";
import { formatCacheLifetime, type ModelCacheTtls } from "../../src/cache-ttl.ts";
import { parseDuration, type Settings } from "../../src/config.ts";
import { FilterPicker, InputSubmenu } from "./ui.ts";

/** A model picker followed by a duration editor; empty/auto removes only that override. */
export function cacheTtlPicker(opts: {
	ctx: ExtensionCommandContext; tui: TUI; theme: Theme; catalog: ModelCacheTtls;
	settings: () => Settings; changed: () => void; close: () => void;
}): Component {
	const { ctx, tui, theme, catalog } = opts;
	const registry = ctx.modelRegistry.getAvailable();
	let child: Component;
	let closed = false;
	let selected: string | undefined;
	let refreshing = false;
	const items = (): SelectItem[] => {
		const cfg = opts.settings().context;
		const models = new Map(registry.map((m) => [`${m.provider}/${m.id}`, m]));
		if (ctx.model) models.set(`${ctx.model.provider}/${ctx.model.id}`, ctx.model);
		const keys = [...new Set([...Object.keys(cfg.cacheTtlByModel), ...models.keys()])];
		return [
			{ value: "__add", label: "✎ Enter a model…", description: "provider/model or model ID" },
			{ value: "__refresh", label: refreshing ? "↻ Refreshing…" : "↻ Refresh catalog", description: catalog.lastError ? `Last refresh failed: ${catalog.lastError}` : "models.dev · cached daily; pricing is not a TTL" },
			...keys.map((key) => {
				const slash = key.indexOf("/");
				const model = models.get(key) ?? (slash < 0 ? { id: key } : { provider: key.slice(0, slash), id: key.slice(slash + 1) });
				return { value: key, label: key, description: formatCacheLifetime(catalog.resolve(model, cfg)) };
			}),
		];
	};
	const back = () => { picker.setItems(items(), selected); child = picker; tui.requestRender(); };
	const refresh = (force: boolean) => {
		refreshing = true;
		picker.setItems(items(), selected);
		void catalog.refresh(force).then(() => {
			refreshing = false;
			if (!closed) { picker.setItems(items(), selected); tui.requestRender(); }
		});
	};
	const edit = (key: string) => {
		selected = key;
		child = new InputSubmenu({
			theme, label: `Cache TTL · ${key}`,
			help: "Duration: 5m, 1h, 300s. 0 = always cold. Empty or auto removes the override. Match the actual provider cache policy.",
			value: opts.settings().context.cacheTtlByModel[key] ?? "auto",
			validate: (v) => !v.trim() || v.trim().toLowerCase() === "auto" || Number.isFinite(parseDuration(v, NaN)) ? undefined : "Enter a duration (5m, 1h, 300s), 0, or auto",
			done: (value) => {
				if (value !== undefined) {
					const map = opts.settings().context.cacheTtlByModel;
					// Avoid ambiguous case variants; the resolver is case-insensitive.
					for (const old of Object.keys(map)) if (old.toLowerCase() === key.toLowerCase()) delete map[old];
					if (value.trim() && value.trim().toLowerCase() !== "auto") map[key] = value.trim();
					opts.changed();
				}
				back();
			},
		});
	};
	const picker = new FilterPicker({
		theme, title: "Cache TTL by model", items: items(), hint: "type to filter · enter edit · esc done",
		done: (key) => {
			if (key === undefined) { closed = true; opts.close(); return; }
			if (key === "__refresh") {
				refresh(true);
				return;
			}
			if (key === "__add") {
				child = new InputSubmenu({
					theme, label: "Model ID", help: "provider/model (recommended) or exact model ID. No wildcards.", value: "",
					validate: (v) => !v.trim() || /[\s*]/.test(v.trim()) ? "Enter a model ID without spaces or wildcards" : undefined,
					done: (v) => v === undefined ? back() : edit(v.trim()),
				});
			} else edit(key);
		},
	});
	child = picker;
	if (opts.settings().context.cacheTtlAuto) refresh(false);
	return { render: (w) => child.render(w), handleInput: (data) => child.handleInput?.(data), invalidate: () => child.invalidate() };
}
