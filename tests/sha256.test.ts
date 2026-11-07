import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Sha256, sha256Hex } from "../src/core/sha256.ts";

/**
 * The pure-TS sha256 must be byte-identical to node:crypto: coverage
 * fingerprints are persisted in the extraction ledger, so a drift would
 * silently re-open every covered message.
 */

function nodeHex(parts: readonly string[]): string {
	const h = createHash("sha256");
	for (const p of parts) h.update(p);
	return h.digest("hex");
}

const CASES: string[] = [
	"",
	"abc",
	"a".repeat(55), // padding fits in one block
	"a".repeat(56), // padding spills into a second block
	"a".repeat(63),
	"a".repeat(64), // exact block
	"a".repeat(65),
	"a".repeat(119),
	"a".repeat(128),
	"héllo wörld",
	"emoji 🎓📚 and more 🧠",
	"combining: é vs é",
	"null and \x00 control\x1f chars",
	"line\nbreaks\tand\ttabs",
	JSON.stringify(["assistant", ["TEACHER [m1] some prose", "TEACHER [m1] more"]]),
	"x".repeat(1_000_000),
];

describe("sha256 (pure TS)", () => {
	it("matches node:crypto for single-chunk inputs", () => {
		for (const input of CASES) {
			assert.equal(sha256Hex(input), nodeHex([input]), `mismatch for length ${input.length}`);
		}
	});

	it("matches node:crypto for multi-chunk updates", () => {
		const chunks = ["first chunk ", "second with unicode 🎓 ", "".padEnd(200, "z"), "tail"];
		assert.equal(sha256Hex(chunks), nodeHex(chunks));
		const h = new Sha256();
		for (const c of chunks) h.update(c);
		assert.equal(h.digest("hex"), nodeHex(chunks));
	});

	it("chunk boundaries do not matter", () => {
		const full = CASES[15]!;
		assert.ok(full.length === 1_000_000);
		for (const cut of [1, 55, 56, 64, 1000, 999_999]) {
			const h = new Sha256();
			h.update(full.slice(0, cut));
			h.update(full.slice(cut));
			assert.equal(h.digest("hex"), nodeHex([full]), `cut at ${cut}`);
		}
	});

	it("digest does not disturb a fresh instance and is repeatable", () => {
		assert.equal(sha256Hex("repeat"), sha256Hex("repeat"));
		assert.notEqual(sha256Hex("a"), sha256Hex("b"));
	});
});
