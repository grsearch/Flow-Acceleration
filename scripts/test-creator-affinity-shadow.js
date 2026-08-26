'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { PublicFlowLeadShadowSuite } = require('../src/core/PublicFlowLeadShadowSuite');

function main() {
  const base = 1_800_900_000_000;
  let now = base;
  let sequence = 0;
  const creator = 'creator-affinity-a';
  const smartA = 'smart-affinity-a';
  const smartB = 'smart-affinity-b';
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const config = {
    enabled: true,
    simulatePositions: true,
    storageTable: 'creator_affinity_shadow_positions',
    strategyCode: 'CAF', strategyName: 'Creator Affinity + Public Flow', modeCode: 'CAF',
    positionSizeSol: 1,
    smartWallets: [smartA, smartB],
    creatorAffinity: { enabled: true, lookbackMs: 7 * 24 * 60 * 60_000 },
    featureWindowMs: 5_000, stateRetentionMs: 60_000,
    episodeCooldownMs: 60_000, smartLabelWindowMs: 15_000,
    entryDelayMs: 200, entryTimeoutMs: 2_000,
    exitDelayMs: 200, exitTimeoutMs: 1_000,
    maxEntryPriceJumpPct: 15, maxEntryPriceDropPct: 30,
    maxCrossMarketPriceJumpPct: 50,
    entryProfiles: [{
      id: 'CAF_W50_E10', minAgeMs: 3_000, maxAgeMs: 10_000,
      minCurvePct: 10, maxCurvePct: 85,
      minPublicBuyers5s: 3, minPublicBuyFlow5sSol: 0.5,
      minPublicNetFlow5sSol: 0.25, maxLargestBuyerSharePct: 50,
      maxReturn5sPct: 50,
      minCreatorPriorCompleted: 3, minCreatorPriorWinRatePct: 50,
    }],
    exitProfiles: [{ id: 'H20_T60', hardStopPct: 20, maxHoldMs: 60_000 }],
    costModel: {
      platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0.001, priorityFeeSol: 0,
      jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 1,
      entryFailureRatePct: 0, entryFailureCostPct: 0,
    },
  };

  const create = (mint, createdAt) => store.recordCreate({
    mint, symbol: mint.slice(0, 5), name: null, uri: null,
    bondingCurve: null, creator, createdAt,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  const suite = new PublicFlowLeadShadowSuite({ config, store, now: () => now });
  suite.start();
  const smartEvent = ({ mint, wallet = smartA, side, phase, timestampMs, sol, balance }) => {
    now = Math.max(now, timestampMs);
    return suite.onSmartWalletEvent({
      mint, wallet, side, positionPhase: phase, timestampMs,
      solAmount: sol, tokenBalanceAfter: balance,
    });
  };

  // Three independently completed wallet x Mint episodes establish causal history.
  for (let index = 0; index < 3; index += 1) {
    const mint = `CreatorPrior${index}111111111111111111111111111`;
    const openedAt = base - 40_000 + index * 4_000;
    create(mint, openedAt - 1_000);
    smartEvent({ mint, wallet: index === 2 ? smartB : smartA, side: 'BUY', phase: 'OPEN',
      timestampMs: openedAt, sol: 1, balance: 100 });
    smartEvent({ mint, wallet: index === 2 ? smartB : smartA, side: 'SELL', phase: 'CLOSE',
      timestampMs: openedAt + 2_000, sol: 1.2, balance: 0 });
  }

  // An unfinished prior launch is visible as a launch, but never fabricated into
  // either a win or a loss. A close occurring after the signal is also censored.
  const unfinishedMint = 'CreatorUnfinished111111111111111111111111';
  create(unfinishedMint, base - 20_000);
  smartEvent({ mint: unfinishedMint, side: 'BUY', phase: 'OPEN',
    timestampMs: base - 19_000, sol: 1, balance: 100 });
  const futureCloseMint = 'CreatorFutureClose11111111111111111111111';
  create(futureCloseMint, base - 18_000);
  smartEvent({ mint: futureCloseMint, side: 'BUY', phase: 'OPEN',
    timestampMs: base - 17_000, sol: 1, balance: 100 });
  smartEvent({ mint: futureCloseMint, side: 'SELL', phase: 'CLOSE',
    timestampMs: base + 2_000, sol: 2, balance: 0 });

  const currentMint = 'CreatorCurrent111111111111111111111111111';
  create(currentMint, base - 5_000);
  const prior = suite._creatorSnapshot(currentMint, base);
  assert.strictEqual(prior.creatorPriorLaunches, 5);
  assert.strictEqual(prior.creatorPriorSmartWallets, 2);
  assert.strictEqual(prior.creatorPriorCompleted, 3,
    'unfinished and future-closed episodes must be causally censored');
  assert.strictEqual(prior.creatorPriorWinRatePct, 100);
  assert.ok(Math.abs(prior.creatorPriorCapitalReturnPct - 20) < 0.000001);

  const observe = (offset, wallet, sol, price) => {
    now = base + offset;
    sequence += 1;
    return suite.observeTrade({
      mint: currentMint, symbol: 'CAF', timestampMs: now,
      market: 'PUMP_BONDING_CURVE', side: 'BUY', solAmount: sol,
      tokenAmount: sol / price, wallet, price, reservePrice: price,
      curvePct: 40, ageMs: 5_000 + offset,
      signature: `caf-public-${sequence}`, eventIndex: 0,
    });
  };
  observe(-200, 'public-a', 0.2, 1);
  observe(-100, 'public-b', 0.2, 1.01);
  const signals = observe(0, 'public-c', 0.2, 1.02);
  assert.strictEqual(signals.length, 1);
  const row = store.db.prepare(`
    SELECT * FROM creator_affinity_shadow_positions
    WHERE mint=?
  `).get(currentMint);
  assert.strictEqual(row.status, 'PENDING_ENTRY');
  assert.strictEqual(row.creator_prior_completed, 3);
  assert.strictEqual(row.creator_prior_win_rate_pct, 100);
  assert.ok(Math.abs(row.creator_prior_capital_return_pct - 20) < 0.000001);
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) n FROM sqlite_master
    WHERE type='table' AND name='public_flow_lead_shadow_positions'
  `).get().n, 0, 'CAF must remain isolated from the legacy PFL table');

  // The current Smart OPEN is only a future label and cannot improve its own
  // stored creator prior. It also does not create an extra strategy entry.
  now = base + 500;
  assert.strictEqual(suite.onSmartWalletEvent({
    mint: currentMint, wallet: smartA, side: 'BUY', positionPhase: 'OPEN',
    timestampMs: now, solAmount: 1, tokenBalanceAfter: 100,
  }), 1);
  const labelled = store.db.prepare(`
    SELECT creator_prior_completed, creator_prior_win_rate_pct,
      smart_open_delay_ms, smart_open_wallet
    FROM creator_affinity_shadow_positions WHERE mint=?
  `).get(currentMint);
  assert.strictEqual(labelled.creator_prior_completed, 3);
  assert.strictEqual(labelled.creator_prior_win_rate_pct, 100);
  assert.strictEqual(labelled.smart_open_delay_ms, 500);
  assert.strictEqual(labelled.smart_open_wallet, smartA);
  assert.strictEqual(suite._creatorSnapshot(currentMint, now).creatorPriorCompleted, 3,
    'current Mint must be excluded from its own creator history');
  assert.strictEqual(store.db.prepare(
    'SELECT COUNT(*) n FROM creator_affinity_shadow_positions',
  ).get().n, 1);

  const dashboard = suite.dashboard({ positionLimit: 10 });
  assert.strictEqual(dashboard.cohorts.length, 1);
  assert.strictEqual(dashboard.positions.length, 1);
  assert.strictEqual(suite.health().strategy.research.creatorAffinityIsHistoricalPriorOnly, true);
  store.close();
  console.log('Creator Affinity Shadow tests: PASS');
}

main();
