import { getDB } from "../db";
import logger from '../../../utils/logger.js';

export default async function handler(req, res) {
  const client = await getDB();

  try {
    if (req.method === "GET") {
      const result = await client.query(
        `SELECT id, name, target_amount, current_amount, target_date
         FROM savings_goals
         ORDER BY created_at ASC`
      );
      res.status(200).json(result.rows);
    } else if (req.method === "POST") {
      const { id, name, target_amount, current_amount, target_date } = req.body || {};

      if (!name || target_amount === undefined || target_amount === null) {
        return res.status(400).json({ error: "name and target_amount are required" });
      }

      let result;
      if (id) {
        result = await client.query(
          `UPDATE savings_goals
           SET name = $2, target_amount = $3, current_amount = $4, target_date = $5, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [id, name, target_amount, current_amount ?? 0, target_date || null]
        );
      } else {
        result = await client.query(
          `INSERT INTO savings_goals (name, target_amount, current_amount, target_date)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [name, target_amount, current_amount ?? 0, target_date || null]
        );
      }

      res.status(200).json(result.rows[0]);
    } else if (req.method === "DELETE") {
      const { id } = req.body || {};

      if (!id) {
        return res.status(400).json({ error: "id is required" });
      }

      await client.query("DELETE FROM savings_goals WHERE id = $1", [id]);
      res.status(200).json({ success: true });
    } else {
      res.setHeader("Allow", ["GET", "POST", "DELETE"]);
      res.status(405).end(`Method ${req.method} Not Allowed`);
    }
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, "Error in savings_goals API");
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
}
