import { spawn } from "node:child_process";
import { statSync } from "node:fs";

import { CURSOR_MINIMUM_VERSION } from "../../core/contracts/cursor.ts";
import { getCursorBinary } from "./binary.ts";
import { cursorHome, guardNode, prepareCursorHome } from "./home.ts";
import { checkCursorVersion, readCursorOutput, type CursorVersionCheck, type ReadCursorOutput } from "./installation.ts";
import { sweepStaleRuns } from "./workspace.ts";
import type { RunCursor } from "./stream.ts";

export class CursorLaunchError extends Error {}

/** `--version` costs most of a second, so a passing check is remembered per binary
 * file (path, size and mtime). An in-place update changes the key and is checked again. */
function versionKey(binary: string): string {
	try {
		const stat = statSync(binary);
		return `${binary}\0${stat.size}\0${stat.mtimeMs}`;
	} catch {
		return binary;
	}
}

/** Injectable seams keep all verification offline; production uses the installed CLI. */
export function createCursorLauncher({
	findBinary = getCursorBinary,
	read = readCursorOutput,
	spawnProcess = spawn,
	prepareHome = (binary) => prepareCursorHome(cursorHome(), guardNode(binary)),
	sweep = () => sweepStaleRuns(cursorHome().home),
}: {
	findBinary?: () => string | null;
	read?: ReadCursorOutput;
	spawnProcess?: typeof spawn;
	prepareHome?: (binary: string) => Promise<void>;
	sweep?: () => Promise<void>;
} = {}): RunCursor {
	const verified = new Set<string>();
	let swept = false;
	return async (args, options) => {
		if (options.signal?.aborted) throw new CursorLaunchError("Request was aborted");
		const binary = findBinary();
		if (!binary) return null;
		const key = versionKey(binary);
		if (!verified.has(key)) {
			const status: CursorVersionCheck = await checkCursorVersion(binary, read);
			if (status.state === "update-required") {
				throw new CursorLaunchError(`cursor-agent ${status.version} is too old. LearnHarness requires ${CURSOR_MINIMUM_VERSION} or later; run \`cursor-agent update\` on the server.`);
			}
			if (status.state !== "meets-minimum") {
				throw new CursorLaunchError("cursor-agent's version could not be checked. Check the installation outside LearnHarness and try again.");
			}
			verified.add(key);
		}
		// The CLI rewrites its config on every run; restore the lockdown files first.
		await prepareHome(binary);
		if (!swept) {
			swept = true;
			sweep().catch((error: unknown) => console.error("cursor-agent stale run cleanup failed:", error));
		}
		if (options.signal?.aborted) throw new CursorLaunchError("Request was aborted");
		// detached: its own session, so the CLI never reaches the server's terminal.
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe", detached: true });
	};
}
