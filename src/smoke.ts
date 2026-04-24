import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type JsonRpcMessage = {
	id?: number;
	method?: string;
	result?: unknown;
	error?: unknown;
	params?: unknown;
};

const projectRoot = join(import.meta.dirname, "../../tests/fixtures/runloom-admin");
const serverPath = join(import.meta.dirname, "server.js");
const samplePath = join(projectRoot, "src/sample.svelte");
const sampleUri = pathToFileURL(samplePath).toString();

const server = spawn(process.execPath, [serverPath], {
	stdio: ["pipe", "pipe", "pipe"],
});

let buffer = Buffer.alloc(0);
const pending = new Map<number, (message: JsonRpcMessage) => void>();

server.stdout.on("data", (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk]);
	readMessages();
});

server.stderr.on("data", (chunk: Buffer) => {
	process.stderr.write(chunk);
});

server.on("exit", (code) => {
	if (code !== null && code !== 0) {
		throw new Error(`LSP server exited with code ${code}`);
	}
});

try {
	await request(1, "initialize", {
		processId: process.pid,
		rootUri: pathToFileURL(projectRoot).toString(),
		capabilities: {},
		workspaceFolders: [
			{
				uri: pathToFileURL(projectRoot).toString(),
				name: "runloom-admin",
			},
		],
	});
	notify("initialized", {});

	const sampleText = await readFile(samplePath, "utf8");
	notify("textDocument/didOpen", {
		textDocument: {
			uri: sampleUri,
			languageId: "svelte",
			version: 1,
			text: sampleText,
		},
	});

	const hover = await request(2, "textDocument/hover", {
		textDocument: { uri: sampleUri },
		position: { line: 4, character: 9 },
	});
	const hoverText = JSON.stringify(hover.result);
	if (!hoverText.includes("common_loading") || !hoverText.includes("Loading")) {
		throw new Error(`hover smoke failed: ${hoverText}`);
	}

	const completion = await request(3, "textDocument/completion", {
		textDocument: { uri: sampleUri },
		position: { line: 4, character: 8 },
	});
	const completionText = JSON.stringify(completion.result);
	if (!completionText.includes("common_loading")) {
		throw new Error(`completion smoke failed: ${completionText}`);
	}

	const inlayHints = await request(4, "textDocument/inlayHint", {
		textDocument: { uri: sampleUri },
		range: {
			start: { line: 0, character: 0 },
			end: { line: 20, character: 0 },
		},
	});
	const inlayHintText = JSON.stringify(inlayHints.result);
	if (!inlayHintText.includes("zh · 加载中") || !inlayHintText.includes("zh · 登录")) {
		throw new Error(`inlay hint smoke failed: ${inlayHintText}`);
	}

	await request(5, "shutdown", null);
	notify("exit", null);
} finally {
	server.kill();
}

function request(id: number, method: string, params: unknown): Promise<JsonRpcMessage> {
	write({
		jsonrpc: "2.0",
		id,
		method,
		params,
	});

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`request timed out: ${method}`));
		}, 5_000);

		pending.set(id, (message) => {
			clearTimeout(timer);
			if (message.error) {
				reject(new Error(JSON.stringify(message.error)));
				return;
			}
			resolve(message);
		});
	});
}

function notify(method: string, params: unknown): void {
	write({
		jsonrpc: "2.0",
		method,
		params,
	});
}

function write(message: unknown): void {
	const json = JSON.stringify(message);
	const length = Buffer.byteLength(json, "utf8");
	server.stdin.write(`Content-Length: ${length}\r\n\r\n${json}`);
}

function readMessages(): void {
	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;

		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const match = /Content-Length: (\d+)/i.exec(header);
		if (!match) throw new Error(`invalid LSP header: ${header}`);

		const length = Number(match[1]);
		const messageStart = headerEnd + 4;
		const messageEnd = messageStart + length;
		if (buffer.length < messageEnd) return;

		const json = buffer.subarray(messageStart, messageEnd).toString("utf8");
		buffer = buffer.subarray(messageEnd);

		const message = JSON.parse(json) as JsonRpcMessage;
		if (typeof message.id === "number") {
			pending.get(message.id)?.(message);
			pending.delete(message.id);
		}
	}
}
