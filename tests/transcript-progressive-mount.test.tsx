import React, { act, useRef, type RefObject } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import type { Root } from "react-dom/client";
import type { StickToBottomContext } from "use-stick-to-bottom";
import {
	BOTTOM_PIN_SCRIPT, BottomPin, FIRST_FRAME_ROWS, ROWS_PER_FRAME, TranscriptAnchor,
	distanceFromBottom, firstMountedIndex, nextMountedIndex, upwardScrollIntent, useProgressiveMount,
} from "../components/transcript-anchor.tsx";

const { window, document } = parseHTML("<html><body></body></html>");
const location = { hash: "" };
Object.assign(window, { location });
Object.assign(globalThis, {
	window,
	document,
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	Node: window.Node,
	Event: window.Event,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});

/* A fake layout: every row is ROW px tall, stacked in DOM order inside the
 * rows root; the scroller is VIEW px tall and clamps scrollTop like a
 * browser. getBoundingClientRect is viewport-relative (scroller at 0). */
const ROW = 100;
const VIEW = 900;
let scroller: HTMLElement & { _top: number };
let rowsRoot: () => Element | null;

function makeScroller() {
	const element = document.createElement("div") as unknown as HTMLElement & { _top: number };
	element._top = 0;
	Object.defineProperty(element, "clientHeight", { get: () => VIEW });
	Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => Math.max(VIEW, (rowsRoot()?.children.length ?? 0) * ROW) });
	Object.defineProperty(element, "scrollTop", {
		get: () => element._top,
		set: (value: number) => { element._top = Math.max(0, Math.min(value, element.scrollHeight - VIEW)); },
	});
	return element;
}

const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
	const parent = this.parentElement;
	if (parent && parent === rowsRoot()) {
		const index = Array.prototype.indexOf.call(parent.children, this);
		const top = index * ROW - scroller.scrollTop;
		return { top, bottom: top + ROW, left: 0, right: 0, width: 0, height: ROW, x: 0, y: top, toJSON() {} } as DOMRect;
	}
	return originalRect ? originalRect.call(this) : ({ top: 0 } as DOMRect);
};

let stops = 0;
function contextFor(isAtBottom: boolean): RefObject<StickToBottomContext | null> {
	const state = { isAtBottom };
	return { current: { scrollRef: { current: scroller }, state, stopScroll: () => { stops++; state.isAtBottom = false; } } as unknown as StickToBottomContext };
}

function rowsFor(count: number) {
	return Array.from({ length: count }, (_, i) => `row ${i}`);
}

let log: number[] = [];

function Harness({ count, context }: { count: number; context: RefObject<StickToBottomContext | null> }) {
	const from = useProgressiveMount(count);
	log.push(from);
	const rootRef = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={rootRef} data-rows="">
			<TranscriptAnchor mountFrom={from} rootRef={rootRef} scrollContextRef={context}>
				{rowsFor(count).map((text, i) => (i < from ? null : <p key={i}>{text}</p>))}
			</TranscriptAnchor>
		</div>
	);
}

const roots: { root: Root; host: HTMLElement }[] = [];

async function mount(element: React.ReactElement, parent: HTMLElement = document.body as unknown as HTMLElement) {
	const host = document.createElement("div") as unknown as HTMLElement;
	parent.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	rowsRoot = () => host.querySelector("[data-rows]");
	await act(async () => { root.render(element); });
	return host;
}

/** One chunk: the rAF, then the timeout, then React's commit. */
async function nextFrame() {
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function mountAll(onStep?: () => void) {
	for (let i = 0; i < 20 && log.at(-1) !== 0; i++) {
		await nextFrame();
		onStep?.();
	}
}

beforeEach(() => {
	log = [];
	stops = 0;
	location.hash = "";
	scroller = makeScroller();
	rowsRoot = () => null;
});

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); });
		host.remove();
	}
	scroller.remove();
});

describe("progressive transcript mount", () => {
	it("starts from the newest twelve and steps ten at a time", () => {
		assert.equal(FIRST_FRAME_ROWS, 12);
		assert.equal(ROWS_PER_FRAME, 10);
		assert.equal(firstMountedIndex(120), 108);
		assert.equal(firstMountedIndex(12), 0);
		assert.equal(firstMountedIndex(5), 0);
		assert.equal(nextMountedIndex(108), 98);
		assert.equal(nextMountedIndex(4), 0);
	});

	it("server-renders only the newest twelve rows", () => {
		const markup = renderToString(<Harness count={30} context={{ current: null }} />);
		assert.ok(!markup.includes("row 17<"));
		for (let i = 18; i < 30; i++) assert.ok(markup.includes(`row ${i}<`), `row ${i}`);
	});

	it("mounts older rows newest-first, one chunk per frame, ending in the full DOM", async () => {
		const host = await mount(<Harness count={30} context={contextFor(false)} />);
		const texts = () => Array.from(rowsRoot()!.children, (row) => row.textContent);
		assert.deepEqual(texts(), rowsFor(30).slice(18));
		const suffixes: number[] = [];
		await mountAll(() => suffixes.push(rowsRoot()!.children.length));
		assert.deepEqual([...new Set(log)], [18, 8, 0]);
		assert.deepEqual(suffixes, [22, 30]);
		const full = renderToStaticMarkup(<div data-rows="">{rowsFor(30).map((text, i) => <p key={i}>{text}</p>)}</div>);
		assert.equal(host.innerHTML, full);
	});

	it("keeps the visible rows still while older rows mount above", async () => {
		await mount(<Harness count={40} context={contextFor(false)} />);
		scroller.scrollTop = 50;
		const newestFirst = () => Array.from(rowsRoot()!.children).find((row) => row.textContent === "row 28")!;
		const before = newestFirst().getBoundingClientRect().top;
		const tops: number[] = [];
		await mountAll(() => tops.push(newestFirst().getBoundingClientRect().top));
		assert.equal(rowsRoot()!.children.length, 40);
		assert.ok(tops.length >= 3);
		for (const top of tops) assert.equal(top, before);
		assert.equal(scroller.scrollTop, 50 + 28 * ROW);
	});

	it("stays at the bottom while mounting when stick-to-bottom is locked", async () => {
		await mount(<Harness count={40} context={contextFor(true)} />);
		scroller.scrollTop = scroller.scrollHeight;
		assert.equal(distanceFromBottom(scroller), 0);
		const distances: number[] = [];
		await mountAll(() => distances.push(distanceFromBottom(scroller)));
		assert.ok(distances.length >= 3);
		assert.deepEqual(new Set(distances), new Set([0]));
	});

	it("releases the bottom lock on upward input inside the scroller while mounting", async () => {
		// The scroller wraps the rows, as in the app.
		document.body.append(scroller);
		await mount(<Harness count={40} context={contextFor(true)} />, scroller);
		const nested = rowsRoot()!.children[3]!;
		const wheel = (deltaY: number, target: Element) => {
			const event = new window.Event("wheel", { bubbles: true }) as unknown as WheelEvent;
			Object.defineProperty(event, "deltaY", { value: deltaY });
			target.dispatchEvent(event);
		};
		wheel(120, nested);
		assert.equal(stops, 0);
		wheel(-120, document.body as unknown as Element);
		assert.equal(stops, 0);
		wheel(-120, nested);
		assert.equal(stops, 1);
		await mountAll();
		wheel(-120, nested);
		assert.equal(stops, 1, "no listener once every row is mounted");
	});

	it("classifies upward scroll input", () => {
		const target = document.createElement("div") as unknown as HTMLElement;
		const event = (type: string, props: Record<string, unknown>, on: EventTarget = target) => {
			const e = new window.Event(type) as unknown as Event;
			for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
			Object.defineProperty(e, "target", { value: on });
			return e;
		};
		assert.equal(upwardScrollIntent(event("wheel", { deltaY: -1 }), target, null), true);
		assert.equal(upwardScrollIntent(event("wheel", { deltaY: 1 }), target, null), false);
		assert.equal(upwardScrollIntent(event("touchmove", { touches: [{ clientY: 300 }] }), target, 200), true);
		assert.equal(upwardScrollIntent(event("touchmove", { touches: [{ clientY: 100 }] }), target, 200), false);
		assert.equal(upwardScrollIntent(event("keydown", { key: "PageUp" }), target, null), true);
		assert.equal(upwardScrollIntent(event("keydown", { key: " ", shiftKey: true }), target, null), true);
		assert.equal(upwardScrollIntent(event("keydown", { key: "ArrowDown" }), target, null), false);
		assert.equal(upwardScrollIntent(event("pointerdown", {}), target, null), true);
		assert.equal(upwardScrollIntent(event("pointerdown", {}, document.body), target, null), false);
	});

	it("mounts everything at once when the hash names a message", async () => {
		location.hash = "#message-m_0_3";
		await mount(<Harness count={30} context={contextFor(false)} />);
		assert.equal(rowsRoot()!.children.length, 30);
		assert.equal(log.at(-1), 0);
	});

	it("mounts everything synchronously on a later hash change", async () => {
		await mount(<Harness count={30} context={contextFor(false)} />);
		assert.equal(rowsRoot()!.children.length, 12);
		let seen = -1;
		window.addEventListener("hashchange", () => { seen = rowsRoot()!.children.length; });
		location.hash = "#message-m_0_3";
		await act(async () => { window.dispatchEvent(new window.Event("hashchange")); });
		assert.equal(seen, 30);
	});
});

describe("open at bottom", () => {
	function runPin(env: { hash?: string; scroller?: Record<string, unknown> | null }) {
		const observers: { cb: () => void; observed: unknown[]; disconnected: boolean }[] = [];
		class FakeResizeObserver {
			entry: (typeof observers)[number];
			constructor(cb: () => void) { this.entry = { cb, observed: [], disconnected: false }; observers.push(this.entry); }
			observe(target: unknown) { this.entry.observed.push(target); }
			disconnect() { this.entry.disconnected = true; }
		}
		const listeners = new Map<string, () => void>();
		const fakeWindow: Record<string, unknown> = { ResizeObserver: FakeResizeObserver };
		const scrollerElement = env.scroller === undefined
			? { scrollTop: 0, scrollHeight: 5000, firstElementChild: { id: "content" } }
			: env.scroller;
		const fakeDocument = { currentScript: { previousElementSibling: { firstElementChild: scrollerElement } } };
		new Function("document", "location", "window", "ResizeObserver", "addEventListener", "removeEventListener", BOTTOM_PIN_SCRIPT)(
			fakeDocument, { hash: env.hash ?? "" }, fakeWindow, FakeResizeObserver,
			(type: string, fn: () => void) => listeners.set(type, fn),
			(type: string) => listeners.delete(type),
		);
		return { observers, listeners, fakeWindow, scroller: scrollerElement as { scrollTop: number; scrollHeight: number } | null };
	}

	it("pins the scroller to the bottom on every resize until the first input", () => {
		const { observers, listeners, fakeWindow, scroller: element } = runPin({});
		assert.equal(element!.scrollTop, 5000);
		assert.equal(observers.length, 1);
		assert.equal(observers[0]!.observed.length, 2);
		element!.scrollHeight = 7000;
		observers[0]!.cb();
		assert.equal(element!.scrollTop, 7000);
		assert.deepEqual([...listeners.keys()].sort(), ["keydown", "pointerdown", "touchstart", "wheel"]);
		listeners.get("wheel")!();
		assert.equal(observers[0]!.disconnected, true);
		assert.equal(listeners.size, 0);
		assert.equal(fakeWindow.__lhBottomPin, null);
	});

	it("exposes a stop handle for hydration", () => {
		const { observers, fakeWindow } = runPin({});
		(fakeWindow.__lhBottomPin as () => void)();
		assert.equal(observers[0]!.disconnected, true);
	});

	it("does nothing when the hash names a message or the scroller is missing", () => {
		const deep = runPin({ hash: "#message-m_0_3" });
		assert.equal(deep.scroller!.scrollTop, 0);
		assert.equal(deep.observers.length, 0);
		assert.equal(runPin({ scroller: null }).observers.length, 0);
	});

	it("server-renders an executable script, inert text/plain on the client", () => {
		const saved = globalThis.window;
		// @ts-expect-error -- simulate the server
		delete globalThis.window;
		try {
			const markup = renderToString(<BottomPin scrollContextRef={{ current: null }} />);
			assert.ok(markup.startsWith('<script type="text/javascript">'));
			assert.ok(markup.includes("__lhBottomPin"));
		} finally {
			globalThis.window = saved;
		}
	});

	it("snaps to the bottom and retires the server pin on mount", async () => {
		rowsRoot = () => null;
		let stopped = false;
		(window as unknown as Record<string, unknown>).__lhBottomPin = () => { stopped = true; };
		Object.defineProperty(scroller, "scrollHeight", { get: () => 4000 });
		const host = await mount(<BottomPin scrollContextRef={contextFor(true)} />);
		assert.equal(stopped, true);
		assert.equal(scroller.scrollTop, 4000 - VIEW);
		assert.equal(host.querySelector("script")!.getAttribute("type"), "text/plain");
	});
});
