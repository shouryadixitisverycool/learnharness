/** cursor-agent discovery, version and sign-in checks (binary.ts, installation.ts, launch.ts). */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveCursorBinary } from "../src/agent/cursor/binary.ts";
import { checkCursorVersion, inspectCursorInstallation, parseCursorVersion, type ReadCursorOutput } from "../src/agent/cursor/installation.ts";
import { CursorLaunchError, createCursorLauncher } from "../src/agent/cursor/launch.ts";

const lookup = (env: Record<string, string>, executable: string[]) => resolveCursorBinary({
	env, platform: "linux", homeDir: "/home/u", cwd: "/srv", isExecutable: (path) => executable.includes(path),
});

test("binary: LH_CURSOR_AGENT_PATH wins, else PATH, else ~/.local/bin", () => {
	assert.equal(lookup({ LH_CURSOR_AGENT_PATH: "/opt/cursor/cursor-agent", PATH: "/usr/bin" }, ["/opt/cursor/cursor-agent", "/usr/bin/cursor-agent"]), "/opt/cursor/cursor-agent");
	assert.equal(lookup({ LH_CURSOR_AGENT_PATH: "/opt/missing" }, ["/usr/bin/cursor-agent"]), null, "a configured path that is not executable is not silently replaced");
	assert.equal(lookup({ PATH: "/usr/local/bin:/usr/bin" }, ["/usr/bin/cursor-agent"]), "/usr/bin/cursor-agent");
	assert.equal(lookup({ PATH: "/usr/bin" }, ["/home/u/.local/bin/cursor-agent"]), "/home/u/.local/bin/cursor-agent");
	assert.equal(lookup({ PATH: "/usr/bin" }, []), null);
});

test("version: YYYY.MM.DD-build, compared by date against the minimum", async () => {
	assert.deepEqual(parseCursorVersion("2026.08.25-3e8eec8\n"), { version: "2026.08.25-3e8eec8", date: [2026, 8, 25] });
	assert.equal(parseCursorVersion("Cursor Agent 1.2.3"), null);
	const read = (output: string): ReadCursorOutput => async () => output;
	assert.deepEqual(await checkCursorVersion("/x", read("2026.09.01-abcdef0")), { state: "meets-minimum", version: "2026.09.01-abcdef0" });
	assert.deepEqual(await checkCursorVersion("/x", read("2026.07.30-abcdef0")), { state: "update-required", version: "2026.07.30-abcdef0" });
	assert.deepEqual(await checkCursorVersion("/x", read("garbage")), { state: "unchecked", version: null });
	assert.deepEqual(await checkCursorVersion("/x", async () => { throw new Error("ENOENT"); }), { state: "unchecked", version: null });
});

function reader(status: unknown, version = "2026.08.25-3e8eec8"): ReadCursorOutput & { calls: string[][] } {
	const calls: string[][] = [];
	const read = async (_binary: string, args: string[]) => {
		calls.push(args);
		return args[0] === "--version" ? version : JSON.stringify(status);
	};
	return Object.assign(read, { calls });
}

test("inspection reports sign-in from `status --format json` and nothing else from it", async () => {
	const signedIn = reader({ status: "authenticated", isAuthenticated: true, userInfo: { email: "learner@example.com" } });
	const status = await inspectCursorInstallation(() => "/bin/cursor-agent", signedIn);
	assert.deepEqual(status, { state: "signed-in", version: "2026.08.25-3e8eec8", minimumVersion: "2026.08.25" });
	assert.ok(!JSON.stringify(status).includes("example.com"));
	assert.deepEqual(signedIn.calls, [["--version"], ["status", "--format", "json"]]);

	assert.equal((await inspectCursorInstallation(() => "/bin/cursor-agent", reader({ isAuthenticated: false }))).state, "signed-out");
	assert.equal((await inspectCursorInstallation(() => "/bin/cursor-agent", reader("nonsense"))).state, "unchecked");
	assert.equal((await inspectCursorInstallation(() => "/bin/cursor-agent", reader({}, "2026.01.01-aaaa"))).state, "update-required");
	assert.equal((await inspectCursorInstallation(() => null, reader({}))).state, "not-found");
});

test("launcher: checks the version once per binary, prepares the HOME every run, and refuses old builds", async () => {
	const read = reader({});
	let prepared = 0;
	let swept = 0;
	const spawned: { args: string[]; detached: unknown }[] = [];
	const launch = createCursorLauncher({
		findBinary: () => "/bin/cursor-agent",
		read,
		prepareHome: async (binary) => { assert.equal(binary, "/bin/cursor-agent"); prepared++; },
		sweep: async () => { swept++; },
		spawnProcess: ((_binary: string, args: string[], options: { detached?: boolean }) => {
			spawned.push({ args, detached: options.detached });
			return {} as never;
		}) as never,
	});
	await launch(["-p"], { cwd: "/tmp", env: {} as NodeJS.ProcessEnv });
	await launch(["-p"], { cwd: "/tmp", env: {} as NodeJS.ProcessEnv });
	assert.equal(read.calls.length, 1);
	assert.equal(prepared, 2);
	assert.equal(swept, 1, "stale runs are swept once per process");
	assert.deepEqual(spawned, [{ args: ["-p"], detached: true }, { args: ["-p"], detached: true }]);

	const old = createCursorLauncher({ findBinary: () => "/bin/cursor-agent", read: reader({}, "2025.12.01-aaaa"), prepareHome: async () => {}, sweep: async () => {} });
	await assert.rejects(async () => old(["-p"], { cwd: "/tmp", env: {} as NodeJS.ProcessEnv }), CursorLaunchError);
	const missing = createCursorLauncher({ findBinary: () => null });
	assert.equal(await missing(["-p"], { cwd: "/tmp", env: {} as NodeJS.ProcessEnv }), null);
});
