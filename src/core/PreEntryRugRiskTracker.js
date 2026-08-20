'use strict';

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tradePrice(trade) {
  for (const value of [trade?.price, trade?.priceSolPerToken, trade?.curvePrice]) {
    const number = finite(value);
    if (number > 0) return number;
  }
  return null;
}

class PreEntryRugRiskTracker {
  constructor({ config, now = () => Date.now() }) {
    this.config = config;
    this.now = now;
    this.states = new Map();
    this.lastSweepAt = 0;
    this.metrics = {
      observedTrades: 0,
      evaluations: 0,
      sampleReady: 0,
      flagged: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {}

  stop() {
    this.states.clear();
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint || !['BUY', 'SELL'].includes(trade.side)) return;
    const timestampMs = finite(trade.timestampMs);
    const price = tradePrice(trade);
    if (!(timestampMs > 0) || !(price > 0)) return;
    let state = this.states.get(trade.mint);
    if (!state) {
      state = { events: [], offset: 0, lastAt: timestampMs };
      this.states.set(trade.mint, state);
    }
    state.events.push({ timestampMs, side: trade.side, price });
    state.lastAt = Math.max(state.lastAt, timestampMs);
    this._prune(state, timestampMs);
    if (state.events.length - state.offset > this.config.maxEventsPerMint) {
      state.offset = state.events.length - this.config.maxEventsPerMint;
      this._compact(state);
    }
    this.metrics.observedTrades += 1;
    this.metrics.lastActionAt = this.now();
  }

  snapshot(mint, timestampMs = this.now()) {
    const state = this.states.get(mint);
    if (!state) return this._empty(timestampMs);
    this._prune(state, timestampMs);
    const cutoff = timestampMs - this.config.windowMs;
    const rows = state.events.slice(state.offset).filter((row) => (
      row.timestampMs >= cutoff && row.timestampMs <= timestampMs
    ));
    if (!rows.length) return this._empty(timestampMs);
    let buys = 0;
    let alternations = 0;
    let upticks = 0;
    let priceComparisons = 0;
    let consecutiveBuys = 0;
    let maxConsecutiveBuys = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.side === 'BUY') {
        buys += 1;
        consecutiveBuys += 1;
        maxConsecutiveBuys = Math.max(maxConsecutiveBuys, consecutiveBuys);
      } else consecutiveBuys = 0;
      if (index === 0) continue;
      const previous = rows[index - 1];
      if (row.side !== previous.side) alternations += 1;
      if (row.price !== previous.price) {
        priceComparisons += 1;
        if (row.price > previous.price) upticks += 1;
      }
    }
    const buySharePct = buys / rows.length * 100;
    const sideAlternationPct = rows.length > 1 ? alternations / (rows.length - 1) * 100 : 0;
    const upTickSharePct = priceComparisons > 0 ? upticks / priceComparisons * 100 : 0;
    const returnPct = rows[0].price > 0 ? ((rows[rows.length - 1].price / rows[0].price) - 1) * 100 : 0;
    const checks = {
      buyShare: buySharePct >= this.config.minBuySharePct,
      consecutiveBuys: maxConsecutiveBuys >= this.config.minConsecutiveBuys,
      lowAlternation: sideAlternationPct <= this.config.maxSideAlternationPct,
      upticks: upTickSharePct >= this.config.minUpTickSharePct,
      priceRunup: returnPct >= this.config.minReturnPct,
    };
    const score = Object.values(checks).filter(Boolean).length;
    const sampleReady = rows.length >= this.config.minTrades;
    const flagged = sampleReady && score >= this.config.minFlags;
    this.metrics.evaluations += 1;
    if (sampleReady) this.metrics.sampleReady += 1;
    if (flagged) this.metrics.flagged += 1;
    return {
      observedAt: timestampMs,
      windowMs: this.config.windowMs,
      sampleSize: rows.length,
      sampleReady,
      flagged,
      score,
      maxScore: Object.keys(checks).length,
      buySharePct,
      maxConsecutiveBuys,
      sideAlternationPct,
      upTickSharePct,
      returnPct,
      checks,
    };
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled || now - this.lastSweepAt < this.config.sweepIntervalMs) return;
    this.lastSweepAt = now;
    const cutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      if (state.lastAt < cutoff) this.states.delete(mint);
      else this._prune(state, now);
    }
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'PRE_ENTRY_RUG_RISK_OBSERVER',
      sendsTransactions: false,
      trackedMints: this.states.size,
      thresholds: {
        windowMs: this.config.windowMs,
        minTrades: this.config.minTrades,
        minBuySharePct: this.config.minBuySharePct,
        minConsecutiveBuys: this.config.minConsecutiveBuys,
        maxSideAlternationPct: this.config.maxSideAlternationPct,
        minUpTickSharePct: this.config.minUpTickSharePct,
        minReturnPct: this.config.minReturnPct,
        minFlags: this.config.minFlags,
      },
      ...this.metrics,
    };
  }

  _empty(observedAt) {
    return {
      observedAt,
      windowMs: this.config.windowMs,
      sampleSize: 0,
      sampleReady: false,
      flagged: false,
      score: 0,
      maxScore: 5,
      buySharePct: null,
      maxConsecutiveBuys: 0,
      sideAlternationPct: null,
      upTickSharePct: null,
      returnPct: null,
      checks: {},
    };
  }

  _prune(state, now) {
    const cutoff = now - this.config.stateRetentionMs;
    while (state.offset < state.events.length
      && state.events[state.offset].timestampMs < cutoff) state.offset += 1;
    if (state.offset > 128 && state.offset * 2 >= state.events.length) this._compact(state);
  }

  _compact(state) {
    if (state.offset <= 0) return;
    state.events = state.events.slice(state.offset);
    state.offset = 0;
  }
}

module.exports = { PreEntryRugRiskTracker, tradePrice };
