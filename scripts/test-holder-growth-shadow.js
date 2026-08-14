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
