/**
 * Stand-in for cursor-agent in tests. Reads the prompt from stdin to EOF, prints
 * system/init, then replays the scenario file named by FAKE_CURSOR_SCENARIO line
 * by line. Lines with a "fake" key are directives instead of output:
 *   {"fake":"text","text":"..."}               stream the text as two partial deltas, then the segment's closing copy
 *   {"fake":"thinking","text":"..."}           stream thinking deltas, then thinking/completed
 *   {"fake":"call","id":"call-1\nfc_1","name":"quiz","arguments":{...}}
 *                                             print tool_call started, call the MCP bridge, wait, print completed
 *   add "mcpFirst":true to send the MCP request before the stdout event
 *   {"fake":"native","name":"shellToolCall"}  print a refused native call (started + completed permissionDenied)
 *   {"fake":"reply"}                          stream one segment whose text is every MCP result so far, joined by " | "
 *   {"fake":"result","usage":{...}}           print result/success
 *   {"fake":"hold"}                           stay alive until killed
 *   {"fake":"exit","code":1,"stderr":"..."}   write stderr and exit with that code
 * FAKE_CURSOR_STDIN, when set, receives the prompt. FAKE_CURSOR_LOG, when set,
 * gets one JSON line per run describing argv, cwd, HOME and the workspace files,
 * and one line per MCP result the fake received.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HOLD_INTERVAL_MS = 60_000;
const SERVER = "learnharness";
const sessionId = randomUUID();

function writeLine(value) {
	const line = typeof value === "string" ? value : JSON.stringify(value);
	return new Promise((resolve) => process.stdout.write(`${line}\n`, resolve));
}

let stamp = 1_800_000_000_000;
const now = () => ++stamp;

const workspace = process.argv[process.argv.indexOf("--workspace") + 1];
const mcpFile = join(workspace, ".cursor", "mcp.json");
const rulesFile = join(workspace, ".cursor", "rules", "learnharness.mdc");

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_CURSOR_STDIN) writeFileSync(process.env.FAKE_CURSOR_STDIN, prompt);
if (process.env.FAKE_CURSOR_LOG) {
	appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify({
		argv: process.argv.slice(2),
		cwd: process.cwd(),
		home: process.env.HOME,
		envKeys: Object.keys(process.env).sort(),
		rules: readFileSync(rulesFile, "utf8"),
		mcpConfig: readFileSync(mcpFile, "utf8"),
		mcpConfigMode: statSync(mcpFile).mode & 0o777,
		prompt,
	})}\n`);
}

await writeLine({ type: "system", subtype: "init", apiKeySource: "login", cwd: workspace, session_id: sessionId, model: "Fake Grok", permissionMode: "default" });
await writeLine({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, session_id: sessionId });

let client = null;
async function bridge() {
	if (client) return client;
	const { url, headers } = JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers[SERVER];
	client = new Client({ name: "fake-cursor-agent", version: "1.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
	return client;
}

async function streamText(text) {
	const half = Math.ceil(text.length / 2);
	for (const part of [text.slice(0, half), text.slice(half)]) {
		if (part) await writeLine({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: part }] }, session_id: sessionId, timestamp_ms: now() });
	}
	await writeLine({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId, model_call_id: `${randomUUID()}-0`, timestamp_ms: now() });
}

function mcpToolCall(directive, result) {
	return {
		mcpToolCall: {
			args: { name: `${SERVER}-${directive.name}`, args: directive.arguments, toolCallId: directive.id, providerIdentifier: SERVER, toolName: directive.name, serverIdentifier: SERVER },
			...(result ? { result } : {}),
		},
		toolCallId: directive.id,
	};
}

const results = [];
const lines = readFileSync(process.env.FAKE_CURSOR_SCENARIO, "utf8").split("\n").filter(Boolean);
for (const line of lines) {
	const directive = JSON.parse(line);
	switch (directive.fake) {
		case "text":
			await streamText(directive.text);
			break;

		case "thinking":
			await writeLine({ type: "thinking", subtype: "delta", text: directive.text, session_id: sessionId, timestamp_ms: now() });
			await writeLine({ type: "thinking", subtype: "completed", session_id: sessionId, timestamp_ms: now() });
			break;

		case "call": {
			const started = { type: "tool_call", subtype: "started", call_id: directive.id, tool_call: mcpToolCall(directive), session_id: sessionId, timestamp_ms: now() };
			const connection = await bridge();
			if (!directive.mcpFirst) await writeLine(started);
			const request = connection.callTool({ name: directive.name, arguments: directive.arguments }, undefined, { timeout: 600_000 });
			if (directive.mcpFirst) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				await writeLine(started);
			}
			const result = await request;
			const text = result.content.map((block) => block.text).join("");
			results.push(text);
			if (process.env.FAKE_CURSOR_LOG) appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify({ callResult: text, name: directive.name })}\n`);
			await writeLine({ ...started, subtype: "completed", tool_call: mcpToolCall(directive, { success: { content: [{ text: { text } }], isError: result.isError === true } }) });
			break;
		}

		case "native": {
			const id = `native-${randomUUID()}`;
			const started = { type: "tool_call", subtype: "started", call_id: id, tool_call: { [directive.name]: { args: {} } }, session_id: sessionId };
			await writeLine(started);
			await writeLine({ ...started, subtype: "completed", tool_call: { [directive.name]: { args: {}, result: { permissionDenied: { error: "Command blocked by permissions configuration" } } } } });
			break;
		}

		case "reply":
			await streamText(results.join(" | "));
			break;

		case "result":
			await writeLine({ type: "result", subtype: "success", duration_ms: 1234, is_error: false, result: "", session_id: sessionId, usage: directive.usage ?? { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 } });
			break;

		case "hold":
			setInterval(() => {}, HOLD_INTERVAL_MS);
			await new Promise(() => {});
			break;

		case "exit":
			process.stderr.write(directive.stderr ?? "");
			process.exit(directive.code);
			break;

		default:
			await writeLine(line);
	}
}
await client?.close();
