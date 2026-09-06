'use strict';

const assert = require('node:assert/strict');
const { LiveLossRugFeedback } = require('../src/core/LiveLossRugFeedback');
const T = 1_920_000_000_000;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const totals = (pnl = -0.011) => ({ complete: true, realizedReturnPct: pnl / 0.02 * 100,
  realizedPnlSol: pnl, entrySolDelta: -0.02, exitSolDelta: 0.02 + pnl, pendingSettlements: 0 });

function fixture(options = {}) {
  let now = T; const cases = new Map(); const positions = new Map(); const reads = []; const writes = [];
  const captures = []; const analyses = []; const learns = []; const released = []; const learned = new Set();
  let failWrite = () => false; let failLearn = false; let classification = 'CONFIRMED_RUG';
  let confirmationReady = true; let duplicateResult = false;
  const store = {
    getLiveLossRugCase(id) { reads.push(['case', id]); return clone(cases.get(id)); },
    upsertLiveLossRugCase(patch) {
      writes.push(clone(patch));
      if (failWrite(patch)) throw Object.assign(new Error('SQLITE_BUSY'), { code: 'SQLITE_BUSY' });
      const existing = cases.get(patch.positionId) || {};
      const next = { ...existing, ...clone(patch) };
      if (existing.entryEvidence) next.entryEvidence = existing.entryEvidence;
      if (existing.triggerEvidence) { next.triggerEvidence = existing.triggerEvidence; next.triggerAt = existing.triggerAt; }
      cases.set(patch.positionId, next); return clone(next);
    },
    getLiveLossRugPosition(id) { reads.push(['position', id]); return clone(positions.get(id)); },
    pendingLiveLossRugPositions(limit, afterId) {
      reads.push(['recovery', limit, afterId]);
      return [...positions.values()].filter(row => row.mode === 'LIVE' && row.id > afterId
        && (row.status === 'CLOSED' || row.status === 'ENTRY_FAILED')
        && (row.realized_return_pct <= -50 || cases.has(row.id))
        && (cases.get(row.id)?.status !== 'FINAL'
          || !['LEARNED', 'ALREADY_LEARNED', 'NOT_ELIGIBLE'].includes(cases.get(row.id)?.learning?.status)))
        .sort((a, b) => a.id - b.id).slice(0, limit).map(clone);
    },
  };
  const tracker = {
    captureLossEvidence(mint, capturedAt, { phase }) {
      const result = { version: 'LIVE_LOSS_EVIDENCE_V1', mint, phase, capturedAt,
        events: [{ marker: `${mint}:${phase}:${capturedAt}` }], completeness: { ready: true } };
      captures.push(result); return result;
    },
    analyzeLossEvidence(input) {
      analyses.push(clone(input));
      assert(input.entryEvidence?.tracker, 'must have frozen entry, not settlement-time reconstruction');
      assert(input.settlement.complete);
      assert(input.settlement.realizedReturnPct <= -50);
      if (!confirmationReady) return { classification: 'CANDIDATE',
        reason: 'INDEPENDENT_POST_COLLAPSE_CONFIRMATION_MISSING', evidence: { confirmation: null }, learningCandidate: null };
      return { classification, reason: 'fixture', evidence: { entryAt: input.entryEvidence.capturedAt },
        learningCandidate: classification === 'CONFIRMED_RUG' ? { template: 'AMM_EARLY:FIXTURE' } : null };
    },
    learnFromLossCase(input) {
      learns.push(clone(input));
      const id = Number(input.caseId.split(':').at(-1));
      assert(['ANALYZED', 'FINAL'].includes(cases.get(id)?.status), 'persist analysis BEFORE learning');
      assert.equal(cases.get(id).attribution.knownAt, input.knownAt);
      if (failLearn) throw new Error('SQLITE_BUSY');
      if (learned.has(input.caseId) || duplicateResult) return { status: 'ALREADY_LEARNED', templatesAdded: 0, walletsAdded: 0 };
      learned.add(input.caseId); return { status: 'LEARNED', templatesAdded: 1, walletsAdded: 0 };
    },
    releaseLossEvidence(mint) { released.push(mint); },
  };
  const config = { enabled: true, maxPending: 256, batchSize: 10,
    flushIntervalMs: 1_000, recoveryIntervalMs: 30_000, ...options };
  let feedback = new LiveLossRugFeedback({ config, store, tracker, now: () => now });
  function position(id = 1, patch = {}) {
    const row = { id, mint: `mint-${id}`, strategy_id: 'test-live', mode: 'LIVE', status: 'CLOSED',
      opened_at: T + 1, entry_price: 1, realized_return_pct: -55,
      orders: [{ side: 'BUY', status: 'CONFIRMED', signature: `buy-${id}`, wallet_sol_delta: -0.02, confirmed_at: T + 1 },
        { side: 'SELL', status: 'CONFIRMED', signature: `sell-${id}`, wallet_sol_delta: 0.009, confirmed_at: T + 9_000 }], ...patch };
    positions.set(id, row); return row;
  }
  const api = { cases, positions, reads, writes, captures, analyses, learns, learned, released, store, tracker, position,
    get feedback() { return feedback; }, get now() { return now; }, setNow(offset) { now = T + offset; },
    failWrites(fn) { failWrite = fn; }, failLearning(value) { failLearn = value; },
    classify(value) { classification = value; }, confirmation(value) { confirmationReady = value; },
    duplicateLearn(value) { duplicateResult = value; },
    entry(row = position()) { return feedback.captureEntry(row, { mint: row.mint, price: 1,
      timestampMs: now, receivedAtMs: now, signature: 'source', apiKey: 'never-copy-this', secret: 'no' }); },
    trigger(row) { return feedback.observePosition(row, { mint: row.mint, price: 0.4, reservePrice: 0.4,
      timestampMs: now, receivedAtMs: now, signature: 'collapse' }); },
    async restart() { feedback = new LiveLossRugFeedback({ config, store, tracker, now: () => now });
      feedback.start(); await feedback.flush(); return feedback; },
  };
  return api;
}

async function baseline() {
  const f = fixture(); const row = f.position();
  assert(f.entry(row)); assert.equal(f.entry(row), false);
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0, 'entry path performs no SQLite work');
  f.setNow(10_000); assert(f.trigger(row)); assert.equal(f.trigger(row), false);
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0, 'first drop only freezes evidence');
  const captured = clone(f.captures[0]); f.captures[0].events[0].marker = 'mutated';
  assert(f.feedback.onSettlement(1, totals()));
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0, 'settlement callback only enqueues');
  await f.feedback.flush();
  const record = f.cases.get(1);
  assert.equal(record.status, 'FINAL'); assert.equal(record.classification, 'CONFIRMED_RUG');
  assert.deepEqual(record.entryEvidence.tracker, captured);
  assert.equal(record.learning.status, 'LEARNED'); assert.equal(f.learned.size, 1);
  assert.equal(record.triggerEvidence.capturedAt, T + 10_000);
  assert.equal(record.attribution.resolutionTracker.phase, 'SETTLEMENT');
  assert.equal(JSON.stringify(record).includes('never-copy-this'), false);
  f.feedback.onSettlement(1, totals()); await f.feedback.flush();
  assert.equal(f.learns.length, 1, 'completed callback idempotence');
  await f.feedback.stop();
}

async function accountingAndIsolation() {
  for (const mode of ['DRY_RUN', 'SHADOW', 'PAPER']) {
    const f = fixture(); const row = f.position(1, { mode });
    assert.equal(f.entry(row), false); f.setNow(10_000); assert.equal(f.trigger(row), false);
    f.feedback.onSettlement(1, totals()); await f.feedback.flush();
    assert.equal(f.cases.size, 0); assert.equal(f.learns.length, 0); await f.feedback.stop();
  }
  for (const fault of ['unsettled', 'unknown', 'no-signature', 'not-closed', 'mismatch', 'future']) {
    const f = fixture(); const row = f.position(); f.entry(row); f.setNow(10_000);
    if (fault === 'unsettled') row.orders[1].wallet_sol_delta = null;
    if (fault === 'unknown') row.orders[1].status = 'CONFIRMATION_UNKNOWN';
    if (fault === 'no-signature') row.orders[1].signature = null;
    if (fault === 'not-closed') row.status = 'OPEN';
    if (fault === 'future') row.orders[1].confirmed_at = T + 11_000;
    f.feedback.onSettlement(1, fault === 'mismatch' ? totals(-0.015) : totals());
    await f.feedback.flush(); assert.equal(f.cases.get(1).status, 'INVALID_SETTLEMENT', fault);
    assert.equal(f.learns.length, 0, fault); await f.feedback.stop();
  }
  const partial = fixture(); const row = partial.position(); partial.entry(row); partial.setNow(10_000);
  row.orders[1].status = 'CONFIRMED_PARTIAL'; row.orders[1].wallet_sol_delta = 0.004;
  row.orders.push({ side: 'SELL', status: 'CONFIRMED', signature: 'sell-rest', wallet_sol_delta: 0.005, confirmed_at: T + 9_001 });
  partial.feedback.onSettlement(1, totals()); await partial.feedback.flush();
  assert.equal(partial.cases.get(1).status, 'FINAL'); assert.equal(partial.learns.length, 1);
  await partial.feedback.stop();
  for (const hadTrigger of [false, true]) {
    const f = fixture(); const p = f.position(); f.entry(p); f.setNow(10_000);
    if (hadTrigger) f.trigger(p);
    p.orders[1].wallet_sol_delta = 0.015; p.realized_return_pct = -25;
    f.feedback.onSettlement(1, totals(-0.005)); await f.feedback.flush();
    assert.equal(f.cases.get(1).status, 'FINAL');
    assert.equal(f.cases.get(1).classification, hadTrigger ? 'RECOVERED' : 'NOT_LOSS');
    assert.equal(f.learns.length, 0); assert.equal(f.feedback.health().trackedPositions, 0);
    await f.feedback.stop();
  }
}

async function durabilityAndRecovery() {
  const f = fixture(); const row = f.position(); f.entry(row); f.setNow(10_000);
  f.feedback.onSettlement(1, totals()); f.failWrites(patch => patch.status === 'ANALYZED');
  await f.feedback.flush(); assert.equal(f.learns.length, 0, 'failed case commit prevents learning');
  const attempted = f.writes.length; await f.feedback.flush(); assert.equal(f.writes.length, attempted);
  await assert.rejects(f.feedback.stop(), error => error.code === 'LIVE_LOSS_FEEDBACK_PENDING');
  f.failWrites(() => false); f.setNow(11_000); await f.feedback.flush();
  assert.equal(f.learns.length, 1); await f.feedback.stop();

  const retry = fixture(); const p = retry.position(); retry.entry(p); retry.setNow(10_000);
  retry.feedback.onSettlement(1, totals()); retry.failWrites(patch => patch.status === 'FINAL');
  await retry.feedback.flush(); assert.equal(retry.cases.get(1).status, 'ANALYZED');
  assert.equal(retry.learned.size, 1);
  const firstKnownAt = retry.cases.get(1).attribution.knownAt;
  await assert.rejects(retry.feedback.stop(), error => error.code === 'LIVE_LOSS_FEEDBACK_PENDING');
  retry.failWrites(() => false); retry.setNow(20_000); await retry.restart();
  assert.equal(retry.cases.get(1).status, 'FINAL'); assert.equal(retry.analyses.length, 1);
  assert(retry.learns.every(call => call.knownAt === firstKnownAt)); assert.equal(retry.learned.size, 1);
  assert.equal(retry.captures.filter(c => c.phase === 'SETTLEMENT').length, 1, 'retries reuse frozen analysis');
  await retry.feedback.stop();

  const missing = fixture(); missing.position(); missing.setNow(20_000); await missing.restart();
  assert.equal(missing.cases.get(1).classification, 'INSUFFICIENT'); assert.equal(missing.learns.length, 0);
  assert(missing.captures.every(capture => capture.phase !== 'ENTRY'), 'restart never recreates entry from current data');
  await missing.feedback.stop();

  const recovered = fixture(); const r = recovered.position(); recovered.entry(r); recovered.setNow(10_000); recovered.trigger(r);
  await recovered.feedback.flush(); await recovered.feedback.stop();
  r.realized_return_pct = -25; r.orders[1].wallet_sol_delta = 0.015;
  recovered.setNow(20_000); await recovered.restart();
  assert.equal(recovered.cases.get(1).classification, 'RECOVERED'); await recovered.feedback.stop();
}

async function boundedAndConfirmation() {
  const bounded = fixture({ maxPending: 1 }); const a = bounded.position(1); const b = bounded.position(2);
  assert(bounded.entry(a)); assert.equal(bounded.entry(b), false); assert.equal(bounded.feedback.health().dropped, 1);
  assert.equal(bounded.captures.length, 1); await bounded.feedback.stop();
  const failed = fixture(); const row = failed.position(); failed.entry(row);
  assert(failed.feedback.onEntryFailed({ ...row, status: 'ENTRY_FAILED' }));
  await failed.feedback.flush(); assert.equal(failed.cases.get(1).classification, 'NOT_APPLICABLE');
  assert.equal(failed.feedback.health().trackedPositions, 0); assert.equal(failed.learns.length, 0);
  await failed.feedback.stop();
  const oldFailure = fixture();
  oldFailure.feedback.onEntryFailed(oldFailure.position(1, { status: 'ENTRY_FAILED' }));
  await oldFailure.feedback.flush(); assert.equal(oldFailure.cases.size, 0, 'old uncaptured entry failure is not a new RUG case');
  await oldFailure.feedback.stop();

  for (const eventuallyConfirmed of [false, true]) {
    const f = fixture(); const p = f.position(); f.entry(p); f.setNow(10_000); f.trigger(p);
    f.confirmation(false); f.feedback.onSettlement(1, totals()); await f.feedback.flush();
    assert.equal(f.cases.get(1).status, 'AWAITING_CONFIRMATION'); assert.equal(f.learns.length, 0);
    f.setNow(14_999); await f.feedback.flush(); assert.equal(f.analyses.length, 1);
    f.confirmation(eventuallyConfirmed); f.setNow(15_000); await f.feedback.flush();
    assert.equal(f.cases.get(1).status, 'FINAL'); assert.equal(f.learns.length, eventuallyConfirmed ? 1 : 0);
    assert.equal(f.cases.get(1).triggerEvidence.capturedAt, T + 10_000);
    assert.equal(f.cases.get(1).attribution.knownAt, T + 15_000, 'new confirming data is never backdated');
    await f.feedback.stop();
  }
  const durableWait = fixture(); const p = durableWait.position(); durableWait.entry(p); durableWait.setNow(10_000);
  durableWait.confirmation(false); durableWait.feedback.onSettlement(1, totals()); await durableWait.feedback.flush();
  await durableWait.feedback.stop(); assert.equal(durableWait.cases.get(1).status, 'AWAITING_CONFIRMATION');
  durableWait.setNow(16_000); await durableWait.restart();
  assert.equal(durableWait.cases.get(1).status, 'FINAL'); assert.equal(durableWait.learns.length, 0);
  await durableWait.feedback.stop();
}

async function boundedRecoveryCursor() {
  const f = fixture({ recoveryBatchSize: 2 }); const p = f.position(6); f.setNow(20_000);
  const cursors = [];
  f.store.pendingLiveLossRugPositions = (limit, afterId) => {
    assert.equal(limit, 2); cursors.push(afterId);
    const rows = afterId < 4 ? [] : [clone(p)];
    rows.lastScannedId = afterId < 4 ? afterId + 2 : 6;
    rows.hasMore = afterId < 4;
    rows.scannedCandidates = 2;
    return rows;
  };
  await f.restart();
  assert.equal(f.feedback.health().recoveryAfterId, 2, 'empty FINAL prefix page advances scan cursor');
  f.setNow(21_000); await f.feedback.flush();
  assert.equal(f.feedback.health().recoveryAfterId, 4);
  f.setNow(22_000); await f.feedback.flush();
  assert.deepEqual(cursors, [0, 2, 4]);
  assert.equal(f.cases.get(6).classification, 'INSUFFICIENT');
  assert.equal(f.feedback.health().recoveryAfterId, 0, 'reset only after hasMore=false');
  await f.feedback.stop();
}

(async () => {
  await baseline(); await accountingAndIsolation(); await durabilityAndRecovery(); await boundedAndConfirmation();
  await boundedRecoveryCursor();
  console.log('test-live-loss-rug-feedback: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
