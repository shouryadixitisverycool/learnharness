/**
 * Azure OpenAI (endpoint + API key): settings sanitization, discovery
 * parsing/filtering against a mocked Azure data plane, the pi-ai metadata
 * join (deployment name, then reported model, then the model without its
 * date), key storage (file only, never process.env, env wins), provider
 * registration + the picker row, the request a stream sends, and the
 * route's save/refresh/remove policy.
 * Every key here is a throwaway test string; no request leaves the process.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-azure-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.AZURE_OPENAI_API_KEY;
delete process.env.AZURE_OPENAI_BASE_URL;
delete process.env.LH_IGNORE_ENV_KEYS;
const SETTINGS_FILE = path.join(dir, "settings.json");
const AUTH_FILE = path.join(dir, "auth.json");
const KEY = "azure-test-key-0123456789";
const ENDPOINT = "https://example-resource.openai.azure.com/openai/v1";

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
	delete process.env.LH_AUTH_FILE;
});

const settings = await import("../src/core/settings.ts");
const azure = await import("../src/server/azure-provider.ts");
const keys = await import("../src/server/keys.ts");
const catalog = await import("../src/server/model-catalog.ts");
const { piModels, piEngineForSpec, nativeAzureProvider } = await import("../src/agent/models.ts");
const { AZURE_PROVIDER, AUTH_PROVIDER_KEYS } = await import("../src/core/auth-keys.ts");
type Route = typeof import("../app/api/azure-provider/route.ts");
let route: Route;
before(async () => { route = await import("../app/api/azure-provider/route.ts"); });

// ─── A mocked Azure data plane, shaped like the real responses ──────────────

const dep = (id: string, model = id, status = "succeeded") => ({ scale_settings: { scale_type: "standard" }, model, owner: "organization-owner", id, status, object: "deployment" });
const DEPLOYMENTS = {
	data: [
		dep("gpt-6-sol"),
		dep("gpt-6-luna"),
		dep("my-sol", "gpt-6.1-sol-2026-09-29"),
		dep("embed", "text-embedding-3-small"),
		dep("pending", "gpt-6-sol", "creating"),
		dep("mystery", "vendor-thing-7"),
	],
	object: "list",
};
const caps = (chat: boolean) => ({ fine_tune: false, inference: true, completion: false, chat_completion: chat, embeddings: !chat });
const MODELS = {
	data: [
		{ id: "gpt-6-sol", capabilities: caps(true) },
		{ id: "gpt-6-luna", capabilities: caps(true) },
		{ id: "gpt-6.1-sol-2026-09-29", capabilities: caps(true) },
		{ id: "text-embedding-3-small", capabilities: caps(false) },
	],
	object: "list",
};

interface MockOptions { status?: number; message?: string; deployments?: unknown }
const requests: { url: string; key: string | null }[] = [];
function mockAzure(opts: MockOptions = {}) {
	requests.length = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, key: new Headers(init?.headers).get("api-key") });
		if (opts.status) return Response.json({ error: { code: String(opts.status), message: opts.message ?? "denied" } }, { status: opts.status });
		const u = new URL(url);
		if (u.pathname === "/openai/deployments" && u.searchParams.get("api-version") === azure.AZURE_DEPLOYMENTS_API_VERSION) return Response.json(opts.deployments ?? DEPLOYMENTS);
		if (u.pathname === "/openai/v1/models") return Response.json(MODELS);
		return Response.json({ error: { code: "404", message: "Resource not found" } }, { status: 404 });
	}) as typeof fetch;
}

function readJson(file: string): Record<string, unknown> {
	try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return {}; }
}
function reset() {
	fs.rmSync(SETTINGS_FILE, { force: true });
	fs.rmSync(AUTH_FILE, { force: true });
	delete process.env.AZURE_OPENAI_API_KEY;
	piModels();
}

function request(method: string, body?: unknown, origin = "http://localhost") {
	return new Request("http://localhost/api/azure-provider", {
		method,
		headers: { "content-type": "application/json", origin },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

// ─── Settings sanitization ──────────────────────────────────────────────────

describe("azureProvider settings sanitization", () => {
	it("keeps a valid endpoint and well-formed deployments, drops the rest", () => {
		const out = settings.sanitizeUserSettings({
			version: 1,
			azureProvider: {
				endpoint: ` ${ENDPOINT}/ `,
				models: [
					{ id: "gpt-6-sol", model: "gpt-6-sol" },
					{ id: "gpt-6-sol", model: "gpt-6-sol-2026-09-22" },
					{ id: "  " }, { id: "has space" }, { id: 5 }, null, "x",
					{ id: "luna", model: "bad model" },
				],
			},
		});
		assert.deepEqual(out?.azureProvider, {
			endpoint: ENDPOINT,
			models: [{ id: "gpt-6-sol", model: "gpt-6-sol-2026-09-22" }, { id: "luna" }],
		});
	});
	it("accepts any https URL and drops everything else", () => {
		assert.equal(settings.normalizeAzureEndpoint("https://proxy.example/azure/"), "https://proxy.example/azure");
		for (const endpoint of ["", "http://x.openai.azure.com/openai/v1", "not a url", "https://u:p@x.example", "https://x.example/?a=1", 42]) {
			assert.equal(settings.sanitizeUserSettings({ version: 1, azureProvider: { endpoint } })?.azureProvider?.endpoint, undefined, String(endpoint));
		}
	});
});

// ─── Discovery parsing and filtering ────────────────────────────────────────

describe("Azure discovery", () => {
	it("keeps succeeded chat deployments and unlisted models, drops non-chat ones", async () => {
		mockAzure();
		const found = await azure.discoverAzureModels(ENDPOINT, KEY);
		assert.ok(found.ok);
		assert.deepEqual(found.models, [
			{ id: "gpt-6-luna", model: "gpt-6-luna" },
			{ id: "gpt-6-sol", model: "gpt-6-sol" },
			{ id: "my-sol", model: "gpt-6.1-sol-2026-09-29" },
			{ id: "mystery", model: "vendor-thing-7" },
		]);
		assert.ok(requests.every((r) => r.key === KEY), "every call carries the api-key header");
		assert.deepEqual(requests.map((r) => new URL(r.url).pathname).sort(), ["/openai/deployments", "/openai/v1/models"]);
	});
	it("derives the list URLs from any endpoint", () => {
		assert.equal(azure.azureDeploymentsUrl(ENDPOINT), `https://example-resource.openai.azure.com/openai/deployments?api-version=${azure.AZURE_DEPLOYMENTS_API_VERSION}`);
		assert.equal(azure.azureDeploymentsUrl("https://proxy.example/azure"), `https://proxy.example/azure/deployments?api-version=${azure.AZURE_DEPLOYMENTS_API_VERSION}`);
		assert.equal(azure.azureModelsUrl(ENDPOINT), `${ENDPOINT}/models`);
	});
	it("reports a rejected key with Azure's message", async () => {
		mockAzure({ status: 401, message: "Access denied due to invalid subscription key" });
		const found = await azure.discoverAzureModels(ENDPOINT, KEY);
		assert.deepEqual(found, { ok: false, error: "Azure rejected the API key (HTTP 401): Access denied due to invalid subscription key", status: 401 });
	});
	it("fails when the deployment list is missing, empty or unreachable", async () => {
		mockAzure();
		const proxy = await azure.discoverAzureModels("https://proxy.example/v1", KEY);
		assert.deepEqual(proxy, { ok: false, error: "The Azure deployment list returned HTTP 404: Resource not found", status: 404 });
		mockAzure({ deployments: { data: [dep("embed", "text-embedding-3-small")] } });
		assert.deepEqual(await azure.discoverAzureModels(ENDPOINT, KEY), { ok: false, error: "No chat deployments were found on this resource" });
		globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
		const unreachable = await azure.discoverAzureModels(ENDPOINT, KEY);
		assert.equal(!unreachable.ok && unreachable.error, "Couldn't reach the Azure endpoint");
		assert.equal((await azure.discoverAzureModels("http://insecure.example", KEY)).ok, false);
	});
});

// ─── Metadata join ──────────────────────────────────────────────────────────

describe("Azure metadata join", () => {
	it("uses pi-ai's entry by deployment name", () => {
		const { model, priceKnown } = azure.toAzurePiModel({ id: "gpt-6-sol", model: "gpt-6-sol" }, ENDPOINT);
		assert.equal(priceKnown, true);
		assert.equal(model.name, "GPT-6 Sol");
		assert.equal(model.provider, "azure");
		assert.equal(model.baseUrl, ENDPOINT);
		assert.equal(model.reasoning, true);
		assert.ok(model.cost.input > 0);
	});
	it("falls back to the reported model without its date, keeping the deployment id", () => {
		const { model, priceKnown } = azure.toAzurePiModel({ id: "my-sol", model: "gpt-6.1-sol-2026-09-29" }, ENDPOINT);
		assert.equal(priceKnown, true);
		assert.equal(model.id, "my-sol");
		assert.equal(model.name, "GPT-6.1 Sol (my-sol)");
		assert.equal(model.contextWindow, 272000);
	});
	it("gives an unknown model the plain defaults and an unknown price", () => {
		const { model, priceKnown } = azure.toAzurePiModel({ id: "mystery", model: "vendor-thing-7" }, ENDPOINT);
		assert.equal(priceKnown, false);
		assert.equal(model.name, "mystery (vendor-thing-7)");
		assert.equal(model.api, "azure-openai-responses");
		assert.equal(model.reasoning, false);
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.contextWindow, azure.AZURE_UNKNOWN_CONTEXT_WINDOW);
	});
});

// ─── Key storage, registration and the picker ───────────────────────────────

describe("Azure key storage and registration", () => {
	beforeEach(reset);

	it("stays out of the pi-ai plain-key table and the generic keys API", () => {
		assert.ok(!AUTH_PROVIDER_KEYS.some((p) => p.id === AZURE_PROVIDER.id || p.envVar === AZURE_PROVIDER.envVar));
		assert.equal(keys.isWritableAuthKey(AZURE_PROVIDER.envVar), false);
		assert.deepEqual(keys.saveKey(AZURE_PROVIDER.envVar, KEY), { ok: false, error: "Use the Azure OpenAI editor" });
		assert.throws(() => keys.deleteKey(AZURE_PROVIDER.envVar), /Azure OpenAI editor/);
	});

	it("save stores the key in the file only, registers deployments, and lists the picker row", async () => {
		mockAzure();
		const res = await route.POST(request("POST", { endpoint: `${ENDPOINT}/`, key: ` ${KEY} ` }));
		assert.equal(res.status, 200);
		const body = await res.json() as { endpoint: string; models: { id: string; name: string }[]; keyPresent: boolean; keySource: string };
		assert.equal(body.endpoint, ENDPOINT);
		assert.equal(body.keySource, "file");
		assert.ok(!JSON.stringify(body).includes(KEY), "no key characters in the response");
		assert.equal(readJson(AUTH_FILE)[AZURE_PROVIDER.envVar], KEY, "trimmed key in auth.json");
		assert.equal(process.env.AZURE_OPENAI_API_KEY, undefined, "never reflected into process.env");
		assert.ok(!JSON.stringify(readJson(SETTINGS_FILE)).includes(KEY), "settings hold no key");

		keys.initAuthEnv();
		assert.equal(process.env.AZURE_OPENAI_API_KEY, undefined, "the boot fill-gap skips it too");
		const status = keys.keyStatuses().find((s) => s.id === AZURE_PROVIDER.envVar);
		assert.deepEqual([status?.present, status?.masked, status?.source], [true, "••••", "file"]);

		const provider = piModels().getProvider(AZURE_PROVIDER.id);
		assert.ok(provider && provider !== nativeAzureProvider());
		assert.deepEqual(piModels().getModels(AZURE_PROVIDER.id).map((m) => m.id).sort(), ["gpt-6-luna", "gpt-6-sol", "my-sol", "mystery"]);
		assert.equal(azure.azureProviderAvailable(), true);
		assert.equal(keys.providerKeyPresent(AZURE_PROVIDER.id), true);
		assert.deepEqual(catalog.catalogProviders().find((p) => p.id === AZURE_PROVIDER.id), { id: AZURE_PROVIDER.id, envVar: AZURE_PROVIDER.envVar, keyPresent: true });
		const models = catalog.modelCatalog().models;
		assert.equal(models.find((m) => m.provider === "azure" && m.id === "mystery")?.cost, null, "unknown price is shown as unknown, never $0");
		assert.ok((models.find((m) => m.provider === "azure" && m.id === "gpt-6-sol")?.cost?.input ?? 0) > 0);

		// The auth resolution hands pi the key and the endpoint per request.
		const resolved = await piModels().getAuth(piModels().getModel(AZURE_PROVIDER.id, "gpt-6-sol")!);
		assert.equal(resolved?.auth.apiKey, KEY);
		assert.equal(resolved?.env?.AZURE_OPENAI_BASE_URL, ENDPOINT);
		assert.equal(piEngineForSpec({ provider: AZURE_PROVIDER.id, id: "gpt-6-sol", thinkingLevel: "high" }).level, "high");
	});

	it("streams to <endpoint>/responses with the api-key header and the deployment as the model", async () => {
		mockAzure();
		assert.equal((await route.POST(request("POST", { endpoint: ENDPOINT, key: KEY }))).status, 200);
		const seen: { url: string; key: string | null; model?: unknown }[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const req = input instanceof Request ? input : new Request(String(input), init);
			const body = await req.text().catch(() => "");
			seen.push({ url: req.url, key: req.headers.get("api-key"), model: body ? (JSON.parse(body) as { model?: unknown }).model : undefined });
			return Response.json({ error: { message: "stop here" } }, { status: 400 });
		}) as typeof fetch;
		const models = piModels();
		const model = models.getModel(AZURE_PROVIDER.id, "my-sol")!;
		const auth = await models.getAuth(model);
		const events = models.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey: auth!.auth.apiKey, env: auth!.env, maxRetries: 0 } as never);
		for await (const _event of events) { /* drain */ }
		assert.ok(seen.length >= 1, "a request went out");
		assert.equal(new URL(seen[0]!.url).origin + new URL(seen[0]!.url).pathname, `${ENDPOINT}/responses`);
		assert.equal(seen[0]!.key, KEY);
		assert.equal(seen[0]!.model, "my-sol");
	});

	it("a real env key wins and the editor cannot overwrite it", async () => {
		process.env.AZURE_OPENAI_API_KEY = "azure-env-owned-key-9876";
		mockAzure();
		const refused = await route.POST(request("POST", { endpoint: ENDPOINT, key: KEY }));
		assert.equal(refused.status, 400);
		const res = await route.POST(request("POST", { endpoint: ENDPOINT }));
		assert.equal(res.status, 200);
		assert.equal((await res.json() as { keySource: string }).keySource, "env");
		assert.ok(requests.every((r) => r.key === "azure-env-owned-key-9876"));
		assert.equal(readJson(AUTH_FILE)[AZURE_PROVIDER.envVar], undefined);
	});

	it("a rejected key stores nothing", async () => {
		mockAzure({ status: 401, message: "invalid" });
		const res = await route.POST(request("POST", { endpoint: ENDPOINT, key: KEY }));
		assert.equal(res.status, 502);
		assert.match((await res.json() as { error: string }).error, /Azure rejected the API key \(HTTP 401\)/);
		assert.equal(fs.existsSync(SETTINGS_FILE) && Boolean(readJson(SETTINGS_FILE).azureProvider), false);
		assert.equal(readJson(AUTH_FILE)[AZURE_PROVIDER.envVar], undefined);
		assert.equal(azure.azureProviderAvailable(), false);
	});

	it("refresh reuses the stored key; remove restores pi-ai's own entry", async () => {
		mockAzure();
		assert.equal((await route.POST(request("POST", { endpoint: ENDPOINT, key: KEY }))).status, 200);
		mockAzure({ deployments: { data: [dep("gpt-6-sol")] } });
		const refreshed = await route.POST(request("POST", { endpoint: ENDPOINT }));
		assert.equal(refreshed.status, 200);
		assert.deepEqual((await refreshed.json() as { models: { id: string }[] }).models.map((m) => m.id), ["gpt-6-sol"]);
		assert.ok(requests.every((r) => r.key === KEY));

		const removed = await route.DELETE(request("DELETE", {}));
		assert.equal(removed.status, 200);
		assert.equal(readJson(AUTH_FILE)[AZURE_PROVIDER.envVar], undefined);
		assert.equal(readJson(SETTINGS_FILE).azureProvider, undefined);
		assert.equal(piModels().getProvider(AZURE_PROVIDER.id), nativeAzureProvider());
		assert.equal(catalog.catalogProviders().some((p) => p.id === AZURE_PROVIDER.id), false);
	});

	it("refuses cross-origin writes, a missing key and a non-https endpoint", async () => {
		mockAzure();
		assert.equal((await route.POST(request("POST", { endpoint: ENDPOINT, key: KEY }, "http://evil.example"))).status, 403);
		assert.equal((await route.POST(request("POST", { endpoint: ENDPOINT }))).status, 400);
		assert.equal((await route.POST(request("POST", { endpoint: "http://example-resource.openai.azure.com/openai/v1", key: KEY }))).status, 400);
		assert.equal(requests.length, 0, "nothing reached Azure");
	});
});
