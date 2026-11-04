/**
 * Cursor stream function (src/agent/cursor/stream.ts).
 *
 * The runCursor seam spawns tests/fixtures/cursor/fake-cursor-agent.mjs, which
 * replays synthetic stream-json lines and calls the real MCP bridge, so the
 * process plumbing (argv, workspace files, stdin, stdout lines, exit, kill) runs
 * end to end. Nothing here starts the real CLI.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, SimpleStreamOptions, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { CursorError } from "../src/agent/cursor/constants.ts";
import { heldCallTimeoutMs } from "../src/agent/cursor/live-processes.ts";
import { CURSOR_MODELS } from "../src/agent/cursor/provider.ts";
import { createCursorStreamFunction, DEFERRED_PLACEHOLDER, QUESTION_PLACEHOLDER, toCursorArgs, type RunCursor } from "../src/agent/cursor/stream.ts";

const FAKE_CURSOR = fileURLToPath(new URL("./fixtures/cursor/fake-cursor-agent.mjs", import.meta.url));
const SESSION_ID = "cursor-stream-test-chat";
const LOOKUP: Tool = { name: "lookup", description: "Look up a term", parameters: { type: "object", properties: { term: { type: "string" } } } };
const QUIZ: Tool = { name: "quiz", description: "Ask a question", parameters: { type: "object", properties: { question: { type: "string" } } } };
const TOOLS = [LOOKUP, QUIZ];
const HI: Message = { role: "user", content: "Teach me what a derivative is", timestamp: 0 };

type RunLog = { argv: string[]; cwd: string; home: string; envKeys: string[]; rules: string; mcpConfig: string; mcpConfigMode: number; prompt: string };

function line(value: object): string {
	return JSON.stringify(value);
}

function call(id: string, name: string, args: object, extra: object = {}): string {
	return line({ fake: "call", id, name, arguments: args, ...extra });
}

const RESULT = line({ fake: "result", usage: { inputTokens: 7000, outputTokens: 120, cacheReadTokens: 41000, cacheWriteTokens: 0 } });
const HOLD = line({ fake: "hold" });

function setup(t: TestContext, scenarios: string[][]) {
	const dir = mkdtempSync(join(tmpdir(), "cursor-stream-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const home = join(dir, "cursor-home");
	const authDir = join(dir, "auth");
	mkdirSync(authDir);
	const log = join(dir, "runs.jsonl");
	const children: ChildProcessWithoutNullStreams[] = [];
	let run = 0;
	const runCursor: RunCursor = (args, options) => {
		const scenario = scenarios[Math.min(run, scenarios.length - 1)]!;
		const file = join(dir, `scenario-${run++}.jsonl`);
		writeFileSync(file, `${scenario.join("\n")}\n`);
		const child = spawn(process.execPath, [FAKE_CURSOR, ...args], {
			cwd: options.cwd,
			env: { ...options.env, PATH: process.env.PATH, FAKE_CURSOR_SCENARIO: file, FAKE_CURSOR_LOG: log },
			stdio: "pipe",
		}) as ChildProcessWithoutNullStreams;
		children.push(child);
		t.after(() => child.kill("SIGKILL"));
		return child;
	};
	const stream = createCursorStreamFunction(runCursor, () => ({ home, authDir }));
	const entries = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((entry) => JSON.parse(entry) as Record<string, unknown>) : [];
	const runs = () => entries().filter((entry) => "argv" in entry) as unknown as RunLog[];
	const callResults = () => entries().flatMap((entry) => typeof entry.callResult === "string" ? [entry.callResult] : []);
	return { stream, runs, callResults, children, home };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function last(events: AssistantMessageEvent[]): AssistantMessageEvent {
	const event = events.at(-1);
	assert.ok(event);
	return event;
}

async function turn(stream: ReturnType<typeof setup>["stream"], messages: Message[], options: SimpleStreamOptions = {}): Promise<AssistantMessage> {
	const model = CURSOR_MODELS[0]!;
	const context = normalizeContext({ systemPrompt: "You are the tutor. Be kind.", messages, tools: TOOLS });
	const events = await collect(stream(model, context, { sessionId: SESSION_ID, reasoning: "medium", ...options }));
	const end = last(events);
	if (end.type === "done") return end.message;
	assert.ok(end.type === "error");
	return end.error;
}

function text(message: AssistantMessage): string {
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}

function toolCalls(message: AssistantMessage) {
	return message.content.flatMap((block) => block.type === "toolCall" ? [block] : []);
}

function result(id: string, name: string, value: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: value }], isError: false, timestamp: 0 };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("timed out waiting");
		await sleep(10);
	}
}

const exited = (child: ChildProcessWithoutNullStreams) => child.exitCode !== null || child.signalCode !== null;

test("toCursorArgs: print mode, stream-json with partials, no sandbox, the chosen model and workspace", () => {
	assert.deepEqual(toCursorArgs({ model: "grok-4.7-medium-fast", workspace: "/tmp/ws" }), [
		"-p", "--trust", "--approve-mcps", "--sandbox", "disabled", "--output-format", "stream-json",
		"--stream-partial-output", "--model", "grok-4.7-medium-fast", "--workspace", "/tmp/ws",
	]);
});

test("a plain reply streams thinking and text, reports usage, and stops", async (t) => {
	const { stream, runs, home } = setup(t, [[line({ fake: "thinking", text: "Plan the intro." }), line({ fake: "text", text: "A derivative is a rate of change." }), RESULT]]);
	const message = await turn(stream, [HI]);
	assert.equal(message.stopReason, "stop");
	assert.equal(text(message), "A derivative is a rate of change.");
	assert.deepEqual(message.content.map((block) => block.type), ["thinking", "text"]);
	assert.deepEqual({ ...message.usage, cost: undefined }, { input: 7000, output: 120, cacheRead: 41000, cacheWrite: 0, totalTokens: 48120, cost: undefined });
	const [run] = runs();
	assert.ok(run);
	assert.equal(run.prompt, "Teach me what a derivative is");
	assert.equal(run.argv[run.argv.indexOf("--model") + 1], "grok-4.7-medium-fast");
	assert.equal(run.home, home);
	assert.match(run.rules, /^---\ndescription: LearnHarness tutor instructions\nalwaysApply: true\n---\nYou are the LearnHarness tutor, not a coding agent\./);
	assert.match(run.rules, /You are the tutor\. Be kind\.\n$/);
	assert.equal(run.mcpConfigMode, 0o600);
	assert.match(JSON.parse(run.mcpConfig).mcpServers.learnharness.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
	// The run's workspace is gone once the process exits.
	await waitFor(() => !existsSync(run.cwd));
});

test("a held tool call reaches pi, and its result continues the same process", async (t) => {
	const { stream, runs } = setup(t, [[
		line({ fake: "text", text: "Let me check." }),
		call("call-1\nfc_1", "lookup", { term: "derivative" }),
		line({ fake: "reply" }),
		RESULT,
	]]);
	const first = await turn(stream, [HI]);
	assert.equal(first.stopReason, "toolUse");
	assert.equal(text(first), "Let me check.");
	assert.deepEqual(toolCalls(first).map(({ id, name, arguments: args }) => ({ id, name, args })), [{ id: "call-1:fc_1", name: "lookup", args: { term: "derivative" } }]);

	const second = await turn(stream, [HI, first, result("call-1:fc_1", "lookup", "rate of change")]);
	assert.equal(second.stopReason, "stop");
	assert.equal(text(second), "rate of change");
	assert.equal(second.usage.input, 7000);
	assert.equal(runs().length, 1, "the continuation reuses the running CLI");
});

test("an MCP request that arrives before its stdout event still pairs", async (t) => {
	const { stream, runs } = setup(t, [[call("call-2\nfc_2", "lookup", { term: "slope" }, { mcpFirst: true }), line({ fake: "reply" }), RESULT]]);
	const first = await turn(stream, [HI]);
	assert.equal(first.stopReason, "toolUse");
	const second = await turn(stream, [HI, first, result("call-2:fc_2", "lookup", "rise over run")]);
	assert.equal(text(second), "rise over run");
	assert.equal(runs().length, 1);
});

test("a question splits the run: placeholder to the CLI, kill, then a replay with the learner's answer", async (t) => {
	const { stream, runs, children } = setup(t, [
		[line({ fake: "text", text: "Quick check." }), call("call-3\nfc_3", "quiz", { question: "What is f'(x) for x^2?" }), line({ fake: "reply" }), HOLD],
		[line({ fake: "text", text: "Right, it is 2x." }), RESULT],
	]);
	const first = await turn(stream, [HI]);
	assert.equal(first.stopReason, "toolUse");
	assert.deepEqual(toolCalls(first).map((block) => block.name), ["quiz"]);
	await waitFor(() => exited(children[0]!));

	const answer = result("call-3:fc_3", "quiz", "The learner answered: 2x");
	const second = await turn(stream, [HI, first, answer]);
	assert.equal(second.stopReason, "stop");
	assert.equal(text(second), "Right, it is 2x.");

	const [, replay] = runs();
	assert.ok(replay, "the answer starts a second run");
	assert.match(replay.prompt, /^\[LearnHarness replay\]\n/);
	assert.ok(replay.prompt.includes("[learner]\nTeach me what a derivative is"));
	assert.ok(replay.prompt.includes("[tutor]\nQuick check."));
	assert.ok(replay.prompt.includes(`[tutor called tool quiz, call id call-3:fc_3]\n${JSON.stringify({ question: "What is f'(x) for x^2?" })}`));
	assert.ok(replay.prompt.includes("[result of quiz, call id call-3:fc_3]\nThe learner answered: 2x"));
	assert.match(replay.prompt, /Continue the lesson as the tutor from there\.\n$/);
	assert.ok(!replay.prompt.includes("You are the tutor. Be kind."), "the system prompt stays in the rules file");
	assert.ok(!replay.prompt.includes(QUESTION_PLACEHOLDER), "the placeholder never reaches the replay");
});

test("a question kills the CLI right away instead of letting it finish its turn", async (t) => {
	const { stream, callResults, children } = setup(t, [[call("call-4\nfc_4", "quiz", { question: "?" }), line({ fake: "text", text: "Never shown." }), RESULT]]);
	const message = await turn(stream, [HI]);
	assert.equal(message.stopReason, "toolUse");
	assert.ok(!text(message).includes("Never shown."));
	await waitFor(() => exited(children[0]!));
	assert.equal(children[0]!.signalCode, "SIGTERM");
	// The placeholder is sent before the kill; whether the CLI reads it first does not matter.
	assert.ok(callResults().every((value) => value === QUESTION_PLACEHOLDER));
});

test("a held call that pi never answers expires: placeholder, kill, and replay next time", async (t) => {
	const previous = heldCallTimeoutMs.current;
	heldCallTimeoutMs.current = 150;
	t.after(() => { heldCallTimeoutMs.current = previous; });
	const { stream, runs, callResults, children } = setup(t, [
		[call("call-5\nfc_5", "lookup", { term: "limit" }), HOLD],
		[line({ fake: "text", text: "A limit is where a function heads." }), RESULT],
	]);
	const first = await turn(stream, [HI]);
	await waitFor(() => exited(children[0]!));
	assert.equal(children[0]!.signalCode, "SIGTERM");
	assert.ok(callResults().every((value) => value === DEFERRED_PLACEHOLDER));

	const second = await turn(stream, [HI, first, result("call-5:fc_5", "lookup", "the value approached")]);
	assert.equal(text(second), "A limit is where a function heads.");
	assert.equal(runs().length, 2);
	assert.ok(runs()[1]!.prompt.includes("[result of lookup, call id call-5:fc_5]\nthe value approached"));
});

test("edited history replays instead of continuing the held process", async (t) => {
	const { stream, runs, children } = setup(t, [
		[call("call-6\nfc_6", "lookup", { term: "x" }), line({ fake: "reply" }), RESULT],
		[line({ fake: "text", text: "Fresh run." }), RESULT],
	]);
	const first = await turn(stream, [HI]);
	const edited: Message = { role: "user", content: "Teach me integrals instead", timestamp: 0 };
	const second = await turn(stream, [edited, first, result("call-6:fc_6", "lookup", "y")]);
	assert.equal(text(second), "Fresh run.");
	assert.equal(runs().length, 2);
	await waitFor(() => exited(children[0]!));
});

test("without a chat session every tool call splits", async (t) => {
	const { stream, children } = setup(t, [[call("call-7\nfc_7", "lookup", { term: "x" }), line({ fake: "reply" }), HOLD]]);
	const message = await turn(stream, [HI], { sessionId: undefined });
	assert.equal(message.stopReason, "toolUse");
	await waitFor(() => exited(children[0]!));
});

test("refused native tools are ignored and the turn carries on", async (t) => {
	const { stream } = setup(t, [[line({ fake: "native", name: "shellToolCall" }), line({ fake: "native", name: "readToolCall" }), line({ fake: "text", text: "I only use LearnHarness tools." }), RESULT]]);
	const message = await turn(stream, [HI]);
	assert.equal(message.stopReason, "stop");
	assert.equal(text(message), "I only use LearnHarness tools.");
});

test("a signed-out CLI fails the turn with a sign-in hint", async (t) => {
	const { stream } = setup(t, [[line({ fake: "exit", code: 1, stderr: "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n" })]]);
	const message = await turn(stream, [HI]);
	assert.equal(message.stopReason, "error");
	assert.equal(message.errorMessage, CursorError.NotSignedIn);
});

test("other CLI failures surface the first stderr line", async (t) => {
	const { stream } = setup(t, [[line({ fake: "exit", code: 1, stderr: "Cannot use this model: grok-9. Available models: auto\n" })]]);
	const message = await turn(stream, [HI]);
	assert.equal(message.errorMessage, "cursor-agent: Cannot use this model: grok-9. Available models: auto");
});

test("a missing CLI fails the turn", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-stream-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const stream = createCursorStreamFunction(() => null, () => ({ home: join(dir, "home"), authDir: join(dir, "auth") }));
	const message = await turn(stream, [HI]);
	assert.equal(message.errorMessage, CursorError.CliNotFound);
});

test("aborting kills the run", async (t) => {
	const { stream, children } = setup(t, [[line({ fake: "text", text: "Starting" }), HOLD]]);
	const controller = new AbortController();
	const pending = turn(stream, [HI], { signal: controller.signal });
	await waitFor(() => children.length === 1);
	await sleep(200);
	controller.abort();
	const message = await pending;
	assert.equal(message.stopReason, "aborted");
	await waitFor(() => exited(children[0]!));
});
