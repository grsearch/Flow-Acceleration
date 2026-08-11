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
    signalVariant: liveEntryThreshold.signalVariant,
    minNetFlowW3Sol: liveEntryThreshold.minNetFlowW3Sol,
    minUniqueBuyersW3: liveEntryThreshold.minUniqueBuyersW3,
    maxSignalAgeMs: integerEnv('FLOW_LIVE_MAX_SIGNAL_AGE_MS', 1_500, { min: 100 }),
    positionSizeSol: numberEnv('FLOW_LIVE_POSITION_SOL', 0.05, { min: 0.000001 }),
    maxConcurrentPositions: integerEnv('FLOW_LIVE_MAX_POSITIONS', 1, { min: 1, max: 20 }),
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
    priorityFeeMicroLamports: integerEnv('FLOW_LIVE_PRIORITY_FEE_MICROLAMPORTS', 20_000, {
      min: 0,
    }),
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
    trailingStopPct: numberEnv('FLOW_LIVE_PRIMARY_TRAILING_STOP_PCT', 7.5, {
      min: 0.1,
      max: 100,
    }),
    maxHoldMs: integerEnv('FLOW_LIVE_PRIMARY_MAX_HOLD_MS', 60_000, { min: 1_000 }),
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
  },

  // Research-only execution path. It never creates or signs a transaction.
  signalShadow: {
    enabled: booleanEnv('FLOW_SIGNAL_SHADOW_ENABLED', true),
    profiles: primaryThresholdProfiles,
    positionSizeSol: numberEnv('FLOW_SIGNAL_SHADOW_POSITION_SOL', 0.05, { min: 0.000001 }),
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
      positionSizeSol: numberEnv('FLOW_SIGNAL_SHADOW_POSITION_SOL', 0.05, {
        min: 0.000001,
      }),
    }),
  },

  // Direct Primary Flow research. Each 30-second signal episode is simulated once
  // per exit cohort; all cohorts share the same 200ms-delayed market fill.
  flowFirstShadow: {
    enabled: booleanEnv('FLOW_FIRST_SHADOW_ENABLED', true),
    signalVariant: 'primary_3w',
    episodeGapMs: 30_000,
    positionSizeSol: numberEnv('FLOW_FIRST_SHADOW_POSITION_SOL', 0.05, { min: 0.000001 }),
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
      positionSizeSol: numberEnv('FLOW_FIRST_SHADOW_POSITION_SOL', 0.05, {
        min: 0.000001,
      }),
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
    positionSizeSol: numberEnv('FLOW_SMART_PULLBACK_POSITION_SOL', 0.05, { min: 0.000001 }),
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
      positionSizeSol: numberEnv('FLOW_SMART_PULLBACK_POSITION_SOL', 0.05, {
        min: 0.000001,
      }),
    }),
  },

  // Isolated true Smart Wallet OPEN research. This path has its own table and
  // never signs or sends a transaction; existing Shadow strategies are unchanged.
  smartOpenShadow: {
    enabled: booleanEnv('FLOW_SMART_OPEN_SHADOW_ENABLED', true),
    minSmartOpenSol: numberEnv('FLOW_SMART_OPEN_SHADOW_MIN_SOL', 1, { min: 0.000001 }),
    preBuyWindowMs: integerEnv('FLOW_SMART_OPEN_SHADOW_PREBUY_WINDOW_MS', 2_000, {
      min: 100,
    }),
    minPreBuyers: integerEnv('FLOW_SMART_OPEN_SHADOW_MIN_PREBUY_BUYERS', 2, { min: 0 }),
    maxEntryPriceJumpPct: numberEnv('FLOW_SMART_OPEN_SHADOW_MAX_ENTRY_JUMP_PCT', 10, {
      min: 0,
      max: 100,
    }),
    positionSizeSol: numberEnv('FLOW_SMART_OPEN_SHADOW_POSITION_SOL', 0.05, {
      min: 0.000001,
    }),
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
      positionSizeSol: numberEnv('FLOW_SMART_OPEN_SHADOW_POSITION_SOL', 0.05, {
        min: 0.000001,
      }),
    }),
  },

  // Independent first-pullback execution research. References are emitted by
  // LaunchQualityObserver, but every simulated position lives in its own table.
  launchPullbackShadow: {
    enabled: booleanEnv('FLOW_LAUNCH_PULLBACK_SHADOW_ENABLED', true),
    positionSizeSol: numberEnv('FLOW_LAUNCH_PULLBACK_SHADOW_POSITION_SOL', 0.05, {
      min: 0.000001,
    }),
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
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: numberEnv('FLOW_LAUNCH_PULLBACK_SHADOW_POSITION_SOL', 0.05, {
        min: 0.000001,
      }),
    }),
  },

  // Lifecycle oversold-rebound research. Pre-migration curve trades and the
  // post-migration PumpSwap subscription use separate cohorts; profiles below
  // are orthogonal online experiments and never create or sign a transaction.
  migratedDropReboundShadow: {
    enabled: booleanEnv('FLOW_MIGRATED_REBOUND_SHADOW_ENABLED', true),
    lifecycleStages: [
      { id: 'PRE_MIGRATION', label: '毕业前', market: 'PUMP_BONDING_CURVE' },
      { id: 'POST_MIGRATION', label: '毕业后', market: 'PUMP_AMM' },
    ],
    stateRetentionMs: integerEnv('FLOW_REBOUND_DETECTOR_STATE_RETENTION_MS', 60_000, {
      min: 5_000,
      max: 10 * 60_000,
    }),
    trackingAgeMs: integerEnv('FLOW_MIGRATED_REBOUND_TRACKING_MS', 5 * 60_000, {
      min: 30_000,
      max: 30 * 60_000,
    }),
    positionSizeSol: numberEnv('FLOW_MIGRATED_REBOUND_POSITION_SOL', 0.05, {
      min: 0.000001,
    }),
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
    bigWinnerPct: numberEnv('FLOW_MIGRATED_REBOUND_BIG_WINNER_PCT', 50, { min: 1 }),
    entryProfiles: [
      {
        id: 'G0',
        label: '基准 1秒 / 跌15–35% / 反弹2–5% / 1秒确认',
        windowMs: 1_000,
        dropMinPct: 15,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
      },
      {
        id: 'GW05',
        label: '窗口0.5秒',
        windowMs: 500,
        dropMinPct: 15,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
      },
      {
        id: 'GW20',
        label: '窗口2秒',
        windowMs: 2_000,
        dropMinPct: 15,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
      },
      {
        id: 'GD15_25',
        label: '浅跌15–25%',
        windowMs: 1_000,
        dropMinPct: 15,
        dropMaxPct: 25,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
      },
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
        id: 'GR3',
        label: '反弹3–5%',
        windowMs: 1_000,
        dropMinPct: 15,
        dropMaxPct: 35,
        reboundMinPct: 3,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
      },
      {
        id: 'GT05',
        label: '0.5秒内反弹',
        windowMs: 1_000,
        dropMinPct: 15,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 500,
      },
      {
        id: 'GT20',
        label: '2秒内反弹',
        windowMs: 1_000,
        dropMinPct: 15,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 2_000,
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
        id: 'XTAIL',
        label: '大赢家尾部 +20%激活 / 回撤10% / 60秒兜底',
        exitMode: 'TAIL',
        hardStopPct: numberEnv('FLOW_MIGRATED_REBOUND_TAIL_HARD_STOP_PCT', 20, {
          min: 0.1,
          max: 100,
        }),
        trailingActivationPct: numberEnv(
          'FLOW_MIGRATED_REBOUND_TAIL_ACTIVATION_PCT',
          20,
          { min: 0.1, max: 1_000 },
        ),
        trailingStopPct: numberEnv('FLOW_MIGRATED_REBOUND_TAIL_STOP_PCT', 10, {
          min: 0.1,
          max: 100,
        }),
        maxHoldMs: integerEnv('FLOW_MIGRATED_REBOUND_TAIL_MAX_HOLD_MS', 60_000, {
          min: 1_000,
        }),
      },
    ],
    costModel: normalizeCostModel({
      ...labelCostModel,
      positionSizeSol: numberEnv('FLOW_MIGRATED_REBOUND_POSITION_SOL', 0.05, {
        min: 0.000001,
      }),
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
  if (config.liveTrading.enabled && !config.liveTrading.dryRun) {
    if (!config.liveTrading.rpcUrl) errors.push('FLOW_RPC_URL is required for live trading');
    if (!config.liveTrading.privateKey) {
      errors.push('FLOW_LIVE_PRIVATE_KEY is required for live trading');
    }
    if (!process.env.FLOW_LIVE_POSITION_SOL) {
      errors.push('FLOW_LIVE_POSITION_SOL must be explicitly set for live trading');
    }
  }
  return errors;
}

module.exports = {
  config,
  normalizeEndpoint,
  liveTradingGuard,
  validateConfig,
  streamTokenFor,
};
