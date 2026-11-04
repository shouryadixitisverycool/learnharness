import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { runSideQuestion, sideQuestionSystemPrompt, sideQuestionTools, TUTOR_NOTE_TOOL } from "../src/agent/subagents/side-question.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { SessionAttachment } from "../src/agent/tools/attachments.ts";
import type { AttachmentRecord } from "../src/core/contracts.ts";
import { AUTH_FILE, PATHS } from "../config.ts";

function attached(name: string, kind: AttachmentRecord["kind"], file: string, extra: Partial<AttachmentRecord> = {}): SessionAttachment {
	const mimeType = kind === "pdf" ? "application/pdf" : kind === "epub" ? "application/epub+zip" : "image/png";
	return {
		record: { id: `att_${file}`, name, kind, mimeType, bytes: 2048, file, addedAt: "2026-11-04T00:00:00.000Z", ...extra },
		path: `${PATHS.attachments}/${file}`,
	};
}
const pdf = attached("Calculus.pdf", "pdf", "aaa.pdf", { pages: 412 });
const epub = attached("Spivak.epub", "epub", "bbb.epub", { chapters: 30, title: "Calculus" });
const image = attached("whiteboard.png", "image", "ccc.png");

function scripted(steps: FauxResponseStep[], modelId?: string): { engine: PiEngine; seen: string[][] } {
	const seen: string[][] = [];
	const faux = createFauxCore(modelId ? { models: [{ id: modelId }] } : {});
	faux.setResponses(steps.map((step) => (context, ...rest) => {
		seen.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
		return typeof step === "function" ? step(context, ...rest) : step;
	}));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, seen };
}

async function run(engine: PiEngine, attachments?: SessionAttachment[]) {
	const deltas: string[] = [];
	const tools: Array<[string, string]> = [];
	const result = await runSideQuestion({
		engine, userMessage: "<tutor_transcript>\n\n</tutor_transcript>\n\nLearner: why?", chatId: "chat_agent",
		onText: (d) => deltas.push(d), onTool: (n, l) => tools.push([n, l]), attachments,
	});
	return { result, deltas, tools };
}

describe("runSideQuestion", () => {
	it("streams the answer in order, ends on tutor_note, and never streams the note", async () => {
		const { engine } = scripted([
			fauxAssistantMessage([fauxText("Because the inner function changes too."), fauxToolCall(TUTOR_NOTE_TOOL, { tell: true, note: "SECRET-NOTE unsure about the chain rule." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must never run"),
		]);
		const { result, deltas } = await run(engine);
		assert.equal(deltas.join(""), "Because the inner function changes too.");
		assert.ok(!deltas.join("").includes("SECRET-NOTE"));
		assert.equal(result.answer, "Because the inner function changes too.");
		assert.deepEqual(result.note, { tell: true, note: "SECRET-NOTE unsure about the chain rule." });
		assert.equal(result.usage.length, 1, "the run stopped after the note");
	});

	it("reports file tools and joins the answer across model calls", async () => {
		const { engine } = scripted([
			fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("ls", { path: "/definitely/missing/dir" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("It isn't there."), fauxToolCall(TUTOR_NOTE_TOOL, { tell: false, note: "n" })], { stopReason: "toolUse" }),
		]);
		const { result, deltas, tools } = await run(engine);
		assert.deepEqual(tools, [["ls", "/definitely/missing/dir"]]);
		assert.equal(result.answer, "Let me look.\n\nIt isn't there.");
		assert.equal(deltas.join(""), result.answer);
	});

	it("returns a null note when the agent never calls tutor_note", async () => {
		const { engine } = scripted([fauxAssistantMessage("Just an answer.")]);
		const { result } = await run(engine);
		assert.equal(result.answer, "Just an answer.");
		assert.equal(result.note, null);
	});

	it("limits the tools to the read-only file tools and the note, plus send_to_user on Claude", async () => {
		assert.deepEqual(sideQuestionTools(scripted([]).engine).map((t) => t.name), ["read", "ls", "find", "grep", TUTOR_NOTE_TOOL]);
		assert.deepEqual(sideQuestionTools(scripted([], "claude-sonnet-x").engine).map((t) => t.name), ["read", "ls", "find", "grep", TUTOR_NOTE_TOOL, "send_to_user"]);
	});

	it("streams send_to_user prose as the answer on Claude models", async () => {
		const { engine } = scripted([
			fauxAssistantMessage([fauxToolCall("send_to_user", { message: "Delivered answer." }), fauxToolCall(TUTOR_NOTE_TOOL, { tell: false, note: "n" })], { stopReason: "toolUse" }),
		], "claude-sonnet-x");
		const { result, deltas } = await run(engine);
		assert.equal(result.answer, "Delivered answer.");
		assert.equal(deltas.join(""), "Delivered answer.");
	});

	it("loads the system prompt with the tutor_note contract", () => {
		assert.match(sideQuestionSystemPrompt(), /^You answer side questions/);
		assert.match(sideQuestionSystemPrompt(), /call tutor_note exactly once/);
	});

	it("refuses the app's own data and auth file to the file tools (the answer key lives there)", async () => {
		const tools = sideQuestionTools(scripted([]).engine);
		const run = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute("call", args as never);
		for (const [name, args] of [
			["read", { path: `${PATHS.chats}/chat_x.json` }],
			["ls", { path: PATHS.data }],
			["grep", { pattern: "correctAnswer", path: PATHS.chats }],
			["find", { pattern: "*.json", path: PATHS.data }],
			["read", { path: AUTH_FILE }],
		] as const) {
			await assert.rejects(() => run(name, args), /app's own data/, `${name} ${JSON.stringify(args)}`);
		}
		await assert.doesNotReject(() => run("ls", { path: "/definitely/missing/dir" }).catch((err: Error) => {
			if (/app's own data/.test(err.message)) throw err;
		}));
	});
});

describe("side agent attachments", () => {
	it("adds the pdf and epub readers only for the kinds the session holds", () => {
		const names = (a: SessionAttachment[]) => sideQuestionTools(scripted([]).engine, a).map((t) => t.name);
		assert.deepEqual(names([pdf]), ["read", "ls", "find", "grep", "pdf_info", "pdf_extract", "pdf_search", TUTOR_NOTE_TOOL]);
		assert.deepEqual(names([epub, image]), ["read", "ls", "find", "grep", "epub_info", "epub_read", "epub_search", TUTOR_NOTE_TOOL]);
		assert.deepEqual(names([image]), ["read", "ls", "find", "grep", TUTOR_NOTE_TOOL]);
	});

	it("lists the attachments after the instructions, without the tutor-only hints", () => {
		assert.equal(sideQuestionSystemPrompt([]), sideQuestionSystemPrompt());
		const prompt = sideQuestionSystemPrompt([pdf, epub, image]);
		assert.ok(prompt.startsWith(sideQuestionSystemPrompt()), "the instructions stay the cacheable prefix");
		assert.match(prompt, /## Session attachments/);
		assert.match(prompt, /- Calculus\.pdf — PDF, 412 pages, .* → pdf_info \/ pdf_search \/ pdf_extract — path: .*aaa\.pdf/);
		assert.match(prompt, /- Spivak\.epub — EPUB "Calculus", 30 chapters/);
		assert.match(prompt, /- whiteboard\.png — image, .* → `read` this path to look at it — path: .*ccc\.png/);
		assert.doesNotMatch(prompt, /`pdf` job/);
		assert.doesNotMatch(prompt, /shown on the message it was sent with/);
	});

	it("lets read open the session's attached images, and nothing else in the data dir", async () => {
		const tools = sideQuestionTools(scripted([]).engine, [pdf, image]);
		const read = (p: string) => tools.find((t) => t.name === "read")!.execute("call", { path: p } as never);
		// Missing on disk, but past the guard: the failure is the read's own.
		await assert.rejects(() => read(image.path), (err: Error) => !/app's own data/.test(err.message));
		await assert.rejects(() => read(pdf.path), /app's own data/, "a PDF goes through pdf_*, not read");
		await assert.rejects(() => read(`${PATHS.attachments}/other-session.png`), /app's own data/);
	});

	it("keeps the attachment readers to this session's files", async () => {
		const tools = sideQuestionTools(scripted([]).engine, [pdf]);
		const result = await tools.find((t) => t.name === "pdf_info")!.execute("call", { path: `${PATHS.attachments}/other-session.pdf` } as never);
		assert.match(JSON.stringify(result.content), /must be one of this session's attachments/);
	});

	it("shows an attachment's name, not its blob path, while a reader runs", async () => {
		const { engine } = scripted([
			fauxAssistantMessage([fauxToolCall("pdf_search", { path: pdf.path, query: "chain rule" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Page 112 covers it."), fauxToolCall(TUTOR_NOTE_TOOL, { tell: false, note: "n" })], { stopReason: "toolUse" }),
		]);
		const { tools, result } = await run(engine, [pdf]);
		assert.deepEqual(tools, [["pdf_search", "Calculus.pdf"]]);
		assert.equal(result.answer, "Page 112 covers it.");
	});
});
