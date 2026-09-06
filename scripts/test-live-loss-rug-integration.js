'use strict';

const assert = require('node:assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { config } = require('../src/config');
const { LEGACY_LIVE_ID, LEGACY_RUGX, LEGACY_VERSION } = require('../src/core/ResearchCalibrationPolicy');

async function main() {
  const T = 1_940_000_000_000;
  let now = T;
  const mint = 'loss-feedback-integration';
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', flushMs: 60_000,
    flushMax: 100 }, { configuredTradingCostPct: 0 });
  const tracker = new PreEntryRugRiskTracker({ config: { ...config.preEntryRugRisk,
    enabled: true, toxicCollapsePct: 60, toxicMemoryPath: null }, store, now: () => now });
  store.recordCreate({ mint, symbol: mint, name: null, uri: null, bondingCurve: null,
    creator: null, createdAt: T - 1000, initialRealTokenReservesRaw: '1000000000000000',
    tokenTotalSupplyRaw: '1000000000000000' });
  store.recordMigration({ mint, migratedAt: T, timestampMs: T, pool: 'loss-pool' });
  let buys = 0, sells = 0;
  // Explicit in-memory fakes: no wallet key, RPC, network or real signatures.
  const executor = {
    async buyAmm(args) {
      buys += 1;
      return { signature: 'offline-integration-buy', venue: 'PUMP_AMM',
        tokenAmountRaw: String(Math.round(args.solAmount / args.referencePrice * 1e6)),
        expectedPrice: args.referencePrice,
        execution: { entrySlot: 200, pool: 'loss-pool',
          settlement: { walletSolDelta: -0.0202, networkFeeSol: 0.0001, transactionSlot: 200 } } };
    },
    async sell(args) {
      sells += 1;
      assert.equal(args.emergency, true);
      return { signature: 'offline-integration-sell', venue: 'PUMP_AMM',
        tokenAmountRaw: args.tokenAmountRaw, balanceVerified: true,
        settlement: { walletSolDelta: 0.008, networkFeeSol: 0.0001, transactionSlot: 202 } };
    },
  };
  const manager = new LiveTradingManager({ config: { ...config.liveTrading, enabled: true,
    requestedEnabled: true, dryRun: false, safetyLock: false, killSwitchFile: null,
    strategies: config.liveTrading.strategies.filter(row => row.id === LEGACY_LIVE_ID),
    lossRugFeedback: { ...config.liveTrading.lossRugFeedback, enabled: true } },
    store, executor, now: () => now });
  assert.equal(manager.lossRugFeedback.health().status, 'DEGRADED');
  assert.equal(manager.lossRugFeedback.health().trackerBound, false);
  // Regression: the manager already exists, exactly like the broken runtime.
  // Late binding must work for capture, analysis, learning and evidence release.
  store.preEntryRugRisk = tracker;
  assert.equal(manager.lossRugFeedback.health().ready, true);
  let b = 1_000_000_000_000_000n, q = 400_000_000_000n, seq = 0;
  const emit = (offset, side, amount, { target = mint, slot = ++seq + 100, reset = false } = {}) => {
    if (reset) { b = 1_000_000_000_000_000n; q = 400_000_000_000n; }
    now = T + offset;
    const preB = b, preQ = q, k = b * q;
    q = side === 'SELL' ? q * 65n / 100n : q + BigInt(Math.round(amount * 1e9));
    b = k / q;
    const price = Number(q) / Number(b) / 1000;
    const trade = { mint: target, pool: target === mint ? 'loss-pool' : 'copy-pool', market: 'PUMP_AMM',
      timestampMs: now, receivedAtMs: now, chainTimestampMs: now, slot,
      signature: `offline-trade-${target}-${offset}`, eventIndex: 0, wallet: `actor-${target}-${offset}`,
      side, solAmount: amount, tokenAmount: amount / price, price, reservePrice: price,
      ammQuoteState: 'POST_TRADE_V1', virtualQuoteReservesRaw: '0',
      prePoolBaseReservesRaw: String(preB), prePoolQuoteReservesRaw: String(preQ),
      poolBaseReservesRaw: String(b), poolQuoteReservesRaw: String(q) };
    tracker.observeTrade(trade);
    if (target === mint) manager.observeTrade(trade);
    return trade;
  };
  try {
    manager.start();
    emit(0, 'BUY', 0.01);
    let source;
    for (const at of [15100, 15200, 15300, 15400]) source = emit(at, 'BUY', 10);
    manager.onExternalStrategySignal({ ...source, strategyId: LEGACY_LIVE_ID,
      episodeId: `offline-source:${LEGACY_VERSION}`, lifecycleStage: 'AMM_MATURE', lifecycleAgeMs: 15400,
      features: { sourceCohortId: LEGACY_RUGX, calibrationVersion: LEGACY_VERSION,
        shadowPositionSol: 0.02, ageMs: 15400 } });
    await manager.entryQueue;
    await Promise.allSettled([...manager.pending]);
    assert.equal(buys, 1);
    const position = [...manager.positions.values()][0];
    assert(position);
    await manager.lossRugFeedback.flush({ force: true });
    const frozen = store.getLiveLossRugCase(position.id).entryEvidence;
    assert(frozen?.tracker?.template);
    emit(16000, 'SELL', 120, { slot: 201 });
    emit(16200, 'BUY', 0.01, { slot: 203 });
    await Promise.allSettled([...manager.pending]);
    assert.equal(sells, 1);
    assert.equal(store.db.prepare('SELECT status FROM live_positions WHERE id=?').get(position.id).status, 'CLOSED');
    assert.equal(tracker.metrics.toxicCollapsesLabeled, 0,
      '57.75% cliff is below the original 60% automatic learner threshold');
    await manager.lossRugFeedback.flush({ force: true });
    now += 6000;
    await manager.lossRugFeedback.flush({ force: true });
    const row = store.getLiveLossRugCase(position.id);
    assert.equal(row.status, 'FINAL', JSON.stringify(row));
    assert.equal(row.classification, 'CONFIRMED_RUG', JSON.stringify(row.attribution));
    assert(row.realizedReturnPct < -50);
    assert.equal(row.learning.status, 'LEARNED');
    assert.equal(row.learning.walletsAdded, 0);
    assert.deepEqual(row.entryEvidence, frozen, 'original entry evidence remains immutable');
    assert.equal(tracker.toxicTemplates.size, 1);
    assert.equal(tracker.toxicWallets.size, 0, 'a losing trade does not blacklist all participants');
    const count = store.db.prepare('SELECT count(*) n FROM pre_entry_rug_toxic_history').get().n;
    manager._refreshPositionSettlement(position.id);
    await manager.lossRugFeedback.flush({ force: true });
    assert.equal(store.db.prepare('SELECT count(*) n FROM pre_entry_rug_toxic_history').get().n, count);
    emit(30000, 'BUY', 0.01, { target: 'copy', reset: true });
    for (const at of [45100, 45200, 45300, 45400]) emit(at, 'BUY', 10, { target: 'copy' });
    const guard = tracker.evaluateGuard({ strategyId: LEGACY_LIVE_ID, mint: 'copy', timestampMs: now,
      source: 'LIVE', market: 'PUMP_AMM', lifecycleStage: 'AMM_MATURE', enforcementMode: 'HARD_BLOCK',
      hardBlockSignatures: ['crossMintToxicWallets', 'crossMintToxicTemplate'] });
    assert.equal(guard.blocked, true, 'new high-confidence copy is blocked without a restart');
    assert.equal(guard.reason, 'PRE_ENTRY_RUG_CROSS_MINT_TOXIC');
    assert.equal(buys, 1); assert.equal(sells, 1);
  } finally { await manager.stop(); store.close(); }
  console.log('test-live-loss-rug-integration: real tracker + store + manager feedback + future filter passed');
}

async function runtimeStartupBinding() {
  const { createRuntime } = require('../src/index');
  const runtimeConfig = { ...config,
    storage: { ...config.storage, dbPath: ':memory:', startupReplayCacheMs: 0 },
    liveTrading: { ...config.liveTrading, enabled: false, dryRun: true },
    server: { ...config.server, host: '127.0.0.1', port: 0 },
    migrationSecondLegShadow: { ...config.migrationSecondLegShadow, solUsdReference: { enabled: false } },
  };
  for (const [key, value] of Object.entries(runtimeConfig)) {
    if (/Shadow|Registry|Observer|Audit|Overlay/.test(key) && value && typeof value === 'object') {
      runtimeConfig[key] = { ...value, enabled: false };
    }
  }
  runtimeConfig.preEntryRugRisk = { ...config.preEntryRugRisk, enabled: true,
    toxicMemoryPath: null, crossMintEnabled: false, firstCliffCounterfactualEnabled: false };
  const startedTrackers = new WeakSet();
  const trackerStart = PreEntryRugRiskTracker.prototype.start;
  const managerStart = LiveTradingManager.prototype.start;
  const log = console.log;
  let assertions = 0, app;
  PreEntryRugRiskTracker.prototype.start = function (...args) {
    const result = trackerStart.apply(this, args);
    startedTrackers.add(this); return result;
  };
  LiveTradingManager.prototype.start = function (...args) {
    assert(this.store.preEntryRugRisk instanceof PreEntryRugRiskTracker,
      'real createRuntime must bind the collector before live state restoration');
    assert(startedTrackers.has(this.store.preEntryRugRisk), 'collector must be started first');
    assert.equal(this.lossRugFeedback.tracker, this.store.preEntryRugRisk,
      'constructor injection itself must already be valid, not only the late-binding fallback');
    assertions += 1; return managerStart.apply(this, args);
  };
  console.log = () => {};
  try {
    // Constructor/restoration only: no start(), sockets, wallet, signing or RPC.
    app = createRuntime(runtimeConfig);
    assert.equal(assertions, 1);
    assert.equal(app.trader.lossRugFeedback.health().status, 'DISABLED', 'dry run remains disabled');
  } finally {
    PreEntryRugRiskTracker.prototype.start = trackerStart;
    LiveTradingManager.prototype.start = managerStart;
    if (app) await app.stop('offline-loss-feedback-startup-test');
    console.log = log;
  }
  console.log('test-live-loss-rug-integration: actual createRuntime binds and starts tracker before manager');
}
(async () => { await runtimeStartupBinding(); await main(); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
