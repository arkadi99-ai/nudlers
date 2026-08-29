-- Adds an open "account type" label (credit card / bank account / other),
-- decoupled from card_vendor (which is a card BRAND for icon display) and
-- from transaction_type (internal plumbing). Needed since a single
-- credential (e.g. Moneytor) can now aggregate many real-world accounts of
-- different types.
ALTER TABLE card_vendors ADD COLUMN IF NOT EXISTS account_type VARCHAR(30);
