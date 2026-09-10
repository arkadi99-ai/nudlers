-- Migration: allow pending categorization questions to expire.
--
-- A question nobody ever replies to would otherwise stay 'open' forever,
-- permanently blocking askAboutNextUnclearExpense() from re-asking about
-- that same merchant (or asking about anything else, if it's always
-- picked as the biggest one). The cron sweep marks stale open questions
-- 'expired' after 14 days.

ALTER TABLE pending_categorization_questions DROP CONSTRAINT IF EXISTS pending_categorization_questions_status_check;
ALTER TABLE pending_categorization_questions ADD CONSTRAINT pending_categorization_questions_status_check
    CHECK (status IN ('open', 'answered', 'expired'));
