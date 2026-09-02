'use strict';

const assert = require('assert');
const { ResearchStore, MIGRATION_SOURCE } = require('../src/data/ResearchStore');
const {
  MigratedDropReboundShadowSuite,
  ammBuyAveragePrice,
  ammSellAveragePrice,
  beijingHourAllowed,
} = require(
  '../src/core/MigratedDropReboundShadowSuite'
);

function trade(mint, timestampMs, price, market = 'PUMP_AMM', overrides = {}) {
  const resolvedPrice = overrides.price ?? price;
  const solAmount = overrides.solAmount ?? 1;
  return {
    ...overrides,
    mint,
    timestampMs,
    receivedAtMs: overrides.receivedAtMs ?? timestampMs,
    market: overrides.market || market,
    side: overrides.side || 'BUY',
    solAmount,
    tokenAmount: overrides.tokenAmount ?? (solAmount / resolvedPrice),
    price: resolvedPrice,
    reservePrice: overrides.reservePrice ?? resolvedPrice,
    signature: overrides.signature || `${mint}:${timestampMs}:${resolvedPrice}`,
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

function recordMigration(store, mint, migratedAt, completedAt = migratedAt) {
  store.recordComplete({ mint, completedAt, timestampMs: completedAt });
  return store.recordMigration({
    mint,
    migratedAt,
    timestampMs: migratedAt,
    pool: `${mint}:pool`,
  });
}

function testFirstAmmMigrationRecoveryAndExactUpgrade() {
  const store = new ResearchStore({
    dbPath: ':memory:',
    rawRetentionHours: 168,
    archiveDir: './data/archive',
    flushMs: 60_000,
    flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const mint = 'FirstAmmRecovery1111111111111111111111111111';
  const completedAt = 1_799_999_999_000;
  const firstAmmAt = completedAt + 6_000;
  recordCreate(store, mint, completedAt - 10_000);
  store.recordComplete({ mint, completedAt, timestampMs: completedAt });
  assert.strictEqual(store.recoverMigrationFromFirstAmmTrade({
    ...trade(mint, firstAmmAt - 1, 1),
    price: null,
  }), null);

  const recovered = store.recoverMigrationFromFirstAmmTrade(trade(
    mint,
    firstAmmAt + 50,
    1,
    'PUMP_AMM',
    {
      chainTimestampMs: firstAmmAt,
      pool: 'first-amm-pool',
      signature: 'first-amm-signature',
    },
  ));
  assert.ok(recovered);
  assert.strictEqual(recovered.migrated_at, firstAmmAt);
  assert.strictEqual(recovered.migration_source, MIGRATION_SOURCE.FIRST_AMM_OBSERVED);
  assert.strictEqual(recovered.migration_signature, 'first-amm-signature');
  assert.strictEqual(recovered.migration_pool, 'first-amm-pool');
  const suite = new MigratedDropReboundShadowSuite({
    config: {
      enabled: true,
      lifecycleStages: [{ id: 'POST_MIGRATION', market: 'PUMP_AMM' }],
      entryProfiles: [],
      exitProfiles: [],
      positionSizeSol: 0.1,
      entryTimeoutMs: 2_000,
      trackingAgeMs: 30_000,
      stateRetentionMs: 30_000,
      costModel: { positionSizeSol: 0.1 },
    },
    store,
    now: () => firstAmmAt + 50,
  });
  suite.onGraduated(recovered, { source: 'first_amm' });
  assert.strictEqual(suite.health().firstAmmMigrationRecoveries, 1);
  assert.strictEqual(suite.health().lastCompletionToFirstAmmMs, 6_000);

  const exactAt = completedAt + 250;
  const exact = store.recordMigration({
    mint,
    migratedAt: exactAt,
    timestampMs: exactAt,
    pool: 'exact-chain-pool',
    signature: 'exact-chain-signature',
  });
  assert.strictEqual(exact.migrated_at, exactAt);
  assert.strictEqual(exact.migration_source, MIGRATION_SOURCE.CHAIN_EVENT);
  assert.strictEqual(exact.migration_signature, 'exact-chain-signature');
  assert.strictEqual(exact.migration_pool, 'exact-chain-pool');
  suite.onGraduated(exact, { source: 'migration' });
  assert.strictEqual(suite.health().migrationEventsObserved, 1);
  assert.strictEqual(suite.tracked.get(mint).migratedAt, exactAt);
  assert.strictEqual(suite.tracked.get(mint).migrationSource, MIGRATION_SOURCE.CHAIN_EVENT);
  assert.strictEqual(store.recoverMigrationFromFirstAmmTrade(trade(
    mint,
    firstAmmAt + 1_000,
    1,
  )), null);
  store.close();
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

  // A position opened before curve completion remains observable, but PumpSwap
  // exits only become executable after the actual migration event.
  store.recordComplete({ mint: preMint, completedAt: base + 1_000, timestampMs: base + 1_000 });
  suite.onGraduated(store.getToken(preMint), { source: 'complete' });
  store.recordMigration({
    mint: preMint,
    migratedAt: base + 1_500,
    timestampMs: base + 1_500,
    pool: `${preMint}:pool`,
  });
  suite.onGraduated(store.getToken(preMint), { source: 'migration' });
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
  store.recordComplete({
    mint: postMint,
    completedAt: base + 1_000,
    timestampMs: base + 1_000,
  });
  suite.onGraduated(store.getToken(postMint), { source: 'complete' });
  const signalsBeforeActualMigration = suite.health().signals;
  suite.observeTrade(trade(postMint, base + 1_100, 1));
  suite.observeTrade(trade(postMint, base + 1_400, 0.8));
  suite.observeTrade(trade(postMint, base + 1_700, 0.82));
  assert.strictEqual(suite.health().signals, signalsBeforeActualMigration);
  assert.strictEqual(suite.health().missingMigratedAtAmmTrades, 3);
  store.recordMigration({
    mint: postMint,
    migratedAt: base + 5_000,
    timestampMs: base + 5_000,
    pool: `${postMint}:pool`,
  });
  suite.onGraduated(store.getToken(postMint), { source: 'migration' });
  assert.strictEqual(store.getToken(postMint).graduated_at, base + 1_000);
  assert.strictEqual(store.getToken(postMint).migrated_at, base + 5_000);
  assert.strictEqual(suite.health().lastCompletionToMigrationMs, 4_000);
  const outOfOrderMint = 'OutOfOrderMigration1111111111111111111111111';
  recordCreate(store, outOfOrderMint, base);
  store.recordMigration({
    mint: outOfOrderMint,
    migratedAt: base + 20_000,
    timestampMs: base + 20_000,
  });
  store.recordComplete({
    mint: outOfOrderMint,
    completedAt: base + 15_000,
    timestampMs: base + 15_000,
  });
  assert.strictEqual(store.getToken(outOfOrderMint).graduated_at, base + 15_000);
  assert.strictEqual(store.getToken(outOfOrderMint).migrated_at, base + 20_000);
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

  // Health must distinguish an idle two-minute tracking window from a broken
  // AMM feed or a missing graduation mapping after restart.
  suite.observeTrade(trade(
    'MissingGraduationDiagnostic111111111111111111111',
    base + 9_201,
    1,
  ));
  const diagnosticHealth = suite.health();
  assert(diagnosticHealth.startupRecoveredMints >= 1);
  assert(diagnosticHealth.ammTradesObserved > 0);
  assert(diagnosticHealth.postMigrationEligibleTrades > 0);
  assert.strictEqual(diagnosticHealth.missingGraduatedAtAmmTrades, 1);
  assert.strictEqual(diagnosticHealth.lastMissingGraduatedAtAmmTradeAt, base + 9_201);
  assert(diagnosticHealth.lastAmmTradeObservedAt >= base + 9_201);

  // Curve events after graduation do not seed either lifecycle detector.
  const signalsBeforeStrayCurve = suite.health().signals;
  suite.observeTrade(trade(postMint, base + 10_000, 1, 'PUMP_BONDING_CURVE'));
  suite.observeTrade(trade(postMint, base + 10_100, 0.8, 'PUMP_BONDING_CURVE'));
  suite.observeTrade(trade(postMint, base + 10_300, 0.82, 'PUMP_BONDING_CURVE'));
  assert.strictEqual(suite.health().signals, signalsBeforeStrayCurve);

  // A drop beyond the maximum is cancelled and cannot re-arm inside the episode.
  const deepMint = 'DeepDrop1111111111111111111111111111111111';
  recordCreate(store, deepMint, base);
  recordMigration(store, deepMint, base + 12_000);
  suite.onGraduated(store.getToken(deepMint), { source: 'migration' });
  suite.observeTrade(trade(deepMint, base + 12_100, 1));
  suite.observeTrade(trade(deepMint, base + 12_150, 0.8));
  suite.observeTrade(trade(deepMint, base + 12_200, 0.64));
  suite.observeTrade(trade(deepMint, base + 12_400, 0.66));
  assert.strictEqual(suite.health().signals, signalsBeforeStrayCurve);
  assert(suite.health().dropExceededMax >= 1);

  // A single malformed PumpSwap quote is ignored and cannot manufacture a signal.
  const guardedMint = 'GuardedAmmPrice111111111111111111111111111';
  recordCreate(store, guardedMint, base);
  recordMigration(store, guardedMint, base + 13_000);
  suite.onGraduated(store.getToken(guardedMint), { source: 'migration' });
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

testFirstAmmMigrationRecoveryAndExactUpgrade();
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
  recordMigration(store, mint, base);
  let suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  suite.onGraduated(store.getToken(mint), { source: 'migration' });
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
  suite.onGraduated(store.getToken(mint), { source: 'migration' });
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
  recordMigration(store, lateMint, base);
  suite.onGraduated(store.getToken(lateMint), { source: 'migration' });
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
  recordMigration(store, mint, base);
  suite.onGraduated(store.getToken(mint), { source: 'migration' });
  suite.observeTrade(trade(mint, base + 100, 1));
  suite.observeTrade(trade(mint, base + 200, 0.7));
  suite.observeTrade(trade(mint, base + 300, 0.7203));
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

function testV2ProfileSpecificJumpAndRunner() {
  const base = 2_200_000_000_000;
  let now = base;
  const store = optimizationStore();
  const config = optimizationConfig([{
    id: 'V2_B75_H20', label: 'v2 runner',
    entryProfileIds: ['GE30_D25_32_R24_F1'], exitMode: 'BLEND_XLEG_RUNNER',
    coreWeightPct: 25, runnerHoldMs: 20_000,
    trailingActivationPct: 8, trailingStopPct: 3,
    fastTakeProfitPct: 18, fastTakeProfitWindowMs: 5_000, lossCheckAtMs: 6_000,
  }]);
  config.entryProfiles = [{
    id: 'GE30_D25_32_R24_F1', label: 'v2', windowMs: 1_000,
    dropMinPct: 25, dropMaxPct: 32, reboundMinPct: 2, reboundMaxPct: 4,
    reboundTimeoutMs: 1_000, maxLifecycleAgeMs: 30_000,
    maxSignalsPerMint: 1, maxEntryPriceJumpPct: 3,
  }];
  const rejectedMint = 'V2JumpRejected111111111111111111111111111111';
  recordCreate(store, rejectedMint, base);
  recordMigration(store, rejectedMint, base);
  let suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  suite.onGraduated(store.getToken(rejectedMint), { source: 'migration' });
  suite.observeTrade(trade(rejectedMint, base + 100, 1));
  suite.observeTrade(trade(rejectedMint, base + 200, 0.7));
  suite.observeTrade(trade(rejectedMint, base + 300, 0.721));
  suite.observeTrade(trade(rejectedMint, base + 500, 0.75));
  const rejected = store.db.prepare(`
    SELECT status, rejection_reason FROM migrated_drop_rebound_shadow_positions WHERE mint=?
  `).get(rejectedMint);
  assert.strictEqual(rejected.status, 'PRICE_JUMP');
  assert.match(rejected.rejection_reason, /ENTRY_PRICE_JUMP/);

  const runnerMint = 'V2Runner11111111111111111111111111111111111';
  recordCreate(store, runnerMint, base + 100_000);
  recordMigration(store, runnerMint, base + 100_000);
  suite.onGraduated(store.getToken(runnerMint), { source: 'migration' });
  suite.observeTrade(trade(runnerMint, base + 100_100, 1));
  suite.observeTrade(trade(runnerMint, base + 100_200, 0.7));
  suite.observeTrade(trade(runnerMint, base + 100_300, 0.721));
  suite.observeTrade(trade(runnerMint, base + 100_500, 0.73));
  suite.observeTrade(trade(runnerMint, base + 101_000, 0.95));
  suite.observeTrade(trade(runnerMint, base + 101_200, 0.9));
  suite.observeTrade(trade(runnerMint, base + 120_500, 1.2));
  suite.observeTrade(trade(runnerMint, base + 120_700, 1.2));
  const runner = store.db.prepare(`
    SELECT status, core_exit_price, exit_reason FROM migrated_drop_rebound_shadow_positions
    WHERE mint=?
  `).get(runnerMint);
  assert.strictEqual(runner.status, 'CLOSED');
  assert.strictEqual(runner.core_exit_price, 0.9);
  assert.match(runner.exit_reason, /RUNNER_20000MS/);
  store.close();
}

function testCapacityAwareEntryFill() {
  const base = 2_300_000_000_000;
  let now = base;
  const store = optimizationStore();
  const config = optimizationConfig([{
    id: 'GEXEC_XLEG', label: 'capacity', entryProfileIds: ['GE30_R23_F1_EXEC'],
    exitMode: 'FIXED_HOLD', fixedHoldMs: 300,
  }]);
  config.entryProfiles = [{
    id: 'GE30_R23_F1_EXEC', label: 'capacity', windowMs: 1_000,
    dropMinPct: 25, dropMaxPct: 35, reboundMinPct: 2, reboundMaxPct: 3,
    reboundTimeoutMs: 1_000, maxLifecycleAgeMs: 30_000,
    maxSignalsPerMint: 1, exitProfileIds: ['GEXEC_XLEG'],
    capacityAware: true, positionSols: [0.05, 1],
  }];
  const mint = 'CapacityFill111111111111111111111111111111111';
  recordCreate(store, mint, base);
  recordMigration(store, mint, base);
  const suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  suite.onGraduated(store.getToken(mint), { source: 'migration' });
  suite.observeTrade(trade(mint, base + 100, 1));
  suite.observeTrade(trade(mint, base + 200, 0.7));
  suite.observeTrade(trade(mint, base + 300, 0.7203));
  suite.observeTrade({
    ...trade(mint, base + 500, 0.73),
    poolBaseReservesRaw: '100000000',
    poolQuoteReservesRaw: '73000000000',
    virtualQuoteReservesRaw: '0',
  });
  const rows = store.db.prepare(`
    SELECT cohort_id, status, position_sol, entry_price, entry_impact_pct
    FROM migrated_drop_rebound_shadow_positions WHERE mint=? ORDER BY position_sol
  `).all(mint);
  assert.strictEqual(rows.length, 2);
  assert(rows.every((row) => row.status === 'OPEN'));
  assert.deepStrictEqual(rows.map((row) => row.position_sol), [0.05, 1]);
  assert.match(rows[0].cohort_id, /0_05SOL$/);
  assert.match(rows[1].cohort_id, /1SOL$/);
  assert(rows[1].entry_price > rows[0].entry_price);
  assert(rows[1].entry_impact_pct > rows[0].entry_impact_pct);
  const direct = ammBuyAveragePrice({
    poolBaseReservesRaw: '100000000',
    poolQuoteReservesRaw: '73000000000',
  }, 1, 0.73);
  assert(direct.price > 0.73 && direct.impactPct > 1);
  const sell = ammSellAveragePrice({
    poolBaseReservesRaw: '100000000',
    poolQuoteReservesRaw: '73000000000',
  }, 1, 0.73);
  assert(sell.price < 0.73 && sell.impactPct < 0);
  suite.observeTrade({
    ...trade(mint, base + 1_000, 0.8),
    poolBaseReservesRaw: '100000000',
    poolQuoteReservesRaw: '80000000000',
    virtualQuoteReservesRaw: '0',
  });
  const closedRows = store.db.prepare(`
    SELECT status, position_sol, exit_impact_pct
    FROM migrated_drop_rebound_shadow_positions WHERE mint=? ORDER BY position_sol
  `).all(mint);
  assert(closedRows.every((row) => row.status === 'CLOSED'));
  assert(closedRows.every((row) => row.exit_impact_pct < 0));
  assert(closedRows[1].exit_impact_pct < closedRows[0].exit_impact_pct);
  store.close();
}

function testSecondOpportunityOnlyAndBeijingWindows() {
  const base = 2_400_000_000_000;
  let now = base;
  const store = optimizationStore();
  const config = optimizationConfig([{
    id: 'G2_XLEG', label: 'second', entryProfileIds: ['GE30_R23_F2_ONLY'],
    exitMode: 'LEGACY', trailingActivationPct: 8, trailingStopPct: 3,
    fastTakeProfitPct: 18, fastTakeProfitWindowMs: 5_000,
    lossCheckAtMs: 6_000, maxHoldMs: 15_000,
  }]);
  config.entryProfiles = [{
    id: 'GE30_R23_F2_ONLY', label: 'second', windowMs: 1_000,
    dropMinPct: 25, dropMaxPct: 35, reboundMinPct: 2, reboundMaxPct: 3,
    reboundTimeoutMs: 1_000, maxLifecycleAgeMs: 30_000,
    minSignalOrdinal: 2, maxSignalsPerMint: 2, exitProfileIds: ['G2_XLEG'],
  }];
  const mint = 'SecondOpportunity11111111111111111111111111111';
  recordCreate(store, mint, base);
  recordMigration(store, mint, base);
  const suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  suite.onGraduated(store.getToken(mint), { source: 'migration' });
  suite.observeTrade(trade(mint, base + 100, 1));
  suite.observeTrade(trade(mint, base + 200, 0.7));
  suite.observeTrade(trade(mint, base + 300, 0.7203));
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions WHERE mint=?
  `).get(mint).n, 0);
  suite.observeTrade(trade(mint, base + 1_500, 0.8));
  suite.observeTrade(trade(mint, base + 1_600, 0.56));
  suite.observeTrade(trade(mint, base + 1_700, 0.57624));
  suite.observeTrade(trade(mint, base + 1_900, 0.58));
  const row = store.db.prepare(`
    SELECT status, entry_profile_id FROM migrated_drop_rebound_shadow_positions WHERE mint=?
  `).get(mint);
  assert.strictEqual(row.status, 'OPEN');
  assert.strictEqual(row.entry_profile_id, 'GE30_R23_F2_ONLY');

  const beijingNoon = Date.UTC(2026, 7, 16, 4, 0, 0);
  const beijingNight = Date.UTC(2026, 7, 16, 18, 0, 0);
  assert.strictEqual(beijingHourAllowed(beijingNoon, [[8, 18]]), true);
  assert.strictEqual(beijingHourAllowed(beijingNoon, [[0, 8], [18, 24]]), false);
  assert.strictEqual(beijingHourAllowed(beijingNight, [[0, 8], [18, 24]]), true);
  store.close();
}

function testStairTrailingAndRunnerHardStop() {
  const base = 2_500_000_000_000;
  let now = base;
  const store = optimizationStore();
  const config = optimizationConfig([
    {
      id: 'G1_STAIR_H60', label: 'stair', entryProfileIds: ['GD25_35'],
      exitMode: 'STAIR_TRAILING', hardStopPct: 15, maxHoldMs: 60_000,
      trailingTiers: [
        { activationPct: 20, stopPct: 8 },
        { activationPct: 40, stopPct: 12 },
      ],
    },
    {
      id: 'G1_B75_H30', label: 'runner risk', entryProfileIds: ['GD25_35'],
      exitMode: 'BLEND_XLEG_RUNNER_RISK', coreWeightPct: 75,
      runnerHoldMs: 30_000, trailingActivationPct: 8, trailingStopPct: 3,
      hardStopPct: 15, fastTakeProfitPct: 18, fastTakeProfitWindowMs: 5_000,
      lossCheckAtMs: 6_000,
    },
  ]);
  const stairMint = 'StairTrailing111111111111111111111111111111111';
  let suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  seedPostMigrationSignal({ suite, store, mint: stairMint, base });
  suite.observeTrade(trade(stairMint, base + 1_000, 0.95));
  suite.observeTrade(trade(stairMint, base + 1_200, 0.85));
  suite.observeTrade(trade(stairMint, base + 1_500, 0.84));
  const stair = store.db.prepare(`
    SELECT status, exit_reason FROM migrated_drop_rebound_shadow_positions
    WHERE mint=? AND exit_profile_id='G1_STAIR_H60'
  `).get(stairMint);
  assert.strictEqual(stair.status, 'CLOSED');
  assert.strictEqual(stair.exit_reason, 'STAIR_TRAILING_20_8');

  const riskMint = 'RunnerRisk1111111111111111111111111111111111';
  const riskBase = base + 100_000;
  seedPostMigrationSignal({ suite, store, mint: riskMint, base: riskBase });
  suite.observeTrade(trade(riskMint, riskBase + 1_000, 0.6));
  suite.observeTrade(trade(riskMint, riskBase + 1_300, 0.59));
  const risk = store.db.prepare(`
    SELECT status, exit_reason, core_exit_price FROM migrated_drop_rebound_shadow_positions
    WHERE mint=? AND exit_profile_id='G1_B75_H30'
  `).get(riskMint);
  assert.strictEqual(risk.status, 'CLOSED');
  assert.strictEqual(risk.exit_reason, 'BLEND_HARD_STOP');
  assert.strictEqual(risk.core_exit_price, null);
  store.close();
}

testEarlyOpportunityProfiles();
testSplitRunnerPersistsAcrossRestart();
testRiskExitRequiresWeakRecovery();
testV2ProfileSpecificJumpAndRunner();
testCapacityAwareEntryFill();
testSecondOpportunityOnlyAndBeijingWindows();
testStairTrailingAndRunnerHardStop();

function testFastReboundCapacityProfile() {
  const base = 2_600_000_000_000;
  const store = optimizationStore();
  const config = optimizationConfig([{
    id: 'GQ_XLEG', label: 'gq', entryProfileIds: ['GE30_D25_32_R23_F1_FAST200'],
    exitMode: 'LEGACY', trailingActivationPct: 8, trailingStopPct: 3,
    fastTakeProfitPct: 18, fastTakeProfitWindowMs: 5_000,
    lossCheckAtMs: 6_000, maxHoldMs: 15_000,
  }]);
  config.entryProfiles = [{
    id: 'GE30_D25_32_R23_F1_FAST200', label: 'fast200', windowMs: 1_000,
    dropMinPct: 25, dropMaxPct: 32, reboundMinPct: 2, reboundMaxPct: 3,
    reboundTimeoutMs: 1_000, maxReboundFromLowMs: 200,
    maxLifecycleAgeMs: 30_000, maxSignalsPerMint: 1,
    maxEntryPriceJumpPct: 5, exitProfileIds: ['GQ_XLEG'], capacityAware: true,
    positionSols: [0.05, 0.25, 0.5, 1],
  }];
  const suite = new MigratedDropReboundShadowSuite({ config, store, now: () => base });
  suite.start();

  const slowMint = 'SlowReboundGQ11111111111111111111111111111111';
  recordCreate(store, slowMint, base);
  recordMigration(store, slowMint, base);
  suite.onGraduated(store.getToken(slowMint), { source: 'migration' });
  suite.observeTrade(trade(slowMint, base + 100, 1));
  suite.observeTrade(trade(slowMint, base + 200, 0.7));
  suite.observeTrade(trade(slowMint, base + 500, 0.7203));
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions WHERE mint=?
  `).get(slowMint).n, 0, 'a rebound after 200ms must be rejected before cohort creation');
  assert.strictEqual(suite.health().reboundTooSlow, 1);

  const fastMint = 'FastReboundGQ11111111111111111111111111111111';
  recordCreate(store, fastMint, base);
  recordMigration(store, fastMint, base);
  suite.onGraduated(store.getToken(fastMint), { source: 'migration' });
  suite.observeTrade(trade(fastMint, base + 1_100, 1));
  suite.observeTrade(trade(fastMint, base + 1_200, 0.7));
  suite.observeTrade(trade(fastMint, base + 1_350, 0.7203));
  const pending = store.db.prepare(`
    SELECT position_sol, status FROM migrated_drop_rebound_shadow_positions
    WHERE mint=? ORDER BY position_sol
  `).all(fastMint);
  assert.deepStrictEqual(pending.map((row) => row.position_sol), [0.05, 0.25, 0.5, 1]);
  assert.ok(pending.every((row) => row.status === 'PENDING_ENTRY'));
  store.close();
}

testFastReboundCapacityProfile();

function fastFlowTrade(mint, timestampMs, price, {
  wallet,
  side = 'BUY',
  solAmount = 0.5,
} = {}) {
  return {
    ...trade(mint, timestampMs, price),
    wallet,
    side,
    solAmount,
    poolBaseReservesRaw: '1000000000000000',
    poolQuoteReservesRaw: '720000000000',
    virtualQuoteReservesRaw: '0',
  };
}

function testFastReversalContinuationConfirmation() {
  const base = 2_700_000_000_000;
  let now = base;
  const store = optimizationStore();
  const config = optimizationConfig([{
    id: 'GFR_X8',
    label: 'fast reversal 8s',
    entryProfileIds: ['GFR_300'],
    exitMode: 'FIXED_HOLD',
    fixedHoldMs: 8_000,
  }, {
    id: 'GFR_X15',
    label: 'fast reversal 15s',
    entryProfileIds: ['GFR_300'],
    exitMode: 'FIXED_HOLD',
    fixedHoldMs: 15_000,
  }, {
    id: 'GFR_HS20_H30',
    label: 'fast reversal hard stop / hold',
    entryProfileIds: ['GFR_300'],
    exitMode: 'TAIL',
    hardStopPct: 20,
    trailingActivationPct: 1_000,
    trailingStopPct: 100,
    maxHoldMs: 30_000,
  }]);
  config.entryProfiles = [{
    id: 'GFR_300',
    label: 'fast reversal 300ms',
    liveStrategyId: 'migrated_gfr_300_hs20_h30_live',
    windowMs: 1_000,
    dropMinPct: 25,
    dropMaxPct: 35,
    reboundMinPct: 2,
    reboundMaxPct: 5,
    reboundTimeoutMs: 1_000,
    maxLifecycleAgeMs: 30_000,
    maxSignalsPerMint: 1,
    maxEntryPriceJumpPct: 15,
    exitProfileIds: ['GFR_X8', 'GFR_X15', 'GFR_HS20_H30'],
    capacityAware: true,
    positionSols: [0.05, 0.1],
    fastConfirmation: {
      confirmationMs: 300,
      minPriceContinuationPct: 1,
      minBuyTx: 2,
      minUniqueBuyers: 2,
      minNetFlowSol: 0.5,
      minNetFlowAccelerationSol: 0,
      maxSellBuyRatio: 0.5,
      maxTopBuyerSharePct: 60,
      maxRoundTripImpactPct: 5,
    },
  }];
  const liveSignals = [];
  const suite = new MigratedDropReboundShadowSuite({
    config,
    store,
    now: () => now,
    onLiveSignal: (event) => liveSignals.push(event),
  });
  suite.start();

  const fastMint = 'FastContinuation111111111111111111111111111111';
  recordCreate(store, fastMint, base);
  recordMigration(store, fastMint, base);
  suite.onGraduated(store.getToken(fastMint), { source: 'migration' });
  suite.observeTrade(fastFlowTrade(fastMint, base + 100, 0.000001, {
    wallet: 'peak-buyer', solAmount: 0.2,
  }));
  suite.observeTrade(fastFlowTrade(fastMint, base + 200, 0.0000007, {
    wallet: 'low-buyer', solAmount: 0.2,
  }));
  suite.observeTrade(fastFlowTrade(fastMint, base + 300, 0.00000072, {
    wallet: 'buyer-a', solAmount: 0.5,
  }));
  suite.observeTrade(fastFlowTrade(fastMint, base + 450, 0.000000725, {
    wallet: 'buyer-b', solAmount: 0.4,
  }));
  suite.observeTrade(fastFlowTrade(fastMint, base + 600, 0.00000073, {
    wallet: 'buyer-c', solAmount: 0.5,
  }));
  const opened = store.db.prepare(`
    SELECT status, position_sol, confirmation_json
    FROM migrated_drop_rebound_shadow_positions
    WHERE mint=? ORDER BY position_sol
  `).all(fastMint);
  assert.deepStrictEqual(opened.map((row) => row.status), Array(6).fill('OPEN'));
  assert.strictEqual(liveSignals.length, 1, 'one confirmed episode emits one live signal');
  assert.strictEqual(liveSignals[0].strategyId, 'migrated_gfr_300_hs20_h30_live');
  assert.strictEqual(liveSignals[0].features.entryProfileId, 'GFR_300');
  assert.deepStrictEqual(opened.map((row) => row.position_sol), [0.05, 0.05, 0.05, 0.1, 0.1, 0.1]);
  const confirmation = JSON.parse(opened[0].confirmation_json);
  assert.strictEqual(confirmation.uniqueBuyers, 3);
  assert(confirmation.netFlowAccelerationSol > 0);
  assert(confirmation.roundTripImpactPct < 5);
  const fastState = suite.detectors.get('POST_MIGRATION:GFR_300').states.get(fastMint);
  assert.strictEqual(Object.hasOwn(fastState, 'flowTrades'), false,
    'G-FR flow must use the shared per-mint buffer, not one copy per profile');
  assert.strictEqual(suite.health().fastConfirmationFeatureComputations, 1,
    'all exit/capacity rows for one confirmation instant must share one feature scan');
  assert.strictEqual(suite.health().fastConfirmationCapacityComputations, 2,
    'the two capacity sizes should each be quoted once');

  const slowMint = 'SlowContinuation111111111111111111111111111111';
  recordCreate(store, slowMint, base);
  recordMigration(store, slowMint, base);
  suite.onGraduated(store.getToken(slowMint), { source: 'migration' });
  suite.observeTrade(fastFlowTrade(slowMint, base + 1_100, 0.000001, {
    wallet: 'peak', solAmount: 0.2,
  }));
  suite.observeTrade(fastFlowTrade(slowMint, base + 1_200, 0.0000007, {
    wallet: 'low', solAmount: 0.2,
  }));
  suite.observeTrade(fastFlowTrade(slowMint, base + 1_300, 0.00000072, {
    wallet: 'single-buyer', solAmount: 0.1,
  }));
  suite.observeTrade(fastFlowTrade(slowMint, base + 1_600, 0.000000721, {
    wallet: 'single-buyer', solAmount: 0.05,
  }));
  now = base + 4_000;
  suite.advanceTime(now);
  const rejected = store.db.prepare(`
    SELECT status, rejection_reason, confirmation_json
    FROM migrated_drop_rebound_shadow_positions WHERE mint=?
  `).all(slowMint);
  assert(rejected.every((row) => row.status === 'NO_ENTRY'));
  assert(rejected.every((row) => row.rejection_reason === 'FAST_CONFIRM_PRICE_NOT_CONTINUING'));
  assert(rejected.every((row) => JSON.parse(row.confirmation_json).uniqueBuyers === 1));
  assert.strictEqual(suite.health().fastConfirmationPassed, 6);
  assert.strictEqual(suite.health().fastConfirmationRejected, 6);
  assert.strictEqual(suite.health().fastConfirmationFeatureComputations, 2);
  assert.strictEqual(suite.health().fastConfirmationCapacityComputations, 2,
    'a failed public-flow check must skip unnecessary AMM capacity quotes');

  const boundedMint = 'BoundedFastFlow1111111111111111111111111111111';
  recordCreate(store, boundedMint, base);
  recordMigration(store, boundedMint, base);
  suite.onGraduated(store.getToken(boundedMint), { source: 'migration' });
  suite.observeTrade(fastFlowTrade(boundedMint, base + 4_800, 0.000001, {
    wallet: 'bounded-peak',
    solAmount: 0.01,
  }));
  suite.observeTrade(fastFlowTrade(boundedMint, base + 4_900, 0.0000007, {
    wallet: 'bounded-low',
    solAmount: 0.01,
  }));
  for (let index = 0; index < 600; index += 1) {
    suite.observeTrade(fastFlowTrade(boundedMint, base + 5_000 + index, 0.0000007, {
      wallet: `bounded-${index}`,
      solAmount: 0.01,
    }));
  }
  const boundedBuffer = suite.fastFlowByMint.get(boundedMint);
  assert.ok(boundedBuffer.rows.length - boundedBuffer.start <= 512,
    'shared G-FR buffers must remain hard bounded during a trade burst');
  store.close();
}

testFastReversalContinuationConfirmation();

function testNoExitIsCensored() {
  let written = null;
  const position = {
    id: 7,
    mint: 'NoExitCensored1111111111111111111111111111',
    maxFavorableReturnPct: 12,
    maxAdverseReturnPct: -34,
  };
  const suite = Object.create(MigratedDropReboundShadowSuite.prototype);
  suite.store = {
    updateMigratedDropReboundShadowPosition: (_id, patch) => { written = patch; },
  };
  suite.positions = new Map([[position.id, position]]);
  suite.rowsByMint = new Map([[position.mint, new Set([position.id])]]);
  suite.metrics = { closed: 0, noExit: 0, lastActionAt: null };
  suite.now = () => 123;
  suite._markNoExit(position);
  assert.strictEqual(written.status, 'NO_EXIT');
  assert.strictEqual(written.rejectionReason, 'NO_EXECUTABLE_EXIT_TRADE');
  assert.strictEqual(Object.hasOwn(written, 'grossReturnPct'), false);
  assert.strictEqual(Object.hasOwn(written, 'netReturnPct'), false);
}

testNoExitIsCensored();

function testLiveSignalCapacityGate() {
  const emitted = [];
  const suite = Object.create(MigratedDropReboundShadowSuite.prototype);
  suite.onLiveSignal = (signal) => emitted.push(signal);
  suite.liveSignalsEmitted = new Set();
  suite.metrics = { replayLiveSignalsSuppressed: 0, lastError: null };
  const profile = {
    id: 'GE30_D25_32_R24_F1_EXEC1',
    livePositionSol: 0.1,
    liveExitStrategies: {
      V2_R2_H15: 'migrated_ge30_d25_32_r24_f1_exec01_v2_r2_h15_live',
    },
  };
  const tradeRow = {
    slot: 42,
    timestampMs: 1_000,
    receivedAtMs: 1_001,
  };
  const position = {
    episodeId: 'capacity-gate-episode',
    cohortId: 'POST_GE30_D25_32_R24_F1_EXEC1_V2_R2_H15_0_1SOL',
    mint: 'MintCapacityGate1111111111111111111111111111',
    symbol: 'CAP',
    exitProfileId: 'V2_R2_H15',
    entryPrice: 1,
    migrationAgeMs: 5_000,
    dropPct: 28,
    reboundPct: 3,
    entryJumpPct: 1,
    entryImpactPct: 2,
  };
  suite._emitOpenedLiveSignal({ ...position, positionSol: 1 }, profile, tradeRow, 1);
  assert.strictEqual(emitted.length, 0,
    'the 1 SOL capacity row must never trigger the 0.1 SOL live strategy');
  suite._emitOpenedLiveSignal({ ...position, positionSol: 0.1 }, profile, tradeRow, 1);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].strategyId,
    'migrated_ge30_d25_32_r24_f1_exec01_v2_r2_h15_live');
  assert.strictEqual(emitted[0].features.sourceShadowCohortId,
    'POST_GE30_D25_32_R24_F1_EXEC1_V2_R2_H15_0_1SOL');

  const grtProfile = {
    id: 'GRT_R23_F3_V2',
    liveExitStrategies: {
      GRT_F3_XLEG_V2: 'migrated_grt_r23_f3_v2_xleg_live',
    },
  };
  suite._emitOpenedLiveSignal({
    ...position,
    episodeId: 'grt-f3-v2-episode',
    cohortId: 'POST_GRT_R23_F3_V2_GRT_F3_XLEG_V2',
    exitProfileId: 'GRT_F3_XLEG_V2',
    positionSol: 1,
  }, grtProfile, tradeRow, 1);
  assert.strictEqual(emitted.length, 2);
  assert.strictEqual(emitted[1].strategyId, 'migrated_grt_r23_f3_v2_xleg_live');
  assert.strictEqual(
    emitted[1].features.sourceShadowCohortId,
    'POST_GRT_R23_F3_V2_GRT_F3_XLEG_V2',
  );
}

testLiveSignalCapacityGate();

function testDirectDumpNextBuySequentialOpportunities() {
  const base = 2_600_000_000_000;
  let now = base;
  const store = optimizationStore();
  const entryProfileId = 'GE30_DUMP5_NB2_M2';
  const exitProfileId = 'G_DUMP_NB_X8';
  const config = {
    ...optimizationConfig([{
      id: exitProfileId,
      label: 'fixed 8 seconds',
      entryProfileIds: [entryProfileId],
      exitMode: 'FIXED_HOLD',
      fixedHoldMs: 8_000,
      maxHoldMs: 8_000,
    }]),
    observationAgeMs: 30 * 60_000,
    entryProfiles: [{
      id: entryProfileId,
      label: 'direct dump then next buy',
      signalMode: 'DUMP_NEXT_BUY',
      windowMs: 1_000,
      dropMinPct: 15,
      dropMaxPct: 55,
      minDumpSol: 5,
      nextBuyWindowMs: 2_000,
      reboundMinPct: 0,
      reboundMaxPct: 1_000,
      reboundTimeoutMs: 2_000,
      maxLifecycleAgeMs: 30_000,
      maxSignalsPerMint: 2,
      reentryCooldownMs: 2_000,
      maxEntryPriceJumpPct: 15,
      exitProfileIds: [exitProfileId],
      capacityAware: true,
      positionSols: [1],
      rugGuardMode: 'LABEL_ONLY',
    }],
  };
  const mint = 'DirectDumpNextBuy111111111111111111111111111';
  const suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  recordCreate(store, mint, base);
  recordMigration(store, mint, base);
  suite.onGraduated(store.getToken(mint), { source: 'migration' });

  const observe = (offset, price, overrides = {}) => {
    now = base + offset;
    suite.observeTrade(trade(mint, now, price, 'PUMP_AMM', overrides));
  };
  const closeFixedHold = (offset, price) => {
    observe(offset, price, { side: 'BUY', wallet: `exit-arm-${offset}` });
    observe(offset + 300, price, { side: 'BUY', wallet: `exit-fill-${offset}` });
  };

  // Opportunity one: a >=5 SOL dump arms the detector; only the next real BUY confirms.
  observe(100, 1, { side: 'BUY', wallet: 'baseline-1' });
  observe(200, 0.8, {
    side: 'SELL', solAmount: 6, wallet: 'dumper-1', slot: 101, signature: 'dump-1',
  });
  observe(350, 0.81, {
    side: 'BUY', solAmount: 0.4, wallet: 'next-buyer-1', slot: 101, signature: 'next-buy-1',
  });
  observe(600, 0.82, { side: 'BUY', wallet: 'fill-1' });

  // An overlapping dump sequence while the first position is active must not create another row.
  observe(1_000, 1, { side: 'BUY', wallet: 'overlap-base' });
  observe(1_100, 0.8, { side: 'SELL', solAmount: 7, wallet: 'overlap-dumper' });
  observe(1_200, 0.81, { side: 'BUY', wallet: 'overlap-buyer' });
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions
    WHERE mint=? AND entry_profile_id=?
  `).get(mint, entryProfileId).n, 1);
  closeFixedHold(8_700, 0.9);

  // Opportunity two is allowed after the first closes and the cooldown expires.
  observe(10_000, 1, { side: 'BUY', wallet: 'baseline-2' });
  observe(10_100, 0.8, {
    side: 'SELL', solAmount: 6.5, wallet: 'dumper-2', slot: 202, signature: 'dump-2',
  });
  observe(10_250, 0.81, {
    side: 'BUY', solAmount: 0.5, wallet: 'next-buyer-2', slot: 202, signature: 'next-buy-2',
  });
  observe(10_500, 0.82, { side: 'BUY', wallet: 'fill-2' });
  closeFixedHold(18_600, 0.92);

  // A third otherwise-valid opportunity is rejected by the per-Mint maximum of two.
  observe(20_000, 1, { side: 'BUY', wallet: 'baseline-3' });
  observe(20_100, 0.8, { side: 'SELL', solAmount: 8, wallet: 'dumper-3' });
  observe(20_250, 0.81, { side: 'BUY', wallet: 'next-buyer-3' });
  observe(20_500, 0.82, { side: 'BUY', wallet: 'fill-3' });

  const rows = store.db.prepare(`
    SELECT status, confirmation_json
    FROM migrated_drop_rebound_shadow_positions
    WHERE mint=? AND entry_profile_id=? ORDER BY id
  `).all(mint, entryProfileId);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((row) => row.status === 'CLOSED'));
  const confirmation = JSON.parse(rows[0].confirmation_json);
  assert.strictEqual(confirmation.entryConfirmation.mode,
    'NEXT_ACTUAL_BUY_AFTER_LARGE_SELL');
  assert.strictEqual(confirmation.entryConfirmation.dumpSignature, 'dump-1');
  assert.strictEqual(confirmation.entryConfirmation.nextBuySignature, 'next-buy-1');
  assert.ok(confirmation.preEntryUniversalRugGuard,
    'the universal RUG result must be retained as a forward label without blocking entry');
  assert.strictEqual(suite.health().dumpNextBuySignals, 2);

  // Observation continues to 30 minutes, while entry remains hard-limited to 30 seconds.
  const observedMint = 'DirectDumpObservation111111111111111111111111111';
  recordCreate(store, observedMint, base);
  recordMigration(store, observedMint, base);
  suite.onGraduated(store.getToken(observedMint), { source: 'migration' });
  assert.ok(suite.trackedMints(base + (10 * 60_000)).includes(observedMint));
  assert.ok(!suite.trackedMints(base + (31 * 60_000)).includes(observedMint));

  const lateMint = 'DirectDumpLate11111111111111111111111111111111';
  recordCreate(store, lateMint, base);
  recordMigration(store, lateMint, base);
  suite.onGraduated(store.getToken(lateMint), { source: 'migration' });
  const lateTrade = (offset, price, overrides = {}) => {
    now = base + offset;
    suite.observeTrade(trade(lateMint, now, price, 'PUMP_AMM', overrides));
  };
  lateTrade(31_000, 1, { side: 'BUY' });
  lateTrade(31_100, 0.8, { side: 'SELL', solAmount: 7 });
  lateTrade(31_250, 0.81, { side: 'BUY' });
  lateTrade(31_500, 0.82, { side: 'BUY' });
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) AS n FROM migrated_drop_rebound_shadow_positions WHERE mint=?
  `).get(lateMint).n, 0);
  store.close();
}

testDirectDumpNextBuySequentialOpportunities();
