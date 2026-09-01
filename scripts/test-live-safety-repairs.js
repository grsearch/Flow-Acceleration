'use strict';

const assert = require('assert');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { ResearchStore } = require('../src/data/ResearchStore');

function managerConfig(strategies, dryRun) {
  return {
    enabled: true,
    requestedEnabled: true,
    safetyLock: false,
    dryRun,
    strategies,
    maxConcurrentPositions: 10,
    maxConcurrentPositionsPerMint: 3,
    maxSignalAgeMs: 10_000,
    mintCooldownMs: 0,
    failedEntryCooldownMs: 0,
    failedEntryWindowMs: 300_000,
    maxFailedEntriesPerMint: 20,
    maxHoldMs: 60_000,
    maxEntrySelfImpactPct: 10,
    exitRetryCount: 0,
    exitRetryDelayMs: 1,
    entryReconcileCount: 1,
    entryReconcileDelayMs: 1,
    expiredEntryReleaseMs: 60_000,
    heldMintLockRecheckMs: 1_000,
    heldMintLockRecheckBatch: 10,
    killSwitchFile: null,
    ammPriceContinuity: { minRatio: 0.01, maxRatio: 100, resetAfterMs: 15_000 },
  };
}

function strategy(id) {
  return {
    id,
    enabled: true,
    entryEnabled: true,
    signalSource: `${id}_SOURCE`,
    ruleVersion: `${id}_v1`,
    market: 'PUMP_AMM',
    positionSizeSol: 0.1,
    maxSignalAgeMs: 10_000,
    maxEntriesPerMint: 5,
    maxEntryPriceJumpPct: 20,
    maxEntrySelfImpactPct: 10,
    reentryCooldownMs: 0,
    exitMode: 'FIXED_HOLD',
    fixedHoldMs: 60_000,
    hardStopPct: 20,
    maxHoldMs: 60_000,
  };
}

async function settle(manager) {
  await manager.entryQueue;
  await Promise.allSettled([...manager.pending]);
  await new Promise((resolve) => setImmediate(resolve));
}

function signal(strategyId, mint, now, episodeId) {
  return {
    strategyId,
    episodeId,
    mint,
    symbol: mint,
    price: 1,
    market: 'PUMP_AMM',
    timestampMs: now,
    receivedAtMs: now,
    features: {},
  };
}

async function main() {
  let now = 2_000_000_000_000;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 0 });

  const lockStrategy = strategy('held_mint_lock_test');
  let balanceChecks = 0;
  let buyAttempts = 0;
  const executor = {
    async buyAmm() {
      buyAttempts += 1;
      const error = new Error('Wallet already holds this mint');
      error.code = 'WALLET_ALREADY_HOLDS_MINT';
      error.tokenBalanceRaw = '123456';
      throw error;
    },
    async tokenBalanceRaw() {
      balanceChecks += 1;
      return '0';
    },
  };
  const live = new LiveTradingManager({
    config: managerConfig([lockStrategy], false), store, executor, now: () => now,
  });
  live.start();
  const lockMint = 'persistent-held-mint-lock';
  live.onExternalStrategySignal(signal(lockStrategy.id, lockMint, now, 'lock:1'));
  await settle(live);
  const lock = store.activeLiveMintEntryLock(lockMint);
  assert(lock, 'wallet balance mismatch must create a durable Mint entry lock');
  assert.strictEqual(buyAttempts, 1,
    'a terminal entry failure must end the decision instead of looping forever');
  assert.strictEqual(lock.token_balance_raw, '123456');
  assert.strictEqual(
    store.liveTradingDashboard({ strategyId: lockStrategy.id }).positions[0].exit_reason,
    'ENTRY_WALLET_BALANCE_LOCKED',
  );
  await live.stop();

  const restarted = new LiveTradingManager({
    config: managerConfig([lockStrategy], false), store, executor, now: () => now,
  });
  restarted.start();
  assert.strictEqual(
    restarted._riskReason(signal(lockStrategy.id, lockMint, now, 'lock:2')),
    'MINT_WALLET_BALANCE_LOCK',
    'the lock must survive a manager restart',
  );
  now += 1_001;
  restarted.advanceTime(now);
  await settle(restarted);
  assert.strictEqual(balanceChecks, 1);
  assert.strictEqual(store.activeLiveMintEntryLock(lockMint), null,
    'only a verified zero wallet balance may release the lock');
  assert.strictEqual(
    restarted._riskReason(signal(lockStrategy.id, lockMint, now, 'lock:3')),
    null,
  );
  await restarted.stop();

  const stopStrategy = strategy('extreme_hard_stop_test');
  const dry = new LiveTradingManager({
    config: managerConfig([stopStrategy], true), store, now: () => now,
  });
  dry.start();
  const stopMint = 'extreme-hard-stop-mint';
  store.recordCreate({
    mint: stopMint,
    symbol: 'STOP',
    name: null,
    uri: null,
    bondingCurve: null,
    creator: null,
    createdAt: now - 100_000,
    initialRealTokenReservesRaw: null,
    tokenTotalSupplyRaw: null,
  });
  store.recordComplete({ mint: stopMint, completedAt: now - 10_000 });
  dry.onExternalStrategySignal(signal(stopStrategy.id, stopMint, now, 'stop:1'));
  await settle(dry);
  now += 100;
  dry.observeTrade({
    mint: stopMint,
    market: 'PUMP_AMM',
    price: 0.01,
    timestampMs: now,
  });
  await settle(dry);
  const stopped = store.liveTradingDashboard({ strategyId: stopStrategy.id }).positions[0];
  assert.strictEqual(stopped.status, 'CLOSED');
  assert.strictEqual(stopped.exit_reason, 'HARD_STOP',
    'a 99% crash must stop before AMM continuity filtering can discard the trade');
  assert.strictEqual(stopped.hard_stop_trigger_at, now);
  assert.strictEqual(stopped.hard_stop_trigger_price, 0.01);
  assert(Math.abs(stopped.hard_stop_trigger_return_pct + 99) < 1e-9);
  await dry.stop();

  const attributed = store.createLivePosition({
    strategyId: 'hard_stop_attribution_test',
    mint: 'hard-stop-attribution-mint',
    mode: 'LIVE',
    status: 'OPEN',
    positionSol: 1,
    entryPrice: 1,
  });
  store.updateLivePosition(attributed.id, {
    status: 'CLOSED',
    hardStopTriggerAt: now,
    hardStopTriggerPrice: 0.8,
    hardStopTriggerReturnPct: -20,
  });
  store.recordLiveOrder({
    positionId: attributed.id,
    strategyId: 'hard_stop_attribution_test',
    mint: attributed.mint,
    side: 'BUY',
    status: 'CONFIRMED',
    walletSolDelta: -1,
  });
  store.recordLiveOrder({
    positionId: attributed.id,
    strategyId: 'hard_stop_attribution_test',
    mint: attributed.mint,
    side: 'SELL',
    status: 'CONFIRMED',
    walletSolDelta: 0.75,
  });
  const settlement = store.refreshLivePositionSettlement(attributed.id);
  assert.strictEqual(settlement.hardStopFillReturnPct, -25);
  assert.strictEqual(settlement.hardStopSlippagePct, -5,
    'hard-stop trigger loss and actual wallet fill loss must be attributed separately');

  store.close();
  console.log('test-live-safety-repairs: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
