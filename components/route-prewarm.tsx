"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

// Home -> chat navigation used to pay the chat transcript's whole JS cost
// (streamdown/shiki/katex chunks, ~1 MB decoded) plus the shiki engine init
// inside the measured window. Those chunks render byte-identical output
// whenever they load, so fetching+evaluating them early is invisible: this
// prewarm runs only after the current page has finished painting (post-LCP,
// through requestIdleCallback), never on chat routes (they load the same
// modules themselves), and at most once per page lifetime.

type IdleWindow = Window & {
	requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

type CodePlugin = {
	getThemes: () => [unknown, unknown];
	highlight: (
		options: { code: string; language: string; themes: unknown },
		callback?: () => void,
	) => unknown;
};

async function prewarmChatTranscript(): Promise<void> {
	try {
		const { streamdownPlugins } = await import("@/components/ai-elements/message");
		const code = (streamdownPlugins as { code?: CodePlugin }).code;
		if (!code) return;
		// The plugin caches one highlighter per (language, themes); warming it
		// here moves the shiki engine + grammar init off the first chat paint.
		// "js" only: the engine init is the shared cost, other languages pay
		// just their grammar load in the post-mount highlight effect.
		code.highlight(
			{ code: "const prewarm = 1;", language: "js", themes: code.getThemes() },
			() => {},
		);
	} catch {
		// Best effort only — a failed prewarm must never break the host page.
	}
}

let scheduled = false;

export default function RoutePrewarm() {
	const pathname = usePathname();
	useEffect(() => {
		if (scheduled) return;
		if (!pathname || pathname.startsWith("/chat/") || pathname === "/login") return;
		scheduled = true;

		const run = () => {
			void prewarmChatTranscript();
		};
		const idle = () => {
			const w = window as IdleWindow;
			if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 1500 });
			else setTimeout(run, 500);
		};

		// Gate on LCP so the eval can never delay the host page's own paint
		// metrics. Entries keep arriving while bigger paints land; start once
		// they go quiet. Hard fallback keeps the prewarm from being lost on
		// pages where LCP never fires.
		let lastEntry = 0;
		let sawEntry = false;
		try {
			const observer = new PerformanceObserver((list) => {
				if (list.getEntries().length > 0) {
					sawEntry = true;
					lastEntry = performance.now();
				}
			});
			observer.observe({ type: "largest-contentful-paint", buffered: true });
			setTimeout(() => observer.disconnect(), 10000);
		} catch {
			sawEntry = true; // no LCP support: fall through to the timed checks
		}
		const started = performance.now();
		const tick = () => {
			const now = performance.now();
			if ((sawEntry && now - lastEntry > 250) || now - started > 8000) {
				if (document.readyState === "complete") idle();
				else window.addEventListener("load", idle, { once: true });
				return;
			}
			setTimeout(tick, 250);
		};
		tick();
	}, [pathname]);
	return null;
}
