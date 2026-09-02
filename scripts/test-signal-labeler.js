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
assert.strictEqual(merged.label_status, 'COMPLETE');
assert.deepStrictEqual(JSON.parse(merged.missing_horizons_json), []);
assert.strictEqual(JSON.parse(merged.horizon_observation_lags_json)['60'], 0);
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
assert.strictEqual(restoredPatch.mfe_30s, undefined,
  'an uncovered excursion window must remain missing instead of being reported as 0%');
assert.strictEqual(restoredPatch.label_status, 'RIGHT_CENSORED');
assert.deepStrictEqual(JSON.parse(restoredPatch.missing_horizons_json), [1, 2, 15, 20, 30, 60]);
assert.strictEqual(JSON.parse(restoredPatch.horizon_observation_lags_json)['3'], 2000);

const failureUpdates = [];
const failureLabeler = new SignalLabeler({
  store: { updateSignalReturn: (_signalId, patch) => failureUpdates.push(patch) },
  config: {
    horizonsSeconds: [1],
    excursionSeconds: [],
    costModel: {
      platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 0,
      baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, fixedCostSol: 0,
      positionSizeSol: 0.2, failureRatePct: 100, failureLossPct: 7,
    },
  },
});
failureLabeler.addSignal({ signalId: 9, mint: 'failure', timestampMs: 3_000_000, price: 100 });
failureLabeler.onTrade({ mint: 'failure', timestampMs: 3_001_000, price: 110 });
assert.ok(Math.abs(failureUpdates[0].net_return_1s - 10) < 1e-9,
  'future labels must describe market returns, not stochastic execution failures');

const censoredUpdates = [];
const censoredLabeler = new SignalLabeler({
  store: { updateSignalReturn: (_signalId, patch) => censoredUpdates.push(patch) },
  config: { horizonsSeconds: [1, 5], excursionSeconds: [], configuredTradingCostPct: 1 },
});
censoredLabeler.addSignal({ signalId: 10, mint: 'idle', timestampMs: 4_000_000, price: 100 });
censoredLabeler.advanceTime(4_010_000);
assert.strictEqual(censoredUpdates[0].label_status, 'RIGHT_CENSORED');
assert.strictEqual(censoredUpdates[0].censor_reason, 'NO_TRADE_WITHIN_MAX_OBSERVATION_LAG');
assert.deepStrictEqual(JSON.parse(censoredUpdates[0].missing_horizons_json), [1, 5]);
assert.strictEqual(censoredLabeler.stats().censoredSignals, 1);

const crossMarketUpdates = [];
const crossMarketLabeler = new SignalLabeler({
  store: { updateSignalReturn: (_signalId, patch) => crossMarketUpdates.push(patch) },
  config: { horizonsSeconds: [1], excursionSeconds: [], configuredTradingCostPct: 1 },
});
crossMarketLabeler.addSignal({
  signalId: 11,
  mint: 'migrated',
  timestampMs: 5_000_000,
  price: 0.000001,
  market: 'PUMP_BONDING_CURVE',
});
crossMarketLabeler.onTrade({
  mint: 'migrated',
  timestampMs: 5_001_000,
  price: 0.001,
  market: 'PUMP_AMM',
});
crossMarketLabeler.advanceTime(5_004_000);
const crossMarketPatch = crossMarketUpdates.at(-1);
assert.strictEqual(crossMarketPatch.return_1s, undefined,
  'PumpSwap prices must never label a bonding-curve signal');
assert.strictEqual(crossMarketPatch.label_status, 'RIGHT_CENSORED');
assert.strictEqual(crossMarketPatch.censor_reason, 'MARKET_TRANSITION_BEFORE_HORIZON');
assert.strictEqual(crossMarketLabeler.stats().crossMarketSamplesSkipped, 1);

console.log('test-signal-labeler: ok');
