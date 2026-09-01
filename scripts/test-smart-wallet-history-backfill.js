'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { SmartWalletRegistry } = require('../src/core/SmartWalletRegistry');

const DAY_MS = 24 * 60 * 60_000;

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
}

function config(seedWallets = []) {
  return {
    enabled: true,
    seedWallets,
    seedClusters: [],
    discoveryEnabled: true,
    discoveryDelayMs: 0,
    ageCheckEnabled: false,
    pnlGateEnabled: true,
    pnlWindowMs: DAY_MS,
    pnlMinClosedPositions: 1,
    pnlMinRealizedSol: 0,
    pnlMinCapitalReturnPct: 0,
    pnlSnapshotCacheMs: 100,
    elite60dEnabled: true,
    elite60dWindowMs: 60 * DAY_MS,
    elite60dMinRealizedSol: 200,
    historyBackfillEnabled: true,
    historyRpcUrl: '',
    historyWindowMs: 60 * DAY_MS,
    historyWarmupMs: 30 * DAY_MS,
    historyInitialAllEnabled: true,
    historyDailyWalletLimit: 1,
    historyDailyCreditLimit: 250_000,
    historyConcurrency: 1,
    historyPageSize: 1_000,
    historyMaxPagesPerWallet: 100,
    historyRetryMs: 60_000,
    historyCreditsPerPage: 50,
    clusterAutoEnabled: false,
    autoVoteRequiresActive: true,
    autoVoteRequiresKnownCluster: true,
    gradeRefreshMs: DAY_MS,
    lookbackMs: 60 * DAY_MS,
    selectionMinSamples: 30,
    copyMinSamples: 30,
    holdingMinSamples: 30,
    minActiveDays: 7,
    minCopyPf: 1.2,
    minPositiveWindowPct: 70,
    maxTop1ProfitPct: 35,
    holdingBigWinnerPct: 100,
    holdingMinBigWinnerRatePct: 10,
    gradeConfirmationRuns: 2,
    labelPositionSol: 1,
    labelEntryDelayMs: 0,
    labelEntryTimeoutMs: 1_000,
    labelGraceMs: 1_000,
    selectionHorizonMs: 300_000,
    copyReturnHorizonMs: 30_000,
    costModel: {
      platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0, priorityFeeSol: 0,
      jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 1,
    },
  };
}

function event(store, wallet, mint, at, side, sol, signature) {
  return store.recordHistoricalSmartWalletEvent({
    timestampMs: at,
    receivedAtMs: at,
    signature,
    eventIndex: 0,
    wallet,
    mint,
    side,
    market: 'PUMP_AMM',
    solAmount: sol,
    tokenAmount: 100,
    price: sol / 100,
  });
}

function completeHistory(store, wallet, now, ledgerComplete = true) {
  store.db.prepare(`
    UPDATE smart_wallet_history_backfills SET status='COMPLETE',
      window_start_at=?, window_end_at=?, ledger_complete=?, orphan_events=?,
      completed_at=?, updated_at=? WHERE wallet=?
  `).run(
    now - 90 * DAY_MS, now, ledgerComplete ? 1 : 0,
    ledgerComplete ? 0 : 1, now, now, wallet,
  );
}

async function main() {
  const now = 1_900_000_000_000;
  const store = makeStore();
  const registry = new SmartWalletRegistry({
    config: config(['initial-a', 'initial-b']),
    store,
    now: () => now,
  });
  registry.start();

  const initial = store.db.prepare(`
    SELECT wallet, cohort FROM smart_wallet_history_backfills ORDER BY wallet
  `).all();
  assert.deepStrictEqual(initial, [
    { wallet: 'initial-a', cohort: 'INITIAL' },
    { wallet: 'initial-b', cohort: 'INITIAL' },
  ], 'the deployment cohort must be queued as uncapped INITIAL work');

  store.db.prepare(`
    UPDATE smart_wallet_history_backfills SET status='COMPLETE', ledger_complete=1
    WHERE cohort='INITIAL'
  `).run();
  registry.discoverWallet({
    wallet: 'daily-a', source: 'ROLLING_DISCOVERY', discoveredAt: now + 1,
    effectiveFrom: now,
  });
  registry.discoverWallet({
    wallet: 'daily-b', source: 'ROLLING_DISCOVERY', discoveredAt: now + 2,
    effectiveFrom: now,
  });
  const firstDaily = registry._claimHistoryBackfill(now + 3);
  assert(firstDaily && firstDaily.cohort === 'DAILY');
  store.db.prepare(`
    UPDATE smart_wallet_history_backfills SET status='COMPLETE' WHERE wallet=?
  `).run(firstDaily.wallet);
  assert.strictEqual(registry._claimHistoryBackfill(now + 4), null,
    'only one newly-started wallet is allowed when the configured daily limit is one');

  const observedAt = now + 100;
  const elite = 'elite-wallet';
  registry.discoverWallet({
    wallet: elite, source: 'ROLLING_DISCOVERY', discoveredAt: now + 5,
    effectiveFrom: now,
  });
  registry.setCluster({
    wallet: elite, clusterId: 'elite-cluster', confidence: 'CONFIRMED',
    reason: { source: 'TEST' }, validFrom: now - DAY_MS,
  });
  event(store, elite, 'old-win', observedAt - 50 * DAY_MS, 'BUY', 100, 'elite-old-buy');
  event(store, elite, 'old-win', observedAt - 49 * DAY_MS, 'SELL', 350, 'elite-old-sell');
  event(store, elite, 'recent-loss', observedAt - 2 * 60 * 60_000, 'BUY', 100, 'elite-new-buy');
  event(store, elite, 'recent-loss', observedAt - 60 * 60_000, 'SELL', 90, 'elite-new-sell');
  const rebuilt = registry.rebuildActualWalletLedger(elite);
  assert.strictEqual(rebuilt.ledgerComplete, true);
  completeHistory(store, elite, observedAt, true);
  registry.pnlSnapshotCache.clear();

  const monitoring = registry.monitoringSnapshot(elite, observedAt);
  assert.strictEqual(monitoring.actualPnl24h.realizedPnlSol, -10);
  assert.strictEqual(monitoring.actualPnl60d.realizedPnlSol, 240);
  assert.strictEqual(monitoring.pnlStatus, 'PNL_ELITE_60D');
  assert.strictEqual(monitoring.pnlEligibilityClass, 'LONG_TERM_ELITE');
  assert.strictEqual(monitoring.voteWeight, 1);
  assert(registry.walletSnapshot(elite, observedAt),
    'a complete >200 SOL 60d wallet must vote even when its recent 24h loses money');

  const exact = 'exact-200-wallet';
  registry.discoverWallet({
    wallet: exact, source: 'ROLLING_DISCOVERY', discoveredAt: now + 6,
    effectiveFrom: now,
  });
  registry.setCluster({
    wallet: exact, clusterId: 'exact-cluster', confidence: 'CONFIRMED',
    reason: { source: 'TEST' }, validFrom: now - DAY_MS,
  });
  event(store, exact, 'exact-win', observedAt - 40 * DAY_MS, 'BUY', 100, 'exact-buy');
  event(store, exact, 'exact-win', observedAt - 39 * DAY_MS, 'SELL', 300, 'exact-sell');
  registry.rebuildActualWalletLedger(exact);
  completeHistory(store, exact, observedAt, true);
  registry.pnlSnapshotCache.clear();
  assert.strictEqual(registry.monitoringSnapshot(exact, observedAt).longTermElite, false,
    'the threshold is strictly greater than 200 SOL');
  assert.strictEqual(registry.walletSnapshot(exact, observedAt), null);

  const incomplete = 'incomplete-wallet';
  registry.discoverWallet({
    wallet: incomplete, source: 'ROLLING_DISCOVERY', discoveredAt: now + 7,
    effectiveFrom: now,
  });
  store.db.prepare(`
    UPDATE smart_wallet_history_backfills SET status='COMPLETE',
      window_start_at=?, window_end_at=?, ledger_complete=0, orphan_events=1,
      completed_at=?, updated_at=? WHERE wallet=?
  `).run(observedAt - 90 * DAY_MS, observedAt, observedAt, observedAt, incomplete);
  registry.pnlSnapshotCache.clear();
  assert.strictEqual(registry.monitoringSnapshot(incomplete, observedAt).longTermElite, false,
    'an incomplete reconstructed ledger must fail closed');

  registry.stop();
  store.close();

  const rpcStore = makeStore();
  const rpcRequests = [];
  const rpcConfig = config(['rpc-wallet']);
  rpcConfig.historyRpcUrl = '';
  rpcConfig.historyDailyWalletLimit = 50;
  const fakeParser = {
    parseTransaction: (transaction) => transaction.mockEvents || [],
  };
  const fakeFetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    rpcRequests.push(body);
    const cursor = body.params[1].paginationToken;
    const data = cursor ? [] : [{
      blockTime: Math.floor((now - 40 * DAY_MS) / 1_000),
      paginationToken: 'page-1',
      mockEvents: [
        {
          type: 'ammTrade', timestampMs: now - 40 * DAY_MS,
          signature: 'rpc-buy', eventIndex: 0, wallet: 'rpc-wallet',
          mint: 'rpc-mint', side: 'BUY', market: 'PUMP_AMM',
          solAmount: 100, tokenAmount: 100, price: 1,
        },
        {
          type: 'ammTrade', timestampMs: now - 39 * DAY_MS,
          signature: 'rpc-sell', eventIndex: 0, wallet: 'rpc-wallet',
          mint: 'rpc-mint', side: 'SELL', market: 'PUMP_AMM',
          solAmount: 350, tokenAmount: 100, price: 3.5,
        },
      ],
    }];
    return { ok: true, json: async () => ({ result: { data } }) };
  };
  const rpcRegistry = new SmartWalletRegistry({
    config: rpcConfig,
    store: rpcStore,
    now: () => now,
    fetchImpl: fakeFetch,
    transactionParser: fakeParser,
  });
  rpcRegistry.start();
  rpcRegistry.config.historyRpcUrl = 'https://example.invalid/rpc';
  const rpcClaim = rpcRegistry._claimHistoryBackfill(now);
  assert(rpcClaim && rpcClaim.wallet === 'rpc-wallet');
  await rpcRegistry._runHistoryBackfill(rpcClaim);
  const rpcRow = rpcStore.db.prepare(`
    SELECT * FROM smart_wallet_history_backfills WHERE wallet='rpc-wallet'
  `).get();
  assert.strictEqual(rpcRow.status, 'COMPLETE');
  assert.strictEqual(rpcRow.ledger_complete, 1);
  assert.strictEqual(rpcRow.pages_fetched, 2);
  assert.strictEqual(rpcRow.credits_spent, 100);
  assert.strictEqual(rpcRow.inserted_events, 2);
  assert.strictEqual(rpcRequests[0].method, 'getTransactionsForAddress');
  assert.strictEqual(rpcRequests[0].params[1].limit, 1_000);
  assert.strictEqual(rpcRequests[0].params[1].transactionDetails, 'full');
  assert.strictEqual(rpcRequests[0].params[1].filters.status, 'succeeded');
  assert.strictEqual(rpcRequests[1].params[1].paginationToken, 'page-1');
  assert.strictEqual(rpcStore.db.prepare(`
    SELECT realized_pnl_sol FROM smart_wallet_actual_positions
    WHERE wallet='rpc-wallet' AND status='CLOSED'
  `).get().realized_pnl_sol, 250);
  rpcRegistry.stop();
  rpcStore.close();
  console.log('Smart Wallet historical backfill and 60d elite tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
