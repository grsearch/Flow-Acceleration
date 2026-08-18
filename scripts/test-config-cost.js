'use strict';

const assert = require('assert');
const {
  config, normalizeEndpoint, liveTradingGuard, shadowPositionEnv,
  livePositionEnv, priorityFeeMicroLamports,
} = require('../src/config');
const { costBreakdown, expectedNetReturnPct } = require('../src/core/CostModel');

assert.strictEqual(
  normalizeEndpoint('laserstream-mainnet-sgp.helius-rpc.com'),
  'https://laserstream-mainnet-sgp.helius-rpc.com',
);
assert.strictEqual(normalizeEndpoint('http://127.0.0.1:10000/'), 'http://127.0.0.1:10000');
assert.throws(() => normalizeEndpoint('grpc://example.com'), /Unsupported/);

process.env.FLOW_TEST_SHADOW_POSITION_SOL = '0.05';
assert.strictEqual(shadowPositionEnv('FLOW_TEST_SHADOW_POSITION_SOL'), 1);
process.env.FLOW_TEST_SHADOW_POSITION_SOL = '0.4';
assert.strictEqual(shadowPositionEnv('FLOW_TEST_SHADOW_POSITION_SOL'), 0.4);
delete process.env.FLOW_TEST_SHADOW_POSITION_SOL;
process.env.FLOW_TEST_LIVE_POSITION_SOL = '0.05';
assert.strictEqual(livePositionEnv('FLOW_TEST_LIVE_POSITION_SOL'), 0.1);
process.env.FLOW_TEST_LIVE_POSITION_SOL = '1';
assert.strictEqual(livePositionEnv('FLOW_TEST_LIVE_POSITION_SOL'), 0.1);
process.env.FLOW_TEST_LIVE_POSITION_SOL = '0.4';
assert.strictEqual(livePositionEnv('FLOW_TEST_LIVE_POSITION_SOL'), 0.4);
delete process.env.FLOW_TEST_LIVE_POSITION_SOL;
assert.strictEqual(priorityFeeMicroLamports(0.0005, 250_000), 2_000_000);

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
assert.strictEqual(config.storage.rawRetentionHours, 48);
assert.strictEqual(config.storage.startupReplayCacheMs, 15 * 60_000);
assert.strictEqual(config.liveTrading.enabled, false);
assert.strictEqual(config.liveTrading.requestedEnabled, false);
assert.strictEqual(config.liveTrading.safetyLock, true);
assert.strictEqual(config.liveTrading.dryRun, true);
assert.strictEqual(config.liveTrading.maxDailySpendSol, undefined);
assert.strictEqual(config.liveTrading.maxDailyTrades, undefined);
assert.strictEqual(config.liveTrading.maxDailyLossSol, undefined);
assert.strictEqual(config.liveTrading.maxConcurrentPositions, 3);
const liveContinuity = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'migration_continuity_mc_c5_e120_live'
));
const liveGraduationAccel = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'graduation_accel_o_c80_d5_b2_s0_nc_live'
));
const liveQualityLeader = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'quality_leader_ql_strict_protected_live'
));
const liveV3 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'post_gd20_35_r1_5_5_age60_xleg_v3'
));
const liveGd25F1 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'post_gd25_35_f1_xleg_live_v1'
));
assert.strictEqual(liveContinuity.positionSizeSol, 0.1);
assert.strictEqual(liveContinuity.entryEnabled, false);
assert.strictEqual(liveContinuity.code, 'M-C5-E120');
assert.strictEqual(liveContinuity.exitMode, 'FIXED_HOLD');
assert.strictEqual(liveContinuity.fixedHoldMs, 120_000);
assert.strictEqual(liveQualityLeader.positionSizeSol, 0.1);
assert.strictEqual(liveQualityLeader.entryEnabled, true);
assert.strictEqual(liveQualityLeader.code, 'QL-STRICT-PR');
assert.strictEqual(liveQualityLeader.market, 'PUMP_BONDING_CURVE');
assert.strictEqual(liveQualityLeader.exitMode, 'QUALITY_PROTECTED_RUNNER');
assert.strictEqual(liveQualityLeader.hardStopPct, 20);
assert.strictEqual(liveQualityLeader.noStrengthMs, 30_000);
assert.strictEqual(liveQualityLeader.maxHoldMs, 300_000);
assert.strictEqual(liveQualityLeader.protectedFloors.length, 4);
assert.strictEqual(liveGraduationAccel.positionSizeSol, 0.1);
assert.strictEqual(liveGraduationAccel.entryEnabled, false);
assert.strictEqual(liveGraduationAccel.market, 'PUMP_BONDING_CURVE');
assert.strictEqual(liveGraduationAccel.exitMode, 'GRADUATION_CORE_RUNNER');
assert.strictEqual(liveGraduationAccel.coreExitPct, 50);
assert.strictEqual(liveV3.positionSizeSol, 0.1);
assert.strictEqual(liveV3.entryEnabled, false);
assert.strictEqual(liveGd25F1.positionSizeSol, 0.1);
assert.strictEqual(liveGd25F1.entryEnabled, false);
assert.strictEqual(liveGd25F1.code, 'GD25-35-F1-XLEG');
assert.strictEqual(liveGd25F1.market, 'PUMP_AMM');
assert.strictEqual(liveGd25F1.trackingAgeMs, 120_000);
assert.strictEqual(liveGd25F1.dropMinPct, 25);
assert.strictEqual(liveGd25F1.dropMaxPct, 35);
assert.strictEqual(liveGd25F1.reboundMinPct, 2);
assert.strictEqual(liveGd25F1.reboundMaxPct, 5);
assert.strictEqual(liveGd25F1.maxSignalsPerMint, 1);
assert.strictEqual(liveGd25F1.maxEntriesPerMint, 1);
assert.strictEqual(liveGd25F1.maxEntryPriceJumpPct, 10);
assert.strictEqual(liveGd25F1.maxEntrySelfImpactPct, 10);
assert.strictEqual(liveGd25F1.trailingActivationPct, 8);
assert.strictEqual(liveGd25F1.trailingStopPct, 3);
assert.strictEqual(liveGd25F1.maxHoldMs, 15_000);
assert.strictEqual(config.liveTrading.priorityFeeSol, 0.0005);
assert.strictEqual(config.liveTrading.priorityFeeMicroLamports, 2_000_000);
assert.strictEqual(liveV3.market, 'PUMP_AMM');
assert.strictEqual(liveV3.dropMinPct, 20);
assert.strictEqual(liveV3.dropMaxPct, 35);
assert.strictEqual(liveV3.reboundMinPct, 1.5);
assert.strictEqual(liveV3.reboundMaxPct, 5);
assert.strictEqual(liveV3.trackingAgeMs, 60_000);
assert.strictEqual(liveV3.maxEntryPriceJumpPct, 3);
assert.strictEqual(liveV3.maxEntriesPerMint, 1);
assert.strictEqual(liveV3.reentryCooldownMs, 1_000);
assert.strictEqual(liveV3.trailingActivationPct, 8);
assert.strictEqual(liveV3.trailingStopPct, 3);
assert.strictEqual(liveV3.maxHoldMs, 15_000);
assert.strictEqual(config.liveTrading.strategies
  .find((strategy) => strategy.id === 'post_gd25_32_r2_4_age30_xleg_v2').entryEnabled, false);
assert.strictEqual(config.liveTrading.strategies
  .find((strategy) => strategy.id === 'post_gd25_35_xleg').entryEnabled, false);
assert.strictEqual(config.liveTrading.buySlippagePct, 10);
assert.strictEqual(config.liveTrading.sellSlippagePct, 15);
assert.strictEqual(config.liveTrading.entryReconcileCount, 5);
assert.strictEqual(config.liveTrading.expiredEntryReleaseMs, 10 * 60_000);
assert.strictEqual(config.liveTrading.readCommitment, 'processed');
assert.strictEqual(config.liveTrading.confirmationCommitment, 'confirmed');
assert.strictEqual(config.liveTrading.contextSlotRetryCount, 6);
assert.strictEqual(config.liveTrading.contextSlotRetryDelayMs, 50);
assert.strictEqual(config.signalShadow.enabled, false);
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
assert.strictEqual(config.signalShadow.positionSizeSol, 1);
assert.ok(Math.abs(costBreakdown(config.signalShadow.costModel).deterministicCostPct - 2.251) < 1e-12);
assert.deepStrictEqual(config.strategy.primaryThresholdProfiles, config.signalShadow.profiles);
assert.strictEqual(config.flowFirstShadow.enabled, false);
assert.strictEqual(config.flowFirstShadow.signalVariant, 'primary_3w');
assert.strictEqual(config.flowFirstShadow.episodeGapMs, 30_000);
assert.strictEqual(config.flowFirstShadow.positionSizeSol, 1);
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
  Math.abs(costBreakdown(config.flowFirstShadow.costModel).deterministicCostPct - 2.251)
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
  Math.abs(costBreakdown(config.smartPullbackShadow.costModel).deterministicCostPct - 2.251)
    < 1e-12,
);
assert.strictEqual(config.smartOpenShadow.enabled, false);
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
  Math.abs(costBreakdown(config.smartOpenShadow.costModel).deterministicCostPct - 2.251)
    < 1e-12,
);
assert.strictEqual(config.flowSmartConfirmShadow.enabled, true);
assert.strictEqual(config.flowSmartConfirmShadow.positionSizeSol, 1);
assert.deepStrictEqual(
  config.flowSmartConfirmShadow.cohorts.map((cohort) => [cohort.id, cohort.maxConfirmationDelayMs]),
  [['L5_F5', 5_000], ['L15_F5', 15_000], ['L5_T15', 5_000], ['L15_T20', 15_000]],
);
assert.strictEqual(config.smartResonanceShadow.enabled, true);
assert.strictEqual(config.smartResonanceShadow.positionSizeSol, 1);
assert.strictEqual(config.smartResonanceShadow.entryDelayMs, 200);
assert.deepStrictEqual(
  config.smartResonanceShadow.entryProfiles.map((profile) => [
    profile.id, profile.requiredWallets, profile.resonanceWindowMs,
  ]),
  [
    ['SR_R0', 2, 5_000],
    ['SR_R1', 2, 5_000],
    ['SR_R2', 3, 60_000],
    ['SR_R3', 2, 60_000],
  ],
);
assert.deepStrictEqual(
  config.smartResonanceShadow.exitProfiles.map((profile) => [
    profile.id, profile.hardStopPct, profile.maxHoldMs,
  ]),
  [
    ['H20_T60', 20, 60_000], ['H20_T120', 20, 120_000],
    ['H20_T180', 20, 180_000], ['H20_T240', 20, 240_000],
    ['H30_T60', 30, 60_000], ['H30_T120', 30, 120_000],
    ['H30_T180', 30, 180_000], ['H30_T240', 30, 240_000],
  ],
);
assert.strictEqual(config.publicFlowLeadShadow.enabled, true);
assert.strictEqual(config.publicFlowLeadShadow.positionSizeSol, 1);
assert.strictEqual(config.publicFlowLeadShadow.smartLabelWindowMs, 15_000);
assert.deepStrictEqual(
  config.publicFlowLeadShadow.entryProfiles.map((profile) => profile.id),
  ['PFL_B0', 'PFL_B1', 'PFL_A1', 'PFL_R1'],
);
assert.deepStrictEqual(
  config.publicFlowLeadShadow.exitProfiles.map((profile) => [
    profile.id, profile.hardStopPct, profile.maxHoldMs,
  ]),
  [
    ['H20_T120', 20, 120_000], ['H20_T180', 20, 180_000],
    ['H20_T240', 20, 240_000], ['H30_T120', 30, 120_000],
    ['H30_T180', 30, 180_000], ['H30_T240', 30, 240_000],
  ],
);
assert.strictEqual(
  config.publicFlowLeadShadow.entryProfiles.find((profile) => profile.id === 'PFL_A1')
    .minFlowAccelerationRatio,
  1.5,
);
assert.strictEqual(config.launchPullbackShadow.enabled, true);
assert.strictEqual(config.launchPullbackShadow.positionSizeSol, 1);
assert.strictEqual(config.launchPullbackShadow.maxEntryPriceJumpPct, 10);
assert.deepStrictEqual(
  config.launchPullbackShadow.profiles.slice(0, 3).map((profile) => [
    profile.id,
    profile.minNetFlowSol,
    profile.maxCreatorSharePct,
  ]),
  [['F1', 15, 5], ['F2', 20, 10], ['F3', 20, 20]],
);
assert.deepStrictEqual(
  config.launchPullbackShadow.profiles.slice(3).map((profile) => [
    profile.id, profile.minBuyers, profile.minRecentBuyers,
    profile.minRetentionPct, profile.maxTop3SharePct,
  ]),
  [['FQ1', 10, 3, 50, 70], ['FQ2', 15, 3, 50, 70]],
);
assert.deepStrictEqual(
  config.launchPullbackShadow.holds.map((hold) => [hold.id, hold.fixedHoldMs]),
  [['3S', 3_000], ['8S', 8_000]],
);
assert.deepStrictEqual(
  config.launchPullbackShadow.optimizationCohorts.map((cohort) => cohort.id),
  [
    'FC_BASE_X12', 'FC_STRICT_NF20_X12', 'FC_BASE_STAIR60',
    'FC_BASE_WEAK3_X12', 'FC_BASE_WEAK5_X12',
    'FO_F2_J2_3S', 'FO_C70_10S', 'FO_C70_T15', 'FO_RB10_30S', 'FO_RB10_T20',
    'FO_RB10_H20_60S', 'FO_RB10_H20_120S',
    'FO_D12_R3_10S', 'FO_D12_R3_T15',
    'FO_D12_R3_Q_10S', 'FO_D12_R3_QC_10S', 'FO_D12_R3_Q_T10_H30',
    'F2_8S_NF30', 'FT_C_NF30', 'F2_NF30_H20_60S', 'F2_NF30_H20_120S',
    'F_ABSORB3_8S', 'F_ABSORB5_RUNNER', 'F_REACCEL0_8S',
  ],
);
assert.strictEqual(
  config.launchPullbackShadow.optimizationCohorts
    .find((cohort) => cohort.id === 'FO_D12_R3_Q_10S').maxNetFlowSol,
  50,
);
assert.strictEqual(
  config.launchPullbackShadow.optimizationCohorts[0].maxEntryPriceJumpPct,
  3,
);
const flowConsensus = config.launchPullbackShadow.optimizationCohorts
  .find((cohort) => cohort.id === 'FC_BASE_X12');
assert.strictEqual(flowConsensus.flowConfirmationWindowMs, 5_000);
assert.strictEqual(flowConsensus.minFlowSignalBuyersW3, 3);
assert.strictEqual(flowConsensus.fixedHoldMs, 12_000);
assert.ok(
  Math.abs(costBreakdown(config.launchPullbackShadow.costModel).deterministicCostPct - 2.251)
    < 1e-12,
);
assert.strictEqual(config.launchQualityObserver.enabled, true);
assert.deepStrictEqual(
  config.launchQualityObserver.snapshotHorizonsMs,
  [5_000, 10_000, 20_000, 30_000, 60_000],
);
assert.strictEqual(config.launchQualityObserver.pumpReferencePct, 25);
assert.strictEqual(config.launchQualityObserver.pullbackReferencePct, 7.5);
assert.strictEqual(config.launchQualityObserver.reboundReferencePct, 3);
assert.strictEqual(config.launchQualityObserver.marketRegimeLookbackMs, 30 * 60_000);
assert.strictEqual(config.launchQualityObserver.marketRegimeSettlementLagMs, 60_000);
assert.strictEqual(config.rangeScalperShadow.enabled, false);
assert.strictEqual(config.rangeScalperShadow.initialObservationMs, 120_000);
assert.strictEqual(config.rangeScalperShadow.maxTrackingMs, 1_200_000);
assert.strictEqual(config.rangeScalperShadow.windowMs, 60_000);
assert.deepStrictEqual(
  config.rangeScalperShadow.entryProfiles.map((profile) => profile.id),
  ['JA', 'JB', 'JC', 'JW'],
);
assert.deepStrictEqual(
  config.rangeScalperShadow.entryProfiles.find((profile) => profile.id === 'JW'),
  {
    id: 'JW', label: 'JW · JB条件预热后仅交易第2/3波', warmupProfileId: 'JB',
    deviationSigma: 1.5, reboundPct: 2, reboundTimeoutMs: 5_000,
    minRecentNetFlowSol: 0.1, minOpportunityIndex: 2,
    maxOpportunityIndex: 3, exitProfileIds: ['X6'],
  },
);
assert.deepStrictEqual(
  config.rangeScalperShadow.exitProfiles.map((profile) => profile.id),
  ['XM', 'X6', 'XB', 'XF'],
);
assert.ok(
  Math.abs(costBreakdown(config.rangeScalperShadow.costModel).deterministicCostPct - 2.251)
    < 1e-12,
);
assert.strictEqual(config.cyaEarlyPyramidShadow.enabled, false);
assert.strictEqual(config.cyaEarlyPyramidShadow.positionSizeSol, 1);
assert.deepStrictEqual(
  config.cyaEarlyPyramidShadow.entryProfiles.map((profile) => profile.id),
  ['K5_30', 'K3_30'],
);
assert.deepStrictEqual(
  config.cyaEarlyPyramidShadow.exitProfiles.map((profile) => profile.id),
  ['T20', 'T30'],
);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles.map((profile) => [
    profile.id, profile.maxLifecycleAgeMs ?? null, profile.maxSignalsPerMint ?? null,
  ]),
  [
    ['GD25_35', null, null],
    ['GE30_R23_F1', 30_000, 1],
    ['GE30_R23_F3', 30_000, 3],
    ['GE30_R23_F1_EXEC', 30_000, 1],
    ['GE30_R23_F2_ONLY', 30_000, 2],
    ['GE30_R23_F3_EXEC', 30_000, 3],
    ['GE30_R23_F2_ONLY_EXEC', 30_000, 2],
    ['GE30_R23_F1_NIGHT', 30_000, 1],
    ['GE30_R23_F1_DAY', 30_000, 1],
    ['GE30_D25_32_R24_F1', 30_000, 1],
    ['GE30_D25_32_R23_F1_FAST200', 30_000, 1],
  ],
);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F1_EXEC').positionSols,
  [0.05, 0.1, 0.25, 0.5, 1],
);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F1_NIGHT').beijingHourRanges,
  [[0, 8], [18, 24]],
);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.exitProfiles.map((profile) => profile.id),
  [
    'X3', 'X8', 'XLEG',
    'GEXEC_XLEG', 'G2_XLEG', 'G3EXEC_XLEG', 'G2EXEC_XLEG', 'GTIME_XLEG', 'GQ_XLEG',
    'G1_E2_H6', 'G1_E2_H8', 'G1_E3_H8',
    'G1_B75_H30', 'G1_B50_H60',
    'G1_STAIR_H60', 'G1_STAIR_H120',
    'XB50', 'XB25',
    'V2_R2_H10', 'V2_R2_H15', 'V2_B75_H20', 'V2_B75_H60',
    'XR3_H12', 'XR3_H15', 'XR4_H12', 'XR4_H15',
  ],
);
assert.ok(config.migratedDropReboundShadow.exitProfiles
  .filter((profile) => profile.id.startsWith('XB') || profile.id.startsWith('XR'))
  .every((profile) => profile.entryProfileIds.join(',') === 'GD25_35'));
assert.ok(config.migratedDropReboundShadow.exitProfiles
  .filter((profile) => profile.id.startsWith('V2_'))
  .every((profile) => profile.entryProfileIds.join(',') === 'GE30_D25_32_R24_F1'));
const gqProfile = config.migratedDropReboundShadow.entryProfiles
  .find((profile) => profile.id === 'GE30_D25_32_R23_F1_FAST200');
assert.strictEqual(gqProfile.maxReboundFromLowMs, 200);
assert.deepStrictEqual(gqProfile.positionSols, [0.05, 0.25, 0.5, 1]);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F3_EXEC').positionSols,
  [0.05, 0.1, 0.25],
);
assert.deepStrictEqual(
  config.bigWinnerShadow.entryProfiles.filter((profile) => profile.family === 'PARTICIPATION')
    .map((profile) => profile.id),
  ['PP_DIRECT_10', 'PP_PULLBACK_8_20', 'PP_PULLBACK_8_30'],
);
assert.strictEqual(config.migrationContinuityShadow.enabled, true);
assert.strictEqual(config.migrationContinuityShadow.positionSizeSol, 1);
assert.deepStrictEqual(config.migrationContinuityShadow.entryProfile, {
  id: 'MC_C5', label: 'MC-C · 毕业后5秒质量延续',
  liveStrategyId: 'migration_continuity_mc_c5_e120_live',
  minBuyers: 20, minNetFlowSol: 5, minReturnPct: 5, maxSellBuyRatio: 0.6,
});
assert.deepStrictEqual(
  config.migrationContinuityShadow.exitProfiles.map((profile) => profile.id),
  ['E60', 'E120', 'T10', 'T12_5', 'FLOW', 'RUNNER'],
);
assert.deepStrictEqual(
  config.holderGrowthShadow.entryProfiles.map((profile) => [profile.id, profile.horizonMs]),
  [
    ['HG30_BAL', 30_000],
    ['HG30_NQ_A_R75_C40_75', 30_000],
    ['HG30_NQ_B_R80_C45_70', 30_000],
    ['HG30_NQ_C_POST_PEAK', 30_000],
  ],
);
assert.strictEqual(
  config.qualityLeaderShadow.entryProfiles.find((profile) => profile.id === 'QL_STRICT')
    .liveStrategyId,
  'quality_leader_ql_strict_protected_live',
);
assert.deepStrictEqual(
  config.holderGrowthShadow.exitProfiles.map((profile) => profile.id),
  ['X15_FIXED', 'X12_FIXED', 'X18_FIXED'],
);
assert.deepStrictEqual(
  config.holderGrowthShadow.entryProfiles.find((profile) => (
    profile.id === 'HG30_BAL'
  )).exitProfileIds,
  ['X15_FIXED'],
);
const holderNqB = config.holderGrowthShadow.entryProfiles.find((profile) => (
  profile.id === 'HG30_NQ_B_R80_C45_70'
));
assert.strictEqual(holderNqB.minRetentionPct, 80);
assert.strictEqual(holderNqB.minCurvePct, 45);
assert.strictEqual(holderNqB.maxCurvePct, 70);
const holderNqC = config.holderGrowthShadow.entryProfiles.find((profile) => (
  profile.id === 'HG30_NQ_C_POST_PEAK'
));
assert.strictEqual(holderNqC.requirePostPeakNetPositive, true);
assert.deepStrictEqual(holderNqC.exitProfileIds, ['X12_FIXED', 'X15_FIXED', 'X18_FIXED']);
assert.ok(!config.holderGrowthShadow.entryProfiles.some((profile) => (
  ['HG30_NB20_NF25', 'HG30_RB15_NF25', 'HG30_B80_NF25'].includes(profile.id)
)));
assert.strictEqual(config.holderGrowthShadow.exitTimeoutMs, 30_000);
assert.ok(config.holderGrowthShadow.exitProfiles
  .filter((profile) => ['ADAPTIVE_TRAILING', 'SCALE_ADAPTIVE'].includes(profile.exitMode))
  .every((profile) => profile.trailingTiers.length >= 4));
assert.strictEqual(config.graduationAccelerationShadow.enabled, true);
assert.deepStrictEqual(config.graduationAccelerationShadow.capacitySols, [0.05, 0.5, 1]);
assert.deepStrictEqual(
  config.graduationAccelerationShadow.entryProfiles.map((profile) => profile.id),
  [
    'O_FAST10_C80_B20_R07', 'O_C80_D5_B2_S0_NC',
    'O90_M5_X60', 'O90_M5_X120', 'O90_M5_STAIR120',
  ],
);
const o90Gate = config.graduationAccelerationShadow.entryProfiles
  .find((profile) => profile.id === 'O90_M5_X60');
assert.deepStrictEqual(o90Gate.postMigrationGate, {
  windowMs: 5_000, minBuyers: 25, minNetFlowSol: 0,
});
assert.deepStrictEqual(
  config.graduationAccelerationShadow.trailingTiers.map((tier) => [
    tier.activationPct, tier.drawdownPct,
  ]),
  [[20, 10], [40, 15], [80, 20], [150, 25], [300, 30]],
);
assert.strictEqual(config.graduationAccelerationShadow.coreExitPct, 50);
assert.ok(
  Math.abs(costBreakdown(config.cyaEarlyPyramidShadow.costModel).deterministicCostPct - 2.251)
    < 1e-12,
);
for (const shadow of [
  config.signalShadow,
  config.flowFirstShadow,
  config.smartPullbackShadow,
  config.smartOpenShadow,
  config.launchPullbackShadow,
  config.cyaEarlyPyramidShadow,
  config.bondingCurveMomentumShadow,
  config.graduationHoldShadow,
  config.migratedDropReboundShadow,
  config.rangeScalperShadow,
]) {
  assert.strictEqual(shadow.positionSizeSol, 1);
  assert.ok(Math.abs(costBreakdown(shadow.costModel).deterministicCostPct - 2.251) < 1e-12);
}

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
