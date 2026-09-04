'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { EarlyPureBuyBurstShadowSuite } = require('../src/core/EarlyPureBuyBurstShadowSuite');

function config() {
  return {
    enabled: true,
    smartWallets: ['excluded-smart-wallet'],
    positionSizeSol: 1,
    featureWindowMs: 3_000,
    maxTradesPerMint: 16,
    stateRetentionMs: 120_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 15,
    maxEntryPriceDropPct: 35,
    maxEntryImpactPct: 15,
    base: {
      maxAgeMs: 10_000,
      maxCurvePct: 50,
      minNetFlow3sSol: 3,
      maxNetFlow3sSol: 5,
      minBuyers3s: 2,
      maxBuyers3s: 4,
      maxSellTx3s: 0,
    },
    confirmationB: {
      minDelayMs: 300,
      maxDelayMs: 500,
      minDeltaBuyers: 1,
      minDeltaNetFlowSol: 0.5,
      maxJumpPct: 10,
    },
    confirmationC: {
      minDelayMs: 1_000,
      maxDelayMs: 3_000,
      minDrawdownPct: 3,
      maxDrawdownPct: 8,
      minReclaimPct: 1,
      maxReclaimPct: 2,
      maxSingleSellSol: 0.5,
      maxSellSharePct: 35,
    },
    entryProfiles: [
      { id: 'EB_A', label: 'immediate baseline', newEntriesEnabled: true },
      { id: 'EB_B', label: '300-500ms confirmation', newEntriesEnabled: true },
      { id: 'EB_C', label: 'pullback reclaim', newEntriesEnabled: true },
      {
        id: 'EB_A_SWC_R2_W300', label: 'EB-A + two smart clusters',
        newEntriesEnabled: true, sourceProfileId: 'EB_A',
        consensusWindowMs: 300_000, requiredClusters: 2,
        exitProfileIds: ['FIX20', 'FIX30'],
      },
      {
        id: 'EB_A_SWC_PA3_W300', label: 'EB-A + three P_A clusters',
        newEntriesEnabled: true, sourceProfileId: 'EB_A',
        consensusWindowMs: 300_000, requiredClusters: 3,
        minSelectionAClusters: 3, selectionGradeOnly: 'S_A',
        exitProfileIds: ['FIX20', 'FIX30'],
      },
    ],
    exitProfiles: [
      { id: 'FIX5', label: 'fixed 5s', maxHoldMs: 5_000 },
      { id: 'FIX20', label: 'fixed 20s', maxHoldMs: 20_000 },
      { id: 'FIX30', label: 'fixed 30s', maxHoldMs: 30_000 },
    ],
    costModel: {
      platformFeePct: 1,
      buySlippagePct: 0,
      sellSlippagePct: 0,
      priceImpactPct: 0,
      baseTxFeeSol: 0.000005,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      fixedCostSol: 0,
      positionSizeSol: 1,
      entryFailureRatePct: 0,
      entryFailureCostPct: 0,
    },
  };
}

function setup(base, settings = config(), guardEvaluator = null) {
  let now = base;
  let sequence = 0;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  if (guardEvaluator) {
    store.preEntryRugRisk = {
      config: { enabled: true },
      evaluateGuard: guardEvaluator,
    };
  }
  const suite = new EarlyPureBuyBurstShadowSuite({
    config: settings, store, now: () => now,
  });
  suite.start();
  const send = ({ mint, offset, side = 'BUY', sol = 0.1, wallet, price = 0.0000001,
    reserves = true }) => {
    now = base + offset;
    sequence += 1;
    const trade = {
      mint, symbol: 'EB', timestampMs: now, slot: 10_000 + Math.floor(offset / 400),
      market: 'PUMP_BONDING_CURVE', side, solAmount: sol,
      tokenAmount: sol / price, wallet, price, reservePrice: price,
      curvePct: 35, ageMs: 6_000 + Math.max(0, offset),
      signature: `eb-${sequence}`, eventIndex: 0,
    };
    if (reserves) {
      trade.virtualTokenReservesRaw = '1000000000000000';
      trade.virtualSolReservesRaw = String(Math.max(1, Math.round(price * 1e18)));
    }
    return { trade, signals: suite.observeTrade(trade) };
  };
  return { store, suite, send, setNow: (value) => { now = value; } };
}

function seedBaseline(send, mint) {
  send({ mint, offset: -500, sol: 1.25, wallet: `${mint}-buyer-1` });
  send({ mint, offset: -250, sol: 1.25, wallet: `${mint}-buyer-2` });
  return send({ mint, offset: 0, sol: 1.5, wallet: `${mint}-buyer-3` });
}

function testEntryPathsAndExecutableExits() {
  const base = 1_850_000_000_000;
  const { store, suite, send, setNow } = setup(base);
  const mint = 'EarlyPureBuyBurst111111111111111111111111';

  send({ mint, offset: -750, sol: 20, wallet: 'excluded-smart-wallet' });
  const baseline = seedBaseline(send, mint);
  assert.strictEqual(baseline.signals.length, 3, 'EB-A must create isolated FIX5/20/30 cohorts');
  assert.ok(baseline.signals.every((row) => row.entryProfileId === 'EB_A'));

  // Smart-wallet flow is excluded from the causal feature window.
  send({ mint, offset: 250, sol: 0.1, wallet: `${mint}-public-fill-a` });
  assert.strictEqual(suite.health().opened, 3);

  const confirmB = send({
    mint, offset: 350, sol: 0.5, wallet: `${mint}-buyer-4`, price: 0.000000104,
  });
  assert.strictEqual(confirmB.signals.length, 3, 'EB-B must require a fresh public-flow confirmation');
  assert.ok(confirmB.signals.every((row) => row.entryProfileId === 'EB_B'));
  send({ mint, offset: 600, sol: 0.1, wallet: `${mint}-public-fill-b`, price: 0.000000104 });

  send({ mint, offset: 1_100, side: 'SELL', sol: 0.3, wallet: `${mint}-seller`, price: 0.000000094 });
  const confirmC = send({
    mint, offset: 1_400, sol: 0.5, wallet: `${mint}-buyer-5`, price: 0.0000000952,
  });
  assert.strictEqual(confirmC.signals.length, 3, 'EB-C must require a 3-8% pullback and 1-2% reclaim');
  assert.ok(confirmC.signals.every((row) => row.entryProfileId === 'EB_C'));
  send({ mint, offset: 1_700, sol: 0.1, wallet: `${mint}-public-fill-c`, price: 0.0000000952 });

  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM early_pure_buy_burst_shadow_positions WHERE status='OPEN'
  `).get().n, 9);

  const openRows = store.db.prepare(`
    SELECT id, entry_at, exit_profile_id FROM early_pure_buy_burst_shadow_positions
    WHERE status='OPEN'
  `).all();
  const holds = new Map([['FIX5', 5_000], ['FIX20', 20_000], ['FIX30', 30_000]]);
  const dueTimes = [...new Set(openRows.map((row) => row.entry_at + holds.get(row.exit_profile_id)))].sort((a, b) => a - b);
  dueTimes.forEach((dueAt, index) => {
    setNow(dueAt);
    suite.advanceTime(dueAt);
    send({
      mint, offset: dueAt - base + 250, sol: 0.01,
      wallet: `${mint}-exit-${index}`, price: 0.00000012,
    });
  });

  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM early_pure_buy_burst_shadow_positions WHERE status='CLOSED'
  `).get().n, 9, 'all three entry paths and all fixed exits must close independently');
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM early_pure_buy_burst_shadow_positions
    WHERE status='CLOSED' AND net_return_pct IS NOT NULL AND exit_impact_pct IS NOT NULL
  `).get().n, 9, 'completed rows require executable reserve-priced exits');

  for (let index = 0; index < 80; index += 1) {
    send({ mint, offset: 40_000 + index, wallet: `${mint}-burst-${index}`, sol: 0.01 });
  }
  assert.ok(suite.states.get(mint).rows.length <= config().maxTradesPerMint);
  assert.strictEqual(suite.health().excludedSmartTrades, 1);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  const dashboard = suite.dashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 9);
  assert.ok(dashboard.cohorts.every((row) => row.completed === 1));
  assert.strictEqual(dashboard.strategy.missingExitPolicy, 'NO_EXIT_EXCLUDED_FROM_RETURN_STATS');
  store.close();
}

function testIdlePoolUsesPersistedReserveQuote() {
  const base = 1_851_000_000_000;
  const { store, send } = setup(base);
  const mint = 'EarlyPureBuyNoExit1111111111111111111111111';
  seedBaseline(send, mint);
  send({ mint, offset: 250, sol: 0.1, wallet: `${mint}-fill` });

  // Simulate a process restart after the entry, with no later Mint trade.
  // The persisted reserve state is the current pool state until a trade changes it.
  const recovered = new EarlyPureBuyBurstShadowSuite({
    config: config(),
    store,
    now: () => base + 6_451,
  });
  recovered.start();

  const row = store.db.prepare(`
    SELECT status, exit_reason, gross_return_pct, net_return_pct
    FROM early_pure_buy_burst_shadow_positions
    WHERE entry_profile_id='EB_A' AND exit_profile_id='FIX5'
  `).get();
  assert.strictEqual(row.status, 'CLOSED');
  assert.strictEqual(row.exit_reason, 'FIXED_5000MS');
  assert.ok(Number.isFinite(row.gross_return_pct));
  assert.ok(Number.isFinite(row.net_return_pct));
  const cohort = recovered.dashboard().cohorts.find(
    (item) => item.entry_profile_id === 'EB_A' && item.exit_profile_id === 'FIX5',
  );
  assert.strictEqual(cohort.no_exit, 0);
  assert.strictEqual(cohort.completed, 1,
    'an unchanged pool remains executable even when no new trade arrives at the exit time');
  store.close();
}

function testCausalSmartWalletConsensusOverlay() {
  const base = 1_852_000_000_000;
  const { store, suite, send } = setup(base);
  const mint = 'EarlyPureBuySmartConsensus111111111111111111';
  const snapshot = (wallet, clusterId, registryVersion) => ({
    wallet, clusterId, registryVersion, votingEligible: true,
    selectionGrade: 'S_B', pnlEligibilityClass: 'ACTIVE_24H',
    snapshotGeneratedAt: base - 60_000, snapshotExpiresAt: base + 60_000,
  });
  suite.onSmartWalletEvent({
    id: 501, mint, wallet: 'smart-one', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: base - 20_000,
  }, { walletSnapshot: snapshot('smart-one', 'cluster-one', 41) });
  suite.onSmartWalletEvent({
    id: 502, mint, wallet: 'smart-two', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: base - 10_000,
  }, { walletSnapshot: snapshot('smart-two', 'cluster-two', 42) });
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_voting_event_snapshots WHERE mint=?
  `).get(mint).n, 2);
  const recovered = new EarlyPureBuyBurstShadowSuite({
    config: config(), store, now: () => base - 1_000,
  });
  recovered.start();
  const restoredConsensus = recovered._smartConsensus(
    recovered.states.get(mint),
    base,
    recovered.entryProfiles.get('EB_A_SWC_R2_W300'),
  );
  assert.strictEqual(restoredConsensus.distinctClusters, 2,
    'a restart must restore the exact causal vote snapshots inside the 300s window');
  assert.deepStrictEqual(restoredConsensus.votes.map((row) => row.registryVersion), [41, 42]);
  send({ mint, offset: -500, sol: 1.25, wallet: `${mint}-buyer-1` });
  send({ mint, offset: -250, sol: 1.25, wallet: `${mint}-buyer-2` });
  const signal = send({ mint, offset: 0, sol: 1.5, wallet: `${mint}-buyer-3` });
  assert.strictEqual(signal.signals.length, 5,
    'EB-A keeps its three controls and adds only the FIX20/FIX30 smart overlay arms');
  const overlays = store.db.prepare(`
    SELECT exit_profile_id, features_json
    FROM early_pure_buy_burst_shadow_positions
    WHERE mint=? AND entry_profile_id='EB_A_SWC_R2_W300'
    ORDER BY exit_profile_id
  `).all(mint);
  assert.deepStrictEqual(overlays.map((row) => row.exit_profile_id), ['FIX20', 'FIX30']);
  const consensus = JSON.parse(overlays[0].features_json).smartConsensus;
  assert.strictEqual(consensus.distinctClusters, 2);
  assert.deepStrictEqual(consensus.votes.map((row) => row.registryVersion), [41, 42],
    'the row must retain the exact cached eligibility versions seen before the source signal');

  const relatedMint = 'EarlyPureBuyRelatedCluster1111111111111111111';
  suite.onSmartWalletEvent({
    id: 503, mint: relatedMint, wallet: 'related-one', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: base - 20_000,
  }, { walletSnapshot: snapshot('related-one', 'same-cluster', 43) });
  suite.onSmartWalletEvent({
    id: 504, mint: relatedMint, wallet: 'related-two', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: base - 10_000,
  }, { walletSnapshot: snapshot('related-two', 'same-cluster', 44) });
  send({ mint: relatedMint, offset: 1_000, sol: 1.25, wallet: 'related-public-1' });
  send({ mint: relatedMint, offset: 1_250, sol: 1.25, wallet: 'related-public-2' });
  const relatedSignal = send({
    mint: relatedMint, offset: 1_500, sol: 1.5, wallet: 'related-public-3',
  });
  assert.strictEqual(relatedSignal.signals.length, 3,
    'two addresses in one cluster must remain one vote');

  const futureMint = 'EarlyPureBuyNoLookahead111111111111111111111';
  suite.onSmartWalletEvent({
    id: 505, mint: futureMint, wallet: 'past-smart', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: base,
  }, { walletSnapshot: snapshot('past-smart', 'past-cluster', 45) });
  send({ mint: futureMint, offset: 2_000, sol: 1.25, wallet: 'future-public-1' });
  send({ mint: futureMint, offset: 2_250, sol: 1.25, wallet: 'future-public-2' });
  const futureSignal = send({
    mint: futureMint, offset: 2_500, sol: 1.5, wallet: 'future-public-3',
  });
  assert.strictEqual(futureSignal.signals.length, 3);
  suite.onSmartWalletEvent({
    id: 506, mint: futureMint, wallet: 'future-smart', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: base + 2_600,
  }, { walletSnapshot: snapshot('future-smart', 'future-cluster', 46) });
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM early_pure_buy_burst_shadow_positions
    WHERE mint=? AND entry_profile_id='EB_A_SWC_R2_W300'
  `).get(futureMint).n, 0, 'a vote after EB-A must never be applied retroactively');
  assert.strictEqual(suite.health().smartConsensusSignals, 1);
  store.close();
}

function testHighFrequencyRugPairSharesSignalAndOnlyFiltersRugx() {
  const base = 1_853_000_000_000;
  const settings = config();
  settings.entryProfiles.push({
    id: 'EB_A_RUGX', label: 'paired catastrophe filter',
    newEntriesEnabled: true, pairedBaselineProfileId: 'EB_A',
    rugGuardMode: 'LIVE_CURVE_CATASTROPHE', exitProfileIds: ['FIX20'],
  });
  const guardCalls = [];
  const { store, suite, send } = setup(base, settings, (options) => {
    guardCalls.push(options);
    const blocked = Array.isArray(options.hardBlockSignatures);
    return {
      ...options,
      flagged: blocked,
      blocked,
      reason: blocked ? 'PRE_ENTRY_RUG_EXTREME_DUMPABILITY' : 'RUG_RISK_LABEL_ONLY',
    };
  });
  const mint = 'EarlyPureBuyRugPair11111111111111111111111';
  send({ mint, offset: -500, sol: 1.25, wallet: `${mint}-buyer-1` });
  send({ mint, offset: -250, sol: 1.25, wallet: `${mint}-buyer-2` });
  const signal = send({ mint, offset: 0, sol: 1.5, wallet: `${mint}-buyer-3` });
  assert.strictEqual(signal.signals.length, 4,
    'the high-frequency pair adds one FIX20 row to the three EB-A controls');
  assert.strictEqual(signal.signals.find((row) => row.entryProfileId === 'EB_A').signalAt,
    signal.signals.find((row) => row.entryProfileId === 'EB_A_RUGX').signalAt);
  send({ mint, offset: 250, sol: 0.1, wallet: `${mint}-fill` });
  const pairRows = store.db.prepare(`
    SELECT entry_profile_id, exit_profile_id, status, rejection_reason
    FROM early_pure_buy_burst_shadow_positions
    WHERE mint=? AND exit_profile_id='FIX20'
      AND entry_profile_id IN ('EB_A', 'EB_A_RUGX')
    ORDER BY entry_profile_id
  `).all(mint);
  assert.deepStrictEqual(pairRows.map((row) => row.status), ['OPEN', 'NO_ENTRY']);
  assert.strictEqual(pairRows[1].rejection_reason, 'PRE_ENTRY_RUG_EXTREME_DUMPABILITY');
  const rugxCall = guardCalls.find((row) => row.strategyId.includes('EB_A_RUGX'));
  assert.deepStrictEqual(rugxCall.hardBlockSignatures, [
    'crossMintToxicWallets', 'crossMintToxicTemplate',
  ]);
  store.db.prepare(`
    UPDATE early_pure_buy_burst_shadow_positions
    SET status='CLOSED', net_return_pct=-90
    WHERE mint=? AND entry_profile_id='EB_A' AND exit_profile_id='FIX20'
  `).run(mint);
  const comparison = suite.dashboard().rugComparisons[0];
  assert.strictEqual(comparison.pairedSignals, 1);
  assert.strictEqual(comparison.blocked, 1);
  assert.strictEqual(comparison.avoidedRug50, 1);
  assert.strictEqual(comparison.avoidedRug80, 1);
  assert.strictEqual(comparison.averageNetReturnLiftPct, 90);
  store.close();
}

function main() {
  testEntryPathsAndExecutableExits();
  testIdlePoolUsesPersistedReserveQuote();
  testCausalSmartWalletConsensusOverlay();
  testHighFrequencyRugPairSharesSignalAndOnlyFiltersRugx();
  console.log('Early pure-buy burst shadow test passed.');
}

main();
