/**
 * Amazon Bedrock (API key + region): settings sanitization, discovery
 * parsing/filtering against a mocked Bedrock control plane, the pi-ai
 * metadata join (including reasoning for models pi-ai does not know), key
 * storage (file only, never process.env, env wins), provider registration
 * + the picker row, and the route's save/refresh/remove policy.
 * Every key here is a throwaway test string; no request leaves the process.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bedrock-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
delete process.env.LH_IGNORE_ENV_KEYS;
const SETTINGS_FILE = path.join(dir, "settings.json");
const AUTH_FILE = path.join(dir, "auth.json");
const KEY = "ABSKtest-key-0123456789";

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
	delete process.env.LH_AUTH_FILE;
});

const settings = await import("../src/core/settings.ts");
const bedrock = await import("../src/server/bedrock-provider.ts");
const keys = await import("../src/server/keys.ts");
const catalog = await import("../src/server/model-catalog.ts");
const { piModels, piEngineForSpec, nativeBedrockProvider } = await import("../src/agent/models.ts");
const { BEDROCK_PROVIDER, AUTH_PROVIDER_KEYS } = await import("../src/core/auth-keys.ts");
type Route = typeof import("../app/api/bedrock-provider/route.ts");
let route: Route;
before(async () => { route = await import("../app/api/bedrock-provider/route.ts"); });

// ─── A mocked Bedrock control plane, shaped like the real responses ─────────

const converse = (extra: Record<string, unknown> = {}) => ({ sync: true, streaming: true, ...extra });
function fm(modelId: string, opts: { types?: string[]; output?: string[]; input?: string[]; status?: string; converse?: Record<string, unknown> | null; name?: string; schema?: unknown; maxTokens?: number } = {}) {
	return {
		modelId,
		modelName: opts.name ?? modelId,
		outputModalities: opts.output ?? ["TEXT"],
		inputModalities: opts.input ?? ["TEXT"],
		inferenceTypesSupported: opts.types ?? ["ON_DEMAND"],
		modelLifecycle: { status: opts.status ?? "ACTIVE" },
		inferenceAPIsSupported: opts.converse === null ? undefined : { converse: converse(opts.converse ?? {}) },
		responseStreamingSupported: true,
		converse: { maxTokensMaximum: opts.maxTokens ?? null, additionalRequestFieldsSchema: opts.schema === undefined ? null : JSON.stringify(opts.schema) },
	};
}
const GPT_SCHEMA = { reasoning_config: { type: "enum", default: "medium", enum: ["none", "low", "medium", "high", "xhigh", "max"] } };
const FOUNDATION = {
	modelSummaries: [
		fm("amazon.nova-micro-v1:0", { types: ["INFERENCE_PROFILE"], name: "Nova Micro" }),
		fm("amazon.nova-lite-v1:0", { types: ["INFERENCE_PROFILE", "ON_DEMAND"], input: ["TEXT", "IMAGE"], name: "Nova Lite" }),
		fm("openai.gpt-6.1-terra", { types: ["INFERENCE_PROFILE"], input: ["TEXT", "IMAGE"], name: "GPT-6.1 Terra", schema: GPT_SCHEMA, maxTokens: 128000 }),
		fm("moonshotai.kimi-k2.5", { name: "Kimi K2.5", schema: { reasoningConfig: { enabled: { type: "boolean" } } } }),
		fm("cohere.embed-v4:0", { output: ["EMBEDDING"], converse: { sync: false, streaming: false } }),
		fm("amazon.nova-2-sonic-v1:0", { output: ["SPEECH", "TEXT"], converse: { sync: false } }),
		fm("old.legacy-v1", { status: "LEGACY" }),
		fm("orphan.profile-only", { types: ["INFERENCE_PROFILE"] }),
	],
};
const PROFILES = [
	{ inferenceProfileId: "eu.amazon.nova-micro-v1:0", status: "ACTIVE" },
	{ inferenceProfileId: "eu.amazon.nova-lite-v1:0", status: "ACTIVE" },
	{ inferenceProfileId: "eu.openai.gpt-6.1-terra", status: "ACTIVE" },
	{ inferenceProfileId: "global.openai.gpt-6.1-terra", status: "ACTIVE" },
];
const AVAILABLE = { agreementAvailability: { status: "AVAILABLE" }, authorizationStatus: "AUTHORIZED", entitlementAvailability: "AVAILABLE", regionAvailability: "AVAILABLE" };

interface MockOptions { status?: number; message?: string; unconfirmed?: string[]; paged?: boolean }
const requests: { url: string; auth: string | null }[] = [];
function mockAws(opts: MockOptions = {}) {
	requests.length = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
		if (opts.status) return Response.json({ message: opts.message ?? "denied" }, { status: opts.status });
		const u = new URL(url);
		if (u.pathname === "/foundation-models") return Response.json(FOUNDATION);
		if (u.pathname === "/inference-profiles") {
			if (opts.paged && !u.searchParams.get("nextToken")) return Response.json({ inferenceProfileSummaries: PROFILES.slice(0, 2), nextToken: "page2" });
			return Response.json({ inferenceProfileSummaries: opts.paged ? PROFILES.slice(2) : PROFILES });
		}
		const m = u.pathname.match(/^\/foundation-model-availability\/(.+)$/);
		if (m) {
			const id = decodeURIComponent(m[1]!);
			return Response.json(opts.unconfirmed?.includes(id) ? { ...AVAILABLE, agreementAvailability: { status: "NOT_AVAILABLE" } } : AVAILABLE);
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

function readJson(file: string): Record<string, unknown> {
	try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return {}; }
}
function reset() {
	fs.rmSync(SETTINGS_FILE, { force: true });
	fs.rmSync(AUTH_FILE, { force: true });
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
	piModels();
}

function request(method: string, body?: unknown, origin = "http://localhost") {
	return new Request("http://localhost/api/bedrock-provider", {
		method,
		headers: { "content-type": "application/json", origin },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

// ─── Settings sanitization ──────────────────────────────────────────────────

describe("bedrockProvider settings sanitization", () => {
	it("keeps a valid region and well-formed models, drops the rest", () => {
		const out = settings.sanitizeUserSettings({
			version: 1,
			bedrockProvider: {
				region: " EU-North-1 ",
				models: [
					{ id: "global.openai.gpt-6.1-terra", awsName: "GPT-6.1 Terra", image: true, maxTokens: 128000, accessConfirmed: true, reasoningLevels: ["low", "high", "low", "BAD", 3] },
					{ id: "global.openai.gpt-6.1-terra", awsName: "dupe wins" },
					{ id: "  " }, { id: "has space" }, { id: 5 }, null, "x",
					{ id: "qwen.qwen3-32b-v1:0", image: "yes", maxTokens: -1, accessConfirmed: "true" },
				],
			},
		});
		assert.deepEqual(out?.bedrockProvider, {
			region: "eu-north-1",
			models: [{ id: "global.openai.gpt-6.1-terra", awsName: "dupe wins" }, { id: "qwen.qwen3-32b-v1:0" }],
		});
	});
	it("drops a region that is not an AWS region id", () => {
		for (const region of ["", "europe", "eu-north", "eu-north-1; rm", 42]) {
			assert.equal(settings.sanitizeUserSettings({ version: 1, bedrockProvider: { region } })?.bedrockProvider?.region, undefined, String(region));
		}
		assert.equal(settings.normalizeBedrockRegion("us-gov-west-1"), "us-gov-west-1");
		assert.ok(settings.BEDROCK_REGIONS.includes("eu-north-1"));
	});
	it("keeps reasoning levels deduped", () => {
		const out = settings.sanitizeBedrockProvider({ region: "eu-north-1", models: [{ id: "a", reasoningLevels: ["low", "high", "low", "BAD", 3] }] });
		assert.deepEqual(out.models?.[0]?.reasoningLevels, ["low", "high"]);
	});
});

// ─── Discovery parsing and filtering ────────────────────────────────────────

describe("Bedrock discovery", () => {
	it("keeps active Converse text models and routes them: on-demand id, else global, else regional", async () => {
		mockAws({ unconfirmed: ["openai.gpt-6.1-terra"] });
		const found = await bedrock.discoverBedrockModels("eu-north-1", KEY);
		assert.ok(found.ok);
		assert.deepEqual(found.models.map((m) => m.id), [
			"amazon.nova-lite-v1:0",
			"eu.amazon.nova-micro-v1:0",
			"global.openai.gpt-6.1-terra",
			"moonshotai.kimi-k2.5",
		]);
		const terra = found.models.find((m) => m.id === "global.openai.gpt-6.1-terra")!;
		assert.deepEqual(terra, { id: "global.openai.gpt-6.1-terra", awsName: "GPT-6.1 Terra", image: true, maxTokens: 128000, reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"] }, "unconfirmed access leaves accessConfirmed unset");
		assert.equal(found.models.find((m) => m.id === "eu.amazon.nova-micro-v1:0")?.accessConfirmed, true);
		assert.ok(requests.every((r) => r.auth === `Bearer ${KEY}`), "every call carries the bearer key");
		assert.ok(requests.every((r) => r.url.startsWith("https://bedrock.eu-north-1.amazonaws.com/")), "control plane of the chosen region");
		assert.ok(requests.some((r) => r.url.includes("/foundation-model-availability/openai.gpt-6.1-terra")), "availability is asked for the base model of a profile");
	});
	it("follows inference-profile pages", async () => {
		mockAws({ paged: true });
		const found = await bedrock.discoverBedrockModels("eu-north-1", KEY);
		assert.ok(found.ok);
		assert.ok(found.models.some((m) => m.id === "global.openai.gpt-6.1-terra"));
	});
	it("reports a rejected key with AWS's message", async () => {
		mockAws({ status: 403, message: "Bearer token is invalid" });
		const found = await bedrock.discoverBedrockModels("eu-north-1", KEY);
		assert.deepEqual(found, { ok: false, error: "AWS rejected the Bedrock API key (HTTP 403): Bearer token is invalid", status: 403 });
	});
	it("reports an unreachable region and a bad region id", async () => {
		globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
		const found = await bedrock.discoverBedrockModels("eu-north-1", KEY);
		assert.equal(found.ok, false);
		assert.equal(!found.ok && found.error, "Couldn't reach Bedrock in eu-north-1");
		assert.equal((await bedrock.discoverBedrockModels("nowhere", KEY)).ok, false);
	});
	it("parses the reasoning_config enum and availability bodies", () => {
		assert.deepEqual(bedrock.reasoningEnum(JSON.stringify(GPT_SCHEMA)), ["none", "low", "medium", "high", "xhigh", "max"]);
		assert.equal(bedrock.reasoningEnum(JSON.stringify({ reasoningConfig: { enabled: {} } })), undefined);
		assert.equal(bedrock.reasoningEnum("not json"), undefined);
		assert.equal(bedrock.availabilityConfirmed(AVAILABLE), true);
		assert.equal(bedrock.availabilityConfirmed({ ...AVAILABLE, authorizationStatus: "NOT_AUTHORIZED" }), false);
	});
});

// ─── Metadata join ──────────────────────────────────────────────────────────

describe("Bedrock metadata join", () => {
	it("uses pi-ai's entry for a known id, renamed for its prefix", () => {
		const exact = bedrock.toBedrockPiModel({ id: "eu.amazon.nova-micro-v1:0" }, "eu-north-1");
		assert.equal(exact.priceKnown, true);
		assert.equal(exact.model.name, "Nova Micro (EU)");
		assert.equal(exact.model.baseUrl, "https://bedrock-runtime.eu-north-1.amazonaws.com");
		assert.equal(exact.model.provider, "amazon-bedrock");
		assert.ok(exact.model.cost.input > 0);
	});
	it("gives an unknown GPT model reasoning levels from AWS's effort enum, not pi-ai's catalog", () => {
		const { model, priceKnown } = bedrock.toBedrockPiModel({ id: "global.openai.gpt-6.1-terra", awsName: "GPT-6.1 Terra", image: true, maxTokens: 128000, reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"] }, "eu-north-1");
		assert.equal(priceKnown, false);
		assert.equal(model.name, "GPT-6.1 Terra (Global)");
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.maxTokens, 128000);
		assert.equal(model.contextWindow, bedrock.BEDROCK_UNKNOWN_CONTEXT_WINDOW);
	});
	it("keeps reasoning off where pi's adapter has no effort field to send", () => {
		assert.equal(bedrock.toBedrockPiModel({ id: "vendor.unknown-x", awsName: "X", reasoningLevels: ["low", "high"] }, "eu-north-1").model.reasoning, false);
		assert.equal(bedrock.toBedrockPiModel({ id: "global.openai.gpt-9-new" }, "eu-north-1").model.reasoning, false, "no AWS enum, no levels");
	});
});

// ─── Key storage, registration and the picker ───────────────────────────────

describe("Bedrock key storage and registration", () => {
	beforeEach(reset);

	it("stays out of the pi-ai plain-key table and the generic keys API", () => {
		assert.ok(!AUTH_PROVIDER_KEYS.some((p) => p.id === BEDROCK_PROVIDER.id || p.envVar === BEDROCK_PROVIDER.envVar));
		assert.equal(keys.isWritableAuthKey(BEDROCK_PROVIDER.envVar), false);
		assert.deepEqual(keys.saveKey(BEDROCK_PROVIDER.envVar, KEY), { ok: false, error: "Use the Amazon Bedrock editor" });
		assert.throws(() => keys.deleteKey(BEDROCK_PROVIDER.envVar), /Amazon Bedrock editor/);
	});

	it("save stores the key in the file only, registers discovered models, and lists the picker row", async () => {
		mockAws();
		const res = await route.POST(request("POST", { region: "eu-north-1", key: ` ${KEY} ` }));
		assert.equal(res.status, 200);
		const body = await res.json() as { region: string; models: { id: string; name: string; accessConfirmed: boolean }[]; keyPresent: boolean; keySource: string };
		assert.equal(body.region, "eu-north-1");
		assert.equal(body.keySource, "file");
		assert.ok(!JSON.stringify(body).includes(KEY), "no key characters in the response");
		assert.equal(readJson(AUTH_FILE)[BEDROCK_PROVIDER.envVar], KEY, "trimmed key in auth.json");
		assert.equal(process.env.AWS_BEARER_TOKEN_BEDROCK, undefined, "never reflected into process.env");
		assert.ok(!readJson(SETTINGS_FILE).bedrockProvider || !JSON.stringify(readJson(SETTINGS_FILE)).includes(KEY), "settings hold no key");

		keys.initAuthEnv();
		assert.equal(process.env.AWS_BEARER_TOKEN_BEDROCK, undefined, "the boot fill-gap skips it too");
		const status = keys.keyStatuses().find((s) => s.id === BEDROCK_PROVIDER.envVar);
		assert.deepEqual([status?.present, status?.masked, status?.source], [true, "••••", "file"]);

		const provider = piModels().getProvider(BEDROCK_PROVIDER.id);
		assert.ok(provider && provider !== nativeBedrockProvider());
		assert.deepEqual(piModels().getModels(BEDROCK_PROVIDER.id).map((m) => m.id).sort(), body.models.map((m) => m.id).sort());
		assert.equal(bedrock.bedrockProviderAvailable(), true);
		assert.equal(keys.providerKeyPresent(BEDROCK_PROVIDER.id), true);
		const row = catalog.catalogProviders().find((p) => p.id === BEDROCK_PROVIDER.id);
		assert.deepEqual(row, { id: BEDROCK_PROVIDER.id, envVar: BEDROCK_PROVIDER.envVar, keyPresent: true });
		const terra = catalog.modelCatalog().models.find((m) => m.id === "global.openai.gpt-6.1-terra");
		assert.equal(terra?.cost, null, "unknown price is shown as unknown, never $0");
		assert.ok(terra?.supportedLevels.includes("high"));
		assert.ok(!terra?.supportedLevels.includes("minimal"));

		// The auth resolution hands pi the bearer key and the region per request.
		const resolved = await piModels().getAuth(piModels().getModel(BEDROCK_PROVIDER.id, "global.openai.gpt-6.1-terra")!);
		assert.equal(resolved?.auth.apiKey, KEY);
		assert.equal(resolved?.env?.AWS_REGION, "eu-north-1");

		// Reasoning high survives the engine's clamp.
		assert.equal(piEngineForSpec({ provider: BEDROCK_PROVIDER.id, id: "global.openai.gpt-6.1-terra", thinkingLevel: "high" }).level, "high");
	});

	it("a real env key wins and the editor cannot overwrite it", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "ABSKenv-owned-key-9876";
		mockAws();
		const refused = await route.POST(request("POST", { region: "eu-north-1", key: KEY }));
		assert.equal(refused.status, 400);
		const res = await route.POST(request("POST", { region: "eu-north-1" }));
		assert.equal(res.status, 200);
		assert.equal((await res.json() as { keySource: string }).keySource, "env");
		assert.ok(requests.every((r) => r.auth === "Bearer ABSKenv-owned-key-9876"));
		assert.equal(readJson(AUTH_FILE)[BEDROCK_PROVIDER.envVar], undefined);
	});

	it("a rejected key stores nothing", async () => {
		mockAws({ status: 403, message: "invalid" });
		const res = await route.POST(request("POST", { region: "eu-north-1", key: KEY }));
		assert.equal(res.status, 502);
		assert.match((await res.json() as { error: string }).error, /AWS rejected the Bedrock API key \(HTTP 403\)/);
		assert.equal(fs.existsSync(SETTINGS_FILE) && Boolean(readJson(SETTINGS_FILE).bedrockProvider), false);
		assert.equal(readJson(AUTH_FILE)[BEDROCK_PROVIDER.envVar], undefined);
		assert.equal(bedrock.bedrockProviderAvailable(), false);
	});

	it("refresh reuses the stored key; remove restores pi-ai's own entry", async () => {
		mockAws();
		assert.equal((await route.POST(request("POST", { region: "eu-north-1", key: KEY }))).status, 200);
		mockAws({ unconfirmed: ["moonshotai.kimi-k2.5"] });
		const refreshed = await route.POST(request("POST", { region: "eu-north-1" }));
		assert.equal(refreshed.status, 200);
		const rows = (await refreshed.json() as { models: { id: string; accessConfirmed: boolean }[] }).models;
		assert.equal(rows.find((m) => m.id === "moonshotai.kimi-k2.5")?.accessConfirmed, false);
		assert.ok(requests.every((r) => r.auth === `Bearer ${KEY}`));

		const removed = await route.DELETE(request("DELETE", {}));
		assert.equal(removed.status, 200);
		assert.equal(readJson(AUTH_FILE)[BEDROCK_PROVIDER.envVar], undefined);
		assert.equal(readJson(SETTINGS_FILE).bedrockProvider, undefined);
		assert.equal(piModels().getProvider(BEDROCK_PROVIDER.id), nativeBedrockProvider());
		assert.equal(catalog.catalogProviders().some((p) => p.id === BEDROCK_PROVIDER.id), false);
	});

	it("refuses cross-origin writes and a missing key", async () => {
		mockAws();
		assert.equal((await route.POST(request("POST", { region: "eu-north-1", key: KEY }, "http://evil.example"))).status, 403);
		assert.equal((await route.POST(request("POST", { region: "eu-north-1" }))).status, 400);
		assert.equal((await route.POST(request("POST", { region: "mars-1", key: KEY }))).status, 400);
		assert.equal(requests.length, 0, "nothing reached AWS");
	});
});
