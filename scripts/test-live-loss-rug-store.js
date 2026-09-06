'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');
const { exportResearchWindow } = require('./export-research-window');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-loss-rug-store-'));
const source = path.join(directory, 'source.db');
const store = new ResearchStore({ dbPath: source, archiveDir: directory,
  flushMs: 60_000, flushMax: 1_000 }, { configuredTradingCostPct: 0 });
const T = 1_900_000_000_000;
const position = (id, status = 'CLOSED', ret = -60, strategy = 'test', mode = 'LIVE') => {
  store.db.prepare(`INSERT INTO live_positions(id,mint,strategy_id,mode,status,position_sol,
    realized_return_pct,realized_pnl_sol,opened_at,closed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,0.02,?,-0.012,?,?,?,?)`).run(id, `mint-${id}`, strategy, mode, status, ret,
    T - 100_000, status === 'CLOSED' ? T - 50_000 : null, T - 110_000, T - 40_000);
};
const update = (id, patch = {}) => store.upsertLiveLossRugCase({ positionId: id, mint: `mint-${id}`,
  strategyId: 'test', mode: 'LIVE', entryAt: T - 100_000, updatedAt: T + id, ...patch });
try {
  position(1);
  const frozen = { capturedAt: T - 100_000, tracker: { samples: ['before'], bytes: 'x'.repeat(50_000) } };
  const first = update(1, { entryEvidence: frozen });
  assert.equal(first.status, 'CAPTURED');
  assert.deepEqual(first.entryEvidence, frozen);
  update(1, { status: 'TRIGGERED', triggerAt: T - 70_000,
    triggerEvidence: { capturedAt: T - 70_000, markReturnPct: -53, tracker: { samples: ['first'] } } });
  store.upsertLiveLossRugCase({ positionId: 1, entryEvidence: { samples: ['future'] },
    triggerAt: T, triggerEvidence: { samples: ['later'] }, updatedAt: T + 10 });
  let saved = store.getLiveLossRugCase(1);
  assert.deepEqual(saved.entryEvidence, frozen);
  assert.equal(saved.triggerAt, T - 70_000);
  assert.equal(saved.triggerEvidence.markReturnPct, -53);
  assert.equal(saved.status, 'TRIGGERED', 'omitted status cannot reset the case');
  assert.equal(saved.createdAt, T + 1);
  update(1, { status: 'ANALYZED', settledAt: T - 50_000, realizedReturnPct: -60,
    classification: 'CONFIRMED_RUG', learning: { status: 'PENDING' }, attribution: { analysis: { reason: 'proof' } } });
  assert.deepEqual(store.pendingLiveLossRugPositions().map(row => row.id), [1]);
  update(1, { status: 'FINAL', learning: { status: 'LEARNED', templatesAdded: 1, walletsAdded: 2 } });
  assert.equal(store.pendingLiveLossRugPositions().length, 0);
  update(1, { learning: { status: 'ERROR' } });
  assert.equal(store.pendingLiveLossRugPositions().length, 1, 'unfinished learning resumes even on damaged FINAL');
  update(1, { learning: null });
  assert.equal(store.pendingLiveLossRugPositions().length, 1, 'FINAL with missing learning still resumes');
  update(1, { learning: { status: 'UNRECOGNIZED' } });
  assert.equal(store.pendingLiveLossRugPositions().length, 1, 'unknown learning cannot finalize recovery');
  update(1, { learning: { status: 'LEARNED', templatesAdded: 1, walletsAdded: 2 } });
  position(2, 'CLOSED', -30); update(2, { status: 'TRIGGERED', triggerAt: T - 80_000 });
  position(3, 'CLOSED', -10); // No case: do not backfill historical winners/non-large losses.
  position(4, 'ENTRY_FAILED', null); update(4);
  position(5, 'ENTRY_UNKNOWN', null); update(5);
  position(6, 'CLOSED', -70); update(6, { status: 'INVALID_SETTLEMENT', settledAt: T,
    realizedReturnPct: -70, classification: 'CONFIRMED_RUG' });
  assert.deepEqual(store.pendingLiveLossRugPositions().map(row => row.id), [2, 4, 6]);
  update(2, { status: 'FINAL', settledAt: T, realizedReturnPct: -30,
    classification: 'RECOVERED', learning: { status: 'NOT_ELIGIBLE' } });
  update(4, { status: 'FINAL', classification: 'NOT_APPLICABLE', learning: { status: 'NOT_ELIGIBLE' } });
  position(7, 'CLOSED', -80, 'other'); update(7, { strategyId: 'other', status: 'FINAL', settledAt: T,
    realizedReturnPct: -80, classification: 'CONFIRMED_RUG', learning: { status: 'LEARNED', templatesAdded: 99 } });
  position(8, 'OPEN', null); update(8, { status: 'TRIGGERED', triggerAt: T });
  position(9); update(9, { status: 'ANALYZED', settledAt: T, realizedReturnPct: -60,
    classification: 'EXECUTION_LOSS', learning: { status: 'PENDING' } });
  position(10); update(10, { status: 'FINAL', settledAt: T, realizedReturnPct: -60,
    classification: 'INSUFFICIENT', learning: { status: 'NOT_ELIGIBLE' } });
  position(11, 'CLOSED', -60, 'test', 'DRY_RUN'); update(11, { mode: 'DRY_RUN', status: 'FINAL',
    settledAt: T, realizedReturnPct: -60, classification: 'CONFIRMED_RUG' });
  const feedback = store.liveTradingDashboard({ strategyId: 'test' }).lossRugFeedback;
  assert.equal(feedback.summary.largeLossCases, 3);
  assert.equal(feedback.summary.confirmedRug, 1, 'invalid/provisional/dry/other strategy not confirmed RUG');
  assert.equal(feedback.summary.executionLoss, 1);
  assert.equal(feedback.summary.unknown, 1);
  assert.equal(feedback.summary.provisional, 1);
  assert.equal(feedback.summary.withdrawn, 1);
  assert.equal(feedback.summary.templatesAdded, 1);
  assert.equal(feedback.summary.walletsAdded, 2);
  assert(!JSON.stringify(feedback).includes('x'.repeat(1_000)), 'Dashboard is a compact summary, full evidence remains in case store');
  assert.equal(feedback.cases.find(row => row.positionId === 1).entryEvidence.capturedAt, T - 100_000);
  position(12); update(12, { status: 'AWAITING_CONFIRMATION', settledAt: T, realizedReturnPct: -60,
    classification: 'CONFIRMED_RUG', learning: { status: 'PENDING' } });
  const awaiting = store.liveLossRugFeedbackDashboard('test').summary;
  assert.equal(awaiting.largeLossCases, 4, 'known settled loss counts during brief confirmation wait');
  assert.equal(awaiting.confirmedRug, 1, 'awaiting confirmation is not yet a final RUG classification');
  for (let id = 20; id < 85; id += 1) position(id);
  assert.equal(store.pendingLiveLossRugPositions(999).scannedCandidates, 50);
  assert(store.pendingLiveLossRugPositions(999).length <= 50);
  const firstPage = store.pendingLiveLossRugPositions(5);
  const secondPage = store.pendingLiveLossRugPositions(5, firstPage.lastScannedId);
  assert(secondPage.every(row => row.id > firstPage.lastScannedId));
  for (let id = 100; id < 151; id += 1) {
    position(id); update(id, { status: 'FINAL', learning: { status: 'NOT_ELIGIBLE' } });
  }
  position(151);
  const finalPrefix = store.pendingLiveLossRugPositions(10, 99);
  assert.equal(finalPrefix.length, 0);
  assert.equal(finalPrefix.scannedCandidates, 10);
  assert.equal(finalPrefix.lastScannedId, 109);
  assert.equal(finalPrefix.hasMore, true, 'empty unfinished page cannot imply end of history');
  let page = finalPrefix; let pages = 1;
  while (page.hasMore && !page.some(row => row.id === 151)) {
    page = store.pendingLiveLossRugPositions(10, page.lastScannedId); pages += 1;
    assert(page.scannedCandidates <= 10);
    assert(pages < 10);
  }
  assert(page.some(row => row.id === 151), 'cursor finds pending loss behind many completed pages');
  const index = store.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM live_positions
    INDEXED BY idx_live_positions_loss_rug_pending WHERE mode='LIVE' AND status='CLOSED'
    AND realized_return_pct<=-50 AND id>? ORDER BY id LIMIT 50`).all(0);
  assert(index.some(row => row.detail.includes('idx_live_positions_loss_rug_pending')));
  store.db.prepare(`INSERT INTO live_orders(position_id,mint,side,status,attempt,signature,wallet_sol_delta,
    execution_json,created_at,confirmed_at,updated_at) VALUES(1,'mint-1','BUY','CONFIRMED',1,'signature',-0.02,?, ?, ?, ?)`)
    .run(JSON.stringify({ original: true }), T - 100_000, T - 99_000, T - 99_000);
  assert.equal(store.getLiveLossRugPosition(1).orders[0].execution_json, '{"original":true}');
  assert.equal(store.getLiveLossRugPosition(1).orders[0].wallet_sol_delta, -0.02);
  assert.equal(store.getLiveLossRugPosition(999), null);
  store.db.pragma('busy_timeout = 5000');
  assert.equal(store.withLiveLossRugWrite(() => store.db.pragma('busy_timeout', { simple: true })), 25);
  assert.equal(store.db.pragma('busy_timeout', { simple: true }), 5000);
  assert.throws(() => store.withLiveLossRugWrite(() => { throw new Error('expected'); }), /expected/);
  assert.equal(store.db.pragma('busy_timeout', { simple: true }), 5000);
  assert.throws(() => store.withLiveLossRugWrite(async () => {}), /synchronous/);
  const blocker = new Database(source);
  blocker.exec('BEGIN IMMEDIATE');
  const began = Date.now();
  assert.throws(() => update(1, { updatedAt: T + 12 }), error => error.code === 'SQLITE_BUSY');
  assert(Date.now() - began < 1000, 'busy write must fail promptly rather than blocking for the global timeout');
  assert.equal(store.db.pragma('busy_timeout', { simple: true }), 5000);
  blocker.exec('ROLLBACK'); blocker.close();
  const destination = path.join(directory, 'export.db');
  const manifest = exportResearchWindow({ sourcePath: source, destinationPath: destination,
    startMs: T, endMs: T + 100 });
  assert.equal(manifest.integrity, 'ok');
  assert.equal(manifest.liveLossRugFeedback.included, true);
  assert.match(manifest.liveLossRugFeedback.temporalScope, /not a historical as-of/);
  const exported = new Database(destination, { readonly: true });
  assert.equal(exported.prepare('SELECT COUNT(*) n FROM live_positions WHERE id=1').get().n, 1,
    'older closed position must follow window-updated case');
  assert.equal(exported.prepare('SELECT COUNT(*) n FROM live_orders WHERE position_id=1').get().n, 1,
    'older linked order evidence must follow case');
  assert.equal(exported.prepare('SELECT entry_evidence_json FROM live_loss_rug_cases WHERE position_id=1').get().entry_evidence_json,
    JSON.stringify(frozen));
  exported.close();
  store.db.exec('DROP TABLE live_loss_rug_cases');
  assert.deepEqual(store.liveTradingDashboard({ strategyId: 'test' }).lossRugFeedback,
    { available: false, summary: null, cases: [] });
  const oldManifest = exportResearchWindow({ sourcePath: source, destinationPath: path.join(directory, 'old-export.db'),
    startMs: T, endMs: T + 100 });
  assert.equal(oldManifest.liveLossRugFeedback.included, false);
  console.log('Live loss RUG Store/export tests passed: immutable evidence, bounded recovery, scoped summaries, portable old/new schema.');
} finally {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
