import "./config.js";
import { tool } from "@langchain/core/tools";
import { TavilySearch } from "@langchain/tavily";
import { z } from "zod";
import { pool } from "../db.js";

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
      "Search the public web for current events or general information that is NOT in the company/knowledge PDFs or tracked company pages. Do not use this when the vector database or tracked pages already have the answer.",
    schema: z.object({
      query: z.string().describe("The web search query"),
    }),
  }
);

export const fetchCompanyPage = tool(
  async ({ pageId }) => {
    try {
      const result = await pool.query(
        `SELECT id, label, url, page_content_cache, cache_updated_at, is_active
         FROM tracked_pages
         WHERE id = $1`,
        [pageId]
      );

      if (result.rows.length === 0) {
        return `Page with ID ${pageId} was not found in tracked company pages.`;
      }

      const page = result.rows[0];
      if (!page.is_active) {
        return `Tracked page "${page.label}" (ID: ${page.id}) is currently disabled/inactive.`;
      }

      if (!page.page_content_cache || !page.page_content_cache.trim()) {
        return `Content not yet available for page "${page.label}" (ID: ${page.id}), please try again shortly.`;
      }

      const updatedStr = page.cache_updated_at
        ? new Date(page.cache_updated_at).toISOString()
        : "Unknown";

      return `--- Company Page: ${page.label} (${page.url}) [Last Cached: ${updatedStr}] ---\n\n${page.page_content_cache}`;
    } catch (err) {
      console.error("Error in fetchCompanyPage tool:", err);
      return `Failed to retrieve content for page ID ${pageId}: ${err.message}`;
    }
  },
  {
    name: "fetch_company_page",
    description:
      "Fetches the cached live content of an official Web Prism Dynamics company website page by pageId. Use this when the user asks questions about specific company website pages, services, or pricing outlined on the tracked company pages.",
    schema: z.object({
      pageId: z.number().describe("The integer ID of the tracked company page to fetch content for"),
    }),
  }
);

export const tools = [tavilySearch, fetchCompanyPage];

export const toolsByName = Object.fromEntries(
  tools.map((t) => [t.name, t])
);
