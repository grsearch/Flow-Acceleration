'use strict';

const assert = require('assert');
const { HolderGrowthShadowSuite } = require('../src/core/HolderGrowthShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:',
    archiveDir: '.',
    rawRetentionHours: 24,
    flushMs: 60_000,
    flushMax: 100,
  }, { configuredTradingCostPct: 0 });
}

function makeConfig() {
  return {
    enabled: true,
    positionSizeSol: 1,
    snapshotHorizonMs: 30_000,
    maxSnapshotLagMs: 2_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 100,
    maxEntryPriceDropPct: 99,
    maxPlausibleReturnPct: 500,
    entryProfiles: [
      {
        id: 'HG30_BAL', label: 'Balanced', minBuyers: 10, minNewBuyers: 10,
        minRetentionPct: 50, minNetFlowSol: 5, maxTop3SharePct: 80,
      },
      {
        id: 'HG30_FAST', label: 'Fast', minBuyers: 10, minNewBuyers: 20,
        minRetentionPct: 70, minNetFlowSol: 10, maxTop3SharePct: 80,
      },
    ],
    exitProfile: {
      id: 'XT15_H120', label: 'test', hardStopPct: 20,
      trailingActivationPct: 15, trailingStopPct: 15, maxHoldMs: 120_000,
    },
    costModel: {
      platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0, priorityFeeSol: 0,
      jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 1,
      entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
}

function recordToken(store, mint, createdAt) {
  store.recordCreate({
    mint, symbol: mint.slice(0, 4), name: null, uri: null,
    bondingCurve: null, creator: null, createdAt,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
}

function curveTrade(mint, timestampMs, price) {
  return {
    mint,
    timestampMs,
    market: 'PUMP_BONDING_CURVE',
    reservePrice: price,
    price,
  };
}

function ammTrade(mint, timestampMs, price) {
  return {
    mint,
    timestampMs,
    market: 'PUMP_AMM',
    price,
  };
}

function snapshot(mint, observedAt, overrides = {}) {
  return {
    mint,
    horizonMs: 30_000,
    observedAt,
    observationLagMs: 0,
    price: 1,
    buyers: 10,
    newBuyers: 10,
    retentionPct: 50,
    netFlowSol: 5,
    top3SharePct: 80,
    curvePct: 60,
    virtualSolReserves: 60,
    ...overrides,
  };
}

function run() {
  const base = 1_800_000_000_000;
  let now = base;
  const store = makeStore();
  const suite = new HolderGrowthShadowSuite({
    config: makeConfig(),
    store,
    now: () => now,
  });
  suite.start();

  const balancedMint = 'HolderGrowthBalanced11111111111111111111111';
  recordToken(store, balancedMint, base);
  now = base + 30_000;
  suite.onSnapshot(snapshot(balancedMint, now));
  assert.strictEqual(suite.health().pendingEntries, 1);
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM holder_growth_shadow_positions').get().n,
    1,
  );
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n,
    0,
    'holder growth research must never create a live position',
  );

  now += 250;
  suite.observeTrade(curveTrade(balancedMint, now, 1));
  now += 500;
  suite.observeTrade(curveTrade(balancedMint, now, 1.2));
  now += 500;
  suite.observeTrade(curveTrade(balancedMint, now, 1.01));
  now += 250;
  suite.observeTrade(curveTrade(balancedMint, now, 1.0));
  let balanced = store.db.prepare(`
    SELECT * FROM holder_growth_shadow_positions WHERE mint = ?
  `).get(balancedMint);
  assert.strictEqual(balanced.status, 'CLOSED');
  assert.strictEqual(balanced.exit_reason, 'TRAILING_15PCT');
  assert.ok(Number.isFinite(balanced.net_return_pct));
  assert.ok(balanced.max_favorable_return_pct >= 19.9);

  const fastMint = 'HolderGrowthFast111111111111111111111111111';
  recordToken(store, fastMint, base);
  now = base + 40_000;
  suite.onSnapshot(snapshot(fastMint, now, {
    buyers: 25, newBuyers: 22, retentionPct: 75, netFlowSol: 12, top3SharePct: 60,
  }));
  assert.strictEqual(suite.health().pendingEntries, 2,
    'Fast samples must create independent Balanced and Fast cohorts');
  now += 250;
  suite.observeTrade(curveTrade(fastMint, now, 1));
  now += 500;
  suite.observeTrade(curveTrade(fastMint, now, 0.79));
  now += 250;
  suite.observeTrade(curveTrade(fastMint, now, 0.78));
  const fastRows = store.db.prepare(`
    SELECT * FROM holder_growth_shadow_positions WHERE mint = ? ORDER BY cohort_id
  `).all(fastMint);
  assert.strictEqual(fastRows.length, 2);
  assert.ok(fastRows.every((row) => row.status === 'CLOSED'));
  assert.ok(fastRows.every((row) => row.exit_reason === 'HARD_STOP'));

  suite.onSnapshot(snapshot('replay-holder', now + 1_000, {
    buyers: 30, newBuyers: 25, retentionPct: 80, netFlowSol: 20, top3SharePct: 50,
  }), { replay: true });
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM holder_growth_shadow_positions').get().n,
    3,
    'startup replay must not create new research entries',
  );
  assert.strictEqual(suite.health().replayMatchesSuppressed, 2);

  const dashboard = store.holderGrowthShadowDashboard();
  assert.strictEqual(dashboard.cohorts.length, 2);
  assert.strictEqual(dashboard.positions.length, 3);
  assert.ok(dashboard.cohorts.every((row) => Number.isFinite(row.average_net_return_pct)));
  assert.strictEqual(suite.health().sendsTransactions, false);
  store.close();
  console.log('test-holder-growth-shadow: ok');
}

run();

function runEntryExitMatrix() {
  const base = 1_810_000_000_000;
  let now = base;
  const store = makeStore();
  const config = makeConfig();
  config.costModel.priorityFeeSol = 0.001;
  delete config.exitProfile;
  config.entryProfiles = [{
    id: 'HG10_OPEN', label: 'Early', horizonMs: 10_000,
    minBuyers: 5, minNewBuyers: 3, minRetentionPct: 30,
    minNetFlowSol: 1.5, maxTop3SharePct: 90,
  }];
  config.exitProfiles = [
    {
      id: 'X5_FIXED', label: '5s', exitMode: 'FIXED_HOLD', fixedHoldMs: 5_000,
      hardStopPct: 100, maxHoldMs: 5_000,
    },
    {
      id: 'XSTAIR_BAL', label: 'stair', exitMode: 'ADAPTIVE_TRAILING',
      hardStopPct: 20, maxHoldMs: 360_000,
      trailingTiers: [
        { activationPct: 20, drawdownPct: 10 },
        { activationPct: 40, drawdownPct: 15 },
      ],
    },
    {
      id: 'XSCALE_50_RUNNER', label: 'scale', exitMode: 'SCALE_RUNNER',
      hardStopPct: 20, scaleOutTriggerPct: 30, scaleOutFractionPct: 50,
      trailingActivationPct: 30, trailingStopPct: 20, maxHoldMs: 300_000,
    },
    {
      id: 'XP30_70_STAIR', label: 'scale adaptive', exitMode: 'SCALE_ADAPTIVE',
      hardStopPct: 20, scaleOutTriggerPct: 30, scaleOutFractionPct: 70,
      maxHoldMs: 300_000,
      trailingTiers: [
        { activationPct: 30, drawdownPct: 15 },
        { activationPct: 60, drawdownPct: 15 },
        { activationPct: 100, drawdownPct: 20 },
        { activationPct: 200, drawdownPct: 25 },
      ],
    },
    {
      id: 'XFLOW_60', label: 'flow', exitMode: 'FLOW_CHECK', hardStopPct: 20,
      flowCheckHorizonMs: 60_000, minBuyerVelocityRatio: 0.5,
      minNetFlowDeltaSol: 0, trailingActivationPct: 20,
      trailingStopPct: 15, maxHoldMs: 180_000,
    },
  ];
  const suite = new HolderGrowthShadowSuite({ config, store, now: () => now });
  suite.start();
  const early = (mint, overrides = {}) => snapshot(mint, now, {
    horizonMs: 10_000, buyers: 6, newBuyers: 4, retentionPct: 40,
    netFlowSol: 2, top3SharePct: 80, ...overrides,
  });
  const row = (mint, exitProfileId) => store.db.prepare(`
    SELECT * FROM holder_growth_shadow_positions
    WHERE mint = ? AND exit_profile_id = ?
  `).get(mint, exitProfileId);

  const fixedMint = 'HolderGrowthEarlyFixed1111111111111111111111';
  recordToken(store, fixedMint, base);
  now = base + 10_000;
  suite.onSnapshot(early(fixedMint));
  assert.strictEqual(suite.health().pendingEntries, 5,
    '10s relaxed entry must create one independent row per exit');
  now += 250;
  suite.observeTrade(curveTrade(fixedMint, now, 1));
  now += 5_250;
  suite.observeTrade(curveTrade(fixedMint, now, 1.1));
  assert.strictEqual(row(fixedMint, 'X5_FIXED').status, 'CLOSED');
  assert.strictEqual(row(fixedMint, 'X5_FIXED').exit_reason, 'FIXED_HOLD');

  const stairMint = 'HolderGrowthEarlyStair111111111111111111111';
  recordToken(store, stairMint, base);
  now = base + 20_000;
  suite.onSnapshot(early(stairMint));
  now += 250;
  suite.observeTrade(curveTrade(stairMint, now, 1));
  now += 500;
  suite.observeTrade(curveTrade(stairMint, now, 1.39));
  const tierOneStop = row(stairMint, 'XSTAIR_BAL').stop_price;
  assert.ok(tierOneStop > 1.25 && tierOneStop < 1.26);
  now += 500;
  suite.observeTrade(curveTrade(stairMint, now, 1.401));
  const upgraded = row(stairMint, 'XSTAIR_BAL');
  assert.strictEqual(upgraded.trailing_tier_index, 1);
  assert.ok(upgraded.stop_price >= tierOneStop,
    'a wider higher tier must never lower an already earned stop');
  now += 500;
  suite.observeTrade(curveTrade(stairMint, now, 1.24));
  now += 250;
  suite.observeTrade(curveTrade(stairMint, now, 1.23));
  assert.strictEqual(row(stairMint, 'XSTAIR_BAL').status, 'CLOSED');
  assert.match(row(stairMint, 'XSTAIR_BAL').exit_reason, /^STAIR_T2_/);

  const scaleMint = 'HolderGrowthEarlyScale111111111111111111111';
  recordToken(store, scaleMint, base);
  now = base + 30_000;
  suite.onSnapshot(early(scaleMint));
  now += 250;
  suite.observeTrade(curveTrade(scaleMint, now, 1));
  now += 500;
  suite.observeTrade(curveTrade(scaleMint, now, 1.3));
  now += 250;
  suite.observeTrade(curveTrade(scaleMint, now, 1.32));
  assert.strictEqual(row(scaleMint, 'XSCALE_50_RUNNER').scale_out_price, 1.32);
  now += 500;
  suite.observeTrade(curveTrade(scaleMint, now, 1.05));
  now += 250;
  suite.observeTrade(curveTrade(scaleMint, now, 1.04));
  const scaled = row(scaleMint, 'XSCALE_50_RUNNER');
  assert.strictEqual(scaled.status, 'CLOSED');
  assert.ok(Math.abs(scaled.gross_return_pct - 18) < 0.01,
    '50% scale at +32% plus 50% runner at +4% must realize +18%');
  assert.ok(Math.abs(scaled.net_return_pct - 17.8) < 0.01,
    'a filled partial exit must include its extra fixed execution cost');
  const adaptiveScaled = row(scaleMint, 'XP30_70_STAIR');
  assert.strictEqual(adaptiveScaled.status, 'CLOSED');
  assert.strictEqual(adaptiveScaled.trailing_tier_index, 0);
  assert.ok(Math.abs(adaptiveScaled.gross_return_pct - 23.6) < 0.01,
    '70% scale at +32% plus 30% runner at +4% must realize +23.6%');

  const flowMint = 'HolderGrowthEarlyFlow1111111111111111111111';
  recordToken(store, flowMint, base);
  now = base + 40_000;
  suite.onSnapshot(early(flowMint));
  now += 250;
  suite.observeTrade(curveTrade(flowMint, now, 1));
  now = base + 90_000;
  suite.onSnapshot(snapshot(flowMint, now, {
    horizonMs: 60_000, buyers: 7, newBuyers: 1, retentionPct: 40,
    netFlowSol: 1.5, top3SharePct: 80,
  }));
  let flow = row(flowMint, 'XFLOW_60');
  assert.strictEqual(flow.flow_check_status, 'FAIL');
  assert.strictEqual(flow.status, 'EXIT_PENDING');
  now += 250;
  suite.observeTrade(curveTrade(flowMint, now, 0.99));
  flow = row(flowMint, 'XFLOW_60');
  assert.strictEqual(flow.status, 'CLOSED');
  assert.strictEqual(flow.exit_reason, 'FLOW_DECAY_60S');

  assert.strictEqual(suite.health().exitProfiles.length, 5);
  assert.deepStrictEqual(suite.health().strategy.snapshotHorizonsMs, [10_000]);
  store.close();
  console.log('test-holder-growth-shadow matrix: ok');
}

runEntryExitMatrix();

function runForwardEntryBoundsAndMigrationExit() {
  const base = 1_820_000_000_000;
  let now = base;
  const store = makeStore();
  const config = makeConfig();
  config.entryProfiles = [{
    id: 'HG30_FLOW_EDGE', label: 'flow edge', horizonMs: 30_000,
    minBuyers: 5, minNewBuyers: 3, minRetentionPct: 30,
    minNetFlowSol: 10, maxTop3SharePct: 90,
    minEntryJumpPct: 0, maxEntryJumpPct: 2,
  }];
  config.exitProfile = {
    id: 'XT15_H120', label: 'test', exitMode: 'TRAILING',
    hardStopPct: 20, trailingActivationPct: 15,
    trailingStopPct: 15, maxHoldMs: 120_000,
  };
  const suite = new HolderGrowthShadowSuite({ config, store, now: () => now });
  suite.start();
  const rejectedMint = 'HolderGrowthJumpRejected1111111111111111111';
  recordToken(store, rejectedMint, base);
  now = base + 30_000;
  suite.onSnapshot(snapshot(rejectedMint, now, { netFlowSol: 12 }));
  now += 250;
  suite.observeTrade(curveTrade(rejectedMint, now, 0.99));
  const rejected = store.db.prepare(`
    SELECT * FROM holder_growth_shadow_positions WHERE mint = ?
  `).get(rejectedMint);
  assert.strictEqual(rejected.status, 'PRICE_JUMP');
  assert.match(rejected.rejection_reason, /^ENTRY_PRICE_OUTSIDE_0\.00_2\.00_/);

  const migratedMint = 'HolderGrowthMigratedExit11111111111111111111';
  recordToken(store, migratedMint, base);
  now = base + 40_000;
  suite.onSnapshot(snapshot(migratedMint, now, { netFlowSol: 12 }));
  now += 250;
  suite.observeTrade(curveTrade(migratedMint, now, 1.01));
  now += 500;
  suite.observeTrade(curveTrade(migratedMint, now, 0.79));
  let migrated = store.db.prepare(`
    SELECT * FROM holder_growth_shadow_positions WHERE mint = ?
  `).get(migratedMint);
  assert.strictEqual(migrated.status, 'EXIT_PENDING');
  now += 50;
  suite.onGraduated({ mint: migratedMint, graduatedAt: now });
  assert.deepStrictEqual(suite.trackedMints(), [migratedMint]);
  now += 250;
  suite.observeTrade(ammTrade(migratedMint, now, 0.8));
  migrated = store.db.prepare(`
    SELECT * FROM holder_growth_shadow_positions WHERE mint = ?
  `).get(migratedMint);
  assert.strictEqual(migrated.status, 'CLOSED');
  assert.strictEqual(migrated.exit_market, 'PUMP_AMM');
  assert.match(migrated.exit_reason, /MIGRATION_REROUTE$/);
  assert.deepStrictEqual(suite.trackedMints(), []);

  store.close();
  console.log('test-holder-growth-shadow bounds/migration: ok');
}

runForwardEntryBoundsAndMigrationExit();

