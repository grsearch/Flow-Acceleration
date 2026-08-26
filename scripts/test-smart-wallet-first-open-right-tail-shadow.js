'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  SmartWalletFirstOpenRightTailShadowSuite,
} = require('../src/core/SmartWalletFirstOpenRightTailShadowSuite');

function main() {
  const base = 1_800_900_000_000;
  let now = base;
  let sequence = 0;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const config = {
    enabled: true,
    positionSizeSol: 1,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 2_000,
    flowFadeWindowMs: 3_000,
    maxEpisodeMs: 130_000,
    maxEntryPriceJumpPct: 20,
    maxEntryPriceDropPct: 30,
    entryProfiles: [
      { id: 'S50_R8', maxPreReturnPct: 50, maxConsecutiveBuys: 8 },
      { id: 'B70_R10', maxPreReturnPct: 70, maxConsecutiveBuys: 10 },
    ],
    exitProfiles: [
      { id: 'X20', mode: 'FIXED', maxHoldMs: 20_000, hardStopPct: 0, coreWeightPct: 0 },
      {
        id: 'C25_R75_X120', mode: 'CORE_RUNNER', maxHoldMs: 120_000,
        hardStopPct: 0, coreWeightPct: 25, coreActivationPct: 20,
        trailingDrawdownPct: 20,
      },
    ],
    costModel: {
      platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const risks = {
    strict: {
      returnPct: 40, maxConsecutiveBuys: 8, buySharePct: 72,
      sideAlternationPct: 45, repeatedBuySizeSharePct: 12,
      maxWalletBuyTxSharePct: 18,
    },
    balanced: {
      returnPct: 60, maxConsecutiveBuys: 9, buySharePct: 68,
      sideAlternationPct: 40, repeatedBuySizeSharePct: 20,
      maxWalletBuyTxSharePct: 25,
    },
    incomplete: { returnPct: 20 },
  };
  const suite = new SmartWalletFirstOpenRightTailShadowSuite({
    config,
    store,
    rugRiskTracker: { snapshot: (mint) => risks[mint] || {} },
    now: () => now,
  });
  suite.start();

  const smartOpen = (id, mint, timestampMs = now) => suite.onSmartWalletEvent({
    id, mint, symbol: 'SWFO', wallet: `smart-${id}`, side: 'BUY',
    positionPhase: 'OPEN', timestampMs, price: 0.000001,
    market: 'PUMP_BONDING_CURVE',
  });
  const trade = (mint, timestampMs, price, side = 'BUY', solAmount = 0.5) => {
    sequence += 1;
    now = timestampMs;
    const quoteSolRaw = Math.max(1, Math.round(price * 100_000_000 * 1e9));
    suite.observeTrade({
      mint, symbol: 'SWFO', timestampMs, market: 'PUMP_BONDING_CURVE',
      side, solAmount, tokenAmount: solAmount / price,
      wallet: `public-${sequence}`, price, reservePrice: price,
      virtualTokenReservesRaw: '100000000000000',
      virtualSolReservesRaw: String(quoteSolRaw),
      signature: `swfo-${sequence}`, eventIndex: 0,
    });
  };

  smartOpen(1, 'strict', base);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM smart_wallet_first_open_right_tail_shadow_positions`).get().n, 4);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM smart_wallet_first_open_right_tail_shadow_positions
    WHERE status='PENDING_ENTRY'`).get().n, 4);

  suite.onSmartWalletEvent({
    id: 2, mint: 'strict', wallet: 'smart-1', side: 'BUY', positionPhase: 'ADD',
    timestampMs: base + 100, price: 0.000001, market: 'PUMP_BONDING_CURVE',
  });
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM smart_wallet_first_open_right_tail_shadow_positions`).get().n, 4,
  'ADD must not create a new episode');

  trade('strict', base + 250, 0.000001);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM smart_wallet_first_open_right_tail_shadow_positions
    WHERE status='OPEN'`).get().n, 4);
  trade('strict', base + 20_300, 0.0000013);
  trade('strict', base + 20_600, 0.00000128);
  trade('strict', base + 20_900, 0.00000127, 'SELL');
  const fixed = store.db.prepare(`SELECT *
    FROM smart_wallet_first_open_right_tail_shadow_positions
    WHERE smart_event_id=1 AND cohort_id='S50_R8:X20'`).get();
  assert.strictEqual(fixed.status, 'CLOSED');
  assert(fixed.net_return_pct > 0);
  assert.strictEqual(fixed.pre_side_alternation_pct, 45);
  assert.strictEqual(fixed.pre_largest_wallet_share_pct, 18);

  trade('strict', base + 21_000, 0.0000016);
  trade('strict', base + 21_300, 0.00000125, 'SELL');
  trade('strict', base + 21_600, 0.00000124, 'SELL');
  const runner = store.db.prepare(`SELECT *
    FROM smart_wallet_first_open_right_tail_shadow_positions
    WHERE smart_event_id=1 AND cohort_id='S50_R8:C25_R75_X120'`).get();
  assert.strictEqual(runner.status, 'CLOSED');
  assert(runner.core_exit_at > 0);
  assert(Number.isFinite(runner.core_realized_return_pct));
  assert(Number.isFinite(runner.runner_realized_return_pct));

  now = base + 30_000;
  smartOpen(3, 'balanced', now);
  const balancedRows = store.db.prepare(`SELECT entry_profile_id, status
    FROM smart_wallet_first_open_right_tail_shadow_positions
    WHERE smart_event_id=3 ORDER BY entry_profile_id, exit_profile_id`).all();
  assert.strictEqual(balancedRows.filter((row) => row.entry_profile_id === 'S50_R8'
    && row.status === 'RULE_REJECTED').length, 2);
  assert.strictEqual(balancedRows.filter((row) => row.entry_profile_id === 'B70_R10'
    && row.status === 'PENDING_ENTRY').length, 2);

  now = base + 40_000;
  smartOpen(4, 'incomplete', now);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM smart_wallet_first_open_right_tail_shadow_positions
    WHERE smart_event_id=4 AND status='RULE_REJECTED'
      AND rejection_reason='INCOMPLETE_PRE_ENTRY_RISK'`).get().n, 4);

  now = base + 50_000;
  smartOpen(5, 'strict', now);
  trade('strict', now + 250, 0.000001);
  now = base + 181_000;
  suite.advanceTime(now);
  const noExit = store.db.prepare(`SELECT status, net_return_pct
    FROM smart_wallet_first_open_right_tail_shadow_positions
    WHERE smart_event_id=5 AND cohort_id='S50_R8:C25_R75_X120'`).get();
  assert.strictEqual(noExit.status, 'NO_EXIT');
  assert.strictEqual(noExit.net_return_pct, null, 'NO_EXIT is not a -100% return');

  const dashboard = suite.dashboard(50);
  assert(dashboard.groups.length === 4);
  assert.strictEqual(dashboard.sendsTransactions, false);
  assert.strictEqual(dashboard.health.ignoredAdds, 1);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);
  store.close();
  console.log('Smart Wallet First OPEN Right-Tail Shadow tests: PASS');
}

main();
