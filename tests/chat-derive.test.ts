/**
 * ChatStore.derive: a remembered pure function of a chat record must equal
 * the same function over a fresh getChat after every kind of write,
 * including writes the store did not make (another process editing or
 * replacing the file). And the gate helpers built on it must give the
 * answers the full-record versions gave.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-derive-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { PATHS } = await import("../config.ts");
const { deriveChat } = await import("../src/core/chat-derive.ts");
const { coverageFingerprints, coverageOf, coverageTotals } = await import("../src/core/coverage.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

type Msg = Parameters<typeof chatStore.saveMessages>[1][number];
const user = (id: string, content: string): Msg => ({ id, role: "user", content, timestamp: 1 }) as Msg;

/** derive with a counting compute, so tests see when it actually ran. */
function counted() {
	let runs = 0;
	const compute = (record: { title: string; messages: readonly unknown[] }) => {
		runs++;
		return { title: record.title, count: record.messages.length };
	};
	return { compute, runs: () => runs };
}

describe("ChatStore.derive", () => {
	it("computes once per file version and matches a fresh read", () => {
		const chat = chatStore.createChat("derive me");
		const { compute, runs } = counted();
		const first = chatStore.derive!(chat.id, "t", compute);
		assert.deepEqual(first, { title: "derive me", count: 0 });
		assert.equal(chatStore.derive!(chat.id, "t", compute), first, "unchanged file: the remembered value");
		assert.equal(runs(), 1);
		// Another key on the same version reuses the one parse, and computes its own value.
		assert.equal(chatStore.derive!(chat.id, "other", (r) => r.id), chat.id);
	});

	it("store writes invalidate it", () => {
		const chat = chatStore.createChat("writes");
		const { compute, runs } = counted();
		chatStore.derive!(chat.id, "t", compute);
		chatStore.saveMessages(chat.id, [user("m1", "hello")]);
		assert.deepEqual(chatStore.derive!(chat.id, "t", compute), { title: "writes", count: 1 });
		chatStore.renameChat(chat.id, "renamed");
		assert.deepEqual(chatStore.derive!(chat.id, "t", compute), { title: "renamed", count: 1 });
		// Two writes back to back with records of identical length.
		chatStore.saveMessages(chat.id, [user("m2", "aaaaa")]);
		assert.deepEqual(chatStore.derive!(chat.id, "t", compute), { title: "renamed", count: 1 });
		chatStore.saveMessages(chat.id, [user("m3", "bbbbb")]);
		assert.equal(chatStore.derive!(chat.id, "first", (r) => (r.messages[0] as { id: string }).id), "m3");
		assert.equal(runs(), 4);
	});

	it("sees external edits, replacements and removals", () => {
		const chat = chatStore.createChat("external");
		const file = path.join(PATHS.chats, `${chat.id}.json`);
		const title = (id: string) => chatStore.derive!(id, "title", (r) => r.title);
		assert.equal(title(chat.id), "external");

		// In-place rewrite (same inode).
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...record, title: "edited elsewhere" }));
		assert.equal(title(chat.id), "edited elsewhere");

		// Replacement by rename (new inode), same byte length as the last edit.
		const tmp = `${file}.other`;
		fs.writeFileSync(tmp, JSON.stringify({ ...record, title: "edited ELSEWHERE" }));
		fs.renameSync(tmp, file);
		assert.equal(title(chat.id), "edited ELSEWHERE");

		fs.rmSync(file);
		assert.equal(title(chat.id), null);
	});

	it("answers null where getChat does, and never remembers a null", () => {
		assert.equal(chatStore.derive!("chat_missing", "t", () => 1), null);
		assert.equal(chatStore.derive!("../escape", "t", () => 1), null, "an invalid id reads as absent, like getChat");
		const chat = chatStore.createChat("future");
		const file = path.join(PATHS.chats, `${chat.id}.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		const errors = console.error;
		console.error = () => {};
		try {
			fs.writeFileSync(file, JSON.stringify({ ...record, version: 999 }));
			assert.equal(chatStore.getChat(chat.id), null);
			assert.equal(chatStore.derive!(chat.id, "t", (r) => r.title), null, "a record this build refuses stays refused");
		} finally {
			console.error = errors;
		}
		fs.writeFileSync(file, JSON.stringify(record));
		assert.equal(chatStore.derive!(chat.id, "t", (r) => r.title), "future");
	});

	it("deleteChat forgets the record", () => {
		const chat = chatStore.createChat("doomed");
		assert.equal(chatStore.derive!(chat.id, "t", (r) => r.title), "doomed");
		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(chatStore.derive!(chat.id, "t", (r) => r.title), null);
	});

	it("stays correct for many chats (parsed records are bounded, values are not)", () => {
		const chats = Array.from({ length: 10 }, (_, i) => chatStore.createChat(`many ${i}`));
		for (const chat of chats) chatStore.derive!(chat.id, "t", (r) => r.title);
		for (const [i, chat] of chats.entries()) {
			assert.equal(chatStore.derive!(chat.id, "t", () => "recomputed"), `many ${i}`);
			assert.equal(chatStore.derive!(chat.id, "count", (r) => r.messages.length), 0, "a new key after its parse was dropped re-reads");
		}
	});
});

describe("deriveChat", () => {
	it("falls back to getChat for stores without derive", () => {
		const record = { id: "c1", title: "fake" } as unknown as ReturnType<typeof chatStore.getChat>;
		const fake = { getChat: (id: string) => (id === "c1" ? record : null) };
		assert.equal(deriveChat(fake, "c1", "t", (r) => r.title), "fake");
		assert.equal(deriveChat(fake, "nope", "t", (r) => r.title), null);
	});
});

describe("coverageTotals", () => {
	it("gives coverageOf's totals from fingerprints alone", () => {
		const messages = [
			user("u1", "what is a derivative?"),
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "A derivative is a rate of change." }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 2 },
			user("u2", "and an integral?"),
			{ id: "a2", role: "assistant", content: [{ type: "text", text: "An integral accumulates area under a curve." }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 3 },
		] as unknown as Parameters<typeof coverageOf>[0];
		const fingerprints = coverageFingerprints(messages);
		const covered = [{ chatId: "c", fp: fingerprints[1]!.fp, tokens: fingerprints[1]!.tokens, foldedAt: "2026-01-01T00:00:00.000Z" }];
		for (const entries of [[], covered]) {
			const { slots, ...full } = coverageOf(messages, entries, "c");
			assert.deepEqual(coverageTotals(fingerprints, entries, "c"), full);
			assert.deepEqual(fingerprints, slots.map(({ fp, tokens }) => ({ fp, tokens })));
		}
		assert.ok(coverageOf(messages, covered, "c").coveredTokens > 0, "the fixture covers something");
	});
});
