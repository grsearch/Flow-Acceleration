'use strict';

const assert = require('assert');
const FlowAccelerationEngine = require('../src/core/FlowAccelerationEngine');
const LiveTradingManager = require('../src/core/LiveTradingManager');
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
    stopLossPct: 12,
    takeProfitPct: 20,
    trailingActivationPct: 8,
    trailingStopPct: 5,
    minHoldMs: 500,
    maxHoldMs: 60_000,
    exitOnTriggerWalletSell: true,
    exitRetryCount: 1,
    exitRetryDelayMs: 1,
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

  now = 10_100;
  const add = store.recordSmartWalletEvent(smartTrade({
    timestampMs: now, signature: 'smart-add', tokenAmount: 10,
  }));
  assert.strictEqual(add.positionPhase, 'ADD');
  manager.onSmartWalletEvent(add, { ...context, receivedAtMs: now });
  assert.strictEqual(calls.buy, 1, 'ADD must never open another live position');

  now = 11_000;
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

  await manager.stop();
  store.close();
  console.log('test-smart-open-live: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
