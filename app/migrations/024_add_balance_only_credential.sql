-- Migration: balance-only credentials.
--
-- Some credentials (e.g. a direct bank connection kept alongside a fuller
-- aggregator like RiseUp) are only meant to report a real account balance,
-- never insert transactions - RiseUp already has that data, and re-syncing
-- the direct connection duplicates every bank-side transaction. Previously
-- this was "enforced" only by the user remembering not to click sync for
-- that credential - fragile, and it silently regressed (see 2026-09-06
-- duplicate-transaction incident). Now enforced in code
-- (processScrapedAccounts), not by memory.

ALTER TABLE vendor_credentials ADD COLUMN IF NOT EXISTS balance_only BOOLEAN NOT NULL DEFAULT false;
