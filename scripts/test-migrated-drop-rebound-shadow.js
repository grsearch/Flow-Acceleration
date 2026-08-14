'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { MigratedDropReboundShadowSuite } = require(
  '../src/core/MigratedDropReboundShadowSuite'
);

function trade(mint, timestampMs, price, market = 'PUMP_AMM') {
  return {
    mint,
    timestampMs,
    receivedAtMs: timestampMs,
    market,
    side: 'BUY',
    solAmount: 1,
    tokenAmount: 1 / price,
    price,
    reservePrice: price,
    signature: `${mint}:${timestampMs}:${price}`,
  };
}

function recordCreate(store, mint, createdAt) {
  store.recordCreate({
    mint,
    symbol: mint.slice(0, 8),
    name: null,
    uri: null,
    bondingCurve: null,
    creator: null,
    createdAt,
    initialRealTokenReservesRaw: null,
    tokenTotalSupplyRaw: null,
  });
}

function run() {
  const base = 1_800_000_000_000;
  let now = base;
  const store = new ResearchStore({
    dbPath: ':memory:',
    rawRetentionHours: 168,
    archiveDir: './data/archive',
    flushMs: 60_000,
    flushMax: 1_000,
  }, {
    configuredTradingCostPct: 0,
  });
  const config = {
    enabled: true,
    lifecycleStages: [
      { id: 'PRE_MIGRATION', label: '毕业前', market: 'PUMP_BONDING_CURVE' },
      { id: 'POST_MIGRATION', label: '毕业后', market: 'PUMP_AMM' },
    ],
    stateRetentionMs: 60_000,
    trackingAgeMs: 300_000,
    positionSizeSol: 0.05,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 15,
    ammPriceContinuity: {
      minRatio: 0.2,
      maxRatio: 5,
      resetAfterMs: 15_000,
      confirmationTrades: 2,
      confirmationWindowMs: 2_000,
      confirmationTolerancePct: 20,
    },
    entryProfiles: [{
      id: 'G0',
      label: 'baseline',
      windowMs: 1_000,
      dropMinPct: 15,
      dropMaxPct: 35,
      reboundMinPct: 2,
      reboundMaxPct: 5,
      reboundTimeoutMs: 1_000,
    }],
    exitProfiles: [
      { id: 'X3', label: '3s', exitMode: 'FIXED_HOLD', fixedHoldMs: 3_000 },
      {
        id: 'XLEG',
        label: 'legacy',
        exitMode: 'LEGACY',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
        maxHoldMs: 15_000,
      },
    ],
    costModel: {
      platformFeePct: 1,
      buySlippagePct: 0,
      sellSlippagePct: 0,
      priceImpactPct: 0,
      baseTxFeeSol: 0,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      fixedCostSol: 0,
      positionSizeSol: 0.05,
      entryFailureRatePct: 0,
      entryFailureCostPct: 0,
    },
  };
  // Production may intentionally enable only POST_MIGRATION research. Curve
  // trades must then be ignored instead of aborting the shared trade pipeline.
  const postOnlySuite = new MigratedDropReboundShadowSuite({
    config: {
      ...config,
      lifecycleStages: config.lifecycleStages.filter((stage) => stage.id === 'POST_MIGRATION'),
    },
    store,
    now: () => now,
  });
  const disabledStageMint = 'DisabledPreMigration111111111111111111111111';
  recordCreate(store, disabledStageMint, base - 5_000);
  assert.doesNotThrow(() => {
    postOnlySuite.observeTrade(trade(
      disabledStageMint,
      base + 1,
      1,
      'PUMP_BONDING_CURVE',
    ));
    postOnlySuite.observeTrade(trade(
      disabledStageMint,
      base + 101,
      0.7,
      'PUMP_BONDING_CURVE',
    ));
    postOnlySuite.observeTrade(trade(
      disabledStageMint,
      base + 201,
      0.72,
      'PUMP_BONDING_CURVE',
    ));
  });
  assert.strictEqual(postOnlySuite.health().signals, 0);

  let suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();

  // PRE_MIGRATION: curve trades create their own signal and cohort rows.
  const preMint = 'PreMigrationRebound111111111111111111111111';
  recordCreate(store, preMint, base - 5_000);
  suite.observeTrade(trade(preMint, base + 10, 1, 'PUMP_BONDING_CURVE'));
  suite.observeTrade(trade(preMint, base + 110, 0.8, 'PUMP_BONDING_CURVE'));
  suite.observeTrade(trade(preMint, base + 310, 0.82, 'PUMP_BONDING_CURVE'));
  assert.strictEqual(suite.health().signals, 1);
  assert.strictEqual(suite.health().pendingEntries, 2);

  suite.observeTrade(trade(preMint, base + 550, 0.83, 'PUMP_BONDING_CURVE'));
  assert.strictEqual(suite.health().opened, 2);
  assert.strictEqual(suite.health().activePositions, 2);
  let rows = store.migratedDropReboundShadowDashboard({ positionLimit: 20 }).positions;
  assert(rows.every((row) => row.lifecycle_stage === 'PRE_MIGRATION'));
  assert(rows.every((row) => row.entry_market === 'PUMP_BONDING_CURVE'));
  assert(rows.every((row) => row.cohort_id.startsWith('PRE_')));

  // A position opened before graduation remains observable and may exit on PumpSwap.
  store.recordComplete({ mint: preMint, completedAt: base + 1_000, timestampMs: base + 1_000 });
  suite.onGraduated(store.getToken(preMint));
  suite.stop();
  suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  assert.strictEqual(suite.health().activePositions, 2);
  assert(suite.trackedMints(now).includes(preMint));

  suite.observeTrade(trade(preMint, base + 2_000, 1));
  suite.observeTrade(trade(preMint, base + 2_250, 0.99));
  rows = store.migratedDropReboundShadowDashboard({ positionLimit: 20 }).positions;
  assert.strictEqual(
    rows.find((row) => row.lifecycle_stage === 'PRE_MIGRATION'
      && row.exit_profile_id === 'XLEG').status,
    'CLOSED',
  );
  assert.strictEqual(
    rows.find((row) => row.lifecycle_stage === 'PRE_MIGRATION'
      && row.exit_profile_id === 'X3').status,
    'OPEN',
  );
  suite.observeTrade(trade(preMint, base + 3_000, 0.5, 'PUMP_BONDING_CURVE'));
  rows = store.migratedDropReboundShadowDashboard({ positionLimit: 20 }).positions;
  assert.strictEqual(
    rows.find((row) => row.lifecycle_stage === 'PRE_MIGRATION'
      && row.exit_profile_id === 'X3').lowest_price,
    0.83,
  );
  suite.observeTrade(trade(preMint, base + 4_000, 0.9));

  // POST_MIGRATION: PumpSwap trades use a separate detector and cohort namespace.
  const postMint = 'PostMigrationRebound11111111111111111111111';
  recordCreate(store, postMint, base);
  store.recordComplete({ mint: postMint, completedAt: base + 5_000, timestampMs: base + 5_000 });
  suite.onGraduated(store.getToken(postMint));
  suite.observeTrade(trade(postMint, base + 5_100, 1));
  suite.observeTrade(trade(postMint, base + 5_400, 0.8));
  suite.observeTrade(trade(postMint, base + 5_700, 0.82));
  assert.strictEqual(suite.health().signals, 1);
  assert.strictEqual(suite.health().pendingEntries, 2);
  suite.observeTrade(trade(postMint, base + 5_950, 0.83));
  assert.strictEqual(suite.health().opened, 2);
  suite.observeTrade(trade(postMint, base + 6_000, 0.0001));
  rows = store.migratedDropReboundShadowDashboard({ positionLimit: 20 }).positions;
  assert(rows.filter((row) => row.lifecycle_stage === 'POST_MIGRATION')
    .every((row) => row.last_price === 0.83 && row.lowest_price === 0.83));
  suite.observeTrade(trade(postMint, base + 7_000, 1));
  suite.observeTrade(trade(postMint, base + 7_250, 0.99));
  suite.observeTrade(trade(postMint, base + 9_200, 0.9));

  rows = store.migratedDropReboundShadowDashboard({ positionLimit: 20 }).positions;
  assert(rows.every((row) => row.status === 'CLOSED'));
  assert(rows.every((row) => Number.isFinite(row.net_return_pct)));
  assert.strictEqual(rows.filter((row) => row.lifecycle_stage === 'PRE_MIGRATION').length, 2);
  assert.strictEqual(rows.filter((row) => row.lifecycle_stage === 'POST_MIGRATION').length, 2);
  assert(rows.filter((row) => row.lifecycle_stage === 'POST_MIGRATION')
    .every((row) => row.entry_market === 'PUMP_AMM' && row.cohort_id.startsWith('POST_')));

  // Curve events after graduation do not seed either lifecycle detector.
  const signalsBeforeStrayCurve = suite.health().signals;
  suite.observeTrade(trade(postMint, base + 10_000, 1, 'PUMP_BONDING_CURVE'));
  suite.observeTrade(trade(postMint, base + 10_100, 0.8, 'PUMP_BONDING_CURVE'));
  suite.observeTrade(trade(postMint, base + 10_300, 0.82, 'PUMP_BONDING_CURVE'));
  assert.strictEqual(suite.health().signals, signalsBeforeStrayCurve);

  // A drop beyond the maximum is cancelled and cannot re-arm inside the episode.
  const deepMint = 'DeepDrop1111111111111111111111111111111111';
  recordCreate(store, deepMint, base);
  store.recordComplete({ mint: deepMint, completedAt: base + 12_000, timestampMs: base + 12_000 });
  suite.onGraduated(store.getToken(deepMint));
  suite.observeTrade(trade(deepMint, base + 12_100, 1));
  suite.observeTrade(trade(deepMint, base + 12_150, 0.8));
  suite.observeTrade(trade(deepMint, base + 12_200, 0.64));
  suite.observeTrade(trade(deepMint, base + 12_400, 0.66));
  assert.strictEqual(suite.health().signals, signalsBeforeStrayCurve);
  assert(suite.health().dropExceededMax >= 1);

  // A single malformed PumpSwap quote is ignored and cannot manufacture a signal.
  const guardedMint = 'GuardedAmmPrice111111111111111111111111111';
  recordCreate(store, guardedMint, base);
  store.recordComplete({
    mint: guardedMint,
    completedAt: base + 13_000,
    timestampMs: base + 13_000,
  });
  suite.onGraduated(store.getToken(guardedMint));
  suite.observeTrade(trade(guardedMint, base + 13_100, 1));
  const signalsBeforeOutlier = suite.health().signals;
  suite.observeTrade(trade(guardedMint, base + 13_200, 0.0001));
  suite.observeTrade(trade(guardedMint, base + 13_300, 0.99));
  assert.strictEqual(suite.health().signals, signalsBeforeOutlier);
  assert.strictEqual(suite.health().ammPriceOutliersIgnored, 2);

  // Two corroborating quotes may confirm a genuine new regime after the first is quarantined.
  suite.observeTrade(trade(guardedMint, base + 13_400, 0.1));
  suite.observeTrade(trade(guardedMint, base + 13_500, 0.101));
  assert.strictEqual(suite.health().ammPriceOutliersIgnored, 3);
  assert.strictEqual(suite.health().ammPriceRegimesConfirmed, 1);

  const dashboard = store.migratedDropReboundShadowDashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 4);
  assert.strictEqual(dashboard.entryProfiles.length, 2);
  assert(dashboard.entryProfiles.every((profile) => profile.signals === 1));
  const timeSessions = store.shadowTimeSessionDashboard('migrated-rebound');
  assert.strictEqual(
    timeSessions.sessions.reduce((sum, session) => sum + session.resolved, 0),
    4,
  );
  const health = store.health().migratedDropReboundShadowPositions;
  assert.strictEqual(health.signals, 2);
  assert.strictEqual(health.pre_migration_signals, 1);
  assert.strictEqual(health.post_migration_signals, 1);

  now = base + config.trackingAgeMs + 20_000;
  assert(!suite.trackedMints(now).includes(deepMint));
  store.close();
  console.log('Lifecycle drop/rebound Shadow G tests: PASS');
}

run();

function testEarlyOpportunityProfiles() {
  const base = 1_900_000_000_000;
  let now = base;
  const store = new ResearchStore({
    dbPath: ':memory:', rawRetentionHours: 168, archiveDir: './data/archive',
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const config = {
    enabled: true,
    lifecycleStages: [{ id: 'POST_MIGRATION', label: 'post', market: 'PUMP_AMM' }],
    stateRetentionMs: 60_000, trackingAgeMs: 120_000, positionSizeSol: 1,
    entryDelayMs: 200, entryTimeoutMs: 2_000, exitDelayMs: 200, exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 15,
    entryProfiles: [
      {
        id: 'GE30_R23_F1', label: 'first', windowMs: 1_000,
        dropMinPct: 15, dropMaxPct: 35, reboundMinPct: 2, reboundMaxPct: 3,
        reboundTimeoutMs: 1_000, maxLifecycleAgeMs: 30_000, maxSignalsPerMint: 1,
      },
      {
        id: 'GE30_R23_F3', label: 'first-three', windowMs: 1_000,
        dropMinPct: 15, dropMaxPct: 35, reboundMinPct: 2, reboundMaxPct: 3,
        reboundTimeoutMs: 1_000, maxLifecycleAgeMs: 30_000, maxSignalsPerMint: 3,
      },
    ],
    exitProfiles: [{ id: 'X3', label: '3s', exitMode: 'FIXED_HOLD', fixedHoldMs: 3_000 }],
    costModel: {
      platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0, priorityFeeSol: 0,
      jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 1,
    },
  };
  const mint = 'EarlyOpportunity1111111111111111111111111111';
  recordCreate(store, mint, base);
  store.recordComplete({ mint, completedAt: base, timestampMs: base });
  let suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  suite.onGraduated(store.getToken(mint));
  const cycle = (start) => {
    suite.observeTrade(trade(mint, base + start, 1));
    suite.observeTrade(trade(mint, base + start + 100, 0.8));
    suite.observeTrade(trade(mint, base + start + 200, 0.82));
  };
  cycle(1_000);
  cycle(3_000);
  cycle(5_000);
  cycle(7_000);
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions WHERE entry_profile_id='GE30_R23_F1'").get().n,
    1,
  );
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions WHERE entry_profile_id='GE30_R23_F3'").get().n,
    3,
  );

  // Counts are restored from persisted episodes; restart cannot reopen F1.
  suite.stop();
  suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  suite.onGraduated(store.getToken(mint));
  cycle(9_000);
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions WHERE entry_profile_id='GE30_R23_F1'").get().n,
    1,
  );
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions WHERE entry_profile_id='GE30_R23_F3'").get().n,
    3,
  );

  const lateMint = 'LateOpportunity11111111111111111111111111111';
  recordCreate(store, lateMint, base);
  store.recordComplete({ mint: lateMint, completedAt: base, timestampMs: base });
  suite.onGraduated(store.getToken(lateMint));
  suite.observeTrade(trade(lateMint, base + 31_000, 1));
  suite.observeTrade(trade(lateMint, base + 31_100, 0.8));
  suite.observeTrade(trade(lateMint, base + 31_200, 0.82));
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions WHERE mint=?').get(lateMint).n,
    0,
  );
  store.close();
}

function optimizationConfig(exitProfiles) {
  return {
    enabled: true,
    lifecycleStages: [{ id: 'POST_MIGRATION', label: 'post', market: 'PUMP_AMM' }],
    stateRetentionMs: 60_000,
    trackingAgeMs: 120_000,
    positionSizeSol: 1,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 15,
    entryProfiles: [{
      id: 'GD25_35', label: 'base', windowMs: 1_000,
      dropMinPct: 25, dropMaxPct: 35, reboundMinPct: 2, reboundMaxPct: 5,
      reboundTimeoutMs: 1_000,
    }],
    exitProfiles,
    costModel: {
      platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0, priorityFeeSol: 0,
      jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 1,
    },
  };
}

function optimizationStore() {
  return new ResearchStore({
    dbPath: ':memory:', rawRetentionHours: 168, archiveDir: './data/archive',
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
}

function seedPostMigrationSignal({ suite, store, mint, base }) {
  recordCreate(store, mint, base);
  store.recordComplete({ mint, completedAt: base, timestampMs: base });
  suite.onGraduated(store.getToken(mint));
  suite.observeTrade(trade(mint, base + 100, 1));
  suite.observeTrade(trade(mint, base + 200, 0.7));
  suite.observeTrade(trade(mint, base + 300, 0.721));
  suite.observeTrade(trade(mint, base + 500, 0.73));
}

function testSplitRunnerPersistsAcrossRestart() {
  const base = 2_000_000_000_000;
  let now = base;
  const store = optimizationStore();
  const legacyShape = {
    entryProfileIds: ['GD25_35'], exitMode: 'BLEND_XLEG_X8',
    runnerHoldMs: 8_000, trailingActivationPct: 8, trailingStopPct: 3,
    fastTakeProfitPct: 18, fastTakeProfitWindowMs: 5_000,
    lossCheckAtMs: 6_000,
  };
  const config = optimizationConfig([
    { id: 'XB50', label: '50/50', coreWeightPct: 50, ...legacyShape },
    { id: 'XB25', label: '25/75', coreWeightPct: 25, ...legacyShape },
  ]);
  const mint = 'SplitRunner111111111111111111111111111111111';
  let suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  seedPostMigrationSignal({ suite, store, mint, base });

  suite.observeTrade(trade(mint, base + 1_000, 0.95));
  suite.observeTrade(trade(mint, base + 1_200, 0.9));
  let rows = store.db.prepare(`
    SELECT exit_profile_id, status, core_exit_price
    FROM migrated_drop_rebound_shadow_positions WHERE mint=? ORDER BY exit_profile_id
  `).all(mint);
  assert(rows.every((row) => row.status === 'OPEN' && row.core_exit_price === 0.9));

  suite.stop();
  now = base + 1_300;
  suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  suite.observeTrade(trade(mint, base + 8_500, 1.46));
  suite.observeTrade(trade(mint, base + 8_700, 1.4));
  rows = store.db.prepare(`
    SELECT exit_profile_id, status, core_exit_price, gross_return_pct, exit_reason
    FROM migrated_drop_rebound_shadow_positions WHERE mint=? ORDER BY exit_profile_id
  `).all(mint);
  assert(rows.every((row) => row.status === 'CLOSED' && row.core_exit_price === 0.9));
  assert(rows.every((row) => row.exit_reason.startsWith('BLEND_FAST_TAKE_PROFIT_X8')));
  assert(rows.find((row) => row.exit_profile_id === 'XB25').gross_return_pct
    > rows.find((row) => row.exit_profile_id === 'XB50').gross_return_pct,
  'the 75% runner cohort must retain more of a large late winner');
  store.close();
}

function testRiskExitRequiresWeakRecovery() {
  const base = 2_100_000_000_000;
  let now = base;
  const store = optimizationStore();
  const makeRisk = (id, lossCheckAtMs, hardStopPct) => ({
    id, label: id, entryProfileIds: ['GD25_35'], exitMode: 'RISK_XLEG',
    trailingActivationPct: 8, trailingStopPct: 3, hardStopPct,
    fastTakeProfitPct: 18, fastTakeProfitWindowMs: 5_000,
    lossCheckAtMs, lossCheckRecoveryPct: 1, maxHoldMs: 15_000,
  });
  const config = optimizationConfig([
    makeRisk('XR3_H12', 3_000, 12), makeRisk('XR3_H15', 3_000, 15),
    makeRisk('XR4_H12', 4_000, 12), makeRisk('XR4_H15', 4_000, 15),
  ]);
  const mint = 'RiskMatrix11111111111111111111111111111111111';
  const suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  seedPostMigrationSignal({ suite, store, mint, base });
  suite.observeTrade(trade(mint, base + 2_000, 0.65));
  suite.observeTrade(trade(mint, base + 3_500, 0.6564));
  let rows = store.db.prepare(`
    SELECT exit_profile_id, status, exit_reason
    FROM migrated_drop_rebound_shadow_positions WHERE mint=? ORDER BY exit_profile_id
  `).all(mint);
  assert(rows.filter((row) => row.exit_profile_id.startsWith('XR3'))
    .every((row) => row.status === 'EXIT_PENDING' && row.exit_reason === 'RISK_LOSS_CHECK'),
  JSON.stringify(rows));
  assert(rows.filter((row) => row.exit_profile_id.startsWith('XR4'))
    .every((row) => row.status === 'OPEN'));
  suite.observeTrade(trade(mint, base + 3_700, 0.66));
  suite.observeTrade(trade(mint, base + 4_500, 0.7));
  rows = store.db.prepare(`
    SELECT exit_profile_id, status FROM migrated_drop_rebound_shadow_positions
    WHERE mint=? ORDER BY exit_profile_id
  `).all(mint);
  assert(rows.filter((row) => row.exit_profile_id.startsWith('XR3'))
    .every((row) => row.status === 'CLOSED'));
  assert(rows.filter((row) => row.exit_profile_id.startsWith('XR4'))
    .every((row) => row.status === 'OPEN'),
  'a rebound more than 1% above the running low must survive the four-second check');
  store.close();
}

testEarlyOpportunityProfiles();
testSplitRunnerPersistsAcrossRestart();
testRiskExitRequiresWeakRecovery();
