import express from "express";
import cors from "cors";
import multer from "multer";
import "./graph/config.js";
import { runAgent } from "./graph/agent.js";
import {
  ingestKnowledgePdfs,
  ingestUploadedPdf,
  listKnowledgeDocuments,
  deleteKnowledgeDocument,
  getCollectionPointCount,
} from "./knowledge/vectorstore.js";
import { pool, initDb } from "./db.js";
import {
  analyzeSessionInsights,
  getSessionInsights,
  getInsightsOverview,
} from "./insights/analyzer.js";
import { fetchPageContent, refreshTrackedPages } from "./knowledge/pageFetchers.js";

const app = express();
const port = process.env.PORT || 3000;

const corsOptions = {
  origin(origin, callback) {
    // Allow same-origin, server-to-server, and local dev frontends (Live Server, etc.)
    callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use(express.static("public"));

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");

    if (isPdf) cb(null, true);
    else cb(new Error("Only PDF files are allowed."));
  },
});

// Helper: Format user survey answers into a concise string for LLM context
async function getUserSurveyContext(sessionId) {
  if (!sessionId) return "";
  try {
    const result = await pool.query(
      `SELECT q.question_text, a.selected_option 
       FROM session_survey_answers a
       JOIN onboarding_questions q ON a.question_id = q.id
       WHERE a.session_id = $1
       ORDER BY q.sort_order ASC`,
      [sessionId]
    );

    if (result.rows.length === 0) return "";
    return result.rows
      .map((r) => `- ${r.question_text}: ${r.selected_option}`)
      .join("\n");
  } catch (err) {
    console.error("Error fetching survey context:", err);
    return "";
  }
}

// ----------------------------------------------------
// 1. RAG AI Chat Endpoint (Phase 2)
// ----------------------------------------------------
app.post("/ai", async (req, res) => {
  try {
    const { input, sessionId } = req.body;

    if (!input?.trim()) {
      return res.status(400).json({ error: "Message input is required." });
    }

    const trimmedInput = input.trim();

    // 1. Ensure session exists and save user message
    if (sessionId) {
      try {
        await pool.query(
          `INSERT INTO chat_sessions (id, last_active_at)
           VALUES ($1, NOW())
           ON CONFLICT (id) DO UPDATE SET last_active_at = NOW()`,
          [sessionId]
        );

        await pool.query(
          `INSERT INTO chat_messages (session_id, role, content)
           VALUES ($1, $2, $3)`,
          [sessionId, "user", trimmedInput]
        );
      } catch (dbErr) {
        console.error("Failed to save user message to DB:", dbErr);
      }
    }

    // 2. Fetch personalized onboarding survey context for this user session
    const userContext = await getUserSurveyContext(sessionId);

    // 3. Run agentic RAG workflow with survey context
    const state = await runAgent(trimmedInput, userContext);
    const botResponse = state.aismsg || state.prompt || "";

    // 4. Save assistant message
    if (sessionId) {
      try {
        await pool.query(
          `INSERT INTO chat_messages (session_id, role, content, metadata)
           VALUES ($1, $2, $3, $4)`,
          [sessionId, "assistant", botResponse, JSON.stringify(state)]
        );
      } catch (dbErr) {
        console.error("Failed to save bot response to DB:", dbErr);
      }

      analyzeSessionInsights(pool, sessionId).catch((err) => {
        console.error("Session insight analysis failed:", err.message);
      });
    }

    return res.status(200).json(state);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message ?? "Failed to generate a response.",
    });
  }
});

// ----------------------------------------------------
// 2. Client Onboarding Survey Endpoints (Phase 1)
// ----------------------------------------------------

// Get all active questions for the chatbot onboarding flow
app.get("/api/onboarding/questions", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, question_text, question_type, options, sort_order 
       FROM onboarding_questions 
       WHERE is_active = TRUE 
       ORDER BY sort_order ASC, id ASC`
    );
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching onboarding questions:", error);
    return res.status(500).json({ error: "Failed to fetch onboarding questions." });
  }
});

// Get session onboarding progress / answered questions
app.get("/api/onboarding/status/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const answered = await pool.query(
      `SELECT question_id, selected_option, created_at 
       FROM session_survey_answers 
       WHERE session_id = $1`,
      [sessionId]
    );

    const totalActive = await pool.query(
      `SELECT COUNT(*)::int AS count FROM onboarding_questions WHERE is_active = TRUE`
    );

    const totalCount = totalActive.rows[0]?.count || 0;
    const answeredCount = answered.rows.length;

    return res.status(200).json({
      completed: totalCount > 0 && answeredCount >= totalCount,
      totalQuestions: totalCount,
      answeredCount,
      answers: answered.rows,
    });
  } catch (error) {
    console.error("Error fetching onboarding status:", error);
    return res.status(500).json({ error: "Failed to fetch onboarding status." });
  }
});

// Save user's answer to a survey question
app.post("/api/onboarding/answers", async (req, res) => {
  try {
    const { sessionId, questionId, selectedOption } = req.body;

    if (!sessionId || !questionId || !selectedOption) {
      return res.status(400).json({ error: "sessionId, questionId, and selectedOption are required." });
    }

    // Ensure session exists
    await pool.query(
      `INSERT INTO chat_sessions (id, last_active_at)
       VALUES ($1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_active_at = NOW()`,
      [sessionId]
    );

    // Upsert answer - populate both selected_option and selected_options (as JSON array) to satisfy legacy schemas
    const result = await pool.query(
      `INSERT INTO session_survey_answers (session_id, question_id, selected_option, selected_options, created_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (session_id, question_id) 
       DO UPDATE SET selected_option = $3, selected_options = $4::jsonb, created_at = NOW()
       RETURNING *`,
      [sessionId, questionId, selectedOption, JSON.stringify([selectedOption])]
    );

    return res.status(200).json({ success: true, answer: result.rows[0] });
  } catch (error) {
    console.error("Error saving survey answer:", error);
    return res.status(500).json({ error: "Failed to save survey answer." });
  }
});

// ----------------------------------------------------
// 3. Admin Panel Question Management & Analytics
// ----------------------------------------------------

// List all questions for admin
app.get("/api/admin/questions", async (req, res) => {
  try {
    const query = `
      SELECT 
        q.id,
        q.question_text,
        q.question_type,
        q.options,
        q.sort_order,
        q.is_active,
        q.created_at,
        COUNT(a.id)::int AS response_count
      FROM onboarding_questions q
      LEFT JOIN session_survey_answers a ON q.id = a.question_id
      GROUP BY q.id
      ORDER BY q.sort_order ASC, q.id ASC
    `;
    const result = await pool.query(query);
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Admin fetch questions error:", error);
    return res.status(500).json({ error: "Failed to retrieve questions." });
  }
});

// Create new question
app.post("/api/admin/questions", async (req, res) => {
  try {
    const { question_text, question_type = "mcq", options = [], sort_order, is_active = true } = req.body;

    if (!question_text?.trim()) {
      return res.status(400).json({ error: "Question text is required." });
    }

    let order = sort_order;
    if (order === undefined || order === null) {
      const maxOrderRes = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM onboarding_questions`);
      order = maxOrderRes.rows[0].next_order;
    }

    const result = await pool.query(
      `INSERT INTO onboarding_questions (question_text, question_type, options, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [question_text.trim(), question_type, JSON.stringify(options), order, is_active]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Admin create question error:", error);
    return res.status(500).json({ error: "Failed to create question." });
  }
});

// Update question
app.put("/api/admin/questions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { question_text, question_type, options, sort_order, is_active } = req.body;

    const currentRes = await pool.query(`SELECT * FROM onboarding_questions WHERE id = $1`, [id]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: "Question not found." });
    }
    const current = currentRes.rows[0];

    const result = await pool.query(
      `UPDATE onboarding_questions
       SET question_text = COALESCE($1, question_text),
           question_type = COALESCE($2, question_type),
           options = COALESCE($3, options),
           sort_order = COALESCE($4, sort_order),
           is_active = COALESCE($5, is_active)
       WHERE id = $6
       RETURNING *`,
      [
        question_text !== undefined ? question_text.trim() : current.question_text,
        question_type !== undefined ? question_type : current.question_type,
        options !== undefined ? JSON.stringify(options) : current.options,
        sort_order !== undefined ? sort_order : current.sort_order,
        is_active !== undefined ? is_active : current.is_active,
        id,
      ]
    );

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Admin update question error:", error);
    return res.status(500).json({ error: "Failed to update question." });
  }
});

// Delete question
app.delete("/api/admin/questions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM onboarding_questions WHERE id = $1 RETURNING id`, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Question not found." });
    }
    return res.status(200).json({ message: "Question deleted successfully.", id });
  } catch (error) {
    console.error("Admin delete question error:", error);
    return res.status(500).json({ error: "Failed to delete question." });
  }
});

// Reorder questions
app.post("/api/admin/questions/reorder", async (req, res) => {
  try {
    const { orderedIds } = req.body; // Array of IDs in new order: [3, 1, 2]
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: "orderedIds array is required." });
    }

    for (let i = 0; i < orderedIds.length; i++) {
      await pool.query(`UPDATE onboarding_questions SET sort_order = $1 WHERE id = $2`, [i + 1, orderedIds[i]]);
    }

    return res.status(200).json({ success: true, message: "Order updated successfully." });
  } catch (error) {
    console.error("Admin reorder questions error:", error);
    return res.status(500).json({ error: "Failed to reorder questions." });
  }
});

// Survey analytics breakdown
app.get("/api/admin/survey-analytics", async (req, res) => {
  try {
    const questionsRes = await pool.query(
      `SELECT id, question_text, question_type, options, sort_order, is_active 
       FROM onboarding_questions 
       ORDER BY sort_order ASC, id ASC`
    );

    const answersRes = await pool.query(
      `SELECT question_id, selected_option, COUNT(*)::int AS count 
       FROM session_survey_answers 
       GROUP BY question_id, selected_option`
    );

    const responseMap = {};
    for (const row of answersRes.rows) {
      if (!responseMap[row.question_id]) responseMap[row.question_id] = {};
      responseMap[row.question_id][row.selected_option] = row.count;
    }

    const analytics = questionsRes.rows.map((q) => {
      const breakdown = responseMap[q.id] || {};
      const totalAnswers = Object.values(breakdown).reduce((a, b) => a + b, 0);
      const optionsArray = Array.isArray(q.options) ? q.options : (typeof q.options === "string" ? JSON.parse(q.options) : []);
      
      const stats = optionsArray.map((opt) => {
        const count = breakdown[opt] || 0;
        const percentage = totalAnswers > 0 ? Math.round((count / totalAnswers) * 100) : 0;
        return { option: opt, count, percentage };
      });

      return {
        id: q.id,
        question_text: q.question_text,
        question_type: q.question_type,
        is_active: q.is_active,
        totalAnswers,
        stats,
      };
    });

    return res.status(200).json(analytics);
  } catch (error) {
    console.error("Admin survey analytics error:", error);
    return res.status(500).json({ error: "Failed to retrieve survey analytics." });
  }
});

// ----------------------------------------------------
// 4. Admin Session & Conversation Analytics (Existing)
// ----------------------------------------------------

app.get("/api/admin/stats", async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM chat_sessions)::int AS total_sessions,
        (SELECT COUNT(*) FROM chat_messages)::int AS total_messages,
        (SELECT COUNT(*) FROM chat_messages WHERE role = 'user')::int AS total_user_queries,
        (SELECT COUNT(*) FROM chat_sessions WHERE last_active_at >= NOW() - INTERVAL '24 HOURS')::int AS active_last_24h,
        (SELECT COUNT(DISTINCT session_id) FROM session_survey_answers)::int AS completed_onboardings
    `;
    const result = await pool.query(statsQuery);
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Admin stats error:", error);
    return res.status(500).json({ error: "Failed to retrieve statistics." });
  }
});

function buildAdminSessionFilters(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 25));
  const search = query.search?.trim() || "";
  const filter = query.filter?.trim() || "all";
  const leadType = query.lead_type?.trim() || "";
  const sentiment = query.sentiment?.trim() || "";
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];

  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (search) {
    const searchParam = addParam(`%${search}%`);
    conditions.push(`(
      s.id::text ILIKE ${searchParam}
      OR EXISTS (
        SELECT 1 FROM chat_messages cm
        WHERE cm.session_id = s.id AND cm.content ILIKE ${searchParam}
      )
    )`);
  }

  if (filter === "with_messages") {
    conditions.push(
      `EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.session_id = s.id)`
    );
  } else if (filter === "with_survey") {
    conditions.push(
      `EXISTS (SELECT 1 FROM session_survey_answers a WHERE a.session_id = s.id)`
    );
  } else if (filter === "analyzed") {
    conditions.push(`si.session_id IS NOT NULL`);
  } else if (filter === "pending_analysis") {
    conditions.push(
      `si.session_id IS NULL AND EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.session_id = s.id)`
    );
  }

  if (leadType) {
    conditions.push(`si.lead_type = ${addParam(leadType)}`);
  }

  if (sentiment) {
    conditions.push(`si.sentiment = ${addParam(sentiment)}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const baseFrom = `
    FROM chat_sessions s
    LEFT JOIN session_insights si ON si.session_id = s.id
    ${whereClause}
  `;

  const selectQuery = `
    SELECT
      s.id,
      s.created_at,
      s.last_active_at,
      (SELECT COUNT(*)::int FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
      (
        SELECT m2.content
        FROM chat_messages m2
        WHERE m2.session_id = s.id
        ORDER BY m2.created_at DESC
        LIMIT 1
      ) AS last_message,
      (
        SELECT m3.role
        FROM chat_messages m3
        WHERE m3.session_id = s.id
        ORDER BY m3.created_at DESC
        LIMIT 1
      ) AS last_message_role,
      (
        SELECT COUNT(*)::int
        FROM session_survey_answers a
        WHERE a.session_id = s.id
      ) AS survey_answers_count,
      si.sentiment,
      si.sentiment_score,
      si.lead_score,
      si.icp_fit_score,
      si.lead_type,
      si.intent,
      si.ideal_customer_verdict,
      si.analyzed_at
    ${baseFrom}
    ORDER BY s.last_active_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const countQuery = `SELECT COUNT(*)::int AS total ${baseFrom}`;

  return {
    page,
    limit,
    offset,
    params,
    countQuery,
    selectQuery,
    selectParams: [...params, limit, offset],
  };
}

app.get("/api/admin/sessions", async (req, res) => {
  try {
    const {
      page,
      limit,
      countQuery,
      selectQuery,
      selectParams,
      params,
    } = buildAdminSessionFilters(req.query);

    const [countResult, sessionsResult] = await Promise.all([
      pool.query(countQuery, params),
      pool.query(selectQuery, selectParams),
    ]);

    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.status(200).json({
      data: sessionsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Admin sessions error:", error);
    return res.status(500).json({ error: "Failed to retrieve sessions list." });
  }
});

app.get("/api/admin/sessions/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(sessionId)) {
      return res.status(400).json({ error: "Invalid session UUID format." });
    }

    const sessionRes = await pool.query(
      `SELECT id, created_at, last_active_at FROM chat_sessions WHERE id = $1`,
      [sessionId]
    );

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: "Session not found." });
    }

    const messagesRes = await pool.query(
      `SELECT id, role, content, metadata, created_at 
       FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at ASC`,
      [sessionId]
    );

    const surveyRes = await pool.query(
      `SELECT q.question_text, q.question_type, a.selected_option, a.created_at
       FROM session_survey_answers a
       JOIN onboarding_questions q ON a.question_id = q.id
       WHERE a.session_id = $1
       ORDER BY q.sort_order ASC`,
      [sessionId]
    );

    const insights = await getSessionInsights(pool, sessionId);

    return res.status(200).json({
      session: sessionRes.rows[0],
      messages: messagesRes.rows,
      surveyAnswers: surveyRes.rows,
      insights,
    });
  } catch (error) {
    console.error("Admin session detail error:", error);
    return res.status(500).json({ error: "Failed to retrieve session details." });
  }
});

app.delete("/api/admin/sessions/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await pool.query(`DELETE FROM chat_sessions WHERE id = $1 RETURNING id`, [sessionId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Session not found." });
    }

    return res.status(200).json({ message: "Session and conversation deleted successfully.", id: sessionId });
  } catch (error) {
    console.error("Delete session error:", error);
    return res.status(500).json({ error: "Failed to delete session." });
  }
});

// ----------------------------------------------------
// 5. AI Insights — Sentiment & ICP Scoring
// ----------------------------------------------------

app.get("/api/admin/insights/overview", async (_req, res) => {
  try {
    const data = await getInsightsOverview(pool);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Insights overview error:", error);
    return res.status(500).json({ error: error.message ?? "Failed to load insights overview." });
  }
});

app.get("/api/admin/sessions/:sessionId/insights", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const insights = await getSessionInsights(pool, sessionId);
    if (!insights) {
      return res.status(404).json({ error: "No insights generated for this session yet." });
    }
    return res.status(200).json(insights);
  } catch (error) {
    console.error("Get session insights error:", error);
    return res.status(500).json({ error: error.message ?? "Failed to load session insights." });
  }
});

app.post("/api/admin/sessions/:sessionId/insights/analyze", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const insights = await analyzeSessionInsights(pool, sessionId);
    return res.status(200).json(insights);
  } catch (error) {
    console.error("Analyze session insights error:", error);
    return res.status(500).json({ error: error.message ?? "Failed to analyze session." });
  }
});

// ----------------------------------------------------
// 6. Knowledge Base / Document Ingestion (Admin)
// ----------------------------------------------------

app.get("/api/admin/documents", async (_req, res) => {
  try {
    const [documents, totalChunks] = await Promise.all([
      listKnowledgeDocuments(),
      getCollectionPointCount(),
    ]);

    return res.status(200).json({
      documents,
      totalDocuments: documents.length,
      totalChunks,
    });
  } catch (error) {
    console.error("List documents error:", error);
    return res.status(500).json({ error: error.message ?? "Failed to list documents." });
  }
});

app.post("/api/admin/documents/upload", pdfUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "PDF file is required." });
    }

    const result = await ingestUploadedPdf(req.file.buffer, req.file.originalname);
    return res.status(201).json({
      message: "Document uploaded and indexed successfully.",
      ...result,
    });
  } catch (error) {
    console.error("Document upload error:", error);
    return res.status(500).json({ error: error.message ?? "Failed to upload document." });
  }
});

app.delete("/api/admin/documents", async (req, res) => {
  try {
    const source = req.query.source?.trim();
    if (!source) {
      return res.status(400).json({ error: "source query parameter is required." });
    }

    await deleteKnowledgeDocument(source);
    return res.status(200).json({
      message: "Document removed from vector database.",
      source,
    });
  } catch (error) {
    console.error("Delete document error:", error);
    return res.status(500).json({ error: error.message ?? "Failed to delete document." });
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }
  if (error?.message === "Only PDF files are allowed.") {
    return res.status(400).json({ error: error.message });
  }
  return next(error);
});

// ----------------------------------------------------
// Admin Tracked Company Pages Routes
// ----------------------------------------------------
app.get("/api/admin/pages", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, label, url, page_type, is_active, last_fetched_at, last_fetch_status, last_fetch_error, cache_updated_at
       FROM tracked_pages
       ORDER BY id ASC`
    );
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching tracked pages:", error);
    return res.status(500).json({ error: "Failed to retrieve tracked pages." });
  }
});

app.post("/api/admin/pages", async (req, res) => {
  try {
    const { label, url, page_type = "auto" } = req.body;

    if (!label?.trim() || !url?.trim()) {
      return res.status(400).json({ error: "Both label and url are required." });
    }

    const cleanType = ["auto", "static", "react"].includes(page_type?.toLowerCase())
      ? page_type.toLowerCase()
      : "auto";

    const result = await pool.query(
      `INSERT INTO tracked_pages (label, url, page_type, is_active)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, label, url, page_type, is_active, last_fetched_at, last_fetch_status, last_fetch_error, cache_updated_at`,
      [label.trim(), url.trim(), cleanType]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating tracked page:", error);
    if (error.code === "23505") {
      return res.status(409).json({ error: "A page with this URL is already tracked." });
    }
    return res.status(500).json({ error: error.message || "Failed to create tracked page." });
  }
});

app.put("/api/admin/pages/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { label, url, page_type, is_active } = req.body;

    const existing = await pool.query(`SELECT * FROM tracked_pages WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Tracked page not found." });
    }

    const current = existing.rows[0];
    const newLabel = label !== undefined ? label.trim() : current.label;
    const newUrl = url !== undefined ? url.trim() : current.url;
    let newType = page_type !== undefined ? page_type.toLowerCase() : current.page_type;
    if (!["auto", "static", "react"].includes(newType)) {
      newType = current.page_type;
    }
    const newIsActive = is_active !== undefined ? Boolean(is_active) : current.is_active;

    const result = await pool.query(
      `UPDATE tracked_pages
       SET label = $1, url = $2, page_type = $3, is_active = $4
       WHERE id = $5
       RETURNING id, label, url, page_type, is_active, last_fetched_at, last_fetch_status, last_fetch_error, cache_updated_at`,
      [newLabel, newUrl, newType, newIsActive, id]
    );

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error updating tracked page:", error);
    if (error.code === "23505") {
      return res.status(409).json({ error: "Another page with this URL already exists." });
    }
    return res.status(500).json({ error: error.message || "Failed to update tracked page." });
  }
});

app.delete("/api/admin/pages/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM tracked_pages WHERE id = $1 RETURNING id`, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tracked page not found." });
    }

    return res.status(200).json({ message: "Tracked page deleted successfully.", id });
  } catch (error) {
    console.error("Error deleting tracked page:", error);
    return res.status(500).json({ error: "Failed to delete tracked page." });
  }
});

app.post("/api/admin/pages/:id/test-fetch", async (req, res) => {
  try {
    const { id } = req.params;
    const pageRes = await pool.query(`SELECT id, label, url, page_type FROM tracked_pages WHERE id = $1`, [id]);

    if (pageRes.rows.length === 0) {
      return res.status(404).json({ error: "Tracked page not found." });
    }

    const page = pageRes.rows[0];
    const text = await fetchPageContent(page.url, page.page_type);

    return res.status(200).json({
      id: page.id,
      label: page.label,
      url: page.url,
      page_type: page.page_type,
      extracted_length: text.length,
      extracted_text: text,
    });
  } catch (error) {
    console.error("Error in test-fetch:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch page content." });
  }
});

app.post("/api/admin/pages/refresh-all", async (req, res) => {
  try {
    const summary = await refreshTrackedPages();
    return res.status(200).json({
      message: "Refreshed tracked pages.",
      summary,
    });
  } catch (error) {
    console.error("Error during manual refresh of tracked pages:", error);
    return res.status(500).json({ error: error.message || "Failed to refresh pages." });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  initDb()
    .then(async () => {
      // Refresh tracked pages once on startup, then every 3 hours
      refreshTrackedPages().catch((err) => {
        console.error("Initial refresh of tracked pages failed:", err);
      });

      const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
      setInterval(() => {
        refreshTrackedPages().catch((err) => {
          console.error("Scheduled refresh of tracked pages failed:", err);
        });
      }, THREE_HOURS_MS);
    })
    .catch((err) => console.error("Database init error:", err));

  ingestKnowledgePdfs().catch((error) => {
    console.error("Failed to ingest PDFs:", error);
  });
});
