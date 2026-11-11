import { apiRequestRefusal } from "./desktop-access.ts";
import { appsOnlyAllowed, appsOnlyRefusal, isPublicPath, remoteRequestAuthorized, serverModeEnabled } from "./remote-access.ts";

type Env = Record<string, string | undefined>;

/** Every request check that runs before a route: Proxy calls it, and so does
 * the one streamed route that bypasses Proxy (plugin document conversion).
 * Returns the refusal, or undefined when the request may continue.
 *
 * 1. LH_APPS_ONLY=1 (server mode): anything that isn't a LearnHarness app is
 *    refused before sign-in.
 * 2. API requests: the desktop capability, or in browser-only mode the Host
 *    allowlist (LH_ALLOWED_HOSTS) and the cross-site write check.
 * 3. Server mode (LH_SERVER_PASSWORD): signed-out API calls get 401 and
 *    signed-out pages go to /login. */
export function requestGateRefusal(request: Request, env: Env = process.env): Response | undefined {
	const url = new URL(request.url);
	const { pathname, search } = url;
	const api = pathname === "/api" || pathname.startsWith("/api/");
	if (!appsOnlyAllowed(request.headers, env)) return appsOnlyRefusal(api);
	if (api) {
		const refusal = apiRequestRefusal(request, env);
		if (refusal) return Response.json({ error: refusal }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	if (serverModeEnabled(env) && !isPublicPath(pathname) && !remoteRequestAuthorized(request.headers, env)) {
		if (api) return Response.json({ error: "Sign in required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
		const login = new URL("/login", url);
		login.searchParams.set("next", pathname + search);
		return new Response(null, { status: 307, headers: { Location: login.toString(), "Cache-Control": "no-store" } });
	}
}
