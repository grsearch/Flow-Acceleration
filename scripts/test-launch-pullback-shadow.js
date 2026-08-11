'use strict';

const assert = require('assert');
const { LaunchPullbackShadowSuite } = require('../src/core/LaunchPullbackShadowSuite');
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

function makeConfig({ withTrailing = false } = {}) {
  return {
    enabled: true,
    positionSizeSol: 0.05,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 10,
    bigWinnerPct: 50,
    profiles: [
      { id: 'F1', label: 'F1', minNetFlowSol: 15, maxCreatorSharePct: 5 },
      { id: 'F2', label: 'F2', minNetFlowSol: 20, maxCreatorSharePct: 10 },
      { id: 'F3', label: 'F3', minNetFlowSol: 20, maxCreatorSharePct: 20 },
    ],
    holds: [
      { id: '3S', label: '3s', fixedHoldMs: 3_000 },
      { id: '8S', label: '8s', fixedHoldMs: 8_000 },
    ],
    trailingCohorts: withTrailing ? [
      {
        id: 'FT_A', label: 'FT-A', profileId: 'F2', trailingActivationPct: 0,
        trailingDrawdownPct: 20, minHoldMs: 3_000, maxHoldMs: 120_000,
        hardStopPct: null,
      },
      {
        id: 'FT_B', label: 'FT-B', profileId: 'F1', trailingActivationPct: 10,
        trailingDrawdownPct: 20, minHoldMs: 3_000, maxHoldMs: 120_000,
        hardStopPct: 30,
      },
      {
        id: 'FT_C', label: 'FT-C', profileId: 'F2', trailingActivationPct: 30,
        trailingDrawdownPct: 20, minHoldMs: 0, maxHoldMs: 120_000,
        hardStopPct: 30,
      },
      {
        id: 'FT_D', label: 'FT-D', profileId: 'F1', trailingActivationPct: 30,
        trailingDrawdownPct: 15, minHoldMs: 3_000, maxHoldMs: 120_000,
        hardStopPct: 30,
      },
    ] : [],
    costModel: {
      platformFeePct: 1.4,
      buySlippagePct: 0.3,
      sellSlippagePct: 0.3,
      priceImpactPct: 0.2,
      baseTxFeeSol: 0.00001,
      priorityFeeSol: 0.0005,
      jitoTipSol: 0,
      fixedCostSol: 0,
      positionSizeSol: 0.05,
    },
  };
}

function testTrailingCohorts() {
  const store = makeStore();
  let now = 1_000_000;
  const suite = new LaunchPullbackShadowSuite({
    config: makeConfig({ withTrailing: true }),
    store,
    now: () => now,
  });
  suite.start();
  suite.onReference(reference('trail', now));
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions WHERE mint = 'trail'").get().n,
    10,
    'six historical cohorts and four new trailing cohorts must coexist',
  );

  suite.observeTrade(trade('trail', now + 200, 1));
  suite.observeTrade(trade('trail', now + 1_000, 1.5));
  suite.observeTrade(trade('trail', now + 2_500, 1.1));
  assert.strictEqual(
    store.db.prepare("SELECT status FROM launch_pullback_shadow_positions WHERE cohort_id = 'FT_C' AND mint = 'trail'").get().status,
    'EXIT_PENDING',
    'FT-C should trail immediately once its +30% activation was reached',
  );
  assert.strictEqual(
    store.db.prepare("SELECT status FROM launch_pullback_shadow_positions WHERE cohort_id = 'FT_A' AND mint = 'trail'").get().status,
    'OPEN',
    'FT-A must respect its three-second minimum hold',
  );
  suite.observeTrade(trade('trail', now + 2_700, 1.08));
  suite.observeTrade(trade('trail', now + 3_200, 1.1));
  suite.observeTrade(trade('trail', now + 3_400, 1.08));
  const exits = store.db.prepare(`
    SELECT cohort_id, status, exit_reason FROM launch_pullback_shadow_positions
    WHERE mint = 'trail' AND cohort_id LIKE 'FT_%' ORDER BY cohort_id
  `).all();
  assert.deepStrictEqual(exits.map((row) => row.status), ['CLOSED', 'CLOSED', 'CLOSED', 'CLOSED']);
  assert.ok(exits.every((row) => row.exit_reason.startsWith('TRAILING_DRAWDOWN_')));

  now = 2_000_000;
  suite.onReference(reference('hard-stop', now));
  suite.observeTrade(trade('hard-stop', now + 200, 1));
  suite.observeTrade(trade('hard-stop', now + 500, 0.69));
  suite.observeTrade(trade('hard-stop', now + 700, 0.68));
  const hardStops = store.db.prepare(`
    SELECT cohort_id, status, exit_reason FROM launch_pullback_shadow_positions
    WHERE mint = 'hard-stop' AND cohort_id LIKE 'FT_%' ORDER BY cohort_id
  `).all();
  assert.strictEqual(hardStops.find((row) => row.cohort_id === 'FT_A').status, 'OPEN');
  assert.ok(hardStops.filter((row) => row.cohort_id !== 'FT_A').every((row) => (
    row.status === 'CLOSED' && row.exit_reason === 'HARD_STOP_30PCT'
  )));

  now = 3_000_000;
  suite.onReference(reference('max-hold', now));
  suite.observeTrade(trade('max-hold', now + 200, 1));
  suite.advanceTime(now + 120_200);
  suite.observeTrade(trade('max-hold', now + 120_400, 1.1));
  const maxHold = store.db.prepare(`
    SELECT status, exit_reason FROM launch_pullback_shadow_positions
    WHERE mint = 'max-hold' AND cohort_id = 'FT_A'
  `).get();
  assert.deepStrictEqual(maxHold, { status: 'CLOSED', exit_reason: 'MAX_HOLD_120S' });
  assert.strictEqual(suite.health().sendsTransactions, false);
  store.close();
}

function reference(mint, at, netFlowSol = 20, creatorSharePct = 4) {
  return {
    mint,
    symbol: mint.toUpperCase(),
    createdAt: at - 10_000,
    referenceAt: at,
    referencePrice: 1,
    pump25At: at - 3_000,
    referencePeakAt: at - 2_000,
    referencePeakPrice: 1.2,
    firstPullbackAt: at - 1_000,
    pullbackLowPrice: 0.9,
    maxPullbackPct: 25,
    features: {
      netFlowSol,
      creatorSharePct,
      buyers: 20,
      recentBuyers: 8,
      retentionPct: 70,
      top1SharePct: 12,
      top3SharePct: 28,
    },
  };
}

function trade(mint, timestampMs, price) {
  return {
    mint,
    timestampMs,
    market: 'PUMP_BONDING_CURVE',
    side: 'BUY',
    price,
    reservePrice: price,
  };
}

function main() {
  const store = makeStore();
  let now = 100_000;
  const suite = new LaunchPullbackShadowSuite({
    config: makeConfig(),
    store,
    now: () => now,
  });
  suite.start();
  suite.onReference(reference('winner', now));
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions').get().n,
    6,
  );
  suite.observeTrade(trade('winner', now + 199, 1.01));
  assert.strictEqual(suite.health().opened, 0);
  suite.observeTrade(trade('winner', now + 200, 1.02));
  assert.strictEqual(suite.health().opened, 6);

  suite.observeTrade(trade('winner', now + 3_200, 1.18));
  suite.observeTrade(trade('winner', now + 3_400, 1.20));
  assert.strictEqual(suite.health().closed, 3);
  suite.observeTrade(trade('winner', now + 8_200, 1.28));
  suite.observeTrade(trade('winner', now + 8_400, 1.30));
  assert.strictEqual(suite.health().closed, 6);

  let dashboard = store.launchPullbackShadowDashboard({ bigWinnerPct: 20 });
  assert.strictEqual(dashboard.cohorts.length, 6);
  assert.ok(dashboard.cohorts.every((cohort) => cohort.resolved === 1));
  assert.ok(dashboard.cohorts.every((cohort) => cohort.average_net_return_pct > 0));
  assert.ok(dashboard.cohorts.every((cohort) => cohort.independent_mints === 1));

  now = 200_000;
  suite.onReference(reference('rejected', now, 10, 0));
  assert.strictEqual(
    store.db.prepare(`
      SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions
      WHERE mint = 'rejected' AND status = 'RULE_REJECTED'
    `).get().n,
    6,
  );

  now = 300_000;
  suite.onReference(reference('jump', now, 25, 2));
  suite.observeTrade(trade('jump', now + 200, 1.2));
  assert.strictEqual(
    store.db.prepare(`
      SELECT COUNT(*) AS n FROM launch_pullback_shadow_positions
      WHERE mint = 'jump' AND status = 'PRICE_JUMP'
    `).get().n,
    6,
  );

  now = 400_000;
  suite.onReference(reference('restore', now, 25, 2));
  suite.observeTrade(trade('restore', now + 200, 1.01));
  suite.stop();
  const restored = new LaunchPullbackShadowSuite({
    config: makeConfig(),
    store,
    now: () => now + 500,
  });
  restored.start();
  assert.strictEqual(restored.health().activePositions, 6);

  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n,
    0,
    'shadow F must never create live positions',
  );
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM flow_first_shadow_positions').get().n,
    0,
    'shadow F must remain isolated from old strategy tables',
  );
  assert.strictEqual(restored.health().sendsTransactions, false);
  dashboard = store.launchPullbackShadowDashboard();
  assert.ok(dashboard.positions.some((row) => row.mint === 'restore'));
  store.close();
  console.log('test-launch-pullback-shadow: ok');
}

main();
testTrailingCohorts();
