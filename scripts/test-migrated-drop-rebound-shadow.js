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

  const dashboard = store.migratedDropReboundShadowDashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 4);
  assert.strictEqual(dashboard.entryProfiles.length, 2);
  assert(dashboard.entryProfiles.every((profile) => profile.signals === 1));
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
