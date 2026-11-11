import { NextResponse, type NextRequest } from "next/server";
import { requestGateRefusal } from "./src/server/request-gate.ts";

/** Applies to every page and API method, including SSE and spending/settings
 * routes (src/server/request-gate.ts has the checks). No public callback or
 * worker bypass: internal jobs call server functions, and any legitimate
 * self-HTTP request must carry the private capability. The one streamed
 * document route runs the same gate inside its handler, avoiding Next's
 * silently truncated Proxy body clone. */
export function proxy(request: NextRequest) {
	return requestGateRefusal(request) ?? NextResponse.next();
}

// Everything except build assets, public files (fonts, worklets, icons) and
// the exact streamed plugin document endpoint, not the documents subtree or
// other plugin routes. Must remain a static literal.
export const config = { matcher: ["/((?!_next/static|_next/image|fonts/|worklets/|siwc/|favicon\\.ico|api/plugins/[^/]+/documents/markdown/?$).*)"] };
