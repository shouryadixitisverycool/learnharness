/**
 * Azure OpenAI through an endpoint URL + API key.
 *
 * Discovery asks the resource for its deployments (the data-plane
 * deployments list) and for its model list (/models, which flags each
 * model's chat_completion capability). The snapshot is stored as non-secret
 * settings; this module turns it into a pi-ai provider that replaces pi's
 * static azure catalog while configured, streaming through pi's native
 * Azure adapters. The key is read from the auth file (or a real env var)
 * per publication and handed to pi per request. It is never copied into
 * process.env, so child processes (Claude Code) never inherit it.
 */

import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { AZURE_MODELS } from "@earendil-works/pi-ai/providers/azure.models";
import { configureProviderSource, nativeAzureProvider, piModels } from "../agent/models.ts";
import { AZURE_PROVIDER } from "../core/auth-keys.ts";
import {
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	azureProviderConfigured,
	normalizeAzureEndpoint,
	type AzureModel,
	type AzureProviderSettings,
} from "../core/settings.ts";
import { readAzureFileKey } from "../store/auth.ts";
import { readSettings } from "../store/settings.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

/** Context window for a deployment whose model pi-ai's catalog does not know. */
export const AZURE_UNKNOWN_CONTEXT_WINDOW = 128_000;

/** The data-plane api-version that still serves the deployments list (later
 *  GA versions answer 404 for it). */
export const AZURE_DEPLOYMENTS_API_VERSION = "2022-12-01";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// ─── Credentials ─────────────────────────────────────────────────────────────

export interface AzureAuthState {
	readable: boolean;
	key?: string;
	source: "env" | "file" | "none";
}

/** The effective key: a real env var wins over the file (the keys seam's
 *  precedence). The fresh-user switch hides env keys. */
export function azureAuthState(): AzureAuthState {
	const envKey = process.env.LH_IGNORE_ENV_KEYS !== "1" ? process.env[AZURE_PROVIDER.envVar]?.trim() : undefined;
	if (envKey) return { readable: true, key: envKey, source: "env" };
	try {
		const fileKey = readAzureFileKey()?.trim();
		return fileKey ? { readable: true, key: fileKey, source: "file" } : { readable: true, source: "none" };
	} catch {
		return { readable: false, source: "none" };
	}
}

// ─── Discovery ───────────────────────────────────────────────────────────────

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type AzureDiscoverResult =
	| { ok: true; models: AzureModel[] }
	| { ok: false; error: string; status?: number };

/** Azure's error text from a JSON error body ({error: {message}}), capped. */
async function azureMessage(res: Response): Promise<string | undefined> {
	try {
		const body = await readBoundedJson(res, 64 * 1024);
		const error = isRecord(body) ? body.error : undefined;
		const message = isRecord(error) ? error.message : isRecord(body) ? body.message : undefined;
		return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : undefined;
	} catch {
		return undefined;
	}
}

class AzureHttpError extends Error {
	constructor(message: string, readonly status?: number) { super(message); }
}

async function getJson(fetchImpl: FetchLike, url: string, key: string, what: string): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		let res: Response;
		try {
			res = await fetchImpl(url, { headers: { "api-key": key, accept: "application/json" }, signal: controller.signal, redirect: "manual" });
		} catch {
			throw new AzureHttpError(controller.signal.aborted ? "The Azure endpoint timed out" : "Couldn't reach the Azure endpoint");
		}
		if (res.status === 401 || res.status === 403) {
			const message = await azureMessage(res);
			throw new AzureHttpError(`Azure rejected the API key (HTTP ${res.status})${message ? `: ${message}` : ""}`, res.status);
		}
		if (!res.ok) {
			const message = await azureMessage(res);
			throw new AzureHttpError(`The Azure ${what} returned HTTP ${res.status}${message ? `: ${message}` : ""}`, res.status);
		}
		try {
			return await readBoundedJson(res, 8 * 1024 * 1024);
		} catch (error) {
			throw new AzureHttpError(error instanceof CustomBodyLimitError ? `The Azure ${what} was too large` : `The Azure ${what} was unreadable`);
		}
	} finally {
		clearTimeout(timer);
	}
}

/** The deployments list URL: the endpoint minus a trailing /v1, then
 *  /deployments (…/openai/v1 → …/openai/deployments). */
export function azureDeploymentsUrl(endpoint: string): string {
	const url = new URL(endpoint);
	url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/deployments`;
	url.search = new URLSearchParams({ "api-version": AZURE_DEPLOYMENTS_API_VERSION }).toString();
	return url.toString();
}

/** The model list URL: <endpoint>/models. */
export function azureModelsUrl(endpoint: string): string {
	return `${endpoint.replace(/\/+$/, "")}/models`;
}

/** Pure selection over the deployments + models bodies. Keeps deployments
 *  whose status is succeeded (or unreported) and whose model /models flags
 *  as chat_completion. A deployment whose model /models does not list is
 *  kept (owner, 2026-11-08). */
export function selectAzureDeployments(deploymentsBody: unknown, modelsBody: unknown): AzureModel[] {
	const rows = isRecord(deploymentsBody) && Array.isArray(deploymentsBody.data) ? deploymentsBody.data : null;
	if (!rows) throw new AzureHttpError("Azure's response was not a deployment list");
	const chat = new Map<string, boolean>();
	const listed = isRecord(modelsBody) && Array.isArray(modelsBody.data) ? modelsBody.data : [];
	for (const m of listed) {
		if (!isRecord(m) || typeof m.id !== "string") continue;
		const caps = isRecord(m.capabilities) ? m.capabilities : undefined;
		// One id can appear more than once; any chat-capable row counts.
		chat.set(m.id, chat.get(m.id) === true || caps?.chat_completion === true);
	}
	const byId = new Map<string, AzureModel>();
	for (const row of rows) {
		if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim() || /\s/.test(row.id.trim())) continue;
		if (row.status !== undefined && row.status !== "succeeded") continue;
		const id = row.id.trim();
		const model = typeof row.model === "string" && row.model.trim() && !/\s/.test(row.model.trim()) ? row.model.trim() : undefined;
		const capability = chat.get(model ?? id);
		if (capability === false) continue;
		byId.set(id, model ? { id, model } : { id });
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Discover the resource's chat deployments. A rejected key, unreachable
 *  endpoint or unreadable list is an error (nothing is saved). */
export async function discoverAzureModels(endpointRaw: string, key: string, fetchImpl: FetchLike = fetch): Promise<AzureDiscoverResult> {
	const endpoint = normalizeAzureEndpoint(endpointRaw);
	if (!endpoint) return { ok: false, error: "Enter an https endpoint URL" };
	try {
		const [deployments, models] = await Promise.all([
			getJson(fetchImpl, azureDeploymentsUrl(endpoint), key, "deployment list"),
			getJson(fetchImpl, azureModelsUrl(endpoint), key, "model list"),
		]);
		const found = selectAzureDeployments(deployments, models);
		if (!found.length) return { ok: false, error: "No chat deployments were found on this resource" };
		return { ok: true, models: found };
	} catch (error) {
		if (error instanceof AzureHttpError) return { ok: false, error: error.message, status: error.status };
		return { ok: false, error: "Azure discovery failed" };
	}
}

// ─── Metadata join + registration ────────────────────────────────────────────

const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

function piCatalog(): Model<Api>[] {
	return Object.values(AZURE_MODELS) as Model<Api>[];
}

/** pi-ai's entry by deployment name, else by the reported model, else by
 *  the reported model without its version date. */
function knownEntry(model: AzureModel): Model<Api> | undefined {
	const catalog = piCatalog();
	for (const id of [model.id, model.model, model.model?.replace(DATE_SUFFIX, "")]) {
		const hit = id ? catalog.find((m) => m.id === id) : undefined;
		if (hit) return hit;
	}
	return undefined;
}

/** One deployment as a pi-ai model: pi-ai's limits, reasoning, prices and
 *  name when it knows the model (named "<name> (<deployment>)" when the
 *  deployment name differs); otherwise text only, no reasoning, a 128k
 *  context and an unknown price. */
export function toAzurePiModel(model: AzureModel, endpoint: string): { model: Model<Api>; priceKnown: boolean } {
	const known = knownEntry(model);
	if (known) {
		const name = known.id === model.id ? known.name : `${known.name} (${model.id})`;
		return { model: { ...known, id: model.id, name, provider: AZURE_PROVIDER.id, baseUrl: endpoint }, priceKnown: true };
	}
	return {
		priceKnown: false,
		model: {
			id: model.id,
			name: model.model && model.model !== model.id ? `${model.id} (${model.model})` : model.id,
			api: "azure-openai-responses",
			provider: AZURE_PROVIDER.id,
			baseUrl: endpoint,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: AZURE_UNKNOWN_CONTEXT_WINDOW,
			maxTokens: CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
			type: "chat",
		},
	};
}

// HMR-stable: pricing reads this to show "unknown" instead of $0.
const unknownKey = Symbol.for("learnharness.azure-unknown-prices");
const globals = globalThis as typeof globalThis & { [unknownKey]?: Set<string> };
const unknownPrices = globals[unknownKey] ??= new Set<string>();

/** True when the registered Azure model has no pi-ai price data. */
export function azurePriceUnknown(id: string): boolean {
	return unknownPrices.has(id);
}

/** Build the configured Azure provider on pi's native Azure streams. The
 *  endpoint, api-version and an identity deployment map ride per request as
 *  scoped env, which outranks any ambient AZURE_OPENAI_* values. */
export function buildAzureProvider(input: { endpoint: string; models: readonly AzureModel[]; key: string }): Provider<Api> {
	const native = nativeAzureProvider();
	if (!native) throw new Error("pi-ai's Azure provider is missing");
	const mapped = input.models.map((m) => toAzurePiModel(m, input.endpoint));
	unknownPrices.clear();
	for (const { model, priceKnown } of mapped) if (!priceKnown) unknownPrices.add(model.id);
	const env = {
		AZURE_OPENAI_BASE_URL: input.endpoint,
		AZURE_OPENAI_API_VERSION: "v1",
		AZURE_OPENAI_DEPLOYMENT_NAME_MAP: input.models.map((m) => `${m.id}=${m.id}`).join(","),
	};
	return createProvider<Api>({
		id: AZURE_PROVIDER.id,
		name: AZURE_PROVIDER.label,
		auth: { apiKey: {
			name: "Azure OpenAI API key",
			resolve: async () => ({ auth: { apiKey: input.key }, env, source: "Azure OpenAI API key" }),
		} },
		models: mapped.map((m) => m.model),
		api: { stream: native.stream, streamSimple: native.streamSimple },
	});
}

/** Install the Azure source: configured + key + deployments → the
 *  discovered provider; otherwise pi-ai's own entry (hidden from the
 *  picker, as before). */
export function installAzureProviderSource(readAuth = azureAuthState): void {
	let fingerprint: string | undefined;
	configureProviderSource({
		isCustom: () => false,
		sync(models) {
			const ap = readSettings()?.azureProvider;
			const auth = readAuth();
			const ready = azureProviderConfigured(ap) && Boolean(auth.key) && Boolean(ap.models?.length);
			const next = JSON.stringify([ap ?? null, auth]); // in-memory only
			if (next === fingerprint) return;
			if (ready) models.setProvider(buildAzureProvider({ endpoint: ap.endpoint, models: ap.models ?? [], key: auth.key! }));
			else {
				unknownPrices.clear();
				const native = nativeAzureProvider();
				if (native) models.setProvider(native);
			}
			fingerprint = next;
		},
	}, "azure");
}

/** Is the user's Azure provider registered (configured, key present)? */
export function azureProviderAvailable(): boolean {
	const current = piModels().getProvider(AZURE_PROVIDER.id);
	return current !== undefined && current !== nativeAzureProvider();
}

/** The editor's view of the stored snapshot: names joined from pi-ai. */
export function azureModelRows(ap: AzureProviderSettings | undefined): { id: string; name: string; model?: string }[] {
	if (!azureProviderConfigured(ap)) return [];
	return (ap.models ?? []).map((m) => ({ id: m.id, name: toAzurePiModel(m, ap.endpoint).model.name, ...(m.model ? { model: m.model } : {}) }));
}
