'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const { shanghaiDay } = require('../src/data/RawTradeShardManager');
const { mergeRawShards } = require('../src/data/ResearchSnapshot');
const { exportResearchWindow } = require('./export-research-window');

function storage(dbPath, shardDir) {
  return {
    dbPath,
    archiveDir: path.dirname(dbPath),
    rawRetentionHours: 48,
    rawShardingEnabled: true,
    rawShardDir: shardDir,
    rawShardReadDays: 3,
    cacheSizeKb: 8_192,
    busyTimeoutMs: 5_000,
    flushMs: 60_000,
    flushMax: 100,
  };
}

function trade(timestampMs, suffix) {
  return {
    timestampMs,
    chainTimestampMs: timestampMs,
    receivedAtMs: timestampMs,
    slot: 100,
    signature: `sharded-${suffix}`,
    eventIndex: 0,
    market: 'PUMP_BONDING_CURVE',
    mint: `mint-${suffix}`,
    bondingCurve: null,
    wallet: `wallet-${suffix}`,
    side: 'BUY',
    solAmount: 1,
    tokenAmount: 1,
    price: 1,
    reservePrice: null,
    curvePct: null,
    virtualSolReservesRaw: null,
    virtualTokenReservesRaw: null,
    realSolReservesRaw: null,
    realTokenReservesRaw: null,
    pool: null,
    poolBaseReservesRaw: null,
    poolQuoteReservesRaw: null,
    virtualQuoteReservesRaw: null,
    ammExecutionContextJson: null,
  };
}

function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-raw-shards-'));
  const dbPath = path.join(directory, 'research.db');
  const shardDir = path.join(directory, 'raw-daily');
  const now = Date.now();
  const previous = now - 5 * 24 * 60 * 60_000;
  let store = new ResearchStore(storage(dbPath, shardDir), { configuredTradingCostPct: 1.4 });
  try {
    const legacy = previous - 24 * 60 * 60_000;
    store.ensureToken('mint-previous');
    store.ensureToken('mint-current');
    store.ensureToken('mint-legacy-cold');
    store.stmts.insertRawTrade.run(trade(legacy, 'legacy-cold'));
    store.queueRawTrade(trade(previous, 'previous'));
    assert.strictEqual(store.flushRawTrades(), 1);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 1);
    store.queueRawTrade(trade(now, 'current'));
    assert.strictEqual(store.flushRawTrades(), 1);
    assert.strictEqual(
      store.db.prepare('SELECT COUNT(*) n FROM main.raw_trades').get().n,
      1,
      'pre-cutover history must be preserved in the main database',
    );
    assert.strictEqual(
      store.db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n,
      1,
      'the hot view must detach shards outside the configured read window',
    );
    assert.ok(fs.existsSync(path.join(
      shardDir, `raw-trades-${shanghaiDay(previous)}-CST.db`,
    )));
    assert.ok(fs.existsSync(path.join(
      shardDir, `raw-trades-${shanghaiDay(now)}-CST.db`,
    )));
    assert.strictEqual(store.rawTradeShards.health().activeDay, shanghaiDay(now));
  } finally {
    store.close();
  }

  store = new ResearchStore(storage(dbPath, shardDir), { configuredTradingCostPct: 1.4 });
  try {
    assert.deepStrictEqual(
      store.db.prepare('SELECT mint FROM raw_trades_all ORDER BY timestamp_ms').all()
        .map((row) => row.mint),
      ['mint-current'],
    );
  } finally {
    store.close();
  }

  const exportedPath = path.join(directory, 'window.db');
  const result = exportResearchWindow({
    sourcePath: dbPath,
    destinationPath: exportedPath,
    startMs: previous - 24 * 60 * 60_000 - 1_000,
    endMs: now + 1_000,
  });
  assert.strictEqual(result.integrity, 'ok');
  const exported = new Database(exportedPath, { readonly: true });
  try {
    assert.strictEqual(exported.prepare('SELECT COUNT(*) n FROM raw_trades').get().n, 3);
    assert.strictEqual(exported.prepare(`
      SELECT COUNT(*) n FROM sqlite_master WHERE name='raw_trade_shard_meta'
    `).get().n, 0);
  } finally {
    exported.close();
  }

  const snapshotPath = path.join(directory, 'snapshot.db');
  fs.copyFileSync(dbPath, snapshotPath);
  const merged = mergeRawShards(snapshotPath);
  assert.strictEqual(merged.mergedShards, 2);
  const snapshot = new Database(snapshotPath, { readonly: true });
  try {
    assert.strictEqual(snapshot.prepare('SELECT COUNT(*) n FROM raw_trades').get().n, 3);
    assert.strictEqual(snapshot.prepare(`
      SELECT COUNT(*) n FROM sqlite_master WHERE name='raw_trade_shard_meta'
    `).get().n, 0);
  } finally {
    snapshot.close();
  }

  fs.rmSync(directory, { recursive: true, force: true });
  console.log('test-raw-trade-sharding: ok');
}

main();
