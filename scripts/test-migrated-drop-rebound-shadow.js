'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { MigratedDropReboundShadowSuite } = require(
  '../src/core/MigratedDropReboundShadowSuite'
);

function trade(mint, timestampMs, price, market = 'PUMP_AMM') {
  return {
    mint,
    timestampMs,
    receivedAtMs: timestampMs,
    market,
    side: 'BUY',
    solAmount: 1,
    tokenAmount: 1 / price,
    price,
    reservePrice: price,
    signature: `${mint}:${timestampMs}:${price}`,
  };
}

function run() {
  let now = 1_800_000_000_000;
  const store = new ResearchStore({
    dbPath: ':memory:',
    rawRetentionHours: 168,
    archiveDir: './data/archive',
    flushMs: 60_000,
    flushMax: 1_000,
  }, {
    configuredTradingCostPct: 0,
  });
  const config = {
    enabled: true,
    trackingAgeMs: 300_000,
    positionSizeSol: 0.05,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 15,
    entryProfiles: [{
      id: 'G0',
      label: 'baseline',
      windowMs: 1_000,
      dropMinPct: 15,
      dropMaxPct: 35,
      reboundMinPct: 2,
      reboundMaxPct: 5,
      reboundTimeoutMs: 1_000,
    }],
    exitProfiles: [
      { id: 'X3', label: '3s', exitMode: 'FIXED_HOLD', fixedHoldMs: 3_000 },
      {
        id: 'XLEG',
        label: 'legacy',
        exitMode: 'LEGACY',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
        maxHoldMs: 15_000,
      },
    ],
    costModel: {
      platformFeePct: 1,
      buySlippagePct: 0,
      sellSlippagePct: 0,
      priceImpactPct: 0,
      baseTxFeeSol: 0,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      fixedCostSol: 0,
      positionSizeSol: 0.05,
      entryFailureRatePct: 0,
      entryFailureCostPct: 0,
    },
  };
  let suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();

  const mint = 'MigratedRebound111111111111111111111111111';
  store.recordComplete({ mint, completedAt: now, timestampMs: now });
  suite.onGraduated(store.getToken(mint));
  assert.deepStrictEqual(suite.trackedMints(now), [mint]);

  // Bonding-curve trades must never seed or trigger the migrated strategy.
  suite.observeTrade(trade(mint, now + 10, 1, 'PUMP_BONDING_CURVE'));
  suite.observeTrade(trade(mint, now + 110, 0.8, 'PUMP_BONDING_CURVE'));
  suite.observeTrade(trade(mint, now + 310, 0.82, 'PUMP_BONDING_CURVE'));
  assert.strictEqual(suite.health().signals, 0);

  suite.observeTrade(trade(mint, now + 400, 1));
  suite.observeTrade(trade(mint, now + 700, 0.8));
  suite.observeTrade(trade(mint, now + 1_000, 0.82));
  assert.strictEqual(suite.health().signals, 1);
  assert.strictEqual(suite.health().pendingEntries, 2);

  suite.observeTrade(trade(mint, now + 1_250, 0.83));
  assert.strictEqual(suite.health().opened, 2);
  assert.strictEqual(suite.health().activePositions, 2);

  // Active cohorts and the PumpSwap subscription scope survive a process restart.
  suite.stop();
  suite = new MigratedDropReboundShadowSuite({ config, store, now: () => now });
  suite.start();
  assert.strictEqual(suite.health().activePositions, 2);
  assert(suite.trackedMints(now).includes(mint));

  // Legacy exits on a fast +18% move, fixed cohort waits for three seconds.
  suite.observeTrade(trade(mint, now + 2_000, 1));
  suite.observeTrade(trade(mint, now + 2_250, 0.99));
  let rows = store.migratedDropReboundShadowDashboard({ positionLimit: 10 }).positions;
  assert.strictEqual(rows.find((row) => row.exit_profile_id === 'XLEG').status, 'CLOSED');
  assert.strictEqual(rows.find((row) => row.exit_profile_id === 'X3').status, 'OPEN');

  suite.observeTrade(trade(mint, now + 4_300, 0.9));
  suite.observeTrade(trade(mint, now + 4_550, 0.89));
  rows = store.migratedDropReboundShadowDashboard({ positionLimit: 10 }).positions;
  assert(rows.every((row) => row.status === 'CLOSED'));
  assert(rows.every((row) => Number.isFinite(row.net_return_pct)));
  assert(rows.every((row) => row.entry_market === 'PUMP_AMM'));

  // A drop beyond the maximum is cancelled and cannot re-arm inside the same episode.
  const deepMint = 'DeepDrop1111111111111111111111111111111111';
  store.recordComplete({ mint: deepMint, completedAt: now, timestampMs: now });
  suite.onGraduated(store.getToken(deepMint));
  suite.observeTrade(trade(deepMint, now + 5_000, 1));
  suite.observeTrade(trade(deepMint, now + 5_050, 0.8));
  suite.observeTrade(trade(deepMint, now + 5_100, 0.64));
  suite.observeTrade(trade(deepMint, now + 5_300, 0.66));
  assert.strictEqual(suite.health().signals, 0);
  assert(suite.health().dropExceededMax >= 1);

  const dashboard = store.migratedDropReboundShadowDashboard({ positionLimit: 10 });
  assert.strictEqual(dashboard.cohorts.length, 2);
  assert.strictEqual(dashboard.entryProfiles[0].signals, 1);
  assert.strictEqual(store.health().migratedDropReboundShadowPositions.signals, 1);

  now += config.trackingAgeMs + 1;
  assert(!suite.trackedMints(now).includes(deepMint));
  store.close();
  console.log('Migrated drop/rebound Shadow G tests: PASS');
}

run();
