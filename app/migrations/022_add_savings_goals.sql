-- Migration: savings goals.
--
-- Named financial goals (e.g. "טיול תאילנד") with a target amount and an
-- optional target date. Progress is updated manually by the user (no
-- automatic bank-account linkage exists yet - only the main checking
-- account reports a real balance today). Future features (the proactive
-- WhatsApp agent) read this table directly to reference progress in
-- messages - no extra plumbing needed when that's built.

CREATE TABLE IF NOT EXISTS savings_goals (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    target_amount NUMERIC(12, 2) NOT NULL,
    current_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    target_date DATE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
