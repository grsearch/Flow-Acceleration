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
// Holder Growth produced a large, consistently negative entry/exit cross-product.
// Keep the complete historical matrix queryable, but only create new rows for the
// two short fixed-hold controls unless an operator explicitly re-enables the full
// experiment. A new flag is used so an older server .env cannot silently restore
// the 8 x 13 matrix after a normal code upgrade.
const holderGrowthFullMatrixEnabled = booleanEnv(
  'FLOW_HOLDER_GROWTH_FULL_MATRIX_ENABLED',
  false,
);
// Forward-only optimization discovered after repricing historical NO_EXIT rows.
// Keep it independently switchable so old HG30_BAL controls and every
// historical cohort ID remain unchanged.
const holderGrowthStrongFlowEnabled = booleanEnv(
  'FLOW_HOLDER_GROWTH_STRONG_FLOW_ENABLED',
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

// The live strategy used 0.05 SOL as its former deployment default. Treat that
// exact legacy value as inherited so upgrading an existing server moves the
// active strategy to the new 1 SOL size without requiring a manual .env edit.
// Other values remain explicit operator overrides.
function livePositionEnv(name, fallback = 1, legacyName = null) {
  const raw = process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
  if (raw == null || raw === '' || Number(raw) === 0.05) return fallback;
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
        id: 'post_gd25_32_r2_4_age30_xleg_v2',
        label: '毕业后精选深跌反弹 · XLEG-V2',
        ruleVersion: 'post_migration_age30_drop25_32_rebound2_4_xleg_v1',
        enabled: booleanEnv('FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_ENABLED', true),
        entryEnabled: true,
        market: 'PUMP_AMM',
        positionSizeSol: livePositionEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_POSITION_SOL',
          1,
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
        // The executor compares a fresh 1-SOL PumpSwap quote with the signal's
        // reserve price. This blocks both price movement and self-impact above 3%.
        maxEntryPriceJumpPct: numberEnv(
          'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_MAX_ENTRY_JUMP_PCT',
          3,
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
        id: 'post_gd25_35_xleg',
        label: '毕业后深跌反弹 · XLEG（旧版停止新开仓）',
        ruleVersion: 'post_migration_gd25_35_xleg_reentry2_v2',
        enabled: true,
        // Keep the definition loaded so historical rows stay visible and any
        // legacy active position still has its original exit rules after restart.
        entryEnabled: false,
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
    enabled: booleanEnv('FLOW_SMART_PULLBACK_SHADOW_ENABLED', true),
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
    enabled: booleanEnv('FLOW_SMART_CONFIRM_SHADOW_ENABLED', true),
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

  // Independent first-pullback execution research. References are emitted by
  // LaunchQualityObserver, but every simulated position lives in its own table.
  launchPullbackShadow: {
    enabled: booleanEnv('FLOW_LAUNCH_PULLBACK_SHADOW_ENABLED', true),
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

  // Independent early Bonding Curve research derived from the observed CYA
  // wallet pattern. It uses public order flow only and never follows, signs,
  // or sends the monitored wallet's transactions.
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
    positionSizeSol: shadowPositionEnv('FLOW_MIGRATED_REBOUND_POSITION_SOL'),
    entryDelayMs: integerEnv('FLOW_MIGRATED_REBOUND_ENTRY_DELAY_MS', 200, { min: 0 }),
    entryTimeoutMs: integerEnv('FLOW_MIGRATED_REBOUND_ENTRY_TIMEOUT_MS', 2_000, {
      min: 1,
    }),
    exitDelayMs: integerEnv('FLOW_MIGRATED_REBOUND_EXIT_DELAY_MS', 200, { min: 0 }),
    exitTimeoutMs: integerEnv('FLOW_MIGRATED_REBOUND_EXIT_TIMEOUT_MS', 5_000, {
      min: 1,
    }),
    maxEntryPriceJumpPct: numberEnv('FLOW_MIGRATED_REBOUND_MAX_ENTRY_JUMP_PCT', 15, {
      min: 0,
      max: 100,
    }),
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
    ],
    exitProfiles: [
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
        entryProfileIds: ['GE30_D25_32_R24_F1'],
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
    enabled: booleanEnv('FLOW_MIGRATION_CONTINUITY_SHADOW_ENABLED', true),
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
        hardStopPct: 20, maxHoldMs: 60_000,
      },
      {
        id: 'E120', label: '固定120秒', exitMode: 'FIXED_HOLD', fixedHoldMs: 120_000,
        hardStopPct: 20, maxHoldMs: 120_000,
      },
      {
        id: 'T10', label: '5秒保护 / +10%激活 / 回撤10%', exitMode: 'TRAILING',
        minHoldMs: 5_000, trailingActivationPct: 10, trailingStopPct: 10,
        hardStopPct: 20, maxHoldMs: 120_000,
      },
      {
        id: 'T12_5', label: '10秒保护 / +15%激活 / 回撤12.5%', exitMode: 'TRAILING',
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
        exitProfileIds: holderGrowthFullMatrixEnabled ? null : ['X5_FIXED', 'X15_FIXED'],
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
    ].filter((profile) => holderGrowthFullMatrixEnabled
      || profile.id === 'HG30_BAL'
      || (holderGrowthStrongFlowEnabled && [
        'HG30_NB20_NF25',
        'HG30_RB15_NF25',
        'HG30_B80_NF25',
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
      || ['X5_FIXED', 'X15_FIXED'].includes(profile.id)
      || (holderGrowthStrongFlowEnabled
        && ['X12_FIXED', 'X18_FIXED', 'X15_R20'].includes(profile.id))),
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
    if (!process.env.FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_POSITION_SOL
      && !process.env.FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL) {
      errors.push(
        'FLOW_LIVE_POST_GD25_32_R2_4_AGE30_XLEG_V2_POSITION_SOL must be explicitly set for live trading (the legacy XLEG size is accepted during migration)',
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
