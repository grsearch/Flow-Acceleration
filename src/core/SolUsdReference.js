'use strict';

// One public, wallet-independent request per minute. This is a cached FDV
// conversion reference, never an executable token quote or a per-entry RPC.
// https://docs.cdp.coinbase.com/coinbase-business/track-apis/prices
const ENDPOINT = 'https://api.coinbase.com/v2/prices/SOL-USD/spot';
const boundedMs = (value, fallback, min, max) => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;

class SolUsdReference {
  constructor({ config = {}, now = () => Date.now(), fetchImpl = globalThis.fetch,
    timers = globalThis } = {}) {
    this.config = config;
    this.now = now;
    this.fetch = fetchImpl;
    this.timers = timers;
    this.refreshIntervalMs = boundedMs(config.refreshMs, 60_000, 60_000, 86_400_000);
    this.requestTimeoutMs = boundedMs(config.requestTimeoutMs, 3_000, 1_000, 30_000);
    this.maxAgeMs = boundedMs(config.maxAgeMs, 300_000, 1_000, 300_000);
    this.value = null;
    this.timer = null;
    this.pending = null;
    this.controller = null;
    this.activeAttempt = null;
    this.stopped = true;
    this.lastAttemptAt = null;
    this.lastCompletedAt = null;
    this.lastSuccessAt = null;
    this.nextRefreshAt = null;
    this.lastError = null;
    this.lastErrorCode = null;
    this.lastHttpStatus = null;
    this.metrics = { attempts: 0, successes: 0, failures: 0, timeouts: 0,
      cancellations: 0, consecutiveFailures: 0 };
  }

  start() {
    if (!this.stopped || this.config.enabled === false) return;
    this.stopped = false;
    this.nextRefreshAt = this.now() + this.refreshIntervalMs;
    this.timer = this.timers.setInterval(() => {
      if (this.stopped) return;
      this.nextRefreshAt = this.now() + this.refreshIntervalMs;
      void this.refresh();
    }, this.refreshIntervalMs);
    this.timer.unref?.();
    void this.refresh();
  }

  refresh() {
    if (this.stopped || this.pending) return this.pending || Promise.resolve();
    const attempt = { startedAt: this.now(), controller: new AbortController(), settled: false };
    // Publish ownership before invoking any request code. A synchronous throw
    // must not let an async finally clear pending before it is assigned.
    const pending = new Promise(resolve => { attempt.resolve = resolve; });
    this.activeAttempt = attempt;
    this.pending = pending;
    this.controller = attempt.controller;
    this.lastAttemptAt = attempt.startedAt;
    this.metrics.attempts += 1;
    attempt.timeout = this.timers.setTimeout(() => {
      // Abort alone is not a deadline: a transport or response body may never
      // settle. Release this attempt ourselves, then cancel best-effort.
      this._complete(attempt, { errorCode: 'SOL_USD_REQUEST_TIMEOUT' });
    }, this.requestTimeoutMs);
    attempt.timeout.unref?.();
    void this._request(attempt).then(result => this._complete(attempt, result),
      () => this._complete(attempt, { errorCode: 'SOL_USD_REQUEST_FAILED' }));
    return pending;
  }

  async _request(attempt) {
    if (typeof this.fetch !== 'function') return { errorCode: 'SOL_USD_FETCH_UNAVAILABLE' };
    const response = await this.fetch(ENDPOINT, { signal: attempt.controller.signal,
      redirect: 'error', headers: { Accept: 'application/json' } });
    if (attempt.settled || this.activeAttempt !== attempt || this.stopped) {
      try { void response?.body?.cancel()?.catch(() => {}); } catch (_) {}
      return { cancelled: true };
    }
    const httpStatus = Number.isInteger(response?.status) && response.status >= 100
      && response.status <= 599 ? response.status : null;
    if (!response?.ok) {
      try { void response?.body?.cancel()?.catch(() => {}); } catch (_) {}
      return { errorCode: 'SOL_USD_HTTP_ERROR', httpStatus };
    }
    let payload;
    try { payload = await response.json(); }
    catch (_) { return { errorCode: 'SOL_USD_RESPONSE_INVALID', httpStatus }; }
    const rawAmount = payload?.data?.amount;
    const amount = Number(rawAmount);
    if (payload?.data?.base !== 'SOL' || payload?.data?.currency !== 'USD'
      || !['string', 'number'].includes(typeof rawAmount)
      || !(amount > 0) || !Number.isFinite(amount)) {
      return { errorCode: 'SOL_USD_RESPONSE_INVALID', httpStatus };
    }
    return { priceUsd: amount, httpStatus };
  }

  _complete(attempt, result) {
    // Only the owning attempt may touch shared state. Late success, rejection
    // or body completion after timeout/stop cannot clear a newer request.
    if (attempt.settled || this.activeAttempt !== attempt) return;
    const completedAt = this.now();
    if (!result.cancelled && completedAt - attempt.startedAt >= this.requestTimeoutMs) {
      result = { errorCode: 'SOL_USD_REQUEST_TIMEOUT' };
    }
    attempt.settled = true;
    this.timers.clearTimeout(attempt.timeout);
    this.activeAttempt = null;
    this.pending = null;
    this.controller = null;
    this.lastCompletedAt = completedAt;
    if (result.cancelled) {
      this.metrics.cancellations += 1;
    } else if (result.errorCode) {
      // Preserve still-fresh cache, but never extend it on an error. Only fixed
      // codes/statuses are exposed; provider messages may contain credentials.
      this.lastError = 'SOL_USD_REFERENCE_REFRESH_FAILED';
      this.lastErrorCode = result.errorCode;
      this.lastHttpStatus = result.httpStatus ?? null;
      this.metrics.failures += 1;
      this.metrics.consecutiveFailures += 1;
      if (result.errorCode === 'SOL_USD_REQUEST_TIMEOUT') this.metrics.timeouts += 1;
    } else {
      this.value = { priceUsd: result.priceUsd, observedAt: completedAt,
        expiresAt: completedAt + this.maxAgeMs,
        source: 'COINBASE_SOL_USD_SPOT', referenceKind: 'FDV_CONVERSION_ONLY' };
      this.lastSuccessAt = completedAt;
      this.lastError = null;
      this.lastErrorCode = null;
      this.lastHttpStatus = result.httpStatus ?? null;
      this.metrics.successes += 1;
      this.metrics.consecutiveFailures = 0;
    }
    if (result.cancelled || result.errorCode) {
      try { attempt.controller.abort(); } catch (_) {}
    }
    attempt.resolve();
  }

  snapshot(at = this.now()) {
    return this.value && this.value.observedAt <= at && at < this.value.expiresAt
      ? { ...this.value } : null;
  }

  health() {
    const now = this.now();
    const reference = this.snapshot(now);
    const status = this.config.enabled === false ? 'DISABLED' : this.stopped ? 'STOPPED'
      : reference ? 'READY' : this.value && now >= this.value.expiresAt ? 'STALE' : 'UNAVAILABLE';
    return { ready: Boolean(reference), reference, status,
      refreshing: Boolean(this.activeAttempt), lastAttemptAt: this.lastAttemptAt,
      lastCompletedAt: this.lastCompletedAt, lastSuccessAt: this.lastSuccessAt,
      pendingSince: this.activeAttempt?.startedAt ?? null,
      pendingAgeMs: this.activeAttempt ? Math.max(0, now - this.activeAttempt.startedAt) : null,
      nextRefreshAt: this.nextRefreshAt, refreshIntervalMs: this.refreshIntervalMs,
      requestTimeoutMs: this.requestTimeoutMs, ...this.metrics,
      lastError: this.lastError, lastErrorCode: this.lastErrorCode, lastHttpStatus: this.lastHttpStatus };
  }

  async stop() {
    this.stopped = true;
    this.timers.clearInterval(this.timer);
    this.timer = null;
    this.nextRefreshAt = null;
    if (this.activeAttempt) this._complete(this.activeAttempt, { cancelled: true });
  }
}

module.exports = { SolUsdReference, ENDPOINT };
