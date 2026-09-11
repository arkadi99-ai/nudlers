-- Migration: remove the favorites feature.
--
-- The star/favorite toggle (added 2026-03-06 alongside an unrelated "notes"
-- feature) turned out to be a dead end in practice: favoriting a
-- transaction had exactly one effect anywhere in the app - filtering the
-- same transactions table to show only starred rows. No report, budget,
-- or insight ever consulted it. Removed after a real UX audit (2026-09-11)
-- flagged it as confusing, unlabeled clutter with no payoff. `notes` stays -
-- it's a genuinely used, separate feature that happened to ship in the
-- same commit.

DROP INDEX IF EXISTS idx_transactions_is_favorite;
ALTER TABLE transactions DROP COLUMN IF EXISTS is_favorite;
