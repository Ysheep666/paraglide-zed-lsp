import { loadMessageIndex, type MessageIndex } from "./core.js";
import { findProjectRootForDocument } from "./workspace.js";

export type ProjectRootFinder = (
	documentUri: string,
	workspaceFolders: string[]
) => Promise<string | null>;

export type MessageIndexLoader = (projectRoot: string) => Promise<MessageIndex>;

type MessageIndexCacheOptions = {
	findProjectRoot?: ProjectRootFinder;
	loadMessageIndex?: MessageIndexLoader;
	ttlMs?: number;
	now?: () => number;
};

type CachedMessageIndex = {
	expiresAt: number;
	value: Promise<MessageIndex | null>;
};

const DEFAULT_INDEX_CACHE_TTL_MS = 1_000;

export class MessageIndexCache {
	private readonly findProjectRoot: ProjectRootFinder;
	private readonly loadMessageIndex: MessageIndexLoader;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly cache = new Map<string, CachedMessageIndex>();

	constructor(options: MessageIndexCacheOptions = {}) {
		this.findProjectRoot = options.findProjectRoot ?? findProjectRootForDocument;
		this.loadMessageIndex = options.loadMessageIndex ?? loadMessageIndex;
		this.ttlMs = options.ttlMs ?? DEFAULT_INDEX_CACHE_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	async loadForDocument(
		documentUri: string,
		workspaceFolders: readonly string[]
	): Promise<MessageIndex | null> {
		const projectRoot = await this.findProjectRoot(documentUri, [...workspaceFolders]);
		if (!projectRoot) return null;

		const cached = this.cache.get(projectRoot);
		const now = this.now();
		if (cached && cached.expiresAt > now) return await cached.value;

		const value = this.loadMessageIndex(projectRoot).catch((error: unknown) => {
			this.cache.delete(projectRoot);
			throw error;
		});
		this.cache.set(projectRoot, {
			expiresAt: now + this.ttlMs,
			value,
		});

		return await value;
	}

	clear(): void {
		this.cache.clear();
	}
}

export class DocumentValidationVersions {
	private readonly versions = new Map<string, number>();

	mark(documentUri: string, version: number): void {
		this.versions.set(documentUri, version);
	}

	isCurrent(documentUri: string, version: number): boolean {
		return this.versions.get(documentUri) === version;
	}

	clear(documentUri: string): void {
		this.versions.delete(documentUri);
	}
}
