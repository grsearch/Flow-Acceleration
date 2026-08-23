'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');
const OUTPUT = path.join(REPORTS, 'toxic-template-retention-backtest-20260823.json');

const TEMPLATE_WINDOW_MS = 5_000;
const TEMPLATE_RECENT_MS = 30_000;
const LARGE_BUY_MIN_SOL = 1;
const MIN_LARGE_BUYS = 4;
const MAX_LARGE_BUYS = 6;
const MIN_TOTAL_BUY_SOL = 40;
const MAX_BURST_SPAN_MS = 500;
const SIZE_BUCKET_SOL = 0.25;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * pct)));
  return sorted[index];
}

function fingerprint(amounts, spanMs) {
  const amountKey = amounts
    .slice()
    .sort((a, b) => b - a)
    .map((amount) => (Math.round(amount / SIZE_BUCKET_SOL) * SIZE_BUCKET_SOL).toFixed(2))
    .join(',');
  let spanKey = '1000';
  if (spanMs <= 50) spanKey = '50';
  else if (spanMs <= 100) spanKey = '100';
  else if (spanMs <= 250) spanKey = '250';
  else if (spanMs <= 500) spanKey = '500';
  return `${amounts.length}|${spanKey}|${amountKey}`;
}

function findLatestTemplate(rows, signalAt) {
  let latest = null;
  for (let end = 0; end < rows.length; end += 1) {
    const observedAt = rows[end].timestamp_ms;
    if (observedAt > signalAt) break;
    const cutoff = observedAt - TEMPLATE_WINDOW_MS;
    const largeBuys = [];
    for (let index = end; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.timestamp_ms < cutoff) break;
      if (row.sol_amount >= LARGE_BUY_MIN_SOL) largeBuys.push(row);
    }
    largeBuys.reverse();
    if (largeBuys.length < MIN_LARGE_BUYS || largeBuys.length > MAX_LARGE_BUYS) continue;
    const spanMs = largeBuys[largeBuys.length - 1].timestamp_ms - largeBuys[0].timestamp_ms;
    const totalBuySol = largeBuys.reduce((sum, row) => sum + row.sol_amount, 0);
    if (spanMs > MAX_BURST_SPAN_MS || totalBuySol < MIN_TOTAL_BUY_SOL) continue;
    latest = {
      fingerprint: fingerprint(largeBuys.map((row) => row.sol_amount), spanMs),
      observedAt,
      spanMs,
      totalBuySol,
      largeBuyCount: largeBuys.length,
      wallets: [...new Set(largeBuys.map((row) => row.wallet).filter(Boolean))],
      amounts: largeBuys.map((row) => row.sol_amount).sort((a, b) => b - a),
    };
  }
  if (!latest || signalAt - latest.observedAt > TEMPLATE_RECENT_MS) return null;
  return latest;
}

function listDatabases() {
  return fs.readdirSync(REPORTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('last24h-202608'))
    .map((entry) => path.join(REPORTS, entry.name, 'flow-acceleration-last24h.db'))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function rowKey(row) {
  if (row.entry_signature) return `sig:${row.entry_signature}`;
  return [row.strategy_id, row.mint, row.signal_at, row.opened_at, row.created_at].join('|');
}

function preferRow(previous, next) {
  if (!previous) return next;
  const previousScore = (previous.realized_return_pct != null ? 4 : 0)
    + (previous.closed_at ? 2 : 0) + (previous.entry_signature ? 1 : 0);
  const nextScore = (next.realized_return_pct != null ? 4 : 0)
    + (next.closed_at ? 2 : 0) + (next.entry_signature ? 1 : 0);
  return nextScore >= previousScore ? next : previous;
}

function loadPositions(databases) {
  const unique = new Map();
  const sources = [];
  for (const dbPath of databases) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT lp.*,
             COALESCE(lsd.timestamp_ms, lp.opened_at, lp.created_at) AS signal_at
      FROM live_positions lp
      LEFT JOIN live_strategy_decisions lsd ON lsd.id = lp.strategy_decision_id
      WHERE UPPER(lp.mode) = 'LIVE'
        AND COALESCE(lsd.timestamp_ms, lp.opened_at, lp.created_at) IS NOT NULL
      ORDER BY signal_at
    `).all();
    sources.push({ dbPath, rows: rows.length });
    for (const row of rows) {
      const normalized = { ...row, dbPath };
      unique.set(rowKey(normalized), preferRow(unique.get(rowKey(normalized)), normalized));
    }
    db.close();
  }
  return { positions: [...unique.values()].sort((a, b) => a.signal_at - b.signal_at), sources };
}

function attachTemplates(positions) {
  const byDatabase = new Map();
  for (const row of positions) {
    const rows = byDatabase.get(row.dbPath) || [];
    rows.push(row);
    byDatabase.set(row.dbPath, rows);
  }
  for (const [dbPath, rows] of byDatabase) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const query = db.prepare(`
      SELECT timestamp_ms, wallet, sol_amount
      FROM raw_trades
      WHERE mint = ? AND side = 'BUY'
        AND timestamp_ms BETWEEN ? AND ?
        AND sol_amount >= ?
      ORDER BY timestamp_ms, id
    `);
    for (const row of rows) {
      const signalAt = finite(row.signal_at, 0);
      const trades = query.all(
        row.mint,
        signalAt - TEMPLATE_RECENT_MS - TEMPLATE_WINDOW_MS,
        signalAt,
        LARGE_BUY_MIN_SOL,
      );
      row.template = findLatestTemplate(trades, signalAt);
      row.price_return_pct = row.entry_price > 0 && row.exit_price > 0
        ? ((row.exit_price / row.entry_price) - 1) * 100 : null;
    }
    db.close();
  }
}

function backtest(positions, retentionMs) {
  const templates = new Map();
  const wallets = new Map();
  const stats = {
    retentionMs: Number.isFinite(retentionMs) ? retentionMs : null,
    evaluated: 0, blocked: 0, blockedExact: 0, blockedWallet: 0,
    catastrophes: 0, catastrophesBlocked: 0,
    winnersBlocked: 0, nonWinnersBlocked: 0,
    pnlOfBlockedSol: 0, avoidedLossSol: 0, missedProfitSol: 0,
    firstCatastrophesLearned: 0,
  };
  const isActive = (expiresAt, timestamp) => expiresAt === Infinity || expiresAt > timestamp;
  for (const row of positions) {
    if (!row.template) continue;
    stats.evaluated += 1;
    const timestamp = row.signal_at;
    const exact = templates.get(row.template.fingerprint);
    const exactMatch = exact && isActive(exact.expiresAt, timestamp);
    let walletOverlap = 0;
    for (const wallet of row.template.wallets) {
      const record = wallets.get(wallet);
      if (record && isActive(record.expiresAt, timestamp)) walletOverlap += 1;
    }
    const walletMatch = walletOverlap >= 2;
    const blocked = Boolean(exactMatch || walletMatch);
    const returnPct = finite(row.realized_return_pct);
    const pnl = finite(row.realized_pnl_sol, 0);
    const catastrophic = returnPct != null && returnPct <= -50;
    if (catastrophic) stats.catastrophes += 1;
    if (blocked) {
      stats.blocked += 1;
      if (exactMatch) stats.blockedExact += 1;
      if (walletMatch) stats.blockedWallet += 1;
      stats.pnlOfBlockedSol += pnl;
      if (pnl < 0) stats.avoidedLossSol += -pnl;
      if (pnl > 0) stats.missedProfitSol += pnl;
      if (returnPct != null && returnPct > 0) stats.winnersBlocked += 1;
      else stats.nonWinnersBlocked += 1;
      if (catastrophic) stats.catastrophesBlocked += 1;
    }
    if (catastrophic) {
      const learnedAt = finite(row.closed_at, finite(row.updated_at, timestamp));
      const expiresAt = Number.isFinite(retentionMs) ? learnedAt + retentionMs : Infinity;
      const previous = templates.get(row.template.fingerprint);
      if (!previous || !isActive(previous.expiresAt, learnedAt)) stats.firstCatastrophesLearned += 1;
      templates.set(row.template.fingerprint, {
        expiresAt, learnedAt, mint: row.mint,
      });
      for (const wallet of row.template.wallets) wallets.set(wallet, { expiresAt, learnedAt });
    }
  }
  stats.blockRatePct = stats.evaluated ? stats.blocked / stats.evaluated * 100 : 0;
  stats.catastropheRecallPct = stats.catastrophes
    ? stats.catastrophesBlocked / stats.catastrophes * 100 : 0;
  stats.blockedWinnerRatePct = stats.blocked
    ? stats.winnersBlocked / stats.blocked * 100 : 0;
  stats.counterfactualPnlImprovementSol = -stats.pnlOfBlockedSol;
  return stats;
}

function summarize(positions) {
  const resolved = positions.filter((row) => finite(row.realized_return_pct) != null);
  const catastrophic = resolved.filter((row) => finite(row.realized_return_pct) <= -50);
  const priceCatastrophic = resolved.filter((row) => finite(row.price_return_pct) <= -50);
  const priceCatastrophic60 = resolved.filter((row) => finite(row.price_return_pct) <= -60);
  const actualAndPrice50 = catastrophic.filter((row) => finite(row.price_return_pct) <= -50);
  const actualAndPrice60 = catastrophic.filter((row) => finite(row.price_return_pct) <= -60);
  const executionAmplifiedCatastrophic = catastrophic.filter((row) => (
    finite(row.price_return_pct) == null || finite(row.price_return_pct) > -50
  ));
  const templated = resolved.filter((row) => row.template);
  const catastrophicTemplated = catastrophic.filter((row) => row.template);
  const totalPnlSol = resolved.reduce((sum, row) => sum + finite(row.realized_pnl_sol, 0), 0);
  const catastrophicPnlSol = catastrophic.reduce(
    (sum, row) => sum + finite(row.realized_pnl_sol, 0), 0,
  );
  const templateCounts = new Map();
  for (const row of catastrophicTemplated) {
    const item = templateCounts.get(row.template.fingerprint) || {
      fingerprint: row.template.fingerprint, catastrophes: 0, mints: new Set(),
      totalPnlSol: 0, returns: [], wallets: new Set(), sampleAmounts: row.template.amounts,
    };
    item.catastrophes += 1;
    item.mints.add(row.mint);
    item.totalPnlSol += finite(row.realized_pnl_sol, 0);
    item.returns.push(finite(row.realized_return_pct));
    for (const wallet of row.template.wallets) item.wallets.add(wallet);
    templateCounts.set(row.template.fingerprint, item);
  }
  const topTemplates = [...templateCounts.values()]
    .map((item) => ({
      fingerprint: item.fingerprint,
      catastrophes: item.catastrophes,
      uniqueMints: item.mints.size,
      totalPnlSol: item.totalPnlSol,
      medianReturnPct: percentile(item.returns, 0.5),
      wallets: item.wallets.size,
      sampleAmounts: item.sampleAmounts,
    }))
    .sort((a, b) => b.catastrophes - a.catastrophes || a.totalPnlSol - b.totalPnlSol);
  return {
    positions: positions.length,
    resolved: resolved.length,
    totalPnlSol,
    catastrophicPnlSol,
    firstSignalAt: positions[0]?.signal_at || null,
    lastSignalAt: positions[positions.length - 1]?.signal_at || null,
    catastrophicActualLoss50: catastrophic.length,
    catastrophicPriceDrop50: priceCatastrophic.length,
    catastrophicPriceDrop60: priceCatastrophic60.length,
    catastrophicActualAndPriceDrop50: actualAndPrice50.length,
    catastrophicActualAndPriceDrop60: actualAndPrice60.length,
    catastrophicActualLoss50WithoutPriceDrop50: executionAmplifiedCatastrophic.length,
    templatedResolved: templated.length,
    templatedCatastrophes: catastrophicTemplated.length,
    templateCoverageOfCatastrophesPct: catastrophic.length
      ? catastrophicTemplated.length / catastrophic.length * 100 : 0,
    uniqueCatastrophicTemplates: templateCounts.size,
    recurrentCatastrophicTemplates: topTemplates.filter((item) => item.uniqueMints >= 2).length,
    topTemplates: topTemplates.slice(0, 30),
  };
}

function main() {
  const databases = listDatabases();
  const { positions, sources } = loadPositions(databases);
  attachTemplates(positions);
  const report = {
    generatedAt: Date.now(),
    definition: {
      templateWindowMs: TEMPLATE_WINDOW_MS,
      templateRecentMs: TEMPLATE_RECENT_MS,
      largeBuyMinSol: LARGE_BUY_MIN_SOL,
      minLargeBuys: MIN_LARGE_BUYS,
      maxLargeBuys: MAX_LARGE_BUYS,
      minTotalBuySol: MIN_TOTAL_BUY_SOL,
      maxBurstSpanMs: MAX_BURST_SPAN_MS,
      sizeBucketSol: SIZE_BUCKET_SOL,
      catastrophicActualReturnPct: -50,
    },
    databases: sources,
    summary: summarize(positions),
    retentionBacktests: [
      backtest(positions, 86_400_000),
      backtest(positions, 3 * 86_400_000),
      backtest(positions, 7 * 86_400_000),
      backtest(positions, Infinity),
    ],
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
