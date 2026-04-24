import mFunctionMatcher from "@inlang/plugin-m-function-matcher";
import type { MessageReference } from "@inlang/plugin-m-function-matcher";
import type { MessageCall, MessageFunctionOptions } from "./core.js";

const officialMatcher =
	mFunctionMatcher.meta["app.inlang.ideExtension"].messageReferenceMatchers[0];

export async function matchMessageCalls(
	source: string,
	options: MessageFunctionOptions = {}
): Promise<MessageCall[]> {
	if (!officialMatcher) return [];

	try {
		const aliases = normalizeMessageFunctionAliases(options.messageFunctionAliases);
		const calls = await Promise.all(
			aliases.map(async (alias) => {
				const input = createMatcherInput(source, alias);
				if (!input) return [];

				const references = await officialMatcher({ documentText: input.matcherSource });
				return references
					.map((reference) => toMessageCall(input, reference, aliases))
					.filter((call): call is MessageCall => call !== null)
					.filter((call) => isCodeOffset(source, call.callRange.start));
			})
		);

		return calls
			.flat()
			.filter(dedupeMessageCalls())
			.sort((left, right) => left.callRange.start - right.callRange.start);
	} catch {
		return [];
	}
}

export function normalizeMessageFunctionAliases(aliases: readonly string[] | undefined): string[] {
	const normalized = new Set<string>(["m"]);

	for (const alias of aliases ?? []) {
		const value = alias.trim();
		if (/^[A-Za-z_$][\w$]*$/.test(value)) {
			normalized.add(value);
		}
	}

	return [...normalized];
}

type MatcherInput = {
	originalSource: string;
	matcherSource: string;
	toOriginalOffset: (offset: number) => number;
};

function toMessageCall(
	input: MatcherInput,
	reference: MessageReference,
	aliases: readonly string[]
): MessageCall | null {
	const { matcherSource, originalSource } = input;
	const key = reference.messageId;
	const matcherKeyStart = officialPositionToOffset(matcherSource, reference.position.start);
	const keyStart = input.toOriginalOffset(matcherKeyStart);
	const keyEnd = keyStart + key.length;
	const callStart = findCallStart(originalSource, keyStart, aliases);
	const callEnd = findCallEnd(originalSource, keyStart, keyEnd);

	if (callStart === null || callEnd === null || callEnd <= keyEnd) return null;
	if (originalSource.slice(keyStart, keyEnd) !== key) return null;

	return {
		key,
		range: {
			start: keyStart,
			end: keyEnd,
		},
		callRange: {
			start: callStart,
			end: callEnd,
		},
	};
}

function createMatcherInput(source: string, alias: string): MatcherInput | null {
	if (alias === "m") {
		return {
			originalSource: source,
			matcherSource: source,
			toOriginalOffset: (offset) => offset,
		};
	}

	if (!hasAliasImport(source, alias)) return null;

	const { matcherSource, offsetMap } = normalizeAliasSource(source, alias);
	return {
		originalSource: source,
		matcherSource,
		toOriginalOffset: (offset) => offsetMap[Math.min(offset, offsetMap.length - 1)] ?? source.length,
	};
}

function hasAliasImport(source: string, alias: string): boolean {
	const escapedAlias = escapeRegExp(alias);
	return (
		new RegExp(`\\bimport\\s+\\*\\s+as\\s+${escapedAlias}\\b`).test(source) ||
		new RegExp(`\\bimport\\s*\\{[^}]*\\b${escapedAlias}\\b[^}]*\\}`).test(source)
	);
}

function normalizeAliasSource(
	source: string,
	alias: string
): { matcherSource: string; offsetMap: number[] } {
	let matcherSource = "";
	const offsetMap: number[] = [];

	for (let offset = 0; offset < source.length; ) {
		if (shouldNormalizeAliasAt(source, offset, alias)) {
			matcherSource += "m";
			offsetMap.push(offset);
			offset += alias.length;
			continue;
		}

		matcherSource += source[offset];
		offsetMap.push(offset);
		offset += 1;
	}

	offsetMap.push(source.length);

	return { matcherSource, offsetMap };
}

function shouldNormalizeAliasAt(source: string, offset: number, alias: string): boolean {
	if (!isIdentifierAt(source, offset, alias)) return false;

	return isCallObjectAt(source, offset, alias) || isImportAliasAt(source, offset, alias);
}

function isIdentifierAt(source: string, offset: number, identifier: string): boolean {
	if (!source.startsWith(identifier, offset)) return false;

	const before = offset > 0 ? source[offset - 1] : "";
	const after = source[offset + identifier.length] ?? "";
	return !isIdentifierPart(before) && !isIdentifierPart(after);
}

function isCallObjectAt(source: string, offset: number, alias: string): boolean {
	const next = source[offset + alias.length];
	return next === "." || next === "[";
}

function isImportAliasAt(source: string, offset: number, alias: string): boolean {
	const declaration = findImportDeclarationAround(source, offset);
	if (!declaration) return false;

	const relativeOffset = offset - declaration.start;
	const prefix = declaration.text.slice(0, relativeOffset);
	const suffix = declaration.text.slice(relativeOffset + alias.length);
	const isNamespaceAlias = /\*\s+as\s+$/.test(prefix);
	const isNamedBinding =
		prefix.lastIndexOf("{") > prefix.lastIndexOf("}") &&
		suffix.includes("}") &&
		/^[\s,}]/.test(suffix) &&
		!/^\s+as\b/.test(suffix);

	return isNamespaceAlias || isNamedBinding;
}

function findImportDeclarationAround(
	source: string,
	offset: number
): { start: number; text: string } | null {
	for (
		let importStart = source.lastIndexOf("import", offset);
		importStart !== -1;
		importStart = source.lastIndexOf("import", importStart - 1)
	) {
		if (!isIdentifierAt(source, importStart, "import")) continue;

		const end = findImportDeclarationEnd(source, importStart);
		if (end === null) continue;
		if (offset >= end) return null;

		return { start: importStart, text: source.slice(importStart, end) };
	}

	return null;
}

function findImportDeclarationEnd(source: string, importStart: number): number | null {
	const fromIndex = findImportFromKeyword(source, importStart + "import".length);
	if (fromIndex === null) return null;

	const quoteStart = findModuleSpecifierQuote(source, fromIndex + "from".length);
	if (quoteStart === null) return null;

	const quote = source[quoteStart];
	if (!quote) return null;

	let escaped = false;
	for (let offset = quoteStart + 1; offset < source.length; offset += 1) {
		const character = source[offset];
		if (!character) continue;

		if (escaped) {
			escaped = false;
			continue;
		}

		if (character === "\\") {
			escaped = true;
			continue;
		}

		if (character === quote) {
			let end = offset + 1;
			while (/[ \t]/.test(source[end] ?? "")) {
				end += 1;
			}
			return source[end] === ";" ? end + 1 : end;
		}
	}

	return null;
}

function findImportFromKeyword(source: string, offset: number): number | null {
	let depth = 0;

	for (let current = offset; current < source.length; current += 1) {
		const character = source[current];
		if (character === ";") return null;
		if (character === "{") depth += 1;
		if (character === "}") depth = Math.max(0, depth - 1);

		if (depth === 0 && isIdentifierAt(source, current, "from")) {
			return current;
		}
	}

	return null;
}

function findModuleSpecifierQuote(source: string, offset: number): number | null {
	for (let current = offset; current < source.length; current += 1) {
		const character = source[current];
		if (character === "'" || character === '"') return current;
		if (!/\s/.test(character ?? "")) return null;
	}

	return null;
}

function officialPositionToOffset(
	source: string,
	position: { line: number; character: number }
): number {
	return positionToOffset(source, {
		line: Math.max(0, position.line - 1),
		character: Math.max(0, position.character - 1),
	});
}

function positionToOffset(
	source: string,
	position: { line: number; character: number }
): number {
	let line = 0;
	let lineStart = 0;

	for (let offset = 0; offset < source.length && line < position.line; offset += 1) {
		if (source.charCodeAt(offset) === 10) {
			line += 1;
			lineStart = offset + 1;
		}
	}

	const lineEnd = source.indexOf("\n", lineStart);
	const maxCharacter = (lineEnd === -1 ? source.length : lineEnd) - lineStart;
	return lineStart + Math.min(position.character, Math.max(0, maxCharacter));
}

function findCallStart(source: string, keyStart: number, aliases: readonly string[]): number | null {
	const dotIndex = keyStart - 1;
	if (source[dotIndex] === ".") {
		return findAliasStartBefore(source, dotIndex, aliases);
	}

	const quoteIndex = keyStart - 1;
	const bracketIndex = quoteIndex - 1;
	if ((source[quoteIndex] === "'" || source[quoteIndex] === '"') && source[bracketIndex] === "[") {
		return findAliasStartBefore(source, bracketIndex, aliases);
	}

	return null;
}

function findAliasStartBefore(
	source: string,
	endOffset: number,
	aliases: readonly string[]
): number | null {
	let startOffset = endOffset;
	while (startOffset > 0 && isIdentifierPart(source[startOffset - 1] ?? "")) {
		startOffset -= 1;
	}

	const identifier = source.slice(startOffset, endOffset);
	return aliases.includes(identifier) ? startOffset : null;
}

function findCallEnd(source: string, keyStart: number, keyEnd: number): number | null {
	const openParen = findCallOpenParen(source, keyStart, keyEnd);
	if (openParen === null) return null;

	return findClosingParenEnd(source, openParen);
}

function findCallOpenParen(source: string, keyStart: number, keyEnd: number): number | null {
	const accessKind = source[keyStart - 1];
	let offset = skipWhitespace(source, keyEnd);

	if (accessKind === ".") {
		return source[offset] === "(" ? offset : null;
	}

	if (accessKind !== "'" && accessKind !== '"') return null;
	if (source[offset] !== accessKind) return null;

	offset = skipWhitespace(source, offset + 1);
	if (source[offset] !== "]") return null;

	offset = skipWhitespace(source, offset + 1);
	return source[offset] === "(" ? offset : null;
}

function skipWhitespace(source: string, offset: number): number {
	let current = offset;
	while (/\s/.test(source[current] ?? "")) {
		current += 1;
	}

	return current;
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

function isCodeOffset(source: string, targetOffset: number): boolean {
	let state:
		| "code"
		| "singleLineComment"
		| "multiLineComment"
		| "htmlComment"
		| "singleQuote"
		| "doubleQuote"
		| "template" = "code";
	let escaped = false;

	for (let offset = 0; offset < targetOffset; offset += 1) {
		const character = source[offset];
		const next = source[offset + 1];
		if (!character) continue;

		if (state === "code") {
			if (source.startsWith("<!--", offset)) {
				state = "htmlComment";
				offset += 3;
				continue;
			}
			if (character === "/" && next === "/") {
				state = "singleLineComment";
				offset += 1;
				continue;
			}
			if (character === "/" && next === "*") {
				state = "multiLineComment";
				offset += 1;
				continue;
			}
			if (character === "'") {
				state = "singleQuote";
				escaped = false;
				continue;
			}
			if (character === '"') {
				state = "doubleQuote";
				escaped = false;
				continue;
			}
			if (character === "`") {
				state = "template";
				escaped = false;
			}
			continue;
		}

		if (state === "singleLineComment") {
			if (character === "\n") state = "code";
			continue;
		}

		if (state === "multiLineComment") {
			if (character === "*" && next === "/") {
				state = "code";
				offset += 1;
			}
			continue;
		}

		if (state === "htmlComment") {
			if (source.startsWith("-->", offset)) {
				state = "code";
				offset += 2;
			}
			continue;
		}

		if (escaped) {
			escaped = false;
			continue;
		}

		if (character === "\\") {
			escaped = true;
			continue;
		}

		if (state === "singleQuote" && character === "'") {
			state = "code";
			continue;
		}

		if (state === "doubleQuote" && character === '"') {
			state = "code";
			continue;
		}

		if (state === "template" && character === "`") {
			state = "code";
		}
	}

	return state === "code";
}

function dedupeMessageCalls(): (call: MessageCall) => boolean {
	const seen = new Set<string>();

	return (call) => {
		const key = `${call.key}:${call.range.start}:${call.range.end}`;
		if (seen.has(key)) return false;

		seen.add(key);
		return true;
	};
}

function isIdentifierPart(character: string): boolean {
	return /^[A-Za-z0-9_$]$/.test(character);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
