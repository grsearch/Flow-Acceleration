'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { CyaSlotFlowShadowSuite } = require('../src/core/CyaSlotFlowShadowSuite');

function main() {
  const base = 1_800_900_000_000;
  let now = base;
  let sequence = 0;
  const targetWallet = 'cya-target-wallet';
  const otherSmartWallet = 'other-smart-wallet';
  const mint = 'CyaSlotFlow111111111111111111111111111111';
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  store.recordCreate({
    mint, symbol: 'CSF', name: null, uri: null, bondingCurve: null,
    creator: 'creator-wallet', createdAt: base - 4_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  const config = {
    enabled: true,
    targetWallet,
    excludedWallets: [targetWallet, otherSmartWallet],
    positionSizeSol: 1,
    featureWindowMs: 5_000,
    maxTradesPerMint: 32,
    stateRetentionMs: 60_000,
    episodeCooldownMs: 60_000,
    targetLabelWindowMs: 15_000,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 50,
    maxEntryPriceDropPct: 50,
    maxEntryImpactPct: 25,
    maxAddImpactPct: 25,
    entryProfiles: [{
      id: 'CSF_TEST', label: 'completed slot test',
      minAgeMs: 3_000, maxAgeMs: 5_000,
      minBuyers5s: 5, minNetFlow5sSol: 5,
      minBuyTxSharePct: 75, maxLargestBuyerSharePct: 40,
      minReturn5sPct: 20, maxReturn5sPct: 140,
      minSourceSlotBuyers: 5, minSourceSlotNetFlowSol: 5,
      requireCreatorNoSell: false,
    }],
    managementProfiles: [
      {
        id: 'FIXED', label: 'fixed control', hardStopPct: 90,
        noContinuationMs: 60_000, minContinuationMfePct: 0, maxHoldMs: 1_000,
        trailingActivationPct: 0, trailingStopPct: 0,
        addActivationPct: 0, addMaxAgeMs: 0, addCooldownMs: 0,
        addStepPct: 0, addFraction: 0, maxAdds: 0,
        minAddNetFlow1sSol: 0, minAddBuyers1s: 0, minAddBuyTxSharePct: 0,
      },
      {
        id: 'ADD50', label: 'flow-confirmed add', hardStopPct: 90,
        noContinuationMs: 60_000, minContinuationMfePct: 0, maxHoldMs: 1_000,
        trailingActivationPct: 0, trailingStopPct: 0,
        addActivationPct: 50, addMaxAgeMs: 900, addCooldownMs: 100,
        addStepPct: 10, addFraction: 0.2, maxAdds: 1,
        minAddNetFlow1sSol: 0.2, minAddBuyers1s: 2, minAddBuyTxSharePct: 70,
      },
    ],
    costModel: {
      platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0.000005, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 1, entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };
  const suite = new CyaSlotFlowShadowSuite({ config, store, now: () => now });
  suite.start();

  const trade = (offset, slot, side, sol, wallet, price) => {
    now = base + offset;
    sequence += 1;
    const row = {
      mint, symbol: 'CSF', timestampMs: now, slot,
      market: 'PUMP_BONDING_CURVE', side, solAmount: sol,
      tokenAmount: sol / price, wallet, price, reservePrice: price,
      virtualTokenReservesRaw: '1000000000000000',
      virtualSolReservesRaw: String(Math.max(1, Math.round(price * 1e18))),
      ageMs: 4_000 + offset, signature: `csf-${sequence}`, eventIndex: 0,
    };
    return { row, signals: suite.observeTrade(row) };
  };

  // Six diversified public buys form a completed source slot.
  for (let index = 0; index < 6; index += 1) {
    trade(-900 + index * 100, 100, 'BUY', 1, `public-${index}`, 0.00000010 + index * 0.000000006);
  }
  // A huge monitored-wallet buy must not contaminate source flow or create a signal.
  const excluded = trade(-250, 100, 'BUY', 100, targetWallet, 0.00000014);
  assert.strictEqual(excluded.signals.length, 0);
  assert.strictEqual(suite.health().excludedWalletTrades, 1);

  // The first public trade in the next slot evaluates only the completed prior slot.
  const signal = trade(0, 101, 'BUY', 0.2, 'slot-trigger', 0.000000132);
  assert.strictEqual(signal.signals.length, 2);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM cya_slot_flow_shadow_positions',
  ).get().n, 2);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_slot_flow_shadow_positions
    WHERE public_buyers_5s=6 AND ABS(public_buy_flow_5s-6)<0.000001
      AND source_slot=100 AND trigger_slot=101
  `).get().n, 2, 'target-wallet trade must be excluded from all causal features');

  // A delayed older-slot packet must not turn the causal boundary backwards.
  const stale = trade(50, 99, 'BUY', 100, 'stale-public', 0.00000014);
  assert.strictEqual(stale.signals.length, 0);
  assert.strictEqual(suite.health().outOfOrderSlotTrades, 1);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM cya_slot_flow_shadow_positions',
  ).get().n, 2);

  // Target OPEN/ADD cannot fill a pending entry. ADD is not even a label.
  trade(100, 101, 'BUY', 50, targetWallet, 0.00000015);
  assert.strictEqual(suite.health().opened, 0);
  now = base + 120;
  assert.strictEqual(suite.onSmartWalletEvent({
    mint, wallet: targetWallet, side: 'BUY', positionPhase: 'ADD', timestampMs: now,
  }), 0);

  // A public post-delay trade is the first permissible simulated fill.
  trade(250, 101, 'BUY', 0.2, 'public-fill', 0.000000135);
  assert.strictEqual(suite.health().opened, 2);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_slot_flow_shadow_positions
    WHERE status='OPEN' AND entry_at=?
  `).get(base + 250).n, 2);

  // The target wallet is now stored strictly as a future outcome label.
  now = base + 350;
  assert.strictEqual(suite.onSmartWalletEvent({
    mint, wallet: targetWallet, side: 'BUY', positionPhase: 'OPEN', timestampMs: now,
  }), 2);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_slot_flow_shadow_positions
    WHERE target_open_delay_ms=350
  `).get().n, 2);

  // Only continuing public flow can authorize the ADD50 profile's single add.
  trade(450, 101, 'BUY', 0.2, 'add-public-1', 0.000000215);
  trade(600, 101, 'BUY', 0.2, 'add-public-2', 0.000000220);
  trade(750, 101, 'BUY', 0.2, 'add-public-3', 0.000000225);
  assert.strictEqual(store.db.prepare(`
    SELECT add_count FROM cya_slot_flow_shadow_positions
    WHERE management_profile_id='ADD50'
  `).get().add_count, 1);
  assert.strictEqual(store.db.prepare(`
    SELECT add_count FROM cya_slot_flow_shadow_positions
    WHERE management_profile_id='FIXED'
  `).get().add_count, 0);

  // Both profiles request fixed exits and close using capacity-aware reserve quotes.
  now = base + 1_300;
  suite.advanceTime(now);
  trade(1_550, 101, 'SELL', 0.2, 'public-exit', 0.00000018);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM cya_slot_flow_shadow_positions
    WHERE status='CLOSED' AND exit_reason='MAX_HOLD'
      AND exit_price IS NOT NULL AND exit_impact_pct IS NOT NULL
  `).get().n, 2);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);

  // The queue is hard bounded even under a burst and does not emit another same-slot episode.
  for (let index = 0; index < 80; index += 1) {
    trade(1_600 + index, 101, 'BUY', 0.01, `burst-${index}`, 0.00000018);
  }
  assert.ok(suite.states.get(mint).trades.length <= config.maxTradesPerMint);
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM cya_slot_flow_shadow_positions',
  ).get().n, 2);

  const dashboard = suite.dashboard({ positionLimit: 10 });
  assert.strictEqual(dashboard.cohorts.length, 2);
  assert.strictEqual(dashboard.positions.length, 2);
  assert.ok(dashboard.cohorts.every((row) => row.target_open_5s_rate_pct === 100));
  assert.strictEqual(suite.health().strategy.entryUsesTargetWallet, undefined);
  assert.strictEqual(suite.health().strategy.research.entryUsesTargetWallet, false);
  store.close();
  console.log('CYA Slot Flow Shadow tests: PASS');
}

main();
