'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { runBacktest } = require('../src/core/FlowBacktester');
const { createResearchSnapshot, snapshotName } = require('../src/data/ResearchSnapshot');

function args(argv) {
  const values = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, raw = 'true'] = item.slice(2).split('=', 2);
    values[key] = raw;
  }
  return values;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compact(result) {
  return {
    parameters: result.parameters,
    analysisWindow: result.analysisWindow,
    metrics: result.metrics,
    validation: result.validation,
  };
}

async function main() {
  const input = args(process.argv.slice(2));
  const sourcePath = input.db || config.storage.dbPath;
  let analysisPath = sourcePath;
  let snapshot = null;
  if (input.snapshot !== 'false') {
    analysisPath = input['snapshot-out']
      || path.join('data', 'snapshots', snapshotName());
    snapshot = await createResearchSnapshot(sourcePath, analysisPath);
  }

  const db = new Database(analysisPath, { readonly: true, fileMustExist: true });
  try {
    const dataSpan = db.prepare(`
      SELECT
        (SELECT MIN(timestamp_ms) FROM raw_trades) AS raw_first_ms,
        (SELECT MAX(timestamp_ms) FROM raw_trades) AS raw_last_ms,
        (SELECT MIN(timestamp_ms) FROM flow_signals) AS signal_first_ms,
        (SELECT MAX(timestamp_ms) FROM flow_signals) AS signal_last_ms,
        (SELECT COUNT(*) FROM flow_signals) AS signals,
        (SELECT COUNT(DISTINCT mint) FROM flow_signals) AS mints
    `).get();
    if (!Number.isFinite(dataSpan.raw_last_ms)) throw new Error('Snapshot contains no raw trades');

    const holds = [1_000, 2_000, 3_000, 5_000, 8_000, 10_000];
    const delays = [100, 200, 400, 600, 1_000];
    const thresholds = [1, 2, 3, 5, 8, 10];
    const exitTimeoutMs = number(input['exit-timeout-ms'], config.backtest.exitTimeoutMs);
    const entryTimeoutMs = number(input['entry-timeout-ms'], config.backtest.entryTimeoutMs);
    const exitDelayMs = number(input['exit-delay-ms'], 0);
    const retryCount = number(input['exit-retry-count'], 0);
    const retryDelayMs = number(input['exit-retry-delay-ms'], 500);
    const baselineHoldMs = number(input['hold-ms'], 5_000);
    const baselineDelayMs = number(input['delay-ms'], 200);
    const maxLookaheadMs = Math.max(...holds, baselineHoldMs)
      + Math.max(...delays, baselineDelayMs)
      + entryTimeoutMs
      + exitTimeoutMs
      + exitDelayMs
      + retryCount * retryDelayMs;
    const fromMs = number(input['from-ms'], dataSpan.raw_first_ms);
    const toMs = number(input['to-ms'], dataSpan.raw_last_ms - maxLookaheadMs);
    if (toMs <= fromMs) throw new Error('Not enough complete raw-trade coverage for analysis');

    const baseOptions = {
      ...config.labels.costModel,
      executionDelayMs: baselineDelayMs,
      entryTimeoutMs,
      exitTimeoutMs,
      noExitLossPct: number(input['no-exit-loss-pct'], config.backtest.noExitLossPct),
      minNetFlowW3: number(input['min-net-w3'], config.strategy.minNetFlowW3Sol),
      minFlowAccel: number(input['min-accel'], config.strategy.minAccelerationRatio),
      takeProfitPct: input['take-profit-pct'],
      stopLossPct: input['stop-loss-pct'],
      trailingStopPct: input['trailing-stop-pct'],
      trailingActivationPct: input['trailing-activation-pct'],
      exitExecutionDelayMs: exitDelayMs,
      exitRetryCount: retryCount,
      exitRetryDelayMs: retryDelayMs,
      exitFailureCostSol: input['exit-failure-cost-sol'],
      fromMs,
      toMs,
      dataCutoffMs: dataSpan.raw_last_ms,
      splitRatio: number(input['split-ratio'], 0.7),
      bootstrapSamples: number(input['bootstrap-samples'], 500),
      limit: number(input.limit, 100_000),
      includeRows: false,
    };

    const baseline = runBacktest(db, { ...baseOptions, holdMs: baselineHoldMs });
    const scan = (values, optionsForValue) => values.map((value) => {
      const result = runBacktest(db, {
        ...baseOptions,
        ...optionsForValue(value),
        bootstrapSamples: 0,
      });
      return { value, metrics: result.metrics, validation: result.validation };
    });
    const report = {
      generatedAt: Date.now(),
      sourcePath: path.resolve(sourcePath),
      analysisPath: path.resolve(analysisPath),
      snapshot,
      dataSpan,
      fixedCohort: { fromMs, toMs, dataCutoffMs: dataSpan.raw_last_ms, maxLookaheadMs },
      collectionFloorWarning: {
        minNetFlowW3: config.strategy.minNetFlowW3Sol,
        minFlowAccel: config.strategy.minAccelerationRatio,
        message: 'Thresholds below collection floors cannot be evaluated from existing signals.',
      },
      baseline: compact(baseline),
      holdScan: scan(holds, (holdMs) => ({ holdMs })),
      delayScan: scan(delays, (executionDelayMs) => ({
        holdMs: baselineHoldMs,
        executionDelayMs,
      })),
      netFlowScan: scan(thresholds, (minNetFlowW3) => ({
        holdMs: baselineHoldMs,
        minNetFlowW3,
      })),
    };
    const output = JSON.stringify(report, null, 2);
    if (input.out) {
      const outputPath = path.resolve(input.out);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${output}\n`, 'utf8');
      console.log(JSON.stringify({ outputPath, analysisPath: path.resolve(analysisPath) }, null, 2));
    } else {
      console.log(output);
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Analysis] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { args, compact, main };
