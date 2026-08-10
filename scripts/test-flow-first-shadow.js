'use strict';

const assert = require('assert');
const { FlowFirstShadowSuite } = require('../src/core/FlowFirstShadowSuite');
const { STATUS } = require('../src/core/FlowFirstShadowManager');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function config(overrides = {}) {
  const costModel = {
    platformFeePct: 1.4,
    buySlippagePct: 0.3,
    sellSlippagePct: 0.3,
    priceImpactPct: 0.2,
    baseTxFeeSol: 0.00001,
    priorityFeeSol: 0.0005,
    positionSizeSol: 0.05,
  };
  return {
    enabled: true,
    signalVariant: 'primary_3w',
    episodeGapMs: 30_000,
    positionSizeSol: 0.05,
    maxSignalAgeMs: 1_500,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxHoldMs: 60_000,
    bigWinnerPct: 50,
    cohorts: [
      { id: 'C5', label: 'C5 固定持有5秒', exitMode: 'FIXED_HOLD', fixedHoldMs: 5_000 },
      { id: 'C75', label: 'C7.5 峰值回撤7.5%', exitMode: 'TRAILING', trailingStopPct: 7.5 },
      { id: 'C125', label: 'C12.5 峰值回撤12.5%', exitMode: 'TRAILING', trailingStopPct: 12.5 },
    ],
    costModel,
    ...overrides,
  };
}

function primarySignal(store, { mint, timestampMs, price = 1 }) {
  return store.recordSignal({
    timestampMs,
    slot: 1,
    signature: `${mint}-${timestampMs}`,
    mint,
    symbol: mint,
    ageMs: 15_000,
    curvePct: 45,
    price,
    buyFlowW1: 0.5,
    buyFlowW2: 0.8,
    buyFlowW3: 1.5,
    sellFlowW1: 0.2,
    sellFlowW2: 0.1,
    sellFlowW3: 0.1,
    netFlowW1: 0.3,
    netFlowW2: 0.7,
    netFlowW3: 1.4,
    deltaNetFlow12: 0.4,
    deltaNetFlow23: 0.7,
    uniqueBuyersW1: 1,
    uniqueBuyersW2: 2,
    uniqueBuyersW3: 3,
    buyTxW1: 1,
    buyTxW2: 3,
    buyTxW3: 5,
    flowAccel1: 2.33,
    flowAccel2: 2,
    flowAccel: 2,
    signalVariant: 'primary_3w',
    isPrimary: true,
  });
}

function trade({ mint, timestampMs, price }) {
  return {
    mint,
    timestampMs,
    price,
    side: 'BUY',
    wallet: `wallet-${timestampMs}`,
    solAmount: 1,
    market: 'PUMP_BONDING_CURVE',
  };
}

function main() {
  const store = makeStore();
  let now = 99_000;
  let suite = new FlowFirstShadowSuite({ config: config(), store, now: () => now });
  suite.start();

  const first = primarySignal(store, { mint: 'flow-first-mint', timestampMs: 100_000 });
  suite.onSignal(first);
  const duplicate = primarySignal(store, { mint: 'flow-first-mint', timestampMs: 100_100 });
  suite.onSignal(duplicate);
  let health = suite.health();
  assert.strictEqual(health.mode, 'SHADOW_C');
  assert.strictEqual(health.sendsTransactions, false);
  assert.strictEqual(health.episodes, 1, 'one Primary episode must count once, not once per row');
  assert.strictEqual(health.deduplicated, 1);
  assert.strictEqual(health.pendingEntries, 3);

  now = 100_150;
  suite = new FlowFirstShadowSuite({ config: config(), store, now: () => now });
  suite.start();
  assert.strictEqual(suite.health().pendingEntries, 3, 'restart must restore all three cohorts');

  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 100_199, price: 1.2 }));
  assert.strictEqual(suite.health().pendingEntries, 3, 'entry must wait for the configured delay');
  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 100_200, price: 1.1 }));
  let dashboard = store.flowFirstShadowDashboard({ bigWinnerPct: 50 });
  const opened = dashboard.positions.filter((row) => row.mint === 'flow-first-mint');
  assert.strictEqual(opened.length, 3);
  assert.ok(opened.every((row) => row.entry_price === 1.1), 'all exits must share one actual fill');
  assert.ok(opened.every((row) => Math.abs(row.entry_jump_pct - 10) < 1e-9));

  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 101_000, price: 1.66 }));
  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 101_100, price: 1.51 }));
  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 101_300, price: 1.5 }));
  dashboard = store.flowFirstShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(
    dashboard.positions.find((row) => row.cohort_id === 'C75').status,
    STATUS.CLOSED,
    '7.5% cohort must exit while the 12.5% cohort stays open',
  );
  assert.strictEqual(
    dashboard.positions.find((row) => row.cohort_id === 'C125').status,
    STATUS.OPEN,
  );

  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 103_000, price: 2.2 }));
  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 103_100, price: 1.9 }));
  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 103_300, price: 1.88 }));
  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 105_200, price: 1.7 }));
  suite.observeTrade(trade({ mint: 'flow-first-mint', timestampMs: 105_400, price: 1.68 }));
  dashboard = store.flowFirstShadowDashboard({ bigWinnerPct: 50 });
  const byCohort = Object.fromEntries(
    dashboard.positions.filter((row) => row.mint === 'flow-first-mint')
      .map((row) => [row.cohort_id, row]),
  );
  assert.strictEqual(byCohort.C5.status, STATUS.CLOSED);
  assert.strictEqual(byCohort.C5.exit_reason, 'FIXED_HOLD_5S');
  assert.strictEqual(byCohort.C125.status, STATUS.CLOSED);
  assert.strictEqual(byCohort.C125.exit_reason, 'TRAILING_12.5PCT');
  assert.ok(byCohort.C125.max_favorable_return_pct >= 99.99);
  assert.deepStrictEqual(
    new Set(dashboard.cohorts.map((cohort) => cohort.cohort_id)),
    new Set(['C5', 'C75', 'C125']),
  );
  assert.ok(dashboard.cohorts.every((cohort) => cohort.independent_mints === 1));
  assert.ok(dashboard.cohorts.every((cohort) => cohort.big_winner_opportunities === 1));

  const noEntry = primarySignal(store, { mint: 'no-entry-mint', timestampMs: 200_000 });
  now = 200_000;
  suite.onSignal(noEntry);
  suite.advanceTime(202_201);
  dashboard = store.flowFirstShadowDashboard();
  assert.strictEqual(
    dashboard.positions.filter((row) => row.mint === 'no-entry-mint'
      && row.status === STATUS.NO_ENTRY).length,
    3,
  );

  now = 300_000;
  const sharedLockSignal = primarySignal(store, {
    mint: 'shared-lock-mint', timestampMs: 300_000,
  });
  suite.onSignal(sharedLockSignal);
  suite.observeTrade(trade({ mint: 'shared-lock-mint', timestampMs: 300_200, price: 1 }));
  suite.advanceTime(310_500);
  suite.advanceTime(310_501);
  now = 331_000;
  const laterEpisode = primarySignal(store, {
    mint: 'shared-lock-mint', timestampMs: 331_000,
  });
  suite.onSignal(laterEpisode);
  dashboard = store.flowFirstShadowDashboard();
  const sharedRejected = dashboard.positions.filter((row) => (
    row.mint === 'shared-lock-mint' && row.signal_at === 331_000
  ));
  assert.strictEqual(sharedRejected.length, 3);
  assert.ok(sharedRejected.every((row) => row.status === STATUS.RULE_REJECTED));
  assert.ok(sharedRejected.every((row) => (
    row.rejection_reason === 'COHORT_MINT_ALREADY_ACTIVE'
  )), 'all cohorts must keep the exact same episode sample while any cohort remains active');

  health = suite.health();
  assert.deepStrictEqual(
    health.cohorts.map((cohort) => [
      cohort.cohortId,
      cohort.strategy.exit.policy,
      cohort.strategy.exit.trailingStopPct,
    ]),
    [
      ['C5', 'FIXED_HOLD', null],
      ['C75', 'IMMEDIATE_TRAILING', 7.5],
      ['C125', 'IMMEDIATE_TRAILING', 12.5],
    ],
  );
  assert.ok(health.cohorts.every((cohort) => !cohort.strategy.research.sendsTransactions));
  assert.strictEqual(store.health().flowFirstShadowPositions.total, 12);
  store.close();
  console.log('flow first shadow tests passed');
}

main();
