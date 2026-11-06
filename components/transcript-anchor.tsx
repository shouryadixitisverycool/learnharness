"use client";

import { Component, useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { messageIdFromHash } from "@/src/core";

/** Progressive transcript mount (owner, perf round 2, 2026-11-06): a chat
 * opens with its newest FIRST_FRAME_ROWS view messages, on the server render
 * and the client's first frame alike, then mounts the older ones
 * ROWS_PER_FRAME at a time, one chunk per frame, newest-first, until the
 * whole transcript is in the DOM. Scrolling up or Find in that first moment
 * may not reach older rows yet; that was accepted. A URL hash naming a
 * message mounts everything at once, so deep links land as before. */
export const FIRST_FRAME_ROWS = 12;
export const ROWS_PER_FRAME = 10;

export function firstMountedIndex(count: number): number {
	return Math.max(0, count - FIRST_FRAME_ROWS);
}

export function nextMountedIndex(from: number): number {
	return Math.max(0, from - ROWS_PER_FRAME);
}

export function hashNamesMessage(hash: string): boolean {
	return messageIdFromHash(hash) !== null;
}

/** The index of the oldest mounted view message. Rows below it render
 * nothing; their keys and indexes are untouched, so mounting only inserts. */
export function useProgressiveMount(count: number): number {
	// Same value on the server and in hydration: the hash is client-only, so
	// it is read after the first commit (below), never in the initializer.
	const [from, setFrom] = useState(() => firstMountedIndex(count));

	// Before first paint on a client navigation; right after hydration on a
	// direct load.
	useLayoutEffect(() => {
		if (hashNamesMessage(window.location.hash)) setFrom(0);
	}, []);

	// A later hash change to a not-yet-mounted message: mount everything
	// synchronously, in the capture phase, so SessionMessageNavigation's own
	// (bubble) hashchange handler finds the row.
	useEffect(() => {
		if (from === 0) return;
		const onHash = () => {
			if (hashNamesMessage(window.location.hash)) flushSync(() => setFrom(0));
		};
		window.addEventListener("hashchange", onHash, true);
		window.addEventListener("popstate", onHash, true);
		return () => {
			window.removeEventListener("hashchange", onHash, true);
			window.removeEventListener("popstate", onHash, true);
		};
	}, [from]);

	// One chunk per frame: the rAF lands in the frame after this commit was
	// painted, the timeout after that frame's paint.
	useEffect(() => {
		if (from === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const frame = requestAnimationFrame(() => {
			timer = setTimeout(() => setFrom(nextMountedIndex), 0);
		});
		return () => {
			cancelAnimationFrame(frame);
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [from]);

	return from;
}

interface AnchorSnapshot {
	/** Stay at the bottom after this commit. */
	bottom: boolean;
	/** The previously oldest mounted row and its viewport top before the commit. */
	first: Element | null;
	top: number;
}

interface TranscriptAnchorProps {
	mountFrom: number;
	rootRef: RefObject<HTMLElement | null>;
	scrollContextRef: RefObject<StickToBottomContext | null>;
	children: ReactNode;
}

export function distanceFromBottom(scroller: HTMLElement): number {
	return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
}

/** Keeps the visible rows still while older rows mount above them. Renders
 * no DOM of its own. It reads positions right before React mutates the DOM
 * (getSnapshotBeforeUpdate) and corrects scrollTop right after, before paint.
 * The correction is the MEASURED move of the previously oldest row, so it is
 * zero when Chrome's own scroll anchoring already compensated. While
 * mounting is in progress, a view locked at the bottom stays at the bottom
 * (the dock spacer's first measurement, a streamed delta). Once every row is
 * mounted it does nothing: stick-to-bottom owns scrolling as before. */
export class TranscriptAnchor extends Component<TranscriptAnchorProps> {
	getSnapshotBeforeUpdate(prev: TranscriptAnchorProps): AnchorSnapshot | null {
		if (prev.mountFrom === 0) return null;
		const context = this.props.scrollContextRef.current;
		const scroller = context?.scrollRef.current;
		const root = this.props.rootRef.current;
		if (!context || !scroller || !root) return null;
		const bottom = context.state.isAtBottom && distanceFromBottom(scroller) <= 1;
		const prepended = this.props.mountFrom < prev.mountFrom;
		const first = prepended && !bottom ? root.firstElementChild : null;
		if (!bottom && !first) return null;
		return { bottom, first, top: first?.getBoundingClientRect().top ?? 0 };
	}

	componentDidUpdate(_prev: TranscriptAnchorProps, _state: unknown, snapshot: AnchorSnapshot | null): void {
		if (!snapshot) return;
		const scroller = this.props.scrollContextRef.current?.scrollRef.current;
		if (!scroller) return;
		if (snapshot.bottom) {
			scroller.scrollTop = scroller.scrollHeight;
			return;
		}
		if (!snapshot.first?.isConnected) return;
		const moved = snapshot.first.getBoundingClientRect().top - snapshot.top;
		if (moved !== 0) scroller.scrollTop += moved;
	}

	render(): ReactNode {
		return this.props.children;
	}
}

declare global {
	interface Window { __lhBottomPin?: (() => void) | null }
}

/** The server HTML's pre-paint bottom pin (owner, perf round 2). It runs
 * while the page is still parsing: the transcript scroller (this script's
 * previous sibling's first child) is pinned to the bottom by a
 * ResizeObserver, whose callbacks run before every paint, until hydration
 * takes over (BottomPin) or the first wheel/touch/key/pointer input. A hash
 * naming a message skips it. React-created scripts never execute, so on a
 * client navigation the node is inert; it is typed text/plain there (the
 * Next "preventing flash before hydration" guide's pattern) so React's dev
 * build does not warn about it. Keep it ES5-small and self-contained. */
export const BOTTOM_PIN_SCRIPT = `(function(){try{var s=document.currentScript,r=s&&s.previousElementSibling,e=r&&r.firstElementChild,h=location.hash;if(!e||!e.firstElementChild||!window.ResizeObserver)return;try{h=decodeURIComponent(h.replace(/^#/,""))}catch(x){h=""}if(h.indexOf("message-")===0&&h.length>8)return;var t=["wheel","touchstart","keydown","pointerdown"],p=function(){e.scrollTop=e.scrollHeight},o=new ResizeObserver(p),f=function(){o.disconnect();window.__lhBottomPin=null;for(var i=0;i<t.length;i++)removeEventListener(t[i],f,true)};p();o.observe(e);o.observe(e.firstElementChild);for(var i=0;i<t.length;i++)addEventListener(t[i],f,{capture:true,passive:true});window.__lhBottomPin=f}catch(x){}})()`;

/** Rendered right AFTER the Conversation, so its layout effect runs after
 * the scroller's refs are attached. On mount (client navigation or
 * hydration) it puts the transcript at the bottom before first paint and
 * retires the server pin; a hash naming a message is left to
 * SessionMessageNavigation. */
export function BottomPin({ scrollContextRef }: { scrollContextRef: RefObject<StickToBottomContext | null> }) {
	useLayoutEffect(() => {
		window.__lhBottomPin?.();
		const scroller = scrollContextRef.current?.scrollRef.current;
		if (scroller && !hashNamesMessage(window.location.hash)) scroller.scrollTop = scroller.scrollHeight;
	}, [scrollContextRef]);
	return (
		<script
			type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
			suppressHydrationWarning
			dangerouslySetInnerHTML={{ __html: BOTTOM_PIN_SCRIPT }}
		/>
	);
}
