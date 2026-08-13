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
    label: 'FD10-R3 Â· å›žè¸©10% / åå¼¹3% / ç¨³å®š0.5ç§’',
    pullbackPct: numberEnv('FLOW_LAUNCH_DEEP_D10_R3_PULLBACK_PCT', 10, {
      min: 0.1, max: 100,
    }),
    reboundPct: numberEnv('FLOW_LAUNCH_DEEP_D10_R3_REBOUND_PCT', 3, { min: 0 }),
    lowStableMs: integerEnv('FLOW_LAUNCH_DEEP_D10_R3_LOW_STABLE_MS', 500, { min: 0 }),
  },
  {
    id: 'DEEP_D12_5_R3',
    cohortId: 'FD12_5_R3_5S',
    label: 'FD12.5-R3 Â· å›žè¸©12.5% / åå¼¹3% / ç¨³å®š0.5ç§’',
    pullbackPct: numberEnv('FLOW_LAUNCH_DEEP_D12_5_R3_PULLBACK_PCT', 12.5, {
      min: 0.1, max: 100,
    }),
    reboundPct: numberEnv('FLOW_LAUNCH_DEEP_D12_5_R3_REBOUND_PCT', 3, { min: 0 }),
    lowStableMs: integerEnv('FLOW_LAUNCH_DEEP_D12_5_R3_LOW_STABLE_MS', 500, { min: 0 }),
  },
  {
    id: 'DEEP_D12_5_R5',
    cohortId: 'FD12_5_R5_5S',
    label: 'FD12.5-R5 Â· å›žè¸©12.5% / åå¼¹5% / ç¨³å®š1ç§’',
    pullbackPct: numberEnv('FLOW_LAUNCH_DEEP_D12_5_R5_PULLBACK_PCT', 12.5, {
      min: 0.1, max: 100,
    }),
    reboundPct: numberEnv('FLOW_LAUNCH_DEEP_D12_5_R5_REBOUND_PCT', 5, { min: 0 }),
    lowStableMs: integerEnv('FLOW_LAUNCH_DEEP_D12_5_R5_LOW_STABLE_MS', 1_000, { min: 0 }),
  },
  {
    id: 'DEEP_D15_R5',
    cohortId: 'FD15_R5_5S',
    label: 'FD15-R5 Â· å›žè¸©15% / åå¼¹5% / ç¨³å®š1ç§’',
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
      maxRatio: numberEnv('FLOW_L×]´æÚ$z{-®éÜj×Ö„VçG'•&–6T§V×7C¢çVÖ&W$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEôÔ…ôTåE%•ô¥TÕõ5BrÂÂ°Ð¢Ö–ã¢ÀÐ¢Öƒ¢ÀÐ¢Ò’ÀÐ¢†&E7F÷7C¢çVÖ&W$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEô„$Eõ5Dõõ5BrÂ3Â°Ð¢Ö–ã¢ãÀÐ¢Öƒ¢ÀÐ¢Ò’ÀÐ¢6öçG&öÅG&–Æ–æu7F÷7C¢çVÖ&W$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEô“õE$”Ä”äuõ5Dõõ5BrÂrãRÂ°Ð¢Ö–ã¢ãÀÐ¢Öƒ¢ÀÐ¢Ò’ÀÐ¢6öçG&öÄÖ„†öÆD×3¢–çFVvW$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEô“ôÔ…ô„ôÄEôÕ2rÂcóÂ°Ð¢Ö–ã¢óÀÐ¢Ò’ÀÐ¢Ö„†öÆD×3¢–çFVvW$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEôÔ…ô„ôÄEôÕ2rÂ#óÂ°Ð¢Ö–ã¢óÀÐ¢Ò’ÀÐ¢f—'7D6†V6·ö–çEF–ÖV÷WD×3¢–çFVvW$Vçb€Ð¢tdÄõuôu$ETD”ôåô„ôÄEôd•%5Eô4„T4µô”åEõD”ÔTõUEôÕ2rÀÐ¢#óÀÐ¢²Ö–ã¢óÒÀÐ¢’ÀÐ¢7FWF–ÖV÷WD×3¢–çFVvW$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEõ5DUõD”ÔTõUEôÕ2rÂ5óÂ°Ð¢Ö–ã¢#SÀÐ¢Ò’ÀÐ¢w&GVF–öåF–ÖV÷WD×3¢–çFVvW$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEôu$ETD”ôåõD”ÔTõUEôÕ2rÂUóÂ°Ð¢Ö–ã¢óÀÐ¢Ò’ÀÐ¢ÖÔW†—DFVÆ”×3¢–çFVvW$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEô“%ôÔÕôU„•EôDTÄ•ôÕ2rÂUóÂ°Ð¢Ö–ã¢ÀÐ¢Ò’ÀÐ¢'&–FvTÖ–ä'W–W'3S¢–çFVvW$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEô“%ôÔ”åô%U”U%5óU2rÂ"Â°Ð¢Ö–ã¢ÀÐ¢Ò’ÀÐ¢'&–FvTÖ„7V×VÆF—fUG&FW3¢–çFVvW$Vçb€Ð¢tdÄõuôu$ETD”ôåô„ôÄEô“%ôÔ…ô5TÕTÄD•dUõE$DU2rÀÐ¢#ÀÐ¢²Ö–ã¢ÒÀÐ¢’ÀÐ¢6†V6·ö–çG3¢³sÂƒÂƒRÂ“Â“RÂ“uÒÀÐ¢6†V6·ö–çE'VÆW3¢°Ð¢°Ð¢F‡&W6†öÆE7C¢sÀÐ¢Ö–äæWDfÆ÷sU6öÃ¢ÀÐ¢Ö–ä'W–W'3S¢2ÀÐ¢Ö…6VÆÅ6öÃS¢ÀÐ¢Ö–ä7W'fTFVÇFS¢RÀÐ¢ÒÀÐ¢°Ð¢F‡&W6†öÆE7C¢ƒÀÐ¢Ö–äæWDfÆ÷sU6öÃ¢ÀÐ¢Ö–ä'W–W'3S¢ÀÐ¢Ö…6VÆÅ6öÃS¢çVÆÂÀÐ¢Ö–ä7W'fTFVÇFS¢RÀÐ¢ÒÀÐ¢°Ð¢F‡&W6†öÆE7C¢ƒRÀÐ¢Ö–äæWDfÆ÷sU6öÃ¢ÀÐ¢Ö–ä'W–W'3S¢ÀÐ¢Ö…6VÆÅ6öÃS¢çVÆÂÀÐ¢Ö–ä7W'fTFVÇFS¢RÀÐ¢ÒÀÐ¢°Ð¢F‡&W6†öÆE7C¢“ÀÐ¢Ö–äæWDfÆ÷sU6öÃ¢ÀÐ¢Ö–ä'W–W'3S¢BÀÐ¢Ö…6VÆÅ6öÃS¢çVÆÂÀÐ¢Ö–ä7W'fTFVÇFS¢RÀÐ¢ÒÀÐ¢°Ð¢F‡&W6†öÆE7C¢“RÀÐ¢Ö–äæWDfÆ÷sU6öÃ¢ÀÐ¢Ö–ä'W–W'3S¢BÀÐ¢Ö…6VÆÅ6öÃS¢çVÆÂÀÐ¢Ö–ä7W'fTFVÇFS¢RÀÐ¢ÒÀÐ¢ÒÀÐ¢6ö†÷'G3¢°Ð¢°Ð¢–C¢t“rÀÐ¢Æ&VÃ¢t“+rV&Ç’VçG'žz{¾XªŽjÚ.y¸ŽZûžxZrrÀÐ¢W†—DÖöFS¢t4ôåE$ôÅõE$”Ä”ärrÀÐ¢ÒÀÐ¢°Ð¢–C¢t“rÀÐ¢Æ&VÃ¢t“+rjh.xè~j8iú^x+’ò“r^jù^K‰®X˜Þ˜X{¢rÀÐ¢W†—DÖöFS¢u$Uôu$Eô4„T4µô”åE2rÀÐ¢ÒÀÐ¢°Ð¢–C¢t“"rÀÐ¢Æ&VÃ¢t“"+rKŠ^jÎjh.xè~j8iú^x+’òz›þ‹h®jù^K‰¢rÀÐ¢W†—DÖöFS¢uD…$õTt…ôu$ETD”ôârÀÐ¢ÒÀÐ¢ÒÀÐ¢&–uv–ææW%7C¢çVÖ&W$Vçb‚tdÄõuôu$ETD”ôåô„ôÄEô$”uõt”ääU%õ5BrÂSÂ²Ö–ã¢Ò’ÀÐ¢6÷7DÖöFVÃ¢æ÷&ÖÆ—¦T6÷7DÖöFVÂ‡°Ð¢ââæÆ&VÄ6÷7DÖöFVÂÀÐ¢÷6—F–öå6—¦U6öÃ¢6†F÷u÷6—F–öäVçb‚tdÄõuôu$ETD”ôåô„ôÄEõõ4•D”ôåõ4ôÂr’ÀÐ¢Ò’ÀÐ¢ÒÀÐ Ð¢òòÆ–fV7–6ÆR÷fW'6öÆB×&V&÷VæB&W6V&6‚â&RÖÖ–w&F–öâ7W'fRG&FW2æBF†PÐ¢òò÷7BÖÖ–w&F–öâV×7v7V'67&—F–öâW6R6W&FR6ö†÷'G3²&öf–ÆW2&VÆ÷pÐ¢òò&R÷'F†övöæÂöæÆ–æRW‡W&–ÖVçG2æBæWfW"7&VFR÷"6–vâG&ç67F–öâàÐ¢Ö–w&FVDG&÷&V&÷VæE6†F÷s¢°Ð¢Væ&ÆVC¢&ööÆVäVçb‚tdÄõuôÔ”u$DTEõ$T$õTäEõ4„DõuôTä$ÄTBrÂG'VR’ÀÐ¢Æ–fV7–6ÆU7FvW3¢°Ð¢²–C¢uõ5EôÔ”u$D”ôârÂÆ&VÃ¢~jù^K‰®YârÂÖ&¶WC¢uTÕôÔÒrÒÀÐ¢ÒÀÐ¢7FFU&WFVçF–öä×3¢–çFVvW$Vçb‚tdÄõuõ$T$õTäEôDUDT5Dõ%õ5DDUõ$UDTåD”ôåôÕ2rÂcóÂ°Ð¢Ö–ã¢UóÀÐ¢Öƒ¢¢cóÀÐ¢Ò’ÀÐ¢G&6¶–ætvT×3¢ÖF‚æÖ–âƒ#óÂ–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEõE$4´”äuôÕ2rÂ#óÂ°Ð¢Ö–ã¢3óÀÐ¢Öƒ¢3¢cóÀÐ¢Ò’’ÀÐ¢÷6—F–öå6—¦U6öÃ¢6†F÷u÷6—F–öäVçb‚tdÄõuôÔ”u$DTEõ$T$õTäEõõ4•D”ôåõ4ôÂr’ÀÐ¢VçG'”FVÆ”×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôTåE%•ôDTÄ•ôÕ2rÂ#Â²Ö–ã¢Ò’ÀÐ¢VçG'•F–ÖV÷WD×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôTåE%•õD”ÔTõUEôÕ2rÂ%óÂ°Ð¢Ö–ã¢ÀÐ¢Ò’ÀÐ¢W†—DFVÆ”×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôU„•EôDTÄ•ôÕ2rÂ#Â²Ö–ã¢Ò’ÀÐ¢W†—EF–ÖV÷WD×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôU„•EõD”ÔTõUEôÕ2rÂUóÂ°Ð¢Ö–ã¢ÀÐ¢Ò’ÀÐ¢Ö„VçG'•&–6T§V×7C¢çVÖ&W$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôÔ…ôTåE%•ô¥TÕõ5BrÂRÂ°Ð¢Ö–ã¢ÀÐ¢Öƒ¢ÀÐ¢Ò’ÀÐ¢ÖÕ&–6T6öçF–çV—G“¢°Ð¢Ö–å&F–ó¢çVÖ&W$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôÔÕõ$”4UôÔ”åõ$D”òrÂã"Â°Ð¢Ö–ã¢ãÀÐ¢Öƒ¢ÀÐ¢Ò’ÀÐ¢Ö…&F–ó¢çVÖ&W$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôÔÕõ$”4UôÔ…õ$D”òrÂRÂ°Ð¢Ö–ã¢ÀÐ¢Ò’ÀÐ¢&W6WDgFW$×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôÔÕõ$”4Uõ$U4UEôÕ2rÂUóÂ°Ð¢Ö–ã¢óÀÐ¢Ò’ÀÐ¢6öæf—&ÖF–öåG&FW3¢–çFVvW$Vçb€Ð¢tdÄõuôÔ”u$DTEõ$T$õTäEôÔÕõ$”4Uô4ôäd•$ÔD”ôåõE$DU2rÀÐ¢"ÀÐ¢²Ö–ã¢"ÂÖƒ¢ÒÀÐ¢’ÀÐ¢6öæf—&ÖF–öåv–æF÷t×3¢–çFVvW$Vçb€Ð¢tdÄõuôÔ”u$DTEõ$T$õTäEôÔÕõ$”4Uô4ôäd•$ÔD”ôåõt”äDõuôÕ2rÀÐ¢%óÀÐ¢²Ö–ã¢ÂÖƒ¢3óÒÀÐ¢’ÀÐ¢6öæf—&ÖF–öåFöÆW&æ6U7C¢çVÖ&W$Vçb€Ð¢tdÄõuôÔ”u$DTEõ$T$õTäEôÔÕõ$”4Uô4ôäd•$ÔD”ôåõDôÄU$ä4Uõ5BrÀÐ¢#ÀÐ¢²Ö–ã¢ãÂÖƒ¢ÒÀÐ¢’ÀÐ¢ÒÀÐ¢&–uv–ææW%7C¢çVÖ&W$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEô$”uõt”ääU%õ5BrÂSÂ²Ö–ã¢Ò’ÀÐ¢VçG'•&öf–ÆW3¢°Ð¢°Ð¢–C¢ttC#Uó3RrÀÐ¢Æ&VÃ¢~k{‹xÃ#^(	33RRrÀÐ¢v–æF÷t×3¢óÀÐ¢G&÷Ö–å7C¢#RÀÐ¢G&÷Ö…7C¢3RÀÐ¢&V&÷VæDÖ–å7C¢"ÀÐ¢&V&÷VæDÖ…7C¢RÀÐ¢&V&÷VæEF–ÖV÷WD×3¢óÀÐ¢ÒÀÐ¢ÒÀÐ¢W†—E&öf–ÆW3¢°Ð¢°Ð¢–C¢uƒ2rÀÐ¢Æ&VÃ¢~Y»®Zé®hÈiÈ“>zy"rÀÐ¢W†—DÖöFS¢td•„TEô„ôÄBrÀÐ¢f—†VD†öÆD×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEô„ôÄEó55ôÕ2rÂ5óÂ²Ö–ã¢#SÒ’ÀÐ¢ÒÀÐ¢°Ð¢–C¢uƒ‚rÀÐ¢Æ&VÃ¢~Y»®Zé®hÈiÈ“Žzy"rÀÐ¢W†—DÖöFS¢td•„TEô„ôÄBrÀÐ¢f—†VD†öÆD×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEô„ôÄEó…5ôÕ2rÂ…óÂ²Ö–ã¢#SÒ’ÀÐ¢ÒÀÐ¢°Ð¢–C¢u„ÄTrrÀÐ¢Æ&VÃ¢~iz~x˜‚³‚^køkK²òY¹îi*C2Rò^zy.XYÎ[©RrÀÐ¢W†—DÖöFS¢tÄTt5’rÀÐ¢G&–Æ–æt7F—fF–öå7C¢çVÖ&W$Vçb€Ð¢tdÄõuôÔ”u$DTEõ$T$õTäEôÄTt5•õE$”Ä”äuô5D•dD”ôåõ5BrÀÐ¢‚ÀÐ¢²Ö–ã¢ãÂÖƒ¢óÒÀÐ¢’ÀÐ¢G&–Æ–æu7F÷7C¢çVÖ&W$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôÄTt5•õE$”Ä”äuõ5Dõõ5BrÂ2Â°Ð¢Ö–ã¢ãÀÐ¢Öƒ¢ÀÐ¢Ò’ÀÐ¢f7EF¶U&öf—E7C¢çVÖ&W$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôÄTt5•ôd5EõEõ5BrÂ‚Â°Ð¢Ö–ã¢ÀÐ¢Öƒ¢óÀÐ¢Ò’ÀÐ¢f7EF¶U&öf—Ev–æF÷t×3¢–çFVvW$Vçb€Ð¢tdÄõuôÔ”u$DTEõ$T$õTäEôÄTt5•ôd5EõEõt”äDõuôÕ2rÀÐ¢UóÀÐ¢²Ö–ã¢ÒÀÐ¢’ÀÐ¢Æ÷746†V6´D×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôÄTt5•ôÄõ55ô4„T4µôÕ2rÂeóÂ°Ð¢Ö–ã¢ÀÐ¢Ò’ÀÐ¢Ö„†öÆD×3¢–çFVvW$Vçb‚tdÄõuôÔ”u$DTEõ$T$õTäEôÄTt5•ôÔ…ô„ôÄEôÕ2rÂUóÂ°Ð¢Ö–ã¢óÀÐ¢Ò’ÀÐ¢ÒÀÐ¢ÒÀÐ¢6÷7DÖöFVÃ¢æ÷&ÖÆ—¦T6÷7DÖöFVÂ‡°Ð¢ââæÆ&VÄ6÷7DÖöFVÂÀÐ¢÷6—F–öå6—¦U6öÃ¢6†F÷u÷6—F–öäVçb‚tdÄõuôÔ”u$DTEõ$T$õTäEõõ4•D”ôåõ4ôÂr’ÀÐ¢Ò’ÀÐ¢ÒÀÐ Ð¢òò–æFWVæFVçB÷7BÖÖ–w&F–öâ&ævR×&Vv–ÖR&W6V&6‚âWfW'’w&GVF–öâ&V6V—fW0Ð¢òò6†÷'BV×7vö'6W'fF–öâv–æF÷s²öæÇ’VÆ–f–VB÷66–ÆÆF–ærÖ&¶WG2¶VW Ð¢òòF†RW‡FVæFVB7V'67&—F–öââF†—27V—FRæWfW"÷vç26–væW"÷"W†V7WF÷"àÐ¢&ævU66ÇW%6†F÷s¢°Ð¢Væ&ÆVC¢&ööÆVäVçb‚tdÄõuõ$ätUõ44ÅU%õ4„DõuôTä$ÄTBrÂG'VR’ÀÐ¢÷6—F–öå6—¦U6öÃ¢6†F÷u÷6—F–öäVçb‚tdÄõuõ$ätUõ44ÅU%õõ4•D”ôåõ4ôÂr’ÀÐ¢–æ—F–Äö'6W'fF–öä×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ô”ä•D”Åôô%4U%dD”ôåôÕ2rÂ#óÂ°Ð¢Ö–ã¢3óÀÐ¢Öƒ¢¢cóÀÐ¢Ò’ÀÐ¢Ö…G&6¶–æt×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ…õE$4´”äuôÕ2rÂ#¢cóÂ°Ð¢Ö–ã¢#óÀÐ¢Öƒ¢c¢cóÀÐ¢Ò’ÀÐ¢v–æF÷t×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%õt”äDõuôÕ2rÂcóÂ°Ð¢Ö–ã¢óÀÐ¢Öƒ¢R¢cóÀÐ¢Ò’ÀÐ¢&V6VçDfÆ÷uv–æF÷t×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%õ$T4TåEôdÄõuôÕ2rÂóÂ°Ð¢Ö–ã¢#SÀÐ¢Öƒ¢óÀÐ¢Ò’ÀÐ¢&ævTÆ÷746öæf—&Ô×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%õ$ätUôÄõ55ô4ôäd•$ÕôÕ2rÂ3óÂ°Ð¢Ö–ã¢óÀÐ¢Öƒ¢R¢cóÀÐ¢Ò’ÀÐ¢Vç7V'67&–&Tw&6T×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%õTå5T%45$”$Uôu$4UôÕ2rÂUóÂ°Ð¢Ö–ã¢ÀÐ¢Öƒ¢cóÀÐ¢Ò’ÀÐ¢Ö–åG&FW3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ”åõE$DU2rÂcÂ²Ö–ã¢RÒ’ÀÐ¢Ö–åföÇVÖU6öÃ¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ”åõdôÅTÔUõ4ôÂrÂ#Â²Ö–ã¢Ò’ÀÐ¢Ö–åVæ—VUvÆÆWG3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ”åõTä•TUõtÄÄUE2rÂ#Â²Ö–ã¢"Ò’ÀÐ¢Ö–ä'W•6†&U7C¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ”åô%U•õ4„$Uõ5BrÂ3RÂ°Ð¢Ö–ã¢ÂÖƒ¢ÀÐ¢Ò’ÀÐ¢Ö„'W•6†&U7C¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ…ô%U•õ4„$Uõ5BrÂcRÂ°Ð¢Ö–ã¢ÂÖƒ¢ÀÐ¢Ò’ÀÐ¢Ö–å&ævU7C¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ”åõ$ätUõ5BrÂ"Â²Ö–ã¢ãÒ’ÀÐ¢Ö„Vff–6–Væ7•&F–ó¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ…ôTdd”4”Tä5•õ$D”òrÂã3RÂ°Ð¢Ö–ã¢ãÂÖƒ¢ÀÐ¢Ò’ÀÐ¢Ö–äÖVä7&÷76W3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ”åôÔTåô5$õ54U2rÂBÂ²Ö–ã¢Ò’ÀÐ¢Ö…F÷vÆÆWE6†&U7C¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ…õDõõtÄÄUEõ4„$Uõ5BrÂ#RÂ°Ð¢Ö–ã¢ãÂÖƒ¢ÀÐ¢Ò’ÀÐ¢Ö…G&VæE7C¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ…õE$TäEõ5BrÂ"Â²Ö–ã¢ãÒ’ÀÐ¢Ö–å&ævU66÷&S¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ”åõ$ätUõ44õ$RrÂcRÂ°Ð¢Ö–ã¢ÂÖƒ¢ÀÐ¢Ò’ÀÐ¢VçG'”FVÆ”×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ôTåE%•ôDTÄ•ôÕ2rÂ#Â²Ö–ã¢Ò’ÀÐ¢VçG'•F–ÖV÷WD×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ôTåE%•õD”ÔTõUEôÕ2rÂ%óÂ²Ö–ã¢Ò’ÀÐ¢W†—DFVÆ”×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ôU„•EôDTÄ•ôÕ2rÂ#Â²Ö–ã¢Ò’ÀÐ¢W†—EF–ÖV÷WD×3¢–çFVvW$Vçb‚tdÄõuõ$ätUõ44ÅU%ôU„•EõD”ÔTõUEôÕ2rÂUóÂ²Ö–ã¢Ò’ÀÐ¢Ö„VçG'•&–6T§V×7C¢çVÖ&W$Vçb‚tdÄõuõ$ätUõ44ÅU%ôÔ…ôTåE%•ô¥TÕõ5BrÂ2Â°Ð¢Ö–ã¢ÂÖƒ¢ÀÐ¢Ò’ÀÐ¢VçG'•&öf–ÆW3¢°Ð¢°Ð¢–C¢t¤rÀÐ¢Æ&VÃ¢t¤+rø2Xþzk²²"RXøÞ[Ë’rÀÐ¢FWf–F–öå6–vÖ¢ÀÐ¢&V&÷VæE7C¢"ÀÐ¢&V&÷VæEF–ÖV÷WD×3¢UóÀÐ¢ÒÀÐ¢°Ð¢–C¢t¤"rÀÐ¢Æ&VÃ¢t¤"+rã\ø2Xþzk²²jÚ>XxkXXZRrÀÐ¢FWf–F–öå6–vÖ¢ãRÀÐ¢&V&÷VæE7C¢"ÀÐ¢&V&÷VæEF–ÖV÷WD×3¢UóÀÐ¢Ö–å&V6VçDæWDfÆ÷u6öÃ¢ãÀÐ¢ÒÀÐ¢°Ð¢–C¢t¤2rÀÐ¢Æ&VÃ¢t¤2+rKˆ¾‹ÚŽXøÞ[Ë’²XÙnXè¾ŠXxòrÀÐ¢FWf–F–öå6–vÖ¢ÀÐ¢&V&÷VæE7C¢"ÀÐ¢&V&÷VæEF–ÖV÷WD×3¢UóÀÐ¢Ö–å&V6VçD'W–W'3¢"ÀÐ¢Ö…6VÆÄFV6•&F–ó¢ãRÀÐ¢ÒÀÐ¢ÒÀÐ¢W†—E&öf–ÆW3¢°Ð¢°Ð¢–C¢u„ÒrÂÆ&VÃ¢u„Ò+rY¹î[Ù.KŠÞ‹ÛBrÂW†—DÖöFS¢tÔ”DÄ”äRrÀÐ¢†&E7F÷7C¢‚ÂÖ„†öÆD×3¢#óÀÐ¢ÒÀÐ¢°Ð¢–C¢uƒbrÂÆ&VÃ¢uƒb+rY»®Zé¢³bRrÂW†—DÖöFS¢uD´Uõ$ôd•BrÀÐ¢F¶U&öf—E7C¢bÂ†&E7F÷7C¢‚ÂÖ„†öÆD×3¢#óÀÐ¢ÒÀÐ¢°Ð¢–C¢u„"rÂÆ&VÃ¢u„"+rKˆ®‹ÚŽ˜X{¢rÂW†—DÖöFS¢uUU%ô$äBrÀÐ¢†&E7F÷7C¢‚ÂÖ„†öÆD×3¢3óÀÐ¢ÒÀÐ¢°Ð¢–C¢u„brÂÆ&VÃ¢u„b+rKŠÞ‹ÛNK‰N‹XN˜yXøÞ‹ÚÂrÂW†—DÖöFS¢tdÄõuõ$UdU%4ÂrÀÐ¢†&E7F÷7C¢‚ÂÖ„†öÆD×3¢3óÀÐ¢ÒÀÐ¢ÒÀÐ¢6÷7DÖöFVÃ¢æ÷&ÖÆ—¦T6÷7DÖöFVÂ‡°Ð¢ââæÆ&VÄ6÷7DÖöFVÂÀÐ¢÷6—F–öå6—¦U6öÃ¢6†F÷u÷6—F–öäVçb‚tdÄõuõ$ätUõ44ÅU%õõ4•D”ôåõ4ôÂr’ÀÐ¢Ò’ÀÐ¢ÒÀÐ Ð¢òòö'6W'fW"ÖöæÇ’ÆVæ6‚VÆ—G’&W6V&6‚â&VfW&Væ6RW&6VçFvW2Æ&VÂÖ&¶W@Ð¢òò7G'V7GW&Rf÷"ÆFW"æÇ—6—3²F†W’æWfW"&V6öÖRâVçG'’÷"W†V7WF–öâ'VÆRàÐ¢ÆVæ6…VÆ—G”ö'6W'fW#¢°Ð¢Væ&ÆVC¢&ööÆVäVçb‚tdÄõuôÄTä4…õTÄ•E•ôô%4U%dU%ôTä$ÄTBrÂG'VR’ÀÐ¢6æ6†÷D†÷&—¦öç4×3¢Ö–ÆÆ—6V6öæDÆ—7DVçb€Ð¢tdÄõuôÄTä4…õTÄ•E•õ4ä4„õEõ4T4ôäE2rÀÐ¢³RÂÂ#Â3ÂcÒÀÐ¢’ÀÐ¢Ö„ÆVæ6„vT×3¢–çFVvW$Vçb‚tdÄõuôÄTä4…õTÄ•E•ôÔ…ôtUôÕ2rÂ“óÂ°Ð¢Ö–ã¢3óÀÐ¢Öƒ¢¢cóÀÐ¢Ò’ÀÐ¢V×&VfW&Væ6U7C¢çVÖ&W$Vçb‚tdÄõuôÄTä4…õTÄ•E•õTÕõ$TdU$Tä4Uõ5BrÂ#RÂ°Ð¢Ö–ã¢ãÀÐ¢Öƒ¢óÀÐ¢Ò’ÀÐ¢VÆÆ&6µ&VfW&Væ6U7C¢çVÖ&W$Vçb€Ð¢tdÄõuôÄTä4…õTÄ•E•õTÄÄ$4µõ$TdU$Tä4Uõ5BrÀÐ¢rãRÀÐ¢²Ö–ã¢ãÂÖƒ¢ÒÀÐ¢’ÀÐ¢&V&÷VæE&VfW&Væ6U7C¢çVÖ&W$Vçb€Ð¢tdÄõuôÄTä4…õTÄ•E•õ$T$õTäEõ$TdU$Tä4Uõ5BrÀÐ¢2ÀÐ¢²Ö–ã¢ÂÖƒ¢óÒÀÐ¢’ÀÐ¢FVW&VfW&Væ6U&öf–ÆW3¢ÆVæ6„FVWVÆÆ&6µ&öf–ÆW2æÖ‚‡&öf–ÆR’Óâ‡²ââç&öf–ÆRÒ’’ÀÐ¢&V6VçD'W–W%v–æF÷t×3¢–çFVvW$Vçb€Ð¢tdÄõuôÄTä4…õTÄ•E•õ$T4TåEô%U”U%õt”äDõuôÕ2rÀÐ¢óÀÐ¢²Ö–ã¢SÂÖƒ¢cóÒÀÐ¢’ÀÐ¢&WFVçF–öäfÆö÷%7C¢çVÖ&W$Vçb‚tdÄõuôÄTä4…õTÄ•E•õ$UDTåD”ôåôdÄôõ%õ5BrÂÂ°Ð¢Ö–ã¢ÀÐ¢Öƒ¢ÀÐ¢Ò’ÀÐ¢Ö„ö'6W'fF–öäÆt×3¢–çFVvW$Vçb€Ð¢tdÄõuôÄTä4…õTÄ•E•ôÔ…ôô%4U%dD”ôåôÄuôÕ2rÀÐ¢%óÀÐ¢²Ö–ã¢ÂÖƒ¢3óÒÀÐ¢’ÀÐ¢ÒÀÐ Ð¢7F÷&vS¢°Ð¢F%Fƒ¢&ö6W72æVçbädÄõuôD%õD‚ÇÂrâöFFöfÆ÷r×&W6V&6‚æF"rÀÐ¢&u&WFVçF–öä†÷W'3¢çVÖ&W$Vçb‚tdÄõuõ$uõ$UDTåD”ôåô„õU%2rÂc‚Â²Ö–ã¢Ò’ÀÐ¢&6†—fTF—#¢&ö6W72æVçbädÄõuô$4„•dUôD•"ÇÂrâöFFö&6†—fRrÀÐ¢fÇW6„×3¢–çFVvW$Vçb‚tdÄõuôD%ôdÅU4…ôÕ2rÂ#SÂ²Ö–ã¢#RÒ’ÀÐ¢fÇW6„Öƒ¢–çFVvW$Vçb‚tdÄõuôD%ôdÅU4…ôÔ‚rÂóÂ²Ö–ã¢Ò’ÀÐ¢ÒÀÐ Ð¢6W'fW#¢°Ð¢÷'C¢–çFVvW$Vçb‚tdÄõuôD4„$ô$Eõõ%BrÂ3Â²Ö–ã¢ÂÖƒ¢cUóS3RÒ’ÀÐ¢†÷7C¢&ö6W72æVçbädÄõuô$”äEô„õ5BÇÂsãããrÀÐ¢ÒÀÐ§Ó° ¢òò6öÆæ&WVW7G2&–÷&—G’&–6RW"5RÂv†–ÆR÷W&F÷'2&V6öâ&÷WBF†RF÷FÀ¢òòfVRW"G&ç67F–öââFW&—fRöæR6†&VB'W’÷6VÆÂ5R&–6Rg&öÒF†R4ôÂF&vWBà¦6öæf–ræÆ—fUG&F–ærç&–÷&—G”fVTÖ–7&ôÆ×÷'G2Ò&–÷&—G”fVTÖ–7&ôÆ×÷'G2€¢6öæf–ræÆ—fUG&F–ærç&–÷&—G”fVU6öÂÀ¢6öæf–ræÆ—fUG&F–æræ6ö×WFUVæ—DÆ–Ö—BÀ¢“° Ð¦gVæ7F–öâ7G&VÕFö¶Väf÷"†VæGö–çB’°Ð¢–b†6öæf–rç7G&VÒæÆÆVä†&´VæGö–çG2æ†2†VæGö–çB’’&WGW&â6öæf–rç7G&VÒæÆÆVä†&µFö¶VâÇÂVæFVf–æVC°Ð¢&WGW&â6öæf–rç7G&VÒæ†VÆ—W5Fö¶VâÇÂVæFVf–æVC°Ð§ÐÐ Ð¦gVæ7F–öâfÆ–FFT6öæf–r‚’°Ð¢6öç7BW'&÷'2ÒµÓ°Ð¢–b†6öæf–rç7G&VÒæVæGö–çG2æÆVæwF‚ÓÓÒ’°Ð¢W'&÷'2çW6‚‚tÖ—76–ærdÄõuôu%5ôTäEô”åE2÷"„TÄ•U5ôÄ4U%5E$TÕôTäEô”åB…2’r“°Ð¢ÐÐ¢–b†6öæf–rç7G&FVw’ç6–væÅv–æF÷t×2¢2â6öæf–rç7G&FVw’æ'VffW$×2’°Ð¢W'&÷'2çW6‚‚tdÄõuô%TddU%ôÕ2×W7B6÷fW"ÆÂF‡&VR6–væÂv–æF÷w2r“°Ð¢ÐÐ¢–b†6öæf–ræÆVæ6…VÆ—G”ö'6W'fW"ç6æ6†÷D†÷&—¦öç4×2æÆVæwF‚ÓÓÒ’°Ð¢W'&÷'2çW6‚‚tdÄõuôÄTä4…õTÄ•E•õ4ä4„õEõ4T4ôäE2×W7B6öçF–âBÆV7BöæRfÇVRr“°Ð¢ÐÐ¢–b†6öæf–ræ&öæF–æt7W'fTÖöÖVçGVÕ6†F÷rç6æ6†÷D†÷&—¦öç4×2æÆVæwF‚ÓÓÒ’°Ð¢W'&÷'2çW6‚‚tdÄõuô$ôäD”äuôÔôÔTåETÕõ4ä4„õEõ4T4ôäE2×W7B6öçF–âBÆV7BöæRfÇVRr“°Ð¢ÐÐ¢–b†6öæf–ræÆ—fUG&F–æræVæ&ÆVBbb6öæf–ræÆ—fUG&F–æræG'•'Vâ’°Ð¢–b‚6öæf–ræÆ—fUG&F–ærç'5W&Â’W'&÷'2çW6‚‚tdÄõuõ%5õU$Â—2&WV—&VBf÷"Æ—fRG&F–ærr“°Ð¢–b‚6öæf–ræÆ—fUG&F–ærç&—fFT¶W’’°Ð¢W'&÷'2çW6‚‚tdÄõuôÄ•dUõ$•dDUô´U’—2&WV—&VBf÷"Æ—fRG&F–ærr“°Ð¢ÐÐ¢–b‚&ö6W72æVçbädÄõuôÄ•dUõõ5EôtC#Uó3Uõ„ÄTuõõ4•D”ôåõ4ôÂ’°Ð¢W'&÷'2çW6‚‚tdÄõuôÄ•dUõõ5EôtC#Uó3Uõ„ÄTuõõ4•D”ôåõ4ôÂ×W7B&RW‡Æ–6—FÇ’6WBf÷"Æ—fRG&F–ærr“°Ð¢ÐÐ¢ÐÐ¢&WGW&âW'&÷'3°Ð§ÐÐ Ð¦ÖöGVÆRæW‡÷'G2Ò°¢6öæf–rÀÐ¢æ÷&ÖÆ—¦TVæGö–çBÀÐ¢Æ—fUG&F–ætwV&BÀÐ¢6†F÷u÷6—F–öäVçbÀ¢Æ—fU÷6—F–öäVçbÀ¢&–÷&—G”fVTÖ–7&ôÆ×÷'G2À¢fÆ–FFT6öæf–rÀÐ¢7G&VÕFö¶Väf÷"ÀÐ§Ó°Ð