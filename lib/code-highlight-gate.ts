/**
 * Holds shiki tokenization until a chat's first paint (owner, perf round 2b,
 * 2026-11-07). Opening a chat used to tokenize every code block of the first
 * rows inside the commit task, ~100 ms before anything painted. While a hold
 * is active, a highlight request that is not already cached returns null
 * (the block shows its plain code) and runs after the last hold is released,
 * one request per task; the block's own callback then swaps in the colored
 * tokens. Requests the
 * plugin already answered once pass straight through, so a block it has
 * tokenized before is colored in the first paint as it was.
 */

type HighlightCallback<R> = (result: R) => void;

export type CodeHighlighter<O, R> = {
	highlight: (options: O, callback?: HighlightCallback<R>) => R | null;
};

let holds = 0;
let queue: Array<() => void> = [];
let draining = false;

/** Runs the held requests one per task, so a frame can render between two
 *  code blocks' tokenization instead of waiting for all of them. Stops while
 *  a new hold is active; that hold's release resumes it. */
function drain(): void {
	if (draining) return;
	draining = true;
	const step = () => {
		const run = holds === 0 ? queue.shift() : undefined;
		if (!run) {
			draining = false;
			return;
		}
		run();
		setTimeout(step, 0);
	};
	setTimeout(step, 0);
}

/** Starts a hold; the returned function ends it (idempotent). */
export function holdCodeHighlight(): () => void {
	holds++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds--;
		if (holds === 0 && queue.length > 0) drain();
	};
}

/** Wraps a Streamdown code plugin so its highlight calls respect the hold.
 *  `keyOf` names a request: once a key has produced tokens, later requests
 *  for it are known to be cached and are never held. */
export function gateCodeHighlighter<P extends CodeHighlighter<O, R>, O, R>(plugin: P, keyOf: (options: O) => string): P {
	const done = new Set<string>();
	const run = (options: O, callback?: HighlightCallback<R>): R | null => {
		const key = keyOf(options);
		const result = plugin.highlight(options, (tokens) => {
			done.add(key);
			callback?.(tokens);
		});
		if (result) done.add(key);
		return result;
	};
	return {
		...plugin,
		highlight(options: O, callback?: HighlightCallback<R>): R | null {
			if (holds === 0 || done.has(keyOf(options))) return run(options, callback);
			queue.push(() => {
				const result = run(options, callback);
				if (result) callback?.(result);
			});
			return null;
		},
	};
}
