import type { JsonObject, Usage } from "@earendil-works/pi-ai";

export type CursorUsage = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;

/** What a finished native or MCP call came back with. */
export type CursorToolOutcome = "success" | "error" | "rejected" | "permissionDenied" | "unknown";

export type CursorToolCall =
	/** A call to an MCP tool. `server` is the MCP server name; `name` is the bare tool name. */
	| { kind: "mcp"; server: string; name: string; arguments: JsonObject }
	/** The CLI listing an MCP server's tools before its first call. */
	| { kind: "discovery" }
	/** Shell, read, edit and the CLI's other built-in tools, e.g. `shellToolCall`. */
	| { kind: "native"; name: string };

export type CursorEvent =
	| { type: "init"; sessionId: string; model: string }
	| { type: "thinkingDelta"; text: string }
	| { type: "thinkingDone" }
	/** A streamed piece of assistant text (--stream-partial-output). */
	| { type: "textDelta"; text: string }
	/** The whole text of the assistant segment just streamed, sent when it closes. */
	| { type: "textFlush"; text: string }
	| { type: "toolStarted"; callId: string; call: CursorToolCall }
	| { type: "toolCompleted"; callId: string; call: CursorToolCall; outcome: CursorToolOutcome }
	| { type: "result"; isError: boolean; text: string; durationMs: number | null; usage: CursorUsage | null };

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Raw : null;
}

function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function messageText(line: Raw): string | null {
	const content = record(line.message)?.content;
	if (!Array.isArray(content)) return null;
	return content.flatMap((block) => {
		const value = record(block);
		return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("");
}

/** Cursor prefixes MCP tool names with their server, e.g. `learnharness-quiz`. */
function toToolCall(raw: Raw): { call: CursorToolCall; result: Raw | null } | null {
	const keys = Object.keys(raw).filter((key) => key.endsWith("ToolCall"));
	if (keys.length !== 1) return null;
	const key = keys[0]!;
	const body = record(raw[key]);
	if (!body) return null;
	const result = record(body.result);
	if (key === "getMcpToolsToolCall") return { call: { kind: "discovery" }, result };
	if (key !== "mcpToolCall") return { call: { kind: "native", name: key }, result };

	const args = record(body.args);
	const server = text(args?.providerIdentifier) ?? text(args?.serverIdentifier);
	const qualified = text(args?.name);
	const name = text(args?.toolName) ?? (server && qualified?.startsWith(`${server}-`) ? qualified.slice(server.length + 1) : null);
	const callArgs = record(args?.args);
	if (!server || !name) return null;
	return { call: { kind: "mcp", server, name, arguments: (callArgs ?? {}) as JsonObject }, result };
}

function toOutcome(result: Raw | null): CursorToolOutcome {
	if (!result) return "unknown";
	for (const outcome of ["success", "error", "rejected", "permissionDenied"] as const) {
		if (outcome in result) return outcome;
	}
	// Edit calls report e.g. readPermissionDenied / writePermissionDenied.
	return Object.keys(result).some((key) => key.endsWith("PermissionDenied")) ? "permissionDenied" : "unknown";
}

function toUsage(raw: Raw | null): CursorUsage | null {
	if (!raw) return null;
	return {
		input: count(raw.inputTokens),
		output: count(raw.outputTokens),
		cacheRead: count(raw.cacheReadTokens),
		cacheWrite: count(raw.cacheWriteTokens),
	};
}

/** Tool call ids carry a newline between the run's call id and the model's
 * function-call id. Pi ids end up in DOM keys and URLs, so keep them on one line. */
export function toPiToolCallId(callId: string): string {
	return callId.replace(/\s+/g, ":");
}

export function parseCursorLine(line: string): CursorEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	const raw = record(parsed);
	if (!raw) return null;

	switch (raw.type) {
		case "system": {
			const sessionId = text(raw.session_id);
			return raw.subtype === "init" && sessionId ? { type: "init", sessionId, model: text(raw.model) ?? "" } : null;
		}

		case "thinking":
			if (raw.subtype === "delta") {
				const delta = text(raw.text);
				return delta ? { type: "thinkingDelta", text: delta } : null;
			}
			return raw.subtype === "completed" ? { type: "thinkingDone" } : null;

		case "assistant": {
			const content = messageText(raw);
			if (content === null) return null;
			// Partial deltas carry a timestamp and no model call; the closing copy of a
			// segment carries a model_call_id, or (the run's last segment) no timestamp.
			const partial = typeof raw.timestamp_ms === "number" && raw.model_call_id === undefined;
			return partial ? (content ? { type: "textDelta", text: content } : null) : { type: "textFlush", text: content };
		}

		case "tool_call": {
			const callId = text(raw.call_id);
			const body = record(raw.tool_call);
			const parsedCall = body && toToolCall(body);
			if (!callId || !parsedCall) return null;
			if (raw.subtype === "started") return { type: "toolStarted", callId, call: parsedCall.call };
			if (raw.subtype === "completed") return { type: "toolCompleted", callId, call: parsedCall.call, outcome: toOutcome(parsedCall.result) };
			return null;
		}

		case "result":
			return {
				type: "result",
				isError: raw.is_error === true || raw.subtype !== "success",
				text: text(raw.result) ?? "",
				durationMs: typeof raw.duration_ms === "number" ? raw.duration_ms : null,
				usage: toUsage(record(raw.usage)),
			};

		default:
			return null;
	}
}
