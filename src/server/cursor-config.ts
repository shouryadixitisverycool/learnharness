import { getCursorBinary } from "../agent/cursor/binary.ts";
import { settingsStore } from "../store/settings.ts";

/** Fresh admission state, not a process-wide cache. Existing runs keep
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function cursorEnabled(): boolean {
	return settingsStore.readSettings()?.cursor?.enabled === true;
}

/** Opt-in and installation only, never a sign-in verdict (that costs a CLI call). */
export function cursorAvailable(): boolean {
	return cursorEnabled() && getCursorBinary() !== null;
}
