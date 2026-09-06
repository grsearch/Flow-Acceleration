'use strict';
const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { config } = require('../src/config');
const { CALIBRATION_ID, EB_VERSION, EB_SOURCE } = require('../src/core/ResearchCalibrationPolicy');

async function main() {
  let now = 1_788_660_000_000;
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100 }, { configuredTradingCostPct: 0 });
  // Explicit fixture override tests retired positions/source compatibility, not
  // deployment authorization (the default CAL02 config must stay disabled).
  const strategy = { ...config.liveTrading.strategies.find((p) => p.id === CALIBRATION_ID), entryEnabled: true };
  store.preEntryRugRisk = { config: { enabled: true },
    evaluateGuard: () => ({ enabled: true, blocked: false, sampleReady: false }) };
  const manager = new LiveTradingManager({
    config: { ...config.liveTrading, enabled: true, requestedEnabled: true, safetyLock: false,
      dryRun: true, strategies: [strategy], killSwitchFile: null }, store,
    executor: { buy() { throw new Error('TEST MUST NEVER SIGN OR CALL RPC'); } }, now: () => now,
  });
  manager.start();
  const signal = (mint) => ({ strategyId: CALIBRATION_ID, episodeId: `${EB_VERSION}:${mint}:${now}`,
    timestampMs: now, receivedAtMs: now, chainTimestampMs: now, mint,
    slot: 100, eventIndex: 0, signature: `sig-${mint}`, bondingCurve: `curve-${mint}`,
    market: 'PUMP_BONDING_CURVE', price: 3e-8, reservePrice: 3e-8,
    virtualTokenReservesRaw: '1000000000000000', virtualSolReservesRaw: '30000000000',
    realTokenReservesRaw: '700000000000000', realSolReservesRaw: '10000000000',
    features: { sourceCohortId: EB_SOURCE, calibrationVersion: EB_VERSION, shadowPositionSol: 0.02 } });
  const settle = async () => { await manager.entryQueue; await Promise.allSettled([...manager.pending]); };
  try {
    assert.strictEqual(manager._riskReason(signal('a')), null);
    assert.strictEqual(manager._riskReason({ ...signal('a'), features: {} }), 'CALIBRATION_SOURCE_MISMATCH');
    assert.strictEqual(manager._riskReason({ ...signal('a'), bondingCurve: null }), 'CALIBRATION_SOURCE_IDENTITY_MISSING');
    for (const override of [{ eventIndex: -1 }, { slot: 1.5 }, { receivedAtMs: now + 5_000 }]) {
      assert.strictEqual(manager._riskReason({ ...signal('a'), ...override }), 'CALIBRATION_SOURCE_IDENTITY_MISSING');
    }
    assert.strictEqual(manager._riskReason({ ...signal('a'), chainTimestampMs: now - 3_001 }), 'STALE_SIGNAL_CHAIN_TIME');
    store.preEntryRugRisk.config.enabled = false;
    manager.onExternalStrategySignal(signal('unguarded'));
    await settle();
    const blocked = store.db.prepare('SELECT * FROM live_strategy_decisions WHERE mint=?').get('unguarded');
    assert.strictEqual(blocked.action_reason, 'CALIBRATION_RUG_GUARD_UNAVAILABLE');
    assert.strictEqual(manager.positions.size, 0);
    store.preEntryRugRisk.config.enabled = true;
    manager.onExternalStrategySignal(signal('a'));
    manager.onExternalStrategySignal(signal('b'));
    manager.onExternalStrategySignal(signal('c'));
    manager.onExternalStrategySignal(signal('d'));
    await settle();
    assert.strictEqual(manager.positions.size, 3, 'OPENING/OPEN must reserve the three slots across queued signals');
    const position = [...manager.positions.values()][0];
    assert([...manager.positions.values()].every((row) => row.positionSol === 0.02));
    const rows = store.db.prepare("SELECT * FROM live_strategy_decisions WHERE mint != 'unguarded' ORDER BY id").all();
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[3].action_reason, 'MAX_POSITIONS');
    // Strategy-total cap still protects the policy if a caller supplies a
    // looser global manager cap; the configured deployment itself caps at 3.
    manager.config.maxConcurrentPositions = 10;
    assert.strictEqual(manager._riskReason(signal('e')), 'STRATEGY_MAX_TOTAL_POSITIONS');
    manager.config.maxConcurrentPositions = 3;
    const features = JSON.parse(rows[0].features_json);
    assert.strictEqual(features.sourceCohortId, EB_SOURCE);
    assert.strictEqual(features.signalTiming.bondingCurve, 'curve-a');
    position.status = 'EXIT_FAILED';
    assert.strictEqual(manager._riskReason(signal('e')), 'CALIBRATION_UNRESOLVED_EXECUTION');
    assert.strictEqual(manager.health({ includeDatabase: false }).strategies[0].calibrationSafety.blocked, true);
    position.status = 'OPEN';
    assert.strictEqual(manager.health({ includeDatabase: false }).strategies[0].calibrationSafety.blocked, false);
    // A stop request is independent of entry permission and does not require
    // incoming quotes at the maximum holding deadline.
    let requested = null;
    const requestExit = manager._requestExit;
    manager._requestExit = (_p, reason) => { requested = reason; };
    manager._evaluatePositionExit(position, now + 1_000, position.entryPrice * 0.69);
    assert.strictEqual(requested, 'HARD_STOP');
    requested = null;
    strategy.entryEnabled = false;
    now = position.openedAt + 20_001;
    manager._scheduleMaxHold(position);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(requested, 'FIXED_HOLD_20000MS');
    manager._requestExit = requestExit;
  } finally {
    await manager.stop();
    store.close();
  }
  console.log('test-eba-calibration-live: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
