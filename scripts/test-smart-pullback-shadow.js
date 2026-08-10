'use strict';

const assert = require('assert');
const { SmartPullbackShadowSuite } = require('../src/core/SmartPullbackShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function config() {
  return {
    enabled: true,
    minSmartBuySol: 0.1,
    episodeGapMs: 30_000,
    confirmationWindowMs: 15_000,
    pullbackPct: 2.5,
    reboundPct: 7.5,
    minReboundBuyers: 1,
    maxEntryVsSmartBuyPct: 2,
    maxEntryPriceJumpPct: 10,
    positionSizeSol: 0.05,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxHoldMs: 60_000,
    bigWinnerPct: 50,
    cohorts: [
      { id: 'A', label: 'A · Trailing 7.5%', trailingStopPct: 7.5 },
      { id: 'B', label: 'B · Trailing 12.5%', trailingStopPct: 12.5 },
    ],
    costModel: {
      platformFeePct: 1.4,
      buySlippagePct: 0.3,
      sellSlippagePct: 0.3,
      priceImpactPct: 0.2,
      baseTxFeeSol: 0.00001,
      priorityFeeSol: 0.0005,
      positionSizeSol: 0.05,
    },
  };
}

function trade({ mint = 'mint-ab', timestampMs, price, side = 'BUY', wallet = 'regular' }) {
  return {
    mint,
    symbol: mint,
    timestampMs,
    receivedAtMs: timestampMs,
    slot: timestampMs,
    signature: `${mint}-${timestampMs}-${wallet}`,
    eventIndex: 0,
    price,
    side,
    wallet,
    solAmount: 0.2,
    tokenAmount: 1_000,
    curvePct: 50,
    ageMs: 10_000,
    market: 'PUMP_BONDING_CURVE',
  };
}

function main() {
  const store = makeStore();
  let now = 90_000;
  let suite = new SmartPullbackShadowSuite({ config: config(), store, now: () => now });
  suite.start();

  const smartTrade = trade({ timestampMs: 100_000, price: 1, wallet: 'smart-wallet' });
  const smartEvent = store.recordSmartWalletEvent(smartTrade);
  suite.onSmartWalletBuy({ ...smartTrade, id: smartEvent.id });
  assert.strictEqual(suite.health().episodes, 1, 'A/B rows share one Smart episode');
  let dashboard = store.smartPullbackShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(dashboard.positions.length, 2, 'the same episode must create A and B rows');
  assert.deepStrictEqual(
    new Set(dashboard.positions.map((row) => row.status)),
    new Set(['WAITING_PULLBACK']),
  );
  suite.stop();
  suite = new SmartPullbackShadowSuite({ config: config(), store, now: () => now });
  suite.start();
  assert.strictEqual(suite.health().candidates, 2, 'restart must restore both A/B candidates');

  suite.observeTrade(trade({ timestampMs: 100_100, price: 0.9, side: 'SELL' }));
  suite.observeTrade(trade({ timestampMs: 100_200, price: 0.968, wallet: 'rebound-buyer' }));
  dashboard = store.smartPullbackShadowDashboard({ bigWinnerPct: 50 });
  assert.ok(dashboard.positions.every((row) => row.status === 'PENDING_ENTRY'));
  suite.observeTrade(trade({ timestampMs: 100_300, price: 0.969 }));
  assert.strictEqual(suite.health().pendingEntries, 2, 'entry must wait 200ms');
  suite.observeTrade(trade({ timestampMs: 100_400, price: 0.97 }));
  assert.strictEqual(suite.health().activePositions, 2);
  dashboard = store.smartPullbackShadowDashboard({ bigWinnerPct: 50 });
  assert.deepStrictEqual(
    new Set(dashboard.positions.map((row) => `${row.entry_at}:${row.entry_price}`)),
    new Set(['100400:0.97']),
    'A/B must share the exact same simulated fill',
  );

  suite.observeTrade(trade({ timestampMs: 100_500, price: 2, side: 'BUY' }));
  suite.observeTrade(trade({ timestampMs: 100_600, price: 1.84, side: 'SELL' }));
  assert.strictEqual(
    suite.health().cohorts.find((cohort) => cohort.cohortId === 'A').activePositions,
    1,
    'A should be waiting for its delayed exit',
  );
  suite.observeTrade(trade({ timestampMs: 100_800, price: 1.85 }));
  dashboard = store.smartPullbackShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(
    dashboard.positions.find((row) => row.cohort_id === 'A').status,
    'CLOSED',
  );
  assert.strictEqual(
    dashboard.positions.find((row) => row.cohort_id === 'B').status,
    'OPEN',
  );

  suite.observeTrade(trade({ timestampMs: 101_000, price: 3 }));
  suite.observeTrade(trade({ timestampMs: 101_100, price: 2.6, side: 'SELL' }));
  suite.observeTrade(trade({ timestampMs: 101_300, price: 2.61 }));
  dashboard = store.smartPullbackShadowDashboard({ bigWinnerPct: 50 });
  assert.ok(dashboard.positions.every((row) => row.status === 'CLOSED'));
  assert.strictEqual(dashboard.cohorts.length, 2);
  for (const cohort of dashboard.cohorts) {
    assert.strictEqual(cohort.resolved, 1);
    assert.strictEqual(cohort.big_winner_opportunities, 1);
    assert.strictEqual(cohort.big_winners_realized, 1);
    assert.strictEqual(cohort.top_5_winner_contribution_pct, 100);
  }
  assert.ok(
    dashboard.cohorts.find((cohort) => cohort.cohort_id === 'B').max_winner_pct
      > dashboard.cohorts.find((cohort) => cohort.cohort_id === 'A').max_winner_pct,
    'the wider B trail should capture the later right-tail move in this scenario',
  );

  const stale = trade({ mint: 'no-confirm', timestampMs: 200_000, price: 1, wallet: 'smart-2' });
  const staleEvent = store.recordSmartWalletEvent(stale);
  suite.onSmartWalletBuy({ ...stale, id: staleEvent.id });
  now = 215_001;
  suite.advanceTime(now);
  dashboard = store.smartPullbackShadowDashboard({ bigWinnerPct: 50 });
  assert.strictEqual(
    dashboard.positions.filter((row) => row.mint === 'no-confirm'
      && row.status === 'NO_CONFIRMATION').length,
    2,
  );

  const health = suite.health();
  assert.strictEqual(health.mode, 'SHADOW_AB');
  assert.strictEqual(health.sendsTransactions, false);
  assert.deepStrictEqual(
    health.cohorts.map((cohort) => [
      cohort.cohortId,
      cohort.strategy.exit.trailingStopPct,
      cohort.strategy.research.sendsTransactions,
    ]),
    [['A', 7.5, false], ['B', 12.5, false]],
  );
  store.close();
  console.log('smart pullback shadow tests passed');
}

main();
