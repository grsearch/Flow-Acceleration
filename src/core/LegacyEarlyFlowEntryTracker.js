'use strict';

const strictAmm = require('./StrictAmmShadowExecution');

const EXECUTION_VERSION = 'LEGACY_EARLY_FLOW_EXEC_V1';
const ENTRY_MODE = 'LEGACY_EARLY_FLOW';
const BASE_COHORT_ID = 'LEGACY-EARLY-FLOW-BASE';
const RUGX_COHORT_ID = 'LEGACY-EARLY-FLOW-RUGX';
const STUDY_VERSION = 'LEGACY_EARLY_FLOW_5ARM_V1';
const STUDY_ARMS = Object.freeze({
  'LEGACY-EARLY-FLOW-BREADTH6': Object.freeze({
    rejectionReason: 'STUDY_FILTER_REJECTED_BREADTH6',
    thresholdPatch: Object.freeze({ minBuyers5s: 6 }),
    singleVariable: Object.freeze({ feature: 'buyers5s', operator: 'GTE', value: 6,
      description: '5秒独立买家≥6' }),
  }),
  'LEGACY-EARLY-FLOW-CONCENTRATION55': Object.freeze({
    rejectionReason: 'STUDY_FILTER_REJECTED_CONCENTRATION55',
    thresholdPatch: Object.freeze({ maxSingleBuyShare5s: 0.55 }),
    singleVariable: Object.freeze({ feature: 'maxSingleBuyShare5s', operator: 'LTE', value: 0.55,
      description: '最大单笔买入占比≤55%' }),
  }),
  'LEGACY-EARLY-FLOW-EXCLUDE-FLAT': Object.freeze({
    rejectionReason: 'STUDY_FILTER_REJECTED_EXCLUDE_FLAT',
    thresholdPatch: Object.freeze({ excludedPriceChange10sMin: 0,
      excludedPriceChange10sMax: 4 }),
    singleVariable: Object.freeze({ feature: 'priceChange10sPct',
      operator: 'EXCLUDE_INCLUSIVE_RANGE', min: 0, max: 4,
      description: '排除10秒涨幅0%–4%' }),
  }),
});
const STUDY_COHORT_IDS = Object.freeze(Object.keys(STUDY_ARMS));
const FIVE_ARM_COHORT_IDS = Object.freeze([
  BASE_COHORT_ID, RUGX_COHORT_ID, ...STUDY_COHORT_IDS,
]);
const DEFAULT_THRESHOLDS = Object.freeze({
  minAgeMs: 15_000, maxAgeMs: 25_000, minFdvUsd: 15_000, maxFdvUsd: 100_000,
  minPriceChange10sPct: -10, maxPriceChange10sPct: 8,
  minNetFlow1sSol: 0, minBuyers5s: 3, minTrades5s: 4, maxSingleBuyShare5s: 0.7,
});
const numeric = value => value == null || value === '' ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = value => Number.isSafeInteger(numeric(value)) && numeric(value) > 0
  ? numeric(value) : null;

function postPoolPrice(trade) {
  if (trade?.market !== 'PUMP_AMM' || trade.ammQuoteState !== 'POST_TRADE_V1') return null;
  try {
    const base = BigInt(trade.poolBaseReservesRaw);
    const realQuote = BigInt(trade.poolQuoteReservesRaw);
    const effectiveQuote = realQuote + BigInt(trade.virtualQuoteReservesRaw ?? 0);
    if (base <= 0n || realQuote < 0n || effectiveQuote <= 0n) return null;
    const price = (Number(effectiveQuote) / 1e9) / (Number(base) / 1e6);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (_) { return null; }
}

function migrationEvidence(token = {}, explicit = false) {
  const migratedAt = timestamp(token.migrated_at ?? token.migratedAt ?? token.migrationAt);
  if (migratedAt) return { migrationAt: migratedAt, migrationSource: 'CONFIRMED_MIGRATION' };
  // Completion/graduation is a documented fallback, never the first AMM trade
  // or token creation timestamp. timestampMs is accepted only on an explicit
  // graduation callback, never on arbitrary token/trade metadata.
  const graduatedAt = timestamp(token.graduated_at ?? token.graduatedAt
    ?? token.completedAt ?? (explicit ? token.timestampMs : null));
  return graduatedAt ? { migrationAt: graduatedAt, migrationSource: 'EXPLICIT_GRADUATION' } : null;
}

function matchesLegacyEntry(features, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const keys = ['ageMs', 'fdvUsd', 'priceChange10sPct', 'netFlow1sSol',
    'buyers5s', 'trades5s', 'maxSingleBuyShare5s'];
  const excludedMin = numeric(t.excludedPriceChange10sMin);
  const excludedMax = numeric(t.excludedPriceChange10sMax);
  const excludedPriceChange = excludedMin != null && excludedMax != null
    && excludedMin <= excludedMax
    && features?.priceChange10sPct >= excludedMin
    && features?.priceChange10sPct <= excludedMax;
  return keys.every(key => Number.isFinite(features?.[key]))
    && features.ageMs >= t.minAgeMs && features.ageMs <= t.maxAgeMs
    && features.fdvUsd >= t.minFdvUsd && features.fdvUsd <= t.maxFdvUsd
    && features.priceChange10sPct >= t.minPriceChange10sPct
    && features.priceChange10sPct <= t.maxPriceChange10sPct
    && features.netFlow1sSol > t.minNetFlow1sSol
    && features.buyers5s >= t.minBuyers5s && features.trades5s >= t.minTrades5s
    && features.maxSingleBuyShare5s <= t.maxSingleBuyShare5s
    && !excludedPriceChange;
}

class LegacyEarlyFlowEntryTracker {
  constructor({ config = {}, store, now = () => Date.now(), getSolUsdReference = () => null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.getSolUsdReference = getSolUsdReference;
    this.states = new Map();
    this.unknown = new Map();
    this.maxMints = Math.max(1, Math.min(2_000, numeric(config.maxTrackedMints) || 512));
    this.maxEvents = Math.max(20, Math.min(8_000, numeric(config.maxEventsPerMint) || 2_000));
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds || {}) };
    this.policy = { version: strictAmm.VERSION, maxTradeAgeMs: 3_000 };
    this.metrics = { evaluated: 0, signals: 0, migrationsObserved: 0,
      tokenLookups: 0, rejectedByReason: {}, fdvRejectedByReason: {}, lastSignalAt: null };
  }

  reject(reason) {
    this.metrics.rejectedByReason[reason] = (this.metrics.rejectedByReason[reason] || 0) + 1;
    return null;
  }

  rejectFdv(reason) {
    this.metrics.fdvRejectedByReason[reason] = (this.metrics.fdvRejectedByReason[reason] || 0) + 1;
    // Keep the existing aggregate for API consumers; these are evaluations,
    // not distinct mints or signals that already passed all entry conditions.
    return this.reject('FDV_REFERENCE_UNAVAILABLE');
  }

  observeGraduation(token, explicit = true) {
    if (!token?.mint) return null;
    const evidence = migrationEvidence(token, explicit);
    if (!evidence || evidence.migrationAt > this.now()
      || this.now() > evidence.migrationAt + this.thresholds.maxAgeMs + 3_000) return null;
    const previous = this.states.get(token.mint);
    const pool = token.migration_pool ?? token.migrationPool ?? token.pool ?? null;
    if (previous) {
      previous.supplyRaw ||= token.token_total_supply_raw ?? token.tokenTotalSupplyRaw ?? null;
      if (!previous.signaled && evidence.migrationSource === 'CONFIRMED_MIGRATION'
        && previous.migrationSource !== 'CONFIRMED_MIGRATION') {
        Object.assign(previous, evidence);
      }
      if (!previous.pool && pool) previous.pool = pool;
      return previous;
    }
    this.advanceTime(this.now());
    if (this.states.size >= this.maxMints) return this.reject('TRACKING_CAPACITY');
    const state = { mint: token.mint, symbol: token.symbol || null, ...evidence,
      supplyRaw: token.token_total_supply_raw ?? token.tokenTotalSupplyRaw ?? null,
      pool, policy: { ...this.policy }, events: [], overflowUntil: 0, signaled: false };
    this.states.set(token.mint, state);
    this.unknown.delete(token.mint);
    this.metrics.migrationsObserved += 1;
    return state;
  }

  observeTrade(trade) {
    if (trade?.market !== 'PUMP_AMM' || !trade.mint) return null;
    this.metrics.evaluated += 1;
    const now = this.now();
    let state = this.states.get(trade.mint);
    if (!state) {
      if (now < (this.unknown.get(trade.mint) || 0)) return null;
      this.metrics.tokenLookups += 1;
      const token = this.store?.getToken?.(trade.mint);
      state = this.observeGraduation(token, false);
      if (!state) {
        if (this.unknown.size >= this.maxMints) this.unknown.delete(this.unknown.keys().next().value);
        this.unknown.set(trade.mint, now + 5_000);
        return this.reject('MIGRATION_EVIDENCE_MISSING_OR_EXPIRED');
      }
    }
    if (state.signaled) return null;
    const mark = postPoolPrice(trade);
    if (!(mark > 0)) return this.reject('POST_POOL_PRICE_UNAVAILABLE');
    const reason = strictAmm.rejection(trade, state, now);
    if (reason) return this.reject(reason);
    const solAmount = numeric(trade.solAmount);
    if (!['BUY', 'SELL'].includes(trade.side) || !(solAmount > 0)
      || typeof trade.wallet !== 'string' || !trade.wallet) return this.reject('TRADE_FLOW_FIELDS_MISSING');
    strictAmm.accept(trade, state, now);
    const at = trade.chainTimestampMs;
    if (at < state.migrationAt || at > state.migrationAt + this.thresholds.maxAgeMs) {
      return this.reject('MIGRATION_AGE_OUTSIDE_TRACKING');
    }
    // Keep a bounded 10-second causal window, including SELLs; unknown fields
    // are never replaced by zero to manufacture pure inflow.
    state.events = state.events.filter(event => event.at >= at - 13_000);
    if (state.events.length >= this.maxEvents) {
      state.events.shift();
      state.overflowUntil = at + 10_000;
    }
    state.events.push({ at, price: mark, side: trade.side, solAmount, wallet: trade.wallet });
    if (at < state.overflowUntil) return this.reject('WINDOW_CAPACITY_TRUNCATED');
    if (at - state.migrationAt < this.thresholds.minAgeMs) return null;
    const beforeWindow = state.events.filter(event => event.at <= at - 10_000).at(-1);
    // Preserve the old strategy's causal partial-window fallback. Record the
    // coverage explicitly: a five-second history must not be called ten seconds.
    // The bounded retention also prevents an arbitrarily old reference price.
    const first = beforeWindow || state.events[0];
    if (!state.supplyRaw && now >= (state.nextMetadataLookupAt || 0)) {
      this.metrics.tokenLookups += 1;
      const token = this.store?.getToken?.(trade.mint);
      this.observeGraduation(token, false);
      state.nextMetadataLookupAt = now + 5_000;
    }
    let supply;
    try { supply = Number(BigInt(state.supplyRaw)) / 1e6; } catch (_) { supply = null; }
    let reference;
    try { reference = this.getSolUsdReference(); } catch (_) { reference = null; }
    const solPriceUsd = numeric(reference?.priceUsd);
    if (!(supply > 0) || !Number.isFinite(supply)) return this.rejectFdv('TOKEN_SUPPLY_UNAVAILABLE');
    if (!(solPriceUsd > 0) || !timestamp(reference?.observedAt) || !timestamp(reference?.expiresAt)) {
      return this.rejectFdv('SOL_USD_REFERENCE_UNAVAILABLE');
    }
    if (reference.observedAt > trade.receivedAtMs || reference.observedAt > now) {
      return this.rejectFdv('SOL_USD_REFERENCE_NOT_YET_KNOWN');
    }
    if (reference.expiresAt <= now || reference.expiresAt <= trade.receivedAtMs
      || now - reference.observedAt > 300_000) return this.rejectFdv('SOL_USD_REFERENCE_EXPIRED');
    const last5 = state.events.filter(event => event.at >= at - 5_000);
    const buys = last5.filter(event => event.side === 'BUY');
    const buySol = buys.reduce((sum, event) => sum + event.solAmount, 0);
    const features = { executionVersion: EXECUTION_VERSION,
      migrationAt: state.migrationAt, migrationSource: state.migrationSource,
      ageMs: at - state.migrationAt, fdvUsd: mark * supply * solPriceUsd,
      fdvReference: { solPriceUsd, observedAt: reference.observedAt, expiresAt: reference.expiresAt,
        source: String(reference.source || 'LOCAL_SOL_USD_REFERENCE').slice(0, 100),
        tokenSupplyRaw: String(state.supplyRaw), priceSource: 'POST_POOL_RESERVES' },
      priceChange10sPct: (mark / first.price - 1) * 100,
      priceWindowStartAt: first.at, priceWindowSpanMs: at - first.at,
      priceWindowComplete: Boolean(beforeWindow),
      priceWindowSource: beforeWindow ? 'AT_OR_BEFORE_10S' : 'AVAILABLE_HISTORY_FIRST_TRADE',
      netFlow1sSol: state.events.filter(event => event.at >= at - 1_000)
        .reduce((sum, event) => sum + (event.side === 'BUY' ? 1 : -1) * event.solAmount, 0),
      buyers5s: new Set(buys.map(event => event.wallet)).size, trades5s: last5.length,
      maxSingleBuyShare5s: buySol > 0 ? Math.max(...buys.map(event => event.solAmount)) / buySol : 1,
      sourceTradePrice: numeric(trade.price), sourceReservePrice: mark,
    };
    if (!matchesLegacyEntry(features, this.thresholds)) return null;
    return { state, features, trade: { ...trade, reservePrice: mark }, price: mark };
  }

  markSignaled(candidate) {
    candidate.state.signaled = true;
    this.metrics.signals += 1;
    this.metrics.lastSignalAt = candidate.trade.receivedAtMs;
  }

  advanceTime(now = this.now()) {
    for (const [mint, state] of this.states) {
      if (now > state.migrationAt + this.thresholds.maxAgeMs + 3_000) this.states.delete(mint);
    }
    for (const [mint, until] of this.unknown) if (now > until) this.unknown.delete(mint);
  }

  trackedMints() { this.advanceTime(); return [...this.states.keys()]; }
  health() { return { ...this.metrics, rejectedByReason: { ...this.metrics.rejectedByReason },
    fdvRejectedByReason: { ...this.metrics.fdvRejectedByReason },
    trackedMints: this.states.size, maxMints: this.maxMints,
    maxEventsPerMint: this.maxEvents, fdvReferenceMode: 'CACHED_SOL_USD_AND_RECORDED_TOKEN_SUPPLY',
    thresholds: { ...this.thresholds } }; }
}

module.exports = { LegacyEarlyFlowEntryTracker, EXECUTION_VERSION, ENTRY_MODE,
  BASE_COHORT_ID, RUGX_COHORT_ID, STUDY_VERSION, STUDY_ARMS,
  STUDY_COHORT_IDS, FIVE_ARM_COHORT_IDS,
  DEFAULT_THRESHOLDS, matchesLegacyEntry, postPoolPrice, migrationEvidence };
