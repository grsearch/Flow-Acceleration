'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const { STATUS, passesAcceleration, runBacktest } = require('../src/core/FlowBacktester');

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

function addSignal(store, mint, timestampMs) {
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-schema-migration-'));
  const dbPath = path.join(tempDir, 'research.db');
  const storage = {
    dbPath, archiveDir: tempDir, rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  };
  const initialStore = new ResearchStore(storage, { configuredTradingCostPct: 1.4 });
  initialStore.close();
  const legacyDb = new Database(dbPath);
  legacyDb.exec('ALTER TABLE signal_returns DROP COLUMN cost_model_json');
  legacyDb.close();
  const migratedStore = new ResearchStore(storage, { configuredTradingCostPct: 1.4 });
  const columns = migratedStore.db.prepare('PRAGMA table_info(signal_returns)').all();
  assert.ok(columns.some((column) => column.name === 'cost_model_json'));
  migratedStore.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.strictEqual(passesAcceleration({ flow_accel_1: 1.3, flow_accel_2: 1.1 }, 1.2), false);
assert.strictEqual(passesAcceleration({ flow_accel_1: null, flow_accel_2: 1.3 }, 1.2), true);
assert.strictEqual(passesAcceleration({ flow_accel_1: null, flow_accel_2: null }, 1.2), true);

console.log('test-flow-backtest: ok');
