/**
 * The combined request gate (src/server/request-gate.ts) for a self-hosted
 * server behind tailscale serve: upstream's browser-only host/origin policy
 * plus the fork's server-mode sign-in and apps-only checks, shared by Proxy
 * and the streamed plugin document route.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestGateRefusal } from "../src/server/request-gate.ts";
import { createPluginDocumentRoute } from "../src/server/plugin-transport.ts";
import { mintSessionToken, SESSION_COOKIE } from "../src/server/remote-access.ts";

const HOST = "dixithome.example.ts.net:8446";
const ORIGIN = `https://${HOST}`;
const server = { LH_SERVER_PASSWORD: "correct horse battery staple", LH_SESSION_SECRET: "a".repeat(64) };
const allowed = { ...server, LH_ALLOWED_HOSTS: "dixithome.example.ts.net" };

/** What tailscale serve forwards: the original Host, X-Forwarded-Proto
 *  https, so Next builds an https request URL. */
function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
	return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers: { host: HOST, "x-forwarded-proto": "https", ...init.headers } });
}
const signedIn = (env: Record<string, string>) => ({ cookie: `${SESSION_COOKIE}=${mintSessionToken(env)}` });

describe("request gate behind tailscale serve", () => {
	it("refuses the API for an unlisted host name, sign-in included", async () => {
		for (const path of ["/api/chats", "/api/auth/login"]) {
			const refusal = requestGateRefusal(request(path), server);
			assert.equal(refusal?.status, 403, path);
			assert.match((await refusal!.json()).error, /LH_ALLOWED_HOSTS/);
		}
	});

	it("with the name allowlisted, keeps the server-mode sign-in gate", async () => {
		assert.equal(requestGateRefusal(request("/api/chats"), allowed)?.status, 401);
		assert.equal(requestGateRefusal(request("/api/auth/login", { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } }), allowed), undefined);
		const page = requestGateRefusal(request("/sessions?x=1"), allowed);
		assert.equal(page?.status, 307);
		assert.equal(page?.headers.get("location"), `${ORIGIN}/login?next=%2Fsessions%3Fx%3D1`);
		assert.equal(requestGateRefusal(request("/login"), allowed), undefined);
	});

	it("lets a signed-in same-origin write through and refuses a cross-site one", async () => {
		const headers = signedIn(allowed);
		assert.equal(requestGateRefusal(request("/api/chats", { headers }), allowed), undefined);
		assert.equal(requestGateRefusal(request("/api/chats", { method: "POST", headers: { ...headers, origin: ORIGIN, "sec-fetch-site": "same-origin" } }), allowed), undefined);
		const cross = requestGateRefusal(request("/api/chats", { method: "POST", headers: { ...headers, origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), allowed);
		assert.equal(cross?.status, 403);
		assert.match((await cross!.json()).error, /Cross-site/);
	});

	it("apps-only refuses a browser before any other check", async () => {
		const env = { ...allowed, LH_APPS_ONLY: "1" };
		assert.equal(requestGateRefusal(request("/api/chats", { headers: signedIn(env) }), env)?.status, 403);
		assert.equal(requestGateRefusal(request("/api/chats", { headers: { ...signedIn(env), "user-agent": "Mozilla/5.0 LearnHarnessAndroid/1.0.0" } }), env), undefined);
	});

	it("without server mode, pages pass and the API keeps upstream's policy", () => {
		assert.equal(requestGateRefusal(new Request("http://localhost:3000/"), {}), undefined);
		assert.equal(requestGateRefusal(new Request("http://localhost:3000/api/chats", { headers: { host: "localhost:3000" } }), {}), undefined);
		assert.equal(requestGateRefusal(new Request("http://mymac.local:3000/api/chats", { headers: { host: "mymac.local:3000" } }), {})?.status, 403);
	});

	it("the streamed plugin document route, which skips Proxy, still requires sign-in", async (t) => {
		const keys = ["LH_SERVER_PASSWORD", "LH_SESSION_SECRET", "LH_ALLOWED_HOSTS", "LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET", "LH_APPS_ONLY"] as const;
		const saved = keys.map((key) => process.env[key]);
		for (const key of keys) delete process.env[key];
		Object.assign(process.env, allowed);
		try {
			const convert = t.mock.fn(async () => Response.json({ markdown: "fixture" }));
			const route = createPluginDocumentRoute({ convertDocument: convert });
			const context = { params: Promise.resolve({ id: "doc" }) };
			const post = (headers: Record<string, string>) => request("/api/plugins/doc/documents/markdown", { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers } });
			assert.equal((await route.POST(post({}), context)).status, 401);
			assert.equal(convert.mock.callCount(), 0);
			assert.equal((await route.POST(post(signedIn(allowed)), context)).status, 200);
			assert.equal(convert.mock.callCount(), 1);
		} finally {
			keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
		}
	});
});
