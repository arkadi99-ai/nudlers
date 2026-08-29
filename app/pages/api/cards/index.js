import { getDB } from "../db";
import logger from '../../../utils/logger.js';

export default async function handler(req, res) {
  const client = await getDB();

  try {
    if (req.method === "GET") {
      // Get all unique account numbers from transactions and their associated card vendors.
      // Real bank/card account numbers are matched by their last 4 digits (a physical card
      // reported by two different credentials should still merge into one row here) - but
      // RiseUp identifies accounts with an opaque hash, not real digits, so truncating it
      // to 4 characters risks colliding two unrelated accounts. RiseUp accounts are matched
      // by their full identifier instead.
      const result = await client.query(`
        WITH unique_cards AS (
          SELECT DISTINCT
            CASE WHEN vendor = 'riseup' THEN account_number ELSE RIGHT(account_number, 4) END as last4_digits,
            COUNT(*) as transaction_count
          FROM transactions
          WHERE account_number IS NOT NULL
            AND account_number != ''
            AND (vendor = 'riseup' OR LENGTH(account_number) >= 4)
          GROUP BY CASE WHEN vendor = 'riseup' THEN account_number ELSE RIGHT(account_number, 4) END
        )
        SELECT
          uc.last4_digits,
          uc.transaction_count,
          cv.card_vendor,
          cv.card_nickname,
          cv.account_type,
          cv.id as card_vendor_id,
          co.id as card_ownership_id,
          co.linked_bank_account_id,
          ba.id as bank_account_id,
          ba.nickname as bank_account_nickname,
          ba.bank_account_number,
          ba.vendor as bank_account_vendor,
          co.custom_bank_account_number,
          co.custom_bank_account_nickname
        FROM unique_cards uc
        LEFT JOIN card_vendors cv ON uc.last4_digits = cv.last4_digits
        LEFT JOIN card_ownership co ON uc.last4_digits = CASE WHEN co.vendor = 'riseup' THEN co.account_number ELSE RIGHT(co.account_number, 4) END
        LEFT JOIN vendor_credentials ba ON co.linked_bank_account_id = ba.id
        ORDER BY uc.transaction_count DESC
      `);

      res.status(200).json(result.rows);
    } else if (req.method === "POST") {
      // Create or update a card vendor mapping
      const { last4_digits, card_vendor, card_nickname, account_type } = req.body || {};

      if (!last4_digits) {
        return res.status(400).json({ error: "last4_digits is required" });
      }

      // Upsert the card vendor. card_vendor (a card BRAND, for icon display)
      // is optional now - a bank account or investment fund has no brand,
      // only an account_type.
      const result = await client.query(
        `INSERT INTO card_vendors (last4_digits, card_vendor, card_nickname, account_type, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (last4_digits)
         DO UPDATE SET
           card_vendor = EXCLUDED.card_vendor,
           card_nickname = EXCLUDED.card_nickname,
           account_type = EXCLUDED.account_type,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [last4_digits, card_vendor || null, card_nickname || null, account_type || null]
      );

      res.status(200).json(result.rows[0]);
    } else if (req.method === "DELETE") {
      // Delete a card vendor mapping
      const { last4_digits } = req.body || {};

      if (!last4_digits) {
        return res.status(400).json({ error: "last4_digits is required" });
      }

      await client.query(
        "DELETE FROM card_vendors WHERE last4_digits = $1",
        [last4_digits]
      );

      res.status(200).json({ success: true });
    } else {
      res.setHeader("Allow", ["GET", "POST", "DELETE"]);
      res.status(405).end(`Method ${req.method} Not Allowed`);
    }
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, "Error in card_vendors API");
    // Debug logging handled by pino logger above
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
}
