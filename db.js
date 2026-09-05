import "./graph/config.js";
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") || process.env.DATABASE_URL?.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false },
});

export async function initDb() {
  const createTablesQuery = `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id UUID PRIMARY KEY,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);

    CREATE TABLE IF NOT EXISTS onboarding_questions (
      id SERIAL PRIMARY KEY,
      question_text TEXT NOT NULL,
      question_type VARCHAR(50) DEFAULT 'mcq',
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INT NOT NULL DEFAULT 1,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS session_survey_answers (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      question_id INT NOT NULL REFERENCES onboarding_questions(id) ON DELETE CASCADE,
      selected_option TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE(session_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS tracked_pages (
      id SERIAL PRIMARY KEY,
      label VARCHAR NOT NULL,
      url TEXT NOT NULL UNIQUE,
      page_type VARCHAR NOT NULL DEFAULT 'auto',
      is_active BOOLEAN DEFAULT TRUE,
      last_fetched_at TIMESTAMP WITH TIME ZONE,
      last_fetch_status VARCHAR,
      last_fetch_error TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;

  // Auto-migration to handle any existing tables created with older column schemas
  const migrationQuery = `
    ALTER TABLE onboarding_questions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    ALTER TABLE onboarding_questions ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 1;
    ALTER TABLE onboarding_questions ADD COLUMN IF NOT EXISTS question_type VARCHAR(50) DEFAULT 'mcq';
    ALTER TABLE onboarding_questions ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '[]'::jsonb;
    
    ALTER TABLE session_survey_answers ADD COLUMN IF NOT EXISTS selected_option TEXT;
    
    ALTER TABLE tracked_pages ADD COLUMN IF NOT EXISTS page_content_cache TEXT;
    ALTER TABLE tracked_pages ADD COLUMN IF NOT EXISTS cache_updated_at TIMESTAMP WITH TIME ZONE;
    
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'session_survey_answers' AND column_name = 'selected_options'
      ) THEN
        ALTER TABLE session_survey_answers ALTER COLUMN selected_options DROP NOT NULL;
        UPDATE session_survey_answers 
        SET selected_option = COALESCE(selected_option, selected_options::text)
        WHERE selected_option IS NULL;
      END IF;
    END $$;
  `;

  const seedQuery = `
    INSERT INTO onboarding_questions (question_text, question_type, options, sort_order, is_active)
    SELECT 'What is your primary role or interest?', 'mcq', '["Software Engineer / Developer", "Product Manager / Designer", "Business / Leadership", "Researcher / Student", "Other"]'::jsonb, 1, TRUE
    WHERE NOT EXISTS (SELECT 1 FROM onboarding_questions);

    INSERT INTO onboarding_questions (question_text, question_type, options, sort_order, is_active)
    SELECT 'How familiar are you with AI / RAG systems?', 'mcq', '["Brand new to AI", "Have used ChatGPT/LLMs", "Actively building AI applications", "Expert / Researcher"]'::jsonb, 2, TRUE
    WHERE (SELECT COUNT(*) FROM onboarding_questions) = 1;
  `;

  try {
    await pool.query(createTablesQuery);
    await pool.query(migrationQuery);
    await pool.query(seedQuery);
    console.log("✅ PostgreSQL schema synced and verified (tables, columns & seed questions).");
  } catch (err) {
    console.error("Error initializing database tables:", err);
  }
}
