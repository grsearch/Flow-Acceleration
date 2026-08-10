'use strict';

const assert = require('assert');
const { config, normalizeEndpoint, liveTradingGuard } = require('../src/config');
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
assert.strictEqual(config.liveTrading.requestedEnabled, false);
assert.strictEqual(config.liveTrading.safetyLock, true);
assert.strictEqual(config.liveTrading.dryRun, true);
assert.strictEqual(config.liveTrading.signalVariant, 'primary_early_5_4');
assert.strictEqual(config.liveTrading.minNetFlowW3Sol, 5);
assert.strictEqual(config.liveTrading.minUniqueBuyersW3, 4);
assert.strictEqual(config.liveTrading.maxDailySpendSol, undefined);
assert.strictEqual(config.liveTrading.trailingStopPct, 7.5);
assert.strictEqual(config.liveTrading.maxHoldMs, 60_000);
assert.strictEqual(config.liveTrading.buySlippagePct, 10);
assert.strictEqual(config.liveTrading.sellSlippagePct, 15);
assert.strictEqual(config.liveTrading.entryReconcileCount, 5);
assert.strictEqual(config.liveTrading.readCommitment, 'processed');
assert.strictEqual(config.liveTrading.confirmationCommitment, 'confirmed');
assert.strictEqual(config.liveTrading.contextSlotRetryCount, 2);
assert.strictEqual(config.liveTrading.contextSlotRetryDelayMs, 25);
assert.strictEqual(config.signalShadow.enabled, true);
assert.deepStrictEqual(
  config.signalShadow.profiles.map((profile) => [
    profile.id,
    profile.signalVariant,
    profile.minNetFlowW3Sol,
    profile.minUniqueBuyersW3,
  ]),
  [
    ['aggressive', 'primary_early_3_3', 3, 3],
    ['balanced', 'primary_early_5_4', 5, 4],
    ['conservative', 'primary_early_7_5', 7, 5],
  ],
);
assert.strictEqual(config.signalShadow.trailingStopPct, 7.5);
assert.strictEqual(config.signalShadow.positionSizeSol, 0.05);
assert.ok(Math.abs(costBreakdown(config.signalShadow.costModel).deterministicCostPct - 3.22) < 1e-12);
assert.deepStrictEqual(config.strategy.primaryThresholdProfiles, config.signalShadow.profiles);
assert.strictEqual(config.flowFirstShadow.enabled, true);
assert.strictEqual(config.flowFirstShadow.signalVariant, 'primary_3w');
assert.strictEqual(config.flowFirstShadow.episodeGapMs, 30_000);
assert.strictEqual(config.flowFirstShadow.positionSizeSol, 0.05);
assert.deepStrictEqual(
  config.flowFirstShadow.cohorts.map((cohort) => [
    cohort.id,
    cohort.exitMode,
    cohort.fixedHoldMs ?? null,
    cohort.trailingStopPct ?? null,
  ]),
  [
    ['C5', 'FIXED_HOLD', 5_000, null],
    ['C75', 'TRAILING', null, 7.5],
    ['C125', 'TRAILING', null, 12.5],
  ],
);
assert.ok(
  Math.abs(costBreakdown(config.flowFirstShadow.costModel).deterministicCostPct - 3.22)
    < 1e-12,
);
assert.strictEqual(config.smartPullbackShadow.enabled, true);
assert.strictEqual(config.smartPullbackShadow.minSmartBuySol, 0.1);
assert.strictEqual(config.smartPullbackShadow.confirmationWindowMs, 15_000);
assert.strictEqual(config.smartPullbackShadow.pullbackPct, 2.5);
assert.strictEqual(config.smartPullbackShadow.reboundPct, 7.5);
assert.strictEqual(config.smartPullbackShadow.maxEntryVsSmartBuyPct, 2);
assert.deepStrictEqual(
  config.smartPullbackShadow.cohorts.map((cohort) => [cohort.id, cohort.trailingStopPct]),
  [['A', 7.5], ['B', 12.5]],
);
assert.ok(
  Math.abs(costBreakdown(config.smartPullbackShadow.costModel).deterministicCostPct - 3.22)
    < 1e-12,
);
assert.strictEqual(config.smartOpenShadow.enabled, true);
assert.strictEqual(config.smartOpenShadow.minSmartOpenSol, 1);
assert.strictEqual(config.smartOpenShadow.preBuyWindowMs, 2_000);
assert.strictEqual(config.smartOpenShadow.minPreBuyers, 2);
assert.strictEqual(config.smartOpenShadow.maxEntryPriceJumpPct, 10);
assert.deepStrictEqual(
  config.smartOpenShadow.cohorts.map((cohort) => [
    cohort.id,
    cohort.exitMode,
    cohort.fixedHoldMs ?? null,
    cohort.trailingActivationPct ?? null,
    cohort.trailingStopPct ?? null,
    cohort.followSmartExit,
  ]),
  [
    ['D0', 'FIXED_HOLD', 5_000, null, null, false],
    ['D1', 'DELAYED_TRAILING', null, 20, 15, false],
    ['D2', 'SMART_FOLLOW', null, null, null, true],
  ],
);
assert.ok(
  Math.abs(costBreakdown(config.smartOpenShadow.costModel).deterministicCostPct - 3.22)
    < 1e-12,
);

assert.deepStrictEqual(liveTradingGuard(true, true, false), {
  enabled: false,
  requestedEnabled: true,
  safetyLock: true,
  dryRun: true,
});
assert.deepStrictEqual(liveTradingGuard(true, false, false), {
  enabled: true,
  requestedEnabled: true,
  safetyLock: false,
  dryRun: false,
});

console.log('test-config-cost: ok');
