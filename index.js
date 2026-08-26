import express from "express";
import cors from "cors";
import "./graph/config.js";
import { runAgent } from "./graph/agent.js";
import { ingestCompanyPdf } from "./knowledge/vectorstore.js";
import { pool, initDb } from "./db.js";

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.post("/ai", async (req, res) => {
  try {
    const { input, sessionId } = req.body;

    if (!input?.trim()) {
      return res.status(400).json({ error: "Message input is required." });
    }

    const trimmedInput = input.trim();

    // 1. If sessionId is provided, ensure session exists and save user message
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

    // 2. Run agentic RAG workflow
    const state = await runAgent(trimmedInput);
    const botResponse = state.aismsg || state.prompt || "";

    // 3. Save assistant message if sessionId is present
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
    }

    return res.status(200).json(state);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message ?? "Failed to generate a response.",
    });
  }
});

// ==========================================
// ADMIN API ROUTES 
// ==========================================

// 1. Get analytics / summary stats for admin dashboard
app.get("/api/admin/stats", async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM chat_sessions)::int AS total_sessions,
        (SELECT COUNT(*) FROM chat_messages)::int AS total_messages,
        (SELECT COUNT(*) FROM chat_messages WHERE role = 'user')::int AS total_user_queries,
        (SELECT COUNT(*) FROM chat_sessions WHERE last_active_at >= NOW() - INTERVAL '24 HOURS')::int AS active_last_24h
    `;
    const result = await pool.query(statsQuery);
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Admin stats error:", error);
    return res.status(500).json({ error: "Failed to retrieve statistics." });
  }
});

// 2. Paginated list of user sessions with search, message counts, and last snippet
app.get("/api/admin/sessions", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = req.query.search?.trim() || "";
    const offset = (page - 1) * limit;

    let countQuery = `SELECT COUNT(DISTINCT s.id)::int AS total FROM chat_sessions s`;
    let sessionsQuery = `
      SELECT 
        s.id,
        s.created_at,
        s.last_active_at,
        COUNT(m.id)::int AS message_count,
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
        ) AS last_message_role
      FROM chat_sessions s
      LEFT JOIN chat_messages m ON s.id = m.session_id
    `;

    const queryParams = [];
    const countParams = [];

    if (search) {
      countQuery += ` LEFT JOIN chat_messages cm ON s.id = cm.session_id WHERE s.id::text ILIKE $1 OR cm.content ILIKE $1`;
      countParams.push(`%${search}%`);

      sessionsQuery += ` WHERE s.id::text ILIKE $1 OR m.content ILIKE $1`;
      queryParams.push(`%${search}%`);
    }

    sessionsQuery += `
      GROUP BY s.id
      ORDER BY s.last_active_at DESC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;
    queryParams.push(limit, offset);

    const [countResult, sessionsResult] = await Promise.all([
      pool.query(countQuery, countParams),
      pool.query(sessionsQuery, queryParams),
    ]);

    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);

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

// 3. Get full conversation transcript and metadata for a specific session
app.get("/api/admin/sessions/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Validate UUID format
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

    return res.status(200).json({
      session: sessionRes.rows[0],
      messages: messagesRes.rows,
    });
  } catch (error) {
    console.error("Admin session detail error:", error);
    return res.status(500).json({ error: "Failed to retrieve session details." });
  }
});

// 4. Delete a session and its message cascade
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  initDb().catch((err) => console.error("Database init error:", err));
  ingestCompanyPdf().catch((error) => {
    console.error("Failed to ingest PDF:", error);
  });
});

