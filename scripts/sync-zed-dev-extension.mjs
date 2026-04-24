import { cp, mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = join(
	homedir(),
	"Library/Application Support/Zed/extensions/work/paraglide-i18n"
);

if (!existsSync(join(root, "dist/src/server.js"))) {
	throw new Error("缺少 dist/src/server.js，请先运行 bun run build。");
}

if (!existsSync(join(root, "node_modules/vscode-languageserver"))) {
	throw new Error("缺少 node_modules/vscode-languageserver，请先运行 bun install。");
}

await mkdir(workDir, { recursive: true });
await rm(join(workDir, "dist"), { recursive: true, force: true });
await rm(join(workDir, "node_modules"), { recursive: true, force: true });
await rm(join(workDir, "package.json"), { force: true });

await cp(join(root, "dist"), join(workDir, "dist"), {
	recursive: true,
	force: true,
});
await symlink(join(root, "node_modules"), join(workDir, "node_modules"), "dir");
await symlink(join(root, "package.json"), join(workDir, "package.json"), "file");

console.log(`已同步 Zed dev extension work 目录：${workDir}`);
