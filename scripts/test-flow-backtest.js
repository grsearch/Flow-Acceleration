'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  EXIT_REASON, STATUS, passesAcceleration, runBacktest,
} = require('../src/core/FlowBacktester');

const zeroVariableCosts = {
  buySlippagePct: 0,
  sellSlippagePct: 0,
  priceImpactPct: 0,
  baseTxFeeSol: 0,
  priorityFeeSol: 0,
  jitoTipSol: 0,
  fixedCostSol: 0,
  positionSizeSol: 0.2,
  failureRatePct: 0,
  failureLossPct: 1,
};

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, {
    configuredTradingCostPct: 1.4,
  });
}

function addSignal(store, mint, timestampMs, overrides = {}) {
  return store.recordSignal({
    timestampMs, slot: 1, signature: `signal-${mint}`, mint, symbol: 'FLOW',
    ageMs: 10_000, curvePct: 40, price: 1,
    buyFlowW1: 0.5, buyFlowW2: 1, buyFlowW3: 3,
    sellFlowW1: 0.2, sellFlowW2: 0.2, sellFlowW3: 0.2,
    netFlowW1: 0.3, netFlowW2: 0.8, netFlowW3: 2.8,
    deltaNetFlow12: 0.5, deltaNetFlow23: 2,
    uniqueBuyersW1: 2, uniqueBuyersW2: 5, uniqueBuyersW3: 10,
    buyTxW1: 3, buyTxW2: 8, buyTxW3: 15,
    flowAccel1: 2.67, flowAccel2: 3.5,
    ...overrides,
  });
}

let tradeNumber = 0;
function addTrade(store, mint, timestampMs, price, market = 'PUMP_BONDING_CURVE') {
  tradeNumber += 1;
  store.ensureToken(mint);
  store.queueRawTrade({
    timestampMs,
    receivedAtMs: timestampMs,
    chainTimestampMs: timestampMs,
    signature: `trade-${tradeNumber}`,
    eventIndex: 0,
    market,
    mint,
    wallet: 'wallet',
    side: 'BUY',
    solAmount: 1,
    tokenAmount: 1,
    price,
  });
}

{
  const store = makeStore();
  const signal = addSignal(store, 'completed', 1_000_000);
  assert.strictEqual(signal.signalId, 1);
  assert.strictEqual(signal.flowAccel, 2.67);
  const saved = store.db.prepare('SELECT flow_accel FROM flow_signals WHERE signal_id = 1').get();
  assert.strictEqual(saved.flow_accel, 2.67, 'summary acceleration must use the stricter ratio');
  const variant = store.db.prepare(`
    SELECT signal_variant, is_primary FROM flow_signals WHERE signal_id = 1
  `).get();
  assert.deepStrictEqual(variant, { signal_variant: 'primary_3w', is_primary: 1 });
  const savedReturn = store.db.prepare('SELECT cost_model_json FROM signal_returns WHERE signal_id = 1').get();
  assert.strictEqual(JSON.parse(savedReturn.cost_model_json).platformFeePct, 1.4);

  addTrade(store, 'completed', 1_000_200, 1.01);
  addTrade(store, 'completed', 1_002_000, 1.08);
  addTrade(store, 'completed', 1_004_000, 0.99);
  addTrade(store, 'completed', 1_005_200, 1.05);
  store.flushRawTrades();

  const result = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    platformFeePct: 1,
    ...zeroVariableCosts,
    minNetFlowW3: 1,
    minFlowAccel: 1.2,
  });
  assert.strictEqual(result.metrics.samples, 1);
  assert.strictEqual(result.metrics.completedSamples, 1);
  assert.strictEqual(result.rows[0].status, STATUS.COMPLETED);
  assert.ok(result.metrics.averageRawReturnPct > 3.9 && result.metrics.averageRawReturnPct < 4);
  assert.ok(result.metrics.averageNetReturnPct > 2.9 && result.metrics.averageNetReturnPct < 3);
  assert.ok(result.metrics.averageExecutedNetReturnPct > 2.9);
  assert.ok(result.metrics.medianExecutedNetReturnPct > 2.9);
  assert.ok(result.metrics.executedWinRatePct === 100);
  assert.ok(result.metrics.executedRobustness);
  assert.ok(result.warnings.some(({ code }) => code === 'IDEALIZED_ZERO_DELAY_EXIT'));
  assert.ok(result.metrics.averageMfePct > 6.9);
  assert.ok(result.metrics.averageMaePct < -1.9);

  const detailedCosts = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    platformFeePct: 1,
    ...zeroVariableCosts,
    baseTxFeeSol: 0.00001,
    priorityFeeSol: 0.0005,
    jitoTipSol: 0.001,
  });
  assert.ok(Math.abs(detailedCosts.parameters.totalFixedCostSol - 0.00151) < 1e-12);
  assert.ok(Math.abs(detailedCosts.parameters.totalCostPct - 1.755) < 1e-9);

  const failedExecution = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    platformFeePct: 0,
    ...zeroVariableCosts,
    failureRatePct: 100,
    failureLossPct: 7,
  });
  assert.strictEqual(failedExecution.metrics.averageNetReturnPct, -7);
  assert.strictEqual(failedExecution.metrics.winRatePct, 0);
  assert.strictEqual(failedExecution.metrics.modeledFailureSamples, 1);
  store.close();
}

{
  const store = makeStore();
  store.queueRawTrade({
    timestampMs: 17_000_000,
    chainTimestampMs: 17_000_000,
    receivedAtMs: 17_000_000_000_000_000,
    signature: 'bad-received-at',
    eventIndex: 0,
    market: 'PUMP_BONDING_CURVE',
    mint: 'timestamp-sanity',
    wallet: 'wallet',
    side: 'BUY',
    solAmount: 1,
    tokenAmount: 1,
    price: 1,
  });
  store.flushRawTrades();
  const saved = store.db.prepare(`
    SELECT timestamp_ms, received_at_ms FROM raw_trades WHERE signature = 'bad-received-at'
  `).get();
  assert.strictEqual(saved.received_at_ms, saved.timestamp_ms);
  assert.strictEqual(store.health().timestampCorrections, 1);
  store.close();
}

{
  const store = makeStore();
  const timestamp = 18_000_000;
  addSignal(store, 'smart-lifecycle', timestamp);
  const smartTrade = (side, offset, solAmount, tokenAmount = 100) => store.recordSmartWalletEvent({
    timestampMs: timestamp + offset,
    slot: 1,
    signature: `smart-${side}-${offset}`,
    eventIndex: 0,
    wallet: 'smart-wallet',
    mint: 'smart-lifecycle',
    side,
    market: 'PUMP_BONDING_CURVE',
    solAmount,
    tokenAmount,
    price: 1,
    curvePct: 40,
    ageMs: 5_000,
  });
  assert.strictEqual(smartTrade('BUY', 1_000, 2).positionPhase, 'OPEN');
  assert.strictEqual(smartTrade('BUY', 2_000, 0.2).positionPhase, 'ADD');
  assert.strictEqual(smartTrade('SELL', 5_000, 2.2, 200).positionPhase, 'CLOSE');
  const stats = store.smartWalletStats(['smart-wallet'])[0];
  assert.strictEqual(stats.openBuys, 1);
  assert.strictEqual(stats.addBuys, 1);
  assert.strictEqual(stats.averageHoldMs, 4_000);
  assert.strictEqual(stats.openSignalOverlap5Pct, 100);
  assert.strictEqual(stats.addSignalOverlap30Pct, 100);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM smart_signal_confirmations').get().n, 1);
  store.close();
}

{
  const store = makeStore();
  const start = 16_000_000;
  const researchSignal = {
    curvePct: 30,
    netFlowW3: 1.5,
    buyTxW3: 3,
    uniqueBuyersW3: 2,
  };
  addSignal(store, 'cooldown-filter', start, researchSignal);
  addSignal(store, 'cooldown-filter', start + 10_000, researchSignal);
  addSignal(store, 'cooldown-filter', start + 20_000, researchSignal);
  const episodes = store.db.prepare(`
    SELECT signal_rank_in_mint, previous_signal_gap_ms, signal_episode_id
    FROM flow_signals WHERE mint = 'cooldown-filter' ORDER BY timestamp_ms
  `).all();
  assert.deepStrictEqual(episodes.map((row) => row.signal_rank_in_mint), [1, 2, 3]);
  assert.deepStrictEqual(episodes.map((row) => row.previous_signal_gap_ms), [null, 10_000, 10_000]);
  assert.strictEqual(new Set(episodes.map((row) => row.signal_episode_id)).size, 1,
    'signals no more than 30s apart must share a research episode');
  addSignal(store, 'late-curve', start + 25_000, { ...researchSignal, curvePct: 85 });
  addSignal(store, 'shadow-only', start + 30_000, {
    ...researchSignal,
    signalVariant: 'shadow_2w',
    isPrimary: false,
    flowAccel1: 0.5,
    flowAccel2: 1.5,
  });
  addTrade(store, 'coverage-filter', start + 60_000, 1);
  store.flushRawTrades();

  const firstOnly = runBacktest(store.db, {
    firstSignalOnly: true,
    maxCurvePct: 60,
    maxBuyTxW3: 3,
    maxUniqueBuyersW3: 2,
    maxNetFlowW3: 2,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(firstOnly.analysisWindow.selectedSignals, 1);
  assert.strictEqual(firstOnly.analysisWindow.signalSelection.availableSignals, 4);
  assert.strictEqual(firstOnly.analysisWindow.signalSelection.filteredByProhibitionRules, 1);
  assert.strictEqual(firstOnly.analysisWindow.signalSelection.filteredByFirstSignal, 2);
  assert.strictEqual(firstOnly.rows[0].mint, 'cooldown-filter');

  const cooldown = runBacktest(store.db, {
    signalCooldownMs: 15_000,
    maxCurvePct: 60,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(cooldown.analysisWindow.selectedSignals, 2,
    'cooldown must compare with the last accepted signal, not merely the previous row');
  assert.strictEqual(cooldown.analysisWindow.signalSelection.filteredByCooldown, 1);

  const shadow = runBacktest(store.db, {
    signalVariant: 'shadow_2w',
    minFlowAccel: 1.2,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(shadow.analysisWindow.selectedSignals, 1);
  assert.strictEqual(shadow.rows[0].signalVariant, 'shadow_2w');
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'graduated', 2_000_000);
  store.recordComplete({ mint: 'graduated', completedAt: 2_000_100 });
  addTrade(store, 'graduated', 2_000_200, 1.01, 'PUMP_AMM');
  addTrade(store, 'coverage', 2_010_000, 1);
  store.flushRawTrades();
  const result = runBacktest(store.db, { platformFeePct: 0, ...zeroVariableCosts });
  assert.strictEqual(result.rows[0].status, STATUS.GRADUATED_BEFORE_ENTRY);
  assert.strictEqual(result.metrics.enteredSamples, 0, 'PumpSwap must never be used as an entry');
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'post-grad-exit', 3_000_000);
  addTrade(store, 'post-grad-exit', 3_000_200, 1);
  store.recordComplete({ mint: 'post-grad-exit', completedAt: 3_001_000 });
  addTrade(store, 'post-grad-exit', 3_005_200, 1.1, 'PUMP_AMM');
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000, executionDelayMs: 200, platformFeePct: 0, ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].status, STATUS.COMPLETED);
  assert.strictEqual(result.rows[0].entryMarket, 'PUMP_BONDING_CURVE');
  assert.strictEqual(result.rows[0].exitMarket, 'PUMP_AMM');
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'no-exit', 4_000_000);
  addTrade(store, 'no-exit', 4_000_200, 1);
  addTrade(store, 'coverage-before', 3_999_000, 1);
  addTrade(store, 'coverage-after', 4_020_000, 1);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    exitTimeoutMs: 1_000,
    noExitLossPct: 100,
    platformFeePct: 1,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].status, STATUS.NO_EXIT);
  assert.strictEqual(result.rows[0].netReturnPct, -101);
  assert.strictEqual(result.metrics.noExit, 1);
  assert.strictEqual(result.metrics.roundTripCompletionRatePct, 0);

  const rightCensoredNoExit = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    exitTimeoutMs: 1_000,
    platformFeePct: 1,
    ...zeroVariableCosts,
  });
  assert.strictEqual(rightCensoredNoExit.rows[0].status, STATUS.NO_EXIT);
  assert.strictEqual(rightCensoredNoExit.rows[0].netReturnPct, null,
    'NO_EXIT must remain unpriced unless an explicit stress loss is requested');
  assert.strictEqual(rightCensoredNoExit.metrics.noExit, 1,
    'an unpriced NO_EXIT must remain visible as a right-censored outcome');
  assert.strictEqual(rightCensoredNoExit.metrics.averageNetReturnPct, null);
  assert.strictEqual(rightCensoredNoExit.metrics.averageExecutedNetReturnPct, null,
    'an unpriced NO_EXIT must stay out of executed-return PnL');

  const failedEntry = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    exitTimeoutMs: 1_000,
    noExitLossPct: 100,
    platformFeePct: 1,
    ...zeroVariableCosts,
    entryFailureRatePct: 100,
    entryFailureCostPct: 7,
  });
  assert.strictEqual(failedEntry.metrics.averageNetReturnPct, -7,
    'a failed entry must also replace a modeled no-exit loss because no position opened');
  assert.strictEqual(failedEntry.metrics.modeledEntryFailureSamples, 1);
  assert.strictEqual(failedEntry.rows[0].expectedNetReturnPct, -7);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'right-censored', 5_000_000);
  addTrade(store, 'right-censored', 5_000_200, 1);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000, executionDelayMs: 200, platformFeePct: 0, ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].status, STATUS.RIGHT_CENSORED);
  assert.strictEqual(result.metrics.samples, 0, 'right-censored data is reported but not scored');
  assert.strictEqual(result.metrics.rightCensored, 1);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'no-entry', 6_000_000);
  addTrade(store, 'coverage-before-entry', 5_999_000, 1);
  addTrade(store, 'coverage-after-entry', 6_010_000, 1);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    executionDelayMs: 200,
    entryTimeoutMs: 2_000,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].status, STATUS.NO_ENTRY);
  assert.strictEqual(result.metrics.noEntry, 1);
  assert.strictEqual(result.metrics.executionRatePct, 0);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'dynamic-tp', 7_000_000);
  addTrade(store, 'dynamic-tp', 7_000_200, 1);
  addTrade(store, 'dynamic-tp', 7_000_500, 1.1);
  addTrade(store, 'dynamic-tp', 7_000_700, 1.08);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    takeProfitPct: 5,
    exitExecutionDelayMs: 200,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].exitReason, EXIT_REASON.TAKE_PROFIT);
  assert.strictEqual(result.rows[0].triggerAt, 7_000_500);
  assert.strictEqual(result.rows[0].exitAt, 7_000_700);
  assert.ok(Math.abs(result.rows[0].rawReturnPct - 8) < 1e-9);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'dynamic-stop', 8_000_000);
  addTrade(store, 'dynamic-stop', 8_000_200, 1);
  addTrade(store, 'dynamic-stop', 8_000_500, 0.94);
  addTrade(store, 'dynamic-stop', 8_000_600, 0.92);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    stopLossPct: 5,
    exitExecutionDelayMs: 100,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].exitReason, EXIT_REASON.STOP_LOSS);
  assert.strictEqual(result.rows[0].exitAt, 8_000_600);
  assert.ok(Math.abs(result.rows[0].rawReturnPct + 8) < 1e-9);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'dynamic-trailing', 9_000_000);
  addTrade(store, 'dynamic-trailing', 9_000_200, 1);
  addTrade(store, 'dynamic-trailing', 9_000_500, 1.1);
  addTrade(store, 'dynamic-trailing', 9_000_600, 1.06);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    trailingStopPct: 3,
    trailingActivationPct: 5,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].exitReason, EXIT_REASON.TRAILING_STOP);
  assert.strictEqual(result.rows[0].exitAt, 9_000_600);
  assert.ok(Math.abs(result.rows[0].rawReturnPct - 6) < 1e-9);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'dynamic-flow-decay', 9_100_000);
  addTrade(store, 'dynamic-flow-decay', 9_100_200, 1);
  addTrade(store, 'dynamic-flow-decay', 9_100_500, 1.1);
  store.rawBuffer.at(-1).solAmount = 2;
  store.rawBuffer.at(-1).side = 'BUY';
  addTrade(store, 'dynamic-flow-decay', 9_101_000, 1.05);
  store.rawBuffer.at(-1).solAmount = 3;
  store.rawBuffer.at(-1).side = 'SELL';
  addTrade(store, 'dynamic-flow-decay', 9_101_200, 1.04);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    flowExitWindowMs: 2_000,
    flowExitNetFlowThresholdSol: 0,
    flowExitMinHoldMs: 0,
    flowExitConfirmations: 1,
    exitExecutionDelayMs: 200,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].exitReason, EXIT_REASON.FLOW_DECAY);
  assert.strictEqual(result.rows[0].triggerAt, 9_101_000);
  assert.strictEqual(result.rows[0].exitAt, 9_101_200);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'smart-wallet-exit', 9_200_000);
  addTrade(store, 'smart-wallet-exit', 9_200_200, 1);
  addTrade(store, 'smart-wallet-exit', 9_200_500, 1.08);
  store.rawBuffer.at(-1).side = 'SELL';
  store.rawBuffer.at(-1).wallet = 'tracked-smart-wallet';
  addTrade(store, 'smart-wallet-exit', 9_200_700, 1.06);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    exitOnSmartWalletSell: true,
    smartWallets: ['tracked-smart-wallet'],
    exitExecutionDelayMs: 200,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows[0].exitReason, EXIT_REASON.SMART_WALLET_SELL);
  assert.strictEqual(result.rows[0].exitAt, 9_200_700);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'entry-guard', 9_300_000);
  addTrade(store, 'entry-guard', 9_300_200, 1.5);
  addTrade(store, 'coverage-entry-guard', 9_310_000, 1);
  store.flushRawTrades();
  const guarded = runBacktest(store.db, {
    executionDelayMs: 200,
    maxEntryPriceJumpPct: 10,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(guarded.rows.length, 0);
  assert.strictEqual(guarded.analysisWindow.signalSelection.filteredByEntryPriceJump, 1);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'single-position', 9_400_000);
  addSignal(store, 'single-position', 9_401_000);
  addTrade(store, 'single-position', 9_400_200, 1);
  addTrade(store, 'single-position', 9_405_200, 1.1);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 5_000,
    executionDelayMs: 200,
    singlePositionPerMint: true,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows.length, 1);
  assert.strictEqual(result.analysisWindow.signalSelection.filteredByOpenPosition, 1);
  store.close();
}

{
  const store = makeStore();
  const returns = [10, -5, 2, -1];
  returns.forEach((value, index) => {
    const mint = `analysis-${index}`;
    const timestamp = 10_000_000 + index * 10_000;
    addSignal(store, mint, timestamp);
    addTrade(store, mint, timestamp + 200, 1);
    addTrade(store, mint, timestamp + 1_200, 1 + value / 100);
  });
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 1_000,
    executionDelayMs: 200,
    splitRatio: 0.5,
    bootstrapSamples: 100,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.metrics.uniqueMints, 4);
  assert.strictEqual(result.validation.train.candidateSignals, 2);
  assert.strictEqual(result.validation.test.candidateSignals, 2);
  assert.ok(Number.isFinite(result.metrics.robustness.mintBootstrap95Pct.lowerPct));
  assert.ok(result.metrics.robustness.topWinnerContributionPct.top1 > 80);
  assert.ok(result.metrics.robustness.averageWithoutTopWinnersPct.top1 < 0);
  store.close();
}

{
  const store = makeStore();
  const timestamp = 14_000_000;
  addSignal(store, 'cross-market-guard', timestamp);
  addTrade(store, 'cross-market-guard', timestamp + 200, 1);
  addTrade(store, 'cross-market-guard', timestamp + 1_200, 1_000, 'PUMP_AMM');
  addTrade(store, 'coverage-only', timestamp + 10_000, 1);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 1_000,
    executionDelayMs: 200,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows.length, 1);
  assert.notStrictEqual(result.rows[0].status, STATUS.COMPLETED,
    'PumpSwap prices must not be used before a recorded graduation');
  assert.strictEqual(result.rows[0].exitMarket, null);
  store.close();
}

{
  const store = makeStore();
  addSignal(store, 'filtered-before-limit', 15_000_000);
  addSignal(store, 'qualified-after-limit', 15_010_000);
  store.db.prepare(`
    UPDATE flow_signals SET flow_accel_1 = 1, flow_accel = 1
    WHERE mint = 'filtered-before-limit'
  `).run();
  addTrade(store, 'filtered-before-limit', 15_000_200, 1);
  addTrade(store, 'filtered-before-limit', 15_001_200, 1.1);
  addTrade(store, 'qualified-after-limit', 15_010_200, 1);
  addTrade(store, 'qualified-after-limit', 15_011_200, 1.1);
  store.flushRawTrades();
  const result = runBacktest(store.db, {
    holdMs: 1_000,
    executionDelayMs: 200,
    minFlowAccel: 1.2,
    limit: 1,
    platformFeePct: 0,
    ...zeroVariableCosts,
  });
  assert.strictEqual(result.rows.length, 1,
    'the SQL limit must apply after the acceleration threshold');
  assert.strictEqual(result.rows[0].mint, 'qualified-after-limit');
  store.close();
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-schema-migration-'));
  const dbPath = path.join(tempDir, 'research.db');
  const storage = {
    dbPath, archiveDir: tempDir, rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  };
  const initialStore = new ResearchStore(storage, { configuredTradingCostPct: 1.4 });
  addSignal(initialStore, 'legacy-label', 20_000_000);
  initialStore.db.prepare('UPDATE signal_returns SET finalized_at = ? WHERE signal_id = 1')
    .run(20_060_000);
  initialStore.close();
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    DROP INDEX idx_flow_signals_variant_ts;
    ALTER TABLE flow_signals DROP COLUMN signal_variant;
    ALTER TABLE flow_signals DROP COLUMN is_primary;
    ALTER TABLE signal_returns DROP COLUMN cost_model_json;
    ALTER TABLE signal_returns DROP COLUMN label_status;
    ALTER TABLE signal_returns DROP COLUMN censor_reason;
    ALTER TABLE signal_returns DROP COLUMN missing_horizons_json;
    ALTER TABLE signal_returns DROP COLUMN horizon_observation_lags_json;
  `);
  legacyDb.close();
  const migratedStore = new ResearchStore(storage, { configuredTradingCostPct: 1.4 });
  const signalColumns = new Set(
    migratedStore.db.prepare('PRAGMA table_info(flow_signals)').all()
      .map((column) => column.name),
  );
  assert.ok(signalColumns.has('signal_variant'));
  assert.ok(signalColumns.has('is_primary'));
  const migratedSignal = migratedStore.db.prepare(`
    SELECT signal_variant, is_primary FROM flow_signals WHERE signal_id = 1
  `).get();
  assert.deepStrictEqual(migratedSignal, { signal_variant: 'primary_3w', is_primary: 1 });
  const columns = migratedStore.db.prepare('PRAGMA table_info(signal_returns)').all();
  const names = new Set(columns.map((column) => column.name));
  for (const column of [
    'cost_model_json', 'label_status', 'censor_reason', 'missing_horizons_json',
    'horizon_observation_lags_json',
  ]) assert.ok(names.has(column), `missing migrated column: ${column}`);
  const migratedLabel = migratedStore.db.prepare(`
    SELECT label_status, censor_reason, missing_horizons_json
    FROM signal_returns WHERE signal_id = 1
  `).get();
  assert.strictEqual(migratedLabel.label_status, 'RIGHT_CENSORED');
  assert.strictEqual(migratedLabel.censor_reason, 'LEGACY_MISSING_HORIZON');
  assert.deepStrictEqual(JSON.parse(migratedLabel.missing_horizons_json),
    [1, 2, 3, 5, 8, 10, 15, 20, 30, 60]);
  migratedStore.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.strictEqual(passesAcceleration({ flow_accel_1: 1.3, flow_accel_2: 1.1 }, 1.2), false);
assert.strictEqual(passesAcceleration({ flow_accel_1: null, flow_accel_2: 1.3 }, 1.2), true);
assert.strictEqual(passesAcceleration({ flow_accel_1: null, flow_accel_2: null }, 1.2), true);

console.log('test-flow-backtest: ok');
