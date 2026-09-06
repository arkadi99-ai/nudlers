import { createApiHandler } from "../../../utils/apiHandler";
import { getDB } from "../db";
import logger from '../../../utils/logger.js';
import { updateCategoryByDescription } from "../../../utils/categorization.js";

/**
 * POST /api/categories/update-by-description
 * Update category for all transactions with a given description and optionally create a rule.
 */
const handler = createApiHandler({
    validate: (req) => {
        if (req.method !== 'POST') return "Only POST method is allowed";
        const { description, newCategory } = req.body;
        if (!description || !newCategory) return "description and newCategory are required";
    },
    query: async () => ({ sql: 'SELECT 1' }),
    transform: async (result, req) => {
        const { description, newCategory, createRule = true } = req.body;
        const client = await getDB();
        try {
            return await updateCategoryByDescription(client, { description, newCategory, createRule });
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Error updating category by description');
            throw error;
        } finally {
            client.release();
        }
    }
});

export default handler;
