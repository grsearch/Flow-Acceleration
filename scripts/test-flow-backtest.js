'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { runBacktest } = require('../src/core/FlowBacktester');

const store = new ResearchStore({
  dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
}, {
  configuredTradingCostPct: 1.4,
});

const signal = store.recordSignal({
  timestampMs: 1_000_000, slot: 1, signature: 'signal', mint: 'mint', symbol: 'FLOW',
  ageMs: 10_000, curvePct: 40, price: 1,
  buyFlowW1: 0.5, buyFlowW2: 1, buyFlowW3: 3,
  sellFlowW1: 0.2, sellFlowW2: 0.2, sellFlowW3: 0.2,
  netFlowW1: 0.3, netFlowW2: 0.8, netFlowW3: 2.8,
  deltaNetFlow12: 0.5, deltaNetFlow23: 2,
  uniqueBuyersW1: 2, uniqueBuyersW2: 5, uniqueBuyersW3: 10,
  buyTxW1: 3, buyTxW2: 8, buyTxW3: 15,
  flowAccel1: 2.67, flowAccel2: 3.5,
});
assert.strictEqual(signal.signalId, 1);

for (const trade of [
  { timestampMs: 1_000_200, price: 1.01, signature: 'entry' },
  { timestampMs: 1_002_000, price: 1.08, signature: 'high' },
  { timestampMs: 1_004_000, price: 0.99, signature: 'low' },
  { timestampMs: 1_005_200, price: 1.05, signature: 'exit' },
]) {
  store.ensureToken('mint');
  store.queueRawTrade({
    ...trade,
    receivedAtMs: trade.timestampMs,
    chainTimestampMs: trade.timestampMs,
    eventIndex: 0,
    market: 'PUMP_BONDING_CURVE',
    mint: 'mint',
    wallet: 'wallet',
    side: 'BUY',
    solAmount: 1,
    tokenAmount: 1,
  });
}
store.flushRawTrades();

const result = runBacktest(store.db, {
  holdMs: 5_000,
  executionDelayMs: 200,
  tradingCostPct: 1,
  minNetFlowW3: 1,
  minFlowAccel: 1.2,
});
assert.strictEqual(result.metrics.samples, 1);
assert.ok(result.metrics.averageRawReturnPct > 3.9 && result.metrics.averageRawReturnPct < 4);
assert.ok(result.metrics.averageNetReturnPct > 2.9 && result.metrics.averageNetReturnPct < 3);
assert.ok(result.metrics.averageMfePct > 6.9);
assert.ok(result.metrics.averageMaePct < -1.9);

const detailedCosts = runBacktest(store.db, {
  holdMs: 5_000,
  executionDelayMs: 200,
  platformFeePct: 1,
  baseTxFeeSol: 0.00001,
  priorityFeeSol: 0.0005,
  jitoTipSol: 0.001,
  positionSizeSol: 0.2,
});
assert.ok(Math.abs(detailedCosts.parameters.totalFixedCostSol - 0.00151) < 1e-12);
assert.ok(Math.abs(detailedCosts.parameters.totalCostPct - 1.755) < 1e-9);

store.close();
console.log('test-flow-backtest: ok');
