'use strict';

const assert = require('assert');
const FlowAccelerationEngine = require('../src/core/FlowAccelerationEngine');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const {
  classifyBuyReconciliation,
  confirmedTransactionFailure,
} = require('../src/core/PumpTradeExecutor');
const { evaluateSmartOpen, REJECT } = require('../src/core/SmartOpenStrategy');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function managerConfig(overrides = {}) {
  return {
    enabled: true,
    dryRun: false,
    minSmartOpenSol: 1,
    minPreBuyers: 2,
    preBuyWindowMs: 2_000,
    maxSignalAgeMs: 1_500,
    positionSizeSol: 0.05,
    maxConcurrentPositions: 1,
    maxDailySpendSol: 1,
    minWalletReserveSol: 0.05,
    mintCooldownMs: 600_000,
    maxEntryPriceJumpPct: 10,
    buySlippagePct: 10,
    sellSlippagePct: 15,
    computeUnitLimit: 250_000,
    priorityFeeMicroLamports: 20_000,
    commitment: 'confirmed',
    exitStrategy: 'SMART_WALLET_SELL_60S',
    stopLossPct: 12,
    takeProfitPct: 20,
    trailingActivationPct: 8,
    trailingStopPct: 5,
    minHoldMs: 500,
    maxHoldMs: 60_000,
    exitOnTriggerWalletSell: true,
    exitRetryCount: 1,
    exitRetryDelayMs: 1,
    entryReconcileCount: 1,
    entryReconcileDelayMs: 1,
    killSwitchFile: '',
    ...overrides,
  };
}

function smartTrade({ side = 'BUY', timestampMs, signature, tokenAmount = 100 }) {
  return {
    timestampMs,
    receivedAtMs: timestampMs,
    slot: 1,
    signature,
    eventIndex: 0,
    wallet: 'smart-wallet',
    mint: 'smart-mint',
    side,
    market: 'PUMP_BONDING_CURVE',
    solAmount: side === 'BUY' ? 1.2 : 1.1,
    tokenAmount,
    price: 0.01,
    curvePct: 50,
    ageMs: 10_000,
  };
}

async function main() {
  const confirmedFailure = confirmedTransactionFailure(
    'failed-chain-signature',
    { InstructionError: [3, { Custom: 6002 }] },
  );
  assert.strictEqual(confirmedFailure.code, 'TRANSACTION_FAILED');
  assert.strictEqual(confirmedFailure.signature, 'failed-chain-signature');
  assert.strictEqual(confirmedFailure.transactionFailed, true);
  assert.strictEqual(classifyBuyReconciliation({
    err: { InstructionError: [3, { Custom: 6002 }] },
    confirmationStatus: 'confirmed',
  }, 0n).state, 'FAILED');
  assert.strictEqual(classifyBuyReconciliation({
    err: null,
    confirmationStatus: 'confirmed',
  }, 500n).state, 'CONFIRMED');
  assert.strictEqual(classifyBuyReconciliation({
    err: null,
    confirmationStatus: 'finalized',
  }, 0n).state, 'EMPTY');
  assert.strictEqual(classifyBuyReconciliation(null, 0n).state, 'UNKNOWN');

  const exact = evaluateSmartOpen({
    positionPhase: 'OPEN', market: 'PUMP_BONDING_CURVE', solAmount: 1,
    timestampMs: 10_000,
  }, { uniqueBuyers: 2, receivedAtMs: 10_000 }, managerConfig(), 10_100);
  assert.strictEqual(exact.matched, true);
  const rejected = evaluateSmartOpen({
    positionPhase: 'ADD', market: 'PUMP_AMM', solAmount: 0.5, timestampMs: 1,
  }, { uniqueBuyers: 1, receivedAtMs: 1 }, managerConfig(), 10_000);
  assert.ok(rejected.rejectReasons.includes(REJECT.NOT_OPEN));
  assert.ok(rejected.rejectReasons.includes(REJECT.NOT_BONDING_CURVE));
  assert.ok(rejected.rejectReasons.includes(REJECT.SMART_BUY_TOO_SMALL));
  assert.ok(rejected.rejectReasons.includes(REJECT.INSUFFICIENT_PREBUY_BUYERS));
  assert.ok(rejected.rejectReasons.includes(REJECT.STALE_EVENT));

  const engine = new FlowAccelerationEngine({
    bufferMs: 60_000,
    activityWindowMs: 5_000,
    activityMinVolumeSol: 999,
    activityMinTxCount: 999,
    activityMinUniqueWallets: 999,
    signalWindowMs: 2_000,
    minNetFlowW3Sol: 999,
    minNetFlowDeltaSol: 999,
    minAccelerationRatio: 99,
    ratioFloorSol: 0.05,
    signalCooldownMs: 0,
    candidateIdleMs: 15_000,
  });
  const prior = (wallet, timestampMs) => ({
    market: 'PUMP_BONDING_CURVE', mint: 'smart-mint', wallet, side: 'BUY',
    solAmount: 0.2, tokenAmount: 10, price: 0.01, timestampMs,
  });
  engine.handleTrade(prior('buyer-1', 9_000));
  engine.handleTrade(prior('buyer-2', 9_500));
  engine.handleTrade(prior('smart-wallet', 9_700));
  const context = engine.recentBuyContext('smart-mint', 10_000, 2_000, 'smart-wallet');
  assert.strictEqual(context.uniqueBuyers, 2, 'trigger wallet must be excluded from pre-buy Buyers');
  assert.strictEqual(context.buyTx, 2);

  const store = makeStore();
  let now = 10_000;
  const calls = { buy: 0, sell: 0 };
  const executor = {
    async buy() {
      calls.buy += 1;
      return {
        signature: 'live-buy-signature', venue: 'PUMP_BONDING_CURVE',
        tokenAmountRaw: '5000000', expectedPrice: 0.01,
      };
    },
    async sell() {
      calls.sell += 1;
      return {
        signature: 'live-sell-signature', venue: 'PUMP_BONDING_CURVE',
        tokenAmountRaw: '5000000',
      };
    },
  };
  const manager = new LiveTradingManager({
    config: managerConfig(), store, executor, now: () => now,
  });
  manager.start();
  const open = store.recordSmartWalletEvent(smartTrade({
    timestampMs: now, signature: 'smart-open',
  }));
  manager.onSmartWalletEvent(open, { ...context, receivedAtMs: now });
  await manager.entryQueue;
  assert.strictEqual(calls.buy, 1);
  assert.strictEqual(store.activeLivePositions().length, 1);
  assert.strictEqual(
    store.db.prepare('SELECT action_status FROM smart_open_decisions').get().action_status,
    'OPEN',
  );

  now = 10_050;
  manager.observeTrade({
    mint: 'smart-mint', market: 'PUMP_BONDING_CURVE', price: 0.001, timestampMs: now,
  });
  await Promise.allSettled([...manager.pending]);
  assert.strictEqual(calls.sell, 0, 'price stop must be disabled by SMART_WALLET_SELL_60S');
  assert.strictEqual(store.activeLivePositions().length, 1);

  now = 10_100;
  const add = store.recordSmartWalletEvent(smartTrade({
    timestampMs: now, signature: 'smart-add', tokenAmount: 10,
  }));
  assert.strictEqual(add.positionPhase, 'ADD');
  manager.onSmartWalletEvent(add, { ...context, receivedAtMs: now });
  assert.strictEqual(calls.buy, 1, 'ADD must never open another live position');

  now = 10_200;
  const close = store.recordSmartWalletEvent(smartTrade({
    side: 'SELL', timestampMs: now, signature: 'smart-close', tokenAmount: 110,
  }));
  assert.strictEqual(close.positionPhase, 'CLOSE');
  manager.onSmartWalletEvent(close, { ...context, receivedAtMs: now });
  await Promise.allSettled([...manager.pending]);
  assert.strictEqual(calls.sell, 1);
  assert.strictEqual(store.activeLivePositions().length, 0);
  assert.strictEqual(
    store.db.prepare('SELECT status FROM live_positions').get().status,
    'CLOSED',
  );
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM smart_open_decisions').get().n,
    3,
    'OPEN, ADD and CLOSE decisions must all be retained',
  );
  const dashboard = store.liveTradingDashboard();
  assert.strictEqual(dashboard.stats.decisions, 3);
  assert.strictEqual(dashboard.stats.matched, 1);
  assert.strictEqual(dashboard.stats.positions, 1);
  assert.strictEqual(dashboard.stats.closed_positions, 1);
  assert.strictEqual(dashboard.stats.confirmed_orders, 2);
  assert.strictEqual(dashboard.positions[0].status, 'CLOSED');
  assert.strictEqual(dashboard.orders.length, 2);
  assert.ok(Array.isArray(dashboard.decisions[0].rejection_reasons));
  const health = manager.health();
  assert.strictEqual(health.strategy.ruleVersion, 'smart-open-curve-v1');
  assert.strictEqual(health.strategy.entry.minSmartOpenSol, 1);
  assert.strictEqual(health.strategy.exit.maxHoldMs, 60_000);
  assert.strictEqual(health.strategy.exit.policy, 'SMART_WALLET_SELL_60S');
  assert.strictEqual(health.strategy.exit.exitOnTriggerWalletSell, true);
  assert.strictEqual(health.strategy.exit.minHoldMs, 0);
  assert.strictEqual(health.strategy.exit.stopLossPct, 0);
  assert.strictEqual(health.strategy.exit.takeProfitPct, 0);
  assert.strictEqual(health.strategy.exit.trailingStopPct, 0);
  assert.strictEqual(health.strategy.risk.positionSizeSol, 0.05);
  assert.strictEqual(health.strategy.execution.buySlippagePct, 10);
  assert.strictEqual(health.strategy.execution.sellSlippagePct, 15);

  await manager.stop();
  store.close();

  const failedStore = makeStore();
  let failedNow = 20_000;
  let failedSellCalls = 0;
  const failedManager = new LiveTradingManager({
    config: managerConfig(),
    store: failedStore,
    now: () => failedNow,
    executor: {
      async buy() {
        throw confirmedTransactionFailure(
          'too-much-sol-signature',
          { InstructionError: [3, { Custom: 6002 }] },
        );
      },
      async sell() { failedSellCalls += 1; },
      async reconcileBuy() { throw new Error('deterministic failure must not be reconciled'); },
    },
  });
  failedManager.start();
  const failedOpen = failedStore.recordSmartWalletEvent(smartTrade({
    timestampMs: failedNow,
    signature: 'failed-smart-open',
  }));
  failedManager.onSmartWalletEvent(failedOpen, { ...context, receivedAtMs: failedNow });
  await failedManager.entryQueue;
  const failedPosition = failedStore.db.prepare('SELECT * FROM live_positions').get();
  const failedOrder = failedStore.db.prepare('SELECT * FROM live_orders').get();
  assert.strictEqual(failedPosition.status, 'ENTRY_FAILED');
  assert.strictEqual(failedPosition.exit_reason, 'ENTRY_TRANSACTION_FAILED');
  assert.strictEqual(failedOrder.status, 'FAILED');
  assert.strictEqual(failedOrder.signature, 'too-much-sol-signature');
  assert.strictEqual(failedSellCalls, 0, 'confirmed chain failure must never trigger a sell');
  assert.strictEqual(failedStore.activeLivePositions().length, 0);
  await failedManager.stop();
  failedStore.close();

  const unknownStore = makeStore();
  let unknownNow = 30_000;
  let unknownSellCalls = 0;
  const unknownManager = new LiveTradingManager({
    config: managerConfig(),
    store: unknownStore,
    now: () => unknownNow,
    executor: {
      async buy() {
        const error = new Error('RPC confirmation timed out');
        error.signature = 'unknown-buy-signature';
        throw error;
      },
      async reconcileBuy() { return { state: 'UNKNOWN', tokenAmountRaw: '0' }; },
      async sell() { unknownSellCalls += 1; },
    },
  });
  unknownManager.start();
  const unknownOpen = unknownStore.recordSmartWalletEvent(smartTrade({
    timestampMs: unknownNow,
    signature: 'unknown-smart-open',
  }));
  unknownManager.onSmartWalletEvent(unknownOpen, { ...context, receivedAtMs: unknownNow });
  await unknownManager.entryQueue;
  assert.strictEqual(
    unknownStore.db.prepare('SELECT status FROM live_positions').get().status,
    'EXIT_FAILED',
  );
  assert.strictEqual(
    unknownStore.db.prepare('SELECT COUNT(*) AS n FROM live_orders').get().n,
    1,
    'unknown entry must not generate blind sell orders',
  );
  assert.strictEqual(unknownSellCalls, 0);
  await unknownManager.stop();

  unknownNow = 31_000;
  const recoveryManager = new LiveTradingManager({
    config: managerConfig(),
    store: unknownStore,
    now: () => unknownNow,
    executor: {
      async reconcileBuy() {
        return { state: 'FAILED', error: 'Transaction failed on chain: Custom 6002' };
      },
      async sell() { unknownSellCalls += 1; },
    },
  });
  recoveryManager.start();
  await Promise.allSettled([...recoveryManager.pending]);
  assert.strictEqual(
    unknownStore.db.prepare('SELECT status FROM live_positions').get().status,
    'ENTRY_FAILED',
    'restart recovery should release a known-failed entry',
  );
  assert.strictEqual(unknownStore.db.prepare('SELECT status FROM live_orders').get().status, 'FAILED');
  assert.strictEqual(unknownSellCalls, 0);
  assert.strictEqual(unknownStore.activeLivePositions().length, 0);
  await recoveryManager.stop();
  unknownStore.close();

  console.log('test-smart-open-live: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
