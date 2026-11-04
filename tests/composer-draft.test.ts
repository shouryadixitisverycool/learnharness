import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readComposerDraft, writeComposerDraft } from "../components/composer-draft.ts";

describe("composer draft storage", () => {
	it("keeps drafts isolated by chat and removes an explicitly cleared draft", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		};
		writeComposerDraft(storage, "chat_one", "unfinished thought");
		assert.equal(readComposerDraft(storage, "chat_one"), "unfinished thought");
		assert.equal(readComposerDraft(storage, "chat_two"), "");
		writeComposerDraft(storage, "chat_one", "");
		assert.equal(readComposerDraft(storage, "chat_one"), "");
	});

	it("treats unavailable storage as empty and never blocks editing", () => {
		const unavailable = {
			getItem: () => { throw new Error("storage disabled"); },
			setItem: () => { throw new Error("quota"); },
			removeItem: () => { throw new Error("storage disabled"); },
		};
		assert.equal(readComposerDraft(unavailable, "chat"), "");
		assert.doesNotThrow(() => writeComposerDraft(unavailable, "chat", "draft"));
	});
});
