'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResearchStore } = require('../src/data/ResearchStore');
const { normalizeRawExecutionContext } = require('../src/data/RawTradeShardManager');

const optional = ['pool', 'poolBaseReservesRaw', 'poolQuoteReservesRaw', 'virtualQuoteReservesRaw'];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-raw-boundary-'));

function legacyRow(store, signature) {
  const at = Date.now();
  store.queueRawTrade({ timestampMs: at, receivedAtMs: at, signature,
    market: 'PUMP_AMM', mint: 'boundary-mint', side: 'BUY',
    solAmount: 0.1, tokenAmount: 100, price: 0.001 });
  const row = store.rawBuffer.pop();
  for (const key of optional) delete row[key];
  return row;
}

try {
  for (const rawShardingEnabled of [false, true]) {
    const root = path.join(directory, rawShardingEnabled ? 'shard' : 'main');
    const store = new ResearchStore({
      dbPath: path.join(root, 'research.db'), rawShardDir: path.join(root, 'raw-daily'),
      archiveDir: root, flushMs: 60_000, flushMax: 100,
      rawShardingEnabled, busyTimeoutMs: 50,
    }, { configuredTradingCostPct: 0 });
    try {
      store.ensureToken('boundary-mint');
      const legacy = Object.freeze(legacyRow(store, 'legacy'));
      const precise = Object.freeze({ ...legacyRow(store, 'precise'), pool: 'observed-pool',
        poolBaseReservesRaw: 123456789012345678901234567890n,
        poolQuoteReservesRaw: 987654321098765432109876543210n,
        virtualQuoteReservesRaw: 0n });
      store.rawBuffer.push(legacy, precise);
      assert.equal(store.flushRawTrades(), 2);
      assert.equal(store.rawBuffer.length, 0);
      const legacyStored = store.db.prepare("SELECT * FROM raw_trades_all WHERE signature='legacy'").get();
      assert.equal(legacyStored.pool, null);
      assert.equal(legacyStored.pool_base_reserves_raw, null);
      assert.equal(legacyStored.pool_quote_reserves_raw, null);
      assert.equal(legacyStored.virtual_quote_reserves_raw, null);
      assert(!Object.hasOwn(legacy, 'pool'), 'write normalization must not mutate legacy objects');
      const stored = store.db.prepare("SELECT * FROM raw_trades_all WHERE signature='precise'").get();
      assert.equal(stored.pool, 'observed-pool');
      assert.equal(stored.pool_base_reserves_raw, '123456789012345678901234567890');
      assert.equal(stored.pool_quote_reserves_raw, '987654321098765432109876543210');
      assert.equal(stored.virtual_quote_reserves_raw, '0');

      // Re-delivery after an uncertain acknowledgement remains idempotent.
      store.rawBuffer.push(legacy, precise);
      assert.equal(store.flushRawTrades(), 2);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 2);

      // A failure on the second row rolls back the whole transaction and keeps
      // every queued object in order. Missing required fields must still fail.
      const first = Object.freeze(legacyRow(store, 'retry-first'));
      const malformed = legacyRow(store, 'retry-second');
      delete malformed.market;
      store.rawBuffer.push(first, malformed);
      assert.throws(() => store.flushRawTrades(), /Missing named parameter "market"/);
      assert.deepEqual(store.rawBuffer, [first, malformed]);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 2);
      const health = store.healthSnapshot();
      assert.equal(health.writeStatus, 'DEGRADED');
      assert.equal(health.lastWriteErrorCode, 'SQLITE_BINDING');
      assert.equal(health.lastWriteErrorKind, 'BINDING');
      assert.equal(health.lastWriteMissingParameter, 'market');
      assert.equal(health.sqliteBusyErrors, 0, 'binding failure is not lock contention');
      assert.equal(health.tradesDroppedBackpressure, 0);
      malformed.market = 'PUMP_AMM';
      store.nextWriteRetryAt = 0;
      assert.equal(store.flushRawTrades(), 2);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 4);
      assert.equal(store.rawBuffer.length, 0);

      if (rawShardingEnabled) {
        // An old ResearchStore may call a new shard manager directly, bypassing
        // ResearchStore's normalization: the shard boundary protects that too.
        const direct = Object.freeze(legacyRow(store, 'old-store-direct-shard'));
        store.rawTradeShards.prepareBatch([direct]);
        assert.equal(store.rawTradeShards.insert(direct).changes, 1);
        assert.equal(store.rawTradeShards.insert(direct).changes, 0);
        assert.equal(store.db.prepare("SELECT pool FROM raw_trades_all WHERE signature=?")
          .get(direct.signature).pool, null);
      }
      const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      store._noteWriteFailure(busy);
      assert.equal(store.healthSnapshot().lastWriteErrorKind, 'CONTENTION');
      assert.equal(store.healthSnapshot().lastWriteMissingParameter, null);
    } finally { store.close(); }
  }
  assert.deepEqual(normalizeRawExecutionContext({}), {
    pool: null, poolBaseReservesRaw: null, poolQuoteReservesRaw: null, virtualQuoteReservesRaw: null,
  });
  console.log('test-raw-write-boundary-compatibility: ok (main/shard legacy, atomic retry, duplicates, bigint, error classification)');
} finally {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('flow-raw-boundary-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
