'use strict';

const assert = require('node:assert/strict');
const { RuntimeTaskMetrics } = require('../src/runtime/RuntimeTaskMetrics');
const { ParserRejectionAudit } = require('../src/runtime/ParserRejectionAudit');
let now = 1000; let tick = 0n; const logged = [];
const advance = (ms) => { now += ms; tick += BigInt(ms) * 1000000n; };
const metrics = new RuntimeTaskMetrics({ now: () => now, monotonic: () => tick,
  onSlow: (row) => logged.push(row), maxTasks: 2, maxSlow: 2 });
assert.equal(metrics.run('stage', () => { advance(150); return 42; }), 42);
assert.throws(() => metrics.run('stage', () => { advance(120); throw new Error('expected'); }), /expected/);
assert.equal(metrics.health().tasks.stage.calls, 2);
assert.equal(metrics.health().tasks.stage.failures, 1);
assert.equal(metrics.health().tasks.stage.maxMs, 150);
assert.equal(logged.length, 1, 'logs are throttled, counters are not');
assert.equal(logged[0].startedAt, 1000);
assert.equal(logged[0].finishedAt, 1150);
metrics.run('second', () => advance(200));
metrics.run('overflow', () => advance(1));
assert.equal(metrics.health().untrackedNames, 1);
assert.equal(metrics.health().recentSlow.length, 2);
const snapshot = metrics.health(); snapshot.tasks.stage.calls = 0;
assert.equal(metrics.health().tasks.stage.calls, 2, 'read-only detached snapshots');
const badLogger = new RuntimeTaskMetrics({ now: () => now, monotonic: () => tick,
  onSlow: () => { throw new Error('logging must not abort trading'); } });
assert.equal(badLogger.run('x', () => { advance(200); return 'ok'; }), 'ok');
assert.equal(badLogger.health().logErrors, 1);

let calls = 0; let fail = true; const saved = [];
const store = { recordParserQuarantineBatch(rows) { calls += 1;
  if (fail) throw new Error('database locked'); saved.push(...rows); } };
const audit = new ParserRejectionAudit({ store, now: () => now, maxPending: 2, batchSize: 1 });
const input = { signature: 'sig1', eventIndex: 0, programId: 'program', reason: 'BAD_TIME',
  receivedAtMs: now, dataLength: 129, dataHash: 'a'.repeat(64),
  details: { chainTimestampMs: -1e21, tokenAmountRaw: '123', apiKey: 'secret', url: 'https://credential.invalid',
    ammExecutionFees: { quoteAmountRaw: '100000000', poolQuoteAmountRaw: '99011856',
      userQuoteAmountRaw: '98814227', lpFeeRaw: '19764', lpFeeBasisPoints: 2,
      protocolFeeRaw: { apiKey: 'nested-private-value' },
      coinCreatorFeeRaw: 'https://nested-credential.invalid/api-key',
      cashbackRaw: '9'.repeat(1000), buybackRaw: '0', ixName: 'buy_exact_quote_in',
      apiKey: 'nested-private-value', nested: { token: 'another-private-value' } } } };
assert.equal(audit.enqueue(input), true);
assert.equal(calls, 0, 'parser path must not touch SQLite');
assert.equal(audit.enqueue(input), false);
audit.enqueue({ ...input, signature: 'sig2' });
audit.enqueue({ ...input, signature: 'sig3' });
assert.equal(audit.health().dropped, 1);
assert.equal(audit.health().duplicatePending, 1);
assert.equal(audit.flush(), 0);
assert.equal(audit.health().pending, 2);
audit.flush(); assert.equal(calls, 1, 'failed diagnostic writes back off');
advance(5000); fail = false;
assert.equal(audit.flush(), 1);
assert.equal(audit.flush(), 1);
assert.equal(audit.health().pending, 0);
assert.equal(saved[0].details.tokenAmountRaw, '123');
assert.equal(JSON.stringify(saved).includes('secret'), false);
assert.equal(JSON.stringify(saved).includes('credential.invalid'), false);
assert.deepEqual(saved[0].details.ammExecutionFees, { quoteAmountRaw: '100000000',
  poolQuoteAmountRaw: '99011856', userQuoteAmountRaw: '98814227', lpFeeRaw: '19764',
  buybackRaw: '0', lpFeeBasisPoints: 2, ixName: 'buy_exact_quote_in' });
assert.equal(JSON.stringify(saved).includes('private-value'), false);
input.details.ammExecutionFees.poolQuoteAmountRaw = 'mutation';
assert.equal(saved[0].details.ammExecutionFees.poolQuoteAmountRaw, '99011856',
  'nested whitelist data must be detached from caller-owned input');
const guardedSaved = [];
const guardedAudit = new ParserRejectionAudit({ now: () => now,
  store: { recordParserQuarantineBatch: (rows) => guardedSaved.push(...rows) } });
for (const dataHash of [null, undefined, '', 'g'.repeat(64), 'a'.repeat(63), {}]) {
  assert.equal(guardedAudit.enqueue({ ...input, dataHash }), false);
}
assert.equal(guardedAudit.health().invalidRecords, 6);
assert.equal(guardedAudit.health().dropped, 6);
assert.equal(guardedAudit.health().pending, 0, 'invalid hash never poisons the retry head');
for (const [i, receivedAtMs] of [-1, NaN, Number.MAX_SAFE_INTEGER + 1].entries()) {
  assert.equal(guardedAudit.enqueue({ ...input, signature: `corrected-${i}`, dataHash: 'A'.repeat(64),
    eventIndex: receivedAtMs, receivedAtMs, dataLength: -1 }), true);
}
assert.equal(guardedAudit.flush(), 3);
for (const row of guardedSaved) {
  assert.equal(row.receivedAtMs, now);
  assert.equal(row.createdAt, now);
  assert.equal(row.eventIndex, 0);
  assert.equal(row.dataLength, null);
  assert.equal(row.dataHash, 'a'.repeat(64));
}
const crowdedDetails = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`field${i}`, i]));
crowdedDetails.ammExecutionFees = { poolQuoteAmountRaw: '99011856', userQuoteAmountRaw: '98814227',
  apiKey: 'must-not-leak', lpFeeRaw: { nested: 'must-not-leak' } };
assert.equal(guardedAudit.enqueue({ ...input, signature: 'full-decoder-fields', details: crowdedDetails }), true);
assert.equal(guardedAudit.flush(), 1);
assert.deepEqual(guardedSaved.at(-1).details.ammExecutionFees,
  { poolQuoteAmountRaw: '99011856', userQuoteAmountRaw: '98814227' },
  'fee evidence must not be truncated when the decoder already has 24 flat fields');
assert.equal(JSON.stringify(guardedSaved.at(-1)).includes('must-not-leak'), false);
console.log('Runtime task metrics and bounded parser quarantine tests passed');
