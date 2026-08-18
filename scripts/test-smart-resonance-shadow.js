'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  SmartResonanceRightTailShadowSuite,
} = require('../src/core/SmartResonanceRightTailShadowSuite');

function main() {
  const base = 1_800_200_000_000;
  let now = base;
  let sequence = 0;
  const wallets = ['smart-a', 'smart-b', 'smart-c'];
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const config = {
    enabled: true,
    positionSizeSol: 1,
    smartWallets: wallets,
    featureWindowMs: 5_000,
    stateRetentionMs: 60_000,
    episodeCooldownMs: 60_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 15,
    maxEntryPriceDropPct: 30,
    maxCrossMarketPriceJumpPct: 50,
    entryProfiles: [
      { id: 'SR_R0', resonanceWindowMs: 5_000, requiredWallets: 2 },
      { id: 'SR_R1', resonanceWindowMs: 5_000, requiredWallets: 2,
        minPublicBuyers5s: 20, minPublicBuyFlow5sSol: 15, maxLargestBuyerSharePct: 25 },
      { id: 'SR_R2', resonanceWindowMs: 60_000, requiredWallets: 3,
        minPublicBuyers5s: 20, maxLargestBuyerSharePct: 20 },
      { id: 'SR_R3', resonanceWindowMs: 60_000, requiredWallets: 2,
        minPublicBuyers5s: 20, requirePreGraduation: true,
        maxAgeMs: 25_000, minCurvePct: 60, maxCurvePct: 80 },
    ],
    exitProfiles: [
      { id: 'H20_T1', hardStopPct: 20, maxHoldMs: 1_000 },
      { id: 'H30_T2', hardStopPct: 30, maxHoldMs: 2_000 },
    ],
    costModel: {
      platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0.001, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const suite = new SmartResonanceRightTailShadowSuite({ config, store, now: () => now });
  suite.start();
  const mint = 'SmartResonance1111111111111111111111111111';
  store.recordCreate({
    mint, symbol: 'SR', name: null, uri: null, bondingCurve: null, creator: null,
    createdAt: base - 10_000, initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });

  const trade = (offset, side, sol, wallet, price, overrides = {}) => {
    sequence += 1;
    now = base + offset;
    const row = {
      mint, symbol: 'SR', timestampMs: now, market: 'PUMP_BONDING_CURVE',
      side, solAmount: sol, tokenAmount: sol / price, wallet, price, reservePrice: price,
      curvePct: 70, ageMs: 10_000 + offset, signature: `sr-sig-${sequence}`, eventIndex: 0,
      ...overrides,
    };
    suite.observeTrade(row);
    return row;
  };

  for (let index = 0; index < 20; index += 1) {
    trade(-3_800 + index * 100, 'BUY', 1, `public-${index}`, 1);
  }
  const first = trade(0, 'BUY', 1, wallets[0], 1.02);
  suite.onSmartWalletEvent({ ...first, id: 1, positionPhase: 'OPEN' });
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM smart_resonance_shadow_positions').get().n, 0);

  // Repeated buys by the same wallet never satisfy distinct-wallet resonance.
  const repeated = trade(500, 'BUY', 1, wallets[0], 1.03);
  suite.onSmartWalletEvent({ ...repeated, id: 2, positionPhase: 'ADD' });
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM smart_resonance_shadow_positions').get().n, 0);

  const second = trade(1_000, 'BUY', 1, wallets[1], 1.05);
  suite.onSmartWalletEvent({ ...second, id: 3, positionPhase: 'OPEN' });
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM smart_resonance_shadow_positions').get().n, 6);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n FROM smart_resonance_shadow_positions
    WHERE public_buyers_5s=20 AND public_buy_flow_5s=20`).get().n, 6,
  'monitored-wallet buys must be excluded from public-flow confirmation');

  const third = trade(1_100, 'BUY', 1, wallets[2], 1.06);
  suite.onSmartWalletEvent({ ...third, id: 4, positionPhase: 'OPEN' });
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM smart_resonance_shadow_positions').get().n, 8);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n FROM smart_resonance_shadow_positions
    WHERE entry_profile_id='SR_R2' AND distinct_wallets=3`).get().n, 2);

  // Every profile fills on the later trade, never at the Smart signal price.
  trade(1_400, 'BUY', 0.2, 'public-fill', 1.1);
  assert.strictEqual(suite.health().opened, 8);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n FROM smart_resonance_shadow_positions
    WHERE status='OPEN' AND entry_price=1.1 AND signal_price<1.1`).get().n, 8);

  // A 27% fall closes H20 only; H30 remains for its fixed-hold exit.
  trade(1_600, 'SELL', 0.2, 'public-stop', 0.8);
  trade(1_900, 'BUY', 0.1, 'public-stop-fill', 0.79);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n FROM smart_resonance_shadow_positions
    WHERE status='CLOSED' AND exit_profile_id='H20_T1'
      AND exit_reason='HARD_STOP_20'`).get().n, 4);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n FROM smart_resonance_shadow_positions
    WHERE status='OPEN' AND exit_profile_id='H30_T2'`).get().n, 4);

  now = base + 3_500;
  suite.advanceTime(now);
  trade(3_800, 'BUY', 0.1, 'public-time-fill', 1.8);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n FROM smart_resonance_shadow_positions
    WHERE status='CLOSED' AND exit_profile_id='H30_T2' AND exit_reason='MAX_HOLD'`).get().n, 4);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n FROM smart_resonance_shadow_positions
    WHERE status='CLOSED' AND net_return_pct IS NOT NULL`).get().n, 8);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  const dashboard = suite.dashboard({ positionLimit: 20 });
  assert.strictEqual(dashboard.cohorts.length, 8);
  assert.strictEqual(dashboard.positions.length, 8);
  store.close();
  console.log('Smart Resonance Right-Tail Shadow tests: PASS');
}

main();
