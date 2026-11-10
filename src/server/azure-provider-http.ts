/** GET/POST/DELETE /api/azure-provider: Azure OpenAI's status, save (or
 * refresh) and removal. No key characters ever reach a response. */
import { AZURE_PROVIDER, genericProviderKeyGuard } from "../core/auth-keys.ts";
import { normalizeAzureEndpoint, type AzureProviderSettings } from "../core/settings.ts";
import { readAzureFileKey, writeAzureFileKey } from "../store/auth.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { azureAuthState, azureModelRows, discoverAzureModels } from "./azure-provider.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { authorized } from "./custom-provider-http.ts";
import { piModels } from "../agent/models.ts";

const failure = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** The editor's status payload. */
export function azureStatus() {
	const ap = readSettings()?.azureProvider;
	const auth = azureAuthState();
	return {
		endpoint: ap?.endpoint ?? "",
		models: azureModelRows(ap),
		keyPresent: Boolean(auth.key),
		keySource: auth.source,
	};
}

export function azureProviderGet(): Response {
	return Response.json(azureStatus(), { headers: { "cache-control": "no-store" } });
}

/** Key first, then config; a failed config write restores the old key. */
function commit(ap: AzureProviderSettings | undefined, key: string | undefined | null): void {
	const oldKey = key === null ? undefined : readAzureFileKey();
	let wroteKey = false;
	try {
		if (key !== null) { writeAzureFileKey(key); wroteKey = true; }
		const { azureProvider: _old, ...rest } = readSettings() ?? { version: 1 };
		writeSettings(ap ? { ...rest, azureProvider: ap } : rest);
	} catch {
		if (wroteKey) { try { writeAzureFileKey(oldKey); } catch { /* best effort */ } }
		throw new Error("save failed");
	}
	piModels();
}

/** POST {endpoint, key?}: discover with the supplied key (or the effective
 *  stored one), then store key + endpoint + deployments. Any discovery
 *  failure stores nothing. DELETE: drop the file key and the configuration. */
export async function azureProviderMutation(request: Request): Promise<Response> {
	if (!authorized(request)) return failure("Azure configuration requires a trusted same-origin request.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure("JSON content-type is required.", 415);
	try {
		const body = await readBoundedJson(request, 16 * 1024, request.method === "DELETE");
		if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid JSON body.");
		const raw = body as Record<string, unknown>;
		const auth = azureAuthState();
		if (!auth.readable) return failure("The key store is unreadable. No changes were saved.", 500);
		if (request.method === "DELETE") {
			commit(undefined, undefined);
			return Response.json(azureStatus(), { headers: { "cache-control": "no-store" } });
		}
		if (request.method !== "POST") return failure("Unsupported method", 405);
		const endpoint = normalizeAzureEndpoint(raw.endpoint);
		if (!endpoint) return failure("Enter an https endpoint URL, such as https://<resource>.openai.azure.com/openai/v1.");
		if (raw.key !== undefined && typeof raw.key !== "string") return failure("The API key must be a string.");
		const supplied = typeof raw.key === "string" && raw.key.trim() ? raw.key.trim() : undefined;
		if (supplied && auth.source === "env") return failure(`The environment supplies the Azure key (${AZURE_PROVIDER.envVar}). Change it there.`);
		if (supplied) {
			const shape = genericProviderKeyGuard("The Azure API key", supplied);
			if (!shape.ok) return failure(`${shape.error}.`);
		}
		const key = auth.source === "env" ? auth.key : supplied ?? auth.key;
		if (!key) return failure("Enter your Azure API key.");
		const found = await discoverAzureModels(endpoint, key);
		if (!found.ok) return failure(`${found.error}.`, 502);
		commit({ endpoint, models: found.models }, supplied ?? null);
		return Response.json(azureStatus(), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return failure("Request body is too large.", 413);
		if (error instanceof SyntaxError) return failure("Invalid JSON body.");
		return failure("Unable to save the Azure configuration.", 500);
	}
}
