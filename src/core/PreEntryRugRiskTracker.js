'use strict';

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tradePrice(trade) {
  // Reserve price is the least distorted public mark for comparing adjacent
  // trades; fall back to the execution/derived prices when it is unavailable.
  for (const value of [trade?.reservePrice, trade?.price, trade?.priceSolPerToken, trade?.curvePrice]) {
    const number = finite(value);
    if (number > 0) return number;
  }
  return null;
}

function beijingHour(timestampMs) {
  return new Date(timestampMs + (8 * 60 * 60 * 1_000)).getUTCHours();
}

function hourInWindow(hour, startHour, endHour) {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

class PreEntryRugRiskTracker {
  constructor({ config, now = () => Date.now() }) {
    this.config = config;
    this.now = now;
    this.states = new Map();
    this.guardStrategies = new Map();
    this.recentGuardDecisions = [];
    this.lastSweepAt = 0;
    this.metrics = {
      observedTrades: 0,
      evaluations: 0,
      sampleReady: 0,
      flagged: 0,
      flaggedLegacy: 0,
      flaggedVerticalFragile: 0,
      flaggedSparseBreadth: 0,
      flaggedChaseRepeatedSize: 0,
      flaggedBeijingRiskWindow: 0,
      guardEvaluations: 0,
      guardPassed: 0,
      guardRejected: 0,
      guardSampleInsufficient: 0,
      liveCacheHits: 0,
      liveCacheMisses: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {}

  stop() {
    this.states.clear();
    this.guardStrategies.clear();
    this.recentGuardDecisions = [];
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint || !['BUY', 'SELL'].includes(trade.side)) return;
    const timestampMs = finite(trade.timestampMs);
    const price = tradePrice(trade);
    if (!(timestampMs > 0) || !(price > 0)) return;
    let state = this.states.get(trade.mint);
    if (!state) {
      state = {
        events: [], offset: 0, lastAt: timestampMs, version: 0,
        cachedVersion: -1, cachedRisk: null,
      };
      this.states.set(trade.mint, state);
    }
    state.events.push({
      timestampMs,
      side: trade.side,
      price,
      wallet: String(trade.wallet || ''),
      solAmount: finite(trade.solAmount, 0),
    });
    state.version += 1;
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
    if (state.cachedRisk && state.cachedVersion === state.version
      && Math.abs(timestampMs - state.cachedRisk.observedAt) <= this.config.cacheMaxAgeMs) {
      this.metrics.evaluations += 1;
      if (state.cachedRisk.sampleReady) this.metrics.sampleReady += 1;
      if (state.cachedRisk.flagged) {
        this.metrics.flagged += 1;
        this._recordSignatureMetrics(state.cachedRisk);
      }
      return state.cachedRisk;
    }
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
    let maxBuyImpactPct = 0;
    const buyerTradeCounts = new Map();
    const buySizeCounts = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.side === 'BUY') {
        buys += 1;
        consecutiveBuys += 1;
        maxConsecutiveBuys = Math.max(maxConsecutiveBuys, consecutiveBuys);
        if (row.wallet) {
          buyerTradeCounts.set(row.wallet, (buyerTradeCounts.get(row.wallet) || 0) + 1);
        }
        if (row.solAmount > 0) {
          const sizeKey = row.solAmount.toFixed(3);
          buySizeCounts.set(sizeKey, (buySizeCounts.get(sizeKey) || 0) + 1);
        }
      } else consecutiveBuys = 0;
      if (index === 0) continue;
      const previous = rows[index - 1];
      if (row.side !== previous.side) alternations += 1;
      if (row.price !== previous.price) {
        priceComparisons += 1;
        if (row.price > previous.price) upticks += 1;
      }
      if (row.side === 'BUY' && previous.price > 0 && row.price > previous.price) {
        maxBuyImpactPct = Math.max(maxBuyImpactPct, (row.price / previous.price - 1) * 100);
      }
    }
    const buySharePct = buys / rows.length * 100;
    const sideAlternationPct = rows.length > 1 ? alternations / (rows.length - 1) * 100 : 0;
    const upTickSharePct = priceComparisons > 0 ? upticks / priceComparisons * 100 : 0;
    const returnPct = rows[0].price > 0 ? ((rows[rows.length - 1].price / rows[0].price) - 1) * 100 : 0;
    const uniqueBuyers = buyerTradeCounts.size;
    const maxWalletBuyTrades = buyerTradeCounts.size
      ? Math.max(...buyerTradeCounts.values()) : 0;
    const repeatedBuySizeTrades = buySizeCounts.size
      ? Math.max(...buySizeCounts.values()) : 0;
    const buysPerBuyer = uniqueBuyers > 0 ? buys / uniqueBuyers : null;
    const maxWalletBuyTxSharePct = buys > 0 ? maxWalletBuyTrades / buys * 100 : null;
    const repeatedBuySizeSharePct = buys > 0 ? repeatedBuySizeTrades / buys * 100 : null;
    const checks = {
      buyShare: buySharePct >= this.config.minBuySharePct,
      consecutiveBuys: maxConsecutiveBuys >= this.config.minConsecutiveBuys,
      lowAlternation: sideAlternationPct <= this.config.maxSideAlternationPct,
      upticks: upTickSharePct >= this.config.minUpTickSharePct,
      priceRunup: returnPct >= this.config.minReturnPct,
    };
    const score = Object.values(checks).filter(Boolean).length;
    const sampleReady = rows.length >= this.config.minTrades;
    const hour = beijingHour(timestampMs);
    const beijingRiskWindow = this.config.beijingRiskWindowEnabled && hourInWindow(
      hour,
      this.config.beijingRiskStartHour,
      this.config.beijingRiskEndHour,
    );
    const legacyMinFlags = beijingRiskWindow
      ? Math.min(this.config.minFlags, this.config.beijingRiskMinFlags)
      : this.config.minFlags;
    const signatures = {
      legacyStairStep: score >= legacyMinFlags,
      verticalFragileReuse: returnPct >= this.config.verticalFragileMinReturnPct
        && maxBuyImpactPct >= this.config.verticalFragileMinBuyImpactPct
        && maxWalletBuyTxSharePct != null
        && maxWalletBuyTxSharePct >= this.config.verticalFragileMinWalletTxSharePct,
      sparseBuyerBreadth: buysPerBuyer != null
        && buysPerBuyer >= this.config.sparseBreadthMinBuysPerBuyer,
      chaseRepeatedSize: returnPct >= this.config.chaseRepeatedMinReturnPct
        && repeatedBuySizeSharePct != null
        && repeatedBuySizeSharePct >= this.config.chaseRepeatedMinSizeSharePct,
    };
    const flaggedReasons = Object.entries(signatures)
      .filter(([, matched]) => matched)
      .map(([name]) => name);
    const flagged = sampleReady && flaggedReasons.length > 0;
    this.metrics.evaluations += 1;
    if (sampleReady) this.metrics.sampleReady += 1;
    if (flagged) {
      this.metrics.flagged += 1;
    }
    const risk = {
      observedAt: timestampMs,
      windowMs: this.config.windowMs,
      sampleSize: rows.length,
      sampleReady,
      flagged,
      score,
      maxScore: Object.keys(checks).length,
      legacyMinFlags,
      beijingHour: hour,
      beijingRiskWindow,
      buySharePct,
      maxConsecutiveBuys,
      sideAlternationPct,
      upTickSharePct,
      returnPct,
      uniqueBuyers,
      buysPerBuyer,
      maxWalletBuyTxSharePct,
      repeatedBuySizeSharePct,
      maxBuyImpactPct,
      checks,
      signatures,
      flaggedReasons,
    };
    if (flagged) this._recordSignatureMetrics(risk);
    state.cachedRisk = risk;
    state.cachedVersion = state.version;
    return risk;
  }

  evaluateGuard({ strategyId, mint, timestampMs = this.now(), source = 'SHADOW' }) {
    const normalizedStrategyId = String(strategyId || 'UNKNOWN');
    const normalizedSource = String(source || 'SHADOW').toUpperCase();
    let risk;
    if (normalizedSource === 'LIVE') {
      const state = this.states.get(mint);
      const cached = state?.cachedRisk;
      if (cached && state.cachedVersion === state.version
        && Math.abs(timestampMs - cached.observedAt) <= this.config.cacheMaxAgeMs) {
        risk = cached;
        this.metrics.liveCacheHits += 1;
      } else {
        // Refresh only from the bounded in-memory ring (<= maxEventsPerMint).
        // This keeps enforcement current without RPC, SQLite or network I/O.
        risk = this.snapshot(mint, timestampMs);
        this.metrics.liveCacheMisses += 1;
      }
    } else risk = this.snapshot(mint, timestampMs);
    const blocked = Boolean(this.config.enabled && risk.sampleReady && risk.flagged);
    const stats = this.guardStrategies.get(normalizedStrategyId) || {
      strategyId: normalizedStrategyId,
      source: normalizedSource,
      evaluated: 0,
      sampleReady: 0,
      sampleInsufficient: 0,
      passed: 0,
      rejected: 0,
      lastEvaluatedAt: null,
      lastRejectedAt: null,
    };
    stats.evaluated += 1;
    stats.lastEvaluatedAt = timestampMs;
    if (risk.sampleReady) stats.sampleReady += 1;
    else stats.sampleInsufficient += 1;
    if (blocked) {
      stats.rejected += 1;
      stats.lastRejectedAt = timestampMs;
    } else stats.passed += 1;
    this.guardStrategies.set(normalizedStrategyId, stats);

    this.metrics.guardEvaluations += 1;
    if (risk.sampleReady) this.metrics.guardPassed += blocked ? 0 : 1;
    else this.metrics.guardSampleInsufficient += 1;
    if (blocked) this.metrics.guardRejected += 1;

    const decision = {
      strategyId: normalizedStrategyId,
      source: normalizedSource,
      mint,
      observedAt: timestampMs,
      blocked,
      reason: blocked ? 'PRE_ENTRY_RUG_RISK' : (
        risk.sampleReady ? 'RUG_GUARD_PASS' : 'RUG_GUARD_SAMPLE_INSUFFICIENT'
      ),
      ...risk,
    };
    if (blocked) {
      this.recentGuardDecisions.unshift(decision);
      if (this.recentGuardDecisions.length > 100) this.recentGuardDecisions.length = 100;
    }
    return decision;
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
      mode: 'UNIVERSAL_PRE_ENTRY_RUG_GUARD',
      scope: 'ALL_LIVE_AND_SHADOW_ENTRIES',
      enforcement: 'FLAGGED_BLOCK_SAMPLE_INSUFFICIENT_ALLOW',
      livePath: 'MEMORY_ONLY_BOUNDED_CACHE_REFRESH',
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
        verticalFragileMinReturnPct: this.config.verticalFragileMinReturnPct,
        verticalFragileMinBuyImpactPct: this.config.verticalFragileMinBuyImpactPct,
        verticalFragileMinWalletTxSharePct: this.config.verticalFragileMinWalletTxSharePct,
        sparseBreadthMinBuysPerBuyer: this.config.sparseBreadthMinBuysPerBuyer,
        chaseRepeatedMinReturnPct: this.config.chaseRepeatedMinReturnPct,
        chaseRepeatedMinSizeSharePct: this.config.chaseRepeatedMinSizeSharePct,
        beijingRiskWindowEnabled: this.config.beijingRiskWindowEnabled,
        beijingRiskStartHour: this.config.beijingRiskStartHour,
        beijingRiskEndHour: this.config.beijingRiskEndHour,
        beijingRiskMinFlags: this.config.beijingRiskMinFlags,
      },
      strategyStats: [...this.guardStrategies.values()]
        .sort((left, right) => right.evaluated - left.evaluated),
      recentFlagged: this.recentGuardDecisions.slice(0, 50),
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
      legacyMinFlags: this.config.minFlags,
      beijingHour: beijingHour(observedAt),
      beijingRiskWindow: false,
      buySharePct: null,
      maxConsecutiveBuys: 0,
      sideAlternationPct: null,
      upTickSharePct: null,
      returnPct: null,
      uniqueBuyers: 0,
      buysPerBuyer: null,
      maxWalletBuyTxSharePct: null,
      repeatedBuySizeSharePct: null,
      maxBuyImpactPct: null,
      checks: {},
      signatures: {},
      flaggedReasons: [],
    };
  }

  _prune(state, now) {
    const cutoff = now - this.config.stateRetentionMs;
    while (state.offset < state.events.length
      && state.events[state.offset].timestampMs < cutoff) state.offset += 1;
    if (state.offset > 128 && state.offset * 2 >= state.events.length) this._compact(state);
  }

  _recordSignatureMetrics(risk) {
    if (risk.signatures?.legacyStairStep) this.metrics.flaggedLegacy += 1;
    if (risk.signatures?.verticalFragileReuse) this.metrics.flaggedVerticalFragile += 1;
    if (risk.signatures?.sparseBuyerBreadth) this.metrics.flaggedSparseBreadth += 1;
    if (risk.signatures?.chaseRepeatedSize) this.metrics.flaggedChaseRepeatedSize += 1;
    if (risk.beijingRiskWindow && risk.score >= this.config.beijingRiskMinFlags
      && risk.score < this.config.minFlags) this.metrics.flaggedBeijingRiskWindow += 1;
  }

  _compact(state) {
    if (state.offset <= 0) return;
    state.events = state.events.slice(state.offset);
    state.offset = 0;
  }
}

module.exports = { PreEntryRugRiskTracker, tradePrice };
