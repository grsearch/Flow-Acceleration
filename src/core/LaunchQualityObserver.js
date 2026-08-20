'use strict';

const LABEL_HORIZONS_MS = Object.freeze([3_000, 5_000, 10_000, 30_000]);

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rawSol(value) {
  try {
    const raw = BigInt(value || 0);
    return Number(raw) / 1e9;
  } catch (_) {
    return null;
  }
}

function normalizedToken(token = {}) {
  return {
    mint: token.mint,
    symbol: token.symbol || null,
    creator: token.creator || null,
    createdAt: finite(token.createdAt ?? token.created_at),
  };
}

function statePrice(trade) {
  return finite(trade.reservePrice) > 0 ? Number(trade.reservePrice) : finite(trade.price);
}

function newState(token) {
  return {
    ...token,
    firstTradeAt: null,
    lastTradeAt: null,
    baselinePrice: null,
    lastPrice: null,
    peakAt: null,
    peakPrice: null,
    maxReturnPct: 0,
    pumpAt: { 25: null, 50: null, 100: null },
    referencePeakAt: null,
    referencePeakPrice: null,
    firstPullbackAt: null,
    pullbackLowPrice: null,
    maxPullbackPct: 0,
    reboundAt: null,
    reboundPrice: null,
    referenceFeatures: null,
    totalBuySol: 0,
    totalSellSol: 0,
    buyTx: 0,
    sellTx: 0,
    wallets: new Map(),
    flowEvents: [],
    buySolSincePeak: 0,
    sellSolSincePeak: 0,
    latestCurvePct: null,
    latestVirtualSolReserves: null,
    capturedHorizons: new Set(),
    labelFinalized: false,
    returns: new Map(),
    outcomeMfe: new Map(LABEL_HORIZONS_MS.map((horizon) => [horizon, 0])),
    outcomeMae: new Map(LABEL_HORIZONS_MS.map((horizon) => [horizon, 0])),
    deepReferenceStates: new Map(),
  };
}

class LaunchQualityObserver {
  constructor({
    config, store, now = () => Date.now(), onReference = null, onSnapshot = null,
    rugRiskTracker = null,
  }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.onReference = typeof onReference === 'function' ? onReference : null;
    this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : null;
    this.rugRiskTracker = rugRiskTracker;
    this.states = new Map();
    this.marketRegimeCache = new Map();
    this.metrics = {
      launchesObserved: 0,
      snapshotsWritten: 0,
      referencePullbacks: 0,
      deepReferences: 0,
      deepRejected: 0,
      labelsCompleted: 0,
      rightCensored: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    const restoreWindowMs = this.config.maxLaunchAgeMs
      + Math.max(...LABEL_HORIZONS_MS)
      + this.config.maxObservationLagMs
      + 5_000;
    const tokens = this.store.allTokens()
      .map(normalizedToken)
      .filter((token) => token.mint && token.createdAt
        && token.createdAt >= now - restoreWindowMs
        && token.createdAt <= now + 5_000);
    for (const token of tokens) this._ensureState(token, false);
    for (const trade of this.store.recentCurveTrades(now - restoreWindowMs)) {
      this.observeTrade(trade, { replay: true });
    }
    this.advanceTime(now, { replay: true });
  }

  stop() {}

  onCreate(token) {
    if (!this.config.enabled) return null;
    return this._ensureState(normalizedToken(token), true);
  }

  observeTrade(trade, { replay = false } = {}) {
    if (!this.config.enabled || !trade?.mint || trade.market !== 'PUMP_BONDING_CURVE') return;
    const timestampMs = finite(trade.timestampMs);
    const price = statePrice(trade);
    if (!(timestampMs > 0) || !(price > 0)) return;

    let state = this.states.get(trade.mint);
    if (!state) {
      // Startup replay may continue past a state that was already finalized and
      // removed. Never recreate it from a later trade: doing so used to replace
      // a valid reference label with NO_REFERENCE after every restart.
      if (replay) return;
      const token = normalizedToken(this.store.getToken(trade.mint) || {});
      if (!token.mint || !token.createdAt) return;
      const latestDeadline = token.createdAt + this.config.maxLaunchAgeMs
        + Math.max(...LABEL_HORIZONS_MS) + this.config.maxObservationLagMs;
      if (timestampMs > latestDeadline) return;
      state = this._ensureState(token, !replay);
    }
    if (!state || timestampMs < state.createdAt - 5_000) return;

    this._applyTrade(state, trade, timestampMs, price, replay);
    this._captureDueSnapshots(state, timestampMs, { replay });
    this._captureDueReturns(state, trade, timestampMs, price);
    this._finishIfDue(state, timestampMs);
  }

  advanceTime(now = this.now(), { replay = false } = {}) {
    if (!this.config.enabled) return;
    for (const state of [...this.states.values()]) {
      this._captureDueSnapshots(state, now, { replay });
      this._finishIfDue(state, now);
    }
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'OBSERVER_ONLY',
      sendsTransactions: false,
      opensSimulatedPositions: false,
      activeLaunches: this.states.size,
      strategy: {
        name: 'Launch Quality / First Pullback Observer',
        observationHorizonsMs: [...this.config.snapshotHorizonsMs],
        referenceLabels: {
          pumpPct: this.config.pumpReferencePct,
          pullbackPct: this.config.pullbackReferencePct,
          reboundPct: this.config.reboundReferencePct,
          note: 'Reference labels only; they are not entry thresholds.',
        },
        deepShadowReferences: (this.config.deepReferenceProfiles || []).map((profile) => ({
          id: profile.id,
          pullbackPct: profile.pullbackPct,
          reboundPct: profile.reboundPct,
          lowStableMs: profile.lowStableMs,
          minNewBuyers: profile.minNewBuyers,
          flowWindowMs: profile.flowWindowMs,
          minWindowNetFlowSol: profile.minWindowNetFlowSol,
          maxPullbackPct: profile.maxPullbackPct,
        })),
        research: {
          buyerWindowMs: this.config.recentBuyerWindowMs,
          retentionFloorPct: this.config.retentionFloorPct,
          marketRegimeLookbackMs: this.config.marketRegimeLookbackMs,
          marketRegimeSettlementLagMs: this.config.marketRegimeSettlementLagMs,
          labelHorizonsMs: [...LABEL_HORIZONS_MS],
          maxObservationLagMs: this.config.maxObservationLagMs,
          isolatedTables: [
            'launch_quality_observations',
            'launch_quality_snapshots',
          ],
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  _ensureState(token, countMetric) {
    if (!token?.mint || !(token.createdAt > 0)) return null;
    const existing = this.states.get(token.mint);
    if (existing) return existing;
    const stored = this.store.getLaunchQualityObservation(token.mint);
    if (stored && ['COMPLETE', 'RIGHT_CENSORED', 'NO_REFERENCE'].includes(stored.label_status)) {
      return null;
    }
    const state = newState(token);
    this.states.set(token.mint, state);
    this.store.createLaunchQualityObservation(token);
    if (countMetric) {
      this.metrics.launchesObserved += 1;
      this.metrics.lastActionAt = this.now();
    }
    return state;
  }

  _applyTrade(state, trade, timestampMs, price, replay = false) {
    if (!state.firstTradeAt) {
      state.firstTradeAt = timestampMs;
      state.baselinePrice = price;
      state.peakAt = timestampMs;
      state.peakPrice = price;
      this.store.updateLaunchQualityObservation(state.mint, {
        firstTradeAt: timestampMs,
        baselinePrice: price,
        lastTradeAt: timestampMs,
        lastPrice: price,
        peakAt: timestampMs,
        peakPrice: price,
        maxReturnPct: 0,
      });
    }
    state.lastTradeAt = timestampMs;
    state.lastPrice = price;
    state.latestCurvePct = finite(trade.curvePct, state.latestCurvePct);
    state.latestVirtualSolReserves = rawSol(trade.virtualSolReservesRaw)
      ?? state.latestVirtualSolReserves;
    const side = String(trade.side || '').toUpperCase();
    const solAmount = Math.max(0, finite(trade.solAmount, 0));
    const tokenAmount = Math.max(0, finite(trade.tokenAmount, 0));
    const wallet = String(trade.wallet || '');
    state.flowEvents.push({ timestampMs, side, solAmount });
    while (state.flowEvents.length && state.flowEvents[0].timestampMs < timestampMs - 15_000) {
      state.flowEvents.shift();
    }

    if (side === 'BUY') {
      state.totalBuySol += solAmount;
      state.buySolSincePeak += solAmount;
      state.buyTx += 1;
    } else if (side === 'SELL') {
      state.totalSellSol += solAmount;
      state.sellSolSincePeak += solAmount;
      state.sellTx += 1;
    }
    if (wallet) {
      const walletState = state.wallets.get(wallet) || {
        firstBuyAt: null,
        buySol: 0,
        buyToken: 0,
        netToken: 0,
      };
      if (side === 'BUY') {
        walletState.firstBuyAt ??= timestampMs;
        walletState.buySol += solAmount;
        walletState.buyToken += tokenAmount;
        walletState.netToken += tokenAmount;
      } else if (side === 'SELL') {
        walletState.netToken -= tokenAmount;
      }
      state.wallets.set(wallet, walletState);
    }

    if (price > state.peakPrice) {
      state.peakPrice = price;
      state.peakAt = timestampMs;
      state.buySolSincePeak = side === 'BUY' ? solAmount : 0;
      state.sellSolSincePeak = side === 'SELL' ? solAmount : 0;
      if (!state.firstPullbackAt) {
        state.referencePeakAt = timestampMs;
        state.referencePeakPrice = price;
        state.pullbackLowPrice = price;
      }
    }
    state.maxReturnPct = Math.max(
      state.maxReturnPct,
      ((state.peakPrice / state.baselinePrice) - 1) * 100,
    );
    this._recordPumpMilestones(state, timestampMs, price);
    this._observeReferencePullback(state, timestampMs, price, replay);
    this._observeDeepReferencePullbacks(state, timestampMs, price, replay);
    this._updateOutcomeExcursions(state, timestampMs, price);
  }

  _recordPumpMilestones(state, timestampMs, price) {
    const patch = {};
    for (const threshold of [25, 50, 100]) {
      if (state.pumpAt[threshold]) continue;
      if (((price / state.baselinePrice) - 1) * 100 < threshold) continue;
      state.pumpAt[threshold] = timestampMs;
      patch[`pump${threshold}At`] = timestampMs;
    }
    if (Object.keys(patch).length) this.store.updateLaunchQualityObservation(state.mint, patch);
  }

  _observeReferencePullback(state, timestampMs, price, replay = false) {
    if (!state.pumpAt[25] || state.reboundAt) return;
    state.referencePeakAt ??= state.peakAt;
    state.referencePeakPrice ??= state.peakPrice;
    if (!state.firstPullbackAt && price > state.referencePeakPrice) {
      state.referencePeakAt = timestampMs;
      state.referencePeakPrice = price;
      state.buySolSincePeak = String(state.flowEvents.at(-1)?.side) === 'BUY'
        ? state.flowEvents.at(-1).solAmount : 0;
      state.sellSolSincePeak = String(state.flowEvents.at(-1)?.side) === 'SELL'
        ? state.flowEvents.at(-1).solAmount : 0;
    }
    state.pullbackLowPrice = Math.min(state.pullbackLowPrice ?? price, price);
    state.maxPullbackPct = Math.max(
      state.maxPullbackPct,
      (1 - state.pullbackLowPrice / state.referencePeakPrice) * 100,
    );
    if (!state.firstPullbackAt
      && state.maxPullbackPct >= this.config.pullbackReferencePct) {
      state.firstPullbackAt = timestampMs;
      this.store.updateLaunchQualityObservation(state.mint, {
        referencePeakAt: state.referencePeakAt,
        referencePeakPrice: state.referencePeakPrice,
        firstPullbackAt: timestampMs,
        pullbackLowPrice: state.pullbackLowPrice,
        maxPullbackPct: state.maxPullbackPct,
      });
    }
    if (!state.firstPullbackAt) return;
    const reboundPct = ((price / state.pullbackLowPrice) - 1) * 100;
    if (reboundPct < this.config.reboundReferencePct) return;
    state.reboundAt = timestampMs;
    state.reboundPrice = price;
    state.referenceFeatures = {
      ...this._features(state, timestampMs),
      ...this._marketRegimeFeatures(timestampMs),
    };
    this.metrics.referencePullbacks += 1;
    this.metrics.lastActionAt = this.now();
    this.store.updateLaunchQualityObservation(state.mint, {
      reboundAt: timestampMs,
      reboundPrice: price,
      pullbackLowPrice: state.pullbackLowPrice,
      maxPullbackPct: state.maxPullbackPct,
      referenceFeatures: state.referenceFeatures,
      labelStatus: 'PENDING',
    });
    if (!replay && this.onReference) {
      try {
        this.onReference({
          mint: state.mint,
          symbol: state.symbol,
          creator: state.creator,
          createdAt: state.createdAt,
          referenceAt: timestampMs,
          referencePrice: price,
          pump25At: state.pumpAt[25],
          referencePeakAt: state.referencePeakAt,
          referencePeakPrice: state.referencePeakPrice,
          firstPullbackAt: state.firstPullbackAt,
          pullbackLowPrice: state.pullbackLowPrice,
          maxPullbackPct: state.maxPullbackPct,
          features: { ...state.referenceFeatures },
        });
      } catch (error) {
        this.metrics.lastError = error?.message || String(error);
      }
    }
  }

  _observeDeepReferencePullbacks(state, timestampMs, price, replay = false) {
    if (!state.pumpAt[25]) return;
    const lifecycleDeadline = state.createdAt + this.config.maxLaunchAgeMs;
    for (const profile of this.config.deepReferenceProfiles || []) {
      let tracker = state.deepReferenceStates.get(profile.id);
      if (!tracker) {
        tracker = {
          peakAt: state.peakAt,
          peakPrice: state.peakPrice,
          lowAt: state.peakAt,
          lowPrice: state.peakPrice,
          firstPullbackAt: null,
          maxPullbackPct: 0,
          terminal: false,
        };
        state.deepReferenceStates.set(profile.id, tracker);
      }
      if (tracker.terminal) continue;

      if (timestampMs > lifecycleDeadline) {
        tracker.terminal = true;
        continue;
      }

      if (!tracker.firstPullbackAt && price > tracker.peakPrice) {
        tracker.peakAt = timestampMs;
        tracker.peakPrice = price;
        tracker.lowAt = timestampMs;
        tracker.lowPrice = price;
      }
      if (price < tracker.lowPrice) {
        tracker.lowAt = timestampMs;
        tracker.lowPrice = price;
      }
      tracker.maxPullbackPct = Math.max(
        tracker.maxPullbackPct,
        (1 - tracker.lowPrice / tracker.peakPrice) * 100,
      );
      if (tracker.maxPullbackPct > profile.maxPullbackPct) {
        tracker.terminal = true;
        this.metrics.deepRejected += 1;
        if (!replay) {
          this._emitDeepReference(state, profile, tracker, timestampMs, price,
            `MAX_PULLBACK_${tracker.maxPullbackPct.toFixed(2)}PCT`);
        }
        continue;
      }
      if (!tracker.firstPullbackAt && tracker.maxPullbackPct >= profile.pullbackPct) {
        tracker.firstPullbackAt = timestampMs;
      }
      if (!tracker.firstPullbackAt) continue;

      const reboundPct = ((price / tracker.lowPrice) - 1) * 100;
      const lowStableMs = timestampMs - tracker.lowAt;
      const buyersSinceLow = [...state.wallets.values()].filter((wallet) => (
        wallet.firstBuyAt != null && wallet.firstBuyAt >= tracker.lowAt
      )).length;
      const windowStart = timestampMs - profile.flowWindowMs;
      const windowNetFlowSol = state.flowEvents.filter((event) => (
        event.timestampMs >= windowStart
      )).reduce((total, event) => (
        total + (event.side === 'BUY' ? event.solAmount : -event.solAmount)
      ), 0);
      if (timestampMs < tracker.lowAt) continue;
      if (reboundPct < profile.reboundPct
        || lowStableMs < profile.lowStableMs
        || buyersSinceLow < profile.minNewBuyers
        || windowNetFlowSol < profile.minWindowNetFlowSol) continue;

      tracker.terminal = true;
      this.metrics.deepReferences += 1;
      if (!replay) {
        this._emitDeepReference(state, profile, tracker, timestampMs, price, null, {
          reboundPct,
          lowStableMs,
          buyersSinceLow,
          windowNetFlowSol,
        });
      }
    }
  }

  _emitDeepReference(state, profile, tracker, timestampMs, price, rejectionReason, evidence = {}) {
    this.metrics.lastActionAt = this.now();
    if (!this.onReference) return;
    try {
      this.onReference({
        mint: state.mint,
        symbol: state.symbol,
        creator: state.creator,
        createdAt: state.createdAt,
        referenceProfileId: profile.id,
        referenceAt: timestampMs,
        referencePrice: price,
        pump25At: state.pumpAt[25],
        referencePeakAt: tracker.peakAt,
        referencePeakPrice: tracker.peakPrice,
        firstPullbackAt: tracker.firstPullbackAt || timestampMs,
        pullbackLowAt: tracker.lowAt,
        pullbackLowPrice: tracker.lowPrice,
        maxPullbackPct: tracker.maxPullbackPct,
        rejectionReason,
        features: {
          ...this._features(state, timestampMs),
          ...this._marketRegimeFeatures(timestampMs),
          deepReboundPct: evidence.reboundPct ?? ((price / tracker.lowPrice) - 1) * 100,
          lowStableMs: evidence.lowStableMs ?? timestampMs - tracker.lowAt,
          buyersSincePullbackLow: evidence.buyersSinceLow ?? 0,
          windowNetFlowSol: evidence.windowNetFlowSol ?? 0,
          flowWindowMs: profile.flowWindowMs,
        },
      });
    } catch (error) {
      this.metrics.lastError = error?.message || String(error);
    }
  }

  _features(state, observedAt, horizonMs = null) {
    const buyers = [...state.wallets.values()].filter((wallet) => wallet.firstBuyAt != null);
    buyers.sort((left, right) => left.firstBuyAt - right.firstBuyAt);
    const contributions = buyers.map((wallet) => wallet.buySol).sort((left, right) => right - left);
    const totalWalletBuySol = contributions.reduce((sum, value) => sum + value, 0);
    const retained = buyers.slice(0, 20).filter((wallet) => (
      wallet.buyToken > 0
      && wallet.netToken >= wallet.buyToken * (this.config.retentionFloorPct / 100)
    )).length;
    const retention = buyers.length
      ? retained / Math.min(20, buyers.length) * 100
      : null;
    const recentBuyerCutoff = observedAt - this.config.recentBuyerWindowMs;
    const recentBuyers = buyers.filter((wallet) => wallet.firstBuyAt >= recentBuyerCutoff).length;
    const previousHorizonMs = horizonMs == null
      ? null
      : Math.max(0, ...this.config.snapshotHorizonsMs.filter((value) => value < horizonMs));
    const newBuyers = horizonMs == null
      ? recentBuyers
      : buyers.filter((wallet) => (
        wallet.firstBuyAt > state.createdAt + previousHorizonMs
        && wallet.firstBuyAt <= state.createdAt + horizonMs
      )).length;
    const last2sSell = state.flowEvents.filter((event) => (
      event.side === 'SELL' && event.timestampMs >= observedAt - 2_000
    )).reduce((sum, event) => sum + event.solAmount, 0);
    const prior5sSell = state.flowEvents.filter((event) => (
      event.side === 'SELL'
      && event.timestampMs >= observedAt - 7_000
      && event.timestampMs < observedAt - 2_000
    )).reduce((sum, event) => sum + event.solAmount, 0);
    const recent1s = state.flowEvents.filter((event) => (
      event.timestampMs > observedAt - 1_000 && event.timestampMs <= observedAt
    ));
    const previous1s = state.flowEvents.filter((event) => (
      event.timestampMs > observedAt - 2_000 && event.timestampMs <= observedAt - 1_000
    ));
    const netFlow = (events) => events.reduce((sum, event) => (
      sum + (event.side === 'BUY' ? event.solAmount : -event.solAmount)
    ), 0);
    const recentNetFlow1s = netFlow(recent1s);
    const previousNetFlow1s = netFlow(previous1s);
    const depthFractionPct = state.latestVirtualSolReserves > 0
      ? state.sellSolSincePeak / state.latestVirtualSolReserves * 100
      : null;
    const sellImpact = state.sellSolSincePeak > 0
      ? state.maxPullbackPct / state.sellSolSincePeak
      : null;
    const depthAdjustedImpact = depthFractionPct > 0
      ? state.maxPullbackPct / depthFractionPct
      : null;
    const creator = state.creator ? state.wallets.get(state.creator) : null;
    const rugRisk = this.rugRiskTracker?.snapshot(state.mint, observedAt) || null;
    return {
      buyers: buyers.length,
      recentBuyers,
      newBuyers,
      buyTx: state.buyTx,
      sellTx: state.sellTx,
      buySol: state.totalBuySol,
      sellSol: state.totalSellSol,
      netFlowSol: state.totalBuySol - state.totalSellSol,
      top1SharePct: totalWalletBuySol > 0
        ? contributions.slice(0, 1).reduce((sum, value) => sum + value, 0)
          / totalWalletBuySol * 100
        : null,
      top3SharePct: totalWalletBuySol > 0
        ? contributions.slice(0, 3).reduce((sum, value) => sum + value, 0)
          / totalWalletBuySol * 100
        : null,
      retentionPct: retention,
      creatorSharePct: totalWalletBuySol > 0 && creator
        ? creator.buySol / totalWalletBuySol * 100
        : 0,
      sellSolSincePeak: state.sellSolSincePeak,
      buySolSincePeak: state.buySolSincePeak,
      sellImpactPctPerSol: sellImpact,
      sellDepthFractionPct: depthFractionPct,
      depthAdjustedSellImpact: depthAdjustedImpact,
      sellDecayRatio: last2sSell / Math.max(prior5sSell, 0.05),
      recentNetFlow1s,
      previousNetFlow1s,
      netFlowAcceleration1s: recentNetFlow1s - previousNetFlow1s,
      curvePct: state.latestCurvePct,
      virtualSolReserves: state.latestVirtualSolReserves,
      rugRisk,
    };
  }

  _marketRegimeFeatures(observedAt) {
    if (typeof this.store.launchMarketRegimeSnapshot !== 'function') return {};
    const cacheMs = Math.max(1_000, Number(this.config.marketRegimeCacheMs) || 5_000);
    const cacheKey = Math.floor(observedAt / cacheMs);
    const cached = this.marketRegimeCache.get(cacheKey);
    if (cached) return cached;

    const lookbackMs = Math.max(60_000, Number(this.config.marketRegimeLookbackMs) || 1_800_000);
    const settlementLagMs = Math.max(
      60_000,
      Number(this.config.marketRegimeSettlementLagMs) || 60_000,
    );
    const cutoffAt = observedAt - settlementLagMs;
    const row = this.store.launchMarketRegimeSnapshot({
      startAt: cutoffAt - lookbackMs,
      cutoffAt,
      observedAt,
    }) || {};
    const features = {
      marketRegimeObservedAt: observedAt,
      marketRegimeIndependentMints: finite(row.independent_mints, 0),
      marketRegimeAverageNetReturn5s: row.average_net_return_5s == null
        ? null : finite(row.average_net_return_5s),
      marketRegimeWinRate5s: row.win_rate_5s == null ? null : finite(row.win_rate_5s),
      marketRegimeBig20Rate5s: row.big20_rate_5s == null ? null : finite(row.big20_rate_5s),
    };
    this.marketRegimeCache.clear();
    this.marketRegimeCache.set(cacheKey, features);
    return features;
  }

  _captureDueSnapshots(state, observedAt, { replay = false } = {}) {
    for (const horizonMs of this.config.snapshotHorizonsMs) {
      if (state.capturedHorizons.has(horizonMs)) continue;
      if (observedAt < state.createdAt + horizonMs) continue;
      const features = this._features(state, observedAt, horizonMs);
      const price = state.lastPrice;
      const result = this.store.recordLaunchQualitySnapshot({
        mint: state.mint,
        horizonMs,
        observedAt,
        lastTradeAt: state.lastTradeAt,
        observationLagMs: Math.max(0, observedAt - (state.createdAt + horizonMs)),
        price,
        priceReturnPct: price > 0 && state.baselinePrice > 0
          ? ((price / state.baselinePrice) - 1) * 100 : null,
        peakReturnPct: state.maxReturnPct,
        drawdownPct: state.peakPrice > 0 && price > 0
          ? (1 - price / state.peakPrice) * 100 : null,
        ...features,
      });
      state.capturedHorizons.add(horizonMs);
      if (result?.inserted) {
        this.metrics.snapshotsWritten += 1;
        this.metrics.lastActionAt = this.now();
        if (this.onSnapshot) {
          try {
            this.onSnapshot(result, { replay });
          } catch (error) {
            this.metrics.lastError = error?.message || String(error);
          }
        }
      }
    }
  }

  _updateOutcomeExcursions(state, timestampMs, price) {
    if (!state.reboundAt || timestampMs < state.reboundAt) return;
    const returnPct = ((price / state.reboundPrice) - 1) * 100;
    for (const horizonMs of LABEL_HORIZONS_MS) {
      if (timestampMs > state.reboundAt + horizonMs) continue;
      state.outcomeMfe.set(horizonMs, Math.max(state.outcomeMfe.get(horizonMs), returnPct));
      state.outcomeMae.set(horizonMs, Math.min(state.outcomeMae.get(horizonMs), returnPct));
    }
  }

  _captureDueReturns(state, trade, timestampMs, price) {
    if (!state.reboundAt) return;
    const patch = {};
    for (const horizonMs of LABEL_HORIZONS_MS) {
      if (state.returns.has(horizonMs)) continue;
      const targetAt = state.reboundAt + horizonMs;
      if (timestampMs < targetAt || timestampMs > targetAt + this.config.maxObservationLagMs) continue;
      const value = ((price / state.reboundPrice) - 1) * 100;
      state.returns.set(horizonMs, value);
      patch[`return${horizonMs / 1_000}s`] = value;
    }
    if (Object.keys(patch).length) this.store.updateLaunchQualityObservation(state.mint, patch);
  }

  _finishIfDue(state, now) {
    if (state.reboundAt) {
      const labelDeadline = state.reboundAt + Math.max(...LABEL_HORIZONS_MS)
        + this.config.maxObservationLagMs;
      if (!state.labelFinalized && now > labelDeadline) {
        const missing = LABEL_HORIZONS_MS.filter((horizon) => !state.returns.has(horizon));
        const patch = {
          status: missing.length ? 'RIGHT_CENSORED' : 'COMPLETE',
          labelStatus: missing.length ? 'RIGHT_CENSORED' : 'COMPLETE',
          censorReason: missing.length ? `MISSING_${missing.map((value) => value / 1_000).join('_')}S` : null,
          completedAt: now,
          lastTradeAt: state.lastTradeAt,
          lastPrice: state.lastPrice,
          peakAt: state.peakAt,
          peakPrice: state.peakPrice,
          maxReturnPct: state.maxReturnPct,
          pullbackLowPrice: state.pullbackLowPrice,
          maxPullbackPct: state.maxPullbackPct,
        };
        for (const horizonMs of LABEL_HORIZONS_MS) {
          patch[`mfe${horizonMs / 1_000}s`] = state.outcomeMfe.get(horizonMs);
          patch[`mae${horizonMs / 1_000}s`] = state.outcomeMae.get(horizonMs);
        }
        this.store.updateLaunchQualityObservation(state.mint, patch);
        state.labelFinalized = true;
        if (missing.length) this.metrics.rightCensored += 1;
        else this.metrics.labelsCompleted += 1;
      }
      const snapshotDeadline = state.createdAt + Math.max(...this.config.snapshotHorizonsMs)
        + this.config.maxObservationLagMs;
      const deepReferenceDeadline = (this.config.deepReferenceProfiles || []).length
        ? state.createdAt + this.config.maxLaunchAgeMs + this.config.maxObservationLagMs
        : 0;
      if (state.labelFinalized
        && now > Math.max(labelDeadline, snapshotDeadline, deepReferenceDeadline)) {
        this.states.delete(state.mint);
      }
      return;
    }
    if (now <= state.createdAt + this.config.maxLaunchAgeMs) return;
    const deepProfilesPending = [...state.deepReferenceStates.values()]
      .some((tracker) => !tracker.terminal);
    if (deepProfilesPending
      && now <= state.createdAt + this.config.maxLaunchAgeMs + this.config.maxObservationLagMs) {
      return;
    }
    this.store.updateLaunchQualityObservation(state.mint, {
      status: 'NO_REFERENCE_PULLBACK',
      labelStatus: 'NO_REFERENCE',
      completedAt: now,
      lastTradeAt: state.lastTradeAt,
      lastPrice: state.lastPrice,
      peakAt: state.peakAt,
      peakPrice: state.peakPrice,
      maxReturnPct: state.maxReturnPct,
      pullbackLowPrice: state.pullbackLowPrice,
      maxPullbackPct: state.maxPullbackPct,
    });
    this.states.delete(state.mint);
  }
}

module.exports = { LaunchQualityObserver, LABEL_HORIZONS_MS };
