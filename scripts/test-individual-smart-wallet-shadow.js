'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  IndividualSmartWalletShadowPortfolio,
} = require('../src/core/IndividualSmartWalletShadowPortfolio');

function costModel() {
  return {
    platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
    baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
    positionSizeSol: 0.1, entryFailureRatePct: 0, entryFailureCostPct: 0,
  };
}

function main() {
  const base = 1_800_950_000_000;
  let now = base;
  let sequence = 0;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const defaults = {
    positionSizeSol: 0.1,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 2_000,
    flowFadeWindowMs: 3_000,
    maxEntryPriceJumpPct: 10,
    maxEntryPriceDropPct: 30,
    maxEntryImpactPct: 5,
    costModel: costModel(),
  };
  const rawEntry = [{ id: 'RAW_EXEC', riskGuardEnabled: false }];
  const mirrorExit = [{
    id: 'WALLET_EXIT', mode: 'WALLET_EXIT', maxHoldMs: 60_000,
    hardStopPct: 18, coreWeightPct: 0,
  }];
  const portfolio = new IndividualSmartWalletShadowPortfolio({
    config: {
      enabled: true,
      defaults,
      profiles: [
        {
          id: 'ARDIN_CURVE', label: 'ARDIN', targetWallet: 'ardin',
          targetMarket: 'PUMP_BONDING_CURVE', allowCrossMarketExit: true,
          storageTable: 'individual_smart_wallet_ardin_curve_shadow_positions',
          maxEpisodeMs: 70_000, entryProfiles: rawEntry, exitProfiles: mirrorExit,
        },
        {
          id: 'DZ_AMM', label: 'DZ', targetWallet: 'dz', targetMarket: 'PUMP_AMM',
          storageTable: 'individual_smart_wallet_dz_amm_shadow_positions',
          maxEpisodeMs: 70_000, entryProfiles: rawEntry, exitProfiles: mirrorExit,
        },
      ],
    },
    store,
    rugRiskTracker: { snapshot: () => ({}) },
    now: () => now,
  });
  portfolio.start();

  const event = ({ id, wallet, mint, market, side = 'BUY', phase = 'OPEN', at = now }) => ({
    id, wallet, mint, market, side, positionPhase: phase, timestampMs: at,
    price: 0.000001,
  });
  const trade = ({ mint, market, at, price = 0.000001, side = 'BUY' }) => {
    sequence += 1;
    now = at;
    const common = {
      mint, market, timestampMs: at, side, solAmount: 1,
      tokenAmount: 1 / price, wallet: `public-${sequence}`,
      price, reservePrice: price, signature: `solo-${sequence}`, eventIndex: 0,
    };
    if (market === 'PUMP_AMM') {
      portfolio.observeTrade({
        ...common,
        poolBaseReservesRaw: '100000000000000',
        poolQuoteReservesRaw: '100000000000',
        virtualQuoteReservesRaw: '0',
      });
    } else {
      portfolio.observeTrade({
        ...common,
        virtualTokenReservesRaw: '100000000000000',
        virtualSolReservesRaw: '100000000000',
      });
    }
  };

  portfolio.onSmartWalletEvent(event({
    id: 1, wallet: 'other', mint: 'ignored', market: 'PUMP_BONDING_CURVE',
  }));
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM individual_smart_wallet_ardin_curve_shadow_positions`).get().n, 0);

  portfolio.onSmartWalletEvent(event({
    id: 2, wallet: 'ardin', mint: 'curve-mint', market: 'PUMP_BONDING_CURVE',
  }));
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM individual_smart_wallet_ardin_curve_shadow_positions`).get().n, 1);
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM individual_smart_wallet_dz_amm_shadow_positions`).get().n, 0);
  trade({ mint: 'curve-mint', market: 'PUMP_BONDING_CURVE', at: base + 250 });
  assert.strictEqual(store.db.prepare(`SELECT status
    FROM individual_smart_wallet_ardin_curve_shadow_positions`).get().status, 'OPEN');

  now = base + 1_000;
  portfolio.onSmartWalletEvent(event({
    id: 3, wallet: 'ardin', mint: 'curve-mint', market: 'PUMP_BONDING_CURVE',
    side: 'SELL', phase: 'CLOSE', at: now,
  }));
  assert.strictEqual(store.db.prepare(`SELECT status
    FROM individual_smart_wallet_ardin_curve_shadow_positions`).get().status, 'EXIT_PENDING');
  trade({ mint: 'curve-mint', market: 'PUMP_BONDING_CURVE', at: base + 1_250, side: 'SELL' });
  const closed = store.db.prepare(`SELECT status, exit_reason
    FROM individual_smart_wallet_ardin_curve_shadow_positions`).get();
  assert.strictEqual(closed.status, 'CLOSED');
  assert.strictEqual(closed.exit_reason, 'TARGET_WALLET_CLOSE');

  now = base + 2_000;
  portfolio.onSmartWalletEvent(event({
    id: 4, wallet: 'dz', mint: 'wrong-market', market: 'PUMP_BONDING_CURVE', at: now,
  }));
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) n
    FROM individual_smart_wallet_dz_amm_shadow_positions`).get().n, 0);
  portfolio.onSmartWalletEvent(event({
    id: 5, wallet: 'dz', mint: 'amm-mint', market: 'PUMP_AMM', at: now,
  }));
  trade({ mint: 'amm-mint', market: 'PUMP_AMM', at: base + 2_250 });
  assert.strictEqual(store.db.prepare(`SELECT status
    FROM individual_smart_wallet_dz_amm_shadow_positions`).get().status, 'OPEN');

  const dashboard = portfolio.dashboard(20);
  assert.strictEqual(dashboard.pooledConsensus, false);
  assert.strictEqual(dashboard.sendsTransactions, false);
  assert.strictEqual(dashboard.strategies.length, 2);
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);
  store.close();
  console.log('Individual Smart Wallet Shadow tests: PASS');
}

main();
