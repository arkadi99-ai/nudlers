-- Migration: pending categorization questions.
--
-- Tracks a "what was this charge?" question the WhatsApp social agent asked
-- in the family group, keyed by the WhatsApp message ID it was sent as.
-- When someone in the group replies by QUOTING that exact message (WhatsApp's
-- own reply-to feature), the incoming-message listener matches the quoted
-- message ID back to a row here to know which merchant to categorize -
-- never acts on free-floating chat, only direct replies to its own questions.

CREATE TABLE IF NOT EXISTS pending_categorization_questions (
    id SERIAL PRIMARY KEY,
    description TEXT NOT NULL,
    amount NUMERIC(12, 2),
    wa_message_id TEXT NOT NULL,
    group_jid TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    answer_text TEXT,
    resolved_category TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    answered_at TIMESTAMP,
    CHECK (status IN ('open', 'answered'))
);

CREATE INDEX IF NOT EXISTS idx_pending_categorization_open_message
    ON pending_categorization_questions (wa_message_id)
    WHERE status = 'open';
