/** The Cursor replay prompt (src/agent/cursor/transcript.ts). */
import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { toCursorInput } from "../src/agent/cursor/transcript.ts";

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant", content, api: "cursor-cli", provider: "cursor", model: "grok-4.7-fast",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse", timestamp: 0,
});

test("a first message goes to stdin as is; the system prompt and tools stay out of it", () => {
	const context = normalizeContext({ systemPrompt: "Doctrine.", messages: [{ role: "user", content: "Teach me derivatives", timestamp: 0 }], tools: [{ name: "quiz", description: "q", parameters: { type: "object" } }] });
	const input = toCursorInput(context.messages);
	assert.equal(input.prompt, "Teach me derivatives");
	assert.equal(input.replay, false);
	assert.equal(input.systemPrompt, "Doctrine.");
	assert.deepEqual(input.tools.map((tool) => tool.name), ["quiz"]);
});

test("a replay lists turns, tool calls with ids and arguments, and results, then says how to continue", () => {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "Teach me derivatives" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 },
		assistant([
			{ type: "thinking", thinking: "private plan" },
			{ type: "text", text: "Here is the idea." },
			{ type: "toolCall", id: "c1:fc1", name: "quiz", arguments: { question: "d/dx x^2?" } },
		]),
		{ role: "toolResult", toolCallId: "c1:fc1", toolName: "quiz", content: [{ type: "text", text: "Learner chose 2x (correct)" }], isError: false, timestamp: 0 },
	];
	const input = toCursorInput(normalizeContext({ systemPrompt: "Doctrine.", messages }).messages);
	assert.equal(input.replay, true);
	assert.equal(input.prompt, [
		"[LearnHarness replay]",
		"This lesson is already in progress. A new session is picking it up, so the conversation so far is below, oldest first. You are the tutor in it.",
		"Every tool call below already ran and its result is final: never call a tool again for a call that has a result. When you asked the learner a question with a tool, their answer is that call's result.",
		"",
		"[learner]\nTeach me derivatives\n[image attached (image/png); this model cannot see images]",
		"",
		"[tutor]\nHere is the idea.",
		"",
		"[tutor called tool quiz, call id c1:fc1]\n{\"question\":\"d/dx x^2?\"}",
		"",
		"[result of quiz, call id c1:fc1]\nLearner chose 2x (correct)",
		"",
		"[end of replay]\nThe latest entries above are the results of your tool calls. Continue the lesson as the tutor from there.",
		"",
	].join("\n"));
	assert.ok(!input.prompt.includes("private plan"));
	assert.ok(!input.prompt.includes("Doctrine."));
});

test("a replay that ends on a learner message asks for a reply to it", () => {
	const messages: Message[] = [
		{ role: "user", content: "hi", timestamp: 0 },
		assistant([{ type: "text", text: "Hello." }]),
		{ role: "user", content: "What is a limit?", timestamp: 0 },
	];
	const input = toCursorInput(messages);
	assert.match(input.prompt, /\[learner\]\nWhat is a limit\?\n\n\[end of replay\]\nReply as the tutor to the learner's latest message above\.\n$/);
});
