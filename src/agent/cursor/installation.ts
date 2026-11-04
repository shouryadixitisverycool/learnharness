import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

import { CURSOR_MINIMUM_VERSION, type CursorStatus } from "../../core/contracts/cursor.ts";
import { getCursorBinary } from "./binary.ts";
import { cursorEnv, cursorHome, guardNode, prepareCursorHome } from "./home.ts";

export type ReadCursorOutput = (binary: string, args: string[]) => Promise<string>;

/** No shell. Always the isolated HOME, so the user's own Cursor config never loads. */
export const readCursorOutput: ReadCursorOutput = async (binary, args) => {
	const location = cursorHome();
	await prepareCursorHome(location, guardNode(binary));
	return new Promise((resolve, reject) => {
		execFile(binary, args, {
			cwd: tmpdir(), env: cursorEnv(location.home), windowsHide: true,
			timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 16_384,
		}, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
};

/** `2026.08.25-3e8eec8` → its date and build parts, or null. */
export function parseCursorVersion(output: string): { version: string; date: number[] } | null {
	const match = /^(\d{4})\.(\d{2})\.(\d{2})-([0-9a-f]{4,40})$/.exec(output.trim());
	if (!match) return null;
	return { version: match[0], date: match.slice(1, 4).map(Number) };
}

function meetsMinimum(date: number[]): boolean {
	const minimum = CURSOR_MINIMUM_VERSION.split(".").map(Number);
	const differing = date.findIndex((part, index) => part !== minimum[index]);
	return differing === -1 || date[differing]! > minimum[differing]!;
}

export type CursorVersionCheck = { state: "meets-minimum" | "update-required" | "unchecked"; version: string | null };

export async function checkCursorVersion(binary: string, read: ReadCursorOutput = readCursorOutput): Promise<CursorVersionCheck> {
	try {
		const parsed = parseCursorVersion(await read(binary, ["--version"]));
		if (!parsed) return { state: "unchecked", version: null };
		return { state: meetsMinimum(parsed.date) ? "meets-minimum" : "update-required", version: parsed.version };
	} catch {
		return { state: "unchecked", version: null };
	}
}

/** Reads only the boolean: never the email, user id, or any token field. */
export async function readCursorSignedIn(binary: string, read: ReadCursorOutput = readCursorOutput): Promise<boolean | null> {
	try {
		const parsed: unknown = JSON.parse(await read(binary, ["status", "--format", "json"]));
		if (!parsed || typeof parsed !== "object" || !("isAuthenticated" in parsed)) return null;
		return typeof parsed.isAuthenticated === "boolean" ? parsed.isAuthenticated : null;
	} catch {
		return null;
	}
}

export async function inspectCursorInstallation(
	findBinary: () => string | null = getCursorBinary,
	read: ReadCursorOutput = readCursorOutput,
): Promise<CursorStatus> {
	const base = { version: null, minimumVersion: CURSOR_MINIMUM_VERSION };
	const binary = findBinary();
	if (!binary) return { ...base, state: "not-found" };
	const version = await checkCursorVersion(binary, read);
	if (version.state === "update-required") return { ...base, version: version.version, state: "update-required" };
	if (version.state === "unchecked") return { ...base, state: "unchecked" };
	const signedIn = await readCursorSignedIn(binary, read);
	return { ...base, version: version.version, state: signedIn === true ? "signed-in" : signedIn === false ? "signed-out" : "unchecked" };
}
