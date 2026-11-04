import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import { QUESTION_TOOLS } from "../../core/pending.ts";
import { PRACTICE_PROBLEM_TOOL } from "../../core/native-messages.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { CursorError } from "./constants.ts";
import { parseCursorLine, toPiToolCallId, type CursorEvent, type CursorUsage } from "./events.ts";
import { cursorEnv, cursorHome, type CursorHome } from "./home.ts";
import { CursorLaunchError, createCursorLauncher } from "./launch.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "./live-processes.ts";
import { toCursorModelId } from "./provider.ts";
import { BRIDGE_SERVER_NAME, createCursorToolBridge, textResult, toCallToolResult, type CursorToolBridge, type HeldMcpCall } from "./tool-bridge.ts";
import { toCursorInput } from "./transcript.ts";
import { createWorkspace, removeWorkspace, type CursorWorkspace } from "./workspace.ts";

type RunCursorOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };

type CursorChild = ChildProcessWithoutNullStreams | null;
export type RunCursor = (args: string[], options: RunCursorOptions) => CursorChild | Promise<CursorChild>;

/** What the CLI hears back for a learner-facing call. The process is killed right after,
 * and the learner's real answer reaches the model in the next run's replay. */
export const QUESTION_PLACEHOLDER = "Shown to the learner. End your turn now; their answer arrives in the next message.";

/** What the CLI hears back for a call whose result will only come with the next replay. */
export const DEFERRED_PLACEHOLDER = "This tool is still running. End your turn now; its result arrives in the next message.";

/** Calls that wait on the learner. pi ends the turn at these (makeQuestionStopper), so
 * holding the MCP call would outlast the CLI's 60 s request timeout. */
const SPLIT_TOOLS: ReadonlySet<string> = new Set([...QUESTION_TOOLS, PRACTICE_PROBLEM_TOOL]);

// Parallel calls reach stdout and MCP in either order. A batch waits for every
// started call to arrive over MCP, but never longer than this.
const BATCH_SETTLE_MS = 3_000;

const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "cursor-agent failed to start";
const KILL_GRACE_MS = 1_000;

export function toCursorArgs(input: { model: string; workspace: string }): string[] {
	return [
		"-p",
		"--trust",
		"--approve-mcps",
		// The sandbox cannot start on every host (AppArmor). The isolated HOME's
		// deny list is the boundary instead; see home.ts.
		"--sandbox",
		"disabled",
		"--output-format",
		"stream-json",
		"--stream-partial-output",
		"--model",
		input.model,
		"--workspace",
		input.workspace,
	];
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/** One pi stream() call. A CLI run spans one or more of these: each held tool call ends one. */
class CursorTurn {
	private readonly output: AssistantMessage;
	private open: { kind: "text" | "thinking"; contentIndex: number } | null = null;
	/** Text streamed since the CLI last closed a segment, to reconcile its closing copy. */
	private segmentText = "";
	started = false;
	finished = false;

	constructor(private readonly stream: AssistantMessageEventStream, model: Model<Api>) {
		this.output = createOutput(model);
	}

	getMessage(): AssistantMessage { return this.output; }

	textDelta(text: string): void {
		if (this.finished || !text) return;
		this.start();
		this.segmentText += text;
		if (this.open?.kind !== "text") {
			this.closeOpen();
			const contentIndex = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.open = { kind: "text", contentIndex };
			this.stream.push({ type: "text_start", contentIndex, partial: this.output });
		}
		const block = this.output.content[this.open.contentIndex]!;
		if (block.type === "text") block.text += text;
		this.stream.push({ type: "text_delta", contentIndex: this.open.contentIndex, delta: text, partial: this.output });
	}

	/** The CLI repeats a finished segment's text in full. Emit only what the deltas missed. */
	textFlush(text: string): void {
		if (this.finished) return;
		const streamed = this.segmentText;
		this.segmentText = "";
		if (text.startsWith(streamed) && text.length > streamed.length) {
			const rest = text.slice(streamed.length);
			this.textDelta(rest);
			this.segmentText = "";
		}
		if (this.open?.kind === "text") this.closeOpen();
	}

	thinkingDelta(text: string): void {
		if (this.finished || !text) return;
		this.start();
		if (this.open?.kind !== "thinking") {
			this.closeOpen();
			const contentIndex = this.output.content.length;
			this.output.content.push({ type: "thinking", thinking: "" });
			this.open = { kind: "thinking", contentIndex };
			this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
		}
		const block = this.output.content[this.open.contentIndex]!;
		if (block.type === "thinking") block.thinking += text;
		this.stream.push({ type: "thinking_delta", contentIndex: this.open.contentIndex, delta: text, partial: this.output });
	}

	thinkingDone(): void {
		if (this.open?.kind === "thinking") this.closeOpen();
	}

	setUsage(usage: CursorUsage): void {
		Object.assign(this.output.usage, usage);
		const { input, output, cacheRead, cacheWrite } = this.output.usage;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeOpen();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.end("toolUse");
	}

	finish(): void {
		if (this.finished) return;
		this.start();
		this.closeOpen();
		this.end("stop");
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeOpen(): void {
		const open = this.open;
		if (!open) return;
		this.open = null;
		const block = this.output.content[open.contentIndex]!;
		if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: open.contentIndex, content: block.text, partial: this.output });
		if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: open.contentIndex, content: block.thinking, partial: this.output });
	}

	private end(reason: "stop" | "toolUse"): void {
		this.finished = true;
		this.output.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.output });
		this.stream.end();
	}
}

type Intent = { id: string; name: string; arguments: ToolCall["arguments"] };
type Admission = { call: ToolCall; mcp: HeldMcpCall };

let runCounter = 0;

function seconds(ms: number): string {
	return (ms / 1000).toFixed(1);
}

function toErrorMessage(stderr: string, code: number | null): string {
	if (/authentication required|not logged in|run 'agent login'/i.test(stderr)) return CursorError.NotSignedIn;
	const line = stderr.split("\n").map((value) => value.trim()).find(Boolean);
	return line ? `cursor-agent: ${line.slice(0, 300)}` : `cursor-agent exited with code ${code}`;
}

/** One cursor-agent run. Lives across pi turns while it holds tool calls for pi. */
class CursorProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private readonly run = ++runCounter;
	private readonly startedAt = Date.now();
	private initAt: number | undefined;
	private firstTokenAt: number | undefined;
	private turns = 1;
	private stderr = "";
	private closed = false;
	private stopping = false;
	private endReason = "exited";
	private killTimer: NodeJS.Timeout | undefined;
	private batchTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	private cliSessionId: string | undefined;
	private usage: CursorUsage | null = null;
	/** Harness calls seen on stdout whose MCP request has not arrived yet. */
	private intents: Intent[] = [];
	/** MCP requests whose stdout event has not arrived yet. */
	private unmatched: HeldMcpCall[] = [];
	/** Matched calls not yet handed to pi. */
	private paired: Admission[] = [];
	/** Calls handed to pi whose results the CLI is still waiting on. */
	private admitted: Admission[] = [];

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: CursorToolBridge,
		private readonly workspace: CursorWorkspace,
		private readonly home: string,
		private turn: CursorTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
		private readonly replay: boolean,
	) {}

	start(prompt: string, signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(code));
		this.child.once("error", (error) => {
			console.error("cursor-agent process failed:", error);
			this.turn.fail(START_FAILED_MESSAGE, "error");
			this.handleClose(null);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => console.error("cursor-agent stdin closed early:", error));
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try { this.handleLine(line); }
			catch (error) {
				console.error("cursor-agent output handling failed:", error);
				this.fail("cursor-agent emitted malformed stream output");
			}
		});
		this.setSignal(signal);
		if (!this.stopping) this.child.stdin.end(prompt);
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every(({ call }) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: CursorTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.toolCallIds = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.turns++;
		this.setSignal(signal);
		if (this.stopping) return;
		for (const { call, mcp } of admitted) {
			mcp.respond(toCallToolResult(results.find((result) => result.toolCallId === call.id)!));
		}
		this.flush();
	}

	/** pi did not answer the held calls in time, or cannot continue them: unblock the CLI, then stop it. */
	expire(reason = "held call expired"): void {
		this.endReason = reason;
		for (const { mcp } of this.admitted) mcp.respond(textResult(DEFERRED_PLACEHOLDER));
		this.kill();
	}

	kill(): void {
		removeLiveProcess(this);
		clearTimeout(this.batchTimer);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		this.signalChild("SIGTERM");
		this.killTimer = setTimeout(() => this.signalChild("SIGKILL"), KILL_GRACE_MS);
		this.killTimer.unref();
	}

	fail(message: string): void {
		this.endReason = message;
		this.turn.fail(message, "error");
		this.kill();
	}

	onMcpCall(call: HeldMcpCall): void {
		this.unmatched.push(call);
		this.pair();
	}

	onMcpCancel(call: HeldMcpCall): void {
		this.unmatched = this.unmatched.filter((candidate) => candidate !== call);
		this.paired = this.paired.filter((admission) => admission.mcp !== call);
	}

	/** The detached child leads its own process group; signal the whole group. */
	private signalChild(signal: NodeJS.Signals): void {
		try {
			if (this.child.pid !== undefined) process.kill(-this.child.pid, signal);
			else this.child.kill(signal);
		} catch {
			this.child.kill(signal);
		}
	}

	private readonly abort = () => {
		this.endReason = "aborted";
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	/** Pair each MCP request with the stdout call that has the same tool and arguments, in order. */
	private pair(): void {
		for (const mcp of [...this.unmatched]) {
			const index = this.intents.findIndex((intent) => intent.name === mcp.name && isDeepStrictEqual(intent.arguments, mcp.arguments));
			if (index === -1) continue;
			const [intent] = this.intents.splice(index, 1);
			this.unmatched = this.unmatched.filter((candidate) => candidate !== mcp);
			this.paired.push({ call: { type: "toolCall", id: intent!.id, name: intent!.name, arguments: intent!.arguments }, mcp });
		}
		this.flush();
	}

	/** Hand matched calls to pi once every call the CLI started has reached the bridge
	 * (or, forced, once that wait timed out). */
	private flush(force = false): void {
		if (this.stopping || this.turn.finished || this.admitted.length > 0) return;
		if (!force && (this.intents.length > 0 || this.unmatched.length > 0)) {
			this.batchTimer ??= setTimeout(() => this.settleBatch(), BATCH_SETTLE_MS);
			return;
		}
		if (this.paired.length === 0) return;
		clearTimeout(this.batchTimer);
		this.batchTimer = undefined;

		const batch = this.paired;
		this.paired = [];
		const calls = batch.map(({ call }) => call);
		// Without a chat session there is nothing to continue later: always split.
		if (!this.sessionId || calls.some((call) => SPLIT_TOOLS.has(call.name))) {
			for (const { call, mcp } of batch) mcp.respond(textResult(SPLIT_TOOLS.has(call.name) ? QUESTION_PLACEHOLDER : DEFERRED_PLACEHOLDER));
			this.endReason = `split at ${calls.map((call) => call.name).join(", ")}`;
			this.turn.admit(calls);
			this.kill();
			return;
		}
		this.admitted = batch;
		this.toolCallIds = calls.map((call) => call.id);
		this.turn.admit(calls);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		addLiveProcess(this);
	}

	private settleBatch(): void {
		this.batchTimer = undefined;
		if (this.stopping || this.turn.finished) return;
		if (this.unmatched.length > 0) {
			this.fail("cursor-agent compatibility error: an MCP call does not match any streamed tool call");
			return;
		}
		// Calls still missing from MCP were refused by the CLI; their completion clears them.
		this.flush(true);
	}

	private handleLine(line: string): void {
		if (this.stopping || !line.trim()) return;
		const event = parseCursorLine(line);
		if (!event) return;
		if (event.type === "init") {
			this.initAt ??= Date.now();
			this.cliSessionId = event.sessionId;
			return;
		}
		if (event.type === "toolStarted" || event.type === "toolCompleted") {
			this.handleTool(event);
			return;
		}
		// The CLI waits on held calls. Output now means it gave up on them.
		if (this.turn.finished) {
			this.endReason = "moved on while harness calls were held";
			console.error(`cursor-agent run ${this.run} moved on while harness tool calls were waiting; the next message replays.`);
			this.kill();
			return;
		}
		if ((event.type === "textDelta" || event.type === "thinkingDelta") && this.firstTokenAt === undefined) this.firstTokenAt = Date.now();
		switch (event.type) {
			case "thinkingDelta": this.turn.thinkingDelta(event.text); return;
			case "thinkingDone": this.turn.thinkingDone(); return;
			case "textDelta": this.turn.textDelta(event.text); return;
			case "textFlush": this.turn.textFlush(event.text); return;
			case "result":
				this.usage = event.usage;
				if (event.isError) {
					this.fail(event.text ? `cursor-agent: ${event.text.slice(0, 300)}` : "cursor-agent failed");
					return;
				}
				if (event.usage) this.turn.setUsage(event.usage);
				this.endReason = "completed";
				this.turn.finish();
				this.kill();
				return;
		}
	}

	private handleTool(event: Extract<CursorEvent, { type: "toolStarted" | "toolCompleted" }>): void {
		const { call } = event;
		if (call.kind === "native") {
			if (event.type === "toolCompleted") console.warn(`cursor-agent run ${this.run}: native ${call.name} came back ${event.outcome}`);
			return;
		}
		if (call.kind !== "mcp" || call.server !== BRIDGE_SERVER_NAME) return;
		const id = toPiToolCallId(event.callId);
		if (event.type === "toolStarted") {
			if (!this.intents.some((intent) => intent.id === id)) this.intents.push({ id, name: call.name, arguments: call.arguments });
			this.pair();
			return;
		}
		// A call that completes before reaching the bridge was refused by the CLI itself.
		const before = this.intents.length;
		this.intents = this.intents.filter((intent) => intent.id !== id);
		if (this.intents.length !== before) {
			console.warn(`cursor-agent run ${this.run}: harness tool ${call.name} came back ${event.outcome} before reaching LearnHarness`);
			this.flush();
		}
	}

	private handleClose(code: number | null): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		clearTimeout(this.batchTimer);
		removeLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		if (!this.turn.finished) {
			if (this.stderr.trim()) console.error("cursor-agent stderr:", this.stderr.trim());
			this.endReason = toErrorMessage(this.stderr, code);
			this.turn.fail(this.endReason, "error");
		}
		const usage = this.usage
			? `in ${this.usage.input}, out ${this.usage.output}, cache read ${this.usage.cacheRead}, cache write ${this.usage.cacheWrite}`
			: "not reported";
		console.info(`cursor-agent run ${this.run} (${this.replay ? "replay" : "fresh"}, session ${this.sessionId?.slice(0, 12) ?? "none"}) ended after ${seconds(Date.now() - this.startedAt)} s: ${this.endReason}; `
			+ `CLI ready ${this.initAt === undefined ? "never" : `${seconds(this.initAt - this.startedAt)} s`}; first token ${this.firstTokenAt === undefined ? "none" : `${seconds(this.firstTokenAt - this.startedAt)} s`}; pi turns ${this.turns}; tokens ${usage}`);
		Promise.all([this.bridge.close(), removeWorkspace(this.workspace, this.home, this.cliSessionId)]).catch((error: unknown) => {
			console.error("cursor-agent cleanup failed:", error);
		});
	}
}

function continueLiveProcess(turn: CursorTurn, owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], signal: AbortSignal | undefined): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []);
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof CursorProcess)) return false;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.expire("history changed while calls were held");
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

async function startProcess(
	runCursor: RunCursor,
	turn: CursorTurn,
	cliModel: string,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	location: CursorHome,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	const input = toCursorInput(context.messages);
	let cliProcess: CursorProcess | undefined;
	const bridge = await createCursorToolBridge(input.tools, {
		onCall: (call) => cliProcess ? cliProcess.onMcpCall(call) : call.respond(textResult("LearnHarness is not ready for this call.")),
		onError: (error) => cliProcess?.fail(error.message),
		onCancel: (call) => cliProcess?.onMcpCancel(call),
	});
	let workspace: CursorWorkspace;
	try {
		workspace = await createWorkspace(input.systemPrompt, bridge.mcpConfig, input.tools.map((tool) => tool.name));
	} catch (error) {
		await bridge.close();
		throw error;
	}
	const cleanup = () => Promise.all([bridge.close(), removeWorkspace(workspace, location.home, undefined)]);
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await cleanup();
		return;
	}

	let child: ChildProcessWithoutNullStreams | null;
	try {
		child = await runCursor(toCursorArgs({ model: cliModel, workspace: workspace.dir }), { cwd: workspace.dir, env, signal: options?.signal });
	} catch (error) {
		await cleanup();
		throw error;
	}
	if (!child) {
		turn.fail(CursorError.CliNotFound, "error");
		await cleanup();
		return;
	}

	cliProcess = new CursorProcess(
		child,
		bridge,
		workspace,
		location.home,
		turn,
		owner,
		options?.sessionId,
		configuration,
		structuredClone(conversationForReuse(context.messages)),
		input.replay,
	);
	cliProcess.start(input.prompt, options?.signal);
}

function failStart(turn: CursorTurn, options: SimpleStreamOptions | undefined, error: unknown): void {
	console.error("cursor-agent turn failed:", error);
	const aborted = options?.signal?.aborted === true;
	turn.fail(aborted ? ABORT_MESSAGE : error instanceof CursorLaunchError ? error.message : START_FAILED_MESSAGE, aborted ? "aborted" : "error");
}

export function createCursorStreamFunction(runCursor: RunCursor, home: () => CursorHome = cursorHome): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("cursor stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new CursorTurn(stream, model);
		const cliModel = toCursorModelId(model.id, options?.reasoning);
		const location = home();
		const env = cursorEnv(location.home);
		// A held process must not outlive a change of model, effort, prompt, tools or environment.
		const configuration = { request: configurationForReuse(model, context, cliModel), env };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;

		startProcess(runCursor, turn, cliModel, context, options, owner, configuration, location, env)
			.catch((error: unknown) => failStart(turn, options, error));
		return stream;
	};
}

export const streamCursor = createCursorStreamFunction(createCursorLauncher());
