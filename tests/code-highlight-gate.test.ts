import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateCodeHighlighter, holdCodeHighlight } from "../lib/code-highlight-gate.ts";

type Options = { code: string; language: string };

/** A fake plugin with the Streamdown code plugin's contract: a cached key
 *  answers synchronously; otherwise it returns null, tokenizes later and
 *  calls the callback. `flush` runs the pending tokenizations. */
function fakePlugin() {
	const cache = new Map<string, string>();
	const pending: Array<() => void> = [];
	const calls: string[] = [];
	const plugin = {
		name: "fake",
		highlight(options: Options, callback?: (r: string) => void): string | null {
			calls.push(options.code);
			const hit = cache.get(options.code);
			if (hit) return hit;
			pending.push(() => {
				const tokens = `tokens:${options.code}`;
				cache.set(options.code, tokens);
				callback?.(tokens);
			});
			return null;
		},
	};
	const flush = () => pending.splice(0).forEach((run) => run());
	return { plugin, calls, flush };
}

const tasks = (n = 1) => new Promise<void>((resolve) => {
	let left = n;
	const next = () => (--left <= 0 ? resolve() : setTimeout(next, 0));
	setTimeout(next, 0);
});

const keyOf = (o: Options) => `${o.language}\u0000${o.code}`;

describe("code highlight gate", () => {
	it("passes requests straight through without a hold", () => {
		const { plugin, calls, flush } = fakePlugin();
		const gated = gateCodeHighlighter(plugin, keyOf);
		const got: string[] = [];
		assert.equal(gated.highlight({ code: "a", language: "js" }, (r) => got.push(r)), null);
		assert.deepEqual(calls, ["a"]);
		flush();
		assert.deepEqual(got, ["tokens:a"]);
		assert.equal(gated.name, "fake");
	});

	it("holds uncached requests until the last hold is released", async () => {
		const { plugin, calls, flush } = fakePlugin();
		const gated = gateCodeHighlighter(plugin, keyOf);
		const got: string[] = [];
		const releaseA = holdCodeHighlight();
		const releaseB = holdCodeHighlight();
		assert.equal(gated.highlight({ code: "a", language: "js" }, (r) => got.push(r)), null);
		assert.deepEqual(calls, []);
		releaseA();
		releaseA(); // idempotent
		assert.deepEqual(calls, []);
		releaseB();
		assert.deepEqual(calls, []);
		await tasks();
		assert.deepEqual(calls, ["a"]);
		flush();
		assert.deepEqual(got, ["tokens:a"]);
	});

	it("runs held requests one per task and pauses under a new hold", async () => {
		const { plugin, calls } = fakePlugin();
		const gated = gateCodeHighlighter(plugin, keyOf);
		const release = holdCodeHighlight();
		for (const code of ["a", "b", "c"]) gated.highlight({ code, language: "js" }, () => {});
		release();
		await tasks();
		assert.deepEqual(calls, ["a"]);
		const again = holdCodeHighlight();
		await tasks(3);
		assert.deepEqual(calls, ["a"]);
		again();
		await tasks(4);
		assert.deepEqual(calls, ["a", "b", "c"]);
	});

	it("answers already-tokenized requests synchronously during a hold", () => {
		const { plugin, calls, flush } = fakePlugin();
		const gated = gateCodeHighlighter(plugin, keyOf);
		gated.highlight({ code: "a", language: "js" }, () => {});
		flush();
		const release = holdCodeHighlight();
		try {
			assert.equal(gated.highlight({ code: "a", language: "js" }, () => {}), "tokens:a");
			assert.deepEqual(calls, ["a", "a"]);
		} finally {
			release();
		}
	});

	it("delivers a result that became cached while the request was held", async () => {
		const { plugin, flush } = fakePlugin();
		const gated = gateCodeHighlighter(plugin, keyOf);
		const other = gateCodeHighlighter(plugin, keyOf);
		const release = holdCodeHighlight();
		const got: string[] = [];
		gated.highlight({ code: "a", language: "js" }, (r) => got.push(r));
		release();
		await tasks();
		flush();
		// A second wrapper over the same plugin starts with no known keys.
		const again = holdCodeHighlight();
		other.highlight({ code: "a", language: "js" }, (r) => got.push(r));
		again();
		await tasks();
		assert.deepEqual(got, ["tokens:a", "tokens:a"]);
	});
});
