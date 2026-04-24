import { access } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { URI } from "vscode-uri";

export async function findProjectRootForDocument(
	documentUri: string,
	workspaceFolders: string[]
): Promise<string | null> {
	const filePath = URI.parse(documentUri).fsPath;
	const startDir = dirname(filePath);
	const directRoot = await findProjectRootUpwards(startDir);
	if (directRoot) return directRoot;

	for (const folder of workspaceFolders) {
		const workspaceRoot = URI.parse(folder).fsPath;
		for (const candidate of [workspaceRoot, resolve(workspaceRoot, "apps/admin")]) {
			if (await hasInlangSettings(candidate)) return candidate;
		}
	}

	return null;
}

async function findProjectRootUpwards(startDir: string): Promise<string | null> {
	let current = resolve(startDir);
	const root = parse(current).root;

	while (true) {
		if (await hasInlangSettings(current)) return current;
		if (current === root) return null;
		current = dirname(current);
	}
}

async function hasInlangSettings(projectRoot: string): Promise<boolean> {
	try {
		await access(resolve(projectRoot, "project.inlang/settings.json"));
		return true;
	} catch {
		return false;
	}
}
