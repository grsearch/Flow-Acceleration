'use strict';

// Exercise stale production toggles, without any RPC or transaction transport.
const assert = require('assert/strict');
const toggles = [
  'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG',
  'FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG',
  'FLOW_LIVE_GRADUATION_ACCEL_HO500_X60',
];
for (const toggle of toggles) {
  process.env[`${toggle}_ENABLED`] = 'true';
  process.env[`${toggle}_ENTRY_ENABLED`] = 'true';
}
const { config } = require('../src/config');
const { ResearchStore } = require('../src/data/ResearchStore');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const pausedIds = [
  'migrated_ge30_r23_f2_only_g2_xleg_live',
  'migrated_grt_r23_f3_v2_xleg_live',
  'graduation_accel_o_c80_ho500_x60_live',
];
const strategies = pausedIds.map((id) => config.liveTrading.strategies.find((s) => s.id === id));
for (const strategy of strategies) {
  assert(strategy);
  assert.equal(strategy.enabled, true, 'existing positions must retain their manager');
  assert.equal(strategy.entryEnabled, false, 'stale .env=true must not reopen entries');
  assert(strategy.hardStopPct > 0);
  assert(strategy.maxHoldMs > 0);
}
const source = config.graduationAccelerationShadow.entryProfiles.find((p) => p.id === 'O_C80_HO500_X60');
const matrix = config.graduationAccelerationShadow.entryProfiles.filter((p) => p.experimentGroup === 'HO500_LONG_EXIT_V1');
assert.equal(matrix.length, 12);
assert.equal(new Set(matrix.map((p) => p.id)).size, 12);
assert.equal(source.runnerExitMode, 'FIXED_HOLD');
assert.equal(source.runnerMaxHoldMs, 60_000);
assert.equal(config.graduationAccelerationShadow.longExitObservationGraceMs, 300_000);
for (const hold of [1_800_000, 3_600_000]) {
  for (const [activation, drawdown] of [[30, 20], [100, 30]]) {
    const pair = matrix.filter((p) => p.runnerMaxHoldMs === hold && p.trailingActivationPct === activation);
    assert.deepEqual(pair.map((p) => p.hardStopPct), [20, 30, 0]);
    for (const profile of pair) {
      assert.equal(profile.trailingStopPct, drawdown);
      assert.equal(profile.runnerExitMode, 'TRAILING');
      assert.equal(profile.coreExitPct, 0);
      assert.equal(profile.pairedEntryProfileId, source.id);
      assert.deepEqual(profile.capacitySols, [0.1]);
      assert.equal(profile.handoffLiveStrategyId, null);
      assert.equal(profile.liveStrategyId, null);
      assert.equal(profile.liveBridgeCapacitySol, null);
      assert.equal(profile.capacityAwareExit, true);
      assert.equal(profile.rugGuardMode, source.rugGuardMode, 'no hidden entry filter differences');
      assert.deepEqual(profile.postMigrationEntryGate, source.postMigrationEntryGate);
    }
  }
}

async function main() {
  let now = Date.now();
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', flushMs: 60_000, flushMax: 100 },
    { configuredTradingCostPct: 0 });
  const restored = strategies.map((strategy, index) => {
    const position = store.createLivePosition({ strategyId: strategy.id, mint: `paused-held-${index}`,
      mode: 'DRY_RUN', status: 'OPEN', entryMarket: 'PUMP_AMM', positionSol: 0.1, entryPrice: 1e-7 });
    store.updateLivePosition(position.id, { openedAt: now, tokenAmountRaw: '1000000000000' });
    store.recordLiveOrder({ positionId: position.id, strategyId: strategy.id, mint: position.mint,
      side: 'BUY', venue: 'PUMP_AMM', status: 'CONFIRMED',
      execution: { entrySlot: 100, pool: 'pool' } });
    return position;
  });
  const manager = new LiveTradingManager({ store, now: () => now, config: {
    ...config.liveTrading, enabled: true, dryRun: true, safetyLock: false,
    privateKey: '', killSwitchFile: null, strategies,
  } });
  try {
    manager.start();
    assert.equal(manager.entryStrategies.size, 0);
    assert.equal(manager.positions.size, 3, 'paused strategies still restore existing holdings');
    for (const strategy of strategies) {
      const decision = manager.onExternalStrategySignal({ strategyId: strategy.id,
        mint: `new-${strategy.id}`, episodeId: `paused-${strategy.id}`, timestampMs: now,
        receivedAtMs: now, chainTimestampMs: now - 100, slot: 100, pool: 'pool',
        market: 'PUMP_AMM', price: 1e-7 });
      assert.equal(decision.action_status ?? decision.actionStatus, 'MATCHED_ENTRY_DISABLED');
    }
    await manager.entryQueue;
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n, 3);
    now += 100;
    for (const position of restored) {
      manager.observeTrade({ mint: position.mint, timestampMs: now, receivedAtMs: now,
        chainTimestampMs: now - 100, slot: 101, market: 'PUMP_AMM', pool: 'pool',
        side: 'SELL', price: 5e-8, reservePrice: 5e-8, solAmount: 1, tokenAmount: 2e7,
        poolBaseReservesRaw: '1000000000000000', poolQuoteReservesRaw: '50000000000',
        virtualQuoteReservesRaw: '0' });
    }
    await Promise.allSettled([...manager.pending]);
    for (const position of restored) {
      const row = store.db.prepare('SELECT status,exit_reason FROM live_positions WHERE id=?').get(position.id);
      assert.equal(row.status, 'CLOSED', `${position.strategyId}: exits must not be paused`);
      assert.match(row.exit_reason, /HARD_STOP/);
    }
    console.log('test-ho500-exit-config-and-live-pause: ok (12 controls, stale toggles locked, no new buys, restored exits)');
  } finally { await manager.stop(); store.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
