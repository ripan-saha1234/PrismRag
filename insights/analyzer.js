import { readFileSync, existsSync, readdirSync } from "fs";
import { dirname, join, extname } from "path";
import { fileURLToPath } from "url";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { llm } from "../graph/llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANALYSIS_DOCS_DIR = join(__dirname, "..", "knowledge", "analysis-docs");
const ANALYSIS_DOC_EXTENSIONS = new Set([".md", ".txt"]);

function getMessageText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("")
      .trim();
  }
  return "";
}

function parseJsonFromModel(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

function loadAnalysisDocuments() {
  if (!existsSync(ANALYSIS_DOCS_DIR)) return "";

  const files = readdirSync(ANALYSIS_DOCS_DIR)
    .filter((name) => ANALYSIS_DOC_EXTENSIONS.has(extname(name).toLowerCase()))
    .filter((name) => name.toLowerCase() !== "readme.md")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (!files.length) return "";

  return files
    .map((name) => {
      const content = readFileSync(join(ANALYSIS_DOCS_DIR, name), "utf-8").trim();
      return `--- ${name} ---\n${content}`;
    })
    .join("\n\n");
}

export async function fetchSessionData(pool, sessionId) {
  const [surveyRes, messagesRes] = await Promise.all([
    pool.query(
      `SELECT q.question_text, a.selected_option
       FROM session_survey_answers a
       JOIN onboarding_questions q ON a.question_id = q.id
       WHERE a.session_id = $1
       ORDER BY q.sort_order ASC`,
      [sessionId]
    ),
    pool.query(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    ),
  ]);

  const surveyProfile = surveyRes.rows
    .map((row) => `- ${row.question_text}: ${row.selected_option}`)
    .join("\n");

  const messages = messagesRes.rows;
  const transcript = messages
    .map((m) => `[${m.role.toUpperCase()}] ${m.content}`)
    .join("\n");

  return { surveyProfile, messages, transcript };
}

export async function analyzeSessionInsights(pool, sessionId) {
  const { surveyProfile, messages, transcript } = await fetchSessionData(
    pool,
    sessionId
  );

  if (!messages.length) {
    throw new Error("No chat messages to analyze for this session.");
  }

  const transcriptSample = transcript.slice(-6000);
  const analysisDocs = loadAnalysisDocuments();

  const systemPrompt = `You are a sales intelligence analyst for Web Prism Dynamics LLP.

Analyze the user's onboarding profile and chat transcript. Score sentiment and ICP fit using:
1. Your own reasoning about buyer intent, engagement, and commercial signals
2. ONLY the analysis guideline documents below (ICP, sentiment rules, lead scoring). Do not use outside assumptions that conflict with these docs.

Return ONLY valid JSON (no markdown) with this exact shape:
{
  "sentiment": "positive" | "neutral" | "negative",
  "sentiment_score": number between -1 and 1,
  "lead_score": integer 0-100,
  "icp_fit_score": integer 0-100,
  "lead_type": "hot" | "warm" | "cold",
  "intent": "short intent label",
  "topics": ["topic1", "topic2"],
  "engagement_level": "low" | "medium" | "high",
  "summary": "2-3 sentence conversation summary",
  "icp_reasoning": "why this person matches or does not match the ICP",
  "profile_signals": ["signal from onboarding profile"],
  "chat_signals": ["signal from chat messages"],
  "recommended_action": "specific next step for sales/support",
  "ideal_customer_verdict": "one sentence: how ideal this customer is"
}

ANALYSIS GUIDELINE DOCUMENTS (from knowledge/analysis-docs/):
${analysisDocs || "No analysis documents found. Add .md or .txt files to knowledge/analysis-docs/."}`;

  const userPrompt = `SESSION ID: ${sessionId}

ONBOARDING PROFILE:
${surveyProfile || "No onboarding answers saved."}

CHAT TRANSCRIPT:
${transcriptSample || "No transcript."}`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ]);

  let analysis;
  try {
    analysis = parseJsonFromModel(getMessageText(response));
  } catch {
    throw new Error("AI returned invalid analysis JSON.");
  }

  const result = await pool.query(
    `INSERT INTO session_insights (
      session_id, sentiment, sentiment_score, lead_score, icp_fit_score,
      lead_type, intent, topics, engagement_level, summary, icp_reasoning,
      profile_signals, chat_signals, recommended_action, ideal_customer_verdict,
      raw_analysis, analyzed_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
      $12::jsonb, $13::jsonb, $14, $15, $16::jsonb, NOW()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      sentiment = EXCLUDED.sentiment,
      sentiment_score = EXCLUDED.sentiment_score,
      lead_score = EXCLUDED.lead_score,
      icp_fit_score = EXCLUDED.icp_fit_score,
      lead_type = EXCLUDED.lead_type,
      intent = EXCLUDED.intent,
      topics = EXCLUDED.topics,
      engagement_level = EXCLUDED.engagement_level,
      summary = EXCLUDED.summary,
      icp_reasoning = EXCLUDED.icp_reasoning,
      profile_signals = EXCLUDED.profile_signals,
      chat_signals = EXCLUDED.chat_signals,
      recommended_action = EXCLUDED.recommended_action,
      ideal_customer_verdict = EXCLUDED.ideal_customer_verdict,
      raw_analysis = EXCLUDED.raw_analysis,
      analyzed_at = NOW()
    RETURNING *`,
    [
      sessionId,
      analysis.sentiment ?? "neutral",
      analysis.sentiment_score ?? 0,
      analysis.lead_score ?? 0,
      analysis.icp_fit_score ?? 0,
      analysis.lead_type ?? "cold",
      analysis.intent ?? "unknown",
      JSON.stringify(analysis.topics ?? []),
      analysis.engagement_level ?? "low",
      analysis.summary ?? "",
      analysis.icp_reasoning ?? "",
      JSON.stringify(analysis.profile_signals ?? []),
      JSON.stringify(analysis.chat_signals ?? []),
      analysis.recommended_action ?? "",
      analysis.ideal_customer_verdict ?? "",
      JSON.stringify(analysis),
    ]
  );

  return result.rows[0];
}

export async function getSessionInsights(pool, sessionId) {
  const result = await pool.query(
    `SELECT * FROM session_insights WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

export async function getInsightsOverview(pool) {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS analyzed_sessions,
      COALESCE(ROUND(AVG(lead_score)), 0)::int AS avg_lead_score,
      COALESCE(ROUND(AVG(icp_fit_score)), 0)::int AS avg_icp_score,
      COUNT(*) FILTER (WHERE lead_type = 'hot')::int AS hot_leads,
      COUNT(*) FILTER (WHERE lead_type = 'warm')::int AS warm_leads,
      COUNT(*) FILTER (WHERE lead_type = 'cold')::int AS cold_leads,
      COUNT(*) FILTER (WHERE sentiment = 'positive')::int AS positive_sentiment,
      COUNT(*) FILTER (WHERE sentiment = 'neutral')::int AS neutral_sentiment,
      COUNT(*) FILTER (WHERE sentiment = 'negative')::int AS negative_sentiment
    FROM session_insights
  `);

  return {
    overview: result.rows[0],
  };
}
