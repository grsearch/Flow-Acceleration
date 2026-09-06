'use strict';

const assert = require('node:assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');
const { recoveryDiagnostics } = require('../src/core/AccountRecoveryDiagnostics');
const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, flushMax: 1000 }, { configuredTradingCostPct: 0 });
const T = 1_900_000_000_000;
function insert(id, status = 'PENDING', error = null, strategy = 'queue-test', due = T) {
  store.db.prepare(`INSERT INTO live_positions(id,mint,strategy_id,mode,status,position_sol,created_at,updated_at)
    VALUES(?,?,?,'LIVE','CLOSED',0.02,?,?)`).run(id, `offline-mint-${id}`, strategy, T, T);
  store.db.prepare(`INSERT INTO live_account_recoveries(id,account_address,mint,owner,token_program,creation_signature,
    position_id,funded_lamports,status,signature,prepared_json,next_attempt_at,error,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, `offline-account-${id}`, `offline-mint-${id}`, 'offline-owner',
    'offline-program', `offline-creation-${id}`, id, '1887234', status,
    ['UNKNOWN','PREPARED'].includes(status) ? `offline-signed-${id}` : null,
    ['UNKNOWN','PREPARED'].includes(status) ? JSON.stringify({ expectedRefundLamports: '1887234' }) : null,
    due, error, T - 100_000, T + id);
}
try {
  for (let id = 1; id <= 4; id++) insert(id, id % 2 ? 'UNKNOWN' : 'PREPARED');
  insert(5); insert(6, 'PENDING', 'CLEANUP_FEE_UNAVAILABLE', 'queue-test', T + 60_000);
  assert.deepEqual(store.liveAccountRecoveryCandidates({ now: T, limit: 3 }).map(r => r.id), [1, 2, 5], 'one unsigned slot without increasing batch size');
  assert.deepEqual(store.liveAccountRecoveryCandidates({ now: T, limit: 1 }).map(r => r.id), [1], 'batch size one still prioritizes signed safety');
  store.db.prepare('UPDATE live_account_recoveries SET next_attempt_at=? WHERE id=5').run(T + 60_000);
  assert.deepEqual(store.liveAccountRecoveryCandidates({ now: T, limit: 3 }).map(r => r.id), [1, 2, 3], 'do not waste reservation if no unsigned due');
  const diagnostic = { version: 'ACCOUNT_RECOVERY_DIAGNOSTICS_V1', privateKey: 'DO-NOT-PERSIST',
    account: { status: 'EMPTY', tokenAmountRaw: '0', contextSlot: 90, reason: null, url: 'DO-NOT-PERSIST' },
    quoteAttempts: [{ rpc: 'PRIMARY', blockhashSlot: 100, feeSlot: 101, feeLamports: 105000,
      result: 'READY', signedBytes: 'DO-NOT-PERSIST' }] };
  const saved = store.updateLiveAccountRecovery(6, { status: 'PENDING', checks: 2, consecutiveFailures: 2,
    lastCheckedAt: T, diagnostics: diagnostic, errorStage: 'FEE_QUOTE', nextAttemptAt: T + 120_000 });
  assert.equal(saved.checks, 2); assert.equal(saved.attempts, 0);
  assert.equal(saved.next_attempt_at, T + 120_000);
  assert(!saved.diagnostics_json.includes('DO-NOT-PERSIST'));
  const reread = store.liveAccountRecoveryDashboard('queue-test').cases.find(row => row.id === 6);
  assert.equal(reread.diagnostics.quoteAttempts[0].feeLamports, 105000);
  assert.equal(reread.diagnostics_json, undefined, 'raw diagnostics JSON is never sent to the UI');
  assert.equal(recoveryDiagnostics({ version: 'future' }), null);
  assert.equal(recoveryDiagnostics({ ...diagnostic, quoteAttempts: Array(20).fill(diagnostic.quoteAttempts[0]) }).quoteAttempts.length, 3);
  assert.throws(() => store.updateLiveAccountRecovery(6, { checks: -1 }), /check diagnostic/);
  for (let id = 7; id <= 30; id++) insert(id, 'PENDING', 'CLEANUP_FEE_UNAVAILABLE');
  insert(31, 'PENDING', 'TOKEN_ACCOUNT_BALANCE_NONZERO');
  insert(32, 'PENDING', 'ACTIVE_POSITION_OR_UNRESOLVED_ORDER');
  insert(33, 'PENDING', 'TOKEN_ACCOUNT_NOT_SAFELY_EMPTY');
  insert(34, 'BLOCKED', 'TOKEN_ACCOUNT_DELEGATED');
  insert(35, 'PENDING', 'CLEANUP_FEE_UNAVAILABLE', 'other');
  let dashboard = store.liveAccountRecoveryDashboard('queue-test');
  assert.equal(dashboard.cases.length, 20);
  assert.equal(dashboard.summary.queueCounts.WAITING_FEE_QUOTE, 25, 'whole-strategy counts are not the recent-20 subset');
  assert.equal(dashboard.summary.queueCounts.SIGNED_UNCONFIRMED, 4);
  assert.equal(dashboard.summary.queueCounts.WAITING_ACCOUNT_EMPTY, 1);
  assert.equal(dashboard.summary.queueCounts.WAITING_TRADING, 1);
  assert.equal(dashboard.summary.queueCounts.WAITING_SAFETY, 1);
  assert.equal(dashboard.summary.queueCounts.BLOCKED, 1);
  assert.equal(dashboard.summary.queueCounts.QUEUED, 1);
  assert.equal(store.liveAccountRecoveryDashboard('other').summary.queueCounts.WAITING_FEE_QUOTE, 1);
  const row = store.liveAccountRecoveryPositionStates([6]).get(6);
  assert.equal(row.account_recovery_checks, 2);
  assert.equal(row.account_recovery_last_checked_at, T);
  assert.equal(row.account_recovery_next_attempt_at, T + 120_000);
  // Old readonly snapshots must not claim zero checks or fail after deployment.
  for (const column of ['checks', 'consecutive_failures', 'last_checked_at', 'diagnostics_json']) {
    store.db.exec(`ALTER TABLE live_account_recoveries DROP COLUMN ${column}`);
  }
  dashboard = store.liveAccountRecoveryDashboard('queue-test');
  assert.equal(dashboard.cases[0].checks, null);
  assert.equal(dashboard.cases[0].diagnostics, null);
  assert.equal(store.liveAccountRecoveryPositionStates([6]).get(6).account_recovery_checks, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM live_orders').get().n, 0, 'tests never create trading orders');
  console.log('Account recovery queue: bounded fair lanes, persisted check diagnostics, sanitized evidence, complete counts and old snapshots passed');
} finally { store.close(); }
