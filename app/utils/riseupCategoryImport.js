import * as XLSX from 'xlsx';

// RiseUp's "cashflow" export (an .xlsx the user generates from inside the
// RiseUp app itself) carries the user's own manually-curated budget category
// per transaction ("קטגוריה בתזרים") - a different, more accurate concept
// than the generic auto-category RiseUp's public transactions API returns
// (which our scraper stores as-is; see riseup.js's mapTransaction). This
// module turns that export into a merchant-name -> category mapping we can
// trust enough to seed as categorization_rules.
const BUSINESS_NAME_HEADER = 'שם העסק';
const CATEGORY_HEADER = 'קטגוריה בתזרים';

const MIN_PATTERN_LEN = 4;

// Bare generic banking-mechanism words describe HOW money moved, not WHO it
// went to/from (standing order, withdrawal, credit, transfer, deposit,
// interest, fee). Seeding a rule from one of these as a whole name would
// silently recategorize every future unrelated transaction carrying the same
// generic label. Exact-match only - a specific name like "אתגרים הוראת קבע"
// is still a fine, safe pattern.
const GENERIC_DENYLIST = new Set([
  'הוראת-קבע', 'הוראת קבע', 'משיכה', 'משיכת מזומן', 'זיכוי', 'העברה',
  'הפקדה', 'ריבית', 'עמלה', 'עמלת בנק', 'חיוב', 'תשלום'
]);

function norm(s) {
  return (s || '').trim().toLowerCase();
}

/**
 * Parses a RiseUp cashflow export (.xlsx, as a Buffer) into
 * { businessName, category } rows, skipping anything missing either field.
 */
export function parseRiseupExport(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false });

  return rows
    .map(r => ({
      businessName: r[BUSINESS_NAME_HEADER],
      category: r[CATEGORY_HEADER]
    }))
    .filter(r => r.businessName && r.category);
}

/**
 * Builds a merchant-name -> category mapping from parsed export rows,
 * keeping only entries confident and specific enough to safely drive
 * automatic recategorization:
 *   - the category must be consistent (or dominant, >=70% with >=3 samples)
 *     across every appearance of that exact business name in the export
 *   - the name must be at least MIN_PATTERN_LEN characters
 *   - the name must not be a substring of any OTHER distinct business name in
 *     the same export (a fragment, not a full merchant identity - matching
 *     rules use substring search, so a fragment would hijack unrelated
 *     transactions)
 *   - the name must not be a bare generic banking-mechanism word
 *
 * Returns { confidentMap: Map<normalizedName, {category, originalName}>, stats }.
 */
export function buildConfidentMapping(rows) {
  const nameToCategoryCounts = new Map();
  const nameToOriginal = new Map();

  for (const r of rows) {
    const trimmed = r.businessName.trim();
    const key = norm(trimmed);
    if (!nameToCategoryCounts.has(key)) {
      nameToCategoryCounts.set(key, {});
      nameToOriginal.set(key, trimmed);
    }
    const counts = nameToCategoryCounts.get(key);
    counts[r.category] = (counts[r.category] || 0) + 1;
  }

  const allKeys = Array.from(nameToCategoryCounts.keys());
  function isFragmentOfAnotherName(key) {
    for (const other of allKeys) {
      if (other !== key && other.includes(key)) return true;
    }
    return false;
  }

  function modeCategory(counts) {
    let best = null, bestCount = -1, total = 0;
    for (const [cat, c] of Object.entries(counts)) {
      total += c;
      if (c > bestCount) { best = cat; bestCount = c; }
    }
    return { best, bestCount, total, pure: bestCount === total };
  }

  const confidentMap = new Map();
  const stats = { totalUniqueNames: allKeys.length, skippedLowConfidence: 0, skippedShort: 0, skippedGeneric: 0, skippedGenericStandalone: 0 };

  for (const [key, counts] of nameToCategoryCounts.entries()) {
    const { best, bestCount, total, pure } = modeCategory(counts);
    const confident = pure || (bestCount / total >= 0.7 && total >= 3);
    if (!confident) { stats.skippedLowConfidence++; continue; }

    const originalName = nameToOriginal.get(key);
    if (originalName.length < MIN_PATTERN_LEN) { stats.skippedShort++; continue; }
    if (GENERIC_DENYLIST.has(originalName)) { stats.skippedGenericStandalone++; continue; }
    if (isFragmentOfAnotherName(key)) { stats.skippedGeneric++; continue; }

    confidentMap.set(key, { category: best, originalName });
  }

  return { confidentMap, stats };
}
