'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchStore } = require('../src/data/ResearchStore');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-health-sampler-'));
  const dbPath = path.join(directory, 'research.db');
  const store = new ResearchStore({
    dbPath,
    archiveDir: directory,
    rawRetentionHours: 48,
    flushMs: 60_000,
    flushMax: 100,
    healthRefreshMs: 60_000,
  }, {
    configuredTradingCostPct: 1.4,
  });

  try {
    store.ensureToken('health-mint');
    store.queueRawTrade({
      timestampMs: Date.now(),
      receivedAtMs: Date.now(),
      chainTimestampMs: Date.now(),
      signature: 'health-trade-1',
      eventIndex: 0,
      market: 'PUMP_BONDING_CURVE',
      mint: 'health-mint',
      wallet: 'health-wallet',
      side: 'BUY',
      solAmount: 1,
      tokenAmount: 1,
      price: 1,
    });
    store.flushRawTrades();

    const pending = store.healthSnapshot();
    assert.strictEqual(pending.statsSnapshot.status, 'PENDING');
    assert.strictEqual(pending.rawRows, undefined);

    await store.refreshHealthSnapshot();
    const sampled = store.healthSnapshot();
    assert.strictEqual(sampled.rawRows, 1);
    assert.strictEqual(sampled.statsSnapshot.status, 'READY');
    assert.strictEqual(sampled.statsSnapshot.refreshes, 1);
    assert.ok(sampled.statsSnapshot.generatedAt > 0);
    assert.ok(sampled.statsSnapshot.durationMs >= 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log('test-database-health-sampler: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
