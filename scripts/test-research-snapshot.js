'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const { createResearchSnapshot } = require('../src/data/ResearchSnapshot');
const { main: analyzeMain } = require('./analyze-flow-strategy');

function addSignal(store, mint, timestampMs) {
  store.recordSignal({
    timestampMs, slot: 1, signature: `signal-${mint}`, mint, symbol: 'FLOW',
    ageMs: 1_000, curvePct: 10, price: 1,
    buyFlowW1: 1, buyFlowW2: 2, buyFlowW3: 3,
    sellFlowW1: 0, sellFlowW2: 0, sellFlowW3: 0,
    netFlowW1: 1, netFlowW2: 2, netFlowW3: 3,
    deltaNetFlow12: 1, deltaNetFlow23: 1,
    uniqueBuyersW1: 1, uniqueBuyersW2: 2, uniqueBuyersW3: 3,
    buyTxW1: 1, buyTxW2: 2, buyTxW3: 3,
    flowAccel1: 2, flowAccel2: 1.5,
  });
}

let tradeId = 0;
function addTrade(store, mint, timestampMs, price) {
  tradeId += 1;
  store.ensureToken(mint);
  store.queueRawTrade({
    timestampMs, receivedAtMs: timestampMs, chainTimestampMs: timestampMs,
    signature: `snapshot-trade-${tradeId}`, eventIndex: 0, market: 'PUMP_BONDING_CURVE',
    mint, wallet: 'wallet', side: 'BUY', solAmount: 1, tokenAmount: 1, price,
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-snapshot-test-'));
  const source = path.join(tempDir, 'source.db');
  const destination = path.join(tempDir, 'snapshot.db');
  const storage = {
    dbPath: source, archiveDir: tempDir, rawRetentionHours: 168, flushMs: 60_000, flushMax: 100,
  };
  let store = new ResearchStore(storage, { configuredTradingCostPct: 1 });
  addSignal(store, 'one', 1_000_000);
  addTrade(store, 'one', 1_000_000, 1);
  addTrade(store, 'one', 1_000_200, 1);
  addTrade(store, 'one', 1_001_200, 1.1);
  addTrade(store, 'coverage', 1_030_000, 1);
  store.close();

  const snapshot = await createResearchSnapshot(source, destination);
  assert.strictEqual(snapshot.integrity, 'ok');
  assert.strictEqual(snapshot.signals.rows, 1);

  store = new ResearchStore(storage, { configuredTradingCostPct: 1 });
  addSignal(store, 'two', 2_000_000);
  store.close();

  const frozen = new Database(destination, { readonly: true });
  assert.strictEqual(frozen.prepare('SELECT COUNT(*) AS n FROM flow_signals').get().n, 1);
  frozen.close();
  const analysisPath = path.join(tempDir, 'analysis.json');
  const originalArgv = process.argv;
  process.argv = [
    process.execPath,
    'analyze-flow-strategy.js',
    `--db=${destination}`,
    '--snapshot=false',
    `--out=${analysisPath}`,
    '--hold-ms=1000',
    '--bootstrap-samples=10',
  ];
  try {
    await analyzeMain();
  } finally {
    process.argv = originalArgv;
  }
  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
  assert.strictEqual(analysis.dataSpan.signals, 1);
  assert.strictEqual(analysis.baseline.metrics.completedSamples, 1);
  assert.strictEqual(analysis.fixedCohort.dataCutoffMs, 1_030_000);
  assert.strictEqual(analysis.fixedCohort.maxLookaheadMs, 18_000,
    'fixed cohort must reserve entry delay, entry timeout, hold, and exit timeout');
  assert.strictEqual(analysis.fixedCohort.toMs, 1_012_000);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('test-research-snapshot: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
