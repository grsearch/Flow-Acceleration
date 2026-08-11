'use strict';

const assert = require('assert');
const { GraduationHoldShadowSuite, STATUS } = require('../src/core/GraduationHoldShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function config() {
  return {
    enabled: true,
    signalVariant: 'primary_3w',
    positionSizeSol: 0.05,
    maxSignalLatencyMs: 1_500,
    maxSignalCurvePct: 70,
    maxTokenAgeMs: 600_000,
    stateRetentionMs: 600_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 10,
    hardStopPct: 30,
    controlTrailingStopPct: 7.5,
    controlMaxHoldMs: 60_000,
    maxHoldMs: 120_000,
    firstCheckpointTimeoutMs: 20_000,
    stepTimeoutMs: 3_000,
    graduationTimeoutMs: 15_000,
    ammExitDelayMs: 5_000,
    bridgeMinBuyers5: 12,
    bridgeMaxCumulativeTrades: 20,
    checkpoints: [70, 80, 85, 90, 95, 97],
    checkpointRules: [
      { thresholdPct: 70, minNetFlow5Sol: 0, minBuyers5: 3, maxSellSol5: 1, minCurveDelta5: 5 },
      { thresholdPct: 80, minNetFlow5Sol: 0, minBuyers5: 1, maxSellSol5: null, minCurveDelta5: 5 },
      { thresholdPct: 85, minNetFlow5Sol: 0, minBuyers5: 1, maxSellSol5: null, minCurveDelta5: 5 },
      { thresholdPct: 90, minNetFlow5Sol: 0, minBuyers5: 4, maxSellSol5: null, minCurveDelta5: 5 },
      { thresholdPct: 95, minNetFlow5Sol: 0, minBuyers5: 4, maxSellSol5: null, minCurveDelta5: 5 },
    ],
    cohorts: [
      { id: 'I0', label: 'control', exitMode: 'CONTROL_TRAILING' },
      { id: 'I1', label: 'pre-grad', exitMode: 'PRE_GRAD_CHECKPOINTS' },
      { id: 'I2', label: 'through-grad', exitMode: 'THROUGH_GRADUATION' },
    ],
    costModel: {
      platformFeePct: 1.4,
      buySlippagePct: 0.3,
      sellSlippagePct: 0.3,
      priceImpactPct: 0.2,
      baseTxFeeSol: 0.00001,
      priorityFeeSol: 0.0005,
      positionSizeSol: 0.05,
    },
  };
}

function signal(store, mint, timestampMs, curvePct = 45) {
  return store.recordSignal({
    timestampMs,
    slot: 1,
    signature: `${mint}-${timestampMs}`,
    mint,
    symbol: mint,
    ageMs: 15_000,
    curvePct,
    price: 1,
    buyFlowW1: 1,
    buyFlowW2: 2,
    buyFlowW3: 4,
    sellFlowW1: 0,
    sellFlowW2: 0,
    sellFlowW3: 0,
    netFlowW1: 1,
    netFlowW2: 2,
    netFlowW3: 4,
    deltaNetFlow12: 1,
    deltaNetFlow23: 2,
    uniqueBuyersW1: 1,
    uniqueBuyersW2: 2,
    uniqueBuyersW3: 4,
    buyTxW1: 1,
    buyTxW2: 2,
    buyTxW3: 4,
    flowAccel1: 2,
    flowAccel2: 2,
    flowAccel: 2,
    signalVariant: 'primary_3w',
    isPrimary: true,
  });
}

function trade({ mint, timestampMs, price, curvePct, market = 'PUMP_BONDING_CURVE', wallet }) {
  return {
    mint,
    timestampMs,
    price,
    reservePrice: price,
    curvePct,
    side: 'BUY',
    wallet: wallet || `wallet-${timestampMs}`,
    solAmount: 1,
    market,
  };
}

function main() {
  const store = makeStore();
  let now = 100_000;
  const suite = new GraduationHoldShadowSuite({ config: config(), store, now: () => now });
  suite.start();
  suite.onSignal(signal(store, 'graduation-mint', 100_000));
  assert.strictEqual(suite.health().pendingEntries, 3);
  assert.strictEqual(suite.health().sendsTransactions, false);

  suite.observeTrade(trade({
    mint: 'graduation-mint', timestampMs: 100_200, price: 1, curvePct: 45,
  }));
  assert.strictEqual(suite.health().activePositions, 3, 'all cohorts share the early fill');

  for (let index = 0; index < 12; index += 1) {
    suite.observeTrade(trade({
      mint: 'graduation-mint',
      timestampMs: 100_300 + index * 50,
      price: 1.02 + index * 0.01,
      curvePct: 46 + index,
      wallet: `buyer-${index}`,
    }));
  }
  for (const [timestampMs, price, curvePct] of [
    [101_000, 1.5, 70],
    [101_500, 1.8, 80],
    [102_000, 2.0, 85],
    [102_500, 2.3, 90],
    [103_000, 2.6, 95],
    [103_500, 2.8, 97],
  ]) {
    suite.observeTrade(trade({ mint: 'graduation-mint', timestampMs, price, curvePct }));
  }
  let dashboard = store.graduationHoldShadowDashboard();
  let rows = Object.fromEntries(dashboard.positions.map((row) => [row.cohort_id, row]));
  assert.strictEqual(rows.I1.status, STATUS.EXIT_PENDING);
  assert.strictEqual(rows.I1.exit_reason, 'PRE_GRAD_CURVE_97');
  assert.strictEqual(rows.I2.status, STATUS.OPEN);
  assert.strictEqual(rows.I2.graduation_ready, 1);
  assert.strictEqual(rows.I2.gates_passed, 5);

  suite.observeTrade(trade({
    mint: 'graduation-mint', timestampMs: 103_750, price: 2.75, curvePct: 97.5,
  }));
  suite.observeTrade(trade({
    mint: 'graduation-mint', timestampMs: 103_800, price: 2.5, curvePct: 97.6,
  }));
  suite.observeTrade(trade({
    mint: 'graduation-mint', timestampMs: 104_050, price: 2.45, curvePct: 97.7,
  }));
  dashboard = store.graduationHoldShadowDashboard();
  rows = Object.fromEntries(dashboard.positions.map((row) => [row.cohort_id, row]));
  assert.strictEqual(rows.I1.status, STATUS.CLOSED);
  assert.strictEqual(rows.I0.status, STATUS.CLOSED);
  assert.strictEqual(rows.I2.status, STATUS.OPEN);

  suite.onGraduated({ mint: 'graduation-mint', graduated_at: 105_000 });
  suite.observeTrade(trade({
    mint: 'graduation-mint',
    timestampMs: 110_250,
    price: 3.2,
    curvePct: 100,
    market: 'PUMP_AMM',
  }));
  dashboard = store.graduationHoldShadowDashboard();
  rows = Object.fromEntries(dashboard.positions.map((row) => [row.cohort_id, row]));
  assert.strictEqual(rows.I2.status, STATUS.CLOSED);
  assert.strictEqual(rows.I2.exit_market, 'PUMP_AMM');
  assert.strictEqual(rows.I2.exit_reason, 'GRADUATED_AMM_DELAY');
  assert.strictEqual(rows.I2.checkpoint_history.length, 5);

  now = 200_000;
  suite.onSignal(signal(store, 'late-mint', 200_000, 80));
  dashboard = store.graduationHoldShadowDashboard({ positionLimit: 30 });
  const rejected = dashboard.positions.filter((row) => row.mint === 'late-mint');
  assert.strictEqual(rejected.length, 3);
  assert.ok(rejected.every((row) => row.status === STATUS.RULE_REJECTED));
  assert.ok(rejected.every((row) => row.rejection_reason === 'HIGH_CURVE_FRESH_ENTRY_BLOCKED'));

  assert.deepStrictEqual(
    new Set(dashboard.cohorts.map((row) => row.cohort_id)),
    new Set(['I0', 'I1', 'I2']),
  );
  assert.strictEqual(store.health().graduationHoldShadowPositions.total, 6);
  store.close();
  console.log('graduation hold shadow tests passed');
}

main();
