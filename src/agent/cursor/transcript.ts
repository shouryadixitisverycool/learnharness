import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

export type CursorInput = {
	systemPrompt: string;
	tools: Tool[];
	/** The whole stdin prompt. */
	prompt: string;
	/** True when the prompt replays earlier turns instead of carrying one fresh message. */
	replay: boolean;
};

const REPLAY_HEADER = [
	"[LearnHarness replay]",
	"This lesson is already in progress. A new session is picking it up, so the conversation so far is below, oldest first. You are the tutor in it.",
	"Every tool call below already ran and its result is final: never call a tool again for a call that has a result. When you asked the learner a question with a tool, their answer is that call's result.",
].join("\n");

function contentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => block.type === "text" ? block.text : `[image attached (${block.mimeType}); this model cannot see images]`).join("\n");
}

function renderMessage(message: Message): string[] {
	switch (message.role) {
		case "system":
			return [];

		case "user":
			return [`[learner]\n${contentText(message.content)}`];

		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return block.text.trim() ? [`[tutor]\n${block.text}`] : [];
				if (block.type === "toolCall") return [`[tutor called tool ${block.name}, call id ${block.id}]\n${JSON.stringify(block.arguments)}`];
				return [];
			});

		case "toolResult": {
			const label = `[result of ${message.toolName}, call id ${message.toolCallId}${message.isError ? ", error" : ""}]`;
			return [`${label}\n${contentText(message.content)}`];
		}
	}
}

function closingInstruction(last: Message | undefined): string {
	if (last?.role === "toolResult") {
		return "[end of replay]\nThe latest entries above are the results of your tool calls. Continue the lesson as the tutor from there.";
	}
	return "[end of replay]\nReply as the tutor to the learner's latest message above.";
}

/** The system prompt goes to the workspace rules file; only the conversation goes to stdin. */
export function toCursorInput(messages: Message[]): CursorInput {
	const conversation = messages.filter((message) => message.role !== "system");
	const systemPrompt = getCurrentSystemPrompt(messages);
	const tools = getCurrentTools(messages);
	const [first] = conversation;

	if (conversation.length === 1 && first?.role === "user") {
		return { systemPrompt, tools, prompt: contentText(first.content), replay: false };
	}

	const body = conversation.flatMap(renderMessage).join("\n\n");
	return {
		systemPrompt,
		tools,
		prompt: `${REPLAY_HEADER}\n\n${body}\n\n${closingInstruction(conversation.at(-1))}\n`,
		replay: true,
	};
}
