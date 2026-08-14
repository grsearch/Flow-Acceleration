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

// The live strategy used 0.05 SOL as its former deployment default. Treat that
// exact legacy value as inherited so upgrading an existing server moves the
// active strategy to the new 1 SOL size without requiring a manual .env edit.
// Other values remain explicit operator overrides.
function livePositionEnv(name, fallback = 1) {
  const raw = process.env[name];
  if (raw == null || raw === '' || Number(raw) === 0.05) return fallback;
  return numberEnv(name, fallback, { min: 0.000001 });
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
    noExitLossPct: numberEnv('FLOW_BACKTEST_NO_EXIT_LOSS_PCT', 100, { min: 0 }),
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
    privateKey: process.env.FLOW_LIVE_PRIVATE_KEY || '',
    maxSignalAgeMs: integerEnv('FLOW_LIVE_MAX_SIGNAL_AGE_MS', 1_500, { min: 100 }),
    maxConcurrentPositions: integerEnv('FLOW_LIVE_MAX_POSITIONS', 3, { min: 1, max: 20 }),
    minWalletReserveSol: numberEnv('FLOW_LIVE_MIN_WALLET_RESERVE_SOL', 0.05, { min: 0 }),
    mintCooldownMs: integerEnv('FLOW_LIVE_MINT_COOLDOWN_MS', 10 * 60_000, { min: 0 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_LIVE_MAX_ENTRY_PRICE_JUMP_PCT', 10, {
      min: 0,
      max: 100,
    }),
    buySlippagePct: numberEnv('FLOW_LIVE_BUY_SLIPPAGE_PCT', 10, { min: 0.1, max: 50 }),
    sellSlippagePct: numberEnv('FLOW_LIVE_SELL_SLIPPAGE_PCT', 15, { min: 0.1, max: 50 }),
    computeUnitLimit: integerEnv('FLOW_LIVE_COMPUTE_UNIT_LIMIT', 250_000, {
      min: 100_000,
      max: 1_400_000,
    }),
    priorityFeeSol: numberEnv('FLOW_LIVE_PRIORITY_FEE_SOL', 0.0005, { min: 0 }),
    // The transaction stream is processed-level. Quote against the same newest view,
    // but retain confirmed-level finality for position state and reconciliation.
    readCommitment: process.env.FLOW_LIVE_READ_COMMITMENT || 'processed',
    confirmationCommitment: process.env.FLOW_LIVE_CONFIRMATION_COMMITMENT
      || process.env.FLOW_LIVE_COMMITMENT
      || 'confirmed',
    contextSlotRetryCount: integerEnv('FLOW_LIVE_CONTEXT_SLOT_RETRIES', 2, {
      min: 0,
      max: 10,
    }),
    contextSlotRetryDelayMs: integerEnv('FLOW_LIVE_CONTEXT_SLOT_RETRY_DELAY_MS', 25, {
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
    entryReconcileCount: integerEnv('FLOW_LIVE_ENTRY_RECONCILE_COUNT', 5, {
      min: 1,
      max: 30,
    }),
    entryReconcileDelayMs: integerEnv('FLOW_LIVE_ENTRY_RECONCILE_DELAY_MS', 1_000, {
      min: 100,
      max: 30_000,
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
        id: 'post_gd25_35_xleg',
        label: '毕业后深跌反弹 · XLEG',
        enabled: booleanEnv('FLOW_LIVE_POST_GD25_35_XLEG_ENABLED', true),
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv('FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL', 1),
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
    ex…12338 tokens truncated…护 / +15%激活 / 回撤12.5%', exitMode: 'TRAILING',
        minHoldMs: 10_000, trailingActivationPct: 15, trailingStopPct: 12.5,
        hardStopPct: 20, maxHoldMs: 180_000,
      },
      {
        id: 'FLOW', label: '10秒保护 / 3秒订单流转弱', exitMode: 'FLOW_FADE',
        minHoldMs: 10_000, minSellBuyRatio: 1.2, maxNetFlowSol: -2,
        hardStopPct: 20, maxHoldMs: 180_000,
      },
      {
        id: 'RUNNER', label: '15秒保护 / +20%激活 / 自适应尾仓',
        exitMode: 'ADAPTIVE_TRAILING', minHoldMs: 15_000, trailingActivationPct: 20,
        hardStopPct: 25, maxHoldMs: 300_000,
        trailingTiers: [
          { belowPct: 50, stopPct: 12.5 },
          { belowPct: 100, stopPct: 20 },
          { belowPct: Infinity, stopPct: 25 },
        ],
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
    enabled: booleanEnv('FLOW_RANGE_SCALPER_SHADOW_ENABLED', true),
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
    enabled: booleanEnv('FLOW_HOLDER_GROWTH_SHADOW_ENABLED', true),
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
    exitTimeoutMs: integerEnv('FLOW_HOLDER_GROWTH_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
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
    ],
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
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: shadowPositionEnv('FLOW_HOLDER_GROWTH_POSITION_SOL'),
    }),
  },

  // Observer-only Launch Quality research. Reference percentages label market
  // structure for later analysis; they never become an entry or execution rule.
  launchQualityObserver: {
    enabled: booleanEnv('FLOW_LAUNCH_QUALITY_OBSERVER_ENABLED', true),
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

  storage: {
    dbPath: process.env.FLOW_DB_PATH || './data/flow-research.db',
    rawRetentionHours: numberEnv('FLOW_RAW_RETENTION_HOURS', 168, { min: 1 }),
    archiveDir: process.env.FLOW_ARCHIVE_DIR || './data/archive',
    flushMs: integerEnv('FLOW_DB_FLUSH_MS', 250, { min: 25 }),
    flushMax: integerEnv('FLOW_DB_FLUSH_MAX', 1_000, { min: 10 }),
  },

  server: {
    port: integerEnv('FLOW_DASHBOARD_PORT', 3001, { min: 1, max: 65_535 }),
    host: process.env.FLOW_BIND_HOST || '0.0.0.0',
  },
};

// Solana requests priority price per CU, while operators reason about the total
// fee per transaction. Derive one shared buy/sell CU price from the SOL target.
config.liveTrading.priorityFeeMicroLamports = priorityFeeMicroLamports(
  config.liveTrading.priorityFeeSol,
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
  if (config.bondingCurveMomentumShadow.snapshotHorizonsMs.length === 0) {
    errors.push('FLOW_BONDING_MOMENTUM_SNAPSHOT_SECONDS must contain at least one value');
  }
  if (config.liveTrading.enabled && !config.liveTrading.dryRun) {
    if (!config.liveTrading.rpcUrl) errors.push('FLOW_RPC_URL is required for live trading');
    if (!config.liveTrading.privateKey) {
      errors.push('FLOW_LIVE_PRIVATE_KEY is required for live trading');
    }
    if (!process.env.FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL) {
      errors.push('FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL must be explicitly set for live trading');
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

