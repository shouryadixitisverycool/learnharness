/** Azure OpenAI (endpoint + API key): status, save/refresh, removal. */
import { announceSettingsChanged, azureProviderGet, azureProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = azureProviderGet;
/** A saved Azure configuration changes every device's model catalog. */
async function mutation(request: Request): Promise<Response> {
	const response = await azureProviderMutation(request);
	if (response.ok) announceSettingsChanged("keys");
	return response;
}

export const POST = mutation;
export const DELETE = mutation;
