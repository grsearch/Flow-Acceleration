'use strict';

// Independent integration checks: temporary DB only, no RPC, signing or runtime startup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const { PumpEventParser } = require('../src/core/PumpEventParser');
const { ParserRejectionAudit } = require('../src/runtime/ParserRejectionAudit');
const { RuntimeTaskMetrics } = require('../src/runtime/RuntimeTaskMetrics');
const { collectRuntime } = require('../src/server/DashboardProcessServer');
const fixture = require('./fixtures/amm-post-trade-receipts.json').fixtures[0];
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const bytes = Buffer.from(fixture.programDataBase64, 'base64');
const receivedAt = Number(bytes.readBigInt64LE(8)) * 1000 + 800;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-diagnostics-review-'));
let store; let writer;
try {
  store = new ResearchStore({ dbPath: path.join(root, 'research.db'), archiveDir: root,
    flushMs: 60_000, flushMax: 100, busyTimeoutMs: 30_000 }, { configuredTradingCostPct: 1.4 });
  const audit = new ParserRejectionAudit({ store, retryMs: 0 });
  let dbCalls = 0;
  const persist = store.recordParserQuarantineBatch.bind(store);
  store.recordParserQuarantineBatch = (rows) => { dbCalls += 1; return persist(rows); };
  const parser = new PumpEventParser({ pumpAmmProgramId: AMM,
    wsolMint: 'So11111111111111111111111111111111111111112',
    onRejectedEvent: (row) => audit.enqueue(row) });
  const tx = (program) => ({ slot: fixture.slot, signature: fixture.signature,
    meta: { err: null, preTokenBalances: [{ mint: fixture.mint }],
      logMessages: [`Program ${program} invoke [1]`, `Program data: ${bytes.toString('base64')}`,
        `Program ${program} success`] } });
  const accepted = parser.parseTransaction(tx(AMM), receivedAt);
  assert.equal(accepted.length, 1);
  assert.equal(audit.health().pending, 0);
  assert.equal(dbCalls, 0);
  assert.deepEqual(parser.parseTransaction(tx('ComputeBudget111111111111111111111111111111'), receivedAt), []);
  assert.equal(audit.health().pending, 1);
  assert.equal(dbCalls, 0, 'parser rejection callback must only enqueue, never acquire SQLite locks');
  assert.deepEqual(parser.parseTransaction(tx(AMM), receivedAt), accepted,
    'rejecting an unrelated event must not change the next valid event');

  writer = new Database(path.join(root, 'research.db'));
  writer.exec('BEGIN IMMEDIATE');
  const started = process.hrtime.bigint();
  assert.equal(audit.flush(), 0, 'contended audit remains queued');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1000, `diagnostic SQL contention must not inherit 30s timeout: ${elapsedMs}ms`);
  assert.equal(store.db.pragma('busy_timeout', { simple: true }), 30_000, 'connection timeout restored');
  assert.equal(audit.health().pending, 1);
  assert.equal(audit.health().writeErrors, 1);
  writer.exec('ROLLBACK');
  assert.equal(audit.flush(), 1);
  assert.equal(audit.health().pending, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM parser_event_quarantine').get().n, 1);
  const quarantine = store.db.prepare('SELECT * FROM parser_event_quarantine').get();
  assert.equal(quarantine.reason, 'PROGRAM_MISMATCH');
  assert.equal(quarantine.received_at_ms, receivedAt);

  // New PnL outbox insert shares the existing event transaction: either both
  // commit or neither does. No synchronous processing is required by the insert.
  const trade = { ...accepted[0], signature: 'new-ledger-event', timestampMs: receivedAt,
    receivedAtMs: receivedAt, mint: fixture.mint };
  store.ensureToken(trade.mint);
  const smartEvent = store.recordSmartWalletEvent(trade);
  assert.equal(smartEvent.inserted, true);
  const work = store.db.prepare('SELECT * FROM smart_wallet_pnl_pending_events WHERE smart_event_id=?')
    .get(smartEvent.id);
  assert.equal(work.status, 'PENDING');
  assert.equal(JSON.parse(work.event_json).id, smartEvent.id);
  assert.equal(store.recordSmartWalletEvent(trade).inserted, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM smart_wallet_pnl_pending_events').get().n, 1);
  store.db.exec(`CREATE TEMP TRIGGER reject_test_outbox BEFORE INSERT ON smart_wallet_pnl_pending_events
    BEGIN SELECT RAISE(ABORT, 'review simulated outbox failure'); END`);
  assert.throws(() => store.recordSmartWalletEvent({ ...trade, signature: 'must-rollback' }), /outbox failure/);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM smart_wallet_events WHERE signature='must-rollback'").get().n, 0);
  store.db.exec('DROP TRIGGER reject_test_outbox');

  const metrics = new RuntimeTaskMetrics();
  assert.equal(metrics.run('valid-event', () => accepted.length), 1);
  const promise = Promise.resolve(5);
  assert.equal(metrics.run('async-owner', () => promise), promise, 'timing wrapper preserves returned promise identity');
  let dbReads = 0;
  const snapshot = collectRuntime({ config: {}, runtimeDiagnostics: { health: () => ({
    parser: parser.getStats(), parserQuarantine: audit.health(), taskTimings: metrics.health(),
  }) }, store: { healthSnapshot() { dbReads += 1; return { pendingWrites: 0 }; } } });
  assert.equal(dbReads, 1, 'only the existing healthSnapshot boundary is consulted');
  const serialized = JSON.parse(JSON.stringify(snapshot));
  assert.equal(serialized.sections.runtimeDiagnostics.parser.acceptedEvents, 2);
  assert.equal(serialized.sections.runtimeDiagnostics.parser.rejectedEvents, 1);
  assert.equal(serialized.sections.runtimeDiagnostics.parserQuarantine.persisted, 1);
  assert.equal(serialized.sections.runtimeDiagnostics.taskTimings.tasks['valid-event'].calls, 1);
  assert.deepEqual(serialized.errors, []);
  const impossible = Buffer.from(bytes);
  impossible.writeBigUInt64LE(impossible.readBigUInt64LE(16) - 1n, 48); // BUY larger than pre-pool base.
  const invalidStateTx = tx(AMM);
  invalidStateTx.meta.logMessages[1] = `Program data: ${impossible.toString('base64')}`;
  assert.deepEqual(parser.parseTransaction(invalidStateTx, receivedAt), []);
  assert.equal(audit.flush(), 1);
  const invalidState = store.db.prepare("SELECT details_json FROM parser_event_quarantine WHERE reason='INVALID_AMM_RESERVES'").get();
  const evidence = JSON.parse(invalidState.details_json);
  assert.equal(evidence.ammQuoteStateReason, 'NON_POSITIVE_POST_BASE');
  assert.equal(evidence.ammExecutionFees.poolQuoteAmountRaw, fixture.knownFields.quote_amount_in_with_lp_fee);
  assert.equal(evidence.ammExecutionFees.userQuoteAmountRaw, fixture.knownFields.user_quote_amount_in);
  assert.equal(evidence.virtualQuoteReservesRaw, fixture.virtualQuoteReservesRaw);
  assert.deepEqual(parser.parseTransaction(tx(AMM), -1), []);
  assert.equal(audit.flush(), 1, 'negative receipt metadata must not poison a quarantine batch');
  assert.ok(store.db.prepare("SELECT received_at_ms FROM parser_event_quarantine WHERE reason='INVALID_RECEIVED_TIMESTAMP'")
    .get().received_at_ms > 0);
  console.log(`Independent runtime diagnostics checks passed (real SQLite lock ${elapsedMs.toFixed(1)}ms, atomic outbox, parser isolation, IPC JSON)`);
} finally {
  if (writer?.inTransaction) writer.exec('ROLLBACK');
  writer?.close();
  store?.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('flow-diagnostics-review-'));
  fs.rmSync(root, { recursive: true, force: true });
}
