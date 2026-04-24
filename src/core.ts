import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CompletionItemKind,
	DiagnosticSeverity,
	MarkupKind,
	type CompletionItem,
	type Diagnostic,
	type Hover,
	type InlayHint,
	type Position,
	type Range,
} from "vscode-languageserver/node.js";

export type OffsetRange = {
	start: number;
	end: number;
};

export type MessageCall = {
	key: string;
	range: OffsetRange;
	callRange: OffsetRange;
};

export type InlayHintOptions = {
	enabled?: boolean;
	displayLocale?: string;
	format?: "plain" | "compact";
	maxLength?: number;
	showExisting?: boolean;
	showMissing?: boolean;
};

export type MessageEntry = {
	key: string;
	translations: Record<string, string>;
	missingLocales: string[];
};

export type MessageIndex = {
	projectRoot: string;
	baseLocale: string;
	locales: string[];
	messages: Map<string, MessageEntry>;
};

type InlangSettings = {
	baseLocale?: unknown;
	locales?: unknown;
	"plugin.inlang.messageFormat"?: {
		pathPattern?: unknown;
	};
};

export async function loadMessageIndex(projectRoot: string): Promise<MessageIndex> {
	const settingsPath = join(projectRoot, "project.inlang", "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as InlangSettings;
	const baseLocale = readString(settings.baseLocale, "baseLocale");
	const locales = readStringArray(settings.locales, "locales");
	const pathPattern = readPathPattern(settings);
	const entries = new Map<string, MessageEntry>();

	for (const locale of locales) {
		const relativePath = pathPattern.replace("{locale}", locale);
		const filePath = join(projectRoot, relativePath);
		const file = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

		for (const [key, value] of Object.entries(file)) {
			if (key === "$schema" || typeof value !== "string") continue;

			const entry =
				entries.get(key) ??
				({
					key,
					translations: {},
					missingLocales: [],
				} satisfies MessageEntry);

			entry.translations[locale] = value;
			entries.set(key, entry);
		}
	}

	for (const entry of entries.values()) {
		entry.missingLocales = locales.filter((locale) => entry.translations[locale] === undefined);
	}

	return {
		projectRoot,
		baseLocale,
		locales,
		messages: entries,
	};
}

export function parseMessageCalls(source: string): MessageCall[] {
	const calls: MessageCall[] = [];
	const matcher = /\bm\.([A-Za-z_$][\w$]*)\s*\(/g;

	for (const match of source.matchAll(matcher)) {
		const callStart = match.index;
		const key = match[1];
		if (callStart === undefined || key === undefined) continue;

		const keyStart = callStart + match[0].indexOf(key);
		const openParen = callStart + match[0].length - 1;
		const callEnd = findClosingParenEnd(source, openParen) ?? callStart + match[0].length;
		calls.push({
			key,
			range: {
				start: keyStart,
				end: keyStart + key.length,
			},
			callRange: {
				start: callStart,
				end: callEnd,
			},
		});
	}

	return calls;
}

export function createDiagnostics(uri: string, source: string, index: MessageIndex): Diagnostic[] {
	void uri;
	const diagnostics: Diagnostic[] = [];

	for (const call of parseMessageCalls(source)) {
		const entry = index.messages.get(call.key);

		if (!entry) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: offsetRangeToLspRange(source, call.range),
				message: `未知 Paraglide 消息 key：${call.key}`,
				source: "paraglide-zed-lsp",
				code: "unknown-message-key",
			});
			continue;
		}

		if (entry.missingLocales.length > 0) {
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: offsetRangeToLspRange(source, call.range),
				message: `消息 ${call.key} 缺少 locale：${entry.missingLocales.join(", ")}`,
				source: "paraglide-zed-lsp",
				code: "missing-message-locale",
			});
		}
	}

	return diagnostics;
}

export function createHover(
	uri: string,
	source: string,
	offset: number,
	index: MessageIndex
): Hover | null {
	void uri;
	const call = parseMessageCalls(source).find(
		(candidate) => offset >= candidate.range.start && offset <= candidate.range.end
	);
	if (!call) return null;

	const entry = index.messages.get(call.key);
	if (!entry) return null;

	const lines = [`\`${entry.key}\``, ""];
	for (const locale of index.locales) {
		const value = entry.translations[locale];
		lines.push(`- ${locale}: ${value ?? "(missing)"}`);
	}

	return {
		contents: {
			kind: MarkupKind.Markdown,
			value: lines.join("\n"),
		},
		range: offsetRangeToLspRange(source, call.range),
	};
}

export function createCompletionItems(index: MessageIndex): CompletionItem[] {
	return [...index.messages.values()]
		.sort((left, right) => left.key.localeCompare(right.key))
		.map((entry) => {
			const baseText = entry.translations[index.baseLocale];
			const detail = baseText ? `${index.baseLocale}: ${baseText}` : undefined;
			const documentation = index.locales
				.map((locale) => `- ${locale}: ${entry.translations[locale] ?? "(missing)"}`)
				.join("\n");

			return {
				label: entry.key,
				kind: CompletionItemKind.Function,
				detail,
				documentation: {
					kind: MarkupKind.Markdown,
					value: documentation,
				},
			};
		});
}

export function createInlayHints(
	uri: string,
	source: string,
	range: Range,
	index: MessageIndex,
	options: InlayHintOptions = {}
): InlayHint[] {
	void uri;

	if (options.enabled === false) return [];

	const targetLocale = resolveDisplayLocale(index, options.displayLocale);
	const format = options.format ?? "compact";
	const maxLength = normalizeMaxLength(options.maxLength);
	const showExisting = options.showExisting ?? true;
	const showMissing = options.showMissing ?? true;
	const hints: InlayHint[] = [];

	for (const call of parseMessageCalls(source)) {
		const position = offsetToPosition(source, call.callRange.end);
		if (!isPositionInRange(position, range)) continue;

		const entry = index.messages.get(call.key);
		if (!entry) continue;

		const value = entry.translations[targetLocale];
		if (value !== undefined) {
			if (!showExisting) continue;

			hints.push({
				position,
				label: formatInlayHintLabel(targetLocale, value, {
					format,
					maxLength,
				}),
				paddingLeft: true,
				tooltip: createMessageTooltip(entry, index),
			});
			continue;
		}

		if (!showMissing) continue;

		hints.push({
			position,
			label:
				format === "compact"
					? `${targetLocale} · missing`
					: `missing translation for '${targetLocale}'`,
			paddingLeft: true,
			tooltip: createMessageTooltip(entry, index),
		});
	}

	return hints;
}

export function shouldOfferCompletion(source: string, offset: number): boolean {
	const prefix = source.slice(Math.max(0, offset - 80), offset);
	return /\bm\.[A-Za-z_$\w$]*$/.test(prefix);
}

export function offsetToPosition(source: string, offset: number): Position {
	const safeOffset = Math.max(0, Math.min(offset, source.length));
	let line = 0;
	let lineStart = 0;

	for (let index = 0; index < safeOffset; index += 1) {
		if (source.charCodeAt(index) === 10) {
			line += 1;
			lineStart = index + 1;
		}
	}

	return {
		line,
		character: safeOffset - lineStart,
	};
}

function findClosingParenEnd(source: string, openParen: number): number | null {
	let depth = 0;
	let quote: string | null = null;
	let escaped = false;

	for (let index = openParen; index < source.length; index += 1) {
		const character = source[index];
		if (!character) continue;

		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}

			if (character === "\\") {
				escaped = true;
				continue;
			}

			if (character === quote) {
				quote = null;
			}
			continue;
		}

		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}

		if (character === "(") {
			depth += 1;
			continue;
		}

		if (character === ")") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}

	return null;
}

function resolveDisplayLocale(index: MessageIndex, displayLocale: string | undefined): string {
	const requested = displayLocale?.trim();
	if (!requested || requested === "auto") return index.baseLocale;

	const exact = findLocale(index.locales, requested);
	if (exact) return exact;

	const baseLanguage = requested.split(/[-_]/)[0];
	if (baseLanguage) {
		const locale = findLocale(index.locales, baseLanguage);
		if (locale) return locale;
	}

	return index.baseLocale;
}

function findLocale(locales: string[], requested: string): string | undefined {
	const normalized = requested.toLowerCase();
	return locales.find((locale) => locale.toLowerCase() === normalized);
}

function normalizeMaxLength(maxLength: number | undefined): number {
	if (typeof maxLength !== "number" || !Number.isFinite(maxLength)) return 80;
	return Math.max(1, Math.floor(maxLength));
}

function formatInlayHintLabel(
	locale: string,
	value: string,
	options: {
		format: NonNullable<InlayHintOptions["format"]>;
		maxLength: number;
	}
): string {
	const text = truncateText(value, options.maxLength);
	if (options.format === "plain") return text;
	return `${locale} · ${text}`;
}

function truncateText(value: string, maxLength: number): string {
	const characters = [...value];
	if (characters.length <= maxLength) return value;
	return `${characters.slice(0, maxLength).join("")}…`;
}

function createMessageTooltip(entry: MessageEntry, index: MessageIndex) {
	return {
		kind: MarkupKind.Markdown,
		value: [
			`\`${entry.key}\``,
			"",
			...index.locales.map((locale) => `- ${locale}: ${entry.translations[locale] ?? "(missing)"}`),
		].join("\n"),
	};
}

function isPositionInRange(position: Position, range: Range): boolean {
	return comparePositions(position, range.start) >= 0 && comparePositions(position, range.end) <= 0;
}

function comparePositions(left: Position, right: Position): number {
	if (left.line !== right.line) return left.line - right.line;
	return left.character - right.character;
}

function offsetRangeToLspRange(source: string, range: OffsetRange): Range {
	return {
		start: offsetToPosition(source, range.start),
		end: offsetToPosition(source, range.end),
	};
}

function readString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`project.inlang/settings.json 缺少有效字段：${name}`);
	}

	return value;
}

function readStringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`project.inlang/settings.json 缺少有效字段：${name}`);
	}

	return value as string[];
}

function readPathPattern(settings: InlangSettings): string {
	const configured = settings["plugin.inlang.messageFormat"]?.pathPattern;
	if (typeof configured === "string" && configured.includes("{locale}")) return configured;
	return "./messages/{locale}.json";
}
