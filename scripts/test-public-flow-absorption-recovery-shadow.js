'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  PublicFlowAbsorptionRecoveryShadowSuite,
} = require('../src/core/PublicFlowAbsorptionRecoveryShadowSuite');

function config() {
  const shared = {
    requireCompleteHistory: true,
    minAgeMs: 5 * 60_000,
    maxAgeMs: 45 * 60_000,
    minCurvePct: 35,
    maxCurvePct: 70,
    minPullbackPct: 6,
    maxPullbackPct: 18,
    minReboundPct: 2,
    maxReboundPct: 8,
    minSelloffSellers: 2,
    minSelloffSellSol: 0.5,
    maxSelloffNetFlowSol: -0.5,
    minNetFlow3sSol: 0.5,
    minNetFlow5sSol: 0,
    minNetFlow10sSol: -5,
    minBuyers3s: 2,
    maxTop1BuyShare5sPct: 40,
    maxRecentSell1sSol: 0.5,
    minObservedHolders: 20,
    minFirstBuyerSample: 20,
    minFirst20RetentionPct: 50,
    maxTop3InventoryPct: 40,
    rejectCreatorSell5s: true,
  };
  return {
    enabled: true,
    positionSizeSol: 0.1,
    structureWindowMs: 10_000,
    stateRetentionMs: 46 * 60_000,
    completeHistoryMaxInitialAgeMs: 2_000,
    retentionFloorFraction: 0.1,
    observationMinPullbackPct: 6,
    observationMinReboundPct: 2,
    rejectionObservationCooldownMs: 2_000,
    entryDelayMs: 200,
    entryTimeoutMs: 1_500,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 8,
    maxEntryPriceDropPct: 30,
    maxEntryImpactPct: 5,
    maxCrossMarketPriceJumpPct: 50,
    smartLookbackMs: 300_000,
    smartFutureLabelWindowMs: 15_000,
    j36Wallet: 'J36AVCr7uVoXwYgcL8yBmeCAatSLGLSjrCMaBca3sCXq',
    entryProfiles: [
      { ...shared, id: 'PFAR_A_NO_WALLET', label: 'A', trigger: 'PUBLIC_FLOW' },
      { ...shared, id: 'PFAR_B_TAG_ONLY', label: 'B', trigger: 'PUBLIC_FLOW' },
      {
        ...shared, id: 'PFAR_C_J36_CONTROL', label: 'C', trigger: 'J36_OPEN',
        minTriggerBuySol: 0.2,
      },
    ],
    exitProfiles: [10, 15, 20].map((seconds) => ({
      id: `FIX${seconds}_H15`, label: `${seconds}s`, maxHoldMs: seconds * 1_000,
      hardStopPct: 15,
    })),
    costModel: {
      platformFeePct: 1,
      buySlippagePct: 0,
      sellSlippagePct: 0,
      priceImpactPct: 0,
      baseTxFeeSol: 0,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      fixedCostSol: 0,
      positionSizeSol: 0.1,
      entryFailureRatePct: 0,
      entryFailureCostPct: 0,
    },
  };
}

function main() {
  const base = 1_800_500_000_000;
  let now = base;
  let sequence = 0;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  let suite = new PublicFlowAbsorptionRecoveryShadowSuite({
    config: config(), store, now: () => now,
  });
  suite.start();

  const mint = 'PFAR1111111111111111111111111111111111111';
  const createdAt = base - 5 * 60_000;
  store.recordCreate({
    mint, symbol: 'PFAR', name: null, uri: null, bondingCurve: null,
    creator: 'creator-1', createdAt,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  suite.onCreate({ mint, symbol: 'PFAR', creator: 'creator-1', createdAt });

  const trade = (offset, side, sol, wallet, price, overrides = {}) => {
    sequence += 1;
    now = base + offset;
    const virtualTokens = 1_000_000;
    const row = {
      mint,
      symbol: 'PFAR',
      timestampMs: now,
      receivedAtMs: now,
      market: 'PUMP_BONDING_CURVE',
      side,
      solAmount: sol,
      tokenAmount: sol / price,
      wallet,
      price,
      reservePrice: price,
      curvePct: 50,
      ageMs: now - createdAt,
      signature: `pfar-${sequence}`,
      eventIndex: 0,
      virtualTokenReservesRaw: String(Math.round(virtualTokens * 1e6)),
      virtualSolReservesRaw: String(Math.round(virtualTokens * price * 1e9)),
      ...overrides,
    };
    return { row, signals: suite.observeTrade(row) };
  };

  // Build a complete and diversified first-20 holder sample.
  for (let index = 0; index < 20; index += 1) {
    trade(-9_900 + index * 30, 'BUY', 0.1, `holder-${index}`, 1.2);
  }
  trade(-8_000, 'BUY', 0.1, 'peak-buyer', 1.2);
  trade(-7_000, 'SELL', 1.5, 'seller-a', 1.1);
  trade(-6_500, 'SELL', 1.5, 'seller-b', 1.0);

  // One buyer cannot satisfy the flow and breadth recovery confirmation.
  assert.strictEqual(trade(-1_000, 'BUY', 0.3, 'recovery-a', 1.02).signals.length, 0);
  // The second is still concentrated at 50% of recent buy flow.
  assert.strictEqual(trade(-500, 'BUY', 0.3, 'recovery-b', 1.025).signals.length, 0);
  // The third produces the anonymous public A/B signal without any Smart event.
  const publicSignal = trade(0, 'BUY', 0.3, 'recovery-c', 1.03);
  assert.strictEqual(publicSignal.signals.length, 6);
  assert.strictEqual(suite.health().publicSignals, 1);
  assert.strictEqual(suite.health().j36Signals, 0);

  // The next causal Curve trade provides a reserve-priced 0.1 SOL fill.
  trade(300, 'BUY', 0.1, 'entry-fill', 1.04);
  assert.strictEqual(suite.health().opened, 6);

  // A later Smart OPEN labels B but does not create or alter A entry decisions.
  now = base + 400;
  suite.onSmartWalletEvent({
    mint, wallet: 'smart-label-1', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: now, solAmount: 0.4, price: 1.04, reservePrice: 1.04,
  }, { walletSnapshot: { independenceClusterId: 'cluster-1', grade: 'S_A' } });

  // J36 is the isolated C control. Its trade is public market flow, while the
  // identity-aware callback is used only to create the C cohort.
  const j36 = trade(500, 'BUY', 0.25,
    'J36AVCr7uVoXwYgcL8yBmeCAatSLGLSjrCMaBca3sCXq', 1.045).row;
  suite.onSmartWalletEvent({
    ...j36, positionPhase: 'OPEN',
  }, { walletSnapshot: { independenceClusterId: 'j36-cluster', grade: 'S_A' } });
  assert.strictEqual(suite.health().j36Signals, 1);
  trade(800, 'BUY', 0.1, 'j36-entry-fill', 1.05);
  assert.strictEqual(suite.health().opened, 9);

  suite.advanceTime(base + 1_000);
  const counts = store.db.prepare(`
    SELECT entry_profile_id, COUNT(*) n, MAX(smart_wallet_count) smart_count
    FROM public_flow_absorption_recovery_shadow_positions
    GROUP BY entry_profile_id ORDER BY entry_profile_id
  `).all();
  assert.deepStrictEqual(counts.map((row) => [row.entry_profile_id, row.n]), [
    ['PFAR_A_NO_WALLET', 3],
    ['PFAR_B_TAG_ONLY', 3],
    ['PFAR_C_J36_CONTROL', 3],
  ]);
  assert.strictEqual(counts.find((row) => row.entry_profile_id === 'PFAR_A_NO_WALLET').smart_count, 0);
  assert.strictEqual(counts.find((row) => row.entry_profile_id === 'PFAR_B_TAG_ONLY').smart_count, 2);
  const publicPairs = store.db.prepare(`
    SELECT a.exit_profile_id,
      a.signal_at a_signal_at, b.signal_at b_signal_at,
      a.entry_at a_entry_at, b.entry_at b_entry_at,
      a.entry_price a_entry_price, b.entry_price b_entry_price,
      a.entry_impact_pct a_impact, b.entry_impact_pct b_impact
    FROM public_flow_absorption_recovery_shadow_positions a
    JOIN public_flow_absorption_recovery_shadow_positions b
      ON b.mint=a.mint AND b.exit_profile_id=a.exit_profile_id
      AND b.entry_profile_id='PFAR_B_TAG_ONLY'
    WHERE a.entry_profile_id='PFAR_A_NO_WALLET'
    ORDER BY a.exit_profile_id
  `).all();
  assert.strictEqual(publicPairs.length, 3);
  for (const pair of publicPairs) {
    assert.strictEqual(pair.a_signal_at, pair.b_signal_at);
    assert.strictEqual(pair.a_entry_at, pair.b_entry_at);
    assert.strictEqual(pair.a_entry_price, pair.b_entry_price);
    assert.strictEqual(pair.a_impact, pair.b_impact);
  }

  // Persisted B labels survive a process restart and merge with later labels;
  // the restart must not reset a prior two-wallet label back to one.
  suite.stop();
  suite = new PublicFlowAbsorptionRecoveryShadowSuite({
    config: config(), store, now: () => now,
  });
  suite.start();
  now = base + 1_100;
  suite.onSmartWalletEvent({
    mint, wallet: 'smart-label-3', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: now, solAmount: 0.3, price: 1.05, reservePrice: 1.05,
  }, { walletSnapshot: { independenceClusterId: 'cluster-3', grade: 'S_A' } });
  suite.advanceTime(base + 1_200);
  const restoredLabel = store.db.prepare(`
    SELECT MAX(smart_wallet_count) wallets, MAX(smart_cluster_count) clusters
    FROM public_flow_absorption_recovery_shadow_positions
    WHERE entry_profile_id='PFAR_B_TAG_ONLY'
  `).get();
  assert.strictEqual(restoredLabel.wallets, 3);
  assert.strictEqual(restoredLabel.clusters, 3);

  // Complete the 10-second exit for all three entry cohorts using a separate
  // trigger trade and a causal fill 250ms later.
  trade(11_000, 'BUY', 0.1, 'exit-trigger', 1.1);
  trade(11_250, 'BUY', 0.1, 'exit-fill', 1.1);
  suite.advanceTime(base + 11_500);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_absorption_recovery_shadow_positions
    WHERE exit_profile_id='FIX10_H15' AND status='CLOSED'
  `).get().n, 3);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_absorption_recovery_shadow_positions
    WHERE status='CLOSED' AND net_return_pct IS NOT NULL
  `).get().n, 3);

  // Missing an observed lifecycle start is a hard scientific guard: after a
  // restart, an old token may be observed and labelled, but it cannot enter A/B.
  const incompleteMint = 'PFARINCOMPLETE111111111111111111111111111';
  for (let index = 0; index < 20; index += 1) {
    trade(20_100 + index * 30, 'BUY', 0.1, `late-holder-${index}`, 1.2, {
      mint: incompleteMint,
    });
  }
  trade(22_000, 'BUY', 0.1, 'late-peak', 1.2, { mint: incompleteMint });
  trade(23_000, 'SELL', 1.5, 'late-seller-a', 1.1, { mint: incompleteMint });
  trade(23_500, 'SELL', 1.5, 'late-seller-b', 1.0, { mint: incompleteMint });
  trade(29_000, 'BUY', 0.3, 'late-recovery-a', 1.02, { mint: incompleteMint });
  trade(29_500, 'BUY', 0.3, 'late-recovery-b', 1.025, { mint: incompleteMint });
  assert.strictEqual(trade(30_000, 'BUY', 0.3, 'late-recovery-c', 1.03, {
    mint: incompleteMint,
  }).signals.length, 0);
  suite.advanceTime(base + 30_100);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM public_flow_absorption_recovery_shadow_positions
    WHERE mint=?
  `).get(incompleteMint).n, 0);
  assert.ok(suite.health().rejectionReasons.HISTORY_INCOMPLETE > 0);

  // No executable trade after an exit deadline is censored. It must never be
  // rewritten as a synthetic -100% (or any other) realized return.
  suite.advanceTime(base + 31_000);
  const noExit = store.db.prepare(`
    SELECT COUNT(*) n,
      SUM(net_return_pct IS NOT NULL) priced,
      MIN(exit_reason) reason
    FROM public_flow_absorption_recovery_shadow_positions
    WHERE status='NO_EXIT'
  `).get();
  assert.strictEqual(noExit.n, 6);
  assert.strictEqual(noExit.priced, 0);
  assert.strictEqual(noExit.reason, 'FIXED_15000MS');

  const dashboard = suite.dashboard({ positionLimit: 20, observationLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 9);
  assert.ok(dashboard.observationStats.observations >= 1);
  assert.strictEqual(dashboard.runtime.sendsTransactions, false);
  assert.strictEqual(dashboard.runtime.changesLiveTrading, false);

  store.close();
  console.log('public flow absorption recovery shadow tests passed');
}

main();
