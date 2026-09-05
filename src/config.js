'use strict';

require('dotenv').config();

const { costBreakdown, normalizeCostModel } = require('./core/CostModel');
const { PRIMARY_THRESHOLD_VARIANTS } = require('./core/PrimaryThresholdProfiles');

function numberEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function integerEnv(name, fallback, bounds = {}) {
  return Math.trunc(numberEnv(name, fallback, bounds));
}

function nullableNumberEnv(name, fallback = null, bounds = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return numberEnv(name, fallback, bounds);
}

function booleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function listEnv(name, fallback = []) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return [...fallback];
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function positiveNumberListEnv(name, fallback = []) {
  const values = listEnv(name, fallback.map(String))
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return [...new Set(values)];
}

function millisecondListEnv(name, fallbackSeconds = []) {
  const values = listEnv(name, fallbackSeconds.map(String))
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((seconds) => Math.trunc(seconds * 1_000));
  return [...new Set(values)].sort((left, right) => left - right);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function liveTradingGuard(requestedEnabled, safetyLock, dryRun) {
  return {
    enabled: Boolean(requestedEnabled) && !Boolean(safetyLock),
    requestedEnabled: Boolean(requestedEnabled),
    safetyLock: Boolean(safetyLock),
    dryRun: Boolean(safetyLock) || Boolean(dryRun),
  };
}

function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError(`Unsupported gRPC endpoint protocol: ${parsed.protocol}`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function endpointEnv(name, fallback = []) {
  return listEnv(name, fallback).map(normalizeEndpoint).filter(Boolean);
}

const heliusEndpoints = endpointEnv('HELIUS_LASERSTREAM_ENDPOINTS',
  process.env.HELIUS_LASERSTREAM_ENDPOINT ? [process.env.HELIUS_LASERSTREAM_ENDPOINT] : []);
const allenHarkEndpoints = endpointEnv('ALLENHARK_GRPC_ENDPOINTS');
const explicitEndpoints = endpointEnv('FLOW_GRPC_ENDPOINTS');
const labelCostModel = normalizeCostModel({
  platformFeePct: numberEnv(
    'FLOW_PLATFORM_FEE_PCT',
    numberEnv('FLOW_DEFAULT_TRADING_COST_PCT', 1.4, { min: 0 }),
    { min: 0 },
  ),
  buySlippagePct: numberEnv('FLOW_BUY_SLIPPAGE_PCT', 0.3, { min: 0 }),
  sellSlippagePct: numberEnv('FLOW_SELL_SLIPPAGE_PCT', 0.3, { min: 0 }),
  priceImpactPct: numberEnv('FLOW_PRICE_IMPACT_PCT', 0.2, { min: 0 }),
  baseTxFeeSol: numberEnv('FLOW_BASE_TX_FEE_SOL', 0.00001, { min: 0 }),
  priorityFeeSol: numberEnv('FLOW_PRIORITY_FEE_SOL', 0.0005, { min: 0 }),
  jitoTipSol: numberEnv('FLOW_JITO_TIP_SOL', 0, { min: 0 }),
  fixedCostSol: numberEnv('FLOW_FIXED_COST_SOL', 0, { min: 0 }),
  positionSizeSol: numberEnv('FLOW_POSITION_SIZE_SOL', 0.2, { min: 0.000001 }),
  entryFailureRatePct: numberEnv(
    'FLOW_ENTRY_FAILURE_RATE_PCT',
    numberEnv('FLOW_FAILURE_RATE_PCT', 0, { min: 0, max: 100 }),
    { min: 0, max: 100 },
  ),
  entryFailureCostPct: numberEnv(
    'FLOW_ENTRY_FAILURE_COST_PCT',
    numberEnv('FLOW_FAILURE_LOSS_PCT', 1, { min: 0 }),
    { min: 0 },
  ),
});

const liveEntryThreshold = {
  id: 'balanced',
  signalVariant: PRIMARY_THRESHOLD_VARIANTS.BALANCED,
  minNetFlowW3Sol: numberEnv('FLOW_LIVE_MIN_NETFLOW_W3_SOL', 5, { min: 0 }),
  minUniqueBuyersW3: integerEnv('FLOW_LIVE_MIN_BUYERS_W3', 4, { min: 0 }),
};
const primaryThresholdProfiles = [
  {
    id: 'aggressive',
    signalVariant: PRIMARY_THRESHOLD_VARIANTS.AGGRESSIVE,
    minNetFlowW3Sol: numberEnv('FLOW_SIGNAL_SHADOW_AGGRESSIVE_MIN_NETFLOW_W3_SOL', 3, { min: 0 }),
    minUniqueBuyersW3: integerEnv('FLOW_SIGNAL_SHADOW_AGGRESSIVE_MIN_BUYERS_W3', 3, { min: 0 }),
  },
  liveEntryThreshold,
  {
    id: 'conservative',
    signalVariant: PRIMARY_THRESHOLD_VARIANTS.CONSERVATIVE,
    minNetFlowW3Sol: numberEnv('FLOW_SIGNAL_SHADOW_CONSERVATIVE_MIN_NETFLOW_W3_SOL', 7, { min: 0 }),
    minUniqueBuyersW3: integerEnv('FLOW_SIGNAL_SHADOW_CONSERVATIVE_MIN_BUYERS_W3', 5, { min: 0 }),
  },
];
const liveTradingRequested = booleanEnv('FLOW_LIVE_TRADING_ENABLED', false);
// Safety lock defaults to ON so an existing server .env with live trading enabled
// cannot resume signing after this research-only A/B release is deployed.
const liveTradingSafetyLock = booleanEnv('FLOW_LIVE_TRADING_SAFETY_LOCK', true);
const guardedLiveTrading = liveTradingGuard(
  liveTradingRequested,
  liveTradingSafetyLock,
  booleanEnv('FLOW_LIVE_DRY_RUN', true),
);
const retiredShadowsEnabled = booleanEnv('FLOW_RETIRED_SHADOWS_ENABLED', false);
// Cohorts with a sufficiently large, consistently negative forward sample are
// disabled behind a second explicit override. This prevents an old server .env
// containing strategy-specific `..._ENABLED=true` values from silently
// restarting them after an upgrade. Historical rows and raw collection remain.
const provenNegativeShadowsEnabled = booleanEnv(
  'FLOW_PROVEN_NEGATIVE_SHADOWS_ENABLED',
  false,
);
// Holder Growth produced a large, consistently negative entry/exit cross-product.
// Keep the complete historical matrix queryable, but only create new rows for the
// 15-second control and the isolated forward quality cohorts unless an operator
// explicitly re-enables the full experiment. A new flag is used so an older server
// .env cannot silently restore a retired experiment after a normal code upgrade.
const holderGrowthFullMatrixEnabled = booleanEnv(
  'FLOW_HOLDER_GROWTH_FULL_MATRIX_ENABLED',
  false,
);
// Forward-only quality cohorts selected on two non-overlapping 24-hour windows.
// This deliberately uses a new flag: an old STRONG_FLOW=true server setting must
// not revive the proven-negative absolute-flow cohorts.
const holderGrowthQualityEnabled = booleanEnv(
  'FLOW_HOLDER_GROWTH_QUALITY_ENABLED',
  true,
);
// The first PFL matrix was useful as a future-label discovery sample but is
// consistently negative as an entry rule. Keep those cohort definitions behind
// an explicit opt-in while the narrower B2 forward cohort starts a clean sample.
const publicFlowLeadLegacyProfilesEnabled = booleanEnv(
  'FLOW_PUBLIC_FLOW_LEAD_LEGACY_PROFILES_ENABLED',
  false,
);
// G-FR is intentionally isolated from the rest of Lifecycle Drop/Rebound G.
// Operators can pause this compute-heavier forward experiment without losing
// the mature G cohorts or their historical rows.
const migratedReboundGfrEnabled = booleanEnv(
  'FLOW_MIGRATED_REBOUND_GFR_ENABLED',
  true,
);

// One shared fallback keeps every research-only strategy on the same economic
// scale. A strategy-specific environment variable may still override it.
const defaultShadowPositionSol = numberEnv('FLOW_SHADOW_DEFAULT_POSITION_SOL', 1, {
  min: 0.000001,
});

// Old deployments copied 0.05 into every strategy-specific variable. Treat
// that exact former default as inherited so a normal code upgrade really moves
// every Shadow to the shared 1 SOL default. Other explicit custom sizes remain
// valid; setting the shared default itself to 0.05 still opts all Shadows back.
function shadowPositionEnv(name) {
  const raw = process.env[name];
  if (raw == null || raw === '' || Number(raw) === 0.05) return defaultShadowPositionSol;
  return numberEnv(name, defaultShadowPositionSol, { min: 0.000001 });
}

// Live strategies previously shipped with 0.05 SOL and then 1 SOL defaults.
// Treat both historical values as inherited so an existing server moves to the
// current 0.1 SOL default on a normal code upgrade. Other values remain explicit
// operator overrides.
function livePositionEnv(name, fallback = 0.1, legacyName = null) {
  const raw = process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
  if (raw == null || raw === '' || [0.05, 1].includes(Number(raw))) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0.000001, value) : fallback;
}

function priorityFeeMicroLamports(priorityFeeSol, computeUnitLimit) {
  if (!(priorityFeeSol > 0) || !(computeUnitLimit > 0)) return 0;
  // 1 SOL = 1e9 lamports and 1 lamport = 1e6 micro-lamports.
  return Math.ceil((priorityFeeSol * 1e15) / computeUnitLimit);
}

// Forward-only first-pullback entry experiments. These profiles are consumed by
// both the observer (causal reference detection) and Shadow F (simulated entry).
// Keep their IDs immutable so results never merge with the historical 7.5% groups.
const launchDeepPullbackProfiles = [
  {
    id: 'DEEP_D10_R3',
    cohortId: 'FD10_R3_5S',
    label: 'FD10-R3 · 回踩10% / 反弹3% / 稳定0.5秒',
    pullbackPct: numberEnv('FLOW_LAUNCH_DEEP_D10_R3_PULLBACK_PCT', 10, {
      min: 0.1, max: 100,
    }),
    reboundPct: numberEnv('FLOW_LAUNCH_DEEP_D10_R3_REBOUND_PCT', 3, { min: 0 }),
    lowStableMs: integerEnv('FLOW_LAUNCH_DEEP_D10_R3_LOW_STABLE_MS', 500, { min: 0 }),
  },
  {
    id: 'DEEP_D12_5_R3',
    cohortId: 'FD12_5_R3_5S',
    label: 'FD12.5-R3 · 回踩12.5% / 反弹3% / 稳定0.5秒',
    pullbackPct: numberEnv('FLOW_LAUNCH_DEEP_D12_5_R3_PULLBACK_PCT', 12.5, {
      min: 0.1, max: 100,
    }),
    reboundPct: numberEnv('FLOW_LAUNCH_DEEP_D12_5_R3_REBOUND_PCT', 3, { min: 0 }),
    lowStableMs: integerEnv('FLOW_LAUNCH_DEEP_D12_5_R3_LOW_STABLE_MS', 500, { min: 0 }),
  },
  {
    id: 'DEEP_D12_5_R5',
    cohortId: 'FD12_5_R5_5S',
    label: 'FD12.5-R5 · 回踩12.5% / 反弹5% / 稳定1秒',
    pullbackPct: numberEnv('FLOW_LAUNCH_DEEP_D12_5_R5_PULLBACK_PCT', 12.5, {
      min: 0.1, max: 100,
    }),
    reboundPct: numberEnv('FLOW_LAUNCH_DEEP_D12_5_R5_REBOUND_PCT', 5, { min: 0 }),
    lowStableMs: integerEnv('FLOW_LAUNCH_DEEP_D12_5_R5_LOW_STABLE_MS', 1_000, { min: 0 }),
  },
  {
    id: 'DEEP_D15_R5',
    cohortId: 'FD15_R5_5S',
    label: 'FD15-R5 · 回踩15% / 反弹5% / 稳定1秒',
    pullbackPct: numberEnv('FLOW_LAUNCH_DEEP_D15_R5_PULLBACK_PCT', 15, {
      min: 0.1, max: 100,
    }),
    reboundPct: numberEnv('FLOW_LAUNCH_DEEP_D15_R5_REBOUND_PCT', 5, { min: 0 }),
    lowStableMs: integerEnv('FLOW_LAUNCH_DEEP_D15_R5_LOW_STABLE_MS', 1_000, { min: 0 }),
  },
].map((profile) => ({
  ...profile,
  minNewBuyers: integerEnv('FLOW_LAUNCH_DEEP_MIN_NEW_BUYERS', 2, { min: 0 }),
  flowWindowMs: integerEnv('FLOW_LAUNCH_DEEP_FLOW_WINDOW_MS', 1_000, { min: 100 }),
  minWindowNetFlowSol: numberEnv('FLOW_LAUNCH_DEEP_MIN_WINDOW_NET_FLOW_SOL', 0.01, { min: 0 }),
  maxPullbackPct: numberEnv('FLOW_LAUNCH_DEEP_MAX_PULLBACK_PCT', 25, {
    min: 0.1, max: 100,
  }),
}));

const m2fNearHighThresholds = Object.freeze({
  minAgeMs: 60_000,
  maxAgeMs: 240_000,
  minCurrentImpulsePct: 10,
  maxCurrentImpulsePct: 150,
  minPeakImpulsePct: 25,
  minPullbackPct: 5,
  maxPullbackPct: 15,
  minReboundPct: 3,
  minNetFlow10sSol: 1,
  minNetFlow3sSol: 0.1,
  minBuyers10s: 10,
  minBuyers3s: 2,
  maxLargestBuyerSharePct: 45,
  minBuySpeedRatio: 1.05,
  minNetFlowAcceleration: 0,
  maxSellDecelerationRatio: 1.1,
  minHolderDiffusionIndex: 8,
  maxEstimatedImpact1SolPct: 1,
});

// Retired research paths stay queryable for historical analysis, but an old server
// .env must not silently reopen them. Reopening requires this explicit master gate
// as well as the individual strategy switch.
const retiredResearchReopenEnabled = booleanEnv(
  'FLOW_RETIRED_RESEARCH_REOPEN_ENABLED',
  false,
);

// Late post-migration stabilization (LPS) is intentionally isolated from the
// retired M2F entry matrix. M2F-OBS already keeps eight minutes of causal
// PumpSwap snapshots, so these delayed controls add no RPC calls. The 150s
// cohort is the primary forward test; 180/240/300s are sparse controls.
const lpsTargetToleranceMs = integerEnv('FLOW_LPS_TARGET_TOLERANCE_MS', 3_000, {
  min: 500,
  max: 15_000,
});
const lpsPositionSizeSol = numberEnv('FLOW_LPS_POSITION_SOL', 1, {
  min: 0.01,
  max: 100,
});
const lpsThresholds = (targetAgeMs) => ({
  minAgeMs: targetAgeMs - lpsTargetToleranceMs,
  maxAgeMs: targetAgeMs + lpsTargetToleranceMs,
  maxObservationLagMs: integerEnv('FLOW_LPS_MAX_OBSERVATION_LAG_MS', 3_000, {
    min: 250,
    max: 30_000,
  }),
  minCurrentImpulsePct: -100,
  maxCurrentImpulsePct: 10_000,
  minPeakImpulsePct: -100,
  minPullbackPct: -100,
  maxPullbackPct: 100,
  minReboundPct: -100,
  maxReboundPct: 10_000,
  minNetFlow10sSol: numberEnv('FLOW_LPS_MIN_NET_FLOW_10S_SOL', 8, {
    min: -10_000,
    max: 10_000,
  }),
  minNetFlow3sSol: -10_000,
  minBuyers10s: integerEnv('FLOW_LPS_MIN_BUYERS_10S', 7, {
    min: 0,
    max: 10_000,
  }),
  minBuyers3s: 0,
  maxLargestBuyerSharePct: numberEnv('FLOW_LPS_MAX_TOP1_SHARE_PCT', 50, {
    min: 0,
    max: 100,
  }),
  minBuySpeedRatio: -1_000,
  minNetFlowAcceleration: numberEnv('FLOW_LPS_MIN_NET_FLOW_ACCELERATION', 0.001, {
    min: -10_000,
    max: 10_000,
  }),
  maxSellDecelerationRatio: 1_000_000_000,
  minHolderDiffusionIndex: -10_000,
  minQuoteReserveSol: 0,
  maxEstimatedImpact1SolPct: numberEnv('FLOW_LPS_MAX_IMPACT_1SOL_PCT', 15, {
    min: 0,
    max: 100,
  }),
});
const lpsEntryTargets = [
  ['LPS-D150', 150_000, 'FLOW_LPS_150_ENABLED', [30_000, 60_000, 120_000]],
  ['LPS-D180', 180_000, 'FLOW_LPS_180_ENABLED', [30_000]],
  ['LPS-D240', 240_000, 'FLOW_LPS_240_ENABLED', [30_000]],
  ['LPS-D300', 300_000, 'FLOW_LPS_300_ENABLED', [30_000]],
];
const lpsCohorts = lpsEntryTargets.flatMap(([
  prefix, targetAgeMs, enabledEnv, holds,
]) => holds.map((maxHoldMs) => ({
  id: `${prefix}-X${maxHoldMs / 1_000}`,
  label: `Late stabilization ${targetAgeMs / 1_000}s / fixed ${maxHoldMs / 1_000}s`,
  enabled: retiredResearchReopenEnabled && booleanEnv(enabledEnv, true),
  studyMode: 'LATE_POST_MIGRATION_STABILIZATION',
  confirmationMode: 'IMMEDIATE',
  positionSizeSol: lpsPositionSizeSol,
  entryDelayMs: 200,
  entryTimeoutMs: 2_000,
  exitDelayMs: 200,
  exitTimeoutMs: 2_000,
  maxEntryPriceJumpPct: 15,
  maxNegativeEntryJumpPct: 30,
  hardStopPct: 100,
  maxHoldMs,
  thresholds: lpsThresholds(targetAgeMs),
})));

// PMO is a forward-only, strictly paired post-migration opportunity matrix.
// The archived one-day screening selected public-flow continuation over the
// two sparse pullback entries. Every exit is run twice on the exact same
// signal: BASE only labels RUG risk, while RUGX blocks only repeat actors or
// templates learned inside the same PumpSwap lifecycle stage. Curve-only
// coordinated-dumpability thresholds are deliberately not inherited here.
const postMigrationOpportunityEnabled = booleanEnv(
  'FLOW_POST_MIGRATION_OPPORTUNITY_SHADOW_ENABLED',
  true,
);
const postMigrationOpportunityPositionSol = numberEnv(
  'FLOW_POST_MIGRATION_OPPORTUNITY_POSITION_SOL',
  0.1,
  { min: 0.01, max: 10 },
);
const postMigrationOpportunityThresholds = Object.freeze({
  minAgeMs: 10_000,
  maxAgeMs: 120_000,
  maxObservationLagMs: 2_000,
  minCurrentImpulsePct: -20,
  maxCurrentImpulsePct: 300,
  minPeakImpulsePct: 0,
  minPullbackPct: 0,
  maxPullbackPct: 35,
  minReboundPct: 0,
  maxReboundPct: 100,
  minNetFlow10sSol: 3,
  minNetFlow3sSol: 0.5,
  minBuyers10s: 6,
  minBuyers3s: 2,
  maxLargestBuyerSharePct: 50,
  minBuySpeedRatio: -1_000,
  minNetFlowAcceleration: -10_000,
  maxSellDecelerationRatio: 1_000_000_000,
  minHolderDiffusionIndex: -10_000,
  minQuoteReserveSol: 5,
  maxEstimatedImpact1SolPct: 15,
});
const postMigrationOpportunityExits = Object.freeze([
  { id: 'H15-A30-D15-X120', hardStopPct: 15, trailingActivationPct: 30, trailingStopPct: 15, maxHoldMs: 120_000 },
  { id: 'H20-A50-D20-X300', hardStopPct: 20, trailingActivationPct: 50, trailingStopPct: 20, maxHoldMs: 300_000 },
  // Primary right-tail candidate from the one-day screen: activation is kept
  // deliberately high so an ordinary +30% move cannot cut off a larger run.
  { id: 'H20-A75-D25-X300', hardStopPct: 20, trailingActivationPct: 75, trailingStopPct: 25, maxHoldMs: 300_000 },
  { id: 'H25-A100-D30-X600', hardStopPct: 25, trailingActivationPct: 100, trailingStopPct: 30, maxHoldMs: 600_000 },
]);
const postMigrationOpportunityCohorts = postMigrationOpportunityExits.flatMap((exit) => (
  ['BASE', 'RUGX'].map((arm) => ({
    ...exit,
    id: `PMO-FLOW-${exit.id}${arm === 'RUGX' ? '-RUGX' : ''}`,
    label: `PMO Flow · ${exit.id} · ${arm}`,
    enabled: postMigrationOpportunityEnabled,
    studyMode: arm === 'RUGX'
      ? 'POST_MIGRATION_PUBLIC_FLOW_RUG_FILTERED'
      : 'POST_MIGRATION_PUBLIC_FLOW_BASELINE',
    confirmationMode: 'IMMEDIATE',
    positionSizeSol: postMigrationOpportunityPositionSol,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 2_000,
    maxEntryPriceJumpPct: 15,
    maxNegativeEntryJumpPct: 30,
    maxObservedPriceRatio: 100,
    rugGuardMode: arm === 'RUGX' ? 'HARD_BLOCK' : 'LABEL_ONLY',
    hardBlockSignatures: arm === 'RUGX' ? [
      'crossMintToxicWallets',
      'crossMintToxicTemplate',
    ] : [],
    rugPolicyReason: arm === 'RUGX'
      ? 'PMO_STRICT_PAIR_HIGH_CONFIDENCE_RUGX'
      : 'PMO_STRICT_PAIR_BASELINE_LABEL_ONLY',
    requireCapacityMetrics: true,
    thresholds: { ...postMigrationOpportunityThresholds },
  }))
));

// The existing O-C80 live bridge deliberately keeps its 15% entry-move guard.
// These forward-only cohorts measure two entry counterfactuals. Only the
// selected 0.1 SOL HO500-X60 cohort feeds the separately gated live strategy:
// 1) wait for the first executable PumpSwap tape after graduation; and
// 2) accept selected 40-70% curve repricing bands only after a fresh public BUY.
const graduationRelaxedEntryShadowEnabled = booleanEnv(
  'FLOW_GRADUATION_ACCEL_RELAXED_ENTRY_SHADOW_ENABLED',
  true,
);
const graduationRelaxedCapacitySols = positiveNumberListEnv(
  'FLOW_GRADUATION_ACCEL_RELAXED_CAPACITY_SOLS',
  [0.1, 1],
);
const graduationRelaxedEntryProfiles = [
  ...[0, 200, 500].flatMap((handoffDelayMs) => (
    [60_000, 120_000].flatMap((runnerMaxHoldMs) => {
      const baseline = {
        id: `O_C80_HO${handoffDelayMs}_X${runnerMaxHoldMs / 1_000}`,
        label: `O-C80-HO${handoffDelayMs} · 毕业后PumpSwap接力 / 固定${runnerMaxHoldMs / 1_000}秒`,
        studyGroup: 'O_C80_POST_GRADUATION_HANDOFF',
        mode: 'CURVE_MILESTONE',
        thresholdPct: 80,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        migrationHandoff: true,
        handoffLiveStrategyId: handoffDelayMs === 500 && runnerMaxHoldMs === 60_000
          ? 'graduation_accel_o_c80_ho500_x60_live'
          : null,
        liveBridgeCapacitySol: 0.1,
        capacityAwareExit: true,
        capacitySols: handoffDelayMs === 500 && runnerMaxHoldMs === 60_000
          ? [...new Set([0.1, ...graduationRelaxedCapacitySols])]
          : graduationRelaxedCapacitySols,
        coreExitPct: 0,
        postMigrationEntryGate: {
          windowMs: handoffDelayMs,
          // Keep the first executable post-delay trade in the causal snapshot.
          evaluateAtFill: true,
          captureWindowMs: 10_000,
          minBuyers: 1,
          minNetFlowSol: 0,
          maxSellBuyRatio: 1,
          maxDrawdownPct: 20,
          maxMarketMovePct: 15,
          maxSelfImpactPct: 10,
        },
        runnerExitMode: 'FIXED_HOLD',
        runnerMaxHoldMs,
      };
      if (handoffDelayMs !== 500 || runnerMaxHoldMs !== 60_000) return [baseline];
      return [
        baseline,
        {
          ...baseline,
          id: 'O_C80_HO500_X60_RUGX',
          label: 'O-C80-HO500-X60 RUGX · 同信号 + 当前高置信灾难过滤',
          handoffLiveStrategyId: null,
          capacitySols: [0.1],
          pairedBaselineProfileId: 'O_C80_HO500_X60',
          rugGuardMode: 'HIGH_CONFIDENCE_CATASTROPHE',
        },
      ];
    })
  )),
  ...[
    ['DAY0420', 4, 20],
    ['OFF2004', 20, 4],
  ].map(([sessionId, sessionStartHourCst, sessionEndHourCst]) => ({
    id: `O_C80_HO500_X60_${sessionId}`,
    label: `O-C80-HO500-${sessionId} · PumpSwap接力 / 固定60秒 / 北京时段分层`,
    studyGroup: 'O_C80_POST_GRADUATION_HANDOFF_TIME',
    mode: 'CURVE_MILESTONE',
    thresholdPct: 80,
    recentWindowMs: 5_000,
    minCurveDeltaPct: 5,
    minBuyers: 2,
    maxSellTx: 0,
    requireNoCreatorSell: true,
    migrationHandoff: true,
    capacityAwareExit: true,
    capacitySols: graduationRelaxedCapacitySols,
    sessionStartHourCst,
    sessionEndHourCst,
    coreExitPct: 0,
    postMigrationEntryGate: {
      windowMs: 500,
      evaluateAtFill: true,
      captureWindowMs: 10_000,
      minBuyers: 1,
      minNetFlowSol: 0,
      maxSellBuyRatio: 1,
      maxDrawdownPct: 20,
      maxMarketMovePct: 15,
      maxSelfImpactPct: 10,
    },
    runnerExitMode: 'FIXED_HOLD',
    runnerMaxHoldMs: 60_000,
  })),
  ...[[40, 50], [50, 60], [60, 70]].flatMap(([minPct, maxPct]) => (
    [60_000, 120_000].map((runnerMaxHoldMs) => ({
      id: `O_C80_J${minPct}_${maxPct}_X${runnerMaxHoldMs / 1_000}`,
      label: `O-C80-J${minPct}-${maxPct} · Curve冲击${minPct}%–${maxPct}% / 新BUY确认 / 固定${runnerMaxHoldMs / 1_000}秒`,
      studyGroup: 'O_C80_CURVE_JUMP_BAND',
      mode: 'CURVE_MILESTONE',
      thresholdPct: 80,
      recentWindowMs: 5_000,
      minCurveDeltaPct: 5,
      minBuyers: 2,
      maxSellTx: 0,
      requireNoCreatorSell: true,
      capacityAwareExit: true,
      capacitySols: graduationRelaxedCapacitySols,
      entryPriceJumpBand: {
        minPct,
        maxPct,
        minPostSignalBuyers: 1,
        minPostSignalNetFlowSol: 0,
        maxPostSignalSellTx: 0,
      },
      coreExitPct: 0,
      runnerExitMode: 'FIXED_HOLD',
      runnerMaxHoldMs,
    }))
  )),
].map((profile) => ({ ...profile, newEntriesEnabled: graduationRelaxedEntryShadowEnabled }));

// Exit-only, forward paired controls. The Suite clones a successful 0.1 SOL
// baseline fill; these profiles never select another entry or emit live orders.
const graduationHo500LongExitEnabled = booleanEnv('FLOW_GRADUATION_ACCEL_HO500_LONG_EXIT_ENABLED', true);
const graduationHo500ExitBaseline = graduationRelaxedEntryProfiles
  .find((profile) => profile.id === 'O_C80_HO500_X60');
const graduationHo500LongExitProfiles = graduationHo500ExitBaseline
  ? [1_800_000, 3_600_000].flatMap((runnerMaxHoldMs) => (
    [[30, 20], [100, 30]].flatMap(([trailingActivationPct, trailingStopPct]) => (
      [20, 30, 0].map((hardStopPct) => ({
        ...graduationHo500ExitBaseline,
        id: `O_C80_HO500_LONG_A${trailingActivationPct}_D${trailingStopPct}_H${hardStopPct || 'OFF'}_X${runnerMaxHoldMs / 1_000}`,
        label: `HO500 长持对照 · ${runnerMaxHoldMs / 60_000}分钟 / TP${trailingActivationPct}回撤${trailingStopPct} / ${hardStopPct ? `硬止损${hardStopPct}%` : '无硬止损'}`,
        studyGroup: 'HO500_LONG_EXIT_V1',
        experimentGroup: 'HO500_LONG_EXIT_V1',
        pairedEntryProfileId: 'O_C80_HO500_X60',
        newEntriesEnabled: graduationHo500LongExitEnabled && graduationRelaxedEntryShadowEnabled,
        handoffLiveStrategyId: null,
        liveStrategyId: null,
        liveBridgeCapacitySol: null,
        capacitySols: [0.1],
        runnerExitMode: 'TRAILING',
        runnerMaxHoldMs,
        trailingActivationPct,
        trailingStopPct,
        hardStopPct,
        coreExitPct: 0,
      }))
    ))
  )) : [];

const config = {
  pump: {
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    ammProgramId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    wsolMint: 'So11111111111111111111111111111111111111112',
    tokenDecimals: 6,
  },

  stream: {
    endpoints: unique(explicitEndpoints.length > 0
      ? explicitEndpoints
      : [...heliusEndpoints, ...allenHarkEndpoints]),
    heliusEndpoints: new Set(heliusEndpoints),
    heliusToken: process.env.FLOW_GRPC_TOKEN
      || process.env.HELIUS_LASERSTREAM_TOKEN
      || process.env.HELIUS_API_KEY
      || '',
    allenHarkEndpoints: new Set(allenHarkEndpoints),
    allenHarkToken: process.env.ALLENHARK_GRPC_TOKEN || '',
    reconnectMinMs: integerEnv('FLOW_STREAM_RECONNECT_MIN_MS', 1_000, { min: 250 }),
    reconnectMaxMs: integerEnv('FLOW_STREAM_RECONNECT_MAX_MS', 30_000, { min: 1_000 }),
    staleTimeoutMs: integerEnv('FLOW_STREAM_STALE_TIMEOUT_MS', 15_000, { min: 5_000 }),
    staleCheckMs: integerEnv('FLOW_STREAM_STALE_CHECK_MS', 2_000, { min: 500 }),
    dedupTtlMs: integerEnv('FLOW_STREAM_DEDUP_TTL_MS', 300_000, { min: 10_000 }),
    dedupMax: integerEnv('FLOW_STREAM_DEDUP_MAX', 100_000, { min: 1_000 }),
  },

  strategy: {
    bufferMs: integerEnv('FLOW_BUFFER_MS', 10 * 60_000, { min: 60_000 }),
    activityWindowMs: integerEnv('FLOW_ACTIVITY_WINDOW_MS', 5_000, { min: 1_000 }),
    activityMinVolumeSol: numberEnv('FLOW_ACTIVITY_MIN_VOLUME_SOL', 3, { min: 0 }),
    activityMinTxCount: integerEnv('FLOW_ACTIVITY_MIN_TX_COUNT', 12, { min: 1 }),
    activityMinUniqueWallets: integerEnv('FLOW_ACTIVITY_MIN_UNIQUE_WALLETS', 8, { min: 1 }),
    signalWindowMs: integerEnv('FLOW_SIGNAL_WINDOW_MS', 2_000, { min: 250 }),
    minNetFlowW3Sol: numberEnv('FLOW_MIN_NET_W3_SOL', 1, { min: 0 }),
    minNetFlowDeltaSol: numberEnv('FLOW_MIN_NET_DELTA_SOL', 0.1, { min: 0 }),
    minAccelerationRatio: numberEnv('FLOW_MIN_ACCEL_RATIO', 1.2, { min: 1 }),
    ratioFloorSol: numberEnv('FLOW_RATIO_FLOOR_SOL', 0.05, { min: 0.000001 }),
    signalCooldownMs: integerEnv('FLOW_SIGNAL_COOLDOWN_MS', 0, { min: 0 }),
    candidateIdleMs: integerEnv('FLOW_CANDIDATE_IDLE_MS', 15_000, { min: 2_000 }),
    primaryThresholdProfiles,
  },

  labels: {
    horizonsSeconds: [1, 2, 3, 5, 8, 10, 15, 20, 30, 60],
    excursionSeconds: [5, 10, 30],
    maxObservationLagMs: integerEnv('FLOW_LABEL_MAX_OBSERVATION_LAG_MS', 2_000, { min: 0 }),
    costModel: labelCostModel,
    configuredTradingCostPct: costBreakdown(labelCostModel).deterministicCostPct,
  },

  backtest: {
    executionDelayMs: integerEnv('FLOW_BACKTEST_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_BACKTEST_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitExecutionDelayMs: integerEnv('FLOW_BACKTEST_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_BACKTEST_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    noExitLossPct: nullableNumberEnv('FLOW_BACKTEST_NO_EXIT_LOSS_PCT', null, { min: 0 }),
    signalCooldownMs: integerEnv('FLOW_BACKTEST_SIGNAL_COOLDOWN_MS', 5_000, { min: 0 }),
    singlePositionPerMint: booleanEnv('FLOW_BACKTEST_SINGLE_POSITION_PER_MINT', true),
  },

  smartWallets: listEnv('FLOW_SMART_WALLETS', [
    'Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt',
    '7yd579zXmWPoxEE22BUYTzAo8nyMmQtPyEWS3g1BFhH4',
  ]),

  liveTrading: {
    ...guardedLiveTrading,
    rpcUrl: process.env.FLOW_RPC_URL || '',
    contextFallbackRpcUrl: process.env.FLOW_LIVE_CONTEXT_FALLBACK_RPC_URL || '',
    privateKey: process.env.FLOW_LIVE_PRIVATE_KEY || '',
    maxSignalAgeMs: integerEnv('FLOW_LIVE_MAX_SIGNAL_AGE_MS', 1_500, { min: 100 }),
    maxPositionTradeAgeMs: integerEnv('FLOW_LIVE_MAX_POSITION_TRADE_AGE_MS', 3_000, { min: 1_000 }),
    maxConcurrentPositions: integerEnv('FLOW_LIVE_MAX_POSITIONS', 10, { min: 1, max: 20 }),
    maxConcurrentPositionsPerMint: integerEnv(
      'FLOW_LIVE_MAX_CONCURRENT_POSITIONS_PER_MINT',
      3,
      { min: 1, max: 10 },
    ),
    minWalletReserveSol: numberEnv('FLOW_LIVE_MIN_WALLET_RESERVE_SOL', 0.05, { min: 0 }),
    mintCooldownMs: integerEnv('FLOW_LIVE_MINT_COOLDOWN_MS', 10 * 60_000, { min: 0 }),
    failedEntryCooldownMs: integerEnv(
      'FLOW_LIVE_FAILED_ENTRY_COOLDOWN_MS', 30_000, { min: 0 },
    ),
    failedEntryWindowMs: integerEnv(
      'FLOW_LIVE_FAILED_ENTRY_WINDOW_MS', 5 * 60_000, { min: 1 },
    ),
    maxFailedEntriesPerMint: integerEnv(
      'FLOW_LIVE_MAX_FAILED_ENTRIES_PER_MINT', 2, { min: 1, max: 20 },
    ),
    heldMintLockRecheckMs: integerEnv(
      'FLOW_LIVE_HELD_MINT_LOCK_RECHECK_MS', 60_000, { min: 1_000 },
    ),
    heldMintLockRecheckBatch: integerEnv(
      'FLOW_LIVE_HELD_MINT_LOCK_RECHECK_BATCH', 10, { min: 1, max: 100 },
    ),
    maxEntryPriceJumpPct: numberEnv('FLOW_LIVE_MAX_ENTRY_PRICE_JUMP_PCT', 10, {
      min: 0,
      max: 100,
    }),
    maxEntrySelfImpactPct: numberEnv('FLOW_LIVE_MAX_ENTRY_SELF_IMPACT_PCT', 10, {
      min: 0,
      max: 100,
    }),
    buySlippagePct: numberEnv('FLOW_LIVE_BUY_SLIPPAGE_PCT', 10, { min: 0.1, max: 50 }),
    sellSlippagePct: numberEnv('FLOW_LIVE_SELL_SLIPPAGE_PCT', 15, { min: 0.1, max: 50 }),
    // Catastrophe exits deliberately prefer execution certainty over price
    // certainty. At 100%, Pump/PumpSwap encode a zero minimum SOL output; this
    // path is used only after a HARD_STOP/RUG trigger, never for normal exits.
    emergencySellSlippagePct: numberEnv(
      'FLOW_LIVE_EMERGENCY_SELL_SLIPPAGE_PCT', 100, { min: 15, max: 100 },
    ),
    computeUnitLimit: integerEnv('FLOW_LIVE_COMPUTE_UNIT_LIMIT', 250_000, {
      min: 100_000,
      max: 1_400_000,
    }),
    priorityFeeSol: numberEnv('FLOW_LIVE_PRIORITY_FEE_SOL', 0.0005, { min: 0 }),
    emergencyPriorityFeeSol: numberEnv(
      'FLOW_LIVE_EMERGENCY_PRIORITY_FEE_SOL', 0.002, { min: 0 },
    ),
    // The transaction stream is processed-level. Quote against the same newest view,
    // but retain confirmed-level finality for position state and reconciliation.
    readCommitment: process.env.FLOW_LIVE_READ_COMMITMENT || 'processed',
    confirmationCommitment: process.env.FLOW_LIVE_CONFIRMATION_COMMITMENT
      || process.env.FLOW_LIVE_COMMITMENT
      || 'confirmed',
    contextSlotRetryCount: integerEnv('FLOW_LIVE_CONTEXT_SLOT_RETRIES', 6, {
      min: 0,
      max: 10,
    }),
    contextSlotRetryDelayMs: integerEnv('FLOW_LIVE_CONTEXT_SLOT_RETRY_DELAY_MS', 50, {
      min: 0,
      max: 500,
    }),
    // Backward-compatible alias consumed by older dashboard/export code.
    commitment: process.env.FLOW_LIVE_CONFIRMATION_COMMITMENT
      || process.env.FLOW_LIVE_COMMITMENT
      || 'confirmed',
    maxHoldMs: 15_000,
    exitRetryCount: integerEnv('FLOW_LIVE_EXIT_RETRY_COUNT', 10, { min: 0, max: 60 }),
    exitRetryDelayMs: integerEnv('FLOW_LIVE_EXIT_RETRY_DELAY_MS', 1_000, { min: 100 }),
    emergencyExitRetryDelayMs: integerEnv(
      'FLOW_LIVE_EMERGENCY_EXIT_RETRY_DELAY_MS',
      100,
      { min: 25, max: 1_000 },
    ),
    entryReconcileCount: integerEnv('FLOW_LIVE_ENTRY_RECONCILE_COUNT', 5, {
      min: 1,
      max: 30,
    }),
    entryReconcileDelayMs: integerEnv('FLOW_LIVE_ENTRY_RECONCILE_DELAY_MS', 1_000, {
      min: 100,
      max: 30_000,
    }),
    expiredEntryReleaseMs: integerEnv('FLOW_LIVE_EXPIRED_ENTRY_RELEASE_MS', 10 * 60_000, {
      min: 60_000,
      max: 24 * 60 * 60_000,
    }),
    killSwitchFile: process.env.FLOW_LIVE_KILL_SWITCH_FILE || './data/LIVE_TRADING_DISABLED',
    ammPriceContinuity: {
      minRatio: numberEnv('FLOW_LIVE_AMM_PRICE_MIN_RATIO', 0.2, { min: 0.0001, max: 1 }),
      maxRatio: numberEnv('FLOW_LIVE_AMM_PRICE_MAX_RATIO', 5, { min: 1 }),
      resetAfterMs: integerEnv('FLOW_LIVE_AMM_PRICE_RESET_MS', 15_000, { min: 1_000 }),
    },
    // Multiple live strategies can coexist here. Each one owns its own SOL size
    // and independent decision history; the retired Primary live rule is not listed.
    strategies: [
      {
        id: 'cya_organic_burst_cob_f_core25_runner_live',
        code: 'COB-F-C25-R75-X120',
        label: 'CYA Organic Burst · COB-F Strict 7 SOL · 25/75 Stair Runner',
        ruleVersion: 'cya_organic_burst_cob_f_core25_runner_live_v1',
        signalSource: 'CYA_ORGANIC_BURST_COB_F',
        enabled: booleanEnv('FLOW_LIVE_CYA_ORGANIC_BURST_COB_F_ENABLED', true),
        entryEnabled: booleanEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_F_ENTRY_ENABLED',
          false,
        ),
        market: 'PUMP_BONDING_CURVE',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_F_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_F_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_F_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 1_000 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_F_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'CORE_RUNNER',
        hardStopPct: 0,
        coreActivationPct: 20,
        coreExitPct: 25,
        trailingActivationPct: 20,
        baseTrailingDrawdownPct: 15,
        trailingTiers: [
          { activationPct: 50, drawdownPct: 20 },
          { activationPct: 100, drawdownPct: 25 },
        ],
        maxHoldMs: 120_000,
        sourceShadowCohortId: 'COB_F_CORE25_R75_X120',
      },
      {
        id: 'cya_organic_burst_cob_d_fix30_live',
        code: 'COB-D-T30-D10-X60',
        label: 'CYA Organic Burst · COB-D Strict 5 SOL · Fast TP + Trailing',
        ruleVersion: 'cya_organic_burst_cob_d_fast_tp_trailing_live_v3',
        signalSource: 'CYA_ORGANIC_BURST_COB_D',
        enabled: booleanEnv('FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_ENABLED', true),
        entryEnabled: booleanEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_ENTRY_ENABLED',
          false,
        ),
        market: 'PUMP_BONDING_CURVE',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 1_000 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'TRAILING',
        minHoldMs: 0,
        fastTakeProfitPct: numberEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_FAST_TP_PCT',
          10,
          { min: 0 },
        ),
        fastTakeProfitWindowMs: integerEnv(
          'FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_FAST_TP_WINDOW_MS',
          2_000,
          { min: 0 },
        ),
        trailingActivationPct: 30,
        trailingStopPct: 10,
        hardStopPct: 20,
        maxHoldMs: 60_000,
        sourceShadowCohortId: 'COB_D_T30_10_X60',
      },
      {
        id: 'big_winner_pbr_a_x50_15_live',
        code: 'PBR-A-X50-15',
        label: 'Big Winner PBR-A · X50_15 Core + Runner',
        ruleVersion: 'big_winner_pbr_a_x50_15_live_v2',
        signalSource: 'BIG_WINNER_PBR_A',
        enabled: booleanEnv('FLOW_LIVE_BIG_WINNER_PBR_A_X50_15_ENABLED', true),
        // Keep the definition loaded for history and already-open exits, but a stale
        // server .env must not reopen this loss-making live cohort.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_BIG_WINNER_PBR_A_X50_15_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_BIG_WINNER_PBR_A_X50_15_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_BIG_WINNER_PBR_A_X50_15_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_BIG_WINNER_PBR_A_X50_15_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'PBR_CORE_RUNNER',
        hardStopPct: 15,
        coreActivationPct: 20,
        coreExitPct: 50,
        trailingActivationPct: 30,
        baseTrailingDrawdownPct: 15,
        trailingTiers: [
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
        ],
        maxHoldMs: 180_000,
        sourceShadowCohortId: 'PBR_A:X50_15',
      },
      {
        id: 'migrated_gfr_300_hs20_h30_live',
        code: 'GFR-300-HS20-H30',
        label: 'Lifecycle Drop/Rebound G · GFR_300 30秒尾仓',
        ruleVersion: 'migrated_gfr_300_hs20_h30_live_v1',
        signalSource: 'MIGRATED_GFR_300_CONFIRMED',
        enabled: booleanEnv('FLOW_LIVE_MIGRATED_GFR_300_V2_ENABLED', true),
        // Historical rows and already-open exits remain available, but new
        // entries are hard-locked off after the negative live/RUG sample.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv('FLOW_LIVE_MIGRATED_GFR_300_V2_POSITION_SOL', 0.1),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATED_GFR_300_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GFR_300_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GFR_300_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'TAIL',
        hardStopPct: 20,
        maxHoldMs: 30_000,
        sourceShadowCohortId: 'POST_GFR_300_GFR_HS20_H30_C10',
      },
      {
        id: 'migrated_ge30_r23_f2_only_g2_xleg_live',
        requireChainTimestamp: true,
        requireEntrySlot: true,
        code: 'POST-GE30-R23-F2-G2-XLEG',
        label: 'Lifecycle Drop/Rebound G · 第二次机会 XLEG',
        ruleVersion: 'migrated_ge30_r23_f2_only_g2_xleg_live_v2',
        signalSource: 'MIGRATED_GE30_R23_F2_ONLY_G2_XLEG',
        enabled: booleanEnv('FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_ENABLED', true),
        // User-paused 2026-09-05. Ignore stale ENTRY_ENABLED=true; preserve exits.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        // The latest overlapping 24h sample was sharply negative from
        // 00:00-04:00 Beijing and positive outside it. Keep this scoped to
        // this live rule; its source Shadow remains an all-day control.
        entryBeijingStartHour: integerEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_ENTRY_BEIJING_START_HOUR',
          4,
          { min: 0, max: 24 },
        ),
        entryBeijingEndHour: integerEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_ENTRY_BEIJING_END_HOUR',
          24,
          { min: 0, max: 24 },
        ),
        // Error 6040 is a stale AMM quote, not a strategy-rule rejection.
        // One immediate fresh quote is allowed while the original 15% price
        // guard, self-impact guard and signal-age bound still apply.
        entryQuoteRefreshRetryCount: integerEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_QUOTE_REFRESH_RETRY_COUNT',
          1,
          { min: 0, max: 1 },
        ),
        entryQuoteRefreshMaxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_QUOTE_REFRESH_MAX_SIGNAL_AGE_MS',
          2_500,
          { min: 100, max: 10_000 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'LEGACY',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_HARD_STOP_PCT',
          20,
          { min: 0.1, max: 100 },
        ),
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
        maxHoldMs: 15_000,
        sourceShadowCohortId: 'POST_GE30_R23_F2_ONLY_G2_XLEG',
      },
      {
        id: 'migrated_grt_r23_f3_v2_xleg_live',
        requireChainTimestamp: true,
        requireEntrySlot: true,
        code: 'GRT-R23-F3-V2-XLEG',
        label: 'Lifecycle Drop/Rebound G · GRT前三次机会前向 XLEG',
        ruleVersion: 'migrated_grt_r23_f3_v2_xleg_live_v2',
        signalSource: 'MIGRATED_GRT_R23_F3_V2_XLEG',
        enabled: booleanEnv('FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG_ENABLED', true),
        // User-paused 2026-09-05. Ignore stale ENTRY_ENABLED=true; preserve exits.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        entryQuoteRefreshRetryCount: integerEnv(
          'FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG_QUOTE_REFRESH_RETRY_COUNT',
          1,
          { min: 0, max: 1 },
        ),
        entryQuoteRefreshMaxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG_QUOTE_REFRESH_MAX_SIGNAL_AGE_MS',
          2_500,
          { min: 100, max: 10_000 },
        ),
        // Daily live evidence showed two near-simultaneous fills for the same
        // strategy/Mint. Keep the three signal opportunities in Shadow, but
        // never compound them with real capital.
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'LEGACY',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GRT_R23_F3_V2_XLEG_HARD_STOP_PCT',
          20,
          { min: 0.1, max: 100 },
        ),
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
        maxHoldMs: 15_000,
        sourceShadowCohortId: 'POST_GRT_R23_F3_V2_GRT_F3_XLEG_V2',
      },
      {
        id: 'migrated_ge30_d25_32_r24_f1_exec01_v2_r2_h15_live',
        code: 'G-V2-EXEC01-R2-H15',
        label: 'Lifecycle Drop/Rebound G · V2可执行0.1 SOL / R2-H15（停止新开仓）',
        ruleVersion: 'migrated_ge30_d25_32_r24_f1_exec01_v2_r2_h15_live_v1',
        signalSource: 'MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15',
        enabled: booleanEnv(
          'FLOW_LIVE_MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15_ENABLED',
          true,
        ),
        // Keep the definition loaded for historical display and management of
        // already-open positions, but permanently stop new entries. This is a
        // code-level lock so a stale deployment environment cannot reopen it.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        entryQuoteRefreshRetryCount: integerEnv(
          'FLOW_LIVE_MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15_QUOTE_REFRESH_RETRY_COUNT',
          1,
          { min: 0, max: 1 },
        ),
        entryQuoteRefreshMaxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15_QUOTE_REFRESH_MAX_SIGNAL_AGE_MS',
          2_500,
          { min: 100, max: 10_000 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15_MAX_ENTRY_JUMP_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'RISK_XLEG',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct: 15,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 2_000,
        lossCheckRecoveryPct: 1,
        maxHoldMs: 15_000,
        sourceShadowCohortId: 'POST_GE30_D25_32_R24_F1_EXEC1_V2_R2_H15_0_1SOL',
      },
      {
        id: 'migrated_gd25_35_x8_live',
        code: 'POST-GD25-35-X8',
        label: 'Lifecycle Drop/Rebound G · GD25-35 固定8秒',
        ruleVersion: 'migrated_gd25_35_x8_live_v1',
        signalSource: 'MIGRATED_GD25_35_X8',
        enabled: booleanEnv('FLOW_LIVE_MIGRATED_GD25_35_X8_ENABLED', true),
        entryEnabled: booleanEnv('FLOW_LIVE_MIGRATED_GD25_35_X8_ENTRY_ENABLED', true),
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv('FLOW_LIVE_MIGRATED_GD25_35_X8_POSITION_SOL', 0.1),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATED_GD25_35_X8_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GD25_35_X8_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_MIGRATED_GD25_35_X8_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 8_000,
        maxHoldMs: 8_000,
        sourceShadowCohortId: 'POST_GD25_35_X8',
      },
      {
        id: 'migration_continuity_mc_c5_t12_5_live',
        code: 'M-C5-T12.5',
        label: 'Migration Continuity M · 10秒保护 / T12.5',
        ruleVersion: 'migration_continuity_mc_c5_t12_5_live_v1',
        signalSource: 'MIGRATION_CONTINUITY_MC_C5_T12_5',
        enabled: booleanEnv('FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_T12_5_ENABLED', true),
        // Keep historical rows and already-open exits available, but do not let
        // a stale production .env reopen the currently negative live cohort.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_T12_5_V2_POSITION_SOL',
          0.5,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_T12_5_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_T12_5_MAX_ENTRY_JUMP_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_T12_5_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'TRAILING',
        minHoldMs: 10_000,
        trailingActivationPct: 15,
        trailingStopPct: 12.5,
        hardStopPct: 20,
        maxHoldMs: 180_000,
        sourceShadowCohortId: 'MC_C5_T12_5',
      },
      {
        id: 'graduation_accel_o90_m5_stair120_live',
        code: 'O90-M5-STAIR120',
        label: 'Graduation Acceleration O · O90 M5 STAIR120',
        ruleVersion: 'graduation_accel_o90_m5_stair120_live_v1',
        signalSource: 'GRADUATION_ACCEL_O90_M5_STAIR120',
        enabled: booleanEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_V4_ENABLED',
          true,
        ),
        entryEnabled: booleanEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_V4_ENTRY_ENABLED',
          true,
        ),
        market: 'PUMP_BONDING_CURVE',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_V4_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 1_000 },
        ),
        exitMode: 'GRADUATION_CORE_RUNNER',
        hardStopPct: 30,
        coreExitPct: 50,
        maxPreGraduationHoldMs: 5 * 60_000,
        maxPostGraduationHoldMs: 120_000,
        maxHoldMs: 5 * 60_000,
        postMigrationGate: {
          windowMs: 5_000,
          minBuyers: 25,
          minNetFlowSol: 0,
        },
        trailingTiers: [
          { activationPct: 20, drawdownPct: 10 },
          { activationPct: 40, drawdownPct: 15 },
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
          { activationPct: 300, drawdownPct: 30 },
        ],
        sourceShadowCohortId: 'O90_M5_STAIR120:C10',
      },
      {
        id: 'migration_continuity_mc_c5_e120_live',
        code: 'M-C5-E120',
        label: 'Migration Continuity M · 固定120秒',
        ruleVersion: 'migration_continuity_mc_c5_e120_live_v1',
        signalSource: 'MIGRATION_CONTINUITY_MC_C5',
        enabled: booleanEnv('FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_E120_ENABLED', true),
        // Historical display and already-open exits stay loaded, but this rule
        // is no longer allowed to create a new live position.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_E120_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_E120_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_E120_MAX_ENTRY_JUMP_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_E120_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 120_000,
        hardStopPct: 20,
        maxHoldMs: 120_000,
      },
      {
        id: 'quality_leader_ql_strict_protected_live',
        code: 'QL-STRICT-PR',
        label: 'Quality Leader QL Strict · Protected Runner',
        ruleVersion: 'quality_leader_ql_strict_protected_live_v1',
        signalSource: 'QUALITY_LEADER_QL_STRICT_PROTECTED',
        enabled: booleanEnv('FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_ENABLED', true),
        // Historical rows and already-open exits remain visible, but stale
        // production .env values must not reopen a strategy whose realised
        // RUG losses diverged materially from its mark-price Shadow results.
        entryEnabled: false,
        market: 'PUMP_BONDING_CURVE',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_MAX_ENTRY_JUMP_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxShadowEntryImpactPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_MAX_SHADOW_IMPACT_PCT',
          12,
          { min: 0, max: 100 },
        ),
        exitMode: 'QUALITY_PROTECTED_RUNNER',
        hardStopPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_HARD_STOP_PCT',
          20,
          { min: 0.1, max: 100 },
        ),
        strengthActivationPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_STRENGTH_PCT',
          20,
          { min: 0.1, max: 1_000 },
        ),
        noStrengthMs: integerEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_NO_STRENGTH_MS',
          30_000,
          { min: 1_000, max: 5 * 60_000 },
        ),
        maxHoldMs: integerEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_MAX_HOLD_MS',
          5 * 60_000,
          { min: 10_000, max: 30 * 60_000 },
        ),
        protectedFloors: [
          { activationPct: 20, minFloorPct: 0, peakGivebackPct: 15 },
          { activationPct: 50, minFloorPct: 15, peakGivebackPct: 25 },
          { activationPct: 100, minFloorPct: 40, peakGivebackPct: 40 },
          { activationPct: 200, minFloorPct: 100, peakGivebackPct: 80 },
        ],
        qualityCriteria: {
          minReturn10Pct: 140,
          maxDrawdown20Pct: 12,
          minBuyerDelta: 8,
          minNetFlowDeltaSol: 3,
          minRetentionPct: 80,
          maxCreatorSharePct: 3,
          minCurvePct: 55,
          maxCurvePct: 90,
          maxSellBuyRatio: 0.55,
          minVirtualSolReserves: 30,
        },
      },
      {
        id: 'quality_leader_ql_strict_guard_protected_live',
        code: 'QL-STRICT-GUARD',
        label: 'Quality Leader QL Strict Guard · Protected Runner',
        ruleVersion: 'quality_leader_ql_strict_guard_protected_live_v1',
        signalSource: 'QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED',
        enabled: booleanEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_ENABLED',
          true,
        ),
        entryEnabled: booleanEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_ENTRY_ENABLED',
          true,
        ),
        market: 'PUMP_BONDING_CURVE',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_MAX_ENTRY_JUMP_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxShadowEntryImpactPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_MAX_SHADOW_IMPACT_PCT',
          12,
          { min: 0, max: 100 },
        ),
        exitMode: 'QUALITY_PROTECTED_RUNNER',
        hardStopPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_HARD_STOP_PCT',
          20,
          { min: 0.1, max: 100 },
        ),
        strengthActivationPct: numberEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_STRENGTH_PCT',
          20,
          { min: 0.1, max: 1_000 },
        ),
        noStrengthMs: integerEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_NO_STRENGTH_MS',
          30_000,
          { min: 1_000, max: 5 * 60_000 },
        ),
        maxHoldMs: integerEnv(
          'FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_MAX_HOLD_MS',
          5 * 60_000,
          { min: 10_000, max: 30 * 60_000 },
        ),
        protectedFloors: [
          { activationPct: 20, minFloorPct: 0, peakGivebackPct: 15 },
          { activationPct: 50, minFloorPct: 15, peakGivebackPct: 25 },
          { activationPct: 100, minFloorPct: 40, peakGivebackPct: 40 },
          { activationPct: 200, minFloorPct: 100, peakGivebackPct: 80 },
        ],
        qualityCriteria: {
          minReturn10Pct: 140,
          maxDrawdown20Pct: 12,
          minBuyerDelta: 8,
          minNetFlowDeltaSol: 3,
          minRetentionPct: 80,
          maxCreatorSharePct: 3,
          minCurvePct: 55,
          maxCurvePct: 90,
          maxSellBuyRatio: 0.55,
          minVirtualSolReserves: 30,
          requireHealthyRugRisk: true,
        },
        sourceShadowCohortId: 'QL_STRICT_GUARD:QL_PROTECTED',
      },
      {
        id: 'launch_pullback_fo_rb10_30s_live',
        code: 'F-FO-RB10-X30',
        label: 'Launch Pullback F · FO-RB10 固定30秒',
        ruleVersion: 'launch_pullback_fo_rb10_30s_live_v1',
        signalSource: 'LAUNCH_PULLBACK_FO_RB10_30S',
        enabled: booleanEnv('FLOW_LIVE_LAUNCH_PULLBACK_FO_RB10_30S_ENABLED', true),
        // Retain the strategy definition for historical display and safe exit
        // handling, but prevent an older production .env from reopening it.
        entryEnabled: false,
        market: 'PUMP_BONDING_CURVE',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_LAUNCH_PULLBACK_FO_RB10_30S_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_LAUNCH_PULLBACK_FO_RB10_30S_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_LAUNCH_PULLBACK_FO_RB10_30S_MAX_ENTRY_JUMP_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_LAUNCH_PULLBACK_FO_RB10_30S_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 30_000,
        hardStopPct: 0,
        maxHoldMs: 30_000,
        sourceShadowCohortId: 'FO_RB10_30S',
      },
      {
        id: 'graduation_accel_o_c80_d5_b2_s0_nc_live',
        code: 'O-C80-D5-B2-S0-NC',
        label: 'Graduation Acceleration O · Curve80 D5 B2 S0 NC',
        ruleVersion: 'graduation_accel_o_c80_d5_b2_s0_nc_live_v4',
        signalSource: 'GRADUATION_ACCEL_O_C80_D5_B2_S0_NC',
        // Exact strategy keys prevent an old Curve80 canary setting from
        // silently changing this promoted rule's enablement.
        enabled: booleanEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_ENABLED',
          true,
        ),
        entryEnabled: booleanEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_ENTRY_ENABLED',
          true,
        ),
        market: 'PUMP_BONDING_CURVE',
        positionSizeSol: livePositionEnv(
          // V3 deliberately bypasses the previous server-side V2=0.5 value.
          // Shadow remains 1 SOL; only the real order size returns to 0.1 SOL.
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_V3_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 1_000 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'GRADUATION_CORE_RUNNER',
        hardStopPct: 30,
        coreExitPct: 50,
        maxPreGraduationHoldMs: 5 * 60_000,
        maxPostGraduationHoldMs: 5 * 60_000,
        maxHoldMs: 5 * 60_000,
        trailingTiers: [
          { activationPct: 20, drawdownPct: 10 },
          { activationPct: 40, drawdownPct: 15 },
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
          { activationPct: 300, drawdownPct: 30 },
        ],
        sourceShadowCohortId: 'O_C80_D5_B2_S0_NC:1SOL',
      },
      {
        id: 'graduation_accel_o_c80_p500_stair240_live',
        code: 'O-C80-P500-STAIR240',
        label: 'Graduation Acceleration O · Curve80持续500ms / 全仓阶梯尾仓240秒',
        ruleVersion: 'graduation_accel_o_c80_p500_stair240_live_v1',
        signalSource: 'GRADUATION_ACCEL_O_C80_P500_STAIR240',
        enabled: booleanEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_P500_STAIR240_ENABLED',
          true,
        ),
        // Code-locked after the negative live sample (including repeated
        // curve-complete failures and a -92.77% tail). Keep the definition
        // loaded so existing positions can still exit and history remains
        // visible, while stale production environment values cannot reopen it.
        entryEnabled: false,
        market: 'PUMP_BONDING_CURVE',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_P500_STAIR240_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_P500_STAIR240_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_P500_STAIR240_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 1_000 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_P500_STAIR240_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'GRADUATION_CORE_RUNNER',
        hardStopPct: 30,
        coreExitPct: 0,
        maxPreGraduationHoldMs: 5 * 60_000,
        maxPostGraduationHoldMs: 240_000,
        maxHoldMs: 5 * 60_000,
        trailingTiers: [
          { activationPct: 20, drawdownPct: 10 },
          { activationPct: 40, drawdownPct: 15 },
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
          { activationPct: 300, drawdownPct: 30 },
        ],
        sourceShadowCohortId: 'O_C80_P500_STAIR240:1SOL',
      },
      {
        // New experiment ID: do not mix the historical disabled recovery
        // strategy (1 SOL shadow source) with the audited 0.1 SOL cohort.
        id: 'graduation_accel_o_c80_ho500_x60_live',
        requireChainTimestamp: true,
        requireEntrySlot: true,
        requireSignalPool: true,
        code: 'O-C80-HO500-X60',
        label: 'Graduation O · 毕业后500ms接入 / 固定60秒 / 0.1 SOL',
        ruleVersion: 'graduation_accel_o_c80_ho500_x60_live_v2',
        signalSource: 'GRADUATION_ACCEL_O_C80_HO500_X60',
        enabled: booleanEnv('FLOW_LIVE_GRADUATION_ACCEL_HO500_X60_ENABLED', true),
        // Exit research continues in Shadow. Existing live positions still exit.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: 0.1,
        maxSignalAgeMs: 1_500,
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: 15,
        maxEntryPriceDropPct: 15,
        maxEntrySelfImpactPct: 10,
        maxShadowEntryImpactPct: 10,
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 60_000,
        hardStopPct: 30,
        maxHoldMs: 60_000,
        sourceShadowCohortId: 'O_C80_HO500_X60_POSTV1:0_1SOL',
      },
      {
        id: 'graduation_accel_o_c80_ho500_x60_recovery_live',
        code: 'O-C80-HO500-X60-R',
        label: 'Graduation Acceleration O · PumpSwap 500ms Recovery',
        ruleVersion: 'graduation_accel_o_c80_ho500_x60_recovery_live_v1',
        signalSource: 'GRADUATION_ACCEL_O_C80_HO500_X60_RECOVERY',
        enabled: booleanEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_HO500_X60_RECOVERY_ENABLED',
          true,
        ),
        // Code-locked after the negative live sample. Keep the strategy loaded
        // only for historical display and any outstanding position exit; a
        // stale server .env must not reopen new entries.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_HO500_X60_RECOVERY_POSITION_SOL',
          0.1,
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_HO500_X60_RECOVERY_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_HO500_X60_RECOVERY_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 1_000 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_HO500_X60_RECOVERY_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxShadowEntryImpactPct: numberEnv(
          'FLOW_LIVE_GRADUATION_ACCEL_O_C80_HO500_X60_RECOVERY_MAX_SHADOW_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 60_000,
        hardStopPct: 30,
        maxHoldMs: 60_000,
        sourceShadowCohortId: 'O_C80_HO500_X60:1SOL',
      },
      {
        id: 'post_gd20_35_r1_5_5_age60_xleg_v3',
        code: 'G20-35-R1.5-A60-V3',
        label: '毕业后宽幅深跌反弹 · XLEG-V3（停止新开仓）',
        ruleVersion: 'post_migration_age60_drop20_35_rebound1_5_5_xleg_v3',
        enabled: booleanEnv('FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_ENABLED', true),
        // Keep the strategy loaded so an already-open position still receives
        // its original exit management after an upgrade. New entries remain
        // off unless an operator explicitly re-enables this exact rule.
        entryEnabled: booleanEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_ENTRY_ENABLED',
          false,
        ),
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_POSITION_SOL',
          0.1,
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_POSITION_SOL',
        ),
        trackingAgeMs: integerEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_TRACKING_MS',
          60_000,
          { min: 10_000, max: 10 * 60_000 },
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        windowMs: integerEnv('FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_WINDOW_MS', 1_000, {
          min: 250,
        }),
        dropMinPct: numberEnv('FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_DROP_MIN_PCT', 20, {
          min: 0.1,
        }),
        dropMaxPct: numberEnv('FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_DROP_MAX_PCT', 35, {
          min: 0.1,
        }),
        reboundMinPct: numberEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_REBOUND_MIN_PCT',
          1.5,
          { min: 0.1 },
        ),
        reboundMaxPct: numberEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_REBOUND_MAX_PCT',
          5,
          { min: 0.1 },
        ),
        reboundTimeoutMs: integerEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_REBOUND_TIMEOUT_MS',
          1_000,
          { min: 100 },
        ),
        maxEntriesPerMint: integerEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_MAX_ENTRIES_PER_MINT',
          1,
          { min: 1, max: 10 },
        ),
        reentryCooldownMs: integerEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_REENTRY_COOLDOWN_MS',
          1_000,
          { min: 0, max: 10 * 60_000 },
        ),
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_MAX_ENTRY_JUMP_PCT',
          3,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        trailingActivationPct: numberEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_TRAILING_ACTIVATION_PCT',
          8,
          { min: 0.1 },
        ),
        trailingStopPct: numberEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_TRAILING_STOP_PCT',
          3,
          { min: 0.1, max: 100 },
        ),
        fastTakeProfitPct: numberEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_FAST_TP_PCT',
          18,
          { min: 0 },
        ),
        fastTakeProfitWindowMs: integerEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_FAST_TP_WINDOW_MS',
          5_000,
          { min: 0 },
        ),
        lossCheckAtMs: integerEnv(
          'FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_LOSS_CHECK_MS',
          6_000,
          { min: 0 },
        ),
        maxHoldMs: integerEnv('FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_MAX_HOLD_MS', 15_000, {
          min: 1_000,
        }),
      },
      {
        id: 'post_gd25_32_r2_4_age30_xleg_v2',
        code: 'G25-32-R2-4-A30-V2',
        label: '毕业后精选深跌反弹 · XLEG-V2（停止新开仓）',
        ruleVersion: 'post_migration_age30_drop25_32_rebound2_4_xleg_v2',
        enabled: booleanEnv('FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_ENABLED', true),
        // Preserve historical statistics and exit behavior without mixing new
        // V3 entries into the narrow V2 sample.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_POSITION_SOL',
          0.1,
          'FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL',
        ),
        trackingAgeMs: integerEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_TRACKING_MS',
          30_000,
          { min: 10_000, max: 10 * 60_000 },
        ),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        windowMs: integerEnv('FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_WINDOW_MS', 1_000, {
          min: 250,
        }),
        dropMinPct: numberEnv('FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_DROP_MIN_PCT', 25, {
          min: 0.1,
        }),
        dropMaxPct: numberEnv('FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_DROP_MAX_PCT', 32, {
          min: 0.1,
        }),
        reboundMinPct: numberEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_REBOUND_MIN_PCT',
          2,
          { min: 0.1 },
        ),
        reboundMaxPct: numberEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_REBOUND_MAX_PCT',
          4,
          { min: 0.1 },
        ),
        reboundTimeoutMs: integerEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_REBOUND_TIMEOUT_MS',
          1_000,
          { min: 100 },
        ),
        maxEntriesPerMint: integerEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_MAX_ENTRIES_PER_MINT',
          1,
          { min: 1, max: 10 },
        ),
        reentryCooldownMs: integerEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_REENTRY_COOLDOWN_MS',
          1_000,
          { min: 0, max: 10 * 60_000 },
        ),
        // Market movement and the strategy's own 1-SOL price impact are independent
        // guards. PumpSwap virtual quote reserves are included in both spot prices.
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_MAX_ENTRY_JUMP_PCT',
          3,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        trailingActivationPct: numberEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_TRAILING_ACTIVATION_PCT',
          8,
          { min: 0.1 },
        ),
        trailingStopPct: numberEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_TRAILING_STOP_PCT',
          3,
          { min: 0.1, max: 100 },
        ),
        fastTakeProfitPct: numberEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_FAST_TP_PCT',
          18,
          { min: 0 },
        ),
        fastTakeProfitWindowMs: integerEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_FAST_TP_WINDOW_MS',
          5_000,
          { min: 0 },
        ),
        lossCheckAtMs: integerEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_LOSS_CHECK_MS',
          6_000,
          { min: 0 },
        ),
        maxHoldMs: integerEnv('FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_MAX_HOLD_MS', 15_000, {
          min: 1_000,
        }),
      },
      {
        id: 'post_gd25_35_f1_xleg_live_v1',
        code: 'GD25-35-F1-XLEG',
        label: '毕业后深跌反弹 · GD25 F1 XLEG',
        ruleVersion: 'post_migration_gd25_35_first_xleg_live_v1',
        enabled: booleanEnv('FLOW_LIVE_POST_GD25_35_F1_XLEG_ENABLED', true),
        // Preserve the complete live sample and any outstanding exit handling,
        // while permanently stopping new entries for this version.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_POSITION_SOL',
          0.1,
          'FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL',
        ),
        trackingAgeMs: integerEnv('FLOW_LIVE_POST_GD25_35_F1_XLEG_TRACKING_MS', 120_000, {
          min: 30_000,
          max: 10 * 60_000,
        }),
        maxSignalAgeMs: integerEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_MAX_SIGNAL_AGE_MS',
          1_500,
          { min: 100 },
        ),
        windowMs: integerEnv('FLOW_LIVE_POST_GD25_35_F1_XLEG_WINDOW_MS', 1_000, {
          min: 250,
        }),
        dropMinPct: numberEnv('FLOW_LIVE_POST_GD25_35_F1_XLEG_DROP_MIN_PCT', 25, {
          min: 0.1,
        }),
        dropMaxPct: numberEnv('FLOW_LIVE_POST_GD25_35_F1_XLEG_DROP_MAX_PCT', 35, {
          min: 0.1,
        }),
        reboundMinPct: numberEnv('FLOW_LIVE_POST_GD25_35_F1_XLEG_REBOUND_MIN_PCT', 2, {
          min: 0.1,
        }),
        reboundMaxPct: numberEnv('FLOW_LIVE_POST_GD25_35_F1_XLEG_REBOUND_MAX_PCT', 5, {
          min: 0.1,
        }),
        reboundTimeoutMs: integerEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_REBOUND_TIMEOUT_MS',
          1_000,
          { min: 100 },
        ),
        // This is the promoted form of the offline "first row per Mint" result.
        // A matched opportunity is consumed even if execution is later rejected
        // or fails, so later rebounds cannot silently change the tested sample.
        maxSignalsPerMint: 1,
        maxEntriesPerMint: 1,
        reentryCooldownMs: 0,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_MAX_ENTRY_JUMP_PCT',
          10,
          { min: 0, max: 100 },
        ),
        maxEntrySelfImpactPct: numberEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_MAX_ENTRY_SELF_IMPACT_PCT',
          10,
          { min: 0, max: 100 },
        ),
        trailingActivationPct: numberEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_TRAILING_ACTIVATION_PCT',
          8,
          { min: 0.1 },
        ),
        trailingStopPct: numberEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_TRAILING_STOP_PCT',
          3,
          { min: 0.1, max: 100 },
        ),
        fastTakeProfitPct: numberEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_FAST_TP_PCT',
          18,
          { min: 0 },
        ),
        fastTakeProfitWindowMs: integerEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_FAST_TP_WINDOW_MS',
          5_000,
          { min: 0 },
        ),
        lossCheckAtMs: integerEnv(
          'FLOW_LIVE_POST_GD25_35_F1_XLEG_LOSS_CHECK_MS',
          6_000,
          { min: 0 },
        ),
        maxHoldMs: integerEnv('FLOW_LIVE_POST_GD25_35_F1_XLEG_MAX_HOLD_MS', 15_000, {
          min: 1_000,
        }),
      },
      {
        id: 'post_gd25_35_xleg',
        code: 'GD25-35-XLEG-V1',
        label: '毕业后深跌反弹 · XLEG（旧版停止新开仓）',
        ruleVersion: 'post_migration_gd25_35_xleg_reentry2_v2',
        enabled: true,
        // Keep the definition loaded so historical rows stay visible and any
        // legacy active position still has its original exit rules after restart.
        entryEnabled: false,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv('FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL', 0.1),
        trackingAgeMs: integerEnv('FLOW_LIVE_POST_GD25_35_TRACKING_MS', 120_000, {
          min: 30_000,
          max: 10 * 60_000,
        }),
        maxSignalAgeMs: integerEnv('FLOW_LIVE_POST_GD25_35_MAX_SIGNAL_AGE_MS', 1_500, {
          min: 100,
        }),
        windowMs: integerEnv('FLOW_LIVE_POST_GD25_35_WINDOW_MS', 1_000, { min: 250 }),
        dropMinPct: numberEnv('FLOW_LIVE_POST_GD25_35_DROP_MIN_PCT', 25, { min: 0.1 }),
        dropMaxPct: numberEnv('FLOW_LIVE_POST_GD25_35_DROP_MAX_PCT', 35, { min: 0.1 }),
        reboundMinPct: numberEnv('FLOW_LIVE_POST_GD25_35_REBOUND_MIN_PCT', 2, { min: 0.1 }),
        reboundMaxPct: numberEnv('FLOW_LIVE_POST_GD25_35_REBOUND_MAX_PCT', 5, { min: 0.1 }),
        reboundTimeoutMs: integerEnv('FLOW_LIVE_POST_GD25_35_REBOUND_TIMEOUT_MS', 1_000, {
          min: 100,
        }),
        maxEntriesPerMint: integerEnv(
          'FLOW_LIVE_POST_GD25_35_MAX_ENTRIES_PER_MINT',
          2,
          { min: 1, max: 10 },
        ),
        reentryCooldownMs: integerEnv(
          'FLOW_LIVE_POST_GD25_35_REENTRY_COOLDOWN_MS',
          1_000,
          { min: 0, max: 10 * 60_000 },
        ),
        maxEntryPriceJumpPct: numberEnv('FLOW_LIVE_POST_GD25_35_MAX_ENTRY_JUMP_PCT', 15, {
          min: 0,
          max: 100,
        }),
        trailingActivationPct: numberEnv('FLOW_LIVE_POST_GD25_35_TRAILING_ACTIVATION_PCT', 8, {
          min: 0.1,
        }),
        trailingStopPct: numberEnv('FLOW_LIVE_POST_GD25_35_TRAILING_STOP_PCT', 3, {
          min: 0.1,
          max: 100,
        }),
        fastTakeProfitPct: numberEnv('FLOW_LIVE_POST_GD25_35_FAST_TP_PCT', 18, { min: 0 }),
        fastTakeProfitWindowMs: integerEnv('FLOW_LIVE_POST_GD25_35_FAST_TP_WINDOW_MS', 5_000, {
          min: 0,
        }),
        lossCheckAtMs: integerEnv('FLOW_LIVE_POST_GD25_35_LOSS_CHECK_MS', 6_000, { min: 0 }),
        maxHoldMs: integerEnv('FLOW_LIVE_POST_GD25_35_MAX_HOLD_MS', 15_000, {
          min: 1_000,
        }),
      },
    ],
  },

  // Research-only execution path. It never creates or signs a transaction.
  signalShadow: {
    enabled: retiredShadowsEnabled && booleanEnv('FLOW_SIGNAL_SHADOW_ENABLED', false),
    profiles: primaryThresholdProfiles,
    positionSizeSol: shadowPositionEnv('FLOW_SIGNAL_SHADOW_POSITION_SOL'),
    maxSignalAgeMs: integerEnv('FLOW_SIGNAL_SHADOW_MAX_SIGNAL_AGE_MS', 1_500, { min: 100 }),
    entryDelayMs: integerEnv('FLOW_SIGNAL_SHADOW_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SIGNAL_SHADOW_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SIGNAL_SHADOW_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SIGNAL_SHADOW_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_SIGNAL_SHADOW_MAX_ENTRY_JUMP_PCT', 10, {
      min: 0,
      max: 100,
    }),
    trailingStopPct: numberEnv('FLOW_SIGNAL_SHADOW_TRAILING_STOP_PCT', 7.5, {
      min: 0.1,
      max: 100,
    }),
    maxHoldMs: integerEnv('FLOW_SIGNAL_SHADOW_MAX_HOLD_MS', 60_000, { min: 1_000 }),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SIGNAL_SHADOW_POSITION_SOL'),
    }),
  },

  // Direct Primary Flow research. Each 30-second signal episode is simulated once
  // per exit cohort; all cohorts share the same 200ms-delayed market fill.
  flowFirstShadow: {
    enabled: retiredShadowsEnabled && booleanEnv('FLOW_FIRST_SHADOW_ENABLED', false),
    signalVariant: 'primary_3w',
    episodeGapMs: 30_000,
    positionSizeSol: shadowPositionEnv('FLOW_FIRST_SHADOW_POSITION_SOL'),
    maxSignalAgeMs: integerEnv('FLOW_FIRST_SHADOW_MAX_SIGNAL_AGE_MS', 1_500, { min: 100 }),
    entryDelayMs: integerEnv('FLOW_FIRST_SHADOW_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_FIRST_SHADOW_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_FIRST_SHADOW_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_FIRST_SHADOW_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxHoldMs: integerEnv('FLOW_FIRST_SHADOW_MAX_HOLD_MS', 60_000, { min: 1_000 }),
    bigWinnerPct: numberEnv('FLOW_FIRST_SHADOW_BIG_WINNER_PCT', 50, { min: 1 }),
    cohorts: [
      {
        id: 'C5',
        label: 'C5 固定持有5秒',
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_FIRST_SHADOW_FIXED_HOLD_MS', 5_000, { min: 250 }),
      },
      {
        id: 'C75',
        label: 'C7.5 峰值回撤7.5%',
        exitMode: 'TRAILING',
        trailingStopPct: numberEnv('FLOW_FIRST_SHADOW_C75_TRAILING_STOP_PCT', 7.5, {
          min: 0.1,
          max: 100,
        }),
      },
      {
        id: 'C125',
        label: 'C12.5 峰值回撤12.5%',
        exitMode: 'TRAILING',
        trailingStopPct: numberEnv('FLOW_FIRST_SHADOW_C125_TRAILING_STOP_PCT', 12.5, {
          min: 0.1,
          max: 100,
        }),
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_FIRST_SHADOW_POSITION_SOL'),
    }),
  },

  // Smart Wallet pullback A/B research. This path only records simulated
  // positions and never owns an executor or signing key.
  smartPullbackShadow: {
    enabled: booleanEnv('FLOW_SMART_PULLBACK_SHADOW_ENABLED', false),
    minSmartBuySol: numberEnv('FLOW_SMART_PULLBACK_MIN_BUY_SOL', 0.1, { min: 0.000001 }),
    episodeGapMs: integerEnv('FLOW_SMART_PULLBACK_EPISODE_GAP_MS', 30_000, { min: 1_000 }),
    confirmationWindowMs: integerEnv(
      'FLOW_SMART_PULLBACK_CONFIRMATION_WINDOW_MS',
      15_000,
      { min: 1_000 },
    ),
    pullbackPct: numberEnv('FLOW_SMART_PULLBACK_DRAWDOWN_PCT', 2.5, {
      min: 0.1,
      max: 100,
    }),
    reboundPct: numberEnv('FLOW_SMART_PULLBACK_REBOUND_PCT', 7.5, {
      min: 0.1,
      max: 500,
    }),
    minReboundBuyers: integerEnv('FLOW_SMART_PULLBACK_MIN_REBOUND_BUYERS', 1, { min: 1 }),
    maxEntryVsSmartBuyPct: numberEnv('FLOW_SMART_PULLBACK_MAX_ENTRY_VS_SMART_PCT', 2, {
      min: 0,
      max: 100,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_SMART_PULLBACK_MAX_CONFIRM_JUMP_PCT', 10, {
      min: 0,
      max: 100,
    }),
    positionSizeSol: shadowPositionEnv('FLOW_SMART_PULLBACK_POSITION_SOL'),
    entryDelayMs: integerEnv('FLOW_SMART_PULLBACK_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SMART_PULLBACK_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SMART_PULLBACK_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SMART_PULLBACK_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxHoldMs: integerEnv('FLOW_SMART_PULLBACK_MAX_HOLD_MS', 60_000, { min: 1_000 }),
    bigWinnerPct: numberEnv('FLOW_SMART_PULLBACK_BIG_WINNER_PCT', 50, { min: 1 }),
    cohorts: [
      {
        id: 'A',
        label: 'A · Trailing 7.5%',
        trailingStopPct: numberEnv('FLOW_SMART_PULLBACK_A_TRAILING_STOP_PCT', 7.5, {
          min: 0.1,
          max: 100,
        }),
      },
      {
        id: 'B',
        label: 'B · Trailing 12.5%',
        trailingStopPct: numberEnv('FLOW_SMART_PULLBACK_B_TRAILING_STOP_PCT', 12.5, {
          min: 0.1,
          max: 100,
        }),
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_PULLBACK_POSITION_SOL'),
    }),
  },

  // Isolated true Smart Wallet OPEN research. This path has its own table and
  // never signs or sends a transaction; existing Shadow strategies are unchanged.
  smartOpenShadow: {
    enabled: retiredShadowsEnabled && booleanEnv('FLOW_SMART_OPEN_SHADOW_ENABLED', false),
    minSmartOpenSol: numberEnv('FLOW_SMART_OPEN_SHADOW_MIN_SOL', 1, { min: 0.000001 }),
    preBuyWindowMs: integerEnv('FLOW_SMART_OPEN_SHADOW_PREBUY_WINDOW_MS', 2_000, {
      min: 100,
    }),
    minPreBuyers: integerEnv('FLOW_SMART_OPEN_SHADOW_MIN_PREBUY_BUYERS', 2, { min: 0 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_SMART_OPEN_SHADOW_MAX_ENTRY_JUMP_PCT', 10, {
      min: 0,
      max: 100,
    }),
    positionSizeSol: shadowPositionEnv('FLOW_SMART_OPEN_SHADOW_POSITION_SOL'),
    entryDelayMs: integerEnv('FLOW_SMART_OPEN_SHADOW_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SMART_OPEN_SHADOW_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SMART_OPEN_SHADOW_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SMART_OPEN_SHADOW_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    bigWinnerPct: numberEnv('FLOW_SMART_OPEN_SHADOW_BIG_WINNER_PCT', 50, { min: 1 }),
    cohorts: [
      {
        id: 'D0',
        label: 'D0 · 真OPEN固定5秒',
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_SMART_OPEN_SHADOW_D0_HOLD_MS', 5_000, { min: 250 }),
        followSmartExit: false,
      },
      {
        id: 'D1',
        label: 'D1 · 延迟激活移动止盈',
        exitMode: 'DELAYED_TRAILING',
        hardStopPct: numberEnv('FLOW_SMART_OPEN_SHADOW_D1_HARD_STOP_PCT', 12.5, {
          min: 0.1,
          max: 100,
        }),
        trailingActivationPct: numberEnv(
          'FLOW_SMART_OPEN_SHADOW_D1_TRAILING_ACTIVATION_PCT',
          20,
          { min: 0, max: 1_000 },
        ),
        trailingStopPct: numberEnv('FLOW_SMART_OPEN_SHADOW_D1_TRAILING_STOP_PCT', 15, {
          min: 0.1,
          max: 100,
        }),
        maxHoldMs: integerEnv('FLOW_SMART_OPEN_SHADOW_D1_MAX_HOLD_MS', 60_000, {
          min: 1_000,
        }),
        followSmartExit: false,
      },
      {
        id: 'D2',
        label: 'D2 · 跟随Smart减仓/清仓',
        exitMode: 'SMART_FOLLOW',
        hardStopPct: numberEnv('FLOW_SMART_OPEN_SHADOW_D2_HARD_STOP_PCT', 12.5, {
          min: 0.1,
          max: 100,
        }),
        maxHoldMs: integerEnv('FLOW_SMART_OPEN_SHADOW_D2_MAX_HOLD_MS', 180_000, {
          min: 1_000,
        }),
        followSmartExit: true,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_OPEN_SHADOW_POSITION_SOL'),
    }),
  },

  // Forward-only confirmation research. A Primary Flow signal is only eligible
  // after a monitored wallet opens the same mint; entry is then simulated on
  // the first later Bonding Curve trade. This intentionally does not reuse the
  // retrospective smart_signal_confirmations label as an earlier entry price.
  flowSmartConfirmShadow: {
    // The completed forward sample remained negative. Keep the table/API for
    // historical analysis, but require the explicit proven-negative override
    // before this retired experiment can create more positions.
    enabled: provenNegativeShadowsEnabled
      && booleanEnv('FLOW_SMART_CONFIRM_SHADOW_ENABLED', true),
    positionSizeSol: shadowPositionEnv('FLOW_SMART_CONFIRM_SHADOW_POSITION_SOL'),
    minSmartOpenSol: numberEnv('FLOW_SMART_CONFIRM_SHADOW_MIN_OPEN_SOL', 0.1, { min: 0 }),
    entryDelayMs: integerEnv('FLOW_SMART_CONFIRM_SHADOW_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SMART_CONFIRM_SHADOW_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SMART_CONFIRM_SHADOW_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SMART_CONFIRM_SHADOW_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv(
      'FLOW_SMART_CONFIRM_SHADOW_MAX_ENTRY_JUMP_PCT',
      10,
      { min: 0, max: 100 },
    ),
    bigWinnerPct: numberEnv('FLOW_SMART_CONFIRM_SHADOW_BIG_WINNER_PCT', 50, { min: 1 }),
    cohorts: [
      {
        id: 'L5_F5',
        label: 'L5-F5 · Smart OPEN within 5s / fixed 5s',
        maxConfirmationDelayMs: 5_000,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 5_000,
      },
      {
        id: 'L15_F5',
        label: 'L15-F5 · Smart OPEN within 15s / fixed 5s',
        maxConfirmationDelayMs: 15_000,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 5_000,
      },
      {
        id: 'L5_T15',
        label: 'L5-T15 · Smart OPEN within 5s / trailing 15%',
        maxConfirmationDelayMs: 5_000,
        exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: 10,
        trailingDrawdownPct: 15,
        hardStopPct: 25,
        minHoldMs: 1_000,
        maxHoldMs: 60_000,
      },
      {
        id: 'L15_T20',
        label: 'L15-T20 · Smart OPEN within 15s / trailing 20%',
        maxConfirmationDelayMs: 15_000,
        exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: 20,
        trailingDrawdownPct: 20,
        hardStopPct: 30,
        minHoldMs: 2_000,
        maxHoldMs: 120_000,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_CONFIRM_SHADOW_POSITION_SOL'),
    }),
  },

  // Strictly forward-only public-trade observer. The score describes the
  // low-alternation, one-sided stair-step pattern seen before many direct RUGs.
  // It performs no RPC calls. All entry-capable live and Shadow strategies use
  // the same forward-only guard. Live entry reads memory cache only and fails open.
  preEntryRugRisk: {
    enabled: booleanEnv('FLOW_PRE_ENTRY_RUG_RISK_ENABLED', true),
    windowMs: integerEnv('FLOW_PRE_ENTRY_RUG_RISK_WINDOW_MS', 15_000, { min: 1_000 }),
    stateRetentionMs: integerEnv('FLOW_PRE_ENTRY_RUG_RISK_RETENTION_MS', 60_000, {
      min: 15_000,
    }),
    sweepIntervalMs: integerEnv('FLOW_PRE_ENTRY_RUG_RISK_SWEEP_MS', 5_000, { min: 1_000 }),
    maxEventsPerMint: integerEnv('FLOW_PRE_ENTRY_RUG_RISK_MAX_EVENTS', 256, { min: 32 }),
    cacheMaxAgeMs: integerEnv('FLOW_PRE_ENTRY_RUG_RISK_CACHE_MAX_AGE_MS', 1_000, {
      min: 50, max: 10_000,
    }),
    minTrades: integerEnv('FLOW_PRE_ENTRY_RUG_RISK_MIN_TRADES', 10, { min: 3 }),
    minBuySharePct: numberEnv('FLOW_PRE_ENTRY_RUG_RISK_MIN_BUY_SHARE_PCT', 58, {
      min: 0, max: 100,
    }),
    minConsecutiveBuys: integerEnv('FLOW_PRE_ENTRY_RUG_RISK_MIN_BUY_STREAK', 14, { min: 2 }),
    maxSideAlternationPct: numberEnv('FLOW_PRE_ENTRY_RUG_RISK_MAX_ALTERNATION_PCT', 30, {
      min: 0, max: 100,
    }),
    minUpTickSharePct: numberEnv('FLOW_PRE_ENTRY_RUG_RISK_MIN_UPTICK_PCT', 55, {
      min: 0, max: 100,
    }),
    minReturnPct: numberEnv('FLOW_PRE_ENTRY_RUG_RISK_MIN_RETURN_PCT', 30, { min: 0 }),
    minFlags: integerEnv('FLOW_PRE_ENTRY_RUG_RISK_MIN_FLAGS', 5, { min: 1, max: 5 }),
    verticalFragileMinReturnPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_VERTICAL_MIN_RETURN_PCT', 50, { min: 0 },
    ),
    verticalFragileMinBuyImpactPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_VERTICAL_MIN_BUY_IMPACT_PCT', 10, { min: 0 },
    ),
    verticalFragileMinWalletTxSharePct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_VERTICAL_MIN_WALLET_TX_SHARE_PCT', 8, { min: 0, max: 100 },
    ),
    sparseBreadthMinBuysPerBuyer: numberEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_SPARSE_MIN_BUYS_PER_BUYER', 2, { min: 1 },
    ),
    chaseRepeatedMinReturnPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_REPEAT_MIN_RETURN_PCT', 30, { min: 0 },
    ),
    chaseRepeatedMinSizeSharePct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_REPEAT_MIN_SIZE_SHARE_PCT', 15, { min: 0, max: 100 },
    ),
    beijingRiskWindowEnabled: booleanEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_BEIJING_WINDOW_ENABLED', true,
    ),
    beijingRiskStartHour: integerEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_BEIJING_START_HOUR', 16, { min: 0, max: 23 },
    ),
    beijingRiskEndHour: integerEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_BEIJING_END_HOUR', 20, { min: 0, max: 23 },
    ),
    beijingRiskMinFlags: integerEnv(
      'FLOW_PRE_ENTRY_RUG_RISK_BEIJING_MIN_FLAGS', 4, { min: 1, max: 5 },
    ),
    // Forward-only labels for the failure mode that a chart stop cannot
    // protect against: one to three public sells collapse the pool before the
    // next independent trade confirms that the lower price persisted. These
    // labels correct Shadow capacity accounting; they are not entry blockers.
    cliffEnabled: booleanEnv('FLOW_PRE_ENTRY_RUG_CLIFF_ENABLED', true),
    cliffWindowMs: integerEnv('FLOW_PRE_ENTRY_RUG_CLIFF_WINDOW_MS', 2_000, {
      min: 100, max: 10_000,
    }),
    cliffMaxSells: integerEnv('FLOW_PRE_ENTRY_RUG_CLIFF_MAX_SELLS', 3, {
      min: 1, max: 10,
    }),
    cliffMinDropPct: numberEnv('FLOW_PRE_ENTRY_RUG_CLIFF_MIN_DROP_PCT', 50, {
      min: 20, max: 99,
    }),
    cliffPersistMaxRatioPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_CLIFF_PERSIST_MAX_RATIO_PCT', 75, { min: 1, max: 100 },
    ),
    cliffPairIgnoreMs: integerEnv('FLOW_PRE_ENTRY_RUG_CLIFF_PAIR_IGNORE_MS', 100, {
      min: 0, max: 1_000,
    }),
    slowRugMinDurationMs: integerEnv('FLOW_PRE_ENTRY_RUG_SLOW_MIN_DURATION_MS', 10_000, {
      min: 1_000, max: 120_000,
    }),
    // Estimate how much of the visible token inventory the largest observed
    // wallets could dump, then simulate our 1-SOL exit after them. This uses
    // the existing bounded in-memory event ring and trade reserves only.
    dumpabilityEnabled: booleanEnv('FLOW_PRE_ENTRY_RUG_DUMPABILITY_ENABLED', true),
    dumpabilityPositionSol: numberEnv('FLOW_PRE_ENTRY_RUG_DUMPABILITY_POSITION_SOL', 1, {
      min: 0.001, max: 100,
    }),
    dumpTop1ReserveWarnPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_DUMP_TOP1_RESERVE_WARN_PCT', 25, { min: 0, max: 1_000 },
    ),
    dumpTop3ReserveWarnPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_DUMP_TOP3_RESERVE_WARN_PCT', 50, { min: 0, max: 1_000 },
    ),
    // A first-occurrence catastrophe guard. It does not wait for the generic
    // ten-trade sample: a sub-500ms coordinated capital burst plus highly
    // concentrated inventory and an unexecutable post-dump exit is sufficient.
    extremeDumpabilityEnabled: booleanEnv(
      'FLOW_PRE_ENTRY_RUG_EXTREME_DUMPABILITY_ENABLED', true,
    ),
    extremeDumpabilityMinObservedWallets: integerEnv(
      'FLOW_PRE_ENTRY_RUG_EXTREME_MIN_OBSERVED_WALLETS', 4, { min: 2, max: 32 },
    ),
    extremeDumpabilityTop3ObservedSharePct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_EXTREME_TOP3_OBSERVED_SHARE_PCT', 70,
      { min: 0, max: 100 },
    ),
    extremeDumpabilityTop3RecoveryMaxPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_EXTREME_TOP3_RECOVERY_MAX_PCT', 20,
      { min: 0, max: 100 },
    ),
    // Paired counterfactual only: evaluate two pre-first-cliff filters on every
    // entry opportunity that the current guard passes. No entry is blocked and
    // no RPC/SQLite lookup is added to the hot path.
    firstCliffCounterfactualEnabled: booleanEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_COUNTERFACTUAL_ENABLED', true,
    ),
    firstCliffHorizonMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_HORIZON_MS', 30_000, { min: 5_000, max: 120_000 },
    ),
    firstCliffMaxPending: integerEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_MAX_PENDING', 10_000, { min: 100, max: 100_000 },
    ),
    firstCliffAuditFlushMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_AUDIT_FLUSH_MS', 1_000, { min: 250, max: 10_000 },
    ),
    firstCliffEffectiveBuyersMax: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_EFFECTIVE_BUYERS_MAX', 3, { min: 1, max: 100 },
    ),
    firstCliffHc1Top1Pct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_HC1_TOP1_PCT', 15, { min: 0, max: 1_000 },
    ),
    firstCliffHc1Top3Pct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_HC1_TOP3_PCT', 35, { min: 0, max: 1_000 },
    ),
    firstCliffHc2Top1Pct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_HC2_TOP1_PCT', 20, { min: 0, max: 1_000 },
    ),
    firstCliffHc2Top3Pct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_HC2_TOP3_PCT', 35, { min: 0, max: 1_000 },
    ),
    // Lifecycle-specific paired research. These boundaries and PumpSwap
    // concentration/recovery checks only label counterfactual cohorts; they do
    // not change the universal live guard until forward precision is proven.
    firstCliffLifecycleEnabled: booleanEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_LIFECYCLE_ENABLED', true,
    ),
    firstCliffLaunchMaxAgeMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_LAUNCH_MAX_AGE_MS', 5_000,
      { min: 500, max: 30_000 },
    ),
    firstCliffCurveEarlyMaxAgeMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_CURVE_EARLY_MAX_AGE_MS', 30_000,
      { min: 5_000, max: 300_000 },
    ),
    firstCliffCurveMigrationMinPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_CURVE_MIGRATION_MIN_PCT', 80,
      { min: 0, max: 100 },
    ),
    firstCliffAmmEarlyMaxAgeMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_AMM_EARLY_MAX_AGE_MS', 10_000,
      { min: 500, max: 120_000 },
    ),
    firstCliffAmmHc1Top3RecoveryMaxPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_AMM_HC1_TOP3_RECOVERY_MAX_PCT', 50,
      { min: 0, max: 100 },
    ),
    firstCliffAmmHc2Top3RecoveryMaxPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_AMM_HC2_TOP3_RECOVERY_MAX_PCT', 40,
      { min: 0, max: 100 },
    ),
    firstCliffAmmHc1WalletBuyTxSharePct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_AMM_HC1_WALLET_BUY_TX_SHARE_PCT', 50,
      { min: 0, max: 100 },
    ),
    firstCliffAmmHc2WalletBuyTxSharePct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_AMM_HC2_WALLET_BUY_TX_SHARE_PCT', 60,
      { min: 0, max: 100 },
    ),
    // Stage-specific forward candidates derived from independent historical
    // episodes. They are audit labels only: no live/Shadow entry rejection and
    // no additional RPC or database lookup is allowed on the entry path.
    firstCliffCurveLateCandidateRecoveryMaxPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_CURVE_LATE_CANDIDATE_RECOVERY_MAX_PCT', 2,
      { min: 0, max: 100 },
    ),
    firstCliffCurveMigrationCandidateWalletBuyTxSharePct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_CURVE_MIGRATION_CANDIDATE_WALLET_BUY_TX_SHARE_PCT', 70,
      { min: 0, max: 100 },
    ),
    firstCliffAmmEarlyCandidateRecoveryMaxPct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_AMM_EARLY_CANDIDATE_RECOVERY_MAX_PCT', 20,
      { min: 0, max: 100 },
    ),
    firstCliffAmmEarlyCandidateWalletBuyTxSharePct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_FIRST_CLIFF_AMM_EARLY_CANDIDATE_WALLET_BUY_TX_SHARE_PCT', 25,
      { min: 0, max: 100 },
    ),
    // Learn repeated launch/rug families from public trades only. Four large
    // buys in a sub-500ms burst form a template; after that template visibly
    // collapses, later Mints with the same amount/timing vector or at least two
    // learned wallets are blocked without requiring the native 10-trade sample.
    crossMintEnabled: booleanEnv('FLOW_PRE_ENTRY_RUG_CROSS_MINT_ENABLED', true),
    templateWindowMs: integerEnv('FLOW_PRE_ENTRY_RUG_TEMPLATE_WINDOW_MS', 5_000, {
      min: 100, max: 30_000,
    }),
    templateLargeBuyMinSol: numberEnv('FLOW_PRE_ENTRY_RUG_TEMPLATE_LARGE_BUY_MIN_SOL', 1, {
      min: 0.01,
    }),
    templateMinLargeBuys: integerEnv('FLOW_PRE_ENTRY_RUG_TEMPLATE_MIN_LARGE_BUYS', 4, {
      min: 2, max: 16,
    }),
    templateMaxLargeBuys: integerEnv('FLOW_PRE_ENTRY_RUG_TEMPLATE_MAX_LARGE_BUYS', 6, {
      min: 2, max: 32,
    }),
    templateMinTotalBuySol: numberEnv('FLOW_PRE_ENTRY_RUG_TEMPLATE_MIN_TOTAL_BUY_SOL', 40, {
      min: 1,
    }),
    templateMaxBurstSpanMs: integerEnv('FLOW_PRE_ENTRY_RUG_TEMPLATE_MAX_BURST_SPAN_MS', 500, {
      min: 10, max: 5_000,
    }),
    templateSizeBucketSol: numberEnv('FLOW_PRE_ENTRY_RUG_TEMPLATE_SIZE_BUCKET_SOL', 0.25, {
      min: 0.01, max: 10,
    }),
    toxicCollapsePct: numberEnv('FLOW_PRE_ENTRY_RUG_TOXIC_COLLAPSE_PCT', 60, {
      min: 20, max: 100,
    }),
    toxicCollapseWindowMs: integerEnv('FLOW_PRE_ENTRY_RUG_TOXIC_COLLAPSE_WINDOW_MS', 30_000, {
      min: 1_000, max: 120_000,
    }),
    // Keep the legacy combined key readable for older tooling. The split keys
    // intentionally default to longer independent windows even when an old
    // deployment still overrides the former 24-hour value.
    toxicRetentionMs: integerEnv('FLOW_PRE_ENTRY_RUG_TOXIC_RETENTION_MS', 60 * 86_400_000, {
      min: 60_000, max: 365 * 86_400_000,
    }),
    toxicWalletRetentionMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_TOXIC_WALLET_RETENTION_MS',
      60 * 86_400_000,
      { min: 60_000, max: 365 * 86_400_000 },
    ),
    toxicTemplateRetentionMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_TOXIC_TEMPLATE_RETENTION_MS',
      30 * 86_400_000,
      { min: 60_000, max: 365 * 86_400_000 },
    ),
    toxicMemoryPath: process.env.FLOW_PRE_ENTRY_RUG_TOXIC_MEMORY_PATH
      || './data/pre-entry-rug-toxic-memory.json',
    toxicPersistIntervalMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_TOXIC_PERSIST_INTERVAL_MS', 5_000, { min: 1_000, max: 60_000 },
    ),
    toxicAmountTolerancePct: numberEnv(
      'FLOW_PRE_ENTRY_RUG_TOXIC_AMOUNT_TOLERANCE_PCT', 2, { min: 0, max: 10 },
    ),
    toxicBurstToleranceMs: integerEnv(
      'FLOW_PRE_ENTRY_RUG_TOXIC_BURST_TOLERANCE_MS', 100, { min: 0, max: 1_000 },
    ),
    toxicWalletOverlapMin: integerEnv('FLOW_PRE_ENTRY_RUG_TOXIC_WALLET_OVERLAP_MIN', 2, {
      min: 1, max: 16,
    }),
    maxToxicWallets: integerEnv('FLOW_PRE_ENTRY_RUG_MAX_TOXIC_WALLETS', 4_096, {
      min: 64, max: 65_536,
    }),
    maxToxicTemplates: integerEnv('FLOW_PRE_ENTRY_RUG_MAX_TOXIC_TEMPLATES', 1_024, {
      min: 32, max: 16_384,
    }),
  },

  // Independent causal study derived from the observed behavior of consistently
  // profitable wallets. It never signs transactions and never reuses a future
  // Smart OPEN as an earlier fill price.
  smartLikeEarlyShadow: {
    enabled: booleanEnv('FLOW_SMART_LIKE_EARLY_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_SMART_LIKE_EARLY_POSITION_SOL'),
    stateWindowMs: integerEnv('FLOW_SMART_LIKE_EARLY_STATE_WINDOW_MS', 5_000, { min: 1_000 }),
    stateRetentionMs: integerEnv('FLOW_SMART_LIKE_EARLY_STATE_RETENTION_MS', 240_000, {
      min: 30_000,
    }),
    entryDelayMs: integerEnv('FLOW_SMART_LIKE_EARLY_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SMART_LIKE_EARLY_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SMART_LIKE_EARLY_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SMART_LIKE_EARLY_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_SMART_LIKE_EARLY_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0, max: 100,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_SMART_LIKE_EARLY_MAX_ENTRY_DROP_PCT', 30, {
      min: 0, max: 100,
    }),
    maxCurvePct: numberEnv('FLOW_SMART_LIKE_EARLY_MAX_CURVE_PCT', 40, { min: 0, max: 100 }),
    maxAgeMs: integerEnv('FLOW_SMART_LIKE_EARLY_MAX_AGE_MS', 10_000, { min: 250 }),
    maxReturn5sPct: numberEnv('FLOW_SMART_LIKE_EARLY_MAX_RETURN_5S_PCT', 10, {
      min: -100, max: 1_000,
    }),
    minNetFlow5s: numberEnv('FLOW_SMART_LIKE_EARLY_MIN_NETFLOW_5S_SOL', 0, { min: -1_000 }),
    minSmartOpenSol: numberEnv('FLOW_SMART_LIKE_EARLY_MIN_SMART_OPEN_SOL', 0.1, { min: 0 }),
    smartConfirmationMs: integerEnv('FLOW_SMART_LIKE_EARLY_CONFIRMATION_MS', 5_000, { min: 100 }),
    clusterDedupMs: integerEnv('FLOW_SMART_LIKE_EARLY_CLUSTER_DEDUP_MS', 1_000, { min: 0 }),
    addThresholdsPct: [50, 80, 120],
    addFraction: numberEnv('FLOW_SMART_LIKE_EARLY_ADD_FRACTION', 0.08, { min: 0, max: 1 }),
    hardStopPct: numberEnv('FLOW_SMART_LIKE_EARLY_HARD_STOP_PCT', 20, { min: 0.1, max: 100 }),
    noStrengthMs: integerEnv('FLOW_SMART_LIKE_EARLY_NO_STRENGTH_MS', 25_000, { min: 1_000 }),
    noStrengthMfePct: numberEnv('FLOW_SMART_LIKE_EARLY_NO_STRENGTH_MFE_PCT', 10, {
      min: 0, max: 1_000,
    }),
    flowDecayNetFlow1s: numberEnv('FLOW_SMART_LIKE_EARLY_FLOW_DECAY_NETFLOW_1S', -1, {
      min: -1_000,
    }),
    flowDecaySellTx1s: integerEnv('FLOW_SMART_LIKE_EARLY_FLOW_DECAY_SELL_TX_1S', 3, {
      min: 1,
    }),
    priorityWallets: listEnv('FLOW_SMART_LIKE_EARLY_PRIORITY_WALLETS', [
      'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',
      '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9',
      '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f',
      'ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT',
      'Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt',
    ]),
    walletClusters: [{
      id: 'F9_FAIC_CLUSTER',
      wallets: [
        'F9zT1F46HAoPanR4NC1Yw7TyP8Z9tCavTe48mrzK7aN4',
        'FAicXNV5FVqtfbpn4Zccs71XcfGeyxBSGbqLDyDJZjke',
      ],
    }],
    entryProfiles: [
      {
        id: 'SMART_DIRECT', label: 'Smart OPEN / Curve<=40 / no chase',
        sourceType: 'SMART_OPEN', requireAge: false, requireFlowConfirmation: false,
      },
      {
        id: 'SMART_STRICT', label: 'Smart OPEN / AGE<=10s / prior Flow<=5s',
        sourceType: 'SMART_OPEN', requireAge: true, requireFlowConfirmation: true,
      },
      {
        id: 'FLOW_PREDICT', label: 'Primary Rank 1 predictive entry / later Smart label',
        sourceType: 'FLOW_PREDICT', requireAge: true, requireFlowConfirmation: false,
      },
    ],
    addProfiles: [
      { id: 'BASE', label: 'No add', thresholdsPct: [], addFraction: 0 },
      {
        id: 'PYRAMID', label: 'Add 8% at +50/+80/+120%',
        thresholdsPct: [50, 80, 120],
        addFraction: numberEnv('FLOW_SMART_LIKE_EARLY_ADD_FRACTION', 0.08, {
          min: 0, max: 1,
        }),
      },
    ],
    exitProfiles: [
      {
        id: 'E50_T12', label: '+50% sell 40%, runner trail 12%',
        activationPct: 50, sellFraction: 0.4, trailingStopPct: 12,
        maxHoldMs: 180_000, flowDecayExit: false,
      },
      {
        id: 'E75_T15', label: '+75% sell 50%, runner trail 15%',
        activationPct: 75, sellFraction: 0.5, trailingStopPct: 15,
        maxHoldMs: 180_000, flowDecayExit: false,
      },
      {
        id: 'E100_FLOW', label: '+100% sell 40%, flow decay or trail 20%',
        activationPct: 100, sellFraction: 0.4, trailingStopPct: 20,
        maxHoldMs: 180_000, flowDecayExit: true,
      },
      {
        id: 'FIX60_H20', label: '-20% hard stop / otherwise fixed 60s',
        mode: 'FIXED_HOLD', hardStopPct: 20, maxHoldMs: 60_000,
        allowedAddProfileIds: ['BASE'],
      },
      {
        id: 'FIX120_H20', label: '-20% hard stop / otherwise fixed 120s',
        mode: 'FIXED_HOLD', hardStopPct: 20, maxHoldMs: 120_000,
        allowedAddProfileIds: ['BASE'],
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_LIKE_EARLY_POSITION_SOL'),
    }),
  },

  // Strictly causal multi-wallet resonance study. A signal exists only when the
  // second or third distinct monitored wallet BUY has actually been observed.
  // The signal price is never treated as a fill: every cohort waits for the
  // first comparable market trade after the configured execution delay.
  smartResonanceShadow: {
    enabled: provenNegativeShadowsEnabled
      && booleanEnv('FLOW_SMART_RESONANCE_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_SMART_RESONANCE_POSITION_SOL'),
    featureWindowMs: integerEnv('FLOW_SMART_RESONANCE_FEATURE_WINDOW_MS', 5_000, {
      min: 1_000,
    }),
    stateRetentionMs: integerEnv('FLOW_SMART_RESONANCE_STATE_RETENTION_MS', 10 * 60_000, {
      min: 60_000,
    }),
    episodeCooldownMs: integerEnv('FLOW_SMART_RESONANCE_EPISODE_COOLDOWN_MS', 60_000, {
      min: 1_000,
    }),
    entryDelayMs: integerEnv('FLOW_SMART_RESONANCE_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SMART_RESONANCE_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SMART_RESONANCE_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SMART_RESONANCE_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_SMART_RESONANCE_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_SMART_RESONANCE_MAX_ENTRY_DROP_PCT', 30, {
      min: 0, max: 100,
    }),
    maxCrossMarketPriceJumpPct: numberEnv(
      'FLOW_SMART_RESONANCE_MAX_CROSS_MARKET_JUMP_PCT',
      50,
      { min: 0, max: 1_000 },
    ),
    entryProfiles: [
      {
        id: 'SR_R0',
        label: 'SR-R0 · 2 Smart Wallet / 5s baseline',
        resonanceWindowMs: 5_000,
        requiredWallets: 2,
      },
      {
        id: 'SR_R1',
        label: 'SR-R1 · 2 Wallet/5s + public Buyers20 + BuyFlow15 + Top1<=25%',
        resonanceWindowMs: 5_000,
        requiredWallets: 2,
        minPublicBuyers5s: 20,
        minPublicBuyFlow5sSol: 15,
        maxLargestBuyerSharePct: 25,
      },
      {
        id: 'SR_R2',
        label: 'SR-R2 · 3 Wallet/60s + public Buyers20 + Top1<=20%',
        resonanceWindowMs: 60_000,
        requiredWallets: 3,
        minPublicBuyers5s: 20,
        maxLargestBuyerSharePct: 20,
      },
      {
        id: 'SR_R3',
        label: 'SR-R3 · 2 Wallet/60s + pre-grad AGE25s + Curve60-80 + Buyers20',
        resonanceWindowMs: 60_000,
        requiredWallets: 2,
        minPublicBuyers5s: 20,
        requirePreGraduation: true,
        requiredMarket: 'PUMP_BONDING_CURVE',
        maxAgeMs: 25_000,
        minCurvePct: 60,
        maxCurvePct: 80,
      },
      {
        id: 'SR_R3_GUARD',
        label: 'SR-R3-GUARD · R3 + 公共订单流RUG过滤',
        resonanceWindowMs: 60_000,
        requiredWallets: 2,
        minPublicBuyers5s: 20,
        requirePreGraduation: true,
        requiredMarket: 'PUMP_BONDING_CURVE',
        maxAgeMs: 25_000,
        minCurvePct: 60,
        maxCurvePct: 80,
        requireHealthyRugRisk: true,
      },
    ],
    exitProfiles: [20, 30].flatMap((hardStopPct) => (
      [60, 120, 180, 240].map((holdSeconds) => ({
        id: `H${hardStopPct}_T${holdSeconds}`,
        label: `Hard stop ${hardStopPct}% / fixed ${holdSeconds}s`,
        hardStopPct,
        maxHoldMs: holdSeconds * 1_000,
      }))
    )),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_RESONANCE_POSITION_SOL'),
    }),
  },

  // Versioned, forward-only wallet registry. New wallets are nominated from
  // early buyers of graduated tokens, need repeated seed-token evidence, and
  // become eligible only after a delay. The discovery token itself is excluded
  // from grading so the registry cannot grade on its own selection sample.
  smartWalletRegistry: {
    enabled: booleanEnv('FLOW_SMART_WALLET_REGISTRY_ENABLED', true),
    discoveryEnabled: booleanEnv('FLOW_SMART_WALLET_DISCOVERY_ENABLED', true),
    discoveryMinSeedMints: integerEnv('FLOW_SMART_WALLET_DISCOVERY_MIN_SEEDS', 2, { min: 1 }),
    discoveryMinBuySol: numberEnv('FLOW_SMART_WALLET_DISCOVERY_MIN_BUY_SOL', 0.2, { min: 0 }),
    discoveryMaxEarlyBuyers: integerEnv('FLOW_SMART_WALLET_DISCOVERY_MAX_BUYERS', 25, {
      min: 1, max: 500,
    }),
    discoveryMaxCurvePct: numberEnv('FLOW_SMART_WALLET_DISCOVERY_MAX_CURVE_PCT', 80, {
      min: 0, max: 100,
    }),
    discoveryDelayMs: integerEnv('FLOW_SMART_WALLET_DISCOVERY_DELAY_MS', 24 * 60 * 60_000, {
      min: 0,
    }),
    ageCheckEnabled: booleanEnv('FLOW_SMART_WALLET_AGE_CHECK_ENABLED', true),
    ageRpcUrl: process.env.FLOW_SMART_WALLET_AGE_RPC_URL || process.env.FLOW_RPC_URL || '',
    ageHardRejectMs: integerEnv('FLOW_SMART_WALLET_AGE_HARD_REJECT_MS', 7 * 24 * 60 * 60_000, {
      min: 0,
    }),
    ageMinVoteMs: integerEnv('FLOW_SMART_WALLET_AGE_MIN_VOTE_MS', 30 * 24 * 60 * 60_000, {
      min: 24 * 60 * 60_000,
    }),
    ageRetryMs: integerEnv('FLOW_SMART_WALLET_AGE_RETRY_MS', 24 * 60 * 60_000, {
      min: 24 * 60 * 60_000,
    }),
    ageRpcTimeoutMs: integerEnv('FLOW_SMART_WALLET_AGE_RPC_TIMEOUT_MS', 10_000, {
      min: 1_000, max: 60_000,
    }),
    ageRpcPageSize: integerEnv('FLOW_SMART_WALLET_AGE_RPC_PAGE_SIZE', 1_000, {
      min: 1, max: 1_000,
    }),
    ageRpcPagesPerCheck: integerEnv('FLOW_SMART_WALLET_AGE_RPC_PAGES_PER_CHECK', 2, {
      min: 1, max: 20,
    }),
    ageCheckConcurrency: integerEnv('FLOW_SMART_WALLET_AGE_CHECK_CONCURRENCY', 1, {
      min: 1, max: 1,
    }),
    eventMonitoringRequiresResolvedAge: booleanEnv(
      'FLOW_SMART_WALLET_EVENT_MONITORING_REQUIRES_RESOLVED_AGE', true,
    ),
    ageSeedBypass: booleanEnv('FLOW_SMART_WALLET_AGE_SEED_BYPASS', false),
    pnlGateEnabled: booleanEnv('FLOW_SMART_WALLET_PNL_GATE_ENABLED', true),
    pnlWindowMs: integerEnv('FLOW_SMART_WALLET_PNL_WINDOW_MS', 24 * 60 * 60_000, {
      min: 24 * 60 * 60_000,
    }),
    pnlMinClosedPositions: integerEnv('FLOW_SMART_WALLET_PNL_MIN_CLOSED', 1, {
      min: 1, max: 1_000,
    }),
    pnlMinRealizedSol: numberEnv('FLOW_SMART_WALLET_PNL_MIN_REALIZED_SOL', 0, {
      min: 0,
    }),
    pnlMinCapitalReturnPct: numberEnv('FLOW_SMART_WALLET_PNL_MIN_RETURN_PCT', 0, {
      min: 0,
    }),
    pnlSnapshotCacheMs: integerEnv('FLOW_SMART_WALLET_PNL_CACHE_MS', 15 * 60_000, {
      min: 15 * 60_000, max: 24 * 60 * 60_000,
    }),
    votingSnapshotRefreshMs: integerEnv(
      'FLOW_SMART_WALLET_VOTING_SNAPSHOT_REFRESH_MS', 15 * 60_000,
      { min: 60_000, max: 24 * 60 * 60_000 },
    ),
    lastSeenWriteIntervalMs: integerEnv(
      'FLOW_SMART_WALLET_LAST_SEEN_WRITE_INTERVAL_MS', 15 * 60_000,
      { min: 60_000, max: 24 * 60 * 60_000 },
    ),
    actualEventBackfillBatchSize: integerEnv(
      'FLOW_SMART_WALLET_ACTUAL_BACKFILL_BATCH_SIZE', 250,
      { min: 10, max: 5_000 },
    ),
    actualEventBackfillIntervalMs: integerEnv(
      'FLOW_SMART_WALLET_ACTUAL_BACKFILL_INTERVAL_MS', 5_000,
      { min: 1_000, max: 60_000 },
    ),
    // Full cluster/grade maintenance grows with the historical wallet ledger.
    // Keep it off the realtime Node event loop so HTTP and stream callbacks do
    // not pause while SQLite performs multi-day scans.
    maintenanceWorkerEnabled: booleanEnv(
      'FLOW_SMART_WALLET_MAINTENANCE_WORKER_ENABLED', true,
    ),
    maintenanceWorkerTimeoutMs: integerEnv(
      'FLOW_SMART_WALLET_MAINTENANCE_WORKER_TIMEOUT_MS', 10 * 60_000,
      { min: 60_000, max: 60 * 60_000 },
    ),
    gradeDirtyRefreshMinMs: integerEnv(
      'FLOW_SMART_WALLET_GRADE_DIRTY_REFRESH_MIN_MS', 6 * 60 * 60_000,
      { min: 15 * 60_000, max: 24 * 60 * 60_000 },
    ),
    clusterCountCacheMs: integerEnv(
      'FLOW_SMART_WALLET_CLUSTER_COUNT_CACHE_MS', 15 * 60_000,
      { min: 15 * 60_000, max: 24 * 60 * 60_000 },
    ),
    historyBackfillEnabled: booleanEnv(
      'FLOW_SMART_WALLET_HISTORY_BACKFILL_ENABLED', true,
    ),
    historyRpcUrl: process.env.FLOW_SMART_WALLET_HISTORY_RPC_URL
      || process.env.FLOW_RPC_URL || '',
    historyWindowMs: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_WINDOW_MS', 60 * 24 * 60 * 60_000,
      { min: 7 * 24 * 60 * 60_000 },
    ),
    historyWarmupMs: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_WARMUP_MS', 30 * 24 * 60 * 60_000,
      { min: 0 },
    ),
    historyInitialAllEnabled: booleanEnv(
      'FLOW_SMART_WALLET_HISTORY_INITIAL_ALL_ENABLED', true,
    ),
    historyDailyWalletLimit: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_DAILY_WALLET_LIMIT', 50, { min: 1, max: 10_000 },
    ),
    historyConcurrency: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_CONCURRENCY', 1, { min: 1, max: 1 },
    ),
    historyPageSize: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_PAGE_SIZE', 1_000, { min: 1, max: 1_000 },
    ),
    historyMaxPagesPerWallet: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_MAX_PAGES_PER_WALLET', 500, { min: 1, max: 10_000 },
    ),
    historyRpcTimeoutMs: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_RPC_TIMEOUT_MS', 60_000, { min: 1_000, max: 120_000 },
    ),
    historyRetryMs: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_RETRY_MS', 24 * 60 * 60_000,
      { min: 24 * 60 * 60_000 },
    ),
    historyCreditsPerPage: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_CREDITS_PER_PAGE', 50, { min: 1, max: 10_000 },
    ),
    historyDailyCreditLimit: integerEnv(
      'FLOW_SMART_WALLET_HISTORY_DAILY_CREDIT_LIMIT', 250_000,
      { min: 1_000, max: 100_000_000 },
    ),
    elite60dEnabled: booleanEnv('FLOW_SMART_WALLET_ELITE_60D_ENABLED', true),
    elite60dWindowMs: integerEnv(
      'FLOW_SMART_WALLET_ELITE_60D_WINDOW_MS', 60 * 24 * 60 * 60_000,
      { min: 7 * 24 * 60 * 60_000 },
    ),
    elite60dMinRealizedSol: numberEnv(
      'FLOW_SMART_WALLET_ELITE_60D_MIN_REALIZED_SOL', 200, { min: 0 },
    ),
    clusterAutoEnabled: booleanEnv('FLOW_SMART_WALLET_CLUSTER_AUTO_ENABLED', true),
    clusterObservationMs: integerEnv(
      'FLOW_SMART_WALLET_CLUSTER_OBSERVATION_MS', 12 * 60 * 60_000,
      { min: 60 * 60_000 },
    ),
    clusterRefreshMs: integerEnv('FLOW_SMART_WALLET_CLUSTER_REFRESH_MS', 6 * 60 * 60_000, {
      min: 60 * 60_000,
    }),
    clusterLookbackMs: integerEnv(
      'FLOW_SMART_WALLET_CLUSTER_LOOKBACK_MS', 7 * 24 * 60 * 60_000,
      { min: 12 * 60 * 60_000 },
    ),
    clusterMinDistinctMints: integerEnv('FLOW_SMART_WALLET_CLUSTER_MIN_MINTS', 3, {
      min: 1, max: 1_000,
    }),
    clusterSyncWindowMs: integerEnv('FLOW_SMART_WALLET_CLUSTER_SYNC_WINDOW_MS', 5_000, {
      min: 100, max: 60_000,
    }),
    clusterAmountTolerancePct: numberEnv(
      'FLOW_SMART_WALLET_CLUSTER_AMOUNT_TOLERANCE_PCT', 15,
      { min: 0, max: 100 },
    ),
    clusterMinCorrelatedMints: integerEnv(
      'FLOW_SMART_WALLET_CLUSTER_MIN_CORRELATED_MINTS', 2,
      { min: 1, max: 100 },
    ),
    clusterMinCorrelationPct: numberEnv(
      'FLOW_SMART_WALLET_CLUSTER_MIN_CORRELATION_PCT', 50,
      { min: 0, max: 100 },
    ),
    autoVoteRequiresActive: booleanEnv('FLOW_SMART_WALLET_AUTO_VOTE_REQUIRES_ACTIVE', true),
    autoVoteRequiresKnownCluster: booleanEnv(
      'FLOW_SMART_WALLET_AUTO_VOTE_REQUIRES_KNOWN_CLUSTER', true,
    ),
    gradeRefreshMs: integerEnv('FLOW_SMART_WALLET_GRADE_REFRESH_MS', 24 * 60 * 60_000, {
      min: 60_000,
    }),
    lookbackMs: integerEnv('FLOW_SMART_WALLET_GRADE_LOOKBACK_MS', 60 * 24 * 60 * 60_000, {
      min: 7 * 24 * 60 * 60_000,
    }),
    labelPositionSol: shadowPositionEnv('FLOW_SMART_WALLET_LABEL_POSITION_SOL'),
    labelEntryDelayMs: integerEnv('FLOW_SMART_WALLET_LABEL_ENTRY_DELAY_MS', 5_000, { min: 0 }),
    labelEntryTimeoutMs: integerEnv('FLOW_SMART_WALLET_LABEL_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    labelGraceMs: integerEnv('FLOW_SMART_WALLET_LABEL_GRACE_MS', 10_000, { min: 0 }),
    copyReturnHorizonMs: integerEnv('FLOW_SMART_WALLET_COPY_HORIZON_MS', 30_000, {
      min: 1_000,
    }),
    selectionHorizonMs: integerEnv('FLOW_SMART_WALLET_SELECTION_HORIZON_MS', 300_000, {
      min: 30_000,
    }),
    noExitReturnPct: numberEnv('FLOW_SMART_WALLET_NO_EXIT_RETURN_PCT', -100, {
      min: -100, max: 0,
    }),
    maxNoExitRatePct: numberEnv('FLOW_SMART_WALLET_MAX_NO_EXIT_RATE_PCT', 20, {
      min: 0, max: 100,
    }),
    maxCrossMarketJumpPct: numberEnv('FLOW_SMART_WALLET_MAX_CROSS_MARKET_JUMP_PCT', 500, {
      min: 0, max: 10_000,
    }),
    // S_A/S_B are graduation-prediction grades, not profitability aliases.
    // Only mature first OPENs on the Bonding Curve are counted; discovery
    // seeds are excluded and recent unresolved Mints are right-censored.
    graduationPredictionHorizonMs: integerEnv(
      'FLOW_SMART_WALLET_GRAD_PREDICTION_HORIZON_MS', 12 * 60 * 60_000,
      { min: 60 * 60_000, max: 7 * 24 * 60 * 60_000 },
    ),
    graduationPredictionLookbackMs: integerEnv(
      'FLOW_SMART_WALLET_GRAD_PREDICTION_LOOKBACK_MS', 60 * 24 * 60 * 60_000,
      { min: 7 * 24 * 60 * 60_000 },
    ),
    graduationPredictionMinActiveDays: integerEnv(
      'FLOW_SMART_WALLET_GRAD_PREDICTION_MIN_ACTIVE_DAYS', 3,
      { min: 1, max: 60 },
    ),
    graduationPredictionFallbackBaselinePct: numberEnv(
      'FLOW_SMART_WALLET_GRAD_PREDICTION_FALLBACK_BASELINE_PCT', 8,
      { min: 0.01, max: 100 },
    ),
    minGraduationRatePct: numberEnv(
      'FLOW_SMART_WALLET_MIN_GRAD_RATE_PCT', 25, { min: 0, max: 100 },
    ),
    minGraduationWilsonLowerPct: numberEnv(
      'FLOW_SMART_WALLET_MIN_GRAD_WILSON_LOWER_PCT', 10, { min: 0, max: 100 },
    ),
    selectionMinSamples: integerEnv('FLOW_SMART_WALLET_SELECTION_MIN_SAMPLES', 30, { min: 5 }),
    copyMinSamples: integerEnv('FLOW_SMART_WALLET_COPY_MIN_SAMPLES', 30, { min: 5 }),
    holdingMinSamples: integerEnv('FLOW_SMART_WALLET_HOLDING_MIN_SAMPLES', 30, { min: 5 }),
    minActiveDays: integerEnv('FLOW_SMART_WALLET_MIN_ACTIVE_DAYS', 7, { min: 1 }),
    minGraduationLift: numberEnv('FLOW_SMART_WALLET_MIN_GRAD_LIFT', 1.5, { min: 0 }),
    minBig50Lift: numberEnv('FLOW_SMART_WALLET_MIN_BIG50_LIFT', 1.5, { min: 0 }),
    minSelectionBLift: numberEnv('FLOW_SMART_WALLET_MIN_SELECTION_B_LIFT', 1.1, { min: 0 }),
    minCopyPf: numberEnv('FLOW_SMART_WALLET_MIN_COPY_PF', 1.2, { min: 0 }),
    minPositiveWindowPct: numberEnv('FLOW_SMART_WALLET_MIN_POSITIVE_WINDOW_PCT', 70, {
      min: 0, max: 100,
    }),
    maxTop1ProfitPct: numberEnv('FLOW_SMART_WALLET_MAX_TOP1_PROFIT_PCT', 35, {
      min: 0, max: 100,
    }),
    holdingBigWinnerPct: numberEnv('FLOW_SMART_WALLET_HOLDING_BIG_WINNER_PCT', 100, {
      min: 0,
    }),
    holdingMinRunnerUpliftPct: numberEnv(
      'FLOW_SMART_WALLET_HOLDING_MIN_RUNNER_UPLIFT_PCT', 20, { min: 0 },
    ),
    holdingMinBigWinnerRatePct: numberEnv(
      'FLOW_SMART_WALLET_HOLDING_MIN_BIG_WINNER_RATE_PCT', 10, { min: 0, max: 100 },
    ),
    gradeConfirmationRuns: integerEnv('FLOW_SMART_WALLET_GRADE_CONFIRMATION_RUNS', 2, {
      min: 1, max: 10,
    }),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_WALLET_LABEL_POSITION_SOL'),
    }),
  },

  // FEA-OBS V2: smart-wallet consensus is the causal candidate trigger. A
  // pre-graduation scout is optional, graduation must be followed by independent
  // public AMM flow before scaling, and the long-tail arm sells a core while
  // retaining a trailing runner. RUG output is recorded as a label only.
  smartWalletConsensusFlowRunnerShadow: {
    enabled: booleanEnv('FLOW_SMART_CONSENSUS_V2_SHADOW_ENABLED', true),
    positionSizeSol: shadowPositionEnv('FLOW_SMART_CONSENSUS_V2_POSITION_SOL'),
    probationVoteWeight: numberEnv('FLOW_SMART_CONSENSUS_V2_PROBATION_WEIGHT', 0.5, {
      min: 0, max: 1,
    }),
    enforceAGradeAfterClusters: integerEnv(
      'FLOW_SMART_CONSENSUS_V2_ENFORCE_A_AFTER_CLUSTERS', 12, { min: 1 },
    ),
    stateRetentionMs: integerEnv('FLOW_SMART_CONSENSUS_V2_STATE_RETENTION_MS', 24 * 60 * 60_000, {
      min: 60_000,
    }),
    postGradSnapshotHorizonsMs: millisecondListEnv(
      'FLOW_SMART_CONSENSUS_V2_POST_GRAD_SNAPSHOT_SECONDS',
      [30, 60, 120, 300],
    ),
    maxRestoredHoldingRows: integerEnv(
      'FLOW_SMART_CONSENSUS_V2_MAX_RESTORED_HOLDING_ROWS', 20_000,
      { min: 100, max: 100_000 },
    ),
    episodeCooldownMs: integerEnv('FLOW_SMART_CONSENSUS_V2_EPISODE_COOLDOWN_MS', 30 * 60_000, {
      min: 1_000,
    }),
    entryDelayMs: integerEnv('FLOW_SMART_CONSENSUS_V2_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SMART_CONSENSUS_V2_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SMART_CONSENSUS_V2_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SMART_CONSENSUS_V2_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    // A constant-product sell quote cannot credibly be orders of magnitude
    // above the public mark. Reject inconsistent reserve snapshots instead of
    // recording impossible multi-thousand-SOL Shadow proceeds.
    maxExitQuoteToMarketRatio: numberEnv(
      'FLOW_SMART_CONSENSUS_V2_MAX_EXIT_QUOTE_TO_MARK_RATIO', 5,
      { min: 1, max: 100 },
    ),
    maxHistoricalExitProceedsMultiple: 1_000,
    maxScoutWaitMs: integerEnv('FLOW_SMART_CONSENSUS_V2_MAX_SCOUT_WAIT_MS', 15 * 60_000, {
      min: 30_000,
    }),
    maxFlowWaitMs: integerEnv('FLOW_SMART_CONSENSUS_V2_MAX_FLOW_WAIT_MS', 2 * 60_000, {
      min: 10_000,
    }),
    flowWindowMs: integerEnv('FLOW_SMART_CONSENSUS_V2_FLOW_WINDOW_MS', 20_000, {
      min: 2_000,
    }),
    minFlowNetSol: numberEnv('FLOW_SMART_CONSENSUS_V2_MIN_FLOW_NET_SOL', 0.1, { min: 0 }),
    minFlowBuyers: integerEnv('FLOW_SMART_CONSENSUS_V2_MIN_FLOW_BUYERS', 3, { min: 1 }),
    minFlowBuyTx: integerEnv('FLOW_SMART_CONSENSUS_V2_MIN_FLOW_BUY_TX', 3, { min: 1 }),
    strictMinFlowNetSol: numberEnv(
      'FLOW_SMART_CONSENSUS_V2_STRICT_MIN_FLOW_NET_SOL', 1, { min: 0 },
    ),
    strictMinFlowNetSharePct: numberEnv(
      'FLOW_SMART_CONSENSUS_V2_STRICT_MIN_FLOW_NET_SHARE_PCT', 3, { min: 0, max: 100 },
    ),
    strictMaxFlowConfirmationDelayMs: integerEnv(
      'FLOW_SMART_CONSENSUS_V2_STRICT_MAX_FLOW_CONFIRM_DELAY_MS', 30_000, { min: 1_000 },
    ),
    dynamicThresholds: [
      { maxEligibleClusters: 10, ordinary: 2, strong: 3 },
      { maxEligibleClusters: 25, ordinary: 3, strong: 5 },
      { maxEligibleClusters: 50, ordinary: 4, strong: 7 },
      { maxEligibleClusters: Number.MAX_SAFE_INTEGER, ordinary: 6, strong: 10 },
    ],
    entryProfiles: [
      {
        id: 'PA3_POST_FLOW_V1',
        label: 'P_A严格3集群/300秒 · 毕业后公共流确认',
        ruleVersion: 'GRAD_PREDICTION_V1',
        strength: 'PREDICTION_A3',
        consensusWindowMs: 300_000,
        requiredClusters: 3,
        minSelectionAClusters: 3,
        selectionGradeOnly: 'S_A',
        scoutFraction: 0,
        minWeightedScoreRatio: 1,
      },
      {
        id: 'PA3_SCOUT15_FLOW_V1',
        label: 'P_A严格3集群/300秒 · 毕业前15%试仓',
        ruleVersion: 'GRAD_PREDICTION_V1',
        strength: 'PREDICTION_A3',
        consensusWindowMs: 300_000,
        requiredClusters: 3,
        minSelectionAClusters: 3,
        selectionGradeOnly: 'S_A',
        scoutFraction: 0.15,
        minWeightedScoreRatio: 1,
      },
      {
        id: 'PA3_EARLY_C25_V1',
        label: 'P_A严格3集群/300秒 · 早期Curve<25%',
        ruleVersion: 'GRAD_PREDICTION_V1',
        strength: 'PREDICTION_A3',
        consensusWindowMs: 300_000,
        requiredClusters: 3,
        minSelectionAClusters: 3,
        selectionGradeOnly: 'S_A',
        minWeightedScoreRatio: 1,
        minCurvePct: 0,
        maxCurvePct: 25,
        directCurveEntry: true,
        scoutFraction: 1,
        exitProfileIds: ['FIX30', 'CORE80_RUNNER6H_SP30T20'],
      },
      {
        id: 'ROLLING_DYNAMIC_CONTROL_V1',
        label: '宽松滚动钱包动态门槛对照（不要求P_A）',
        ruleVersion: 'LEGACY_BROAD_CONTROL_V1',
        strength: 'ORDINARY',
        consensusWindowMs: 180_000,
        scoutFraction: 0,
        minSelectionAClusters: 0,
        minWeightedScoreRatio: 0.5,
        researchControl: true,
      },
      {
        id: 'POST_FLOW', label: '历史规则（停止新增）· 毕业后公共流', strength: 'ORDINARY',
        enabled: false,
        consensusWindowMs: 180_000, scoutFraction: 0,
        minSelectionAClusters: 2, minWeightedScoreRatio: 0.5,
      },
      {
        id: 'SCOUT15_FLOW', label: '历史规则（停止新增）· 毕业前15%试仓', strength: 'ORDINARY',
        enabled: false,
        consensusWindowMs: 180_000, scoutFraction: 0.15,
        minSelectionAClusters: 2, minWeightedScoreRatio: 0.5,
      },
      {
        id: 'POST_FLOW_STRICT', label: '历史规则（停止新增）· 毕业后强公共流', strength: 'ORDINARY',
        enabled: false,
        consensusWindowMs: 180_000, scoutFraction: 0, flowGate: 'STRICT',
        minSelectionAClusters: 2, minWeightedScoreRatio: 0.5,
      },
      {
        id: 'SCOUT15_FLOW_STRICT', label: '历史规则（停止新增）· 15%试仓+强公共流', strength: 'ORDINARY',
        enabled: false,
        consensusWindowMs: 180_000, scoutFraction: 0.15, flowGate: 'STRICT',
        minSelectionAClusters: 2, minWeightedScoreRatio: 0.5,
      },
      {
        id: 'STRONG25_FLOW', label: '历史规则（停止新增）· 25%试仓+公共流', strength: 'STRONG',
        enabled: false,
        consensusWindowMs: 300_000, scoutFraction: 0.25, flowGate: 'STRICT',
        minSelectionAClusters: 3, minWeightedScoreRatio: 0.6,
      },
      booleanEnv('FLOW_SMART_CONSENSUS_V2_POST_GRAD_HOLD3_ENABLED', true) && {
        id: 'POST_GRAD_HOLD3_FLOW2_60',
        label: '真实AMM毕业 · 3个独立集群仍持仓 · 60秒2买家净流入',
        strength: 'HOLDING_STRONG',
        postGraduationHoldingConsensus: true,
        requiredHoldingClusters: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_HOLDING_CLUSTERS', 3, { min: 2 },
        ),
        minWeightedScoreRatio: numberEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_MIN_WEIGHT_RATIO', 0.5,
          { min: 0, max: 1 },
        ),
        cumulativePostGraduationFlow: true,
        flowWindowMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_FLOW_WINDOW_MS', 60_000,
          { min: 5_000, max: 5 * 60_000 },
        ),
        maxFlowWaitMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_MAX_FLOW_WAIT_MS', 60_000,
          { min: 5_000, max: 5 * 60_000 },
        ),
        minFlowNetSol: numberEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_MIN_FLOW_NET_SOL', 0, { min: 0 },
        ),
        minFlowBuyers: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_MIN_FLOW_BUYERS', 2, { min: 1 },
        ),
        minFlowBuyTx: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_MIN_FLOW_BUY_TX', 2, { min: 1 },
        ),
        requirePositiveFlow: true,
        requireFlowAcceleration: false,
        entryDelayMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_ENTRY_DELAY_MS', 200, { min: 0 },
        ),
        entryTimeoutMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_ENTRY_TIMEOUT_MS', 30_000,
          { min: 1_000, max: 120_000 },
        ),
        scoutFraction: 0,
        exitProfileIds: ['CORE80_RUNNER30M'],
      },
      booleanEnv('FLOW_SMART_CONSENSUS_V2_POST_GRAD_HOLD3_DIRECT_ENABLED', true) && {
        id: 'POST_GRAD_HOLD3_DIRECT',
        label: '真实AMM毕业 · 3个独立集群仍持仓 · 下一笔可执行成交直接入场',
        strength: 'HOLDING_STRONG_DIRECT',
        postGraduationHoldingConsensus: true,
        directPostGraduationEntry: true,
        requiredHoldingClusters: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_HOLDING_CLUSTERS', 3, { min: 2 },
        ),
        minWeightedScoreRatio: numberEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_MIN_WEIGHT_RATIO', 0.5,
          { min: 0, max: 1 },
        ),
        entryDelayMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_ENTRY_DELAY_MS', 200, { min: 0 },
        ),
        entryTimeoutMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_ENTRY_TIMEOUT_MS', 30_000,
          { min: 1_000, max: 120_000 },
        ),
        scoutFraction: 0,
        exitProfileIds: [
          'POST_GRAD_HOLD3_FIX2M',
          'POST_GRAD_HOLD3_FIX5M',
          'POST_GRAD_HOLD3_CORE80_5M',
          'POST_GRAD_HOLD3_CORE80_30M',
          'POST_GRAD_HOLD3_CORE80_6H',
        ],
      },
      booleanEnv('FLOW_SMART_CONSENSUS_V2_EARLY_C25_R3_ENABLED', true) && {
        id: 'EARLY_C25_R3',
        label: '宽松对照 · 早期Curve<25% · 180秒3个独立集群',
        strength: 'RESEARCH_FIXED',
        consensusWindowMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_EARLY_C25_WINDOW_MS', 180_000, { min: 30_000 },
        ),
        requiredClusters: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_EARLY_C25_REQUIRED_CLUSTERS', 3, { min: 2 },
        ),
        minSelectionAClusters: 0,
        minWeightedScoreRatio: numberEnv(
          'FLOW_SMART_CONSENSUS_V2_EARLY_C25_MIN_WEIGHT_RATIO', 0.5,
          { min: 0, max: 1 },
        ),
        minCurvePct: 0,
        maxCurvePct: numberEnv(
          'FLOW_SMART_CONSENSUS_V2_EARLY_C25_MAX_CURVE_PCT', 25,
          { min: 1, max: 100 },
        ),
        directCurveEntry: true,
        scoutFraction: 1,
        exitProfileIds: ['FIX30', 'CORE80_RUNNER6H_SP30T20'],
      },
    ].filter(Boolean),
    exitProfiles: [
      {
        id: 'FIX30', label: '固定30秒早期共振对照', mode: 'FIXED_HOLD',
        fixedHoldMs: 30_000, maxHoldMs: 30_000, hardStopPct: 20,
        entryProfileIds: ['EARLY_C25_R3'],
      },
      {
        id: 'FIX120_H20', label: '固定120秒对照', mode: 'FIXED_HOLD',
        fixedHoldMs: 120_000, maxHoldMs: 120_000, hardStopPct: 20,
      },
      {
        id: 'CORE80_RUNNER6H', label: '+30%卖80%核心仓，余仓30%回撤退出',
        mode: 'CORE_RUNNER', coreActivationPct: 30, coreFraction: 0.8,
        runnerTrailPct: 30, maxHoldMs: 6 * 60 * 60_000, hardStopPct: 20,
      },
      {
        id: 'CORE80_RUNNER6H_SP30T20',
        label: 'Scout峰值保护 + +30%卖80%核心仓，余仓30%回撤退出',
        mode: 'CORE_RUNNER', coreActivationPct: 30, coreFraction: 0.8,
        runnerTrailPct: 30, maxHoldMs: 6 * 60 * 60_000, hardStopPct: 20,
        scoutProtectActivationPct: 30, scoutProtectTrailPct: 20,
        scoutProtectFloorPct: 5,
      },
      {
        id: 'CORE80_RUNNER30M',
        label: '毕业持仓共振 · +30%卖80% · 20% Runner回撤30% · 最长30分钟',
        mode: 'CORE_RUNNER', coreActivationPct: 30, coreFraction: 0.8,
        runnerTrailPct: 30,
        maxHoldMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_MAX_HOLD_MS', 30 * 60_000,
          { min: 60_000, max: 6 * 60 * 60_000 },
        ),
        hardStopPct: 20,
        exitTimeoutMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_EXIT_TIMEOUT_MS', 30_000,
          { min: 1_000, max: 120_000 },
        ),
        entryProfileIds: ['POST_GRAD_HOLD3_FLOW2_60'],
      },
      {
        id: 'POST_GRAD_HOLD3_FIX2M',
        label: '毕业持仓3集群 · 固定持有2分钟',
        mode: 'FIXED_HOLD', fixedHoldMs: 2 * 60_000, maxHoldMs: 2 * 60_000,
        hardStopPct: 100,
        exitTimeoutMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_EXIT_TIMEOUT_MS', 30_000,
          { min: 1_000, max: 120_000 },
        ),
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
      {
        id: 'POST_GRAD_HOLD3_FIX5M',
        label: '毕业持仓3集群 · 固定持有5分钟',
        mode: 'FIXED_HOLD', fixedHoldMs: 5 * 60_000, maxHoldMs: 5 * 60_000,
        hardStopPct: 100,
        exitTimeoutMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_EXIT_TIMEOUT_MS', 30_000,
          { min: 1_000, max: 120_000 },
        ),
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
      {
        id: 'POST_GRAD_HOLD3_CORE80_5M',
        label: '毕业持仓3集群 · +30%卖80% · 20%回撤Runner · 最长5分钟',
        mode: 'CORE_RUNNER', coreActivationPct: 30, coreFraction: 0.8,
        runnerTrailPct: 20, maxHoldMs: 5 * 60_000, hardStopPct: 20,
        exitTimeoutMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_EXIT_TIMEOUT_MS', 30_000,
          { min: 1_000, max: 120_000 },
        ),
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
      {
        id: 'POST_GRAD_HOLD3_CORE80_30M',
        label: '毕业持仓3集群 · 不要求首分钟净流入 · +30%卖80% · 30%回撤 · 最长30分钟',
        mode: 'CORE_RUNNER', coreActivationPct: 30, coreFraction: 0.8,
        runnerTrailPct: 30,
        maxHoldMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_DIRECT_30M_MAX_HOLD_MS',
          30 * 60_000,
          { min: 5 * 60_000, max: 60 * 60_000 },
        ),
        hardStopPct: 30,
        exitTimeoutMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_EXIT_TIMEOUT_MS', 30_000,
          { min: 1_000, max: 120_000 },
        ),
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
      {
        id: 'POST_GRAD_HOLD3_CORE80_6H',
        label: '毕业持仓3集群 · 延迟拉升右尾 · +30%卖80% · 30%回撤 · 最长6小时',
        mode: 'CORE_RUNNER', coreActivationPct: 30, coreFraction: 0.8,
        runnerTrailPct: 30,
        maxHoldMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_DIRECT_6H_MAX_HOLD_MS',
          6 * 60 * 60_000,
          { min: 30 * 60_000, max: 12 * 60 * 60_000 },
        ),
        hardStopPct: 30,
        exitTimeoutMs: integerEnv(
          'FLOW_SMART_CONSENSUS_V2_POST_GRAD_EXIT_TIMEOUT_MS', 30_000,
          { min: 1_000, max: 120_000 },
        ),
        entryProfileIds: ['POST_GRAD_HOLD3_DIRECT'],
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_CONSENSUS_V2_POSITION_SOL'),
    }),
  },

  // Forward-only A/B layer: keep every source Shadow cohort untouched, then
  // measure the exact same simulated fills only when a qualified Registry
  // consensus existed before the source signal. It observes persisted rows,
  // does not duplicate execution state, and can never send a transaction.
  smartWalletConsensusOverlay: {
    enabled: booleanEnv('FLOW_SMART_CONSENSUS_OVERLAY_ENABLED', true),
    consensusEntryProfileIds: [
      'PA3_POST_FLOW_V1',
      'PA3_SCOUT15_FLOW_V1',
      'PA3_EARLY_C25_V1',
    ],
    gateWindowMs: integerEnv(
      'FLOW_SMART_CONSENSUS_OVERLAY_WINDOW_MS', 15 * 60_000, { min: 60_000 },
    ),
    gateFinalizeDelayMs: integerEnv(
      'FLOW_SMART_CONSENSUS_OVERLAY_FINALIZE_DELAY_MS', 60_000, { min: 5_000 },
    ),
    syncMs: integerEnv('FLOW_SMART_CONSENSUS_OVERLAY_SYNC_MS', 5_000, { min: 1_000 }),
    maxRowsPerSync: integerEnv(
      'FLOW_SMART_CONSENSUS_OVERLAY_MAX_ROWS_PER_SYNC', 2_000,
      { min: 10, max: 20_000 },
    ),
    profiles: [
      {
        id: 'SWC_G_GE30_R23_F2_G2_XLEG',
        label: 'G · GE30 R23 F2 G2 XLEG + Smart共识',
        source: 'MIGRATED_DROP_REBOUND',
        sourceCohortId: 'POST_GE30_R23_F2_ONLY_G2_XLEG',
      },
      {
        id: 'SWC_G_GD25_35_X8',
        label: 'G · GD25-35 X8 + Smart共识',
        source: 'MIGRATED_DROP_REBOUND',
        sourceCohortId: 'POST_GD25_35_X8',
      },
      {
        id: 'SWC_O_C80_D5_B2_S0_NC',
        label: 'O · C80 D5 B2 S0 NC + Smart共识',
        source: 'GRADUATION_ACCELERATION',
        sourceCohortId: 'O_C80_D5_B2_S0_NC:1SOL',
      },
      {
        id: 'SWC_O90_M5_STAIR120',
        label: 'O · O90 M5 STAIR120 + Smart共识',
        source: 'GRADUATION_ACCELERATION',
        sourceCohortId: 'O90_M5_STAIR120:1SOL',
      },
      {
        id: 'SWC_FEA_BNH_120',
        label: 'FEA · BNH-120 + Smart共识',
        source: 'FEATURE_EDGE_BNH',
        sourceCohortId: 'FEA_BNH_120',
      },
    ],
  },

  // Forward-only study of why monitored Smart Wallet first entries avoid rapid
  // collapses. It never follows ADD events and never changes a live decision.
  // Every OPEN creates an unguarded fixed-hold control, a causal 10-second
  // emergency-exit cohort, and an isolated synthetic-ramp guard cohort.
  smartWalletRugEscapeShadow: {
    enabled: booleanEnv('FLOW_SMART_WALLET_RUG_ESCAPE_SHADOW_ENABLED', true),
    positionSizeSol: shadowPositionEnv('FLOW_SMART_WALLET_RUG_ESCAPE_POSITION_SOL'),
    entryDelayMs: integerEnv('FLOW_SMART_WALLET_RUG_ESCAPE_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SMART_WALLET_RUG_ESCAPE_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SMART_WALLET_RUG_ESCAPE_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SMART_WALLET_RUG_ESCAPE_EXIT_TIMEOUT_MS', 2_000, { min: 1 }),
    emergencyWindowMs: integerEnv('FLOW_SMART_WALLET_RUG_ESCAPE_EMERGENCY_WINDOW_MS', 10_000, {
      min: 1_000,
    }),
    emergencyRecentFlowMs: integerEnv(
      'FLOW_SMART_WALLET_RUG_ESCAPE_RECENT_FLOW_MS',
      1_000,
      { min: 250 },
    ),
    labelHorizonMs: integerEnv('FLOW_SMART_WALLET_RUG_ESCAPE_LABEL_HORIZON_MS', 30_000, {
      min: 10_000,
    }),
    minLargeSellSol: numberEnv('FLOW_SMART_WALLET_RUG_ESCAPE_MIN_LARGE_SELL_SOL', 1, {
      min: 0,
    }),
    minSellBuyFlowRatio: numberEnv(
      'FLOW_SMART_WALLET_RUG_ESCAPE_MIN_SELL_BUY_FLOW_RATIO',
      0.35,
      { min: 0, max: 10 },
    ),
    flowFlipNetSol: numberEnv('FLOW_SMART_WALLET_RUG_ESCAPE_FLOW_FLIP_SOL', -1, {
      max: 0,
    }),
    buyerStallMs: integerEnv('FLOW_SMART_WALLET_RUG_ESCAPE_BUYER_STALL_MS', 1_500, {
      min: 250,
    }),
    minBuyersBeforeStall: integerEnv(
      'FLOW_SMART_WALLET_RUG_ESCAPE_MIN_BUYERS_BEFORE_STALL',
      3,
      { min: 1 },
    ),
    fastDropPct: numberEnv('FLOW_SMART_WALLET_RUG_ESCAPE_FAST_DROP_PCT', 15, {
      min: 1, max: 100,
    }),
    rug50Pct: numberEnv('FLOW_SMART_WALLET_RUG_ESCAPE_RUG50_PCT', 50, {
      min: 1, max: 100,
    }),
    rug70Pct: numberEnv('FLOW_SMART_WALLET_RUG_ESCAPE_RUG70_PCT', 70, {
      min: 1, max: 100,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_SMART_WALLET_RUG_ESCAPE_MAX_ENTRY_JUMP_PCT', 20, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_SMART_WALLET_RUG_ESCAPE_MAX_ENTRY_DROP_PCT', 30, {
      min: 0, max: 100,
    }),
    syntheticMinFlags: integerEnv('FLOW_SMART_WALLET_RUG_ESCAPE_SYNTH_MIN_FLAGS', 2, {
      min: 1,
    }),
    syntheticMinRunupPct: numberEnv('FLOW_SMART_WALLET_RUG_ESCAPE_SYNTH_MIN_RUNUP_PCT', 25),
    syntheticMinBuySharePct: numberEnv(
      'FLOW_SMART_WALLET_RUG_ESCAPE_SYNTH_MIN_BUY_SHARE_PCT',
      80,
      { min: 0, max: 100 },
    ),
    syntheticMaxAlternationPct: numberEnv(
      'FLOW_SMART_WALLET_RUG_ESCAPE_SYNTH_MAX_ALTERNATION_PCT',
      20,
      { min: 0, max: 100 },
    ),
    syntheticMinConsecutiveBuys: integerEnv(
      'FLOW_SMART_WALLET_RUG_ESCAPE_SYNTH_MIN_CONSECUTIVE_BUYS',
      8,
      { min: 1 },
    ),
    syntheticMinRepeatedSizePct: numberEnv(
      'FLOW_SMART_WALLET_RUG_ESCAPE_SYNTH_MIN_REPEATED_SIZE_PCT',
      35,
      { min: 0, max: 100 },
    ),
    syntheticMinWalletSharePct: numberEnv(
      'FLOW_SMART_WALLET_RUG_ESCAPE_SYNTH_MIN_WALLET_SHARE_PCT',
      35,
      { min: 0, max: 100 },
    ),
    profiles: [
      {
        id: 'BASE_T30', label: 'First OPEN · fixed 30s control',
        syntheticGuard: false, emergencyExit: false, holdMs: 30_000,
      },
      {
        id: 'EE10', label: 'First OPEN · 10s causal emergency escape',
        syntheticGuard: false, emergencyExit: true, holdMs: 30_000,
      },
      {
        id: 'SRG_EE10', label: 'Synthetic ramp guard + 10s emergency escape',
        syntheticGuard: true, emergencyExit: true, holdMs: 30_000,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_WALLET_RUG_ESCAPE_POSITION_SOL'),
    }),
  },

  // Wallet-specific copyability research. Each address owns an isolated table,
  // trigger, execution path and exit grid. A second wallet can never complete
  // or strengthen another wallet's signal, and no row can reach live trading.
  individualSmartWalletShadows: {
    enabled: booleanEnv('FLOW_INDIVIDUAL_SMART_WALLET_SHADOW_ENABLED', true),
    defaults: {
      positionSizeSol: numberEnv('FLOW_INDIVIDUAL_SMART_WALLET_POSITION_SOL', 0.1, {
        min: 0.01, max: 10,
      }),
      entryDelayMs: integerEnv('FLOW_INDIVIDUAL_SMART_WALLET_ENTRY_DELAY_MS', 200, {
        min: 0, max: 10_000,
      }),
      entryTimeoutMs: integerEnv('FLOW_INDIVIDUAL_SMART_WALLET_ENTRY_TIMEOUT_MS', 2_000, {
        min: 100, max: 30_000,
      }),
      exitDelayMs: integerEnv('FLOW_INDIVIDUAL_SMART_WALLET_EXIT_DELAY_MS', 200, {
        min: 0, max: 10_000,
      }),
      exitTimeoutMs: integerEnv('FLOW_INDIVIDUAL_SMART_WALLET_EXIT_TIMEOUT_MS', 5_000, {
        min: 100, max: 30_000,
      }),
      flowFadeWindowMs: 3_000,
      maxEntryPriceJumpPct: numberEnv(
        'FLOW_INDIVIDUAL_SMART_WALLET_MAX_ENTRY_JUMP_PCT', 10,
        { min: 0, max: 100 },
      ),
      maxEntryPriceDropPct: numberEnv(
        'FLOW_INDIVIDUAL_SMART_WALLET_MAX_ENTRY_DROP_PCT', 30,
        { min: 0, max: 100 },
      ),
      maxEntryImpactPct: numberEnv(
        'FLOW_INDIVIDUAL_SMART_WALLET_MAX_ENTRY_IMPACT_PCT', 5,
        { min: 0, max: 100 },
      ),
      costModel: normalizeCostModel({
        ...labelCostModel,
        positionSizeSol: numberEnv('FLOW_INDIVIDUAL_SMART_WALLET_POSITION_SOL', 0.1, {
          min: 0.01, max: 10,
        }),
      }),
    },
    profiles: [
      {
        id: 'ARDIN_CURVE',
        strategyCode: 'SEED-ARDIN-CURVE-S1',
        strategyName: 'ARDIN 独立 Curve 跟单研究',
        label: 'ARDIN · Curve 独立跟单',
        thesis: '验证 ARDIN 的中短线 Curve 选择与退出能否按下一笔成交复制。',
        targetWallet: process.env.FLOW_INDIVIDUAL_ARDIN_WALLET
          || 'ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT',
        targetMarket: 'PUMP_BONDING_CURVE',
        allowCrossMarketExit: true,
        storageTable: 'individual_smart_wallet_ardin_curve_shadow_positions',
        modeCode: 'SHADOW_SEED_ARDIN_CURVE',
        maxEpisodeMs: 310_000,
        entryProfiles: [
          { id: 'RAW_EXEC', label: '原始可执行跟单对照', riskGuardEnabled: false },
          {
            id: 'SAFE_R70_B10', label: '前涨幅≤70%且最长连买≤10',
            riskGuardEnabled: true, maxPreReturnPct: 70, maxConsecutiveBuys: 10,
          },
        ],
        exitProfiles: [
          { id: 'FIX60_H18', label: '固定60秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 60_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'FIX120_H18', label: '固定120秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 120_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'FIX240_H18', label: '固定240秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 240_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'WALLET_X240_H18', label: '跟随钱包卖出 / 最长240秒', mode: 'WALLET_EXIT', maxHoldMs: 240_000, hardStopPct: 18, coreWeightPct: 0 },
        ],
      },
      {
        id: '4VW_CURVE',
        strategyCode: 'SEED-4VW-CURVE-S1',
        strategyName: '4VW 独立 Curve 跟单研究',
        label: '4VW · Curve 独立跟单',
        thesis: '验证 4VW 的一分钟级 Curve 短线是否具备0.1 SOL复制性。',
        targetWallet: process.env.FLOW_INDIVIDUAL_4VW_WALLET
          || '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9',
        targetMarket: 'PUMP_BONDING_CURVE',
        allowCrossMarketExit: true,
        storageTable: 'individual_smart_wallet_4vw_curve_shadow_positions',
        modeCode: 'SHADOW_SEED_4VW_CURVE',
        maxEpisodeMs: 190_000,
        entryProfiles: [
          { id: 'RAW_EXEC', label: '原始可执行跟单对照', riskGuardEnabled: false },
          {
            id: 'SAFE_R70_B10', label: '前涨幅≤70%且最长连买≤10',
            riskGuardEnabled: true, maxPreReturnPct: 70, maxConsecutiveBuys: 10,
          },
        ],
        exitProfiles: [
          { id: 'FIX30_H18', label: '固定30秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 30_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'FIX60_H18', label: '固定60秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 60_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'FIX120_H18', label: '固定120秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 120_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'WALLET_X120_H18', label: '跟随钱包卖出 / 最长120秒', mode: 'WALLET_EXIT', maxHoldMs: 120_000, hardStopPct: 18, coreWeightPct: 0 },
        ],
      },
      {
        id: 'DZ_AMM',
        strategyCode: 'SEED-DZ-AMM-S1',
        strategyName: 'DZ 独立毕业后 AMM 跟单研究',
        label: 'DZ · 毕业后 AMM 独立跟单',
        thesis: '把 DZ 的毕业后交易与所有 Curve 钱包分离，检验中短线持有。',
        targetWallet: process.env.FLOW_INDIVIDUAL_DZ_WALLET
          || 'DZbgq3yE3r41EFszV3XastvyS8j8QnmNT37nsq7sxR66',
        targetMarket: 'PUMP_AMM',
        allowCrossMarketExit: false,
        storageTable: 'individual_smart_wallet_dz_amm_shadow_positions',
        modeCode: 'SHADOW_SEED_DZ_AMM',
        maxEpisodeMs: 670_000,
        entryProfiles: [
          { id: 'RAW_EXEC', label: '原始可执行跟单对照', riskGuardEnabled: false },
          {
            id: 'SAFE_R100_B12', label: '前涨幅≤100%且最长连买≤12',
            riskGuardEnabled: true, maxPreReturnPct: 100, maxConsecutiveBuys: 12,
          },
        ],
        exitProfiles: [
          { id: 'FIX60_H18', label: '固定60秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 60_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'FIX180_H18', label: '固定180秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 180_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'FIX600_H18', label: '固定600秒 / 硬止损18%', mode: 'FIXED_HOLD', maxHoldMs: 600_000, hardStopPct: 18, coreWeightPct: 0 },
          { id: 'WALLET_X600_H18', label: '跟随钱包卖出 / 最长600秒', mode: 'WALLET_EXIT', maxHoldMs: 600_000, hardStopPct: 18, coreWeightPct: 0 },
        ],
      },
    ],
  },

  // Historical Smart-first trigger experiment. Waiting for the monitored OPEN
  // proved causally late, so a second explicit gate defaults to false even when
  // an older server .env still contains the original ENABLED=true setting.
  // Rows remain queryable; new causal entries live in Public Flow Lead V2 below.
  smartWalletFirstOpenRightTailShadow: {
    enabled: booleanEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_TRIGGER_V2_ENABLED', false)
      && booleanEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_POSITION_SOL'),
    entryDelayMs: integerEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_EXIT_TIMEOUT_MS', 2_000, { min: 1 }),
    flowFadeWindowMs: integerEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_FLOW_FADE_WINDOW_MS', 3_000, {
      min: 500,
    }),
    maxEpisodeMs: integerEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_MAX_EPISODE_MS', 130_000, {
      min: 20_000,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_MAX_ENTRY_JUMP_PCT', 20, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_MAX_ENTRY_DROP_PCT', 30, {
      min: 0, max: 100,
    }),
    entryProfiles: [
      {
        id: 'S50_R8', label: 'Strict · pre-return <=50% · consecutive buys <=8',
        maxPreReturnPct: 50, maxConsecutiveBuys: 8,
      },
      {
        id: 'B70_R10', label: 'Balanced · pre-return <=70% · consecutive buys <=10',
        maxPreReturnPct: 70, maxConsecutiveBuys: 10,
      },
    ],
    exitProfiles: [
      {
        id: 'X20', label: 'Fixed 20s control', mode: 'FIXED_HOLD',
        maxHoldMs: 20_000, hardStopPct: 0, coreWeightPct: 0,
      },
      {
        id: 'X60', label: 'Fixed 60s control', mode: 'FIXED_HOLD',
        maxHoldMs: 60_000, hardStopPct: 0, coreWeightPct: 0,
      },
      {
        id: 'X120', label: 'Fixed 120s control', mode: 'FIXED_HOLD',
        maxHoldMs: 120_000, hardStopPct: 0, coreWeightPct: 0,
      },
      {
        id: 'FF15_X120', label: '15s protection + 3s flow-fade / max 120s', mode: 'FLOW_FADE',
        protectionMs: 15_000, flowFadeNetSol: -0.5, maxHoldMs: 120_000,
        hardStopPct: 20, coreWeightPct: 0,
      },
      {
        id: 'C25_R75_X120', label: '25% core + 75% protected runner / max 120s', mode: 'CORE_RUNNER',
        coreWeightPct: 25, coreActivationPct: 50, trailingDrawdownPct: 20,
        hardStopPct: 20, maxHoldMs: 120_000,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_POSITION_SOL'),
    }),
  },

  // Public-order-flow lead study derived from the pre-buy structure observed
  // around profitable Smart Wallet entries. Entry never waits for or consumes a
  // Smart Wallet event. A later Smart OPEN is stored only as a future label;
  // ADD events are intentionally ignored because repeated small adds can be
  // promotional rather than incremental conviction.
  publicFlowLeadShadow: {
    enabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_PUBLIC_FLOW_LEAD_V2_ENABLED', false),
    // Forward public-flow signals remain useful as labels, but the first live
    // sample invalidated the simulated-entry edge. Keep observation on while
    // stopping new paper positions by default; historical rows stay queryable.
    simulatePositions: booleanEnv(
      'FLOW_PUBLIC_FLOW_LEAD_SIMULATED_ENTRIES_ENABLED',
      false,
    ),
    positionSizeSol: shadowPositionEnv('FLOW_PUBLIC_FLOW_LEAD_POSITION_SOL'),
    featureWindowMs: integerEnv('FLOW_PUBLIC_FLOW_LEAD_FEATURE_WINDOW_MS', 5_000, {
      min: 2_000,
    }),
    stateRetentionMs: integerEnv('FLOW_PUBLIC_FLOW_LEAD_STATE_RETENTION_MS', 10 * 60_000, {
      min: 60_000,
    }),
    episodeCooldownMs: integerEnv('FLOW_PUBLIC_FLOW_LEAD_EPISODE_COOLDOWN_MS', 30_000, {
      min: 1_000,
    }),
    smartLabelWindowMs: integerEnv('FLOW_PUBLIC_FLOW_LEAD_SMART_LABEL_WINDOW_MS', 15_000, {
      min: 5_000,
    }),
    entryDelayMs: integerEnv('FLOW_PUBLIC_FLOW_LEAD_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_PUBLIC_FLOW_LEAD_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_PUBLIC_FLOW_LEAD_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_PUBLIC_FLOW_LEAD_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_PUBLIC_FLOW_LEAD_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_PUBLIC_FLOW_LEAD_MAX_ENTRY_DROP_PCT', 30, {
      min: 0, max: 100,
    }),
    maxCrossMarketPriceJumpPct: numberEnv(
      'FLOW_PUBLIC_FLOW_LEAD_MAX_CROSS_MARKET_JUMP_PCT',
      50,
      { min: 0, max: 1_000 },
    ),
    entryProfiles: [
      {
        id: 'PFL_S50_R8',
        label: 'PFL-S50-R8 · strict public-flow lead / future Smart label',
        minAgeMs: 3_000, maxAgeMs: 45_000,
        minCurvePct: 20, maxCurvePct: 85,
        minPublicBuyers1s: 2, minPublicBuyers5s: 6,
        minPublicBuyFlow1sSol: 0.5, minPublicBuyFlow5sSol: 2,
        minPublicNetFlow5sSol: 1, maxLargestBuyerSharePct: 35,
        maxReturn5sPct: 30,
        requirePreRiskSampleReady: true,
        maxPreReturnPct: 50,
        maxPreConsecutiveBuys: 8,
      },
      {
        id: 'PFL_B70_R10',
        label: 'PFL-B70-R10 · balanced public-flow lead / future Smart label',
        minAgeMs: 3_000, maxAgeMs: 60_000,
        minCurvePct: 20, maxCurvePct: 90,
        minPublicBuyers1s: 1, minPublicBuyers5s: 4,
        minPublicBuyFlow1sSol: 0.25, minPublicBuyFlow5sSol: 1,
        minPublicNetFlow5sSol: 0.5, maxLargestBuyerSharePct: 45,
        maxReturn5sPct: 40,
        requirePreRiskSampleReady: true,
        maxPreReturnPct: 70,
        maxPreConsecutiveBuys: 10,
      },
      ...(publicFlowLeadLegacyProfilesEnabled ? [
      {
        id: 'PFL_B0',
        label: 'PFL-B0 · broad public breadth baseline',
        minAgeMs: 10_000, maxAgeMs: 35_000,
        minCurvePct: 55, maxCurvePct: 85,
        minPublicBuyers5s: 20, minPublicBuyFlow5sSol: 12,
        minPublicNetFlow5sSol: 0, maxLargestBuyerSharePct: 30,
        maxReturn5sPct: 40,
      },
      {
        id: 'PFL_B1',
        label: 'PFL-B1 · big-winner analogue / early diversified flow',
        minAgeMs: 5_000, maxAgeMs: 25_000,
        minCurvePct: 60, maxCurvePct: 80,
        minPublicBuyers5s: 25, minPublicBuyFlow5sSol: 15,
        minPublicNetFlow5sSol: 2.5, maxLargestBuyerSharePct: 20,
        maxReturn5sPct: 30,
      },
      {
        id: 'PFL_A1',
        label: 'PFL-A1 · 1s public-flow re-acceleration',
        minAgeMs: 5_000, maxAgeMs: 30_000,
        minCurvePct: 55, maxCurvePct: 85,
        minPublicBuyers1s: 5, minPublicBuyers5s: 20,
        minPublicBuyFlow1sSol: 3, minPublicBuyFlow5sSol: 12,
        minPublicNetFlow5sSol: 0, maxLargestBuyerSharePct: 25,
        minFlowAccelerationRatio: 1.5, maxReturn5sPct: 35,
      },
      {
        id: 'PFL_R1',
        label: 'PFL-R1 · healthy two-way rotation / broad demand',
        minAgeMs: 10_000, maxAgeMs: 35_000,
        minCurvePct: 60, maxCurvePct: 85,
        minPublicBuyers5s: 20, minPublicBuyFlow5sSol: 12,
        minPublicNetFlow5sSol: 0, maxLargestBuyerSharePct: 25,
        minSellBuyRatio: 0.35, maxSellBuyRatio: 0.9,
        maxReturn5sPct: 30,
      },
      ] : []),
      ...(booleanEnv('FLOW_PUBLIC_FLOW_LEAD_B2_ENABLED', false) ? [{
        id: 'PFL_B2',
        label: 'PFL-B2 · 8–12s diversified flow / future Smart OPEN study',
        minAgeMs: 8_000, maxAgeMs: 12_000,
        minCurvePct: 60, maxCurvePct: 75,
        minPublicBuyers1s: 9, maxPublicBuyers1s: 12,
        minPublicBuyers5s: 45,
        minPublicBuyFlow5sSol: 26, maxPublicBuyFlow5sSol: 35,
        minPublicNetFlow5sSol: 2,
        maxLargestBuyerSharePct: 15,
        minReturn5sPct: 10, maxReturn5sPct: 25,
        minFlowAccelerationRatio: 1, maxFlowAccelerationRatio: 2.5,
      }] : []),
    ],
    exitProfiles: [20, 30].flatMap((hardStopPct) => (
      [120, 180, 240].map((holdSeconds) => ({
        id: `H${hardStopPct}_T${holdSeconds}`,
        label: `Hard stop ${hardStopPct}% / fixed ${holdSeconds}s`,
        hardStopPct,
        maxHoldMs: holdSeconds * 1_000,
      }))
    )),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_PUBLIC_FLOW_LEAD_POSITION_SOL'),
    }),
  },

  // PFAR-V1 is a clean forward experiment learned from profitable Smart-Wallet
  // entry context, but its A/B entry path reads only anonymous public trades.
  // Smart Wallet identity is retained solely as a B label and as the isolated
  // J36 control cohort; none of these rows can reach LiveTradingManager.
  publicFlowAbsorptionRecoveryShadow: {
    enabled: booleanEnv('FLOW_PUBLIC_FLOW_RECOVERY_SHADOW_ENABLED', true),
    positionSizeSol: numberEnv('FLOW_PUBLIC_FLOW_RECOVERY_POSITION_SOL', 0.1, {
      min: 0.01,
      max: 10,
    }),
    structureWindowMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_STRUCTURE_WINDOW_MS', 10_000,
      { min: 5_000, max: 30_000 },
    ),
    stateRetentionMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_STATE_RETENTION_MS', 46 * 60_000,
      { min: 10 * 60_000, max: 2 * 60 * 60_000 },
    ),
    completeHistoryMaxInitialAgeMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_COMPLETE_HISTORY_MAX_INITIAL_AGE_MS', 2_000,
      { min: 0, max: 30_000 },
    ),
    retentionFloorFraction: numberEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_RETENTION_FLOOR_PCT', 10,
      { min: 0, max: 100 },
    ) / 100,
    observationMinPullbackPct: numberEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_OBSERVE_MIN_PULLBACK_PCT', 6,
      { min: 0.1, max: 100 },
    ),
    observationMinReboundPct: numberEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_OBSERVE_MIN_REBOUND_PCT', 2,
      { min: 0.1, max: 100 },
    ),
    rejectionObservationCooldownMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_REJECTION_OBSERVATION_COOLDOWN_MS', 2_000,
      { min: 250, max: 60_000 },
    ),
    entryDelayMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_ENTRY_DELAY_MS', 200,
      { min: 0, max: 10_000 },
    ),
    entryTimeoutMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_ENTRY_TIMEOUT_MS', 1_500,
      { min: 100, max: 30_000 },
    ),
    exitDelayMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_EXIT_DELAY_MS', 200,
      { min: 0, max: 10_000 },
    ),
    exitTimeoutMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_EXIT_TIMEOUT_MS', 5_000,
      { min: 100, max: 30_000 },
    ),
    maxEntryPriceJumpPct: numberEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_MAX_ENTRY_JUMP_PCT', 8,
      { min: 0, max: 100 },
    ),
    maxEntryPriceDropPct: numberEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_MAX_ENTRY_DROP_PCT', 30,
      { min: 0, max: 100 },
    ),
    maxEntryImpactPct: numberEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_MAX_ENTRY_IMPACT_PCT', 5,
      { min: 0, max: 100 },
    ),
    maxCrossMarketPriceJumpPct: numberEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_MAX_CROSS_MARKET_JUMP_PCT', 50,
      { min: 0, max: 1_000 },
    ),
    smartLookbackMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_SMART_LOOKBACK_MS', 5 * 60_000,
      { min: 0, max: 60 * 60_000 },
    ),
    smartFutureLabelWindowMs: integerEnv(
      'FLOW_PUBLIC_FLOW_RECOVERY_SMART_FUTURE_LABEL_WINDOW_MS', 15_000,
      { min: 1_000, max: 10 * 60_000 },
    ),
    j36Wallet: process.env.FLOW_PUBLIC_FLOW_RECOVERY_J36_WALLET
      || 'J36AVCr7uVoXwYgcL8yBmeCAatSLGLSjrCMaBca3sCXq',
    entryProfiles: [
      {
        id: 'PFAR_A_NO_WALLET',
        label: 'A · 纯公开流：抛压衰减 → 承接 → 恢复',
        trigger: 'PUBLIC_FLOW',
      },
      {
        id: 'PFAR_B_TAG_ONLY',
        label: 'B · 与A完全同入场；Smart Wallet只作标签',
        trigger: 'PUBLIC_FLOW',
      },
      {
        id: 'PFAR_C_J36_CONTROL',
        label: 'C · J36 OPEN + 同一公开结构对照',
        trigger: 'J36_OPEN',
        minTriggerBuySol: numberEnv(
          'FLOW_PUBLIC_FLOW_RECOVERY_J36_MIN_BUY_SOL', 0.2,
          { min: 0, max: 100 },
        ),
      },
    ].map((profile) => ({
      ...profile,
      requireCompleteHistory: true,
      minAgeMs: 5 * 60_000,
      maxAgeMs: 45 * 60_000,
      minCurvePct: 35,
      maxCurvePct: 70,
      minPullbackPct: 6,
      maxPullbackPct: 18,
      minReboundPct: 2,
      maxReboundPct: 8,
      minSelloffSellers: 2,
      minSelloffSellSol: 0.5,
      maxSelloffNetFlowSol: -0.5,
      minNetFlow3sSol: 0.5,
      minNetFlow5sSol: 0,
      minNetFlow10sSol: -5,
      minBuyers3s: 2,
      maxTop1BuyShare5sPct: 40,
      maxRecentSell1sSol: 0.5,
      minObservedHolders: 20,
      minFirstBuyerSample: 20,
      minFirst20RetentionPct: 50,
      maxTop3InventoryPct: 40,
      rejectCreatorSell5s: true,
    })),
    exitProfiles: [10, 15, 20].map((seconds) => ({
      id: `FIX${seconds}_H15`,
      label: `固定${seconds}秒 / 可执行收益硬止损15%`,
      maxHoldMs: seconds * 1_000,
      hardStopPct: 15,
    })),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: numberEnv('FLOW_PUBLIC_FLOW_RECOVERY_POSITION_SOL', 0.1, {
        min: 0.01,
        max: 10,
      }),
    }),
  },

  // Forward-only creator-affinity observer. Creator launch history from every
  // token already present in flow_tokens is kept separate from the selected
  // Smart-Wallet trade sample. Historical simulated positions remain readable,
  // but the disproven CAF entry family no longer creates new positions.
  creatorAffinityShadow: {
    enabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_CREATOR_AFFINITY_SHADOW_ENABLED', false),
    simulatePositions: false,
    storageTable: 'creator_affinity_shadow_positions',
    strategyCode: 'CAF',
    strategyName: 'Creator Affinity + Public Flow',
    modeCode: 'CAF',
    creatorAffinity: {
      enabled: true,
      lookbackMs: integerEnv(
        'FLOW_CREATOR_AFFINITY_LOOKBACK_MS',
        7 * 24 * 60 * 60_000,
        { min: 24 * 60 * 60_000 },
      ),
      serialLowQualityMinPriorLaunches: integerEnv(
        'FLOW_CREATOR_AFFINITY_SERIAL_LOW_QUALITY_MIN_PRIOR_LAUNCHES',
        20,
        { min: 1 },
      ),
      serialLowQualityMaxGraduationRatePct: numberEnv(
        'FLOW_CREATOR_AFFINITY_SERIAL_LOW_QUALITY_MAX_GRADUATION_RATE_PCT',
        2,
        { min: 0, max: 100 },
      ),
    },
    positionSizeSol: shadowPositionEnv('FLOW_CREATOR_AFFINITY_POSITION_SOL'),
    featureWindowMs: integerEnv('FLOW_CREATOR_AFFINITY_FEATURE_WINDOW_MS', 5_000, {
      min: 2_000,
    }),
    stateRetentionMs: integerEnv('FLOW_CREATOR_AFFINITY_STATE_RETENTION_MS', 10 * 60_000, {
      min: 60_000,
    }),
    episodeCooldownMs: integerEnv('FLOW_CREATOR_AFFINITY_EPISODE_COOLDOWN_MS', 30_000, {
      min: 1_000,
    }),
    smartLabelWindowMs: integerEnv('FLOW_CREATOR_AFFINITY_SMART_LABEL_WINDOW_MS', 15_000, {
      min: 5_000,
    }),
    entryDelayMs: integerEnv('FLOW_CREATOR_AFFINITY_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_CREATOR_AFFINITY_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_CREATOR_AFFINITY_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_CREATOR_AFFINITY_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_CREATOR_AFFINITY_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_CREATOR_AFFINITY_MAX_ENTRY_DROP_PCT', 30, {
      min: 0, max: 100,
    }),
    maxCrossMarketPriceJumpPct: numberEnv(
      'FLOW_CREATOR_AFFINITY_MAX_CROSS_MARKET_JUMP_PCT',
      50,
      { min: 0, max: 1_000 },
    ),
    entryProfiles: [
      {
        id: 'CAF_ALL_E15',
        label: 'CAF-ALL-E15 · current-DB all-launch observer baseline',
        minAgeMs: 3_000, maxAgeMs: 15_000,
        minCurvePct: 10, maxCurvePct: 85,
        minPublicBuyers1s: 1, minPublicBuyers5s: 3,
        minPublicBuyFlow5sSol: 0.5, minPublicNetFlow5sSol: 0.25,
        maxLargestBuyerSharePct: 50, maxReturn5sPct: 50,
        requirePreRiskSampleReady: true,
        maxPreReturnPct: 50, maxPreConsecutiveBuys: 8,
      },
      {
        id: 'CAF_W50_E10',
        label: 'CAF-W50-E10 · Smart sample win>=50% + all-launch quality',
        minAgeMs: 3_000, maxAgeMs: 10_000,
        minCurvePct: 10, maxCurvePct: 85,
        minPublicBuyers1s: 1, minPublicBuyers5s: 3,
        minPublicBuyFlow5sSol: 0.5, minPublicNetFlow5sSol: 0.25,
        maxLargestBuyerSharePct: 50, maxReturn5sPct: 50,
        minCreatorPriorCompleted: 3, minCreatorPriorWinRatePct: 50,
        minCreatorAllPriorLaunches: 3, minCreatorAllPriorGraduated: 1,
        minCreatorAllPriorGraduationRatePct: 2,
        rejectCreatorSerialLowQuality: true,
        requirePreRiskSampleReady: true,
        maxPreReturnPct: 50, maxPreConsecutiveBuys: 8,
      },
      {
        id: 'CAF_P0_E10',
        label: 'CAF-P0-E10 · Smart sample return>=0 + all-launch quality',
        minAgeMs: 3_000, maxAgeMs: 10_000,
        minCurvePct: 10, maxCurvePct: 85,
        minPublicBuyers1s: 1, minPublicBuyers5s: 3,
        minPublicBuyFlow5sSol: 0.5, minPublicNetFlow5sSol: 0.25,
        maxLargestBuyerSharePct: 50, maxReturn5sPct: 50,
        minCreatorPriorCompleted: 3, minCreatorPriorCapitalReturnPct: 0,
        minCreatorAllPriorLaunches: 3, minCreatorAllPriorGraduated: 1,
        minCreatorAllPriorGraduationRatePct: 2,
        rejectCreatorSerialLowQuality: true,
        requirePreRiskSampleReady: true,
        maxPreReturnPct: 50, maxPreConsecutiveBuys: 8,
      },
      {
        id: 'CAF_W50_B5_E15',
        label: 'CAF-W50-B5-E15 · Smart sample quality + broader public flow',
        minAgeMs: 3_000, maxAgeMs: 15_000,
        minCurvePct: 10, maxCurvePct: 85,
        minPublicBuyers1s: 1, minPublicBuyers5s: 5,
        minPublicBuyFlow5sSol: 1, minPublicNetFlow5sSol: 0.5,
        maxLargestBuyerSharePct: 45, maxReturn5sPct: 50,
        minCreatorPriorCompleted: 3, minCreatorPriorWinRatePct: 50,
        minCreatorAllPriorLaunches: 3, minCreatorAllPriorGraduated: 1,
        minCreatorAllPriorGraduationRatePct: 2,
        rejectCreatorSerialLowQuality: true,
        requirePreRiskSampleReady: true,
        maxPreReturnPct: 50, maxPreConsecutiveBuys: 8,
      },
    ],
    exitProfiles: [60, 120, 240].map((holdSeconds) => ({
      id: `H20_T${holdSeconds}`,
      label: `Hard stop 20% / fixed ${holdSeconds}s`,
      hardStopPct: 20,
      maxHoldMs: holdSeconds * 1_000,
    })),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_CREATOR_AFFINITY_POSITION_SOL'),
    }),
  },

  // Independent right-tail study. It consumes the existing PumpSwap trade stream,
  // opens no real positions, and never treats an unobservable exit as a total loss.
  bigWinnerShadow: {
    // V3 reopens only the PBR-C frequency entry for a clean forward sample.
    // The new key prevents a stale server V2=false from silently keeping the
    // suite paused after deployment; every other entry profile remains gated
    // independently below.
    enabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_BIG_WINNER_SHADOW_V3_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_BIG_WINNER_SHADOW_POSITION_SOL'),
    stateWindowMs: integerEnv('FLOW_BIG_WINNER_SHADOW_STATE_WINDOW_MS', 10_000, {
      min: 8_000,
    }),
    stateRetentionMs: integerEnv('FLOW_BIG_WINNER_SHADOW_STATE_RETENTION_MS', 10 * 60_000, {
      min: 6 * 60_000,
    }),
    entryDelayMs: integerEnv('FLOW_BIG_WINNER_SHADOW_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_BIG_WINNER_SHADOW_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    noExitGraceMs: integerEnv('FLOW_BIG_WINNER_SHADOW_NO_EXIT_GRACE_MS', 60_000, {
      min: 1_000,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_BIG_WINNER_SHADOW_MAX_ENTRY_JUMP_PCT', 50, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_BIG_WINNER_SHADOW_MAX_ENTRY_DROP_PCT', 50, {
      min: 0, max: 100,
    }),
    maxEntryImpactPct: numberEnv('FLOW_BIG_WINNER_SHADOW_MAX_ENTRY_IMPACT_PCT', 40, {
      min: 0, max: 1_000,
    }),
    maxAdjacentPriceRatio: numberEnv('FLOW_BIG_WINNER_SHADOW_MAX_PRICE_RATIO', 20, {
      min: 2, max: 1_000,
    }),
    transientUpPriceRatio: numberEnv(
      'FLOW_BIG_WINNER_SHADOW_TRANSIENT_UP_PRICE_RATIO', 2, { min: 1.1, max: 100 },
    ),
    priceConfirmationWindowMs: integerEnv(
      'FLOW_BIG_WINNER_SHADOW_PRICE_CONFIRMATION_WINDOW_MS', 500, { min: 10, max: 5_000 },
    ),
    priceConfirmationMinPersistenceMs: integerEnv(
      'FLOW_BIG_WINNER_SHADOW_PRICE_CONFIRMATION_MIN_PERSISTENCE_MS', 150,
      { min: 1, max: 5_000 },
    ),
    priceConfirmationTolerancePct: numberEnv(
      'FLOW_BIG_WINNER_SHADOW_PRICE_CONFIRMATION_TOLERANCE_PCT', 25,
      { min: 1, max: 100 },
    ),
    priceConfirmationMinWallets: integerEnv(
      'FLOW_BIG_WINNER_SHADOW_PRICE_CONFIRMATION_MIN_WALLETS', 2, { min: 1, max: 10 },
    ),
    entryProfiles: [
      {
        id: 'PBR_A',
        label: 'PBR-A balanced: wave 40 / pullback 12-25 / NF3 3',
        newEntriesEnabled: false,
        liveStrategyId: 'big_winner_pbr_a_x50_15_live',
        family: 'PULLBACK', minAgeMs: 5_000, maxAgeMs: 180_000,
        minFirstWavePct: 40, minPullbackPct: 12, maxPullbackPct: 25,
        minReboundPct: 2, maxReboundPct: 10, minNetFlow3sSol: 3,
        minBuyers3s: 4, maxSingleSell3sSol: 10, minCurrentVsBaselinePct: -10,
      },
      {
        id: 'PBR_A_B10_PB20',
        label: 'PBR-A-B10-PB20 · wave40 / pullback12-20 / NF3≥3 / Buyers3≥10',
        newEntriesEnabled: false,
        family: 'PULLBACK', minAgeMs: 5_000, maxAgeMs: 180_000,
        minFirstWavePct: 40, minPullbackPct: 12, maxPullbackPct: 20,
        minReboundPct: 2, maxReboundPct: 10, minNetFlow3sSol: 3,
        minBuyers3s: 10, maxSingleSell3sSol: 10, minCurrentVsBaselinePct: -10,
        exitProfileIds: ['X50_15'],
      },
      {
        id: 'PBR_B',
        label: 'PBR-B right tail: wave 50 / pullback 18-30 / NF3 2',
        newEntriesEnabled: false,
        family: 'PULLBACK', minAgeMs: 5_000, maxAgeMs: 180_000,
        minFirstWavePct: 50, minPullbackPct: 18, maxPullbackPct: 30,
        minReboundPct: 2, maxReboundPct: 10, minNetFlow3sSol: 2,
        minBuyers3s: 4, maxSingleSell3sSol: 10, minCurrentVsBaselinePct: -10,
      },
      {
        // Clean forward-only sample. The legacy PBR_B rows stay frozen so the
        // fragile right-tail result cannot be mixed with fresh observations.
        id: 'PBR_B_RT_V2',
        label: 'PBR-B-RT-V2 · wave50 / pullback18-30 / NF3≥2',
        newEntriesEnabled: booleanEnv('FLOW_BIG_WINNER_PBR_B_RT_V2_ENABLED', true),
        family: 'PULLBACK', minAgeMs: 5_000, maxAgeMs: 180_000,
        minFirstWavePct: 50, minPullbackPct: 18, maxPullbackPct: 30,
        minReboundPct: 2, maxReboundPct: 10, minNetFlow3sSol: 2,
        minBuyers3s: 4, maxSingleSell3sSol: 10, minCurrentVsBaselinePct: -10,
        exitProfileIds: ['X50_12', 'X50_RATCHET'],
      },
      {
        id: 'PBR_C',
        label: 'PBR-C frequency: wave 40 / pullback 15-25 / NF3 2',
        newEntriesEnabled: false,
        family: 'PULLBACK', minAgeMs: 5_000, maxAgeMs: 180_000,
        minFirstWavePct: 40, minPullbackPct: 15, maxPullbackPct: 25,
        minReboundPct: 2, maxReboundPct: 10, minNetFlow3sSol: 2,
        minBuyers3s: 4, maxSingleSell3sSol: 10, minCurrentVsBaselinePct: -10,
        exitProfileIds: ['X50_12', 'X50_15', 'X50_RATCHET'],
      },
      {
        id: 'FLOW_R',
        label: 'FLOW-R: post-grad 5-60s / NF8 20 / buyers 12 / no chase',
        newEntriesEnabled: false,
        family: 'FLOW', minAgeMs: 5_000, maxAgeMs: 60_000,
        minNetFlow8sSol: 20, minBuyers8s: 12, maxLargestBuyerShare8s: 0.5,
        maxRunupPct: 40, maxDistanceFromHigh10sPct: 10, maxJump2sPct: 20,
        minRecentFlowRatio: 0.5,
      },
      {
        id: 'PP_DIRECT_10',
        label: 'PP-Direct · 毕业后10–30秒 · 参与度持续确认',
        newEntriesEnabled: false,
        family: 'PARTICIPATION', mode: 'DIRECT', minAgeMs: 10_000, maxAgeMs: 30_000,
        minTrades10s: 40, minBuyers10s: 20, minNetFlow10sSol: 3,
        maxLargestBuyerShare10s: 0.55, minRecentBuyers5s: 8,
        minRecentNetFlow5sSol: 0, minRecentFlowRetentionRatio: 0.35,
        exitProfileIds: ['XFIX120_H15_PP', 'XFIX240_H15_PP', 'X25_RATCHET_PP'],
        capacityAware: true,
        positionSols: listEnv(
          'FLOW_BIG_WINNER_PP_CAPACITY_SOLS',
          ['0.05', '0.1', '0.25'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'PP_PULLBACK_8_20',
        label: 'PP-Pullback · 参与度确认后首次回踩8–20% + 二次加速',
        newEntriesEnabled: false,
        family: 'PARTICIPATION', mode: 'PULLBACK', minAgeMs: 10_000, maxAgeMs: 60_000,
        qualificationMaxAgeMs: 30_000,
        minTrades10s: 40, minBuyers10s: 20, minNetFlow10sSol: 3,
        maxLargestBuyerShare10s: 0.55, minRecentBuyers5s: 8,
        minRecentNetFlow5sSol: 0, minRecentFlowRetentionRatio: 0.35,
        minPullbackPct: 8, maxPullbackPct: 20,
        minReboundPct: 2, maxReboundPct: 8,
        minNetFlow3sSol: 2, minBuyers3s: 4, requireFlowAcceleration: true,
        exitProfileIds: ['XFIX120_H15_PP', 'XFIX240_H15_PP', 'X25_RATCHET_PP'],
        capacityAware: true,
        positionSols: listEnv(
          'FLOW_BIG_WINNER_PP_CAPACITY_SOLS',
          ['0.05', '0.1', '0.25'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'PP_PULLBACK_8_30',
        label: 'PP-Pullback Broad · 回踩8–30% + 温和二次加速',
        newEntriesEnabled: false,
        family: 'PARTICIPATION', mode: 'PULLBACK', minAgeMs: 10_000, maxAgeMs: 75_000,
        qualificationMaxAgeMs: 30_000,
        minTrades10s: 40, minBuyers10s: 20, minNetFlow10sSol: 3,
        maxLargestBuyerShare10s: 0.6, minRecentBuyers5s: 7,
        minRecentNetFlow5sSol: 0, minRecentFlowRetentionRatio: 0.25,
        minPullbackPct: 8, maxPullbackPct: 30,
        minReboundPct: 1.5, maxReboundPct: 10,
        minNetFlow3sSol: 1, minBuyers3s: 3, requireFlowAcceleration: true,
        exitProfileIds: ['XFIX120_H15_PP', 'XFIX240_H15_PP', 'X25_RATCHET_PP'],
        capacityAware: true,
        positionSols: listEnv(
          'FLOW_BIG_WINNER_PP_CAPACITY_SOLS',
          ['0.05', '0.1', '0.25'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'PP_PULLBACK_8_30_NF8_3',
        label: 'PP8-30-NF8-3 · 回踩8–30% / NetFlow8≥3 SOL / X25 Runner',
        newEntriesEnabled: false,
        family: 'PARTICIPATION', mode: 'PULLBACK', minAgeMs: 10_000, maxAgeMs: 75_000,
        qualificationMaxAgeMs: 30_000,
        minTrades10s: 40, minBuyers10s: 20, minNetFlow10sSol: 3,
        maxLargestBuyerShare10s: 0.6, minRecentBuyers5s: 7,
        minRecentNetFlow5sSol: 0, minRecentFlowRetentionRatio: 0.25,
        minPullbackPct: 8, maxPullbackPct: 30,
        minReboundPct: 1.5, maxReboundPct: 10,
        minNetFlow3sSol: 1, minNetFlow8sSol: 3, minBuyers3s: 3,
        requireFlowAcceleration: true,
        exitProfileIds: ['X25_RATCHET_PP'], capacityAware: true,
        positionSols: listEnv(
          'FLOW_BIG_WINNER_PP_NF8_CAPACITY_SOLS', ['0.1', '0.25'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'PP20_B45',
        label: 'PP20-B45 · 首次回踩8–20% / Buyers10≥45',
        newEntriesEnabled: false,
        family: 'PARTICIPATION', mode: 'PULLBACK', minAgeMs: 10_000, maxAgeMs: 60_000,
        qualificationMaxAgeMs: 30_000,
        minTrades10s: 40, minBuyers10s: 45, minNetFlow10sSol: 3,
        maxLargestBuyerShare10s: 0.55, minRecentBuyers5s: 8,
        minRecentNetFlow5sSol: 0, minRecentFlowRetentionRatio: 0.35,
        minPullbackPct: 8, maxPullbackPct: 20,
        minReboundPct: 2, maxReboundPct: 8,
        minNetFlow3sSol: 2, minBuyers3s: 4, requireFlowAcceleration: true,
        exitProfileIds: ['X25_RATCHET_PP'], capacityAware: true,
        positionSols: listEnv(
          'FLOW_BIG_WINNER_PP_CAPACITY_SOLS', ['0.05', '0.1', '0.25'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'PP20_EARLY_BREADTH',
        label: 'PP20-Early-Breadth · AGE≤25s / Buyers3≥15 / Buyers10≥45',
        newEntriesEnabled: false,
        family: 'PARTICIPATION', mode: 'PULLBACK', minAgeMs: 10_000, maxAgeMs: 25_000,
        qualificationMaxAgeMs: 25_000,
        minTrades10s: 40, minBuyers10s: 45, minNetFlow10sSol: 3,
        maxLargestBuyerShare10s: 0.55, minRecentBuyers5s: 8,
        minRecentNetFlow5sSol: 0, minRecentFlowRetentionRatio: 0.35,
        minPullbackPct: 8, maxPullbackPct: 20,
        minReboundPct: 2, maxReboundPct: 8,
        minNetFlow3sSol: 2, minBuyers3s: 15, requireFlowAcceleration: true,
        exitProfileIds: ['X25_RATCHET_PP'], capacityAware: true,
        positionSols: listEnv(
          'FLOW_BIG_WINNER_PP_CAPACITY_SOLS', ['0.05', '0.1', '0.25'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'PP20_QUALITY',
        label: 'PP20-Quality · AGE≤30s / Buyers3≥15 / Buyers10≥45 / Sell3≤2.5',
        newEntriesEnabled: false,
        family: 'PARTICIPATION', mode: 'PULLBACK', minAgeMs: 10_000, maxAgeMs: 30_000,
        qualificationMaxAgeMs: 30_000,
        minTrades10s: 40, minBuyers10s: 45, minNetFlow10sSol: 3,
        maxLargestBuyerShare10s: 0.55, minRecentBuyers5s: 8,
        minRecentNetFlow5sSol: 0, minRecentFlowRetentionRatio: 0.35,
        minPullbackPct: 8, maxPullbackPct: 20,
        minReboundPct: 2, maxReboundPct: 8,
        minNetFlow3sSol: 2, minBuyers3s: 15, maxSingleSell3sSol: 2.5,
        requireFlowAcceleration: true,
        exitProfileIds: ['X25_RATCHET_PP'], capacityAware: true,
        positionSols: listEnv(
          'FLOW_BIG_WINNER_PP_CAPACITY_SOLS', ['0.05', '0.1', '0.25'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
    ],
    exitProfiles: [
      {
        id: 'X50_15', label: '+20 sell 50%; adaptive 15/20/25 trail',
        coreActivationPct: 20, coreWeightPct: 50, hardStopPct: 15,
        trailingActivationPct: 30, baseTrailingDrawdownPct: 15,
        trailingTiers: [
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
        ],
        profitFloors: [], maxHoldMs: 180_000,
      },
      {
        id: 'X50_12', label: '+20 sell 50%; tighter -12 hard stop',
        coreActivationPct: 20, coreWeightPct: 50, hardStopPct: 12,
        trailingActivationPct: 30, baseTrailingDrawdownPct: 15,
        trailingTiers: [
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
        ],
        profitFloors: [], maxHoldMs: 180_000,
      },
      {
        id: 'X50_RATCHET', label: '+20 sell 50%; runner profit ratchet',
        coreActivationPct: 20, coreWeightPct: 50, hardStopPct: 15,
        trailingActivationPct: 30, baseTrailingDrawdownPct: 15,
        trailingTiers: [],
        profitFloors: [
          { activationPct: 50, lockPct: 20 },
          { activationPct: 100, lockPct: 60 },
          { activationPct: 150, lockPct: 100 },
          { activationPct: 250, lockPct: 170 },
        ],
        maxHoldMs: 300_000,
      },
      {
        id: 'X40_RATCHET', label: '+20 sell 40%; 60% runner profit ratchet',
        coreActivationPct: 20, coreWeightPct: 40, hardStopPct: 15,
        trailingActivationPct: 30, baseTrailingDrawdownPct: 15,
        trailingTiers: [],
        profitFloors: [
          { activationPct: 50, lockPct: 20 },
          { activationPct: 100, lockPct: 60 },
          { activationPct: 150, lockPct: 100 },
          { activationPct: 250, lockPct: 170 },
        ],
        maxHoldMs: 300_000,
      },
      {
        id: 'XFIX60_H15', label: '-15% hard stop / otherwise fixed 60s',
        mode: 'FIXED_HOLD', coreWeightPct: 0, hardStopPct: 15,
        trailingTiers: [], profitFloors: [], maxHoldMs: 60_000,
      },
      {
        id: 'XFIX120_H15', label: '-15% hard stop / otherwise fixed 120s',
        mode: 'FIXED_HOLD', coreWeightPct: 0, hardStopPct: 15,
        trailingTiers: [], profitFloors: [], maxHoldMs: 120_000,
      },
      {
        id: 'XFIX120_H15_PP', label: 'PP · -15% hard stop / otherwise fixed 120s',
        entryProfileIds: ['PP_DIRECT_10', 'PP_PULLBACK_8_20', 'PP_PULLBACK_8_30'],
        mode: 'FIXED_HOLD', coreWeightPct: 0, hardStopPct: 15,
        trailingTiers: [], profitFloors: [], maxHoldMs: 120_000,
      },
      {
        id: 'XFIX240_H15_PP', label: 'PP · -15% hard stop / otherwise fixed 240s',
        entryProfileIds: ['PP_DIRECT_10', 'PP_PULLBACK_8_20', 'PP_PULLBACK_8_30'],
        mode: 'FIXED_HOLD', coreWeightPct: 0, hardStopPct: 15,
        trailingTiers: [], profitFloors: [], maxHoldMs: 240_000,
      },
      {
        id: 'X25_RATCHET_PP', label: 'PP · 25% Core + 75% protected runner',
        entryProfileIds: [
          'PP_DIRECT_10', 'PP_PULLBACK_8_20', 'PP_PULLBACK_8_30',
          'PP_PULLBACK_8_30_NF8_3',
          'PP20_B45', 'PP20_EARLY_BREADTH', 'PP20_QUALITY',
        ],
        coreActivationPct: 20, coreWeightPct: 25, hardStopPct: 15,
        trailingActivationPct: 30, baseTrailingDrawdownPct: 15,
        trailingTiers: [],
        profitFloors: [
          { activationPct: 50, lockPct: 20 },
          { activationPct: 100, lockPct: 60 },
          { activationPct: 150, lockPct: 100 },
          { activationPct: 250, lockPct: 170 },
        ],
        maxHoldMs: 300_000,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_BIG_WINNER_SHADOW_POSITION_SOL'),
    }),
  },

  // Independent first-pullback execution research. References are emitted by
  // LaunchQualityObserver, but every simulated position lives in its own table.
  launchPullbackShadow: {
    enabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_LAUNCH_PULLBACK_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_LAUNCH_PULLBACK_SHADOW_POSITION_SOL'),
    entryDelayMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_ENTRY_TIMEOUT_MS', 2_000, {
      min: 1,
    }),
    exitDelayMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_EXIT_TIMEOUT_MS', 5_000, {
      min: 1,
    }),
    maxEntryPriceJumpPct: numberEnv(
      'FLOW_LAUNCH_PULLBACK_SHADOW_MAX_ENTRY_JUMP_PCT',
      10,
      { min: 0, max: 100 },
    ),
    bigWinnerPct: numberEnv('FLOW_LAUNCH_PULLBACK_SHADOW_BIG_WINNER_PCT', 50, {
      min: 1,
    }),
    // These cohorts have stable, large negative samples. They remain defined so
    // their historical rows and any already-open position can still be restored,
    // but LaunchPullbackShadowSuite no longer creates new positions for them.
    // Only the three 30-SOL right-tail execution controls keep collecting data.
    retiredCohortIds: [
      'F1_3S', 'F1_8S', 'F2_3S', 'F2_8S', 'F3_3S', 'F3_8S',
      'FQ1_3S', 'FQ1_8S', 'FQ2_3S', 'FQ2_8S',
      'FT_A', 'FT_B', 'FT_C', 'FT_D', 'FQ_X15', 'FQ_X30',
      'FD10_R3_5S', 'FD12_5_R3_5S', 'FD12_5_R5_5S', 'FD15_R5_5S',
      'FC_BASE_X12', 'FC_STRICT_NF20_X12', 'FC_BASE_STAIR60',
      'FC_BASE_WEAK3_X12', 'FC_BASE_WEAK5_X12',
      'FO_F2_J2_3S', 'FO_C70_10S', 'FO_C70_T15',
      'FO_RB10_30S', 'FO_RB10_T20', 'FO_RB10_H20_60S', 'FO_RB10_H20_120S',
      'FO_D12_R3_10S', 'FO_D12_R3_T15', 'FO_D12_R3_Q_10S',
      'FO_D12_R3_QC_10S', 'FO_D12_R3_Q_T10_H30',
      'F2_8S_NF30', 'FT_C_NF30',
      'F_ABSORB3_8S', 'F_ABSORB5_RUNNER', 'F_REACCEL0_8S',
    ],
    profiles: [
      {
        id: 'F1',
        label: 'F1 · NetFlow≥15 / Creator≤5%',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_F1_MIN_NET_FLOW_SOL', 15, { min: 0 }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F1_MAX_CREATOR_SHARE_PCT',
          5,
          { min: 0, max: 100 },
        ),
      },
      {
        id: 'F2',
        label: 'F2 · NetFlow≥20 / Creator≤10%',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_F2_MIN_NET_FLOW_SOL', 20, { min: 0 }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
      },
      {
        id: 'F3',
        label: 'F3 对照 · NetFlow≥20 / Creator≤20%',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_F3_MIN_NET_FLOW_SOL', 20, { min: 0 }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F3_MAX_CREATOR_SHARE_PCT',
          20,
          { min: 0, max: 100 },
        ),
      },
      {
        id: 'FQ1',
        label: 'FQ1 前向 · F1 + Buyers≥10 / Recent≥3 / Retention≥50% / Top3≤70%',
        minNetFlowSol: 15,
        maxCreatorSharePct: 5,
        minBuyers: 10,
        minRecentBuyers: 3,
        minRetentionPct: 50,
        maxTop3SharePct: 70,
      },
      {
        id: 'FQ2',
        label: 'FQ2 前向 · F1 + Buyers≥15 / Recent≥3 / Retention≥50% / Top3≤70%',
        minNetFlowSol: 15,
        maxCreatorSharePct: 5,
        minBuyers: 15,
        minRecentBuyers: 3,
        minRetentionPct: 50,
        maxTop3SharePct: 70,
      },
    ],
    holds: [
      {
        id: '3S',
        label: '固定持有3秒',
        fixedHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_HOLD_3S_MS', 3_000, {
          min: 250,
        }),
      },
      {
        id: '8S',
        label: '固定持有8秒',
        fixedHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_HOLD_8S_MS', 8_000, {
          min: 250,
        }),
      },
    ],
    // These cohorts retain the exact F1/F2 entry filters above and only vary exits.
    // Their IDs are intentionally independent from the historical fixed-hold cohorts.
    trailingCohorts: [
      {
        id: 'FT_A',
        label: 'FT-A · F2立即激活/回撤20%/无硬止损',
        profileId: 'F2',
        trailingActivationPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_A_ACTIVATION_PCT', 0, {
          min: 0,
        }),
        trailingDrawdownPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_A_DRAWDOWN_PCT', 20, {
          min: 0.1,
          max: 100,
        }),
        minHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_A_MIN_HOLD_MS', 3_000, { min: 0 }),
        maxHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_A_MAX_HOLD_MS', 120_000, {
          min: 1_000,
        }),
        hardStopPct: null,
      },
      {
        id: 'FT_B',
        label: 'FT-B · F1盈利10%激活/回撤20%/止损30%',
        profileId: 'F1',
        trailingActivationPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_B_ACTIVATION_PCT', 10, {
          min: 0,
        }),
        trailingDrawdownPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_B_DRAWDOWN_PCT', 20, {
          min: 0.1,
          max: 100,
        }),
        minHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_B_MIN_HOLD_MS', 3_000, { min: 0 }),
        maxHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_B_MAX_HOLD_MS', 120_000, {
          min: 1_000,
        }),
        hardStopPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_B_HARD_STOP_PCT', 30, {
          min: 0.1,
          max: 100,
        }),
      },
      {
        id: 'FT_C',
        label: 'FT-C · F2盈利30%激活/回撤20%/止损30%',
        profileId: 'F2',
        trailingActivationPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_ACTIVATION_PCT', 30, {
          min: 0,
        }),
        trailingDrawdownPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_DRAWDOWN_PCT', 20, {
          min: 0.1,
          max: 100,
        }),
        minHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_C_MIN_HOLD_MS', 0, { min: 0 }),
        maxHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_C_MAX_HOLD_MS', 120_000, {
          min: 1_000,
        }),
        hardStopPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_HARD_STOP_PCT', 30, {
          min: 0.1,
          max: 100,
        }),
      },
      {
        id: 'FT_D',
        label: 'FT-D对照 · F1盈利30%激活/回撤15%/止损30%',
        profileId: 'F1',
        trailingActivationPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_D_ACTIVATION_PCT', 30, {
          min: 0,
        }),
        trailingDrawdownPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_D_DRAWDOWN_PCT', 15, {
          min: 0.1,
          max: 100,
        }),
        minHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_D_MIN_HOLD_MS', 3_000, { min: 0 }),
        maxHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_D_MAX_HOLD_MS', 120_000, {
          min: 1_000,
        }),
        hardStopPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_D_HARD_STOP_PCT', 30, {
          min: 0.1,
          max: 100,
        }),
      },
      {
        id: 'FQ_X15',
        label: 'FQ-X15 · FQ1盈利8%激活/回撤5%/15秒兜底',
        profileId: 'FQ1',
        trailingActivationPct: 8,
        trailingDrawdownPct: 5,
        minHoldMs: 1_000,
        maxHoldMs: 15_000,
        hardStopPct: 12.5,
      },
      {
        id: 'FQ_X30',
        label: 'FQ-X30 · FQ2盈利10%激活/回撤7.5%/30秒兜底',
        profileId: 'FQ2',
        trailingActivationPct: 10,
        trailingDrawdownPct: 7.5,
        minHoldMs: 2_000,
        maxHoldMs: 30_000,
        hardStopPct: 15,
      },
    ],
    // New entry cohorts intentionally do not reuse F1/F2/F3/FT IDs. All four
    // share the same quality/exit gates so their entry depth is comparable.
    deepCohorts: launchDeepPullbackProfiles.map((profile) => ({
      ...profile,
      profileId: profile.id,
      minNetFlowSol: numberEnv('FLOW_LAUNCH_DEEP_MIN_NET_FLOW_SOL', 15, { min: 0 }),
      maxCreatorSharePct: numberEnv('FLOW_LAUNCH_DEEP_MAX_CREATOR_SHARE_PCT', 5, {
        min: 0, max: 100,
      }),
      minBuyers: 0,
      minRecentBuyers: 0,
      minRetentionPct: 0,
      maxTop3SharePct: 100,
      fixedHoldMs: integerEnv('FLOW_LAUNCH_DEEP_FIXED_HOLD_MS', 5_000, { min: 250 }),
    })),
    // New independent cohorts preserve all historical F/FT/FD definitions.
    // They are based on the chronological 70/30 screen from the latest export:
    // low holder concentration was stable at 10s, while creator<=5% with
    // continuing buyers retained a useful 30s right tail.
    optimizationCohorts: [
      ...(booleanEnv('FLOW_LAUNCH_FLOW_CONSENSUS_ENABLED', true) ? [
        {
          id: 'FC_BASE_X12',
          label: 'FC-Base · FO-RB10 + prior-5s Flow BuyersW3>=3 · jump<=3% · fixed12s',
          referenceProfileId: 'LEGACY_7_5_R3',
          referencePullbackPct: 7.5,
          referenceReboundPct: 3,
          profileId: 'FC_BASE',
          minNetFlowSol: 5,
          maxCreatorSharePct: 5,
          minBuyers: 0,
          minRecentBuyers: 10,
          minRetentionPct: 0,
          maxTop3SharePct: 100,
          flowConfirmationWindowMs: 5_000,
          minFlowSignalBuyersW3: 3,
          maxEntryPriceJumpPct: 3,
          exitPolicy: 'FIXED_HOLD',
          fixedHoldMs: 12_000,
        },
        {
          id: 'FC_STRICT_NF20_X12',
          label: 'FC-Strict · FC + NetFlow>=20 · jump<=5% · fixed12s',
          referenceProfileId: 'LEGACY_7_5_R3',
          referencePullbackPct: 7.5,
          referenceReboundPct: 3,
          profileId: 'FC_STRICT',
          minNetFlowSol: 20,
          maxCreatorSharePct: 5,
          minBuyers: 0,
          minRecentBuyers: 10,
          minRetentionPct: 0,
          maxTop3SharePct: 100,
          flowConfirmationWindowMs: 5_000,
          minFlowSignalBuyersW3: 3,
          maxEntryPriceJumpPct: 5,
          exitPolicy: 'FIXED_HOLD',
          fixedHoldMs: 12_000,
        },
        {
          id: 'FC_BASE_STAIR60',
          label: 'FC-Base · 20/40/80% tiered trailing · max60s',
          referenceProfileId: 'LEGACY_7_5_R3',
          referencePullbackPct: 7.5,
          referenceReboundPct: 3,
          profileId: 'FC_BASE',
          minNetFlowSol: 5,
          maxCreatorSharePct: 5,
          minBuyers: 0,
          minRecentBuyers: 10,
          minRetentionPct: 0,
          maxTop3SharePct: 100,
          flowConfirmationWindowMs: 5_000,
          minFlowSignalBuyersW3: 3,
          maxEntryPriceJumpPct: 3,
          exitPolicy: 'TIERED_TRAILING',
          trailingTiers: [
            { activationPct: 20, drawdownPct: 10 },
            { activationPct: 40, drawdownPct: 15 },
            { activationPct: 80, drawdownPct: 20 },
          ],
          minHoldMs: 0,
          maxHoldMs: 60_000,
          hardStopPct: 25,
        },
        {
          id: 'FC_BASE_WEAK3_X12',
          label: 'FC-Base · 3s MFE<5% early exit · max12s',
          referenceProfileId: 'LEGACY_7_5_R3',
          referencePullbackPct: 7.5,
          referenceReboundPct: 3,
          profileId: 'FC_BASE',
          minNetFlowSol: 5,
          maxCreatorSharePct: 5,
          minBuyers: 0,
          minRecentBuyers: 10,
          minRetentionPct: 0,
          maxTop3SharePct: 100,
          flowConfirmationWindowMs: 5_000,
          minFlowSignalBuyersW3: 3,
          maxEntryPriceJumpPct: 3,
          exitPolicy: 'EARLY_STRENGTH',
          strengthCheckMs: 3_000,
          minStrengthMfePct: 5,
          maxHoldMs: 12_000,
          hardStopPct: 25,
        },
        {
          id: 'FC_BASE_WEAK5_X12',
          label: 'FC-Base · 5s MFE<10% early exit · max12s',
          referenceProfileId: 'LEGACY_7_5_R3',
          referencePullbackPct: 7.5,
          referenceReboundPct: 3,
          profileId: 'FC_BASE',
          minNetFlowSol: 5,
          maxCreatorSharePct: 5,
          minBuyers: 0,
          minRecentBuyers: 10,
          minRetentionPct: 0,
          maxTop3SharePct: 100,
          flowConfirmationWindowMs: 5_000,
          minFlowSignalBuyersW3: 3,
          maxEntryPriceJumpPct: 3,
          exitPolicy: 'EARLY_STRENGTH',
          strengthCheckMs: 5_000,
          minStrengthMfePct: 10,
          maxHoldMs: 12_000,
          hardStopPct: 25,
        },
      ] : []),
      {
        id: 'FO_F2_J2_3S',
        label: 'FO-F2-J2 · F2 + 入场跳价<=2% / fixed 3s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'FO_F2_J2',
        minNetFlowSol: 20,
        maxCreatorSharePct: 10,
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        maxEntryPriceJumpPct: 2,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 3_000,
      },
      {
        id: 'FO_C70_10S',
        label: 'FO-C70 · Top3<=70% / fixed 10s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'FO_C70',
        minNetFlowSol: 0,
        maxCreatorSharePct: 100,
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 70,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 10_000,
      },
      {
        id: 'FO_C70_T15',
        label: 'FO-C70-T15 · Top3<=70% / trailing 15%',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'FO_C70',
        minNetFlowSol: 0,
        maxCreatorSharePct: 100,
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 70,
        exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: 10,
        trailingDrawdownPct: 15,
        hardStopPct: 25,
        minHoldMs: 1_000,
        maxHoldMs: 60_000,
      },
      {
        id: 'FO_RB10_30S',
        label: 'FO-RB10 · Creator<=5% / recent buyers>=10 / fixed 30s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'FO_RB10',
        minNetFlowSol: 5,
        maxCreatorSharePct: 5,
        minBuyers: 0,
        minRecentBuyers: 10,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 30_000,
        liveStrategyId: 'launch_pullback_fo_rb10_30s_live',
      },
      {
        id: 'FO_RB10_T20',
        label: 'FO-RB10-T20 · Creator<=5% / recent buyers>=10 / trailing 20%',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'FO_RB10',
        minNetFlowSol: 5,
        maxCreatorSharePct: 5,
        minBuyers: 0,
        minRecentBuyers: 10,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: 20,
        trailingDrawdownPct: 20,
        hardStopPct: 30,
        minHoldMs: 2_000,
        maxHoldMs: 120_000,
      },
      {
        id: 'FO_RB10_H20_60S',
        label: 'FO-RB10 | -20% hard stop / otherwise fixed 60s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'FO_RB10',
        minNetFlowSol: 5,
        maxCreatorSharePct: 5,
        minBuyers: 0,
        minRecentBuyers: 10,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 60_000,
        hardStopPct: 20,
      },
      {
        id: 'FO_RB10_H20_120S',
        label: 'FO-RB10 | -20% hard stop / otherwise fixed 120s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'FO_RB10',
        minNetFlowSol: 5,
        maxCreatorSharePct: 5,
        minBuyers: 0,
        minRecentBuyers: 10,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 120_000,
        hardStopPct: 20,
      },
      {
        id: 'FO_D12_R3_10S',
        label: 'FO-D12-R3 · deep pullback / fixed 10s',
        referenceProfileId: 'DEEP_D12_5_R3',
        referencePullbackPct: 12.5,
        referenceReboundPct: 3,
        profileId: 'FO_D12_R3',
        minNetFlowSol: 15,
        maxCreatorSharePct: 5,
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 10_000,
      },
      {
        id: 'FO_D12_R3_T15',
        label: 'FO-D12-R3-T15 · deep pullback / trailing 15%',
        referenceProfileId: 'DEEP_D12_5_R3',
        referencePullbackPct: 12.5,
        referenceReboundPct: 3,
        profileId: 'FO_D12_R3',
        minNetFlowSol: 15,
        maxCreatorSharePct: 5,
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: 10,
        trailingDrawdownPct: 15,
        hardStopPct: 25,
        minHoldMs: 1_000,
        maxHoldMs: 60_000,
      },
      {
        id: 'FO_D12_R3_Q_10S',
        label: 'FO-D12-R3-Q | retention>=70 / Top3<50 / NetFlow 15-50 / fixed 10s',
        referenceProfileId: 'DEEP_D12_5_R3',
        referencePullbackPct: 12.5,
        referenceReboundPct: 3,
        profileId: 'FO_D12_R3_Q',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_D12_QUALITY_MIN_NET_FLOW_SOL', 15, {
          min: 0,
        }),
        maxNetFlowSol: numberEnv('FLOW_LAUNCH_D12_QUALITY_MAX_NET_FLOW_SOL', 50, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_D12_QUALITY_MAX_CREATOR_SHARE_PCT',
          5,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: numberEnv('FLOW_LAUNCH_D12_QUALITY_MIN_RETENTION_PCT', 70, {
          min: 0, max: 100,
        }),
        maxTop3SharePct: numberEnv('FLOW_LAUNCH_D12_QUALITY_MAX_TOP3_SHARE_PCT', 50, {
          min: 0, max: 100,
        }),
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_LAUNCH_D12_QUALITY_FIXED_HOLD_MS', 10_000, {
          min: 250,
        }),
      },
      {
        id: 'FO_D12_R3_QC_10S',
        label: 'FO-D12-R3-QC | Q + Creator<=3 / fixed 10s',
        referenceProfileId: 'DEEP_D12_5_R3',
        referencePullbackPct: 12.5,
        referenceReboundPct: 3,
        profileId: 'FO_D12_R3_QC',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_D12_QUALITY_MIN_NET_FLOW_SOL', 15, {
          min: 0,
        }),
        maxNetFlowSol: numberEnv('FLOW_LAUNCH_D12_QUALITY_MAX_NET_FLOW_SOL', 50, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_D12_STRICT_MAX_CREATOR_SHARE_PCT',
          3,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: numberEnv('FLOW_LAUNCH_D12_QUALITY_MIN_RETENTION_PCT', 70, {
          min: 0, max: 100,
        }),
        maxTop3SharePct: numberEnv('FLOW_LAUNCH_D12_QUALITY_MAX_TOP3_SHARE_PCT', 50, {
          min: 0, max: 100,
        }),
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_LAUNCH_D12_QUALITY_FIXED_HOLD_MS', 10_000, {
          min: 250,
        }),
      },
      {
        id: 'FO_D12_R3_Q_T10_H30',
        label: 'FO-D12-R3-Q-T10 | +20 activation / drawdown 10 / max 30s',
        referenceProfileId: 'DEEP_D12_5_R3',
        referencePullbackPct: 12.5,
        referenceReboundPct: 3,
        profileId: 'FO_D12_R3_Q',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_D12_QUALITY_MIN_NET_FLOW_SOL', 15, {
          min: 0,
        }),
        maxNetFlowSol: numberEnv('FLOW_LAUNCH_D12_QUALITY_MAX_NET_FLOW_SOL', 50, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_D12_QUALITY_MAX_CREATOR_SHARE_PCT',
          5,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: numberEnv('FLOW_LAUNCH_D12_QUALITY_MIN_RETENTION_PCT', 70, {
          min: 0, max: 100,
        }),
        maxTop3SharePct: numberEnv('FLOW_LAUNCH_D12_QUALITY_MAX_TOP3_SHARE_PCT', 50, {
          min: 0, max: 100,
        }),
        exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: numberEnv(
          'FLOW_LAUNCH_D12_QUALITY_TRAILING_ACTIVATION_PCT', 20, { min: 0 },
        ),
        trailingDrawdownPct: numberEnv(
          'FLOW_LAUNCH_D12_QUALITY_TRAILING_DRAWDOWN_PCT', 10, { min: 0.1, max: 100 },
        ),
        hardStopPct: numberEnv(
          'FLOW_LAUNCH_D12_QUALITY_HARD_STOP_PCT', 20, { min: 0.1, max: 100 },
        ),
        minHoldMs: 0,
        maxHoldMs: integerEnv('FLOW_LAUNCH_D12_QUALITY_TRAILING_MAX_HOLD_MS', 30_000, {
          min: 1_000,
        }),
      },

      {
        id: 'F2_8S_NF30',
        label: 'F2-8S-NF30 | F2 + NetFlow>=30 SOL / fixed 8s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'F2_NF30',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_NF30_MIN_NET_FLOW_SOL', 30, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_HOLD_8S_MS', 8_000, {
          min: 250,
        }),
      },
      {
        id: 'FT_C_NF30',
        label: 'FT-C-NF30 | F2 + NetFlow>=30 SOL / right-tail trailing',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'F2_NF30',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_NF30_MIN_NET_FLOW_SOL', 30, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_ACTIVATION_PCT', 30, {
          min: 0,
        }),
        trailingDrawdownPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_DRAWDOWN_PCT', 20, {
          min: 0.1,
          max: 100,
        }),
        minHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_C_MIN_HOLD_MS', 0, { min: 0 }),
        maxHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_C_MAX_HOLD_MS', 120_000, {
          min: 1_000,
        }),
        hardStopPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_HARD_STOP_PCT', 30, {
          min: 0.1,
          max: 100,
        }),
      },
      {
        id: 'F2_NF30_H20_60S',
        label: 'F2-NF30 | -20% hard stop / otherwise fixed 60s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'F2_NF30',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_NF30_MIN_NET_FLOW_SOL', 30, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 60_000,
        hardStopPct: 20,
      },
      {
        id: 'F2_NF30_H20_120S',
        label: 'F2-NF30 | -20% hard stop / otherwise fixed 120s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'F2_NF30',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_NF30_MIN_NET_FLOW_SOL', 30, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 120_000,
        hardStopPct: 20,
      },
      {
        id: 'F2_NF30_H20_120S_EXEC1',
        label: 'F2-NF30-EXEC1 | 1 SOL executable entry/exit / H20 / fixed 120s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'F2_NF30_EXEC1',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_NF30_MIN_NET_FLOW_SOL', 30, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        positionSizeSol: 1,
        requireExecutableCapacity: true,
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: 120_000,
        hardStopPct: 20,
      },
      {
        id: 'F_ABSORB3_8S',
        label: 'F-ABSORB3 | F2 + peak sell>=3 SOL + refill>=50% / fixed 8s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'F_ABSORB3',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_F2_MIN_NET_FLOW_SOL', 20, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        minSellSolSincePeak: numberEnv(
          'FLOW_LAUNCH_PULLBACK_ABSORB3_MIN_SELL_SOL', 3, { min: 0 },
        ),
        minBuyRefillRatio: numberEnv(
          'FLOW_LAUNCH_PULLBACK_MIN_BUY_REFILL_RATIO', 0.5, { min: 0 },
        ),
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_HOLD_8S_MS', 8_000, {
          min: 250,
        }),
      },
      {
        id: 'F_ABSORB5_RUNNER',
        label: 'F-ABSORB5 | F2 + peak sell>=5 SOL + refill>=50% / right-tail trailing',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'F_ABSORB5',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_F2_MIN_NET_FLOW_SOL', 20, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        minSellSolSincePeak: numberEnv(
          'FLOW_LAUNCH_PULLBACK_ABSORB5_MIN_SELL_SOL', 5, { min: 0 },
        ),
        minBuyRefillRatio: numberEnv(
          'FLOW_LAUNCH_PULLBACK_MIN_BUY_REFILL_RATIO', 0.5, { min: 0 },
        ),
        exitPolicy: 'TRAILING_STOP',
        trailingActivationPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_ACTIVATION_PCT', 30, {
          min: 0,
        }),
        trailingDrawdownPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_DRAWDOWN_PCT', 20, {
          min: 0.1,
          max: 100,
        }),
        minHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_C_MIN_HOLD_MS', 0, { min: 0 }),
        maxHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_FT_C_MAX_HOLD_MS', 120_000, {
          min: 1_000,
        }),
        hardStopPct: numberEnv('FLOW_LAUNCH_PULLBACK_FT_C_HARD_STOP_PCT', 30, {
          min: 0.1,
          max: 100,
        }),
      },
      {
        id: 'F_REACCEL0_8S',
        label: 'F-REACCEL0 | F2 + current 1s net>=0 + acceleration>=0 / fixed 8s',
        referenceProfileId: 'LEGACY_7_5_R3',
        referencePullbackPct: 7.5,
        referenceReboundPct: 3,
        profileId: 'F_REACCEL0',
        minNetFlowSol: numberEnv('FLOW_LAUNCH_PULLBACK_F2_MIN_NET_FLOW_SOL', 20, {
          min: 0,
        }),
        maxCreatorSharePct: numberEnv(
          'FLOW_LAUNCH_PULLBACK_F2_MAX_CREATOR_SHARE_PCT',
          10,
          { min: 0, max: 100 },
        ),
        minBuyers: 0,
        minRecentBuyers: 0,
        minRetentionPct: 0,
        maxTop3SharePct: 100,
        minRecentNetFlow1s: numberEnv(
          'FLOW_LAUNCH_PULLBACK_REACCEL_MIN_NET_FLOW_1S_SOL', 0,
        ),
        minNetFlowAcceleration1s: numberEnv(
          'FLOW_LAUNCH_PULLBACK_REACCEL_MIN_ACCEL_1S_SOL', 0,
        ),
        exitPolicy: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_LAUNCH_PULLBACK_SHADOW_HOLD_8S_MS', 8_000, {
          min: 250,
        }),
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_LAUNCH_PULLBACK_SHADOW_POSITION_SOL'),
    }),
  },

  // Forward-only public-order-flow analogue of the profitable CYA wallet's
  // earliest entries. Signals are evaluated only when a completed Solana slot
  // is followed by the first public trade of the next slot. The target wallet
  // and all monitored Smart Wallets are excluded from causal features; a later
  // target OPEN is recorded strictly as a future label.
  cyaSlotFlowShadow: {
    // Completed-slot CSF cohorts stayed negative after execution costs. Keep
    // their historical rows visible while disabling new causal episodes.
    enabled: booleanEnv('FLOW_CYA_SLOT_FLOW_SHADOW_V2_ENABLED', false),
    targetWallet: process.env.FLOW_CYA_SLOT_FLOW_TARGET_WALLET
      || 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',
    positionSizeSol: shadowPositionEnv('FLOW_CYA_SLOT_FLOW_POSITION_SOL'),
    featureWindowMs: integerEnv('FLOW_CYA_SLOT_FLOW_FEATURE_WINDOW_MS', 5_000, {
      min: 2_000, max: 10_000,
    }),
    maxTradesPerMint: integerEnv('FLOW_CYA_SLOT_FLOW_MAX_TRADES_PER_MINT', 256, {
      min: 32, max: 2_000,
    }),
    stateRetentionMs: integerEnv('FLOW_CYA_SLOT_FLOW_STATE_RETENTION_MS', 10 * 60_000, {
      min: 60_000, max: 60 * 60_000,
    }),
    episodeCooldownMs: integerEnv('FLOW_CYA_SLOT_FLOW_EPISODE_COOLDOWN_MS', 10 * 60_000, {
      min: 1_000,
    }),
    targetLabelWindowMs: integerEnv('FLOW_CYA_SLOT_FLOW_TARGET_LABEL_WINDOW_MS', 15_000, {
      min: 1_000, max: 60_000,
    }),
    entryDelayMs: integerEnv('FLOW_CYA_SLOT_FLOW_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_CYA_SLOT_FLOW_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_CYA_SLOT_FLOW_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_CYA_SLOT_FLOW_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_CYA_SLOT_FLOW_MAX_ENTRY_JUMP_PCT', 35, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_CYA_SLOT_FLOW_MAX_ENTRY_DROP_PCT', 35, {
      min: 0, max: 100,
    }),
    maxEntryImpactPct: numberEnv('FLOW_CYA_SLOT_FLOW_MAX_ENTRY_IMPACT_PCT', 25, {
      min: 0, max: 1_000,
    }),
    maxAddImpactPct: numberEnv('FLOW_CYA_SLOT_FLOW_MAX_ADD_IMPACT_PCT', 20, {
      min: 0, max: 1_000,
    }),
    entryProfiles: [
      {
        id: 'CSF_C03',
        label: 'CSF-C03 · 0–3s early control',
        minAgeMs: 0, maxAgeMs: 3_000,
        minBuyers5s: 5, minNetFlow5sSol: 5,
        minBuyTxSharePct: 75, maxLargestBuyerSharePct: 40,
        minReturn5sPct: 20, maxReturn5sPct: 140,
        minSourceSlotBuyers: 1, minSourceSlotNetFlowSol: 0,
        requireCreatorNoSell: false,
        newEntriesEnabled: false,
      },
      {
        id: 'CSF_E35',
        label: 'CSF-E35 · 3–5s diversified prior-slot flow',
        minAgeMs: 3_000, maxAgeMs: 5_000,
        minBuyers5s: 5, minNetFlow5sSol: 5,
        minBuyTxSharePct: 75, maxLargestBuyerSharePct: 40,
        minReturn5sPct: 20, maxReturn5sPct: 140,
        minSourceSlotBuyers: 1, minSourceSlotNetFlowSol: 0,
        requireCreatorNoSell: false,
        newEntriesEnabled: false,
      },
      {
        id: 'CSF_E510',
        label: 'CSF-E510 · 5–10s broad persistent flow',
        minAgeMs: 5_000, maxAgeMs: 10_000,
        minBuyers5s: 7, minNetFlow5sSol: 8,
        minBuyTxSharePct: 80, maxLargestBuyerSharePct: 35,
        minReturn5sPct: 20, maxReturn5sPct: 140,
        minSourceSlotBuyers: 2, minSourceSlotNetFlowSol: 0.25,
        requireCreatorNoSell: false,
        newEntriesEnabled: false,
      },
      {
        id: 'CSF_S310',
        label: 'CSF-S310 · 3–10s strict / creator no-sell',
        minAgeMs: 3_000, maxAgeMs: 10_000,
        minBuyers5s: 9, minNetFlow5sSol: 10,
        minBuyTxSharePct: 80, maxLargestBuyerSharePct: 30,
        minReturn5sPct: 30, maxReturn5sPct: 120,
        minSourceSlotBuyers: 2, minSourceSlotNetFlowSol: 0.5,
        requireCreatorNoSell: true,
        newEntriesEnabled: false,
      },
      {
        id: 'CSF_E510_Q',
        label: 'CSF-E510-Q · 5–10s strict diversified flow',
        minAgeMs: 5_000, maxAgeMs: 10_000,
        minBuyers5s: 15, minNetFlow5sSol: 12,
        minBuyTxSharePct: 80, maxLargestBuyerSharePct: 35,
        minReturn5sPct: 20, maxReturn5sPct: 140,
        minSourceSlotBuyers: 3, minSourceSlotNetFlowSol: 0.25,
        requireCreatorNoSell: false,
        newEntriesEnabled: true,
        managementProfileIds: ['F20'],
      },
    ],
    managementProfiles: [
      {
        id: 'F20', label: '20s fixed control / no add',
        hardStopPct: 30, noContinuationMs: 3_000, minContinuationMfePct: 5,
        maxHoldMs: 20_000, trailingActivationPct: 0, trailingStopPct: 0,
        addActivationPct: 0, addMaxAgeMs: 0, addCooldownMs: 0,
        addStepPct: 0, addFraction: 0, maxAdds: 0,
        minAddNetFlow1sSol: 0, minAddBuyers1s: 0, minAddBuyTxSharePct: 0,
      },
      {
        id: 'A50_R120', label: '+50% confirmed adds / 120s runner',
        hardStopPct: 30, noContinuationMs: 3_000, minContinuationMfePct: 10,
        maxHoldMs: 120_000, trailingActivationPct: 80, trailingStopPct: 25,
        addActivationPct: 50, addMaxAgeMs: 2_500, addCooldownMs: 250,
        addStepPct: 15, addFraction: 0.2, maxAdds: 4,
        minAddNetFlow1sSol: 0.5, minAddBuyers1s: 2, minAddBuyTxSharePct: 70,
      },
      {
        id: 'A60_R120', label: '+60% strict adds / 120s runner',
        hardStopPct: 30, noContinuationMs: 3_000, minContinuationMfePct: 10,
        maxHoldMs: 120_000, trailingActivationPct: 100, trailingStopPct: 30,
        addActivationPct: 60, addMaxAgeMs: 2_500, addCooldownMs: 250,
        addStepPct: 15, addFraction: 0.2, maxAdds: 4,
        minAddNetFlow1sSol: 1, minAddBuyers1s: 3, minAddBuyTxSharePct: 75,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_CYA_SLOT_FLOW_POSITION_SOL'),
    }),
  },

  // Forward-only public-flow experiment reconstructed from the profitable CYA
  // wallet's earliest entries. Smart-wallet transactions never contribute to
  // the causal signal; CYA's later OPEN is retained only as a future label.
  // All cohorts use reserve-priced 1 SOL execution and a bounded 15s queue.
  cyaOrganicBurstShadow: {
    enabled: booleanEnv('FLOW_CYA_ORGANIC_BURST_SHADOW_ENABLED', true),
    targetWallet: process.env.FLOW_CYA_ORGANIC_BURST_TARGET_WALLET
      || 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',
    positionSizeSol: shadowPositionEnv('FLOW_CYA_ORGANIC_BURST_POSITION_SOL'),
    featureWindowMs: integerEnv('FLOW_CYA_ORGANIC_BURST_FEATURE_WINDOW_MS', 15_000, {
      min: 5_000, max: 30_000,
    }),
    maxTradesPerMint: integerEnv('FLOW_CYA_ORGANIC_BURST_MAX_TRADES_PER_MINT', 256, {
      min: 32, max: 2_000,
    }),
    stateRetentionMs: integerEnv('FLOW_CYA_ORGANIC_BURST_STATE_RETENTION_MS', 10 * 60_000, {
      min: 60_000, max: 60 * 60_000,
    }),
    episodeCooldownMs: integerEnv('FLOW_CYA_ORGANIC_BURST_EPISODE_COOLDOWN_MS', 10 * 60_000, {
      min: 1_000,
    }),
    targetLabelWindowMs: integerEnv('FLOW_CYA_ORGANIC_BURST_TARGET_LABEL_WINDOW_MS', 15_000, {
      min: 1_000, max: 60_000,
    }),
    entryDelayMs: integerEnv('FLOW_CYA_ORGANIC_BURST_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_CYA_ORGANIC_BURST_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_CYA_ORGANIC_BURST_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_CYA_ORGANIC_BURST_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_CYA_ORGANIC_BURST_MAX_ENTRY_JUMP_PCT', 35, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_CYA_ORGANIC_BURST_MAX_ENTRY_DROP_PCT', 35, {
      min: 0, max: 100,
    }),
    maxEntryImpactPct: numberEnv('FLOW_CYA_ORGANIC_BURST_MAX_ENTRY_IMPACT_PCT', 25, {
      min: 0, max: 1_000,
    }),
    entryProfiles: [
      {
        id: 'COB_A',
        label: 'COB-A · broad organic burst',
        newEntriesEnabled: false,
        minAgeMs: 2_000, maxAgeMs: 15_000, maxCurvePct: 60,
        minBuyers5s: 4, minNetFlow5sSol: null, minBuyTxSharePct: 60,
        minReturn2sPct: -5, minReturn5sPct: 5, maxReturn5sPct: 60,
        maxReturn15sPct: null,
      },
      {
        id: 'COB_B',
        label: 'COB-B · recommended balanced burst',
        newEntriesEnabled: false,
        minAgeMs: 2_000, maxAgeMs: 10_000, maxCurvePct: 55,
        minBuyers5s: 4, minNetFlow5sSol: 1, minBuyTxSharePct: 65,
        minReturn2sPct: null, minReturn5sPct: 10, maxReturn5sPct: 60,
        maxReturn15sPct: 80,
      },
      {
        id: 'COB_C',
        label: 'COB-C · early positive 2s burst',
        newEntriesEnabled: false,
        minAgeMs: 2_000, maxAgeMs: 8_000, maxCurvePct: 50,
        minBuyers5s: 4, minNetFlow5sSol: null, minBuyTxSharePct: 65,
        minReturn2sPct: 0, minReturn5sPct: 10, maxReturn5sPct: 60,
        maxReturn15sPct: null,
      },
      // Strict forward-only replacements. They are mutually exclusive per
      // Mint: >=7 SOL is assigned to F first; 5-7 SOL is assigned to D.
      // FIX30 remains the execution control. CORE25_R75_X120 preserves the
      // right-tail research path. The retired live routes are not promoted.
      {
        id: 'COB_F',
        label: 'COB-F · strict 7 SOL organic pullback',
        newEntriesEnabled: true,
        liveStrategyId: 'cya_organic_burst_cob_f_core25_runner_live',
        liveExitProfileId: 'CORE25_R75_X120',
        exclusiveGroup: 'COB_STRICT',
        exitProfileIds: ['FIX30', 'CORE25_R75_X120'],
        minAgeMs: 2_000, maxAgeMs: 10_000, maxCurvePct: null,
        minBuyers5s: 10, minNetFlow5sSol: 7,
        minBuyTxSharePct: 70, maxBuyTxSharePct: 95,
        minReturn2sPct: 0, maxReturn2sPct: 40,
        minReturn5sPct: null, maxReturn5sPct: null,
        maxReturn15sPct: null, minDrawdown15sPct: 2,
      },
      // Forward-only execution comparator for COB-F. It deliberately keeps
      // the same public-flow signal but reproduces the retired live route's
      // 0.1 SOL size, 1.5s freshness window and stricter jump/impact limits.
      // It never emits a live signal and does not alter the original 1 SOL
      // COB-F cohort or any historical row.
      {
        id: 'COB_F_LR01',
        label: 'COB-F-LR01 · 0.1 SOL live-execution replay',
        newEntriesEnabled: booleanEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_ENABLED', true),
        liveReplay: true,
        exclusiveGroup: 'COB_F_LIVE_REPLAY',
        exitProfileIds: ['CORE25_R75_X120'],
        positionSizeSol: numberEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_POSITION_SOL', 0.1, {
          min: 0.001, max: 100,
        }),
        entryDelayMs: integerEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_ENTRY_DELAY_MS', 200, {
          min: 0, max: 10_000,
        }),
        entryTimeoutMs: integerEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_ENTRY_TIMEOUT_MS', 1_500, {
          min: 1, max: 30_000,
        }),
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_JUMP_PCT', 15,
          { min: 0, max: 1_000 },
        ),
        maxEntryPriceDropPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_DROP_PCT', 35,
          { min: 0, max: 100 },
        ),
        maxEntryImpactPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_IMPACT_PCT', 10,
          { min: 0, max: 1_000 },
        ),
        minAgeMs: 2_000, maxAgeMs: 10_000, maxCurvePct: null,
        minBuyers5s: 10, minNetFlow5sSol: 7,
        minBuyTxSharePct: 70, maxBuyTxSharePct: 95,
        minReturn2sPct: 0, maxReturn2sPct: 40,
        minReturn5sPct: null, maxReturn5sPct: null,
        maxReturn15sPct: null, minDrawdown15sPct: 2,
      },
      // Strict forward-only RUG filter pair. Both arms use the exact COB-F
      // public-flow signal, 0.1 SOL execution constraints and FIX30 exit. The
      // baseline remains label-only; RUGX alone hard-blocks the three current
      // high-specificity live Curve catastrophe signatures.
      {
        id: 'COB_F_LR01_FIX30',
        label: 'COB-F-LR01 FIX30 · 0.1 SOL 高频RUG基准',
        newEntriesEnabled: booleanEnv('FLOW_CYA_ORGANIC_BURST_RUG_PAIR_ENABLED', true),
        liveReplay: true,
        exclusiveGroup: 'COB_F_LR01_FIX30_BASELINE',
        exitProfileIds: ['FIX30'],
        positionSizeSol: numberEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_POSITION_SOL', 0.1, {
          min: 0.001, max: 100,
        }),
        entryDelayMs: integerEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_ENTRY_DELAY_MS', 200, {
          min: 0, max: 10_000,
        }),
        entryTimeoutMs: integerEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_ENTRY_TIMEOUT_MS', 1_500, {
          min: 1, max: 30_000,
        }),
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_JUMP_PCT', 15,
          { min: 0, max: 1_000 },
        ),
        maxEntryPriceDropPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_DROP_PCT', 35,
          { min: 0, max: 100 },
        ),
        maxEntryImpactPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_IMPACT_PCT', 10,
          { min: 0, max: 1_000 },
        ),
        minAgeMs: 2_000, maxAgeMs: 10_000, maxCurvePct: null,
        minBuyers5s: 10, minNetFlow5sSol: 7,
        minBuyTxSharePct: 70, maxBuyTxSharePct: 95,
        minReturn2sPct: 0, maxReturn2sPct: 40,
        minReturn5sPct: null, maxReturn5sPct: null,
        maxReturn15sPct: null, minDrawdown15sPct: 2,
      },
      {
        id: 'COB_F_LR01_FIX30_RUGX',
        label: 'COB-F-LR01 FIX30 RUGX · 同信号高置信灾难过滤',
        newEntriesEnabled: booleanEnv('FLOW_CYA_ORGANIC_BURST_RUG_PAIR_ENABLED', true),
        liveReplay: true,
        pairedBaselineProfileId: 'COB_F_LR01_FIX30',
        rugGuardMode: 'LIVE_CURVE_CATASTROPHE',
        exclusiveGroup: 'COB_F_LR01_FIX30_RUGX',
        exitProfileIds: ['FIX30'],
        positionSizeSol: numberEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_POSITION_SOL', 0.1, {
          min: 0.001, max: 100,
        }),
        entryDelayMs: integerEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_ENTRY_DELAY_MS', 200, {
          min: 0, max: 10_000,
        }),
        entryTimeoutMs: integerEnv('FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_ENTRY_TIMEOUT_MS', 1_500, {
          min: 1, max: 30_000,
        }),
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_JUMP_PCT', 15,
          { min: 0, max: 1_000 },
        ),
        maxEntryPriceDropPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_DROP_PCT', 35,
          { min: 0, max: 100 },
        ),
        maxEntryImpactPct: numberEnv(
          'FLOW_CYA_ORGANIC_BURST_LIVE_REPLAY_MAX_ENTRY_IMPACT_PCT', 10,
          { min: 0, max: 1_000 },
        ),
        minAgeMs: 2_000, maxAgeMs: 10_000, maxCurvePct: null,
        minBuyers5s: 10, minNetFlow5sSol: 7,
        minBuyTxSharePct: 70, maxBuyTxSharePct: 95,
        minReturn2sPct: 0, maxReturn2sPct: 40,
        minReturn5sPct: null, maxReturn5sPct: null,
        maxReturn15sPct: null, minDrawdown15sPct: 2,
      },
      {
        id: 'COB_D',
        label: 'COB-D · strict 5 SOL organic pullback',
        newEntriesEnabled: true,
        liveStrategyId: 'cya_organic_burst_cob_d_fix30_live',
        exclusiveGroup: 'COB_STRICT',
        exitProfileIds: ['FIX30', 'CORE25_R75_X120'],
        minAgeMs: 2_000, maxAgeMs: 10_000, maxCurvePct: null,
        minBuyers5s: 10, minNetFlow5sSol: 5,
        minBuyTxSharePct: 70, maxBuyTxSharePct: 95,
        minReturn2sPct: 0, maxReturn2sPct: 40,
        minReturn5sPct: null, maxReturn5sPct: null,
        maxReturn15sPct: null, minDrawdown15sPct: 2,
      },
    ],
    exitProfiles: [
      {
        id: 'INV10_X30',
        label: 'first 10s structure invalidation / max 30s',
        maxHoldMs: 30_000,
        structureInvalidationEnabled: true,
        minInvalidationHoldMs: 1_000,
        invalidationWindowMs: 10_000,
        invalidationDrawdownPct: 8,
        maxInvalidationReturn2sPct: 0,
      },
      {
        id: 'FIX20',
        label: 'fixed 20s control',
        maxHoldMs: 20_000,
        structureInvalidationEnabled: false,
        minInvalidationHoldMs: 0,
        invalidationWindowMs: 0,
        invalidationDrawdownPct: 0,
        maxInvalidationReturn2sPct: 0,
      },
      {
        id: 'FIX30',
        label: 'fixed 30s right-tail control',
        mode: 'FIXED_HOLD',
        maxHoldMs: 30_000,
        structureInvalidationEnabled: false,
        minInvalidationHoldMs: 0,
        invalidationWindowMs: 0,
        invalidationDrawdownPct: 0,
        maxInvalidationReturn2sPct: 0,
      },
      {
        id: 'FLOWFADE_X60',
        label: '5s protection / 2-of-3 flow fade / max 60s',
        mode: 'FLOW_FADE',
        minHoldMs: 5_000,
        maxHoldMs: 60_000,
        minFadeVotes: 2,
        minSellBuyFlowRatio: 0.8,
        maxBuyerRetentionRatio: 0.5,
        structureInvalidationEnabled: false,
      },
      {
        id: 'T30_10_X60',
        label: '-20% stop / +30% activation / 10% drawdown / max 60s',
        mode: 'TRAILING',
        hardStopPct: 20,
        minHoldMs: 0,
        trailingActivationPct: 30,
        trailingStopPct: 10,
        maxHoldMs: 60_000,
        structureInvalidationEnabled: false,
      },
      {
        id: 'CORE25_R75_X120',
        label: '+20% sell 25% / 75% stair runner / max 120s',
        mode: 'CORE_RUNNER',
        coreActivationPct: 20,
        coreWeightPct: 25,
        maxHoldMs: 120_000,
        trailingTiers: [
          { activationPct: 20, drawdownPct: 15 },
          { activationPct: 50, drawdownPct: 20 },
          { activationPct: 100, drawdownPct: 25 },
        ],
        structureInvalidationEnabled: false,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_CYA_ORGANIC_BURST_POSITION_SOL'),
    }),
  },

  // Forward-only validation of the FEA early pure-buy observation. These
  // cohorts never emit live signals. Missing executable exits stay NO_EXIT
  // and are excluded from return statistics instead of becoming -100%.
  earlyPureBuyBurstShadow: {
    enabled: booleanEnv('FLOW_EARLY_PURE_BUY_BURST_SHADOW_ENABLED', true),
    positionSizeSol: shadowPositionEnv('FLOW_EARLY_PURE_BUY_BURST_POSITION_SOL'),
    featureWindowMs: integerEnv('FLOW_EARLY_PURE_BUY_BURST_FEATURE_WINDOW_MS', 3_000, {
      min: 3_000, max: 10_000,
    }),
    maxTradesPerMint: integerEnv('FLOW_EARLY_PURE_BUY_BURST_MAX_TRADES_PER_MINT', 128, {
      min: 32, max: 512,
    }),
    stateRetentionMs: integerEnv('FLOW_EARLY_PURE_BUY_BURST_STATE_RETENTION_MS', 120_000, {
      min: 30_000, max: 10 * 60_000,
    }),
    entryDelayMs: integerEnv('FLOW_EARLY_PURE_BUY_BURST_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_EARLY_PURE_BUY_BURST_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_EARLY_PURE_BUY_BURST_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_EARLY_PURE_BUY_BURST_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_EARLY_PURE_BUY_BURST_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0, max: 100,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_EARLY_PURE_BUY_BURST_MAX_ENTRY_DROP_PCT', 35, {
      min: 0, max: 100,
    }),
    maxEntryImpactPct: numberEnv('FLOW_EARLY_PURE_BUY_BURST_MAX_ENTRY_IMPACT_PCT', 15, {
      min: 0, max: 100,
    }),
    base: {
      maxAgeMs: integerEnv('FLOW_EARLY_PURE_BUY_BURST_MAX_AGE_MS', 10_000, { min: 1_000 }),
      maxCurvePct: numberEnv('FLOW_EARLY_PURE_BUY_BURST_MAX_CURVE_PCT', 50, {
        min: 1, max: 100,
      }),
      minNetFlow3sSol: numberEnv('FLOW_EARLY_PURE_BUY_BURST_MIN_NETFLOW_3S_SOL', 3, {
        min: 0,
      }),
      maxNetFlow3sSol: numberEnv('FLOW_EARLY_PURE_BUY_BURST_MAX_NETFLOW_3S_SOL', 5, {
        min: 0,
      }),
      minBuyers3s: integerEnv('FLOW_EARLY_PURE_BUY_BURST_MIN_BUYERS_3S', 2, { min: 1 }),
      maxBuyers3s: integerEnv('FLOW_EARLY_PURE_BUY_BURST_MAX_BUYERS_3S', 4, { min: 1 }),
      maxSellTx3s: 0,
    },
    confirmationB: {
      minDelayMs: 300, maxDelayMs: 500, minDeltaBuyers: 1,
      minDeltaNetFlowSol: 0.5, maxJumpPct: 10,
    },
    confirmationC: {
      minDelayMs: 1_000, maxDelayMs: 3_000,
      minDrawdownPct: 3, maxDrawdownPct: 8,
      minReclaimPct: 1, maxReclaimPct: 2,
      maxSingleSellSol: 0.5, maxSellSharePct: 35,
    },
    entryProfiles: [
      { id: 'EB_A', label: 'EB-A · immediate pure-buy burst', newEntriesEnabled: true },
      {
        id: 'EB_A_RUGX',
        label: 'EB-A RUGX · 同信号 + 当前高置信灾难过滤 · FIX20',
        newEntriesEnabled: true,
        pairedBaselineProfileId: 'EB_A',
        rugGuardMode: 'LIVE_CURVE_CATASTROPHE',
        exitProfileIds: ['FIX20'],
      },
      { id: 'EB_B', label: 'EB-B · 300-500ms continuation', newEntriesEnabled: true },
      { id: 'EB_C', label: 'EB-C · 1-3s pullback reclaim', newEntriesEnabled: true },
      booleanEnv('FLOW_EARLY_PURE_BUY_BURST_SWC_R2_W300_ENABLED', true) && {
        id: 'EB_A_SWC_R2_W300',
        label: '宽松对照 · EB-A + 300秒内2个独立集群',
        newEntriesEnabled: true,
        sourceProfileId: 'EB_A',
        consensusWindowMs: integerEnv(
          'FLOW_EARLY_PURE_BUY_BURST_SWC_WINDOW_MS', 300_000, { min: 30_000 },
        ),
        requiredClusters: integerEnv(
          'FLOW_EARLY_PURE_BUY_BURST_SWC_REQUIRED_CLUSTERS', 2, { min: 2 },
        ),
        exitProfileIds: ['FIX20', 'FIX30'],
      },
      booleanEnv('FLOW_EARLY_PURE_BUY_BURST_SWC_PA3_W300_ENABLED', true) && {
        id: 'EB_A_SWC_PA3_W300',
        label: 'EB-A + 300秒内3个P_A独立集群',
        newEntriesEnabled: true,
        sourceProfileId: 'EB_A',
        consensusWindowMs: integerEnv(
          'FLOW_EARLY_PURE_BUY_BURST_SWC_PA3_WINDOW_MS', 300_000, { min: 30_000 },
        ),
        requiredClusters: 3,
        minSelectionAClusters: 3,
        selectionGradeOnly: 'S_A',
        exitProfileIds: ['FIX20', 'FIX30'],
      },
    ].filter(Boolean),
    exitProfiles: [
      { id: 'FIX5', label: 'fixed 5s', maxHoldMs: 5_000 },
      { id: 'FIX20', label: 'fixed 20s', maxHoldMs: 20_000 },
      { id: 'FIX30', label: 'fixed 30s', maxHoldMs: 30_000 },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_EARLY_PURE_BUY_BURST_POSITION_SOL'),
    }),
  },

  // Independent early Bonding Curve research derived from the original CYA
  // hypothesis. This retired K matrix is kept separate so its historical rows
  // never mix with the new completed-slot CSF experiment.
  cyaEarlyPyramidShadow: {
    enabled: provenNegativeShadowsEnabled
      && booleanEnv('FLOW_CYA_EARLY_PYRAMID_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_CYA_EARLY_PYRAMID_POSITION_SOL'),
    stateWindowMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_STATE_WINDOW_MS', 5_000, {
      min: 2_000,
      max: 30_000,
    }),
    stateRetentionMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_STATE_RETENTION_MS', 240_000, {
      min: 30_000,
      max: 15 * 60_000,
    }),
    entryDelayMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_ENTRY_TIMEOUT_MS', 2_000, {
      min: 1,
    }),
    exitDelayMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_EXIT_TIMEOUT_MS', 5_000, {
      min: 1,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_CYA_EARLY_PYRAMID_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0,
      max: 100,
    }),
    addStepPct: numberEnv('FLOW_CYA_EARLY_PYRAMID_ADD_STEP_PCT', 15, {
      min: 0.1,
      max: 500,
    }),
    addFraction: numberEnv('FLOW_CYA_EARLY_PYRAMID_ADD_FRACTION', 1 / 12, {
      min: 0.001,
      max: 1,
    }),
    addCooldownMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_ADD_COOLDOWN_MS', 250, {
      min: 0,
      max: 30_000,
    }),
    maxAdds: integerEnv('FLOW_CYA_EARLY_PYRAMID_MAX_ADDS', 6, { min: 0, max: 20 }),
    firstTakeProfitPct: numberEnv('FLOW_CYA_EARLY_PYRAMID_TP1_PCT', 50, { min: 1 }),
    secondTakeProfitPct: numberEnv('FLOW_CYA_EARLY_PYRAMID_TP2_PCT', 100, { min: 1 }),
    hardStopPct: numberEnv('FLOW_CYA_EARLY_PYRAMID_HARD_STOP_PCT', 30, {
      min: 0.1,
      max: 100,
    }),
    noStrengthMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_NO_STRENGTH_MS', 25_000, {
      min: 1_000,
    }),
    noStrengthMfePct: numberEnv('FLOW_CYA_EARLY_PYRAMID_NO_STRENGTH_MFE_PCT', 20, {
      min: 0,
    }),
    maxHoldMs: integerEnv('FLOW_CYA_EARLY_PYRAMID_MAX_HOLD_MS', 180_000, {
      min: 1_000,
    }),
    entryProfiles: [
      {
        id: 'K5_30',
        label: 'K5-30 · AGE 5–30s / Curve 20–60%',
        minAgeMs: 5_000,
        maxAgeMs: 30_000,
        minCurvePct: 20,
        maxCurvePct: 60,
        minBuyers5s: 3,
        maxBuyers5s: 14,
        minNetFlow5s: 0.1,
        maxNetFlow5s: 15,
        maxReturn2sPct: 15,
      },
      {
        id: 'K3_30',
        label: 'K3-30 · AGE 3–30s / Curve 20–60%',
        minAgeMs: 3_000,
        maxAgeMs: 30_000,
        minCurvePct: 20,
        maxCurvePct: 60,
        minBuyers5s: 2,
        maxBuyers5s: 18,
        minNetFlow5s: 0,
        maxNetFlow5s: 20,
        maxReturn2sPct: 25,
      },
    ],
    exitProfiles: [
      { id: 'T20', label: 'Runner peak drawdown 20%', trailingStopPct: 20 },
      { id: 'T30', label: 'Runner peak drawdown 30%', trailingStopPct: 30 },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_CYA_EARLY_PYRAMID_POSITION_SOL'),
    }),
  },

  // Independent pre-migration Bonding Curve momentum research. It evaluates
  // causal order-flow edges and simulated exits only; no execution path exists.
  bondingCurveMomentumShadow: {
    enabled: retiredShadowsEnabled && booleanEnv('FLOW_BONDING_MOMENTUM_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_BONDING_MOMENTUM_POSITION_SOL'),
    stateWindowMs: integerEnv('FLOW_BONDING_MOMENTUM_STATE_WINDOW_MS', 5_000, {
      min: 5_000,
      max: 30_000,
    }),
    stateRetentionMs: integerEnv('FLOW_BONDING_MOMENTUM_STATE_RETENTION_MS', 60_000, {
      min: 5_000,
      max: 10 * 60_000,
    }),
    episodeCooldownMs: integerEnv('FLOW_BONDING_MOMENTUM_EPISODE_COOLDOWN_MS', 5_000, {
      min: 0,
      max: 10 * 60_000,
    }),
    entryDelayMs: integerEnv('FLOW_BONDING_MOMENTUM_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_BONDING_MOMENTUM_ENTRY_TIMEOUT_MS', 2_000, {
      min: 1,
    }),
    exitDelayMs: integerEnv('FLOW_BONDING_MOMENTUM_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_BONDING_MOMENTUM_EXIT_TIMEOUT_MS', 5_000, {
      min: 1,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_BONDING_MOMENTUM_MAX_ENTRY_JUMP_PCT', 10, {
      min: 0,
      max: 100,
    }),
    snapshotHorizonsMs: millisecondListEnv(
      'FLOW_BONDING_MOMENTUM_SNAPSHOT_SECONDS',
      [1, 2, 3, 5, 8, 10, 20, 30],
    ),
    maxSnapshotLagMs: integerEnv('FLOW_BONDING_MOMENTUM_MAX_SNAPSHOT_LAG_MS', 2_000, {
      min: 0,
      max: 30_000,
    }),
    flowExitNetFlowSol: numberEnv('FLOW_BONDING_MOMENTUM_FLOW_EXIT_NET_SOL', 0),
    flowExitMaxBuyTxAccel: numberEnv('FLOW_BONDING_MOMENTUM_FLOW_EXIT_BUY_TX_ACCEL', 0),
    flowExitMinSellSol: numberEnv('FLOW_BONDING_MOMENTUM_FLOW_EXIT_MIN_SELL_SOL', 0.5, {
      min: 0,
    }),
    bigWinnerPct: numberEnv('FLOW_BONDING_MOMENTUM_BIG_WINNER_PCT', 50, { min: 1 }),
    entryProfiles: [
      {
        id: 'H0',
        label: 'H0 · Lifecycle订单流基线',
        minAgeMs: 10_000,
        maxAgeMs: 60_000,
        minCurvePct: 40,
        maxCurvePct: 100,
        minNetFlow1s: 5,
        minFlowAccel1s: 1.5,
        minBuyers1s: 5,
        minBuyTx1s: 5,
      },
      {
        id: 'H1',
        label: 'H1 · 买单速度加速',
        minAgeMs: 10_000,
        maxAgeMs: 60_000,
        minCurvePct: 40,
        maxCurvePct: 100,
        minNetFlow1s: 5,
        minFlowAccel1s: 1.5,
        minBuyers1s: 5,
        minBuyTx1s: 5,
        minBuyTxAccel1s: 6,
        maxTop1SharePct: 50,
      },
      {
        id: 'H2',
        label: 'H2 · 新买家资金分散',
        minAgeMs: 10_000,
        maxAgeMs: 60_000,
        minCurvePct: 40,
        maxCurvePct: 100,
        minNetFlow1s: 5,
        minFlowAccel1s: 1.5,
        minBuyers1s: 5,
        minNewBuyers1s: 4,
        minBuyTx1s: 5,
        maxTop1SharePct: 30,
      },
      {
        id: 'H3',
        label: 'H3 · 卖压衰减转换',
        minAgeMs: 10_000,
        maxAgeMs: 180_000,
        minCurvePct: 40,
        maxCurvePct: 100,
        minNetFlow1s: 3,
        minFlowAccel1s: 1.5,
        minBuyers1s: 5,
        minBuyTx1s: 5,
        minPriorSellSol1s: 0.5,
        maxSellDecayRatio: 0.25,
      },
    ],
    exitProfiles: [
      {
        id: 'X3',
        label: 'X3 · 固定持有3秒',
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_BONDING_MOMENTUM_FIXED_HOLD_MS', 3_000, {
          min: 250,
        }),
        maxHoldMs: 3_000,
      },
      {
        id: 'XF',
        label: 'XF · 订单流反转 / 10秒兜底',
        exitMode: 'FLOW_REVERSAL',
        minHoldMs: integerEnv('FLOW_BONDING_MOMENTUM_FLOW_MIN_HOLD_MS', 500, { min: 0 }),
        maxHoldMs: integerEnv('FLOW_BONDING_MOMENTUM_FLOW_MAX_HOLD_MS', 10_000, {
          min: 1_000,
        }),
      },
      {
        id: 'XT',
        label: 'XT · +10%激活 / 回撤7.5% / 30秒兜底',
        exitMode: 'WINNER_TRAIL',
        minHoldMs: integerEnv('FLOW_BONDING_MOMENTUM_TRAIL_MIN_HOLD_MS', 500, { min: 0 }),
        trailingActivationPct: numberEnv(
          'FLOW_BONDING_MOMENTUM_TRAIL_ACTIVATION_PCT',
          10,
          { min: 0.1, max: 1_000 },
        ),
        trailingStopPct: numberEnv('FLOW_BONDING_MOMENTUM_TRAIL_STOP_PCT', 7.5, {
          min: 0.1,
          max: 100,
        }),
        maxHoldMs: integerEnv('FLOW_BONDING_MOMENTUM_TRAIL_MAX_HOLD_MS', 30_000, {
          min: 1_000,
        }),
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_BONDING_MOMENTUM_POSITION_SOL'),
    }),
  },

  // Graduation probability is used only as a hold/exit overlay on an earlier
  // Primary Flow entry. It never opens a fresh position above the configured
  // Curve ceiling and never owns a signer or transaction executor.
  graduationHoldShadow: {
    enabled: retiredShadowsEnabled && booleanEnv('FLOW_GRADUATION_HOLD_SHADOW_ENABLED', false),
    signalVariant: 'primary_3w',
    positionSizeSol: shadowPositionEnv('FLOW_GRADUATION_HOLD_POSITION_SOL'),
    maxSignalLatencyMs: integerEnv('FLOW_GRADUATION_HOLD_MAX_SIGNAL_LATENCY_MS', 1_500, {
      min: 100,
    }),
    maxSignalCurvePct: numberEnv('FLOW_GRADUATION_HOLD_MAX_ENTRY_CURVE_PCT', 70, {
      min: 0,
      max: 100,
    }),
    maxTokenAgeMs: integerEnv('FLOW_GRADUATION_HOLD_MAX_TOKEN_AGE_MS', 10 * 60_000, {
      min: 1_000,
      max: 60 * 60_000,
    }),
    stateRetentionMs: integerEnv('FLOW_GRADUATION_HOLD_STATE_RETENTION_MS', 10 * 60_000, {
      min: 5_000,
      max: 60 * 60_000,
    }),
    entryDelayMs: integerEnv('FLOW_GRADUATION_HOLD_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_GRADUATION_HOLD_ENTRY_TIMEOUT_MS', 2_000, {
      min: 1,
    }),
    exitDelayMs: integerEnv('FLOW_GRADUATION_HOLD_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_GRADUATION_HOLD_EXIT_TIMEOUT_MS', 5_000, {
      min: 1,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_GRADUATION_HOLD_MAX_ENTRY_JUMP_PCT', 10, {
      min: 0,
      max: 100,
    }),
    hardStopPct: numberEnv('FLOW_GRADUATION_HOLD_HARD_STOP_PCT', 30, {
      min: 0.1,
      max: 100,
    }),
    controlTrailingStopPct: numberEnv('FLOW_GRADUATION_HOLD_I0_TRAILING_STOP_PCT', 7.5, {
      min: 0.1,
      max: 100,
    }),
    controlMaxHoldMs: integerEnv('FLOW_GRADUATION_HOLD_I0_MAX_HOLD_MS', 60_000, {
      min: 1_000,
    }),
    maxHoldMs: integerEnv('FLOW_GRADUATION_HOLD_MAX_HOLD_MS', 120_000, {
      min: 1_000,
    }),
    firstCheckpointTimeoutMs: integerEnv(
      'FLOW_GRADUATION_HOLD_FIRST_CHECKPOINT_TIMEOUT_MS',
      20_000,
      { min: 1_000 },
    ),
    stepTimeoutMs: integerEnv('FLOW_GRADUATION_HOLD_STEP_TIMEOUT_MS', 3_000, {
      min: 250,
    }),
    graduationTimeoutMs: integerEnv('FLOW_GRADUATION_HOLD_GRADUATION_TIMEOUT_MS', 15_000, {
      min: 1_000,
    }),
    ammExitDelayMs: integerEnv('FLOW_GRADUATION_HOLD_I2_AMM_EXIT_DELAY_MS', 5_000, {
      min: 0,
    }),
    bridgeMinBuyers5: integerEnv('FLOW_GRADUATION_HOLD_I2_MIN_BUYERS_5S', 12, {
      min: 1,
    }),
    bridgeMaxCumulativeTrades: integerEnv(
      'FLOW_GRADUATION_HOLD_I2_MAX_CUMULATIVE_TRADES',
      20,
      { min: 1 },
    ),
    checkpoints: [70, 80, 85, 90, 95, 97],
    checkpointRules: [
      {
        thresholdPct: 70,
        minNetFlow5Sol: 0,
        minBuyers5: 3,
        maxSellSol5: 1,
        minCurveDelta5: 5,
      },
      {
        thresholdPct: 80,
        minNetFlow5Sol: 0,
        minBuyers5: 1,
        maxSellSol5: null,
        minCurveDelta5: 5,
      },
      {
        thresholdPct: 85,
        minNetFlow5Sol: 0,
        minBuyers5: 1,
        maxSellSol5: null,
        minCurveDelta5: 5,
      },
      {
        thresholdPct: 90,
        minNetFlow5Sol: 0,
        minBuyers5: 4,
        maxSellSol5: null,
        minCurveDelta5: 5,
      },
      {
        thresholdPct: 95,
        minNetFlow5Sol: 0,
        minBuyers5: 4,
        maxSellSol5: null,
        minCurveDelta5: 5,
      },
    ],
    cohorts: [
      {
        id: 'I0',
        label: 'I0 · Early Entry移动止盈对照',
        exitMode: 'CONTROL_TRAILING',
      },
      {
        id: 'I1',
        label: 'I1 · 概率检查点 / 97%毕业前退出',
        exitMode: 'PRE_GRAD_CHECKPOINTS',
      },
      {
        id: 'I2',
        label: 'I2 · 严格概率检查点 / 穿越毕业',
        exitMode: 'THROUGH_GRADUATION',
      },
    ],
    bigWinnerPct: numberEnv('FLOW_GRADUATION_HOLD_BIG_WINNER_PCT', 50, { min: 1 }),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_GRADUATION_HOLD_POSITION_SOL'),
    }),
  },

  // Lifecycle oversold-rebound research. Pre-migration curve trades and the
  // post-migration PumpSwap subscription use separate cohorts; profiles below
  // are orthogonal online experiments and never create or sign a transaction.
  migratedDropReboundShadow: {
    enabled: booleanEnv('FLOW_MIGRATED_REBOUND_SHADOW_ENABLED', true),
    gfrEnabled: migratedReboundGfrEnabled,
    // Cohort-level retirement keeps the useful G/GQ/GFR controls running while
    // stopping only the repeatedly negative combinations. Prefix matching also
    // covers their capacity suffixes (for example _0P1SOL and _1SOL).
    retiredCohortPrefixes: [
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
    ],
    lifecycleStages: [
      { id: 'POST_MIGRATION', label: '毕业后', market: 'PUMP_AMM' },
    ],
    stateRetentionMs: integerEnv('FLOW_REBOUND_DETECTOR_STATE_RETENTION_MS', 60_000, {
      min: 5_000,
      max: 10 * 60_000,
    }),
    trackingAgeMs: Math.min(120_000, integerEnv('FLOW_MIGRATED_REBOUND_TRACKING_MS', 120_000, {
      min: 30_000,
      max: 30 * 60_000,
    })),
    // Keep lightweight post-migration observation alive for offline labels and
    // later-stage research. Individual entry profiles retain their own much
    // shorter causal age gates (the direct-dump cohort remains <=30 seconds).
    observationAgeMs: integerEnv(
      'FLOW_MIGRATED_REBOUND_OBSERVATION_MS',
      30 * 60_000,
      { min: 120_000, max: 60 * 60_000 },
    ),
    // Completion and PumpSwap migration are separate events. Keep completed
    // Mints subscribed long enough to observe a delayed migration/first AMM
    // trade, without extending any profile's post-migration entry age gate.
    pendingMigrationTrackingMs: integerEnv(
      'FLOW_MIGRATED_REBOUND_PENDING_MIGRATION_MS',
      2 * 60 * 60_000,
      { min: 30 * 60_000, max: 6 * 60 * 60_000 },
    ),
    positionSizeSol: shadowPositionEnv('FLOW_MIGRATED_REBOUND_POSITION_SOL'),
    entryDelayMs: integerEnv('FLOW_MIGRATED_REBOUND_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_MIGRATED_REBOUND_ENTRY_TIMEOUT_MS', 2_000, {
      min: 1,
    }),
    fastFlowMaxTradesPerMint: integerEnv(
      'FLOW_MIGRATED_REBOUND_GFR_MAX_TRADES_PER_MINT',
      512,
      { min: 32, max: 10_000 },
    ),
    fastFlowSweepMs: integerEnv(
      'FLOW_MIGRATED_REBOUND_GFR_SWEEP_MS',
      5_000,
      { min: 1_000, max: 60_000 },
    ),
    exitDelayMs: integerEnv('FLOW_MIGRATED_REBOUND_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_MIGRATED_REBOUND_EXIT_TIMEOUT_MS', 5_000, {
      min: 1,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_MIGRATED_REBOUND_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0,
      max: 100,
    }),
    maxPlausibleReturnPct: numberEnv(
      'FLOW_MIGRATED_REBOUND_MAX_PLAUSIBLE_RETURN_PCT',
      1_000,
      { min: 10, max: 100_000 },
    ),
    ammPriceContinuity: {
      minRatio: numberEnv('FLOW_MIGRATED_REBOUND_AMM_PRICE_MIN_RATIO', 0.2, {
        min: 0.0001,
        max: 1,
      }),
      maxRatio: numberEnv('FLOW_MIGRATED_REBOUND_AMM_PRICE_MAX_RATIO', 5, {
        min: 1,
      }),
      resetAfterMs: integerEnv('FLOW_MIGRATED_REBOUND_AMM_PRICE_RESET_MS', 15_000, {
        min: 1_000,
      }),
      confirmationTrades: integerEnv(
        'FLOW_MIGRATED_REBOUND_AMM_PRICE_CONFIRMATION_TRADES',
        2,
        { min: 2, max: 10 },
      ),
      confirmationWindowMs: integerEnv(
        'FLOW_MIGRATED_REBOUND_AMM_PRICE_CONFIRMATION_WINDOW_MS',
        2_000,
        { min: 100, max: 30_000 },
      ),
      confirmationTolerancePct: numberEnv(
        'FLOW_MIGRATED_REBOUND_AMM_PRICE_CONFIRMATION_TOLERANCE_PCT',
        20,
        { min: 0.1, max: 100 },
      ),
    },
    bigWinnerPct: numberEnv('FLOW_MIGRATED_REBOUND_BIG_WINNER_PCT', 50, { min: 1 }),
    entryProfiles: [
      {
        id: 'GD25_35',
        label: '深跌25–35%',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
        liveExitStrategies: {
          X8: 'migrated_gd25_35_x8_live',
        },
      },
      {
        id: 'GD25_35_RUG_GUARD_ALL',
        label: 'G-RUG-ALL · 深跌反弹 + 公共订单流RUG过滤',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
        maxSignalsPerMint: 1,
        requireHealthyRugRisk: true,
        exitProfileIds: ['X8', 'XLEG'],
        capacityAware: true,
        positionSols: [0.1, 1],
      },
      {
        id: 'GD25_35_RUG_GUARD_T20_24',
        label: 'G-RUG-T20-24 · RUG过滤 + 北京20–24时',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
        maxSignalsPerMint: 1,
        requireHealthyRugRisk: true,
        beijingHourRanges: [[20, 24]],
        exitProfileIds: ['X8', 'XLEG'],
        capacityAware: true,
        positionSols: [0.1, 1],
      },
      {
        id: 'GE30_R23_F1',
        label: '毕业后30秒内 · 反弹2%–3% · 每Mint首次',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
      },
      {
        id: 'GE30_R23_F3',
        label: '毕业后30秒内 · 反弹2%–3% · 每Mint前三次',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 3,
      },
      {
        id: 'GE30_R23_F1_EXEC',
        label: 'G-EXEC · 30秒内反弹2%–3% · 首次 · 多容量真实冲击',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        exitProfileIds: ['GEXEC_XLEG'],
        capacityAware: true,
        positionSols: listEnv(
          'FLOW_MIGRATED_REBOUND_EXEC_CAPACITY_SOLS',
          ['0.05', '0.1', '0.25', '0.5', '1'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'GE30_R23_F1_XQ',
        label: 'G-XQ · 首次反弹 + 可执行容量/价格质量',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        maxEntryPriceJumpPct: 5,
        maxEntryImpactPct: 3,
        exitProfileIds: ['G1XQ_X8', 'G1XQ_X30', 'G1XQ_X60'],
        capacityAware: true,
        positionSols: [0.1, 0.5, 1],
      },
      {
        id: 'GE30_R23_F2_ONLY',
        label: 'G-F2 · 30秒内反弹2%–3% · 只取第二次机会',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        minSignalOrdinal: 2,
        maxSignalsPerMint: 2,
        exitProfileIds: ['G2_XLEG', 'G2_XLEG_H20_FWD'],
        liveExitStrategies: {
          G2_XLEG: 'migrated_ge30_r23_f2_only_g2_xleg_live',
        },
      },
      {
        // New IDs intentionally avoid the retired POST_GE30_R23_F3_* prefix.
        // They create clean forward samples without rewriting historical rows.
        id: 'GRT_R23_F3_V2',
        label: 'G-RT-F3-V2 · 30秒内反弹2%–3% · 前三次前向样本',
        newEntriesEnabled: booleanEnv('FLOW_MIGRATED_REBOUND_GRT_R23_F3_V2_ENABLED', true),
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 3,
        exitProfileIds: ['GRT_F3_XLEG_V2', 'GRT_F3_XLEG_H20_FWD'],
        liveExitStrategies: {
          GRT_F3_XLEG_V2: 'migrated_grt_r23_f3_v2_xleg_live',
        },
      },
      {
        id: 'GRT_R23_F2_ONLY_V2',
        label: 'G-RT-F2-V2 · 30秒内反弹2%–3% · 只取第二次前向样本',
        newEntriesEnabled: booleanEnv('FLOW_MIGRATED_REBOUND_GRT_R23_F2_V2_ENABLED', true),
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        minSignalOrdinal: 2,
        maxSignalsPerMint: 2,
        exitProfileIds: ['GRT_F2_XLEG_V2'],
      },
      {
        id: 'GE30_R23_F3_EXEC',
        label: 'G-F3-EXEC · 前三次机会 · 真实AMM容量冲击',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 3,
        exitProfileIds: ['G3EXEC_XLEG'],
        capacityAware: true,
        positionSols: listEnv(
          'FLOW_MIGRATED_REBOUND_F23_EXEC_CAPACITY_SOLS',
          ['0.05', '0.1', '0.25', '0.5', '1'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'GE30_R23_F2_ONLY_EXEC',
        label: 'G-F2-EXEC · 只取第二次机会 · 真实AMM容量冲击',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        minSignalOrdinal: 2,
        maxSignalsPerMint: 2,
        exitProfileIds: ['G2EXEC_XLEG'],
        capacityAware: true,
        positionSols: listEnv(
          'FLOW_MIGRATED_REBOUND_F23_EXEC_CAPACITY_SOLS',
          ['0.05', '0.1', '0.25', '0.5', '1'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'GE30_R23_F1_NIGHT',
        label: 'G-TIME夜间 · 18:00–08:00 · 首次',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        beijingHourRanges: [[0, 8], [18, 24]],
        exitProfileIds: ['GTIME_XLEG'],
      },
      {
        id: 'GE30_R23_F1_DAY',
        label: 'G-TIME白天 · 08:00–18:00 · 首次对照',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        beijingHourRanges: [[8, 18]],
        exitProfileIds: ['GTIME_XLEG'],
      },
      {
        id: 'GE30_D25_32_R24_F1',
        label: 'V2 · 毕业后30秒内 · 跌25%–32% · 反弹2%–4% · 首次',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 32,
        reboundMinPct: 2,
        reboundMaxPct: 4,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_V2_MAX_ENTRY_JUMP_PCT',
          3,
          { min: 0, max: 100 },
        ),
      },
      {
        id: 'GE30_D25_32_R24_F1_EXEC1',
        label: 'V2-EXEC1 · 0.1/1 SOL执行容量对照 · R2-H15',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 32,
        reboundMinPct: 2,
        reboundMaxPct: 4,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_V2_MAX_ENTRY_JUMP_PCT',
          3,
          { min: 0, max: 100 },
        ),
        exitProfileIds: ['V2_R2_H15'],
        capacityAware: true,
        positionSols: [0.1, 1],
        livePositionSol: 0.1,
        liveExitStrategies: {
          V2_R2_H15: 'migrated_ge30_d25_32_r24_f1_exec01_v2_r2_h15_live',
        },
      },
      {
        id: 'GE30_D25_32_R24_F1_04_24',
        label: 'V2-TIME · 04:00–24:00 · 跌25%–32% · 反弹2%–4% · 首次',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 32,
        reboundMinPct: 2,
        reboundMaxPct: 4,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        beijingHourRanges: [[4, 24]],
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_V2_MAX_ENTRY_JUMP_PCT',
          3,
          { min: 0, max: 100 },
        ),
        exitProfileIds: ['V2_TIME_R2_H15'],
        capacityAware: true,
        positionSols: [0.1, 0.5, 1],
      },
      {
        id: 'GE30_D25_32_R23_F1_FAST200',
        label: 'GQ · post-grad <=30s · drop25-32% · rebound2-3% within200ms · first',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 32,
        reboundMinPct: 2,
        reboundMaxPct: 3,
        reboundTimeoutMs: 1_000,
        maxReboundFromLowMs: 200,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_GQ_MAX_ENTRY_JUMP_PCT',
          5,
          { min: 0, max: 100 },
        ),
        exitProfileIds: ['GQ_XLEG'],
        capacityAware: true,
        positionSols: listEnv(
          'FLOW_MIGRATED_REBOUND_GQ_CAPACITY_SOLS',
          ['0.05', '0.25', '0.5', '1'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
      },
      {
        id: 'GE30_DUMP5_NB2_M2',
        label: 'G-DUMP-NB · 毕业后30秒内 · >=5 SOL砸单 · 2秒内下一笔真实买单 · 每Mint最多2次',
        newEntriesEnabled: booleanEnv(
          'FLOW_MIGRATED_REBOUND_DUMP_NEXT_BUY_ENABLED',
          true,
        ),
        signalMode: 'DUMP_NEXT_BUY',
        windowMs: integerEnv('FLOW_MIGRATED_REBOUND_DUMP_WINDOW_MS', 1_000, {
          min: 250,
          max: 5_000,
        }),
        dropMinPct: numberEnv('FLOW_MIGRATED_REBOUND_DUMP_MIN_DROP_PCT', 15, {
          min: 1,
          max: 100,
        }),
        dropMaxPct: numberEnv('FLOW_MIGRATED_REBOUND_DUMP_MAX_DROP_PCT', 55, {
          min: 1,
          max: 100,
        }),
        minDumpSol: numberEnv('FLOW_MIGRATED_REBOUND_DUMP_MIN_SOL', 5, {
          min: 0.01,
          max: 10_000,
        }),
        nextBuyWindowMs: integerEnv(
          'FLOW_MIGRATED_REBOUND_DUMP_NEXT_BUY_WINDOW_MS',
          2_000,
          { min: 100, max: 10_000 },
        ),
        reboundMinPct: 0,
        reboundMaxPct: 1_000,
        reboundTimeoutMs: 2_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 2,
        reentryCooldownMs: 2_000,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_DUMP_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 100 },
        ),
        exitProfileIds: ['G_DUMP_NB_X8'],
        capacityAware: true,
        positionSols: [1],
        // Forward comparison only: record the lifecycle-aware guard decision,
        // but do not block or add latency to this new causal entry cohort.
        rugGuardMode: 'LABEL_ONLY',
      },
      ...(migratedReboundGfrEnabled ? [
        ['GFR_300', 300],
        ['GFR_600', 600],
        ['GFR_1000', 1_000],
      ].map(([id, confirmationMs]) => ({
        id,
        // Keep GFR_300 as the measured fast path. The 600/1000ms variants
        // remain queryable but stop producing new positions after a
        // persistently negative forward sample.
        newEntriesEnabled: id === 'GFR_300',
        liveStrategyId: id === 'GFR_300' ? 'migrated_gfr_300_hs20_h30_live' : null,
        label: `G-FR · 快速反转延续 · ${confirmationMs}ms确认`,
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
        maxLifecycleAgeMs: 30_000,
        maxSignalsPerMint: 1,
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_GFR_MAX_ENTRY_JUMP_PCT',
          15,
          { min: 0, max: 100 },
        ),
        exitProfileIds: ['GFR_X8', 'GFR_X15', 'GFR_HS20_H30'],
        capacityAware: true,
        positionSols: listEnv(
          'FLOW_MIGRATED_REBOUND_GFR_CAPACITY_SOLS',
          ['0.05', '0.1'],
        ).map(Number).filter((value) => Number.isFinite(value) && value > 0),
        fastConfirmation: {
          confirmationMs,
          minPriceContinuationPct: numberEnv(
            'FLOW_MIGRATED_REBOUND_GFR_MIN_CONTINUATION_PCT',
            1,
            { min: -100, max: 100 },
          ),
          minBuyTx: integerEnv('FLOW_MIGRATED_REBOUND_GFR_MIN_BUY_TX', 2, {
            min: 1,
            max: 100,
          }),
          minUniqueBuyers: integerEnv('FLOW_MIGRATED_REBOUND_GFR_MIN_BUYERS', 2, {
            min: 1,
            max: 100,
          }),
          minNetFlowSol: numberEnv('FLOW_MIGRATED_REBOUND_GFR_MIN_NET_FLOW_SOL', 0.5, {
            min: -1_000,
            max: 1_000,
          }),
          minNetFlowAccelerationSol: numberEnv(
            'FLOW_MIGRATED_REBOUND_GFR_MIN_NET_FLOW_ACCEL_SOL',
            0,
            { min: -1_000, max: 1_000 },
          ),
          maxSellBuyRatio: numberEnv(
            'FLOW_MIGRATED_REBOUND_GFR_MAX_SELL_BUY_RATIO',
            0.5,
            { min: 0, max: 100 },
          ),
          maxTopBuyerSharePct: numberEnv(
            'FLOW_MIGRATED_REBOUND_GFR_MAX_TOP_BUYER_SHARE_PCT',
            60,
            { min: 0, max: 100 },
          ),
          maxRoundTripImpactPct: numberEnv(
            'FLOW_MIGRATED_REBOUND_GFR_MAX_ROUND_TRIP_IMPACT_PCT',
            5,
            { min: 0, max: 100 },
          ),
        },
      })) : []),
    ],
    exitProfiles: [
      {
        id: 'G_DUMP_NB_X8',
        label: 'G-DUMP-NB · 固定持有8秒',
        entryProfileIds: ['GE30_DUMP5_NB2_M2'],
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_MIGRATED_REBOUND_DUMP_HOLD_MS', 8_000, {
          min: 250,
          max: 60_000,
        }),
      },
      {
        id: 'X3',
        label: '固定持有3秒',
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_MIGRATED_REBOUND_HOLD_3S_MS', 3_000, { min: 250 }),
      },
      {
        id: 'X8',
        label: '固定持有8秒',
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: integerEnv('FLOW_MIGRATED_REBOUND_HOLD_8S_MS', 8_000, { min: 250 }),
      },
      {
        id: 'XLEG',
        label: '旧版 +8%激活 / 回撤3% / 15秒兜底',
        exitMode: 'LEGACY',
        trailingActivationPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_TRAILING_ACTIVATION_PCT',
          8,
          { min: 0.1, max: 1_000 },
        ),
        trailingStopPct: numberEnv('FLOW_MIGRATED_REBOUND_LEGACY_TRAILING_STOP_PCT', 3, {
          min: 0.1,
          max: 100,
        }),
        fastTakeProfitPct: numberEnv('FLOW_MIGRATED_REBOUND_LEGACY_FAST_TP_PCT', 18, {
          min: 0,
          max: 1_000,
        }),
        fastTakeProfitWindowMs: integerEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_FAST_TP_WINDOW_MS',
          5_000,
          { min: 0 },
        ),
        lossCheckAtMs: integerEnv('FLOW_MIGRATED_REBOUND_LEGACY_LOSS_CHECK_MS', 6_000, {
          min: 0,
        }),
        maxHoldMs: integerEnv('FLOW_MIGRATED_REBOUND_LEGACY_MAX_HOLD_MS', 15_000, {
          min: 1_000,
        }),
      },
      ...[
        ['GEXEC_XLEG', ['GE30_R23_F1_EXEC'], '容量感知 XLEG'],
        ['G2_XLEG', ['GE30_R23_F2_ONLY'], '第二次机会 XLEG'],
        ['GRT_F3_XLEG_V2', ['GRT_R23_F3_V2'], '前三次机会前向 XLEG'],
        ['GRT_F2_XLEG_V2', ['GRT_R23_F2_ONLY_V2'], '第二次机会前向 XLEG'],
        ['G3EXEC_XLEG', ['GE30_R23_F3_EXEC'], '前三次机会容量感知 XLEG'],
        ['G2EXEC_XLEG', ['GE30_R23_F2_ONLY_EXEC'], '第二次机会容量感知 XLEG'],
        ['GTIME_XLEG', ['GE30_R23_F1_NIGHT', 'GE30_R23_F1_DAY'], '分时段 XLEG'],
      ].map(([id, entryProfileIds, label]) => ({
        id,
        label,
        entryProfileIds,
        exitMode: 'LEGACY',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
        maxHoldMs: 15_000,
      })),
      {
        id: 'G2_XLEG_H20_FWD',
        label: '第二次机会 XLEG + 20%硬止损（前向）',
        entryProfileIds: ['GE30_R23_F2_ONLY'],
        exitMode: 'RISK_XLEG',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct: 20,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
        lossCheckRecoveryPct: 1,
        maxHoldMs: 15_000,
      },
      {
        id: 'GRT_F3_XLEG_H20_FWD',
        label: 'GRT前三次机会 XLEG + 20%硬止损（前向对照）',
        entryProfileIds: ['GRT_R23_F3_V2'],
        exitMode: 'RISK_XLEG',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct: 20,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
        lossCheckRecoveryPct: 1,
        maxHoldMs: 15_000,
      },
      {
        id: 'GQ_XLEG',
        label: 'GQ fast-rebound capacity XLEG',
        entryProfileIds: ['GE30_D25_32_R23_F1_FAST200'],
        exitMode: 'LEGACY',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
        maxHoldMs: 15_000,
      },
      ...[
        ['G1XQ_X8', 8_000],
        ['G1XQ_X30', 30_000],
        ['G1XQ_X60', 60_000],
      ].map(([id, fixedHoldMs]) => ({
        id,
        label: `${id} · G-XQ容量感知固定持有`,
        entryProfileIds: ['GE30_R23_F1_XQ'],
        exitMode: 'FIXED_HOLD',
        fixedHoldMs,
      })),
      ...(migratedReboundGfrEnabled ? [{
        id: 'GFR_X8',
        label: 'G-FR · 固定持有8秒',
        entryProfileIds: ['GFR_300', 'GFR_600', 'GFR_1000'],
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 8_000,
      }, {
        id: 'GFR_X15',
        label: 'G-FR · 固定持有15秒',
        entryProfileIds: ['GFR_300', 'GFR_600', 'GFR_1000'],
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 15_000,
      }, {
        id: 'GFR_HS20_H30',
        label: 'G-FR · 硬止损20% / 最长30秒',
        entryProfileIds: ['GFR_300', 'GFR_600', 'GFR_1000'],
        exitMode: 'TAIL',
        hardStopPct: 20,
        trailingActivationPct: 1_000,
        trailingStopPct: 100,
        maxHoldMs: 30_000,
      }] : []),
      ...[
        ['G1_E2_H6', 2_000, 6],
        ['G1_E2_H8', 2_000, 8],
        ['G1_E3_H8', 3_000, 8],
      ].map(([id, lossCheckAtMs, hardStopPct]) => ({
        id,
        label: `${id} · F1早期弱势退出`,
        entryProfileIds: ['GE30_R23_F1'],
        exitMode: 'RISK_XLEG',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs,
        lossCheckRecoveryPct: 1,
        maxHoldMs: 15_000,
      })),
      ...[
        ['G1_B75_H30', 75, 30_000],
        ['G1_B50_H60', 50, 60_000],
      ].map(([id, coreWeightPct, runnerHoldMs]) => ({
        id,
        label: `${id} · F1核心XLEG + 尾仓`,
        entryProfileIds: ['GE30_R23_F1'],
        exitMode: 'BLEND_XLEG_RUNNER_RISK',
        coreWeightPct,
        runnerHoldMs,
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct: 15,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
      })),
      ...[
        ['G1_STAIR_H60', 60_000],
        ['G1_STAIR_H120', 120_000],
      ].map(([id, maxHoldMs]) => ({
        id,
        label: `${id} · F1分级移动止盈`,
        entryProfileIds: ['GE30_R23_F1'],
        exitMode: 'STAIR_TRAILING',
        hardStopPct: 15,
        maxHoldMs,
        trailingTiers: [
          { activationPct: 20, stopPct: 8 },
          { activationPct: 40, stopPct: 12 },
          { activationPct: 80, stopPct: 18 },
        ],
      })),
      {
        id: 'XB50',
        label: '50% XLEG core + 50% fixed-8s runner',
        entryProfileIds: ['GD25_35'],
        exitMode: 'BLEND_XLEG_X8',
        coreWeightPct: numberEnv('FLOW_MIGRATED_REBOUND_BLEND_50_CORE_WEIGHT_PCT', 50, {
          min: 0,
          max: 100,
        }),
        runnerHoldMs: integerEnv('FLOW_MIGRATED_REBOUND_BLEND_RUNNER_HOLD_MS', 8_000, {
          min: 250,
        }),
        trailingActivationPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_TRAILING_ACTIVATION_PCT', 8, { min: 0.1 },
        ),
        trailingStopPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_TRAILING_STOP_PCT', 3, { min: 0.1, max: 100 },
        ),
        fastTakeProfitPct: numberEnv('FLOW_MIGRATED_REBOUND_LEGACY_FAST_TP_PCT', 18, {
          min: 0,
        }),
        fastTakeProfitWindowMs: integerEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_FAST_TP_WINDOW_MS', 5_000, { min: 0 },
        ),
        lossCheckAtMs: integerEnv('FLOW_MIGRATED_REBOUND_LEGACY_LOSS_CHECK_MS', 6_000, {
          min: 0,
        }),
      },
      {
        id: 'XB25',
        label: '25% XLEG core + 75% fixed-8s runner',
        entryProfileIds: ['GD25_35'],
        exitMode: 'BLEND_XLEG_X8',
        coreWeightPct: numberEnv('FLOW_MIGRATED_REBOUND_BLEND_25_CORE_WEIGHT_PCT', 25, {
          min: 0,
          max: 100,
        }),
        runnerHoldMs: integerEnv('FLOW_MIGRATED_REBOUND_BLEND_RUNNER_HOLD_MS', 8_000, {
          min: 250,
        }),
        trailingActivationPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_TRAILING_ACTIVATION_PCT', 8, { min: 0.1 },
        ),
        trailingStopPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_TRAILING_STOP_PCT', 3, { min: 0.1, max: 100 },
        ),
        fastTakeProfitPct: numberEnv('FLOW_MIGRATED_REBOUND_LEGACY_FAST_TP_PCT', 18, {
          min: 0,
        }),
        fastTakeProfitWindowMs: integerEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_FAST_TP_WINDOW_MS', 5_000, { min: 0 },
        ),
        lossCheckAtMs: integerEnv('FLOW_MIGRATED_REBOUND_LEGACY_LOSS_CHECK_MS', 6_000, {
          min: 0,
        }),
      },
      ...[
        ['V2_R2_H10', 10],
        ['V2_R2_H15', 15],
      ].map(([id, fallbackHardStopPct]) => ({
        id,
        label: `${id} | 2秒弱势检查 / 硬止损${fallbackHardStopPct}%`,
        entryProfileIds: id === 'V2_R2_H15'
          ? ['GE30_D25_32_R24_F1', 'GE30_D25_32_R24_F1_EXEC1']
          : ['GE30_D25_32_R24_F1'],
        exitMode: 'RISK_XLEG',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct: numberEnv(
          `FLOW_MIGRATED_REBOUND_V2_HARD_STOP_${fallbackHardStopPct}_PCT`,
          fallbackHardStopPct,
          { min: 0.1, max: 100 },
        ),
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: integerEnv('FLOW_MIGRATED_REBOUND_V2_LOSS_CHECK_MS', 2_000, {
          min: 0,
        }),
        lossCheckRecoveryPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_V2_MAX_RECOVERY_FROM_LOW_PCT',
          1,
          { min: 0, max: 100 },
        ),
        maxHoldMs: 15_000,
      })),
      {
        id: 'V2_TIME_R2_H15',
        label: 'V2-TIME | 04:00–24:00 / 2秒弱势检查 / 硬止损15%',
        entryProfileIds: ['GE30_D25_32_R24_F1_04_24'],
        exitMode: 'RISK_XLEG',
        trailingActivationPct: 8,
        trailingStopPct: 3,
        hardStopPct: 15,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 2_000,
        lossCheckRecoveryPct: 1,
        maxHoldMs: 15_000,
      },
      ...[
        ['V2_B75_H20', 20_000],
        ['V2_B75_H60', 60_000],
      ].map(([id, fallbackRunnerHoldMs]) => ({
        id,
        label: `${id} | 25% XLEG core + 75% runner`,
        entryProfileIds: ['GE30_D25_32_R24_F1'],
        exitMode: 'BLEND_XLEG_RUNNER',
        coreWeightPct: 25,
        runnerHoldMs: integerEnv(
          `FLOW_MIGRATED_REBOUND_${id}_RUNNER_HOLD_MS`,
          fallbackRunnerHoldMs,
          { min: 250 },
        ),
        trailingActivationPct: 8,
        trailingStopPct: 3,
        fastTakeProfitPct: 18,
        fastTakeProfitWindowMs: 5_000,
        lossCheckAtMs: 6_000,
      })),
      ...[
        ['XR3_H12', 3_000, 12],
        ['XR3_H15', 3_000, 15],
        ['XR4_H12', 4_000, 12],
        ['XR4_H15', 4_000, 15],
      ].map(([id, fallbackLossCheckMs, fallbackHardStopPct]) => ({
        id,
        label: `${id} | early weak-state exit`,
        entryProfileIds: ['GD25_35'],
        exitMode: 'RISK_XLEG',
        trailingActivationPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_TRAILING_ACTIVATION_PCT', 8, { min: 0.1 },
        ),
        trailingStopPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_TRAILING_STOP_PCT', 3, { min: 0.1, max: 100 },
        ),
        hardStopPct: numberEnv(`FLOW_MIGRATED_REBOUND_RISK_HARD_STOP_${fallbackHardStopPct}_PCT`,
          fallbackHardStopPct, { min: 0.1, max: 100 }),
        fastTakeProfitPct: numberEnv('FLOW_MIGRATED_REBOUND_LEGACY_FAST_TP_PCT', 18, {
          min: 0,
        }),
        fastTakeProfitWindowMs: integerEnv(
          'FLOW_MIGRATED_REBOUND_LEGACY_FAST_TP_WINDOW_MS', 5_000, { min: 0 },
        ),
        lossCheckAtMs: integerEnv(
          `FLOW_MIGRATED_REBOUND_RISK_CHECK_${fallbackLossCheckMs / 1_000}S_MS`,
          fallbackLossCheckMs,
          { min: 0 },
        ),
        lossCheckRecoveryPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_RISK_MAX_RECOVERY_FROM_LOW_PCT', 1, { min: 0, max: 100 },
        ),
        maxHoldMs: integerEnv('FLOW_MIGRATED_REBOUND_LEGACY_MAX_HOLD_MS', 15_000, {
          min: 1_000,
        }),
      })),
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_MIGRATED_REBOUND_POSITION_SOL'),
    }),
  },

  // Independent post-migration continuation study. The entry thresholds were
  // selected from the chronological migration-cohort backtest; every exit is
  // stored as a separate cohort so long-hold winner capture stays auditable.
  migrationContinuityShadow: {
    enabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_MIGRATION_CONTINUITY_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_MIGRATION_CONTINUITY_POSITION_SOL'),
    confirmWindowMs: integerEnv('FLOW_MIGRATION_CONTINUITY_CONFIRM_MS', 5_000, {
      min: 1_000, max: 15_000,
    }),
    detectionDeadlineMs: integerEnv('FLOW_MIGRATION_CONTINUITY_DETECTION_MS', 10_000, {
      min: 5_000, max: 30_000,
    }),
    flowWindowMs: integerEnv('FLOW_MIGRATION_CONTINUITY_FLOW_WINDOW_MS', 3_000, {
      min: 1_000, max: 10_000,
    }),
    entryDelayMs: integerEnv('FLOW_MIGRATION_CONTINUITY_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_MIGRATION_CONTINUITY_ENTRY_TIMEOUT_MS', 2_000, {
      min: 1,
    }),
    exitDelayMs: integerEnv('FLOW_MIGRATION_CONTINUITY_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_MIGRATION_CONTINUITY_EXIT_TIMEOUT_MS', 5_000, {
      min: 1,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_MIGRATION_CONTINUITY_MAX_ENTRY_JUMP_PCT', 10, {
      min: 0, max: 100,
    }),
    entryProfile: {
      id: 'MC_C5',
      liveStrategyId: 'migration_continuity_mc_c5_t12_5_live',
      label: 'MC-C · 毕业后5秒质量延续',
      minBuyers: integerEnv('FLOW_MIGRATION_CONTINUITY_MIN_BUYERS', 20, { min: 1 }),
      minNetFlowSol: numberEnv('FLOW_MIGRATION_CONTINUITY_MIN_NET_FLOW_SOL', 5, { min: 0 }),
      minReturnPct: numberEnv('FLOW_MIGRATION_CONTINUITY_MIN_RETURN_PCT', 5, { min: -100 }),
      maxSellBuyRatio: numberEnv('FLOW_MIGRATION_CONTINUITY_MAX_SELL_BUY_RATIO', 0.6, {
        min: 0, max: 10,
      }),
    },
    exitProfiles: [
      {
        id: 'E60', label: '固定60秒', exitMode: 'FIXED_HOLD', fixedHoldMs: 60_000,
        hardStopPct: 20, maxHoldMs: 60_000, newEntriesEnabled: false,
      },
      {
        id: 'E120', label: '固定120秒', exitMode: 'FIXED_HOLD', fixedHoldMs: 120_000,
        hardStopPct: 20, maxHoldMs: 120_000, newEntriesEnabled: false,
      },
      {
        // New id creates a clean forward sample after Universal RUG Guard was
        // applied to every Shadow entry. Historical E120 rows remain unchanged.
        id: 'E120_GUARD_V2',
        label: '固定120秒 · Universal RUG Guard 前向样本',
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 120_000,
        hardStopPct: 20,
        maxHoldMs: 120_000,
        newEntriesEnabled: false,
      },
      {
        id: 'T10', label: '5秒保护 / +10%激活 / 回撤10%', exitMode: 'TRAILING',
        minHoldMs: 5_000, trailingActivationPct: 10, trailingStopPct: 10,
        hardStopPct: 20, maxHoldMs: 120_000, newEntriesEnabled: false,
      },
      {
        id: 'T12_5', label: '10秒保护 / +15%激活 / 回撤12.5%', exitMode: 'TRAILING',
        minHoldMs: 10_000, trailingActivationPct: 15, trailingStopPct: 12.5,
        hardStopPct: 20, maxHoldMs: 180_000, newEntriesEnabled: false,
      },
      {
        id: 'E120_CONVERGED_V3',
        label: '固定120秒 · 收敛前向样本',
        exitMode: 'FIXED_HOLD',
        fixedHoldMs: 120_000,
        hardStopPct: 20,
        maxHoldMs: 120_000,
        newEntriesEnabled: booleanEnv(
          'FLOW_MIGRATION_CONTINUITY_E120_CONVERGED_V3_ENABLED',
          true,
        ),
      },
      {
        id: 'FLOW', label: '10秒保护 / 3秒订单流转弱', exitMode: 'FLOW_FADE',
        minHoldMs: 10_000, minSellBuyRatio: 1.2, maxNetFlowSol: -2,
        hardStopPct: 20, maxHoldMs: 180_000, newEntriesEnabled: false,
      },
      {
        id: 'RUNNER', label: '15秒保护 / +20%激活 / 自适应尾仓',
        exitMode: 'ADAPTIVE_TRAILING', minHoldMs: 15_000, trailingActivationPct: 20,
        hardStopPct: 25, maxHoldMs: 300_000, newEntriesEnabled: false,
        trailingTiers: [
          { belowPct: 50, stopPct: 12.5 },
          { belowPct: 100, stopPct: 20 },
          { belowPct: Infinity, stopPct: 25 },
        ],
      },
      {
        id: 'AH60_180',
        label: 'MC-AH · 30秒订单流判定 / 弱60秒 / 强180秒',
        exitMode: 'ADAPTIVE_HORIZON',
        decisionAtMs: 30_000,
        weakHoldMs: 60_000,
        strongHoldMs: 180_000,
        minStrongNetFlowSol: 1,
        maxStrongSellBuyRatio: 0.8,
        minStrongBuyers: 3,
        hardStopPct: 20,
        maxHoldMs: 180_000,
        newEntriesEnabled: false,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_MIGRATION_CONTINUITY_POSITION_SOL'),
    }),
  },

  // Independent post-migration range-regime research. Every graduation receives
  // a short PumpSwap observation window; only qualified oscillating markets keep
  // the extended subscription. This suite never owns a signer or executor.
  rangeScalperShadow: {
    enabled: provenNegativeShadowsEnabled
      && booleanEnv('FLOW_RANGE_SCALPER_SHADOW_ENABLED', true),
    positionSizeSol: shadowPositionEnv('FLOW_RANGE_SCALPER_POSITION_SOL'),
    initialObservationMs: integerEnv('FLOW_RANGE_SCALPER_INITIAL_OBSERVATION_MS', 120_000, {
      min: 30_000,
      max: 10 * 60_000,
    }),
    maxTrackingMs: integerEnv('FLOW_RANGE_SCALPER_MAX_TRACKING_MS', 20 * 60_000, {
      min: 120_000,
      max: 60 * 60_000,
    }),
    windowMs: integerEnv('FLOW_RANGE_SCALPER_WINDOW_MS', 60_000, {
      min: 10_000,
      max: 5 * 60_000,
    }),
    recentFlowWindowMs: integerEnv('FLOW_RANGE_SCALPER_RECENT_FLOW_MS', 1_000, {
      min: 250,
      max: 10_000,
    }),
    rangeLossConfirmMs: integerEnv('FLOW_RANGE_SCALPER_RANGE_LOSS_CONFIRM_MS', 30_000, {
      min: 1_000,
      max: 5 * 60_000,
    }),
    unsubscribeGraceMs: integerEnv('FLOW_RANGE_SCALPER_UNSUBSCRIBE_GRACE_MS', 5_000, {
      min: 0,
      max: 60_000,
    }),
    minTrades: integerEnv('FLOW_RANGE_SCALPER_MIN_TRADES', 60, { min: 5 }),
    minVolumeSol: numberEnv('FLOW_RANGE_SCALPER_MIN_VOLUME_SOL', 20, { min: 0 }),
    minUniqueWallets: integerEnv('FLOW_RANGE_SCALPER_MIN_UNIQUE_WALLETS', 20, { min: 2 }),
    minBuySharePct: numberEnv('FLOW_RANGE_SCALPER_MIN_BUY_SHARE_PCT', 35, {
      min: 0, max: 100,
    }),
    maxBuySharePct: numberEnv('FLOW_RANGE_SCALPER_MAX_BUY_SHARE_PCT', 65, {
      min: 0, max: 100,
    }),
    minRangePct: numberEnv('FLOW_RANGE_SCALPER_MIN_RANGE_PCT', 12, { min: 0.1 }),
    maxEfficiencyRatio: numberEnv('FLOW_RANGE_SCALPER_MAX_EFFICIENCY_RATIO', 0.35, {
      min: 0.01, max: 1,
    }),
    minMeanCrosses: integerEnv('FLOW_RANGE_SCALPER_MIN_MEAN_CROSSES', 4, { min: 1 }),
    maxTopWalletSharePct: numberEnv('FLOW_RANGE_SCALPER_MAX_TOP_WALLET_SHARE_PCT', 25, {
      min: 0.1, max: 100,
    }),
    maxTrendPct: numberEnv('FLOW_RANGE_SCALPER_MAX_TREND_PCT', 12, { min: 0.1 }),
    minRangeScore: numberEnv('FLOW_RANGE_SCALPER_MIN_RANGE_SCORE', 65, {
      min: 0, max: 100,
    }),
    entryDelayMs: integerEnv('FLOW_RANGE_SCALPER_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_RANGE_SCALPER_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_RANGE_SCALPER_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_RANGE_SCALPER_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_RANGE_SCALPER_MAX_ENTRY_JUMP_PCT', 3, {
      min: 0, max: 100,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_RANGE_SCALPER_MAX_ENTRY_DROP_PCT', 50, {
      min: 0, max: 100,
    }),
    maxObservedPriceScaleRatio: numberEnv(
      'FLOW_RANGE_SCALPER_MAX_PRICE_SCALE_RATIO',
      100,
      { min: 2, max: 1_000_000 },
    ),
    entryProfiles: [
      {
        id: 'JA',
        label: 'JA · 1σ 偏离 + 2% 反弹',
        deviationSigma: 1,
        reboundPct: 2,
        reboundTimeoutMs: 5_000,
      },
      {
        id: 'JB',
        label: 'JB · 1.5σ 偏离 + 正净流入',
        deviationSigma: 1.5,
        reboundPct: 2,
        reboundTimeoutMs: 5_000,
        minRecentNetFlowSol: 0.1,
      },
      {
        id: 'JC',
        label: 'JC · 下轨反弹 + 卖压衰减',
        deviationSigma: 1,
        reboundPct: 2,
        reboundTimeoutMs: 5_000,
        minRecentBuyers: 2,
        maxSellDecayRatio: 0.5,
      },
      {
        id: 'JW',
        label: 'JW · JB条件预热后仅交易第2/3波',
        warmupProfileId: 'JB',
        deviationSigma: 1.5,
        reboundPct: 2,
        reboundTimeoutMs: 5_000,
        minRecentNetFlowSol: 0.1,
        minOpportunityIndex: 2,
        maxOpportunityIndex: 3,
        exitProfileIds: ['X6'],
      },
    ],
    exitProfiles: [
      {
        id: 'XM', label: 'XM · 回归中轴', exitMode: 'MIDLINE',
        hardStopPct: 8, maxHoldMs: 20_000,
      },
      {
        id: 'X6', label: 'X6 · 固定 +6%', exitMode: 'TAKE_PROFIT',
        takeProfitPct: 6, hardStopPct: 8, maxHoldMs: 20_000,
      },
      {
        id: 'XB', label: 'XB · 上轨退出', exitMode: 'UPPER_BAND',
        hardStopPct: 8, maxHoldMs: 30_000,
      },
      {
        id: 'XF', label: 'XF · 中轴且资金反转', exitMode: 'FLOW_REVERSAL',
        hardStopPct: 8, maxHoldMs: 30_000,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_RANGE_SCALPER_POSITION_SOL'),
    }),
  },

  // Independent observed-holder-growth research. "Holders" here means wallets
  // seen buying through the captured Pump curve stream; it is deliberately not
  // presented as an authoritative on-chain holder count.
  holderGrowthShadow: {
    enabled: booleanEnv('FLOW_HOLDER_GROWTH_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_HOLDER_GROWTH_POSITION_SOL'),
    snapshotHorizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
      min: 5_000,
      max: 60_000,
    }),
    maxSnapshotLagMs: integerEnv('FLOW_HOLDER_GROWTH_MAX_SNAPSHOT_LAG_MS', 2_000, {
      min: 0,
      max: 30_000,
    }),
    entryDelayMs: integerEnv('FLOW_HOLDER_GROWTH_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_HOLDER_GROWTH_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_HOLDER_GROWTH_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_HOLDER_GROWTH_EXIT_TIMEOUT_MS', 30_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_HOLDER_GROWTH_MAX_ENTRY_JUMP_PCT', 100, {
      min: 0,
      max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_HOLDER_GROWTH_MAX_ENTRY_DROP_PCT', 99, {
      min: 0,
      max: 100,
    }),
    maxPlausibleReturnPct: numberEnv(
      'FLOW_HOLDER_GROWTH_MAX_PLAUSIBLE_RETURN_PCT',
      500,
      { min: 10, max: 100_000 },
    ),
    bigWinnerPct: numberEnv('FLOW_HOLDER_GROWTH_BIG_WINNER_PCT', 50, { min: 1 }),
    entryProfiles: [
      {
        id: 'HG10_OPEN',
        label: 'HG10 Open · 10秒早期宽松组',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_OPEN_HORIZON_MS', 10_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 5,
        minNewBuyers: 3,
        minRetentionPct: 30,
        minNetFlowSol: 1.5,
        maxTop3SharePct: 90,
      },
      {
        id: 'HG10_FLOW10_J2',
        label: 'N Flow Edge 10s · NetFlow>=10 · entry jump 0-2%',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_OPEN_HORIZON_MS', 10_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 5,
        minNewBuyers: 3,
        minRetentionPct: 30,
        minNetFlowSol: 10,
        maxTop3SharePct: 90,
        minEntryJumpPct: 0,
        maxEntryJumpPct: 2,
      },
      {
        id: 'HG10_FLOW15_J2',
        label: 'N Flow Edge 10s · NetFlow>=15 · entry jump 0-2%',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_OPEN_HORIZON_MS', 10_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 5,
        minNewBuyers: 3,
        minRetentionPct: 30,
        minNetFlowSol: 15,
        maxTop3SharePct: 90,
        minEntryJumpPct: 0,
        maxEntryJumpPct: 2,
      },
      {
        id: 'HG20_BAL',
        label: 'HG20 Balanced · 20秒早期均衡组',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_EARLY_HORIZON_MS', 20_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 8,
        minNewBuyers: 5,
        minRetentionPct: 40,
        minNetFlowSol: 3,
        maxTop3SharePct: 85,
      },
      {
        id: 'HG20_FAST',
        label: 'HG20 Fast · 20秒早期加速组',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_EARLY_HORIZON_MS', 20_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 10,
        minNewBuyers: 8,
        minRetentionPct: 50,
        minNetFlowSol: 5,
        maxTop3SharePct: 80,
      },
      {
        id: 'HG20_QUALITY_J2',
        label: 'N Quality 20s · Buyers>=40 · retention>=60% · entry jump 0-2%',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_EARLY_HORIZON_MS', 20_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 40,
        minNewBuyers: 5,
        minRetentionPct: 60,
        minNetFlowSol: 5,
        maxTop3SharePct: 80,
        minEntryJumpPct: 0,
        maxEntryJumpPct: 2,
      },
      {
        id: 'HG30_BAL',
        label: 'HG30 Balanced · 新增买家≥1/s + 留存≥50%',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 10,
        minNewBuyers: 10,
        minRetentionPct: 50,
        minNetFlowSol: 5,
        maxTop3SharePct: 80,
        exitProfileIds: holderGrowthFullMatrixEnabled ? null : ['X15_FIXED'],
      },
      {
        id: 'HG30_FAST',
        label: 'HG30 Fast · 新增买家≥2/s + 留存≥70%',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 10,
        minNewBuyers: 20,
        minRetentionPct: 70,
        minNetFlowSol: 10,
        maxTop3SharePct: 80,
      },
      {
        id: 'HG30_NB20_NF25',
        label: 'HG30 Strong A · 新增买家≥20 + NetFlow≥25',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 10,
        minNewBuyers: 20,
        minRetentionPct: 50,
        minNetFlowSol: 25,
        maxTop3SharePct: 80,
        exitProfileIds: holderGrowthFullMatrixEnabled
          ? null : ['X12_FIXED', 'X15_FIXED', 'X18_FIXED', 'X15_R20'],
      },
      {
        id: 'HG30_RB15_NF25',
        label: 'HG30 Strong B · 近窗买家≥15 + NetFlow≥25',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 10,
        minNewBuyers: 10,
        minRecentBuyers: 15,
        minRetentionPct: 50,
        minNetFlowSol: 25,
        maxTop3SharePct: 80,
        exitProfileIds: holderGrowthFullMatrixEnabled
          ? null : ['X12_FIXED', 'X15_FIXED', 'X18_FIXED', 'X15_R20'],
      },
      {
        id: 'HG30_B80_NF25',
        label: 'HG30 Strong C · Buyers≥80 + NetFlow≥25',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 80,
        minNewBuyers: 10,
        minRetentionPct: 50,
        minNetFlowSol: 25,
        maxTop3SharePct: 80,
        exitProfileIds: holderGrowthFullMatrixEnabled
          ? null : ['X12_FIXED', 'X15_FIXED', 'X18_FIXED', 'X15_R20'],
      },
      {
        id: 'HG30_NQ_A_R75_C40_75',
        label: 'HG30 NQ-A · Retention>=75% · Curve 40-75%',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 10,
        minNewBuyers: 10,
        minRetentionPct: 75,
        minNetFlowSol: 5,
        maxTop3SharePct: 80,
        minCurvePct: 40,
        maxCurvePct: 75,
        exitProfileIds: ['X15_FIXED'],
      },
      {
        id: 'HG30_NQ_B_R80_C45_70',
        label: 'HG30 NQ-B · Retention>=80% · Curve 45-70%',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 10,
        minNewBuyers: 10,
        minRetentionPct: 80,
        minNetFlowSol: 5,
        maxTop3SharePct: 80,
        minCurvePct: 45,
        maxCurvePct: 70,
        exitProfileIds: ['X15_FIXED'],
      },
      {
        id: 'HG30_NQ_C_POST_PEAK',
        label: 'HG30 NQ-C · NQ-A + post-peak net buying',
        horizonMs: integerEnv('FLOW_HOLDER_GROWTH_SNAPSHOT_MS', 30_000, {
          min: 5_000, max: 60_000,
        }),
        minBuyers: 10,
        minNewBuyers: 10,
        minRetentionPct: 75,
        minNetFlowSol: 5,
        maxTop3SharePct: 80,
        minCurvePct: 40,
        maxCurvePct: 75,
        requirePostPeakNetPositive: true,
        exitProfileIds: ['X12_FIXED', 'X15_FIXED', 'X18_FIXED'],
      },
    ].filter((profile) => holderGrowthFullMatrixEnabled
      || profile.id === 'HG30_BAL'
      || (holderGrowthQualityEnabled && [
        'HG30_NQ_A_R75_C40_75',
        'HG30_NQ_B_R80_C45_70',
        'HG30_NQ_C_POST_PEAK',
      ].includes(profile.id))),
    // Every exit is crossed with every entry as an independent cohort. Keep
    // XT15_H120 unchanged so existing production rows remain comparable.
    exitProfiles: [
      {
        id: 'X5_FIXED', label: '固定5秒', exitMode: 'FIXED_HOLD',
        fixedHoldMs: 5_000, hardStopPct: 100, maxHoldMs: 5_000,
      },
      {
        id: 'X15_FIXED', label: '固定15秒', exitMode: 'FIXED_HOLD',
        fixedHoldMs: 15_000, hardStopPct: 100, maxHoldMs: 15_000,
      },
      {
        id: 'X12_FIXED', label: '固定12秒', exitMode: 'FIXED_HOLD',
        fixedHoldMs: 12_000, hardStopPct: 100, maxHoldMs: 12_000,
      },
      {
        id: 'X18_FIXED', label: '固定18秒', exitMode: 'FIXED_HOLD',
        fixedHoldMs: 18_000, hardStopPct: 100, maxHoldMs: 18_000,
      },
      {
        id: 'X15_R20',
        label: '15秒强势减仓80% / 20%尾仓',
        exitMode: 'FIXED_SCALE_RUNNER',
        fixedHoldMs: 15_000,
        hardStopPct: 100,
        scaleOutTriggerPct: 20,
        scaleOutFractionPct: 80,
        trailingActivationPct: 20,
        trailingStopPct: 15,
        maxHoldMs: 120_000,
      },
      {
        id: 'XT15_H120',
        label: '+15%激活 / 峰值回撤15% / 硬止损20% / 120秒兜底',
        exitMode: 'TRAILING',
        hardStopPct: numberEnv('FLOW_HOLDER_GROWTH_HARD_STOP_PCT', 20, {
          min: 0.1,
          max: 100,
        }),
        trailingActivationPct: numberEnv(
          'FLOW_HOLDER_GROWTH_TRAILING_ACTIVATION_PCT',
          15,
          { min: 0.1, max: 1_000 },
        ),
        trailingStopPct: numberEnv('FLOW_HOLDER_GROWTH_TRAILING_STOP_PCT', 15, {
          min: 0.1,
          max: 100,
        }),
        maxHoldMs: integerEnv('FLOW_HOLDER_GROWTH_MAX_HOLD_MS', 120_000, {
          min: 1_000,
          max: 10 * 60_000,
        }),
      },
      {
        id: 'XT20_D10_H180', label: '+20%激活 / 回撤10% / 180秒兜底',
        exitMode: 'TRAILING', hardStopPct: 20,
        trailingActivationPct: 20, trailingStopPct: 10, maxHoldMs: 180_000,
      },
      {
        id: 'XT30_D15_H300', label: '+30%激活 / 回撤15% / 300秒兜底',
        exitMode: 'TRAILING', hardStopPct: 20,
        trailingActivationPct: 30, trailingStopPct: 15, maxHoldMs: 300_000,
      },
      {
        id: 'XSCALE_50_RUNNER', label: '+30%减仓50% / 尾仓回撤20%',
        exitMode: 'SCALE_RUNNER', hardStopPct: 20,
        scaleOutTriggerPct: 30, scaleOutFractionPct: 50,
        trailingActivationPct: 30, trailingStopPct: 20, maxHoldMs: 300_000,
      },
      {
        id: 'XP20_50_D15_H120',
        label: '+20%减仓50% / 尾仓回撤15% / 120秒兜底',
        exitMode: 'SCALE_RUNNER', hardStopPct: 20,
        scaleOutTriggerPct: 20, scaleOutFractionPct: 50,
        trailingActivationPct: 20, trailingStopPct: 15, maxHoldMs: 120_000,
      },
      {
        id: 'XP20_70_D20_H180',
        label: '+20%减仓70% / 尾仓回撤20% / 180秒兜底',
        exitMode: 'SCALE_RUNNER', hardStopPct: 20,
        scaleOutTriggerPct: 20, scaleOutFractionPct: 70,
        trailingActivationPct: 20, trailingStopPct: 20, maxHoldMs: 180_000,
      },
      {
        id: 'XP30_70_STAIR',
        label: '+30%减仓70% / 尾仓阶梯回撤',
        exitMode: 'SCALE_ADAPTIVE', hardStopPct: 20,
        scaleOutTriggerPct: 30, scaleOutFractionPct: 70, maxHoldMs: 300_000,
        trailingTiers: [
          { activationPct: 30, drawdownPct: 15 },
          { activationPct: 60, drawdownPct: 15 },
          { activationPct: 100, drawdownPct: 20 },
          { activationPct: 200, drawdownPct: 25 },
        ],
      },
      {
        id: 'XFLOW_60', label: '60秒Holder/资金流转弱退出',
        exitMode: 'FLOW_CHECK', hardStopPct: 20,
        flowCheckHorizonMs: 60_000, minBuyerVelocityRatio: 0.5,
        minNetFlowDeltaSol: 0, trailingActivationPct: 20,
        trailingStopPct: 15, maxHoldMs: 180_000,
      },
      {
        id: 'XSTAIR_BAL', label: '阶梯均衡 20/40/80/150/300',
        exitMode: 'ADAPTIVE_TRAILING', hardStopPct: 20, maxHoldMs: 360_000,
        trailingTiers: [
          { activationPct: 20, drawdownPct: 10 },
          { activationPct: 40, drawdownPct: 15 },
          { activationPct: 80, drawdownPct: 20 },
          { activationPct: 150, drawdownPct: 25 },
          { activationPct: 300, drawdownPct: 30 },
        ],
      },
      {
        id: 'XSTAIR_LOCK', label: '阶梯保守 15/30/60/120',
        exitMode: 'ADAPTIVE_TRAILING', hardStopPct: 20, maxHoldMs: 300_000,
        trailingTiers: [
          { activationPct: 15, drawdownPct: 7.5 },
          { activationPct: 30, drawdownPct: 10 },
          { activationPct: 60, drawdownPct: 15 },
          { activationPct: 120, drawdownPct: 20 },
        ],
      },
      {
        id: 'XSTAIR_TAIL', label: '阶梯尾仓 20/50/100/200',
        exitMode: 'ADAPTIVE_TRAILING', hardStopPct: 20, maxHoldMs: 360_000,
        trailingTiers: [
          { activationPct: 20, drawdownPct: 12.5 },
          { activationPct: 50, drawdownPct: 20 },
          { activationPct: 100, drawdownPct: 25 },
          { activationPct: 200, drawdownPct: 30 },
        ],
      },
    ].filter((profile) => holderGrowthFullMatrixEnabled
      || profile.id === 'X15_FIXED'
      || (holderGrowthQualityEnabled
        && ['X12_FIXED', 'X18_FIXED'].includes(profile.id))),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_HOLDER_GROWTH_POSITION_SOL'),
    }),
  },

  // Independent two-stage Quality Leader research. It consumes existing 10s/20s
  // Launch Quality snapshots and therefore adds no RPC or gRPC subscriptions.
  qualityLeaderShadow: {
    enabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_QUALITY_LEADER_SHADOW_ENABLED', false),
    positionSizeSol: shadowPositionEnv('FLOW_QUALITY_LEADER_POSITION_SOL'),
    snapshot10Ms: 10_000,
    snapshot20Ms: 20_000,
    maxSnapshotLagMs: integerEnv('FLOW_QUALITY_LEADER_MAX_SNAPSHOT_LAG_MS', 2_000, {
      min: 0, max: 30_000,
    }),
    entryDelayMs: integerEnv('FLOW_QUALITY_LEADER_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_QUALITY_LEADER_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_QUALITY_LEADER_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_QUALITY_LEADER_EXIT_TIMEOUT_MS', 30_000, { min: 1 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_QUALITY_LEADER_MAX_ENTRY_JUMP_PCT', 20, {
      min: 0, max: 1_000,
    }),
    maxEntryPriceDropPct: numberEnv('FLOW_QUALITY_LEADER_MAX_ENTRY_DROP_PCT', 20, {
      min: 0, max: 100,
    }),
    hardStopPct: numberEnv('FLOW_QUALITY_LEADER_HARD_STOP_PCT', 20, {
      min: 0.1, max: 100,
    }),
    strengthActivationPct: numberEnv('FLOW_QUALITY_LEADER_STRENGTH_PCT', 20, {
      min: 0.1, max: 1_000,
    }),
    noStrengthMs: integerEnv('FLOW_QUALITY_LEADER_NO_STRENGTH_MS', 30_000, {
      min: 1_000, max: 5 * 60_000,
    }),
    maxHoldMs: integerEnv('FLOW_QUALITY_LEADER_MAX_HOLD_MS', 5 * 60_000, {
      min: 10_000, max: 30 * 60_000,
    }),
    maxPlausibleReturnPct: numberEnv('FLOW_QUALITY_LEADER_MAX_PLAUSIBLE_RETURN_PCT', 5_000, {
      min: 100, max: 100_000,
    }),
    bigWinnerPct: numberEnv('FLOW_QUALITY_LEADER_BIG_WINNER_PCT', 100, { min: 1 }),
    entryProfiles: [
      {
        id: 'QL_STRICT',
        label: 'QL-A/B Strict · Retention≥80%',
        minReturn10Pct: 140,
        maxDrawdown20Pct: 12,
        minBuyerDelta: 8,
        minNetFlowDeltaSol: 3,
        minRetentionPct: 80,
        maxCreatorSharePct: 3,
        minCurvePct: 55,
        maxCurvePct: 90,
        maxSellBuyRatio: 0.55,
        minVirtualSolReserves: 30,
        exitProfileIds: ['QL_BARBELL', 'QL_PROTECTED'],
      },
      {
        id: 'QL_BROAD',
        label: 'QL-C Broad · Retention≥60%',
        minReturn10Pct: 140,
        maxDrawdown20Pct: 12,
        minBuyerDelta: 8,
        minNetFlowDeltaSol: 3,
        minRetentionPct: 60,
        maxCreatorSharePct: 3,
        minCurvePct: 55,
        maxCurvePct: 90,
        maxSellBuyRatio: 0.55,
        minVirtualSolReserves: 30,
        exitProfileIds: ['QL_BARBELL'],
      },
      {
        id: 'QL_STRICT_GUARD',
        liveStrategyId: 'quality_leader_ql_strict_guard_protected_live',
        label: 'QL-GUARD · Strict + 公共订单流RUG过滤',
        minReturn10Pct: 140,
        maxDrawdown20Pct: 12,
        minBuyerDelta: 8,
        minNetFlowDeltaSol: 3,
        minRetentionPct: 80,
        maxCreatorSharePct: 3,
        minCurvePct: 55,
        maxCurvePct: 90,
        maxSellBuyRatio: 0.55,
        minVirtualSolReserves: 30,
        requireHealthyRugRisk: true,
        exitProfileIds: ['QL_BARBELL', 'QL_PROTECTED'],
      },
      {
        id: 'QL_STRICT_GUARD_T00_04',
        label: 'QL-GUARD-T00-04 · Strict/RUG过滤/北京00–04时',
        minReturn10Pct: 140,
        maxDrawdown20Pct: 12,
        minBuyerDelta: 8,
        minNetFlowDeltaSol: 3,
        minRetentionPct: 80,
        maxCreatorSharePct: 3,
        minCurvePct: 55,
        maxCurvePct: 90,
        maxSellBuyRatio: 0.55,
        minVirtualSolReserves: 30,
        requireHealthyRugRisk: true,
        beijingHourRanges: [[0, 4]],
        exitProfileIds: ['QL_BARBELL', 'QL_PROTECTED'],
      },
      {
        id: 'QL_STRICT_GUARD_T16_20',
        label: 'QL-GUARD-T16-20 · Strict/RUG过滤/北京16–20时',
        minReturn10Pct: 140,
        maxDrawdown20Pct: 12,
        minBuyerDelta: 8,
        minNetFlowDeltaSol: 3,
        minRetentionPct: 80,
        maxCreatorSharePct: 3,
        minCurvePct: 55,
        maxCurvePct: 90,
        maxSellBuyRatio: 0.55,
        minVirtualSolReserves: 30,
        requireHealthyRugRisk: true,
        beijingHourRanges: [[16, 20]],
        exitProfileIds: ['QL_BARBELL', 'QL_PROTECTED'],
      },
    ],
    exitProfiles: [
      {
        id: 'QL_BARBELL',
        label: 'Barbell · +20%卖33% / +100%卖17% / 50%保护尾仓',
        mode: 'BARBELL',
        scale1TriggerPct: 20,
        scale1FractionPct: 33,
        scale2TriggerPct: 100,
        scale2FractionPct: 17,
      },
      {
        id: 'QL_PROTECTED',
        label: 'Protected Runner · 不分批 / 阶梯保护尾仓',
        mode: 'PROTECTED_RUNNER',
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_QUALITY_LEADER_POSITION_SOL'),
    }),
  },

  // Feature Effectiveness Audit Observer. This forward-only audit measures
  // whether each existing signal family adds predictive value after a real
  // 1 SOL reserve-impact model. FEA-BNH-120 is an isolated Shadow cohort;
  // neither path signs or sends a transaction.
  featureEdgeAudit: {
    enabled: booleanEnv('FLOW_FEATURE_EDGE_AUDIT_ENABLED', true),
    canonicalSignalSource: process.env.FLOW_FEATURE_EDGE_AUDIT_CANONICAL_SOURCE
      || 'FLOW_ACCEL_SIGNAL',
    positionSol: numberEnv('FLOW_FEATURE_EDGE_AUDIT_POSITION_SOL', 1, { min: 0.01, max: 100 }),
    sampleCooldownMs: integerEnv(
      'FLOW_FEATURE_EDGE_AUDIT_SAMPLE_COOLDOWN_MS',
      30_000,
      { min: 1_000, max: 30 * 60_000 },
    ),
    maxPending: integerEnv('FLOW_FEATURE_EDGE_AUDIT_MAX_PENDING', 3_000, {
      min: 100, max: 20_000,
    }),
    maxObservationLagMs: integerEnv(
      'FLOW_FEATURE_EDGE_AUDIT_MAX_OBSERVATION_LAG_MS',
      3_000,
      { min: 250, max: 30_000 },
    ),
    stateRetentionMs: integerEnv(
      'FLOW_FEATURE_EDGE_AUDIT_STATE_RETENTION_MS',
      360_000,
      { min: 310_000, max: 30 * 60_000 },
    ),
    minNetFlowSol: numberEnv('FLOW_FEATURE_EDGE_AUDIT_MIN_NETFLOW_SOL', 10, {
      min: 0, max: 10_000,
    }),
    minFlowAccelerationSol: numberEnv(
      'FLOW_FEATURE_EDGE_AUDIT_MIN_FLOW_ACCELERATION_SOL',
      2,
      { min: 0, max: 10_000 },
    ),
    minBuyers: integerEnv('FLOW_FEATURE_EDGE_AUDIT_MIN_BUYERS', 7, { min: 1, max: 10_000 }),
    minBuySharePct: numberEnv('FLOW_FEATURE_EDGE_AUDIT_MIN_BUY_SHARE_PCT', 70, {
      min: 0, max: 100,
    }),
    maxEntryImpactPct: numberEnv('FLOW_FEATURE_EDGE_AUDIT_MAX_ENTRY_IMPACT_PCT', 15, {
      min: 0, max: 1_000,
    }),
    minCurvePct: numberEnv('FLOW_FEATURE_EDGE_AUDIT_MIN_CURVE_PCT', 60, {
      min: 0, max: 100,
    }),
    maxCurvePct: numberEnv('FLOW_FEATURE_EDGE_AUDIT_MAX_CURVE_PCT', 95, {
      min: 0, max: 100,
    }),
    minAgeMs: integerEnv('FLOW_FEATURE_EDGE_AUDIT_MIN_AGE_MS', 5_000, {
      min: 0, max: 60 * 60_000,
    }),
    maxAgeMs: integerEnv('FLOW_FEATURE_EDGE_AUDIT_MAX_AGE_MS', 300_000, {
      min: 1_000, max: 24 * 60 * 60_000,
    }),
    bnhEnabled: booleanEnv('FLOW_FEATURE_EDGE_AUDIT_BNH_ENABLED', true),
    bnhMinAgeMs: integerEnv('FLOW_FEATURE_EDGE_AUDIT_BNH_MIN_AGE_MS', 30_000, {
      min: 0, max: 60 * 60_000,
    }),
    bnhMaxAgeMs: integerEnv('FLOW_FEATURE_EDGE_AUDIT_BNH_MAX_AGE_MS', 120_000, {
      min: 1_000, max: 24 * 60 * 60_000,
    }),
    bnhMinCurvePct: numberEnv('FLOW_FEATURE_EDGE_AUDIT_BNH_MIN_CURVE_PCT', 60, {
      min: 0, max: 100,
    }),
    bnhMaxCurvePct: numberEnv('FLOW_FEATURE_EDGE_AUDIT_BNH_MAX_CURVE_PCT', 90, {
      min: 0, max: 100,
    }),
    bnhHoldMs: integerEnv('FLOW_FEATURE_EDGE_AUDIT_BNH_HOLD_MS', 120_000, {
      min: 5_000, max: 60 * 60_000,
    }),
    bnhRoundTripCostPct: numberEnv(
      'FLOW_FEATURE_EDGE_AUDIT_BNH_ROUND_TRIP_COST_PCT',
      3.2,
      { min: 0, max: 100 },
    ),
  },

  // Post-migration Survivor Observer (PM-SURV). Every migrated mint receives
  // a bounded five-minute baseline. Only liquid, active survivors continue to
  // 30/60 minutes; a deterministic holdout estimates big-winner false negatives.
  // Passing 5m also opens isolated capacity-aware 30/60/120s Shadow rows. It
  // never opens a live position, calls extra RPC endpoints, or signs.
  postMigrationSurvivorObserver: {
    enabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_POST_MIGRATION_SURVIVOR_ENABLED', false),
    newEntriesEnabled: booleanEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_NEW_ENTRIES_ENABLED', false,
    ),
    positionSol: numberEnv('FLOW_POST_MIGRATION_SURVIVOR_POSITION_SOL', 1, {
      min: 0.01, max: 100,
    }),
    baselineStageMs: integerEnv('FLOW_POST_MIGRATION_SURVIVOR_BASELINE_MS', 5 * 60_000, {
      min: 60_000, max: 30 * 60_000,
    }),
    extendedStageMs: integerEnv('FLOW_POST_MIGRATION_SURVIVOR_EXTENDED_MS', 30 * 60_000, {
      min: 5 * 60_000, max: 60 * 60_000,
    }),
    maxAgeMs: integerEnv('FLOW_POST_MIGRATION_SURVIVOR_MAX_AGE_MS', 60 * 60_000, {
      min: 30 * 60_000, max: 2 * 60 * 60_000,
    }),
    inactivityMs: integerEnv('FLOW_POST_MIGRATION_SURVIVOR_INACTIVITY_MS', 180_000, {
      min: 30_000, max: 30 * 60_000,
    }),
    maxActive: integerEnv('FLOW_POST_MIGRATION_SURVIVOR_MAX_ACTIVE', 3_000, {
      min: 100, max: 20_000,
    }),
    maxThirtyMinuteSurvivors: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_MAX_30M', 500, { min: 10, max: 10_000 },
    ),
    maxSixtyMinuteSurvivors: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_MAX_60M', 100, { min: 5, max: 5_000 },
    ),
    holdoutPct: numberEnv('FLOW_POST_MIGRATION_SURVIVOR_HOLDOUT_PCT', 10, {
      min: 0, max: 100,
    }),
    softFailConfirmations: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_SOFT_FAIL_CONFIRMATIONS', 2, { min: 1, max: 10 },
    ),
    softFailConfirmationMs: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_SOFT_FAIL_CONFIRMATION_MS', 30_000,
      { min: 1_000, max: 10 * 60_000 },
    ),
    riskCheckIntervalMs: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_RISK_CHECK_INTERVAL_MS', 2_000,
      { min: 500, max: 60_000 },
    ),
    hardPriceRetentionPct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_HARD_PRICE_RETENTION_PCT', 15, { min: 0, max: 100 },
    ),
    hardExecutableRecoveryPct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_HARD_RECOVERY_PCT', 15, { min: 0, max: 100 },
    ),
    stage5MinPeakRetentionPct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_5M_MIN_PEAK_RETENTION_PCT', 30,
      { min: 0, max: 100 },
    ),
    stage5MinTrades60s: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_5M_MIN_TRADES_60S', 8, { min: 0, max: 100_000 },
    ),
    stage5MinBuyers60s: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_5M_MIN_BUYERS_60S', 3, { min: 0, max: 100_000 },
    ),
    stage5MinBuyTx60s: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_5M_MIN_BUYS_60S', 2, { min: 0, max: 100_000 },
    ),
    stage5MinSellTx60s: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_5M_MIN_SELLS_60S', 1, { min: 0, max: 100_000 },
    ),
    stage5MinExecutableRecoveryPct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_5M_MIN_RECOVERY_PCT', 25, { min: 0, max: 100 },
    ),
    stage30MinBaselineReturnPct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_30M_MIN_RETURN_PCT', -10, { min: -100, max: 10_000 },
    ),
    stage30MinPeakRetentionPct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_30M_MIN_PEAK_RETENTION_PCT', 45,
      { min: 0, max: 100 },
    ),
    stage30MinTrades300s: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_30M_MIN_TRADES_300S', 12,
      { min: 0, max: 100_000 },
    ),
    stage30MinBuyers300s: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_30M_MIN_BUYERS_300S', 5,
      { min: 0, max: 100_000 },
    ),
    stage30MinNetFlowSol: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_30M_MIN_NETFLOW_SOL', 0,
      { min: -100_000, max: 100_000 },
    ),
    stage30MinExecutableRecoveryPct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_30M_MIN_RECOVERY_PCT', 50, { min: 0, max: 100 },
    ),
    maxEventsPerMint: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_MAX_EVENTS_PER_MINT', 512,
      { min: 64, max: 10_000 },
    ),
    dashboardLimit: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_DASHBOARD_LIMIT', 2_000,
      { min: 100, max: 10_000 },
    ),
    transientUpPriceRatio: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_TRANSIENT_UP_PRICE_RATIO', 20,
      { min: 2, max: 1_000_000 },
    ),
    priceConfirmationWindowMs: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_PRICE_CONFIRMATION_WINDOW_MS', 500,
      { min: 100, max: 60_000 },
    ),
    priceConfirmationMinPersistenceMs: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_PRICE_CONFIRMATION_MIN_PERSISTENCE_MS', 150,
      { min: 0, max: 60_000 },
    ),
    priceConfirmationTolerancePct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_PRICE_CONFIRMATION_TOLERANCE_PCT', 25,
      { min: 1, max: 100 },
    ),
    priceConfirmationMinWallets: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_PRICE_CONFIRMATION_MIN_WALLETS', 2,
      { min: 1, max: 100 },
    ),
    shadowEnabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_POST_MIGRATION_SURVIVOR_SHADOW_ENABLED', false),
    shadowFullHoldMatrixEnabled: booleanEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_FULL_HOLD_MATRIX_ENABLED', false,
    ),
    shadowHoldMs: booleanEnv('FLOW_POST_MIGRATION_SURVIVOR_FULL_HOLD_MATRIX_ENABLED', false)
      ? millisecondListEnv(
        'FLOW_POST_MIGRATION_SURVIVOR_SHADOW_HOLDS_SECONDS', [30, 60, 120],
      )
      : [30_000],
    shadowRoundTripCostPct: numberEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_SHADOW_ROUND_TRIP_COST_PCT', 3.2,
      { min: 0, max: 100 },
    ),
    shadowNoExitGraceMs: integerEnv(
      'FLOW_POST_MIGRATION_SURVIVOR_SHADOW_NO_EXIT_GRACE_MS', 60_000,
      { min: 1_000, max: 30 * 60_000 },
    ),
  },

  // Graduation Acceleration Shadow O. This is an independent forward-only
  // experiment derived from the non-overlapping historical graduation study.
  // It never signs or submits a transaction and does not reuse old I cohorts.
  graduationAccelerationShadow: {
    enabled: booleanEnv('FLOW_GRADUATION_ACCEL_SHADOW_ENABLED', true),
    longExitMatrixEnabled: graduationHo500LongExitProfiles.some((profile) => profile.newEntriesEnabled !== false),
    longExitObservationGraceMs: integerEnv(
      'FLOW_GRADUATION_ACCEL_LONG_EXIT_OBSERVATION_GRACE_MS', 5 * 60_000,
      { min: 60_000, max: 5 * 60_000 },
    ),
    longExitObservationMaxMints: integerEnv(
      'FLOW_GRADUATION_ACCEL_LONG_EXIT_OBSERVATION_MAX_MINTS', 2_000,
      { min: 1, max: 10_000 },
    ),
    entryDelayMs: integerEnv('FLOW_GRADUATION_ACCEL_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_GRADUATION_ACCEL_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitDelayMs: integerEnv('FLOW_GRADUATION_ACCEL_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_GRADUATION_ACCEL_EXIT_TIMEOUT_MS', 15_000, { min: 1 }),
    // NO_EXIT remains right-censored. Continue observing the public tape only
    // to measure when a same-market executable exit eventually reappears.
    noExitObservationMs: integerEnv(
      'FLOW_GRADUATION_ACCEL_NO_EXIT_OBSERVATION_MS',
      10 * 60_000,
      { min: 1_000, max: 60 * 60_000 },
    ),
    maxEntryPriceJumpPct: numberEnv('FLOW_GRADUATION_ACCEL_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0, max: 1_000,
    }),
    hardStopPct: numberEnv('FLOW_GRADUATION_ACCEL_HARD_STOP_PCT', 30, {
      min: 0.1, max: 100,
    }),
    maxPreGraduationHoldMs: integerEnv(
      'FLOW_GRADUATION_ACCEL_MAX_PRE_GRAD_HOLD_MS',
      5 * 60_000,
      { min: 10_000, max: 30 * 60_000 },
    ),
    maxPostGraduationHoldMs: integerEnv(
      'FLOW_GRADUATION_ACCEL_MAX_POST_GRAD_HOLD_MS',
      5 * 60_000,
      { min: 10_000, max: 30 * 60_000 },
    ),
    coreExitPct: numberEnv('FLOW_GRADUATION_ACCEL_CORE_EXIT_PCT', 50, {
      min: 1, max: 99,
    }),
    // Shadow remains a 1 SOL research model independently of the promoted
    // 0.5 SOL live order, preserving the eventual production-size capacity test.
    capacitySols: listEnv('FLOW_GRADUATION_ACCEL_V2_CAPACITY_SOLS', ['1'])
      .map(Number).filter((value) => Number.isFinite(value) && value > 0),
    entryProfiles: [
      {
        id: 'O_FAST10_C80_B20_R07',
        label: '10秒 Curve≥80 / Buyers≥20 / Sell-Buy≤0.7',
        mode: 'FIXED_10S',
        horizonMs: 10_000,
        minCurvePct: 80,
        minBuyers: 20,
        maxSellBuyRatio: 0.7,
      },
      {
        id: 'O_C80_D5_B2_S0_NC',
        liveStrategyId: 'graduation_accel_o_c80_d5_b2_s0_nc_live',
        label: '首次Curve80 / ΔCurve5≥5 / Buyers5≥2 / 0卖单 / Creator未卖',
        mode: 'CURVE_MILESTONE',
        thresholdPct: 80,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        capacityAwareExit: true,
      },
      ...[15, 20].map((hardStopPct) => ({
        id: `O_C80_D5_B2_S0_NC_H${hardStopPct}`,
        label: `O-C80-D5止损对照 · H${hardStopPct}% / 其余退出不变`,
        mode: 'CURVE_MILESTONE',
        thresholdPct: 80,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        capacityAwareExit: true,
        hardStopPct,
      })),
      ...[75, 78].map((thresholdPct) => ({
        id: `O_C${thresholdPct}_D5_B2_S0_NC_EARLY`,
        label: `O-C${thresholdPct}-EARLY · Curve${thresholdPct}提前触发 / ΔCurve5≥5 / Buyers≥2 / 0卖单`,
        mode: 'CURVE_MILESTONE',
        thresholdPct,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        capacityAwareExit: true,
        coreExitPct: 50,
        runnerExitMode: 'TIERED_TRAILING',
        runnerMaxHoldMs: 240_000,
      })),
      {
        id: 'O_C80_M5_HANDOFF_X60',
        label: 'O-C80-M5-HANDOFF · Curve80信号后等待毕业 / PumpSwap首5秒确认 / 固定60秒',
        mode: 'CURVE_MILESTONE',
        thresholdPct: 80,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        migrationHandoff: true,
        capacityAwareExit: true,
        coreExitPct: 0,
        postMigrationEntryGate: {
          windowMs: 5_000,
          minBuyers: 5,
          minNetFlowSol: 0,
          maxSellBuyRatio: 0.7,
          maxDrawdownPct: 20,
          maxMarketMovePct: 15,
          maxSelfImpactPct: 10,
        },
        runnerExitMode: 'FIXED_HOLD',
        runnerMaxHoldMs: 60_000,
      },
      ...[
        ['O_C80_LIVE_MIG_X20', 20_000],
        ['O_C80_LIVE_MIG_X30', 30_000],
      ].map(([id, runnerMaxHoldMs]) => ({
        id,
        label: `${id} · O-C80实盘迁移拒绝后 / PumpSwap自然流确认 / 固定${runnerMaxHoldMs / 1_000}秒`,
        mode: 'LIVE_MIGRATION_FAILURE',
        sourceLiveStrategyId: 'graduation_accel_o_c80_d5_b2_s0_nc_live',
        migrationHandoff: true,
        capacityAwareExit: true,
        capacitySols: [1],
        entryTimeoutMs: 2_500,
        coreExitPct: 0,
        postMigrationEntryGate: {
          entryDelayMs: 500,
          captureWindowMs: 3_000,
          evaluateAtFill: true,
          waitForQualification: true,
          minTrades: 3,
          minBuyTx: 2,
          minBuyers: 2,
          minNetFlowSol: 0.1,
          maxSellBuyRatio: 0.5,
          maxLargestSellSol: 1,
          maxDrawdownPct: 12,
          maxMarketMovePct: 15,
          maxSelfImpactPct: 10,
        },
        runnerExitMode: 'FIXED_HOLD',
        runnerMaxHoldMs,
      })),
      ...[
        ['O_C80_P500_STAIR240', 500, 'TIERED_TRAILING', 240_000],
        ['O_C80_P1000_X60', 1_000, 'FIXED_HOLD', 60_000],
        ['O_C80_P1000_X120', 1_000, 'FIXED_HOLD', 120_000],
        ['O_C80_P1000_STAIR240', 1_000, 'TIERED_TRAILING', 240_000],
      ].map(([id, persistenceMs, runnerExitMode, runnerMaxHoldMs]) => ({
        id,
        liveStrategyId: id === 'O_C80_P500_STAIR240'
          ? 'graduation_accel_o_c80_p500_stair240_live'
          : null,
        label: `${id} · Curve80持续确认 / 1 SOL可执行退出`,
        mode: 'CURVE_MILESTONE_PERSISTENCE',
        thresholdPct: 80,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        capacityAwareExit: true,
        persistenceMs,
        maxPersistenceSellTx: 0,
        maxPersistencePullbackPct: 5,
        coreExitPct: 0,
        runnerExitMode,
        runnerMaxHoldMs,
      })),
      {
        id: 'O_C80_P500_STAIR240_RUGX',
        label: 'O_C80_P500_STAIR240 RUGX · 同信号 + 当前高置信灾难过滤',
        mode: 'CURVE_MILESTONE_PERSISTENCE',
        thresholdPct: 80,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        capacityAwareExit: true,
        persistenceMs: 500,
        maxPersistenceSellTx: 0,
        maxPersistencePullbackPct: 5,
        coreExitPct: 0,
        runnerExitMode: 'TIERED_TRAILING',
        runnerMaxHoldMs: 240_000,
        pairedBaselineProfileId: 'O_C80_P500_STAIR240',
        rugGuardMode: 'LIVE_CURVE_CATASTROPHE',
      },
      ...[
        ['O90_M5_X60', 'FIXED_HOLD', 60_000],
        ['O90_M5_X120', 'FIXED_HOLD', 120_000],
        ['O90_M5_STAIR120', 'TIERED_TRAILING', 120_000],
      ].map(([id, runnerExitMode, runnerMaxHoldMs]) => ({
        id,
        liveStrategyId: id === 'O90_M5_STAIR120'
          ? 'graduation_accel_o90_m5_stair120_live'
          : null,
        label: `${id} · Curve90 graduation probability + first PumpSwap 5s gate`,
        mode: 'CURVE_MILESTONE',
        thresholdPct: 90,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 1,
        maxSellTx: 1,
        requireNoCreatorSell: true,
        capacityAwareExit: true,
        coreExitPct: 50,
        postMigrationGate: {
          windowMs: 5_000,
          minBuyers: 25,
          minNetFlowSol: 0,
        },
        runnerExitMode,
        runnerMaxHoldMs,
      })),
      ...[
        ['O90_Q70_D30_X60', 'FIXED_HOLD', 60_000],
        ['O90_Q70_D30_STAIR120', 'TIERED_TRAILING', 120_000],
      ].map(([id, runnerExitMode, runnerMaxHoldMs]) => ({
        id,
        label: `${id} · Curve90 / Buyers5≥3 / NetFlow5≥70 / ΔCurve5≥30 · forward-only`,
        mode: 'CURVE_MILESTONE',
        thresholdPct: 90,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 30,
        minBuyers: 3,
        minNetFlowSol: 70,
        maxSellTx: 1,
        requireNoCreatorSell: true,
        coreExitPct: 50,
        capacityAwareExit: true,
        postMigrationGate: {
          windowMs: 5_000,
          minBuyers: 25,
          minNetFlowSol: 0,
        },
        runnerExitMode,
        runnerMaxHoldMs,
      })),
      {
        id: 'O90_DAY0818_STAIR120',
        label: 'O90-DAY-0818 · 北京时间08–18点 / 旧O90入场 / 阶梯120秒',
        mode: 'CURVE_MILESTONE',
        thresholdPct: 90,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 1,
        maxSellTx: 1,
        requireNoCreatorSell: true,
        sessionStartHourCst: 8,
        sessionEndHourCst: 18,
        coreExitPct: 50,
        capacityAwareExit: true,
        postMigrationGate: {
          windowMs: 5_000,
          minBuyers: 25,
          minNetFlowSol: 0,
        },
        runnerExitMode: 'TIERED_TRAILING',
        runnerMaxHoldMs: 120_000,
      },
      {
        id: 'O_C80_DAY1218_STAIR240',
        label: 'O-C80-DAY-1218 · 北京时间12–18点 / 旧Curve80入场 / 阶梯240秒',
        mode: 'CURVE_MILESTONE',
        thresholdPct: 80,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        sessionStartHourCst: 12,
        sessionEndHourCst: 18,
        coreExitPct: 50,
        capacityAwareExit: true,
        runnerExitMode: 'TIERED_TRAILING',
        runnerMaxHoldMs: 240_000,
      },
      ...[
        ['O_C80_NIGHT0004_STAIR240', 'O-C80-NIGHT-0004', 0, 4],
        ['O_C80_EVENING2024_STAIR240', 'O-C80-EVENING-2024', 20, 24],
      ].map(([id, labelPrefix, sessionStartHourCst, sessionEndHourCst]) => ({
        id,
        label: `${labelPrefix} · 北京时段 / 旧Curve80入场 / 阶梯240秒`,
        mode: 'CURVE_MILESTONE',
        thresholdPct: 80,
        recentWindowMs: 5_000,
        minCurveDeltaPct: 5,
        minBuyers: 2,
        maxSellTx: 0,
        requireNoCreatorSell: true,
        sessionStartHourCst,
        sessionEndHourCst,
        coreExitPct: 50,
        capacityAwareExit: true,
        runnerExitMode: 'TIERED_TRAILING',
        runnerMaxHoldMs: 240_000,
      })),
      ...graduationRelaxedEntryProfiles,
      ...graduationHo500LongExitProfiles,
    ],
    trailingTiers: [
      { activationPct: 20, drawdownPct: 10 },
      { activationPct: 40, drawdownPct: 15 },
      { activationPct: 80, drawdownPct: 20 },
      { activationPct: 150, drawdownPct: 25 },
      { activationPct: 300, drawdownPct: 30 },
    ],
    bigWinnerPct: numberEnv('FLOW_GRADUATION_ACCEL_BIG_WINNER_PCT', 50, { min: 1 }),
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: 1,
    }),
  },

  // Observer-only Launch Quality research. Reference percentages label market
  // structure for later analysis; they never become an entry or execution rule.
  launchQualityObserver: {
    enabled: retiredResearchReopenEnabled
      && booleanEnv('FLOW_LAUNCH_QUALITY_OBSERVER_ENABLED', false),
    snapshotHorizonsMs: millisecondListEnv(
      'FLOW_LAUNCH_QUALITY_SNAPSHOT_SECONDS',
      [5, 10, 20, 30, 60],
    ),
    maxLaunchAgeMs: integerEnv('FLOW_LAUNCH_QUALITY_MAX_AGE_MS', 90_000, {
      min: 30_000,
      max: 10 * 60_000,
    }),
    pumpReferencePct: numberEnv('FLOW_LAUNCH_QUALITY_PUMP_REFERENCE_PCT', 25, {
      min: 0.1,
      max: 10_000,
    }),
    pullbackReferencePct: numberEnv(
      'FLOW_LAUNCH_QUALITY_PULLBACK_REFERENCE_PCT',
      7.5,
      { min: 0.1, max: 100 },
    ),
    reboundReferencePct: numberEnv(
      'FLOW_LAUNCH_QUALITY_REBOUND_REFERENCE_PCT',
      3,
      { min: 0, max: 1_000 },
    ),
    deepReferenceProfiles: launchDeepPullbackProfiles.map((profile) => ({ ...profile })),
    recentBuyerWindowMs: integerEnv(
      'FLOW_LAUNCH_QUALITY_RECENT_BUYER_WINDOW_MS',
      10_000,
      { min: 500, max: 60_000 },
    ),
    retentionFloorPct: numberEnv('FLOW_LAUNCH_QUALITY_RETENTION_FLOOR_PCT', 10, {
      min: 0,
      max: 100,
    }),
    maxObservationLagMs: integerEnv(
      'FLOW_LAUNCH_QUALITY_MAX_OBSERVATION_LAG_MS',
      2_000,
      { min: 0, max: 30_000 },
    ),
    marketRegimeLookbackMs: integerEnv(
      'FLOW_LAUNCH_MARKET_REGIME_LOOKBACK_MS',
      30 * 60_000,
      { min: 5 * 60_000, max: 6 * 60 * 60_000 },
    ),
    marketRegimeSettlementLagMs: integerEnv(
      'FLOW_LAUNCH_MARKET_REGIME_SETTLEMENT_LAG_MS',
      60_000,
      { min: 60_000, max: 10 * 60_000 },
    ),
    marketRegimeCacheMs: integerEnv(
      'FLOW_LAUNCH_MARKET_REGIME_CACHE_MS',
      5_000,
      { min: 1_000, max: 60_000 },
    ),
  },

  // M2F-OBS collects causal post-migration second-leg evidence only. It has
  // no position model, execution callback, RPC enrichment or transaction path.
  migrationSecondLegObserver: {
    enabled: postMigrationOpportunityEnabled || (retiredResearchReopenEnabled
      && booleanEnv('FLOW_M2F_OBSERVER_ENABLED', false)),
    maxAgeMs: integerEnv('FLOW_M2F_OBSERVER_MAX_AGE_MS', 480_000, {
      min: 60_000,
      max: 30 * 60_000,
    }),
    snapshotIntervalMs: integerEnv('FLOW_M2F_OBSERVER_SNAPSHOT_INTERVAL_MS', 1_000, {
      min: 250,
      max: 10_000,
    }),
    restoreGraceMs: integerEnv('FLOW_M2F_OBSERVER_RESTORE_GRACE_MS', 60_000, {
      min: 0,
      max: 10 * 60_000,
    }),
    pullbackArmPct: numberEnv('FLOW_M2F_OBSERVER_PULLBACK_ARM_PCT', 8, {
      min: 0.1,
      max: 100,
    }),
    reboundReferencePct: numberEnv('FLOW_M2F_OBSERVER_REBOUND_REFERENCE_PCT', 3, {
      min: 0,
      max: 100,
    }),
    retentionFloorPct: numberEnv('FLOW_M2F_OBSERVER_RETENTION_FLOOR_PCT', 20, {
      min: 0,
      max: 100,
    }),
    effectiveBuyMinSol: numberEnv('FLOW_M2F_OBSERVER_EFFECTIVE_BUY_MIN_SOL', 0.02, {
      min: 0,
      max: 100,
    }),
  },

  // Retire the old M2F position cohorts after the negative forward sample.
  // Reuse the independent eight-minute M2F-OBS tape for a separately named
  // late-stabilization matrix; old M2F rows remain untouched and queryable.
  migrationSecondLegShadow: {
    enabled: postMigrationOpportunityEnabled || (retiredResearchReopenEnabled
      && booleanEnv('FLOW_LPS_SHADOW_ENABLED', false)),
    newEntriesEnabled: postMigrationOpportunityEnabled
      || booleanEnv('FLOW_LPS_SHADOW_NEW_ENTRIES_ENABLED', false),
    strategyName: 'Post-Migration Opportunity PMO',
    // Labels the broad post-migration tape for Shadow research only. This
    // object is not consumed by LiveTradingManager or any live strategy.
    marketRegime: {
      enabled: retiredResearchReopenEnabled
        && booleanEnv('FLOW_M2F_MARKET_REGIME_SHADOW_ENABLED', false),
      maturityAgeMs: integerEnv('FLOW_M2F_MARKET_REGIME_MATURITY_MS', 120_000, {
        min: 10_000, max: 10 * 60_000,
      }),
      lookbackMs: integerEnv('FLOW_M2F_MARKET_REGIME_LOOKBACK_MS', 10 * 60_000, {
        min: 60_000, max: 6 * 60 * 60_000,
      }),
      minMints: integerEnv('FLOW_M2F_MARKET_REGIME_MIN_MINTS', 12, {
        min: 3, max: 1_000,
      }),
      minPositiveReturnRatePct: numberEnv(
        'FLOW_M2F_MARKET_REGIME_MIN_POSITIVE_RETURN_RATE_PCT', 50, { min: 0, max: 100 },
      ),
      maxRugCollapseRatePct: numberEnv(
        'FLOW_M2F_MARKET_REGIME_MAX_RUG_RATE_PCT', 15, { min: 0, max: 100 },
      ),
      minPositiveNetFlowRatePct: numberEnv(
        'FLOW_M2F_MARKET_REGIME_MIN_POSITIVE_FLOW_RATE_PCT', 55, { min: 0, max: 100 },
      ),
      maxMedianEstimatedImpact1SolPct: numberEnv(
        'FLOW_M2F_MARKET_REGIME_MAX_MEDIAN_IMPACT_1SOL_PCT', 5, { min: 0, max: 100 },
      ),
    },
    cohortId: 'M2F-NH10-GUARD-B',
    positionSizeSol: postMigrationOpportunityEnabled
      ? postMigrationOpportunityPositionSol
      : numberEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_POSITION_SOL', 1, {
          min: 0.01,
          max: 100,
        }),
    entryDelayMs: integerEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_ENTRY_DELAY_MS', 200, {
      min: 0,
      max: 10_000,
    }),
    entryTimeoutMs: integerEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_ENTRY_TIMEOUT_MS', 2_000, {
      min: 100,
      max: 30_000,
    }),
    exitDelayMs: integerEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_EXIT_DELAY_MS', 200, {
      min: 0,
      max: 10_000,
    }),
    exitTimeoutMs: integerEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_EXIT_TIMEOUT_MS', 2_000, {
      min: 100,
      max: 30_000,
    }),
    // A late quote is diagnostic only: it never converts NO_EXIT into CLOSED.
    noExitObservationMs: integerEnv(
      'FLOW_M2F_NO_EXIT_OBSERVATION_MS',
      10 * 60_000,
      { min: 1_000, max: 60 * 60_000 },
    ),
    maxEntryPriceJumpPct: numberEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0,
      max: 1_000,
    }),
    maxNegativeEntryJumpPct: numberEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_MAX_ENTRY_DROP_PCT', 30, {
      min: 0,
      max: 100,
    }),
    // A PumpSwap token cannot causally reprice by hundreds of times between
    // adjacent observations in this short study. Such rows are reserve/decimal
    // scale discontinuities and must not become giant MFE or PnL winners.
    maxObservedPriceRatio: numberEnv('FLOW_M2F_MAX_OBSERVED_PRICE_RATIO', 100, {
      min: 2,
      max: 1_000_000,
    }),
    hardStopPct: numberEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_HARD_STOP_PCT', 15, {
      min: 0,
      max: 100,
    }),
    maxHoldMs: integerEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_MAX_HOLD_MS', 10_000, {
      min: 1_000,
      max: 10 * 60_000,
    }),
    thresholds: { ...m2fNearHighThresholds },
    cohorts: [
      {
        id: 'M2F-NH10-GUARD-B',
        label: 'Near-high 10s entry control',
        enabled: false,
        studyMode: 'ENTRY_CONTROL',
        confirmationMode: 'IMMEDIATE',
        hardStopPct: numberEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_HARD_STOP_PCT', 15, {
          min: 0,
          max: 100,
        }),
        maxHoldMs: integerEnv('FLOW_M2F_NEAR_HIGH_GUARD_B_MAX_HOLD_MS', 10_000, {
          min: 1_000,
          max: 10 * 60_000,
        }),
      },
      {
        id: 'M2F-HOLD-120',
        label: 'Same-entry fixed 120s hold extension',
        enabled: false,
        studyMode: 'SAME_ENTRY_HOLD_EXTENSION',
        confirmationMode: 'IMMEDIATE',
        hardStopPct: 100,
        maxHoldMs: integerEnv('FLOW_M2F_HOLD_120_MS', 120_000, {
          min: 10_000,
          max: 10 * 60_000,
        }),
      },
      {
        id: 'M2F-HOLD-240',
        label: 'Same-entry fixed 240s right-tail extension',
        enabled: false,
        studyMode: 'SAME_ENTRY_HOLD_EXTENSION',
        confirmationMode: 'IMMEDIATE',
        hardStopPct: 100,
        maxHoldMs: integerEnv('FLOW_M2F_HOLD_240_MS', 240_000, {
          min: 10_000,
          max: 10 * 60_000,
        }),
      },
      {
        id: 'M2F-HOLD-240-H20',
        label: 'Same-entry 240s extension with 20% mark stop',
        enabled: false,
        studyMode: 'SAME_ENTRY_HOLD_EXTENSION',
        confirmationMode: 'IMMEDIATE',
        hardStopPct: 20,
        maxHoldMs: integerEnv('FLOW_M2F_HOLD_240_H20_MS', 240_000, {
          min: 10_000,
          max: 10 * 60_000,
        }),
      },
      {
        id: 'M2F-CF2-H10',
        label: 'Two-snapshot persistence filter / original 10s exit',
        enabled: false,
        studyMode: 'CONFIRM_FILTER',
        confirmationMode: 'TWO_SNAPSHOT_PERSISTENCE',
        confirmationMinGapMs: integerEnv('FLOW_M2F_CONFIRM_MIN_GAP_MS', 500, {
          min: 100,
          max: 5_000,
        }),
        confirmationMaxGapMs: integerEnv('FLOW_M2F_CONFIRM_MAX_GAP_MS', 2_500, {
          min: 500,
          max: 10_000,
        }),
        maxSellDecelerationIncrease: numberEnv(
          'FLOW_M2F_CONFIRM_MAX_SELL_DECEL_INCREASE', 0.1, { min: 0, max: 10 },
        ),
        hardStopPct: 15,
        maxHoldMs: 10_000,
      },
      ...[
        ['M2F-SSR-CTRL-X60', 'SSR control / fixed 60s', false, 100, 60_000],
        ['M2F-SSR-MRG-X60', 'SSR + MRG green / fixed 60s', true, 100, 60_000],
        ['M2F-SSR-MRG-X120', 'SSR + MRG green / fixed 120s', true, 100, 120_000],
        ['M2F-SSR-MRG-R120-H20', 'SSR + MRG green / H20 / 120s', true, 20, 120_000],
        ['M2F-SSR-MRG-R240-H20', 'SSR + MRG green / H20 / 240s right tail', true, 20, 240_000],
      ].map(([id, label, requireGreenRegime, hardStopPct, maxHoldMs]) => ({
        id,
        label,
        enabled: false,
        studyMode: requireGreenRegime
          ? 'SELL_STRESS_RECOVERY_MARKET_REGIME'
          : 'SELL_STRESS_RECOVERY_CONTROL',
        confirmationMode: 'TWO_SNAPSHOT_PERSISTENCE',
        confirmationMinGapMs: 500,
        confirmationMaxGapMs: 2_500,
        maxSellDecelerationIncrease: 0.15,
        requireGreenRegime,
        hardStopPct,
        maxHoldMs,
        thresholds: {
          minAgeMs: 10_000,
          maxAgeMs: 90_000,
          minCurrentImpulsePct: 20,
          maxCurrentImpulsePct: 100,
          minPeakImpulsePct: 20,
          minPullbackPct: 10,
          maxPullbackPct: 30,
          minReboundPct: 3,
          maxReboundPct: 15,
          minNetFlow10sSol: 1,
          minNetFlow3sSol: 0.5,
          minBuyers10s: 8,
          minBuyers3s: 1,
          maxLargestBuyerSharePct: 40,
          minBuySpeedRatio: 0,
          minNetFlowAcceleration: -1_000,
          maxSellDecelerationRatio: 0.8,
          minHolderDiffusionIndex: -10_000,
          minQuoteReserveSol: 20,
          maxEstimatedImpact1SolPct: 5,
        },
      })),
      ...lpsCohorts,
      ...postMigrationOpportunityCohorts,
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: postMigrationOpportunityPositionSol,
    }),
  },

  // Forward-only theoretical same-slot backrun study. This observer never
  // signs or sends a transaction. It measures whether a large PumpSwap sell
  // is followed by a buy in the same slot and prices the hypothetical 0.1 SOL
  // round trip from the sell event's post-trade reserves.
  sameSlotDumpBackrunShadow: {
    // The completed-slot export produced zero winners across every tested
    // horizon. Keep the historical table/API but stop generating new rows.
    // This is intentionally hard-disabled: an old server .env=true must not
    // silently reactivate a retired strategy after an ordinary code update.
    retired: true,
    enabled: false,
    positionSizeSol: numberEnv('FLOW_SAME_SLOT_DUMP_BACKRUN_POSITION_SOL', 0.1, {
      min: 0.01,
      max: 10,
    }),
    trackingAgeMs: integerEnv('FLOW_SAME_SLOT_DUMP_BACKRUN_TRACKING_AGE_MS', 15 * 60_000, {
      min: 60_000,
      max: 60 * 60_000,
    }),
    stateRetentionMs: integerEnv('FLOW_SAME_SLOT_DUMP_BACKRUN_STATE_RETENTION_MS', 20 * 60_000, {
      min: 60_000,
      max: 2 * 60 * 60_000,
    }),
    episodeCooldownMs: integerEnv('FLOW_SAME_SLOT_DUMP_BACKRUN_EPISODE_COOLDOWN_MS', 10_000, {
      min: 0,
      max: 10 * 60_000,
    }),
    exitGraceMs: integerEnv('FLOW_SAME_SLOT_DUMP_BACKRUN_EXIT_GRACE_MS', 2_000, {
      min: 100,
      max: 30_000,
    }),
    maxEpisodesPerMint: integerEnv('FLOW_SAME_SLOT_DUMP_BACKRUN_MAX_EPISODES_PER_MINT', 20, {
      min: 1,
      max: 100,
    }),
    entryProfiles: [
      {
        id: 'SDBR-S10-D15',
        label: 'Sell>=10 SOL / drop>=15%',
        minSellSol: 10,
        minDropPct: 15,
        maxDropPct: 70,
        minQuoteReserveSol: 5,
        maxEntryImpactPct: 12,
      },
      {
        id: 'SDBR-S20-D20',
        label: 'Sell>=20 SOL / drop>=20%',
        minSellSol: 20,
        minDropPct: 20,
        maxDropPct: 70,
        minQuoteReserveSol: 5,
        maxEntryImpactPct: 12,
      },
    ],
    exitProfiles: [
      { id: 'H250', label: 'fixed 250ms', kind: 'FIXED', holdMs: 250 },
      { id: 'H500', label: 'fixed 500ms', kind: 'FIXED', holdMs: 500 },
      { id: 'H1000', label: 'fixed 1s', kind: 'FIXED', holdMs: 1_000 },
      { id: 'H2000', label: 'fixed 2s', kind: 'FIXED', holdMs: 2_000 },
      {
        id: 'TP8-H2000',
        label: '+8% or fixed 2s',
        kind: 'TAKE_OR_FIXED',
        takeProfitPct: 8,
        maxHoldMs: 2_000,
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: numberEnv('FLOW_SAME_SLOT_DUMP_BACKRUN_POSITION_SOL', 0.1, {
        min: 0.01,
        max: 10,
      }),
    }),
  },

  storage: {
    dbPath: process.env.FLOW_DB_PATH || './data/flow-research.db',
    rawRetentionHours: numberEnv('FLOW_RAW_RETENTION_HOURS', 48, { min: 24 }),
    archiveDir: process.env.FLOW_ARCHIVE_DIR || './data/archive',
    cacheSizeKb: integerEnv('FLOW_DB_CACHE_SIZE_KB', 65_536, {
      min: 2_000,
      max: 512 * 1_024,
    }),
    busyTimeoutMs: integerEnv('FLOW_DB_BUSY_TIMEOUT_MS', 5_000, {
      min: 50,
      max: 30_000,
    }),
    rawShardingEnabled: booleanEnv('FLOW_RAW_SHARDING_ENABLED', true),
    rawShardDir: process.env.FLOW_RAW_SHARD_DIR || './data/raw-daily',
    rawShardReadDays: integerEnv('FLOW_RAW_SHARD_READ_DAYS', 3, {
      min: 2,
      max: 7,
    }),
    writeRetryMinMs: integerEnv('FLOW_DB_WRITE_RETRY_MIN_MS', 250, {
      min: 50,
      max: 10_000,
    }),
    writeRetryMaxMs: integerEnv('FLOW_DB_WRITE_RETRY_MAX_MS', 30_000, {
      min: 1_000,
      max: 5 * 60_000,
    }),
    maxPendingTrades: integerEnv('FLOW_DB_MAX_PENDING_TRADES', 250_000, {
      min: 10_000,
      max: 5_000_000,
    }),
    flushMs: integerEnv('FLOW_DB_FLUSH_MS', 250, { min: 25 }),
    flushMax: integerEnv('FLOW_DB_FLUSH_MAX', 1_000, { min: 10 }),
    healthRefreshMs: integerEnv('FLOW_DB_HEALTH_REFRESH_MS', 15 * 60_000, {
      min: 60_000,
      max: 60 * 60_000,
    }),
    startupReplayCacheMs: integerEnv('FLOW_STARTUP_REPLAY_CACHE_MS', 15 * 60_000, {
      min: 0,
      max: 60 * 60_000,
    }),
  },

  dashboardCache: {
    enabled: booleanEnv('FLOW_DASHBOARD_CACHE_ENABLED', true),
    processEnabled: booleanEnv('FLOW_DASHBOARD_PROCESS_ENABLED', true),
    runtimeRefreshMs: integerEnv('FLOW_DASHBOARD_RUNTIME_REFRESH_MS', 5_000, {
      min: 1_000,
      max: 60_000,
    }),
    httpHeapMb: integerEnv('FLOW_DASHBOARD_HTTP_HEAP_MB', 256, {
      min: 128,
      max: 2_048,
    }),
    maxSnapshotBytes: integerEnv('FLOW_DASHBOARD_MAX_SNAPSHOT_BYTES', 4 * 1024 * 1024, {
      min: 64 * 1024, max: 16 * 1024 * 1024,
    }),
    maxMemoryBytes: integerEnv('FLOW_DASHBOARD_MAX_MEMORY_BYTES', 32 * 1024 * 1024, {
      min: 1024 * 1024, max: 128 * 1024 * 1024,
    }),
    fastWorkerHeapMb: integerEnv('FLOW_DASHBOARD_FAST_WORKER_HEAP_MB', 128, { min: 64, max: 512 }),
    historyWorkerHeapMb: integerEnv('FLOW_DASHBOARD_HISTORY_WORKER_HEAP_MB', 256, { min: 128, max: 1024 }),
    idleStrategyRefreshMs: integerEnv('FLOW_DASHBOARD_IDLE_STRATEGY_REFRESH_MS', 300_000, {
      min: 60_000, max: 3_600_000,
    }),
    dbPath: process.env.FLOW_DASHBOARD_DB_PATH || './data/flow-dashboard.db',
    fastRefreshMs: integerEnv('FLOW_DASHBOARD_FAST_REFRESH_MS', 15_000, {
      min: 1_000,
      max: 60_000,
    }),
    shadowRefreshMs: integerEnv('FLOW_DASHBOARD_SHADOW_REFRESH_MS', 60_000, {
      min: 10_000,
      max: 15 * 60_000,
    }),
    slowRefreshMs: integerEnv('FLOW_DASHBOARD_SLOW_REFRESH_MS', 5 * 60_000, {
      min: 10_000,
      max: 15 * 60_000,
    }),
    maxSnapshotAgeMs: integerEnv('FLOW_DASHBOARD_MAX_SNAPSHOT_AGE_MS', 15 * 60_000, {
      min: 30_000,
      max: 24 * 60 * 60_000,
    }),
    cacheSizeKb: integerEnv('FLOW_DASHBOARD_CACHE_SIZE_KB', 16_384, {
      min: 2_000,
      max: 128 * 1_024,
    }),
  },

  server: {
    port: integerEnv('FLOW_DASHBOARD_PORT', 3001, { min: 1, max: 65_535 }),
    host: process.env.FLOW_BIND_HOST || '0.0.0.0',
  },
};

// Reserve semantics changed from the event's pre-trade snapshot to a reconstructed
// post-trade snapshot. Keep every old handoff definition for open-position exits
// and historical display, but never append a different execution model to its IDs.
const graduationHandoffProfiles = config.graduationAccelerationShadow.entryProfiles;
const graduationHandoffIds = new Set(graduationHandoffProfiles
  .filter((profile) => profile.migrationHandoff).map((profile) => profile.id));
config.graduationAccelerationShadow.entryProfiles = graduationHandoffProfiles.flatMap((profile) => {
  if (!profile.migrationHandoff) return [profile];
  const post = {
    ...profile,
    id: `${profile.id}_POSTV1`,
    label: `${profile.label} · POST V1 即时`,
    executionModelVersion: 'POST_TRADE_V1',
    feeModel: 'FLAT_ESTIMATE',
    shadowExecutionDelayMs: 0,
    newEntriesEnabled: profile.newEntriesEnabled !== false,
    legacyProfileId: profile.id,
  };
  for (const key of ['pairedEntryProfileId', 'pairedBaselineProfileId']) {
    if (graduationHandoffIds.has(profile[key])) post[key] = `${profile[key]}_POSTV1`;
  }
  return [{
    ...profile,
    label: `${profile.label} · PRE 历史（停止新入场）`,
    executionModelVersion: 'PRE_TRADE_LEGACY',
    newEntriesEnabled: false,
    handoffLiveStrategyId: null,
    liveStrategyId: null,
  }, post];
});
const graduationPostHo500Baseline = config.graduationAccelerationShadow.entryProfiles
  .find((profile) => profile.id === 'O_C80_HO500_X60_POSTV1');
if (graduationPostHo500Baseline) {
  config.graduationAccelerationShadow.entryProfiles.push({
    ...graduationPostHo500Baseline,
    id: 'O_C80_HO500_X60_POSTV1_D1000',
    label: 'O-C80-HO500 · POST V1 同资格延迟1秒 / 固定60秒 / 0.1 SOL',
    pairedSignalProfileId: graduationPostHo500Baseline.id,
    shadowExecutionDelayMs: 1_000,
    capacitySols: [0.1],
    handoffLiveStrategyId: null,
    liveStrategyId: null,
    liveBridgeCapacitySol: null,
  });
}

// Solana requests priority price per CU, while operators reason about the total
// fee per transaction. Derive one shared buy/sell CU price from the SOL target.
config.liveTrading.priorityFeeMicroLamports = priorityFeeMicroLamports(
  config.liveTrading.priorityFeeSol,
  config.liveTrading.computeUnitLimit,
);
config.liveTrading.emergencyPriorityFeeMicroLamports = priorityFeeMicroLamports(
  config.liveTrading.emergencyPriorityFeeSol,
  config.liveTrading.computeUnitLimit,
);

function streamTokenFor(endpoint) {
  if (config.stream.allenHarkEndpoints.has(endpoint)) return config.stream.allenHarkToken || undefined;
  return config.stream.heliusToken || undefined;
}

function validateConfig() {
  const errors = [];
  if (config.stream.endpoints.length === 0) {
    errors.push('Missing FLOW_GRPC_ENDPOINTS or HELIUS_LASERSTREAM_ENDPOINT(S)');
  }
  if (config.strategy.signalWindowMs * 3 > config.strategy.bufferMs) {
    errors.push('FLOW_BUFFER_MS must cover all three signal windows');
  }
  if (config.launchQualityObserver.snapshotHorizonsMs.length === 0) {
    errors.push('FLOW_LAUNCH_QUALITY_SNAPSHOT_SECONDS must contain at least one value');
  }
  if (config.holderGrowthShadow.enabled && !config.launchQualityObserver.enabled) {
    errors.push('FLOW_LAUNCH_QUALITY_OBSERVER_ENABLED must be true when Holder Growth is enabled');
  }
  const holderGrowthHorizons = new Set([
    ...config.holderGrowthShadow.entryProfiles.map((profile) => (
      profile.horizonMs || config.holderGrowthShadow.snapshotHorizonMs
    )),
    ...config.holderGrowthShadow.exitProfiles
      .map((profile) => profile.flowCheckHorizonMs).filter(Boolean),
  ]);
  if (config.holderGrowthShadow.enabled
    && [...holderGrowthHorizons].some((horizonMs) => (
      !config.launchQualityObserver.snapshotHorizonsMs.includes(horizonMs)
    ))) {
    errors.push('FLOW_LAUNCH_QUALITY_SNAPSHOT_SECONDS must include all Holder Growth horizons');
  }
  const holderGrowthExitIds = new Set(
    config.holderGrowthShadow.exitProfiles.map((profile) => profile.id),
  );
  for (const profile of config.holderGrowthShadow.entryProfiles) {
    for (const exitProfileId of profile.exitProfileIds || []) {
      if (!holderGrowthExitIds.has(exitProfileId)) {
        errors.push(`Holder Growth entry ${profile.id} references missing exit ${exitProfileId}`);
      }
    }
  }
  if (config.qualityLeaderShadow.enabled && !config.launchQualityObserver.enabled) {
    errors.push('FLOW_LAUNCH_QUALITY_OBSERVER_ENABLED must be true when Quality Leader is enabled');
  }
  if (config.qualityLeaderShadow.enabled
    && ![config.qualityLeaderShadow.snapshot10Ms, config.qualityLeaderShadow.snapshot20Ms]
      .every((horizonMs) => config.launchQualityObserver.snapshotHorizonsMs.includes(horizonMs))) {
    errors.push('FLOW_LAUNCH_QUALITY_SNAPSHOT_SECONDS must include 10 and 20 for Quality Leader');
  }
  const qualityLeaderExitIds = new Set(
    config.qualityLeaderShadow.exitProfiles.map((profile) => profile.id),
  );
  for (const profile of config.qualityLeaderShadow.entryProfiles) {
    for (const exitProfileId of profile.exitProfileIds || []) {
      if (!qualityLeaderExitIds.has(exitProfileId)) {
        errors.push(`Quality Leader entry ${profile.id} references missing exit ${exitProfileId}`);
      }
    }
  }
  if (config.bigWinnerShadow.enabled) {
    if (config.bigWinnerShadow.entryProfiles.length === 0) {
      errors.push('Big Winner Shadow requires at least one entry profile');
    }
    if (config.bigWinnerShadow.exitProfiles.length === 0) {
      errors.push('Big Winner Shadow requires at least one exit profile');
    }
    const bigWinnerEntryIds = new Set(config.bigWinnerShadow.entryProfiles.map((row) => row.id));
    const bigWinnerExitIds = new Set(config.bigWinnerShadow.exitProfiles.map((row) => row.id));
    if (bigWinnerEntryIds.size !== config.bigWinnerShadow.entryProfiles.length) {
      errors.push('Big Winner Shadow entry profile ids must be unique');
    }
    if (bigWinnerExitIds.size !== config.bigWinnerShadow.exitProfiles.length) {
      errors.push('Big Winner Shadow exit profile ids must be unique');
    }
  }
  if (config.sameSlotDumpBackrunShadow.enabled) {
    const entryIds = new Set(
      config.sameSlotDumpBackrunShadow.entryProfiles.map((profile) => profile.id),
    );
    const exitIds = new Set(
      config.sameSlotDumpBackrunShadow.exitProfiles.map((profile) => profile.id),
    );
    if (!entryIds.size || entryIds.size !== config.sameSlotDumpBackrunShadow.entryProfiles.length) {
      errors.push('Same-Slot Dump Backrun Shadow entry profile ids must be present and unique');
    }
    if (!exitIds.size || exitIds.size !== config.sameSlotDumpBackrunShadow.exitProfiles.length) {
      errors.push('Same-Slot Dump Backrun Shadow exit profile ids must be present and unique');
    }
  }
  if (config.bondingCurveMomentumShadow.snapshotHorizonsMs.length === 0) {
    errors.push('FLOW_BONDING_MOMENTUM_SNAPSHOT_SECONDS must contain at least one value');
  }
  if (config.liveTrading.enabled && !config.liveTrading.dryRun) {
    if (!config.liveTrading.rpcUrl) errors.push('FLOW_RPC_URL is required for live trading');
    if (!config.liveTrading.privateKey) {
      errors.push('FLOW_LIVE_PRIVATE_KEY is required for live trading');
    }
    if (!process.env.FLOW_LIVE_MIGRATED_GFR_300_V2_POSITION_SOL
      && !process.env.FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_V4_POSITION_SOL
      && !process.env.FLOW_LIVE_MIGRATED_GE30_R23_F2_ONLY_G2_XLEG_POSITION_SOL
      && !process.env.FLOW_LIVE_MIGRATED_GE30_D25_32_R24_F1_EXEC01_V2_R2_H15_POSITION_SOL
      && !process.env.FLOW_LIVE_MIGRATED_GD25_35_X8_POSITION_SOL
      && !process.env.FLOW_LIVE_QUALITY_LEADER_QL_STRICT_GUARD_PROTECTED_POSITION_SOL
      && !process.env.FLOW_LIVE_CYA_ORGANIC_BURST_COB_F_POSITION_SOL
      && !process.env.FLOW_LIVE_CYA_ORGANIC_BURST_COB_D_POSITION_SOL
      && !process.env.FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_T12_5_V2_POSITION_SOL
      && !process.env.FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_V3_POSITION_SOL
      && !process.env.FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_V2_POSITION_SOL
      && !process.env.FLOW_LIVE_BIG_WINNER_PBR_A_X50_15_POSITION_SOL
      && !process.env.FLOW_LIVE_MIGRATED_GFR_300_POSITION_SOL
      && !process.env.FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_T12_5_POSITION_SOL
      && !process.env.FLOW_LIVE_GRADUATION_ACCEL_O90_M5_STAIR120_POSITION_SOL
      && !process.env.FLOW_LIVE_MIGRATION_CONTINUITY_MC_C5_E120_POSITION_SOL
      && !process.env.FLOW_LIVE_QUALITY_LEADER_QL_STRICT_PROTECTED_POSITION_SOL
      && !process.env.FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_V3_POSITION_SOL
      && !process.env.FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_V2_POSITION_SOL
      && !process.env.FLOW_LIVE_GRADUATION_ACCEL_O_C80_D5_B2_S0_NC_POSITION_SOL
      && !process.env.FLOW_LIVE_GRADUATION_ACCEL_O_C80_POSITION_SOL
      && !process.env.FLOW_LIVE_POST_GD20_35_R1_5_5_AGE60_XLEG_V3_POSITION_SOL
      && !process.env.FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_POSITION_SOL
      && !process.env.FLOW_LIVE_POST_GD25_35_F1_XLEG_POSITION_SOL
      && !process.env.FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL) {
      errors.push(
        'At least one active live strategy POSITION_SOL must be explicitly set (a previous XLEG size is accepted during migration)',
      );
    }
  }
  return errors;
}

module.exports = {
  config,
  normalizeEndpoint,
  liveTradingGuard,
  shadowPositionEnv,
  livePositionEnv,
  priorityFeeMicroLamports,
  validateConfig,
  streamTokenFor,
};
