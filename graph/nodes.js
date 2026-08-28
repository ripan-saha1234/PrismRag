import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { END } from "@langchain/langgraph";
import { buildSystemPrompt } from "../knowledge/loadKnowledge.js";
import {
  formatRetrievedContext,
  searchCompanyKnowledge,
} from "../knowledge/vectorstore.js";
import { llm } from "./llm.js";
import { tools } from "./tools.js";

export const llmWithTools =
  tools.length > 0
    ? llm.bindTools(tools, { parallel_tool_calls: false })
    : llm;

function getMessageText(message) {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("")
      .trim();
  }

  return "";
}

function getUserQuery(state) {
  if (state.prompt?.trim()) {
    return state.prompt.trim();
  }

  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (!HumanMessage.isInstance(message)) continue;

    const text = getMessageText(message);
    if (text) return text;
  }

  return "";
}

export async function callModel(state) {
  const query = getUserQuery(state);
  const hits = query ? await searchCompanyKnowledge(query) : [];
  const context = formatRetrievedContext(hits);

  const response = await llmWithTools.invoke([
    new SystemMessage(buildSystemPrompt(context, state.userContext || "")),
    ...state.messages,
  ]);

  const aismsg = getMessageText(response);

  return {
    messages: [response],
    aismsg,
  };
}

export function routeTools(state) {
  const lastMessage = state.messages.at(-1);

  if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
    return END;
  }

  if (lastMessage.tool_calls?.length) {
    return "tools";
  }

  return END;
}
