/**
 * The Cursor provider's isolated HOME (src/agent/cursor/home.ts). These are the
 * security boundary: the CLI never sees the user's real ~/.cursor, its config
 * allows only the LearnHarness MCP server, and LearnHarness's own secrets stay
 * out of its environment.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { authEnvRecord } from "../src/core/auth-env.ts";
import { CURSOR_CLI_CONFIG, GUARD_FILE, cursorEnv, cursorHome, guardNode, prepareCursorHome, toHooksConfig } from "../src/agent/cursor/home.ts";
import { PATHS } from "../config.ts";

function tempDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-home-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const EXPECTED_CONFIG = {
	version: 1,
	approvalMode: "allowlist",
	sandbox: { mode: "disabled" },
	permissions: {
		allow: ["Mcp(learnharness:*)"],
		deny: ["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)", "WebSearch(*)"],
	},
};

test("the written cli-config.json allows exactly the LearnHarness MCP server and denies shell, files and web", async (t) => {
	const dir = tempDir(t);
	const home = join(dir, "home");
	const authDir = join(dir, "auth");
	mkdirSync(authDir);
	await prepareCursorHome({ home, authDir });
	const written = JSON.parse(readFileSync(join(home, ".cursor", "cli-config.json"), "utf8"));
	assert.deepEqual(written, EXPECTED_CONFIG);
	assert.deepEqual(JSON.parse(JSON.stringify(CURSOR_CLI_CONFIG)), EXPECTED_CONFIG);
	assert.deepEqual(written.permissions.allow, ["Mcp(learnharness:*)"], "nothing but the bridge is allowed");
	assert.equal(statSync(join(home, ".cursor", "cli-config.json")).mode & 0o777, 0o600);
	assert.equal(statSync(home).mode & 0o777, 0o700);
});

test("every run restores the config the CLI rewrote, and keeps nothing it added", async (t) => {
	const dir = tempDir(t);
	const home = join(dir, "home");
	const authDir = join(dir, "auth");
	mkdirSync(authDir);
	await prepareCursorHome({ home, authDir });
	const file = join(home, ".cursor", "cli-config.json");
	writeFileSync(file, JSON.stringify({ ...EXPECTED_CONFIG, approvalMode: "yolo", permissions: { allow: ["Shell(*)"], deny: [] } }));
	await prepareCursorHome({ home, authDir });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), EXPECTED_CONFIG);
});

test(".config/cursor links to the real auth dir, and a wrong link or directory is replaced", async (t) => {
	const dir = tempDir(t);
	const home = join(dir, "home");
	const authDir = join(dir, "auth");
	const otherDir = join(dir, "other");
	mkdirSync(authDir);
	mkdirSync(otherDir);
	await prepareCursorHome({ home, authDir: otherDir });
	await prepareCursorHome({ home, authDir });
	const link = join(home, ".config", "cursor");
	assert.ok(lstatSync(link).isSymbolicLink());
	assert.equal(readlinkSync(link), authDir);

	rmSync(link);
	mkdirSync(link);
	await prepareCursorHome({ home, authDir });
	assert.equal(readlinkSync(link), authDir);
});

test("the isolated HOME lives in the LearnHarness data dir; LH_CURSOR_CONFIG_DIR picks the auth dir", () => {
	assert.equal(cursorHome({}, "/home/u").home, join(PATHS.data, "cursor-home"));
	assert.equal(cursorHome({}, "/home/u").authDir, "/home/u/.config/cursor");
	assert.equal(cursorHome({ LH_CURSOR_CONFIG_DIR: "/srv/cursor-auth" }, "/home/u").authDir, "/srv/cursor-auth");
});

test("the child env carries HOME, PATH and proxies, never LearnHarness keys or XDG dirs", (t) => {
	const record = authEnvRecord();
	const before = { realEnv: new Set(record.realEnv), fillGap: new Set(record.fillGap) };
	t.after(() => { record.realEnv = before.realEnv; record.fillGap = before.fillGap; });
	record.fillGap.add("CURSOR_API_KEY");
	const env = cursorEnv("/data/cursor-home", {
		PATH: "/usr/bin",
		HOME: "/home/real",
		HTTPS_PROXY: "http://proxy:3128",
		OPENROUTER_API_KEY: "sk-or-secret",
		ANTHROPIC_API_KEY: "sk-ant-secret",
		LH_AUTH_FILE: "/data/auth.json",
		XDG_CONFIG_HOME: "/home/real/.config",
		CURSOR_API_KEY: "injected-by-learnharness",
	});
	assert.deepEqual(env, {
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://proxy:3128",
		NODE_ENV: "production",
		HOME: "/data/cursor-home",
		USERPROFILE: "/data/cursor-home",
		NO_OPEN_BROWSER: "1",
	});
});

test("an operator's own CURSOR_API_KEY reaches the CLI", (t) => {
	const record = authEnvRecord();
	const before = new Set(record.fillGap);
	t.after(() => { record.fillGap = before; });
	record.fillGap.delete("CURSOR_API_KEY");
	assert.equal(cursorEnv("/h", { CURSOR_API_KEY: "key_operator" }).CURSOR_API_KEY, "key_operator");
});

test("hooks.json runs the guard before every tool call and fails closed", async (t) => {
	const dir = tempDir(t);
	const home = join(dir, "home");
	const authDir = join(dir, "auth");
	mkdirSync(authDir);
	await prepareCursorHome({ home, authDir }, "/opt/cursor/node");
	const guard = join(home, ".cursor", GUARD_FILE);
	assert.deepEqual(JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8")), {
		version: 1,
		hooks: { preToolUse: [{ command: `'/opt/cursor/node' '${guard}'`, failClosed: true }] },
	});
	assert.equal(statSync(guard).mode & 0o777, 0o600);
	assert.deepEqual(toHooksConfig("/a b/node", "/it's/guard.mjs"), { version: 1, hooks: { preToolUse: [{ command: "'/a b/node' '/it'\\''s/guard.mjs'", failClosed: true }] } });
});

test("the guard denies every built-in tool and lets only this run's LearnHarness MCP tools through", async (t) => {
	const dir = tempDir(t);
	const home = join(dir, "home");
	const authDir = join(dir, "auth");
	const workspace = join(dir, "lh-cursor-0123456789abcdef");
	mkdirSync(authDir);
	mkdirSync(join(workspace, ".cursor"), { recursive: true });
	writeFileSync(join(workspace, ".cursor", "learnharness-tools.json"), JSON.stringify(["lookup", "quiz"]));
	await prepareCursorHome({ home, authDir }, process.execPath);
	const guard = join(home, ".cursor", GUARD_FILE);
	const decide = (input: unknown) => JSON.parse(spawnSync(process.execPath, [guard], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" }).stdout) as { permission?: string };
	const request = (tool_name: string, roots: unknown = [workspace]) => ({ hook_event_name: "preToolUse", tool_name, tool_input: {}, workspace_roots: roots });

	// What cursor-agent 2026.08.25 sends: grep and glob both arrive as Grep.
	for (const tool of ["Grep", "Read", "Shell", "Write", "Delete", "WebFetch", "WebSearch", "Task"]) {
		assert.equal(decide(request(tool)).permission, "deny", tool);
	}
	assert.deepEqual(decide(request("MCP:lookup")), {}, "a LearnHarness tool gets no decision, so the allow list still applies");
	assert.equal(decide(request("MCP:search_threads")).permission, "deny", "an account plugin's tool is not on this run's list");
	assert.equal(decide(request("MCP:lookup", [workspace, dir])).permission, "deny");
	assert.equal(decide(request("MCP:lookup", [dir])).permission, "deny", "no tool list, no tools");
	assert.equal(decide({ ...request("MCP:lookup"), hook_event_name: "postToolUse" }).permission, "deny");
	assert.equal(decide("not json").permission, "deny");
});

test("the guard runs on the CLI's bundled node when the install has one", (t) => {
	const dir = tempDir(t);
	const versions = join(dir, "versions", "2026.08.25-3e8eec8");
	mkdirSync(versions, { recursive: true });
	writeFileSync(join(versions, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(versions, "node"), "", { mode: 0o755 });
	symlinkSync(join(versions, "cursor-agent"), join(dir, "cursor-agent"));
	assert.equal(guardNode(join(dir, "cursor-agent")), join(versions, "node"));
	chmodSync(join(versions, "node"), 0o644);
	assert.equal(guardNode(join(dir, "cursor-agent")), process.execPath);
	assert.equal(guardNode(null), process.execPath);
});
