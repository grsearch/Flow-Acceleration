'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { CyaOrganicBurstShadowSuite } = require('../src/core/CyaOrganicBurstShadowSuite');

function main() {
  const base = 1_801_000_000_000;
  let now = base;
  let sequence = 0;
  const targetWallet = 'cya-target-wallet';
  const otherSmartWallet = 'other-smart-wallet';
  const mint = 'CyaOrganicBurst11111111111111111111111111';
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  store.recordCreate({
    mint, symbol: 'COB', name: null, uri: null, bondingCurve: null,
    creator: 'creator-wallet', createdAt: base - 6_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  const config = {
    enabled: true,
    targetWallet,
    smartWallets: [targetWallet, otherSmartWallet],
    positionSizeSol: 1,
    featureWindowMs: 15_000,
    maxTradesPerMint: 32,
    stateRetentionMs: 60_000,
    episodeCooldownMs: 60_000,
    targetLabelWindowMs: 15_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 35,
    maxEntryPriceDropPct: 35,
    maxEntryImpactPct: 25,
    entryProfiles: [
      {
        id: 'COB_A', label: 'broad organic burst', minAgeMs: 2_000, maxAgeMs: 15_000,
        maxCurvePct: 60, minBuyers5s: 4, minBuyTxSharePct: 60,
        minReturn2sPct: -5, minReturn5sPct: 5, maxReturn5sPct: 60,
      },
      {
        id: 'COB_B', label: 'balanced organic burst', minAgeMs: 2_000, maxAgeMs: 10_000,
        maxCurvePct: 55, minBuyers5s: 4, minNetFlow5sSol: 1, minBuyTxSharePct: 65,
        minReturn5sPct: 10, maxReturn5sPct: 60, maxReturn15sPct: 80,
      },
      {
        id: 'COB_C', label: 'early organic burst', minAgeMs: 2_000, maxAgeMs: 8_000,
        maxCurvePct: 50, minBuyers5s: 4, minBuyTxSharePct: 65,
        minReturn2sPct: 0, minReturn5sPct: 10, maxReturn5sPct: 60,
      },
    ],
    exitProfiles: [
      {
        id: 'INV10_X30', label: '10s invalidation / 30s max', maxHoldMs: 30_000,
        structureInvalidationEnabled: true, minInvalidationHoldMs: 1_000,
        invalidationWindowMs: 10_000, invalidationDrawdownPct: 8,
        maxInvalidationReturn2sPct: 0,
      },
      { id: 'FIX20', label: 'fixed 20s', maxHoldMs: 20_000, structureInvalidationEnabled: false },
      { id: 'FIX30', label: 'fixed 30s', maxHoldMs: 30_000, structureInvalidationEnabled: false },
    ],
    costModel: {
      platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0.000005, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const suite = new CyaOrganicBurstShadowSuite({ config, store, now: () => now });
  suite.start();

  const trade = (offset, side, sol, wallet, price) => {
    now = base + offset;
    sequence += 1;
    const row = {
      mint, symbol: 'COB', timestampMs: now, slot: 200 + Math.floor(offset / 400),
      market: 'PUMP_BONDING_CURVE', side, solAmount: sol,
      tokenAmount: sol / price, wallet, price, reservePrice: price,
      virtualTokenReservesRaw: '1000000000000000',
      virtualSolReservesRaw: String(Math.max(1, Math.round(price * 1e18))),
      curvePct: 40, ageMs: 6_000 + offset,
      signature: `cob-${sequence}`, eventIndex: 0,
    };
    return { row, signals: suite.observeTrade(row) };
  };

  trade(-1_500, 'BUY', 1, 'public-1', 0.000000100);
  trade(-1_000, 'BUY', 1, 'public-2', 0.000000106);
  trade(-500, 'BUY', 1, 'public-3', 0.000000112);

  // Monitored-wallet flow is excluded from all causal entry features.
  const excluded = trade(-250, 'BUY', 50, targetWallet, 0.000000116);
  assert.strictEqual(excluded.signals.length, 0);
  assert.strictEqual(suite.health().excludedSmartTrades, 1);

  const signal = trade(0, 'BUY', 1, 'public-4', 0.000000120);
  assert.strictEqual(signal.signals.length, 9);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions',
  ).get().n, 9);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE buyers_5s=4 AND ABS(net_flow_5s-4)<0.000001
      AND buy_tx_5s=4 AND sell_tx_5s=0
  `).get().n, 9, 'monitored-wallet trade must not contaminate public-flow features');

  // A monitored-wallet trade after the delay cannot fill a pending entry.
  trade(225, 'BUY', 20, targetWallet, 0.000000122);
  assert.strictEqual(suite.health().opened, 0);
  trade(250, 'BUY', 0.2, 'public-fill', 0.000000122);
  assert.strictEqual(suite.health().opened, 9);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE status='OPEN' AND entry_impact_pct IS NOT NULL AND total_invested_sol=1
  `).get().n, 9);

  // CYA's first OPEN remains a future label only.
  now = base + 500;
  assert.strictEqual(suite.onSmartWalletEvent({
    mint, wallet: targetWallet, side: 'BUY', positionPhase: 'OPEN', timestampMs: now,
  }), 9);

  // A fast reversal closes only INV10; fixed-hold controls remain open.
  trade(1_500, 'BUY', 0.1, 'public-high', 0.000000150);
  trade(2_500, 'SELL', 0.2, 'public-fail', 0.000000120);
  trade(2_750, 'BUY', 0.1, 'public-invalidation-exit', 0.000000118);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE status='CLOSED' AND exit_profile_id='INV10_X30'
      AND exit_reason='STRUCTURE_INVALIDATION'
  `).get().n, 3);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions WHERE status='OPEN'
  `).get().n, 6);

  now = base + 20_500;
  suite.advanceTime(now);
  trade(20_750, 'BUY', 0.1, 'public-fix20-exit', 0.000000180);
  now = base + 30_500;
  suite.advanceTime(now);
  trade(30_750, 'BUY', 0.1, 'public-fix30-exit', 0.000000240);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions
    WHERE status='CLOSED' AND exit_reason='MAX_HOLD'
  `).get().n, 6);

  // Burst memory remains bounded and same-Mint episode cooldown prevents duplicates.
  for (let index = 0; index < 80; index += 1) {
    trade(31_000 + index, 'BUY', 0.01, `burst-${index}`, 0.000000240);
  }
  assert.ok(suite.states.get(mint).trades.length <= config.maxTradesPerMint);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM cya_organic_burst_shadow_positions',
  ).get().n, 9);

  const dashboard = suite.dashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 9);
  assert.strictEqual(dashboard.positions.length, 9);
  assert.ok(dashboard.cohorts.every((row) => row.target_open_5s_rate_pct === 100));
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);
  store.close();
  console.log('CYA Organic Burst Shadow tests: PASS');
}

main();
