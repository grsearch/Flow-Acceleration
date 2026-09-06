'use strict';

const assert = require('node:assert/strict');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');
const T = 1_940_000_000_000;
const clone = value => JSON.parse(JSON.stringify(value));
const config = { enabled: true, windowMs: 15_000, stateRetentionMs: 60_000,
  maxEventsPerMint: 256, sweepIntervalMs: 1, minTrades: 10, minFlags: 5,
  cacheMaxAgeMs: 1_000, toxicCollapsePct: 60, toxicCollapseWindowMs: 30_000,
  toxicTemplateRetentionMs: 30 * 86_400_000, toxicMemoryPath: ':memory:' };

function fixture({ lateTemplate = false, missingConfirmation = false, dropRatio = 65n } = {}) {
  let now = T;
  const history = []; const keys = new Set(); let fail = false;
  const store = { recordPreEntryRugToxicHistory(rows) {
    if (fail) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    let n = 0;
    for (const row of rows) {
      const key = `${row.mint}:${row.labeledAt}:${row.subject}`;
      if (!keys.has(key)) { keys.add(key); history.push(clone(row)); n += 1; }
    }
    return n;
  } };
  const tracker = new PreEntryRugRiskTracker({ config, store, now: () => now });
  let b = 1_000_000_000_000_000n; let q = 400_000_000_000n; let sequence = 0;
  const emit = (offset, side = 'BUY', amount = 10, patch = {}) => {
    now = T + offset;
    const preB = b; const preQ = q; const k = b * q;
    q = side === 'SELL' ? q * dropRatio / 100n : q + BigInt(Math.round(amount * 1e9));
    b = k / q;
    const price = Number(q) / Number(b) / 1000;
    const trade = { mint: 'loss-mint', market: 'PUMP_AMM', pool: 'loss-pool',
      side, wallet: `actor-${sequence}`, solAmount: amount, tokenAmount: amount / price,
      timestampMs: now, receivedAtMs: now, chainTimestampMs: now,
      slot: 100 + sequence, signature: `loss-${sequence++}`, eventIndex: 0,
      ammQuoteState: 'POST_TRADE_V1', price, reservePrice: price,
      prePoolBaseReservesRaw: String(preB), prePoolQuoteReservesRaw: String(preQ),
      poolBaseReservesRaw: String(b), poolQuoteReservesRaw: String(q), virtualQuoteReservesRaw: '0', ...patch };
    tracker.observeTrade(trade); return trade;
  };
  let entry;
  if (lateTemplate) { emit(0, 'BUY', 0.01); entry = tracker.captureLossEvidence('loss-mint', now, { phase: 'ENTRY' }); }
  for (const offset of [100, 200, 300, 400]) emit(offset);
  if (!entry) entry = tracker.captureLossEvidence('loss-mint', now, { phase: 'ENTRY' });
  const entryPrice = entry.events.at(-1).reservePrice;
  emit(1000, 'SELL', 120);
  const trigger = tracker.captureLossEvidence('loss-mint', now, { phase: 'TRIGGER' });
  if (!missingConfirmation) emit(1200, 'BUY', 0.01);
  now = T + 1500;
  const resolution = tracker.captureLossEvidence('loss-mint', now, { phase: 'SETTLEMENT' });
  const args = { entryEvidence: { tracker: entry },
    triggerEvidence: { tracker: trigger, resolutionTracker: resolution },
    position: { mint: 'loss-mint', mode: 'LIVE', status: 'CLOSED', entry_price: entryPrice, closed_at: T + 1250 },
    orders: [
      { side: 'BUY', status: 'CONFIRMED', signature: 'actual-buy', wallet_sol_delta: -0.02, network_fee_sol: 0.0001 },
      { side: 'SELL', status: 'CONFIRMED', signature: 'actual-sell', wallet_sol_delta: 0.008, network_fee_sol: 0.0001 },
    ], settlement: { complete: true, realizedReturnPct: -60, entrySolDelta: -0.02 }, knownAt: now };
  return { tracker, args, history, store, emit, get now() { return now; }, setFail(value) { fail = value; } };
}

{
  const f = fixture();
  assert.equal(f.tracker.toxicTemplates.size, 0, 'old 60% learner unchanged: 57.75% does not auto-label');
  const analysis = f.tracker.analyzeLossEvidence(f.args);
  assert.equal(analysis.classification, 'CONFIRMED_RUG', JSON.stringify(analysis));
  assert.equal(analysis.evidence.templateExistedAtEntry, true);
  assert.equal(analysis.evidence.canExplainOriginalEntry, true);
  const version = f.tracker.toxicVersion;
  f.setFail(true);
  assert.throws(() => f.tracker.learnFromLossCase({ caseId: 'LIVE_LOSS:1', analysis, knownAt: f.now }), /busy/);
  assert.equal(f.tracker.toxicVersion, version);
  assert.equal(f.tracker.toxicTemplates.size, 0);
  f.setFail(false);
  let boundedWrites = 0;
  f.store.withLiveLossRugWrite = work => { boundedWrites += 1; return work(); };
  const learned = f.tracker.learnFromLossCase({ caseId: 'LIVE_LOSS:1', analysis, knownAt: f.now });
  assert.equal(boundedWrites, 1, 'new background writes use Store short-lock wrapper when available');
  assert.equal(learned.status, 'LEARNED'); assert.equal(learned.templatesAdded, 1);
  assert.equal(learned.walletsAdded, 0); assert.equal(f.tracker.toxicWallets.size, 0);
  assert.equal(f.history.length, 1); assert.equal(f.history[0].labeledAt, f.now);
  assert.equal(f.tracker.toxicTemplates.get(learned.fingerprint).createdAt, f.now);
  assert.equal(f.tracker.toxicVersion, version + 1);
  assert.equal(f.tracker._activeToxicTemplate(analysis.learningCandidate.template, f.now - 1), null);
  assert(f.tracker._activeToxicTemplate(analysis.learningCandidate.template, f.now));
  assert.equal(f.tracker.learnFromLossCase({ caseId: 'LIVE_LOSS:1', analysis, knownAt: f.now }).status, 'ALREADY_LEARNED');
  assert.equal(f.history.length, 1);
  const restarted = new PreEntryRugRiskTracker({ config, store: f.store, now: () => f.now });
  assert.equal(restarted.learnFromLossCase({ caseId: 'LIVE_LOSS:1', analysis, knownAt: f.now }).status, 'ALREADY_LEARNED');
  assert.equal(f.history.length, 1, 'same persisted label/time is DB-idempotent after crash');
  assert.equal(restarted.toxicTemplates.size, 1);
  assert.equal(f.tracker.learnFromLossCase({ caseId: 'LIVE_LOSS:1', analysis, knownAt: f.now + 1 }).status, 'NOT_ELIGIBLE');
  const lateWriter = new PreEntryRugRiskTracker({ config, store: f.store, now: () => f.now + 3_600_000 });
  lateWriter.learnFromLossCase({ caseId: 'LIVE_LOSS:1', analysis, knownAt: f.now });
  assert.equal(lateWriter.toxicTemplates.get(learned.fingerprint).createdAt, f.now + 3_600_000);
  assert.equal(lateWriter._activeToxicTemplate(analysis.learningCandidate.template, f.now + 1), null,
    'JSON/memory restore cannot backdate durable knowledge after a delayed-write retry');
}

{
  const f = fixture({ lateTemplate: true });
  const analysis = f.tracker.analyzeLossEvidence(f.args);
  assert.equal(analysis.classification, 'CONFIRMED_RUG', JSON.stringify(analysis));
  assert.equal(analysis.evidence.templateExistedAtEntry, false);
  assert.equal(analysis.evidence.canExplainOriginalEntry, false, 'future learning cannot claim to prevent original entry');
  assert.equal(f.args.entryEvidence.tracker.template, null, 'entry snapshot never retroactively filled');
}

for (const [name, change, classification] of [
  ['first tick only', args => { delete args.triggerEvidence.resolutionTracker; }, 'CANDIDATE'],
  ['dry run', args => { args.position.mode = 'DRY_RUN'; }, 'INSUFFICIENT'],
  ['not closed', args => { args.position.status = 'EXIT_FAILED'; }, 'INSUFFICIENT'],
  ['late settlement', args => { args.settlement.complete = false; }, 'INSUFFICIENT'],
  ['missing order receipt', args => { args.orders[1].wallet_sol_delta = null; }, 'INSUFFICIENT'],
  ['failed sell only', args => { args.orders[1].status = 'FAILED'; }, 'INSUFFICIENT'],
  ['future capture', args => { args.knownAt -= 1000; }, 'INSUFFICIENT'],
  ['hidden future rows', args => { args.entryEvidence.tracker.completeness.omittedFutureEvents = 1; }, 'INSUFFICIENT'],
  ['no template', args => { for (const c of [args.entryEvidence.tracker, args.triggerEvidence.tracker, args.triggerEvidence.resolutionTracker]) c.template = null; }, 'CANDIDATE'],
  ['entry overpay', args => { args.position.entry_price *= 1.5; }, 'MIXED'],
  ['fee dominated', args => { args.orders[0].network_fee_sol = 0.012; }, 'MIXED'],
]) {
  const f = fixture(); const args = clone(f.args); change(args);
  const result = f.tracker.analyzeLossEvidence(args);
  assert.equal(result.classification, classification, `${name}: ${JSON.stringify(result)}`);
  assert.equal(result.learningCandidate, null, name);
  assert.equal(f.tracker.learnFromLossCase({ caseId: name, analysis: result, knownAt: f.now }).status, 'NOT_ELIGIBLE');
}

for (const [name, change] of [
  ['wrong pool', row => { row.pool = 'other-pool'; }],
  ['legacy quote', row => { row.ammQuoteState = null; }],
  ['invalid quote', row => { row.ammQuoteState = 'INVALID'; }],
  ['stale chain', row => { row.chainTimestampMs -= 120_000; }],
  ['future chain', row => { row.chainTimestampMs += 1; }],
  ['wrong reserve price', row => { row.reservePrice *= 3; }],
  ['out of order', row => { row.slot = 1; }],
  ['missing identity', row => { row.eventIndex = null; }],
]) {
  const f = fixture(); const args = clone(f.args);
  for (const capture of [args.triggerEvidence.tracker, args.triggerEvidence.resolutionTracker]) {
    change(capture.events.find(row => row.side === 'SELL'));
  }
  const result = f.tracker.analyzeLossEvidence(args);
  assert.equal(result.classification, 'INSUFFICIENT', `${name}: ${JSON.stringify(result)}`);
  assert.equal(result.learningCandidate, null);
}

{
  const f = fixture(); const args = clone(f.args);
  for (const capture of [args.triggerEvidence.tracker, args.triggerEvidence.resolutionTracker]) {
    capture.events.find(row => row.side === 'SELL').prePoolQuoteReservesRaw = '1';
  }
  assert.notEqual(f.tracker.analyzeLossEvidence(args).classification, 'CONFIRMED_RUG', 'missing actual adjacent pool state cannot prove a cliff');
}
{
  const f = fixture({ dropRatio: 90n });
  assert.equal(f.tracker.analyzeLossEvidence(f.args).classification, 'EXECUTION_LOSS', 'small market fall cannot explain a settled 60% loss');
}
{
  const f = fixture({ dropRatio: 90n });
  for (const offset of [1600, 1800, 2000]) f.emit(offset, 'SELL', 30);
  f.emit(2200, 'BUY', 0.01);
  f.args.position.closed_at = f.now;
  f.args.knownAt = f.now;
  f.args.triggerEvidence.resolutionTracker = f.tracker.captureLossEvidence('loss-mint', f.now, { phase: 'SETTLEMENT' });
  assert.equal(f.tracker.analyzeLossEvidence(f.args).classification, 'MARKET_LOSS',
    'gradual cumulative loss is not a >=50% adjacent-event rug');
}
{
  const f = fixture();
  f.emit(2000, 'BUY', 180);
  f.args.knownAt = f.now;
  f.args.triggerEvidence.resolutionTracker = f.tracker.captureLossEvidence('loss-mint', f.now, { phase: 'SETTLEMENT' });
  const result = f.tracker.analyzeLossEvidence(f.args);
  assert.equal(result.classification, 'CONFIRMED_RUG', JSON.stringify(result));
  assert.equal(result.evidence.exitMarkAt, T + 1200, 'ignore rebound after closed_at, even if receipt arrives later');
  delete f.args.position.closed_at;
  const unknown = f.tracker.analyzeLossEvidence(f.args);
  assert.equal(unknown.evidence.markReturnPct, null);
  assert.equal(unknown.evidence.exitMarkBasis, 'UNKNOWN');
}
{
  const f = fixture();
  const frozen = JSON.stringify(f.args.entryEvidence);
  for (let i = 0; i < 1000; i += 1) f.emit(2000 + i, 'BUY', 0.001);
  const snapshot = f.tracker.captureLossEvidence('loss-mint', f.now, { phase: 'SETTLEMENT' });
  assert.equal(snapshot.events.length, 256);
  assert(snapshot.completeness.truncatedEvents > 0);
  assert.equal(JSON.stringify(f.args.entryEvidence), frozen);
  assert.equal(f.tracker.releaseLossEvidence('loss-mint'), true);
  assert.equal(f.tracker.health().lossFeedbackEvidence.activeStreams, 0);
  for (let i = 0; i < 70; i += 1) f.tracker.captureLossEvidence(`bounded-${i}`, f.now, { phase: 'ENTRY' });
  assert.equal(f.tracker.lossEvidenceStreams.size, 64);
  assert(f.tracker.health().lossFeedbackEvidence.streamEvictions >= 6);
  f.tracker.advanceTime(f.now + 36 * 60_000);
  assert.equal(f.tracker.lossEvidenceStreams.size, 0);
}

console.log('PASS live loss RUG evidence: frozen bounded captures, causal POST proof, conservative attribution, durable template-only learning');
