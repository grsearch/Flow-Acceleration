'use strict';

const { recoveryDiagnostics } = require('./AccountRecoveryDiagnostics');

const ERROR_STAGES = new Set(['CANDIDATE', 'CREATION_RECEIPT', 'ACCOUNT_SNAPSHOT',
  'ACCOUNT_HISTORY', 'BLOCKHASH', 'FEE_QUOTE', 'SIGNING', 'BROADCAST', 'RECONCILE']);
const errorStage = error => ERROR_STAGES.has(error?.recoveryStage) ? error.recoveryStage : null;

// Slow, bounded post-settlement maintenance. Never part of a BUY/SELL promise.
// Signed close payloads are durable before broadcast; ambiguous sends retain a
// per-Mint entry lock until a finalized receipt or proven expiry resolves them.
class LiveAccountRecovery {
  constructor({ config = {}, store, executor, mode = 'DISABLED', now = Date.now,
    isMintBusy = () => false, canRun = () => true } = {}) {
    this.config = config;
    this.store = store;
    this.executor = executor;
    this.mode = mode;
    this.enabled = config.enabled === true && mode === 'LIVE';
    this.now = now;
    this.isMintBusy = isMintBusy;
    this.canRun = canRun;
    this.intervalMs = Math.max(30_000, Number(config.intervalMs) || 60_000);
    this.batchSize = Math.max(1, Math.min(5, Number(config.batchSize) || 3));
    this.backfillBatchSize = Math.max(1, Math.min(10, Number(config.backfillBatchSize) || 3));
    this.minAgeMs = Math.max(30_000, Number(config.minAgeMs) || 60_000);
    this.maxRetryDelayMs = Math.max(this.intervalMs, 10 * 60_000);
    this.locks = new Map();
    this.timer = null;
    this.running = null;
    this.stopping = false;
    this.ready = false;
    this.startFailed = false;
    this.afterOrderId = 0;
    this.stats = { runs: 0, receiptsBackfilled: 0, prepared: 0, broadcasts: 0,
      confirmed: 0, absent: 0, deferred: 0, errors: 0, lastError: null,
      lastErrorAt: null, lastErrorStage: null, lastRunErrors: 0, lastRunAt: null, lastConfirmedAt: null };
  }

  _error(error) {
    this.stats.errors += 1;
    this.stats.lastError = String(error?.code || error?.message || error).slice(0, 300);
    this.stats.lastErrorStage = errorStage(error);
    this.stats.lastErrorAt = this.now();
  }

  start() {
    if (this.mode !== 'LIVE' || this.timer) return;
    this.stopping = false;
    const required = ['liveAccountRecoveryCandidates', 'updateLiveAccountRecovery',
      'liveAccountRecoveryMintBlocked', 'liveAccountRecoveryPendingLocks',
      'liveAccountFundingBackfillOrders', 'recordLiveAccountFunding'];
    if (!required.every(key => typeof this.store?.[key] === 'function')) {
      if (this.enabled || typeof this.store?.liveAccountRecoveryPendingLocks === 'function') {
        this.startFailed = true;
        this._error(new Error('ACCOUNT_RECOVERY_STORE_UNAVAILABLE'));
      }
      return;
    }
    try {
      // Must complete before new live entries; no deferred/background lock hydration.
      this._syncLocks();
      this.ready = true;
    } catch (error) {
      this.startFailed = true;
      this._error(error);
    }
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  blocksMint(mint) {
    // An unreadable durable outbox must never permit a conflicting new BUY.
    return this.startFailed || [...this.locks.values()].includes(mint);
  }

  _syncLocks() {
    try {
      const rows = this.store.liveAccountRecoveryPendingLocks();
      if (!Array.isArray(rows)) throw new Error('ACCOUNT_RECOVERY_LOCK_LIST_INVALID');
      const restored = new Map();
      for (const row of rows) {
      if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0
        || restored.has(Number(row.id))
        || !['PREPARED', 'UNKNOWN'].includes(row.status)
        || !['mint', 'account_address', 'signature'].every(key => typeof row[key] === 'string' && row[key])) {
        this.startFailed = true;
        throw new Error('ACCOUNT_RECOVERY_PENDING_LOCK_INVALID');
      }
        restored.set(Number(row.id), row.mint);
      }
      this.locks = restored;
      this.startFailed = false;
    } catch (error) {
      this.startFailed = true;
      throw error;
    }
  }

  async _rpc(task) {
    let timer;
    const controller = new AbortController();
    try {
      return await Promise.race([Promise.resolve().then(() => task(controller.signal)), new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('ACCOUNT_RECOVERY_RPC_TIMEOUT'));
        }, 30_000);
        timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  }

  health() {
    return { enabled: this.enabled, ready: this.ready,
      status: this.startFailed ? 'LOCK_STATE_UNAVAILABLE'
        : !this.enabled ? (this.locks.size ? 'DISABLED_RECONCILING' : 'DISABLED')
          : !this.ready ? 'UNAVAILABLE' : this.stats.lastRunErrors > 0 ? 'DEGRADED'
            : this.locks.size ? 'RECONCILING' : 'READY',
      intervalMs: this.intervalMs, batchSize: this.batchSize,
      backfillBatchSize: this.backfillBatchSize, maxRetryDelayMs: this.maxRetryDelayMs,
      pendingMintLocks: new Set(this.locks.values()).size,
      ...this.stats };
  }

  async tick() {
    if (this.stopping || this.mode !== 'LIVE' || (!this.ready && !this.timer) || this.running) return this.running;
    const previousErrors = this.stats.errors;
    this.running = this._run().catch(error => this._error(error)).finally(() => {
      this.stats.lastRunErrors = this.stats.errors - previousErrors;
    });
    try { await this.running; } finally { this.running = null; }
  }

  async _run() {
    this.stats.runs += 1;
    this.stats.lastRunAt = this.now();
    this._syncLocks();
    this.ready = true;
    // Reconciliation takes priority, even with automatic sending disabled.
    const rows = this.store.liveAccountRecoveryCandidates({ now: this.now(), limit: this.batchSize });
    for (const row of rows) {
      if (this.stopping) break;
      try { await this._process(row); } catch (error) { this._error(error); }
    }
    if (this.enabled && !this.stopping && this.canRun()) await this._backfill();
    // Resolve a committed terminal update whose subsequent readback failed.
    this._syncLocks();
  }

  async _backfill() {
    if (typeof this.executor?.transactionSettlement !== 'function') return;
    const rows = this.store.liveAccountFundingBackfillOrders({
      afterId: this.afterOrderId, limit: this.backfillBatchSize });
    if (!rows.length) {
      this.afterOrderId = rows.hasMore && Number(rows.lastScannedId) > this.afterOrderId
        ? Number(rows.lastScannedId) : 0;
      return;
    }
    for (const row of rows) {
      if (this.stopping || !this.canRun()) break;
      this.afterOrderId = Math.max(this.afterOrderId, Number(row.id) || 0);
      try {
        const receipt = await this._rpc(() => this.executor.transactionSettlement(row.signature));
        if (!receipt?.accountFunding?.verified) continue;
        this.store.recordLiveAccountFunding(row.id, receipt);
        this.stats.receiptsBackfilled += 1;
      } catch (error) { this._error(error); }
    }
    if (!this.stopping && this.canRun() && Number(rows.lastScannedId) > this.afterOrderId) {
      this.afterOrderId = Number(rows.lastScannedId);
    }
  }

  _save(row, patch) {
    // Store guarantees synchronous durable commit and readback. Failure is
    // fatal to this attempt; never broadcast from an in-memory-only payload.
    const saved = this.store.updateLiveAccountRecovery(row.id, { ...patch, updatedAt: this.now() });
    if (!saved || Number(saved.id) !== Number(row.id) || saved.status !== patch.status) {
      throw new Error('ACCOUNT_RECOVERY_STATE_NOT_DURABLE');
    }
    return saved;
  }

  _defer(row, reason, stage = null, { failure = false, diagnostics } = {}) {
    this.stats.deferred += 1;
    const previous = Number.isSafeInteger(row.consecutive_failures) && row.consecutive_failures >= 0
      ? row.consecutive_failures : 0;
    const failures = failure ? Math.min(1000, row.error === reason ? previous + 1 : 1) : 0;
    // Do not let repeated unsigned RPC failures monopolize the next batch.
    // Signed reconciliation stays on the normal cadence and never re-signs.
    const delay = row.status === 'PENDING' && failure
      ? Math.min(this.maxRetryDelayMs, this.intervalMs * 2 ** Math.min(10, failures - 1))
      : this.intervalMs;
    return this._save(row, { status: row.status || 'PENDING', error: reason, errorStage: stage,
      consecutiveFailures: failures, nextAttemptAt: this.now() + delay,
      ...(diagnostics !== undefined ? { diagnostics: recoveryDiagnostics(diagnostics) } : {}) });
  }

  async _process(row) {
    const id = Number(row.id);
    if (['PREPARED', 'UNKNOWN'].includes(row.status)) {
      this.locks.set(id, row.mint);
      try {
        row = this._save(row, { status: row.status, lastCheckedAt: this.now() });
        return await this._reconcile(row);
      } catch (error) {
        // An RPC exception used to leave next_attempt_at perpetually overdue.
        // Keep the original signed payload/lock, but release the queue slot
        // until the next check. Store guards reject resurrecting terminal rows.
        this._defer(row, 'ACCOUNT_CLOSE_RECONCILE_RETRY', 'RECONCILE', { failure: true });
        throw error;
      }
    }
    if (row.status !== 'PENDING' || !this.enabled || !this.canRun()) return;
    if (this.now() - Number(row.created_at) < this.minAgeMs) {
      return this._save(row, { status: 'PENDING', error: 'ACCOUNT_RECOVERY_MIN_AGE', errorStage: null,
        nextAttemptAt: Number(row.created_at) + this.minAgeMs });
    }
    if ([...this.locks].some(([otherId, mint]) => otherId !== id && mint === row.mint)
      || this.isMintBusy(row.mint) || this.store.liveAccountRecoveryMintBlocked(row.mint)) {
      return this._defer(row, 'ACTIVE_POSITION_OR_UNRESOLVED_ORDER');
    }
    if (typeof this.executor?.prepareEmptyTokenAccountClose !== 'function') {
      return this._defer(row, 'ACCOUNT_CLOSE_EXECUTOR_UNAVAILABLE');
    }
    // No await between the busy check and entry lock. The live manager checks
    // this lock synchronously before it creates an OPENING position.
    this.locks.set(id, row.mint);
    let durable = false;
    try {
      row = this._save(row, { status: 'PENDING', lastCheckedAt: this.now(),
        checks: (Number.isSafeInteger(row.checks) && row.checks >= 0 ? row.checks : 0) + 1 });
      const prepared = await this._rpc(signal => this.executor.prepareEmptyTokenAccountClose({
        address: row.account_address, mint: row.mint, owner: row.owner,
        programId: row.token_program, sourceSignature: row.creation_signature,
        fundedLamports: row.funded_lamports, creationVerified: true,
      }, { signal }));
      if (prepared?.status === 'ABSENT') {
        // Absence is NOT an attributed refund. No invented PnL or signature.
        this._save(row, { status: 'ABSENT', error: 'ACCOUNT_ALREADY_ABSENT_REFUND_UNATTRIBUTED', errorStage: null,
          consecutiveFailures: 0, nextAttemptAt: null, diagnostics: recoveryDiagnostics(prepared.recoveryDiagnostics) });
        this.stats.absent += 1;
        return;
      }
      if (prepared?.status !== 'READY' || !prepared.signature || !prepared.rawTransactionBase64
        || prepared.account !== row.account_address || prepared.mint !== row.mint
        || prepared.owner !== row.owner || prepared.programId !== row.token_program
        || prepared.sourceSignature !== row.creation_signature) {
        throw new Error('ACCOUNT_CLOSE_PREPARATION_INVALID');
      }
      const refund = BigInt(prepared.expectedRefundLamports ?? '-1');
      const fee = BigInt(prepared.estimatedFeeLamports ?? '-1');
      if (refund !== BigInt(row.funded_lamports) || fee <= 0n || fee > 105_000n || fee >= refund) {
        throw new Error('ACCOUNT_CLOSE_PREPARATION_AMOUNTS_INVALID');
      }
      // Recheck after the RPC await (manual trades/process transitions may intervene).
      if (this.stopping || !this.enabled || !this.canRun()
        || this.isMintBusy(row.mint) || this.store.liveAccountRecoveryMintBlocked(row.mint)) {
        return this._defer(row, 'STATE_CHANGED_BEFORE_CLOSE');
      }
      // From this point a commit may succeed even if its readback throws.
      // Never demote it to PENDING; the next durable lock scan resolves it.
      durable = true;
      const saved = this._save(row, { status: 'PREPARED', preparedJson: JSON.stringify(prepared),
        signature: prepared.signature, attempts: (Number(row.attempts) || 0) + 1,
        nextAttemptAt: this.now() + this.intervalMs, error: null, errorStage: null,
        consecutiveFailures: 0, diagnostics: recoveryDiagnostics(prepared.recoveryDiagnostics) });
      // Refuse to use a mismatched/old outbox record even if the store accepted it.
      if (saved.signature !== prepared.signature || saved.prepared_json !== JSON.stringify(prepared)) {
        throw new Error('ACCOUNT_CLOSE_PREPARED_READBACK_MISMATCH');
      }
      this.stats.prepared += 1;
      // A timeout can hide a successful broadcast. Keep PREPARED and its exact
      // signature durable; do not create a second close transaction or new fee.
      try {
        await this._rpc(() => this.executor.sendPreparedTokenAccountClose(prepared));
        this.stats.broadcasts += 1;
      } catch (error) {
        error.recoveryStage = 'BROADCAST';
        this._error(error);
        this._save(saved, { status: 'UNKNOWN', error: String(error?.code || error?.message || error),
          errorStage: 'BROADCAST', nextAttemptAt: this.now() + this.intervalMs });
        return;
      }
      await this._reconcile(saved);
    } catch (error) {
      if (!durable) {
        const permanent = ['ACCOUNT_HISTORY_TRUNCATED', 'ACCOUNT_LIFECYCLE_CHANGED',
          'ACCOUNT_FUNDING_CHANGED', 'UNSAFE_TOKEN_ACCOUNT_EXTENSION', 'UNSAFE_TOKEN_ACCOUNT_STATE',
          'UNSAFE_TOKEN_ACCOUNT', 'NON_CANONICAL_TOKEN_ACCOUNT', 'TOKEN_ACCOUNT_AUTHORITY_MISMATCH',
          'TOKEN_ACCOUNT_DELEGATED', 'CLEANUP_FEE_TOO_HIGH'].includes(error?.code);
        if (permanent) this._save(row, { status: 'BLOCKED', error: error.code, errorStage: errorStage(error),
          nextAttemptAt: null, walletSolDelta: 0, networkFeeSol: 0, refundLamports: '0',
          diagnostics: recoveryDiagnostics(error?.recoveryDiagnostics) });
        else this._defer(row, String(error?.code || error?.message || error), errorStage(error),
          { failure: true, diagnostics: error?.recoveryDiagnostics ?? null });
      }
      throw error;
    } finally {
      if (!durable) this.locks.delete(id);
    }
  }

  async _reconcile(row) {
    const id = Number(row.id);
    const prepared = typeof row.prepared_json === 'string'
      ? JSON.parse(row.prepared_json) : row.prepared_json;
    if (!prepared || prepared.signature !== row.signature || !prepared.rawTransactionBase64
      || prepared.account !== row.account_address || prepared.mint !== row.mint
      || prepared.owner !== row.owner || prepared.programId !== row.token_program
      || prepared.sourceSignature !== row.creation_signature) {
      throw new Error('ACCOUNT_CLOSE_OUTBOX_INVALID');
    }
    if (typeof this.executor?.reconcileTokenAccountClose !== 'function') {
      throw new Error('ACCOUNT_CLOSE_RECONCILER_UNAVAILABLE');
    }
    const result = await this._rpc(signal => this.executor.reconcileTokenAccountClose(prepared, { signal }));
    if (result?.status === 'CONFIRMED') {
      const refund = BigInt(result.refundLamports ?? '-1');
      const cash = result.walletSolDelta;
      const fee = result.networkFeeSol;
      if (refund <= 0n || !Number.isFinite(cash) || !Number.isFinite(fee) || fee < 0
        || Math.abs(cash - (Number(refund) / 1e9 - fee)) > 0.000000001) {
        throw new Error('ACCOUNT_CLOSE_SETTLEMENT_INCONSISTENT');
      }
      this._save(row, { status: 'CONFIRMED', refundLamports: refund.toString(),
        walletSolDelta: cash, networkFeeSol: fee, error: null, errorStage: null, nextAttemptAt: null,
        consecutiveFailures: 0 });
      this.locks.delete(id);
      this.stats.confirmed += 1;
      this.stats.lastConfirmedAt = this.now();
      return;
    }
    if (result?.status === 'EXPIRED') {
      // Proven finalized no-receipt + expired blockhash. Deliberately no new
      // signature; an operator can inspect/reset this exact blocked candidate.
      this._save(row, { status: 'BLOCKED', error: 'CLOSE_EXPIRED_WITHOUT_RECEIPT',
        errorStage: 'RECONCILE', walletSolDelta: 0, networkFeeSol: 0, refundLamports: '0', nextAttemptAt: null });
      this.locks.delete(id);
      return;
    }
    if (result?.status === 'FAILED') {
      if (!Number.isFinite(result.networkFeeSol) || !Number.isFinite(result.walletSolDelta)
        || result.networkFeeSol < 0 || result.walletSolDelta > 0
        || Math.abs(result.walletSolDelta + result.networkFeeSol) > 1e-9) {
        throw new Error('ACCOUNT_CLOSE_FAILED_FEE_UNVERIFIED');
      }
      this._save(row, { status: 'BLOCKED', error: 'CLOSE_TRANSACTION_FAILED',
        errorStage: 'RECONCILE',
        walletSolDelta: result.walletSolDelta, networkFeeSol: result.networkFeeSol,
        refundLamports: '0', nextAttemptAt: null });
      this.locks.delete(id);
      return;
    }
    this._save(row, { status: 'UNKNOWN', error: result?.status || 'CLOSE_STATUS_UNAVAILABLE',
      errorStage: 'RECONCILE', nextAttemptAt: this.now() + this.intervalMs });
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
    this.ready = false;
  }
}

module.exports = LiveAccountRecovery;
