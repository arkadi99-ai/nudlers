-- Migration: add owner to card_vendors.
--
-- A single financial-source credential (RiseUp, previously Moneytor) can
-- aggregate accounts/cards belonging to different family members. This lets
-- the user tag each real account with who it belongs to, the same way
-- account_type already tags what kind of account it is.
--
-- Nullable free text (mirrors account_type): the UI offers a fixed set of
-- common values but the column itself doesn't enforce them.

ALTER TABLE card_vendors ADD COLUMN IF NOT EXISTS owner VARCHAR(50);
