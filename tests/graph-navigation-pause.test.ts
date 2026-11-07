/**
 * The home graph's draw loop stops when a navigation away starts
 * (components/frame-scheduler.ts + lib/route-transition.ts, wired in
 * components/graph-view.tsx). The renderer schedules every frame through
 * FrameScheduler; suspendWhileLeaving drives it from Next's
 * onRouterTransitionStart signal.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FrameScheduler } from "../components/frame-scheduler.ts";
import { leavesPathname, suspendWhileLeaving } from "../lib/route-transition.ts";

function fakeFrames() {
	let next = 1;
	const queue = new Map<number, () => void>();
	return {
		api: {
			request: (cb: () => void) => {
				const id = next++;
				queue.set(id, cb);
				return id;
			},
			cancel: (id: number) => void queue.delete(id),
		},
		get size() {
			return queue.size;
		},
		flush() {
			const cbs = [...queue.values()];
			queue.clear();
			for (const cb of cbs) cb();
		},
	};
}

/** An animating loop: every frame asks for the next one, like tick(). */
function animatingLoop() {
	const frames = fakeFrames();
	let ran = 0;
	const scheduler: FrameScheduler = new FrameScheduler(() => {
		ran++;
		scheduler.request();
	}, frames.api);
	return { frames, scheduler, ran: () => ran };
}

function fakeTransitions() {
	let listener: ((url: string) => void) | null = null;
	return {
		subscribe: (l: (url: string) => void) => {
			listener = l;
			return () => {
				listener = null;
			};
		},
		start: (url: string) => listener?.(url),
		get subscribed() {
			return listener !== null;
		},
	};
}

describe("FrameScheduler", () => {
	it("dedupes requests into one pending frame", () => {
		const { frames, scheduler } = animatingLoop();
		scheduler.request();
		scheduler.request();
		assert.equal(frames.size, 1);
	});

	it("suspend cancels the pending frame and holds later requests", () => {
		const { frames, scheduler, ran } = animatingLoop();
		scheduler.request();
		frames.flush();
		assert.equal(ran(), 1);
		assert.equal(frames.size, 1); // still animating
		scheduler.suspend();
		assert.equal(frames.size, 0);
		scheduler.request();
		assert.equal(frames.size, 0);
		frames.flush();
		assert.equal(ran(), 1);
	});

	it("resume runs the held frame; nothing held means nothing scheduled", () => {
		const { frames, scheduler, ran } = animatingLoop();
		scheduler.request();
		scheduler.suspend();
		scheduler.resume();
		assert.equal(frames.size, 1);
		frames.flush();
		assert.equal(ran(), 1);

		const idle = fakeFrames();
		const quiet = new FrameScheduler(() => {}, idle.api);
		quiet.suspend();
		quiet.resume();
		assert.equal(idle.size, 0);
	});

	it("cancel drops a held frame for good", () => {
		const { frames, scheduler } = animatingLoop();
		scheduler.request();
		scheduler.suspend();
		scheduler.cancel();
		scheduler.resume();
		assert.equal(frames.size, 0);
	});
});

describe("leavesPathname", () => {
	const home = "http://127.0.0.1:3000/";
	it("a different pathname leaves; search or hash changes stay", () => {
		assert.equal(leavesPathname("/chat/abc", home), true);
		assert.equal(leavesPathname("http://127.0.0.1:3000/chat/abc", home), true);
		assert.equal(leavesPathname("/?q=limits", home), false);
		assert.equal(leavesPathname("/#graph", home), false);
		assert.equal(leavesPathname("/", "http://127.0.0.1:3000/?q=x"), false);
	});
});

describe("graph loop on navigation (suspendWhileLeaving)", () => {
	const pageHref = "http://127.0.0.1:3000/";

	it("stops scheduling frames as soon as a navigation away starts", () => {
		const { frames, scheduler, ran } = animatingLoop();
		const nav = fakeTransitions();
		suspendWhileLeaving(scheduler, { subscribe: nav.subscribe, pageHref });
		scheduler.request();
		frames.flush();
		frames.flush();
		assert.equal(ran(), 2);
		nav.start("/chat/chat_bench_0");
		assert.equal(frames.size, 0);
		frames.flush();
		frames.flush();
		assert.equal(ran(), 2);
	});

	it("a navigation that stays on the page resumes drawing", () => {
		const { frames, scheduler } = animatingLoop();
		const nav = fakeTransitions();
		suspendWhileLeaving(scheduler, { subscribe: nav.subscribe, pageHref });
		scheduler.request();
		nav.start("/chat/abc");
		assert.equal(frames.size, 0);
		nav.start("/?q=limits");
		assert.equal(frames.size, 1);
	});

	it("resumes after the backstop if the page is still mounted", async () => {
		const { frames, scheduler } = animatingLoop();
		const nav = fakeTransitions();
		suspendWhileLeaving(scheduler, { subscribe: nav.subscribe, pageHref, backstopMs: 5 });
		scheduler.request();
		nav.start("/chat/abc");
		assert.equal(frames.size, 0);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(frames.size, 1);
	});

	it("cleanup unsubscribes and clears the backstop", async () => {
		const { frames, scheduler } = animatingLoop();
		const nav = fakeTransitions();
		const stop = suspendWhileLeaving(scheduler, { subscribe: nav.subscribe, pageHref, backstopMs: 5 });
		scheduler.request();
		nav.start("/chat/abc");
		stop();
		assert.equal(nav.subscribed, false);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(frames.size, 0);
	});
});
