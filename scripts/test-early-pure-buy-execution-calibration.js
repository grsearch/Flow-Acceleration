'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { EarlyPureBuyBurstShadowSuite } = require('../src/core/EarlyPureBuyBurstShadowSuite');

const BASE = 1_788_660_000_000;
const VERSION = 'EB_EXEC_POST_TARGET_V1';
const BASELINE = 'EB_A_EXEC_V1';
const FILTERED = 'EB_A_EXEC_V1_RUGX';
const EXIT = 'FIX20_H30_EXEC_V1';

function config() {
  const strict = {
    strictExecution: true, executionVersion: VERSION, newEntriesEnabled: true,
    positionSizeSol: 0.02, entryDelayMs: 1_000, exitDelayMs: 1_000,
    entryTimeoutMs: 15_000, exitTimeoutMs: 15_000, maxQuoteChainAgeMs: 3_000,
    exitProfileIds: [EXIT],
    costModel: { platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0.00001, priorityFeeSol: 0.001, jitoTipSol: 0,
      fixedCostSol: 0 },
  };
  return {
    enabled: true, positionSizeSol: 1, smartWallets: [], maxTradesPerMint: 64,
    featureWindowMs: 3_000, stateRetentionMs: 120_000,
    entryDelayMs: 200, entryTimeoutMs: 2_000, exitDelayMs: 200, exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 15, maxEntryPriceDropPct: 35, maxEntryImpactPct: 15,
    base: { maxAgeMs: 10_000, maxCurvePct: 50, minNetFlow3sSol: 3, maxNetFlow3sSol: 5,
      minBuyers3s: 2, maxBuyers3s: 4, maxSellTx3s: 0 },
    confirmationB: { minDelayMs: 300, maxDelayMs: 500, minDeltaBuyers: 1, minDeltaNetFlowSol: 0.5, maxJumpPct: 10 },
    confirmationC: { minDelayMs: 1_000, maxDelayMs: 3_000, minDrawdownPct: 3, maxDrawdownPct: 8,
      minReclaimPct: 1, maxReclaimPct: 2, maxSingleSellSol: 0.5, maxSellSharePct: 35 },
    costModel: { ...strict.costModel, priorityFeeSol: 0, positionSizeSol: 1 },
    entryProfiles: [
      { id: 'EB_A', newEntriesEnabled: false, exitProfileIds: ['FIX20'] },
      { ...strict, id: BASELINE, liveBridgeEnabled: true,
        liveStrategyId: 'early_pure_buy_burst_eba_fix20_calibration_live' },
      { ...strict, id: FILTERED, pairedBaselineProfileId: BASELINE,
        rugGuardMode: 'LIVE_CURVE_CATASTROPHE' },
    ],
    exitProfiles: [{ id: 'FIX20', maxHoldMs: 20_000 },
      { id: EXIT, strictExecution: true, maxHoldMs: 20_000, hardStopPct: 30 }],
  };
}

function setup(options = {}) {
  let now = BASE;
  let seq = 0;
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000 }, { configuredTradingCostPct: 0 });
  const signals = [];
  const guards = [];
  if (options.guard) store.preEntryRugRisk = {
    config: { enabled: true }, evaluateGuard: (request) => { guards.push(request); return options.guard(request); },
  };
  const settings = options.config || config();
  let suite;
  function restart(newSettings = settings) {
    suite?.stop();
    suite = new EarlyPureBuyBurstShadowSuite({ config: newSettings, store, now: () => now,
      onLiveSignal: (signal) => { signals.push(signal); options.onLiveSignal?.(signal); } });
    suite.start();
    return suite;
  }
  restart();
  function trade(offset, overrides = {}) {
    seq += 1;
    now = BASE + offset;
    const row = {
      mint: 'calibration-mint', symbol: 'CAL', market: 'PUMP_BONDING_CURVE',
      bondingCurve: 'calibration-curve', signature: `sig-${seq}`, eventIndex: 0,
      slot: 100 + seq, wallet: `buyer-${seq}`, side: 'BUY', solAmount: 1.25,
      tokenAmount: 10_000, timestampMs: now, receivedAtMs: now,
      chainTimestampMs: Math.floor(now / 1_000) * 1_000,
      ageMs: 1_000, curvePct: 20, price: 3e-8, reservePrice: 3e-8,
      virtualTokenReservesRaw: '1000000000000000', virtualSolReservesRaw: '30000000000',
      realTokenReservesRaw: '700000000000000', realSolReservesRaw: '10000000000',
      ...overrides,
    };
    const positions = suite.observeTrade(row);
    return { row, positions };
  }
  function source(overrides = {}) {
    trade(-500, overrides); trade(-250, overrides);
    return trade(0, { solAmount: 1.5, ...overrides });
  }
  const rows = () => store.db.prepare('SELECT * FROM early_pure_buy_burst_shadow_positions ORDER BY id').all();
  return { store, settings, signals, guards, trade, source, rows, restart,
    get suite() { return suite; }, setNow(offset) { now = BASE + offset; }, close() { store.close(); } };
}

function testStrictSourceAndCausalFixedExit() {
  const env = setup();
  try {
    const { row: source, positions } = env.source({ price: 2.7e-8 });
    assert.strictEqual(positions.length, 2);
    assert.deepStrictEqual(positions.map((p) => p.positionSol), [0.02, 0.02]);
    assert.strictEqual(env.signals.length, 1, 'bridge fires at source before simulated entry');
    assert.strictEqual(env.signals[0].signature, source.signature);
    assert.strictEqual(env.signals[0].bondingCurve, source.bondingCurve);
    assert.strictEqual(env.signals[0].price, 3e-8, 'live and shadow entry guards share post-reserve reference');
    assert.strictEqual(env.signals[0].features.sourceTradePrice, 2.7e-8, 'retain observed execution price as evidence');
    assert.strictEqual(env.signals[0].features.sourceCohortId, `${BASELINE}:${EXIT}`);
    assert.strictEqual(env.signals[0].features.shadowPositionSol, 0.02);
    assert.strictEqual(env.signals[0].episodeId, `${VERSION}:${source.mint}:${BASE}`);
    assert(env.rows().every((p) => p.status === 'PENDING_ENTRY'));
    assert(env.rows().every((p) => Math.abs(p.configured_cost_pct - 6.05) < 1e-10), '0.02 SOL round-trip fixed fee denominator');
    env.suite.observeTrade(source);
    assert.strictEqual(env.signals.length, 1, 'duplicate source cannot bridge twice');
    env.trade(900, { chainTimestampMs: BASE + 1_000, timestampMs: BASE + 1_000 });
    assert(env.rows().every((p) => p.status === 'PENDING_ENTRY'), 'clock skew cannot execute before the wall target');
    env.trade(1_000, { chainTimestampMs: BASE, signature: source.signature });
    env.trade(1_050, { bondingCurve: 'other-curve' });
    env.trade(1_100, { receivedAtMs: null });
    env.trade(1_150, { chainTimestampMs: BASE - 4_000 });
    assert(env.rows().every((p) => p.status === 'PENDING_ENTRY'), 'unknown/stale/wrong-pool/old-chain must not fill');
    env.trade(2_000);
    assert(env.rows().every((p) => p.status === 'OPEN'));
    const entry = env.rows()[0];
    assert.strictEqual(entry.entry_at, BASE + 2_000);
    assert.strictEqual(entry.last_pool_quote_json, null, 'strict model never populates reusable quote cache');
    env.setNow(22_000); env.suite.advanceTime(BASE + 22_000);
    assert(env.rows().every((p) => p.status === 'EXIT_PENDING'));
    env.trade(23_000, { chainTimestampMs: BASE + 22_000 });
    assert(env.rows().every((p) => p.status === 'EXIT_PENDING'), 'fresh receive with old chain cannot fill');
    env.trade(24_000);
    assert(env.rows().every((p) => p.status === 'CLOSED'));
    for (const row of env.rows()) {
      assert.strictEqual(row.exit_reason, 'FIXED_20000MS');
      assert.strictEqual(row.hold_ms, 22_000);
      assert(Math.abs(row.gross_return_pct - row.net_return_pct - 6.05) < 1e-9);
      assert(Math.abs(row.estimated_cost_sol - 0.00121) < 1e-12);
      const execution = JSON.parse(row.features_json).strictExecution;
      assert(execution.exit.chainTimestampMs >= row.exit_target_at);
      assert(execution.entry.chainTimestampMs >= row.entry_target_at);
      assert.strictEqual(execution.source.signature, source.signature);
      assert(execution.quoteRejections >= 5);
    }
    assert.strictEqual(env.suite.health().cachedReserveExits, 0);
    const dashboard = env.suite.dashboard();
    assert.strictEqual(dashboard.rugComparisons.length, 2);
    assert(dashboard.cohorts.every((c) => c.position_sol === 0.02 && c.executionVersion === VERSION));
  } finally { env.close(); }
}

function testHardStopNeedsLaterExecutableQuote() {
  const env = setup();
  try {
    env.source(); env.trade(1_000);
    env.trade(2_000, { side: 'SELL', virtualSolReservesRaw: '19000000000', price: 1.9e-8 });
    assert(env.rows().every((p) => p.status === 'EXIT_PENDING' && p.exit_reason === 'EXECUTABLE_HARD_STOP'));
    assert(env.rows().every((p) => p.exit_at === null), 'trigger quote must not be its own fill');
    env.trade(3_000, { chainTimestampMs: BASE + 2_000, virtualSolReservesRaw: '19000000000' });
    assert(env.rows().every((p) => p.status === 'EXIT_PENDING'));
    env.trade(4_000, { virtualSolReservesRaw: '17000000000', realSolReservesRaw: '0' });
    assert(env.rows().every((p) => p.status === 'EXIT_PENDING'), 'virtual SOL cannot substitute for real sell liquidity');
    env.trade(5_000, { virtualSolReservesRaw: '17000000000', realSolReservesRaw: '5000000000' });
    assert(env.rows().every((p) => p.status === 'CLOSED' && p.gross_return_pct < -40));
    assert(env.rows().every((p) => p.exit_reason === 'EXECUTABLE_HARD_STOP'));
  } finally { env.close(); }
}

function testNoCacheExitAndFrozenPolicyOnRestart() {
  const env = setup();
  try {
    env.source(); env.trade(1_000);
    const changed = config();
    changed.positionSizeSol = 9;
    changed.entryProfiles = [];
    changed.exitProfiles = [];
    changed.costModel.priorityFeeSol = 0.2;
    env.setNow(21_000); env.restart(changed);
    assert(env.rows().every((p) => p.status === 'EXIT_PENDING' && p.exit_target_at === BASE + 22_000));
    env.setNow(38_000); env.suite.advanceTime(BASE + 38_000);
    assert(env.rows().every((p) => p.status === 'NO_EXIT' && p.net_return_pct === null));
    assert(env.rows().every((p) => p.position_sol === 0.02 && p.exit_at === null));
    env.trade(39_000);
    assert(env.rows().every((p) => p.status === 'NO_EXIT'), 'late quote cannot rewrite a timed-out cohort');
    assert.strictEqual(env.signals.length, 1, 'restart never rebridges old source');
  } finally { env.close(); }
}

function testFrozenCostsAndMalformedRecovery() {
  const env = setup();
  try {
    env.source(); env.trade(1_000);
    const changed = config();
    changed.entryProfiles.forEach((p) => { if (p.costModel) p.costModel.priorityFeeSol = 0.2; });
    changed.exitProfiles.find((p) => p.id === EXIT).maxHoldMs = 60_000;
    env.setNow(21_000); env.restart(changed);
    env.trade(22_000);
    assert(env.rows().every((p) => p.status === 'CLOSED' && p.exit_reason === 'FIXED_20000MS'));
    assert(env.rows().every((p) => Math.abs(p.gross_return_pct - p.net_return_pct - 6.05) < 1e-9));
  } finally { env.close(); }
  const broken = setup();
  try {
    broken.source(); broken.trade(1_000);
    broken.store.db.prepare("UPDATE early_pure_buy_burst_shadow_positions SET features_json='{}'").run();
    broken.setNow(2_000); broken.restart();
    assert(broken.rows().every((p) => p.status === 'NO_EXIT' && p.net_return_pct === null
      && p.rejection_reason === 'STRICT_EXECUTION_METADATA_INVALID'));
  } finally { broken.close(); }
}

function testPoolAndMigrationCannotProvideExit() {
  const env = setup();
  try {
    env.source(); env.trade(1_000);
    env.setNow(21_000); env.suite.advanceTime(BASE + 21_000);
    env.trade(22_000, { market: 'PUMP_AMM', pool: 'migration-amm', ammQuoteState: 'POST_TRADE_V1' });
    env.trade(23_000, { bondingCurve: 'other-curve' });
    env.trade(24_000, { complete: true });
    assert(env.rows().every((p) => p.status === 'EXIT_PENDING' && p.net_return_pct === null));
    env.setNow(38_000); env.suite.advanceTime(BASE + 38_000);
    assert(env.rows().every((p) => p.status === 'NO_EXIT'));
  } finally { env.close(); }
}

function testRugPairAndCallbackFailureIsolation() {
  const env = setup({ onLiveSignal() { throw new Error('injected callback'); }, guard(request) {
    assert.strictEqual(request.lifecycleStage, 'CURVE_EARLY');
    if (request.enforcementMode === 'HARD_BLOCK') {
      assert.deepStrictEqual(request.hardBlockSignatures, ['crossMintToxicWallets', 'crossMintToxicTemplate']);
      return { blocked: true, reason: 'RUG_GUARD:crossMintToxicWallets' };
    }
    return { blocked: true, reason: 'wide observation must not enforce baseline' };
  } });
  try {
    env.source(); env.trade(1_000);
    const rows = env.rows();
    assert.strictEqual(rows.find((r) => r.entry_profile_id === BASELINE).status, 'OPEN');
    assert.strictEqual(rows.find((r) => r.entry_profile_id === FILTERED).status, 'NO_ENTRY');
    assert.strictEqual(rows[0].signal_at, rows[1].signal_at);
    assert.strictEqual(rows[0].entry_target_at, rows[1].entry_target_at);
    assert.strictEqual(env.suite.health().liveSignalErrors, 1);
    assert(env.guards.some((g) => g.enforcementMode === 'LABEL_ONLY'));
  } finally { env.close(); }
}

function testMissingSourceNeverBridgesAndLegacyIndependent() {
  for (const bad of [{ receivedAtMs: null }, { chainTimestampMs: null }, { bondingCurve: null },
    { signature: null }, { realTokenReservesRaw: null }, { realSolReservesRaw: '-1' },
    { virtualSolReservesRaw: '1000000000' }, { eventIndex: -1 }, { slot: null },
    { ageMs: null }, { ageMs: undefined }, { ageMs: NaN }, { curvePct: null },
    { curvePct: '' }, { curvePct: undefined }]) {
    const env = setup();
    try {
      env.source(bad);
      assert.strictEqual(env.rows().length, 0);
      assert.strictEqual(env.signals.length, 0);
      assert(env.suite.health().strictSourceRejected > 0);
    } finally { env.close(); }
  }
  const unknownSell = setup();
  try {
    unknownSell.trade(-750, { side: 'SELL', solAmount: 0.1, ageMs: null, curvePct: null });
    unknownSell.source();
    assert.strictEqual(unknownSell.rows().length, 0, 'missing lifecycle cannot erase a valid sell from the feature window');
    assert.strictEqual(unknownSell.signals.length, 0);
  } finally { unknownSell.close(); }
  const settings = config();
  settings.entryProfiles.find((p) => p.id === 'EB_A').newEntriesEnabled = true;
  const env = setup({ config: settings });
  try {
    env.suite.seenMints.add('calibration-mint');
    env.source();
    assert.strictEqual(env.rows().length, 2, 'legacy seen set does not suppress new execution cohort');
    const before = env.rows().map((r) => r.features_json);
    env.restart();
    env.trade(100, { ageMs: 1000 });
    assert.strictEqual(env.signals.length, 1);
    assert.deepStrictEqual(env.rows().map((r) => r.features_json), before);
  } finally { env.close(); }
}

testStrictSourceAndCausalFixedExit();
testHardStopNeedsLaterExecutableQuote();
testNoCacheExitAndFrozenPolicyOnRestart();
testFrozenCostsAndMalformedRecovery();
testPoolAndMigrationCannotProvideExit();
testRugPairAndCallbackFailureIsolation();
testMissingSourceNeverBridgesAndLegacyIndependent();
console.log('Early pure-buy strict execution calibration tests passed.');
