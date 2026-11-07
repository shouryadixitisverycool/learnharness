"use client";

/**
 * THE SHARED SETTINGS RECORD READ (perf wave, 2026-11-06): three separate
 * components each fired their own GET /api/settings at mount (the
 * appearance provider, the composer model pill, the extraction-coverage
 * ring) — three identical requests in the same second, on every page.
 * This module is the single flight: first caller fetches, concurrent
 * callers share the promise, later callers in the same page lifetime
 * read the cached reply.
 *
 * Freshness contract — identical to the per-component fetches it
 * replaces: every app writer lands notifySettingsSaved after a
 * successful PUT (and the events channel forwards other windows' writes
 * through the same signal), which clears this cache, so the next read
 * re-fetches. A failed read is never cached: the next caller retries,
 * exactly like the old per-mount fetch. Same stale-while-revalidate
 * doctrine as model-catalog.ts.
 */

import type { UserSettings } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";

export interface SettingsRecordReply {
	settings: UserSettings | null;
	fileAccessError?: string;
}

let cache: SettingsRecordReply | undefined;
let inflight: Promise<SettingsRecordReply | null> | undefined;
let generation = 0;
let invalidationArmed = false;

function armInvalidation(): void {
	if (invalidationArmed || typeof window === "undefined") return;
	invalidationArmed = true;
	onSettingsSaved(() => {
		// Bump the generation so a read that was IN FLIGHT while the write
		// landed never populates the cache with pre-write data.
		generation++;
		cache = undefined;
		inflight = undefined;
	});
}

/** Test seam: drop the cache/inflight so each stubbed fetch is observed
 *  (the module cache is page-lifetime by design). */
export function resetSettingsRecordForTest(): void {
	cache = undefined;
	inflight = undefined;
	generation++;
}

/** One shared read of GET /api/settings. Resolves null on a non-200 or
 *  transport failure (callers keep their existing failure postures). */
export function getSettingsRecord(): Promise<SettingsRecordReply | null> {
	armInvalidation();
	if (cache) return Promise.resolve(cache);
	if (inflight) return inflight;
	const gen = generation;
	inflight = fetch("/api/settings")
		.then((r) => (r.ok ? (r.json() as Promise<SettingsRecordReply>) : null))
		.then((body) => {
			if (body && gen === generation) cache = body;
			return body;
		})
		.catch(() => null)
		.finally(() => {
			if (gen === generation) inflight = undefined;
		});
	return inflight;
}
