import { announceRouteTransition } from "@/lib/route-transition";

// Next calls this when an App Router navigation starts (push, replace or
// back/forward). The home graph listens to pause its draw loop while the
// destination renders (lib/route-transition.ts).
export function onRouterTransitionStart(url: string): void {
	announceRouteTransition(url);
}
