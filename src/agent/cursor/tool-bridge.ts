import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { JsonObject, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
	type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

export const BRIDGE_SERVER_NAME = "learnharness";

const LOOPBACK_HOST = "127.0.0.1";
const TOKEN_BYTES = 32;

/** One tools/call request the CLI is waiting on. Cursor sends no call id over MCP;
 * the process pairs each request with its stdout `tool_call started` event. */
export type HeldMcpCall = {
	readonly name: string;
	readonly arguments: JsonObject;
	settled: boolean;
	respond(result: CallToolResult): void;
};

type BridgeCallbacks = { onCall(call: HeldMcpCall): void; onError(error: Error): void; onCancel(call: HeldMcpCall): void };

export type CursorToolBridge = {
	/** The workspace `.cursor/mcp.json` contents. Holds the bearer token: write it 0600. */
	mcpConfig: string;
	close(): Promise<void>;
};

export function toCallToolResult(result: ToolResultMessage): CallToolResult {
	// The CLI's models take text only; an image result keeps a marker instead.
	const content = result.content.map((block) => block.type === "text"
		? { type: "text" as const, text: block.text }
		: { type: "text" as const, text: `[image omitted: ${block.mimeType}]` });
	return { content, isError: result.isError };
}

export function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

function toMcpTool(tool: Tool): McpTool {
	return { name: tool.name, description: tool.description, inputSchema: tool.parameters as McpTool["inputSchema"] };
}

// Low-level Server on purpose: McpServer.registerTool only takes zod schemas, and pi tools carry
// JSON Schema that must reach the CLI unchanged.
function createMcpServer(tools: Tool[], callbacks: BridgeCallbacks, held: Set<HeldMcpCall>): Server {
	const server = new Server({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(toMcpTool) }));

	server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
		if (!tools.some((tool) => tool.name === request.params.name)) {
			const error = new McpError(ErrorCode.InvalidParams, "cursor-agent requested an undeclared harness tool");
			callbacks.onError(error);
			throw error;
		}
		return new Promise<CallToolResult>((resolve) => {
			const call: HeldMcpCall = {
				name: request.params.name,
				arguments: (request.params.arguments ?? {}) as JsonObject,
				settled: false,
				respond(result) {
					if (call.settled) return;
					call.settled = true;
					held.delete(call);
					extra.signal.removeEventListener("abort", cancel);
					resolve(result);
				},
			};
			// The CLI cancels a request it stopped waiting for (its 60 s MCP timeout).
			const cancel = () => {
				if (call.settled) return;
				call.respond({ content: [{ type: "text", text: "MCP request cancelled" }], isError: true });
				callbacks.onCancel(call);
			};
			held.add(call);
			extra.signal.addEventListener("abort", cancel, { once: true });
			if (extra.signal.aborted) cancel();
			else callbacks.onCall(call);
		});
	});

	return server;
}

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
	if (header === undefined) return false;
	const actual = Buffer.from(header);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createHttpServer(transport: StreamableHTTPServerTransport, authorization: string): http.Server {
	const expected = Buffer.from(authorization);

	return http.createServer((req, res) => {
		if (!isAuthorized(req.headers.authorization, expected)) {
			res.writeHead(401).end();
			return;
		}

		transport.handleRequest(req, res).catch((error: unknown) => {
			console.error("cursor tool bridge request failed", error);
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
}

function listen(server: http.Server): Promise<AddressInfo> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, LOOPBACK_HOST, () => resolve(server.address() as AddressInfo));
	});
}

function closeHttpServer(server: http.Server): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

function toMcpConfig(port: number, authorization: string): string {
	const server = { url: `http://${LOOPBACK_HOST}:${port}/mcp`, headers: { Authorization: authorization } };
	return JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: server } });
}

export async function createCursorToolBridge(tools: Tool[], callbacks: BridgeCallbacks): Promise<CursorToolBridge> {
	const authorization = `Bearer ${randomBytes(TOKEN_BYTES).toString("hex")}`;
	const held = new Set<HeldMcpCall>();

	const mcpServer = createMcpServer(tools, callbacks, held);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
	await mcpServer.connect(transport);

	const httpServer = createHttpServer(transport, authorization);
	let port: number;
	try {
		({ port } = await listen(httpServer));
	} catch (error) {
		await mcpServer.close();
		throw error;
	}

	return {
		mcpConfig: toMcpConfig(port, authorization),
		close: async () => {
			for (const call of [...held]) call.respond({ content: [{ type: "text", text: "MCP bridge closed" }], isError: true });
			await mcpServer.close();
			await closeHttpServer(httpServer);
		},
	};
}
