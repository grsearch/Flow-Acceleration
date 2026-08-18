'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { BigWinnerShadowSuite } = require('../src/core/BigWinnerShadowSuite');

function store() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
}

function config() {
  const pullback = (id, wave, drawMin, drawMax, net) => ({
    id, family: 'PULLBACK', minAgeMs: 5_000, maxAgeMs: 180_000,
    minFirstWavePct: wave, minPullbackPct: drawMin, maxPullbackPct: drawMax,
    minReboundPct: 2, maxReboundPct: 10, minNetFlow3sSol: net,
    minBuyers3s: 4, maxSingleSell3sSol: 10, minCurrentVsBaselinePct: -10,
  });
  const ratchet = (id, weight, stop) => ({
    id, coreActivationPct: 20, coreWeightPct: weight, hardStopPct: stop,
    trailingActivationPct: 30, baseTrailingDrawdownPct: 15,
    trailingTiers: [],
    profitFloors: [
      { activationPct: 50, lockPct: 20 }, { activationPct: 100, lockPct: 60 },
      { activationPct: 150, lockPct: 100 }, { activationPct: 250, lockPct: 170 },
    ],
    maxHoldMs: 300_000,
  });
  return {
    enabled: true, positionSizeSol: 1, stateWindowMs: 10_000,
    stateRetentionMs: 600_000, entryDelayMs: 200, entryTimeoutMs: 2_000,
    noExitGraceMs: 60_000, maxEntryPriceJumpPct: 50,
    maxEntryPriceDropPct: 50, maxEntryImpactPct: 40, maxAdjacentPriceRatio: 20,
    entryProfiles: [
      pullback('PBR_A', 40, 12, 25, 3),
      pullback('PBR_B', 50, 18, 30, 2),
      pullback('PBR_C', 40, 15, 25, 2),
      {
        id: 'FLOW_R', family: 'FLOW', minAgeMs: 5_000, maxAgeMs: 60_000,
        minNetFlow8sSol: 20, minBuyers8s: 12, maxLargestBuyerShare8s: 0.5,
        maxRunupPct: 40, maxDistanceFromHigh10sPct: 10, maxJump2sPct: 20,
        minRecentFlowRatio: 0.5,
      },
    ],
    exitProfiles: [
      {
        id: 'X50_15', coreActivationPct: 20, coreWeightPct: 50, hardStopPct: 15,
        trailingActivationPct: 30, baseTrailingDrawdownPct: 15,
        trailingTiers: [
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
        ],
        profitFloors: [], maxHoldMs: 180_000,
      },
      {
        id: 'X50_12', coreActivationPct: 20, coreWeightPct: 50, hardStopPct: 12,
        trailingActivationPct: 30, baseTrailingDrawdownPct: 15,
        trailingTiers: [
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
        ],
        profitFloors: [], maxHoldMs: 180_000,
      },
      ratchet('X50_RATCHET', 50, 15),
      ratchet('X40_RATCHET', 40, 15),
      {
        id: 'XFIX60_H15', mode: 'FIXED_HOLD', coreWeightPct: 0,
        hardStopPct: 15, trailingTiers: [], profitFloors: [], maxHoldMs: 60_000,
      },
      {
        id: 'XFIX120_H15', mode: 'FIXED_HOLD', coreWeightPct: 0,
        hardStopPct: 15, trailingTiers: [], profitFloors: [], maxHoldMs: 120_000,
      },
    ],
    costModel: {
      platformFeePct: 3.2, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0, priorityFeeSol: 0,
      jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 1,
      entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
}

function run() {
  const db = store();
  const base = 1_900_100_000_000;
  let now = base;
  const suite = new BigWinnerShadowSuite({ config: config(), store: db, now: () => now });
  suite.start();
  let sequence = 0;
  const emit = (mint, origin, offset, side, sol, wallet, price) => {
    sequence += 1;
    now = origin + offset;
    suite.observeTrade({
      mint, symbol: 'BW', timestampMs: now, market: 'PUMP_AMM', side,
      solAmount: sol, tokenAmount: sol / price, wallet, price, reservePrice: price,
      signature: `bw-${sequence}`, eventIndex: 0,
    });
  };

  const pullMint = 'BigWinnerPullback111111111111111111111111111';
  suite.onGraduated({ mint: pullMint, migratedAt: base, symbol: 'PBR' });
  emit(pullMint, base, 0, 'BUY', 0.1, 'seed', 1);
  emit(pullMint, base, 1_000, 'BUY', 0.1, 'peak', 1.7);
  emit(pullMint, base, 2_000, 'SELL', 0.1, 'seller', 1.3);
  emit(pullMint, base, 3_200, 'BUY', 1, 'buyer-1', 1.305);
  emit(pullMint, base, 3_800, 'BUY', 1, 'buyer-2', 1.31);
  emit(pullMint, base, 4_400, 'BUY', 1, 'buyer-3', 1.315);
  emit(pullMint, base, 5_000, 'BUY', 1, 'buyer-4', 1.326);
  assert.strictEqual(suite.health().pendingEntries, 18,
    'three pullback entries must each create four runner exits and two fixed-hold exits');
  emit(pullMint, base, 5_250, 'BUY', 0.2, 'fill', 1.326);
  assert.strictEqual(suite.health().activePositions, 18);
  emit(pullMint, base, 5_500, 'BUY', 1, 'core', 1.61);
  emit(pullMint, base, 6_000, 'BUY', 1, 'runner', 2.2);
  emit(pullMint, base, 6_500, 'SELL', 1, 'profit', 1.84);
  const pullRows = db.db.prepare(`
    SELECT * FROM big_winner_shadow_positions WHERE mint=? ORDER BY cohort_id
  `).all(pullMint);
  assert.strictEqual(pullRows.length, 18);
  assert.strictEqual(pullRows.filter((row) => row.status === 'CLOSED').length, 12);
  assert.ok(pullRows.filter((row) => !row.exit_profile_id.startsWith('XFIX'))
    .every((row) => row.core_exit_at != null && row.net_return_pct > 0));
  assert.ok(pullRows.filter((row) => row.exit_profile_id.startsWith('XFIX'))
    .every((row) => row.status === 'OPEN' && !row.core_exit_at));
  emit(pullMint, base, 65_500, 'BUY', 1, 'fixed-60-exit', 3.5);
  emit(pullMint, base, 125_500, 'BUY', 1, 'fixed-120-exit', 5);
  const fixedRows = db.db.prepare(`
    SELECT * FROM big_winner_shadow_positions
    WHERE mint=? AND exit_profile_id LIKE 'XFIX%' ORDER BY exit_profile_id
  `).all(pullMint);
  assert.ok(fixedRows.every((row) => row.status === 'CLOSED'
    && row.exit_reason === 'MAX_HOLD' && !row.core_exit_at && row.net_return_pct > 100));

  const flowBase = base + 100_000;
  const flowMint = 'BigWinnerFlow1111111111111111111111111111111';
  suite.onGraduated({ mint: flowMint, migratedAt: flowBase, symbol: 'FLOW' });
  emit(flowMint, flowBase, 0, 'BUY', 0.1, 'seed-flow', 1);
  for (let index = 0; index < 11; index += 1) {
    emit(flowMint, flowBase, 1_000 + index * 400, 'BUY', 2, `flow-${index}`, 1.1 + index * 0.008);
  }
  assert.strictEqual(suite.health().pendingEntries, 6,
    'FLOW-R must create four runner exits and two fixed-hold exits');
  emit(flowMint, flowBase, 5_250, 'BUY', 0.2, 'flow-fill', 1.19);
  assert.strictEqual(suite.health().activePositions, 6);
  now = flowBase + 370_000;
  suite.advanceTime(now);
  const censored = db.db.prepare(`
    SELECT status, net_return_pct FROM big_winner_shadow_positions WHERE mint=?
  `).all(flowMint);
  assert.ok(censored.every((row) => row.status === 'NO_EXIT'));
  assert.ok(censored.every((row) => row.net_return_pct == null),
    'NO_EXIT must remain censored instead of becoming a -100% return');

  const dashboard = suite.dashboard();
  assert.strictEqual(dashboard.cohorts.length, 24);
  assert.strictEqual(db.shadowTimeSessionDashboard('big-winner').sessions.length, 4);
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n, 0,
    'Big Winner Shadow must never create a live position');
  db.close();
  console.log('big winner shadow tests passed');
}

run();

function runParticipation() {
  const db = store();
  const base = 1_900_200_000_000;
  let now = base;
  const cfg = config();
  const baseProfile = {
    family: 'PARTICIPATION', minAgeMs: 10_000, maxAgeMs: 60_000,
    qualificationMaxAgeMs: 30_000,
    minTrades10s: 40, minBuyers10s: 20, minNetFlow10sSol: 3,
    maxLargestBuyerShare10s: 0.55, minRecentBuyers5s: 8,
    minRecentNetFlow5sSol: 0, minRecentFlowRetentionRatio: 0.35,
    exitProfileIds: ['XFIX120_H15_PP'], capacityAware: true,
    positionSols: [0.05, 0.1, 0.25],
  };
  cfg.entryProfiles = [
    { id: 'PP_DIRECT_10', mode: 'DIRECT', ...baseProfile },
    {
      id: 'PP_PULLBACK_8_20', mode: 'PULLBACK', ...baseProfile,
      minPullbackPct: 8, maxPullbackPct: 20,
      minReboundPct: 2, maxReboundPct: 8,
      minNetFlow3sSol: 2, minBuyers3s: 4, requireFlowAcceleration: true,
    },
  ];
  cfg.exitProfiles = [{
    id: 'XFIX120_H15_PP', entryProfileIds: ['PP_DIRECT_10', 'PP_PULLBACK_8_20'],
    mode: 'FIXED_HOLD', coreWeightPct: 0, hardStopPct: 15,
    trailingTiers: [], profitFloors: [], maxHoldMs: 120_000,
  }];
  const suite = new BigWinnerShadowSuite({ config: cfg, store: db, now: () => now });
  suite.start();
  const mint = 'ParticipationPersistence111111111111111111111111';
  suite.onGraduated({ mint, migratedAt: base, symbol: 'PP' });
  let sequence = 0;
  const emit = (offset, side, sol, wallet, price) => {
    now = base + offset;
    sequence += 1;
    suite.observeTrade({
      mint, symbol: 'PP', timestampMs: now, market: 'PUMP_AMM', side,
      solAmount: sol, tokenAmount: sol / price, wallet, price, reservePrice: price,
      signature: `pp-${sequence}`, eventIndex: 0,
    });
  };
  for (let index = 0; index < 40; index += 1) {
    emit(250 + index * 250, 'BUY', 0.2, `buyer-${index % 20}`, 1 + index * 0.001);
  }
  assert.strictEqual(suite.health().pendingEntries, 3,
    'direct participation confirmation must create one row per capacity');
  emit(10_250, 'BUY', 0.2, 'direct-fill', 1.04);
  emit(11_000, 'BUY', 0.2, 'peak-after-quality', 1.4);
  emit(12_000, 'SELL', 0.2, 'healthy-pullback', 1.15);
  emit(12_200, 'BUY', 2, 'reaccel-1', 1.155);
  emit(12_400, 'BUY', 2, 'reaccel-2', 1.16);
  emit(12_600, 'BUY', 2, 'reaccel-3', 1.17);
  emit(12_800, 'BUY', 2, 'reaccel-4', 1.18);
  assert.strictEqual(suite.health().pendingEntries, 3,
    'pullback profile must wait for a fresh executable fill');
  emit(13_050, 'BUY', 0.2, 'pullback-fill', 1.185);
  const rows = db.db.prepare(`
    SELECT entry_profile_id, position_sol, status
    FROM big_winner_shadow_positions WHERE mint=? ORDER BY cohort_id
  `).all(mint);
  assert.strictEqual(rows.length, 6);
  assert.deepStrictEqual(
    [...new Set(rows.map((row) => row.position_sol))],
    [0.05, 0.1, 0.25],
  );
  assert.ok(rows.every((row) => row.status === 'OPEN'));
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n, 0);
  db.close();
  console.log('big winner participation tests passed');
}

runParticipation();
