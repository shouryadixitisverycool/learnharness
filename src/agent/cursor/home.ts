import { randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readlink, rename, rm, symlink, writeFile, chmod } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { PATHS } from "../../../config.ts";
import { externalCliEnv } from "../../core/auth-env.ts";

/**
 * The CLI never runs with the user's real HOME. A real ~/.cursor/cli-config.json
 * can allowlist shell commands, and `-p` mode honours that list. LearnHarness
 * gives the CLI its own HOME instead, holding only:
 *   .cursor/cli-config.json          the permission lists, rewritten before every run (the CLI rewrites it too)
 *   .cursor/hooks.json               a fail-closed preToolUse hook that runs the guard below
 *   .cursor/learnharness-guard.mjs   the guard: denies every tool but this run's LearnHarness MCP tools
 *   .config/cursor                   a symlink to the real auth dir, so token refreshes persist
 *
 * Two layers, because neither is enough alone. The sandbox cannot start everywhere
 * (AppArmor blocks its user namespaces), so runs use --sandbox disabled. The
 * permission lists stop shell, read, write and web calls, but in cursor-agent
 * 2026.08.25 the built-in grep and glob tools ignore them and read any file the
 * server user can read. The hook sees every tool call, grep and glob included.
 * MCP calls carry no server name in the hook, so the allow list still limits them
 * to the learnharness server (the user's Cursor account can add plugin servers).
 */
export const CURSOR_CLI_CONFIG = Object.freeze({
	version: 1,
	approvalMode: "allowlist",
	sandbox: Object.freeze({ mode: "disabled" }),
	permissions: Object.freeze({
		allow: Object.freeze(["Mcp(learnharness:*)"]),
		deny: Object.freeze(["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)", "WebSearch(*)"]),
	}),
});

/** Written into each run's workspace: the bare names of the MCP tools the guard lets through. */
export const TOOL_LIST_FILE = "learnharness-tools.json";

export const GUARD_FILE = "learnharness-guard.mjs";

/** The preToolUse hook. Anything it cannot read or does not recognise is denied.
 * `{}` is no decision: the call still has to pass the permission allow list. */
export const GUARD_SCRIPT = `// Written by LearnHarness before every cursor-agent run. Do not edit: it is replaced.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DENY = { permission: "deny", user_message: "Blocked by LearnHarness: the tutor can only use LearnHarness tools." };
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	let decision = DENY;
	try {
		const request = JSON.parse(input);
		const tool = typeof request.tool_name === "string" && request.tool_name.startsWith("MCP:") ? request.tool_name.slice(4) : null;
		const roots = request.workspace_roots;
		if (request.hook_event_name === "preToolUse" && tool && Array.isArray(roots) && roots.length === 1 && typeof roots[0] === "string") {
			const allowed = JSON.parse(readFileSync(join(roots[0], ".cursor", ${JSON.stringify(TOOL_LIST_FILE)}), "utf8"));
			if (Array.isArray(allowed) && allowed.includes(tool)) decision = {};
		}
	} catch {}
	process.stdout.write(JSON.stringify(decision));
});
`;

/** Single-quoted for the shell the CLI runs hook commands with. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function toHooksConfig(node: string, guard: string): object {
	return { version: 1, hooks: { preToolUse: [{ command: `${shellQuote(node)} ${shellQuote(guard)}`, failClosed: true }] } };
}

function isExecutable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The guard runs on the CLI's own bundled Node when the install has one (the official
 * installer does), else on the server's. Under Electron the server's binary needs
 * ELECTRON_RUN_AS_NODE, which cursorEnv sets. */
export function guardNode(binary: string | null): string {
	if (binary) {
		try {
			const bundled = path.join(path.dirname(realpathSync(binary)), "node");
			if (isExecutable(bundled)) return bundled;
		} catch {
			// Fall through to the server's own runtime.
		}
	}
	return process.execPath;
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type CursorHome = { home: string; authDir: string };

export function cursorHome(env: Record<string, string | undefined> = process.env, homeDir = os.homedir()): CursorHome {
	const authDir = env.LH_CURSOR_CONFIG_DIR?.trim() || path.join(homeDir, ".config", "cursor");
	// The auth dir is a symlink target, never read at build time: keep it out of output tracing.
	return { home: path.join(PATHS.data, "cursor-home"), authDir: path.resolve(/*turbopackIgnore: true*/ authDir) };
}

async function privateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	await chmod(dir, PRIVATE_DIR_MODE);
}

async function linkAuthDir(link: string, target: string): Promise<void> {
	try {
		const stat = await lstat(link);
		if (stat.isSymbolicLink() && await readlink(link) === target) return;
		await rm(link, { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await symlink(target, link, "dir");
}

/** Replace, never edit in place: a concurrent run may be reading the file. */
async function replaceFile(file: string, contents: string): Promise<void> {
	const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, contents, { mode: PRIVATE_FILE_MODE });
	await rename(temporary, file);
}

/** Creates the isolated HOME and rewrites the lockdown files. Run before every CLI call. */
export async function prepareCursorHome({ home, authDir }: CursorHome = cursorHome(), node: string = guardNode(null)): Promise<void> {
	const cursorDir = path.join(home, ".cursor");
	await privateDir(home);
	await privateDir(cursorDir);
	await privateDir(path.join(home, ".config"));
	await linkAuthDir(path.join(home, ".config", "cursor"), authDir);

	const guard = path.join(cursorDir, GUARD_FILE);
	await replaceFile(guard, GUARD_SCRIPT);
	await replaceFile(path.join(cursorDir, "hooks.json"), `${JSON.stringify(toHooksConfig(node, guard), null, 2)}\n`);
	await replaceFile(path.join(cursorDir, "cli-config.json"), `${JSON.stringify(CURSOR_CLI_CONFIG, null, 2)}\n`);
}

// Only what the CLI needs to run and reach Cursor. Everything else, including
// LearnHarness's own keys and the XDG_* dirs that would move the CLI's config
// away from the isolated HOME, stays out.
const PASSED_ENV = [
	"PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
	// Cursor's own authentication and routing, when the operator set them.
	"CURSOR_API_KEY", "CURSOR_API_ENDPOINT",
];

export function cursorEnv(home: string, env: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
	const external = externalCliEnv(env as NodeJS.ProcessEnv);
	const result: Record<string, string> = {};
	for (const name of PASSED_ENV) {
		const value = external[name];
		if (value !== undefined) result[name] = value;
	}
	// The guard may run on the server's own binary; under Electron that needs node mode.
	if (process.versions.electron) result.ELECTRON_RUN_AS_NODE = "1";
	// A fixed NODE_ENV: the server's own build mode is not the CLI's business.
	return { ...result, NODE_ENV: "production", HOME: home, USERPROFILE: home, NO_OPEN_BROWSER: "1" };
}
