'use strict';

const assert = require('assert');
const FlowAccelerationEngine = require('../src/core/FlowAccelerationEngine');

const engine = new FlowAccelerationEngine({
  bufferMs: 600_000,
  activityWindowMs: 5_000,
  activityMinVolumeSol: 0.1,
  activityMinTxCount: 999,
  activityMinUniqueWallets: 999,
  signalWindowMs: 2_000,
  minNetFlowW3Sol: 3.49,
  minNetFlowDeltaSol: 0.1,
  minAccelerationRatio: 1.2,
  ratioFloorSol: 0.05,
  signalCooldownMs: 10_000,
  candidateIdleMs: 15_000,
});

const mint = 'FlowMint1111111111111111111111111111111111';
const signals = [];
engine.on('signal', (signal) => signals.push(signal));

function addMany({ count, total, side, start, end = null, wallets }) {
  for (let index = 0; index < count; index += 1) {
    engine.handleTrade({
      market: 'PUMP_BONDING_CURVE',
      mint,
      wallet: `wallet-${index % wallets}`,
      side,
      solAmount: total / count,
      tokenAmount: 1,
      price: 1,
      timestampMs: end != null && index === count - 1 ? end : start + index,
      curvePct: 40,
      ageMs: 30_000,
    }, { mint, symbol: 'FLOW' });
  }
}

addMany({ count: 3, total: 0.7, side: 'BUY', start: 95_000, wallets: 2 });
addMany({ count: 1, total: 0.4, side: 'SELL', start: 95_500, wallets: 1 });
addMany({ count: 8, total: 1.5, side: 'BUY', start: 97_000, wallets: 5 });
addMany({ count: 1, total: 0.5, side: 'SELL', start: 97_500, wallets: 1 });
addMany({ count: 1, total: 0.7, side: 'SELL', start: 99_000, wallets: 1 });
addMany({ count: 21, total: 4.2, side: 'BUY', start: 99_100, end: 100_000, wallets: 12 });

assert.strictEqual(signals.length, 1);
assert.ok(Math.abs(signals[0].netFlowW1 - 0.3) < 1e-8);
assert.ok(Math.abs(signals[0].netFlowW2 - 1.0) < 1e-8);
assert.ok(Math.abs(signals[0].netFlowW3 - 3.5) < 1e-8);
assert.deepStrictEqual(
  [signals[0].uniqueBuyersW1, signals[0].uniqueBuyersW2, signals[0].uniqueBuyersW3],
  [2, 5, 12],
);
assert.deepStrictEqual([signals[0].buyTxW1, signals[0].buyTxW2, signals[0].buyTxW3], [3, 8, 21]);
assert.ok(Math.abs(signals[0].flowAccel - signals[0].flowAccel1) < 1e-8);

engine.handleTrade({
  market: 'PUMP_BONDING_CURVE', mint, wallet: 'wallet-extra', side: 'BUY', solAmount: 0.1,
  tokenAmount: 1, price: 1, timestampMs: 100_001, curvePct: 40, ageMs: 30_001,
}, { mint, symbol: 'FLOW' });
assert.strictEqual(signals.length, 1, 'a sustained condition must not emit duplicate signals');

engine.handleComplete({ mint, completedAt: 101_000 });
engine.handleCreate({ mint, symbol: 'FLOW', graduated_at: 101_000 });
addMany({ count: 30, total: 30, side: 'BUY', start: 102_000, wallets: 30 });
assert.strictEqual(signals.length, 1, 'graduated tokens must not emit new signals');

console.log('test-flow-acceleration: ok');
