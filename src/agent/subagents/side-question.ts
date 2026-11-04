import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { AUTH_FILE, PATHS } from "../../../config.ts";
import { userFacingTextOf } from "../../core/native-messages.ts";
import type { SideNote } from "../../core/side-questions.ts";
import type { PiEngine } from "../models.ts";
import { serverExecute } from "../tool-execute.ts";
import { healToolRecord, withArgumentHeal } from "../tools/heal.ts";
import { attachmentsPromptSection, attachmentTools, type SessionAttachment } from "../tools/attachments.ts";
import { createReadTool } from "../tools/read.ts";
import { lsTool } from "../tools/ls.ts";
import { findTool } from "../tools/find.ts";
import { grepTool } from "../tools/grep.ts";
import { resolveSourcePath } from "../tools/fs-shared.ts";
import { needsSendToUser, sendToUserTool } from "../tools/send-to-user.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * THE SIDE AGENT (#16): answers one side question over a read-only text
 * transcript of the lesson (core/side-questions.ts sideUserMessage), with
 * read-only learner-file tools and the session's attachments (the pdf_* /
 * epub_* readers, images through read), and ends with ONE tutor_note call — its
 * recommendation and draft note for the tutor. Stateless: the thread so
 * far rides the user message. A foreground call: its engine is built with
 * background = false by the route.
 */

export const TUTOR_NOTE_TOOL = "tutor_note";
/** The answer's model-call budget (P7). */
export const SIDE_QUESTION_MAX_TURNS = 8;

/** Outside the numbered fragments, so it never composes into tutor prompts. */
const SYSTEM_PROMPT_FILE = path.join(PATHS.root, "src", "agent", "prompts", "side-question", "system.md");

let cachedPrompt: string | undefined;
/** The side agent's instructions, then the session's attachment manifest
 *  (last, like the tutor's, so the instructions prefix stays cacheable). */
export function sideQuestionSystemPrompt(attachments: readonly SessionAttachment[] = []): string {
	const instructions = (cachedPrompt ??= fs.readFileSync(SYSTEM_PROMPT_FILE, "utf-8").trim());
	const section = attachmentsPromptSection(attachments, "side");
	return section ? `${instructions}\n\n---\n\n${section}` : instructions;
}

const tutorNoteInput = Type.Object({
	tell: Type.Boolean({ description: "true when the tutor should know about this side thread." }),
	note: Type.String({ minLength: 1, maxLength: 600, description: "One or two sentences for the tutor, covering the whole side thread." }),
});

const tutorNoteTool: AgentTool<typeof tutorNoteInput> = {
	name: TUTOR_NOTE_TOOL,
	label: TUTOR_NOTE_TOOL,
	description: "Record your recommendation and the draft note for the tutor. Call exactly once, after your answer.",
	parameters: tutorNoteInput,
	execute: serverExecute(TUTOR_NOTE_TOOL, tutorNoteInput, () => "Noted."),
};

export interface SideAnswer {
	answer: string;
	/** null when the agent never called tutor_note (the caller supplies P6). */
	note: SideNote | null;
	usage: Usage[];
}

export interface SideQuestionRunOptions {
	engine: PiEngine;
	userMessage: string;
	chatId: string;
	/** The learner-facing answer as it streams (never the tutor note). */
	onText: (delta: string) => void;
	/** A file tool started (label: its path or pattern; an attachment's name). */
	onTool: (name: string, label: string) => void;
	/** The session's active attachments (server/attachments.ts sessionAttachments). */
	attachments?: readonly SessionAttachment[];
}

/** Is this path the app's own data (chat records hold every pending
 *  question's answer key) or its key file? */
function isAppData(target: string): boolean {
	const inside = (root: string) => {
		const rel = path.relative(path.resolve(root), path.resolve(target));
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	};
	return inside(PATHS.data) || path.resolve(target) === path.resolve(AUTH_FILE);
}

/** A file tool that refuses the app's own data: the transcript hides a
 *  waiting question's answer key (P1), so its record file must stay shut.
 *  Walks never enter ~/Library, where the desktop app keeps its data.
 *  `allowed` holds the session's own attached images, which read opens. */
function withoutAppData<T extends AgentTool<any, any>>(tool: T, allowed: ReadonlySet<string>): T {
	return {
		...tool,
		execute: async (toolCallId, params, ...rest) => {
			const target = resolveSourcePath((params as { path?: string } | undefined)?.path);
			if (isAppData(target) && !allowed.has(path.resolve(target))) throw new Error(`${target} is the app's own data, not the learner's files.`);
			return tool.execute(toolCallId, params, ...rest);
		},
	};
}

/** The registry: read-only file tools, the session's attachment readers
 *  (scoped to its own files), the note, and (Claude models only, the
 *  tutor's own gate) the output tool. */
export function sideQuestionTools(engine: PiEngine, attachments: readonly SessionAttachment[] = []): AgentTool<any, any>[] {
	const images = new Set(attachments.filter((a) => a.record.kind === "image").map((a) => path.resolve(a.path)));
	return [
		...[createReadTool(engine.model), lsTool, findTool, grepTool].map((tool) => withoutAppData(tool, images)),
		...Object.values(healToolRecord(attachmentTools(attachments))),
		tutorNoteTool,
		...(needsSendToUser(engine.model) ? [withArgumentHeal(sendToUserTool)] : []),
	];
}

/** What the side thread shows for a running tool: the pattern or path,
 *  or an attachment's name instead of its blob path. */
function toolLabel(args: unknown, names: ReadonlyMap<string, string>): string {
	const a = (args ?? {}) as { path?: unknown; pattern?: unknown };
	const named = typeof a.path === "string" ? names.get(path.resolve(a.path)) : undefined;
	const label = named ?? (typeof a.pattern === "string" ? a.pattern : typeof a.path === "string" ? a.path : "");
	return label.slice(0, 120);
}

function noteOf(message: AssistantMessage): SideNote | null {
	for (const block of message.content) {
		if (block.type !== "toolCall" || block.name !== TUTOR_NOTE_TOOL) continue;
		const args = block.arguments as { tell?: unknown; note?: unknown };
		if (typeof args.tell === "boolean" && typeof args.note === "string" && args.note.trim()) {
			return { tell: args.tell, note: args.note.trim() };
		}
	}
	return null;
}

/** The learner-facing prose of one assistant message: plain text and the
 *  output tool's message; tutor_note arguments never appear. */
function visibleText(message: AssistantMessage): string {
	return userFacingTextOf(message.content).join("\n\n");
}

export async function runSideQuestion(opts: SideQuestionRunOptions): Promise<SideAnswer> {
	const attachments = opts.attachments ?? [];
	const names = new Map(attachments.map((a) => [path.resolve(a.path), a.record.name]));
	const usage: Usage[] = [];
	const answers: string[] = [];
	let note: SideNote | null = null;
	// What the client already has of the message streaming now.
	let streamed = "";
	const emit = (text: string) => {
		const sep = answers.length && !streamed && text ? "\n\n" : "";
		if (text.startsWith(streamed) && text.length > streamed.length) {
			opts.onText(sep + text.slice(streamed.length));
			streamed = text;
		}
	};
	const onEvent = (event: AgentEvent) => {
		if (event.type === "message_update" && event.message.role === "assistant") {
			emit(visibleText(event.message as AssistantMessage));
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message as AssistantMessage;
			const text = visibleText(message);
			emit(text);
			if (text) answers.push(text);
			streamed = "";
			note = noteOf(message) ?? note;
		} else if (event.type === "tool_execution_start" && !["tutor_note", "send_to_user"].includes(event.toolName)) {
			opts.onTool(event.toolName, toolLabel(event.args, names));
		}
	};
	await runSubagent(sideQuestionTools(opts.engine, attachments), {
		role: "sideQuestion",
		engine: opts.engine,
		systemPrompt: sideQuestionSystemPrompt(attachments),
		prompt: opts.userMessage,
		maxTurns: SIDE_QUESTION_MAX_TURNS,
		shouldStop: (m) => m.content.some((b) => b.type === "toolCall" && b.name === TUTOR_NOTE_TOOL),
		onUsage: (u) => usage.push(u),
		onEvent,
		chatId: opts.chatId,
	});
	return { answer: answers.join("\n\n"), note, usage };
}
