/** The Cursor provider's models and effort mapping (src/agent/cursor/provider.ts). */
import assert from "node:assert/strict";
import test from "node:test";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { CURSOR_MODELS, toCursorModelId } from "../src/agent/cursor/provider.ts";
import { isCliModel, isCliProvider } from "../src/core/contracts/cursor.ts";

test("two Grok 4.7 models, text only, 256K context, unpriced", () => {
	assert.deepEqual(CURSOR_MODELS.map((model) => [model.id, model.name]), [["grok-4.7-fast", "Grok 4.7 Fast"], ["grok-4.7", "Grok 4.7"]]);
	for (const model of CURSOR_MODELS) {
		assert.equal(model.provider, "cursor");
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.contextWindow, 256_000);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh"]);
	}
});

test("thinking level picks the CLI model: off, minimal and low share the low floor; max is xhigh", () => {
	const fast = (level?: Parameters<typeof toCursorModelId>[1]) => toCursorModelId("grok-4.7-fast", level);
	assert.equal(fast(undefined), "grok-4.7-low-fast");
	assert.equal(fast("minimal"), "grok-4.7-low-fast");
	assert.equal(fast("low"), "grok-4.7-low-fast");
	assert.equal(fast("medium"), "grok-4.7-medium-fast");
	assert.equal(fast("high"), "grok-4.7-high-fast");
	assert.equal(fast("xhigh"), "grok-4.7-xhigh-fast");
	assert.equal(fast("max"), "grok-4.7-xhigh-fast");
	assert.equal(toCursorModelId("grok-4.7", "medium"), "grok-4.7-medium");
	assert.equal(toCursorModelId("grok-4.7", undefined), "grok-4.7-low");
});

test("Cursor and Claude Code count as CLI-billed providers", () => {
	assert.ok(isCliProvider("cursor") && isCliProvider("claude-code") && !isCliProvider("openrouter"));
	assert.ok(isCliModel("cursor:grok-4.7-fast") && !isCliModel("openai:gpt-5") && !isCliModel(undefined));
});
