'use strict';

const { costBreakdown } = require('./CostModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');

const STATUS = Object.freeze({
  PENDING_ENTRY: 'PENDING_ENTRY',
  PRICE_JUMP: 'PRICE_JUMP',
  NO_ENTRY: 'NO_ENTRY',
  OPEN: 'OPEN',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED: 'CLOSED',
  NO_EXIT: 'NO_EXIT',
});

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function priceOf(trade) {
  const reserve = finite(trade?.reservePrice);
  return reserve > 0 ? reserve : finite(trade?.price);
}

function rowPosition(row) {
  const value = (snake, camel) => row[snake] ?? row[camel];
  return {
    id: row.id,
    cohortId: value('cohort_id', 'cohortId'),
    entryProfileId: value('entry_profile_id', 'entryProfileId'),
    exitProfileId: value('exit_profile_id', 'exitProfileId'),
    episodeId: value('episode_id', 'episodeId'),
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    signalAt: value('signal_at', 'signalAt'),
    signalPrice: value('signal_price', 'signalPrice'),
    midlinePrice: value('midline_price', 'midlinePrice'),
    lowerBandPrice: value('lower_band_price', 'lowerBandPrice'),
    upperBandPrice: value('upper_band_price', 'upperBandPrice'),
    entryTargetAt: value('entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: value('entry_deadline_at', 'entryDeadlineAt'),
    entryAt: value('entry_at', 'entryAt'),
    entryMarket: value('entry_market', 'entryMarket'),
    entryPrice: value('entry_price', 'entryPrice'),
    highestPrice: value('highest_price', 'highestPrice'),
    lowestPrice: value('lowest_price', 'lowestPrice'),
    lastObservedAt: value('last_observed_at', 'lastObservedAt'),
    lastPrice: value('last_price', 'lastPrice'),
    maxFavorableReturnPct: finite(value('max_favorable_return_pct', 'maxFavorableReturnPct'), 0),
    maxAdverseReturnPct: finite(value('max_adverse_return_pct', 'maxAdverseReturnPct'), 0),
    exitMode: value('exit_mode', 'exitMode'),
    takeProfitPct: value('take_profit_pct', 'takeProfitPct'),
    hardStopPct: value('hard_stop_pct', 'hardStopPct'),
    maxHoldMs: value('max_hold_ms', 'maxHoldMs'),
    exitTriggerAt: value('exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: value('exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: value('exit_deadline_at', 'exitDeadlineAt'),
    exitReason: value('exit_reason', 'exitReason'),
  };
}

class RangeScalperShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.maxEntryPriceDropPct = finite(config.maxEntryPriceDropPct, 50);
    this.maxObservedPriceScaleRatio = finite(config.maxObservedPriceScaleRatio, 100);
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      graduatedSeen: 0,
      rangeEvaluations: 0,
      rangeQualified: 0,
      extendedMints: 0,
      candidates: 0,
      signals: 0,
      replaySignalsSuppressed: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      closed: 0,
      noExit: 0,
      rangeLossExits: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    for (const token of this.store.allTokens()) {
      const graduatedAt = finite(token.graduated_at);
      if (graduatedAt && now - graduatedAt <= this.config.maxTrackingMs) {
        this.onGraduated(token);
        const state = this.states.get(token.mint);
        if (state && now > state.extendedUntil) state.extendedUntil = now;
      }
    }
    for (const row of this.store.activeRangeScalperShadowPositions()) {
      const position = rowPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._indexRow(position);
      const token = this.store.getToken(position.mint);
      this.onGraduated(token || {
        mint: position.mint,
        symbol: position.symbol,
        graduated_at: row.migrated_at,
      });
      const state = this.states.get(position.mint);
      if (state) state.extendedUntil = Math.max(state.extendedUntil, now + this.config.exitTimeoutMs);
    }
    const replaySince = now - this.config.windowMs;
    for (const trade of this.store.recentAmmTrades(replaySince)) {
      if (this.states.has(trade.mint)) this.observeTrade(trade, { replay: true });
    }
    for (const state of this.states.values()) {
      if (!state.rangeActive && !this._hasActiveMint(state.mint)) {
        state.extendedUntil = state.graduatedAt + this.config.initialObservationMs;
      }
    }
    this.advanceTime(now);
  }

  stop() {}

  onGraduated(token) {
    if (!this.config.enabled || !token?.mint) return;
    const graduatedAt = finite(
      token.graduated_at ?? token.graduatedAt ?? token.migratedAt
        ?? token.completedAt ?? token.timestampMs,
    );
    if (!(graduatedAt > 0)) return;
    const existing = this.states.get(token.mint);
    if (existing) {
      existing.symbol ||= token.symbol || null;
      existing.graduatedAt = Math.min(existing.graduatedAt, graduatedAt);
      existing.extendedUntil = Math.max(
        existing.extendedUntil,
        existing.graduatedAt + this.config.initialObservationMs,
      );
      return;
    }
    const profiles = new Map();
    for (const profile of this.entryProfiles.values()) {
      const persistedSwingIndex = this.store.rangeScalperMaxSwingIndex(profile.id, token.mint);
      const warmupSwingIndex = profile.warmupProfileId
        ? this.store.rangeScalperMaxSwingIndex(profile.warmupProfileId, token.mint)
        : 0;
      profiles.set(profile.id, {
        armed: true,
        candidate: null,
        // A warm-only first opportunity deliberately creates no JW position.
        // Restore its count from the matching JB reference profile so a restart
        // cannot turn the true second wave back into another warm-up wave.
        swingIndex: Math.max(persistedSwingIndex, warmupSwingIndex),
      });
    }
    this.states.set(token.mint, {
      mint: token.mint,
      symbol: token.symbol || null,
      graduatedAt,
      extendedUntil: graduatedAt + this.config.initialObservationMs,
      trades: [],
      profiles,
      features: null,
      rangeActive: false,
      rangeInvalidSince: null,
      everExtended: false,
      lastTimestampMs: 0,
    });
    this.metrics.graduatedSeen += 1;
  }

  trackedMints(now = this.now()) {
    const tracked = [];
    for (const [mint, state] of this.states) {
      if (now <= state.extendedUntil || this._hasActiveMint(mint)) {
        tracked.push(mint);
        continue;
      }
      this.states.delete(mint);
    }
    return tracked;
  }

  health() {
    const rangeActive = [...this.states.values()].filter((state) => state.rangeActive).length;
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_J',
      sendsTransactions: false,
      trackedMints: this.trackedMints().length,
      rangeActive,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        market: 'PUMP_AMM',
        initialObservationMs: this.config.initialObservationMs,
        maxTrackingMs: this.config.maxTrackingMs,
        windowMs: this.config.windowMs,
        range: {
          minTrades: this.config.minTrades,
          minVolumeSol: this.config.minVolumeSol,
          minUniqueWallets: this.config.minUniqueWallets,
          minBuySharePct: this.config.minBuySharePct,
          maxBuySharePct: this.config.maxBuySharePct,
          minRangePct: this.config.minRangePct,
          maxEfficiencyRatio: this.config.maxEfficiencyRatio,
          minMeanCrosses: this.config.minMeanCrosses,
          maxTopWalletSharePct: this.config.maxTopWalletSharePct,
          maxTrendPct: this.config.maxTrendPct,
          minRangeScore: this.config.minRangeScore,
        },
        entryDelayMs: this.config.entryDelayMs,
        exitDelayMs: this.config.exitDelayMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        maxEntryPriceDropPct: this.maxEntryPriceDropPct,
        maxObservedPriceScaleRatio: this.maxObservedPriceScaleRatio,
        research: {
          isolatedTable: 'range_scalper_shadow_positions',
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          repeatedEpisodes: true,
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  observeTrade(trade, { replay = false } = {}) {
    const price = priceOf(trade);
    const timestampMs = finite(trade?.timestampMs);
    if (!this.config.enabled || trade?.market !== 'PUMP_AMM' || !trade?.mint
      || !(price > 0) || !(timestampMs > 0)) return;
    let state = this.states.get(trade.mint);
    if (!state) {
      const token = this.store.getToken(trade.mint);
      const graduatedAt = finite(token?.graduated_at);
      if (!(graduatedAt > 0) || timestampMs - graduatedAt > this.config.initialObservationMs) return;
      this.onGraduated(token);
      state = this.states.get(trade.mint);
    }
    if (!state || (timestampMs > state.extendedUntil && !this._hasActiveMint(trade.mint))) return;
    if (state.lastTimestampMs && timestampMs < state.lastTimestampMs) return;
    state.lastTimestampMs = timestampMs;
    state.symbol ||= trade.symbol || null;
    state.trades.push({
      timestampMs,
      price,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      side: trade.side,
      wallet: trade.wallet || null,
    });
    this._prune(state, timestampMs);
    const features = this._features(state);
    state.features = features;
    this._updateRangeState(state, features, timestampMs);
    this._observeRows(state, trade, price, features);
    this._observeEntries(state, trade, price, features, replay);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const state of this.states.values()) {
      this._prune(state, now);
      for (const profileState of state.profiles.values()) {
        if (profileState.candidate && now > profileState.candidate.expiresAt) {
          profileState.candidate = null;
        }
      }
    }
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateRangeScalperShadowPosition(pending.id, { status: STATUS.NO_ENTRY });
      this.pendingEntries.delete(pending.id);
      this._unindexRow(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.OPEN && now >= position.entryAt + position.maxHoldMs) {
        this._triggerExit(position, now, 'MAX_HOLD');
      } else if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        this._markNoExit(position);
      }
    }
    this.trackedMints(now);
  }

  _prune(state, timestampMs) {
    const cutoff = timestampMs - this.config.windowMs;
    while (state.trades.length && state.trades[0].timestampMs < cutoff) state.trades.shift();
  }

  _features(state) {
    const trades = state.trades;
    if (!trades.length) return null;
    const totalVolumeSol = trades.reduce((sum, row) => sum + row.solAmount, 0);
    const weightedPrice = totalVolumeSol > 0
      ? trades.reduce((sum, row) => sum + row.price * row.solAmount, 0) / totalVolumeSol
      : trades.reduce((sum, row) => sum + row.price, 0) / trades.length;
    const varianceWeight = totalVolumeSol > 0 ? totalVolumeSol : trades.length;
    const variance = trades.reduce((sum, row) => {
      const weight = totalVolumeSol > 0 ? row.solAmount : 1;
      return sum + weight * ((row.price - weightedPrice) ** 2);
    }, 0) / Math.max(varianceWeight, Number.EPSILON);
    const standardDeviation = Math.sqrt(Math.max(0, variance));
    const prices = trades.map((row) => row.price);
    const minimum = Math.min(...prices);
    const maximum = Math.max(...prices);
    const rangePct = minimum > 0 ? (maximum / minimum - 1) * 100 : 0;
    let path = 0;
    let crosses = 0;
    for (let index = 1; index < trades.length; index += 1) {
      path += Math.abs(trades[index].price - trades[index - 1].price);
      const previous = trades[index - 1].price - weightedPrice;
      const current = trades[index].price - weightedPrice;
      if ((previous < 0 && current >= 0) || (previous > 0 && current <= 0)) crosses += 1;
    }
    const displacement = Math.abs(trades[trades.length - 1].price - trades[0].price);
    const efficiencyRatio = path > 0 ? displacement / path : 1;
    const buySol = trades.filter((row) => row.side === 'BUY')
      .reduce((sum, row) => sum + row.solAmount, 0);
    const sellSol = trades.filter((row) => row.side === 'SELL')
      .reduce((sum, row) => sum + row.solAmount, 0);
    const buySharePct = totalVolumeSol > 0 ? buySol / totalVolumeSol * 100 : 0;
    const wallets = new Set(trades.map((row) => row.wallet).filter(Boolean));
    const walletSol = new Map();
    for (const row of trades) {
      if (!row.wallet) continue;
      walletSol.set(row.wallet, (walletSol.get(row.wallet) || 0) + row.solAmount);
    }
    const topWalletSol = Math.max(0, ...walletSol.values());
    const topWalletSharePct = totalVolumeSol > 0 ? topWalletSol / totalVolumeSol * 100 : 100;
    const third = Math.max(1, Math.floor(trades.length / 3));
    const firstRows = trades.slice(0, third);
    const lastRows = trades.slice(-third);
    const mean = (rows) => rows.reduce((sum, row) => sum + row.price, 0) / rows.length;
    const firstMean = mean(firstRows);
    const lastMean = mean(lastRows);
    const trendPct = firstMean > 0 ? (lastMean / firstMean - 1) * 100 : 0;
    const now = trades[trades.length - 1].timestampMs;
    const recent = trades.filter((row) => row.timestampMs > now - this.config.recentFlowWindowMs);
    const prior = trades.filter((row) => row.timestampMs > now - 2 * this.config.recentFlowWindowMs
      && row.timestampMs <= now - this.config.recentFlowWindowMs);
    const sideSol = (rows, side) => rows.filter((row) => row.side === side)
      .reduce((sum, row) => sum + row.solAmount, 0);
    const recentBuySol = sideSol(recent, 'BUY');
    const recentSellSol = sideSol(recent, 'SELL');
    const priorSellSol = sideSol(prior, 'SELL');
    const recentBuyers = new Set(recent.filter((row) => row.side === 'BUY')
      .map((row) => row.wallet).filter(Boolean)).size;
    const sellDecayRatio = priorSellSol > 0 ? recentSellSol / priorSellSol
      : recentSellSol > 0 ? Number.POSITIVE_INFINITY : 0;
    const liquidityScore = (
      clamp(trades.length / this.config.minTrades)
      + clamp(totalVolumeSol / this.config.minVolumeSol)
      + clamp(wallets.size / this.config.minUniqueWallets)
    ) / 3;
    const balanceHalfWidth = Math.max(1, (this.config.maxBuySharePct - this.config.minBuySharePct) / 2);
    const balanceScore = clamp(1 - Math.abs(buySharePct - 50) / balanceHalfWidth);
    const oscillationScore = clamp(1 - efficiencyRatio / Math.max(this.config.maxEfficiencyRatio, 0.0001));
    const amplitudeScore = clamp(rangePct / this.config.minRangePct);
    const crossScore = clamp(crosses / this.config.minMeanCrosses);
    const concentrationScore = clamp(1 - topWalletSharePct / this.config.maxTopWalletSharePct);
    const trendScore = clamp(1 - Math.abs(trendPct) / this.config.maxTrendPct);
    const rangeScore = (liquidityScore + balanceScore + oscillationScore + amplitudeScore
      + crossScore + concentrationScore + trendScore) / 7 * 100;
    const qualified = trades.length >= this.config.minTrades
      && totalVolumeSol >= this.config.minVolumeSol
      && wallets.size >= this.config.minUniqueWallets
      && buySharePct >= this.config.minBuySharePct
      && buySharePct <= this.config.maxBuySharePct
      && rangePct >= this.config.minRangePct
      && efficiencyRatio <= this.config.maxEfficiencyRatio
      && crosses >= this.config.minMeanCrosses
      && topWalletSharePct <= this.config.maxTopWalletSharePct
      && Math.abs(trendPct) <= this.config.maxTrendPct
      && rangeScore >= this.config.minRangeScore;
    const currentPrice = prices[prices.length - 1];
    const deviationSigma = standardDeviation > 0
      ? (currentPrice - weightedPrice) / standardDeviation : 0;
    return {
      qualified,
      rangeScore,
      tradeCount: trades.length,
      volumeSol: totalVolumeSol,
      uniqueWallets: wallets.size,
      buySharePct,
      rangePct,
      efficiencyRatio,
      meanCrosses: crosses,
      topWalletSharePct,
      trendPct,
      midlinePrice: weightedPrice,
      standardDeviation,
      lowerBandPrice: weightedPrice - standardDeviation,
      upperBandPrice: weightedPrice + standardDeviation,
      deviationSigma,
      recentNetFlowSol: recentBuySol - recentSellSol,
      recentBuyers,
      recentSellSol,
      priorSellSol,
      sellDecayRatio,
    };
  }

  _updateRangeState(state, features, timestampMs) {
    if (!features) return;
    this.metrics.rangeEvaluations += 1;
    if (features.qualified) {
      if (!state.rangeActive) this.metrics.rangeQualified += 1;
      state.rangeActive = true;
      state.rangeInvalidSince = null;
      const maximumUntil = state.graduatedAt + this.config.maxTrackingMs;
      if (state.extendedUntil < maximumUntil) {
        state.extendedUntil = maximumUntil;
        if (!state.everExtended) {
          state.everExtended = true;
          this.metrics.extendedMints += 1;
        }
      }
    } else {
      if (state.rangeActive && !state.rangeInvalidSince) state.rangeInvalidSince = timestampMs;
      if (state.rangeInvalidSince
        && timestampMs - state.rangeInvalidSince >= this.config.rangeLossConfirmMs) {
        state.rangeActive = false;
        if (!this._hasActiveMint(state.mint)) {
          state.extendedUntil = Math.min(
            state.extendedUntil,
            timestampMs + this.config.unsubscribeGraceMs,
          );
        }
      }
    }
  }

  _observeEntries(state, trade, price, features, replay) {
    if (!features) return;
    for (const profile of this.entryProfiles.values()) {
      const profileState = state.profiles.get(profile.id);
      if (!profileState) continue;
      if (price >= features.midlinePrice && !this._hasActiveProfile(state.mint, profile.id)) {
        profileState.armed = true;
      }
      if (!features.qualified) {
        profileState.candidate = null;
        continue;
      }
      const candidate = profileState.candidate;
      if (candidate) {
        if (trade.timestampMs > candidate.expiresAt) {
          profileState.candidate = null;
          continue;
        }
        if (price < candidate.lowPrice) {
          candidate.lowPrice = price;
          candidate.lowAt = trade.timestampMs;
        }
        const reboundPct = (price / candidate.lowPrice - 1) * 100;
        const flowPass = profile.minRecentNetFlowSol == null
          || features.recentNetFlowSol >= profile.minRecentNetFlowSol;
        const buyersPass = profile.minRecentBuyers == null
          || features.recentBuyers >= profile.minRecentBuyers;
        const sellDecayPass = profile.maxSellDecayRatio == null
          || features.sellDecayRatio <= profile.maxSellDecayRatio;
        if (reboundPct >= profile.reboundPct && flowPass && buyersPass && sellDecayPass) {
          profileState.candidate = null;
          if (replay) this.metrics.replaySignalsSuppressed += 1;
          else if (!this._hasActiveProfile(state.mint, profile.id)) {
            profileState.swingIndex += 1;
            const opportunityPass = profileState.swingIndex >= (profile.minOpportunityIndex || 1)
              && (profile.maxOpportunityIndex == null
                || profileState.swingIndex <= profile.maxOpportunityIndex);
            if (opportunityPass) {
              this._emitSignal(state, profile, profileState.swingIndex, trade, price, features,
                candidate, reboundPct);
            }
          }
        }
        continue;
      }
      if (profileState.armed && !this._hasActiveProfile(state.mint, profile.id)
        && features.deviationSigma <= -profile.deviationSigma) {
        profileState.armed = false;
        profileState.candidate = {
          startedAt: trade.timestampMs,
          expiresAt: trade.timestampMs + profile.reboundTimeoutMs,
          lowAt: trade.timestampMs,
          lowPrice: price,
        };
        this.metrics.candidates += 1;
      }
    }
  }

  _emitSignal(state, profile, swingIndex, trade, price, features, candidate, reboundPct) {
    const episodeId = `${state.mint}:${profile.id}:${candidate.startedAt}:${trade.timestampMs}`;
    this.metrics.signals += 1;
    for (const exitProfile of this.exitProfiles.values()) {
      if (Array.isArray(profile.exitProfileIds)
        && !profile.exitProfileIds.includes(exitProfile.id)) continue;
      const cohortId = `${profile.id}_${exitProfile.id}`;
      const saved = this.store.createRangeScalperShadowPosition({
        cohortId,
        entryProfileId: profile.id,
        exitProfileId: exitProfile.id,
        episodeId,
        swingIndex,
        mint: state.mint,
        symbol: state.symbol,
        status: STATUS.PENDING_ENTRY,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        migratedAt: state.graduatedAt,
        signalAt: trade.timestampMs,
        signalPrice: price,
        rangeScore: features.rangeScore,
        windowMs: this.config.windowMs,
        tradeCount: features.tradeCount,
        volumeSol: features.volumeSol,
        uniqueWallets: features.uniqueWallets,
        buySharePct: features.buySharePct,
        rangePct: features.rangePct,
        efficiencyRatio: features.efficiencyRatio,
        meanCrosses: features.meanCrosses,
        topWalletSharePct: features.topWalletSharePct,
        trendPct: features.trendPct,
        midlinePrice: features.midlinePrice,
        lowerBandPrice: features.lowerBandPrice,
        upperBandPrice: features.upperBandPrice,
        deviationSigma: features.deviationSigma,
        reboundPct,
        recentNetFlowSol: features.recentNetFlowSol,
        recentBuyers: features.recentBuyers,
        sellDecayRatio: features.sellDecayRatio,
        features,
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
        exitMode: exitProfile.exitMode,
        takeProfitPct: exitProfile.takeProfitPct,
        hardStopPct: exitProfile.hardStopPct,
        maxHoldMs: exitProfile.maxHoldMs,
      });
      if (!saved?.inserted) continue;
      const pending = rowPosition(saved);
      this.pendingEntries.set(pending.id, pending);
      this._indexRow(pending);
    }
    this.metrics.lastActionAt = this.now();
  }

  _observeRows(state, trade, price, features) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (trade.timestampMs < position.entryTargetAt
          || trade.timestampMs > position.entryDeadlineAt) continue;
        const rugGuard = evaluateUniversalRugGuard(this.store, {
          strategyId: `RANGE_SCALPER:${position.cohortId}`,
          mint: position.mint,
          timestampMs: trade.timestampMs,
          market: trade.market,
        });
        if (rugGuard.blocked) {
          this.store.updateRangeScalperShadowPosition(position.id, {
            status: STATUS.NO_ENTRY,
            rejectionReason: 'PRE_ENTRY_RUG_RISK',
          });
          this.pendingEntries.delete(position.id);
          this._unindexRow(position);
          continue;
        }
        const jumpPct = (price / position.signalPrice - 1) * 100;
        if (jumpPct > this.config.maxEntryPriceJumpPct) {
          this.store.updateRangeScalperShadowPosition(position.id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
          });
          this.pendingEntries.delete(position.id);
          this._unindexRow(position);
          this.metrics.priceJump += 1;
          continue;
        }
        if (jumpPct < -this.maxEntryPriceDropPct) {
          this.store.updateRangeScalperShadowPosition(position.id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_DROP_${Math.abs(jumpPct).toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
          });
          this.pendingEntries.delete(position.id);
          this._unindexRow(position);
          this.metrics.priceJump += 1;
          continue;
        }
        Object.assign(position, {
          status: STATUS.OPEN,
          entryAt: trade.timestampMs,
          entryMarket: trade.market,
          entryPrice: price,
          highestPrice: price,
          lowestPrice: price,
          lastObservedAt: trade.timestampMs,
          lastPrice: price,
        });
        this.store.updateRangeScalperShadowPosition(position.id, {
          status: STATUS.OPEN,
          entryAt: trade.timestampMs,
          entryMarket: trade.market,
          entryPrice: price,
          entryJumpPct: jumpPct,
          highestPrice: price,
          lowestPrice: price,
          lastObservedAt: trade.timestampMs,
          lastPrice: price,
          maxFavorableReturnPct: 0,
          maxAdverseReturnPct: 0,
        });
        this.pendingEntries.delete(position.id);
        this.positions.set(position.id, position);
        this.metrics.opened += 1;
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        const dataIssue = this._priceDataIssue(position, trade, price);
        if (dataIssue) {
          this._markPriceDataIssue(position, dataIssue);
          continue;
        }
        if (trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      const dataIssue = this._priceDataIssue(position, trade, price);
      if (dataIssue) {
        this._markPriceDataIssue(position, dataIssue);
        continue;
      }
      position.highestPrice = Math.max(position.highestPrice, price);
      position.lowestPrice = Math.min(position.lowestPrice, price);
      position.lastObservedAt = trade.timestampMs;
      position.lastPrice = price;
      const grossReturnPct = (price / position.entryPrice - 1) * 100;
      position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct, grossReturnPct);
      position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct, grossReturnPct);
      this.store.updateRangeScalperShadowPosition(position.id, {
        highestPrice: position.highestPrice,
        lowestPrice: position.lowestPrice,
        lastObservedAt: trade.timestampMs,
        lastPrice: price,
        maxFavorableReturnPct: position.maxFavorableReturnPct,
        maxAdverseReturnPct: position.maxAdverseReturnPct,
      });
      let reason = null;
      if (grossReturnPct <= -position.hardStopPct) reason = 'HARD_STOP';
      else if (state.rangeInvalidSince
        && trade.timestampMs - state.rangeInvalidSince >= this.config.rangeLossConfirmMs) {
        reason = 'RANGE_REGIME_LOST';
        this.metrics.rangeLossExits += 1;
      } else if (position.exitMode === 'MIDLINE' && price >= position.midlinePrice) {
        reason = 'MIDLINE_REVERSION';
      } else if (position.exitMode === 'TAKE_PROFIT'
        && grossReturnPct >= position.takeProfitPct) reason = 'TAKE_PROFIT';
      else if (position.exitMode === 'UPPER_BAND' && features
        && price >= Math.max(position.midlinePrice, features.upperBandPrice)) reason = 'UPPER_BAND';
      else if (position.exitMode === 'FLOW_REVERSAL' && features
        && price >= position.midlinePrice && features.recentNetFlowSol <= 0) {
        reason = 'MIDLINE_FLOW_REVERSAL';
      } else if (trade.timestampMs >= position.entryAt + position.maxHoldMs) reason = 'MAX_HOLD';
      if (reason) this._triggerExit(position, trade.timestampMs, reason);
    }
  }

  _triggerExit(position, timestampMs, reason) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitTriggerAt = timestampMs;
    position.exitTargetAt = timestampMs + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    position.exitReason = reason;
    this.store.updateRangeScalperShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
      exitReason: reason,
    });
  }

  _close(position, trade, price) {
    const dataIssue = this._priceDataIssue(position, trade, price);
    if (dataIssue) {
      this._markPriceDataIssue(position, dataIssue);
      return;
    }
    const grossReturnPct = (price / position.entryPrice - 1) * 100;
    this.store.updateRangeScalperShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
      exitReason: position.exitReason,
      grossReturnPct,
      netReturnPct: grossReturnPct - this.costs.deterministicCostPct,
    });
    this.positions.delete(position.id);
    this._unindexRow(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _priceDataIssue(position, trade, price) {
    if (position.entryMarket && trade.market && position.entryMarket !== trade.market) {
      return `CROSS_MARKET_PRICE_${position.entryMarket}_TO_${trade.market}`;
    }
    const referencePrice = finite(position.lastPrice) || finite(position.entryPrice);
    if (!(referencePrice > 0) || !(price > 0)) return null;
    const scaleRatio = Math.max(price / referencePrice, referencePrice / price);
    if (scaleRatio <= this.maxObservedPriceScaleRatio) return null;
    return `PRICE_SCALE_DISCONTINUITY_${scaleRatio.toFixed(2)}X`;
  }

  _markPriceDataIssue(position, rejectionReason) {
    this.store.updateRangeScalperShadowPosition(position.id, {
      status: STATUS.PRICE_JUMP,
      rejectionReason,
    });
    this.pendingEntries.delete(position.id);
    this.positions.delete(position.id);
    this._unindexRow(position);
    this.metrics.priceJump += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateRangeScalperShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      exitReason: position.exitReason || 'NO_EXIT_TRADE',
    });
    this.positions.delete(position.id);
    this._unindexRow(position);
    this.metrics.noExit += 1;
  }

  _hasActiveMint(mint) {
    return (this.rowsByMint.get(mint)?.size || 0) > 0;
  }

  _hasActiveProfile(mint, profileId) {
    for (const id of this.rowsByMint.get(mint) || []) {
      const row = this.pendingEntries.get(id) || this.positions.get(id);
      if (row?.entryProfileId === profileId) return true;
    }
    return false;
  }

  _indexRow(row) {
    let ids = this.rowsByMint.get(row.mint);
    if (!ids) {
      ids = new Set();
      this.rowsByMint.set(row.mint, ids);
    }
    ids.add(row.id);
  }

  _unindexRow(row) {
    const ids = this.rowsByMint.get(row.mint);
    if (!ids) return;
    ids.delete(row.id);
    if (!ids.size) this.rowsByMint.delete(row.mint);
  }
}

module.exports = { RangeScalperShadowSuite };
