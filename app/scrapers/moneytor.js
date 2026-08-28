import logger from '../utils/logger.js';

const MONEYTOR_BASE_URL = 'https://app.moneytor.co.il/api/v1';
const PAGE_LIMIT = 2000;

function formatDateParam(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// Category names Moneytor uses for bank-side "meta" entries that are not
// real spending: the monthly lump-sum credit-card settlement debit (already
// counted once via the itemized card purchases), and inter-account transfers.
// Matched by exact name first, then by keyword as a safety net for names we
// haven't seen yet.
const BANK_META_EXACT = new Set(['CREDIT_CARD_CHECKING', 'BANK_TRANSFER']);
const BANK_META_KEYWORDS = ['TRANSFER', 'CHECKING'];

function prettifyCategory(rawCategory) {
  if (!rawCategory) return null;
  return rawCategory
    .split('_')
    .map(word => (word === '&' ? word : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * Decide the nudlers-facing category for a raw Moneytor transaction.
 *
 * Positive amounts (money in) are always "Income" regardless of Moneytor's
 * own label - salary sometimes comes through generically as "OTHER", and
 * nudlers' own spending queries already exclude the 'Income' category
 * everywhere, so this is the most reliable way to keep inflows out of
 * spending totals.
 *
 * Negative amounts matching a known bank-meta category (the credit card
 * company's monthly settlement debit, or a transfer) are tagged "Bank" -
 * same reasoning: nudlers already excludes 'Bank' from spending sums, and
 * the settlement debit would otherwise double-count every purchase that's
 * already itemized on the card feed.
 *
 * Everything else is real, itemized spending - keep it, just prettified.
 */
function classifyCategory(raw) {
  if (typeof raw.amount === 'number' && raw.amount > 0) {
    return 'Income';
  }

  const rawCategory = raw.category || '';
  const upper = rawCategory.toUpperCase();
  if (BANK_META_EXACT.has(upper) || BANK_META_KEYWORDS.some(kw => upper.includes(kw))) {
    return 'Bank';
  }

  return prettifyCategory(raw.category);
}

function mapTransaction(raw) {
  return {
    identifier: raw.id,
    date: raw.date,
    processedDate: raw.date,
    originalAmount: raw.amount,
    originalCurrency: raw.currency,
    chargedAmount: raw.amount,
    description: raw.description || raw.extra_info || 'Unknown',
    memo: raw.extra_info || null,
    status: 'completed',
    category: classifyCategory(raw),
    type: 'normal'
  };
}

function groupByAccount(rawTransactions) {
  const byAccount = new Map();
  for (const raw of rawTransactions) {
    const accountNumber = raw.accountNumber || raw.accountId || 'unknown';
    if (!byAccount.has(accountNumber)) {
      byAccount.set(accountNumber, { accountNumber, txns: [] });
    }
    byAccount.get(accountNumber).txns.push(mapTransaction(raw));
  }
  return Array.from(byAccount.values());
}

/**
 * Fetch transactions from the Moneytor API (a licensed Israeli Open Banking
 * data provider) and adapt them into the same { success, accounts } shape
 * that israeli-bank-scrapers produces, so the rest of the app (dedup,
 * categorization, budgets, insights, WhatsApp, AI chat) works unchanged.
 */
export async function scrapeMoneytor(credentials, startDate) {
  const apiKey = credentials?.apiKey;
  if (!apiKey) {
    return { success: false, errorType: 'INVALID_CREDENTIALS', errorMessage: 'Missing Moneytor API key' };
  }

  const from = formatDateParam(startDate);
  const allTransactions = [];
  let offset = 0;

  try {
    while (true) {
      const url = `${MONEYTOR_BASE_URL}/transactions?from=${from}&limit=${PAGE_LIMIT}&offset=${offset}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        logger.error({ status: response.status, bodyText }, '[Moneytor] API request failed');
        const errorType = response.status === 401 || response.status === 403
          ? 'INVALID_CREDENTIALS'
          : 'ScrapingError';
        return { success: false, errorType, errorMessage: `Moneytor API returned ${response.status}` };
      }

      const data = await response.json();
      allTransactions.push(...(data.transactions || []));

      if (!data.hasMore) break;
      offset = data.nextOffset ?? (offset + PAGE_LIMIT);
    }

    logger.info({ count: allTransactions.length }, '[Moneytor] Fetched transactions');
    return { success: true, accounts: groupByAccount(allTransactions) };
  } catch (err) {
    logger.error({ error: err.message }, '[Moneytor] Unexpected error fetching transactions');
    return { success: false, errorType: 'ScrapingError', errorMessage: err.message };
  }
}
