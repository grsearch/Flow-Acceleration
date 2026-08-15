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
   Û]ºÞÚ$z{-®éÜj×ÖöFS¢uD´Uõ$ôd•BrÀÐ¢F¶U&öf—E7C¢bÂ†&E7F÷7C¢‚ÂÖ„†öÆD×3¢#óÀÐ¢ÒÀÐ¢°Ð¢–C¢u„"rÂÆ&VÃ¢u„"+rKˆ®‹ÚŽ˜X{¢rÂW†—DÖöFS¢uUU%ô$äBrÀÐ¢†&E7F÷7C¢‚ÂÖ„†öÆD×3¢3óÀÐ¢ÒÀÐ¢°Ð¢–C¢u„brÂÆ&VÃ¢u„b+rKŠÞ‹ÛNK‰N‹XN˜yXøÞ‹ÚÂrÂW†—DÖöFS¢tdÄõuõ$UdU%4ÂrÀÐ¢†&E7F÷7C¢‚ÂÖ„†öÆD×3¢3óÀÐ¢ÒÀÐ¢ÒÀÐ¢6÷7DÖöFVÃ¢æ÷&ÖÆ—¦T6÷7DÖöFVÂ‡°Ð¢ââæÆ&VÄ6÷7DÖöFVÂÀÐ¢÷6—F–öå6—¦U6öÃ¢6†F÷u÷6—F–öäVçb‚tdÄõuõ$ätUõ44ÅU%õõ4•D”ôåõ4ôÂr’ÀÐ¢Ò’ÀÐ¢ÒÀÐ Ð¢òò–æFWVæFVçBö'6W'fVBÖ†öÆFW"Öw&÷wF‚&W6V&6‚â$†öÆFW'2"†W&RÖVç2vÆÆWG0¢òò6VVâ'W––ærF‡&÷Vv‚F†R6GW&VBV×7W'fR7G&VÓ²—B—2FVÆ–&W&FVÇ’æ÷@¢òò&W6VçFVB2âWF†÷&—FF—fRöâÖ6†–â†öÆFW"6÷VçBà¢†öÆFW$w&÷wF…6†F÷s¢°¢Væ&ÆVC¢&ööÆVäVçb‚tdÄõuô„ôÄDU%ôu$õuD…õ4„DõuôTä$ÄTBrÂG'VR’À¢÷6—F–öå6—¦U6öÃ¢6†F÷u÷6—F–öäVçb‚tdÄõuô„ôÄDU%ôu$õuD…õõ4•D”ôåõ4ôÂr’À¢6æ6†÷D†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…õ4ä4„õEôÕ2rÂ3óÂ°¢Ö–ã¢UóÀ¢Öƒ¢cóÀ¢Ò’À¢Ö…6æ6†÷DÆt×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôÔ…õ4ä4„õEôÄuôÕ2rÂ%óÂ°¢Ö–ã¢À¢Öƒ¢3óÀ¢Ò’À¢VçG'”FVÆ”×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôTåE%•ôDTÄ•ôÕ2rÂ#Â²Ö–ã¢Ò’À¢VçG'•F–ÖV÷WD×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôTåE%•õD”ÔTõUEôÕ2rÂ%óÂ²Ö–ã¢Ò’À¢W†—DFVÆ”×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôU„•EôDTÄ•ôÕ2rÂ#Â²Ö–ã¢Ò’À¢W†—EF–ÖV÷WD×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôU„•EõD”ÔTõUEôÕ2rÂUóÂ²Ö–ã¢Ò’À¢Ö„VçG'•&–6T§V×7C¢çVÖ&W$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôÔ…ôTåE%•ô¥TÕõ5BrÂÂ°¢Ö–ã¢À¢Öƒ¢óÀ¢Ò’À¢Ö„VçG'•&–6TG&÷7C¢çVÖ&W$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôÔ…ôTåE%•ôE$õõ5BrÂ“’Â°¢Ö–ã¢À¢Öƒ¢À¢Ò’À¢Ö…ÆW6–&ÆU&WGW&å7C¢çVÖ&W$Vçb€¢tdÄõuô„ôÄDU%ôu$õuD…ôÔ…õÄU4”$ÄUõ$UEU$åõ5BrÀ¢SÀ¢²Ö–ã¢ÂÖƒ¢óÒÀ¢’À¢&–uv–ææW%7C¢çVÖ&W$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ô$”uõt”ääU%õ5BrÂSÂ²Ö–ã¢Ò’À¢VçG'•&öf–ÆW3¢°¢°¢–C¢t„sôõTârÀ¢Æ&VÃ¢t„s÷Vâ+rzy.izžiÉþZëÞiÛî{¸BrÀ¢†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôõTåô„õ$•¤ôåôÕ2rÂóÂ°¢Ö–ã¢UóÂÖƒ¢cóÀ¢Ò’À¢Ö–ä'W–W'3¢RÀ¢Ö–äæWt'W–W'3¢2À¢Ö–å&WFVçF–öå7C¢3À¢Ö–äæWDfÆ÷u6öÃ¢ãRÀ¢Ö…F÷56†&U7C¢“À¢ÒÀ¢°¢–C¢t„sôdÄõsô£"rÀ¢Æ&VÃ¢tâfÆ÷rVFvR2+ræWDfÆ÷sãÓ+rVçG'’§V×Ó"RrÀ¢†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôõTåô„õ$•¤ôåôÕ2rÂóÂ°¢Ö–ã¢UóÂÖƒ¢cóÀ¢Ò’À¢Ö–ä'W–W'3¢RÀ¢Ö–äæWt'W–W'3¢2À¢Ö–å&WFVçF–öå7C¢3À¢Ö–äæWDfÆ÷u6öÃ¢À¢Ö…F÷56†&U7C¢“À¢Ö–äVçG'”§V×7C¢À¢Ö„VçG'”§V×7C¢"À¢ÒÀ¢°¢–C¢t„sôdÄõsUô£"rÀ¢Æ&VÃ¢tâfÆ÷rVFvR2+ræWDfÆ÷sãÓR+rVçG'’§V×Ó"RrÀ¢†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôõTåô„õ$•¤ôåôÕ2rÂóÂ°¢Ö–ã¢UóÂÖƒ¢cóÀ¢Ò’À¢Ö–ä'W–W'3¢RÀ¢Ö–äæWt'W–W'3¢2À¢Ö–å&WFVçF–öå7C¢3À¢Ö–äæWDfÆ÷u6öÃ¢RÀ¢Ö…F÷56†&U7C¢“À¢Ö–äVçG'”§V×7C¢À¢Ö„VçG'”§V×7C¢"À¢ÒÀ¢°¢–C¢t„s#ô$ÂrÀ¢Æ&VÃ¢t„s#&Ææ6VB+r#zy.izžiÉþYØ~Š{¸BrÀ¢†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôT$Å•ô„õ$•¤ôåôÕ2rÂ#óÂ°¢Ö–ã¢UóÂÖƒ¢cóÀ¢Ò’À¢Ö–ä'W–W'3¢‚À¢Ö–äæWt'W–W'3¢RÀ¢Ö–å&WFVçF–öå7C¢CÀ¢Ö–äæWDfÆ÷u6öÃ¢2À¢Ö…F÷56†&U7C¢ƒRÀ¢ÒÀ¢°¢–C¢t„s#ôd5BrÀ¢Æ&VÃ¢t„s#f7B+r#zy.izžiÉþXª˜	þ{¸BrÀ¢†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôT$Å•ô„õ$•¤ôåôÕ2rÂ#óÂ°¢Ö–ã¢UóÂÖƒ¢cóÀ¢Ò’À¢Ö–ä'W–W'3¢À¢Ö–äæWt'W–W'3¢‚À¢Ö–å&WFVçF–öå7C¢SÀ¢Ö–äæWDfÆ÷u6öÃ¢RÀ¢Ö…F÷56†&U7C¢ƒÀ¢ÒÀ¢°¢–C¢t„s#õTÄ•E•ô£"rÀ¢Æ&VÃ¢tâVÆ—G’#2+r'W–W'3ãÓC+r&WFVçF–öããÓcR+rVçG'’§V×Ó"RrÀ¢†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôT$Å•ô„õ$•¤ôåôÕ2rÂ#óÂ°¢Ö–ã¢UóÂÖƒ¢cóÀ¢Ò’À¢Ö–ä'W–W'3¢CÀ¢Ö–äæWt'W–W'3¢RÀ¢Ö–å&WFVçF–öå7C¢cÀ¢Ö–äæWDfÆ÷u6öÃ¢RÀ¢Ö…F÷56†&U7C¢ƒÀ¢Ö–äVçG'”§V×7C¢À¢Ö„VçG'”§V×7C¢"À¢ÒÀ¢°¢–C¢t„s3ô$ÂrÀ¢Æ&VÃ¢t„s3&Ææ6VB+rikZ)îK›Zën(šS÷2²yYžZÙŽ(šSSRrÀ¢†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…õ4ä4„õEôÕ2rÂ3óÂ°¢Ö–ã¢UóÂÖƒ¢cóÀ¢Ò’À¢Ö–ä'W–W'3¢À¢Ö–äæWt'W–W'3¢À¢Ö–å&WFVçF–öå7C¢SÀ¢Ö–äæWDfÆ÷u6öÃ¢RÀ¢Ö…F÷56†&U7C¢ƒÀ¢ÒÀ¢°¢–C¢t„s3ôd5BrÀ¢Æ&VÃ¢t„s3f7B+rikZ)îK›Zën(šS"÷2²yYžZÙŽ(šSsRrÀ¢†÷&—¦öä×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…õ4ä4„õEôÕ2rÂ3óÂ°¢Ö–ã¢UóÂÖƒ¢cóÀ¢Ò’À¢Ö–ä'W–W'3¢À¢Ö–äæWt'W–W'3¢#À¢Ö–å&WFVçF–öå7C¢sÀ¢Ö–äæWDfÆ÷u6öÃ¢À¢Ö…F÷56†&U7C¢ƒÀ¢ÒÀ¢Òæf–ÇFW"‚‡&öf–ÆR’Óâ†öÆFW$w&÷wF„gVÆÄÖG&—„Væ&ÆVBÇÂ&öf–ÆRæ–BÓÓÒt„s3ô$Âr’À¢òòWfW'’W†—B—27&÷76VBv—F‚WfW'’VçG'’2â–æFWVæFVçB6ö†÷'Bâ¶VW ¢òò…CUôƒ#Væ6†ævVB6òW†—7F–ær&öGV7F–öâ&÷w2&VÖ–â6ö×&&ÆRà¢W†—E&öf–ÆW3¢°¢°¢–C¢uƒUôd•„TBrÂÆ&VÃ¢~Y»®Zé£^zy"rÂW†—DÖöFS¢td•„TEô„ôÄBrÀ¢f—†VD†öÆD×3¢UóÂ†&E7F÷7C¢ÂÖ„†öÆD×3¢UóÀ¢ÒÀ¢°¢–C¢uƒUôd•„TBrÂÆ&VÃ¢~Y»®Zé£^zy"rÂW†—DÖöFS¢td•„TEô„ôÄBrÀ¢f—†VD†öÆD×3¢UóÂ†&E7F÷7C¢ÂÖ„†öÆD×3¢UóÀ¢ÒÀ¢°¢–C¢u…CUôƒ#rÀ¢Æ&VÃ¢r³R^køkK²ò[;XÎY¹îi*CRRòzÎjÚ.hÙó#Rò#zy.XYÎ[©RrÀ¢W†—DÖöFS¢uE$”Ä”ärrÀ¢†&E7F÷7C¢çVÖ&W$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ô„$Eõ5Dõõ5BrÂ#Â°¢Ö–ã¢ãÀ¢Öƒ¢À¢Ò’À¢G&–Æ–æt7F—fF–öå7C¢çVÖ&W$Vçb€¢tdÄõuô„ôÄDU%ôu$õuD…õE$”Ä”äuô5D•dD”ôåõ5BrÀ¢RÀ¢²Ö–ã¢ãÂÖƒ¢óÒÀ¢’À¢G&–Æ–æu7F÷7C¢çVÖ&W$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…õE$”Ä”äuõ5Dõõ5BrÂRÂ°¢Ö–ã¢ãÀ¢Öƒ¢À¢Ò’À¢Ö„†öÆD×3¢–çFVvW$Vçb‚tdÄõuô„ôÄDU%ôu$õuD…ôÔ…ô„ôÄEôÕ2rÂ#óÂ°¢Ö–ã¢óÀ¢Öƒ¢¢cóÀ¢Ò’À¢ÒÀ¢°¢–C¢u…C#ôCôƒƒrÂÆ&VÃ¢r³#^køkK²òY¹îi*CRòƒzy.XYÎ[©RrÀ¢W†—DÖöFS¢uE$”Ä”ärrÂ†&E7F÷7C¢#À¢G&–Æ–æt7F—fF–öå7C¢#ÂG&–Æ–æu7F÷7C¢ÂÖ„†öÆD×3¢ƒóÀ¢ÒÀ¢°¢–C¢u…C3ôCUôƒ3rÂÆ&VÃ¢r³3^køkK²òY¹îi*CRRò3zy.XYÎ[©RrÀ¢W†—DÖöFS¢uE$”Ä”ärrÂ†&E7F÷7C¢#À¢G&–Æ–æt7F—fF–öå7C¢3ÂG&–Æ–æu7F÷7C¢RÂÖ„†öÆD×3¢3óÀ¢ÒÀ¢°¢–C¢u…44ÄUóSõ%TääU"rÂÆ&VÃ¢r³3^XxþK¹3SRò[îK¹>Y¹îi*C#RrÀ¢W†—DÖöFS¢u44ÄUõ%TääU"rÂ†&E7F÷7C¢#À¢66ÆT÷WEG&–vvW%7C¢3Â66ÆT÷WDg&7F–öå7C¢SÀ¢G&–Æ–æt7F—fF–öå7C¢3ÂG&–Æ–æu7F÷7C¢#ÂÖ„†öÆD×3¢3óÀ¢ÒÀ¢°¢–C¢u…#óSôCUôƒ#rÀ¢Æ&VÃ¢r³#^XxþK¹3SRò[îK¹>Y¹îi*CRRò#zy.XYÎ[©RrÀ¢W†—DÖöFS¢u44ÄUõ%TääU"rÂ†&E7F÷7C¢#À¢66ÆT÷WEG&–vvW%7C¢#Â66ÆT÷WDg&7F–öå7C¢SÀ¢G&–Æ–æt7F—fF–öå7C¢#ÂG&–Æ–æu7F÷7C¢RÂÖ„†öÆD×3¢#óÀ¢ÒÀ¢°¢–C¢u…#ósôC#ôƒƒrÀ¢Æ&VÃ¢r³#^XxþK¹3sRò[îK¹>Y¹îi*C#Ròƒzy.XYÎ[©RrÀ¢W†—DÖöFS¢u44ÄUõ%TääU"rÂ†&E7F÷7C¢#À¢66ÆT÷WEG&–vvW%7C¢#Â66ÆT÷WDg&7F–öå7C¢sÀ¢G&–Æ–æt7F—fF–öå7C¢#ÂG&–Æ–æu7F÷7C¢#ÂÖ„†öÆD×3¢ƒóÀ¢ÒÀ¢°¢–C¢u…3ósõ5D•"rÀ¢Æ&VÃ¢r³3^XxþK¹3sRò[îK¹>™‹nj*þY¹îi*BrÀ¢W†—DÖöFS¢u44ÄUôDD•dRrÂ†&E7F÷7C¢#À¢66ÆT÷WEG&–vvW%7C¢3Â66ÆT÷WDg&7F–öå7C¢sÂÖ„†öÆD×3¢3óÀ¢G&–Æ–æuF–W'3¢°¢²7F—fF–öå7C¢3ÂG&vF÷vå7C¢RÒÀ¢²7F—fF–öå7C¢cÂG&vF÷vå7C¢RÒÀ¢²7F—fF–öå7C¢ÂG&vF÷vå7C¢#ÒÀ¢²7F—fF–öå7C¢#ÂG&vF÷vå7C¢#RÒÀ¢ÒÀ¢ÒÀ¢°¢–C¢u„dÄõuócrÂÆ&VÃ¢sczy$†öÆFW"þ‹XN˜ykX‹ÚÎ[Ë˜X{¢rÀ¢W†—DÖöFS¢tdÄõuô4„T4²rÂ†&E7F÷7C¢#À¢fÆ÷t6†V6´†÷&—¦öä×3¢cóÂÖ–ä'W–W%fVÆö6—G•&F–ó¢ãRÀ¢Ö–äæWDfÆ÷tFVÇF6öÃ¢ÂG&–Æ–æt7F—fF–öå7C¢#À¢G&–Æ–æu7F÷7C¢RÂÖ„†öÆD×3¢ƒóÀ¢ÒÀ¢°¢–C¢u…5D•%ô$ÂrÂÆ&VÃ¢~™‹nj*þYØ~Š#óCóƒóSó3rÀ¢W†—DÖöFS¢tDD•dUõE$”Ä”ärrÂ†&E7F÷7C¢#ÂÖ„†öÆD×3¢3cóÀ¢G&–Æ–æuF–W'3¢°¢²7F—fF–öå7C¢#ÂG&vF÷vå7C¢ÒÀ¢²7F—fF–öå7C¢CÂG&vF÷vå7C¢RÒÀ¢²7F—fF–öå7C¢ƒÂG&vF÷vå7C¢#ÒÀ¢²7F—fF–öå7C¢SÂG&vF÷vå7C¢#RÒÀ¢²7F—fF–öå7C¢3ÂG&vF÷vå7C¢3ÒÀ¢ÒÀ¢ÒÀ¢°¢–C¢u…5D•%ôÄô4²rÂÆ&VÃ¢~™‹nj*þKùÞZè‚Ró3ócó#rÀ¢W†—DÖöFS¢tDD•dUõE$”Ä”ärrÂ†&E7F÷7C¢#ÂÖ„†öÆD×3¢3óÀ¢G&–Æ–æuF–W'3¢°¢²7F—fF–öå7C¢RÂG&vF÷vå7C¢rãRÒÀ¢²7F—fF–öå7C¢3ÂG&vF÷vå7C¢ÒÀ¢²7F—fF–öå7C¢cÂG&vF÷vå7C¢RÒÀ¢²7F—fF–öå7C¢#ÂG&vF÷vå7C¢#ÒÀ¢ÒÀ¢ÒÀ¢°¢–C¢u…5D•%õD”ÂrÂÆ&VÃ¢~™‹nj*þ[îK¹2#óSóó#rÀ¢W†—DÖöFS¢tDD•dUõE$”Ä”ärrÂ†&E7F÷7C¢#ÂÖ„†öÆD×3¢3cóÀ¢G&–Æ–æuF–W'3¢°¢²7F—fF–öå7C¢#ÂG&vF÷vå7C¢"ãRÒÀ¢²7F—fF–öå7C¢SÂG&vF÷vå7C¢#ÒÀ¢²7F—fF–öå7C¢ÂG&vF÷vå7C¢#RÒÀ¢²7F—fF–öå7C¢#ÂG&vF÷vå7C¢3ÒÀ¢ÒÀ¢ÒÀ¢Òæf–ÇFW"‚‡&öf–ÆR’Óâ†öÆFW$w&÷wF„gVÆÄÖG&—„Væ&ÆV@¢ÇÂ²uƒUôd•„TBrÂuƒUôd•„TBuÒæ–æ6ÇVFW2‡&öf–ÆRæ–B’’À¢6÷7DÖöFVÃ¢æ÷&ÖÆ—¦T6÷7DÖöFVÂ‡°¢ââæÆ&VÄ6÷7DÖöFVÂÀ¢÷6—F–öå6—¦U6öÃ¢6†F÷u÷6—F–öäVçb‚tdÄõuô„ôÄDU%ôu$õuD…õõ4•D”ôåõ4ôÂr’À¢Ò’À¢ÒÀ ¢òòö'6W'fW"ÖöæÇ’ÆVæ6‚VÆ—G’&W6V&6‚â&VfW&Væ6RW&6VçFvW2Æ&VÂÖ&¶W@¢òò7G'V7GW&Rf÷"ÆFW"æÇ—6—3²F†W’æWfW"&V6öÖRâVçG'’÷"W†V7WF–öâ'VÆRàÐ¢ÆVæ6…VÆ—G”ö'6W'fW#¢°Ð¢Væ&ÆVC¢&ööÆVäVçb‚tdÄõuôÄTä4…õTÄ•E•ôô%4U%dU%ôTä$ÄTBrÂG'VR’ÀÐ¢6æ6†÷D†÷&—¦öç4×3¢Ö–ÆÆ—6V6öæDÆ—7DVçb€Ð¢tdÄõuôÄTä4…õTÄ•E•õ4ä4„õEõ4T4ôäE2rÀÐ¢³RÂÂ#Â3ÂcÒÀÐ¢’ÀÐ¢Ö„ÆVæ6„vT×3¢–çFVvW$Vçb‚tdÄõuôÄTä4…õTÄ•E•ôÔ…ôtUôÕ2rÂ“óÂ°Ð¢Ö–ã¢3óÀÐ¢Öƒ¢¢cóÀÐ¢Ò’ÀÐ¢V×&VfW&Væ6U7C¢çVÖ&W$Vçb‚tdÄõuôÄTä4…õTÄ•E•õTÕõ$TdU$Tä4Uõ5BrÂ#RÂ°Ð¢Ö–ã¢ãÀÐ¢Öƒ¢óÀÐ¢Ò’ÀÐ¢VÆÆ&6µ&VfW&Væ6U7C¢çVÖ&W$Vçb€Ð¢tdÄõuôÄTä4…õTÄ•E•õTÄÄ$4µõ$TdU$Tä4Uõ5BrÀÐ¢rãRÀÐ¢²Ö–ã¢ãÂÖƒ¢ÒÀÐ¢’ÀÐ¢&V&÷VæE&VfW&Væ6U7C¢çVÖ&W$Vçb€Ð¢tdÄõuôÄTä4…õTÄ•E•õ$T$õTäEõ$TdU$Tä4Uõ5BrÀÐ¢2ÀÐ¢²Ö–ã¢ÂÖƒ¢óÒÀÐ¢’ÀÐ¢FVW&VfW&Væ6U&öf–ÆW3¢ÆVæ6„FVWVÆÆ&6µ&öf–ÆW2æÖ‚‡&öf–ÆR’Óâ‡²ââç&öf–ÆRÒ’’ÀÐ¢&V6VçD'W–W%v–æF÷t×3¢–çFVvW$Vçb€Ð¢tdÄõuôÄTä4…õTÄ•E•õ$T4TåEô%U”U%õt”äDõuôÕ2rÀÐ¢óÀÐ¢²Ö–ã¢SÂÖƒ¢cóÒÀÐ¢’ÀÐ¢&WFVçF–öäfÆö÷%7C¢çVÖ&W$Vçb‚tdÄõuôÄTä4…õTÄ•E•õ$UDTåD”ôåôdÄôõ%õ5BrÂÂ°Ð¢Ö–ã¢ÀÐ¢Öƒ¢ÀÐ¢Ò’ÀÐ¢Ö„ö'6W'fF–öäÆt×3¢–çFVvW$Vçb€¢tdÄõuôÄTä4…õTÄ•E•ôÔ…ôô%4U%dD”ôåôÄuôÕ2rÀ¢%óÀ¢²Ö–ã¢ÂÖƒ¢3óÒÀ¢’À¢Ö&¶WE&Vv–ÖTÆöö¶&6´×3¢–çFVvW$Vçb€¢tdÄõuôÄTä4…ôÔ$´UEõ$Tt”ÔUôÄôô´$4µôÕ2rÀ¢3¢cóÀ¢²Ö–ã¢R¢cóÂÖƒ¢b¢c¢cóÒÀ¢’À¢Ö&¶WE&Vv–ÖU6WGFÆVÖVçDÆt×3¢–çFVvW$Vçb€¢tdÄõuôÄTä4…ôÔ$´UEõ$Tt”ÔUõ4UEDÄTÔTåEôÄuôÕ2rÀ¢cóÀ¢²Ö–ã¢cóÂÖƒ¢¢cóÒÀ¢’À¢Ö&¶WE&Vv–ÖT66†T×3¢–çFVvW$Vçb€¢tdÄõuôÄTä4…ôÔ$´UEõ$Tt”ÔUô44„UôÕ2rÀ¢UóÀ¢²Ö–ã¢óÂÖƒ¢cóÒÀ¢’À¢ÒÀ Ð¢7F÷&vS¢°Ð¢F%Fƒ¢&ö6W72æVçbädÄõuôD%õD‚ÇÂrâöFFöfÆ÷r×&W6V&6‚æF"rÀÐ¢&u&WFVçF–öä†÷W'3¢çVÖ&W$Vçb‚tdÄõuõ$uõ$UDTåD”ôåô„õU%2rÂc‚Â²Ö–ã¢Ò’ÀÐ¢&6†—fTF—#¢&ö6W72æVçbädÄõuô$4„•dUôD•"ÇÂrâöFFö&6†—fRrÀÐ¢fÇW6„×3¢–çFVvW$Vçb‚tdÄõuôD%ôdÅU4…ôÕ2rÂ#SÂ²Ö–ã¢#RÒ’ÀÐ¢fÇW6„Öƒ¢–çFVvW$Vçb‚tdÄõuôD%ôdÅU4…ôÔ‚rÂóÂ²Ö–ã¢Ò’ÀÐ¢ÒÀÐ Ð¢6W'fW#¢°Ð¢÷'C¢–çFVvW$Vçb‚tdÄõuôD4„$ô$Eõõ%BrÂ3Â²Ö–ã¢ÂÖƒ¢cUóS3RÒ’ÀÐ¢†÷7C¢&ö6W72æVçbädÄõuô$”äEô„õ5BÇÂsãããrÀÐ¢ÒÀÐ§Ó°Ð Ð¢òò6öÆæ&WVW7G2&–÷&—G’&–6RW"5RÂv†–ÆR÷W&F÷'2&V6öâ&÷WBF†RF÷FÀÐ¢òòfVRW"G&ç67F–öââFW&—fRöæR6†&VB'W’÷6VÆÂ5R&–6Rg&öÒF†R4ôÂF&vWBàÐ¦6öæf–ræÆ—fUG&F–ærç&–÷&—G”fVTÖ–7&ôÆ×÷'G2Ò&–÷&—G”fVTÖ–7&ôÆ×÷'G2€Ð¢6öæf–ræÆ—fUG&F–ærç&–÷&—G”fVU6öÂÀÐ¢6öæf–ræÆ—fUG&F–æræ6ö×WFUVæ—DÆ–Ö—BÀÐ¢“°Ð Ð¦gVæ7F–öâ7G&VÕFö¶Väf÷"†VæGö–çB’°Ð¢–b†6öæf–rç7G&VÒæÆÆVä†&´VæGö–çG2æ†2†VæGö–çB’’&WGW&â6öæf–rç7G&VÒæÆÆVä†&µFö¶VâÇÂVæFVf–æVC°Ð¢&WGW&â6öæf–rç7G&VÒæ†VÆ—W5Fö¶VâÇÂVæFVf–æVC°Ð§ÐÐ Ð¦gVæ7F–öâfÆ–FFT6öæf–r‚’°Ð¢6öç7BW'&÷'2ÒµÓ°Ð¢–b†6öæf–rç7G&VÒæVæGö–çG2æÆVæwF‚ÓÓÒ’°Ð¢W'&÷'2çW6‚‚tÖ—76–ærdÄõuôu%5ôTäEô”åE2÷"„TÄ•U5ôÄ4U%5E$TÕôTäEô”åB…2’r“°Ð¢ÐÐ¢–b†6öæf–rç7G&FVw’ç6–væÅv–æF÷t×2¢2â6öæf–rç7G&FVw’æ'VffW$×2’°Ð¢W'&÷'2çW6‚‚tdÄõuô%TddU%ôÕ2×W7B6÷fW"ÆÂF‡&VR6–væÂv–æF÷w2r“°Ð¢ÐÐ¢–b†6öæf–ræÆVæ6…VÆ—G”ö'6W'fW"ç6æ6†÷D†÷&—¦öç4×2æÆVæwF‚ÓÓÒ’°¢W'&÷'2çW6‚‚tdÄõuôÄTä4…õTÄ•E•õ4ä4„õEõ4T4ôäE2×W7B6öçF–âBÆV7BöæRfÇVRr“°¢Ð¢–b†6öæf–ræ†öÆFW$w&÷wF…6†F÷ræVæ&ÆVBbb6öæf–ræÆVæ6…VÆ—G”ö'6W'fW"æVæ&ÆVB’°¢W'&÷'2çW6‚‚tdÄõuôÄTä4…õTÄ•E•ôô%4U%dU%ôTä$ÄTB×W7B&RG'VRv†Vâ†öÆFW"w&÷wF‚—2Væ&ÆVBr“°¢Ð¢6öç7B†öÆFW$w&÷wF„†÷&—¦öç2ÒæWr6WB…°¢ââæ6öæf–ræ†öÆFW$w&÷wF…6†F÷ræVçG'•&öf–ÆW2æÖ‚‡&öf–ÆR’Óâ€¢&öf–ÆRæ†÷&—¦öä×2ÇÂ6öæf–ræ†öÆFW$w&÷wF…6†F÷rç6æ6†÷D†÷&—¦öä×0¢’’À¢ââæ6öæf–ræ†öÆFW$w&÷wF…6†F÷ræW†—E&öf–ÆW0¢æÖ‚‡&öf–ÆR’Óâ&öf–ÆRæfÆ÷t6†V6´†÷&—¦öä×2’æf–ÇFW"„&ööÆVâ’À¢Ò“°¢–b†6öæf–ræ†öÆFW$w&÷wF…6†F÷ræVæ&ÆV@¢bb²ââæ†öÆFW$w&÷wF„†÷&—¦öç5Òç6öÖR‚††÷&—¦öä×2’Óâ€¢6öæf–ræÆVæ6…VÆ—G”ö'6W'fW"ç6æ6†÷D†÷&—¦öç4×2æ–æ6ÇVFW2††÷&—¦öä×2¢’’’°¢W'&÷'2çW6‚‚tdÄõuôÄTä4…õTÄ•E•õ4ä4„õEõ4T4ôäE2×W7B–æ6ÇVFRÆÂ†öÆFW"w&÷wF‚†÷&—¦öç2r“°¢Ð¢–b†6öæf–ræ&öæF–æt7W'fTÖöÖVçGVÕ6†F÷rç6æ6†÷D†÷&—¦öç4×2æÆVæwF‚ÓÓÒ’°Ð¢W'&÷'2çW6‚‚tdÄõuô$ôäD”äuôÔôÔTåETÕõ4ä4„õEõ4T4ôäE2×W7B6öçF–âBÆV7BöæRfÇVRr“°Ð¢ÐÐ¢–b†6öæf–ræÆ—fUG&F–æræVæ&ÆVBbb6öæf–ræÆ—fUG&F–æræG'•'Vâ’°Ð¢–b‚6öæf–ræÆ—fUG&F–ærç'5W&Â’W'&÷'2çW6‚‚tdÄõuõ%5õU$Â—2&WV—&VBf÷"Æ—fRG&F–ærr“°Ð¢–b‚6öæf–ræÆ—fUG&F–ærç&—fFT¶W’’°Ð¢W'&÷'2çW6‚‚tdÄõuôÄ•dUõ$•dDUô´U’—2&WV—&VBf÷"Æ—fRG&F–ærr“°Ð¢ÐÐ¢–b‚&ö6W72æVçbädÄõuôÄ•dUõõ5EôtC#Uó3Uõ„ÄTuõõ4•D”ôåõ4ôÂ’°Ð¢W'&÷'2çW6‚‚tdÄõuôÄ•dUõõ5EôtC#Uó3Uõ„ÄTuõõ4•D”ôåõ4ôÂ×W7B&RW‡Æ–6—FÇ’6WBf÷"Æ—fRG&F–ærr“°Ð¢ÐÐ¢ÐÐ¢&WGW&âW'&÷'3°Ð§ÐÐ Ð¦ÖöGVÆRæW‡÷'G2Ò°Ð¢6öæf–rÀÐ¢æ÷&ÖÆ—¦TVæGö–çBÀÐ¢Æ—fUG&F–ætwV&BÀÐ¢6†F÷u÷6—F–öäVçbÀÐ¢Æ—fU÷6—F–öäVçbÀÐ¢&–÷&—G”fVTÖ–7&ôÆ×÷'G2ÀÐ¢fÆ–FFT6öæf–rÀÐ¢7G&VÕFö¶Väf÷"ÀÐ§Ó°Ð