import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOL_LIST_FILE } from "./home.ts";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.ts";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const RULES_FILE = "learnharness.mdc";

const TUTOR_PREFACE = [
	"You are the LearnHarness tutor, not a coding agent. There is no codebase, repository or workspace to inspect, and the learner is not asking for code changes.",
	`Your only tools are the ${BRIDGE_SERVER_NAME} MCP tools. Shell, file, edit and web tools are disabled and every call to them fails, so never try them.`,
	"Follow the LearnHarness instructions below. They replace any general coding-agent guidance you were given.",
].join("\n");

/** A Cursor rule that always applies. Front matter first, then the tutor's whole system prompt. */
export function toRulesFile(systemPrompt: string): string {
	return `---\ndescription: LearnHarness tutor instructions\nalwaysApply: true\n---\n${TUTOR_PREFACE}\n\n${systemPrompt}\n`;
}

export type CursorWorkspace = { dir: string; id: string };

/** One private directory per run, outside any repository so no AGENTS.md or project rules load.
 * The name is lowercase hex so the CLI's per-workspace state is easy to find again.
 * `toolNames` is what the guard hook lets through for this run. */
export async function createWorkspace(systemPrompt: string, mcpConfig: string, toolNames: readonly string[]): Promise<CursorWorkspace> {
	const id = `lh-cursor-${randomBytes(8).toString("hex")}`;
	const dir = join(tmpdir(), id);
	await mkdir(dir, { mode: PRIVATE_DIR_MODE });
	try {
		await mkdir(join(dir, ".cursor", "rules"), { recursive: true, mode: PRIVATE_DIR_MODE });
		await writeFile(join(dir, ".cursor", "mcp.json"), mcpConfig, { mode: PRIVATE_FILE_MODE });
		await writeFile(join(dir, ".cursor", "rules", RULES_FILE), toRulesFile(systemPrompt), { mode: PRIVATE_FILE_MODE });
		await writeFile(join(dir, ".cursor", TOOL_LIST_FILE), JSON.stringify(toolNames), { mode: PRIVATE_FILE_MODE });
		return { dir, id };
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

async function entries(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/** Removes the run's workspace and what the CLI stored about it in the isolated HOME:
 * the chat store (a copy of the lesson) and the per-project state. */
export async function removeWorkspace(workspace: CursorWorkspace, home: string, sessionId: string | undefined): Promise<void> {
	const chats = join(home, ".cursor", "chats");
	const projects = join(home, ".cursor", "projects");
	const removals = [rm(workspace.dir, { recursive: true, force: true })];
	for (const project of await entries(projects)) {
		if (project.endsWith(workspace.id)) removals.push(rm(join(projects, project), { recursive: true, force: true }));
	}
	// The session id comes from CLI output: use it as a path segment only when it is a plain UUID.
	if (sessionId && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
		for (const bucket of await entries(chats)) {
			if ((await entries(join(chats, bucket))).includes(sessionId)) {
				removals.push(rm(join(chats, bucket, sessionId), { recursive: true, force: true })
					.then(async () => { if ((await entries(join(chats, bucket))).length === 0) await rm(join(chats, bucket), { recursive: true, force: true }); }));
			}
		}
	}
	await Promise.all(removals);
}

const STALE_AFTER_MS = 60 * 60_000;
const WORKSPACE_NAME = /^lh-cursor-[0-9a-f]{16}$/;

async function removeIfStale(path: string, now: number): Promise<void> {
	try {
		if (now - (await stat(path)).mtimeMs > STALE_AFTER_MS) await rm(path, { recursive: true, force: true });
	} catch {
		// Already gone, or not ours to remove.
	}
}

/** What a run leaves behind when the server stops before its cleanup: workspaces in the
 * temp dir and chat stores in the isolated HOME. Only entries untouched for an hour go,
 * so a run in progress is never swept. */
export async function sweepStaleRuns(home: string, now = Date.now(), temp = tmpdir()): Promise<void> {
	const chats = join(home, ".cursor", "chats");
	const projects = join(home, ".cursor", "projects");
	const sweeps: Promise<void>[] = [];
	for (const name of await entries(temp)) {
		if (WORKSPACE_NAME.test(name)) sweeps.push(removeIfStale(join(temp, name), now));
	}
	for (const name of await entries(projects)) sweeps.push(removeIfStale(join(projects, name), now));
	for (const bucket of await entries(chats)) {
		for (const session of await entries(join(chats, bucket))) sweeps.push(removeIfStale(join(chats, bucket, session), now));
	}
	await Promise.all(sweeps);
}
