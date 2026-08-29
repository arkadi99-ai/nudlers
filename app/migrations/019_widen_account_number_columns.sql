-- Migration: widen account-number-ish columns to TEXT.
--
-- Added for the RiseUp integration: RiseUp identifies accounts with an opaque
-- `accountNumberHash` (a real hash, not "last 4 digits"), which is much longer
-- than the VARCHAR(4)/VARCHAR(50) these columns were sized for when only
-- direct-bank scrapers and Moneytor (which both return real last-4-digit
-- numbers) existed. Without this, saving a RiseUp account's nickname/type or
-- inserting its transactions would fail with "value too long for type".
--
-- TEXT has no length limit and is a strict superset of VARCHAR(n) - existing
-- data is preserved untouched and no application code needs to change.
--
-- Idempotent, following the pattern from 016_widen_credential_columns.sql.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'card_vendors'
      AND column_name = 'last4_digits'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE card_vendors ALTER COLUMN last4_digits TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'card_ownership'
      AND column_name = 'account_number'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE card_ownership ALTER COLUMN account_number TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transactions'
      AND column_name = 'account_number'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE transactions ALTER COLUMN account_number TYPE TEXT;
  END IF;
END $$;
