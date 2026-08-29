#!/usr/bin/env node

const Database = require('better-sqlite3');

const databasePath = process.argv[2];
const cohortId = process.argv[3] || 'POST_GE30_R23_F2_ONLY_G2_XLEG';
const hardStopPct = Number(process.argv[4] || 20);

if (!databasePath) {
  console.error('Usage: node scripts/analyze-migrated-g2-hard-stop.js <db> [cohort] [hardStopPct]');
  process.exit(1);
}

const finite = (value, fallback = 0) => (Number.isFinite(Number(value))
  ? Number(value)
  : fallback);

const summarize = (rows) => {
  const returns = rows.map((row) => finite(row.netReturnPct));
  const positive = returns.filter((value) => value > 0);
  const negative = returns.filter((value) => value < 0);
  const gains = positive.reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(negative.reduce((sum, value) => sum + value, 0));
  const sorted = [...returns].sort((left, right) => left - right);
  return {
    count: returns.length,
    wins: positive.length,
    winRatePct: returns.length ? (positive.length / returns.length) * 100 : null,
    averagePct: returns.length
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length
      : null,
    medianPct: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
    profitFactor: losses > 0 ? gains / losses : null,
    totalPct: returns.reduce((sum, value) => sum + value, 0),
    worstPct: sorted[0] ?? null,
    bestPct: sorted.at(-1) ?? null,
  };
};

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const positions = db.prepare(`
  SELECT id, mint, entry_at, entry_price, exit_at, exit_price,
         exit_reason, net_return_pct, configured_cost_pct
  FROM migrated_drop_rebound_shadow_positions
  WHERE cohort_id = ? AND status = 'CLOSED'
    AND entry_at IS NOT NULL AND entry_price > 0
    AND exit_at IS NOT NULL AND exit_price > 0
  ORDER BY entry_at
`).all(cohortId);

const tradesForPosition = db.prepare(`
  SELECT timestamp_ms, reserve_price
  FROM raw_trades
  WHERE mint = ? AND market = 'PUMP_AMM'
    AND timestamp_ms > ? AND timestamp_ms <= ?
    AND reserve_price > 0
  ORDER BY timestamp_ms, id
`);

const exitDelayMs = 200;
const exitTimeoutMs = 2_000;
const variants = [];
let triggered = 0;
let filled = 0;
let noFill = 0;

for (const position of positions) {
  const costPct = finite(position.configured_cost_pct, 2.251);
  const baseline = {
    id: position.id,
    mint: position.mint,
    netReturnPct: finite(position.net_return_pct),
    exitReason: position.exit_reason,
    baselineNetReturnPct: finite(position.net_return_pct),
    baselineExitReason: position.exit_reason,
  };
  const rows = tradesForPosition.all(
    position.mint,
    position.entry_at,
    position.exit_at,
  );
  const triggerPrice = position.entry_price * (1 - hardStopPct / 100);
  const trigger = rows.find((trade) => trade.reserve_price <= triggerPrice);
  if (!trigger) {
    variants.push({ ...baseline, changed: false });
    continue;
  }
  triggered += 1;
  const exitTargetAt = trigger.timestamp_ms + exitDelayMs;
  const exitDeadlineAt = exitTargetAt + exitTimeoutMs;
  const fill = rows.find((trade) => trade.timestamp_ms >= exitTargetAt
    && trade.timestamp_ms <= exitDeadlineAt);
  if (!fill) {
    noFill += 1;
    variants.push({ ...baseline, changed: false, hardStopNoFill: true });
    continue;
  }
  filled += 1;
  const grossReturnPct = ((fill.reserve_price / position.entry_price) - 1) * 100;
  variants.push({
    ...baseline,
    changed: true,
    hardStopTriggerAt: trigger.timestamp_ms,
    hardStopFillAt: fill.timestamp_ms,
    hardStopMarkPct: ((trigger.reserve_price / position.entry_price) - 1) * 100,
    netReturnPct: grossReturnPct - costPct,
    exitReason: `HARD_STOP_${hardStopPct}`,
  });
}

const baselineSummary = summarize(positions.map((position) => ({
  netReturnPct: position.net_return_pct,
})));
const variantSummary = summarize(variants);
const changedRows = variants
  .filter((row) => row.changed)
  .sort((left, right) => left.netReturnPct - right.netReturnPct);

console.log(JSON.stringify({
  databasePath,
  cohortId,
  hardStopPct,
  assumptions: {
    price: 'raw_trades.reserve_price',
    causal: true,
    exitDelayMs,
    exitTimeoutMs,
    note: 'The hard stop only replaces an existing later exit when a later fill exists.',
  },
  coverage: {
    closedPositions: positions.length,
    triggered,
    filled,
    noFill,
  },
  baseline: baselineSummary,
  hardStopVariant: variantSummary,
  delta: {
    averagePct: variantSummary.averagePct - baselineSummary.averagePct,
    totalPct: variantSummary.totalPct - baselineSummary.totalPct,
    winRatePct: variantSummary.winRatePct - baselineSummary.winRatePct,
    profitFactor: variantSummary.profitFactor - baselineSummary.profitFactor,
  },
  changedRows,
}, null, 2));

db.close();
