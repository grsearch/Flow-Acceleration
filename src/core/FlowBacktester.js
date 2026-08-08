'use strict';

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function excursion(prices, entryPrice) {
  const changes = prices
    .filter((price) => Number.isFinite(price) && price > 0)
    .map((price) => ((price / entryPrice) - 1) * 100);
  if (changes.length === 0) return { mfe: null, mae: null };
  return { mfe: Math.max(...changes), mae: Math.min(...changes) };
}

function runBacktest(db, options = {}) {
  const holdMs = Math.max(1, finite(options.holdMs, 5_000));
  const executionDelayMs = Math.max(0, finite(options.executionDelayMs, 200));
  const platformFeePct = Math.max(0, finite(
    options.platformFeePct,
    finite(options.tradingCostPct, 1.4),
  ));
  const buySlippagePct = Math.max(0, finite(options.buySlippagePct, 0));
  const sellSlippagePct = Math.max(0, finite(options.sellSlippagePct, 0));
  const priceImpactPct = Math.max(0, finite(options.priceImpactPct, 0));
  const baseTxFeeSol = Math.max(0, finite(options.baseTxFeeSol, 0));
  const priorityFeeSol = Math.max(0, finite(options.priorityFeeSol, 0));
  const jitoTipSol = Math.max(0, finite(options.jitoTipSol, 0));
  const fixedCostSol = Math.max(0, finite(options.fixedCostSol, 0));
  const positionSizeSol = Math.max(0.000001, finite(options.positionSizeSol, 0.2));
  const failureRatePct = Math.min(100, Math.max(0, finite(options.failureRatePct, 0)));
  const failureLossPct = Math.max(0, finite(options.failureLossPct, 0));
  const minNetFlowW3 = Math.max(0, finite(options.minNetFlowW3, 0));
  const minFlowAccel = Math.max(0, finite(options.minFlowAccel, 0));
  const limit = Math.min(100_000, Math.max(1, Math.trunc(finite(options.limit, 10_000))));

  const signals = db.prepare(`
    SELECT * FROM flow_signals
    WHERE netflow_w3 >= ?
    ORDER BY timestamp_ms
    LIMIT ?
  `).all(minNetFlowW3, limit).filter((signal) => (
    minFlowAccel <= 0 || (Number.isFinite(signal.flow_accel) && signal.flow_accel >= minFlowAccel)
  ));

  const firstTradeAtOrAfter = db.prepare(`
    SELECT timestamp_ms, price, market
    FROM raw_trades
    WHERE mint = ? AND timestamp_ms >= ? AND price > 0
    ORDER BY timestamp_ms, id
    LIMIT 1
  `);
  const pathBetween = db.prepare(`
    SELECT price
    FROM raw_trades
    WHERE mint = ? AND timestamp_ms >= ? AND timestamp_ms <= ? AND price > 0
    ORDER BY timestamp_ms, id
  `);

  const totalFixedCostSol = baseTxFeeSol + priorityFeeSol + jitoTipSol + fixedCostSol;
  const fixedCostPct = (totalFixedCostSol / positionSizeSol) * 100;
  const expectedFailureCostPct = (failureRatePct / 100) * failureLossPct;
  const totalCostPct = platformFeePct + buySlippagePct + sellSlippagePct
    + priceImpactPct + fixedCostPct + expectedFailureCostPct;
  const rows = [];
  let skippedNoEntry = 0;
  let skippedNoExit = 0;

  for (const signal of signals) {
    const entry = firstTradeAtOrAfter.get(signal.mint, signal.timestamp_ms + executionDelayMs);
    if (!entry) {
      skippedNoEntry += 1;
      continue;
    }
    const exit = firstTradeAtOrAfter.get(signal.mint, entry.timestamp_ms + holdMs);
    if (!exit) {
      skippedNoExit += 1;
      continue;
    }
    const rawReturnPct = ((exit.price / entry.price) - 1) * 100;
    const netReturnPct = rawReturnPct - totalCostPct;
    const signalToEntryPct = ((entry.price / signal.p0) - 1) * 100;
    const prices = pathBetween.all(signal.mint, entry.timestamp_ms, exit.timestamp_ms)
      .map((row) => row.price);
    const { mfe, mae } = excursion([entry.price, ...prices], entry.price);
    rows.push({
      signalId: signal.signal_id,
      mint: signal.mint,
      signalAt: signal.timestamp_ms,
      entryAt: entry.timestamp_ms,
      exitAt: exit.timestamp_ms,
      actualDelayMs: entry.timestamp_ms - signal.timestamp_ms,
      actualHoldMs: exit.timestamp_ms - entry.timestamp_ms,
      entryMarket: entry.market,
      exitMarket: exit.market,
      rawReturnPct,
      netReturnPct,
      signalToEntryPct,
      mfePct: mfe,
      maePct: mae,
    });
  }

  const rawReturns = rows.map((row) => row.rawReturnPct);
  const netReturns = rows.map((row) => row.netReturnPct);
  const wins = netReturns.filter((value) => value > 0);
  const losses = netReturns.filter((value) => value < 0);
  const grossProfit = wins.reduce((total, value) => total + value, 0);
  const grossLoss = Math.abs(losses.reduce((total, value) => total + value, 0));

  return {
    parameters: {
      holdMs,
      executionDelayMs,
      platformFeePct,
      buySlippagePct,
      sellSlippagePct,
      priceImpactPct,
      baseTxFeeSol,
      priorityFeeSol,
      jitoTipSol,
      fixedCostSol,
      totalFixedCostSol,
      positionSizeSol,
      failureRatePct,
      failureLossPct,
      totalCostPct,
      minNetFlowW3,
      minFlowAccel,
    },
    metrics: {
      candidateSignals: signals.length,
      samples: rows.length,
      skippedNoEntry,
      skippedNoExit,
      winRatePct: rows.length ? (wins.length / rows.length) * 100 : null,
      averageRawReturnPct: average(rawReturns),
      averageNetReturnPct: average(netReturns),
      medianNetReturnPct: median(netReturns),
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
      expectancyPct: average(netReturns),
      averageMfePct: average(rows.map((row) => row.mfePct).filter(Number.isFinite)),
      averageMaePct: average(rows.map((row) => row.maePct).filter(Number.isFinite)),
      averageActualDelayMs: average(rows.map((row) => row.actualDelayMs)),
      averageLatencyMovePct: average(rows.map((row) => row.signalToEntryPct)),
    },
    rows: options.includeRows === false ? undefined : rows,
  };
}

module.exports = {
  runBacktest,
};
