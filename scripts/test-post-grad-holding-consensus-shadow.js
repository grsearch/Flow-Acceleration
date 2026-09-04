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
    ['holding-only-a', 'holding-cluster-a'],
    ['holding-only-b', 'holding-cluster-b'],
    ['holding-only-c', 'holding-cluster-c'],
  ]);
  const monitoringSnapshot = (wallet) => {
    if (!wallets.has(wallet)) return null;
    const holdingOnly = wallet.startsWith('holding-only-');
    return {
      wallet,
      clusterId: wallets.get(wallet),
      status: 'ACTIVE',
      selectionGrade: holdingOnly ? 'S_C' : 'S_B',
      copyGrade: holdingOnly ? 'C_C' : 'C_B',
      holdingGrade: holdingOnly ? 'H_A' : 'H_B',
      selectionWeight: holdingOnly ? 0 : 1,
      voteWeight: holdingOnly ? null : 1,
      registryVersion: 7,
      effectiveFrom: base - 60_000,
      votingEligible: !holdingOnly,
      ageEligible: true,
      pnlEligible: true,
      clusterKnown: true,
      longTermElite: false,
    };
  };
  const votingSnapshot = (wallet) => {
    const value = monitoringSnapshot(wallet);
    return value?.votingEligible ? value : null;
  };
  const registry = {
    cachedWalletSnapshot: votingSnapshot,
    walletSnapshot: votingSnapshot,
    cachedMonitoringSnapshot: monitoringSnapshot,
    monitoringSnapshot,
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
    postGradSnapshotHorizonsMs: [30_000, 60_000, 120_000, 300_000],
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
    entryProfiles: [
      {
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
      },
      {
        id: 'POST_GRAD_HOLD3_DIRECT',
        strength: 'HOLDING_STRONG_DIRECT',
        postGraduationHoldingConsensus: true,
        directPostGraduationEntry: true,
        requiredHoldingClusters: 3,
        minWeightedScoreRatio: 0.5,
        entryDelayMs: 100,
        entryTimeoutMs: 30_000,
        scoutFraction: 0,
        exitProfileIds: [
          'POST_GRAD_HOLD3_FIX2M',
          'POST_GRAD_HOLD3_FIX5M',
          'POST_GRAD_HOLD3_CORE80_5M',
          'POST_GRAD_HOLD3_CORE80_30M',
          'POST_GRAD_HOLD3_CORE80_6H',
        ],
      },
    ],
    exitProfiles: [
      {
        id: 'CORE80_RUNNER30M', mode: 'CORE_RUNNER',
        coreActivationPct: 30, coreFraction: 0.8, runnerTrailPct: 30,
        maxHoldMs: 30 * 60_000, hardStopPct: 20, exitTimeoutMs: 30_000,
        entryProfileIds: ['POST_GRAD_HOLD3_FLOW2_60'],
      },
      {
        id: 'POST_GRAD_HOLD3_FIX2M', mode: 'FIXED_HOLD',
        fixedHoldMs: 120_000, maxHoldMs: 120_000,
        hardStopPct: 100, exitTimeoutMs: 30_000,
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
      {
        id: 'POST_GRAD_HOLD3_FIX5M', mode: 'FIXED_HOLD',
        fixedHoldMs: 300_000, maxHoldMs: 300_000,
        hardStopPct: 100, exitTimeoutMs: 30_000,
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
      {
        id: 'POST_GRAD_HOLD3_CORE80_5M', mode: 'CORE_RUNNER',
        coreActivationPct: 30, coreFraction: 0.8, runnerTrailPct: 20,
        maxHoldMs: 300_000, hardStopPct: 20, exitTimeoutMs: 30_000,
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
      {
        id: 'POST_GRAD_HOLD3_CORE80_30M', mode: 'CORE_RUNNER',
        coreActivationPct: 30, coreFraction: 0.8, runnerTrailPct: 30,
        maxHoldMs: 30 * 60_000, hardStopPct: 30, exitTimeoutMs: 30_000,
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
      {
        id: 'POST_GRAD_HOLD3_CORE80_6H', mode: 'CORE_RUNNER',
        coreActivationPct: 30, coreFraction: 0.8, runnerTrailPct: 30,
        maxHoldMs: 6 * 60 * 60_000, hardStopPct: 30, exitTimeoutMs: 30_000,
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
    ],
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
  const holdingOnlyRestoreMint = 'RestoreHoldingOnlyConsensus111111111111111111';
  recordToken(holdingOnlyRestoreMint, 'HRESTORE');
  for (const [index, wallet] of [
    'holding-only-a', 'holding-only-b', 'holding-only-c',
  ].entries()) {
    store.recordSmartWalletEvent({
      mint: holdingOnlyRestoreMint, wallet, side: 'BUY', market: 'PUMP_BONDING_CURVE',
      solAmount: 1, tokenAmount: 1_000, price: 0.001,
      timestampMs: base - 2_000 + index, receivedAtMs: base - 2_000 + index,
      signature: `holding-only-restore-${index}`, eventIndex: 0,
    });
  }

  const suite = new SmartWalletConsensusFlowRunnerShadowSuite({
    config, store, registry, now: () => now,
  });
  store.db.prepare(`
    INSERT INTO smart_wallet_consensus_flow_runner_shadow_positions (
      cohort_id, entry_profile_id, exit_profile_id, episode_id, mint, status,
      signal_strength, signal_at, signal_market, signal_price,
      required_clusters, available_clusters, distinct_clusters,
      selection_a_clusters, copy_a_clusters, weighted_score, cluster_votes_json,
      registry_version, position_sol, scout_fraction, configured_cost_pct,
      capital_in_sol, core_proceeds_sol, gross_return_pct, net_return_pct,
      created_at, updated_at
    ) VALUES (
      'LEGACY_BAD_QUOTE', 'POST_GRAD_HOLD3_FLOW2_60', 'CORE80_RUNNER30M',
      'legacy-bad-quote', 'LegacyBadQuote111111111111111111111111111', 'CLOSED',
      'HOLDING_STRONG', ?, 'PUMP_AMM', 0.001,
      3, 4, 3, 0, 0, 1.5, '[]',
      1, 1, 0, 0, 1, 5000, 499900, 499900, ?, ?
    )
  `).run(base - 5_000, base - 5_000, base - 5_000);
  suite.start();
  const invalidLegacy = store.db.prepare(`
    SELECT status, exit_reason, net_return_pct
    FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE cohort_id='LEGACY_BAD_QUOTE'
  `).get();
  assert.strictEqual(invalidLegacy.status, 'INVALID_QUOTE');
  assert.strictEqual(
    invalidLegacy.exit_reason,
    'EXIT_CAPACITY_QUOTE_MARK_PRICE_MISMATCH',
  );
  assert.strictEqual(invalidLegacy.net_return_pct, null);
  assert.strictEqual(suite.health().invalidHistoricalRowsQuarantined, 1);
  assert.strictEqual(suite.health().restoredSmartHoldings, 6);
  assert(suite.trackedMints().includes(restoreMint),
    'three restored holder clusters must keep the mint subscribed for first AMM');
  assert(suite.trackedMints().includes(holdingOnlyRestoreMint),
    'H_A holders must restore and subscribe even when they have no S_A/S_B voting right');

  const positionEvent = (mint, wallet, offset, balance) => {
    now = base + offset;
    return suite.onSmartWalletPositionEvent({
      id: ++sequence, mint, wallet, timestampMs: now,
      side: balance > 0 ? 'BUY' : 'SELL',
      positionPhase: balance > 0 ? 'OPEN' : 'CLOSE',
      tokenBalanceAfter: balance,
    }, { walletSnapshot: monitoringSnapshot(wallet) });
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
  assert.strictEqual(evaluation.weighted_score, 1.5,
    'three independent H_B clusters must remain eligible for the direct Shadow');
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND entry_profile_id='POST_GRAD_HOLD3_FLOW2_60'
  `).get(mint).status, 'WAITING_FLOW');
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND entry_profile_id='POST_GRAD_HOLD3_DIRECT'
      AND status='SCALE_PENDING'
  `).get(mint).n, 5);

  trade(mint, 3_200, 'BUY', 'public-2');
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND entry_profile_id='POST_GRAD_HOLD3_FLOW2_60'
  `).get(mint).status, 'SCALE_PENDING');
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND entry_profile_id='POST_GRAD_HOLD3_DIRECT' AND status='OPEN'
  `).get(mint).n, 5,
  'all direct exit arms must use the next executable AMM trade');
  trade(mint, 3_400, 'BUY', 'public-entry');
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND entry_profile_id='POST_GRAD_HOLD3_FLOW2_60'
  `).get(mint).status, 'OPEN');
  trade(mint, 3_600, 'BUY', 'public-rise', 1_400);
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND entry_profile_id='POST_GRAD_HOLD3_FLOW2_60'
  `).get(mint).status, 'RUNNER');
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND exit_profile_id='POST_GRAD_HOLD3_CORE80_5M'
  `).get(mint).status, 'RUNNER');
  trade(mint, 3_800, 'SELL', 'public-fall', 900);
  trade(mint, 4_000, 'BUY', 'public-exit', 900);
  const closed = store.db.prepare(`
    SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND entry_profile_id='POST_GRAD_HOLD3_FLOW2_60'
  `).get(mint);
  assert.strictEqual(closed.status, 'CLOSED');
  assert.strictEqual(closed.exit_reason, 'RUNNER_TRAIL');
  assert.strictEqual(closed.entry_tx_count, 1);
  assert.strictEqual(closed.exit_tx_count, 2);
  const staged = store.db.prepare(`
    SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND exit_profile_id='POST_GRAD_HOLD3_CORE80_5M'
  `).get(mint);
  assert.strictEqual(staged.status, 'CLOSED');
  assert.strictEqual(staged.exit_reason, 'RUNNER_TRAIL');
  assert.strictEqual(staged.exit_tx_count, 2);

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

  const snapshotMint = 'PostGradLongSnapshot111111111111111111111111';
  recordToken(snapshotMint, 'SNAP');
  positionEvent(snapshotMint, 'holder-a', 9_100, 1_000);
  positionEvent(snapshotMint, 'holder-b', 9_200, 1_000);
  positionEvent(snapshotMint, 'holder-c', 9_300, 1_000);
  now = base + 10_000;
  suite.onGraduated({ mint: snapshotMint, graduatedAt: now, migratedAt: now });
  trade(snapshotMint, 10_000, 'BUY', 'snapshot-public-1');
  trade(snapshotMint, 10_200, 'BUY', 'snapshot-public-entry');
  trade(snapshotMint, 40_300, 'SELL', 'snapshot-30s', 1_050);
  trade(snapshotMint, 70_300, 'BUY', 'snapshot-60s', 1_050);

  trade(mint, 123_500, 'SELL', 'fixed-2m-trigger', 1_100);
  trade(mint, 123_700, 'BUY', 'fixed-2m-exit', 1_100);
  const fixed2m = store.db.prepare(`
    SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND exit_profile_id='POST_GRAD_HOLD3_FIX2M'
  `).get(mint);
  assert.strictEqual(fixed2m.status, 'CLOSED');
  assert.strictEqual(fixed2m.exit_reason, 'MAX_HOLD');

  trade(snapshotMint, 130_300, 'BUY', 'snapshot-120s', 1_050);

  trade(mint, 303_500, 'SELL', 'fixed-5m-trigger', 1_200);
  trade(mint, 303_700, 'BUY', 'fixed-5m-exit', 1_200);
  const fixed5m = store.db.prepare(`
    SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND exit_profile_id='POST_GRAD_HOLD3_FIX5M'
  `).get(mint);
  assert.strictEqual(fixed5m.status, 'CLOSED');
  assert.strictEqual(fixed5m.exit_reason, 'MAX_HOLD');

  trade(snapshotMint, 310_300, 'BUY', 'snapshot-300s', 1_050);
  const snapshotRow = store.db.prepare(`
    SELECT flow_features_json
    FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE mint=? AND exit_profile_id='POST_GRAD_HOLD3_CORE80_30M'
  `).get(snapshotMint);
  const captured = JSON.parse(snapshotRow.flow_features_json);
  assert.strictEqual(captured.kind, 'POST_GRAD_SNAPSHOTS');
  for (const horizon of [30_000, 60_000, 120_000, 300_000]) {
    assert(captured.snapshots[String(horizon)], `missing ${horizon}ms precursor snapshot`);
    assert.strictEqual(captured.snapshots[String(horizon)].qualifiedHoldingClusters, 3);
    assert.strictEqual(captured.snapshots[String(horizon)].qualifiedHoldingWallets, 3);
  }

  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);
  assert.strictEqual(suite.health().holdingConsensusQualified, 4);
  assert.strictEqual(suite.health().holdingConsensusRejected, 4);
  assert.strictEqual(suite.health().directOpened, 10);
  suite.stop();
  store.close();
  console.log('Post-graduation holding consensus Shadow tests: PASS');
}

main();
