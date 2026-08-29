-- Migration: add commitment_type to transactions.
--
-- RiseUp's own API classifies every transaction's category as belonging to a
-- "fixed" or "variable" budget envelope (their own user-configured budget,
-- not a nudlers-side guess). This powers a real "what will I owe next month
-- with zero further spending" projection, sourced directly from data the
-- user already curated in RiseUp, rather than nudlers statistically guessing
-- recurring patterns from transaction history.
--
-- Nullable and vendor-agnostic: only populated for RiseUp for now, NULL for
-- every other vendor (no behavior change for them).

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS commitment_type VARCHAR(20);
