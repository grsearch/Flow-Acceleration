'use strict';

require('dotenv').config();
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { runBacktest } = require('../src/core/FlowBacktester');

function args(argv) {
  const values = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, raw = 'true'] = item.slice(2).split('=', 2);
    values[key] = raw;
  }
  return values;
}

const input = args(process.argv.slice(2));
const dbPath = input.db || config.storage.dbPath;
const signalVariant = input['signal-variant'] || 'primary_3w';
const defaultMinFlowAccel = ['shadow_netflow_breakout', '*'].includes(signalVariant)
  ? 0
  : config.strategy.minAccelerationRatio;
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

try {
  const result = runBacktest(db, {
    holdMs: input['hold-ms'] ?? 60_000,
    executionDelayMs: input['delay-ms'] ?? config.backtest.executionDelayMs,
    entryTimeoutMs: input['entry-timeout-ms'] ?? config.backtest.entryTimeoutMs,
    exitTimeoutMs: input['exit-timeout-ms'] ?? config.backtest.exitTimeoutMs,
    noExitLossPct: input['no-exit-loss-pct'] ?? config.backtest.noExitLossPct,
    takeProfitPct: input['take-profit-pct'],
    stopLossPct: input['stop-loss-pct'],
    trailingStopPct: input['trailing-stop-pct'],
    trailingActivationPct: input['trailing-activation-pct'],
    flowExitNetFlowThresholdSol: input['flow-exit-netflow-sol'],
    flowExitWindowMs: input['flow-exit-window-ms'],
    flowExitMinHoldMs: input['flow-exit-min-hold-ms'],
    flowExitConfirmations: input['flow-exit-confirmations'],
    exitOnSmartWalletSell: input['exit-on-smart-wallet-sell'],
    smartWallets: config.smartWallets,
    exitExecutionDelayMs: input['exit-delay-ms'] ?? config.backtest.exitExecutionDelayMs,
    exitRetryCount: input['exit-retry-count'],
    exitRetryDelayMs: input['exit-retry-delay-ms'],
    exitFailureCostSol: input['exit-failure-cost-sol'],
    platformFeePct: input['platform-fee-pct'] ?? input['cost-pct']
      ?? config.labels.costModel.platformFeePct,
    buySlippagePct: input['buy-slippage-pct'] ?? config.labels.costModel.buySlippagePct,
    sellSlippagePct: input['sell-slippage-pct'] ?? config.labels.costModel.sellSlippagePct,
    priceImpactPct: input['impact-pct'] ?? config.labels.costModel.priceImpactPct,
    baseTxFeeSol: input['base-tx-fee-sol'] ?? config.labels.costModel.baseTxFeeSol,
    priorityFeeSol: input['priority-fee-sol'] ?? config.labels.costModel.priorityFeeSol,
    jitoTipSol: input['jito-tip-sol'] ?? config.labels.costModel.jitoTipSol,
    fixedCostSol: input['fixed-cost-sol'] ?? config.labels.costModel.fixedCostSol,
    positionSizeSol: input['position-sol'] ?? config.labels.costModel.positionSizeSol,
    entryFailureRatePct: input['entry-failure-rate-pct'] ?? input['failure-rate-pct']
      ?? config.labels.costModel.entryFailureRatePct,
    entryFailureCostPct: input['entry-failure-cost-pct'] ?? input['failure-loss-pct']
      ?? config.labels.costModel.entryFailureCostPct,
    minNetFlowW3: input['min-net-w3'] ?? config.strategy.minNetFlowW3Sol,
    maxNetFlowW3: input['max-net-w3'],
    minFlowAccel: input['min-accel'] ?? defaultMinFlowAccel,
    minAgeMs: input['min-age-ms'],
    maxAgeMs: input['max-age-ms'],
    minCurvePct: input['min-curve-pct'],
    maxCurvePct: input['max-curve-pct'],
    minDeltaNetFlow12: input['min-delta-12'],
    minDeltaNetFlow23: input['min-delta-23'],
    minBuyTxW3: input['min-buy-tx-w3'],
    minUniqueBuyersW3: input['min-buyers-w3'],
    maxBuyTxW3: input['max-buy-tx-w3'],
    maxUniqueBuyersW3: input['max-buyers-w3'],
    excludedMints: input['excluded-mints'],
    maxEntryPriceJumpPct: input['max-entry-price-jump-pct'],
    firstSignalOnly: input['first-signal-only'],
    signalCooldownMs: input['signal-cooldown-ms'] ?? config.backtest.signalCooldownMs,
    singlePositionPerMint: input['single-position-per-mint']
      ?? config.backtest.singlePositionPerMint,
    signalVariant,
    fromMs: input['from-ms'],
    toMs: input['to-ms'],
    dataCutoffMs: input['data-cutoff-ms'],
    splitRatio: input['split-ratio'],
    bootstrapSamples: input['bootstrap-samples'],
    limit: input.limit,
    includeRows: input.rows === 'true',
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
