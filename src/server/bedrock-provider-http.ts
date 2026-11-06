/** GET/POST/DELETE /api/bedrock-provider: Amazon Bedrock's status, save
 * (or refresh) and removal. No key characters ever reach a response. */
import { BEDROCK_PROVIDER, genericProviderKeyGuard } from "../core/auth-keys.ts";
import { normalizeBedrockRegion, type BedrockProviderSettings } from "../core/settings.ts";
import { readBedrockFileKey, writeBedrockFileKey } from "../store/auth.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { bedrockAuthState, bedrockModelRows, discoverBedrockModels } from "./bedrock-provider.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { authorized } from "./custom-provider-http.ts";
import { piModels } from "../agent/models.ts";

const failure = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** The editor's status payload. */
export function bedrockStatus() {
	const bp = readSettings()?.bedrockProvider;
	const auth = bedrockAuthState();
	return {
		region: bp?.region ?? "",
		models: bedrockModelRows(bp),
		keyPresent: Boolean(auth.key),
		keySource: auth.source,
	};
}

export function bedrockProviderGet(): Response {
	return Response.json(bedrockStatus(), { headers: { "cache-control": "no-store" } });
}

/** Key first, then config; a failed config write restores the old key. */
function commit(bp: BedrockProviderSettings | undefined, key: string | undefined | null): void {
	const oldKey = key === null ? undefined : readBedrockFileKey();
	let wroteKey = false;
	try {
		if (key !== null) { writeBedrockFileKey(key); wroteKey = true; }
		const { bedrockProvider: _old, ...rest } = readSettings() ?? { version: 1 };
		writeSettings(bp ? { ...rest, bedrockProvider: bp } : rest);
	} catch {
		if (wroteKey) { try { writeBedrockFileKey(oldKey); } catch { /* best effort */ } }
		throw new Error("save failed");
	}
	piModels();
}

/** POST {region, key?}: discover with the supplied key (or the effective
 *  stored one), then store key + region + models. Any discovery failure
 *  stores nothing. DELETE: drop the file key and the configuration. */
export async function bedrockProviderMutation(request: Request): Promise<Response> {
	if (!authorized(request)) return failure("Bedrock configuration requires a trusted same-origin request.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure("JSON content-type is required.", 415);
	try {
		const body = await readBoundedJson(request, 16 * 1024, request.method === "DELETE");
		if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid JSON body.");
		const raw = body as Record<string, unknown>;
		const auth = bedrockAuthState();
		if (!auth.readable) return failure("The key store is unreadable. No changes were saved.", 500);
		if (request.method === "DELETE") {
			commit(undefined, undefined);
			return Response.json(bedrockStatus(), { headers: { "cache-control": "no-store" } });
		}
		if (request.method !== "POST") return failure("Unsupported method", 405);
		const region = normalizeBedrockRegion(raw.region);
		if (!region) return failure("Enter an AWS region id such as eu-north-1.");
		if (raw.key !== undefined && typeof raw.key !== "string") return failure("The API key must be a string.");
		const supplied = typeof raw.key === "string" && raw.key.trim() ? raw.key.trim() : undefined;
		if (supplied && auth.source === "env") return failure(`The environment supplies the Bedrock key (${BEDROCK_PROVIDER.envVar}). Change it there.`);
		if (supplied) {
			const shape = genericProviderKeyGuard("The Bedrock API key", supplied);
			if (!shape.ok) return failure(`${shape.error}.`);
		}
		const key = auth.source === "env" ? auth.key : supplied ?? auth.key;
		if (!key) return failure("Enter your Bedrock API key.");
		const found = await discoverBedrockModels(region, key);
		if (!found.ok) return failure(`${found.error}.`, 502);
		commit({ region, models: found.models }, supplied ?? null);
		return Response.json(bedrockStatus(), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return failure("Request body is too large.", 413);
		if (error instanceof SyntaxError) return failure("Invalid JSON body.");
		return failure("Unable to save the Bedrock configuration.", 500);
	}
}
