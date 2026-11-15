/** GET/POST/DELETE /api/azure-provider: the saved Azure OpenAI resources'
 * status, save (create, edit or refresh one) and removal. No key characters
 * ever reach a response. */
import { AZURE_PROVIDER, genericProviderKeyGuard } from "../core/auth-keys.ts";
import {
	AZURE_PRIMARY_ID,
	isAzureProviderId,
	newAzureProviderId,
	normalizeAzureEndpoint,
	normalizeAzureName,
	type AzureResourceSettings,
} from "../core/settings.ts";
import { readAzureFileKey, writeAzureFileKey } from "../store/auth.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { azureAuthState, azureModelRows, azureResources, discoverAzureModels } from "./azure-provider.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { authorized } from "./custom-provider-http.ts";
import { piModels } from "../agent/models.ts";

const failure = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** One resource in the editor's status payload. */
export interface AzureResourceStatus {
	id: string;
	name: string;
	endpoint: string;
	models: { id: string; name: string; model?: string }[];
	keyPresent: boolean;
	keySource: "env" | "file" | "none";
}

/** The editor's status payload: every saved resource, in save order.
 *  `saved` names the resource a POST just wrote. */
export function azureStatus(saved?: string): { resources: AzureResourceStatus[]; saved?: string } {
	const resources = azureResources().map((r) => {
		const auth = azureAuthState(r.id);
		return { id: r.id, name: r.name ?? "", endpoint: r.endpoint ?? "", models: azureModelRows(r), keyPresent: Boolean(auth.key), keySource: auth.source };
	});
	return saved ? { resources, saved } : { resources };
}

const ok = (saved?: string) => Response.json(azureStatus(saved), { headers: { "cache-control": "no-store" } });

export function azureProviderGet(): Response {
	return ok();
}

/** Key first, then config; a failed config write restores the old key.
 *  `resource` undefined removes the resource `id`; `key` null keeps the
 *  stored key, undefined deletes it. */
function commit(id: string, resource: AzureResourceSettings | undefined, key: string | undefined | null): void {
	const oldKey = key === null ? undefined : readAzureFileKey(id);
	let wroteKey = false;
	try {
		if (key !== null) { writeAzureFileKey(id, key); wroteKey = true; }
		const current = readSettings() ?? { version: 1 };
		const list = current.azureProviders ?? [];
		const index = list.findIndex((r) => r.id === id);
		const next = resource
			? index === -1 ? [...list, resource] : list.map((r, i) => i === index ? resource : r)
			: list.filter((r) => r.id !== id);
		const { azureProviders: _old, ...rest } = current;
		writeSettings(next.length ? { ...rest, azureProviders: next } : rest);
	} catch {
		if (wroteKey) { try { writeAzureFileKey(id, oldKey); } catch { /* best effort */ } }
		throw new Error("save failed");
	}
	piModels();
}

/** POST {id?, name?, endpoint, key?}: without an id, a new resource (key
 *  required); with one, that resource's edit or refresh (a missing key
 *  reuses the stored one). Discovery runs first; any failure stores
 *  nothing. DELETE {id}: drop that resource's key and configuration
 *  (no id = the first resource, the single-resource API's behavior). */
export async function azureProviderMutation(request: Request): Promise<Response> {
	if (!authorized(request)) return failure("Azure configuration requires a trusted same-origin request.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure("JSON content-type is required.", 415);
	try {
		const body = await readBoundedJson(request, 16 * 1024, request.method === "DELETE");
		if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid JSON body.");
		const raw = body as Record<string, unknown>;
		if (raw.id !== undefined && !isAzureProviderId(raw.id)) return failure("Unknown Azure resource.", 404);
		const existing = raw.id === undefined ? undefined : azureResources().find((r) => r.id === raw.id);
		if (request.method === "DELETE") {
			const id = (raw.id as string | undefined) ?? AZURE_PRIMARY_ID;
			if (!azureAuthState(id).readable) return failure("The key store is unreadable. No changes were saved.", 500);
			commit(id, undefined, undefined);
			return ok();
		}
		if (request.method !== "POST") return failure("Unsupported method", 405);
		if (raw.id !== undefined && !existing) return failure("Unknown Azure resource.", 404);
		const endpoint = normalizeAzureEndpoint(raw.endpoint);
		if (!endpoint) return failure("Enter an https endpoint URL, such as https://<resource>.openai.azure.com/openai/v1.");
		if (raw.name !== undefined && typeof raw.name !== "string") return failure("The name must be a string.");
		if (raw.key !== undefined && typeof raw.key !== "string") return failure("The API key must be a string.");
		const name = raw.name === undefined ? existing?.name ?? "" : normalizeAzureName(raw.name);
		const id = existing?.id ?? newAzureProviderId(name, new Set(azureResources().map((r) => r.id)));
		const auth = azureAuthState(id);
		if (!auth.readable) return failure("The key store is unreadable. No changes were saved.", 500);
		const supplied = typeof raw.key === "string" && raw.key.trim() ? raw.key.trim() : undefined;
		if (supplied && auth.source === "env") return failure(`The environment supplies this Azure key (${AZURE_PROVIDER.envVar}). Change it there.`);
		if (supplied) {
			const shape = genericProviderKeyGuard("The Azure API key", supplied);
			if (!shape.ok) return failure(`${shape.error}.`);
		}
		// A new resource never inherits a key left behind under its id.
		const key = auth.source === "env" ? auth.key : supplied ?? (existing ? auth.key : undefined);
		if (!key) return failure("Enter your Azure API key.");
		const found = await discoverAzureModels(endpoint, key);
		if (!found.ok) return failure(`${found.error}.`, 502);
		commit(id, { id, ...(name ? { name } : {}), endpoint, models: found.models }, supplied ?? null);
		return ok(id);
	} catch (error) {
		if (error instanceof CustomBodyLimitError) return failure("Request body is too large.", 413);
		if (error instanceof SyntaxError) return failure("Invalid JSON body.");
		return failure("Unable to save the Azure configuration.", 500);
	}
}
