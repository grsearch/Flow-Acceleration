'use strict';

// One public, wallet-independent request per minute. This is a cached FDV
// conversion reference, never an executable token quote or a per-entry RPC.
// https://docs.cdp.coinbase.com/coinbase-business/track-apis/prices
const ENDPOINT = 'https://api.coinbase.com/v2/prices/SOL-USD/spot';

class SolUsdReference {
  constructor({ config = {}, now = () => Date.now(), fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.now = now;
    this.fetch = fetchImpl;
    this.value = null;
    this.timer = null;
    this.pending = null;
    this.controller = null;
    this.stopped = true;
    this.lastAttemptAt = null;
    this.lastError = null;
  }

  start() {
    if (!this.stopped || this.config.enabled === false) return;
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, Math.max(60_000, this.config.refreshMs || 60_000));
    this.timer.unref?.();
  }

  refresh() {
    if (this.stopped || this.pending) return this.pending || Promise.resolve();
    this.lastAttemptAt = this.now();
    this.controller = new AbortController();
    const controller = this.controller;
    const timeout = setTimeout(() => controller.abort(), 3_000);
    timeout.unref?.();
    this.pending = (async () => {
      try {
        const response = await this.fetch(ENDPOINT, { signal: controller.signal,
          redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('SOL_USD_HTTP_ERROR');
        const payload = await response.json();
        const amount = Number(payload?.data?.amount);
        if (payload?.data?.base !== 'SOL' || payload?.data?.currency !== 'USD'
          || !(amount > 0) || !Number.isFinite(amount)) throw new Error('SOL_USD_RESPONSE_INVALID');
        if (this.stopped) return;
        const observedAt = this.now();
        this.value = { priceUsd: amount, observedAt,
          expiresAt: observedAt + Math.min(300_000, this.config.maxAgeMs || 300_000),
          source: 'COINBASE_SOL_USD_SPOT', referenceKind: 'FDV_CONVERSION_ONLY' };
        this.lastError = null;
      } catch (_) {
        // Keep a still-fresh reference through transient failures, but never
        // fabricate a price or extend the lifetime of the previous observation.
        this.lastError = 'SOL_USD_REFERENCE_REFRESH_FAILED';
      } finally {
        clearTimeout(timeout);
        this.pending = null;
        this.controller = null;
      }
    })();
    return this.pending;
  }

  snapshot(at = this.now()) {
    return this.value && this.value.observedAt <= at && at < this.value.expiresAt
      ? { ...this.value } : null;
  }

  health() {
    return { ready: Boolean(this.snapshot()), reference: this.snapshot(),
      refreshing: Boolean(this.pending), lastAttemptAt: this.lastAttemptAt, lastError: this.lastError };
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.pending;
  }
}

module.exports = { SolUsdReference, ENDPOINT };
