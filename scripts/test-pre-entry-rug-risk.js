'use strict';

const assert = require('node:assert/strict');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');

const config = {
  enabled: true,
  windowMs: 15_000,
  stateRetentionMs: 60_000,
  sweepIntervalMs: 5_000,
  maxEventsPerMint: 256,
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
