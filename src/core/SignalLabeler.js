'use strict';

const { costBreakdown, normalizeCostModel } = require('./CostModel');

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
      completedSignals: 0,
      censoredSignals: 0,
      labelUpdates: 0,
      crossMarketSamplesSkipped: 0,
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
        const endMs = Math.min(
          Date.now(),
          row.timestamp_ms + this._maxHorizonMs() + this._maxObservationLagMs(),
        );
        for (const sample of this.store.labelSamples(row.mint, row.timestamp_ms, endMs)) {
          if (sample.market && state.market && sample.market !== state.market) {
            state.crossMarketSeen = true;
            this.metrics.crossMarketSamplesSkipped += 1;
            continue;
          }
          const value = returnPct(sample.price, state.p0);
          if (!Number.isFinite(value)) continue;
          state.samples.push({ elapsedMs: sample.timestamp_ms - state.timestampMs, value });
          state.lastObservedAt = Math.max(state.lastObservedAt, sample.timestamp_ms);
        }
        const patch = {};
        this._backfillReturns(state, patch);
        if (Object.keys(patch).length > 0) this.store.updateSignalReturn(state.signalId, patch);
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
      market: signal.market || 'PUMP_BONDING_CURVE',
      crossMarketSeen: false,
      costModel,
      configuredCostPct: costBreakdown(costModel).deterministicCostPct,
      samples: [{ elapsedMs: 0, value: 0 }],
      returns: new Map(),
      observationLags: new Map(),
      excursionsDone: new Set(),
      lastObservedAt: signal.timestampMs,
    };

    for (const seconds of this.config.horizonsSeconds) {
      const existing = signal.existing?.[`return_${seconds}s`];
      if (Number.isFinite(existing)) state.returns.set(seconds, existing);
    }
    try {
      const lags = JSON.parse(signal.existing?.horizon_observation_lags_json || '{}');
      for (const [seconds, lag] of Object.entries(lags)) {
        if (Number.isFinite(lag)) state.observationLags.set(Number(seconds), lag);
      }
    } catch (_) {}
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
      if (trade.market && state.market && trade.market !== state.market) {
        state.crossMarketSeen = true;
        this.metrics.crossMarketSamplesSkipped += 1;
        continue;
      }
      const elapsedMs = trade.timestampMs - state.timestampMs;
      const value = returnPct(trade.price, state.p0);
      if (!Number.isFinite(value)) continue;
      state.samples.push({ elapsedMs, value });
      state.lastObservedAt = trade.timestampMs;

      const patch = { last_observed_at: trade.timestampMs };
      let labelsChanged = false;
      for (const seconds of this.config.horizonsSeconds) {
        if (state.returns.has(seconds) || elapsedMs < seconds * 1_000) continue;
        const observationLagMs = elapsedMs - seconds * 1_000;
        if (observationLagMs > this._maxObservationLagMs()) continue;
        state.returns.set(seconds, value);
        state.observationLags.set(seconds, observationLagMs);
        patch[`return_${seconds}s`] = value;
        patch[`net_return_${seconds}s`] = value - state.configuredCostPct;
        labelsChanged = true;
      }
      if (labelsChanged) patch.horizon_observation_lags_json = this._observationLagsJson(state);

      for (const seconds of this.config.excursionSeconds) {
        if (state.excursionsDone.has(seconds) || elapsedMs < seconds * 1_000) continue;
        if (elapsedMs - seconds * 1_000 > this._maxObservationLagMs()) continue;
        this._setExcursion(state, seconds, patch);
      }

      if (elapsedMs >= this._maxHorizonMs()) {
        Object.assign(patch, this._finalizationPatch(state, trade.timestampMs));
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
        if (now - state.timestampMs < this._maxHorizonMs() + this._maxObservationLagMs()) {
          continue;
        }
        const patch = {
          last_observed_at: state.lastObservedAt,
        };
        this._backfillReturns(state, patch);
        for (const seconds of this.config.excursionSeconds) {
          if (!state.excursionsDone.has(seconds) && this._hasHorizonCoverage(state, seconds)) {
            this._setExcursion(state, seconds, patch);
          }
        }
        Object.assign(patch, this._finalizationPatch(state, now));
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

  _backfillReturns(state, patch) {
    for (const seconds of this.config.horizonsSeconds) {
      if (state.returns.has(seconds)) continue;
      const targetMs = seconds * 1_000;
      const sample = state.samples
        .filter((item) => item.elapsedMs >= targetMs)
        .reduce((earliest, item) => (
          earliest == null || item.elapsedMs < earliest.elapsedMs ? item : earliest
        ), null);
      if (!sample || sample.elapsedMs - targetMs > this._maxObservationLagMs()) continue;
      state.returns.set(seconds, sample.value);
      state.observationLags.set(seconds, sample.elapsedMs - targetMs);
      patch[`return_${seconds}s`] = sample.value;
      patch[`net_return_${seconds}s`] = sample.value - state.configuredCostPct;
    }
    if (Object.keys(patch).some((key) => key.startsWith('return_'))) {
      patch.horizon_observation_lags_json = this._observationLagsJson(state);
    }
  }

  _hasHorizonCoverage(state, seconds) {
    const targetMs = seconds * 1_000;
    return state.samples.some((sample) => (
      sample.elapsedMs >= targetMs
      && sample.elapsedMs - targetMs <= this._maxObservationLagMs()
    ));
  }

  _finalizationPatch(state, finalizedAt) {
    const missing = this.config.horizonsSeconds.filter((seconds) => !state.returns.has(seconds));
    const censored = missing.length > 0;
    if (censored) this.metrics.censoredSignals += 1;
    else this.metrics.completedSignals += 1;
    return {
      finalized_at: finalizedAt,
      label_status: censored ? 'RIGHT_CENSORED' : 'COMPLETE',
      censor_reason: censored
        ? (state.crossMarketSeen
          ? 'MARKET_TRANSITION_BEFORE_HORIZON'
          : 'NO_TRADE_WITHIN_MAX_OBSERVATION_LAG')
        : null,
      missing_horizons_json: JSON.stringify(missing),
      horizon_observation_lags_json: this._observationLagsJson(state),
    };
  }

  _maxHorizonMs() {
    return Math.max(0, ...this.config.horizonsSeconds) * 1_000;
  }

  _maxObservationLagMs() {
    return Math.max(0, Number(this.config.maxObservationLagMs ?? 2_000));
  }

  _observationLagsJson(state) {
    return JSON.stringify(Object.fromEntries(
      [...state.observationLags.entries()].sort((left, right) => left[0] - right[0]),
    ));
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
