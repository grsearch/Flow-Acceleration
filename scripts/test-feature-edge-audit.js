'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  FeatureEdgeAuditObserver,
  aggregate,
  OBSERVATION_TABLE,
  BNH_TABLE,
  BNH_PROFILE_ID,
} = require('../src/core/FeatureEdgeAuditObserver');

function baseSignal({
  mint, signalAtMs, flow = true, participation = true, balance = true,
} = {}) {
  return {
    signalId: signalAtMs,
    signalAtMs,
    timestampMs: signalAtMs,
    mint,
    signalVariant: 'primary_3w',
    market: 'PUMP_BONDING_CURVE',
    price: 0.0000001,
    virtualTokenReservesRaw: '1000000000000000',
    virtualSolReservesRaw: '100000000000',
    netFlowW1: flow ? 2 : 8,
    netFlowW2: flow ? 6 : 11,
    netFlowW3: 12,
    uniqueBuyersW1: 2,
    uniqueBuyersW2: participation ? 5 : 3,
    uniqueBuyersW3: participation ? 8 : 4,
    buyTxW1: 2,
    buyTxW2: participation ? 6 : 3,
    buyTxW3: participation ? 10 : 4,
    buyFlowW3: balance ? 13 : 5,
    sellFlowW3: balance ? 1 : 5,
    ageMs: 60_000,
    curvePct: 70,
  };
}

function tradeAt(signal, seconds, multiplier, market = signal.market) {
  return {
    mint: signal.mint,
    timestampMs: signal.signalAtMs + seconds * 1_000,
    market,
    price: signal.price * multiplier,
    virtualTokenReservesRaw: signal.virtualTokenReservesRaw,
    virtualSolReservesRaw: String(Math.round(100_000_000_000 * multiplier)),
  };
}

function observeAllHorizons(observer, signal, multipliers = [1.05, 1.10, 1.20, 1.40]) {
  [5, 30, 120, 300].forEach((seconds, index) => {
    observer.observeTrade(tradeAt(signal, seconds, multipliers[index]));
  });
}

function main() {
  const db = new Database(':memory:');
  const observer = new FeatureEdgeAuditObserver({
    store: { db },
    config: {
      enabled: true,
      positionSol: 1,
      sampleCooldownMs: 30_000,
      maxPending: 100,
      maxObservationLagMs: 3_000,
      stateRetentionMs: 360_000,
      minNetFlowSol: 10,
      minFlowAccelerationSol: 2,
      minBuyers: 7,
      minBuySharePct: 70,
      maxEntryImpactPct: 15,
      minCurvePct: 60,
      maxCurvePct: 95,
      minAgeMs: 5_000,
      maxAgeMs: 300_000,
      bnhEnabled: true,
      bnhMinAgeMs: 30_000,
      bnhMaxAgeMs: 120_000,
      bnhMinCurvePct: 60,
      bnhMaxCurvePct: 90,
      bnhHoldMs: 120_000,
      bnhRoundTripCostPct: 3.2,
    },
  });
  observer.start();

  const signalAtMs = 1_800_000_000_000;
  const signal = baseSignal({
    mint: 'FeatureEdgeAudit111111111111111111111111111',
    signalAtMs,
  });
  const sample = observer.onSignal(signal);
  assert(sample, 'a valid public signal should create a forward observation');
  assert.strictEqual(sample.featureScore, 3,
    'crowded participation must subtract one point from four positive families');
  assert.strictEqual(sample.entryQuoteAvailable, 1,
    'bonding-curve reserves should produce a 1 SOL executable quote');
  assert(sample.entryImpactPct > 0 && sample.entryImpactPct < 15,
    'entry capacity impact must be measured and pass the configured ceiling');
  assert.strictEqual(observer.onSignal({ ...signal, timestampMs: signalAtMs + 1_000 }), null,
    'same-Mint signal spam must be sampled only once inside the cooldown');
  assert.strictEqual(observer.health().cooldownSkipped, 1);

  observeAllHorizons(observer, signal);
  const row = db.prepare(`SELECT * FROM ${OBSERVATION_TABLE} WHERE id=?`).get(sample.id);
  assert.strictEqual(row.label_status, 'COMPLETE');
  assert.strictEqual(row.cross_market_seen, 0);
  for (const seconds of [5, 30, 120, 300]) {
    assert(Number.isFinite(row[`mark_return_${seconds}s`]),
      `${seconds}s mark-price label should be persisted`);
    assert(Number.isFinite(row[`executable_return_${seconds}s`]),
      `${seconds}s 1 SOL executable label should be persisted`);
  }
  assert(row.mark_return_300s > row.executable_return_300s,
    'capacity-aware return must include AMM round-trip impact');

  const bnhSignal = baseSignal({
    mint: 'FeatureEdgeAuditBnh1111111111111111111111111',
    signalAtMs: signalAtMs + 1_000_000,
    participation: false,
  });
  const bnhSample = observer.onSignal(bnhSignal);
  assert(bnhSample?.bnhOpen,
    'flowing, balanced and non-overheated sample should open isolated BNH Shadow');
  observeAllHorizons(observer, bnhSignal, [1.05, 1.10, 1.20, 1.40]);
  const bnhRow = db.prepare(`SELECT * FROM ${BNH_TABLE} WHERE observation_id=?`)
    .get(bnhSample.id);
  assert.strictEqual(bnhRow.profile_id, BNH_PROFILE_ID);
  assert.strictEqual(bnhRow.status, 'CLOSED');
  assert(Number.isFinite(bnhRow.net_return_pct));

  const noFlowSignal = baseSignal({
    mint: 'FeatureEdgeAuditNoFlow1111111111111111111111',
    signalAtMs: signalAtMs + 1_500_000,
    flow: false,
    participation: false,
  });
  const noFlowSample = observer.onSignal(noFlowSignal);
  assert(noFlowSample, 'no-flow sample should remain available to the feature audit');
  assert.strictEqual(noFlowSample.features.flow, false);
  assert.strictEqual(noFlowSample.bnhOpen, false,
    'BNH must not open from balance alone when public Flow is not accelerating');

  const crossSignal = baseSignal({
    mint: 'FeatureEdgeAuditCross11111111111111111111111',
    signalAtMs: signalAtMs + 2_000_000,
    balance: false,
  });
  const crossSample = observer.onSignal(crossSignal);
  observer.observeTrade(tradeAt(crossSignal, 5, 100, 'PUMP_AMM'));
  observer.advanceTime(crossSignal.signalAtMs + 304_000);
  const crossRow = db.prepare(`SELECT * FROM ${OBSERVATION_TABLE} WHERE id=?`)
    .get(crossSample.id);
  assert.strictEqual(crossRow.cross_market_seen, 1);
  assert.strictEqual(crossRow.label_status, 'RIGHT_CENSORED');
  assert.strictEqual(crossRow.censor_reason, 'CROSS_MARKET_LABEL_INVALID');
  assert.strictEqual(crossRow.mark_return_5s, null,
    'cross-market price scales must never be divided into a fake return');

  const dashboard = observer.dashboard({ limit: 100 });
  assert.strictEqual(dashboard.horizons.length, 4);
  assert.strictEqual(dashboard.families.length, 5);
  assert.strictEqual(dashboard.scores.length, 6);
  assert.strictEqual(dashboard.summary.targetHorizonSeconds, 120);
  assert(dashboard.summary.crossMarketRatePct > 0);
  assert.strictEqual(dashboard.bnh.profileId, BNH_PROFILE_ID);
  assert.strictEqual(dashboard.bnh.priced, 1);
  assert.strictEqual(dashboard.bnhRecent.length, 1);
  assert(dashboard.recent.some((item) => item.featureScore === 3));

  const health = observer.health();
  assert.strictEqual(health.mode, 'FEA-OBS-V2');
  assert.strictEqual(health.observerOnly, true);
  assert.strictEqual(health.sendsTransactions, false);
  assert.strictEqual(health.extraRpcCalls, false);
  assert.strictEqual(health.simulatesPositions, true);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='live_positions'")
    .get().count, 0, 'observer must not create or reuse a live-trading table');

  const stats = aggregate([-50, 10, 50, 100]);
  assert.strictEqual(stats.count, 4);
  assert.strictEqual(stats.winRatePct, 75);
  assert.strictEqual(stats.big50RatePct, 50);
  assert.strictEqual(stats.big100RatePct, 25);
  assert.strictEqual(stats.rug50RatePct, 25);

  observer.stop();
  db.close();
  console.log('feature edge audit observer tests passed');
}

main();
