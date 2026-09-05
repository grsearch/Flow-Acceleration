'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  EXECUTION_COLUMNS, attachRawTradeReadView, shanghaiDay,
} = require('../src/data/RawTradeShardManager');
const { mergeRawShards } = require('../src/data/ResearchSnapshot');
const { exportResearchWindow } = require('./export-research-window');

function legacySchema(db) {
  db.exec(`CREATE TABLE raw_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_ms INTEGER NOT NULL,
    chain_timestamp_ms INTEGER, received_at_ms INTEGER NOT NULL, slot INTEGER,
    signature TEXT, event_index INTEGER NOT NULL DEFAULT 0, market TEXT NOT NULL,
    mint TEXT NOT NULL, bonding_curve TEXT, wallet TEXT, side TEXT NOT NULL,
    sol_amount REAL NOT NULL, token_amount REAL NOT NULL, price REAL NOT NULL,
    reserve_price REAL, curve_pct REAL, virtual_sol_reserves_raw TEXT,
    virtual_token_reserves_raw TEXT, real_sol_reserves_raw TEXT, real_token_reserves_raw TEXT,
    UNIQUE(signature,event_index,market));`);
}

function trade(at, signature) {
  return {
    mint: 'context-mint', timestampMs: at, receivedAtMs: at, chainTimestampMs: at - 700,
    slot: 444311319, signature, eventIndex: 1, market: 'PUMP_AMM', side: 'BUY',
    wallet: 'test-wallet', solAmount: 0.1, tokenAmount: 100, price: 0.001,
    reservePrice: 0.001, pool: 'test-amm-pool',
    poolBaseReservesRaw: '12345678901234567890', poolQuoteReservesRaw: '9876543210987654321',
    virtualQuoteReservesRaw: '0',
  };
}

function checkContext(row) {
  assert.equal(row.pool, 'test-amm-pool');
  assert.equal(row.pool_base_reserves_raw, '12345678901234567890');
  assert.equal(row.pool_quote_reserves_raw, '9876543210987654321');
  assert.equal(row.virtual_quote_reserves_raw, '0');
  assert.equal(row.slot, 444311319);
  assert.equal(row.event_index, 1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-raw-context-'));
try {
  const file = path.join(root, 'research.db');
  const shards = path.join(root, 'raw-daily');
  const now = Date.now();
  const previous = now - 24 * 60 * 60_000;
  const settings = {
    dbPath: file, archiveDir: root, flushMs: 60_000, flushMax: 100,
    rawShardDir: shards, rawShardReadDays: 3, busyTimeoutMs: 1_000,
  };
  let db = new Database(file);
  legacySchema(db);
  db.close();
  let store = new ResearchStore(settings, { configuredTradingCostPct: 1.4 });
  try {
    assert(EXECUTION_COLUMNS.every((column) => store.db
      .prepare('PRAGMA table_info(raw_trades)').all().some((row) => row.name === column)));
    store.ensureToken('context-mint');
    store.queueRawTrade(trade(now - 1_000, 'new-main'));
    store.flushRawTrades();
    checkContext(store.db.prepare('SELECT * FROM raw_trades').get());
    const replay = store.stmts.recentAmmTrades.all(now - 2_000)[0];
    assert.equal(replay.pool, 'test-amm-pool');
    assert.equal(replay.poolBaseReservesRaw, '12345678901234567890');
    assert.equal(replay.chainTimestampMs, now - 1_700);
    assert.equal(replay.signature, 'new-main');
  } finally { store.close(); }

  fs.mkdirSync(shards);
  const oldShard = path.join(shards, `raw-trades-${shanghaiDay(previous)}-CST.db`);
  db = new Database(oldShard);
  legacySchema(db);
  db.prepare(`INSERT INTO raw_trades(timestamp_ms,received_at_ms,signature,market,mint,side,
    sol_amount,token_amount,price) VALUES(?,?,'old-shard','PUMP_AMM','old-mint','BUY',1,1,1)`)
    .run(previous, previous);
  db.close();

  store = new ResearchStore({ ...settings, rawShardingEnabled: true }, { configuredTradingCostPct: 1.4 });
  try {
    store.queueRawTrade(trade(now + 1_000, 'new-shard'));
    store.flushRawTrades();
    checkContext(store.db.prepare("SELECT * FROM raw_trades_all WHERE signature='new-shard'").get());
    assert.equal(store.db.prepare("SELECT pool FROM raw_trades_all WHERE signature='old-shard'").get().pool, null);
  } finally { store.close(); }

  db = new Database(oldShard, { readonly: true });
  assert(!db.prepare('PRAGMA table_info(raw_trades)').all().some((row) => row.name === 'pool'),
    'reading a historical shard must not rewrite its schema');
  db.close();
  db = new Database(file, { readonly: true });
  attachRawTradeReadView(db, { dbPath: file, now: now + 2_000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 3);
  checkContext(db.prepare("SELECT * FROM raw_trades_all WHERE signature='new-shard'").get());
  db.close();

  const exportedFile = path.join(root, 'export.db');
  assert.equal(exportResearchWindow({ sourcePath: file, destinationPath: exportedFile,
    startMs: previous - 1_000, endMs: now + 3_000 }).integrity, 'ok');
  db = new Database(exportedFile, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_trades').get().n, 3);
  checkContext(db.prepare("SELECT * FROM raw_trades WHERE signature='new-shard'").get());
  assert.equal(db.prepare("SELECT pool FROM raw_trades WHERE signature='old-shard'").get().pool, null);
  db.close();

  const snapshotFile = path.join(root, 'snapshot.db');
  fs.copyFileSync(file, snapshotFile);
  mergeRawShards(snapshotFile);
  db = new Database(snapshotFile, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_trades').get().n, 3);
  checkContext(db.prepare("SELECT * FROM raw_trades WHERE signature='new-shard'").get());
  db.close();
  console.log('test-raw-execution-context: ok (legacy main, mixed shards, replay, export, snapshot)');
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('flow-raw-context-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
