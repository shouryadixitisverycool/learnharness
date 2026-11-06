/**
 * App Router navigation-start signal. instrumentation-client.ts forwards
 * Next's onRouterTransitionStart hook here (every push, replace and
 * back/forward, whatever started it); pages subscribe to stop background
 * work the moment the user leaves them, before the destination renders.
 *
 * A window event, not module state, so the instrumentation entry and the
 * app chunks never depend on sharing one module instance.
 */

const EVENT = "lh:route-transition-start";

export function announceRouteTransition(url: string): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: url }));
}

export function onRouteTransitionStart(listener: (url: string) => void): () => void {
	const handler = (e: Event) => listener(String((e as CustomEvent<string>).detail));
	window.addEventListener(EVENT, handler);
	return () => window.removeEventListener(EVENT, handler);
}

/** True when navigating to `url` leaves the page at `currentHref` (a
 *  different pathname). Search- or hash-only changes stay on the page. */
export function leavesPathname(url: string, currentHref: string): boolean {
	try {
		return new URL(url, currentHref).pathname !== new URL(currentHref).pathname;
	} catch {
		return false;
	}
}

export type Suspendable = { suspend(): void; resume(): void };

/** Suspend `target` when a navigation away from the current page starts,
 *  resume it when a navigation stays on the page. The page's URL is taken
 *  once, at subscribe time: on back/forward, location already holds the
 *  destination when the hook fires. If the page is still
 *  mounted `backstopMs` later (a navigation that ended back here without
 *  a new transition), resume anyway so the page never stays frozen. The
 *  normal exit is unmount, which calls the returned cleanup. */
export function suspendWhileLeaving(
	target: Suspendable,
	{
		subscribe = onRouteTransitionStart,
		pageHref = window.location.href,
		backstopMs = 5000,
	}: {
		subscribe?: (listener: (url: string) => void) => () => void;
		pageHref?: string;
		backstopMs?: number;
	} = {},
): () => void {
	let backstop: ReturnType<typeof setTimeout> | null = null;
	const clearBackstop = () => {
		if (backstop !== null) clearTimeout(backstop);
		backstop = null;
	};
	const unsubscribe = subscribe((url) => {
		clearBackstop();
		if (leavesPathname(url, pageHref)) {
			target.suspend();
			backstop = setTimeout(() => {
				backstop = null;
				target.resume();
			}, backstopMs);
		} else {
			target.resume();
		}
	});
	return () => {
		clearBackstop();
		unsubscribe();
	};
}
