"use client";
/**
 * composeSlotModel — the one write seam for a model slot's override,
 * shared by the Agent settings section and the composer's model picker.
 * Lives in its own module (perf split, 2026-11-06): the model picker is
 * in the every-chat-route bundle, and importing this from agent-section
 * pulled the ENTIRE settings Agent section (menus, catalog UI) into that
 * first-paint payload. agent-section re-exports it, so existing
 * importers keep working.
 */

import type { ModelsSettings, ModelSlotName } from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Compose: one slot's model/thinking override. Empty model = absent
 *  override (Default — falls to the factory pin); empty thinking = the
 *  tier keeps its resolved thinking budget. Per-field independence, same
 *  as the schema's ModelSlot. Pure — exported for tests. */
export function composeSlotModel(
	models: ModelsSettings | undefined,
	slot: ModelSlotName,
	provider: string,
	id: string,
	thinking: string,
): ModelsSettings {
	const prev = models?.[slot];
	const next = { ...models };
	if (!provider && !id && !thinking) {
		delete next[slot];
		return next;
	}
	next[slot] = {
		...(prev?.cacheRetention !== undefined ? { cacheRetention: prev.cacheRetention } : {}),
		...(provider && id ? { model: { provider, id } } : prev?.model ? { model: prev.model } : {}),
		...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
	};
	return next;
}
