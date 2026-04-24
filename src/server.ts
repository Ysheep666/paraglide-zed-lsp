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
	loadMessageIndex,
	shouldOfferCompletion,
	type InlayHintOptions,
	type MessageIndex,
} from "./core.js";
import { findProjectRootForDocument } from "./workspace.js";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let workspaceFolders: string[] = [];
let hasConfigurationCapability = false;

type ParaglideServerSettings = {
	inlayHints: InlayHintOptions;
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
				triggerCharacters: ["."],
			},
			inlayHintProvider: {
				resolveProvider: false,
			},
		},
	};
});

documents.onDidOpen((event) => {
	void validateDocument(event.document);
});

documents.onDidChangeContent((event) => {
	void validateDocument(event.document);
});

documents.onDidClose((event) => {
	connection.sendDiagnostics({
		uri: event.document.uri,
		diagnostics: [],
	});
});

connection.onHover(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const index = await loadIndexForDocument(document.uri);
	if (!index) return null;

	return createHover(document.uri, document.getText(), document.offsetAt(params.position), index);
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];

	const source = document.getText();
	const offset = document.offsetAt(params.position);
	if (!shouldOfferCompletion(source, offset)) return [];

	const index = await loadIndexForDocument(document.uri);
	if (!index) return [];

	return createCompletionItems(index);
});

connection.languages.inlayHint.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];

	const [index, settings] = await Promise.all([
		loadIndexForDocument(document.uri),
		loadServerSettings(),
	]);
	if (!index) return [];

	return createInlayHints(
		document.uri,
		document.getText(),
		params.range,
		index,
		settings.inlayHints
	);
});

connection.onDidChangeConfiguration(() => {
	for (const document of documents.all()) {
		void validateDocument(document);
	}
	void connection.languages.inlayHint.refresh().catch((error: unknown) => {
		connection.console.warn(formatError(error));
	});
});

documents.listen(connection);
connection.listen();

async function validateDocument(document: TextDocument): Promise<void> {
	let diagnostics: Diagnostic[] = [];

	try {
		const index = await loadIndexForDocument(document.uri);
		if (index) {
			diagnostics = createDiagnostics(document.uri, document.getText(), index);
		}
	} catch (error) {
		connection.console.warn(formatError(error));
	}

	connection.sendDiagnostics({
		uri: document.uri,
		diagnostics,
	});
}

async function loadIndexForDocument(documentUri: string): Promise<MessageIndex | null> {
	const projectRoot = await findProjectRootForDocument(documentUri, workspaceFolders);
	if (!projectRoot) return null;

	try {
		return await loadMessageIndex(projectRoot);
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
		return {
			inlayHints: normalizeInlayHintOptions(raw),
		};
	} catch (error) {
		connection.console.warn(formatError(error));
		return defaultServerSettings;
	}
}

function normalizeInlayHintOptions(raw: unknown): InlayHintOptions {
	if (!isRecord(raw)) return defaultServerSettings.inlayHints;

	const root = isRecord(raw.paraglideI18n) ? raw.paraglideI18n : raw;
	const rawInlayHints = isRecord(root.inlayHints) ? root.inlayHints : {};

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
