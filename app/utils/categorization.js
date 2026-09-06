/**
 * Shared core of "set a category for every transaction with this exact
 * name, and optionally remember it as a rule for next time." Used by both
 * the manual UI (update-by-description.js) and the WhatsApp categorization
 * listener (a family member answering the agent's "what was this charge?"
 * question) - one place, so the two can never drift on what "categorize a
 * merchant" actually does to the database.
 *
 * @param {import('pg').PoolClient} client - an already-checked-out client; caller owns BEGIN/COMMIT/release outside if needed, but this function manages its own transaction.
 * @param {{ description: string, newCategory: string, createRule?: boolean }} params
 */
export async function updateCategoryByDescription(client, { description, newCategory, createRule = true }) {
    await client.query('BEGIN');
    try {
        const updateResult = await client.query(`
            UPDATE transactions
            SET category = $2
            WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
        `, [description, newCategory]);

        let ruleCreated = false;
        let ruleUpdated = false;

        if (createRule) {
            const existingRule = await client.query(`
                SELECT id FROM categorization_rules WHERE LOWER(TRIM(name_pattern)) = LOWER(TRIM($1))
            `, [description]);

            if (existingRule.rows.length > 0) {
                await client.query(`
                    UPDATE categorization_rules
                    SET target_category = $2, updated_at = CURRENT_TIMESTAMP, is_active = true
                    WHERE LOWER(TRIM(name_pattern)) = LOWER(TRIM($1))
                `, [description, newCategory]);
                ruleUpdated = true;
            } else {
                await client.query(`
                    INSERT INTO categorization_rules (name_pattern, target_category, is_active)
                    VALUES ($1, $2, true)
                `, [description, newCategory]);
                ruleCreated = true;
            }
        }

        await client.query('COMMIT');
        return {
            success: true,
            transactionsUpdated: updateResult.rowCount,
            ruleCreated,
            ruleUpdated,
            description,
            newCategory
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}
