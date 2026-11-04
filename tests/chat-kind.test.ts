/**
 * SESSION-KIND PINS (practice sessions, owner 2026-10-04): ChatRecord.kind
 * is ABSENT-BY-DEFAULT — absence reads as teach, so pre-practice records
 * never migrate; "practice" marks an adaptive-practice session (the
 * practice agent + its two tools from turn 1, no extraction, no graph
 * writes). The store normalizes at the summary projection; createChat
 * stamps the marker only for practice. Runs under an isolated LH_DATA_DIR
 * (the chat-birth-stamp discipline: the seam is set before any
 * config-loading import, so every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("session kind (practice sessions, 2026-10-04)", () => {
	it("createChat default carries NO kind field — absence reads as teach", () => {
		const chat = chatStore.createChat("plain session");
		assert.equal("kind" in chat, false, "teach records carry no kind marker");
	});

	it("createChat(kind: 'practice') stamps the marker on record + list", () => {
		const chat = chatStore.createChat("practice session", "practice");
		assert.equal(chat.kind, "practice");
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(listed?.kind, "practice");
	});

	it("the summary projection NORMALIZES: absent record field reads as teach", () => {
		const chat = chatStore.createChat("another plain one");
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(listed?.kind, "teach");
	});

	it("the summary projection marks a practice session with a posed problem as pendingProblem", async () => {
		const { PRACTICE_PROBLEM_TOOL } = await import("../src/core/native-messages.ts");
		const waiting = chatStore.createChat("problem waiting", "practice");
		chatStore.saveMessages(waiting.id, [
			{
				id: "msg_a_call_p1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call_p1", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "Show that…", mode: "recall", modelSolution: "Show that…" } }],
				api: "faux",
				provider: "test",
				model: "test-model",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				id: "msg_r_call_p1",
				role: "toolResult",
				toolCallId: "call_p1",
				toolName: PRACTICE_PROBLEM_TOOL,
				content: [{ type: "text", text: "Problem posed — the turn ends here." }],
				details: null,
				isError: false,
				timestamp: 2,
			},
		]);
		const idle = chatStore.createChat("no problem yet", "practice");
		const listed = chatStore.listChats();
		assert.equal(listed.find((c) => c.id === waiting.id)?.pendingProblem, true);
		assert.equal(listed.find((c) => c.id === idle.id)?.pendingProblem, false);
	});
});
