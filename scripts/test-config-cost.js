'use strict';

const assert = require('assert');
const { config, normalizeEndpoint } = require('../src/config');
const { costBreakdown, expectedNetReturnPct } = require('../src/core/CostModel');

assert.strictEqual(
  normalizeEndpoint('laserstream-mainnet-sgp.helius-rpc.com'),
  'https://laserstream-mainnet-sgp.helius-rpc.com',
);
assert.strictEqual(normalizeEndpoint('http://127.0.0.1:10000/'), 'http://127.0.0.1:10000');
assert.throws(() => normalizeEndpoint('grpc://example.com'), /Unsupported/);

const costs = costBreakdown({
  platformFeePct: 1,
  buySlippagePct: 0.2,
  sellSlippagePct: 0.3,
  priceImpactPct: 0.4,
  baseTxFeeSol: 0.001,
  priorityFeeSol: 0,
  jitoTipSol: 0,
  fixedCostSol: 0,
  positionSizeSol: 0.2,
  failureRatePct: 10,
  failureLossPct: 5,
});
assert.ok(Math.abs(costs.deterministicCostPct - 2.4) < 1e-12);
assert.strictEqual(costs.entryFailureRatePct, 10);
assert.strictEqual(costs.entryFailureCostPct, 5);
assert.ok(Math.abs(expectedNetReturnPct(10, costs) - 6.34) < 1e-12);
assert.strictEqual(config.backtest.executionDelayMs, 200);
assert.strictEqual(config.backtest.exitExecutionDelayMs, 200);
assert.strictEqual(config.backtest.signalCooldownMs, 5_000);
assert.strictEqual(config.backtest.singlePositionPerMint, true);
assert.strictEqual(config.liveTrading.enabled, false);
assert.strictEqual(config.liveTrading.dryRun, true);
assert.strictEqual(config.liveTrading.minSmartOpenSol, 1);
assert.strictEqual(config.liveTrading.minPreBuyers, 2);
assert.strictEqual(config.liveTrading.preBuyWindowMs, 2_000);
assert.strictEqual(config.liveTrading.exitStrategy, 'SMART_WALLET_SELL_60S');
assert.strictEqual(config.liveTrading.buySlippagePct, 10);
assert.strictEqual(config.liveTrading.sellSlippagePct, 15);
assert.strictEqual(config.liveTrading.entryReconcileCount, 5);
assert.strictEqual(config.liveTrading.readCommitment, 'processed');
assert.strictEqual(config.liveTrading.confirmationCommitment, 'confirmed');
assert.strictEqual(config.liveTrading.contextSlotRetryCount, 2);
assert.strictEqual(config.liveTrading.contextSlotRetryDelayMs, 25);

console.log('test-config-cost: ok');
