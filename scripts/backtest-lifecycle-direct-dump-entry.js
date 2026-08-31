'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'data', 'backtest-20260831', 'flow-acceleration-last24h.db');

const WINDOW_MS = 1_000;
const ENTRY_TIMEOUT_MS = 2_000;
const CONFIRMED_ENTRY_DELAY_MS = 200;
const EXIT_TIMEOUT_MS = 5_000;
const MAX_AGE_MS = 70_000;
const HOLDS_MS = [3_000, 8_000, 15_000, 30_000];
const SIZES_SOL = [0.1, 1];
const MAX_ENTRY_JUMP_PCT = 15;

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function summarize(rows, key) {
  const resolved = rows.filter((row) => Number.isFinite(row[key]));
  const values = resolved.map((row) => row[key]);
  const descending = [...values].sort((a, b) => b - a);
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const topFive = descending.slice(0, 5).reduce((sum, value) => sum + value, 0);
  return {
    signals: rows.length,
    resolved: resolved.length,
    noExit: rows.filter((row) => row.noExit).length,
    invalidPriceScale: rows.filter((row) => row.invalidPriceScale).length,
    winPct: resolved.length ? 100 * values.filter((value) => value > 0).length / resolved.length : null,
    avgPct: mean(values),
    medianPct: quantile(values, 0.5),
    p90Pct: quantile(values, 0.9),
    maxWinnerPct: descending[0] ?? null,
    withoutTop5AvgPct: mean(descending.slice(Math.min(5, descending.length))),
    top5NetContributionPct: total > 0 ? 100 * topFive / total : null,
    pf: losses > 0 ? gains / losses : (gains > 0 ? 999 : 0),
    rug50Pct: resolved.length ? 100 * values.filter((value) => value <= -50).length / resolved.length : null,
    rug80Pct: resolved.length ? 100 * values.filter((value) => value <= -80).length / resolved.length : null,
    big20Pct: resolved.length ? 100 * values.filter((value) => value >= 20).length / resolved.length : null,
    big50Pct: resolved.length ? 100 * values.filter((value) => value >= 50).length / resolved.length : null,
    avgMfePct: mean(resolved.map((row) => row.mfePct).filter(Number.isFinite)),
    avgMaePct: mean(resolved.map((row) => row.maePct).filter(Number.isFinite)),
    impactCoveragePct: resolved.length
      ? 100 * resolved.filter((row) => Number.isFinite(row.quoteReserveSol)).length / resolved.length
      : null,
  };
}

function roundObject(value) {
  if (Array.isArray(value)) return value.map(roundObject);
  if (!value || typeof value !== 'object') {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundObject(item)]));
}

const configuredCosts = new Map();
for (const row of db.prepare(`
  SELECT position_sol, AVG(configured_cost_pct) AS cost_pct
  FROM migrated_drop_rebound_shadow_positions
  WHERE configured_cost_pct IS NOT NULL AND position_sol IN (0.1, 1)
  GROUP BY position_sol
`).all()) {
  configuredCosts.set(Number(row.position_sol), Number(row.cost_pct));
}
for (const size of SIZES_SOL) {
  if (!configuredCosts.has(size)) configuredCosts.set(size, 2.25);
}

// Public PUMP_AMM rows do not preserve the exact reserves needed to re-quote every
// historical fill. Calibrate capacity against real Lifecycle G shadow fills instead.
// Use the 75th percentile so the result is deliberately less optimistic than the
// median, while avoiding the handful of corrupted/outlier impact rows.
const capacityImpactPct = new Map();
for (const sizeSol of SIZES_SOL) {
  const samples = db.prepare(`
    SELECT entry_impact_pct, exit_impact_pct
    FROM migrated_drop_rebound_shadow_positions
    WHERE status = 'CLOSED'
      AND position_sol = ?
      AND entry_impact_pct IS NOT NULL
      AND exit_impact_pct IS NOT NULL
      AND ABS(entry_impact_pct) <= 100
      AND ABS(exit_impact_pct) <= 100
  `).all(sizeSol)
    .map((row) => Math.abs(Number(row.entry_impact_pct)) + Math.abs(Number(row.exit_impact_pct)))
    .filter(Number.isFinite);
  capacityImpactPct.set(sizeSol, quantile(samples, 0.75) ?? (sizeSol === 1 ? 3 : 0.3));
}

const results = new Map();
function addResult(variant, holdMs, row) {
  const key = `${variant}|${holdMs}`;
  let rows = results.get(key);
  if (!rows) {
    rows = [];
    results.set(key, rows);
  }
  rows.push(row);
}

function findTradeAtOrAfter(trades, signalIndex, targetAt, predicate = null) {
  for (let index = signalIndex + 1; index < trades.length; index += 1) {
    const trade = trades[index];
    if (trade.at < targetAt) continue;
    if (trade.at > targetAt + ENTRY_TIMEOUT_MS) return null;
    if (!predicate || predicate(trade)) return trade;
  }
  return null;
}

function findExit(trades, entryIndex, targetAt) {
  for (let index = entryIndex + 1; index < trades.length; index += 1) {
    const trade = trades[index];
    if (trade.at < targetAt) continue;
    if (trade.at > targetAt + EXIT_TIMEOUT_MS) return null;
    return trade;
  }
  return null;
}

function evaluateSignal(mint, trades, variant, signal, delayMs, nextBuyOnly = false) {
  let confirmation = null;
  let entry = null;
  if (nextBuyOnly) {
    // The confirming BUY is observable only after it lands. Filling at that same
    // print would be look-ahead. Apply the same 200ms simulated execution delay
    // used by the existing Lifecycle G shadow path.
    confirmation = findTradeAtOrAfter(
      trades,
      signal.index,
      signal.at,
      (trade) => trade.side === 'BUY',
    );
    if (confirmation) {
      entry = findTradeAtOrAfter(
        trades,
        confirmation.index,
        confirmation.at + CONFIRMED_ENTRY_DELAY_MS,
      );
    }
  } else {
    entry = findTradeAtOrAfter(trades, signal.index, signal.at + delayMs);
  }
  if (!entry || entry.price <= 0) return;
  const entryJumpPct = (entry.price / signal.price - 1) * 100;
  if (entryJumpPct > MAX_ENTRY_JUMP_PCT) return;

  for (const holdMs of HOLDS_MS) {
    const exit = findExit(trades, entry.index, entry.at + holdMs);
    const pathEnd = exit?.at ?? (entry.at + holdMs + EXIT_TIMEOUT_MS);
    let highest = entry.price;
    let lowest = entry.price;
    for (let index = entry.index + 1; index < trades.length && trades[index].at <= pathEnd; index += 1) {
      highest = Math.max(highest, trades[index].price);
      lowest = Math.min(lowest, trades[index].price);
    }
    const mfePct = (highest / entry.price - 1) * 100;
    const maePct = (lowest / entry.price - 1) * 100;
    const markGrossPct = exit ? (exit.price / entry.price - 1) * 100 : -100;
    // Existing production accounting treats >500% single-path returns as a price
    // scale/data error. Apply the same rule here rather than letting a few corrupt
    // cross-scale prints manufacture an apparently profitable strategy.
    const invalidPriceScale = Boolean(exit && markGrossPct > 500);
    const base = {
      mint,
      entryAt: entry.at,
      exitAt: exit?.at ?? null,
      noExit: !exit,
      invalidPriceScale,
      entryJumpPct,
      markGrossPct,
      mfePct,
      maePct,
      quoteReserveSol: null,
      markNetPct: invalidPriceScale ? null : markGrossPct - configuredCosts.get(1),
    };
    for (const sizeSol of SIZES_SOL) {
      const executionNetPct = invalidPriceScale
        ? null
        : markGrossPct - configuredCosts.get(sizeSol) - capacityImpactPct.get(sizeSol);
      base[`exec${String(sizeSol).replace('.', '_')}Pct`] = executionNetPct;
    }
    addResult(variant, holdMs, base);
  }
}

function processMint(mint, migratedAt, trades) {
  if (!trades.length) return;
  for (let index = 0; index < trades.length; index += 1) trades[index].index = index;

  const peakDeque = [];
  let peakHead = 0;
  let windowStart = 0;
  let candidate = null;
  let baselineSignal = null;
  const firstSignals = new Map();

  function remember(name, signal) {
    if (!firstSignals.has(name)) firstSignals.set(name, signal);
  }

  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    while (windowStart < index && trades[windowStart].at < trade.at - WINDOW_MS) windowStart += 1;
    while (peakHead < peakDeque.length && trades[peakDeque[peakHead]].at < trade.at - WINDOW_MS) peakHead += 1;
    while (peakDeque.length > peakHead && trades[peakDeque[peakDeque.length - 1]].price <= trade.price) peakDeque.pop();
    peakDeque.push(index);
    if (peakHead > 512) {
      peakDeque.splice(0, peakHead);
      peakHead = 0;
    }

    const peakTrade = trades[peakDeque[peakHead]];
    if (!peakTrade || peakTrade.price <= 0) continue;
    const dropPct = (1 - trade.price / peakTrade.price) * 100;
    const ageMs = trade.at - migratedAt;
    const previous = index > 0 ? trades[index - 1] : null;
    const singleDropPct = previous && previous.price > 0
      ? Math.max(0, (1 - trade.price / previous.price) * 100)
      : 0;

    for (const ageGateSec of [5, 10, 30]) {
      if (ageMs < 0 || ageMs > ageGateSec * 1_000) continue;
      if (dropPct >= 25 && dropPct <= 35) {
        remember(`DIRECT_D25_35_A${ageGateSec}_D0`, trade);
        remember(`DIRECT_D25_35_A${ageGateSec}_D200`, trade);
        remember(`DIRECT_D25_35_A${ageGateSec}_D500`, trade);
        remember(`DIRECT_D25_35_A${ageGateSec}_NEXTBUY`, trade);
      }
      if (dropPct >= 20 && dropPct <= 35) remember(`DIRECT_D20_35_A${ageGateSec}_D200`, trade);
      if (trade.side === 'SELL') {
        for (const minSellSol of [1, 2, 5]) {
          if (trade.sol >= minSellSol && dropPct >= 15 && dropPct <= 55) {
            remember(`DUMP_${minSellSol}SOL_A${ageGateSec}_D200`, trade);
            remember(`DUMP_${minSellSol}SOL_A${ageGateSec}_NEXTBUY`, trade);
          }
        }
        if (trade.sol >= 1 && singleDropPct >= 15 && singleDropPct <= 70) {
          remember(`SINGLE_DUMP15_1SOL_A${ageGateSec}_D200`, trade);
          remember(`SINGLE_DUMP15_1SOL_A${ageGateSec}_NEXTBUY`, trade);
        }
      }
    }

    // Existing Lifecycle G baseline: 25-35% rolling drop, then 2-5% rebound within 1 second.
    if (!baselineSignal) {
      if (!candidate && dropPct >= 25 && dropPct <= 35) {
        candidate = { lowPrice: trade.price, lowAt: trade.at, lowIndex: index };
      } else if (candidate) {
        if (trade.price < candidate.lowPrice) {
          candidate = { lowPrice: trade.price, lowAt: trade.at, lowIndex: index };
        }
        const reboundPct = (trade.price / candidate.lowPrice - 1) * 100;
        if (trade.at - candidate.lowAt > 1_000 || dropPct > 35) candidate = null;
        else if (reboundPct >= 2 && reboundPct <= 5) {
          baselineSignal = trade;
          remember('BASE_R2_5_A30_D200', trade);
        }
      }
    }
  }

  // Non-causal ceiling: the lowest printed trade in the first second after the first 25-35% drop.
  const trigger = [...firstSignals.entries()].find(([name]) => name === 'DIRECT_D25_35_A30_D0')?.[1];
  if (trigger) {
    let low = trigger;
    for (let index = trigger.index; index < trades.length && trades[index].at <= trigger.at + 1_000; index += 1) {
      if (trades[index].price < low.price) low = trades[index];
    }
    remember('ORACLE_1S_LOW_A30', low);
  }

  for (const [variant, signal] of firstSignals) {
    const nextBuyOnly = variant.endsWith('_NEXTBUY');
    const delayMs = variant.includes('_D500') ? 500 : (variant.includes('_D200') || variant.startsWith('BASE_') ? 200 : 0);
    evaluateSignal(mint, trades, variant, signal, delayMs, nextBuyOnly);
  }
}

const tradeQuery = db.prepare(`
  SELECT r.mint,
         t.graduated_at,
         r.timestamp_ms,
         r.side,
         r.sol_amount,
         r.price,
         r.slot
  FROM raw_trades r
  JOIN flow_tokens t ON t.mint = r.mint
  WHERE r.market = 'PUMP_AMM'
    AND t.graduated_at IS NOT NULL
    AND r.timestamp_ms >= t.graduated_at
    AND r.timestamp_ms <= t.graduated_at + ?
    AND r.price > 0
  ORDER BY r.mint, r.timestamp_ms, r.id
`);

let currentMint = null;
let currentMigratedAt = null;
let trades = [];
let mintCount = 0;
let tradeCount = 0;
let sampleMinAt = Number.POSITIVE_INFINITY;
let sampleMaxAt = Number.NEGATIVE_INFINITY;
for (const row of tradeQuery.iterate(MAX_AGE_MS)) {
  if (currentMint !== null && row.mint !== currentMint) {
    processMint(currentMint, currentMigratedAt, trades);
    mintCount += 1;
    trades = [];
  }
  currentMint = row.mint;
  currentMigratedAt = Number(row.graduated_at);
  trades.push({
    at: Number(row.timestamp_ms),
    side: row.side,
    sol: finite(row.sol_amount, 0),
    price: Number(row.price),
    slot: Number(row.slot),
  });
  sampleMinAt = Math.min(sampleMinAt, Number(row.timestamp_ms));
  sampleMaxAt = Math.max(sampleMaxAt, Number(row.timestamp_ms));
  tradeCount += 1;
}
if (currentMint !== null) {
  processMint(currentMint, currentMigratedAt, trades);
  mintCount += 1;
}

const outputRows = [];
const sampleMidAt = Number.isFinite(sampleMinAt) && Number.isFinite(sampleMaxAt)
  ? sampleMinAt + ((sampleMaxAt - sampleMinAt) / 2)
  : null;
for (const [key, rows] of results) {
  const separator = key.lastIndexOf('|');
  const variant = key.slice(0, separator);
  const holdMs = Number(key.slice(separator + 1));
  outputRows.push({
    variant,
    holdSec: holdMs / 1_000,
    mark: summarize(rows, 'markNetPct'),
    exec0_1: summarize(rows, 'exec0_1Pct'),
    exec1: summarize(rows, 'exec1Pct'),
    early0_1: summarize(rows.filter((row) => row.entryAt < sampleMidAt), 'exec0_1Pct'),
    late0_1: summarize(rows.filter((row) => row.entryAt >= sampleMidAt), 'exec0_1Pct'),
    early1: summarize(rows.filter((row) => row.entryAt < sampleMidAt), 'exec1Pct'),
    late1: summarize(rows.filter((row) => row.entryAt >= sampleMidAt), 'exec1Pct'),
  });
}

function rank(rows, field) {
  return rows
    .filter((row) => row[field].resolved >= 20)
    .sort((a, b) => (b[field].avgPct ?? -999) - (a[field].avgPct ?? -999))
    .slice(0, 20);
}

const report = {
  dbPath,
  assumptions: {
    windowMs: WINDOW_MS,
    entryTimeoutMs: ENTRY_TIMEOUT_MS,
    confirmedEntryDelayMs: CONFIRMED_ENTRY_DELAY_MS,
    exitTimeoutMs: EXIT_TIMEOUT_MS,
    maxEntryJumpPct: MAX_ENTRY_JUMP_PCT,
    holdsSec: HOLDS_MS.map((value) => value / 1_000),
    sizesSol: SIZES_SOL,
    configuredCostsPct: Object.fromEntries(configuredCosts),
    empiricalCapacityImpactP75Pct: Object.fromEntries(capacityImpactPct),
    oracleWarning: 'ORACLE_1S_LOW is non-causal and is only a theoretical upper bound.',
    capacityWarning: 'PUMP_AMM per-trade reserves are absent; execution subtracts the 75th-percentile round-trip impact observed in real Lifecycle G fills of the same size.',
    priceScaleRule: 'Exit returns above +500% are excluded as incompatible/cross-scale prints; downside including -100% NO_EXIT remains uncapped.',
  },
  sample: { mintCount, tradeCount, minAt: sampleMinAt, midAt: sampleMidAt, maxAt: sampleMaxAt },
  topByMark: rank([...outputRows], 'mark'),
  topByExec0_1: rank([...outputRows], 'exec0_1'),
  topByExec1: rank([...outputRows], 'exec1'),
  all: outputRows.sort((a, b) => a.variant.localeCompare(b.variant) || a.holdSec - b.holdSec),
};

if (process.argv.includes('--focus')) {
  const focusVariants = new Set([
    'BASE_R2_5_A30_D200',
    'DIRECT_D25_35_A5_D200',
    'DIRECT_D25_35_A5_NEXTBUY',
    'DUMP_1SOL_A30_NEXTBUY',
    'DUMP_5SOL_A30_D200',
    'DUMP_5SOL_A30_NEXTBUY',
    'SINGLE_DUMP15_1SOL_A30_D200',
    'SINGLE_DUMP15_1SOL_A30_NEXTBUY',
    'ORACLE_1S_LOW_A30',
  ]);
  console.log(JSON.stringify(roundObject({
    assumptions: report.assumptions,
    sample: report.sample,
    rows: report.all
      .filter((row) => focusVariants.has(row.variant))
      .map((row) => ({
        variant: row.variant,
        holdSec: row.holdSec,
        exec0_1: row.exec0_1,
        exec1: row.exec1,
        early0_1: row.early0_1,
        late0_1: row.late0_1,
      })),
  }), null, 2));
} else if (process.argv.includes('--table')) {
  const selected = report.all.filter((row) => (
    row.variant === 'BASE_R2_5_A30_D200'
      || row.variant === 'ORACLE_1S_LOW_A30'
      || /^DIRECT_D25_35_A(5|10|30)_(D200|D500|NEXTBUY)$/.test(row.variant)
      || /^DUMP_(1|2|5)SOL_A(5|10|30)_(D200|NEXTBUY)$/.test(row.variant)
      || /^SINGLE_DUMP15_1SOL_A(5|10|30)_(D200|NEXTBUY)$/.test(row.variant)
  ));
  console.log(JSON.stringify(roundObject({
    assumptions: report.assumptions,
    sample: report.sample,
  })));
  console.log('variant\thold\tn\twin01\tavg01\tmed01\tpf01\trug50\trug80\tbig20\tbig50\twin1\tavg1\tmed1\tpf1\tearlyN\tearlyAvg01\tlateN\tlateAvg01\tinvalid');
  for (const row of selected) {
    console.log([
      row.variant,
      row.holdSec,
      row.exec0_1.resolved,
      row.exec0_1.winPct,
      row.exec0_1.avgPct,
      row.exec0_1.medianPct,
      row.exec0_1.pf,
      row.exec0_1.rug50Pct,
      row.exec0_1.rug80Pct,
      row.exec0_1.big20Pct,
      row.exec0_1.big50Pct,
      row.exec1.winPct,
      row.exec1.avgPct,
      row.exec1.medianPct,
      row.exec1.pf,
      row.early0_1.resolved,
      row.early0_1.avgPct,
      row.late0_1.resolved,
      row.late0_1.avgPct,
      row.exec0_1.invalidPriceScale,
    ].map((value) => Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : value).join('\t'));
  }
} else if (process.argv.includes('--compact')) {
  const selected = report.all.filter((row) => (
    row.variant === 'BASE_R2_5_A30_D200'
      || row.variant === 'ORACLE_1S_LOW_A30'
      || /^DIRECT_D25_35_A(5|10|30)_(D200|D500|NEXTBUY)$/.test(row.variant)
      || /^DUMP_(1|2|5)SOL_A(5|10|30)_(D200|NEXTBUY)$/.test(row.variant)
      || /^SINGLE_DUMP15_1SOL_A(5|10|30)_(D200|NEXTBUY)$/.test(row.variant)
  ));
  console.log(JSON.stringify(roundObject({
    dbPath: report.dbPath,
    assumptions: report.assumptions,
    sample: report.sample,
    topByExec0_1: report.topByExec0_1,
    topByExec1: report.topByExec1,
    selected,
  }), null, 2));
} else {
  console.log(JSON.stringify(roundObject(report), null, 2));
}
db.close();
