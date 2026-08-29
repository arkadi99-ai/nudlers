import logger from '../utils/logger.js';

const RISEUP_BASE_URL = 'https://input.riseup.co.il';

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// RiseUp's transactions endpoint requires a cashflowMonth filter per request -
// it has no "give me everything since X" mode like Moneytor does, so we walk
// month by month from startDate through the current month.
function monthsBetween(startDate, endDate) {
  const months = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const last = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  while (cursor <= last) {
    months.push(monthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function mapTransaction(raw, fixedTransactionIds) {
  const magnitude = Math.abs(raw.amount ?? 0);
  const signedAmount = raw.isIncome ? magnitude : -magnitude;

  return {
    identifier: raw.transactionId,
    date: raw.transactionDate,
    processedDate: raw.billingDate || raw.transactionDate,
    originalAmount: signedAmount,
    originalCurrency: 'ILS',
    chargedAmount: signedAmount,
    description: raw.businessName || 'Unknown',
    memo: null,
    status: 'completed',
    category: raw.isIncome ? 'Income' : (raw.categoryLabel || null),
    type: 'normal',
    installmentsNumber: raw.isInstallment ? raw.installmentNumber : null,
    installmentsTotal: raw.isInstallment ? raw.totalNumberOfInstallments : null,
    // Per-transaction bank/card flag: unlike every other vendor (always
    // entirely bank OR entirely card), one RiseUp connection mixes both in a
    // single feed - sourceType tells us which, per transaction.
    isBank: raw.sourceType === 'checkingAccount',
    // RiseUp's own budget classification, from its separate /budget endpoint
    // (NOT the transaction's own categoryType field, which turned out to be
    // an unrelated "how was this category assigned" flag - custom/default/other,
    // not fixed/variable at all). See fetchFixedTransactionIds below.
    commitmentType: fixedTransactionIds.has(raw.transactionId) ? 'fixed' : null
  };
}

/**
 * RiseUp's budget endpoint groups transactions into envelopes (categories),
 * each with a type: 'fixed' | 'variable' | 'variableIncome' | 'trackingCategory' | 'riseupGoal'.
 * 'fixed' means the user has configured this category in RiseUp itself as a
 * recurring, known-amount obligation (rent, subscriptions, insurance) - exactly
 * the "will bill me next month regardless of new spending" signal we need.
 * Returns the set of transactionIds that fall under a 'fixed' envelope for the
 * given month; returns an empty set (never throws) if the budget fetch fails,
 * since a fixed/variable tag is a nice-to-have, not required for the sync to succeed.
 */
async function fetchFixedTransactionIds(token, cashflowMonth) {
  const ids = new Set();
  try {
    const url = `${RISEUP_BASE_URL}/api/external/budget/${cashflowMonth}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    if (!response.ok) {
      logger.warn({ status: response.status, cashflowMonth }, '[RiseUp] Budget fetch failed, skipping fixed-expense tagging for this month');
      return ids;
    }
    const data = await response.json();
    for (const envelope of data.envelopes || []) {
      if (envelope.type !== 'fixed') continue;
      for (const actual of envelope.actuals || []) {
        if (actual.transactionId) ids.add(actual.transactionId);
      }
    }
  } catch (err) {
    logger.warn({ error: err.message, cashflowMonth }, '[RiseUp] Unexpected error fetching budget, skipping fixed-expense tagging for this month');
  }
  return ids;
}

function groupByAccount(rawTransactions, fixedTransactionIds) {
  const byAccount = new Map();
  for (const raw of rawTransactions) {
    const accountNumber = raw.accountNumberHash || 'unknown';
    if (!byAccount.has(accountNumber)) {
      byAccount.set(accountNumber, { accountNumber, accountNickname: null, txns: [] });
    }
    const account = byAccount.get(accountNumber);
    // RiseUp gives us the card/account name straight from the user's own RiseUp
    // app (e.g. "Visa - Dana") - carry it along so the rest of the app can offer
    // it as an auto-filled nickname instead of a bare hash prefix.
    if (!account.accountNickname && raw.accountNickname) {
      account.accountNickname = raw.accountNickname;
    }
    account.txns.push(mapTransaction(raw, fixedTransactionIds));
  }
  return Array.from(byAccount.values());
}

/**
 * Fetch transactions from the RiseUp API (personal-access-token based, see
 * https://github.com/riseup-oss/mcp for the reference client) and adapt them
 * into the same { success, accounts } shape that israeli-bank-scrapers
 * produces, so the rest of the app (dedup, categorization, budgets, insights,
 * WhatsApp, AI chat) works unchanged.
 */
export async function scrapeRiseup(credentials, startDate) {
  const token = credentials?.apiKey;
  if (!token) {
    return { success: false, errorType: 'INVALID_CREDENTIALS', errorMessage: 'Missing RiseUp personal access token' };
  }

  const months = monthsBetween(new Date(startDate), new Date());
  const allTransactions = [];
  const fixedTransactionIds = new Set();

  try {
    for (const cashflowMonth of months) {
      const url = `${RISEUP_BASE_URL}/api/external/transactions?cashflowMonth=${cashflowMonth}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        logger.error({ status: response.status, cashflowMonth, bodyText }, '[RiseUp] API request failed');
        const errorType = response.status === 401 || response.status === 403
          ? 'INVALID_CREDENTIALS'
          : 'ScrapingError';
        return { success: false, errorType, errorMessage: `RiseUp API returned ${response.status}` };
      }

      const data = await response.json();
      allTransactions.push(...(data.transactions || []));

      for (const id of await fetchFixedTransactionIds(token, cashflowMonth)) {
        fixedTransactionIds.add(id);
      }
    }

    logger.info({ count: allTransactions.length, months: months.length, fixedCount: fixedTransactionIds.size }, '[RiseUp] Fetched transactions');
    return { success: true, accounts: groupByAccount(allTransactions, fixedTransactionIds) };
  } catch (err) {
    logger.error({ error: err.message }, '[RiseUp] Unexpected error fetching transactions');
    return { success: false, errorType: 'ScrapingError', errorMessage: err.message };
  }
}
