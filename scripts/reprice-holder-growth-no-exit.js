'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_PLAUSIBLE_RETURN_PCT = 500;

function parseArgs(argv) {
  const result = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, value = 'true'] = item.slice(2).split('=', 2);
    result[key] = value;
  }
  return result;
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function fixedExecutionCostSol() {
  return [
    process.env.FLOW_BASE_TX_FEE_SOL ?? 0.00001,
    process.env.FLOW_PRIORITY_FEE_SOL ?? 0.0005,
    process.env.FLOW_JITO_TIP_SOL ?? 0,
    process.env.FLOW_FIXED_COST_SOL ?? 0,
  ].reduce((sum, value) => sum + Math.max(0, finite(value, 0)), 0);
}

function tradePrice(trade) {
  if (trade.market === 'PUMP_BONDING_CURVE') {
    const reservePrice = finite(trade.reserve_price);
    if (reservePrice > 0) return reservePrice;
  }
  const price = finite(trade.price);
  return price > 0 ? price : null;
}

function tradeMatchesLifecycle(position, trade) {
  if (position.rejection_reason === 'NO_EXIT_AFTER_MIGRATION_AMM_TIMEOUT') {
    return trade.market === 'PUMP_AMM';
  }
  const graduatedAt = finite(position.graduated_at);
  if (graduatedAt && trade.timestamp_ms >= graduatedAt) return trade.market === 'PUMP_AMM';
  return trade.market === 'PUMP_BONDING_CURVE';
}

function realizedReturn(position, price, extraFixedCostSol) {
  const entryPrice = finite(position.entry_price);
  if (!(entryPrice > 0) || !(price > 0)) return null;
  const runnerGrossReturnPct = ((price / entryPrice) - 1) * 100;
  let grossReturnPct = runnerGrossReturnPct;
  let effectiveExitPrice = price;
  let extraCostPct = 0;
  if (['SCALE_RUNNER', 'SCALE_ADAPTIVE'].includes(position.exit_mode)
    && finite(position.scale_out_at) && finite(position.scale_out_price) > 0) {
    const fraction = Math.min(
      1,
      Math.max(0, finite(position.scale_out_fraction_pct, 50) / 100),
    );
    const scaleGrossReturnPct = ((position.scale_out_price / entryPrice) - 1) * 100;
    grossReturnPct = scaleGrossReturnPct * fraction + runnerGrossReturnPct * (1 - fraction);
    effectiveExitPrice = entryPrice * (1 + grossReturnPct / 100);
    const positionSol = Math.max(0.000001, finite(position.position_sol, 1));
    extraCostPct = extraFixedCostSol / positionSol * 100;
  }
  return {
    grossReturnPct,
    netReturnPct: grossReturnPct - finite(position.configured_cost_pct, 0) - extraCostPct,
    effectiveExitPrice,
  };
}

function recoveryForPosition(position, trades, {
  maxPlausibleReturnPct = DEFAULT_MAX_PLAUSIBLE_RETURN_PCT,
  extraFixedCostSol = fixedExecutionCostSol(),
} = {}) {
  for (const trade of trades) {
    if (!tradeMatchesLifecycle(position, trade)) continue;
    const price = tradePrice(trade);
    if (!(price > 0)) continue;
    if (trade.market === 'PUMP_AMM') {
      const ratio = price / position.entry_price;
      if (ratio < 0.05 || ratio > 20) continue;
    }
    const result = realizedReturn(position, price, extraFixedCostSol);
    if (!result || result.grossReturnPct < -100
      || result.grossReturnPct > maxPlausibleReturnPct) continue;
    const highestPrice = Math.max(finite(position.highest_price, price), price);
    const lowestPrice = Math.min(finite(position.lowest_price, price), price);
    return {
      ...result,
      exitAt: trade.timestamp_ms,
      exitMarket: trade.market,
      observedTradePrice: price,
      highestPrice,
      lowestPrice,
      maxFavorableReturnPct: Math.max(
        finite(position.max_favorable_return_pct, 0),
        ((highestPrice / position.entry_price) - 1) * 100,
      ),
      maxAdverseReturnPct: Math.min(
        finite(position.max_adverse_return_pct, 0),
        ((lowestPrice / position.entry_price) - 1) * 100,
      ),
      delayMs: Math.max(0, trade.timestamp_ms - position.exit_target_at),
    };
  }
  return null;
}

function assertRequiredTables(db) {
  for (const table of ['holder_growth_shadow_positions', 'raw_trades', 'flow_tokens']) {
    const exists = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
    `).get(table);
    if (!exists) throw new Error(`Required table is missing: ${table}`);
  }
}

function ensureAuditTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS holder_growth_no_exit_recovery_audit (
      run_id TEXT NOT NULL,
      position_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      audited_at INTEGER NOT NULL,
      recovery_window_ms INTEGER NOT NULL,
      original_status TEXT NOT NULL,
      original_rejection_reason TEXT,
      original_exit_reason TEXT,
      original_gross_return_pct REAL,
      original_net_return_pct REAL,
      recovered_exit_at INTEGER,
      recovered_exit_market TEXT,
      recovered_exit_price REAL,
      recovered_gross_return_pct REAL,
      recovered_net_return_pct REAL,
      PRIMARY KEY(run_id, position_id)
    )
  `);
}

function repriceHolderGrowthNoExit({
  dbPath,
  apply = false,
  windowMs = DEFAULT_WINDOW_MS,
  maxPlausibleReturnPct = DEFAULT_MAX_PLAUSIBLE_RETURN_PCT,
  limit = null,
  now = Date.now(),
} = {}) {
  const resolvedPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Database does not exist: ${resolvedPath}`);
  const db = new Database(resolvedPath, {
    readonly: !apply,
    fileMustExist: true,
    timeout: 60_000,
  });
  db.pragma('busy_timeout = 60000');
  assertRequiredTables(db);
  const safeWindowMs = positiveInteger(windowMs, DEFAULT_WINDOW_MS);
  const safeLimit = limit == null ? null : positiveInteger(limit, null);
  const limitSql = safeLimit ? 'LIMIT ?' : '';
  const positions = db.prepare(`
    SELECT p.*, token.graduated_at
    FROM holder_growth_shadow_positions AS p
    LEFT JOIN flow_tokens AS token ON token.mint = p.mint
    WHERE p.status = 'NO_EXIT'
      AND p.entry_at IS NOT NULL
      AND p.entry_price > 0
      AND p.exit_target_at IS NOT NULL
    ORDER BY p.exit_target_at, p.id
    ${limitSql}
  `).all(...(safeLimit ? [safeLimit] : []));
  const tradesStatement = db.prepare(`
    SELECT timestamp_ms, market, price, reserve_price
    FROM raw_trades
    WHERE mint = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
      AND market IN ('PUMP_BONDING_CURVE', 'PUMP_AMM')
    ORDER BY timestamp_ms, id
  `);
  const extraFixedCostSol = fixedExecutionCostSol();
  const outcomes = positions.map((position) => {
    const trades = tradesStatement.all(
      position.mint,
      position.exit_target_at,
      position.exit_target_at + safeWindowMs,
    );
    const recovery = recoveryForPosition(position, trades, {
      maxPlausibleReturnPct,
      extraFixedCostSol,
    });
    return { position, recovery };
  });
  const recovered = outcomes.filter((outcome) => outcome.recovery);
  const censored = outcomes.filter((outcome) => !outcome.recovery);
  const byCohort = new Map();
  for (const outcome of outcomes) {
    const key = outcome.position.cohort_id;
    const row = byCohort.get(key) || {
      cohortId: key,
      noExit: 0,
      recoverable: 0,
      recoveredWins: 0,
      recoveredNetReturnSumPct: 0,
    };
    row.noExit += 1;
    if (outcome.recovery) {
      row.recoverable += 1;
      row.recoveredNetReturnSumPct += outcome.recovery.netReturnPct;
      if (outcome.recovery.netReturnPct > 0) row.recoveredWins += 1;
    }
    byCohort.set(key, row);
  }
  const pricedBefore = db.prepare(`
    SELECT COUNT(*) AS count,
      COALESCE(SUM(net_return_pct), 0) AS net_return_sum_pct,
      COALESCE(SUM(net_return_pct > 0), 0) AS wins
    FROM holder_growth_shadow_positions
    WHERE status='CLOSED' AND net_return_pct IS NOT NULL
  `).get();
  const recoveredNetReturnSumPct = recovered.reduce(
    (sum, outcome) => sum + outcome.recovery.netReturnPct,
    0,
  );
  const recoveredWins = recovered.filter((outcome) => outcome.recovery.netReturnPct > 0).length;
  const projectedPricedCount = Number(pricedBefore.count) + recovered.length;
  const projectedPricedNetReturnSumPct = Number(pricedBefore.net_return_sum_pct)
    + recoveredNetReturnSumPct;
  const conservativeCount = projectedPricedCount + censored.length;
  const conservativeNetReturnSumPct = projectedPricedNetReturnSumPct
    + censored.reduce((sum, outcome) => (
      sum - 100 - finite(outcome.position.configured_cost_pct, 0)
    ), 0);

  let runId = null;
  if (apply && outcomes.length) {
    runId = `hg-no-exit-${now}-${safeWindowMs}`;
    const transact = db.transaction(() => {
      ensureAuditTable(db);
      const audit = db.prepare(`
        INSERT INTO holder_growth_no_exit_recovery_audit (
          run_id, position_id, action, audited_at, recovery_window_ms,
          original_status, original_rejection_reason, original_exit_reason,
          original_gross_return_pct, original_net_return_pct,
          recovered_exit_at, recovered_exit_market, recovered_exit_price,
          recovered_gross_return_pct, recovered_net_return_pct
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateRecovered = db.prepare(`
        UPDATE holder_growth_shadow_positions SET
          status='CLOSED', rejection_reason=NULL,
          exit_at=?, exit_market=?, exit_price=?,
          exit_reason=?, gross_return_pct=?, net_return_pct=?,
          highest_price=?, lowest_price=?,
          max_favorable_return_pct=?, max_adverse_return_pct=?, updated_at=?
        WHERE id=? AND status='NO_EXIT'
      `);
      const updateCensored = db.prepare(`
        UPDATE holder_growth_shadow_positions SET
          rejection_reason=COALESCE(rejection_reason, ?),
          gross_return_pct=NULL, net_return_pct=NULL, updated_at=?
        WHERE id=? AND status='NO_EXIT'
      `);
      for (const { position, recovery } of outcomes) {
        audit.run(
          runId,
          position.id,
          recovery ? 'RECOVERED_EXIT' : 'RIGHT_CENSORED',
          now,
          safeWindowMs,
          position.status,
          position.rejection_reason,
          position.exit_reason,
          position.gross_return_pct,
          position.net_return_pct,
          recovery?.exitAt ?? null,
          recovery?.exitMarket ?? null,
          recovery?.effectiveExitPrice ?? null,
          recovery?.grossReturnPct ?? null,
          recovery?.netReturnPct ?? null,
        );
        if (recovery) {
          updateRecovered.run(
            recovery.exitAt,
            recovery.exitMarket,
            recovery.effectiveExitPrice,
            `${position.exit_reason || 'EXIT'}_RECOVERED_${recovery.delayMs}MS`,
            recovery.grossReturnPct,
            recovery.netReturnPct,
            recovery.highestPrice,
            recovery.lowestPrice,
            recovery.maxFavorableReturnPct,
            recovery.maxAdverseReturnPct,
            now,
            position.id,
          );
        } else {
          const reason = position.graduated_at && position.graduated_at <= position.exit_target_at
            ? 'NO_EXIT_AFTER_MIGRATION_AMM_TIMEOUT'
            : 'NO_EXIT_BONDING_CURVE_TIMEOUT';
          updateCensored.run(reason, now, position.id);
        }
      }
    });
    transact();
  }

  const summary = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    database: resolvedPath,
    windowMs: safeWindowMs,
    maxPlausibleReturnPct,
    scannedNoExit: positions.length,
    recoverable: recovered.length,
    recoverablePct: positions.length ? recovered.length / positions.length * 100 : null,
    stillCensored: censored.length,
    recoveredAverageNetReturnPct: recovered.length
      ? recoveredNetReturnSumPct / recovered.length : null,
    recoveredWinRatePct: recovered.length ? recoveredWins / recovered.length * 100 : null,
    pricedBefore: {
      count: Number(pricedBefore.count),
      averageNetReturnPct: Number(pricedBefore.count)
        ? Number(pricedBefore.net_return_sum_pct) / Number(pricedBefore.count) : null,
      winRatePct: Number(pricedBefore.count)
        ? Number(pricedBefore.wins) / Number(pricedBefore.count) * 100 : null,
    },
    projectedPricedAfterRecovery: {
      count: projectedPricedCount,
      averageNetReturnPct: projectedPricedCount
        ? projectedPricedNetReturnSumPct / projectedPricedCount : null,
      winRatePct: projectedPricedCount
        ? (Number(pricedBefore.wins) + recoveredWins) / projectedPricedCount * 100 : null,
    },
    projectedConservativeAverageNetReturnPct: conservativeCount
      ? conservativeNetReturnSumPct / conservativeCount : null,
    runId,
    safety: {
      walCheckpointExecuted: false,
      sourceRowsDeleted: false,
      auditTableWritten: apply && outcomes.length > 0,
    },
    cohorts: [...byCohort.values()].map((row) => ({
      ...row,
      recoveredAverageNetReturnPct: row.recoverable
        ? row.recoveredNetReturnSumPct / row.recoverable : null,
      recoveredWinRatePct: row.recoverable ? row.recoveredWins / row.recoverable * 100 : null,
    })).sort((left, right) => (
      right.recoverable - left.recoverable || right.noExit - left.noExit
    )),
  };
  db.close();
  return summary;
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  const summary = repriceHolderGrowthNoExit({
    dbPath: input.db || process.env.FLOW_DB_PATH || './data/flow-research.db',
    apply: input.apply === 'true',
    windowMs: input['window-ms'],
    maxPlausibleReturnPct: finite(
      input['max-plausible-return-pct'],
      DEFAULT_MAX_PLAUSIBLE_RETURN_PCT,
    ),
    limit: input.limit,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_WINDOW_MS,
  recoveryForPosition,
  repriceHolderGrowthNoExit,
};
