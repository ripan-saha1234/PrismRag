-- 1. Create sessions table for anonymous users
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create messages table
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL, 
    content TEXT NOT NULL,
    metadata JSONB,            -- stores extra info like router decision, sources, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create index for fast lookups by session
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);

-- 4. Create Onboarding / Poll Questions table (Step 1 & 2 in Flow)
CREATE TABLE IF NOT EXISTS onboarding_questions (
    id SERIAL PRIMARY KEY,
    question_text TEXT NOT NULL,
    question_type VARCHAR(50) DEFAULT 'mcq', -- 'mcq', 'poll', 'single_choice'
    options JSONB NOT NULL DEFAULT '[]'::jsonb, -- e.g. ["Engineering", "Product", "Design", "Other"]
    sort_order INT NOT NULL DEFAULT 1,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Create Session Survey Answers table (Step 4 & 5 in Flow)
CREATE TABLE IF NOT EXISTS session_survey_answers (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    question_id INT NOT NULL REFERENCES onboarding_questions(id) ON DELETE CASCADE,
    selected_option TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(session_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_session_survey_answers_session_id ON session_survey_answers(session_id);

-- 6. In case tables were created with older column schemas, ensure columns exist:
ALTER TABLE onboarding_questions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE onboarding_questions ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 1;
ALTER TABLE onboarding_questions ADD COLUMN IF NOT EXISTS question_type VARCHAR(50) DEFAULT 'mcq';
ALTER TABLE onboarding_questions ADD COLUMN IF NOT EXISTS options JSONB DEFAULT '[]'::jsonb;
ALTER TABLE session_survey_answers ADD COLUMN IF NOT EXISTS selected_option TEXT;

-- 7. Seed initial default questions if needed
INSERT INTO onboarding_questions (question_text, question_type, options, sort_order, is_active)
SELECT 'What is your primary role or interest?', 'mcq', '["Software Engineer / Developer", "Product Manager / Designer", "Business / Leadership", "Researcher / Student", "Other"]'::jsonb, 1, TRUE
WHERE NOT EXISTS (SELECT 1 FROM onboarding_questions);

INSERT INTO onboarding_questions (question_text, question_type, options, sort_order, is_active)
SELECT 'How familiar are you with AI / RAG systems?', 'mcq', '["Brand new to AI", "Have used ChatGPT/LLMs", "Actively building AI applications", "Expert / Researcher"]'::jsonb, 2, TRUE
WHERE (SELECT COUNT(*) FROM onboarding_questions) = 1;
