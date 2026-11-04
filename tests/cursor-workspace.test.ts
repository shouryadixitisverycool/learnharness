/** Per-run workspaces and their cleanup (src/agent/cursor/workspace.ts). */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkspace, removeWorkspace, RULES_FILE, sweepStaleRuns } from "../src/agent/cursor/workspace.ts";

test("a workspace holds the always-apply rules file and a private mcp.json, and cleanup removes the CLI's copies", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "cursor-workspace-test-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const workspace = await createWorkspace("Doctrine.", "{\"mcpServers\":{}}", ["quiz", "lookup"]);
	assert.match(workspace.id, /^lh-cursor-[0-9a-f]{16}$/);
	assert.equal(statSync(workspace.dir).mode & 0o777, 0o700);
	assert.equal(statSync(join(workspace.dir, ".cursor", "mcp.json")).mode & 0o777, 0o600);
	const rules = readFileSync(join(workspace.dir, ".cursor", "rules", RULES_FILE), "utf8");
	assert.match(rules, /^---\ndescription: LearnHarness tutor instructions\nalwaysApply: true\n---\n/);
	assert.match(rules, /Your only tools are the learnharness MCP tools\./);
	assert.match(rules, /\n\nDoctrine\.\n$/);
	assert.deepEqual(JSON.parse(readFileSync(join(workspace.dir, ".cursor", "learnharness-tools.json"), "utf8")), ["quiz", "lookup"]);

	// What the real CLI leaves in its HOME for one run.
	const sessionId = "fc5a16e5-93bd-440f-a96e-93b29da6badc";
	const chat = join(home, ".cursor", "chats", "55c2fc5d0ea349b0dffe6d8ee6b6f73d", sessionId);
	const otherChat = join(home, ".cursor", "chats", "aaaa", "0eab84ea-64bf-4fbc-ac5c-ec3d0063594d");
	const project = join(home, ".cursor", "projects", `tmp-${workspace.id}`);
	const otherProject = join(home, ".cursor", "projects", "tmp-lh-cursor-0000000000000000");
	for (const dir of [chat, otherChat, project, otherProject]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(chat, "store.db"), "lesson");

	await removeWorkspace(workspace, home, sessionId);
	assert.ok(!existsSync(workspace.dir));
	assert.ok(!existsSync(chat) && !existsSync(join(chat, "..")), "the chat and its emptied bucket are gone");
	assert.ok(!existsSync(project));
	assert.ok(existsSync(otherChat) && existsSync(otherProject), "other runs' state stays");
});

test("a session id that is not a UUID is never used as a path", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "cursor-workspace-test-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const victim = join(home, ".cursor", "chats", "bucket", "keep");
	mkdirSync(victim, { recursive: true });
	const workspace = await createWorkspace("p", "{}", []);
	await removeWorkspace(workspace, home, "../../..");
	await removeWorkspace(workspace, home, "keep");
	assert.ok(existsSync(victim));
});

test("a restart sweeps what killed runs left behind, but nothing touched in the last hour", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "cursor-sweep-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const temp = join(root, "tmp");
	const old = (path: string) => { mkdirSync(path, { recursive: true }); utimesSync(path, new Date(0), new Date(0)); return path; };
	const fresh = (path: string) => { mkdirSync(path, { recursive: true }); return path; };
	const staleWorkspace = old(join(temp, "lh-cursor-00000000000000aa"));
	const liveWorkspace = fresh(join(temp, "lh-cursor-00000000000000bb"));
	const unrelated = old(join(temp, "lh-cursor-not-ours"));
	const staleChat = old(join(home, ".cursor", "chats", "bucket", "0eab84ea-64bf-4fbc-ac5c-ec3d0063594d"));
	const liveChat = fresh(join(home, ".cursor", "chats", "bucket", "fc5a16e5-93bd-440f-a96e-93b29da6badc"));
	const staleProject = old(join(home, ".cursor", "projects", "tmp-lh-cursor-00000000000000aa"));
	await sweepStaleRuns(home, Date.now(), temp);
	assert.ok(!existsSync(staleWorkspace) && !existsSync(staleChat) && !existsSync(staleProject));
	assert.ok(existsSync(liveWorkspace) && existsSync(liveChat) && existsSync(unrelated));
});
