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
assert.strictEqual(config.backtest.noExitLossPct, null);
assert.strictEqual(config.backtest.signalCooldownMs, 5_000);
assert.strictEqual(config.backtest.singlePositionPerMint, true);
assert.strictEqual(config.storage.rawRetentionHours, 48);
assert.strictEqual(config.storage.healthRefreshMs, 15 * 60_000);
assert.strictEqual(config.storage.startupReplayCacheMs, 15 * 60_000);
assert.strictEqual(config.smartWalletRegistry.clusterAutoEnabled, true);
assert.strictEqual(config.smartWalletRegistry.clusterObservationMs, 12 * 60 * 60_000);
assert.strictEqual(config.smartWalletRegistry.clusterMinDistinctMints, 3);
assert.strictEqual(config.smartWalletRegistry.clusterSyncWindowMs, 5_000);
assert.strictEqual(config.smartWalletRegistry.clusterAmountTolerancePct, 15);
assert.strictEqual(config.smartWalletRegistry.clusterMinCorrelatedMints, 2);
assert.strictEqual(config.smartWalletRegistry.clusterMinCorrelationPct, 50);
assert.strictEqual(config.smartWalletRegistry.historyBackfillEnabled, true);
assert.strictEqual(config.smartWalletRegistry.historyWindowMs, 60 * 24 * 60 * 60_000);
assert.strictEqual(config.smartWalletRegistry.historyWarmupMs, 30 * 24 * 60 * 60_000);
assert.strictEqual(config.smartWalletRegistry.historyInitialAllEnabled, true);
assert.strictEqual(config.smartWalletRegistry.historyDailyWalletLimit, 50);
assert.strictEqual(config.smartWalletRegistry.historyConcurrency, 1);
assert.strictEqual(config.smartWalletRegistry.historyRetryMs, 24 * 60 * 60_000);
assert.strictEqual(config.smartWalletRegistry.historyPageSize, 1_000);
assert.strictEqual(config.smartWalletRegistry.historyMaxPagesPerWallet, 500);
assert.strictEqual(config.smartWalletRegistry.historyCreditsPerPage, 50);
assert.strictEqual(config.smartWalletRegistry.elite60dEnabled, true);
assert.strictEqual(config.smartWalletRegistry.elite60dWindowMs, 60 * 24 * 60 * 60_000);
assert.strictEqual(config.smartWalletRegistry.elite60dMinRealizedSol, 200);
assert.strictEqual(config.smartWalletRegistry.ageRetryMs, 24 * 60 * 60_000);
assert.strictEqual(config.smartWalletRegistry.ageCheckConcurrency, 1);
assert.strictEqual(config.smartWalletRegistry.eventMonitoringRequiresResolvedAge, true);
assert.strictEqual(config.smartWalletRegistry.pnlSnapshotCacheMs, 15 * 60_000);
assert.strictEqual(config.smartWalletRegistry.votingSnapshotRefreshMs, 15 * 60_000);
assert.strictEqual(config.smartWalletRegistry.lastSeenWriteIntervalMs, 15 * 60_000);
assert.strictEqual(config.smartWalletRegistry.actualEventBackfillBatchSize, 250);
assert.strictEqual(config.smartWalletRegistry.actualEventBackfillIntervalMs, 5_000);
assert.strictEqual(config.smartWalletRegistry.clusterRefreshMs, 6 * 60 * 60_000);
assert.strictEqual(config.smartWalletConsensusOverlay.enabled, true);
assert.strictEqual(config.smartWalletConsensusOverlay.gateWindowMs, 15 * 60_000);
assert.strictEqual(config.smartWalletConsensusOverlay.gateFinalizeDelayMs, 60_000);
assert.deepStrictEqual(
  config.smartWalletConsensusOverlay.profiles.map((profile) => [
    profile.id, profile.source, profile.sourceCohortId,
  ]),
  [
    ['SWC_G_GE30_R23_F2_G2_XLEG', 'MIGRATED_DROP_REBOUND',
      'POST_GE30_R23_F2_ONLY_G2_XLEG'],
    ['SWC_G_GD25_35_X8', 'MIGRATED_DROP_REBOUND', 'POST_GD25_35_X8'],
    ['SWC_O_C80_D5_B2_S0_NC', 'GRADUATION_ACCELERATION',
      'O_C80_D5_B2_S0_NC:1SOL'],
    ['SWC_O90_M5_STAIR120', 'GRADUATION_ACCELERATION', 'O90_M5_STAIR120:1SOL'],
    ['SWC_FEA_BNH_120', 'FEATURE_EDGE_BNH', 'FEA_BNH_120'],
  ],
);
const earlyCurveConsensus = config.smartWalletConsensusFlowRunnerShadow.entryProfiles.find(
  (profile) => profile.id === 'EARLY_C25_R3',
);
assert(earlyCurveConsensus);
assert.strictEqual(earlyCurveConsensus.requiredClusters, 3);
assert.strictEqual(earlyCurveConsensus.consensusWindowMs, 180_000);
assert.strictEqual(earlyCurveConsensus.maxCurvePct, 25);
assert.strictEqual(earlyCurveConsensus.directCurveEntry, true);
assert.deepStrictEqual(
  earlyCurveConsensus.exitProfileIds,
  ['FIX30', 'CORE80_RUNNER6H_SP30T20'],
);
const strictPredictionConsensus = config.smartWalletConsensusFlowRunnerShadow.entryProfiles.find(
  (profile) => profile.id === 'PA3_EARLY_C25_V1',
);
assert(strictPredictionConsensus);
assert.strictEqual(strictPredictionConsensus.requiredClusters, 3);
assert.strictEqual(strictPredictionConsensus.minSelectionAClusters, 3);
assert.strictEqual(strictPredictionConsensus.selectionGradeOnly, 'S_A');
assert.strictEqual(strictPredictionConsensus.consensusWindowMs, 300_000);
const broadConsensusControl = config.smartWalletConsensusFlowRunnerShadow.entryProfiles.find(
  (profile) => profile.id === 'ROLLING_DYNAMIC_CONTROL_V1',
);
assert(broadConsensusControl);
assert.strictEqual(broadConsensusControl.researchControl, true);
assert.strictEqual(broadConsensusControl.minSelectionAClusters, 0);
for (const legacyProfileId of [
  'POST_FLOW', 'SCOUT15_FLOW', 'POST_FLOW_STRICT',
  'SCOUT15_FLOW_STRICT', 'STRONG25_FLOW',
]) {
  const legacyProfile = config.smartWalletConsensusFlowRunnerShadow.entryProfiles.find(
    (profile) => profile.id === legacyProfileId,
  );
  assert(legacyProfile);
  assert.strictEqual(legacyProfile.enabled, false);
}
assert.deepStrictEqual(config.smartWalletConsensusOverlay.consensusEntryProfileIds, [
  'PA3_POST_FLOW_V1', 'PA3_SCOUT15_FLOW_V1', 'PA3_EARLY_C25_V1',
]);
const postGradHoldingConsensus = config.smartWalletConsensusFlowRunnerShadow.entryProfiles.find(
  (profile) => profile.id === 'POST_GRAD_HOLD3_FLOW2_60',
);
assert(postGradHoldingConsensus);
assert.strictEqual(postGradHoldingConsensus.postGraduationHoldingConsensus, true);
assert.strictEqual(postGradHoldingConsensus.requiredHoldingClusters, 3);
assert.strictEqual(postGradHoldingConsensus.flowWindowMs, 60_000);
assert.strictEqual(postGradHoldingConsensus.maxFlowWaitMs, 60_000);
assert.strictEqual(postGradHoldingConsensus.minFlowBuyers, 2);
assert.strictEqual(postGradHoldingConsensus.minFlowBuyTx, 2);
assert.strictEqual(postGradHoldingConsensus.requirePositiveFlow, true);
assert.strictEqual(postGradHoldingConsensus.entryTimeoutMs, 30_000);
assert.deepStrictEqual(postGradHoldingConsensus.exitProfileIds, ['CORE80_RUNNER30M']);
const postGradHoldingExit = config.smartWalletConsensusFlowRunnerShadow.exitProfiles.find(
  (profile) => profile.id === 'CORE80_RUNNER30M',
);
assert(postGradHoldingExit);
assert.strictEqual(postGradHoldingExit.coreActivationPct, 30);
assert.strictEqual(postGradHoldingExit.coreFraction, 0.8);
assert.strictEqual(postGradHoldingExit.runnerTrailPct, 30);
assert.strictEqual(postGradHoldingExit.maxHoldMs, 30 * 60_000);
assert.strictEqual(postGradHoldingExit.hardStopPct, 20);
assert.strictEqual(postGradHoldingExit.exitTimeoutMs, 30_000);
const earlyBurstConsensus = config.earlyPureBuyBurstShadow.entryProfiles.find(
  (profile) => profile.id === 'EB_A_SWC_R2_W300',
);
assert(earlyBurstConsensus);
assert.strictEqual(earlyBurstConsensus.sourceProfileId, 'EB_A');
assert.strictEqual(earlyBurstConsensus.requiredClusters, 2);
assert.strictEqual(earlyBurstConsensus.consensusWindowMs, 300_000);
assert.deepStrictEqual(earlyBurstConsensus.exitProfileIds, ['FIX20', 'FIX30']);
const earlyBurstRugPair = config.earlyPureBuyBurstShadow.entryProfiles.find(
  (profile) => profile.id === 'EB_A_RUGX',
);
assert(earlyBurstRugPair);
assert.strictEqual(earlyBurstRugPair.pairedBaselineProfileId, 'EB_A');
assert.strictEqual(earlyBurstRugPair.rugGuardMode, 'LIVE_CURVE_CATASTROPHE');
assert.deepStrictEqual(earlyBurstRugPair.exitProfileIds, ['FIX20']);
const strictEarlyBurstConsensus = config.earlyPureBuyBurstShadow.entryProfiles.find(
  (profile) => profile.id === 'EB_A_SWC_PA3_W300',
);
assert(strictEarlyBurstConsensus);
assert.strictEqual(strictEarlyBurstConsensus.requiredClusters, 3);
assert.strictEqual(strictEarlyBurstConsensus.minSelectionAClusters, 3);
assert.strictEqual(strictEarlyBurstConsensus.selectionGradeOnly, 'S_A');
assert.strictEqual(config.smartWalletConsensusFlowRunnerShadow.maxExitQuoteToMarketRatio, 5);
assert.strictEqual(
  config.smartWalletConsensusFlowRunnerShadow.maxHistoricalExitProceedsMultiple,
  1_000,
);
assert.strictEqual(config.smartWalletRegistry.gradeDirtyRefreshMinMs, 6 * 60 * 60_000);
assert.strictEqual(config.smartWalletRegistry.clusterRefreshMs, 6 * 60 * 60_000);
assert.strictEqual(config.liveTrading.enabled, false);
assert.strictEqual(config.liveTrading.requestedEnabled, false);
assert.strictEqual(config.liveTrading.safetyLock, true);
assert.strictEqual(config.liveTrading.dryRun, true);
assert.strictEqual(config.liveTrading.maxDailySpendSol, undefined);
assert.strictEqual(config.liveTrading.maxDailyTrades, undefined);
assert.strictEqual(config.liveTrading.maxDailyLossSol, undefined);
assert.strictEqual(config.liveTrading.maxConcurrentPositions, 10);
assert.strictEqual(config.liveTrading.maxConcurrentPositionsPerMint, 3);
assert.strictEqual(config.liveTrading.failedEntryCooldownMs, 30_000);
assert.strictEqual(config.liveTrading.failedEntryWindowMs, 5 * 60_000);
assert.strictEqual(config.liveTrading.maxFailedEntriesPerMint, 2);
const liveContinuity = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'migration_continuity_mc_c5_e120_live'
));
const liveContinuityT12 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'migration_continuity_mc_c5_t12_5_live'
));
const liveGfr300 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'migrated_gfr_300_hs20_h30_live'
));
const liveGe30R23F2G2 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'migrated_ge30_r23_f2_only_g2_xleg_live'
));
const liveGe30V2Exec01 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'migrated_ge30_d25_32_r24_f1_exec01_v2_r2_h15_live'
));
const liveGrtF3V2 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'migrated_grt_r23_f3_v2_xleg_live'
));
const liveGd25X8 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'migrated_gd25_35_x8_live'
));
const liveO90 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'graduation_accel_o90_m5_stair120_live'
));
const livePbrA = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'big_winner_pbr_a_x50_15_live'
));
const liveGraduationAccel = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'graduation_accel_o_c80_d5_b2_s0_nc_live'
));
const liveCobD = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'cya_organic_burst_cob_d_fix30_live'
));
const liveCobF = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'cya_organic_burst_cob_f_core25_runner_live'
));
const liveGraduationRecovery = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'graduation_accel_o_c80_ho500_x60_recovery_live'
));
const liveGraduationHandoff = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'graduation_accel_o_c80_ho500_x60_live'
));
const liveGraduationP500 = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'graduation_accel_o_c80_p500_stair240_live'
));
const liveQualityLeader = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'quality_leader_ql_strict_protected_live'
));
const liveQualityLeaderGuard = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'quality_leader_ql_strict_guard_protected_live'
));
const liveLaunchPullback = config.liveTrading.strategies.find((strategy) => (
  strategy.id === 'launch_pullback_fo_rb10_30s_live'
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
assert.strictEqual(livePbrA.entryEnabled, false);
assert.strictEqual(livePbrA.positionSizeSol, 0.1);
assert.strictEqual(livePbrA.ruleVersion, 'big_winner_pbr_a_x50_15_live_v2');
assert.strictEqual(livePbrA.exitMode, 'PBR_CORE_RUNNER');
assert.strictEqual(liveGfr300.entryEnabled, false);
assert.strictEqual(liveGfr300.positionSizeSol, 0.1);
assert.strictEqual(liveGfr300.exitMode, 'TAIL');
assert.strictEqual(liveGfr300.hardStopPct, 20);
assert.strictEqual(liveGfr300.maxHoldMs, 30_000);
assert.strictEqual(liveContinuityT12.entryEnabled, false);
assert.strictEqual(liveContinuityT12.positionSizeSol, 0.5);
assert.strictEqual(liveContinuityT12.exitMode, 'TRAILING');
assert.strictEqual(liveContinuityT12.minHoldMs, 10_000);
assert.strictEqual(liveContinuityT12.trailingActivationPct, 15);
assert.strictEqual(liveContinuityT12.trailingStopPct, 12.5);
assert.strictEqual(liveO90.entryEnabled, true);
assert.strictEqual(liveO90.positionSizeSol, 0.1);
assert.strictEqual(liveO90.postMigrationGate.windowMs, 5_000);
assert.strictEqual(liveO90.postMigrationGate.minBuyers, 25);
assert.strictEqual(liveQualityLeader.positionSizeSol, 0.1);
assert.strictEqual(liveQualityLeader.entryEnabled, false);
assert.strictEqual(liveQualityLeader.code, 'QL-STRICT-PR');
assert.strictEqual(liveQualityLeader.market, 'PUMP_BONDING_CURVE');
assert.strictEqual(liveQualityLeader.exitMode, 'QUALITY_PROTECTED_RUNNER');
assert.strictEqual(liveQualityLeader.hardStopPct, 20);
assert.strictEqual(liveQualityLeader.noStrengthMs, 30_000);
assert.strictEqual(liveQualityLeader.maxHoldMs, 300_000);
assert.strictEqual(liveQualityLeader.protectedFloors.length, 4);
assert.strictEqual(liveQualityLeader.maxEntryPriceJumpPct, 10);
assert.strictEqual(liveQualityLeader.maxShadowEntryImpactPct, 12);
assert.strictEqual(liveQualityLeaderGuard.entryEnabled, true);
assert.strictEqual(liveQualityLeaderGuard.positionSizeSol, 0.1);
assert.strictEqual(liveQualityLeaderGuard.code, 'QL-STRICT-GUARD');
assert.strictEqual(liveQualityLeaderGuard.market, 'PUMP_BONDING_CURVE');
assert.strictEqual(liveQualityLeaderGuard.exitMode, 'QUALITY_PROTECTED_RUNNER');
assert.strictEqual(liveQualityLeaderGuard.qualityCriteria.requireHealthyRugRisk, true);
assert.strictEqual(liveQualityLeaderGuard.sourceShadowCohortId, 'QL_STRICT_GUARD:QL_PROTECTED');
assert.strictEqual(liveGe30R23F2G2.entryEnabled, true);
assert.strictEqual(liveGe30R23F2G2.positionSizeSol, 0.1);
assert.strictEqual(liveGe30R23F2G2.code, 'POST-GE30-R23-F2-G2-XLEG');
assert.strictEqual(liveGe30R23F2G2.exitMode, 'LEGACY');
assert.strictEqual(liveGe30R23F2G2.sourceShadowCohortId, 'POST_GE30_R23_F2_ONLY_G2_XLEG');
assert.strictEqual(liveGe30R23F2G2.entryBeijingStartHour, 4);
assert.strictEqual(liveGe30R23F2G2.entryBeijingEndHour, 24);
assert.strictEqual(liveGe30R23F2G2.entryQuoteRefreshRetryCount, 1);
assert.strictEqual(liveGe30R23F2G2.entryQuoteRefreshMaxSignalAgeMs, 2_500);
assert.strictEqual(liveGrtF3V2.entryEnabled, true);
assert.strictEqual(liveGrtF3V2.maxEntriesPerMint, 1);
assert.strictEqual(liveGe30V2Exec01.entryEnabled, false);
assert.strictEqual(liveGe30V2Exec01.positionSizeSol, 0.1);
assert.strictEqual(liveGe30V2Exec01.code, 'G-V2-EXEC01-R2-H15');
assert.strictEqual(liveGe30V2Exec01.market, 'PUMP_AMM');
assert.strictEqual(liveGe30V2Exec01.exitMode, 'RISK_XLEG');
assert.strictEqual(liveGe30V2Exec01.hardStopPct, 15);
assert.strictEqual(liveGe30V2Exec01.lossCheckAtMs, 2_000);
assert.strictEqual(liveGe30V2Exec01.lossCheckRecoveryPct, 1);
assert.strictEqual(
  liveGe30V2Exec01.sourceShadowCohortId,
  'POST_GE30_D25_32_R24_F1_EXEC1_V2_R2_H15_0_1SOL',
);
assert.strictEqual(liveGd25X8.entryEnabled, true);
assert.strictEqual(liveGd25X8.positionSizeSol, 0.1);
assert.strictEqual(liveGd25X8.code, 'POST-GD25-35-X8');
assert.strictEqual(liveGd25X8.exitMode, 'FIXED_HOLD');
assert.strictEqual(liveGd25X8.fixedHoldMs, 8_000);
assert.strictEqual(liveLaunchPullback.positionSizeSol, 0.1);
assert.strictEqual(liveLaunchPullback.entryEnabled, false);
assert.strictEqual(liveLaunchPullback.code, 'F-FO-RB10-X30');
assert.strictEqual(liveLaunchPullback.market, 'PUMP_BONDING_CURVE');
assert.strictEqual(liveLaunchPullback.exitMode, 'FIXED_HOLD');
assert.strictEqual(liveLaunchPullback.fixedHoldMs, 30_000);
assert.strictEqual(liveLaunchPullback.sourceShadowCohortId, 'FO_RB10_30S');
assert.strictEqual(liveGraduationAccel.positionSizeSol, 0.1);
assert.strictEqual(liveGraduationAccel.entryEnabled, true);
assert.strictEqual(liveGraduationAccel.code, 'O-C80-D5-B2-S0-NC');
assert.strictEqual(liveGraduationAccel.ruleVersion, 'graduation_accel_o_c80_d5_b2_s0_nc_live_v4');
assert.strictEqual(liveGraduationAccel.market, 'PUMP_BONDING_CURVE');
assert.strictEqual(liveGraduationAccel.maxEntrySelfImpactPct, 10);
assert.strictEqual(liveGraduationAccel.exitMode, 'GRADUATION_CORE_RUNNER');
assert.strictEqual(liveGraduationAccel.coreExitPct, 50);
assert.strictEqual(liveCobF.enabled, true);
assert.strictEqual(liveCobF.entryEnabled, false);
assert.strictEqual(liveCobF.positionSizeSol, 0.1);
assert.strictEqual(liveCobF.market, 'PUMP_BONDING_CURVE');
assert.strictEqual(liveCobF.code, 'COB-F-C25-R75-X120');
assert.strictEqual(liveCobF.ruleVersion, 'cya_organic_burst_cob_f_core25_runner_live_v1');
assert.strictEqual(liveCobF.exitMode, 'CORE_RUNNER');
assert.strictEqual(liveCobF.coreActivationPct, 20);
assert.strictEqual(liveCobF.coreExitPct, 25);
assert.strictEqual(liveCobF.trailingActivationPct, 20);
assert.strictEqual(liveCobF.baseTrailingDrawdownPct, 15);
assert.deepStrictEqual(liveCobF.trailingTiers, [
  { activationPct: 50, drawdownPct: 20 },
  { activationPct: 100, drawdownPct: 25 },
]);
assert.strictEqual(liveCobF.hardStopPct, 0);
assert.strictEqual(liveCobF.maxHoldMs, 120_000);
assert.strictEqual(liveCobF.sourceShadowCohortId, 'COB_F_CORE25_R75_X120');
assert.strictEqual(liveCobD.enabled, true);
assert.strictEqual(liveCobD.entryEnabled, false);
assert.strictEqual(liveCobD.positionSizeSol, 0.1);
assert.strictEqual(liveCobD.market, 'PUMP_BONDING_CURVE');
assert.strictEqual(liveCobD.code, 'COB-D-T30-D10-X60');
assert.strictEqual(liveCobD.ruleVersion, 'cya_organic_burst_cob_d_fast_tp_trailing_live_v3');
assert.strictEqual(liveCobD.exitMode, 'TRAILING');
assert.strictEqual(liveCobD.fastTakeProfitPct, 10);
assert.strictEqual(liveCobD.fastTakeProfitWindowMs, 2_000);
assert.strictEqual(liveCobD.trailingActivationPct, 30);
assert.strictEqual(liveCobD.trailingStopPct, 10);
assert.strictEqual(liveCobD.hardStopPct, 20);
assert.strictEqual(liveCobD.maxHoldMs, 60_000);
assert.strictEqual(liveCobD.sourceShadowCohortId, 'COB_D_T30_10_X60');
assert.strictEqual(config.cyaOrganicBurstShadow.enabled, true);
assert.ok(config.cyaOrganicBurstShadow.entryProfiles
  .filter((profile) => ['COB_D', 'COB_F'].includes(profile.id))
  .every((profile) => profile.newEntriesEnabled === true));
assert.deepStrictEqual(
  config.cyaOrganicBurstShadow.entryProfiles
    .filter((profile) => ['COB_D', 'COB_F'].includes(profile.id))
    .map((profile) => [profile.id, profile.exitProfileIds]),
  [
    ['COB_F', ['FIX30', 'CORE25_R75_X120']],
    ['COB_D', ['FIX30', 'CORE25_R75_X120']],
  ],
);
const cobRugPairProfiles = new Map(config.cyaOrganicBurstShadow.entryProfiles
  .filter((profile) => [
    'COB_F_LR01_FIX30', 'COB_F_LR01_FIX30_RUGX',
  ].includes(profile.id))
  .map((profile) => [profile.id, profile]));
assert.strictEqual(cobRugPairProfiles.size, 2);
const cobRugBaseline = cobRugPairProfiles.get('COB_F_LR01_FIX30');
const cobRugFiltered = cobRugPairProfiles.get('COB_F_LR01_FIX30_RUGX');
assert.strictEqual(cobRugBaseline.newEntriesEnabled, true);
assert.strictEqual(cobRugFiltered.newEntriesEnabled, true);
assert.strictEqual(cobRugBaseline.positionSizeSol, 0.1);
assert.strictEqual(cobRugFiltered.positionSizeSol, 0.1);
assert.strictEqual(cobRugBaseline.entryDelayMs, cobRugFiltered.entryDelayMs);
assert.strictEqual(cobRugBaseline.entryTimeoutMs, cobRugFiltered.entryTimeoutMs);
assert.strictEqual(cobRugBaseline.maxEntryPriceJumpPct, cobRugFiltered.maxEntryPriceJumpPct);
assert.strictEqual(cobRugBaseline.maxEntryPriceDropPct, cobRugFiltered.maxEntryPriceDropPct);
assert.strictEqual(cobRugBaseline.maxEntryImpactPct, cobRugFiltered.maxEntryImpactPct);
assert.deepStrictEqual(cobRugBaseline.exitProfileIds, ['FIX30']);
assert.deepStrictEqual(cobRugFiltered.exitProfileIds, ['FIX30']);
assert.strictEqual(cobRugFiltered.pairedBaselineProfileId, 'COB_F_LR01_FIX30');
assert.strictEqual(cobRugFiltered.rugGuardMode, 'LIVE_CURVE_CATASTROPHE');
assert.strictEqual(liveGraduationRecovery.entryEnabled, false);
assert.strictEqual(liveGraduationHandoff.entryEnabled, true);
assert.strictEqual(liveGraduationHandoff.positionSizeSol, 0.1);
assert.strictEqual(liveGraduationHandoff.market, 'PUMP_AMM');
assert.strictEqual(liveGraduationHandoff.sourceShadowCohortId, 'O_C80_HO500_X60:0_1SOL');
assert.strictEqual(liveGraduationHandoff.fixedHoldMs, 60_000);
assert.strictEqual(liveGraduationHandoff.maxHoldMs, 60_000);
assert.strictEqual(liveGraduationHandoff.hardStopPct, 30);
assert.strictEqual(liveGraduationHandoff.exitMode, 'FIXED_HOLD');
assert.strictEqual(liveGraduationHandoff.maxEntriesPerMint, 1);
assert.strictEqual(liveGraduationHandoff.requireChainTimestamp, true);
assert.strictEqual(liveGraduationHandoff.requireEntrySlot, true);
assert.strictEqual(liveGraduationHandoff.requireSignalPool, true);
assert.strictEqual(liveGraduationRecovery.positionSizeSol, 0.1);
assert.strictEqual(liveGraduationRecovery.market, 'PUMP_AMM');
assert.strictEqual(liveGraduationRecovery.exitMode, 'FIXED_HOLD');
assert.strictEqual(liveGraduationRecovery.fixedHoldMs, 60_000);
assert.strictEqual(liveGraduationRecovery.sourceShadowCohortId, 'O_C80_HO500_X60:1SOL');
assert.strictEqual(liveGraduationP500.entryEnabled, false);
assert.strictEqual(liveGraduationP500.positionSizeSol, 0.1);
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
assert.strictEqual(config.liveTrading.emergencySellSlippagePct, 100);
assert.strictEqual(config.liveTrading.emergencyPriorityFeeSol, 0.002);
assert.strictEqual(config.liveTrading.emergencyPriorityFeeMicroLamports, 8_000_000);
assert.strictEqual(config.liveTrading.emergencyExitRetryDelayMs, 100);
assert.strictEqual(config.liveTrading.entryReconcileCount, 5);
assert.strictEqual(config.liveTrading.expiredEntryReleaseMs, 10 * 60_000);
assert.strictEqual(config.liveTrading.readCommitment, 'processed');
assert.strictEqual(config.liveTrading.confirmationCommitment, 'confirmed');
assert.strictEqual(config.liveTrading.contextSlotRetryCount, 6);
assert.strictEqual(config.liveTrading.contextSlotRetryDelayMs, 50);
assert.deepStrictEqual(
  config.liveTrading.strategies.filter((strategy) => strategy.entryEnabled !== false)
    .map((strategy) => strategy.code),
  [
    'POST-GE30-R23-F2-G2-XLEG',
    'GRT-R23-F3-V2-XLEG',
    'POST-GD25-35-X8',
    'O90-M5-STAIR120',
    'QL-STRICT-GUARD',
    'O-C80-D5-B2-S0-NC',
    'O-C80-HO500-X60',
  ],
);
assert.strictEqual(config.preEntryRugRisk.crossMintEnabled, true);
assert.strictEqual(config.preEntryRugRisk.templateMinLargeBuys, 4);
assert.strictEqual(config.preEntryRugRisk.templateMinTotalBuySol, 40);
assert.strictEqual(config.preEntryRugRisk.templateMaxBurstSpanMs, 500);
assert.strictEqual(config.preEntryRugRisk.toxicCollapsePct, 60);
assert.strictEqual(config.preEntryRugRisk.toxicWalletOverlapMin, 2);
assert.strictEqual(config.preEntryRugRisk.extremeDumpabilityEnabled, true);
assert.strictEqual(config.preEntryRugRisk.extremeDumpabilityTop3ObservedSharePct, 70);
assert.strictEqual(config.preEntryRugRisk.extremeDumpabilityTop3RecoveryMaxPct, 20);
assert.strictEqual(config.preEntryRugRisk.toxicWalletRetentionMs, 60 * 86_400_000);
assert.strictEqual(config.preEntryRugRisk.toxicTemplateRetentionMs, 30 * 86_400_000);
assert.strictEqual(config.liveTrading.strategies.find(
  (strategy) => strategy.id === 'migrated_ge30_r23_f2_only_g2_xleg_live',
).hardStopPct, 20);
assert.strictEqual(config.liveTrading.strategies.find(
  (strategy) => strategy.id === 'migrated_ge30_r23_f2_only_g2_xleg_live',
).ruleVersion, 'migrated_ge30_r23_f2_only_g2_xleg_live_v2');
assert.strictEqual(config.liveTrading.strategies.find(
  (strategy) => strategy.id === 'migrated_grt_r23_f3_v2_xleg_live',
).hardStopPct, 20);
assert.strictEqual(config.liveTrading.strategies.find(
  (strategy) => strategy.id === 'migrated_grt_r23_f3_v2_xleg_live',
).ruleVersion, 'migrated_grt_r23_f3_v2_xleg_live_v2');
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
assert.strictEqual(config.smartPullbackShadow.enabled, false);
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
assert.strictEqual(config.flowSmartConfirmShadow.enabled, false);
assert.strictEqual(config.flowSmartConfirmShadow.positionSizeSol, 1);
assert.deepStrictEqual(
  config.flowSmartConfirmShadow.cohorts.map((cohort) => [cohort.id, cohort.maxConfirmationDelayMs]),
  [['L5_F5', 5_000], ['L15_F5', 15_000], ['L5_T15', 5_000], ['L15_T20', 15_000]],
);
assert.strictEqual(config.smartResonanceShadow.enabled, false);
assert.strictEqual(config.smartLikeEarlyShadow.enabled, false);
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
    ['SR_R3_GUARD', 2, 60_000],
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
assert.strictEqual(config.smartWalletFirstOpenRightTailShadow.enabled, false);
assert.strictEqual(config.publicFlowLeadShadow.enabled, false);
assert.strictEqual(config.publicFlowLeadShadow.simulatePositions, false);
assert.strictEqual(config.publicFlowLeadShadow.positionSizeSol, 1);
assert.strictEqual(config.publicFlowLeadShadow.smartLabelWindowMs, 15_000);
assert.deepStrictEqual(
  config.publicFlowLeadShadow.entryProfiles.map((profile) => profile.id),
  ['PFL_S50_R8', 'PFL_B70_R10'],
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
const [pflStrict, pflBalanced] = config.publicFlowLeadShadow.entryProfiles;
assert.deepStrictEqual([
  pflStrict.minAgeMs, pflStrict.maxAgeMs,
  pflStrict.minPublicBuyers1s, pflStrict.minPublicBuyers5s,
  pflStrict.minPublicBuyFlow1sSol, pflStrict.minPublicBuyFlow5sSol,
  pflStrict.minPublicNetFlow5sSol, pflStrict.maxLargestBuyerSharePct,
  pflStrict.maxReturn5sPct, pflStrict.maxPreReturnPct,
  pflStrict.maxPreConsecutiveBuys, pflStrict.requirePreRiskSampleReady,
], [3_000, 45_000, 2, 6, 0.5, 2, 1, 35, 30, 50, 8, true]);
assert.deepStrictEqual([
  pflBalanced.minAgeMs, pflBalanced.maxAgeMs,
  pflBalanced.minPublicBuyers1s, pflBalanced.minPublicBuyers5s,
  pflBalanced.minPublicBuyFlow1sSol, pflBalanced.minPublicBuyFlow5sSol,
  pflBalanced.minPublicNetFlow5sSol, pflBalanced.maxLargestBuyerSharePct,
  pflBalanced.maxReturn5sPct, pflBalanced.maxPreReturnPct,
  pflBalanced.maxPreConsecutiveBuys, pflBalanced.requirePreRiskSampleReady,
], [3_000, 60_000, 1, 4, 0.25, 1, 0.5, 45, 40, 70, 10, true]);
assert.strictEqual(config.launchPullbackShadow.enabled, false);
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
const retiredLaunchCohorts = new Set(config.launchPullbackShadow.retiredCohortIds);
assert.ok([
  'F1_3S', 'FT_C', 'FD12_5_R5_5S', 'FO_RB10_30S',
  'F2_8S_NF30', 'F_REACCEL0_8S',
].every((id) => retiredLaunchCohorts.has(id)));
assert.ok([
  'F2_NF30_H20_60S', 'F2_NF30_H20_120S', 'F2_NF30_H20_120S_EXEC1',
].every((id) => !retiredLaunchCohorts.has(id)));
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
    'F2_NF30_H20_120S_EXEC1',
    'F_ABSORB3_8S', 'F_ABSORB5_RUNNER', 'F_REACCEL0_8S',
  ],
);
const launchExec1 = config.launchPullbackShadow.optimizationCohorts
  .find((cohort) => cohort.id === 'F2_NF30_H20_120S_EXEC1');
assert.strictEqual(launchExec1.positionSizeSol, 1);
assert.strictEqual(launchExec1.requireExecutableCapacity, true);
assert.strictEqual(
  config.launchPullbackShadow.optimizationCohorts
    .find((cohort) => cohort.id === 'FO_D12_R3_Q_10S').maxNetFlowSol,
  50,
);
assert.strictEqual(
  config.launchPullbackShadow.optimizationCohorts[0].maxEntryPriceJumpPct,
  3,
);
assert.strictEqual(
  config.launchPullbackShadow.optimizationCohorts
    .find((cohort) => cohort.id === 'FO_RB10_30S').liveStrategyId,
  'launch_pullback_fo_rb10_30s_live',
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
assert.strictEqual(config.launchQualityObserver.enabled, false);
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
    ['GD25_35_RUG_GUARD_ALL', null, 1],
    ['GD25_35_RUG_GUARD_T20_24', null, 1],
    ['GE30_R23_F1', 30_000, 1],
    ['GE30_R23_F3', 30_000, 3],
    ['GE30_R23_F1_EXEC', 30_000, 1],
    ['GE30_R23_F1_XQ', 30_000, 1],
    ['GE30_R23_F2_ONLY', 30_000, 2],
    ['GRT_R23_F3_V2', 30_000, 3],
    ['GRT_R23_F2_ONLY_V2', 30_000, 2],
    ['GE30_R23_F3_EXEC', 30_000, 3],
    ['GE30_R23_F2_ONLY_EXEC', 30_000, 2],
    ['GE30_R23_F1_NIGHT', 30_000, 1],
    ['GE30_R23_F1_DAY', 30_000, 1],
    ['GE30_D25_32_R24_F1', 30_000, 1],
    ['GE30_D25_32_R24_F1_EXEC1', 30_000, 1],
    ['GE30_D25_32_R24_F1_04_24', 30_000, 1],
    ['GE30_D25_32_R23_F1_FAST200', 30_000, 1],
    ['GE30_DUMP5_NB2_M2', 30_000, 2],
    ['GFR_300', 30_000, 1],
    ['GFR_600', 30_000, 1],
    ['GFR_1000', 30_000, 1],
  ],
);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F1_EXEC').positionSols,
  [0.05, 0.1, 0.25, 0.5, 1],
);
const v2ExecutableProfile = config.migratedDropReboundShadow.entryProfiles
  .find((profile) => profile.id === 'GE30_D25_32_R24_F1_EXEC1');
assert.deepStrictEqual(v2ExecutableProfile.positionSols, [0.1, 1]);
assert.deepStrictEqual(v2ExecutableProfile.exitProfileIds, ['V2_R2_H15']);
assert.strictEqual(v2ExecutableProfile.livePositionSol, 0.1);
assert.deepStrictEqual(v2ExecutableProfile.liveExitStrategies, {
  V2_R2_H15: 'migrated_ge30_d25_32_r24_f1_exec01_v2_r2_h15_live',
});
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F2_ONLY').exitProfileIds,
  ['G2_XLEG', 'G2_XLEG_H20_FWD'],
);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F1_NIGHT').beijingHourRanges,
  [[0, 8], [18, 24]],
);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.exitProfiles.map((profile) => profile.id),
  [
    'G_DUMP_NB_X8', 'X3', 'X8', 'XLEG',
    'GEXEC_XLEG', 'G2_XLEG', 'GRT_F3_XLEG_V2', 'GRT_F2_XLEG_V2',
    'G3EXEC_XLEG', 'G2EXEC_XLEG', 'GTIME_XLEG',
    'G2_XLEG_H20_FWD', 'GRT_F3_XLEG_H20_FWD', 'GQ_XLEG',
    'G1XQ_X8', 'G1XQ_X30', 'G1XQ_X60',
    'GFR_X8', 'GFR_X15', 'GFR_HS20_H30',
    'G1_E2_H6', 'G1_E2_H8', 'G1_E3_H8',
    'G1_B75_H30', 'G1_B50_H60',
    'G1_STAIR_H60', 'G1_STAIR_H120',
    'XB50', 'XB25',
    'V2_R2_H10', 'V2_R2_H15', 'V2_TIME_R2_H15', 'V2_B75_H20', 'V2_B75_H60',
    'XR3_H12', 'XR3_H15', 'XR4_H12', 'XR4_H15',
  ],
);
assert.ok(config.migratedDropReboundShadow.exitProfiles
  .filter((profile) => profile.id.startsWith('XB') || profile.id.startsWith('XR'))
  .every((profile) => profile.entryProfileIds.join(',') === 'GD25_35'));
assert.ok(config.migratedDropReboundShadow.exitProfiles
  .filter((profile) => ['V2_R2_H10', 'V2_B75_H20', 'V2_B75_H60']
    .includes(profile.id))
  .every((profile) => profile.entryProfileIds.join(',') === 'GE30_D25_32_R24_F1'));
assert.deepStrictEqual(
  config.migratedDropReboundShadow.exitProfiles
    .find((profile) => profile.id === 'V2_R2_H15').entryProfileIds,
  ['GE30_D25_32_R24_F1', 'GE30_D25_32_R24_F1_EXEC1'],
);
const g2HardStopForward = config.migratedDropReboundShadow.exitProfiles
  .find((profile) => profile.id === 'G2_XLEG_H20_FWD');
assert.deepStrictEqual(g2HardStopForward.entryProfileIds, ['GE30_R23_F2_ONLY']);
assert.strictEqual(g2HardStopForward.exitMode, 'RISK_XLEG');
assert.strictEqual(g2HardStopForward.hardStopPct, 20);
assert.strictEqual(g2HardStopForward.lossCheckRecoveryPct, 1);
const v2TimeProfile = config.migratedDropReboundShadow.entryProfiles
  .find((profile) => profile.id === 'GE30_D25_32_R24_F1_04_24');
assert.deepStrictEqual(v2TimeProfile.beijingHourRanges, [[4, 24]]);
assert.deepStrictEqual(v2TimeProfile.positionSols, [0.1, 0.5, 1]);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.exitProfiles
    .find((profile) => profile.id === 'V2_TIME_R2_H15').entryProfileIds,
  ['GE30_D25_32_R24_F1_04_24'],
);
const gqProfile = config.migratedDropReboundShadow.entryProfiles
  .find((profile) => profile.id === 'GE30_D25_32_R23_F1_FAST200');
assert.strictEqual(gqProfile.maxReboundFromLowMs, 200);
assert.deepStrictEqual(gqProfile.positionSols, [0.05, 0.25, 0.5, 1]);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F3_EXEC').positionSols,
  [0.05, 0.1, 0.25, 0.5, 1],
);
const gfrProfiles = config.migratedDropReboundShadow.entryProfiles
  .filter((profile) => profile.id.startsWith('GFR_'));
assert.strictEqual(config.migratedDropReboundShadow.gfrEnabled, true);
assert.strictEqual(config.migratedDropReboundShadow.fastFlowMaxTradesPerMint, 512);
assert.strictEqual(config.migratedDropReboundShadow.fastFlowSweepMs, 5_000);
assert.strictEqual(config.migratedDropReboundShadow.maxPlausibleReturnPct, 1_000);
assert.ok([
  'POST_GD25_35_RUG_GUARD_T20_24_',
  'POST_GD25_35_X3',
  'POST_GD25_35_XLEG',
  'POST_GD25_35_XB25',
  'POST_GD25_35_XB50',
  'POST_GE30_R23_F1_',
  'POST_GE30_R23_F3_',
  'POST_GE30_R23_F1_G1_B50_H60',
  'POST_GE30_R23_F1_G1_B75_H30',
  'POST_GE30_D25_32_R24_F1_04_24_V2_TIME_R2_H15',
].every((prefix) => config.migratedDropReboundShadow.retiredCohortPrefixes.includes(prefix)));
assert.ok(!config.migratedDropReboundShadow.retiredCohortPrefixes.includes('POST_GD25_35_X8'));
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GD25_35').liveExitStrategies,
  { X8: 'migrated_gd25_35_x8_live' },
);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F2_ONLY').liveExitStrategies,
  { G2_XLEG: 'migrated_ge30_r23_f2_only_g2_xleg_live' },
);
assert.deepStrictEqual(
  gfrProfiles.map((profile) => [
    profile.id,
    profile.fastConfirmation.confirmationMs,
    profile.fastConfirmation.maxRoundTripImpactPct,
  ]),
  [
    ['GFR_300', 300, 5],
    ['GFR_600', 600, 5],
    ['GFR_1000', 1_000, 5],
  ],
);
assert.ok(gfrProfiles.every((profile) => (
  profile.fastConfirmation.minBuyTx === 2
  && profile.fastConfirmation.minUniqueBuyers === 2
  && profile.fastConfirmation.minNetFlowSol === 0.5
  && profile.fastConfirmation.maxTopBuyerSharePct === 60
  && profile.positionSols.join(',') === '0.05,0.1'
)));
assert.strictEqual(config.bigWinnerShadow.transientUpPriceRatio, 2);
assert.strictEqual(config.bigWinnerShadow.enabled, false);
assert.strictEqual(config.bigWinnerShadow.priceConfirmationWindowMs, 500);
assert.strictEqual(config.bigWinnerShadow.priceConfirmationMinPersistenceMs, 150);
assert.strictEqual(config.bigWinnerShadow.priceConfirmationTolerancePct, 25);
assert.strictEqual(config.bigWinnerShadow.priceConfirmationMinWallets, 2);
const bigWinnerEntryProfiles = new Map(config.bigWinnerShadow.entryProfiles.map((profile) => (
  [profile.id, profile]
)));
assert.deepStrictEqual(
  config.bigWinnerShadow.entryProfiles.filter((profile) => profile.family === 'PARTICIPATION')
    .map((profile) => profile.id),
  [
    'PP_DIRECT_10', 'PP_PULLBACK_8_20', 'PP_PULLBACK_8_30',
    'PP_PULLBACK_8_30_NF8_3',
    'PP20_B45', 'PP20_EARLY_BREADTH', 'PP20_QUALITY',
  ],
);
assert.ok([
  'PBR_B', 'PBR_C', 'FLOW_R',
  'PP_DIRECT_10', 'PP_PULLBACK_8_20', 'PP_PULLBACK_8_30',
].every((id) => bigWinnerEntryProfiles.get(id)?.newEntriesEnabled === false));
assert.strictEqual(bigWinnerEntryProfiles.get('PBR_B_RT_V2').newEntriesEnabled, true);
assert.deepStrictEqual(
  bigWinnerEntryProfiles.get('PBR_B_RT_V2').exitProfileIds,
  ['X50_12', 'X50_RATCHET'],
);
assert.strictEqual(bigWinnerEntryProfiles.get('PBR_A').newEntriesEnabled, false);
assert.strictEqual(bigWinnerEntryProfiles.get('PBR_A_B10_PB20').newEntriesEnabled, false);
assert.strictEqual(bigWinnerEntryProfiles.get('PBR_A_B10_PB20').minBuyers3s, 10);
assert.strictEqual(bigWinnerEntryProfiles.get('PBR_A_B10_PB20').maxPullbackPct, 20);
assert.deepStrictEqual(
  bigWinnerEntryProfiles.get('PBR_A_B10_PB20').exitProfileIds,
  ['X50_15'],
);
assert.strictEqual(
  bigWinnerEntryProfiles.get('PBR_A').liveStrategyId,
  'big_winner_pbr_a_x50_15_live',
);
assert.deepStrictEqual(
  ['PP20_B45', 'PP20_EARLY_BREADTH', 'PP20_QUALITY'].map((id) => (
    bigWinnerEntryProfiles.get(id)?.newEntriesEnabled
  )),
  [false, false, false],
);
assert.strictEqual(bigWinnerEntryProfiles.get('PP20_B45').minBuyers10s, 45);
assert.strictEqual(bigWinnerEntryProfiles.get('PP20_EARLY_BREADTH').maxAgeMs, 25_000);
assert.strictEqual(bigWinnerEntryProfiles.get('PP20_EARLY_BREADTH').minBuyers3s, 15);
assert.strictEqual(bigWinnerEntryProfiles.get('PP20_QUALITY').maxSingleSell3sSol, 2.5);
assert.strictEqual(bigWinnerEntryProfiles.get('PP_PULLBACK_8_30_NF8_3').minNetFlow8sSol, 3);
assert.deepStrictEqual(
  bigWinnerEntryProfiles.get('PP_PULLBACK_8_30_NF8_3').positionSols,
  [0.1, 0.25],
);
assert.ok(['PP20_B45', 'PP20_EARLY_BREADTH', 'PP20_QUALITY'].every((id) => (
  bigWinnerEntryProfiles.get(id).positionSols.join(',') === '0.05,0.1,0.25'
)));
assert.deepStrictEqual(
  config.bigWinnerShadow.exitProfiles.find((profile) => profile.id === 'X25_RATCHET_PP')
    .entryProfileIds,
  [
    'PP_DIRECT_10', 'PP_PULLBACK_8_20', 'PP_PULLBACK_8_30',
    'PP_PULLBACK_8_30_NF8_3',
    'PP20_B45', 'PP20_EARLY_BREADTH', 'PP20_QUALITY',
  ],
);
assert.strictEqual(config.migrationContinuityShadow.enabled, false);
assert.strictEqual(config.migrationContinuityShadow.positionSizeSol, 1);
assert.deepStrictEqual(config.migrationContinuityShadow.entryProfile, {
  id: 'MC_C5', label: 'MC-C · 毕业后5秒质量延续',
  liveStrategyId: 'migration_continuity_mc_c5_t12_5_live',
  minBuyers: 20, minNetFlowSol: 5, minReturnPct: 5, maxSellBuyRatio: 0.6,
});
assert.strictEqual(config.sameSlotDumpBackrunShadow.enabled, false);
assert.strictEqual(config.sameSlotDumpBackrunShadow.retired, true);
const csfProfiles = new Map(config.cyaSlotFlowShadow.entryProfiles.map((profile) => (
  [profile.id, profile]
)));
assert.strictEqual(config.cyaSlotFlowShadow.enabled, false);
assert.ok(['CSF_C03', 'CSF_E35', 'CSF_E510', 'CSF_S310']
  .every((id) => csfProfiles.get(id)?.newEntriesEnabled === false));
assert.strictEqual(csfProfiles.get('CSF_E510_Q').newEntriesEnabled, true);
assert.deepStrictEqual(csfProfiles.get('CSF_E510_Q').managementProfileIds, ['F20']);
assert.deepStrictEqual(
  config.migrationContinuityShadow.exitProfiles.map((profile) => profile.id),
  [
    'E60', 'E120', 'E120_GUARD_V2', 'T10', 'T12_5', 'E120_CONVERGED_V3',
    'FLOW', 'RUNNER', 'AH60_180',
  ],
);
assert.strictEqual(config.migratedDropReboundShadow.observationAgeMs, 30 * 60_000);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_DUMP5_NB2_M2'),
  {
    id: 'GE30_DUMP5_NB2_M2',
    label: 'G-DUMP-NB · 毕业后30秒内 · >=5 SOL砸单 · 2秒内下一笔真实买单 · 每Mint最多2次',
    newEntriesEnabled: true,
    signalMode: 'DUMP_NEXT_BUY',
    windowMs: 1_000,
    dropMinPct: 15,
    dropMaxPct: 55,
    minDumpSol: 5,
    nextBuyWindowMs: 2_000,
    reboundMinPct: 0,
    reboundMaxPct: 1_000,
    reboundTimeoutMs: 2_000,
    maxLifecycleAgeMs: 30_000,
    maxSignalsPerMint: 2,
    reentryCooldownMs: 2_000,
    maxEntryPriceJumpPct: 15,
    exitProfileIds: ['G_DUMP_NB_X8'],
    capacityAware: true,
    positionSols: [1],
    rugGuardMode: 'LABEL_ONLY',
  },
);
const migrationExitProfiles = new Map(config.migrationContinuityShadow.exitProfiles
  .map((profile) => [profile.id, profile]));
assert.ok(['E60', 'E120', 'E120_GUARD_V2', 'T10', 'FLOW', 'RUNNER', 'AH60_180']
  .every((id) => migrationExitProfiles.get(id)?.newEntriesEnabled === false));
assert.strictEqual(migrationExitProfiles.get('T12_5')?.newEntriesEnabled, false);
assert.strictEqual(migrationExitProfiles.get('E120_CONVERGED_V3')?.newEntriesEnabled, true);
assert.strictEqual(
  config.postMigrationSurvivorObserver.shadowFullHoldMatrixEnabled,
  false,
);
assert.deepStrictEqual(config.postMigrationSurvivorObserver.shadowHoldMs, [30_000]);
assert.strictEqual(config.holderGrowthShadow.enabled, false);
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
  undefined,
);
assert.strictEqual(
  config.qualityLeaderShadow.entryProfiles.find((profile) => profile.id === 'QL_STRICT_GUARD')
    .liveStrategyId,
  'quality_leader_ql_strict_guard_protected_live',
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
assert.deepStrictEqual(config.graduationAccelerationShadow.capacitySols, [1]);
assert.deepStrictEqual(
  config.graduationAccelerationShadow.entryProfiles.map((profile) => profile.id),
  [
    'O_FAST10_C80_B20_R07', 'O_C80_D5_B2_S0_NC',
    'O_C80_D5_B2_S0_NC_H15', 'O_C80_D5_B2_S0_NC_H20',
    'O_C75_D5_B2_S0_NC_EARLY', 'O_C78_D5_B2_S0_NC_EARLY',
    'O_C80_M5_HANDOFF_X60',
    'O_C80_LIVE_MIG_X20', 'O_C80_LIVE_MIG_X30',
    'O_C80_P500_STAIR240', 'O_C80_P1000_X60',
    'O_C80_P1000_X120', 'O_C80_P1000_STAIR240',
    'O_C80_P500_STAIR240_RUGX',
    'O90_M5_X60', 'O90_M5_X120', 'O90_M5_STAIR120',
    'O90_Q70_D30_X60', 'O90_Q70_D30_STAIR120',
    'O90_DAY0818_STAIR120', 'O_C80_DAY1218_STAIR240',
    'O_C80_NIGHT0004_STAIR240', 'O_C80_EVENING2024_STAIR240',
    'O_C80_HO0_X60', 'O_C80_HO0_X120',
    'O_C80_HO200_X60', 'O_C80_HO200_X120',
    'O_C80_HO500_X60', 'O_C80_HO500_X60_RUGX', 'O_C80_HO500_X120',
    'O_C80_HO500_X60_DAY0420', 'O_C80_HO500_X60_OFF2004',
    'O_C80_J40_50_X60', 'O_C80_J40_50_X120',
    'O_C80_J50_60_X60', 'O_C80_J50_60_X120',
    'O_C80_J60_70_X60', 'O_C80_J60_70_X120',
  ],
);
const graduationHandoffRugPair = config.graduationAccelerationShadow.entryProfiles
  .find((profile) => profile.id === 'O_C80_HO500_X60_RUGX');
assert.strictEqual(graduationHandoffRugPair.pairedBaselineProfileId, 'O_C80_HO500_X60');
assert.strictEqual(graduationHandoffRugPair.rugGuardMode, 'HIGH_CONFIDENCE_CATASTROPHE');
assert.deepStrictEqual(graduationHandoffRugPair.capacitySols, [0.1]);
assert.strictEqual(graduationHandoffRugPair.handoffLiveStrategyId, null);
assert.strictEqual(config.graduationAccelerationShadow.noExitObservationMs, 600_000);
assert.strictEqual(config.migrationSecondLegShadow.noExitObservationMs, 600_000);
const d5StopProfiles = config.graduationAccelerationShadow.entryProfiles
  .filter((profile) => profile.id.startsWith('O_C80_D5_B2_S0_NC_H'));
assert.deepStrictEqual(d5StopProfiles.map((profile) => profile.hardStopPct), [15, 20]);
assert.ok(d5StopProfiles.every((profile) => !profile.liveStrategyId));
const relaxedGraduationProfiles = config.graduationAccelerationShadow.entryProfiles
  .filter((profile) => profile.studyGroup?.startsWith('O_C80_'));
assert.strictEqual(relaxedGraduationProfiles.length, 15);
assert.ok(relaxedGraduationProfiles.every((profile) => (
  !profile.liveStrategyId
  && profile.capacityAwareExit === true
  && JSON.stringify(profile.capacitySols) === JSON.stringify(
    profile.id === 'O_C80_HO500_X60_RUGX' ? [0.1] : [0.1, 1],
  )
)));
assert.strictEqual(relaxedGraduationProfiles
  .filter((profile) => profile.migrationHandoff).length, 9);
assert.strictEqual(relaxedGraduationProfiles
  .filter((profile) => profile.entryPriceJumpBand).length, 6);
const recoveryBridgeProfiles = relaxedGraduationProfiles
  .filter((profile) => profile.handoffLiveStrategyId);
assert.deepStrictEqual(recoveryBridgeProfiles.map((profile) => profile.id), ['O_C80_HO500_X60']);
assert.strictEqual(recoveryBridgeProfiles[0].liveBridgeCapacitySol, 0.1);
assert.strictEqual(recoveryBridgeProfiles[0].handoffLiveStrategyId, liveGraduationHandoff.id);
assert.deepStrictEqual(
  config.migratedDropReboundShadow.entryProfiles
    .find((profile) => profile.id === 'GE30_R23_F3_EXEC').positionSols,
  [0.05, 0.1, 0.25, 0.5, 1],
);
const p500RugPair = config.graduationAccelerationShadow.entryProfiles
  .find((profile) => profile.id === 'O_C80_P500_STAIR240_RUGX');
assert(p500RugPair);
assert.strictEqual(p500RugPair.pairedBaselineProfileId, 'O_C80_P500_STAIR240');
assert.strictEqual(p500RugPair.rugGuardMode, 'LIVE_CURVE_CATASTROPHE');
assert.strictEqual(p500RugPair.liveStrategyId, undefined);
const persistenceGraduationProfiles = config.graduationAccelerationShadow.entryProfiles
  .filter((profile) => profile.id.startsWith('O_C80_P'));
assert.ok(persistenceGraduationProfiles.every((profile) => profile.capacityAwareExit === true));
assert.deepStrictEqual(
  persistenceGraduationProfiles.filter((profile) => profile.liveStrategyId)
    .map((profile) => [profile.id, profile.liveStrategyId]),
  [[
    'O_C80_P500_STAIR240',
    'graduation_accel_o_c80_p500_stair240_live',
  ]],
);
assert.ok(config.graduationAccelerationShadow.entryProfiles
  .filter((profile) => profile.id.startsWith('O90_') || profile.id === 'O_C80_D5_B2_S0_NC')
  .every((profile) => profile.capacityAwareExit === true));
const earlyGraduationProfiles = config.graduationAccelerationShadow.entryProfiles
  .filter((profile) => profile.id.endsWith('_EARLY'));
assert.deepStrictEqual(earlyGraduationProfiles.map((profile) => profile.thresholdPct), [75, 78]);
assert.ok(earlyGraduationProfiles.every((profile) => !profile.liveStrategyId));
const migrationHandoffProfile = config.graduationAccelerationShadow.entryProfiles
  .find((profile) => profile.id === 'O_C80_M5_HANDOFF_X60');
assert.strictEqual(migrationHandoffProfile.migrationHandoff, true);
assert.strictEqual(migrationHandoffProfile.postMigrationEntryGate.minBuyers, 5);
assert.strictEqual(migrationHandoffProfile.liveStrategyId, undefined);
const liveMigrationHandoffProfiles = config.graduationAccelerationShadow.entryProfiles
  .filter((profile) => profile.mode === 'LIVE_MIGRATION_FAILURE');
assert.deepStrictEqual(
  liveMigrationHandoffProfiles.map((profile) => profile.id),
  ['O_C80_LIVE_MIG_X20', 'O_C80_LIVE_MIG_X30'],
);
assert.ok(liveMigrationHandoffProfiles.every((profile) => (
  profile.sourceLiveStrategyId === 'graduation_accel_o_c80_d5_b2_s0_nc_live'
  && profile.capacitySols[0] === 1
  && profile.postMigrationEntryGate.waitForQualification === true
  && !profile.liveStrategyId
)));
assert.strictEqual(config.migrationSecondLegObserver.enabled, true);
assert.strictEqual(config.migrationSecondLegShadow.enabled, true);
assert.strictEqual(config.migrationSecondLegShadow.newEntriesEnabled, true);
assert.strictEqual(config.migrationSecondLegShadow.marketRegime.enabled, false);
assert.strictEqual(config.migrationSecondLegShadow.maxObservedPriceRatio, 100);
assert.deepStrictEqual(
  config.migrationSecondLegShadow.cohorts
    .filter((cohort) => cohort.enabled !== false)
    .map((cohort) => cohort.id),
  [
    'PMO-FLOW-H15-A30-D15-X120', 'PMO-FLOW-H15-A30-D15-X120-RUGX',
    'PMO-FLOW-H20-A50-D20-X300', 'PMO-FLOW-H20-A50-D20-X300-RUGX',
    'PMO-FLOW-H20-A75-D25-X300', 'PMO-FLOW-H20-A75-D25-X300-RUGX',
    'PMO-FLOW-H25-A100-D30-X600', 'PMO-FLOW-H25-A100-D30-X600-RUGX',
  ],
);
assert.ok(config.migrationSecondLegShadow.cohorts
  .filter((cohort) => cohort.enabled !== false)
  .every((cohort) => cohort.positionSizeSol === 0.1 && !cohort.liveStrategyId));
assert.ok(config.migrationSecondLegShadow.cohorts
  .filter((cohort) => cohort.id.startsWith('PMO-FLOW-') && cohort.id.endsWith('-RUGX'))
  .every((cohort) => cohort.rugGuardMode === 'HARD_BLOCK'
    && cohort.hardBlockSignatures.length === 2
    && cohort.hardBlockSignatures.includes('crossMintToxicWallets')
    && cohort.hardBlockSignatures.includes('crossMintToxicTemplate')));
assert.ok(config.migrationSecondLegShadow.cohorts
  .filter((cohort) => cohort.id.startsWith('PMO-FLOW-') && !cohort.id.endsWith('-RUGX'))
  .every((cohort) => cohort.rugGuardMode === 'LABEL_ONLY'));
assert.deepStrictEqual(
  config.migrationSecondLegShadow.cohorts
    .filter((cohort) => cohort.id.startsWith('M2F-SSR-'))
    .map((cohort) => cohort.id),
  [
    'M2F-SSR-CTRL-X60', 'M2F-SSR-MRG-X60', 'M2F-SSR-MRG-X120',
    'M2F-SSR-MRG-R120-H20', 'M2F-SSR-MRG-R240-H20',
  ],
);
assert.ok(config.migrationSecondLegShadow.cohorts
  .filter((cohort) => cohort.id.startsWith('M2F-SSR-'))
  .every((cohort) => !cohort.liveStrategyId));
const o90Gate = config.graduationAccelerationShadow.entryProfiles
  .find((profile) => profile.id === 'O90_M5_X60');
assert.deepStrictEqual(o90Gate.postMigrationGate, {
  windowMs: 5_000, minBuyers: 25, minNetFlowSol: 0,
});
const o90QualityProfiles = config.graduationAccelerationShadow.entryProfiles
  .filter((profile) => profile.id.startsWith('O90_Q70_D30_'));
assert.strictEqual(o90QualityProfiles.length, 2);
assert.ok(o90QualityProfiles.every((profile) => (
  profile.minBuyers === 3
  && profile.minNetFlowSol === 70
  && profile.minCurveDeltaPct === 30
  && profile.capacityAwareExit === true
  && !profile.liveStrategyId
)));
const o90Day = config.graduationAccelerationShadow.entryProfiles
  .find((profile) => profile.id === 'O90_DAY0818_STAIR120');
assert.deepStrictEqual(
  [o90Day.sessionStartHourCst, o90Day.sessionEndHourCst, o90Day.liveStrategyId],
  [8, 18, undefined],
);
assert.deepStrictEqual(
  config.graduationAccelerationShadow.entryProfiles
    .filter((profile) => profile.id.startsWith('O_C80_NIGHT')
      || profile.id.startsWith('O_C80_EVENING'))
    .map((profile) => [
      profile.id, profile.sessionStartHourCst, profile.sessionEndHourCst,
      profile.liveStrategyId,
    ]),
  [
    ['O_C80_NIGHT0004_STAIR240', 0, 4, undefined],
    ['O_C80_EVENING2024_STAIR240', 20, 24, undefined],
  ],
);
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
