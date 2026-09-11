import { getDB } from '../db';
import logger from '../../../utils/logger.js';
import { parseRiseupExport, buildConfidentMapping } from '../../../utils/riseupCategoryImport';
import { applyActiveCategorizationRules } from './apply-rules';

/**
 * POST /api/categories/import-riseup-export
 * Body: { fileBase64: string } - a RiseUp "cashflow" .xlsx export, generated
 * from inside the RiseUp app (Settings -> Export, or similar). RiseUp's own
 * public transactions API only exposes a generic auto-category per
 * transaction, not the user's own manually-curated budget categorization
 * this export carries - see riseupCategoryImport.js for why we trust this
 * file instead. Seeds categorization_rules from confident merchant->category
 * mappings found in the export, then retroactively applies all active rules
 * to existing transactions (same effect as the "Apply to Existing" button).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { fileBase64 } = req.body;
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    return res.status(400).json({ error: 'fileBase64 is required' });
  }

  let buffer;
  try {
    buffer = Buffer.from(fileBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'fileBase64 is not valid base64' });
  }

  let rows;
  try {
    rows = parseRiseupExport(buffer);
  } catch (error) {
    logger.error({ error: error.message }, '[RiseUp Import] Failed to parse export file');
    return res.status(400).json({ error: 'Could not read this file as a RiseUp cashflow export (.xlsx)' });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'No usable rows found - expected columns "שם העסק" and "קטגוריה בתזרים"' });
  }

  const { confidentMap, stats } = buildConfidentMapping(rows);

  const client = await getDB();
  try {
    let rulesInserted = 0;
    for (const { category, originalName } of confidentMap.values()) {
      const result = await client.query(
        `INSERT INTO categorization_rules (name_pattern, target_category, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (name_pattern, target_category) DO NOTHING`,
        [originalName, category]
      );
      rulesInserted += result.rowCount;
    }

    const { rulesApplied, transactionsUpdated } = await applyActiveCategorizationRules(client);

    logger.info({
      totalRows: rows.length,
      confidentMappings: confidentMap.size,
      rulesInserted,
      transactionsUpdated
    }, '[RiseUp Import] Import complete');

    res.status(200).json({
      success: true,
      totalRows: rows.length,
      uniqueMerchants: stats.totalUniqueNames,
      confidentMappings: confidentMap.size,
      skippedLowConfidence: stats.skippedLowConfidence,
      skippedShort: stats.skippedShort,
      skippedGeneric: stats.skippedGeneric + stats.skippedGenericStandalone,
      rulesInserted,
      rulesApplied,
      transactionsUpdated
    });
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, '[RiseUp Import] Error importing categorization');
    res.status(500).json({ error: 'Failed to import categorization', message: error.message });
  } finally {
    client.release();
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb'
    }
  }
};
