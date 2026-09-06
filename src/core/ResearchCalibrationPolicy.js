'use strict';

const { normalizeCostModel } = require('./CostModel');

const CALIBRATION_ID = 'early_pure_buy_burst_eba_fix20_calibration_live';
const EB_VERSION = 'EB_EXEC_POST_TARGET_V1';
const EB_EXIT = 'FIX20_H30_EXEC_V1';
const EB_SOURCE = `EB_A_EXEC_V1:${EB_EXIT}`;
const LEGACY_LIVE_ID = 'legacy_early_flow_rugx_live';
const LEGACY_VERSION = 'LEGACY_EARLY_FLOW_EXEC_V1';
const LEGACY_BASE = 'LEGACY-EARLY-FLOW-BASE';
const LEGACY_RUGX = 'LEGACY-EARLY-FLOW-RUGX';
const LIVE_PRIORITY_FEE_SOL = 0.0001;
const CALIBRATION_MAX_POSITIONS = 3;

function put(rows, value) {
  const index = rows.findIndex((row) => row.id === value.id);
  if (index < 0) rows.push(value);
  else rows[index] = value;
}

// This is a frozen execution-calibration cohort, not a profitability claim.
// Only the current authorized strategy is armed; LIVE/credentials/kill-switch gates
// remain the operator's responsibility. Retirement never deletes definitions.
function applyResearchCalibrationPolicy(config, {
  focusEnabled = true, calibrationEntryEnabled = true,
} = {}) {
  const live = config.liveTrading;
  // User-fixed per-transaction priority fee, including emergency exits and
  // recovered historical positions. Old environment values cannot raise it.
  live.priorityFeeSol = LIVE_PRIORITY_FEE_SOL;
  live.emergencyPriorityFeeSol = LIVE_PRIORITY_FEE_SOL;
  live.maxConcurrentPositions = CALIBRATION_MAX_POSITIONS;
  const costModel = normalizeCostModel({
    platformFeePct: 1.4, buySlippagePct: 0.3, sellSlippagePct: 0.3,
    priceImpactPct: 0, baseTxFeeSol: 0.00001,
    priorityFeeSol: 2 * live.priorityFeeSol,
    jitoTipSol: 0, fixedCostSol: 0, positionSizeSol: 0.02,
  });
  const strictAmm = {
    version: 'POST_POOL_EXEC1_V1', maxTradeAgeMs: 3_000,
    entryDelayMs: 1_000, exitDelayMs: 1_000,
  };
  for (const strategy of live.strategies) {
    // Only legacy EARLY_FLOW RUGX is authorized for this deployment. Keep every historical
    // definition for active-position recovery, but never rearm an old trial
    // through an obsolete environment flag or a formerly dormant default.
    strategy.entryEnabled = false;
  }
  put(live.strategies, {
    id: CALIBRATION_ID, code: 'EB-A-FIX20-CAL02',
    label: 'EB-A · 0.02 SOL 执行校准 / FIX20 + H30 / 非盈利认证',
    ruleVersion: EB_VERSION, signalSource: 'EARLY_PURE_BUY_EBA_EXEC_V1',
    market: 'PUMP_BONDING_CURVE', enabled: true,
    entryEnabled: false, calibrationOnly: true,
    positionSizeSol: 0.02, sourceShadowCohortId: EB_SOURCE,
    maxConcurrentPositions: CALIBRATION_MAX_POSITIONS,
    maxTotalConcurrentPositions: CALIBRATION_MAX_POSITIONS,
    cumulativeAmountLimitSol: null, cumulativeLossLimitSol: null,
    cumulativeTradeLimit: null, stopOnExecutionAnomaly: true,
    maxSignalAgeMs: 2_000, requireChainTimestamp: true,
    requireEntrySlot: true, requireSignalPool: true,
    maxEntryPriceJumpPct: 15, maxEntrySelfImpactPct: 15,
    maxEntriesPerMint: 1, reentryCooldownMs: 0,
    failedEntryCooldownMs: 30_000, maxFailedEntriesPerMint: 2,
    exitMode: 'FIXED_HOLD', fixedHoldMs: 20_000,
    maxHoldMs: 20_000, hardStopPct: 30,
    rugGuardMode: 'LIVE_CURVE_CATASTROPHE',
  });

  const eb = config.earlyPureBuyBurstShadow;
  // Retain CAL02's historical definitions and exits, but retire its live bridge.
  const ebBase = {
    id: 'EB_A_EXEC_V1', label: 'EB-A EXEC V1 · 0.02 SOL / 1秒新行情 / FIX20 H30',
    newEntriesEnabled: true, strictExecution: true, executionVersion: EB_VERSION,
    positionSizeSol: 0.02, entryDelayMs: 1_000, exitDelayMs: 1_000,
    entryTimeoutMs: 15_000, exitTimeoutMs: 15_000, maxQuoteChainAgeMs: 3_000,
    maxEntryPriceJumpPct: 15, maxEntryPriceDropPct: 35, maxEntryImpactPct: 15,
    exitProfileIds: [EB_EXIT], costModel: { ...costModel },
    liveBridgeEnabled: false, liveStrategyId: CALIBRATION_ID,
  };
  put(eb.entryProfiles, ebBase);
  put(eb.entryProfiles, {
    ...ebBase, id: 'EB_A_EXEC_V1_RUGX',
    label: 'EB-A EXEC V1 RUGX · 同源0.02 SOL / 当前严格过滤',
    pairedBaselineProfileId: ebBase.id, rugGuardMode: 'LIVE_CURVE_CATASTROPHE',
    liveBridgeEnabled: false, liveStrategyId: null,
  });
  put(eb.exitProfiles, { id: EB_EXIT, label: 'EXEC V1 · fixed 20s + hard stop 30%',
    maxHoldMs: 20_000, hardStopPct: 30 });

  // Reuse the old public-flow ENTRY only. Exits and post-trade execution are an
  // explicit frozen safety adaptation, not a claim of reproducing old PnL.
  const legacyExit = {
    exitMode: 'TRAILING', hardStopPct: 30, trailingActivationPct: 10,
    trailingStopPct: 5, maxHoldMs: 30 * 60_000, minHoldMs: 0,
  };
  put(live.strategies, {
    id: LEGACY_LIVE_ID, code: LEGACY_RUGX,
    label: 'Legacy Early Flow · 迁移15–25秒资金流 / RUGX / 0.02 SOL',
    ruleVersion: LEGACY_VERSION, signalSource: LEGACY_VERSION,
    market: 'PUMP_AMM', enabled: true, entryEnabled: calibrationEntryEnabled,
    calibrationOnly: true, sourceShadowCohortId: LEGACY_RUGX,
    positionSizeSol: 0.02, maxConcurrentPositions: CALIBRATION_MAX_POSITIONS,
    maxTotalConcurrentPositions: CALIBRATION_MAX_POSITIONS,
    cumulativeAmountLimitSol: null, cumulativeLossLimitSol: null,
    cumulativeTradeLimit: null, stopOnExecutionAnomaly: true,
    maxSignalAgeMs: 2_000, requireChainTimestamp: true,
    requireEntrySlot: true, requireSignalPool: true,
    requirePostTradeQuote: true, maxEntryPriceJumpPct: 15,
    maxEntrySelfImpactPct: 15, maxEntriesPerMint: 1,
    reentryCooldownMs: 0, failedEntryCooldownMs: 30_000, maxFailedEntriesPerMint: 2,
    rugGuardMode: 'HARD_BLOCK', requireRugGuard: true,
    hardBlockSignatures: ['crossMintToxicWallets', 'crossMintToxicTemplate'],
    ...legacyExit,
  });
  const legacySuite = config.migrationSecondLegShadow;
  legacySuite.enabled = true;
  legacySuite.newEntriesEnabled = true;
  legacySuite.solUsdReference = { enabled: true, refreshMs: 60_000, maxAgeMs: 300_000 };
  const legacyBase = {
    id: LEGACY_BASE, label: 'Legacy Early Flow BASE · 同源无RUG过滤 / 0.02 SOL',
    enabled: true, newEntriesEnabled: true, entryMode: 'LEGACY_EARLY_FLOW',
    studyMode: 'LEGACY_EARLY_FLOW', confirmationMode: 'IMMEDIATE',
    executionVersion: LEGACY_VERSION, strictExecution: { ...strictAmm },
    positionSizeSol: 0.02, costModel: { ...costModel },
    entryDelayMs: 1_000, entryTimeoutMs: 3_000,
    exitDelayMs: 1_000, exitTimeoutMs: 30_000,
    maxEntryPriceJumpPct: 15, maxNegativeEntryJumpPct: 35,
    maxEntryImpactPct: 15, maxObservedPriceRatio: 100,
    requireCapacityMetrics: true, rugGuardMode: 'LABEL_ONLY',
    liveBridgeEnabled: false, liveStrategyId: null,
    thresholds: {
      minAgeMs: 15_000, maxAgeMs: 25_000,
      minFdvUsd: 15_000, maxFdvUsd: 100_000,
      minPriceChange10sPct: -10, maxPriceChange10sPct: 8,
      minNetFlow1sSol: 0, minBuyers5s: 3, minTrades5s: 4,
      maxSingleBuyShare5s: 0.7,
    },
    ...legacyExit,
  };
  put(legacySuite.cohorts, legacyBase);
  put(legacySuite.cohorts, {
    ...legacyBase, id: LEGACY_RUGX,
    label: 'Legacy Early Flow RUGX · 同源当前阶段RUG过滤 / 0.02 SOL',
    pairedBaselineCohortId: LEGACY_BASE, rugGuardMode: 'HARD_BLOCK',
    hardBlockSignatures: ['crossMintToxicWallets', 'crossMintToxicTemplate'],
    rugPolicyReason: 'LEGACY_EARLY_FLOW_STAGE_SCOPED_REPEAT_ACTOR',
    liveBridgeEnabled: calibrationEntryEnabled, liveStrategyId: LEGACY_LIVE_ID,
  });

  const gd = config.migratedDropReboundShadow;
  const gdBase = gd.entryProfiles.find((row) => row.id === 'GD25_35');
  if (gdBase) {
    put(gd.entryProfiles, { ...gdBase, id: 'GD25_35_POST_EXEC1_V1',
      label: 'GD25–35 EXEC1 V1 · 0.02 SOL / X8',
      newEntriesEnabled: true, positionSols: [0.02], capacityAware: true,
      strictExecution: { ...strictAmm }, costModel: { ...costModel },
      exitProfileIds: ['X8_POST_EXEC1_V1'], liveExitStrategies: {},
      liveStrategyId: null, liveBridgeEnabled: false });
    put(gd.exitProfiles, { id: 'X8_POST_EXEC1_V1', label: 'EXEC1 V1 · fixed 8s',
      entryProfileIds: ['GD25_35_POST_EXEC1_V1'], exitMode: 'FIXED_HOLD', fixedHoldMs: 8_000 });
  }
  const hold = config.smartWalletConsensusFlowRunnerShadow;
  const holdBase = hold.entryProfiles.find((row) => row.id === 'POST_GRAD_HOLD3_DIRECT');
  if (holdBase) {
    put(hold.entryProfiles, { ...holdBase, id: 'POST_GRAD_HOLD3_DIRECT_POST_EXEC1_V1',
      label: 'HOLD3 EXEC1 V1 · 0.02 SOL / FIX5m', newEntriesEnabled: true,
      positionSizeSol: 0.02, strictExecution: { ...strictAmm }, costModel: { ...costModel },
      exitProfileIds: ['POST_GRAD_HOLD3_FIX5M_POST_EXEC1_V1'],
      liveStrategyId: null, liveBridgeEnabled: false });
    put(hold.exitProfiles, { id: 'POST_GRAD_HOLD3_FIX5M_POST_EXEC1_V1',
      label: 'EXEC1 V1 · fixed 5m', entryProfileIds: ['POST_GRAD_HOLD3_DIRECT_POST_EXEC1_V1'],
      mode: 'FIXED_HOLD', fixedHoldMs: 300_000, maxHoldMs: 300_000,
      hardStopPct: 100, exitTimeoutMs: 30_000 });
  }

  if (focusEnabled) {
    for (const profile of config.cyaOrganicBurstShadow.entryProfiles) {
      if (['COB_F', 'COB_D', 'COB_F_LR01'].includes(profile.id)) profile.newEntriesEnabled = false;
    }
    for (const profile of eb.entryProfiles) {
      if (['EB_B', 'EB_C', 'EB_A_SWC_R2_W300'].includes(profile.id)) profile.newEntriesEnabled = false;
      if (['EB_A', 'EB_A_SWC_PA3_W300'].includes(profile.id)) profile.exitProfileIds = ['FIX20'];
    }
    for (const profile of config.graduationAccelerationShadow.entryProfiles) {
      if (profile.id.startsWith('O_C80_HO500_LONG_')) profile.newEntriesEnabled = false;
    }
    for (const profile of hold.entryProfiles) {
      if (profile.id === 'EARLY_C25_R3') profile.newEntriesEnabled = false;
      if (profile.id === 'POST_GRAD_HOLD3_DIRECT') profile.exitProfileIds = ['POST_GRAD_HOLD3_FIX5M'];
    }
    for (const cohort of config.migrationSecondLegShadow.cohorts) {
      if (cohort.id.startsWith('PMO-FLOW-')
        && !cohort.id.startsWith('PMO-FLOW-H15-A30-D15-X120')) cohort.newEntriesEnabled = false;
    }
  }
  config.researchCalibration = {
    version: LEGACY_VERSION, focusEnabled, liveStrategyId: LEGACY_LIVE_ID,
    liveEntryEnabled: calibrationEntryEnabled, positionSizeSol: 0.02,
    costModelScope: 'ESTIMATED_ROUND_TRIP_NOT_CHAIN_SETTLEMENT',
    costModel: { ...costModel },
  };
  return config;
}

module.exports = { applyResearchCalibrationPolicy, CALIBRATION_ID, EB_VERSION, EB_SOURCE,
  LEGACY_LIVE_ID, LEGACY_VERSION, LEGACY_BASE, LEGACY_RUGX,
  LIVE_PRIORITY_FEE_SOL, CALIBRATION_MAX_POSITIONS };
