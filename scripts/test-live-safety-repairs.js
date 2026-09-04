'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { ResearchStore } = require('../src/data/ResearchStore');

function assertRealtimeOrdering() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const liveAt = source.indexOf('trader.observeTrade(trade);');
  const registryAt = source.indexOf("observeShadow('smartWalletRegistry'");
  const cachedMonitoringAt = source.indexOf('smartWalletRegistry.cachedMonitoringSnapshot(');
  const cachedVotingAt = source.indexOf('smartWalletRegistry.cachedWalletSnapshot(');
  assert(liveAt >= 0 && registryAt > liveAt,
    'live signal and position handling must run before Smart Wallet research');
  assert(cachedMonitoringAt > liveAt && cachedVotingAt > liveAt,
    'the realtime Smart Wallet path must use local eligibility snapshots');
  assert.strictEqual(source.includes('smartWalletRegistry.monitoringSnapshot('), false,
    'the realtime runtime must not query exact wallet monitoring state per trade');
  assert.strictEqual(source.includes('smartWalletRegistry.walletSnapshot('), false,
    'the realtime runtime must not query exact wallet voting/PnL state per trade');
}

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
    sellSlippagePct: 15,
    emergencySellSlippagePct: 100,
    priorityFeeMicroLamports: 2_000_000,
    emergencyPriorityFeeMicroLamports: 8_000_000,
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
  assertRealtimeOrdering();
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

  let emergencySellArgs = null;
  const emergencyExecutor = {
    async buyAmm() {
      return {
        venue: 'PUMP_AMM', tokenAmountRaw: '1000000', expectedPrice: 1,
        signature: 'emergency-buy',
      };
    },
    async sell(args) {
      emergencySellArgs = args;
      return {
        venue: 'PUMP_AMM', tokenAmountRaw: args.tokenAmountRaw,
        remainingTokenAmountRaw: '0', balanceVerified: true,
        signature: 'emergency-sell',
        execution: { emergencyExit: args.emergency },
      };
    },
  };
  const emergencyLive = new LiveTradingManager({
    config: managerConfig([stopStrategy], false),
    store,
    executor: emergencyExecutor,
    now: () => now,
  });
  emergencyLive.start();
  const emergencyMint = 'emergency-exit-route-mint';
  store.recordCreate({
    mint: emergencyMint, symbol: 'EXIT', name: null, uri: null,
    bondingCurve: null, creator: null, createdAt: now - 100_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  store.recordComplete({ mint: emergencyMint, completedAt: now - 10_000 });
  emergencyLive.onExternalStrategySignal(signal(
    stopStrategy.id, emergencyMint, now, 'emergency:1',
  ));
  await settle(emergencyLive);
  now += 100;
  emergencyLive.observeTrade({
    mint: emergencyMint, market: 'PUMP_AMM', price: 0.01, timestampMs: now,
  });
  await settle(emergencyLive);
  assert.strictEqual(emergencySellArgs.emergency, true,
    'HARD_STOP exits must use the catastrophe execution route');
  const emergencyOrder = store.liveTradingDashboard({
    strategyId: stopStrategy.id,
  }).orders.find((row) => row.mint === emergencyMint && row.side === 'SELL');
  assert.strictEqual(emergencyOrder.execution.emergencyExit, true);
  await emergencyLive.stop();

  const curveStrategy = {
    ...strategy('curve_rug_audit_test'),
    market: 'PUMP_BONDING_CURVE',
  };
  store.preEntryRugRisk = {
    config: { enabled: true },
    evaluateGuard(input) {
      return {
        ...input,
        observedAt: now,
        sampleReady: false,
        sampleSize: 9,
        flagged: true,
        riskFlagged: true,
        blocked: true,
        reason: 'PRE_ENTRY_RUG_EXTREME_DUMPABILITY',
        flaggedReasons: ['extremeCoordinatedDumpability'],
        signatures: { extremeCoordinatedDumpability: true },
        matchedHardBlockSignatures: ['extremeCoordinatedDumpability'],
        extremeCoordinatedDumpability: true,
        dumpability: { top3ObservedSharePct: 88.18, top3RecoveryPct: 10.24 },
      };
    },
  };
  const auditManager = new LiveTradingManager({
    config: managerConfig([curveStrategy], true), store, now: () => now,
  });
  auditManager.start();
  auditManager.onExternalStrategySignal({
    ...signal(curveStrategy.id, 'curve-rug-audit-mint', now, 'rug-audit:1'),
    market: 'PUMP_BONDING_CURVE',
  });
  await settle(auditManager);
  const auditDecision = store.liveTradingDashboard({
    strategyId: curveStrategy.id,
  }).decisions[0];
  assert.strictEqual(auditDecision.action_status, 'RISK_REJECTED');
  assert.strictEqual(auditDecision.action_reason, 'PRE_ENTRY_RUG_EXTREME_DUMPABILITY');
  assert.deepStrictEqual(
    auditDecision.rejection_reasons,
    ['PRE_ENTRY_RUG_EXTREME_DUMPABILITY'],
  );
  assert.strictEqual(
    auditDecision.features.preEntryRugRisk.dumpability.top3RecoveryPct,
    10.24,
  );
  await auditManager.stop();
  delete store.preEntryRugRisk;

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

  const toxicHistoryRows = [{
    kind: 'WALLET',
    subject: 'toxic-wallet-1',
    wallet: 'toxic-wallet-1',
    mint: 'collapsed-mint-1',
    fingerprint: 'fp-1',
    labeledAt: now,
    expiresAt: now + (60 * 24 * 60 * 60 * 1000),
    collapsePct: 92.77,
    totalBuySol: 65.99,
    largeBuyCount: 4,
    burstSpanMs: 281,
    amounts: [20, 18, 16, 11.99],
  }];
  assert.strictEqual(store.recordPreEntryRugToxicHistory(toxicHistoryRows), 1);
  assert.strictEqual(store.recordPreEntryRugToxicHistory(toxicHistoryRows), 0,
    'the permanent toxic ledger must be idempotent for the same collapse label');
  const toxicHistory = store.db.prepare(`
    SELECT kind, subject, mint, collapse_pct, expires_at
    FROM pre_entry_rug_toxic_history
  `).get();
  assert.strictEqual(toxicHistory.kind, 'WALLET');
  assert.strictEqual(toxicHistory.subject, 'toxic-wallet-1');
  assert.strictEqual(toxicHistory.mint, 'collapsed-mint-1');
  assert.strictEqual(toxicHistory.collapse_pct, 92.77);
  assert.strictEqual(toxicHistory.expires_at, toxicHistoryRows[0].expiresAt);

  store.close();
  console.log('test-live-safety-repairs: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
