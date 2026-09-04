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

const EXIT_REASON = Object.freeze({
  TIME_EXIT: 'TIME_EXIT',
  TAKE_PROFIT: 'TAKE_PROFIT',
  STOP_LOSS: 'STOP_LOSS',
  TRAILING_STOP: 'TRAILING_STOP',
  FLOW_DECAY: 'FLOW_DECAY',
  SMART_WALLET_SELL: 'SMART_WALLET_SELL',
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalPositive(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function optionalFinite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalNonNegative(value) {
  const number = optionalFinite(value);
  return number != null && number >= 0 ? number : null;
}

function boolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function stringSet(value) {
  if (value == null || value === '') return new Set();
  const values = Array.isArray(value) ? value : String(value).split(/[\s,;]+/);
  return new Set(values.map((item) => String(item).trim()).filter(Boolean));
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

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
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
    signalVariant: signal.signal_variant || 'primary_3w',
    mint: signal.mint,
    status,
    signalAt: signal.timestamp_ms,
    graduatedAt: signal.graduated_at,
    entryAt: null,
    triggerAt: null,
    exitAt: null,
    actualDelayMs: null,
    marketObservedEntryDelayMs: null,
    actualHoldMs: null,
    entryMarket: null,
    exitMarket: null,
    exitReason: null,
    simulatedExitFailures: 0,
    retryCostSol: 0,
    rawReturnPct: status === STATUS.NO_EXIT ? null : 0,
    netReturnPct: status === STATUS.NO_EXIT ? null : 0,
    expectedNetReturnPct: status === STATUS.NO_EXIT ? null : 0,
    signalToEntryPct: null,
    mfePct: null,
    maePct: null,
  };
}

function returnPct(price, entryPrice) {
  return ((price / entryPrice) - 1) * 100;
}

function findExitTrigger(path, entry, options) {
  const deadline = entry.timestamp_ms + options.holdMs;
  let peakReturnPct = 0;
  let flowNetSol = 0;
  let flowStartIndex = 0;
  let weakFlowObservations = 0;
  const observedFlowTrades = [];
  for (const trade of path) {
    if (trade.timestamp_ms <= entry.timestamp_ms || trade.timestamp_ms > deadline) continue;
    const signedSol = trade.side === 'BUY'
      ? trade.sol_amount
      : trade.side === 'SELL' ? -trade.sol_amount : 0;
    observedFlowTrades.push({ timestampMs: trade.timestamp_ms, signedSol });
    flowNetSol += signedSol;
    const flowCutoff = trade.timestamp_ms - options.flowExitWindowMs;
    while (flowStartIndex < observedFlowTrades.length
      && observedFlowTrades[flowStartIndex].timestampMs < flowCutoff) {
      flowNetSol -= observedFlowTrades[flowStartIndex].signedSol;
      flowStartIndex += 1;
    }
    const value = returnPct(trade.price, entry.price);
    peakReturnPct = Math.max(peakReturnPct, value);
    if (options.stopLossPct != null && value <= -options.stopLossPct) {
      return { ...trade, reason: EXIT_REASON.STOP_LOSS };
    }
    if (options.takeProfitPct != null && value >= options.takeProfitPct) {
      return { ...trade, reason: EXIT_REASON.TAKE_PROFIT };
    }
    if (options.trailingStopPct != null
      && peakReturnPct >= options.trailingActivationPct
      && peakReturnPct - value >= options.trailingStopPct) {
      return { ...trade, reason: EXIT_REASON.TRAILING_STOP };
    }
    if (options.exitOnSmartWalletSell
      && trade.side === 'SELL'
      && options.smartWallets.has(trade.wallet)) {
      return { ...trade, reason: EXIT_REASON.SMART_WALLET_SELL };
    }
    if (options.flowExitNetFlowThresholdSol != null
      && trade.timestamp_ms >= entry.timestamp_ms + options.flowExitMinHoldMs) {
      weakFlowObservations = flowNetSol <= options.flowExitNetFlowThresholdSol
        ? weakFlowObservations + 1
        : 0;
      if (weakFlowObservations >= options.flowExitConfirmations) {
        return { ...trade, reason: EXIT_REASON.FLOW_DECAY, observedNetFlowSol: flowNetSol };
      }
    }
  }
  return { timestamp_ms: deadline, price: null, market: null, reason: EXIT_REASON.TIME_EXIT };
}

function firstTradeBetween(path, startMs, endMs) {
  return path.find((trade) => trade.timestamp_ms >= startMs && trade.timestamp_ms <= endMs) || null;
}

function seededRandom(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function diagnosticsFor(rows, bootstrapSamples) {
  const resolved = rows.filter((row) => ![
    STATUS.DATA_UNAVAILABLE,
    STATUS.RIGHT_CENSORED,
  ].includes(row.status));
  const values = resolved
    .map((row) => row.expectedNetReturnPct)
    .filter(Number.isFinite);
  const sorted = [...values].sort((a, b) => a - b);
  const descending = [...values].sort((a, b) => b - a);
  const grossPositive = values.filter((value) => value > 0)
    .reduce((total, value) => total + value, 0);
  const contribution = (count) => grossPositive > 0
    ? (descending.slice(0, count).filter((value) => value > 0)
      .reduce((total, value) => total + value, 0) / grossPositive) * 100
    : null;
  const withoutTop = (count) => average(descending.slice(Math.min(count, descending.length)));

  const byMint = new Map();
  for (const row of resolved) {
    if (!Number.isFinite(row.expectedNetReturnPct)) continue;
    if (!byMint.has(row.mint)) byMint.set(row.mint, []);
    byMint.get(row.mint).push(row.expectedNetReturnPct);
  }
  const mintMeans = [...byMint.values()].map(average);
  const iterations = Math.min(5_000, Math.max(0, Math.trunc(bootstrapSamples)));
  let confidenceInterval = { lowerPct: null, upperPct: null, iterations: 0 };
  if (mintMeans.length > 1 && iterations > 0) {
    const random = seededRandom();
    const estimates = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let total = 0;
      for (let index = 0; index < mintMeans.length; index += 1) {
        total += mintMeans[Math.floor(random() * mintMeans.length)];
      }
      estimates.push(total / mintMeans.length);
    }
    estimates.sort((a, b) => a - b);
    confidenceInterval = {
      lowerPct: percentile(estimates, 0.025),
      upperPct: percentile(estimates, 0.975),
      iterations,
    };
  }

  return {
    uniqueMints: byMint.size,
    signalsPerMint: byMint.size ? values.length / byMint.size : null,
    mintEqualWeightedReturnPct: average(mintMeans),
    mintEqualWeightedWinRatePct: mintMeans.length
      ? (mintMeans.filter((value) => value > 0).length / mintMeans.length) * 100
      : null,
    percentiles: {
      p05: percentile(sorted, 0.05),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p95: percentile(sorted, 0.95),
    },
    topWinnerContributionPct: {
      top1: contribution(1),
      top5: contribution(5),
      top10: contribution(10),
    },
    averageWithoutTopWinnersPct: {
      top1: withoutTop(1),
      top3: withoutTop(3),
      top5: withoutTop(5),
    },
    mintBootstrap95Pct: confidenceInterval,
  };
}

function profitFactor(values) {
  const grossProfit = values.filter((value) => value > 0)
    .reduce((total, value) => total + value, 0);
  const grossLoss = Math.abs(values.filter((value) => value < 0)
    .reduce((total, value) => total + value, 0));
  return grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0);
}

function calculateMetrics(rows, costs, options = {}) {
  const unresolvedStatuses = new Set([STATUS.DATA_UNAVAILABLE, STATUS.RIGHT_CENSORED]);
  const resolvedRows = rows.filter((row) => !unresolvedStatuses.has(row.status));
  const completedRows = rows.filter((row) => row.status === STATUS.COMPLETED);
  const enteredRows = rows.filter((row) => row.entryAt != null);
  const resolvedEnteredRows = enteredRows.filter((row) => !unresolvedStatuses.has(row.status));
  const outcomes = [];
  const failureProbability = costs.entryFailureRatePct / 100;
  for (const row of resolvedRows) {
    if (row.entryAt != null && Number.isFinite(row.netReturnPct)) {
      if (failureProbability < 1) outcomes.push({ value: row.netReturnPct, weight: 1 - failureProbability });
      if (failureProbability > 0) {
        outcomes.push({ value: -costs.entryFailureCostPct, weight: failureProbability });
      }
    } else if (Number.isFinite(row.netReturnPct)) {
      outcomes.push({ value: row.netReturnPct, weight: 1 });
    }
  }

  const rawReturns = resolvedRows.map((row) => row.rawReturnPct).filter(Number.isFinite);
  const executedReturns = resolvedEnteredRows
    .map((row) => row.netReturnPct)
    .filter(Number.isFinite);
  const wins = outcomes.filter((outcome) => outcome.value > 0);
  const losses = outcomes.filter((outcome) => outcome.value < 0);
  const totalOutcomeWeight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
  const grossProfit = wins.reduce((total, outcome) => total + outcome.value * outcome.weight, 0);
  const grossLoss = Math.abs(losses.reduce(
    (total, outcome) => total + outcome.value * outcome.weight,
    0,
  ));
  const count = (status) => rows.filter((row) => row.status === status).length;
  const exitReasons = {};
  for (const reason of Object.values(EXIT_REASON)) {
    exitReasons[reason] = completedRows.filter((row) => row.exitReason === reason).length;
  }

  const averageExecutedNetReturnPct = average(executedReturns);
  const sortedExecutedReturns = [...executedReturns].sort((a, b) => a - b);
  const metrics = {
    candidateSignals: rows.length,
    samples: resolvedRows.length,
    completedSamples: completedRows.length,
    enteredSamples: enteredRows.length,
    uniqueMints: new Set(resolvedRows.map((row) => row.mint)).size,
    noEntry: count(STATUS.NO_ENTRY),
    noExit: count(STATUS.NO_EXIT),
    graduatedBeforeEntry: count(STATUS.GRADUATED_BEFORE_ENTRY),
    dataUnavailable: count(STATUS.DATA_UNAVAILABLE),
    rightCensored: count(STATUS.RIGHT_CENSORED),
    skippedNoEntry: 0,
    skippedNoExit: 0,
    exitReasons,
    executionRatePct: resolvedRows.length
      ? (resolvedEnteredRows.length / resolvedRows.length) * 100
      : null,
    roundTripCompletionRatePct: resolvedEnteredRows.length
      ? (completedRows.length / resolvedEnteredRows.length) * 100
      : null,
    modeledFailureSamples: resolvedEnteredRows.length * failureProbability,
    modeledEntryFailureSamples: resolvedEnteredRows.length * failureProbability,
    winRatePct: totalOutcomeWeight > 0
      ? (wins.reduce((total, outcome) => total + outcome.weight, 0) / totalOutcomeWeight) * 100
      : null,
    averageRawReturnPct: average(rawReturns),
    averageNetReturnPct: weightedAverage(outcomes),
    averageExecutedNetReturnPct,
    medianExecutedNetReturnPct: percentile(sortedExecutedReturns, 0.5),
    executedWinRatePct: executedReturns.length
      ? (executedReturns.filter((value) => value > 0).length / executedReturns.length) * 100
      : null,
    executedProfitFactor: profitFactor(executedReturns),
    entryFailureCanImproveNegativeStrategy: failureProbability > 0
      && Number.isFinite(averageExecutedNetReturnPct)
      && averageExecutedNetReturnPct < -costs.entryFailureCostPct,
    medianNetReturnPct: weightedMedian(outcomes),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
    expectancyPct: weightedAverage(outcomes),
    averageMfePct: average(completedRows.map((row) => row.mfePct).filter(Number.isFinite)),
    averageMaePct: average(completedRows.map((row) => row.maePct).filter(Number.isFinite)),
    averageActualDelayMs: average(completedRows.map((row) => row.actualDelayMs)),
    averageMarketObservedEntryDelayMs: average(
      completedRows.map((row) => row.marketObservedEntryDelayMs).filter(Number.isFinite),
    ),
    averageLatencyMovePct: average(completedRows.map((row) => row.signalToEntryPct)),
  };
  if (options.diagnostics !== false) {
    metrics.robustness = diagnosticsFor(rows, options.bootstrapSamples ?? 500);
    metrics.executedRobustness = diagnosticsFor(
      resolvedEnteredRows,
      options.bootstrapSamples ?? 500,
    );
  }
  return metrics;
}

function runBacktest(db, options = {}) {
  const rawTradeTable = options.rawTradeTable === 'raw_trades_all'
    ? 'raw_trades_all' : 'raw_trades';
  const holdMs = Math.max(1, finite(options.holdMs, 5_000));
  const executionDelayMs = Math.max(0, finite(options.executionDelayMs, 200));
  const entryTimeoutMs = Math.max(1, finite(options.entryTimeoutMs, 2_000));
  const exitTimeoutMs = Math.max(1, finite(options.exitTimeoutMs, 5_000));
  const noExitLossPct = optionalNonNegative(options.noExitLossPct);
  const minNetFlowW3 = Math.max(0, finite(options.minNetFlowW3, 0));
  const maxNetFlowW3 = optionalNonNegative(options.maxNetFlowW3);
  const minFlowAccel = Math.max(0, finite(options.minFlowAccel, 0));
  const minAgeMs = optionalNonNegative(options.minAgeMs);
  const maxAgeMs = optionalNonNegative(options.maxAgeMs);
  const minCurvePct = optionalNonNegative(options.minCurvePct);
  const maxCurvePct = optionalNonNegative(options.maxCurvePct);
  const minDeltaNetFlow12 = optionalFinite(options.minDeltaNetFlow12);
  const minDeltaNetFlow23 = optionalFinite(options.minDeltaNetFlow23);
  const minBuyTxW3 = optionalNonNegative(options.minBuyTxW3);
  const minUniqueBuyersW3 = optionalNonNegative(options.minUniqueBuyersW3);
  const maxBuyTxW3 = optionalNonNegative(options.maxBuyTxW3);
  const maxUniqueBuyersW3 = optionalNonNegative(options.maxUniqueBuyersW3);
  const excludedMints = stringSet(options.excludedMints);
  const maxEntryPriceJumpPct = optionalNonNegative(options.maxEntryPriceJumpPct);
  const firstSignalOnly = boolean(options.firstSignalOnly, false);
  const signalCooldownMs = Math.max(0, finite(options.signalCooldownMs, 0));
  const singlePositionPerMint = boolean(options.singlePositionPerMint, false);
  const signalVariant = String(options.signalVariant || 'primary_3w').trim() || 'primary_3w';
  const limit = Math.min(100_000, Math.max(1, Math.trunc(finite(options.limit, 10_000))));
  const fromMs = optionalFinite(options.fromMs);
  const toMs = optionalFinite(options.toMs);
  const requestedDataCutoffMs = optionalFinite(options.dataCutoffMs);
  const dataCutoffMs = requestedDataCutoffMs ?? Number.MAX_SAFE_INTEGER;
  if (fromMs != null && toMs != null && fromMs > toMs) throw new Error('fromMs must be <= toMs');
  if (maxNetFlowW3 != null && maxNetFlowW3 < minNetFlowW3) {
    throw new Error('maxNetFlowW3 must be >= minNetFlowW3');
  }
  if (minAgeMs != null && maxAgeMs != null && minAgeMs > maxAgeMs) {
    throw new Error('minAgeMs must be <= maxAgeMs');
  }
  if (minCurvePct != null && maxCurvePct != null && minCurvePct > maxCurvePct) {
    throw new Error('minCurvePct must be <= maxCurvePct');
  }

  const takeProfitPct = optionalPositive(options.takeProfitPct);
  const stopLossPct = optionalPositive(options.stopLossPct);
  const trailingStopPct = optionalPositive(options.trailingStopPct);
  const trailingActivationPct = Math.max(0, finite(options.trailingActivationPct, 0));
  const flowExitNetFlowThresholdSol = optionalFinite(options.flowExitNetFlowThresholdSol);
  const flowExitWindowMs = Math.max(250, finite(options.flowExitWindowMs, 2_000));
  const flowExitMinHoldMs = Math.max(0, finite(options.flowExitMinHoldMs, 1_000));
  const flowExitConfirmations = Math.max(
    1,
    Math.trunc(finite(options.flowExitConfirmations, 2)),
  );
  const exitOnSmartWalletSell = boolean(options.exitOnSmartWalletSell, false);
  const smartWallets = stringSet(options.smartWallets);
  const exitExecutionDelayMs = Math.max(0, finite(options.exitExecutionDelayMs, 0));
  const exitRetryCount = Math.min(20, Math.max(0, Math.trunc(finite(options.exitRetryCount, 0))));
  const exitRetryDelayMs = Math.max(0, finite(options.exitRetryDelayMs, 500));
  const costs = costBreakdown(options);
  const exitFailureCostSol = Math.max(0, finite(
    options.exitFailureCostSol,
    costs.baseTxFeeSol + costs.priorityFeeSol + costs.jitoTipSol,
  ));
  const retryCostSol = exitRetryCount * exitFailureCostSol;
  const rowCosts = retryCostSol > 0
    ? costBreakdown({ ...costs, fixedCostSol: costs.fixedCostSol + retryCostSol })
    : costs;

  const accelerationCondition = signalVariant === 'primary_3w'
    || signalVariant.startsWith('primary_early_')
    || signalVariant === '*'
    ? `(@minFlowAccel <= 0 OR (
      (s.flow_accel_1 IS NULL OR s.flow_accel_1 >= @minFlowAccel)
      AND (s.flow_accel_2 IS NULL OR s.flow_accel_2 >= @minFlowAccel)
    ))`
    : '(@minFlowAccel <= 0 OR s.flow_accel_2 IS NULL OR s.flow_accel_2 >= @minFlowAccel)';
  const buyConditions = [
    's.netflow_w3 >= @minNetFlowW3',
    accelerationCondition,
  ];
  const prohibitionConditions = [];
  const baseConditions = [];
  if (maxNetFlowW3 != null) prohibitionConditions.push('s.netflow_w3 <= @maxNetFlowW3');
  if (minAgeMs != null) buyConditions.push('s.age_ms >= @minAgeMs');
  if (maxAgeMs != null) prohibitionConditions.push('s.age_ms <= @maxAgeMs');
  if (minCurvePct != null) buyConditions.push('s.curve_pct >= @minCurvePct');
  if (maxCurvePct != null) prohibitionConditions.push('s.curve_pct <= @maxCurvePct');
  if (minDeltaNetFlow12 != null) {
    buyConditions.push('s.delta_netflow_12 >= @minDeltaNetFlow12');
  }
  if (minDeltaNetFlow23 != null) {
    buyConditions.push('s.delta_netflow_23 >= @minDeltaNetFlow23');
  }
  if (minBuyTxW3 != null) buyConditions.push('s.buy_tx_w3 >= @minBuyTxW3');
  if (minUniqueBuyersW3 != null) {
    buyConditions.push('s.unique_buyers_w3 >= @minUniqueBuyersW3');
  }
  if (maxBuyTxW3 != null) prohibitionConditions.push('s.buy_tx_w3 <= @maxBuyTxW3');
  if (maxUniqueBuyersW3 != null) {
    prohibitionConditions.push('s.unique_buyers_w3 <= @maxUniqueBuyersW3');
  }
  if (fromMs != null) baseConditions.push('s.timestamp_ms >= @fromMs');
  if (toMs != null) baseConditions.push('s.timestamp_ms <= @toMs');
  const signalColumns = new Set(
    db.prepare('PRAGMA table_info(flow_signals)').all().map((column) => column.name),
  );
  const supportsSignalVariant = signalColumns.has('signal_variant');
  if (supportsSignalVariant && signalVariant !== '*') {
    baseConditions.push('s.signal_variant = @signalVariant');
  } else if (!supportsSignalVariant && !['*', 'primary_3w'].includes(signalVariant)) {
    baseConditions.push('1 = 0');
  }
  const conditions = [...baseConditions, ...prohibitionConditions, ...buyConditions];
  conditions.push(`(
    @cursorTimestampMs IS NULL
    OR s.timestamp_ms > @cursorTimestampMs
    OR (s.timestamp_ms = @cursorTimestampMs AND s.signal_id > @cursorSignalId)
  )`);
  const signalParameters = {
    minNetFlowW3,
    minFlowAccel,
    maxNetFlowW3,
    minAgeMs,
    maxAgeMs,
    minCurvePct,
    maxCurvePct,
    minDeltaNetFlow12,
    minDeltaNetFlow23,
    minBuyTxW3,
    minUniqueBuyersW3,
    maxBuyTxW3,
    maxUniqueBuyersW3,
    signalVariant,
    cursorTimestampMs: null,
    cursorSignalId: 0,
    pageSize: Math.min(5_000, Math.max(500, limit)),
  };
  if (fromMs != null) signalParameters.fromMs = fromMs;
  if (toMs != null) signalParameters.toMs = toMs;
  const countSignals = (countConditions) => db.prepare(`
    SELECT COUNT(*) AS n FROM flow_signals s
    WHERE ${countConditions.length ? countConditions.join(' AND ') : '1 = 1'}
  `).get(signalParameters).n;
  const availableSignals = countSignals(baseConditions);
  const afterProhibitionRules = countSignals([...baseConditions, ...prohibitionConditions]);
  const afterBuyConditions = countSignals([
    ...baseConditions, ...prohibitionConditions, ...buyConditions,
  ]);
  const signalPage = db.prepare(`
    SELECT s.*, t.graduated_at
    FROM flow_signals s
    LEFT JOIN flow_tokens t USING(mint)
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.timestamp_ms, s.signal_id
    LIMIT @pageSize
  `);
  const signals = [];
  const seenMints = new Set();
  const lastAcceptedByMint = new Map();
  const signalSelection = {
    availableSignals,
    filteredByProhibitionRules: availableSignals - afterProhibitionRules,
    filteredByBuyConditions: afterProhibitionRules - afterBuyConditions,
    fetchedSignals: 0,
    scannedSignals: 0,
    filteredByExcludedMint: 0,
    filteredByFirstSignal: 0,
    filteredByCooldown: 0,
    filteredByEntryPriceJump: 0,
    filteredByOpenPosition: 0,
    limitReached: false,
  };
  while (signals.length < limit) {
    const page = signalPage.all(signalParameters);
    if (page.length === 0) break;
    signalSelection.fetchedSignals += page.length;
    for (const signal of page) {
      signalSelection.scannedSignals += 1;
      if (!supportsSignalVariant) {
        signal.signal_variant = 'primary_3w';
        signal.is_primary = 1;
      }
      if (excludedMints.has(signal.mint)) {
        signalSelection.filteredByExcludedMint += 1;
        continue;
      }
      if (firstSignalOnly && seenMints.has(signal.mint)) {
        signalSelection.filteredByFirstSignal += 1;
        continue;
      }
      if (firstSignalOnly) seenMints.add(signal.mint);
      const lastAcceptedAt = lastAcceptedByMint.get(signal.mint);
      if (signalCooldownMs > 0 && Number.isFinite(lastAcceptedAt)
        && signal.timestamp_ms - lastAcceptedAt < signalCooldownMs) {
        signalSelection.filteredByCooldown += 1;
        continue;
      }
      signals.push(signal);
      lastAcceptedByMint.set(signal.mint, signal.timestamp_ms);
      if (signals.length >= limit) {
        signalSelection.limitReached = true;
        break;
      }
    }
    const last = page.at(-1);
    signalParameters.cursorTimestampMs = last.timestamp_ms;
    signalParameters.cursorSignalId = last.signal_id;
    if (page.length < signalParameters.pageSize) break;
  }

  const coverage = db.prepare(`
    SELECT MIN(timestamp_ms) AS min_timestamp_ms, MAX(timestamp_ms) AS max_timestamp_ms
    FROM ${rawTradeTable} WHERE timestamp_ms <= ?
  `).get(dataCutoffMs);
  const firstCurveTradeBetween = db.prepare(`
    SELECT timestamp_ms, price, market, side, sol_amount, wallet
    FROM ${rawTradeTable}
    WHERE mint = ? AND market = 'PUMP_BONDING_CURVE'
      AND timestamp_ms >= ? AND timestamp_ms <= ? AND price > 0
    ORDER BY timestamp_ms, id LIMIT 1
  `);
  const pathBetween = db.prepare(`
    SELECT timestamp_ms, price, market, side, sol_amount, wallet
    FROM ${rawTradeTable}
    WHERE mint = ? AND timestamp_ms >= ? AND timestamp_ms <= ? AND price > 0
    ORDER BY timestamp_ms, id
  `);

  const rows = [];
  const openUntilByMint = new Map();
  for (const signal of signals) {
    const openUntil = openUntilByMint.get(signal.mint);
    if (singlePositionPerMint && Number.isFinite(openUntil) && signal.timestamp_ms < openUntil) {
      signalSelection.filteredByOpenPosition += 1;
      continue;
    }
    const entryTarget = signal.timestamp_ms + executionDelayMs;
    const entryWindowEnd = Math.min(entryTarget + entryTimeoutMs, dataCutoffMs);
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
      const fullEntryWindowEnd = entryTarget + entryTimeoutMs;
      if (!Number.isFinite(coverage.max_timestamp_ms)
        || coverage.max_timestamp_ms < fullEntryWindowEnd
        || dataCutoffMs < fullEntryWindowEnd) {
        status = STATUS.RIGHT_CENSORED;
      } else if (Number.isFinite(coverage.min_timestamp_ms)
        && coverage.min_timestamp_ms > fullEntryWindowEnd) {
        status = STATUS.DATA_UNAVAILABLE;
      } else if (graduatedAt != null && graduatedAt <= fullEntryWindowEnd) {
        status = STATUS.GRADUATED_BEFORE_ENTRY;
      }
      rows.push(blankRow(signal, status));
      continue;
    }

    const signalToEntryPct = returnPct(entry.price, signal.p0);
    if (maxEntryPriceJumpPct != null && signalToEntryPct > maxEntryPriceJumpPct) {
      signalSelection.filteredByEntryPriceJump += 1;
      continue;
    }

    const maximumPathEnd = entry.timestamp_ms + holdMs + exitExecutionDelayMs
      + exitRetryCount * exitRetryDelayMs + exitTimeoutMs;
    const pathEnd = Math.min(maximumPathEnd, dataCutoffMs);
    const path = pathBetween.all(signal.mint, entry.timestamp_ms, pathEnd).filter((trade) => {
      if (trade.market === 'PUMP_BONDING_CURVE') return true;
      if (trade.market !== 'PUMP_AMM' || graduatedAt == null
        || trade.timestamp_ms < graduatedAt) return false;
      const crossMarketRatio = trade.price / entry.price;
      return crossMarketRatio >= 0.05 && crossMarketRatio <= 20;
    });
    const trigger = findExitTrigger(path, entry, {
      holdMs,
      takeProfitPct,
      stopLossPct,
      trailingStopPct,
      trailingActivationPct,
      flowExitNetFlowThresholdSol,
      flowExitWindowMs,
      flowExitMinHoldMs,
      flowExitConfirmations,
      exitOnSmartWalletSell,
      smartWallets,
    });
    const exitTarget = trigger.timestamp_ms + exitExecutionDelayMs
      + exitRetryCount * exitRetryDelayMs;
    const fullExitWindowEnd = exitTarget + exitTimeoutMs;
    const exitWindowEnd = Math.min(fullExitWindowEnd, dataCutoffMs);
    const exit = firstTradeBetween(path, exitTarget, exitWindowEnd);
    const baseRow = blankRow(signal, exit ? STATUS.COMPLETED : STATUS.NO_EXIT);
    baseRow.entryAt = entry.timestamp_ms;
    baseRow.triggerAt = trigger.timestamp_ms;
    baseRow.actualDelayMs = entry.timestamp_ms - signal.timestamp_ms;
    baseRow.marketObservedEntryDelayMs = baseRow.actualDelayMs;
    baseRow.entryMarket = entry.market;
    baseRow.exitReason = trigger.reason;
    baseRow.simulatedExitFailures = exitRetryCount;
    baseRow.retryCostSol = retryCostSol;

    if (!exit) {
      if (!Number.isFinite(coverage.max_timestamp_ms)
        || coverage.max_timestamp_ms < fullExitWindowEnd
        || dataCutoffMs < fullExitWindowEnd) {
        baseRow.status = STATUS.RIGHT_CENSORED;
      } else if (noExitLossPct != null) {
        baseRow.rawReturnPct = -noExitLossPct;
        baseRow.netReturnPct = baseRow.rawReturnPct - rowCosts.deterministicCostPct;
        baseRow.expectedNetReturnPct = expectedNetReturnPct(baseRow.rawReturnPct, rowCosts);
      }
      if (singlePositionPerMint) openUntilByMint.set(signal.mint, Number.MAX_SAFE_INTEGER);
      rows.push(baseRow);
      continue;
    }

    const rawReturnPct = returnPct(exit.price, entry.price);
    const netReturnPct = rawReturnPct - rowCosts.deterministicCostPct;
    const prices = path.filter((trade) => trade.timestamp_ms <= exit.timestamp_ms)
      .map((trade) => trade.price);
    const { mfe, mae } = excursion([entry.price, ...prices], entry.price);
    rows.push({
      ...baseRow,
      status: STATUS.COMPLETED,
      exitAt: exit.timestamp_ms,
      actualHoldMs: exit.timestamp_ms - entry.timestamp_ms,
      exitMarket: exit.market,
      rawReturnPct,
      netReturnPct,
      expectedNetReturnPct: expectedNetReturnPct(rawReturnPct, rowCosts),
      signalToEntryPct,
      mfePct: mfe,
      maePct: mae,
    });
    if (singlePositionPerMint) openUntilByMint.set(signal.mint, exit.timestamp_ms);
  }

  const bootstrapSamples = Math.max(0, Math.trunc(finite(options.bootstrapSamples, 500)));
  const metrics = calculateMetrics(rows, costs, { bootstrapSamples });
  const splitRatio = finite(options.splitRatio, 0.7);
  let validation = null;
  if (rows.length > 1 && splitRatio > 0 && splitRatio < 1) {
    const splitIndex = Math.min(rows.length - 1, Math.max(1, Math.floor(rows.length * splitRatio)));
    const trainRows = rows.slice(0, splitIndex);
    const testRows = rows.slice(splitIndex);
    validation = {
      splitRatio,
      splitAt: testRows[0].signalAt,
      trainLastAt: trainRows.at(-1).signalAt,
      testFirstAt: testRows[0].signalAt,
      train: calculateMetrics(trainRows, costs, { diagnostics: false }),
      test: calculateMetrics(testRows, costs, { diagnostics: false }),
    };
  }

  const warnings = [];
  if (exitExecutionDelayMs === 0) {
    warnings.push({
      code: 'IDEALIZED_ZERO_DELAY_EXIT',
      message: 'Exit delay is 0 ms. This is an idealized fill assumption; use a non-zero delay for executable research, especially with stop or trailing triggers.',
    });
  }
  if (firstSignalOnly && signalCooldownMs > 0) {
    warnings.push({
      code: 'REDUNDANT_SIGNAL_FILTER',
      message: 'firstSignalOnly already keeps one eligible signal per mint; signalCooldownMs has no additional effect.',
    });
  }
  if (takeProfitPct == null && stopLossPct == null && trailingStopPct == null
    && flowExitNetFlowThresholdSol == null && !exitOnSmartWalletSell) {
    warnings.push({
      code: 'FIXED_TIME_EXIT_ONLY',
      message: 'Only the maximum hold-time exit is active. Enable at least one dynamic exit for strategy research.',
    });
  }

  return {
    parameters: {
      holdMs,
      executionDelayMs,
      entryTimeoutMs,
      exitTimeoutMs,
      noExitLossPct,
      takeProfitPct,
      stopLossPct,
      trailingStopPct,
      trailingActivationPct,
      flowExitNetFlowThresholdSol,
      flowExitWindowMs,
      flowExitMinHoldMs,
      flowExitConfirmations,
      exitOnSmartWalletSell,
      exitExecutionDelayMs,
      exitRetryCount,
      exitRetryDelayMs,
      exitFailureCostSol,
      retryCostSol,
      fromMs,
      toMs,
      dataCutoffMs: dataCutoffMs === Number.MAX_SAFE_INTEGER ? null : dataCutoffMs,
      splitRatio,
      bootstrapSamples,
      ...costs,
      totalCostPct: costs.deterministicCostPct,
      effectiveCostWithRetriesPct: rowCosts.deterministicCostPct,
      minNetFlowW3,
      maxNetFlowW3,
      minFlowAccel,
      minAgeMs,
      maxAgeMs,
      minCurvePct,
      maxCurvePct,
      minDeltaNetFlow12,
      minDeltaNetFlow23,
      minBuyTxW3,
      minUniqueBuyersW3,
      maxBuyTxW3,
      maxUniqueBuyersW3,
      excludedMints: [...excludedMints],
      maxEntryPriceJumpPct,
      firstSignalOnly,
      signalCooldownMs,
      singlePositionPerMint,
      signalVariant,
    },
    analysisWindow: {
      selectedSignalFirstMs: signals[0]?.timestamp_ms ?? null,
      selectedSignalLastMs: signals.at(-1)?.timestamp_ms ?? null,
      selectedSignals: signals.length,
      executionEligibleSignals: rows.length,
      selectedMints: new Set(signals.map((signal) => signal.mint)).size,
      signalSelection,
      rawFirstMs: coverage.min_timestamp_ms,
      rawLastMs: coverage.max_timestamp_ms,
    },
    metrics,
    validation,
    warnings,
    rows: options.includeRows === false ? undefined : rows,
  };
}

module.exports = {
  EXIT_REASON,
  STATUS,
  calculateMetrics,
  passesAcceleration,
  runBacktest,
};
