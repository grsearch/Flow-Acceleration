'use strict';
const assert = require('assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { MigrationSecondLegShadowSuite } = require('../src/core/MigrationSecondLegShadowSuite');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');
const { config } = require('../src/config');
const { LEGACY_LIVE_ID, LEGACY_RUGX, LEGACY_VERSION, CALIBRATION_ID } = require('../src/core/ResearchCalibrationPolicy');

async function main() {
  let now = 1_788_660_000_000;
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100 }, { configuredTradingCostPct: 0 });
  const strategy = { ...config.liveTrading.strategies.find((p) => p.id === LEGACY_LIVE_ID) };
  const old = config.liveTrading.strategies.find((p) => p.id === CALIBRATION_ID);
  let reject = false, throws = false, malformed = false;
  const guards = [];
  store.preEntryRugRisk = { config: { enabled: true }, evaluateGuard(request) {
    guards.push(request);
    if (throws) throw new Error('guard failed');
    if (malformed) return { enabled: true };
    return { enabled: true, blocked: reject, reason: reject ? 'TOXIC_WALLET' : null,
      lifecycleStage: 'AMM_EARLY', lifecycleAgeMs: 20_000,
      firstCliffCounterfactual: { lifecycleAgeMs: 10_000 } };
  } };
  const manager = new LiveTradingManager({
    config: { ...config.liveTrading, enabled: true, requestedEnabled: true, safetyLock: false,
      dryRun: true, strategies: [strategy, old], killSwitchFile: null }, store,
    executor: { buy() { throw new Error('TEST MUST NEVER SIGN OR CALL RPC'); } }, now: () => now,
  });
  const event = (mint, overrides = {}) => ({
    mint, market: 'PUMP_AMM', pool: `pool-${mint}`, strategyId: LEGACY_LIVE_ID,
    episodeId: `${mint}:${LEGACY_VERSION}`, timestampMs: now, receivedAtMs: now,
    chainTimestampMs: now, slot: 100, signature: `sig-${mint}`, eventIndex: 0,
    price: 4e-7, reservePrice: 4e-7, ammQuoteState: 'POST_TRADE_V1',
    poolBaseReservesRaw: '100000000000000', poolQuoteReservesRaw: '40000000000',
    virtualQuoteReservesRaw: '0', lifecycleStage: 'AMM_MATURE', lifecycleAgeMs: 20_000,
    features: { sourceCohortId: LEGACY_RUGX, calibrationVersion: LEGACY_VERSION,
      shadowPositionSol: 0.02 }, ...overrides,
  });
  const settle = async () => { await manager.entryQueue; await Promise.allSettled([...manager.pending]); };
  const decision = (mint) => store.db.prepare('SELECT * FROM live_strategy_decisions WHERE mint=?').get(mint);
  try {
    manager.start();
    assert.equal(manager._riskReason(event('valid')), null);
    assert.equal(manager._riskReason(event('old', { strategyId: CALIBRATION_ID })), 'STRATEGY_ENTRY_DISABLED');
    for (const patch of [{ pool: null }, { slot: 0 }, { eventIndex: -1 },
      { chainTimestampMs: now + 1 }, { receivedAtMs: now + 1 }]) {
      assert.equal(manager._riskReason(event('invalid', patch)), 'CALIBRATION_SOURCE_IDENTITY_MISSING');
    }
    assert.equal(manager._riskReason(event('missingpost', { ammQuoteState: null })), 'CALIBRATION_POST_TRADE_QUOTE_REQUIRED');
    assert.equal(manager._riskReason(event('wrongcohort', { features: { sourceCohortId: 'LEGACY-EARLY-FLOW-BASE' } })), 'CALIBRATION_SOURCE_MISMATCH');
    store.preEntryRugRisk.config.enabled = false;
    manager.onExternalStrategySignal(event('unguarded')); await settle();
    assert.equal(decision('unguarded').action_reason, 'CALIBRATION_RUG_GUARD_UNAVAILABLE');
    store.preEntryRugRisk.config.enabled = true;
    throws = true;
    manager.onExternalStrategySignal(event('guarderror')); await settle();
    assert.equal(decision('guarderror').action_reason, 'CALIBRATION_RUG_GUARD_UNAVAILABLE');
    throws = false; malformed = true;
    manager.onExternalStrategySignal(event('malformed')); await settle();
    assert.equal(decision('malformed').action_reason, 'CALIBRATION_RUG_GUARD_UNAVAILABLE');
    malformed = false;
    const whitelist = strategy.hardBlockSignatures;
    strategy.hardBlockSignatures = [];
    manager.onExternalStrategySignal(event('emptyfilter')); await settle();
    assert.equal(decision('emptyfilter').action_reason, 'CALIBRATION_RUG_GUARD_UNAVAILABLE');
    strategy.hardBlockSignatures = whitelist; reject = true;
    manager.onExternalStrategySignal(event('rug')); await settle();
    assert.equal(decision('rug').action_reason, 'TOXIC_WALLET');
    const rugAudit = JSON.parse(decision('rug').features_json).preEntryRugRisk;
    assert.equal(rugAudit.lifecycleStage, 'AMM_EARLY');
    assert.equal(rugAudit.lifecycleAgeMs, 10_000, 'record the actual learner clock, not caller age');
    assert.equal(rugAudit.requestedLifecycleStage, 'AMM_MATURE');
    assert.equal(rugAudit.requestedLifecycleAgeMs, 20_000);
    assert.equal(rugAudit.lifecycleClockMismatch, true);
    const stubTracker = store.preEntryRugRisk;
    const realTracker = new PreEntryRugRiskTracker({ now: () => now, config: {
      enabled: true, windowMs: 15_000, stateRetentionMs: 60_000, maxEventsPerMint: 256,
      cacheMaxAgeMs: 1_000, minTrades: 10, minFlags: 5,
      firstCliffLifecycleEnabled: true, firstCliffAmmEarlyMaxAgeMs: 10_000,
      crossMintEnabled: true, templateMinLargeBuys: 4, templateMaxLargeBuys: 6,
      templateLargeBuyMinSol: 1, templateMinTotalBuySol: 40, templateMaxBurstSpanMs: 500,
    } });
    const fingerprint = realTracker._templateFingerprint([10, 10, 10, 10], 30, 'AMM_EARLY', 'PUMP_AMM');
    realTracker._ingestToxicMemory({ templates: [{ fingerprint, lifecycleStage: 'AMM_EARLY',
      market: 'PUMP_AMM', labeledAt: now - 20_000, expiresAt: now + 100_000,
      amounts: [10, 10, 10, 10], largeBuyCount: 4, burstSpanMs: 30 }] }, now);
    store.preEntryRugRisk = realTracker;
    for (const [offset, amount, wallet] of [[-10_000, 0.1, 'first'],
      [-30, 10, 'toxic-a'], [-20, 10, 'toxic-b'], [-10, 10, 'toxic-c'], [0, 10, 'toxic-d']]) {
      realTracker.observeTrade({ ...event('real-toxic'), timestampMs: now + offset,
        chainTimestampMs: now + offset, receivedAtMs: now + offset,
        signature: `real-toxic-${offset}`, side: 'BUY', solAmount: amount,
        tokenAmount: amount / 4e-7, wallet });
    }
    manager.onExternalStrategySignal(event('real-toxic')); await settle();
    assert.equal(decision('real-toxic').action_reason, 'PRE_ENTRY_RUG_CROSS_MINT_TOXIC',
      'real tracker result without enabled must retain its actual rejection reason');
    assert.equal(JSON.parse(decision('real-toxic').features_json).preEntryRugRisk.blocked, true);
    store.preEntryRugRisk = stubTracker;
    reject = false;
    for (const mint of ['a', 'a', 'b', 'c', 'd']) manager.onExternalStrategySignal(event(mint));
    await settle();
    assert.equal(manager.positions.size, 3);
    assert.equal(decision('d').action_reason, 'MAX_POSITIONS');
    assert.equal(store.db.prepare("SELECT count(*) n FROM live_positions WHERE mint='a'").get().n, 1);
    assert([...manager.positions.values()].every((p) => p.positionSol === 0.02));
    assert(guards.every((g) => g.enforcementMode === 'HARD_BLOCK' && g.lifecycleStage === 'AMM_MATURE'));
    assert.deepEqual(guards[0].hardBlockSignatures, ['crossMintToxicWallets', 'crossMintToxicTemplate']);
    const position = [...manager.positions.values()][0];
    const requests = [];
    manager._requestExit = (_p, reason) => requests.push(reason);
    manager._evaluatePositionExit(position, now + 1000, position.entryPrice * 0.69);
    assert(requests.at(-1)?.includes('STOP'), 'hard stop remains active');
    position.highestPrice = position.entryPrice * 1.2;
    manager._evaluatePositionExit(position, now + 2000, position.highestPrice * 0.94);
    assert.equal(requests.at(-1), 'TRAILING_STOP');
    strategy.entryEnabled = false;
    now = position.openedAt + 1_800_001;
    manager._scheduleMaxHold(position);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.at(-1), 'MAX_HOLD', 'entry pause never pauses existing exits');
  } finally { await manager.stop(); store.close(); }
  console.log('test-legacy-early-flow-live: ok');
}
async function sourceBridgeIntegration() {
  const t = 1_788_660_000_000;
  let now = t;
  const mint = 'integrated-legacy-source';
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.',
    flushMs: 60_000, flushMax: 100 }, { configuredTradingCostPct: 0 });
  store.preEntryRugRisk = new PreEntryRugRiskTracker({ now: () => now, config: {
    ...config.preEntryRugRisk, enabled: true,
  } });
  store.recordCreate({ mint, symbol: mint, name: null, uri: null, bondingCurve: null,
    creator: null, createdAt: t - 10_000,
    tokenTotalSupplyRaw: '1000000000000000', initialRealTokenReservesRaw: '1000000000000000' });
  store.recordMigration({ mint, migratedAt: t, timestampMs: t, pool: `${mint}-pool` });
  const manager = new LiveTradingManager({ config: { ...config.liveTrading,
    enabled: true, requestedEnabled: true, safetyLock: false, dryRun: true, killSwitchFile: null },
    store, now: () => now, executor: new Proxy({}, { get() {
      throw new Error('INTEGRATION TEST MUST NOT ACCESS AN EXECUTOR');
    } }) });
  const shadowConfig = { ...config.migrationSecondLegShadow,
    cohorts: config.migrationSecondLegShadow.cohorts.filter(row => row.entryMode === 'LEGACY_EARLY_FLOW') };
  let bridgeCalls = 0;
  const createSuite = () => new MigrationSecondLegShadowSuite({ config: shadowConfig, store,
    now: () => now, getSolUsdReference: () => ({ priceUsd: 100, observedAt: t,
      expiresAt: t + 300_000, source: 'OFFLINE_TEST' }),
    onLiveSignal(event) { bridgeCalls += 1; manager.onExternalStrategySignal(event); } });
  let suite = createSuite();
  const emit = offset => {
    now = t + offset;
    const trade = { mint, market: 'PUMP_AMM', pool: `${mint}-pool`,
      timestampMs: now, receivedAtMs: now, chainTimestampMs: now,
      slot: offset + 100_000, signature: `integrated-${offset}`, eventIndex: 0,
      ammQuoteState: 'POST_TRADE_V1', poolBaseReservesRaw: '1000000000000000',
      poolQuoteReservesRaw: '400000000000', virtualQuoteReservesRaw: '0',
      price: 4e-7, reservePrice: 4e-7, side: 'BUY', solAmount: 0.1,
      tokenAmount: 250_000, wallet: `buyer-${offset % 3}` };
    store.preEntryRugRisk.observeTrade(trade);
    suite.observeTrade(trade);
  };
  try {
    manager.start(); suite.start(); suite.observeGraduation(store.getToken(mint));
    for (let at = 5000; at <= 15000; at += 1000) emit(at);
    await manager.entryQueue;
    await Promise.allSettled([...manager.pending]);
    assert.equal(bridgeCalls, 1);
    assert.equal(suite.positions.size, 0, 'live bridge must not wait for a simulated fill');
    assert.equal(manager.positions.size, 1, 'actual source payload passes live identity and RUG gates');
    const position = store.db.prepare('SELECT * FROM live_positions').get();
    assert.equal(position.strategy_id, LEGACY_LIVE_ID);
    assert.equal(position.position_sol, 0.02);
    assert.equal(position.status, 'OPEN');
    emit(16000);
    assert.equal(suite.positions.size, 2, 'both actual configured arms fill the later causal quote');
    suite.stop(); now = t + 17000; suite = createSuite(); suite.start();
    for (let at = 18000; at <= 22000; at += 1000) emit(at);
    await manager.entryQueue;
    assert.equal(bridgeCalls, 1, 'restart plus a second qualifying window cannot rebroadcast the episode');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 1);
  } finally { suite.stop(); await manager.stop(); store.close(); }
  console.log('test-legacy-early-flow-source-to-live: ok');
}
main().then(sourceBridgeIntegration).catch((error) => { console.error(error); process.exitCode = 1; });
