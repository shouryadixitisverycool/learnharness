import { cursorInstallationResponse } from "@/src/server";

/** Installation, version and sign-in state; never makes a model request. */
export async function GET(request: Request) {
	return cursorInstallationResponse(request);
}
