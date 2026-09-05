'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const { PumpEventParser, DISCRIMINATORS } = require('../src/core/PumpEventParser');
const {
  EXECUTION_COLUMNS, attachRawTradeReadView, shanghaiDay,
} = require('../src/data/RawTradeShardManager');
const { mergeRawShards } = require('../src/data/ResearchSnapshot');
const { exportResearchWindow } = require('./export-research-window');
const { restoreRawExecutionContext } = require('../src/data/RawExecutionContext');

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
    ammQuoteState: 'POST_TRADE_V1', ammQuoteStateReason: null,
    prePoolBaseReservesRaw: '12345678901234567990',
    prePoolQuoteReservesRaw: '9876543210987654300', preReservePrice: 0.0009,
    ammExecutionFees: { lpFeeBasisPoints: 100, protocolFeeBasisPoints: 25,
      coinCreatorFeeBasisPoints: 50, buybackFeeBasisPoints: 0 },
  };
}

function checkContext(row) {
  assert.equal(row.pool, 'test-amm-pool');
  assert.equal(row.pool_base_reserves_raw, '12345678901234567890');
  assert.equal(row.pool_quote_reserves_raw, '9876543210987654321');
  assert.equal(row.virtual_quote_reserves_raw, '0');
  assert.equal(row.slot, 444311319);
  assert.equal(row.event_index, 1);
  const context = restoreRawExecutionContext(row);
  assert.equal(context.ammQuoteState, 'POST_TRADE_V1');
  assert.equal(context.ammQuoteStateReason, null);
  assert.equal(context.prePoolBaseReservesRaw, '12345678901234567990');
  assert.equal(context.prePoolQuoteReservesRaw, '9876543210987654300');
  assert.equal(context.preReservePrice, 0.0009);
  assert.deepEqual(context.ammExecutionFees, trade(1, 'unused').ammExecutionFees);
}

// Exercise wire decoding as well as storage. Signed virtual reserves must never
// pass through Number; these values deliberately exceed Number.MAX_SAFE_INTEGER.
function parsedAmmTrades(receivedAt, signatureByte) {
  const u64 = (value) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
  const i64 = (value) => { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(BigInt(value)); return bytes; };
  const i128 = (value) => {
    const bytes = Buffer.alloc(16), signed = BigInt(value);
    bytes.writeBigUInt64LE(BigInt.asUintN(64, signed), 0);
    bytes.writeBigInt64LE(signed >> 64n, 8);
    return bytes;
  };
  const pubkey = (byte) => Buffer.alloc(32, byte);
  const text = (value) => {
    const bytes = Buffer.from(value), length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const chainSeconds = Math.floor((receivedAt - 700) / 1000);
  const poolBase = '12345678901234567890', poolQuote = '9876543210987654321';
  const virtualQuote = '-9007199254740993';
  const amm = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const wsol = 'So11111111111111111111111111111111111111112';
  const payloads = ['BUY', 'SELL'].map((side) => Buffer.concat([
    side === 'BUY' ? DISCRIMINATORS.ammBuy : DISCRIMINATORS.ammSell,
    i64(chainSeconds), u64(50_000_000), u64(2_000_000_000),
    u64(0), u64(0), u64(poolBase), u64(poolQuote), u64(1_000_000_000),
    u64(100), u64(10_000_000), u64(25), u64(2_500_000), u64(990_000_000), u64(1_002_500_000),
    pubkey(6), pubkey(2), pubkey(10), pubkey(11), pubkey(12), pubkey(13), pubkey(14),
    u64(50), u64(5_000_000),
    ...(side === 'BUY' ? [Buffer.from([1]), u64(0), u64(0), u64(1_000_000_000),
      i64(chainSeconds), u64(45_000_000), text('buy_exact_quote_in')] : []),
    u64(0), u64(0), u64(0), u64(0), i128(virtualQuote), Buffer.from([1]),
  ]));
  const parser = new PumpEventParser({
    pumpProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', pumpAmmProgramId: amm, wsolMint: wsol,
  });
  const events = parser.parseTransaction({
    slot: 444311320, transaction: { signature: Buffer.alloc(64, signatureByte) },
    meta: { err: null, preTokenBalances: [{ mint: 'context-mint' }, { mint: wsol }],
      logMessages: [`Program ${amm} invoke [1]`, ...payloads.map((bytes) => `Program data: ${bytes.toString('base64')}`),
        `Program ${amm} success`] },
  }, receivedAt);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.side), ['BUY', 'SELL']);
  assert.deepEqual(events.map((event) => event.eventIndex), [0, 1]);
  for (const event of events) {
    assert.equal(event.ammQuoteState, 'POST_TRADE_V1', event.ammQuoteStateReason);
    assert.equal(event.prePoolBaseReservesRaw, poolBase);
    assert.equal(event.prePoolQuoteReservesRaw, poolQuote);
    assert.notEqual(event.poolBaseReservesRaw, poolBase, 'wire pre-state must not masquerade as post-state');
    assert.notEqual(event.poolQuoteReservesRaw, poolQuote);
    assert(event.ammExecutionFees);
    assert.equal(event.virtualQuoteReservesRaw, virtualQuote);
    assert.equal(event.chainTimestampMs, chainSeconds * 1000);
    assert.equal(event.receivedAtMs, receivedAt);
    assert.equal(event.timestampMs, receivedAt);
    assert.equal(event.slot, 444311320);
  }
  return events;
}

function checkParsedContext(row, event, camelCase = false) {
  const fields = {
    pool: 'pool', pool_base_reserves_raw: 'poolBaseReservesRaw', pool_quote_reserves_raw: 'poolQuoteReservesRaw',
    virtual_quote_reserves_raw: 'virtualQuoteReservesRaw', chain_timestamp_ms: 'chainTimestampMs',
    received_at_ms: 'receivedAtMs', timestamp_ms: 'timestampMs', slot: 'slot', signature: 'signature',
    event_index: 'eventIndex', side: 'side', market: 'market',
  };
  for (const [column, key] of Object.entries(fields)) assert.equal(row[camelCase ? key : column], event[key], key);
  const context = restoreRawExecutionContext(row);
  for (const key of ['ammQuoteState', 'ammQuoteStateReason', 'prePoolBaseReservesRaw',
    'prePoolQuoteReservesRaw', 'preReservePrice']) assert.equal(context[key], event[key], key);
  assert.deepEqual(context.ammExecutionFees, event.ammExecutionFees);
}

function checkUnknown(row) {
  for (const column of EXECUTION_COLUMNS) assert.equal(row[column], null, `${column} must remain unknown`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-raw-context-'));
try {
  const file = path.join(root, 'research.db');
  const shards = path.join(root, 'raw-daily');
  const now = Date.now();
  const previous = now - 24 * 60 * 60_000;
  const mainParsed = parsedAmmTrades(now - 500, 60);
  const shardParsed = parsedAmmTrades(now + 1500, 61);
  const settings = {
    dbPath: file, archiveDir: root, flushMs: 60_000, flushMax: 100,
    rawShardDir: shards, rawShardReadDays: 3, busyTimeoutMs: 1_000,
  };
  let db = new Database(file);
  legacySchema(db);
  db.prepare(`INSERT INTO raw_trades(timestamp_ms,received_at_ms,signature,market,mint,side,
    sol_amount,token_amount,price) VALUES(?,?,'old-main','PUMP_AMM','old-mint','BUY',1,1,1)`)
    .run(previous - 500, previous - 500);
  db.close();
  let store = new ResearchStore(settings, { configuredTradingCostPct: 1.4 });
  try {
    assert(EXECUTION_COLUMNS.every((column) => store.db
      .prepare('PRAGMA table_info(raw_trades)').all().some((row) => row.name === column)));
    store.ensureToken('context-mint');
    store.queueRawTrade(trade(now - 1_000, 'new-main'));
    store.flushRawTrades();
    checkContext(store.db.prepare("SELECT * FROM raw_trades WHERE signature='new-main'").get());
    checkUnknown(store.db.prepare("SELECT * FROM raw_trades WHERE signature='old-main'").get());
    const replay = store.recentAmmTrades(now - 2_000)[0];
    assert.equal(replay.pool, 'test-amm-pool');
    assert.equal(replay.poolBaseReservesRaw, '12345678901234567890');
    assert.equal(replay.chainTimestampMs, now - 1_700);
    assert.equal(replay.signature, 'new-main');
    assert.equal(replay.ammQuoteState, 'POST_TRADE_V1');
    assert.equal(replay.prePoolBaseReservesRaw, '12345678901234567990');
    for (const event of mainParsed) store.queueRawTrade(event);
    store.flushRawTrades();
    for (const event of mainParsed) {
      checkParsedContext(store.db.prepare('SELECT * FROM raw_trades WHERE signature=? AND event_index=?')
        .get(event.signature, event.eventIndex), event);
      checkParsedContext(store.stmts.recentAmmTrades.all(now - 2_000)
        .find((row) => row.signature === event.signature && row.eventIndex === event.eventIndex), event, true);
    }
    store.primeStartupTradeReplay(now - 2_000);
    const readsAfterPrime = store.startupTradeReplayHealth().dbReads;
    const cachedReplay = store.recentAmmTrades(now - 2_000);
    for (const event of mainParsed) {
      checkParsedContext(cachedReplay.find((row) => row.signature === event.signature
        && row.eventIndex === event.eventIndex), event, true);
    }
    const firstCached = cachedReplay.find((row) => row.signature === mainParsed[0].signature
      && row.eventIndex === mainParsed[0].eventIndex);
    firstCached.ammExecutionFees.lpFeeBasisPoints = 9999;
    const nextCached = store.recentAmmTrades(now - 2_000).find((row) => row.signature === mainParsed[0].signature
      && row.eventIndex === mainParsed[0].eventIndex);
    assert.equal(nextCached.ammExecutionFees.lpFeeBasisPoints, mainParsed[0].ammExecutionFees.lpFeeBasisPoints,
      'one replay consumer must not mutate the shared cached fee context');
    assert.equal(store.startupTradeReplayHealth().dbReads, readsAfterPrime,
      'context decoding must use the existing shared startup replay, not another DB scan');
    store.releaseStartupTradeReplay();
    for (const event of mainParsed) store.queueRawTrade(event);
    store.flushRawTrades();
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM raw_trades').get().n, 4,
      'two distinct events within one signature survive while exact re-delivery is idempotent');
  } finally { store.close(); }

  fs.mkdirSync(shards);
  const oldShard = path.join(shards, `raw-trades-${shanghaiDay(previous)}-CST.db`);
  db = new Database(oldShard);
  // Production daily shards already use WAL; changing journal mode would alter
  // a legacy test file's header without changing any historical row or schema.
  db.pragma('journal_mode = WAL');
  legacySchema(db);
  db.prepare(`INSERT INTO raw_trades(timestamp_ms,received_at_ms,signature,market,mint,side,
    sol_amount,token_amount,price) VALUES(?,?,'old-shard','PUMP_AMM','old-mint','BUY',1,1,1)`)
    .run(previous, previous);
  db.close();
  const oldShardHash = crypto.createHash('sha256').update(fs.readFileSync(oldShard)).digest('hex');

  store = new ResearchStore({ ...settings, rawShardingEnabled: true }, { configuredTradingCostPct: 1.4 });
  try {
    store.queueRawTrade(trade(now + 1_000, 'new-shard'));
    for (const event of shardParsed) store.queueRawTrade(event);
    store.flushRawTrades();
    checkContext(store.db.prepare("SELECT * FROM raw_trades_all WHERE signature='new-shard'").get());
    assert.equal(store.db.prepare("SELECT pool FROM raw_trades_all WHERE signature='old-shard'").get().pool, null);
    for (const event of shardParsed) {
      checkParsedContext(store.db.prepare('SELECT * FROM raw_trades_all WHERE signature=? AND event_index=?')
        .get(event.signature, event.eventIndex), event);
      checkParsedContext(store.stmts.recentAmmTrades.all(now)
        .find((row) => row.signature === event.signature && row.eventIndex === event.eventIndex), event, true);
    }
  } finally { store.close(); }

  db = new Database(oldShard, { readonly: true });
  assert(!db.prepare('PRAGMA table_info(raw_trades)').all().some((row) => row.name === 'pool'),
    'reading a historical shard must not rewrite its schema');
  db.close();
  db = new Database(file, { readonly: true });
  attachRawTradeReadView(db, { dbPath: file, now: now + 2_000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 8);
  checkContext(db.prepare("SELECT * FROM raw_trades_all WHERE signature='new-shard'").get());
  db.close();

  const exportedFile = path.join(root, 'export.db');
  assert.equal(exportResearchWindow({ sourcePath: file, destinationPath: exportedFile,
    startMs: previous - 1_000, endMs: now + 3_000 }).integrity, 'ok');
  db = new Database(exportedFile, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_trades').get().n, 8);
  checkContext(db.prepare("SELECT * FROM raw_trades WHERE signature='new-shard'").get());
  assert.equal(db.prepare("SELECT pool FROM raw_trades WHERE signature='old-shard'").get().pool, null);
  for (const event of [...mainParsed, ...shardParsed]) {
    checkParsedContext(db.prepare('SELECT * FROM raw_trades WHERE signature=? AND event_index=?')
      .get(event.signature, event.eventIndex), event);
  }
  for (const signature of ['old-main', 'old-shard']) {
    checkUnknown(db.prepare('SELECT * FROM raw_trades WHERE signature=?').get(signature));
  }
  db.close();

  const snapshotFile = path.join(root, 'snapshot.db');
  fs.copyFileSync(file, snapshotFile);
  mergeRawShards(snapshotFile);
  db = new Database(snapshotFile, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_trades').get().n, 8);
  checkContext(db.prepare("SELECT * FROM raw_trades WHERE signature='new-shard'").get());
  for (const event of [...mainParsed, ...shardParsed]) {
    checkParsedContext(db.prepare('SELECT * FROM raw_trades WHERE signature=? AND event_index=?')
      .get(event.signature, event.eventIndex), event);
  }
  db.close();
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(oldShard)).digest('hex'), oldShardHash,
    'read projections, exports, and snapshots must not rewrite the historical shard');
  console.log('test-raw-execution-context: ok (AMM BUY/SELL parser, signed reserves, timing/event identity, legacy main, mixed shards, replay, export, snapshot)');
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('flow-raw-context-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
