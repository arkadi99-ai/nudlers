import logger from '../utils/logger.js';

const MONEYTOR_BASE_URL = 'https://app.moneytor.co.il/api/v1';
const PAGE_LIMIT = 2000;

function formatDateParam(date) {
  return new Date(date).toISOString().slice(0, 10);
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
    category: raw.category || null,
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
