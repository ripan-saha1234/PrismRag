import "./config.js";
import { tool } from "@langchain/core/tools";
import { TavilySearch } from "@langchain/tavily";
import { z } from "zod";

const tavilyClient = new TavilySearch({
  maxResults: 5,
  topic: "general",
  tavilyApiKey: process.env.TAVILY_API_KEY,
});

// Wrap Tavily with a query-only schema so Groq never sends null/empty optional fields
// (timeRange: null causes tool_use_failed validation errors).
export const tavilySearch = tool(
  async ({ query }) => {
    const result = await tavilyClient.invoke({ query });
    return typeof result === "string" ? result : JSON.stringify(result);
  },
  {
    name: "tavily_search",
    description:
      "Search the public web for current events or general information that is NOT about Web Prism Dynamics LLP. Company questions are answered from the vector database, not this tool.",
    schema: z.object({
      query: z.string().describe("The web search query"),
    }),
  }
);

export const tools = [tavilySearch];

export const toolsByName = Object.fromEntries(
  tools.map((t) => [t.name, t])
);
