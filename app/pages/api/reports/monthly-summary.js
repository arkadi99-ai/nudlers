import { createApiHandler } from "../../../utils/apiHandler";
import { getBillingCycleSql } from "../../../utils/transaction_logic";
import { getBillingCycleStartDay } from "../utils/scraperUtils";
import { BANK_VENDORS } from "../../../utils/constants";

const handler = createApiHandler({
  query: async (req, client) => {
    const {
      startDate, endDate, vendor, groupBy, billingCycle,
      excludeBankTransactions, limit = 50, offset = 0,
      sortBy, sortOrder
    } = req.query;

    const limitVal = parseInt(limit, 10) || 50;
    const offsetVal = parseInt(offset, 10) || 0;

    // Default sorts based on groupBy
    let effectiveSortBy = sortBy;
    let effectiveSortOrder = sortOrder;

    if (!effectiveSortBy) {
      if (groupBy === 'category') effectiveSortBy = 'total';
      else if (groupBy === 'description') effectiveSortBy = 'card_expenses';
      else if (groupBy === 'last4digits') effectiveSortBy = 'card_expenses';
      else effectiveSortBy = 'card_expenses';
    }

    if (!effectiveSortOrder) {
      if (groupBy === 'category') effectiveSortOrder = 'asc';
      else effectiveSortOrder = 'desc';
    }

    // Build WHERE clause based on filters
    let whereClause = '';
    const params = [];
    let paramIndex = 1;

    if (billingCycle) {
      const billingStartDay = await getBillingCycleStartDay(client);
      const effectiveMonthSql = getBillingCycleSql(billingStartDay, 't.date', 't.processed_date');
      whereClause = `WHERE (${effectiveMonthSql}) = $${paramIndex}`;
      params.push(billingCycle);
      paramIndex++;
    }
    else if (startDate && endDate) {
      whereClause = `WHERE t.date >= $${paramIndex}::date AND t.date <= $${paramIndex + 1}::date`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (vendor) {
      if (whereClause) {
        whereClause += ` AND t.vendor = $${paramIndex}`;
      } else {
        whereClause = `WHERE t.vendor = $${paramIndex}`;
      }
      params.push(vendor);
      paramIndex++;
    }

    if (excludeBankTransactions === 'true') {
      const bankExclusion = `t.vendor != ALL($${paramIndex}::text[])`;
      params.push(BANK_VENDORS);
      paramIndex++;
      if (whereClause) {
        whereClause += ` AND ${bankExclusion}`;
      } else {
        whereClause = `WHERE ${bankExclusion}`;
      }
    }

    // Real bank/card account numbers are matched by their last 4 digits (a physical card
    // reported by two different credentials should still merge into one row) - but RiseUp
    // identifies accounts with an opaque hash, not real digits, so truncating it to 4
    // characters risks colliding two unrelated accounts. RiseUp accounts are matched by
    // their full identifier instead.
    const accountKeyExpr = (alias) => `CASE WHEN ${alias}.vendor = 'riseup' THEN ${alias}.account_number ELSE RIGHT(${alias}.account_number, 4) END`;

    const credentialJoin = `
      LEFT JOIN card_ownership co ON t.vendor = co.vendor AND ${accountKeyExpr('t')} = ${accountKeyExpr('co')} AND (co.is_hidden = false OR co.is_hidden IS NULL)
      LEFT JOIN vendor_credentials vc ON co.credential_id = vc.id
    `;

    // Determine ORDER BY clause using strict mapping (prevents SQL injection)
    const dir = effectiveSortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const oppositeDir = dir === 'ASC' ? 'DESC' : 'ASC';

    const ORDER_BY_MAP = {
      description: {
        name: `LOWER(TRIM(t.name))`,
        category: `LOWER(MAX(t.category)) ${dir}, LOWER(TRIM(t.name)) ASC`,
        count: `COUNT(DISTINCT (t.identifier, t.vendor)) ${dir}, LOWER(TRIM(t.name)) ASC`,
        transaction_count: `COUNT(DISTINCT (t.identifier, t.vendor)) ${dir}, LOWER(TRIM(t.name)) ASC`,
        _default: `ABS(SUM(t.price)) ${dir}, LOWER(TRIM(t.name)) ASC`,
      },
      category: {
        total: `SUM(t.price)`,
        amount: `SUM(t.price)`,
        count: `COUNT(*)`,
        _default: `category`,
      },
      last4digits: {
        name: `COALESCE(${accountKeyExpr('t')}, 'Unknown')`,
        count: `COUNT(DISTINCT (t.identifier, t.vendor)) ${dir}, COALESCE(${accountKeyExpr('t')}, 'Unknown') ASC`,
        transaction_count: `COUNT(DISTINCT (t.identifier, t.vendor)) ${dir}, COALESCE(${accountKeyExpr('t')}, 'Unknown') ASC`,
        _default: `(
          COALESCE(SUM(CASE WHEN t.category = 'Bank' AND t.price > 0 THEN t.price ELSE 0 END), 0) +
          COALESCE(SUM(CASE WHEN t.category = 'Bank' AND t.price < 0 THEN ABS(t.price) ELSE 0 END), 0) +
          COALESCE(SUM(
            CASE WHEN COALESCE(t.category, 'Uncategorized') NOT IN ('Bank', 'Income') THEN ABS(t.price) ELSE 0 END
          ), 0)
        ) ${dir}, COALESCE(${accountKeyExpr('t')}, 'Unknown') ASC`,
      },
      _default: {
        month: `month`,
        _default: `month ${dir}, vendor ASC`,
      },
    };

    const groupMap = ORDER_BY_MAP[groupBy] || ORDER_BY_MAP._default;
    const rawClause = groupMap[effectiveSortBy] || groupMap._default;
    // If the clause is a simple expression (no dir already embedded), append direction
    const orderClause = rawClause.includes('ASC') || rawClause.includes('DESC') ? rawClause : `${rawClause} ${dir}`;

    let sql;
    if (groupBy === 'description') {
      sql = `
        SELECT 
          TRIM(t.name) as description,
          MAX(t.category) as category,
          COUNT(DISTINCT (t.identifier, t.vendor)) as transaction_count,
          COALESCE(SUM(t.price), 0)::numeric as amount,
          COUNT(*) OVER() as total_count
        FROM transactions t
        ${credentialJoin}
        ${whereClause}
        GROUP BY TRIM(t.name)
        HAVING ROUND(COALESCE(SUM(t.price), 0)) != 0
        ORDER BY ${orderClause}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
    } else if (groupBy === 'category') {
      sql = `
        SELECT 
          COALESCE(NULLIF(t.category, ''), 'Uncategorized') as category,
          COALESCE(SUM(t.price), 0)::numeric as total,
          COALESCE(SUM(t.price), 0)::numeric as amount,
          COUNT(*)::integer as count,
          COUNT(*) OVER() as total_count
        FROM transactions t
        ${whereClause}
        GROUP BY COALESCE(NULLIF(t.category, ''), 'Uncategorized')
        ORDER BY ${orderClause}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
    } else if (groupBy === 'last4digits') {
      sql = `
        SELECT 
          COALESCE(${accountKeyExpr('t')}, 'Unknown') as last4digits,
          COUNT(DISTINCT (t.identifier, t.vendor)) as transaction_count,
          COALESCE(SUM(CASE WHEN t.category = 'Bank' AND t.price > 0 THEN t.price ELSE 0 END), 0)::numeric as bank_income,
          COALESCE(SUM(CASE WHEN t.category = 'Bank' AND t.price < 0 THEN ABS(t.price) ELSE 0 END), 0)::numeric as bank_expenses,
          COALESCE(SUM(
            CASE WHEN COALESCE(t.category, 'Uncategorized') NOT IN ('Bank', 'Income') THEN ABS(t.price) ELSE 0 END
          ), 0)::numeric as card_expenses,
          COALESCE(SUM(CASE WHEN t.price > 0 THEN t.price ELSE 0 END), 0)::numeric as total_income,
          COALESCE(SUM(CASE WHEN t.price < 0 THEN ABS(t.price) ELSE 0 END), 0)::numeric as total_outflow,
          (
            COALESCE(SUM(CASE WHEN t.category = 'Bank' AND t.price > 0 THEN t.price ELSE 0 END), 0) -
            COALESCE(SUM(CASE WHEN t.category = 'Bank' AND t.price < 0 THEN ABS(t.price) ELSE 0 END), 0) -
            COALESCE(SUM(
              CASE WHEN COALESCE(t.category, 'Uncategorized') NOT IN ('Bank', 'Income') THEN ABS(t.price) ELSE 0 END
            ), 0)
          )::numeric as net_balance,
          COALESCE(ba.id, vc.id) as bank_account_id,
          COALESCE(ba.nickname, co.custom_bank_account_nickname, vc.nickname) as bank_account_nickname,
          COALESCE(ba.bank_account_number, co.custom_bank_account_number, co.account_number) as bank_account_number,
          co.custom_bank_account_number,
          co.custom_bank_account_nickname,
          COALESCE(ba.vendor, vc.vendor) as bank_account_vendor,
          t.vendor as transaction_vendor,
          co.balance,
          co.balance_updated_at,
          COUNT(*) OVER() as total_count
        FROM transactions t
        ${credentialJoin}
        LEFT JOIN vendor_credentials ba ON co.linked_bank_account_id = ba.id
        ${whereClause}
        GROUP BY COALESCE(${accountKeyExpr('t')}, 'Unknown'), t.vendor, ba.id, ba.nickname, ba.bank_account_number, ba.vendor, co.custom_bank_account_nickname, co.custom_bank_account_number, co.balance, co.balance_updated_at, vc.id, vc.nickname, vc.vendor, co.account_number
        ORDER BY ${orderClause}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
    } else {
      sql = `
        WITH monthly_data AS (
          SELECT 
            TO_CHAR(t.date, 'YYYY-MM') as month,
            t.vendor,
            vc.nickname as vendor_nickname,
            COALESCE(SUM(CASE WHEN t.category = 'Bank' AND t.price > 0 THEN t.price ELSE 0 END), 0) as bank_income,
            COALESCE(SUM(CASE WHEN t.category = 'Bank' AND t.price < 0 THEN ABS(t.price) ELSE 0 END), 0) as bank_expenses,
            COALESCE(SUM(
              CASE WHEN COALESCE(t.category, 'Uncategorized') NOT IN ('Bank', 'Income') THEN ABS(t.price) ELSE 0 END
            ), 0) as card_expenses
          FROM transactions t
          ${credentialJoin}
          ${whereClause}
          GROUP BY TO_CHAR(t.date, 'YYYY-MM'), t.vendor, vc.nickname
        )
        SELECT 
          month,
          vendor,
          vendor_nickname,
          bank_income::numeric as bank_income,
          bank_expenses::numeric as bank_expenses,
          card_expenses::numeric as card_expenses,
          (bank_income - bank_expenses - card_expenses)::numeric as net_balance,
          COUNT(*) OVER() as total_count
        FROM monthly_data
        ORDER BY ${orderClause}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
    }

    params.push(limitVal, offsetVal);
    return { sql, params };
  },
  transform: (result) => {
    const rows = result.rows;
    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) || 0 : 0;
    const items = rows.map(r => {
      const { total_count, ...item } = r;
      return item;
    });
    return { items, total };
  }
});

export default handler;
