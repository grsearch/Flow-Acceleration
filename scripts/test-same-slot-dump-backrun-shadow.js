'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  SameSlotDumpBackrunShadowSuite,
} = require('../src/core/SameSlotDumpBackrunShadowSuite');

function main() {
  const base = 1_801_000_000_000;
  let now = base;
  let sequence = 0;
  const mint = 'SameSlotDumpBackrun1111111111111111111111';
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const config = {
    enabled: true,
    positionSizeSol: 0.1,
    trackingAgeMs: 15 * 60_000,
    stateRetentionMs: 20 * 60_000,
    episodeCooldownMs: 10_000,
    exitGraceMs: 2_000,
    maxEpisodesPerMint: 20,
    entryProfiles: [
      {
        id: 'SDBR-S10-D15', minSellSol: 10, minDropPct: 15, maxDropPct: 70,
        minQuoteReserveSol: 5, maxEntryImpactPct: 12,
      },
      {
        id: 'SDBR-S20-D20', minSellSol: 20, minDropPct: 20, maxDropPct: 70,
        minQuoteReserveSol: 5, maxEntryImpactPct: 12,
      },
    ],
    exitProfiles: [
      { id: 'H250', kind: 'FIXED', holdMs: 250 },
      { id: 'H500', kind: 'FIXED', holdMs: 500 },
      { id: 'H1000', kind: 'FIXED', holdMs: 1_000 },
      { id: 'H2000', kind: 'FIXED', holdMs: 2_000 },
      { id: 'TP8-H2000', kind: 'TAKE_OR_FIXED', takeProfitPct: 8, maxHoldMs: 2_000 },
    ],
    costModel: {
      platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 0.1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const suite = new SameSlotDumpBackrunShadowSuite({ config, store, now: () => now });
  suite.start();
  suite.onGraduated({ mint, completedAt: base - 1_000 });

  const trade = ({ offset, slot, side, sol, price, quoteSol, wallet }) => {
    now = base + offset;
    sequence += 1;
    const tokenAmount = sol / price;
    return {
      mint,
      symbol: 'SDBR',
      timestampMs: now,
      receivedAtMs: now,
      chainTimestampMs: now - 10,
      slot,
      market: 'PUMP_AMM',
      side,
      solAmount: sol,
      tokenAmount,
      wallet,
      price,
      reservePrice: price,
      poolBaseReservesRaw: '1000000000000000',
      poolQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
      virtualQuoteReservesRaw: '0',
      signature: `sdbr-${sequence}`,
      eventIndex: 0,
    };
  };

  // Prime the causal pre-dump price without creating a signal.
  suite.observeTrade(trade({
    offset: -100, slot: 500, side: 'BUY', sol: 0.1, price: 0.00000010,
    quoteSol: 100, wallet: 'prior-buyer',
  }));

  const signalTrade = trade({
    offset: 0, slot: 501, side: 'SELL', sol: 20, price: 0.00000007,
    quoteSol: 70, wallet: 'dump-wallet',
  });
  const signals = suite.observeTrade(signalTrade);
  assert.strictEqual(signals.length, 2, 'both dump filters should qualify');
  assert.strictEqual(suite.health().simulatedEntries, 10);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM same_slot_dump_backrun_shadow_positions',
  ).get().n, 0, 'the trade hot path must not write SQLite');

  // The first independent follower arrives in the same slot after 100ms.
  suite.observeTrade(trade({
    offset: 100, slot: 501, side: 'BUY', sol: 3.6, price: 0.000000072,
    quoteSol: 72, wallet: 'same-slot-follower',
  }));
  suite.advanceTime(base + 100);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM same_slot_dump_backrun_shadow_positions',
  ).get().n, 10);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM same_slot_dump_backrun_shadow_positions
    WHERE first_buy_same_slot=1 AND first_buy_delay_ms=100
  `).get().n, 10);

  // Real trade events provide causal capacity-aware exits at each horizon.
  for (const [offset, quoteSol] of [[300, 82], [600, 84], [1_100, 86], [2_100, 88]]) {
    suite.observeTrade(trade({
      offset, slot: offset < 600 ? 501 : 502, side: 'BUY', sol: 0.2,
      price: quoteSol * 1e-9, quoteSol, wallet: `exit-${offset}`,
    }));
  }
  suite.advanceTime(base + 2_100);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM same_slot_dump_backrun_shadow_positions WHERE status='CLOSED'
  `).get().n, 10);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM same_slot_dump_backrun_shadow_positions
    WHERE net_return_pct IS NOT NULL AND exit_impact_pct IS NOT NULL
  `).get().n, 10);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  const dashboard = suite.dashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 10);
  assert.strictEqual(dashboard.positions.length, 10);
  assert.ok(dashboard.cohorts.every((row) => row.same_slot_first_buy_rate_pct === 100));
  assert.ok(dashboard.cohorts.some((row) => row.same_slot_exit_rate_pct === 100));
  assert.ok(dashboard.cohorts.some((row) => row.same_slot_exit_rate_pct === 0));
  assert.strictEqual(suite.health().sendsTransactions, false);
  assert.strictEqual(suite.health().addsRpcRequests, false);
  store.close();
  console.log('Same-Slot Dump Backrun Shadow tests: PASS');
}

main();
