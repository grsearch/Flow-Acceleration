'use strict';

const assert = require('assert');
const { QualityLeaderShadowSuite } = require('../src/core/QualityLeaderShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 0 });
}

function makeConfig() {
  return {
    enabled: true,
    positionSizeSol: 1,
    snapshot10Ms: 10_000,
    snapshot20Ms: 20_000,
    maxSnapshotLagMs: 2_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 30_000,
    maxEntryPriceJumpPct: 20,
    maxEntryPriceDropPct: 20,
    hardStopPct: 20,
    strengthActivationPct: 20,
    noStrengthMs: 30_000,
    maxHoldMs: 300_000,
    maxPlausibleReturnPct: 5_000,
    entryProfiles: [
      {
        id: 'QL_STRICT', minReturn10Pct: 140, maxDrawdown20Pct: 12,
        minBuyerDelta: 8, minNetFlowDeltaSol: 3, minRetentionPct: 80,
        maxCreatorSharePct: 3, minCurvePct: 55, maxCurvePct: 90,
        maxSellBuyRatio: 0.55, minVirtualSolReserves: 30,
        exitProfileIds: ['QL_BARBELL', 'QL_PROTECTED'],
      },
      {
        id: 'QL_BROAD', minReturn10Pct: 140, maxDrawdown20Pct: 12,
        minBuyerDelta: 8, minNetFlowDeltaSol: 3, minRetentionPct: 60,
        maxCreatorSharePct: 3, minCurvePct: 55, maxCurvePct: 90,
        maxSellBuyRatio: 0.55, minVirtualSolReserves: 30,
        exitProfileIds: ['QL_BARBELL'],
      },
    ],
    exitProfiles: [
      {
        id: 'QL_BARBELL', mode: 'BARBELL', scale1TriggerPct: 20,
        scale1FractionPct: 33, scale2TriggerPct: 100, scale2FractionPct: 17,
      },
      { id: 'QL_PROTECTED', mode: 'PROTECTED_RUNNER' },
    ],
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
    mint, symbol: 'QL', name: null, uri: null, bondingCurve: null,
    creator: 'creator', createdAt, initialRealTokenReservesRaw: null,
    tokenTotalSupplyRaw: null,
  });
}

function snapshot(mint, horizonMs, observedAt, overrides = {}) {
  return {
    mint, horizonMs, observedAt, observationLagMs: 0, price: 1,
    priceReturnPct: horizonMs === 10_000 ? 150 : 145,
    drawdownPct: horizonMs === 20_000 ? 8 : 0,
    buyers: horizonMs === 10_000 ? 12 : 22,
    buyTx: horizonMs === 10_000 ? 14 : 25,
    sellTx: horizonMs === 10_000 ? 2 : 8,
    netFlowSol: horizonMs === 10_000 ? 5 : 9,
    retentionPct: 85, creatorSharePct: 2, curvePct: 70,
    virtualSolReserves: 40,
    ...overrides,
  };
}

function trade(mint, timestampMs, price, market = 'PUMP_BONDING_CURVE') {
  return { mint, timestampMs, market, price, reservePrice: price };
}

function run() {
  const store = makeStore();
  const base = 1_900_000_000_000;
  let now = base;
  const suite = new QualityLeaderShadowSuite({ config: makeConfig(), store, now: () => now });
  suite.start();

  const mint = 'QualityLeader111111111111111111111111111111';
  recordToken(store, mint, base);
  suite.onSnapshot(snapshot(mint, 10_000, base + 10_000));
  suite.onSnapshot(snapshot(mint, 20_000, base + 20_000));
  assert.strictEqual(suite.health().pendingEntries, 3,
    'strict barbell, strict protected and broad barbell must remain independent');
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n, 0,
    'Quality Leader must never create live positions');

  now = base + 20_250;
  suite.observeTrade(trade(mint, now, 1));
  assert.strictEqual(suite.health().activePositions, 3);
  now += 100;
  suite.observeTrade(trade(mint, now, 1.21));
  now += 250;
  suite.observeTrade(trade(mint, now, 1.22));
  now += 100;
  suite.observeTrade(trade(mint, now, 2.05));
  now += 250;
  suite.observeTrade(trade(mint, now, 2.1));
  now += 100;
  suite.observeTrade(trade(mint, now, 3.2));
  now += 100;
  suite.observeTrade(trade(mint, now, 2.4));
  now += 250;
  suite.observeTrade(trade(mint, now, 2.35));

  const rows = store.db.prepare(`
    SELECT * FROM quality_leader_shadow_positions WHERE mint = ? ORDER BY cohort_id
  `).all(mint);
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every((row) => row.status === 'CLOSED'));
  assert.ok(rows.filter((row) => row.exit_profile_id === 'QL_BARBELL')
    .every((row) => row.partial_stage === 2));
  assert.ok(rows.every((row) => row.net_return_pct > 80));

  const migrationMint = 'QualityLeaderMigration111111111111111111111111';
  recordToken(store, migrationMint, base);
  now = base + 40_000;
  suite.onSnapshot(snapshot(migrationMint, 10_000, now - 10_000));
  suite.onSnapshot(snapshot(migrationMint, 20_000, now));
  now += 250;
  suite.observeTrade(trade(migrationMint, now, 1));
  now += 100;
  suite.observeTrade(trade(migrationMint, now, 1.5));
  suite.onGraduated({ mint: migrationMint, migratedAt: now + 10 });
  now += 250;
  suite.observeTrade(trade(migrationMint, now, 100, 'PUMP_AMM'));
  const normalized = store.db.prepare(`
    SELECT amm_price_scale, max_favorable_return_pct
    FROM quality_leader_shadow_positions WHERE mint = ? LIMIT 1
  `).get(migrationMint);
  assert.ok(normalized.amm_price_scale < 0.02,
    'first AMM price must be normalized to the last curve boundary');
  assert.ok(normalized.max_favorable_return_pct < 100,
    'cross-market scale must not create a fake huge winner');

  const dashboard = store.qualityLeaderShadowDashboard();
  assert.strictEqual(dashboard.cohorts.length, 3);
  assert.strictEqual(store.shadowTimeSessionDashboard('quality-leader').sessions.length, 4);
  store.close();
  console.log('quality leader shadow tests passed');
}

run();
