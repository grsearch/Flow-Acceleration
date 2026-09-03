'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  SmartWalletConsensusFlowRunnerShadowSuite,
} = require('../src/core/SmartWalletConsensusFlowRunnerShadowSuite');

function main() {
  const base = 1_910_000_000_000;
  let now = base;
  let sequence = 0;
  const wallets = new Map([
    ['holder-a', 'cluster-a'],
    ['holder-b', 'cluster-b'],
    ['holder-c', 'cluster-c'],
    ['holder-d', 'cluster-d'],
  ]);
  const snapshot = (wallet) => wallets.has(wallet) ? {
    wallet,
    clusterId: wallets.get(wallet),
    status: 'ACTIVE',
    selectionGrade: 'S_B',
    copyGrade: 'C_B',
    holdingGrade: 'H_A',
    selectionWeight: 1,
    voteWeight: 1,
    registryVersion: 7,
    effectiveFrom: base - 60_000,
    votingEligible: true,
  } : null;
  const registry = {
    cachedWalletSnapshot: snapshot,
    walletSnapshot: snapshot,
    cachedMonitoringSnapshot: snapshot,
    monitoringSnapshot: snapshot,
    activeClusterCounts: () => ({ eligible: 4, selectionA: 0 }),
  };
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const costModel = {
    platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
    baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
    positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
  };
  const config = {
    enabled: true,
    positionSizeSol: 1,
    probationVoteWeight: 1,
    enforceAGradeAfterClusters: 12,
    stateRetentionMs: 24 * 60 * 60_000,
    maxRestoredHoldingRows: 1_000,
    episodeCooldownMs: 30_000,
    entryDelayMs: 100,
    entryTimeoutMs: 1_000,
    exitDelayMs: 100,
    exitTimeoutMs: 1_000,
    maxScoutWaitMs: 10_000,
    maxFlowWaitMs: 10_000,
    flowWindowMs: 2_000,
    minFlowNetSol: 0.1,
    minFlowBuyers: 3,
    minFlowBuyTx: 3,
    strictMinFlowNetSol: 1,
    strictMinFlowNetSharePct: 3,
    strictMaxFlowConfirmationDelayMs: 1_000,
    dynamicThresholds: [{ maxEligibleClusters: 10, ordinary: 2, strong: 3 }],
    entryProfiles: [{
      id: 'POST_GRAD_HOLD3_FLOW2_60',
      strength: 'HOLDING_STRONG',
      postGraduationHoldingConsensus: true,
      requiredHoldingClusters: 3,
      minWeightedScoreRatio: 0.5,
      cumulativePostGraduationFlow: true,
      flowWindowMs: 60_000,
      maxFlowWaitMs: 60_000,
      minFlowNetSol: 0,
      minFlowBuyers: 2,
      minFlowBuyTx: 2,
      requirePositiveFlow: true,
      requireFlowAcceleration: false,
      entryDelayMs: 100,
      entryTimeoutMs: 30_000,
      scoutFraction: 0,
      exitProfileIds: ['CORE80_RUNNER30M'],
    }],
    exitProfiles: [{
      id: 'CORE80_RUNNER30M', mode: 'CORE_RUNNER',
      coreActivationPct: 30, coreFraction: 0.8, runnerTrailPct: 30,
      maxHoldMs: 30 * 60_000, hardStopPct: 20, exitTimeoutMs: 30_000,
      entryProfileIds: ['POST_GRAD_HOLD3_FLOW2_60'],
    }],
    costModel,
  };
  const recordToken = (mint, symbol) => store.recordCreate({
    mint, symbol, name: null, uri: null, bondingCurve: null, creator: 'creator',
    createdAt: base - 10_000, initialRealTokenReservesRaw: null,
    tokenTotalSupplyRaw: null,
  });

  const restoreMint = 'RestoreHoldingConsensus1111111111111111111111';
  recordToken(restoreMint, 'RESTORE');
  for (const [index, wallet] of ['holder-a', 'holder-b', 'holder-c'].entries()) {
    store.recordSmartWalletEvent({
      mint: restoreMint, wallet, side: 'BUY', market: 'PUMP_BONDING_CURVE',
      solAmount: 1, tokenAmount: 1_000, price: 0.001,
      timestampMs: base - 3_000 + index, receivedAtMs: base - 3_000 + index,
      signature: `restore-${index}`, eventIndex: 0,
    });
  }

  const suite = new SmartWalletConsensusFlowRunnerShadowSuite({
    config, store, registry, now: () => now,
  });
  suite.start();
  assert.strictEqual(suite.health().restoredSmartHoldings, 3);
  assert(suite.trackedMints().includes(restoreMint),
    'three restored holder clusters must keep the mint subscribed for first AMM');

  const positionEvent = (mint, wallet, offset, balance) => {
    now = base + offset;
    return suite.onSmartWalletPositionEvent({
      id: ++sequence, mint, wallet, timestampMs: now,
      side: balance > 0 ? 'BUY' : 'SELL',
      positionPhase: balance > 0 ? 'OPEN' : 'CLOSE',
      tokenBalanceAfter: balance,
    }, { walletSnapshot: snapshot(wallet) });
  };
  const trade = (mint, offset, side, wallet, quoteSol = 1_000) => {
    now = base + offset;
    const row = {
      mint, timestampMs: now, receivedAtMs: now,
      market: 'PUMP_AMM', side, wallet,
      solAmount: 0.5, tokenAmount: 500,
      price: quoteSol / 1_000_000,
      reservePrice: quoteSol / 1_000_000,
      signature: `post-grad-${++sequence}`, eventIndex: 0,
      poolBaseReservesRaw: '1000000000000',
      poolQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
      virtualQuoteReservesRaw: '0',
    };
    suite.observeTrade(row);
    return row;
  };

  const mint = 'PostGradHoldingConsensus111111111111111111111';
  recordToken(mint, 'HOLD3');
  positionEvent(mint, 'holder-a', 100, 1_000);
  positionEvent(mint, 'holder-b', 200, 1_000);
  positionEvent(mint, 'holder-c', 300, 1_000);
  now = base + 1_000;
  suite.onGraduated({ mint, graduatedAt: now, migratedAt: now });
  trade(mint, 3_000, 'BUY', 'public-1');
  let evaluation = store.db.prepare(`
    SELECT * FROM smart_wallet_post_grad_holding_evaluations WHERE mint=?
  `).get(mint);
  assert.strictEqual(evaluation.status, 'QUALIFIED');
  assert.strictEqual(evaluation.distinct_clusters, 3);
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE mint=?
  `).get(mint).status, 'WAITING_FLOW');

  trade(mint, 3_200, 'BUY', 'public-2');
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE mint=?
  `).get(mint).status, 'SCALE_PENDING');
  trade(mint, 3_400, 'BUY', 'public-entry');
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE mint=?
  `).get(mint).status, 'OPEN');
  trade(mint, 3_600, 'BUY', 'public-rise', 1_400);
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE mint=?
  `).get(mint).status, 'RUNNER');
  trade(mint, 3_800, 'SELL', 'public-fall', 900);
  trade(mint, 4_000, 'BUY', 'public-exit', 900);
  const closed = store.db.prepare(`
    SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE mint=?
  `).get(mint);
  assert.strictEqual(closed.status, 'CLOSED');
  assert.strictEqual(closed.exit_reason, 'RUNNER_TRAIL');
  assert.strictEqual(closed.entry_tx_count, 1);
  assert.strictEqual(closed.exit_tx_count, 2);

  const soldMint = 'PostGradSoldBeforeMigration111111111111111111';
  recordToken(soldMint, 'SOLD');
  positionEvent(soldMint, 'holder-a', 5_100, 1_000);
  positionEvent(soldMint, 'holder-b', 5_200, 1_000);
  positionEvent(soldMint, 'holder-c', 5_300, 1_000);
  positionEvent(soldMint, 'holder-c', 5_400, 0);
  now = base + 6_000;
  suite.onGraduated({ mint: soldMint, graduatedAt: now, migratedAt: now });
  trade(soldMint, 6_000, 'BUY', 'public-1');
  evaluation = store.db.prepare(`
    SELECT * FROM smart_wallet_post_grad_holding_evaluations WHERE mint=?
  `).get(soldMint);
  assert.strictEqual(evaluation.status, 'REJECTED');
  assert.strictEqual(evaluation.rejection_reason, 'HOLDING_CLUSTERS_LT_3');
  assert.strictEqual(evaluation.distinct_clusters, 2,
    'a wallet that closed before migration must not retain a vote');
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE mint=?
  `).get(soldMint).n, 0);

  const staleMint = 'PostGradMissedFirstAmm11111111111111111111111';
  recordToken(staleMint, 'STALE');
  positionEvent(staleMint, 'holder-a', 7_100, 1_000);
  positionEvent(staleMint, 'holder-b', 7_200, 1_000);
  positionEvent(staleMint, 'holder-c', 7_300, 1_000);
  now = base + 8_000;
  store.recordMigration({
    mint: staleMint, migratedAt: now, timestampMs: now,
    migrationSource: 'FIRST_AMM_OBSERVED',
  });
  trade(staleMint, 8_000, 'BUY', 'public-late');
  evaluation = store.db.prepare(`
    SELECT * FROM smart_wallet_post_grad_holding_evaluations WHERE mint=?
  `).get(staleMint);
  assert.strictEqual(evaluation.status, 'REJECTED');
  assert.strictEqual(evaluation.rejection_reason, 'FIRST_AMM_EVENT_MISSED');

  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);
  assert.strictEqual(suite.health().holdingConsensusQualified, 1);
  assert.strictEqual(suite.health().holdingConsensusRejected, 2);
  suite.stop();
  store.close();
  console.log('Post-graduation holding consensus Shadow tests: PASS');
}

main();
