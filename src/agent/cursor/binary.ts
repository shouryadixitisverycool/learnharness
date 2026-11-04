import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type BinaryLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	cwd?: string;
	isExecutable: (path: string) => boolean;
};

/** LH_CURSOR_AGENT_PATH wins (a Docker bind mount or a non-standard install).
 * Otherwise `cursor-agent` on PATH, then the official installer's ~/.local/bin. */
export function resolveCursorBinary({ env, platform, homeDir, cwd = process.cwd(), isExecutable }: BinaryLookup): string | null {
	const paths = platform === "win32" ? path.win32 : path.posix;
	const configured = env.LH_CURSOR_AGENT_PATH?.trim();
	if (configured) {
		const candidate = paths.resolve(cwd, configured);
		return isExecutable(candidate) ? candidate : null;
	}

	// Direct spawn uses no shell, so a .cmd shim is not runnable.
	const name = platform === "win32" ? "cursor-agent.exe" : "cursor-agent";
	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);
	for (const dir of [...pathDirs, paths.join(homeDir, ".local", "bin")]) {
		const candidate = paths.resolve(cwd, dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function getCursorBinary(): string | null {
	return resolveCursorBinary({
		env: process.env,
		platform: process.platform,
		homeDir: os.homedir(),
		isExecutable: isExecutableFile,
	});
}
