'use strict';

require('dotenv').config();

const { costBreakdown, normalizeCostModel } = require('./core/CostModel');

function numberEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function integerEnv(name, fallback, bounds = {}) {
  return Math.trunc(numberEnv(name, fallback, bounds));
}

function listEnv(name, fallback = []) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return [...fallback];
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
  failureRatePct: numberEnv('FLOW_FAILURE_RATE_PCT', 0, { min: 0, max: 100 }),
  failureLossPct: numberEnv('FLOW_FAILURE_LOSS_PCT', 1, { min: 0 }),
});

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
  },

  labels: {
    horizonsSeconds: [1, 2, 3, 5, 8, 10, 15, 20, 30, 60],
    excursionSeconds: [5, 10, 30],
    costModel: labelCostModel,
    configuredTradingCostPct: costBreakdown(labelCostModel).deterministicCostPct,
  },

  backtest: {
    entryTimeoutMs: integerEnv('FLOW_BACKTEST_ENTRY_TIMEOUT_MS', 2_000, { min: 1 }),
    exitTimeoutMs: integerEnv('FLOW_BACKTEST_EXIT_TIMEOUT_MS', 5_000, { min: 1 }),
    noExitLossPct: numberEnv('FLOW_BACKTEST_NO_EXIT_LOSS_PCT', 100, { min: 0 }),
  },

  smartWallets: listEnv('FLOW_SMART_WALLETS', [
    'Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt',
    '7yd579zXmWPoxEE22BUYTzAo8nyMmQtPyEWS3g1BFhH4',
  ]),

  storage: {
    dbPath: process.env.FLOW_DB_PATH || './data/flow-research.db',
    rawRetentionHours: numberEnv('FLOW_RAW_RETENTION_HOURS', 24, { min: 1 }),
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
  return errors;
}

module.exports = {
  config,
  normalizeEndpoint,
  validateConfig,
  streamTokenFor,
};
