"use client";
/**
 * The palette the app is rendering — the auto-invert switch reads it.
 * This is the appearance context's resolved mode: Dark, Light, or System
 * resolved against the OS (components/settings/appearance.tsx).
 */
import { useAppearance } from "@/components/settings/appearance";
import type { RenderedMode } from "@/src/core";

export function useRenderedMode(): RenderedMode {
	return useAppearance().resolvedMode;
}
