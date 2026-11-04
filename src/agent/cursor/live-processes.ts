export type LiveProcess = {
	readonly owner: symbol;
	readonly sessionId: string | undefined;
	toolCallIds: string[];
	/** Called when pi never sent the held calls' results in time. */
	expire(): void;
};

// cursor-agent gives every MCP request 60 s (the MCP SDK default; no flag or
// config changes it), then reports "Request timed out" and the model may retry.
// A held call is answered with a placeholder before that, the process is
// killed, and the next stream() call replays the conversation instead.
export const HELD_CALL_TIMEOUT_MS = 50_000;

/** Test seam (runner.ts's pdfModelOverride idiom). */
export const heldCallTimeoutMs = { current: HELD_CALL_TIMEOUT_MS };

const liveProcesses = new Map<LiveProcess, NodeJS.Timeout>();

export function addLiveProcess(process: LiveProcess): void {
	removeLiveProcess(process);
	const timer = setTimeout(() => {
		removeLiveProcess(process);
		process.expire();
	}, heldCallTimeoutMs.current);
	timer.unref();
	liveProcesses.set(process, timer);
}

function hasSameIds(ids: string[], otherIds: string[]): boolean {
	return ids.length === otherIds.length && new Set(otherIds).size === otherIds.length && ids.every((id) => otherIds.includes(id));
}

export function getLiveProcess(toolCallIds: string[], owner: symbol, sessionId: string | undefined): LiveProcess | null {
	if (!sessionId || toolCallIds.length === 0) return null;
	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && hasSameIds(process.toolCallIds, toolCallIds)) return process;
	}
	return null;
}

export function removeLiveProcess(process: LiveProcess): void {
	clearTimeout(liveProcesses.get(process));
	liveProcesses.delete(process);
}
