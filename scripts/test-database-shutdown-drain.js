'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore, DatabaseShutdownDrainError } = require('../src/data/ResearchStore');

const EMPTY = { pendingWrites: 0, pendingTokenWrites: 0, pendingLabelWrites: 0 };
const FULL = { pendingWrites: 1, pendingTokenWrites: 1, pendingLabelWrites: 1 };

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-shutdown-drain-'));
  const dbPath = path.join(directory, 'research.db');
  const store = new ResearchStore({
    dbPath, archiveDir: directory, rawRetentionHours: 48,
    rawShardingEnabled: false, busyTimeoutMs: 50,
    writeRetryMinMs: 50, writeRetryMaxMs: 50,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  store.ensureToken('shutdown-mint');
  const now = Date.now();
  const { signalId } = store.recordSignal({
    timestampMs: now, mint: 'shutdown-mint', price: 1,
    slot: 1, signature: 'shutdown-signal', symbol: 'DRAIN', ageMs: 1_000, curvePct: 70,
    buyFlowW1: 1, buyFlowW2: 2, buyFlowW3: 3,
    sellFlowW1: 0, sellFlowW2: 0, sellFlowW3: 0,
    netFlowW1: 1, netFlowW2: 2, netFlowW3: 3,
    deltaNetFlow12: 1, deltaNetFlow23: 1,
    uniqueBuyersW1: 1, uniqueBuyersW2: 2, uniqueBuyersW3: 3,
    buyTxW1: 1, buyTxW2: 2, buyTxW3: 3, flowAccel1: 2, flowAccel2: 1.5,
  });
  let locker;
  return {
    store, dbPath, signalId,
    lock() {
      locker = new Database(dbPath);
      locker.exec('BEGIN IMMEDIATE');
    },
    unlock() {
      if (!locker) return;
      locker.exec('ROLLBACK');
      locker.close();
      locker = null;
    },
    queueTrade(index = 0) {
      store.queueRawTrade({
        timestampMs: now + index, receivedAtMs: now + index,
        signature: `shutdown-trade-${index}`, eventIndex: 0,
        market: 'PUMP_BONDING_CURVE', mint: 'shutdown-mint',
        wallet: 'shutdown-wallet', side: 'BUY', solAmount: 1, tokenAmount: 1, price: 1,
      });
    },
    queueAllUnderLock() {
      this.lock();
      assert.strictEqual(store.updateSignalReturn(signalId, { return_1s: 12 }), false);
      store.ensureToken('shutdown-deferred-mint');
      this.queueTrade();
      assert.deepStrictEqual(store.pendingWriteCounts(), FULL);
    },
    dispose() {
      this.unlock();
      // Only the isolated test fixture bypasses the guarded close so a failed
      // assertion cannot leave timers, handles, or temporary databases behind.
      store._stopBackgroundTasks();
      if (store.db.open) store.db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function assertPersisted(db, signalId) {
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM raw_trades').get().n, 1);
  assert.strictEqual(db.prepare('SELECT return_1s FROM signal_returns WHERE signal_id = ?').get(signalId).return_1s, 12);
  assert.ok(db.prepare('SELECT mint FROM flow_tokens WHERE mint = ?').get('shutdown-deferred-mint'));
}

async function testLockRecovery() {
  const context = fixture();
  let releaseTimer;
  try {
    const { store, signalId } = context;
    context.queueAllUnderLock();
    const progress = [];
    let releasedDuringDrain = false;
    releaseTimer = setTimeout(() => {
      context.unlock();
      releasedDuringDrain = true;
    }, 70);
    const result = await store.drainPendingWrites({
      timeoutMs: 2_000, retryIntervalMs: 10, batchSize: 1,
      onProgress: (state) => progress.push(state),
    });
    assert.strictEqual(result.drained, true);
    assert.ok(releasedDuringDrain, 'drain must yield so the lock release can run');
    assert.ok(result.attempts > 3, 'at least one contended flush was retried');
    assert.deepStrictEqual(store.pendingWriteCounts(), EMPTY);
    assert.strictEqual(progress[0].drained, false);
    assert.strictEqual(progress.at(-1).drained, true);
    assert.strictEqual(store.db.open, true, 'drain itself must not close the connection');
    assertPersisted(store.db, signalId);
    store.close();
    assert.strictEqual(store.db.open, false);
  } finally {
    clearTimeout(releaseTimer);
    context.dispose();
  }
}

async function testTimeoutAndCloseKeepQueues() {
  const context = fixture();
  try {
    const { store } = context;
    context.queueAllUnderLock();
    const raw = store.rawBuffer[0];
    const token = store.pendingTokenWrites.get('shutdown-deferred-mint');
    const label = store.pendingSignalReturnUpdates.get(context.signalId);
    await assert.rejects(store.drainPendingWrites({ timeoutMs: 80, retryIntervalMs: 10 }), (error) => {
      assert.ok(error instanceof DatabaseShutdownDrainError);
      assert.strictEqual(error.code, 'FLOW_DB_DRAIN_TIMEOUT');
      assert.strictEqual(error.drained, false);
      assert.deepStrictEqual(error.pending, FULL);
      assert.ok(error.attempts > 0);
      return true;
    });
    assert.strictEqual(store.db.open, true);
    assert.deepStrictEqual(store.pendingWriteCounts(), FULL);
    assert.strictEqual(store.rawBuffer[0], raw);
    assert.strictEqual(store.pendingTokenWrites.get('shutdown-deferred-mint'), token);
    assert.strictEqual(store.pendingSignalReturnUpdates.get(context.signalId), label);
    assert.throws(() => store.close(), (error) => {
      assert.ok(error instanceof DatabaseShutdownDrainError);
      assert.strictEqual(error.code, 'FLOW_DB_CLOSE_PENDING');
      assert.deepStrictEqual(error.pending, FULL);
      return true;
    });
    assert.strictEqual(store.db.open, true);
    context.unlock();
    await store.drainPendingWrites({ timeoutMs: 2_000 });
    assertPersisted(store.db, context.signalId);
    store.close();
  } finally {
    context.dispose();
  }
}

async function testPermanentErrorIsNotSwallowed() {
  const context = fixture();
  try {
    const { store } = context;
    context.queueTrade();
    const raw = store.rawBuffer[0];
    store.db.exec(`CREATE TRIGGER shutdown_test_reject BEFORE INSERT ON raw_trades
      BEGIN SELECT RAISE(ABORT, 'shutdown fixture permanent failure'); END`);
    const checkError = (error) => {
      assert.ok(error instanceof DatabaseShutdownDrainError);
      assert.strictEqual(error.code, 'FLOW_DB_DRAIN_FAILED');
      assert.strictEqual(error.cause.code, 'SQLITE_CONSTRAINT_TRIGGER');
      assert.match(error.cause.message, /shutdown fixture permanent failure/);
      assert.strictEqual(error.pending.pendingWrites, 1);
      return true;
    };
    await assert.rejects(store.drainPendingWrites({ timeoutMs: 2_000 }), checkError);
    assert.strictEqual(store.rawBuffer[0], raw);
    assert.strictEqual(store.db.open, true);
    assert.throws(() => store.close(), checkError);
    assert.strictEqual(store.rawBuffer[0], raw);
    assert.strictEqual(store.db.open, true);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM raw_trades').get().n, 0);
    store.db.exec('DROP TRIGGER shutdown_test_reject');
    const result = await store.drainPendingWrites();
    assert.strictEqual(result.drained, true);
    assert.deepStrictEqual(store.pendingWriteCounts(), EMPTY);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM raw_trades').get().n, 1);
    store.close();
  } finally {
    context.dispose();
  }
}

async function testBatchYieldAndConcurrentDrain() {
  const context = fixture();
  try {
    const { store } = context;
    for (let index = 0; index < 3; index += 1) context.queueTrade(index);
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const active = store.drainPendingWrites({ timeoutMs: 2_000, batchSize: 1 });
    const joined = store.drainPendingWrites({ timeoutMs: 2_000, batchSize: 1 });
    assert.throws(() => store.close(), { code: 'FLOW_DB_DRAIN_IN_PROGRESS' });
    const [first, second] = await Promise.all([active, joined]);
    assert.ok(yielded);
    assert.deepStrictEqual(first, second);
    assert.strictEqual(first.attempts, 3);
    assert.deepStrictEqual(store.pendingWriteCounts(), EMPTY);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM raw_trades').get().n, 3);
    assert.strictEqual((await store.drainPendingWrites({ timeoutMs: 0 })).drained, true);
    store.close();
  } finally {
    context.dispose();
  }
}

function testSynchronousClose() {
  const context = fixture();
  try {
    const { store } = context;
    context.queueAllUnderLock();
    context.unlock();
    assert.strictEqual(store.close(), undefined, 'normal close remains synchronous');
    assert.deepStrictEqual(store.pendingWriteCounts(), EMPTY);
    assert.strictEqual(store.db.open, false);
    assert.doesNotThrow(() => store.close(), 'close is idempotent once drained');
    const reader = new Database(context.dbPath, { readonly: true });
    try { assertPersisted(reader, context.signalId); } finally { reader.close(); }
  } finally {
    context.dispose();
  }
}

async function main() {
  await testLockRecovery();
  await testTimeoutAndCloseKeepQueues();
  await testPermanentErrorIsNotSwallowed();
  await testBatchYieldAndConcurrentDrain();
  testSynchronousClose();
  console.log('test-database-shutdown-drain: ok');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
