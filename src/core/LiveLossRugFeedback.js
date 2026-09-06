'use strict';

const VERSION = 'LIVE_LOSS_FEEDBACK_V1';
const integer = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const numeric = value => value == null || value === '' ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const bounded = (value, length = 128) => typeof value === 'string' ? value.slice(0, length) : null;
const positionId = position => integer(Number(position?.id ?? position?.positionId ?? position?.position_id));
const valueOf = (object, camel, snake) => object?.[camel] ?? object?.[snake];
const live = position => String(position?.mode || '').toUpperCase() === 'LIVE';
const errorKind = error => /SQLITE_BUSY/.test(String(error?.code || error?.message || '')) ? 'SQLITE_BUSY'
  : /SQLITE_LOCKED/.test(String(error?.code || error?.message || '')) ? 'SQLITE_LOCKED' : 'FEEDBACK_ERROR';

function evidenceSignal(event) {
  const result = {};
  for (const key of ['timestampMs', 'receivedAtMs', 'chainTimestampMs', 'slot', 'eventIndex',
    'price', 'reservePrice', 'solAmount', 'tokenAmount']) result[key] = numeric(event?.[key]);
  for (const key of ['signature', 'market', 'pool', 'side', 'wallet', 'ammQuoteState',
    'poolBaseReservesRaw', 'poolQuoteReservesRaw', 'prePoolBaseReservesRaw', 'prePoolQuoteReservesRaw']) {
    result[key] = bounded(event?.[key]);
  }
  return result;
}

// This queue is diagnostic/learning work only. No method can submit an order,
// modify a trading switch or fetch chain/RPC data. Evidence is captured before
// entry/at the first observed loss, and accounting is independently rechecked.
class LiveLossRugFeedback {
  constructor({ config = {}, store, tracker, now = Date.now } = {}) {
    this.config = config;
    this.enabled = config.enabled === true;
    this.store = store;
    this.tracker = tracker;
    this.now = now;
    this.lossThresholdPct = Math.max(50, numeric(config.lossThresholdPct) ?? 50);
    this.maxPending = Math.max(1, Math.min(2_000, integer(config.maxPending) || 256));
    this.batchSize = Math.max(1, Math.min(50, integer(config.batchSize) || 10));
    this.recoveryBatchSize = Math.max(1, Math.min(50, integer(config.recoveryBatchSize) || 25));
    this.flushIntervalMs = Math.max(50, integer(config.flushIntervalMs) || 1_000);
    this.recoveryIntervalMs = Math.max(1_000, integer(config.recoveryIntervalMs) || 30_000);
    this.retryMs = Math.max(100, integer(config.retryMs) || 1_000);
    this.maxEvidenceBytes = Math.max(4_096, Math.min(1_048_576, integer(config.maxEvidenceBytes) || 262_144));
    this.pending = new Map();
    this.tracked = new Map();
    this.started = false;
    this.stopping = false;
    this.processing = null;
    this.immediate = null;
    this.timer = null;
    this.recoveryAfterId = 0;
    this.nextRecoveryAt = 0;
    this.stats = { capturedEntries: 0, triggerCaptures: 0, settlementRequests: 0,
      completedCases: 0, learnedCases: 0, duplicateRequests: 0, ignoredNonLive: 0,
      ignoredSettlement: 0, invalidSettlements: 0, evidenceErrors: 0, writeErrors: 0,
      learningErrors: 0, recoveryErrors: 0, recoveredPositions: 0, dropped: 0,
      entryEvidenceUnavailable: 0, consecutiveEvidenceErrors: 0,
      lastEvidenceError: null, lastEvidenceErrorAt: null, lastSuccessfulCaptureAt: null,
      lastError: null, lastErrorAt: null, lastPersistedAt: null, lastCompletedAt: null };
  }

  _resolveTracker() {
    // Runtime may restore the manager before binding the collector. Never
    // freeze that initial undefined reference, or keep a replaced collector.
    return this.store?.preEntryRugRisk ?? this.tracker;
  }

  _trackerState() {
    const tracker = this._resolveTracker();
    const collecting = Boolean(tracker) && tracker.config?.enabled !== false;
    return { trackerBound: Boolean(tracker), trackerEnabled: collecting,
      captureReady: collecting && typeof tracker.captureLossEvidence === 'function',
      analyzerReady: collecting && typeof tracker.analyzeLossEvidence === 'function',
      learningReady: collecting && typeof tracker.learnFromLossCase === 'function' };
  }

  _evidenceError(reason) {
    this.stats.evidenceErrors += 1;
    this.stats.consecutiveEvidenceErrors += 1;
    // Only stable codes, never arbitrary exception text or provider secrets.
    this.stats.lastEvidenceError = reason;
    this.stats.lastEvidenceErrorAt = this.now();
  }

  start() {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.stopping = false;
    this.nextRecoveryAt = 0;
    this.timer = setInterval(() => this.advanceTime(), this.flushIntervalMs);
    this.timer.unref?.();
    this._schedule();
  }

  _identity(position) {
    const id = positionId(position);
    const mint = bounded(position?.mint, 96);
    return id && mint ? { positionId: id, mint,
      strategyId: bounded(valueOf(position, 'strategyId', 'strategy_id'), 160),
      mode: 'LIVE', entryAt: numeric(position.entryAt ?? position.openedAt ?? position.opened_at) } : null;
  }

  _copyEvidence(value, capturedAt) {
    try {
      const text = JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item);
      if (!text || Buffer.byteLength(text, 'utf8') > this.maxEvidenceBytes) throw new Error('EVIDENCE_LIMIT');
      return JSON.parse(text);
    } catch (_) {
      this._evidenceError('EVIDENCE_NOT_SERIALIZABLE_OR_LIMIT');
      return { version: VERSION, capturedAt, evidenceUnavailable: true, reason: 'EVIDENCE_NOT_SERIALIZABLE_OR_LIMIT' };
    }
  }

  _capture(mint, phase, capturedAt) {
    const unavailable = reason => {
      this._evidenceError(reason);
      return { version: VERSION, mint, phase, capturedAt, evidenceUnavailable: true, reason };
    };
    const tracker = this._resolveTracker();
    if (tracker?.config?.enabled === false) return unavailable('CAPTURE_DISABLED');
    if (typeof tracker?.captureLossEvidence !== 'function') return unavailable('CAPTURE_UNAVAILABLE');
    try {
      const value = tracker.captureLossEvidence(mint, capturedAt, { phase });
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.then === 'function') return unavailable('INVALID_CAPTURE_RESULT');
      if (value.evidenceUnavailable === true) return unavailable('CAPTURE_REPORTED_UNAVAILABLE');
      const captured = this._copyEvidence(value, capturedAt);
      if (captured.evidenceUnavailable !== true) {
        this.stats.lastSuccessfulCaptureAt = capturedAt;
        this.stats.consecutiveEvidenceErrors = 0;
      }
      return captured;
    } catch (_) {
      return unavailable('CAPTURE_FAILED');
    }
  }

  captureEntry(position, event) {
    if (!this.enabled) return false;
    if (!live(position)) { this.stats.ignoredNonLive += 1; return false; }
    const identity = this._identity(position);
    if (!identity) return false;
    if (this.tracked.get(identity.positionId)?.entryEvidence) { this.stats.duplicateRequests += 1; return false; }
    if (!this._hasCapacity(identity.positionId) || this.tracked.size >= this.maxPending) {
      this.stats.dropped += 1; return false;
    }
    const capturedAt = this.now();
    const entryEvidence = { version: VERSION, ...identity, capturedAt, phase: 'ENTRY',
      tracker: this._capture(identity.mint, 'ENTRY', capturedAt), signal: evidenceSignal(event) };
    if (entryEvidence.tracker.evidenceUnavailable === true) this.stats.entryEvidenceUnavailable += 1;
    this.tracked.set(identity.positionId, { ...identity, entryEvidence, triggerEvidence: null });
    this.stats.capturedEntries += 1;
    return this._enqueue(identity.positionId, { ...identity, entryEvidence, status: 'CAPTURED', updatedAt: capturedAt });
  }

  observePosition(position, trade) {
    if (!this.enabled) return false;
    if (!live(position)) { this.stats.ignoredNonLive += 1; return false; }
    const identity = this._identity(position);
    if (!identity || position.mint !== trade?.mint) return false;
    const entryPrice = numeric(valueOf(position, 'entryPrice', 'entry_price'));
    const markPrice = numeric(trade?.reservePrice) ?? numeric(trade?.price);
    if (!(entryPrice > 0) || !(markPrice > 0)) return false;
    const markReturnPct = (markPrice / entryPrice - 1) * 100;
    if (markReturnPct > -this.lossThresholdPct) return false;
    const previous = this.tracked.get(identity.positionId);
    if (previous?.triggerEvidence) return false;
    if (!this._hasCapacity(identity.positionId)
      || (!previous && this.tracked.size >= this.maxPending)) { this.stats.dropped += 1; return false; }
    const capturedAt = this.now();
    const triggerEvidence = { version: VERSION, ...identity, capturedAt, phase: 'TRIGGER',
      markReturnPct, entryPrice, markPrice, tracker: this._capture(identity.mint, 'TRIGGER', capturedAt),
      signal: evidenceSignal(trade) };
    // On restart, a missing entry snapshot stays missing. The deferred reader
    // can load a previously saved snapshot; current data is never substituted.
    this.tracked.set(identity.positionId, { ...identity, entryEvidence: previous?.entryEvidence || null,
      triggerEvidence });
    this.stats.triggerCaptures += 1;
    return this._enqueue(identity.positionId, { ...identity, triggerAt: capturedAt,
      triggerEvidence, status: 'TRIGGERED', updatedAt: capturedAt });
  }

  onSettlement(id, totals) {
    if (!this.enabled || !integer(Number(id))) return false;
    id = Number(id);
    const returnPct = numeric(totals?.realizedReturnPct);
    if (totals?.complete !== true || returnPct == null) {
      this.stats.ignoredSettlement += 1;
      return false;
    }
    this.stats.settlementRequests += 1;
    // Do not fetch a position from SQLite in the settlement callback.
    return this._enqueue(id, {}, this._copyEvidence(totals, this.now()));
  }

  onEntryFailed(position) {
    if (!this.enabled) return false;
    const id = typeof position === 'object' ? positionId(position) : integer(Number(position));
    const known = this.tracked.get(id);
    const identity = typeof position === 'object' && live(position) ? this._identity(position) : known;
    if (!id || !identity) return false;
    const queued = this._enqueue(id, { positionId: id, mint: identity.mint,
      strategyId: identity.strategyId, mode: 'LIVE', status: 'FINAL', classification: 'NOT_APPLICABLE',
      learning: { status: 'NOT_ELIGIBLE', templatesAdded: 0, walletsAdded: 0 }, updatedAt: this.now() });
    if (queued) {
      this.pending.get(id).entryFailureOnly = true;
      this._releaseTracking(id);
    }
    return queued;
  }

  _hasCapacity(id) { return this.pending.has(id) || this.pending.size < this.maxPending; }

  _enqueue(id, patch, totals = undefined, recovered = false) {
    if (!this._hasCapacity(id)) { this.stats.dropped += 1; return false; }
    const previous = this.pending.get(id);
    if (previous?.needsSettlement && totals) this.stats.duplicateRequests += 1;
    this.pending.set(id, { positionId: id, patch: { ...(previous?.patch || {}), ...patch },
      needsSettlement: previous?.needsSettlement || totals !== undefined || recovered,
      totals: totals ?? previous?.totals, nextAttemptAt: previous?.nextAttemptAt || 0,
      firstSettlementAt: previous?.firstSettlementAt ?? (totals !== undefined || recovered ? this.now() : null),
      entryFailureOnly: previous?.entryFailureOnly || false,
      durableDeferred: false,
      revision: (previous?.revision || 0) + 1 });
    this._schedule();
    return true;
  }

  _schedule() {
    if (!this.started || this.stopping || this.immediate || this.processing) return;
    this.immediate = setImmediate(() => {
      this.immediate = null;
      this.flush().catch(error => this._error(error, 'writeErrors'));
    });
    this.immediate.unref?.();
  }

  advanceTime() { if (this.enabled) this._schedule(); }

  _error(error, counter) {
    this.stats[counter] += 1;
    this.stats.lastError = errorKind(error);
    this.stats.lastErrorAt = this.now();
  }

  async _recover(now) {
    if (!this.started || this.stopping || now < this.nextRecoveryAt
      || this.pending.size >= this.maxPending || typeof this.store?.pendingLiveLossRugPositions !== 'function') return;
    try {
      const limit = Math.min(this.recoveryBatchSize, this.maxPending - this.pending.size);
      const rows = await this.store.pendingLiveLossRugPositions(limit, this.recoveryAfterId);
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = positionId(row);
        if (!id) continue;
        this.recoveryAfterId = Math.max(this.recoveryAfterId, id);
        if (!this.pending.has(id) && this._enqueue(id, {}, undefined, true)) this.stats.recoveredPositions += 1;
      }
      const hasScanMetadata = Array.isArray(rows) && Number.isSafeInteger(rows.lastScannedId)
        && rows.lastScannedId >= 0 && typeof rows.hasMore === 'boolean';
      if (hasScanMetadata) {
        // The bounded Store page can contain only already-final cases. An
        // empty pending array does NOT mean its indexed scan reached the end.
        if (rows.lastScannedId < this.recoveryAfterId
          || (rows.hasMore && rows.lastScannedId <= this.recoveryAfterId && !rows.length)) {
          throw new Error('NON_ADVANCING_RECOVERY_PAGE');
        }
        this.recoveryAfterId = Math.max(this.recoveryAfterId, rows.lastScannedId);
        if (rows.hasMore) this.nextRecoveryAt = now + this.flushIntervalMs;
        else { this.recoveryAfterId = 0; this.nextRecoveryAt = now + this.recoveryIntervalMs; }
      } else if (!Array.isArray(rows) || rows.length < limit) {
        this.recoveryAfterId = 0;
        this.nextRecoveryAt = now + this.recoveryIntervalMs;
      } else this.nextRecoveryAt = now + this.flushIntervalMs;
    } catch (error) {
      this._error(error, 'recoveryErrors');
      this.nextRecoveryAt = now + this.retryMs;
    }
  }

  async flush({ force = false } = {}) {
    if (!this.enabled) return 0;
    if (this.processing) return this.processing;
    this.processing = (async () => {
      const now = this.now();
      await this._recover(now);
      let processed = 0;
      for (const [id, queued] of [...this.pending]) {
        if (processed >= this.batchSize) break;
        if (!force && now < queued.nextAttemptAt) continue;
        processed += 1;
        const item = { ...queued, patch: { ...queued.patch } };
        try {
          const result = await this._process(item);
          const current = this.pending.get(id);
          if (current?.revision === item.revision) {
            if (result?.deferUntil) {
              current.nextAttemptAt = result.deferUntil;
              current.durableDeferred = true;
            } else this.pending.delete(id);
          }
          this.stats.lastPersistedAt = this.now();
          this._maybeReleaseEvidence(item.patch.mint);
        } catch (error) {
          this._error(error, error?.feedbackPhase === 'LEARNING' ? 'learningErrors' : 'writeErrors');
          const current = this.pending.get(id);
          if (current) {
            current.nextAttemptAt = this.now() + this.retryMs;
            // Let other cases progress, including the bounded shutdown pass.
            this.pending.delete(id); this.pending.set(id, current);
          }
          if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(errorKind(error))) break;
        }
      }
      return processed;
    })();
    try { return await this.processing; }
    finally { this.processing = null; }
  }

  _verify(position, orders, requested, knownAt) {
    const fail = reason => ({ valid: false, reason });
    if (!live(position)) return fail('NOT_REAL_LIVE');
    if (position?.status !== 'CLOSED') return fail('POSITION_NOT_CLOSED');
    if (!Array.isArray(orders) || !orders.length) return fail('ORDERS_UNAVAILABLE');
    let entry = 0; let exit = 0; let buys = 0; let sells = 0;
    for (const order of orders) {
      const delta = numeric(valueOf(order, 'walletSolDelta', 'wallet_sol_delta'));
      const signature = bounded(order.signature);
      if (signature && delta == null) return fail('UNSETTLED_SIGNED_ORDER');
      if (delta == null) continue;
      if (!signature && delta !== 0) return fail('UNSIGNED_ACCOUNTING_DELTA');
      if (signature && !['CONFIRMED', 'CONFIRMED_PARTIAL', 'FAILED'].includes(order.status)) return fail('ORDER_STATUS_UNRESOLVED');
      const confirmedAt = numeric(valueOf(order, 'confirmedAt', 'confirmed_at'));
      if (confirmedAt != null && confirmedAt > knownAt) return fail('FUTURE_ORDER_EVIDENCE');
      if (order.side === 'BUY') {
        entry += delta;
        if (signature && ['CONFIRMED', 'CONFIRMED_PARTIAL'].includes(order.status) && delta < 0) buys += 1;
      } else if (order.side === 'SELL') {
        exit += delta;
        if (signature && ['CONFIRMED', 'CONFIRMED_PARTIAL'].includes(order.status)) sells += 1;
      } else if (delta !== 0) return fail('UNKNOWN_ACCOUNTING_SIDE');
    }
    if (!buys || !sells || !(entry < 0)) return fail('MISSING_EXECUTED_BUY_OR_SELL');
    const pnl = entry + exit;
    const pct = pnl / Math.abs(entry) * 100;
    if (!Number.isFinite(pct) || !Number.isFinite(pnl)) return fail('INVALID_ACCOUNTING_TOTALS');
    const requestedPct = numeric(requested?.realizedReturnPct);
    const requestedPnl = numeric(requested?.realizedPnlSol ?? requested?.pnlSol);
    if (requested && (requested.complete !== true || requestedPct == null
      || Math.abs(requestedPct - pct) > 1e-6
      || (requestedPnl != null && Math.abs(requestedPnl - pnl) > 1e-9))) return fail('SETTLEMENT_TOTAL_MISMATCH');
    return { valid: true, reason: 'VERIFIED_SIGNED_WALLET_ACCOUNTING', complete: true,
      qualifiesLoss: pct <= -this.lossThresholdPct,
      realizedReturnPct: pct, realizedPnlSol: pnl, pnlSol: pnl,
      entrySolDelta: entry, exitSolDelta: exit, pendingSettlements: 0,
      confirmedBuys: buys, confirmedSells: sells };
  }

  async _process(item) {
    let existing = await this.store.getLiveLossRugCase(item.positionId);
    if (item.entryFailureOnly && !existing && !item.patch.entryEvidence) return;
    const finalComplete = existing?.status === 'FINAL'
      && ['LEARNED', 'ALREADY_LEARNED', 'NOT_ELIGIBLE'].includes(existing.learning?.status);
    if (finalComplete) { this.stats.duplicateRequests += 1; this._releaseTracking(item.positionId); return; }
    const memory = this.tracked.get(item.positionId);
    const patch = { ...item.patch };
    if (memory?.entryEvidence && !existing?.entryEvidence) patch.entryEvidence = memory.entryEvidence;
    if (memory?.triggerEvidence && !existing?.triggerEvidence) {
      patch.triggerEvidence = memory.triggerEvidence;
      patch.triggerAt = memory.triggerEvidence.capturedAt;
    }
    if (Object.keys(patch).length) {
      // A delayed trigger must not downgrade a settled ANALYZED case.
      if (existing?.status === 'ANALYZED') delete patch.status;
      await this.store.upsertLiveLossRugCase({ positionId: item.positionId, ...patch });
      existing = await this.store.getLiveLossRugCase(item.positionId);
    }
    if (!item.needsSettlement) return;
    const loaded = await this.store.getLiveLossRugPosition(item.positionId);
    const position = loaded?.position || loaded;
    const orders = loaded?.orders;
    const identity = this._identity(position || {});
    if (!identity || !live(position)) { this.stats.ignoredNonLive += 1; this._releaseTracking(item.positionId); return; }
    if (position.status === 'ENTRY_FAILED') {
      await this.store.upsertLiveLossRugCase({ ...identity, status: 'FINAL', classification: 'NOT_APPLICABLE',
        learning: { status: 'NOT_ELIGIBLE', templatesAdded: 0, walletsAdded: 0 }, updatedAt: this.now() });
      this._releaseTracking(item.positionId);
      return;
    }
    const validation = this._verify(position, orders, item.totals, this.now());
    if (!validation.valid) {
      this.stats.invalidSettlements += 1;
      await this.store.upsertLiveLossRugCase({ ...identity, status: 'INVALID_SETTLEMENT',
        attribution: { settlementValidation: validation }, updatedAt: this.now() });
      return;
    }
    if (!validation.qualifiesLoss) {
      await this.store.upsertLiveLossRugCase({ ...identity, status: 'FINAL',
        settledAt: this.now(), realizedReturnPct: validation.realizedReturnPct, pnlSol: validation.pnlSol,
        classification: existing?.triggerEvidence || memory?.triggerEvidence ? 'RECOVERED' : 'NOT_LOSS',
        attribution: { version: VERSION, knownAt: this.now(), settlementValidation: validation },
        learning: { status: 'NOT_ELIGIBLE', templatesAdded: 0, walletsAdded: 0 }, updatedAt: this.now() });
      this.stats.completedCases += 1; this.stats.lastCompletedAt = this.now();
      this._releaseTracking(item.positionId);
      return;
    }
    const savedConfirmationDeadline = numeric(existing?.attribution?.confirmationDeadlineAt);
    if (existing?.status === 'AWAITING_CONFIRMATION' && savedConfirmationDeadline > this.now()) {
      return { deferUntil: savedConfirmationDeadline };
    }
    const analyzed = ['ANALYZED', 'FINAL'].includes(existing?.status);
    let analysis = analyzed ? existing.attribution?.analysis : null;
    let knownAt = analyzed ? numeric(existing.attribution?.knownAt) : null;
    let resolutionTracker = analyzed ? existing.attribution?.resolutionTracker : null;
    if (!analysis || !(knownAt > 0)) {
      knownAt = this.now();
      resolutionTracker = this._capture(identity.mint, 'SETTLEMENT', knownAt);
      const entryEvidence = existing?.entryEvidence || memory?.entryEvidence || null;
      const triggerEvidence = { ...(existing?.triggerEvidence || memory?.triggerEvidence || {}), resolutionTracker };
      const tracker = this._resolveTracker();
      analysis = !entryEvidence || !entryEvidence.tracker || entryEvidence.tracker.evidenceUnavailable === true
        ? { classification: 'INSUFFICIENT', reason: 'ENTRY_EVIDENCE_UNAVAILABLE', learningCandidate: null }
        : resolutionTracker.evidenceUnavailable === true
        ? { classification: 'INSUFFICIENT', reason: 'SETTLEMENT_EVIDENCE_UNAVAILABLE', learningCandidate: null }
        : typeof tracker?.analyzeLossEvidence === 'function'
        ? await tracker.analyzeLossEvidence({ entryEvidence, triggerEvidence,
          position, orders, settlement: validation, knownAt })
        : { classification: 'INSUFFICIENT', reason: 'LOSS_ANALYZER_UNAVAILABLE', learningCandidate: null };
      analysis = this._copyEvidence(analysis, knownAt);
      if (typeof analysis?.classification !== 'string') {
        analysis = { classification: 'INSUFFICIENT', reason: 'INVALID_ANALYSIS_RESULT', learningCandidate: null };
      }
      const confirmationDeadlineAt = savedConfirmationDeadline ?? ((item.firstSettlementAt || knownAt) + 5_000);
      if (analysis.classification === 'CANDIDATE'
        && analysis.reason === 'INDEPENDENT_POST_COLLAPSE_CONFIRMATION_MISSING'
        && knownAt < confirmationDeadlineAt) {
        await this.store.upsertLiveLossRugCase({ ...identity, status: 'AWAITING_CONFIRMATION',
          settledAt: knownAt, realizedReturnPct: validation.realizedReturnPct, pnlSol: validation.pnlSol,
          classification: analysis.classification,
          attribution: { version: VERSION, knownAt, confirmationDeadlineAt,
            analysis, resolutionTracker, settlementValidation: validation },
          learning: { status: 'PENDING' }, updatedAt: knownAt });
        return { deferUntil: confirmationDeadlineAt };
      }
      // Even a learning exception must leave the confirmed case + frozen
      // attribution durable. Retry never reruns it against later market data.
      await this.store.upsertLiveLossRugCase({ ...identity,
        settledAt: knownAt, realizedReturnPct: validation.realizedReturnPct, pnlSol: validation.pnlSol,
        status: 'ANALYZED', classification: analysis.classification,
        attribution: { version: VERSION, knownAt, analysis, resolutionTracker, settlementValidation: validation },
        learning: { status: analysis.learningCandidate ? 'PENDING' : 'NOT_ELIGIBLE' }, updatedAt: knownAt });
    }
    let learning = { status: 'NOT_ELIGIBLE', templatesAdded: 0, walletsAdded: 0 };
    if (analysis.classification === 'CONFIRMED_RUG' && analysis.learningCandidate) {
      try {
        const tracker = this._resolveTracker();
        if (tracker?.config?.enabled === false || typeof tracker?.learnFromLossCase !== 'function') throw new Error('LEARNING_UNAVAILABLE');
        learning = await tracker.learnFromLossCase({ caseId: `LIVE_LOSS:${item.positionId}`, analysis, knownAt });
        if (!['LEARNED', 'ALREADY_LEARNED', 'NOT_ELIGIBLE'].includes(learning?.status)) throw new Error('LEARNING_RESULT_INVALID');
      } catch (error) { error.feedbackPhase = 'LEARNING'; throw error; }
    }
    await this.store.upsertLiveLossRugCase({ ...identity, status: 'FINAL',
      learning: this._copyEvidence(learning, knownAt), updatedAt: this.now() });
    this.stats.completedCases += 1;
    if (learning.status === 'LEARNED') this.stats.learnedCases += 1;
    this.stats.lastCompletedAt = this.now();
    this._releaseTracking(item.positionId);
  }

  _releaseTracking(id) {
    const mint = this.tracked.get(id)?.mint;
    this.tracked.delete(id);
    this._maybeReleaseEvidence(mint);
  }

  _maybeReleaseEvidence(mint) {
    if (!mint || [...this.tracked.values()].some(row => row.mint === mint)
      || [...this.pending.values()].some(row => row.patch.mint === mint)) return;
    try { this._resolveTracker()?.releaseLossEvidence?.(mint); } catch (_) { this._evidenceError('RELEASE_EVIDENCE_FAILED'); }
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    clearInterval(this.timer); this.timer = null;
    if (this.immediate) clearImmediate(this.immediate);
    this.immediate = null;
    if (this.processing) await this.processing;
    // One bounded attempt per queued item, not an unbounded busy-lock loop.
    const batches = Math.ceil(this.pending.size / this.batchSize);
    for (let index = 0; index < batches && this.pending.size; index++) await this.flush({ force: true });
    // A bounded confirmation wait is already durable and recoverable. It is
    // not an unsaved write failure, and must not force an early learning result.
    for (const [id, item] of this.pending) if (item.durableDeferred) this.pending.delete(id);
    if (this.pending.size) {
      const error = new Error('Live loss feedback has unsaved cases');
      error.code = 'LIVE_LOSS_FEEDBACK_PENDING'; error.pending = this.pending.size;
      throw error;
    }
  }

  health() {
    const tracker = this._trackerState();
    const ready = this.enabled && tracker.captureReady && tracker.analyzerReady && tracker.learningReady
      && this.stats.consecutiveEvidenceErrors === 0;
    return { enabled: this.enabled, version: VERSION, mode: 'LOCAL_EVIDENCE_SETTLEMENT_VERIFIED',
      ready, status: !this.enabled ? 'DISABLED' : ready ? 'READY' : 'DEGRADED', ...tracker,
      lossThresholdPct: this.lossThresholdPct, ...this.stats, pending: this.pending.size,
      trackedPositions: this.tracked.size, capacity: this.maxPending, batchSize: this.batchSize,
      recoveryAfterId: this.recoveryAfterId, nextRecoveryAt: this.nextRecoveryAt || null,
      processing: Boolean(this.processing), stopping: this.stopping };
  }
}

module.exports = { LiveLossRugFeedback, VERSION };
