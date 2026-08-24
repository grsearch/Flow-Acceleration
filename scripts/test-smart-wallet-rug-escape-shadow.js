'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { SmartWalletRugEscapeShadowSuite } = require('../src/core/SmartWalletRugEscapeShadowSuite');

function main() {
  const base = 1_800_800_000_000;
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
    emergencyWindowMs: 10_000,
    emergencyRecentFlowMs: 1_000,
    labelHorizonMs: 30_000,
    minLargeSellSol: 1,
    minSellBuyFlowRatio: 0.35,
    flowFlipNetSol: -1,
    buyerStallMs: 1_500,
    minBuyersBeforeStall: 3,
    fastDropPct: 15,
    rug50Pct: 50,
    rug70Pct: 70,
    maxEntryPriceJumpPct: 20,
    maxEntryPriceDropPct: 30,
    syntheticMinRunupPct: 35,
    syntheticMinBuySharePct: 85,
    syntheticMaxAlternationPct: 12,
    syntheticMinConsecutiveBuys: 8,
    syntheticMinRepeatedSizePct: 45,
    syntheticMinWalletSharePct: 55,
    syntheticMinFlags: 2,
    profiles: [
      { id: 'BASE_T30', holdMs: 30_000, emergencyExit: false, syntheticGuard: false },
      { id: 'EE10', holdMs: 30_000, emergencyExit: true, syntheticGuard: false },
      { id: 'SRG_EE10', holdMs: 30_000, emergencyExit: true, syntheticGuard: true },
    ],
    costModel: {
      platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const riskTracker = {
    snapshot: (mint) => mint.includes('Guard') ? {
      flagged: false,
      returnPct: 80,
      buySharePct: 95,
      sideAlternationPct: 2,
      maxConsecutiveBuys: 15,
      repeatedBuySizeSharePct: 80,
      maxWalletBuyTxSharePct: 70,
    } : {
      flagged: false,
      returnPct: 5,
      buySharePct: 55,
      sideAlternationPct: 60,
      maxConsecutiveBuys: 3,
      repeatedBuySizeSharePct: 10,
      maxWalletBuyTxSharePct: 15,
    },
  };
  const suite = new SmartWalletRugEscapeShadowSuite({
    config, store, rugRiskTracker: riskTracker, now: () => now,
  });
  suite.start();

  const trade = (mint, offset, side, sol, wallet, price) => {
    sequence += 1;
    now = base + offset;
    const quoteSol = Math.max(1, Math.round(price * 100_000_000 * 1e9));
    const row = {
      mint, symbol: 'SWRE', timestampMs: now, market: 'PUMP_BONDING_CURVE',
      side, solAmount: sol, tokenAmount: sol / price, wallet, price, reservePrice: price,
      virtualTokenReservesRaw: '100000000000000',
      virtualSolReservesRaw: String(quoteSol),
      signature: `swre-${sequence}`, eventIndex: 0,
    };
    suite.observeTrade(row);
    return row;
  };

  const mint = 'SmartWalletRugEscape11111111111111111111111';
  suite.onSmartWalletEvent({
    id: 1, mint, symbol: 'SWRE', wallet: 'smart-a', side: 'BUY', positionPhase: 'OPEN',
    timestampMs: base, price: 0.000001, market: 'PUMP_BONDING_CURVE',
  });
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM smart_wallet_rug_escape_shadow_positions',
  ).get().n, 3);

  suite.onSmartWalletEvent({
    id: 2, mint, wallet: 'smart-a', side: 'BUY', positionPhase: 'ADD',
    timestampMs: base + 100, price: 0.000001, market: 'PUMP_BONDING_CURVE',
  });
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM smart_wallet_rug_escape_shadow_positions',
  ).get().n, 3, 'ADD must never create a new episode');

  trade(mint, 250, 'BUY', 0.5, 'public-entry', 0.000001);
  trade(mint, 500, 'BUY', 0.5, 'public-b', 0.00000102);
  trade(mint, 700, 'BUY', 0.5, 'public-c', 0.00000103);
  trade(mint, 1_000, 'SELL', 5, 'public-dump', 0.0000009);
  trade(mint, 1_300, 'SELL', 0.5, 'public-exit-fill', 0.00000085);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM smart_wallet_rug_escape_shadow_positions
    WHERE cohort_id IN ('EE10','SRG_EE10') AND status='CLOSED'
      AND emergency_reason='FIRST_LARGE_SELL'`).get().n, 2);

  trade(mint, 2_000, 'SELL', 5, 'public-rug', 0.0000004);
  trade(mint, 30_300, 'BUY', 0.05, 'late-reference', 0.00000038);
  trade(mint, 30_600, 'BUY', 0.05, 'late-exit-fill', 0.00000037);
  now = base + 34_100;
  suite.advanceTime(now);

  const baseline = store.db.prepare(`SELECT * FROM smart_wallet_rug_escape_shadow_positions
    WHERE smart_event_id=1 AND cohort_id='BASE_T30'`).get();
  const emergency = store.db.prepare(`SELECT * FROM smart_wallet_rug_escape_shadow_positions
    WHERE smart_event_id=1 AND cohort_id='EE10'`).get();
  assert.strictEqual(baseline.status, 'CLOSED');
  assert.strictEqual(baseline.caught_rug, 1);
  assert.strictEqual(emergency.escaped_before_rug, 1);
  assert(emergency.exit_at < emergency.rug50_at);

  const guardMint = 'SmartWalletGuard111111111111111111111111111';
  now = base + 40_000;
  suite.onSmartWalletEvent({
    id: 3, mint: guardMint, symbol: 'GUARD', wallet: 'smart-b', side: 'BUY',
    positionPhase: 'OPEN', timestampMs: now, price: 0.000001,
    market: 'PUMP_BONDING_CURVE',
  });
  const blocked = store.db.prepare(`SELECT * FROM smart_wallet_rug_escape_shadow_positions
    WHERE smart_event_id=3 AND cohort_id='SRG_EE10'`).get();
  assert.strictEqual(blocked.status, 'NO_ENTRY');
  assert.strictEqual(blocked.rejection_reason, 'SYNTHETIC_RAMP_GUARD');
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  const dashboard = suite.dashboard(20);
  assert(dashboard.groups.length >= 3);
  assert(dashboard.walletStats.length >= 1);
  assert.strictEqual(dashboard.health.firstOpens, 2);
  assert.strictEqual(dashboard.health.ignoredAdds, 1);
  store.close();
  console.log('Smart Wallet Rug Escape Shadow tests: PASS');
}

main();
