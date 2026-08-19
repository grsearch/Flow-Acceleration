'use strict';

const assert = require('assert');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { ResearchStore } = require('../src/data/ResearchStore');

function waitForQueue() {
  return new Promise((resolve) => setImmediate(resolve));
}

function runtimeConfig(strategies) {
  return {
    enabled: true,
    requestedEnabled: true,
    safetyLock: false,
    dryRun: true,
    strategies,
    maxConcurrentPositions: 3,
    maxSignalAgeMs: 1_500,
    mintCooldownMs: 0,
    maxHoldMs: 15_000,
    maxEntrySelfImpactPct: 10,
    exitRetryCount: 0,
    exitRetryDelayMs: 1,
    entryReconcileCount: 1,
    entryReconcileDelayMs: 1,
    expiredEntryReleaseMs: 60_000,
    killSwitchFile: null,
    ammPriceContinuity: { minRatio: 0.01, maxRatio: 100, resetAfterMs: 15_000 },
  };
}

async function main() {
  let now = 1_000_000;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 0 });
  const strategies = [
    {
      id: 'migration_continuity_mc_c5_e120_live', enabled: true, entryEnabled: true,
      signalSource: 'MIGRATION_CONTINUITY_MC_C5', ruleVersion: 'm-live-test',
      market: 'PUMP_AMM', positionSizeSol: 1, maxSignalAgeMs: 1_500,
      maxEntriesPerMint: 1, reentryCooldownMs: 0, maxEntryPriceJumpPct: 10,
      maxEntrySelfImpactPct: 10, exitMode: 'FIXED_HOLD', fixedHoldMs: 120_000,
      hardStopPct: 20, maxHoldMs: 120_000,
    },
    {
      id: 'graduation_accel_o_c80_d5_b2_s0_nc_live', enabled: true, entryEnabled: true,
      signalSource: 'GRADUATION_ACCEL_O_C80_D5_B2_S0_NC', ruleVersion: 'o-live-test',
      market: 'PUMP_BONDING_CURVE', positionSizeSol: 1, maxSignalAgeMs: 1_500,
      maxEntriesPerMint: 1, reentryCooldownMs: 0, maxEntryPriceJumpPct: 15,
      exitMode: 'GRADUATION_CORE_RUNNER', hardStopPct: 30, coreExitPct: 50,
      maxPreGraduationHoldMs: 300_000, maxPostGraduationHoldMs: 300_000,
      maxHoldMs: 300_000,
      trailingTiers: [
        { activationPct: 20, drawdownPct: 10 },
        { activationPct: 40, drawdownPct: 15 },
      ],
    },
    {
      id: 'quality_leader_ql_strict_protected_live', enabled: true, entryEnabled: true,
      signalSource: 'QUALITY_LEADER_QL_STRICT_PROTECTED', ruleVersion: 'ql-live-test',
      market: 'PUMP_BONDING_CURVE', positionSizeSol: 0.1, maxSignalAgeMs: 1_500,
      maxEntriesPerMint: 1, reentryCooldownMs: 0, maxEntryPriceJumpPct: 20,
      maxEntrySelfImpactPct: 10, maxShadowEntryImpactPct: 12,
      exitMode: 'QUALITY_PROTECTED_RUNNER',
      hardStopPct: 20, strengthActivationPct: 20, noStrengthMs: 30_000,
      maxHoldMs: 300_000,
      protectedFloors: [
        { activationPct: 20, minFloorPct: 0, peakGivebackPct: 15 },
        { activationPct: 50, minFloorPct: 15, peakGivebackPct: 25 },
        { activationPct: 100, minFloorPct: 40, peakGivebackPct: 40 },
        { activationPct: 200, minFloorPct: 100, peakGivebackPct: 80 },
      ],
    },
    {
      id: 'launch_pullback_fo_rb10_30s_live', enabled: true, entryEnabled: true,
      signalSource: 'LAUNCH_PULLBACK_FO_RB10_30S', ruleVersion: 'fo-live-test',
      market: 'PUMP_BONDING_CURVE', positionSizeSol: 0.1, maxSignalAgeMs: 1_500,
      maxEntriesPerMint: 1, reentryCooldownMs: 0, maxEntryPriceJumpPct: 10,
      maxEntrySelfImpactPct: 10, exitMode: 'FIXED_HOLD', fixedHoldMs: 30_000,
      hardStopPct: 0, maxHoldMs: 30_000,
    },
  ];
  const manager = new LiveTradingManager({
    config: runtimeConfig(strategies), store, now: () => now,
  });
  manager.start();

  store.recordCreate({
    mint: 'm-live-mint', symbol: 'M', name: null, uri: null, bondingCurve: null,
    creator: null, createdAt: now - 20_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  store.recordComplete({ mint: 'm-live-mint', completedAt: now - 5_000, timestampMs: now - 5_000 });
  manager.onExternalStrategySignal({
    strategyId: strategies[0].id, episodeId: 'm:1', mint: 'm-live-mint',
    symbol: 'M', price: 1, market: 'PUMP_AMM', timestampMs: now, receivedAtMs: now,
    features: { buyers: 20, netFlowSol: 5, returnPct: 5, sellBuyRatio: 0.5 },
  });
  await waitForQueue();
  assert.strictEqual(store.liveTradingDashboard({ strategyId: strategies[0].id }).stats.positions, 1);
  now += 120_001;
  manager.observeTrade({
    mint: 'm-live-mint', market: 'PUMP_AMM', price: 1.1, timestampMs: now,
  });
  await waitForQueue();
  const mPosition = store.liveTradingDashboard({ strategyId: strategies[0].id }).positions[0];
  assert.strictEqual(mPosition.status, 'CLOSED');
  assert.strictEqual(mPosition.exit_reason, 'FIXED_HOLD_120000MS');

  const oMint = 'o-live-mint';
  store.recordCreate({
    mint: oMint, symbol: 'O', name: null, uri: null, bondingCurve: null,
    creator: 'creator-o', createdAt: now - 20_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  manager.onExternalStrategySignal({
    strategyId: strategies[1].id, episodeId: 'o:1', mint: oMint,
    symbol: 'O', price: 0.000001, market: 'PUMP_BONDING_CURVE',
    timestampMs: now, receivedAtMs: now,
    features: { curvePct: 80, curveDeltaPct: 5, buyers: 2, sellTx: 0, creatorSold: false },
  });
  await waitForQueue();
  store.recordComplete({ mint: oMint, completedAt: now + 1_000, timestampMs: now + 1_000 });
  manager.onGraduated(store.getToken(oMint));
  now += 1_200;
  manager.observeTrade({ mint: oMint, market: 'PUMP_AMM', price: 0.0000013, timestampMs: now });
  await waitForQueue();
  let oDashboard = store.liveTradingDashboard({ strategyId: strategies[1].id });
  assert.strictEqual(oDashboard.positions[0].status, 'OPEN');
  assert.ok(oDashboard.orders.some((order) => order.status === 'CONFIRMED_PARTIAL'));
  now += 100;
  manager.observeTrade({ mint: oMint, market: 'PUMP_AMM', price: 0.000002, timestampMs: now });
  now += 100;
  manager.observeTrade({ mint: oMint, market: 'PUMP_AMM', price: 0.00000165, timestampMs: now });
  await waitForQueue();
  oDashboard = store.liveTradingDashboard({ strategyId: strategies[1].id });
  assert.strictEqual(oDashboard.positions[0].status, 'CLOSED');
  assert.strictEqual(oDashboard.positions[0].exit_reason, 'RUNNER_STAIR_T40_D15');

  manager.onExternalStrategySignal({
    strategyId: strategies[2].id, episodeId: 'ql-impact:1', mint: 'ql-impact-mint',
    symbol: 'QLI', price: 1, market: 'PUMP_BONDING_CURVE',
    timestampMs: now, receivedAtMs: now,
    features: { shadowEntryImpactPct: 13 },
  });
  await waitForQueue();
  assert.deepStrictEqual(store.db.prepare(`
    SELECT action_status, action_reason FROM live_strategy_decisions
    WHERE mint='ql-impact-mint'
  `).get(), { action_status: 'RISK_REJECTED', action_reason: 'SHADOW_ENTRY_IMPACT' });

  const qlMint = 'ql-live-mint';
  store.recordCreate({
    mint: qlMint, symbol: 'QL', name: null, uri: null, bondingCurve: null,
    creator: 'creator-ql', createdAt: now - 20_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  manager.onExternalStrategySignal({
    strategyId: strategies[2].id, episodeId: 'ql:1', mint: qlMint,
    symbol: 'QL', price: 1, market: 'PUMP_BONDING_CURVE',
    timestampMs: now, receivedAtMs: now,
    features: {
      retention20Pct: 85, buyerDelta: 10, netFlowDeltaSol: 4,
      shadowEntryImpactPct: 10,
    },
  });
  await waitForQueue();
  now += 100;
  manager.observeTrade({
    mint: qlMint, market: 'PUMP_BONDING_CURVE', price: 1.25, timestampMs: now,
  });
  now += 100;
  manager.observeTrade({
    mint: qlMint, market: 'PUMP_BONDING_CURVE', price: 1.05, timestampMs: now,
  });
  await waitForQueue();
  const qlPosition = store.liveTradingDashboard({ strategyId: strategies[2].id }).positions[0];
  assert.strictEqual(qlPosition.status, 'CLOSED');
  assert.strictEqual(qlPosition.exit_reason, 'PROTECTED_FLOOR_10');

  const foMint = 'fo-live-mint';
  store.recordCreate({
    mint: foMint, symbol: 'FO', name: null, uri: null, bondingCurve: null,
    creator: 'creator-fo', createdAt: now - 20_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  manager.onExternalStrategySignal({
    strategyId: strategies[3].id, episodeId: 'fo:1', mint: foMint,
    symbol: 'FO', price: 1, market: 'PUMP_BONDING_CURVE',
    timestampMs: now, receivedAtMs: now,
    features: { shadowCohortId: 'FO_RB10_30S', shadowEntryJumpPct: 2 },
  });
  await waitForQueue();
  assert.strictEqual(store.liveTradingDashboard({ strategyId: strategies[3].id }).stats.positions, 1);
  now += 30_001;
  manager.observeTrade({
    mint: foMint, market: 'PUMP_BONDING_CURVE', price: 1.4, timestampMs: now,
  });
  await waitForQueue();
  const foPosition = store.liveTradingDashboard({ strategyId: strategies[3].id }).positions[0];
  assert.strictEqual(foPosition.status, 'CLOSED');
  assert.strictEqual(foPosition.exit_reason, 'FIXED_HOLD_30000MS');

  await manager.stop();
  store.close();
  console.log('test-live-shadow-promotion: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
