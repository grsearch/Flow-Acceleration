'use strict';

const boundedText = (value, length) => typeof value === 'string' ? value.slice(0, length) : null;
const AMM_FEE_RAW_FIELDS = ['quoteAmountRaw', 'poolQuoteAmountRaw', 'userQuoteAmountRaw',
  'lpFeeRaw', 'protocolFeeRaw', 'coinCreatorFeeRaw', 'cashbackRaw', 'buybackRaw'];
const AMM_FEE_BPS_FIELDS = ['lpFeeBasisPoints', 'protocolFeeBasisPoints', 'coinCreatorFeeBasisPoints',
  'cashbackFeeBasisPoints', 'buybackFeeBasisPoints'];
function safeAmmExecutionFees(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const result = {};
  // One known level only. Raw integer text retains exact forensic deltas, but
  // unknown keys, URLs and nested objects can never become an audit payload.
  for (const key of AMM_FEE_RAW_FIELDS) {
    const value = input[key];
    if (typeof value === 'string' && /^-?\d{1,39}$/.test(value)) result[key] = value;
  }
  for (const key of AMM_FEE_BPS_FIELDS) {
    if (Number.isSafeInteger(input[key])) result[key] = input[key];
  }
  if (typeof input.ixName === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(input.ixName)) {
    result.ixName = input.ixName;
  }
  return result;
}
function safeDetails(input) {
  const result = {};
  // Reserve the bounded, known fee context independently of flat diagnostic
  // order; a populated decoder must not push its deltas past the 24-field cap.
  const fees = safeAmmExecutionFees(input?.ammExecutionFees);
  if (fees && Object.keys(fees).length) result.ammExecutionFees = fees;
  for (const [key, value] of Object.entries(input || {}).slice(0, 24)) {
    if (key === 'ammExecutionFees') continue;
    if (/secret|password|credential|authorization|token|url|key/i.test(key) && !/tokenAmount|tokenReserve/i.test(key)) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(key)) continue;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
    else if (typeof value === 'string' && !/(?:https?|wss?):\/\//i.test(value)) result[key] = value.slice(0, 160);
  }
  return result;
}

// Rejecting a malformed event must never turn into synchronous DB work on the
// parser path. This bounded diagnostic buffer is lossy on overload, explicitly
// counted; it is not the canonical trade/accounting queue.
class ParserRejectionAudit {
  constructor({ store, now = Date.now, maxPending = 500, batchSize = 10,
    retryMs = 5_000 } = {}) {
    Object.assign(this, { store, now, maxPending, batchSize, retryMs });
    this.pending = [];
    this.pendingKeys = new Set();
    this.nextAttemptAt = 0;
    this.stats = { observed: 0, persisted: 0, duplicatePending: 0, dropped: 0, invalidRecords: 0,
      writeErrors: 0, lastRejectedAt: null, lastPersistedAt: null, lastErrorAt: null };
  }

  enqueue(event) {
    this.stats.observed += 1;
    const suppliedNow = this.now();
    const createdAt = Number.isSafeInteger(suppliedNow) && suppliedNow > 0 ? suppliedNow : Date.now();
    this.stats.lastRejectedAt = createdAt;
    const dataHash = typeof event?.dataHash === 'string' && /^[a-f0-9]{64}$/i.test(event.dataHash)
      ? event.dataHash.toLowerCase() : null;
    if (!dataHash) {
      // A malformed audit record must not sit at the head of an otherwise valid
      // batch and make every persistence retry fail its SQL input contract.
      this.stats.invalidRecords += 1;
      this.stats.dropped += 1;
      return false;
    }
    const row = { signature: boundedText(event?.signature, 128),
      eventIndex: Number.isSafeInteger(event?.eventIndex) && event.eventIndex >= 0 ? event.eventIndex : 0,
      programId: boundedText(event?.programId, 64),
      reason: boundedText(event?.reason, 96) || 'INVALID_EVENT',
      receivedAtMs: Number.isSafeInteger(event?.receivedAtMs) && event.receivedAtMs > 0 ? event.receivedAtMs : createdAt,
      dataLength: Number.isSafeInteger(event?.dataLength) && event.dataLength >= 0 ? event.dataLength : null,
      dataHash,
      details: safeDetails(event?.details), createdAt };
    const key = JSON.stringify([row.signature, row.eventIndex, row.programId, row.reason, row.dataHash]);
    if (this.pendingKeys.has(key)) { this.stats.duplicatePending += 1; return false; }
    if (this.pending.length >= this.maxPending) { this.stats.dropped += 1; return false; }
    this.pending.push({ key, row });
    this.pendingKeys.add(key);
    return true;
  }

  flush() {
    const now = this.now();
    if (!this.pending.length || now < this.nextAttemptAt) return 0;
    const batch = this.pending.slice(0, this.batchSize);
    try {
      this.store.recordParserQuarantineBatch(batch.map(({ row }) => row));
      this.pending.splice(0, batch.length);
      for (const { key } of batch) this.pendingKeys.delete(key);
      this.stats.persisted += batch.length;
      this.stats.lastPersistedAt = now;
      this.nextAttemptAt = 0;
      return batch.length;
    } catch (_) {
      this.stats.writeErrors += 1;
      this.stats.lastErrorAt = now;
      this.nextAttemptAt = now + this.retryMs;
      return 0;
    }
  }

  health() {
    return { ...this.stats, pending: this.pending.length,
      oldestPendingAt: this.pending[0]?.row.createdAt ?? null,
      nextAttemptAt: this.nextAttemptAt || null, capacity: this.maxPending,
      mode: 'BOUNDED_DIAGNOSTIC_BUFFER' };
  }
}

module.exports = { ParserRejectionAudit };
