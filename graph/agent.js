import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { AgentState } from "./state.js";
import { callModel, routeTools } from "./nodes.js";
import { tools } from "./tools.js";

function buildAgentGraph() {
  const workflow = new StateGraph(AgentState).addNode("agent", callModel);

  if (tools.length > 0) {
    const toolNode = new ToolNode(tools);

    workflow
      .addNode("tools", toolNode)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", routeTools, ["tools", END])
      .addEdge("tools", "agent");
  } else {
    workflow.addEdge(START, "agent").addEdge("agent", END);
  }

  return workflow.compile({ recursionLimit: 15 });
}

export const agentGraph = buildAgentGraph();

function getFinalAiMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!AIMessage.isInstance(message)) continue;

    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) =>
                typeof part === "string" ? part : (part?.text ?? "")
              )
              .join("")
              .trim()
          : "";

    if (text) {
      return text;
    }
  }

  return "";
}

export async function runAgent(prompt, userContext = "") {
  const result = await agentGraph.invoke({
    prompt,
    aismsg: "",
    userContext: userContext || "",
    messages: [new HumanMessage(prompt)],
  });

  return {
    prompt: result.prompt,
    aismsg: result.aismsg || getFinalAiMessage(result.messages),
  };
}
