import { CLAUDE_CODE_PROVIDER } from "./claude-code.ts";

export const CURSOR_PROVIDER = "cursor";

/** Installation, version and sign-in state only. Never an account, quota, or billing verdict. */
export interface CursorStatus {
	state: "not-found" | "signed-in" | "signed-out" | "update-required" | "unchecked";
	version: string | null;
	minimumVersion: string;
}

// The release the provider was built and verified against (stream-json shapes,
// cli-config.json permissions, rules files). Versions are YYYY.MM.DD-<build>.
export const CURSOR_MINIMUM_VERSION = "2026.08.25";

/** Providers whose CLI owns routing and billing: LearnHarness never prices their turns. */
export function isCliProvider(provider: string): boolean {
	return provider === CLAUDE_CODE_PROVIDER || provider === CURSOR_PROVIDER;
}

/** The same check for a qualified `provider:id` model string. */
export function isCliModel(model: string | undefined): boolean {
	return !!model && model.includes(":") && isCliProvider(model.slice(0, model.indexOf(":")));
}
