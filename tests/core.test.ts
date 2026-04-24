import { describe, expect, test } from "vitest";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
	createCompletionItems,
	createDiagnostics,
	createHover,
	createInlayHints,
	loadMessageIndex,
	getMessageCompletionContext,
	offsetToPosition,
	parseMessageCalls,
	shouldOfferCompletion,
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

	test("parses m.key() calls with precise ranges", async () => {
		const source = withMessageImport("<h1>{m.common_loading()}</h1>\n<p>{m.missing_key()}</p>");
		const calls = await parseMessageCalls(source);

		expect(calls.map((call) => call.key)).toEqual(["common_loading", "missing_key"]);
		expect(source.slice(calls[0]!.range.start, calls[0]!.range.end)).toBe("common_loading");
		expect(source.slice(calls[1]!.range.start, calls[1]!.range.end)).toBe("missing_key");
		expect(source.slice(calls[0]!.callRange.start, calls[0]!.callRange.end)).toBe(
			"m.common_loading()"
		);
	});

	test("parses static bracket message calls with precise ranges", async () => {
		const source = withMessageImport(
			"<button>{m['session.changes_summary.open']()}</button>\n<p>{m[\"common_loading\"]({ count: 1 })}</p>"
		);
		const calls = await parseMessageCalls(source);

		expect(calls.map((call) => call.key)).toEqual([
			"session.changes_summary.open",
			"common_loading",
		]);
		expect(source.slice(calls[0]!.range.start, calls[0]!.range.end)).toBe(
			"session.changes_summary.open"
		);
		expect(source.slice(calls[1]!.range.start, calls[1]!.range.end)).toBe("common_loading");
		expect(source.slice(calls[0]!.callRange.start, calls[0]!.callRange.end)).toBe(
			"m['session.changes_summary.open']()"
		);
	});

	test("keeps call ranges through multiline arguments", async () => {
		const source = withMessageImport(
			["<p>{m.common_loading({", "\tcount: format(total)", "})}</p>"].join("\n")
		);

		const [call] = await parseMessageCalls(source);

		expect(source.slice(call!.callRange.start, call!.callRange.end)).toBe(
			["m.common_loading({", "\tcount: format(total)", "})"].join("\n")
		);
	});

	test("does not parse message property references followed by unrelated calls", async () => {
		const source = withMessageImport(
			[
				"<script>",
				"\tconst dotReference = m.common_loading + format(total);",
				"\tconst bracketReference = m['session.changes_summary.open'] + format(total);",
				"</script>",
			].join("\n")
		);

		await expect(parseMessageCalls(source)).resolves.toEqual([]);
	});

	test("only parses official m imports", async () => {
		expect(await parseMessageCalls("<h1>{m.common_loading()}</h1>")).toEqual([]);
		expect(
			await parseMessageCalls(
				'import * as messages from "$lib/paraglide/messages";\n<h1>{messages.common_loading()}</h1>'
			)
		).toEqual([]);
	});

	test("parses configured message function aliases", async () => {
		const source = [
			'<script lang="ts">',
			'\timport * as messages from "$lib/paraglide/messages";',
			"</script>",
			"",
			"<h1>{messages.common_loading()}</h1>",
			"<button>{messages['session.changes_summary.open']()}</button>",
		].join("\n");

		expect((await parseMessageCalls(source)).map((call) => call.key)).toEqual([]);

		const calls = await parseMessageCalls(source, {
			messageFunctionAliases: ["messages"],
		});

		expect(calls.map((call) => call.key)).toEqual([
			"common_loading",
			"session.changes_summary.open",
		]);
		expect(source.slice(calls[0]!.callRange.start, calls[0]!.callRange.end)).toBe(
			"messages.common_loading()"
		);
	});

	test("parses configured aliases from multiline named imports", async () => {
		const source = [
			'<script lang="ts">',
			"\timport {",
			"\t\tmessages",
			'\t} from "$lib/paraglide/messages";',
			"</script>",
			"",
			"<h1>{messages.common_loading()}</h1>",
		].join("\n");

		const calls = await parseMessageCalls(source, {
			messageFunctionAliases: ["messages"],
		});

		expect(calls.map((call) => call.key)).toEqual(["common_loading"]);
		expect(source.slice(calls[0]!.callRange.start, calls[0]!.callRange.end)).toBe(
			"messages.common_loading()"
		);
	});

	test("does not rewrite message keys that match a configured alias", async () => {
		const source = [
			'<script lang="ts">',
			'\timport * as messages from "$lib/paraglide/messages";',
			"</script>",
			"",
			"<h1>{messages.messages()}</h1>",
		].join("\n");

		const [call] = await parseMessageCalls(source, {
			messageFunctionAliases: ["messages"],
		});

		expect(call?.key).toBe("messages");
		expect(source.slice(call!.range.start, call!.range.end)).toBe("messages");
	});

	test("does not parse configured aliases without matching imports", async () => {
		const source = [
			'<script lang="ts">',
			'\timport * as m from "$lib/paraglide/messages";',
			"</script>",
			"",
			"<h1>{messages.common_loading()}</h1>",
		].join("\n");

		await expect(
			parseMessageCalls(source, {
				messageFunctionAliases: ["messages"],
			})
		).resolves.toEqual([]);
	});

	test("ignores message-like calls inside comments and strings", async () => {
		const source = withMessageImport(
			[
				"// m.comment_key()",
				'const label = "m.string_key()"',
				"const template = `m.template_key()`",
				"<h1>{m.common_loading()}</h1>",
			].join("\n")
		);

		const calls = await parseMessageCalls(source);

		expect(calls.map((call) => call.key)).toEqual(["common_loading"]);
	});

	test("creates diagnostics for unknown keys and missing locale translations", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source = withMessageImport(
			"<h1>{m.common_loading()}</h1>\n<button>{m.auth_login_title()}</button>\n<p>{m.missing_key()}</p>"
		);
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const diagnostics = await createDiagnostics(uri, source, index);

		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			"消息 auth_login_title 缺少 locale：en",
			"未知 Paraglide 消息 key：missing_key",
		]);
	});

	test("creates hover content with all locale translations", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source = withMessageImport("<h1>{m.common_loading()}</h1>");
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const hover = await createHover(uri, source, source.indexOf("common_loading") + 2, index);

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
			"session.changes_summary.open",
		]);
		expect(completions[0]!.detail).toBe("zh: 登录");
	});

	test("filters completion items for dot access while keeping dotted keys for bracket access", async () => {
		const index = await loadMessageIndex(fixtureRoot);

		expect(createCompletionItems(index, "dot").map((item) => item.label)).toEqual([
			"auth_login_title",
			"common_loading",
			"common_reload",
		]);
		expect(createCompletionItems(index, "bracket").map((item) => item.label)).toEqual([
			"auth_login_title",
			"common_loading",
			"common_reload",
			"session.changes_summary.open",
		]);
	});

	test("detects message completion access context", () => {
		expect(getMessageCompletionContext("{m.common", "{m.common".length)).toBe("dot");
		expect(getMessageCompletionContext("{m['session.changes", "{m['session.changes".length)).toBe(
			"bracket"
		);
		expect(getMessageCompletionContext('{m["session.changes', '{m["session.changes'.length)).toBe(
			"bracket"
		);
		expect(getMessageCompletionContext("{messages.common", "{messages.common".length)).toBeNull();
		expect(
			getMessageCompletionContext("{messages.common", "{messages.common".length, {
				messageFunctionAliases: ["messages"],
			})
		).toBe("dot");
	});

	test("offers completions inside static bracket message access", () => {
		expect(shouldOfferCompletion("{m['session.changes", "{m['session.changes".length)).toBe(true);
		expect(shouldOfferCompletion('{m["session.changes', '{m["session.changes'.length)).toBe(true);
		expect(shouldOfferCompletion("{messages.common", "{messages.common".length)).toBe(false);
		expect(
			shouldOfferCompletion("{messages.common", "{messages.common".length, {
				messageFunctionAliases: ["messages"],
			})
		).toBe(true);
	});

	test("creates other inlay hints for target locale translations and missing locales", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source = withMessageImport(
			"<h1>{m.common_loading()}</h1>\n<button>{m.auth_login_title()}</button>"
		);
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const hints = await createInlayHints(
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
		expect(hints[0]!.position).toEqual(offsetToPosition(source, source.indexOf("}</h1>")));
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
			await createInlayHints(uri, source, hintsFullRange, index, {
				enabled: false,
				displayLocale: "en",
			})
		).toEqual([]);
	});

	test("uses auto locale and compact truncation for inlay hints", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source = withMessageImport("<h1>{m.common_loading()}</h1>");
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const hints = await createInlayHints(uri, source, hintsFullRange, index, {
			enabled: true,
			displayLocale: "auto",
			format: "compact",
			maxLength: 2,
		});

		expect(hints.map((hint) => hint.label)).toEqual(["zh · 加载…"]);
	});

	test("creates inlay hints for static bracket message calls", async () => {
		const index = await loadMessageIndex(fixtureRoot);
		const source = withMessageImport("<button>{m['session.changes_summary.open']()}</button>");
		const uri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		const hints = await createInlayHints(uri, source, hintsFullRange, index, {
			enabled: true,
			displayLocale: "en",
			format: "compact",
		});

		expect(hints.map((hint) => hint.label)).toEqual(["en · Open"]);
	});
});

function withMessageImport(source: string): string {
	return `<script lang="ts">\n\timport * as m from "$lib/paraglide/messages";\n</script>\n\n${source}`;
}

const hintsFullRange = {
	start: { line: 0, character: 0 },
	end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
};
