'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const {
  FeatureEdgeAuditObserver,
  aggregate,
} = require('../src/core/FeatureEdgeAuditObserver');

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
      minBuyers: 7,
      minBuySharePct: 70,
      maxEntryImpactPct: 15,
      minCurvePct: 60,
      maxCurvePct: 95,
      minAgeMs: 5_000,
      maxAgeMs: 300_000,
    },
  });
  observer.start();

  const signalAtMs = 1_800_000_000_000;
  const mint = 'FeatureEdgeAudit111111111111111111111111111';
  const signal = {
    signalId: 1,
    signalAtMs,
    timestampMs: signalAtMs,
    mint,
    signalVariant: 'primary_3w',
    market: 'PUMP_BONDING_CURVE',
    price: 0.0000001,
    virtualTokenReservesRaw: '1000000000000000',
    virtualSolReservesRaw: '100000000000',
    netFlowW1: 2,
    netFlowW2: 6,
    netFlowW3: 12,
    uniqueBuyersW1: 2,
    uniqueBuyersW2: 5,
    uniqueBuyersW3: 8,
    buyTxW1: 2,
    buyTxW2: 6,
    buyTxW3: 10,
    buyFlowW3: 13,
    sellFlowW3: 1,
    ageMs: 20_000,
    curvePct: 70,
  };

  const sample = observer.onSignal(signal);
  assert(sample, 'a valid public signal should create a forward observation');
  assert.strictEqual(sample.featureScore, 5,
    'all five independent feature families should be scored');
  assert.strictEqual(sample.entryQuoteAvailable, 1,
    'bonding-curve reserves should produce a 1 SOL executable quote');
  assert(sample.entryImpactPct > 0 && sample.entryImpactPct < 15,
    'entry capacity impact must be measured and pass the configured ceiling');
  assert.strictEqual(observer.onSignal({ ...signal, timestampMs: signalAtMs + 1_000 }), null,
    'same-Mint signal spam must be sampled only once inside the cooldown');
  assert.strictEqual(observer.health().cooldownSkipped, 1);

  const futureTrade = (seconds, multiplier) => ({
    mint,
    timestampMs: signalAtMs + seconds * 1_000,
    market: 'PUMP_BONDING_CURVE',
    price: signal.price * multiplier,
    virtualTokenReservesRaw: signal.virtualTokenReservesRaw,
    virtualSolReservesRaw: String(Math.round(100_000_000_000 * multiplier)),
  });
  observer.observeTrade(futureTrade(5, 1.05));
  observer.observeTrade(futureTrade(30, 1.10));
  observer.observeTrade(futureTrade(120, 1.20));
  observer.observeTrade(futureTrade(300, 1.40));

  const row = db.prepare('SELECT * FROM feature_edge_audit_observations WHERE id=?')
    .get(sample.id);
  assert.strictEqual(row.label_status, 'COMPLETE');
  assert.strictEqual(observer.health().pending, 0);
  assert.strictEqual(observer.health().samplesCompleted, 1);
  for (const seconds of [5, 30, 120, 300]) {
    assert(Number.isFinite(row[`mark_return_${seconds}s`]),
      `${seconds}s mark-price label should be persisted`);
    assert(Number.isFinite(row[`executable_return_${seconds}s`]),
      `${seconds}s 1 SOL executable label should be persisted`);
  }
  assert(row.mark_return_300s > row.executable_return_300s,
    'capacity-aware return must include AMM round-trip impact');

  const dashboard = observer.dashboard({ limit: 100 });
  assert.strictEqual(dashboard.horizons.length, 4);
  assert.strictEqual(dashboard.families.length, 5);
  assert.strictEqual(dashboard.scores.length, 6);
  assert.strictEqual(dashboard.recent.length, 1);
  assert.strictEqual(dashboard.summary.targetHorizonSeconds, 300);
  assert.strictEqual(dashboard.recent[0].featureScore, 5);

  const health = observer.health();
  assert.strictEqual(health.observerOnly, true);
  assert.strictEqual(health.sendsTransactions, false);
  assert.strictEqual(health.extraRpcCalls, false);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='live_positions'")
    .get().count, 0, 'observer must not create or reuse a live-trading table');

  const stats = aggregate([-50, 10, 50, 100]);
  assert.strictEqual(stats.count, 4);
  assert.strictEqual(stats.winRatePct, 75);
  assert.strictEqual(stats.big50RatePct, 50);
  assert.strictEqual(stats.rug50RatePct, 25);

  observer.stop();
  db.close();
  console.log('feature edge audit observer tests passed');
}

main();
