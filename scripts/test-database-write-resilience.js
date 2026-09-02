'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');

function signal(timestampMs) {
  return {
    timestampMs,
    slot: 1,
    signature: 'write-resilience-signal',
    mint: 'write-resilience-mint',
    symbol: 'LOCK',
    ageMs: 10_000,
    curvePct: 70,
    price: 1,
    buyFlowW1: 1,
    buyFlowW2: 2,
    buyFlowW3: 3,
    sellFlowW1: 0,
    sellFlowW2: 0,
    sellFlowW3: 0,
    netFlowW1: 1,
    netFlowW2: 2,
    netFlowW3: 3,
    deltaNetFlow12: 1,
    deltaNetFlow23: 1,
    uniqueBuyersW1: 1,
    uniqueBuyersW2: 2,
    uniqueBuyersW3: 3,
    buyTxW1: 1,
    buyTxW2: 2,
    buyTxW3: 3,
    flowAccel1: 2,
    flowAccel2: 1.5,
  };
}

function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-write-resilience-'));
  const dbPath = path.join(directory, 'research.db');
  const store = new ResearchStore({
    dbPath,
    archiveDir: directory,
    rawRetentionHours: 48,
    busyTimeoutMs: 50,
    writeRetryMinMs: 50,
    writeRetryMaxMs: 50,
    flushMs: 60_000,
    flushMax: 10,
  }, { configuredTradingCostPct: 0 });
  let locker;
  let deferredGraduatedAt;
  let deferredMigratedAt;
  try {
    store.ensureToken('write-resilience-mint');
    const saved = store.recordSignal(signal(Date.now()));
    locker = new Database(dbPath);
    locker.pragma('busy_timeout = 50');
    locker.exec('BEGIN IMMEDIATE');

    assert.doesNotThrow(() => {
      const persisted = store.updateSignalReturn(saved.signalId, {
        return_1s: 10,
        net_return_1s: 10,
        last_observed_at: Date.now(),
      });
      assert.strictEqual(persisted, false);
    });
    assert.doesNotThrow(() => {
      store.recordCreate({
        mint: 'deferred-graduation-mint',
        symbol: 'DEFER',
        name: null,
        uri: null,
        bondingCurve: 'deferred-curve',
        creator: 'deferred-creator',
        createdAt: Date.now() - 1_000,
        initialRealTokenReservesRaw: null,
        tokenTotalSupplyRaw: null,
      });
      const graduatedAt = Date.now();
      const token = store.recordComplete({
        mint: 'deferred-graduation-mint',
        bondingCurve: 'deferred-curve',
        completedAt: graduatedAt,
        timestampMs: graduatedAt,
      });
      assert.strictEqual(token.graduated_at, graduatedAt);
      const migratedAt = graduatedAt + 90_000;
      const migratedToken = store.recordMigration({
        mint: 'deferred-graduation-mint',
        bondingCurve: 'deferred-curve',
        pool: 'deferred-pool',
        migratedAt,
        timestampMs: migratedAt,
      });
      assert.strictEqual(migratedToken.graduated_at, graduatedAt);
      assert.strictEqual(migratedToken.migrated_at, migratedAt);
      deferredGraduatedAt = graduatedAt;
      deferredMigratedAt = migratedAt;
    });
    let health = store.healthSnapshot();
    assert.strictEqual(health.writeStatus, 'LOCKED');
    assert.strictEqual(health.pendingLabelWrites, 1);
    assert.strictEqual(health.pendingTokenWrites, 1);
    assert.strictEqual(health.sqliteBusyErrors, 1);

    store.queueRawTrade({
      timestampMs: Date.now(),
      receivedAtMs: Date.now(),
      signature: 'write-resilience-trade',
      eventIndex: 0,
      market: 'PUMP_BONDING_CURVE',
      mint: 'write-resilience-mint',
      wallet: 'write-resilience-wallet',
      side: 'BUY',
      solAmount: 1,
      tokenAmount: 1,
      price: 1,
    });
    assert.strictEqual(store.flushRawTrades(), 0);
    assert.strictEqual(store.healthSnapshot().pendingWrites, 1);

    locker.exec('ROLLBACK');
    locker.close();
    locker = null;
    store.nextWriteRetryAt = 0;
    assert.strictEqual(store.flushDeferredTokenWrites(), 1);
    assert.strictEqual(store.flushDeferredSignalReturnUpdates(), 1);
    assert.strictEqual(store.flushRawTrades(), 1);

    const restored = store.db.prepare(`
      SELECT return_1s, net_return_1s FROM signal_returns WHERE signal_id=?
    `).get(saved.signalId);
    assert.strictEqual(restored.return_1s, 10);
    assert.strictEqual(restored.net_return_1s, 10);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM raw_trades').get().n, 1);
    const deferredToken = store.db.prepare(`
      SELECT graduated_at, migrated_at, migration_source, migration_pool
      FROM flow_tokens WHERE mint='deferred-graduation-mint'
    `).get();
    assert.strictEqual(deferredToken.graduated_at, deferredGraduatedAt);
    assert.strictEqual(deferredToken.migrated_at, deferredMigratedAt);
    assert.strictEqual(deferredToken.migration_source, 'CHAIN_EVENT');
    assert.strictEqual(deferredToken.migration_pool, 'deferred-pool');
    health = store.healthSnapshot();
    assert.strictEqual(health.writeStatus, 'HEALTHY');
    assert.strictEqual(health.pendingWrites, 0);
    assert.strictEqual(health.pendingLabelWrites, 0);
    assert.strictEqual(health.pendingTokenWrites, 0);
    assert.strictEqual(health.labelWritesRecovered, 1);
    assert.strictEqual(health.tokenWritesRecovered, 1);
    assert.ok(health.lastPersistedTradeAt > 0);
  } finally {
    if (locker) {
      try { locker.exec('ROLLBACK'); } catch (_) {}
      locker.close();
    }
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log('test-database-write-resilience: ok');
}

main();
