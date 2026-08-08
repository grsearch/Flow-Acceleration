'use strict';

const { costBreakdown, expectedNetReturnPct, normalizeCostModel } = require('./CostModel');

function returnPct(price, entryPrice) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  return ((price / entryPrice) - 1) * 100;
}

function legacyCostModel(configuredCostPct = 0) {
  return normalizeCostModel({
    platformFeePct: configuredCostPct,
    buySlippagePct: 0,
    sellSlippagePct: 0,
    priceImpactPct: 0,
    baseTxFeeSol: 0,
    priorityFeeSol: 0,
    jitoTipSol: 0,
    fixedCostSol: 0,
    positionSizeSol: 0.2,
    failureRatePct: 0,
    failureLossPct: 1,
  });
}

function parseCostModel(value) {
  if (!value) return null;
  try {
    return normalizeCostModel(typeof value === 'string' ? JSON.parse(value) : value);
  } catch (_) {
    return null;
  }
}

class SignalLabeler {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.pendingByMint = new Map();
    this.metrics = {
      pendingSignals: 0,
      finalizedSignals: 0,
      labelUpdates: 0,
    };
  }

  restore(rows) {
    for (const row of rows || []) {
      const state = this.addSignal({
        signalId: row.signal_id,
        mint: row.mint,
        timestampMs: row.timestamp_ms,
        price: row.p0,
        configuredCostPct: row.configured_cost_pct,
        costModel: parseCostModel(row.cost_model_json),
        existing: row,
      });
      if (typeof this.store.labelSamples === 'function') {
        const endMs = Math.min(Date.now(), row.timestamp_ms + 60_000);
        for (const sample of this.store.labelSamples(row.mint, row.timestamp_ms, endMs)) {
          const value = returnPct(sample.price, state.p0);
          if (!Number.isFinite(value)) continue;
          state.samples.push({ elapsedMs: sample.timestamp_ms - state.timestampMs, value });
          state.lastObservedAt = Math.max(state.lastObservedAt, sample.timestamp_ms);
        }
      }
    }
  }

  addSignal(signal) {
    const costModel = parseCostModel(signal.costModel)
      || parseCostModel(signal.existing?.cost_model_json)
      || (signal.configuredCostPct != null
        ? legacyCostModel(signal.configuredCostPct)
        : parseCostModel(this.config.costModel)
          || legacyCostModel(this.config.configuredTradingCostPct));
    const state = {
      signalId: signal.signalId,
      mint: signal.mint,
      timestampMs: signal.timestampMs,
      p0: signal.price,
      costModel,
      configuredCostPct: costBreakdown(costModel).deterministicCostPct,
      samples: [{ elapsedMs: 0, value: 0 }],
      returns: new Map(),
      excursionsDone: new Set(),
      lastObservedAt: signal.timestampMs,
    };

    for (const seconds of this.config.horizonsSeconds) {
      const existing = signal.existing?.[`return_${seconds}s`];
      if (Number.isFinite(existing)) state.returns.set(seconds, existing);
    }
    for (const seconds of this.config.excursionSeconds) {
      if (Number.isFinite(signal.existing?.[`mfe_${seconds}s`])) state.excursionsDone.add(seconds);
    }

    let states = this.pendingByMint.get(signal.mint);
    if (!states) {
      states = new Map();
      this.pendingByMint.set(signal.mint, states);
    }
    states.set(signal.signalId, state);
    this._refreshPendingCount();
    return state;
  }

  onTrade(trade) {
    const states = this.pendingByMint.get(trade.mint);
    if (!states || !Number.isFinite(trade.price) || trade.price <= 0) return;

    for (const state of [...states.values()]) {
      if (trade.timestampMs < state.timestampMs) continue;
      const elapsedMs = trade.timestampMs - state.timestampMs;
      const value = returnPct(trade.price, state.p0);
      if (!Number.isFinite(value)) continue;
      state.samples.push({ elapsedMs, value });
      state.lastObservedAt = trade.timestampMs;

      const patch = { last_observed_at: trade.timestampMs };
      for (const seconds of this.config.horizonsSeconds) {
        if (state.returns.has(seconds) || elapsedMs < seconds * 1_000) continue;
        state.returns.set(seconds, value);
        patch[`return_${seconds}s`] = value;
        patch[`net_return_${seconds}s`] = expectedNetReturnPct(value, state.costModel);
      }

      for (const seconds of this.config.excursionSeconds) {
        if (state.excursionsDone.has(seconds) || elapsedMs < seconds * 1_000) continue;
        this._setExcursion(state, seconds, patch);
      }

      if (elapsedMs >= 60_000) {
        patch.finalized_at = trade.timestampMs;
        this._finalizeState(state, states);
      }
      this.store.updateSignalReturn(state.signalId, patch);
      this.metrics.labelUpdates += 1;
    }

    if (states.size === 0) this.pendingByMint.delete(trade.mint);
    this._refreshPendingCount();
  }

  advanceTime(now = Date.now()) {
    for (const [mint, states] of this.pendingByMint) {
      for (const state of [...states.values()]) {
        if (now - state.timestampMs < 65_000) continue;
        const patch = {
          last_observed_at: state.lastObservedAt,
          finalized_at: now,
        };
        for (const seconds of this.config.excursionSeconds) {
          if (!state.excursionsDone.has(seconds)) this._setExcursion(state, seconds, patch);
        }
        this.store.updateSignalReturn(state.signalId, patch);
        this._finalizeState(state, states);
      }
      if (states.size === 0) this.pendingByMint.delete(mint);
    }
    this._refreshPendingCount();
  }

  pendingMints() {
    return [...this.pendingByMint.keys()];
  }

  stats() {
    return { ...this.metrics, pendingMints: this.pendingByMint.size };
  }

  _setExcursion(state, seconds, patch) {
    const values = state.samples
      .filter((sample) => sample.elapsedMs <= seconds * 1_000)
      .map((sample) => sample.value);
    if (values.length === 0) values.push(0);
    patch[`mfe_${seconds}s`] = Math.max(...values);
    patch[`mae_${seconds}s`] = Math.min(...values);
    state.excursionsDone.add(seconds);
  }

  _finalizeState(state, states) {
    states.delete(state.signalId);
    this.metrics.finalizedSignals += 1;
  }

  _refreshPendingCount() {
    let count = 0;
    for (const states of this.pendingByMint.values()) count += states.size;
    this.metrics.pendingSignals = count;
  }
}

module.exports = SignalLabeler;
