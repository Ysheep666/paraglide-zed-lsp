#!/usr/bin/env node
import {
	createConnection,
	ProposedFeatures,
	TextDocumentSyncKind,
	type CompletionItem,
	type Diagnostic,
	type InitializeParams,
	type InitializeResult,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TextDocuments } from "vscode-languageserver/node.js";
import {
	createCompletionItems,
	createDiagnostics,
	createHover,
	createInlayHints,
	getMessageCompletionContext,
	type InlayHintOptions,
	type MessageFunctionOptions,
	type MessageIndex,
} from "./core.js";
import { DocumentValidationVersions, MessageIndexCache } from "./server-state.js";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let workspaceFolders: string[] = [];
let hasConfigurationCapability = false;
const messageIndexCache = new MessageIndexCache();
const validationVersions = new DocumentValidationVersions();
const pendingValidationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const VALIDATION_DEBOUNCE_MS = 100;

type ParaglideServerSettings = {
	inlayHints: InlayHintOptions;
	messageFunctionAliases: NonNullable<MessageFunctionOptions["messageFunctionAliases"]>;
};

const defaultServerSettings = {
	inlayHints: {
		enabled: true,
		displayLocale: "auto",
		format: "compact",
		maxLength: 80,
		showExisting: true,
		showMissing: true,
	},
	messageFunctionAliases: [],
} satisfies ParaglideServerSettings;

connection.onInitialize((params: InitializeParams): InitializeResult => {
	hasConfigurationCapability = params.capabilities.workspace?.configuration === true;
	workspaceFolders = params.workspaceFolders?.map((folder) => folder.uri) ?? [];
	if (workspaceFolders.length === 0 && params.rootUri) {
		workspaceFolders = [params.rootUri];
	}

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			hoverProvider: true,
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: [".", "'", "\""],
			},
			inlayHintProvider: {
				resolveProvider: false,
			},
		},
	};
});

documents.onDidOpen((event) => {
	scheduleValidateDocument(event.document, 0);
});

documents.onDidChangeContent((event) => {
	scheduleValidateDocument(event.document, VALIDATION_DEBOUNCE_MS);
});

documents.onDidClose((event) => {
	clearPendingValidation(event.document.uri);
	validationVersions.clear(event.document.uri);
	connection.sendDiagnostics({
		uri: event.document.uri,
		diagnostics: [],
	});
});

connection.onHover(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const [index, settings] = await Promise.all([
		loadIndexForDocument(document.uri),
		loadServerSettings(),
	]);
	if (!index) return null;

	return await createHover(
		document.uri,
		document.getText(),
		document.offsetAt(params.position),
		index,
		settings
	);
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];

	const source = document.getText();
	const offset = document.offsetAt(params.position);
	const settings = await loadServerSettings();
	const completionContext = getMessageCompletionContext(source, offset, settings);
	if (!completionContext) return [];

	const index = await loadIndexForDocument(document.uri);
	if (!index) return [];

	return createCompletionItems(index, completionContext);
});

connection.languages.inlayHint.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];

	const [index, settings] = await Promise.all([
		loadIndexForDocument(document.uri),
		loadServerSettings(),
	]);
	if (!index) return [];

	return await createInlayHints(
		document.uri,
		document.getText(),
		params.range,
		index,
		{
			...settings.inlayHints,
			messageFunctionAliases: settings.messageFunctionAliases,
		}
	);
});

connection.onDidChangeConfiguration(() => {
	messageIndexCache.clear();
	for (const document of documents.all()) {
		scheduleValidateDocument(document, 0);
	}
	void connection.languages.inlayHint.refresh().catch((error: unknown) => {
		connection.console.warn(formatError(error));
	});
});

documents.listen(connection);
connection.listen();

function scheduleValidateDocument(document: TextDocument, delayMs: number): void {
	clearPendingValidation(document.uri);
	validationVersions.mark(document.uri, document.version);

	const timer = setTimeout(() => {
		pendingValidationTimers.delete(document.uri);
		void validateDocument(document.uri, document.version);
	}, delayMs);
	pendingValidationTimers.set(document.uri, timer);
}

function clearPendingValidation(documentUri: string): void {
	const timer = pendingValidationTimers.get(documentUri);
	if (timer) {
		clearTimeout(timer);
		pendingValidationTimers.delete(documentUri);
	}
}

async function validateDocument(documentUri: string, version: number): Promise<void> {
	const document = documents.get(documentUri);
	if (!document || document.version !== version || !validationVersions.isCurrent(documentUri, version)) {
		return;
	}

	let diagnostics: Diagnostic[] = [];

	try {
		const index = await loadIndexForDocument(document.uri);
		if (index) {
			const settings = await loadServerSettings();
			diagnostics = await createDiagnostics(document.uri, document.getText(), index, settings);
		}
	} catch (error) {
		connection.console.warn(formatError(error));
	}

	const latestDocument = documents.get(documentUri);
	if (
		!latestDocument ||
		latestDocument.version !== version ||
		!validationVersions.isCurrent(documentUri, version)
	) {
		return;
	}

	connection.sendDiagnostics({
		uri: document.uri,
		diagnostics,
	});
}

async function loadIndexForDocument(documentUri: string): Promise<MessageIndex | null> {
	try {
		return await messageIndexCache.loadForDocument(documentUri, workspaceFolders);
	} catch (error) {
		connection.console.warn(formatError(error));
		return null;
	}
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

async function loadServerSettings(): Promise<ParaglideServerSettings> {
	if (!hasConfigurationCapability) return defaultServerSettings;

	try {
		const raw = (await connection.workspace.getConfiguration("paraglideI18n")) as unknown;
		const root = isRecord(raw) && isRecord(raw.paraglideI18n) ? raw.paraglideI18n : raw;
		return {
			inlayHints: normalizeInlayHintOptions(root),
			messageFunctionAliases: normalizeMessageFunctionAliases(root),
		};
	} catch (error) {
		connection.console.warn(formatError(error));
		return defaultServerSettings;
	}
}

function normalizeInlayHintOptions(raw: unknown): InlayHintOptions {
	if (!isRecord(raw)) return defaultServerSettings.inlayHints;

	const rawInlayHints = isRecord(raw.inlayHints) ? raw.inlayHints : {};

	return {
		enabled: readBoolean(rawInlayHints.enabled, defaultServerSettings.inlayHints.enabled),
		displayLocale: readString(rawInlayHints.displayLocale),
		format: readInlayHintFormat(rawInlayHints.format, defaultServerSettings.inlayHints.format),
		maxLength: readNumber(rawInlayHints.maxLength, defaultServerSettings.inlayHints.maxLength),
		showExisting: readBoolean(
			rawInlayHints.showExisting,
			defaultServerSettings.inlayHints.showExisting
		),
		showMissing: readBoolean(rawInlayHints.showMissing, defaultServerSettings.inlayHints.showMissing),
	};
}

function normalizeMessageFunctionAliases(
	raw: unknown
): NonNullable<MessageFunctionOptions["messageFunctionAliases"]> {
	if (!isRecord(raw)) return defaultServerSettings.messageFunctionAliases;
	return readStringArray(raw.messageFunctionAliases, defaultServerSettings.messageFunctionAliases);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readInlayHintFormat(
	value: unknown,
	fallback: NonNullable<InlayHintOptions["format"]>
): NonNullable<InlayHintOptions["format"]> {
	return value === "plain" || value === "compact" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value;
}
