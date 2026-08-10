'use strict';

const assert = require('assert');
const { SmartOpenShadowSuite } = require('../src/core/SmartOpenShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:',
    archiveDir: '.',
    rawRetentionHours: 24,
    flushMs: 60_000,
    flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function strategyConfig() {
  return {
    enabled: true,
    minSmartOpenSol: 1,
    preBuyWindowMs: 2_000,
    minPreBuyers: 2,
    maxEntryPriceJumpPct: 10,
    positionSizeSol: 0.05,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    bigWinnerPct: 50,
    cohorts: [
      {
        id: 'D0',
        label: 'D0 · 真OPEN固定5秒',
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 5_000,
        followSmartExit: false,
      },
      {
        id: 'D1',
        label: 'D1 · 延迟激活移动止盈',
        exitMode: 'DELAYED_TRAILING',
        hardStopPct: 12.5,
        trailingActivationPct: 20,
        trailingStopPct: 15,
        maxHoldMs: 60_000,
        followSmartExit: false,
      },
      {
        id: 'D2',
        label: 'D2 · 跟随Smart减仓/清仓',
        exitMode: 'SMART_FOLLOW',
        hardStopPct: 12.5,
        maxHoldMs: 180_000,
        followSmartExit: true,
      },
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

function trade({
  mint = 'smart-open-mint',
  timestampMs,
  price,
  side = 'BUY',
  wallet = 'regular-wallet',
  solAmount = 0.2,
  tokenAmount = 100,
}) {
  return {
    mint,
    symbol: mint,
    timestampMs,
    receivedAtMs: timestampMs,
    slot: timestampMs,
    signature: `${mint}-${timestampMs}-${wallet}-${side}`,
    eventIndex: 0,
    price,
    side,
    wallet,
    solAmount,
    tokenAmount,
    curvePct: 40,
    ageMs: 15_000,
    market: 'PUMP_BONDING_CURVE',
  };
}

function main() {
  const store = makeStore();
  let now = 90_000;
  const suite = new SmartOpenShadowSuite({
    config: strategyConfig(),
    store,
    now: () => now,
  });
  suite.start();

  const openTrade = trade({
    timestampMs: 100_000,
    price: 1,
    wallet: 'smart-wallet',
    solAmount: 1.2,
    tokenAmount: 1_000,
  });
  const openEvent = store.recordSmartWalletEvent(openTrade);
  assert.strictEqual(openEvent.positionPhase, 'OPEN');
  suite.onSmartWalletEvent(openEvent, {
    windowMs: 2_000,
    uniqueBuyers: 2,
    buyTx: 3,
    buyFlowSol: 1.1,
    sellFlowSol: 0.1,
    netFlowSol: 1,
  });

  let dashboard = store.smartOpenShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(dashboard.positions.length, 3, 'one OPEN creates isolated D0/D1/D2 rows');
  assert.ok(dashboard.positions.every((row) => row.status === 'PENDING_ENTRY'));
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM smart_pullback_shadow_positions').get().n,
    0,
    'new OPEN experiment must not write to the old Smart pullback table',
  );

  suite.observeTrade(trade({ timestampMs: 100_100, price: 1.02 }));
  assert.strictEqual(suite.health().pendingEntries, 3);
  suite.observeTrade(trade({ timestampMs: 100_200, price: 1.05 }));
  assert.strictEqual(suite.health().activePositions, 3);

  suite.observeTrade(trade({ timestampMs: 100_500, price: 1.27 }));
  suite.observeTrade(trade({ timestampMs: 100_600, price: 1.06, side: 'SELL' }));
  suite.observeTrade(trade({ timestampMs: 100_800, price: 1.07 }));
  dashboard = store.smartOpenShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(
    dashboard.positions.find((row) => row.cohort_id === 'D1').status,
    'CLOSED',
    'D1 should activate at +20% and exit after a 15% peak drawdown',
  );
  assert.strictEqual(
    dashboard.positions.find((row) => row.cohort_id === 'D2').status,
    'OPEN',
  );

  suite.observeTrade(trade({ timestampMs: 105_200, price: 1.15 }));
  suite.observeTrade(trade({ timestampMs: 105_400, price: 1.16 }));
  dashboard = store.smartOpenShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(
    dashboard.positions.find((row) => row.cohort_id === 'D0').status,
    'CLOSED',
    'D0 should use the fixed five-second exit without changing other cohorts',
  );

  const reduceTrade = trade({
    timestampMs: 106_000,
    price: 1.2,
    side: 'SELL',
    wallet: 'smart-wallet',
    solAmount: 0.12,
    tokenAmount: 100,
  });
  const reduceEvent = store.recordSmartWalletEvent(reduceTrade);
  assert.strictEqual(reduceEvent.positionPhase, 'REDUCE');
  suite.onSmartWalletEvent(reduceEvent, {});
  suite.observeTrade(reduceTrade);
  suite.observeTrade(trade({ timestampMs: 106_200, price: 1.19 }));
  dashboard = store.smartOpenShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(
    dashboard.positions.find((row) => row.cohort_id === 'D2').exit_reason,
    'SMART_WALLET_REDUCE',
    'D2 follows REDUCE/CLOSE from the wallet that opened the position',
  );
  assert.ok(dashboard.positions.every((row) => row.status === 'CLOSED'));

  const rejectedTrade = trade({
    mint: 'insufficient-prebuyers',
    timestampMs: 200_000,
    price: 1,
    wallet: 'smart-wallet-2',
    solAmount: 1.1,
    tokenAmount: 1_000,
  });
  const rejectedEvent = store.recordSmartWalletEvent(rejectedTrade);
  suite.onSmartWalletEvent(rejectedEvent, { uniqueBuyers: 1, buyTx: 1 });
  dashboard = store.smartOpenShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(
    dashboard.positions.filter((row) => row.mint === 'insufficient-prebuyers'
      && row.status === 'RULE_REJECTED').length,
    3,
  );

  const addTrade = trade({
    timestampMs: 201_000,
    price: 1.1,
    wallet: 'smart-wallet',
    solAmount: 2,
    tokenAmount: 100,
  });
  const addEvent = store.recordSmartWalletEvent(addTrade);
  assert.strictEqual(addEvent.positionPhase, 'ADD');
  suite.onSmartWalletEvent(addEvent, { uniqueBuyers: 10, buyTx: 12 });
  dashboard = store.smartOpenShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(
    dashboard.positions.filter((row) => row.smart_event_id === addEvent.id
      && row.rejection_reason.includes('NOT_OPEN')).length,
    3,
    'ADD events remain visible as rejected rows and never contaminate true OPEN results',
  );

  const health = suite.health();
  assert.strictEqual(health.mode, 'SHADOW_SMART_OPEN');
  assert.strictEqual(health.sendsTransactions, false);
  assert.deepStrictEqual(
    health.cohorts.map((cohort) => [
      cohort.cohortId,
      cohort.strategy.exit.policy,
      cohort.strategy.research.isolatedTable,
      cohort.strategy.research.sendsTransactions,
    ]),
    [
      ['D0', 'FIXED_HOLD', 'smart_open_shadow_positions', false],
      ['D1', 'DELAYED_TRAILING', 'smart_open_shadow_positions', false],
      ['D2', 'SMART_REDUCE_OR_CLOSE', 'smart_open_shadow_positions', false],
    ],
  );
  assert.strictEqual(store.health().smartOpenShadowPositions.total, 9);
  store.close();
  console.log('smart OPEN shadow tests passed');
}

main();
