import { createApiHandler } from "../../../../utils/apiHandler";
import { getDB } from "../../db";
import logger from '../../../../utils/logger.js';

const handler = createApiHandler({
  validate: (req) => {
    if (!['PATCH'].includes(req.method)) {
      return "Only PATCH method is allowed";
    }
    if (!req.query.id) {
      return "ID parameter is required";
    }
  },
  query: async (req) => {
    const { id } = req.query;
    const { linked_bank_account_id, custom_bank_account_number, custom_bank_account_nickname, is_hidden } = req.body;

    // Cards scraped before ownership tracking (or never claimed) have no card_ownership row,
    // so callers pass `last4:1234` instead of a numeric id. Derive vendor/credential from the
    // card's most recent transaction and create the row on the fly.
    // ponytail: single upsert covers both the move-card drag and CardVendorsModal linking.
    if (String(id).startsWith('last4:')) {
      const linkedId = linked_bank_account_id && linked_bank_account_id !== -1 ? linked_bank_account_id : null;
      return {
        sql: `
            INSERT INTO card_ownership (vendor, account_number, credential_id, linked_bank_account_id, custom_bank_account_number, custom_bank_account_nickname)
            SELECT t.vendor, t.account_number, vc.id, $2, $3, $4
            FROM transactions t
            JOIN vendor_credentials vc ON vc.vendor = t.vendor
            WHERE (CASE WHEN t.vendor = 'riseup' THEN t.account_number ELSE RIGHT(t.account_number, 4) END) = $1
              AND (t.transaction_type IS NULL OR t.transaction_type != 'bank')
            ORDER BY t.date DESC
            LIMIT 1
            ON CONFLICT (vendor, account_number)
            DO UPDATE SET
              linked_bank_account_id = $2,
              custom_bank_account_number = $3,
              custom_bank_account_nickname = $4
            RETURNING *
          `,
        params: [
          String(id).slice('last4:'.length),
          linkedId,
          linkedId ? null : (custom_bank_account_number ?? null),
          linkedId ? null : (custom_bank_account_nickname ?? null)
        ]
      };
    }

    // Build update query dynamically based on provided fields
    const updates = [];
    const params = [id];
    let paramIndex = 2;

    // Handle visibility toggle
    if (is_hidden !== undefined) {
      updates.push(`is_hidden = $${paramIndex}`);
      params.push(is_hidden);
      paramIndex++;
    }

    // Determine mode: Linking to existing account vs Custom account
    if (linked_bank_account_id && linked_bank_account_id !== -1) {
      // LINKING EXISTING ACCOUNT
      updates.push(`linked_bank_account_id = $${paramIndex}`);
      params.push(linked_bank_account_id);
      paramIndex++;

      // Clear custom fields
      updates.push(`custom_bank_account_number = NULL`);
      updates.push(`custom_bank_account_nickname = NULL`);
    } else if (custom_bank_account_number !== undefined || custom_bank_account_nickname !== undefined) {
      // SETTING CUSTOM ACCOUNT (if either field is provided)

      // Update number if provided
      if (custom_bank_account_number !== undefined) {
        updates.push(`custom_bank_account_number = $${paramIndex}`);
        params.push(custom_bank_account_number);
        paramIndex++;
      }

      // Update nickname if provided
      if (custom_bank_account_nickname !== undefined) {
        updates.push(`custom_bank_account_nickname = $${paramIndex}`);
        params.push(custom_bank_account_nickname);
        paramIndex++;
      }

      // Clear linked account if not explicitly set
      if (!linked_bank_account_id) {
        updates.push(`linked_bank_account_id = NULL`);
      }
    } else if (linked_bank_account_id === null) {
      // EXPLICITLY CLEARING LINKED ACCOUNT
      updates.push(`linked_bank_account_id = NULL`);
    }

    if (updates.length > 0) {
      return {
        sql: `
            UPDATE card_ownership 
            SET ${updates.join(', ')}
            WHERE id = $1
            RETURNING *
          `,
        params: params
      };
    } else {
      // No updates needed query (noop)
      return {
        sql: `SELECT * FROM card_ownership WHERE id = $1`,
        params: [id]
      };
    }
  },
  transform: async (result, req) => {
    if (req.method === 'PATCH' && !result.rows?.[0]) {
      // Nothing matched (unknown id, or no transaction/credential to derive ownership from)
      throw new Error(`No card_ownership row for ${req.query.id}`);
    }
    if (req.method === 'PATCH' && result.rows && result.rows[0]) {
      const row = result.rows[0];

      // Fetch bank account details if linked
      if (row.linked_bank_account_id) {
        const client = await getDB();
        try {
          const bankResult = await client.query(
            `SELECT id, nickname, bank_account_number, vendor FROM vendor_credentials WHERE id = $1`,
            [row.linked_bank_account_id]
          );

          if (bankResult.rows.length === 0) {
            // Bank account was deleted, return without it
            return {
              ...row,
              bank_account: null
            };
          }

          return {
            ...row,
            bank_account: bankResult.rows[0]
          };
        } catch (error) {
          logger.error({ error: error.message, stack: error.stack }, 'Error fetching bank account');
          return {
            ...row,
            bank_account: null
          };
        } finally {
          client.release();
        }
      }

      return {
        ...row,
        bank_account: null
      };
    }

    return { success: true };
  }
});

export default handler;
