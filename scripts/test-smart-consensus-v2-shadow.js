'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { SmartWalletRegistry } = require('../src/core/SmartWalletRegistry');
const {
  SmartWalletConsensusFlowRunnerShadowSuite,
} = require('../src/core/SmartWalletConsensusFlowRunnerShadowSuite');

async function main() {
  const base = 1_900_000_000_000;
  let now = base;
  let sequence = 0;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const costModel = {
    platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
    baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
    positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
  };
  const registryConfig = {
    enabled: true,
    ageCheckEnabled: false,
    seedWallets: ['smart-a', 'smart-b', 'smart-c'],
    seedClusters: [{ id: 'cluster-ab', wallets: ['smart-a', 'smart-b'] }],
    discoveryEnabled: true,
    discoveryMinSeedMints: 2,
    discoveryMinBuySol: 0.2,
    discoveryMaxEarlyBuyers: 25,
    discoveryMaxCurvePct: 80,
    discoveryDelayMs: 1_000,
    gradeRefreshMs: 60_000,
    lookbackMs: 60 * 24 * 60 * 60_000,
    labelPositionSol: 1,
    labelEntryDelayMs: 100,
    labelEntryTimeoutMs: 1_000,
    labelGraceMs: 1_000,
    copyReturnHorizonMs: 1_000,
    selectionHorizonMs: 2_000,
    noExitReturnPct: -100,
    maxCrossMarketJumpPct: 500,
    selectionMinSamples: 5,
    copyMinSamples: 5,
    holdingMinSamples: 5,
    minActiveDays: 1,
    minGraduationLift: 1,
    minBig50Lift: 1,
    minSelectionBLift: 1,
    minCopyPf: 1,
    minPositiveWindowPct: 50,
    maxTop1ProfitPct: 100,
    holdingBigWinnerPct: 50,
    holdingMinRunnerUpliftPct: 5,
    holdingMinBigWinnerRatePct: 1,
    gradeConfirmationRuns: 2,
    costModel,
  };
  const registry = new SmartWalletRegistry({ config: registryConfig, store, now: () => now });
  registry.start();
  const suite = new SmartWalletConsensusFlowRunnerShadowSuite({
    config: {
      enabled: true,
      positionSizeSol: 1,
      probationVoteWeight: 1,
      enforceAGradeAfterClusters: 12,
      stateRetentionMs: 60_000,
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
      strictMaxFlowConfirmationDelayMs: 500,
      dynamicThresholds: [{ maxEligibleClusters: 10, ordinary: 2, strong: 3 }],
      entryProfiles: [{
        id: 'SCOUT15_FLOW', strength: 'ORDINARY', consensusWindowMs: 5_000,
        scoutFraction: 0.15, minSelectionAClusters: 1, minWeightedScoreRatio: 0.5,
      }],
      exitProfiles: [
        { id: 'FIX120', mode: 'FIXED_HOLD', fixedHoldMs: 120_000,
          maxHoldMs: 120_000, hardStopPct: 20 },
        { id: 'RUNNER', mode: 'CORE_RUNNER', coreActivationPct: 30,
          coreFraction: 0.8, runnerTrailPct: 30, maxHoldMs: 60_000, hardStopPct: 20 },
        { id: 'PROTECT', mode: 'CORE_RUNNER', coreActivationPct: 30,
          coreFraction: 0.8, runnerTrailPct: 30, maxHoldMs: 60_000, hardStopPct: 20,
          scoutProtectActivationPct: 30, scoutProtectTrailPct: 20,
          scoutProtectFloorPct: 5 },
      ],
      costModel,
    },
    store,
    registry,
    rugRiskTracker: { snapshot: () => ({ flagged: true, reason: 'OBSERVATION_ONLY' }) },
    now: () => now,
  });
  suite.start();
  const mint = 'ConsensusV211111111111111111111111111111';
  store.recordCreate({
    mint, symbol: 'V2', name: null, uri: null, bondingCurve: null, creator: 'creator',
    createdAt: base - 10_000, initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });

  const trade = (offset, market, side, wallet, quoteSol = 1_000, overrides = {}) => {
    now = base + offset;
    sequence += 1;
    const row = {
      mint,
      timestampMs: now,
      receivedAtMs: now,
      market,
      side,
      wallet,
      solAmount: 0.5,
      tokenAmount: 500,
      price: quoteSol / 1_000_000,
      reservePrice: quoteSol / 1_000_000,
      signature: `v2-${sequence}`,
      eventIndex: 0,
      curvePct: 70,
      virtualTokenReservesRaw: '1000000000000',
      virtualSolReservesRaw: String(Math.round(quoteSol * 1e9)),
      poolBaseReservesRaw: '1000000000000',
      poolQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
      virtualQuoteReservesRaw: '0',
      ...overrides,
    };
    suite.observeTrade(row);
    return row;
  };
  const smartOpen = (offset, wallet, id) => {
    const row = trade(offset, 'PUMP_BONDING_CURVE', 'BUY', wallet);
    return suite.onSmartWalletEvent({ ...row, id, positionPhase: 'OPEN' });
  };

  smartOpen(0, 'smart-a', 1);
  smartOpen(200, 'smart-b', 2);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
  `).get().n, 0, 'two addresses in one cluster must count as one vote');
  smartOpen(400, 'smart-c', 3);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
  `).get().n, 3);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE rug_label_json LIKE '%OBSERVATION_ONLY%'
  `).get().n, 3, 'RUG output is retained as a label without blocking entry');

  trade(600, 'PUMP_BONDING_CURVE', 'BUY', 'public-scout');
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE status='SCOUT_OPEN' AND capital_in_sol=0.15
  `).get().n, 3);

  trade(700, 'PUMP_BONDING_CURVE', 'BUY', 'public-rise-before-graduation', 2_000);
  trade(800, 'PUMP_BONDING_CURVE', 'SELL', 'public-pullback-before-graduation', 1_200);
  trade(900, 'PUMP_BONDING_CURVE', 'BUY', 'public-protect-exit', 1_200);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE exit_profile_id='PROTECT' AND status='CLOSED' AND exit_reason='SCOUT_PROTECT'
  `).get().n, 1, 'the protected arm must harvest a pre-graduation scout reversal');

  now = base + 1_000;
  const graduated = { mint, graduatedAt: now };
  registry.onGraduated(graduated);
  suite.onGraduated(graduated);
  trade(1_400, 'PUMP_AMM', 'BUY', 'public-1');
  trade(1_600, 'PUMP_AMM', 'BUY', 'public-2');
  trade(1_800, 'PUMP_AMM', 'BUY', 'public-3');
  trade(2_000, 'PUMP_AMM', 'BUY', 'public-scale');
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE status='OPEN' AND capital_in_sol=1 AND entry_tx_count=2
  `).get().n, 2);

  const weakFlow = {
    current: { netFlowSol: 0.155, netFlowSharePct: 0.24, buyers: 47, buyTx: 60 },
    previous: { buyTx: 41 },
  };
  assert.strictEqual(suite._flowQualified(
    weakFlow, { flowGate: 'STRICT' }, { graduatedAt: base + 1_000 }, base + 1_200,
  ), false, 'high churn with negligible net share must fail the strict flow gate');
  assert.strictEqual(suite._flowQualified(
    { current: { netFlowSol: 2, netFlowSharePct: 5, buyers: 4, buyTx: 5 },
      previous: { buyTx: 2 } },
    { flowGate: 'STRICT' }, { graduatedAt: base + 1_000 }, base + 1_200,
  ), true);

  trade(2_400, 'PUMP_AMM', 'BUY', 'public-rise', 2_000);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE exit_profile_id='RUNNER' AND status='RUNNER' AND core_sold_at IS NOT NULL
  `).get().n, 1);
  trade(2_600, 'PUMP_AMM', 'SELL', 'public-fall', 1_100);
  trade(2_800, 'PUMP_AMM', 'BUY', 'public-exit', 1_100);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_consensus_flow_runner_shadow_positions
    WHERE exit_profile_id='RUNNER' AND status='CLOSED' AND exit_reason='RUNNER_TRAIL'
      AND net_return_pct IS NOT NULL
  `).get().n, 1);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  // Rolling discovery requires two distinct graduated seed tokens and applies
  // the configured forward delay; one lucky token cannot enter the pool.
  for (let index = 1; index <= 2; index += 1) {
    const seedMint = `Discovery${index}11111111111111111111111111111`;
    store.recordCreate({
      mint: seedMint, symbol: `D${index}`, name: null, uri: null, bondingCurve: null,
      creator: 'other-creator', createdAt: now - 1_000,
      initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
    });
    store.queueRawTrade({
      mint: seedMint, timestampMs: now + index, receivedAtMs: now + index,
      market: 'PUMP_BONDING_CURVE', side: 'BUY', wallet: 'candidate-wallet',
      solAmount: 0.5, tokenAmount: 500, price: 0.001, curvePct: 20,
      signature: `discover-${index}`, eventIndex: 0,
    });
    store.flushRawTrades();
    registry.onGraduated({ mint: seedMint, graduatedAt: now + 100 + index });
  }
  const candidate = store.db.prepare(`
    SELECT * FROM smart_wallet_registry WHERE wallet='candidate-wallet'
  `).get();
  assert(candidate);
  assert.strictEqual(candidate.effective_from, now + 102 + registryConfig.discoveryDelayMs);
  assert.strictEqual(registry.walletSnapshot('candidate-wallet', now + 500), null);
  assert(registry.monitoringSnapshot('candidate-wallet', now + 500),
    'a candidate must be monitored immediately so it can earn forward labels');
  assert.strictEqual(registry.walletSnapshot('candidate-wallet', now + 2_000), null,
    'an ungraded, unknown-cluster candidate must not receive a consensus vote');
  registry.setGrades({
    wallet: 'candidate-wallet', selectionGrade: 'S_B', copyGrade: 'C_C',
    holdingGrade: 'H_C', status: 'ACTIVE', effectiveAt: now + 1_500,
  });
  assert.strictEqual(registry.walletSnapshot('candidate-wallet', now + 2_000), null,
    'an auto-discovered wallet still needs a known independent cluster');
  registry.setCluster({
    wallet: 'candidate-wallet', clusterId: 'candidate-known-cluster',
    confidence: 'CONFIRMED', validFrom: now + 1_500,
  });
  assert(registry.walletSnapshot('candidate-wallet', now + 2_000));

  const noExitMint = 'NoExitLabel111111111111111111111111111111';
  const noExitSignalAt = now + 3_000;
  store.recordCreate({
    mint: noExitMint, symbol: 'NX', name: null, uri: null, bondingCurve: null,
    creator: 'creator-nx', createdAt: noExitSignalAt - 1_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  registry.onSmartWalletEvent({
    id: 9_001, mint: noExitMint, wallet: 'smart-a', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: noExitSignalAt, market: 'PUMP_BONDING_CURVE', price: 0.001,
  });
  registry.observeTrade({
    mint: noExitMint, wallet: 'public-label-entry', side: 'BUY',
    timestampMs: noExitSignalAt + 100, market: 'PUMP_BONDING_CURVE',
    price: 0.001, reservePrice: 0.001, solAmount: 0.5, tokenAmount: 500,
    virtualTokenReservesRaw: '1000000000000', virtualSolReservesRaw: '1000000000000',
  });
  registry.advanceTime(noExitSignalAt + 3_101);
  const noExitLabel = store.db.prepare(`
    SELECT status, return_300s_pct FROM smart_wallet_forward_labels WHERE smart_event_id=9001
  `).get();
  assert.deepStrictEqual(noExitLabel, { status: 'NO_EXIT', return_300s_pct: -100 },
    'missing 300-second liquidity must be scored conservatively instead of disappearing');
  registry.refreshGrades(noExitSignalAt + 3_101);
  const smartAMetrics = JSON.parse(store.db.prepare(`
    SELECT metrics_json FROM smart_wallet_registry WHERE wallet='smart-a'
  `).get().metrics_json);
  assert.strictEqual(smartAMetrics.noExitSamples, 1,
    'NO_EXIT labels must participate in rolling wallet grades');
  const registryDashboard = registry.dashboard(2);
  assert.strictEqual(registryDashboard.health.wallets, 4);
  assert.strictEqual(registryDashboard.wallets.length, 2);
  assert.strictEqual(registryDashboard.walletLimit, 2);
  assert.deepStrictEqual(registryDashboard.sourceCounts, {
    CONFIG_SEED: 3,
    GRADUATED_EARLY_BUYER: 1,
  });

  const dashboard = suite.dashboard(20);
  assert.strictEqual(dashboard.sendsTransactions, false);
  assert.strictEqual(dashboard.rugPolicy, 'OBSERVE_ONLY_NOT_AN_ENTRY_FILTER');
  store.close();
  await testWalletAgeGate(costModel);
  console.log('Smart Wallet Consensus Flow Runner V2 tests: PASS');
}

async function testWalletAgeGate(costModel) {
  const DAY = 24 * 60 * 60_000;
  const now = 1_900_100_000_000;
  const migrationStore = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  migrationStore.db.exec(`
    CREATE TABLE smart_wallet_registry (
      wallet TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      selection_grade TEXT NOT NULL,
      copy_grade TEXT NOT NULL,
      holding_grade TEXT NOT NULL,
      risk_status TEXT NOT NULL,
      source TEXT NOT NULL,
      discovered_at INTEGER NOT NULL,
      effective_from INTEGER NOT NULL,
      last_seen_at INTEGER,
      metrics_json TEXT NOT NULL,
      registry_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const migrationRegistry = new SmartWalletRegistry({
    config: {
      enabled: true, ageCheckEnabled: false, labelPositionSol: 1, costModel,
    },
    store: migrationStore,
    now: () => now,
  });
  const migratedColumns = new Set(migrationStore.db.prepare(
    'PRAGMA table_info(smart_wallet_registry)',
  ).all().map((column) => column.name));
  for (const column of [
    'age_status', 'first_chain_activity_at', 'age_verified_at', 'age_source',
    'age_check_error', 'age_check_after', 'age_scan_before_signature',
    'age_history_complete',
  ]) assert(migratedColumns.has(column), `legacy registry must migrate ${column}`);
  assert(migrationRegistry.discoverWallet({
    wallet: 'migration-wallet', discoveredAt: now, effectiveFrom: now,
  }));
  migrationRegistry.stop();
  migrationStore.close();
  const histories = {
    'wallet-young': [{ signature: 'young-1', slot: 10, blockTime: (now - 2 * DAY) / 1_000 }],
    'wallet-probation': [{
      signature: 'probation-1', slot: 9, blockTime: (now - 10 * DAY) / 1_000,
    }],
    'wallet-old': [{ signature: 'old-1', slot: 8, blockTime: (now - 40 * DAY) / 1_000 }],
  };
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.method === 'getFirstAvailableBlock') {
      return { ok: true, json: async () => ({ result: 0 }) };
    }
    if (body.method === 'getSignaturesForAddress') {
      const wallet = body.params[0];
      if (wallet === 'wallet-unknown') throw new Error('rpc unavailable');
      return { ok: true, json: async () => ({ result: histories[wallet] || [] }) };
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  };
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const registry = new SmartWalletRegistry({
    config: {
      enabled: true,
      seedWallets: [],
      seedClusters: [],
      discoveryEnabled: false,
      discoveryDelayMs: 0,
      ageCheckEnabled: true,
      ageRpcUrl: 'https://rpc.test',
      ageHardRejectMs: 7 * DAY,
      ageMinVoteMs: 30 * DAY,
      ageRetryMs: 60_000,
      ageRpcTimeoutMs: 5_000,
      ageRpcPageSize: 100,
      ageRpcPagesPerCheck: 2,
      ageCheckConcurrency: 1,
      ageSeedBypass: false,
      autoVoteRequiresActive: true,
      autoVoteRequiresKnownCluster: true,
      labelPositionSol: 1,
      costModel,
    },
    store,
    now: () => now,
    fetchImpl,
  });
  for (const wallet of ['wallet-young', 'wallet-probation', 'wallet-old', 'wallet-unknown']) {
    registry.discoverWallet({
      wallet, source: 'GRADUATED_EARLY_BUYER', discoveredAt: now - 1_000,
      effectiveFrom: now - 1_000,
    });
    registry.setGrades({
      wallet, selectionGrade: 'S_A', copyGrade: 'C_A', holdingGrade: 'H_A',
      status: 'ACTIVE', effectiveAt: now - 500,
    });
    registry.setCluster({
      wallet, clusterId: `${wallet}-cluster`, confidence: 'CONFIRMED',
      validFrom: now - 500,
    });
    await registry.verifyWalletAge(wallet, now);
  }
  const ageRows = Object.fromEntries(store.db.prepare(`
    SELECT wallet, age_status FROM smart_wallet_registry ORDER BY wallet
  `).all().map((row) => [row.wallet, row.age_status]));
  assert.deepStrictEqual(ageRows, {
    'wallet-old': 'ELIGIBLE',
    'wallet-probation': 'PROBATION',
    'wallet-unknown': 'UNKNOWN',
    'wallet-young': 'TOO_NEW',
  });
  assert.strictEqual(registry.monitoringSnapshot('wallet-young', now), null,
    'wallets younger than seven days must be excluded from smart-wallet monitoring');
  assert(registry.monitoringSnapshot('wallet-probation', now));
  assert.strictEqual(registry.walletSnapshot('wallet-probation', now), null,
    'wallets aged seven to thirty days must remain observation-only');
  assert.strictEqual(registry.walletSnapshot('wallet-unknown', now), null,
    'unknown age must fail closed');
  assert(registry.walletSnapshot('wallet-old', now),
    'only a wallet with at least thirty days of verified history may vote');
  const health = registry.health();
  assert.strictEqual(health.ageTooNew, 1);
  assert.strictEqual(health.ageProbation, 1);
  assert.strictEqual(health.ageUnknown, 1);
  assert.strictEqual(health.ageEligible, 1);
  assert.strictEqual(health.votingEligible, 1);
  registry.stop();
  store.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
