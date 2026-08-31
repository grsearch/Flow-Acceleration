'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'data', 'backtest-20260831', 'flow-acceleration-last24h.db');

const AGE_GATES_SEC = [30, 60, 120, 300];
const MAX_ENTRIES = [1, 2, 3];
const HOLD_MS = 8_000;
const REENTRY_COOLDOWN_MS = 2_000;
const ENTRY_DELAY_MS = 200;
const LOOKAHEAD_MS = 2_000;
const EXIT_LOOKAHEAD_MS = 5_000;
const MAX_ENTRY_JUMP_PCT = 15;
const SIZE_SOL = 1;

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
  return sorted[Math.floor((sorted.length - 1) * q)];
}

const configuredCostPct = finite(db.prepare(`
  SELECT AVG(configured_cost_pct) AS value
  FROM migrated_drop_rebound_shadow_positions
  WHERE position_sol = ? AND configured_cost_pct IS NOT NULL
`).get(SIZE_SOL)?.value, 2.25);

const impactSamples = db.prepare(`
  SELECT entry_impact_pct, exit_impact_pct
  FROM migrated_drop_rebound_shadow_positions
  WHERE status = 'CLOSED'
    AND position_sol = ?
    AND entry_impact_pct IS NOT NULL
    AND exit_impact_pct IS NOT NULL
    AND ABS(entry_impact_pct) <= 100
    AND ABS(exit_impact_pct) <= 100
`).all(SIZE_SOL)
  .map((row) => Math.abs(Number(row.entry_impact_pct)) + Math.abs(Number(row.exit_impact_pct)))
  .filter(Number.isFinite);
const capacityImpactPct = quantile(impactSamples, 0.75) ?? 3;

function findAtOrAfter(trades, startIndex, targetAt, maxDelayMs, predicate = null) {
  for (let index = startIndex + 1; index < trades.length; index += 1) {
    const trade = trades[index];
    if (trade.at < targetAt) continue;
    if (trade.at > targetAt + maxDelayMs) return null;
    if (!predicate || predicate(trade)) return trade;
  }
  return null;
}

function buildCandidates(trades, migratedAt) {
  const candidates = [];
  const peakDeque = [];
  let head = 0;
  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    while (head < peakDeque.length && trades[peakDeque[head]].at < trade.at - 1_000) head += 1;
    while (peakDeque.length > head && trades[peakDeque[peakDeque.length - 1]].price <= trade.price) peakDeque.pop();
    peakDeque.push(index);
    if (head > 512) {
      peakDeque.splice(0, head);
      head = 0;
    }
    const peak = trades[peakDeque[head]];
    if (!peak || peak.price <= 0) continue;
    const dropPct = 100 * (1 - (trade.price / peak.price));
    const ageMs = trade.at - migratedAt;
    if (
      ageMs >= 0
      && ageMs <= 300_000
      && trade.side === 'SELL'
      && trade.sol >= 5
      && dropPct >= 15
      && dropPct <= 55
    ) {
      candidates.push({ index, at: trade.at, price: trade.price, ageMs, dropPct, sellSol: trade.sol });
    }
  }
  return candidates;
}

function resolveEntry(trades, signal) {
  const buy = findAtOrAfter(trades, signal.index, signal.at, LOOKAHEAD_MS, (trade) => trade.side === 'BUY');
  if (!buy) return null;
  const entry = findAtOrAfter(trades, buy.index, buy.at + ENTRY_DELAY_MS, LOOKAHEAD_MS);
  if (!entry || entry.price <= 0) return null;
  const entryJumpPct = 100 * ((entry.price / signal.price) - 1);
  if (entryJumpPct > MAX_ENTRY_JUMP_PCT) return null;
  return { buy, entry, entryJumpPct };
}

function resolvePosition(mint, trades, signal, occurrence) {
  const resolved = resolveEntry(trades, signal);
  if (!resolved) return null;
  const { entry, entryJumpPct } = resolved;
  const exit = findAtOrAfter(trades, entry.index, entry.at + HOLD_MS, EXIT_LOOKAHEAD_MS);
  const pathEnd = exit?.at ?? (entry.at + HOLD_MS + EXIT_LOOKAHEAD_MS);
  let high = entry.price;
  let low = entry.price;
  for (let index = entry.index + 1; index < trades.length && trades[index].at <= pathEnd; index += 1) {
    high = Math.max(high, trades[index].price);
    low = Math.min(low, trades[index].price);
  }
  const grossPct = exit ? 100 * ((exit.price / entry.price) - 1) : -100;
  if (exit && grossPct > 500) return { invalid: true, nextEligibleAt: entry.at + HOLD_MS + REENTRY_COOLDOWN_MS };
  return {
    mint,
    occurrence,
    signalAt: signal.at,
    entryAt: entry.at,
    exitAt: exit?.at ?? null,
    signalAgeSec: signal.ageMs / 1_000,
    sellSol: signal.sellSol,
    dropPct: signal.dropPct,
    entryJumpPct,
    noExit: !exit,
    grossPct,
    netPct: grossPct - configuredCostPct - capacityImpactPct,
    mfePct: 100 * ((high / entry.price) - 1),
    maePct: 100 * ((low / entry.price) - 1),
    invalid: false,
    nextEligibleAt: entry.at + HOLD_MS + REENTRY_COOLDOWN_MS,
  };
}

const cohorts = new Map();
for (const ageSec of AGE_GATES_SEC) {
  for (const maxEntries of MAX_ENTRIES) cohorts.set(`${ageSec}|${maxEntries}`, []);
}
const occurrenceRows = new Map(MAX_ENTRIES.map((occurrence) => [occurrence, []]));

function processMint(mint, migratedAt, trades) {
  for (let index = 0; index < trades.length; index += 1) trades[index].index = index;
  const candidates = buildCandidates(trades, migratedAt);
  for (const ageSec of AGE_GATES_SEC) {
    const accepted = [];
    let nextEligibleAt = Number.NEGATIVE_INFINITY;
    for (const signal of candidates) {
      if (signal.ageMs > ageSec * 1_000 || signal.at < nextEligibleAt) continue;
      const row = resolvePosition(mint, trades, signal, accepted.length + 1);
      if (!row) continue;
      nextEligibleAt = row.nextEligibleAt;
      if (!row.invalid) accepted.push(row);
      if (accepted.length >= Math.max(...MAX_ENTRIES)) break;
    }
    for (const maxEntries of MAX_ENTRIES) {
      cohorts.get(`${ageSec}|${maxEntries}`).push(...accepted.slice(0, maxEntries));
    }
    if (ageSec === 300) {
      for (const row of accepted) occurrenceRows.get(row.occurrence).push(row);
    }
  }
}

const query = db.prepare(`
  SELECT r.mint, t.graduated_at, r.timestamp_ms, r.side, r.sol_amount, r.price, r.slot
  FROM raw_trades r
  JOIN flow_tokens t ON t.mint = r.mint
  WHERE r.market = 'PUMP_AMM'
    AND t.graduated_at IS NOT NULL
    AND r.timestamp_ms >= t.graduated_at
    AND r.timestamp_ms <= t.graduated_at + 305000
    AND r.price > 0
  ORDER BY r.mint, r.timestamp_ms, r.id
`);

let currentMint = null;
let migratedAt = null;
let trades = [];
let mintCount = 0;
let tradeCount = 0;
for (const row of query.iterate()) {
  if (currentMint !== null && currentMint !== row.mint) {
    processMint(currentMint, migratedAt, trades);
    mintCount += 1;
    trades = [];
  }
  currentMint = row.mint;
  migratedAt = Number(row.graduated_at);
  trades.push({
    at: Number(row.timestamp_ms),
    side: row.side,
    sol: finite(row.sol_amount, 0),
    price: Number(row.price),
    slot: Number(row.slot),
  });
  tradeCount += 1;
}
if (currentMint !== null) {
  processMint(currentMint, migratedAt, trades);
  mintCount += 1;
}

function summarize(rows) {
  const values = rows.map((row) => row.netPct).filter(Number.isFinite);
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const byMint = new Map();
  for (const row of rows) {
    const bucket = byMint.get(row.mint) ?? [];
    bucket.push(row);
    byMint.set(row.mint, bucket);
  }
  const mintReturns = [...byMint.values()].map((items) => items.reduce((sum, row) => sum + row.netPct, 0));
  return {
    positions: values.length,
    mints: byMint.size,
    multiEntryMints: [...byMint.values()].filter((items) => items.length > 1).length,
    winPct: values.length ? 100 * values.filter((value) => value > 0).length / values.length : null,
    avgPct: mean(values),
    medianPct: quantile(values, 0.5),
    pf: losses ? gains / losses : (gains ? 999 : 0),
    rug50Pct: values.length ? 100 * values.filter((value) => value <= -50).length / values.length : null,
    rug80Pct: values.length ? 100 * values.filter((value) => value <= -80).length / values.length : null,
    mintAvgPct: mean(mintReturns),
    mintMedianPct: quantile(mintReturns, 0.5),
    avgAgeSec: mean(rows.map((row) => row.signalAgeSec)),
  };
}

const firstCliffAudit = db.prepare(`
  SELECT lifecycle_stage,
         COUNT(*) AS n,
         SUM(CASE WHEN outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS cliffs,
         AVG(CASE WHEN outcome = 'CLIFF_RUG_70' THEN hc1_matched END) AS hc1_cliff_recall,
         AVG(CASE WHEN outcome = 'NO_CLIFF_30S' THEN hc1_matched END) AS hc1_false_positive,
         AVG(CASE WHEN outcome = 'CLIFF_RUG_70' THEN hc2_matched END) AS hc2_cliff_recall,
         AVG(CASE WHEN outcome = 'NO_CLIFF_30S' THEN hc2_matched END) AS hc2_false_positive
  FROM pre_entry_rug_first_cliff_audits
  GROUP BY lifecycle_stage
  ORDER BY lifecycle_stage
`).all();

const report = {
  dbPath,
  assumptions: {
    signal: 'post-migration SELL >=5 SOL + rolling 1s drop 15-55%; next real BUY within 2s; simulated fill 200ms later',
    holdSec: HOLD_MS / 1_000,
    reentryCooldownSec: REENTRY_COOLDOWN_MS / 1_000,
    maxEntryJumpPct: MAX_ENTRY_JUMP_PCT,
    positionSol: SIZE_SOL,
    configuredCostPct,
    empiricalRoundTripImpactP75Pct: capacityImpactPct,
    noExit: '-100%',
    crossMarketScaleRule: 'exit gross > +500% excluded',
  },
  sample: { mintCount, tradeCount },
  cohorts: [...cohorts.entries()].map(([key, rows]) => {
    const [ageSec, maxEntries] = key.split('|').map(Number);
    return { ageSec, maxEntries, ...summarize(rows) };
  }),
  occurrenceAt300s: [...occurrenceRows.entries()].map(([occurrence, rows]) => ({ occurrence, ...summarize(rows) })),
  firstCliffAudit,
  rugPolicyNote: 'Current RugGuardPolicy labels MIGRATED_DROP_REBOUND entries in AMM_EARLY instead of hard-blocking them; current avoided entries for this family are therefore zero by design.',
};

console.log(JSON.stringify(report, null, 2));
db.close();
