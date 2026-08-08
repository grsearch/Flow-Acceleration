'use strict';

const { costBreakdown, expectedNetReturnPct } = require('./CostModel');

const STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  NO_ENTRY: 'NO_ENTRY',
  NO_EXIT: 'NO_EXIT',
  GRADUATED_BEFORE_ENTRY: 'GRADUATED_BEFORE_ENTRY',
  DATA_UNAVAILABLE: 'DATA_UNAVAILABLE',
  RIGHT_CENSORED: 'RIGHT_CENSORED',
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function weightedAverage(outcomes) {
  const totalWeight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
  if (totalWeight <= 0) return null;
  return outcomes.reduce((total, outcome) => total + outcome.value * outcome.weight, 0) / totalWeight;
}

function weightedMedian(outcomes) {
  if (outcomes.length === 0) return null;
  const sorted = [...outcomes].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((total, outcome) => total + outcome.weight, 0);
  let cumulative = 0;
  for (const outcome of sorted) {
    cumulative += outcome.weight;
    if (cumulative >= totalWeight / 2) return outcome.value;
  }
  return sorted[sorted.length - 1].value;
}

function excursion(prices, entryPrice) {
  const changes = prices
    .filter((price) => Number.isFinite(price) && price > 0)
    .map((price) => ((price / entryPrice) - 1) * 100);
  if (changes.length === 0) return { mfe: null, mae: null };
  return { mfe: Math.max(...changes), mae: Math.min(...changes) };
}

function passesAcceleration(signal, threshold) {
  if (threshold <= 0) return true;
  const ratios = [signal.flow_accel_1, signal.flow_accel_2]
    .filter((value) => Number.isFinite(value));
  return ratios.length === 0 || ratios.every((value) => value >= threshold);
}

function blankRow(signal, status) {
  return {
    signalId: signal.signal_id,
    mint: signal.mint,
    status,
    signalAt: signal.timestamp_ms,
    graduatedAt: signal.graduated_at,
    entryAt: null,
    exitAt: null,
    actualDelayMs: null,
    actualHoldMs: null,
    entryMarket: null,
    exitMarket: null,
    rawReturnPct: status === STATUS.NO_EXIT ? null : 0,
    netReturnPct: status === STATUS.NO_EXIT ? null : 0,
    expectedNetReturnPct: status === STATUS.NO_EXIT ? null : 0,
    signalToEntryPct: null,
    mfePct: null,
    maePct: null,
  };
}

function runBacktest(db, options = {}) {
  const holdMs = Math.max(1, finite(options.holdMs, 5_000));
  const executionDelayMs = Math.max(0, finite(options.executionDelayMs, 200));
  const entryTimeoutMs = Math.max(1, finite(options.entryTimeoutMs, 2_000));
  const exitTimeoutMs = Math.max(1, finite(options.exitTimeoutMs, 5_000));
  const noExitLossPct = Math.max(0, finite(options.noExitLossPct, 100));
  const minNetFlowW3 = Math.max(0, finite(options.minNetFlowW3, 0));
  const minFlowAccel = Math.max(0, finite(options.minFlowAccel, 0));
  const limit = Math.min(100_000, Math.max(1, Math.trunc(finite(options.limit, 10_000))));
  const costs = costBreakdown(options);

  const signals = db.prepare(`
    SELECT s.*, t.graduated_at
    FROM flow_signals s
    LEFT JOIN flow_tokens t USING(mint)
    WHERE s.netflow_w3 >= ?
    ORDER BY s.timestamp_ms
    LIMIT ?
  `).all(minNetFlowW3, limit).filter((signal) => passesAcceleration(signal, minFlowAccel));

  const coverage = db.prepare(`
    SELECT MIN(timestamp_ms) AS min_timestamp_ms, MAX(timestamp_ms) AS max_timestamp_ms
    FROM raw_trades
  `).get();
  const firstCurveTradeBetween = db.prepare(`
    SELECT timestamp_ms, price, market
    FROM raw_trades
    WHERE mint = ?
      AND market = 'PUMP_BONDING_CURVE'
      AND timestamp_ms >= ? AND timestamp_ms <= ?
      AND price > 0
    ORDER BY timestamp_ms, id
    LIMIT 1
  `);
  const firstTradeBetween = db.prepare(`
    SELECT timestamp_ms, price, market
    FROM raw_trades
    WHERE mint = ? AND timestamp_ms >= ? AND timestamp_ms <= ? AND price > 0
    ORDER BY timestamp_ms, id
    LIMIT 1
  `);
  const pathBetween = db.prepare(`
    SELECT price
    FROM raw_trades
    WHERE mint = ? AND timestamp_ms >= ? AND timestamp_ms <= ? AND price > 0
    ORDER BY timestamp_ms, id
  `);

  const rows = [];
  for (const signal of signals) {
    const entryTarget = signal.timestamp_ms + executionDelayMs;
    const entryWindowEnd = entryTarget + entryTimeoutMs;
    const graduatedAt = Number.isFinite(signal.graduated_at) ? signal.graduated_at : null;

    if (graduatedAt != null && graduatedAt <= entryTarget) {
      rows.push(blankRow(signal, STATUS.GRADUATED_BEFORE_ENTRY));
      continue;
    }

    const curveEntryEnd = graduatedAt == null
      ? entryWindowEnd
      : Math.min(entryWindowEnd, graduatedAt - 1);
    const entry = curveEntryEnd >= entryTarget
      ? firstCurveTradeBetween.get(signal.mint, entryTarget, curveEntryEnd)
      : null;

    if (!entry) {
      let status = STATUS.NO_ENTRY;
      if (!Number.isFinite(coverage.max_timestamp_ms)
        || coverage.max_timestamp_ms < entryWindowEnd) {
        status = STATUS.RIGHT_CENSORED;
      } else if (Number.isFinite(coverage.min_timestamp_ms)
        && coverage.min_timestamp_ms > entryWindowEnd) {
        status = STATUS.DATA_UNAVAILABLE;
      } else if (graduatedAt != null && graduatedAt <= entryWindowEnd) {
        status = STATUS.GRADUATED_BEFORE_ENTRY;
      }
      rows.push(blankRow(signal, status));
      continue;
    }

    const exitTarget = entry.timestamp_ms + holdMs;
    const exitWindowEnd = exitTarget + exitTimeoutMs;
    const exit = firstTradeBetween.get(signal.mint, exitTarget, exitWindowEnd);
    if (!exit) {
      if (!Number.isFinite(coverage.max_timestamp_ms)
        || coverage.max_timestamp_ms < exitWindowEnd) {
        const row = blankRow(signal, STATUS.RIGHT_CENSORED);
        row.entryAt = entry.timestamp_ms;
        row.actualDelayMs = entry.timestamp_ms - signal.timestamp_ms;
        row.entryMarket = entry.market;
        rows.push(row);
      } else {
        const row = blankRow(signal, STATUS.NO_EXIT);
        row.entryAt = entry.timestamp_ms;
        row.actualDelayMs = entry.timestamp_ms - signal.timestamp_ms;
        row.entryMarket = entry.market;
        row.rawReturnPct = -noExitLossPct;
        row.netReturnPct = row.rawReturnPct - costs.deterministicCostPct;
        row.expectedNetReturnPct = row.netReturnPct;
        rows.push(row);
      }
      continue;
    }

    const rawReturnPct = ((exit.price / entry.price) - 1) * 100;
    const netReturnPct = rawReturnPct - costs.deterministicCostPct;
    const signalToEntryPct = ((entry.price / signal.p0) - 1) * 100;
    const prices = pathBetween.all(signal.mint, entry.timestamp_ms, exit.timestamp_ms)
      .map((row) => row.price);
    const { mfe, mae } = excursion([entry.price, ...prices], entry.price);
    rows.push({
      ...blankRow(signal, STATUS.COMPLETED),
      entryAt: entry.timestamp_ms,
      exitAt: exit.timestamp_ms,
      actualDelayMs: entry.timestamp_ms - signal.timestamp_ms,
      actualHoldMs: exit.timestamp_ms - entry.timestamp_ms,
      entryMarket: entry.market,
      exitMarket: exit.market,
      rawReturnPct,
      netReturnPct,
      expectedNetReturnPct: expectedNetReturnPct(rawReturnPct, costs),
      signalToEntryPct,
      mfePct: mfe,
      maePct: mae,
    });
  }

  const unresolvedStatuses = new Set([STATUS.DATA_UNAVAILABLE, STATUS.RIGHT_CENSORED]);
  const resolvedRows = rows.filter((row) => !unresolvedStatuses.has(row.status));
  const completedRows = rows.filter((row) => row.status === STATUS.COMPLETED);
  const enteredRows = rows.filter((row) => row.entryAt != null);
  const resolvedEnteredRows = enteredRows.filter((row) => !unresolvedStatuses.has(row.status));
  const outcomes = [];
  const failureProbability = costs.failureRatePct / 100;
  for (const row of resolvedRows) {
    if (row.status === STATUS.COMPLETED) {
      if (failureProbability < 1) {
        outcomes.push({ value: row.netReturnPct, weight: 1 - failureProbability });
      }
      if (failureProbability > 0) {
        outcomes.push({ value: -costs.failureLossPct, weight: failureProbability });
      }
    } else {
      outcomes.push({ value: row.netReturnPct, weight: 1 });
    }
  }

  const rawReturns = resolvedRows.map((row) => row.rawReturnPct).filter(Number.isFinite);
  const wins = outcomes.filter((outcome) => outcome.value > 0);
  const losses = outcomes.filter((outcome) => outcome.value < 0);
  const totalOutcomeWeight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
  const grossProfit = wins.reduce((total, outcome) => total + outcome.value * outcome.weight, 0);
  const grossLoss = Math.abs(
    losses.reduce((total, outcome) => total + outcome.value * outcome.weight, 0),
  );
  const count = (status) => rows.filter((row) => row.status === status).length;

  return {
    parameters: {
      holdMs,
      executionDelayMs,
      entryTimeoutMs,
      exitTimeoutMs,
      noExitLossPct,
      ...costs,
      totalCostPct: costs.deterministicCostPct,
      minNetFlowW3,
      minFlowAccel,
    },
    metrics: {
      candidateSignals: signals.length,
      samples: resolvedRows.length,
      completedSamples: completedRows.length,
      enteredSamples: enteredRows.length,
      noEntry: count(STATUS.NO_ENTRY),
      noExit: count(STATUS.NO_EXIT),
      graduatedBeforeEntry: count(STATUS.GRADUATED_BEFORE_ENTRY),
      dataUnavailable: count(STATUS.DATA_UNAVAILABLE),
      rightCensored: count(STATUS.RIGHT_CENSORED),
      skippedNoEntry: 0,
      skippedNoExit: 0,
      executionRatePct: resolvedRows.length
        ? (resolvedEnteredRows.length / resolvedRows.length) * 100
        : null,
      roundTripCompletionRatePct: resolvedEnteredRows.length
        ? (completedRows.length / resolvedEnteredRows.length) * 100
        : null,
      modeledFailureSamples: completedRows.length * failureProbability,
      winRatePct: totalOutcomeWeight > 0
        ? (wins.reduce((total, outcome) => total + outcome.weight, 0) / totalOutcomeWeight) * 100
        : null,
      averageRawReturnPct: average(rawReturns),
      averageNetReturnPct: weightedAverage(outcomes),
      medianNetReturnPct: weightedMedian(outcomes),
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
      expectancyPct: weightedAverage(outcomes),
      averageMfePct: average(completedRows.map((row) => row.mfePct).filter(Number.isFinite)),
      averageMaePct: average(completedRows.map((row) => row.maePct).filter(Number.isFinite)),
      averageActualDelayMs: average(completedRows.map((row) => row.actualDelayMs)),
      averageLatencyMovePct: average(completedRows.map((row) => row.signalToEntryPct)),
    },
    rows: options.includeRows === false ? undefined : rows,
  };
}

module.exports = {
  STATUS,
  passesAcceleration,
  runBacktest,
};
