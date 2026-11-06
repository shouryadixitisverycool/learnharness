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

		// Gate on the FIRST LCP entry + 600 ms: the page's own paint metrics
		// are settled by then (a canvas can keep emitting bigger LCP
		// candidates for seconds — waiting for quiet never fires), and the
		// margin keeps the eval clear of a late final LCP paint on cold
		// loads. Fallback keeps the prewarm if LCP never fires.
		let lcpAt = 0;
		try {
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) lcpAt = entry.startTime;
			});
			observer.observe({ type: "largest-contentful-paint", buffered: true });
			setTimeout(() => observer.disconnect(), 5000);
		} catch {
			// No LCP support: lcpAt stays 0 and the fallback timer governs.
		}
		const start = () => {
			const t0 = performance.now();
			const tick = () => {
				const now = performance.now();
				if ((lcpAt > 0 && now >= lcpAt + 600) || now - t0 > 2500) {
					const w = window as IdleWindow;
					if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 500 });
					else run();
					return;
				}
				setTimeout(tick, 100);
			};
			tick();
		};
		if (document.readyState === "complete") start();
		else window.addEventListener("load", start, { once: true });
	}, [pathname]);
	return null;
}
