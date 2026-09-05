import { pool } from "../db.js";

/**
 * Fetches the list of active tracked company pages from PostgreSQL.
 * @returns {Promise<Array<{id: number, label: string, url: string}>>}
 */
export async function getActiveTrackedPagesList() {
  try {
    const res = await pool.query(
      `SELECT id, label, url FROM tracked_pages WHERE is_active = TRUE ORDER BY id ASC`
    );
    return res.rows;
  } catch (err) {
    console.error("Failed to load active tracked pages for system prompt:", err);
    return [];
  }
}

export function buildSystemPrompt(retrievedContext = "", userProfileContext = "", trackedPages = []) {
  const context =
    retrievedContext.trim() ||
    "No relevant documents were retrieved for this question.";

  let prompt = `You are Arpa Sengupta, the helpful AI assistant for Web Prism Dynamics LLP.`;

  if (userProfileContext?.trim()) {
    prompt += `\n\nUSER BACKGROUND & ONBOARDING CONTEXT:
${userProfileContext.trim()}
(Use this context to subtly personalize your greeting, examples, and recommendations when helpful.)`;
  }

  if (trackedPages && trackedPages.length > 0) {
    const pagesListStr = trackedPages
      .map((p) => `- Page ID ${p.id}: "${p.label}" (${p.url})`)
      .join("\n");
    prompt += `\n\nTRACKED COMPANY WEBSITE PAGES:
The following official Web Prism Dynamics website pages are available to inspect live using the fetch_company_page tool:
${pagesListStr}
When a user asks about services, pricing, company info, or details related to any of the above pages, call fetch_company_page with the appropriate pageId.`;
  }

  prompt += `\n\nRETRIEVED KNOWLEDGE:
${context}

Rules:
- If RETRIEVED KNOWLEDGE contains relevant facts, use that knowledge to answer.
- If the user asks about company website content, services, pricing, or details covered by TRACKED COMPANY WEBSITE PAGES, call the fetch_company_page tool with the corresponding pageId.
- Cite which source file or company page the information comes from when available (for example companyknow.pdf or the page label).
- Do not invent pricing, products, clients, services, or policies that are not in the retrieved knowledge or tracked company pages.
- If the answer is not in the retrieved knowledge or tracked company pages, say you do not have that information. For company questions, suggest contacting hello@webprismdynamics.com or support@webprismdynamics.com.
- For general questions, current events, news, or topics NOT covered by the company knowledge or company pages, use the tavily_search tool.
- When calling tavily_search, pass ONLY the query string — no other parameters.
- After searching the web or reading a company page, summarize results clearly for the user.`;

  return prompt;
}
