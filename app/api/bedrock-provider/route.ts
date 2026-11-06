/** Amazon Bedrock (API key + region): status, save/refresh, removal. */
import { announceSettingsChanged, bedrockProviderGet, bedrockProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = bedrockProviderGet;
/** A saved Bedrock configuration changes every device's model catalog. */
async function mutation(request: Request): Promise<Response> {
	const response = await bedrockProviderMutation(request);
	if (response.ok) announceSettingsChanged("keys");
	return response;
}

export const POST = mutation;
export const DELETE = mutation;
