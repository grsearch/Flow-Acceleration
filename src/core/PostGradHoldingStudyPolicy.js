'use strict';

const { normalizeCostModel } = require('./CostModel');
const { VERSION: EXECUTION_VERSION } = require('./StrictAmmShadowExecution');

const STUDY_VERSION = 'HOLD3_FORWARD_MATRIX_V1';
const ENTRY_IDS = ['HOLD3_DIRECT_FWD_V1', 'HOLD3_FLOW2_60_FWD_V1'];
const EXIT_IDS = [
  'HOLD3_FIX5M_H30_FWD_V1', 'HOLD3_FIX5M_NOHS_FWD_V1',
  'HOLD3_TRAIL_A30_D20_X30M_H30_FWD_V1', 'HOLD3_TRAIL_A30_D20_X30M_NOHS_FWD_V1',
];

function put(rows, profile) {
  const index = rows.findIndex(row => row.id === profile.id);
  if (index < 0) rows.push(profile);
  else rows[index] = profile;
}

// Forward-only research: new IDs deliberately never rewrite the old 1 SOL or
// single-arm EXEC1 results. Call after historical calibration policy creation.
// No environment-driven tuning within this version; revise IDs for a new study.
function applyPostGradHoldingStudyPolicy(config) {
  const suite = config.smartWalletConsensusFlowRunnerShadow;
  if (!suite) return config;
  suite.entryProfiles ||= [];
  suite.exitProfiles ||= [];
  for (const profile of suite.entryProfiles) {
    if (profile.postGraduationHoldingConsensus && !ENTRY_IDS.includes(profile.id)) {
      profile.newEntriesEnabled = false;
    }
  }
  const costModel = normalizeCostModel({
    positionSizeSol: 0.02, platformFeePct: 1.4,
    buySlippagePct: 0.3, sellSlippagePct: 0.3, priceImpactPct: 0,
    baseTxFeeSol: 0.00001, priorityFeeSol: 0.0002,
    jitoTipSol: 0, fixedCostSol: 0, entryFailureRatePct: 0,
  });
  for (const [index, id] of ENTRY_IDS.entries()) {
    const direct = index === 0;
    put(suite.entryProfiles, {
      id, label: `HOLD3 前向 V1 · ${direct ? 'DIRECT' : 'FLOW2_60'} · 0.02 SOL / 1秒执行 / 4退出对照`,
      enabled: true, newEntriesEnabled: true, researchOnly: true,
      studyVersion: STUDY_VERSION, ruleVersion: STUDY_VERSION,
      strength: direct ? 'HOLDING_STRONG_DIRECT' : 'HOLDING_STRONG_FLOW',
      postGraduationHoldingConsensus: true, directPostGraduationEntry: direct,
      requiredHoldingClusters: 3, minWeightedScoreRatio: 0.5,
      cumulativePostGraduationFlow: true, flowWindowMs: 60_000,
      maxFlowWaitMs: 60_000, minFlowNetSol: 0, minFlowBuyers: 2,
      minFlowBuyTx: 2, requirePositiveFlow: true, requireFlowAcceleration: false,
      scoutFraction: 0, positionSizeSol: 0.02,
      strictExecution: { version: EXECUTION_VERSION },
      entryDelayMs: 1_000, exitDelayMs: 1_000,
      entryTimeoutMs: 30_000, exitTimeoutMs: 30_000,
      costModel: { ...costModel }, exitProfileIds: [...EXIT_IDS],
      liveBridgeEnabled: false, liveStrategyId: null,
      rugGuardMode: 'LABEL_ONLY',
    });
  }
  for (const [index, id] of EXIT_IDS.entries()) {
    const fixed = index < 2;
    const hardStopEnabled = index % 2 === 0;
    put(suite.exitProfiles, {
      id, label: `前向 V1 · ${fixed ? '固定5分钟' : '+30%启动 / 峰值价格回撤20% / 最长30分钟'} · ${hardStopEnabled ? '硬止损30%' : '无硬止损'}`,
      entryProfileIds: [...ENTRY_IDS], studyVersion: STUDY_VERSION,
      mode: fixed ? 'FIXED_HOLD' : 'TRAILING',
      ...(fixed ? { fixedHoldMs: 300_000 } : {
        trailingActivationPct: 30, trailingStopPct: 20,
        trailingDrawdownBasis: 'PEAK_PRICE_PERCENT',
      }),
      maxHoldMs: fixed ? 300_000 : 1_800_000,
      hardStopEnabled, hardStopPct: hardStopEnabled ? 30 : null,
      exitDelayMs: 1_000, exitTimeoutMs: 30_000,
    });
  }
  suite.forwardHoldingStudy = {
    version: STUDY_VERSION, observerOnly: true, sendsTransactions: false,
    entryProfileIds: [...ENTRY_IDS], exitProfileIds: [...EXIT_IDS], arms: 8,
    positionSizeSol: 0.02, entryDelayMs: 1_000, exitDelayMs: 1_000,
    costModelScope: 'ESTIMATED_ROUND_TRIP_NOT_CHAIN_SETTLEMENT',
    feeConvention: 'ROUND_TRIP_ONCE', rugPolicy: 'LABEL_ONLY',
  };
  return config;
}

module.exports = { applyPostGradHoldingStudyPolicy, STUDY_VERSION, ENTRY_IDS, EXIT_IDS };
