'use strict';

const assert = require('node:assert/strict');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');

const config = {
  enabled: true,
  windowMs: 15_000,
  stateRetentionMs: 60_000,
  sweepIntervalMs: 5_000,
  maxEventsPerMint: 256,
  cacheMaxAgeMs: 1_000,
  minTrades: 10,
  minBuySharePct: 58,
  minConsecutiveBuys: 14,
  maxSideAlternationPct: 30,
  minUpTickSharePct: 55,
  minReturnPct: 30,
  minFlags: 5,
};

{
  const tracker = new PreEntryRugRiskTracker({ config });
  for (let index = 0; index < 15; index += 1) {
    tracker.observeTrade({
      mint: 'rug', side: 'BUY', market: 'PUMP_BONDING_CURVE',
      timestampMs: 1_000 + index * 500, price: 1 + index * 0.04,
    });
  }
  const snapshot = tracker.snapshot('rug', 9_000);
  assert.equal(snapshot.sampleReady, true);
  assert.equal(snapshot.flagged, true);
  assert.equal(snapshot.score, 5);
  assert.equal(snapshot.maxConsecutiveBuys, 15);

  const liveDecision = tracker.evaluateGuard({
    strategyId: 'LIVE-TEST', mint: 'rug', timestampMs: 9_050, source: 'LIVE',
  });
  assert.equal(liveDecision.blocked, true);
  assert.equal(tracker.health().liveCacheHits, 1);

  // A newer trade invalidates the snapshot. Live must fail open instead of doing
  // work on the transaction hot path; Shadow refreshes the shared cache.
  tracker.observeTrade({ mint: 'rug', side: 'BUY', timestampMs: 9_100, price: 1.7 });
  const liveMiss = tracker.evaluateGuard({
    strategyId: 'LIVE-TEST', mint: 'rug', timestampMs: 9_110, source: 'LIVE',
  });
  assert.equal(liveMiss.blocked, false);
  assert.equal(liveMiss.reason, 'RUG_GUARD_SAMPLE_INSUFFICIENT');
  assert.equal(tracker.health().liveCacheMisses, 1);
  const shadowDecision = tracker.evaluateGuard({
    strategyId: 'SHADOW-TEST', mint: 'rug', timestampMs: 9_110, source: 'SHADOW',
  });
  assert.equal(shadowDecision.blocked, true);
  const health = tracker.health();
  assert.equal(health.scope, 'ALL_LIVE_AND_SHADOW_ENTRIES');
  assert.equal(health.strategyStats.find((row) => row.strategyId === 'LIVE-TEST').evaluated, 2);
  assert.ok(health.recentFlagged.some((row) => row.strategyId === 'SHADOW-TEST'));
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  for (let index = 0; index < 20; index += 1) {
    tracker.observeTrade({
      mint: 'normal', side: index % 2 ? 'SELL' : 'BUY', market: 'PUMP_AMM',
      timestampMs: 1_000 + index * 300, price: 1 + (index % 4) * 0.01,
    });
  }
  const snapshot = tracker.snapshot('normal', 8_000);
  assert.equal(snapshot.sampleReady, true);
  assert.equal(snapshot.flagged, false);
  assert.ok(snapshot.sideAlternationPct > 90);
}

console.log('pre-entry RUG risk tests passed');
