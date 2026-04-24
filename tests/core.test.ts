import { describe, expect, test } from "vitest";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
	createCompletionItems,
	createDiagnostics,
	createHover,
	createInlayHints,
	loadMessageIndex,
	parseMessageCalls,
} from "../src/core.js";

const fixtureRoot = join(import.meta.dirname, "fixtures/runloom-admin");

describe("Paraglide i18n LSP core", () => {
	test("loads message keys from project.inlang settings and locale files", async () => {
		const index = await loadMessageIndex(fixtureRoot);

		expect(index.baseLocale).toBe("zh");
		expect(index.locales).toEqual(["zh", "en"]);
		expect(index.messages.get("common_loading")?.translations).toEqual({
			zh: "加载中…",
			en: "Loading…",
		});
		expect(index.messages.get("auth_login_title")?.missingLocales).toEqual(["en"]);
	});

	test("parses m.key() calls with precise ranges", () => {
		const source = "<h1>{m.common_loading()}</h1>\n<p>{m.missing_key()}</p>";
		const calls = parseMessageCalls(source);

		expect(calls.map((call) => call.key)).toEqual(["common_loading", "missing_key"]);
		expect(source.slice(calls[0]!.range.start, calls[0]!.range.end)).toBe("common_loading");
		expect(source.slice(calls[1]!.range.start, calls[1]!.range.end)).toBe("missing_key");
		expect(source.slice(calls[0]!.callRange.start, calls[0]!.callRange.end)).toBe(
			"m.common_loading()"
		);
	});

	test("creates diagnostics for unknown keys and missing locale translations", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source = "<h1>{m.common_loading()}</h1>\n<button>{m.auth_login_title()}</button>\n<p>{m.missing_key()}</p>";
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const diagnostics = createDiagnostics(uri, source, index);

		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			"消息 auth_login_title 缺少 locale：en",
			"未知 Paraglide 消息 key：missing_key",
		]);
	});

	test("creates hover content with all locale translations", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source = "<h1>{m.common_loading()}</h1>";
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const hover = createHover(uri, source, 8, index);

		expect(hover?.contents).toEqual({
			kind: "markdown",
			value: ["`common_loading`", "", "- zh: 加载中…", "- en: Loading…"].join("\n"),
		});
	});

	test("creates sorted completion items from message keys", async () => {
		const index = await loadMessageIndex(fixtureRoot);

		const completions = createCompletionItems(index);

		expect(completions.map((item) => item.label)).toEqual([
			"auth_login_title",
			"common_loading",
			"common_reload",
		]);
		expect(completions[0]!.detail).toBe("zh: 登录");
	});

	test("creates other inlay hints for target locale translations and missing locales", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source =
			"<h1>{m.common_loading()}</h1>\n<button>{m.auth_login_title()}</button>";
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const hints = createInlayHints(
			uri,
			source,
			{
				start: { line: 0, character: 0 },
				end: { line: 10, character: 0 },
			},
			index,
			{
				enabled: true,
				displayLocale: "en",
				format: "compact",
				maxLength: 80,
				showExisting: true,
				showMissing: true,
			}
		);

		expect(hints.map((hint) => hint.label)).toEqual([
			"en · Loading…",
			"en · missing",
		]);
		expect(hints[0]!.position).toEqual({ line: 0, character: 23 });
		expect(hints[0]!.paddingLeft).toBe(true);
		expect(hints[0]!.kind).toBeUndefined();
		expect(hints[0]!.tooltip).toEqual({
			kind: "markdown",
			value: ["`common_loading`", "", "- zh: 加载中…", "- en: Loading…"].join("\n"),
		});
		expect(hints[1]!.tooltip).toEqual({
			kind: "markdown",
			value: ["`auth_login_title`", "", "- zh: 登录", "- en: (missing)"].join("\n"),
		});

		expect(
			createInlayHints(uri, source, hintsFullRange, index, {
				enabled: false,
				displayLocale: "en",
			})
		).toEqual([]);
	});

	test("uses auto locale and compact truncation for inlay hints", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source = "<h1>{m.common_loading()}</h1>";
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const hints = createInlayHints(uri, source, hintsFullRange, index, {
			enabled: true,
			displayLocale: "auto",
			format: "compact",
			maxLength: 2,
		});

		expect(hints.map((hint) => hint.label)).toEqual(["zh · 加载…"]);
	});
});

const hintsFullRange = {
	start: { line: 0, character: 0 },
	end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
};
