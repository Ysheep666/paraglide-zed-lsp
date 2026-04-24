import { describe, expect, test } from "vitest";
import {
	DocumentValidationVersions,
	MessageIndexCache,
	type MessageIndexLoader,
	type ProjectRootFinder,
} from "../src/server-state.js";
import type { MessageIndex } from "../src/core.js";

describe("server state", () => {
	test("caches concurrent message index loads per project root", async () => {
		let loadCount = 0;
		const findProjectRoot: ProjectRootFinder = async () => "/project";
		const loadMessageIndex: MessageIndexLoader = async (projectRoot) => {
			loadCount += 1;
			return createMessageIndex(projectRoot);
		};
		const cache = new MessageIndexCache({
			findProjectRoot,
			loadMessageIndex,
			ttlMs: 1_000,
			now: () => 0,
		});

		const [first, second] = await Promise.all([
			cache.loadForDocument("file:///project/src/a.svelte", []),
			cache.loadForDocument("file:///project/src/b.svelte", []),
		]);

		expect(first).toBe(second);
		expect(loadCount).toBe(1);
	});

	test("reloads message index after explicit invalidation", async () => {
		let loadCount = 0;
		const cache = new MessageIndexCache({
			findProjectRoot: async () => "/project",
			loadMessageIndex: async (projectRoot) => {
				loadCount += 1;
				return createMessageIndex(projectRoot);
			},
			ttlMs: 1_000,
			now: () => 0,
		});

		await cache.loadForDocument("file:///project/src/a.svelte", []);
		cache.clear();
		await cache.loadForDocument("file:///project/src/a.svelte", []);

		expect(loadCount).toBe(2);
	});

	test("tracks only the latest validation version per document", () => {
		const versions = new DocumentValidationVersions();

		versions.mark("file:///project/src/a.svelte", 1);
		expect(versions.isCurrent("file:///project/src/a.svelte", 1)).toBe(true);

		versions.mark("file:///project/src/a.svelte", 2);
		expect(versions.isCurrent("file:///project/src/a.svelte", 1)).toBe(false);
		expect(versions.isCurrent("file:///project/src/a.svelte", 2)).toBe(true);

		versions.clear("file:///project/src/a.svelte");
		expect(versions.isCurrent("file:///project/src/a.svelte", 2)).toBe(false);
	});
});

function createMessageIndex(projectRoot: string): MessageIndex {
	return {
		projectRoot,
		baseLocale: "en",
		locales: ["en"],
		messages: new Map(),
	};
}
