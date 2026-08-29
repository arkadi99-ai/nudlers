-- card_vendor (a card BRAND like visa/mastercard) is no longer required -
-- a bank account or other non-card source has no brand, only an
-- account_type and/or nickname.
ALTER TABLE card_vendors ALTER COLUMN card_vendor DROP NOT NULL;
