import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findProjectRootForDocument } from "../src/workspace.js";

describe("workspace discovery", () => {
	test("finds apps/admin style project.inlang from a document path", async () => {
		const fixtureRoot = join(import.meta.dirname, "fixtures/runloom-admin");
		const documentUri = pathToFileURL(join(fixtureRoot, "src/sample.svelte")).toString();

		await expect(findProjectRootForDocument(documentUri, [])).resolves.toBe(fixtureRoot);
	});
});
