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
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

try {
  const result = runBacktest(db, {
    holdMs: input['hold-ms'],
    executionDelayMs: input['delay-ms'],
    platformFeePct: input['platform-fee-pct'] ?? input['cost-pct'],
    buySlippagePct: input['buy-slippage-pct'],
    sellSlippagePct: input['sell-slippage-pct'],
    priceImpactPct: input['impact-pct'],
    baseTxFeeSol: input['base-tx-fee-sol'],
    priorityFeeSol: input['priority-fee-sol'],
    jitoTipSol: input['jito-tip-sol'],
    fixedCostSol: input['fixed-cost-sol'],
    positionSizeSol: input['position-sol'],
    failureRatePct: input['failure-rate-pct'],
    failureLossPct: input['failure-loss-pct'],
    minNetFlowW3: input['min-net-w3'],
    minFlowAccel: input['min-accel'],
    limit: input.limit,
    includeRows: input.rows === 'true',
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
