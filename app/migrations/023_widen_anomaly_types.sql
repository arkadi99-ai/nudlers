-- Migration: widen anomalies.type to include two new detectors.
--
-- rising_trend: a category climbing 3 straight full months (a sustained
-- drift no single week/transaction looks abnormal enough to catch alone).
-- unflagged_recurring: an established recurring charge (3+ of the last 4
-- months, near-constant amount) that was never tagged a "fixed" commitment
-- and has aged out of new_recurring's 2-3-month "new" window.

ALTER TABLE anomalies DROP CONSTRAINT IF EXISTS anomalies_type_check;
ALTER TABLE anomalies ADD CONSTRAINT anomalies_type_check
    CHECK (type IN ('price_hike', 'new_recurring', 'category_spike', 'rising_trend', 'unflagged_recurring'));
