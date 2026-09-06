'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const { SmartWalletRegistry } = require('../src/core/SmartWalletRegistry');

const BASE = 1_900_000_000_000;
let sequence = 0;
function fixture(dbPath = ':memory:', at = BASE) {
  let now = at;
  const timings = [];
  const store = new ResearchStore({ dbPath, archiveDir: '.', flushMs: 60_000,
    flushMax: 1000, rawRetentionHours: 24, busyTimeoutMs: 5000 }, { configuredTradingCostPct: 0 });
  const config = { enabled: true, ageCheckEnabled: true, ageSeedBypass: false,
    eventMonitoringRequiresResolvedAge: true, pnlGateEnabled: true,
    maintenanceWorkerEnabled: false, historyBackfillEnabled: false, clusterAutoEnabled: false,
    seedWallets: [], seedClusters: [], actualEventBackfillIntervalMs: 1000,
    actualEventBackfillBatchSize: 50, costModel: { positionSizeSol: 1 } };
  const registry = new SmartWalletRegistry({ config, store, now: () => now,
    measureTask: (name, callback) => { timings.push(name); return callback(); } });
  return { store, registry, timings, setNow: (value) => { now = value; },
    tick: () => registry._advanceActualEventBackfill(now, { force: true }),
    close: () => store.close() };
}
function event(f, wallet, mint, side, at, sol = side === 'BUY' ? 1 : 1.2) {
  return f.store.recordSmartWalletEvent({ wallet, mint, side, timestampMs: at,
    receivedAtMs: at, solAmount: sol, tokenAmount: 100, price: sol / 100,
    market: 'PUMP_BONDING_CURVE', signature: `outbox-${++sequence}`, eventIndex: 0 });
}
function count(f, table) { return f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; }
function pair(f, wallet, mint, at = BASE) {
  return [event(f, wallet, mint, 'BUY', at), event(f, wallet, mint, 'SELL', at + 1)];
}

function testAtomicOutboxAndAgeIndependence() {
  const f = fixture();
  try {
    f.store.db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON smart_wallet_pnl_pending_events
      BEGIN SELECT RAISE(ABORT,'outbox fixture failure'); END;`);
    assert.throws(() => event(f, 'unknown', 'atomic', 'BUY', BASE), /outbox fixture failure/);
    assert.equal(count(f, 'smart_wallet_events'), 0);
    assert.equal(count(f, 'smart_wallet_positions'), 0);
    f.store.db.exec('DROP TRIGGER fail_outbox');
    f.registry.discoverWallet({ wallet: 'unknown', source: 'CONFIG_SEED',
      discoveredAt: BASE - 1000, effectiveFrom: BASE - 1000 });
    f.registry._refreshWalletEligibilitySnapshot(BASE, { force: true });
    assert.equal(f.registry.cachedMonitoringSnapshot('unknown', BASE), null);
    pair(f, 'unknown', 'atomic');
    pair(f, 'not-in-registry', 'independent');
    assert.equal(count(f, 'smart_wallet_pnl_pending_events'), 4);
    f.tick();
    assert.equal(count(f, 'smart_wallet_pnl_pending_events'), 0);
    assert.equal(count(f, 'smart_wallet_actual_positions'), 2);
    assert.equal(count(f, 'smart_wallet_pnl_processed_events'), 4);
    assert.equal(f.registry.walletSnapshot('unknown', BASE), null, 'AGE must still forbid votes');
    assert.equal(f.registry.actualEventBackfillPending, false);
    pair(f, 'unknown', 'after-idle', BASE + 2000);
    f.setNow(BASE + 3000);
    f.tick(); // No onPersisted wakeup: polling must remain active after an empty batch.
    assert.equal(count(f, 'smart_wallet_actual_positions'), 3);
    assert.equal(f.timings.includes('legacyLedgerRepair'), true);
    assert.equal(f.timings.includes('ledgerQueueConsume'), true);
    assert.equal(f.timings.includes('eligibilitySnapshotForced'), true);
    const realPrepare = f.store.db.prepare;
    f.store.db.prepare = () => { throw new Error('health must not run SQL'); };
    try {
      assert.equal(f.registry.health({ includeDatabase: false }).actualLedger.status, 'CAUGHT_UP');
      assert.equal(f.registry.maintenanceHealth().actualLedger.pendingSampleCount, 0);
    } finally { f.store.db.prepare = realPrepare; }
  } finally { f.close(); }
}

function testFailureHoleAndIdempotence() {
  const f = fixture();
  try {
    const [buy, sell] = pair(f, 'retry-wallet', 'retry-mint');
    pair(f, 'other', 'other-mint');
    f.store.db.exec(`CREATE TRIGGER fail_one_wallet BEFORE INSERT ON smart_wallet_actual_positions
      WHEN NEW.wallet='retry-wallet' BEGIN SELECT RAISE(ABORT,'retry fixture'); END;`);
    f.tick();
    assert.equal(count(f, 'smart_wallet_actual_positions'), 1, 'other mint must continue');
    assert.equal(f.registry.getProcessedActualEvent.get(buy.id), undefined);
    assert.equal(f.registry.getProcessedActualEvent.get(sell.id), undefined,
      'SELL must not overtake a failed BUY and become a false orphan');
    const failed = f.store.db.prepare(`SELECT * FROM smart_wallet_pnl_pending_events
      WHERE smart_event_id=?`).get(buy.id);
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error, /retry fixture/);
    f.store.db.exec('DROP TRIGGER fail_one_wallet');
    f.setNow(BASE + 2000);
    const restored = new SmartWalletRegistry({ config: f.registry.config, store: f.store,
      now: () => BASE + 2000 });
    restored._advanceActualEventBackfill(BASE + 2000, { force: true });
    const position = f.store.db.prepare('SELECT * FROM smart_wallet_actual_positions WHERE wallet=?')
      .get('retry-wallet');
    assert.equal(position.status, 'CLOSED');
    assert.ok(Math.abs(position.realized_pnl_sol - 0.2) < 1e-12);
    assert.equal(count(f, 'smart_wallet_pnl_pending_events'), 0);
    const duplicate = f.registry.processActualWalletEvent({ ...sell, id: sell.id });
    assert.equal(duplicate.duplicate, true);
    assert.equal(count(f, 'smart_wallet_actual_positions'), 2);
    assert.equal(f.store.db.pragma('busy_timeout', { simple: true }), 5000);
  } finally { f.close(); }
}

function testLegacyBoundedRepairAndConflict() {
  const f = fixture();
  try {
    const [buy, sell] = pair(f, 'old', 'old-mint');
    f.store.db.exec('DELETE FROM smart_wallet_pnl_pending_events'); // Pre-outbox database.
    assert.equal(f.registry._backfillActualWalletEvents(1), 1);
    let state = f.store.db.prepare('SELECT * FROM smart_wallet_pnl_repair_state').get();
    assert.equal(state.last_scanned_event_id, buy.id);
    assert.equal(state.high_water_event_id, sell.id);
    assert.equal(state.status, 'SCANNING');
    assert.equal(f.registry._backfillActualWalletEvents(1), 1);
    state = f.store.db.prepare('SELECT * FROM smart_wallet_pnl_repair_state').get();
    assert.equal(state.status, 'COMPLETE');
    assert.equal(count(f, 'smart_wallet_actual_positions'), 1);
    const plans = f.store.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM smart_wallet_events
      WHERE id>? AND id<=? ORDER BY id LIMIT ?`).all(0, sell.id, 1);
    assert.ok(plans.every((p) => !/SCAN |TEMP B-TREE/.test(p.detail)), JSON.stringify(plans));
  } finally { f.close(); }

  const conflict = fixture();
  try {
    const [buy, sell] = pair(conflict, 'hole', 'hole-mint');
    conflict.store.db.exec('DELETE FROM smart_wallet_pnl_pending_events');
    conflict.registry.processActualWalletEvent(sell); // Pre-upgrade ignored SELL.
    conflict.store.db.exec('DELETE FROM smart_wallet_pnl_accounting_cursors');
    pair(conflict, 'good', 'good-mint');
    conflict.tick();
    assert.equal(conflict.registry.getProcessedActualEvent.get(buy.id), undefined);
    assert.equal(conflict.registry.getProcessedActualEvent.get(sell.id).accounting_status,
      'IGNORED_ORPHAN_SELL', 'repair must not silently rewrite a processed later event');
    assert.equal(count(conflict, 'smart_wallet_actual_positions'), 1);
    const blocked = conflict.registry.maintenanceHealth().actualLedger;
    assert.equal(blocked.status, 'REPLAY_REQUIRED');
    assert.equal(blocked.replayRequired[0].first_event_id, buy.id);
    assert.equal(blocked.replayRequired[0].pending_events, 1);
    pair(conflict, 'hole', 'hole-mint', BASE + 2000);
    conflict.setNow(BASE + 3000);
    conflict.tick();
    assert.equal(conflict.registry.maintenanceHealth().actualLedger.replayRequired[0].pending_events, 3);
    assert.equal(count(conflict, 'smart_wallet_actual_positions'), 1);
  } finally { conflict.close(); }
}

function testRestartLockBudgetAndQuarantine() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ledger-outbox-'));
  const dbPath = path.join(directory, 'ledger.db');
  let f;
  let lock;
  try {
    f = fixture(dbPath);
    const ids = pair(f, 'restart', 'restart-mint');
    f.close();
    f = fixture(dbPath, BASE + 1000);
    lock = new Database(dbPath);
    lock.exec('BEGIN IMMEDIATE');
    const began = Date.now();
    f.tick();
    assert.ok(Date.now() - began < 1000, 'new maintenance must not wait the global 5s busy timeout');
    assert.equal(f.store.db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(count(f, 'smart_wallet_pnl_pending_events'), 2);
    assert.equal(count(f, 'smart_wallet_pnl_processed_events'), 0);
    assert.match(f.registry.metrics.actualBackfillLastError, /locked/);
    const quarantine = { signature: 'bad-signature', eventIndex: 1, programId: 'bad-program',
      reason: 'INVALID_CHAIN_TIME', receivedAtMs: BASE, dataLength: 24,
      dataHash: 'fixture-hash', details: { invalidTimestamp: true } };
    assert.throws(() => f.store.recordParserQuarantineBatch([quarantine]), /locked/);
    assert.equal(f.store.db.pragma('busy_timeout', { simple: true }), 5000);
    lock.exec('ROLLBACK');
    f.setNow(BASE + 3000);
    f.tick();
    assert.equal(count(f, 'smart_wallet_actual_positions'), 1);
    assert.equal(f.registry.getProcessedActualEvent.get(ids[1].id).accounting_status, 'CLOSED');
    assert.equal(f.store.recordParserQuarantineBatch([quarantine, quarantine]), 1);
    assert.equal(f.store.recordParserQuarantineBatch([{ ...quarantine, signature: null }]), 1);
    assert.equal(f.store.recordParserQuarantineBatch([{ ...quarantine, signature: null }]), 0,
      'missing signatures must remain idempotent rather than SQL NULL duplicates');
    assert.throws(() => f.store.recordParserQuarantineBatch([
      { ...quarantine, dataHash: 'must-rollback' }, { ...quarantine, receivedAtMs: NaN },
    ]), /Invalid/);
    assert.equal(count(f, 'parser_event_quarantine'), 2);
    assert.throws(() => f.store.recordParserQuarantineBatch(Array(101).fill(quarantine)), /100/);
    assert.equal(f.store.db.pragma('busy_timeout', { simple: true }), 5000);
  } finally {
    if (lock?.inTransaction) lock.exec('ROLLBACK');
    lock?.close();
    f?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testUnrepairedPriorBalanceCannotCorruptNewCycle() {
  const f = fixture();
  try {
    const oldBuy = event(f, 'old-active', 'cycle-mint', 'BUY', BASE);
    f.registry.processActualWalletEvent(oldBuy);
    // Simulate an old missed CLOSE not yet reached by the one-time repair sweep.
    const oldClose = event(f, 'old-active', 'cycle-mint', 'SELL', BASE + 1);
    f.store.db.prepare('DELETE FROM smart_wallet_pnl_pending_events WHERE smart_event_id=?').run(oldClose.id);
    event(f, 'old-active', 'cycle-mint', 'BUY', BASE + 2);
    f.registry._consumeActualEventQueue(50, BASE + 3);
    const position = f.store.db.prepare('SELECT * FROM smart_wallet_actual_positions').get();
    assert.equal(position.total_buy_sol, 1, 'a new OPEN must not be merged into an unrepaired old cycle');
    assert.equal(f.store.db.prepare('SELECT reason FROM smart_wallet_pnl_replay_required').get().reason,
      'OPEN_WITH_EXISTING_POSITION');
  } finally { f.close(); }
}

function testRepairCursorRollbackAndMalformedIsolation() {
  const f = fixture();
  try {
    pair(f, 'legacy', 'legacy-fail');
    f.store.db.exec(`DELETE FROM smart_wallet_pnl_pending_events;
      CREATE TRIGGER fail_legacy_queue BEFORE INSERT ON smart_wallet_pnl_pending_events
      BEGIN SELECT RAISE(ABORT,'legacy enqueue failed'); END;`);
    assert.throws(() => f.registry._backfillActualWalletEvents(1), /legacy enqueue failed/);
    assert.equal(count(f, 'smart_wallet_pnl_pending_events'), 0);
    assert.equal(count(f, 'smart_wallet_pnl_repair_state'), 0,
      'high-water creation and source cursor must roll back with failed enqueue');
    assert.equal(f.store.db.pragma('busy_timeout', { simple: true }), 5000);
    f.store.db.exec('DROP TRIGGER fail_legacy_queue');
    f.tick();
    assert.equal(count(f, 'smart_wallet_actual_positions'), 1);
    const bad = event(f, 'bad-json', 'bad-mint', 'BUY', BASE + 1000);
    f.store.db.prepare('UPDATE smart_wallet_pnl_pending_events SET event_json=? WHERE smart_event_id=?')
      .run('{malformed', bad.id);
    pair(f, 'good-after-bad', 'good-after-bad', BASE + 1000);
    f.setNow(BASE + 2000);
    f.tick();
    assert.equal(count(f, 'smart_wallet_actual_positions'), 2,
      'a permanently malformed payload must not block unrelated wallet/mint work');
    assert.equal(f.store.db.prepare(`SELECT status,last_error FROM smart_wallet_pnl_pending_events
      WHERE smart_event_id=?`).get(bad.id).status, 'REPLAY_REQUIRED');
  } finally { f.close(); }
}

function testBusyMintOrderCheckResumesWithoutFalseReplay() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ledger-order-check-'));
  const dbPath = path.join(directory, 'ledger.db');
  let f = fixture(dbPath);
  try {
    const [buy] = pair(f, 'missing-seed', 'very-busy-mint');
    f.store.db.transaction(() => {
      for (let index = 0; index < 1005; index += 1) {
        f.store.recordHistoricalSmartWalletEvent({ wallet: `other-${index}`, mint: 'very-busy-mint',
          side: 'BUY', timestampMs: BASE + 10 + index, solAmount: 1, tokenAmount: 100,
          price: 0.01, signature: `historic-busy-${index}`, eventIndex: 0 });
      }
    })();
    f.registry._backfillActualWalletEvents(2000);
    assert.equal(count(f, 'smart_wallet_pnl_replay_required'), 0);
    assert.equal(f.store.db.prepare(`SELECT status,last_error FROM smart_wallet_pnl_pending_events
      WHERE smart_event_id=?`).get(buy.id).status, 'PENDING');
    assert.equal(count(f, 'smart_wallet_pnl_order_checks'), 1,
      'an incomplete bounded check must checkpoint rather than falsely require manual replay');
    const saved = f.store.db.prepare('SELECT * FROM smart_wallet_pnl_order_checks').get();
    assert.ok(saved.cursor_event_id > buy.id);
    f.store.recordHistoricalSmartWalletEvent({ wallet: 'late-other', mint: 'very-busy-mint',
      side: 'BUY', timestampMs: BASE + 20000, solAmount: 1, tokenAmount: 100,
      price: 0.01, signature: 'historic-busy-after-checkpoint', eventIndex: 0 });
    f.close();
    f = fixture(dbPath, BASE + 5000);
    const restored = f.registry;
    restored._backfillActualWalletEvents(2000);
    assert.equal(f.store.db.prepare('SELECT upper_event_id FROM smart_wallet_pnl_order_checks')
      .get().upper_event_id, saved.upper_event_id, 'fixed upper bound must not chase new arrivals');
    restored.now = () => BASE + 10000;
    restored._backfillActualWalletEvents(2000);
    assert.equal(count(f, 'smart_wallet_pnl_replay_required'), 0);
    assert.equal(count(f, 'smart_wallet_pnl_order_checks'), 0);
    assert.equal(count(f, 'smart_wallet_pnl_pending_events'), 0);
    const position = f.store.db.prepare('SELECT * FROM smart_wallet_actual_positions').get();
    assert.equal(position.wallet, 'missing-seed');
    assert.equal(position.status, 'CLOSED');
    assert.ok(Math.abs(position.realized_pnl_sol - 0.2) < 1e-12);
    const plan = f.store.db.prepare(`EXPLAIN QUERY PLAN SELECT id,wallet,timestamp_ms
      FROM smart_wallet_events WHERE mint=? AND (timestamp_ms,id)>(?,?)
        AND (timestamp_ms,id)<=(?,?) ORDER BY timestamp_ms,id LIMIT 501`
    ).all('very-busy-mint', BASE, 0, BASE + 5000, 100000);
    assert.ok(plan.every((row) => !/SCAN |TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
  } finally {
    f.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

testAtomicOutboxAndAgeIndependence();
testFailureHoleAndIdempotence();
testLegacyBoundedRepairAndConflict();
testRestartLockBudgetAndQuarantine();
testUnrepairedPriorBalanceCannotCorruptNewCycle();
testRepairCursorRollbackAndMalformedIsolation();
testBusyMintOrderCheckResumesWithoutFalseReplay();
console.log('Smart wallet durable ledger outbox, repair, isolation and quarantine tests: PASS');
