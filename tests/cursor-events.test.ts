/**
 * cursor-agent stream-json parsing (src/agent/cursor/events.ts) against real
 * runs captured on 2026-11-04 with cursor-agent 2026.08.25-3e8eec8 and
 * grok-4.7-low-fast (paths and account details scrubbed).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseCursorLine, toPiToolCallId, type CursorEvent } from "../src/agent/cursor/events.ts";

function fixture(name: string): CursorEvent[] {
	const file = fileURLToPath(new URL(`./fixtures/cursor/${name}`, import.meta.url));
	return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
		const event = parseCursorLine(line);
		return event ? [event] : [];
	});
}

test("a real tool-calling run: init, thinking, text, MCP discovery, two harness calls, result", () => {
	const events = fixture("tool-calls.jsonl");
	assert.deepEqual(events[0], { type: "init", sessionId: "fc5a16e5-93bd-440f-a96e-93b29da6badc", model: "Grok 4.7 256K Low Fast" });

	const tools = events.filter((event) => event.type === "toolStarted" || event.type === "toolCompleted");
	assert.deepEqual(tools.map((event) => [event.type, event.call.kind, event.call.kind === "mcp" ? event.call.name : null]), [
		["toolStarted", "discovery", null],
		["toolCompleted", "discovery", null],
		["toolStarted", "mcp", "lookup"],
		["toolCompleted", "mcp", "lookup"],
		["toolStarted", "mcp", "quiz"],
		["toolCompleted", "mcp", "quiz"],
	]);
	const lookup = tools[2]!;
	assert.ok(lookup.type === "toolStarted" && lookup.call.kind === "mcp");
	assert.equal(lookup.call.server, "learnharness");
	assert.deepEqual(lookup.call.arguments, { term: "derivative" });
	assert.equal(toPiToolCallId(lookup.callId), "call-8dba9109-fbef-41a3-8a70-9e7b13a9e822-1:fc_f97f8b21-bfb2-9ec5-a120-b029774ac069_0");
	assert.ok(tools.every((event) => event.type !== "toolCompleted" || event.outcome === "success"));

	// The streamed deltas of each segment add up to that segment's closing copy.
	let streamed = "";
	const segments: [string, string][] = [];
	for (const event of events) {
		if (event.type === "textDelta") streamed += event.text;
		if (event.type === "textFlush") { segments.push([streamed, event.text]); streamed = ""; }
	}
	assert.equal(segments.length, 2);
	for (const [deltas, flush] of segments) assert.equal(deltas, flush);
	assert.ok(events.some((event) => event.type === "thinkingDelta"));

	const result = events.at(-1);
	assert.deepEqual(result, {
		type: "result",
		isError: false,
		text: result?.type === "result" ? result.text : "",
		durationMs: 12322,
		usage: { input: 6476, output: 500, cacheRead: 41856, cacheWrite: 0 },
	});
});

test("a real locked-down run: shell, read and edit attempts all come back refused", () => {
	const completed = fixture("permission-denied.jsonl").filter((event) => event.type === "toolCompleted");
	assert.deepEqual(completed.map((event) => [event.call.kind === "native" ? event.call.name : event.call.kind, event.outcome]), [
		["shellToolCall", "permissionDenied"],
		["readToolCall", "error"],
		["editToolCall", "permissionDenied"],
	]);
});

test("rejected MCP calls and malformed lines", () => {
	const rejected = parseCursorLine(JSON.stringify({
		type: "tool_call", subtype: "completed", call_id: "c1",
		tool_call: { mcpToolCall: { args: { name: "learnharness-quiz", args: {}, providerIdentifier: "learnharness", toolName: "quiz" }, result: { rejected: { reason: "not allowed" } } } },
	}));
	assert.ok(rejected?.type === "toolCompleted");
	assert.equal(rejected.outcome, "rejected");
	assert.equal(parseCursorLine("not json"), null);
	assert.equal(parseCursorLine(JSON.stringify({ type: "tool_call", subtype: "started", call_id: "c2", tool_call: {} })), null);
	assert.deepEqual(parseCursorLine(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "boom" })), { type: "result", isError: true, text: "boom", durationMs: null, usage: null });
});
