'use strict';

const assert = require('assert');
const SignalLabeler = require('../src/core/SignalLabeler');

const updates = [];
const labeler = new SignalLabeler({
  store: { updateSignalReturn: (signalId, patch) => updates.push({ signalId, patch }) },
  config: {
    horizonsSeconds: [1, 2, 3, 5, 8, 10, 15, 20, 30, 60],
    excursionSeconds: [5, 10, 30],
    configuredTradingCostPct: 1.4,
  },
});

labeler.addSignal({ signalId: 7, mint: 'mint', timestampMs: 1_000_000, price: 100, configuredCostPct: 1.4 });
const samples = [
  [1, 101], [2, 102], [3, 99], [5, 105], [8, 104],
  [10, 103], [15, 102], [20, 101], [30, 98], [60, 106],
];
for (const [seconds, price] of samples) {
  labeler.onTrade({ mint: 'mint', timestampMs: 1_000_000 + seconds * 1_000, price });
}

const merged = Object.assign({}, ...updates.map((update) => update.patch));
assert.ok(Math.abs(merged.return_5s - 5) < 1e-9);
assert.ok(Math.abs(merged.net_return_5s - 3.6) < 1e-9);
assert.ok(Math.abs(merged.mfe_5s - 5) < 1e-9);
assert.ok(Math.abs(merged.mae_5s + 1) < 1e-9);
assert.ok(Math.abs(merged.return_60s - 6) < 1e-9);
assert.ok(merged.finalized_at);
assert.strictEqual(labeler.stats().pendingSignals, 0);

const restoredUpdates = [];
const restoredLabeler = new SignalLabeler({
  store: {
    labelSamples: () => [
      { timestamp_ms: 2_005_000, price: 110 },
      { timestamp_ms: 2_010_000, price: 90 },
    ],
    updateSignalReturn: (signalId, patch) => restoredUpdates.push({ signalId, patch }),
  },
  config: {
    horizonsSeconds: [1, 2, 3, 5, 8, 10, 15, 20, 30, 60],
    excursionSeconds: [5, 10, 30],
    configuredTradingCostPct: 1.4,
  },
});
restoredLabeler.restore([{
  signal_id: 8,
  mint: 'restored-mint',
  timestamp_ms: 2_000_000,
  p0: 100,
  configured_cost_pct: 1.4,
}]);
restoredLabeler.advanceTime(2_066_000);
const restoredPatch = restoredUpdates.at(-1).patch;
assert.ok(Math.abs(restoredPatch.mfe_10s - 10) < 1e-9);
assert.ok(Math.abs(restoredPatch.mae_10s + 10) < 1e-9);

console.log('test-signal-labeler: ok');
