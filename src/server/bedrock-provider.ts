/**
 * Amazon Bedrock through a Bedrock API key (bearer token) + region.
 *
 * Discovery asks the user's AWS account which text models it can run in the
 * region (control plane: ListFoundationModels, ListInferenceProfiles,
 * GetFoundationModelAvailability). The snapshot is stored as non-secret
 * settings; this module turns it into a pi-ai provider that replaces pi's
 * static amazon-bedrock catalog while configured, streaming through pi's
 * native Converse adapter. The key is read from the auth file (or a real
 * env var) per publication and handed to pi per request. It is never copied
 * into process.env, so child processes (Claude Code, Cursor) never inherit it.
 */

import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { AMAZON_BEDROCK_MODELS } from "@earendil-works/pi-ai/providers/amazon-bedrock.models";
import { bedrockNativeStreams, configureProviderSource, nativeBedrockProvider, piModels } from "../agent/models.ts";
import { BEDROCK_PROVIDER } from "../core/auth-keys.ts";
import {
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	bedrockProviderConfigured,
	normalizeBedrockRegion,
	type BedrockModel,
	type BedrockProviderSettings,
} from "../core/settings.ts";
import { readBedrockFileKey } from "../store/auth.ts";
import { readSettings } from "../store/settings.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

/** Context window for a model pi-ai's catalog does not know (AWS's list API
 *  reports none). */
export const BEDROCK_UNKNOWN_CONTEXT_WINDOW = 128_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// ─── Credentials ─────────────────────────────────────────────────────────────

export interface BedrockAuthState {
	readable: boolean;
	key?: string;
	source: "env" | "file" | "none";
}

/** The effective key: a real env var wins over the file (the keys seam's
 *  precedence). The fresh-user switch hides env keys. */
export function bedrockAuthState(): BedrockAuthState {
	const envKey = process.env.LH_IGNORE_ENV_KEYS !== "1" ? process.env[BEDROCK_PROVIDER.envVar]?.trim() : undefined;
	if (envKey) return { readable: true, key: envKey, source: "env" };
	try {
		const fileKey = readBedrockFileKey()?.trim();
		return fileKey ? { readable: true, key: fileKey, source: "file" } : { readable: true, source: "none" };
	} catch {
		return { readable: false, source: "none" };
	}
}

// ─── Discovery ───────────────────────────────────────────────────────────────

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type BedrockDiscoverResult =
	| { ok: true; models: BedrockModel[] }
	| { ok: false; error: string; status?: number };

/** AWS's error text from a JSON error body ({message} / {Message}), capped. */
async function awsMessage(res: Response): Promise<string | undefined> {
	try {
		const body = await readBoundedJson(res, 64 * 1024);
		const message = isRecord(body) ? body.message ?? body.Message : undefined;
		return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : undefined;
	} catch {
		return undefined;
	}
}

class BedrockHttpError extends Error {
	constructor(message: string, readonly status?: number) { super(message); }
}

async function getJson(fetchImpl: FetchLike, url: string, key: string, region: string, timeoutMs = 15_000): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let res: Response;
		try {
			res = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: controller.signal, redirect: "manual" });
		} catch {
			throw new BedrockHttpError(controller.signal.aborted ? `Bedrock in ${region} timed out` : `Couldn't reach Bedrock in ${region}`);
		}
		if (res.status === 401 || res.status === 403) {
			const message = await awsMessage(res);
			throw new BedrockHttpError(`AWS rejected the Bedrock API key (HTTP ${res.status})${message ? `: ${message}` : ""}`, res.status);
		}
		if (!res.ok) {
			const message = await awsMessage(res);
			throw new BedrockHttpError(`Bedrock in ${region} returned HTTP ${res.status}${message ? `: ${message}` : ""}`, res.status);
		}
		try {
			return await readBoundedJson(res, 8 * 1024 * 1024);
		} catch (error) {
			throw new BedrockHttpError(error instanceof CustomBodyLimitError ? "Bedrock's model list was too large" : `Bedrock in ${region} sent an unreadable response`);
		}
	} finally {
		clearTimeout(timer);
	}
}

/** The model-id prefixes of system inference profiles: geography (eu, us,
 *  apac, …) or global. */
const PROFILE_PREFIX = /^(global|us-gov|us|eu|apac|au|ca|jp|in|uk|sa|mx|me|af|il)\./;

interface ProfileSummary { id: string; active: boolean }

/** Pure selection over ListFoundationModels + ListInferenceProfiles bodies.
 *  Keeps ACTIVE models with TEXT output that support Converse both sync and
 *  streaming (drops embeddings, speech and video-only models). Route per
 *  model: the plain id when it runs ON_DEMAND, else its global.* profile,
 *  else a regional profile (owner, 2026-11-06). Models with no route drop. */
export function selectBedrockModels(foundationBody: unknown, profiles: readonly ProfileSummary[]): BedrockModel[] {
	const summaries = isRecord(foundationBody) && Array.isArray(foundationBody.modelSummaries) ? foundationBody.modelSummaries : null;
	if (!summaries) throw new BedrockHttpError("Bedrock's response was not a model list");
	const activeProfiles = profiles.filter((p) => p.active).map((p) => p.id);
	const byId = new Map<string, BedrockModel>();
	for (const row of summaries) {
		if (!isRecord(row) || typeof row.modelId !== "string" || !row.modelId.trim()) continue;
		const lifecycle = isRecord(row.modelLifecycle) ? row.modelLifecycle.status : undefined;
		if (lifecycle !== undefined && lifecycle !== "ACTIVE") continue;
		const output = Array.isArray(row.outputModalities) ? row.outputModalities : [];
		if (!output.includes("TEXT")) continue;
		const apis = isRecord(row.inferenceAPIsSupported) ? row.inferenceAPIsSupported : undefined;
		const converse = apis && isRecord(apis.converse) ? apis.converse : undefined;
		if (converse ? converse.sync !== true || converse.streaming !== true : row.responseStreamingSupported !== true) continue;
		const modelId = row.modelId.trim();
		const types = Array.isArray(row.inferenceTypesSupported) ? row.inferenceTypesSupported : [];
		const matching = activeProfiles.filter((id) => id.replace(PROFILE_PREFIX, "") === modelId && PROFILE_PREFIX.test(id));
		const id = types.includes("ON_DEMAND")
			? modelId
			: matching.find((p) => p.startsWith("global.")) ?? matching.sort()[0];
		if (!id) continue;
		const model: BedrockModel = { id };
		if (typeof row.modelName === "string" && row.modelName.trim()) model.awsName = row.modelName.trim();
		const input = Array.isArray(row.inputModalities) ? row.inputModalities : [];
		if (input.includes("IMAGE")) model.image = true;
		const meta = isRecord(row.converse) ? row.converse.maxTokensMaximum : undefined;
		if (typeof meta === "number" && Number.isInteger(meta) && meta > 0) model.maxTokens = meta;
		const levels = reasoningEnum(isRecord(row.converse) ? row.converse.additionalRequestFieldsSchema : undefined);
		if (levels) model.reasoningLevels = levels;
		byId.set(id, model);
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The `reasoning_config` effort enum from AWS's Converse request-field
 *  schema (a JSON string), or undefined when it lists none. */
export function reasoningEnum(schema: unknown): string[] | undefined {
	let parsed: unknown = schema;
	if (typeof schema === "string") { try { parsed = JSON.parse(schema); } catch { return undefined; } }
	if (!isRecord(parsed) || !isRecord(parsed.reasoning_config)) return undefined;
	const values = parsed.reasoning_config.enum;
	if (!Array.isArray(values)) return undefined;
	const levels = values.filter((v): v is string => typeof v === "string" && /^[a-z]{1,16}$/.test(v));
	return levels.length ? levels : undefined;
}

/** Is a GetFoundationModelAvailability body fully available? */
export function availabilityConfirmed(body: unknown): boolean {
	if (!isRecord(body)) return false;
	const agreement = isRecord(body.agreementAvailability) ? body.agreementAvailability.status : undefined;
	return agreement === "AVAILABLE" && body.authorizationStatus === "AUTHORIZED"
		&& body.entitlementAvailability === "AVAILABLE" && body.regionAvailability === "AVAILABLE";
}

function controlPlane(region: string): string {
	return `https://bedrock.${region}.amazonaws.com`;
}

async function listProfiles(fetchImpl: FetchLike, region: string, key: string): Promise<ProfileSummary[]> {
	const out: ProfileSummary[] = [];
	let token: string | undefined;
	for (let page = 0; page < 20; page++) {
		const query = new URLSearchParams({ maxResults: "1000", typeEquals: "SYSTEM_DEFINED" });
		if (token) query.set("nextToken", token);
		const body = await getJson(fetchImpl, `${controlPlane(region)}/inference-profiles?${query}`, key, region);
		const rows = isRecord(body) && Array.isArray(body.inferenceProfileSummaries) ? body.inferenceProfileSummaries : [];
		for (const row of rows) {
			if (isRecord(row) && typeof row.inferenceProfileId === "string") out.push({ id: row.inferenceProfileId, active: row.status === "ACTIVE" });
		}
		token = isRecord(body) && typeof body.nextToken === "string" && body.nextToken ? body.nextToken : undefined;
		if (!token) break;
	}
	return out;
}

/** Discover the account's usable text models in `region`. A rejected key,
 *  unreachable region or unreadable list is an error (nothing is saved).
 *  Per-model availability checks never fail discovery: a failed check only
 *  leaves that model unconfirmed. */
export async function discoverBedrockModels(regionRaw: string, key: string, fetchImpl: FetchLike = fetch): Promise<BedrockDiscoverResult> {
	const region = normalizeBedrockRegion(regionRaw);
	if (!region) return { ok: false, error: "Enter an AWS region id such as eu-north-1" };
	try {
		const [foundation, profiles] = await Promise.all([
			getJson(fetchImpl, `${controlPlane(region)}/foundation-models`, key, region),
			listProfiles(fetchImpl, region, key),
		]);
		const models = selectBedrockModels(foundation, profiles);
		const queue = [...models];
		const worker = async () => {
			for (let model = queue.shift(); model; model = queue.shift()) {
				const base = model.id.replace(PROFILE_PREFIX, "");
				try {
					const body = await getJson(fetchImpl, `${controlPlane(region)}/foundation-model-availability/${encodeURIComponent(base)}`, key, region, 10_000);
					if (availabilityConfirmed(body)) model.accessConfirmed = true;
				} catch { /* unconfirmed, not fatal */ }
			}
		};
		await Promise.all(Array.from({ length: 8 }, worker));
		if (!models.length) return { ok: false, error: `No usable text models were found in ${region}` };
		return { ok: true, models };
	} catch (error) {
		if (error instanceof BedrockHttpError) return { ok: false, error: error.message, status: error.status };
		return { ok: false, error: "Bedrock discovery failed" };
	}
}

// ─── Metadata join + registration ────────────────────────────────────────────

const SUFFIX: Record<string, string> = {
	global: "Global", us: "US", eu: "EU", apac: "APAC", au: "AU", ca: "CA", jp: "JP", in: "India",
	"us-gov": "US GovCloud", uk: "UK", sa: "SA", mx: "MX", me: "ME", af: "AF", il: "IL",
};

/** "(Global)" for global.*, "(EU)" for eu.*, … ; "" for a plain id. */
function suffixFor(id: string): string {
	const prefix = id.match(PROFILE_PREFIX)?.[1];
	if (!prefix) return "";
	return ` (${SUFFIX[prefix] ?? prefix.toUpperCase()})`;
}

const stripSuffix = (name: string) => name.replace(/\s+\([^)]*\)$/, "");

function piCatalog(): Model<Api>[] {
	return Object.values(AMAZON_BEDROCK_MODELS) as Model<Api>[];
}

/** pi-ai's entry for this id, else for the same model under another prefix
 *  (the plain id first), renamed with this id's suffix. */
function knownEntry(id: string): Model<Api> | undefined {
	const catalog = piCatalog();
	const exact = catalog.find((m) => m.id === id);
	if (exact) return exact;
	const base = id.replace(PROFILE_PREFIX, "");
	const siblings = catalog.filter((m) => m.id.replace(PROFILE_PREFIX, "") === base);
	const sibling = siblings.find((m) => m.id === base) ?? siblings[0];
	return sibling ? { ...sibling, name: `${stripSuffix(sibling.name)}${suffixFor(id)}` } : undefined;
}

/** Reasoning for a model pi-ai's catalog does not know, from AWS's own
 *  `reasoning_config` effort enum. Only GPT ids (not gpt-oss): those are the
 *  ones pi's Converse adapter sends `reasoning.effort` for, so a level the
 *  picker offers is one the request carries. Others stay off. pi levels map
 *  1:1 onto AWS's effort names; minimal is not offered (GPT rejects it), and
 *  xhigh/max only when AWS lists them. */
function unknownReasoning(model: BedrockModel): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
	const levels = model.reasoningLevels ?? [];
	const base = model.id.replace(PROFILE_PREFIX, "");
	if (!/(^|\.)openai\.gpt-(?!oss)/.test(base) || !["low", "medium", "high"].some((l) => levels.includes(l))) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			minimal: null,
			low: levels.includes("low") ? "low" : null,
			medium: levels.includes("medium") ? "medium" : null,
			high: levels.includes("high") ? "high" : null,
			...(levels.includes("xhigh") ? { xhigh: "xhigh" } : {}),
			...(levels.includes("max") ? { max: "max" } : {}),
		},
	};
}

/** One discovered model as a pi-ai model: pi-ai's limits, reasoning, prices
 *  and name when it knows the model; otherwise AWS's image flag, max output
 *  and reasoning effort enum (see unknownReasoning), a 128k context, and an
 *  unknown price. */
export function toBedrockPiModel(model: BedrockModel, region: string): { model: Model<Api>; priceKnown: boolean } {
	const baseUrl = `https://bedrock-runtime.${region}.amazonaws.com`;
	const known = knownEntry(model.id);
	if (known) return { model: { ...known, id: model.id, provider: BEDROCK_PROVIDER.id, baseUrl }, priceKnown: true };
	return {
		priceKnown: false,
		model: {
			id: model.id,
			name: `${model.awsName ?? model.id.replace(PROFILE_PREFIX, "")}${suffixFor(model.id)}`,
			api: "bedrock-converse-stream",
			provider: BEDROCK_PROVIDER.id,
			baseUrl,
			...unknownReasoning(model),
			input: model.image ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: BEDROCK_UNKNOWN_CONTEXT_WINDOW,
			maxTokens: model.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
			type: "chat",
		},
	};
}

// HMR-stable: pricing reads this to show "unknown" instead of $0.
const unknownKey = Symbol.for("learnharness.bedrock-unknown-prices");
const globals = globalThis as typeof globalThis & { [unknownKey]?: Set<string> };
const unknownPrices = globals[unknownKey] ??= new Set<string>();

/** True when the registered Bedrock model has no pi-ai price data. */
export function bedrockPriceUnknown(id: string): boolean {
	return unknownPrices.has(id);
}

/** Build the configured Bedrock provider. The region rides per request as a
 *  scoped AWS_REGION, which outranks any ambient AWS_REGION. */
export function buildBedrockProvider(input: { region: string; models: readonly BedrockModel[]; key: string }): Provider<Api> {
	const mapped = input.models.map((m) => toBedrockPiModel(m, input.region));
	unknownPrices.clear();
	for (const { model, priceKnown } of mapped) if (!priceKnown) unknownPrices.add(model.id);
	return createProvider<Api>({
		id: BEDROCK_PROVIDER.id,
		name: BEDROCK_PROVIDER.label,
		auth: { apiKey: {
			name: "Bedrock API key",
			resolve: async () => ({ auth: { apiKey: input.key }, env: { AWS_REGION: input.region }, source: "Bedrock API key" }),
		} },
		models: mapped.map((m) => m.model),
		api: bedrockNativeStreams(),
	});
}

/** Install the Bedrock source: configured + key → the discovered provider;
 *  otherwise pi-ai's own entry (hidden from the picker, as before). */
export function installBedrockProviderSource(readAuth = bedrockAuthState): void {
	let fingerprint: string | undefined;
	configureProviderSource({
		isCustom: () => false,
		sync(models) {
			const bp = readSettings()?.bedrockProvider;
			const auth = readAuth();
			const ready = bedrockProviderConfigured(bp) && Boolean(auth.key) && Boolean(bp.models?.length);
			const next = JSON.stringify([bp ?? null, auth]); // in-memory only
			if (next === fingerprint) return;
			if (ready) models.setProvider(buildBedrockProvider({ region: bp.region, models: bp.models ?? [], key: auth.key! }));
			else {
				unknownPrices.clear();
				const native = nativeBedrockProvider();
				if (native) models.setProvider(native);
			}
			fingerprint = next;
		},
	}, "bedrock");
}

/** Is the user's Bedrock provider registered (configured, key present)? */
export function bedrockProviderAvailable(): boolean {
	const current = piModels().getProvider(BEDROCK_PROVIDER.id);
	return current !== undefined && current !== nativeBedrockProvider();
}

/** The editor's view of the stored snapshot: names joined from pi-ai. */
export function bedrockModelRows(bp: BedrockProviderSettings | undefined): { id: string; name: string; accessConfirmed: boolean }[] {
	if (!bedrockProviderConfigured(bp)) return [];
	return (bp.models ?? []).map((m) => ({ id: m.id, name: toBedrockPiModel(m, bp.region).model.name, accessConfirmed: m.accessConfirmed === true }));
}
