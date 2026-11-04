import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction, type ThinkingLevel } from "@earendil-works/pi-ai";

import { CURSOR_API, CURSOR_PROVIDER } from "./constants.ts";

const SHARED_MODEL_FIELDS = {
	api: CURSOR_API,
	provider: CURSOR_PROVIDER,
	baseUrl: "",
	input: ["text"],
	// Pi-required placeholders, not prices: the Cursor subscription pays for
	// these runs. Server pricing and the client catalog report them unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	// Cursor sells Grok 4.7 at four efforts and has no thinking-off variant.
	// Low is the floor; xhigh is the ceiling.
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
	contextWindow: 256_000,
	maxTokens: 64_000,
} satisfies Omit<Model<Api>, "id" | "name">;

export const CURSOR_MODELS: readonly Model<Api>[] = [
	{ ...SHARED_MODEL_FIELDS, id: "grok-4.7-fast", name: "Grok 4.7 Fast" },
	{ ...SHARED_MODEL_FIELDS, id: "grok-4.7", name: "Grok 4.7" },
];

const EFFORTS: Record<ThinkingLevel, "low" | "medium" | "high" | "xhigh"> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "xhigh",
};

/** The CLI's own model id: Cursor encodes effort and speed in the name,
 * e.g. grok-4.7-fast at medium is `grok-4.7-medium-fast`. Unset is thinking off,
 * which Cursor does not offer, so it runs at the low floor. */
export function toCursorModelId(modelId: string, level: ThinkingLevel | undefined): string {
	const effort = EFFORTS[level ?? "low"];
	const fast = modelId.endsWith("-fast");
	const base = fast ? modelId.slice(0, -"-fast".length) : modelId;
	return `${base}-${effort}${fast ? "-fast" : ""}`;
}

export function createCursorProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: CURSOR_PROVIDER,
		name: "Cursor",
		auth: { apiKey: { name: "Cursor CLI", resolve: async () => ({ auth: {}, source: "cursor-agent CLI" }) } },
		models: CURSOR_MODELS,
		api: { stream: streamSimple, streamSimple },
	});
}
