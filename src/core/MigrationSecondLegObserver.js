'use strict';

const { PublicKey } = require('@solana/web3.js');
const { NATIVE_MINT } = require('@solana/spl-token');
const { canonicalPumpPoolPda } = require('@pump-fun/pump-swap-sdk');

const LAMPORTS_PER_SOL = 1_000_000_000;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function migrationTime(token = {}) {
  return finite(
    token.graduated_at ?? token.graduatedAt ?? token.migratedAt
      ?? token.completedAt ?? token.timestampMs,
  );
}

function observedPrice(trade = {}) {
  const reservePrice = finite(trade.reservePrice);
  return reservePrice > 0 ? reservePrice : finite(trade.price);
}

function effectiveQuoteReserveSol(trade = {}) {
  try {
    if (trade.poolQuoteReservesRaw == null) return null;
    const poolQuote = BigInt(trade.poolQuoteReservesRaw);
    const virtualQuote = BigInt(trade.virtualQuoteReservesRaw || 0);
    const effective = poolQuote + virtualQuote;
    if (effective <= 0n) return null;
    const value = Number(effective) / LAMPORTS_PER_SOL;
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (_) {
    return null;
  }
}

function fixedInputImpactPct(quoteReserveSol, inputSol) {
  if (!(quoteReserveSol > 0) || !(inputSol > 0)) return null;
  return inputSol / (quoteReserveSol + inputSol) * 100;
}

function canonicalPoolAddress(mint) {
  if (!mint) return null;
  try {
    return canonicalPumpPoolPda(new PublicKey(mint), NATIVE_MINT).toBase58();
  } catch (_) {
    return null;
  }
}

function canonicalPoolStatus(expectedPool, observedPool) {
  if (!expectedPool || !observedPool) return 'UNKNOWN';
  return String(expectedPool) === String(observedPool) ? 'CANONICAL' : 'NON_CANONICAL';
}

function rawPositive(value) {
  if (value == null) return null;
  try { return BigInt(value) > 0n; } catch (_) { return null; }
}

function normalizedToken(token = {}) {
  return {
    mint: token.mint,
    symbol: token.symbol || null,
    creator: token.creator || null,
    migrationAt: migrationTime(token),
    migrationSource: token.migratedAt || token.migration_pool ? 'MIGRATION' : 'COMPLETE',
    migrationPool: token.migration_pool || token.migrationPool || token.pool || null,
  };
}

function newState(token) {
  const expectedCanonicalPool = canonicalPoolAddress(token.mint);
  return {
    ...token,
    firstAmmTradeAt: null,
    baselinePrice: null,
    lastTradeAt: null,
    lastPrice: null,
    peakAt: null,
    peakPrice: null,
    maxReturnPct: 0,
    firstPullbackAt: null,
    pullbackLowAt: null,
    pullbackLowPrice: null,
    maxPullbackPct: 0,
    reboundAt: null,
    lastSnapshotBucket: -1,
    events: [],
    wallets: new Map(),
    latestQuoteReserveSol: null,
    quoteReserveStatus: 'UNAVAILABLE',
    boostStatus: 'UNKNOWN',
    cashbackStatus: 'UNKNOWN',
    expectedCanonicalPool,
    canonicalPoolStatus: canonicalPoolStatus(expectedCanonicalPool, token.migrationPool),
  };
}

function windowStats(events, startAt, endAt, effectiveBuyMinSol = 0) {
  let buySol = 0;
  let sellSol = 0;
  let buyTx = 0;
  let sellTx = 0;
  const buyers = new Map();
  for (const event of events) {
    if (event.timestampMs < startAt || event.timestampMs >= endAt) continue;
    if (event.side === 'BUY') {
      buySol += event.solAmount;
      buyTx += 1;
      if (event.wallet && event.solAmount >= effectiveBuyMinSol) {
        buyers.set(event.wallet, (buyers.get(event.wallet) || 0) + event.solAmount);
      }
    } else if (event.side === 'SELL') {
      sellSol += event.solAmount;
      sellTx += 1;
    }
  }
  const buyerFlows = [...buyers.values()].sort((a, b) => b - a);
  return {
    buySol,
    sellSol,
    netFlow: buySol - sellSol,
    buyTx,
    sellTx,
    buyers: buyers.size,
    largestBuyerSharePct: buySol > 0 ? (buyerFlows[0] || 0) / buySol * 100 : null,
  };
}

class MigrationSecondLegObserver {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.states = new Map();
    this.metrics = {
      migrationsObserved: 0,
      snapshotsWritten: 0,
      completed: 0,
      rightCensored: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    // Keep cold start causal and bounded. Replaying AMM history here adds a
    // synchronous read to the critical startup path and creates a partial
    // baseline when the process missed the actual migration event.
    const censored = this.store.censorOpenMigrationSecondLegObservations({
      completedAt: now,
      completionReason: 'PROCESS_RESTART_NO_REPLAY',
    });
    this.metrics.rightCensored += Number(censored?.changes) || 0;
    this.metrics.startupReplaySkipped = true;
    this.metrics.startupRowsCensored = Number(censored?.changes) || 0;
    this.metrics.lastActionAt = now;
  }

  stop() {}

  onGraduated(token) {
    if (!this.config.enabled) return null;
    return this._ensureState(normalizedToken(token), true);
  }

  trackedMints(now = this.now()) {
    this.advanceTime(now);
    return [...this.states.keys()];
  }

  observeTrade(trade, { replay = false } = {}) {
    if (!this.config.enabled || !trade?.mint || trade.market !== 'PUMP_AMM') return;
    const timestampMs = finite(trade.timestampMs);
    const price = observedPrice(trade);
    if (!(timestampMs > 0) || !(price > 0)) return;

    // Only a migration event observed by this process may create state. A lazy
    // flow_tokens restore would incorrectly use a post-restart trade as entry.
    const state = this.states.get(trade.mint);
    if (!state || timestampMs < state.migrationAt - 5_000) return;
    if (timestampMs > state.migrationAt + this.config.maxAgeMs) {
      this._complete(state, timestampMs, 'MAX_AGE');
      return;
    }

    this._applyTrade(state, trade, timestampMs, price);
    this._captureSnapshot(state, trade, timestampMs, price, replay);
  }

  advanceTime(now = this.now(), { replay = false } = {}) {
    if (!this.config.enabled) return;
    for (const state of [...this.states.values()]) {
      if (now < state.migrationAt + this.config.maxAgeMs) continue;
      this._complete(state, now, state.firstAmmTradeAt ? 'MAX_AGE' : 'NO_AMM_TRADE', replay);
    }
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'M2F_OBSERVER_ONLY',
      code: 'M2F-OBS',
      sendsTransactions: false,
      opensSimulatedPositions: false,
      addsRpcRequests: false,
      activeMigrations: this.states.size,
      strategy: {
        name: 'Migration Second-Leg Flow Diffusion Observer',
        market: 'PUMP_AMM',
        maxAgeMs: this.config.maxAgeMs,
        snapshotIntervalMs: this.config.snapshotIntervalMs,
        pullbackArmPct: this.config.pullbackArmPct,
        retentionFloorPct: this.config.retentionFloorPct,
        effectiveBuyMinSol: this.config.effectiveBuyMinSol,
        exactArticleFeatures: {
          quoteReserve: 'OBSERVED_FROM_SWAP_EVENT',
          onfi10: 'PROVISIONAL_GROSS_FLOW_ONLY',
          boost: 'CAN_BOOST_HINT_ONLY',
          mayhem: 'UNKNOWN',
          cashback: 'TRADE_EVENT_HINT_ONLY',
          canonicalPool: 'LOCALLY_VERIFIED',
          entityClusters: 'UNAVAILABLE',
        },
        isolatedTables: [
          'migration_second_leg_observations',
          'migration_second_leg_snapshots',
        ],
      },
      ...this.metrics,
    };
  }

  _ensureState(token, countMetric) {
    if (!token?.mint || !(token.migrationAt > 0)) return null;
    const existing = this.states.get(token.mint);
    if (existing) {
      existing.symbol ||= token.symbol;
      existing.creator ||= token.creator;
      existing.migrationAt = Math.min(existing.migrationAt, token.migrationAt);
      return existing;
    }
    const stored = this.store.getMigrationSecondLegObservation(token.mint);
    if (stored && stored.status !== 'OBSERVING') return null;
    const state = newState(token);
    this.states.set(token.mint, state);
    this.store.createMigrationSecondLegObservation(token);
    if (countMetric) {
      this.metrics.migrationsObserved += 1;
      this.metrics.lastActionAt = this.now();
    }
    return state;
  }

  _applyTrade(state, trade, timestampMs, price) {
    if (!state.firstAmmTradeAt) {
      state.firstAmmTradeAt = timestampMs;
      state.baselinePrice = price;
      state.peakAt = timestampMs;
      state.peakPrice = price;
      state.pullbackLowAt = timestampMs;
      state.pullbackLowPrice = price;
    }
    state.lastTradeAt = timestampMs;
    state.lastPrice = price;
    if (price > state.peakPrice) {
      state.peakAt = timestampMs;
      state.peakPrice = price;
      if (!state.firstPullbackAt) {
        state.pullbackLowAt = timestampMs;
        state.pullbackLowPrice = price;
      }
    }
    state.maxReturnPct = Math.max(
      state.maxReturnPct,
      (state.peakPrice / state.baselinePrice - 1) * 100,
    );
    if (price < state.pullbackLowPrice) {
      state.pullbackLowAt = timestampMs;
      state.pullbackLowPrice = price;
    }
    state.maxPullbackPct = Math.max(
      state.maxPullbackPct,
      (1 - state.pullbackLowPrice / state.peakPrice) * 100,
    );
    if (!state.firstPullbackAt && state.maxPullbackPct >= this.config.pullbackArmPct) {
      state.firstPullbackAt = timestampMs;
    }
    if (state.firstPullbackAt && !state.reboundAt
      && price >= state.pullbackLowPrice * (1 + this.config.reboundReferencePct / 100)) {
      state.reboundAt = timestampMs;
    }

    const side = String(trade.side || '').toUpperCase();
    const solAmount = Math.max(0, finite(trade.solAmount, 0));
    const tokenAmount = Math.max(0, finite(trade.tokenAmount, 0));
    const wallet = String(trade.wallet || '');
    const quoteReserveSol = effectiveQuoteReserveSol(trade);
    if (quoteReserveSol != null) {
      state.latestQuoteReserveSol = quoteReserveSol;
      state.quoteReserveStatus = 'OBSERVED';
    }
    if (typeof trade.canBoost === 'boolean') {
      if (trade.canBoost) state.boostStatus = 'CAN_BOOST_HINT';
      else if (state.boostStatus === 'UNKNOWN') state.boostStatus = 'NOT_BOOST_CAPABLE_HINT';
    }
    const hasCashback = rawPositive(trade.cashbackRaw);
    if (hasCashback === true) state.cashbackStatus = 'TRADE_CASHBACK_OBSERVED';
    else if (hasCashback === false && state.cashbackStatus === 'UNKNOWN') {
      state.cashbackStatus = 'NO_TRADE_CASHBACK_OBSERVED';
    }
    const poolStatus = canonicalPoolStatus(
      state.expectedCanonicalPool,
      trade.pool || state.migrationPool,
    );
    if (poolStatus === 'NON_CANONICAL' || state.canonicalPoolStatus === 'UNKNOWN') {
      state.canonicalPoolStatus = poolStatus;
    }
    state.events.push({
      timestampMs, side, solAmount, tokenAmount, wallet, price, quoteReserveSol,
    });
    const eventFloor = timestampMs - 35_000;
    while (state.events.length && state.events[0].timestampMs < eventFloor) state.events.shift();
    if (wallet) {
      const existingWallet = state.wallets.get(wallet);
      const isEffectiveBuy = side === 'BUY' && solAmount >= this.config.effectiveBuyMinSol;
      if (isEffectiveBuy || existingWallet) {
        const walletState = existingWallet || { buyToken: 0, netToken: 0 };
        if (isEffectiveBuy) {
          walletState.buyToken += tokenAmount;
          walletState.netToken += tokenAmount;
        } else if (side === 'SELL') {
          walletState.netToken -= tokenAmount;
        }
        state.wallets.set(wallet, walletState);
      }
    }
  }

  _captureSnapshot(state, trade, timestampMs, price, replay) {
    const ageMs = timestampMs - state.migrationAt;
    if (ageMs < 0) return;
    const secondBucket = Math.floor(ageMs / this.config.snapshotIntervalMs);
    if (secondBucket <= state.lastSnapshotBucket) return;
    state.lastSnapshotBucket = secondBucket;

    const current3 = windowStats(
      state.events, timestampMs - 3_000, timestampMs + 1, this.config.effectiveBuyMinSol,
    );
    const current10 = windowStats(
      state.events, timestampMs - 10_000, timestampMs + 1, this.config.effectiveBuyMinSol,
    );
    const previous20 = windowStats(
      state.events, timestampMs - 30_000, timestampMs - 10_000,
      this.config.effectiveBuyMinSol,
    );
    const recentRate = current10.buyTx / 10;
    const priorRate = previous20.buyTx / 20;
    const retainedFloor = this.config.retentionFloorPct / 100;
    let retained = 0;
    let exited = 0;
    for (const wallet of state.wallets.values()) {
      if (!(wallet.buyToken > 0)) continue;
      if (wallet.netToken > wallet.buyToken * retainedFloor) retained += 1;
      else exited += 1;
    }
    const pullbackPct = (1 - price / state.peakPrice) * 100;
    const reboundPct = state.pullbackLowPrice > 0
      ? (price / state.pullbackLowPrice - 1) * 100 : null;
    const quoteReserveSol = effectiveQuoteReserveSol(trade) ?? state.latestQuoteReserveSol;
    const provisionalOnfi10Pct = quoteReserveSol > 0
      ? current10.netFlow / quoteReserveSol * 100 : null;
    const featureCompleteness = {
      publicOrderFlow: true,
      observedWalletDiffusion: true,
      quoteReserve: quoteReserveSol != null,
      onfi10: provisionalOnfi10Pct == null ? false : 'PROVISIONAL_GROSS',
      boost: state.boostStatus === 'UNKNOWN' ? false : 'HINT_ONLY',
      mayhem: false,
      cashback: state.cashbackStatus === 'UNKNOWN' ? false : 'HINT_ONLY',
      canonicalPool: state.canonicalPoolStatus === 'UNKNOWN' ? false : true,
      entityClusters: false,
      note: 'ONFI is provisional gross flow until BOOST/wash/entity filtering is available.',
    };
    const snapshot = {
      mint: state.mint,
      secondBucket,
      ageMs,
      observedAt: timestampMs,
      lastTradeAt: state.lastTradeAt,
      observationLagMs: Math.max(0, timestampMs - state.lastTradeAt),
      slot: trade.slot || null,
      price,
      baselinePrice: state.baselinePrice,
      peakPrice: state.peakPrice,
      openingImpulsePct: (price / state.baselinePrice - 1) * 100,
      pullbackPct,
      pullbackDurationMs: state.firstPullbackAt
        ? timestampMs - state.peakAt : null,
      reboundPct,
      microHighBreak: state.firstPullbackAt && price >= state.peakPrice ? 1 : 0,
      buySol3s: current3.buySol,
      sellSol3s: current3.sellSol,
      netFlow3s: current3.netFlow,
      buySol10s: current10.buySol,
      sellSol10s: current10.sellSol,
      netFlow10s: current10.netFlow,
      buySolPrev20s: previous20.buySol,
      sellSolPrev20s: previous20.sellSol,
      netFlowPrev20s: previous20.netFlow,
      buyers3s: current3.buyers,
      buyers10s: current10.buyers,
      largestBuyerShare10sPct: current10.largestBuyerSharePct,
      buySpeedRatio: priorRate > 0 ? recentRate / priorRate : recentRate > 0 ? null : 0,
      netFlowAcceleration: current10.netFlow - previous20.netFlow / 2,
      sellDecelerationRatio: previous20.sellSol > 0
        ? current10.sellSol / (previous20.sellSol / 2) : current10.sellSol > 0 ? null : 0,
      observedRetainedBuyers: retained,
      observedExitedBuyers: exited,
      observedHolderDiffusionIndex: retained - exited,
      quoteReserveSol,
      onfi10Pct: provisionalOnfi10Pct,
      estimatedImpact005Pct: fixedInputImpactPct(quoteReserveSol, 0.05),
      estimatedImpact01Pct: fixedInputImpactPct(quoteReserveSol, 0.1),
      estimatedImpact025Pct: fixedInputImpactPct(quoteReserveSol, 0.25),
      boostStatus: state.boostStatus,
      mayhemStatus: 'UNKNOWN',
      cashbackStatus: state.cashbackStatus,
      canonicalPoolStatus: state.canonicalPoolStatus,
      entityClusterStatus: 'UNAVAILABLE',
      featureCompleteness,
    };
    const saved = this.store.recordMigrationSecondLegSnapshot(snapshot);
    if (saved?.inserted) {
      this.metrics.snapshotsWritten += 1;
      this.metrics.lastActionAt = this.now();
    }
    this.store.updateMigrationSecondLegObservation(state.mint, {
      firstAmmTradeAt: state.firstAmmTradeAt,
      baselinePrice: state.baselinePrice,
      lastTradeAt: state.lastTradeAt,
      lastPrice: state.lastPrice,
      peakAt: state.peakAt,
      peakPrice: state.peakPrice,
      maxReturnPct: state.maxReturnPct,
      firstPullbackAt: state.firstPullbackAt,
      pullbackLowAt: state.pullbackLowAt,
      pullbackLowPrice: state.pullbackLowPrice,
      maxPullbackPct: state.maxPullbackPct,
      reboundAt: state.reboundAt,
      boostStatus: state.boostStatus,
      cashbackStatus: state.cashbackStatus,
      canonicalPoolStatus: state.canonicalPoolStatus,
      quoteReserveStatus: state.quoteReserveStatus,
    });
    if (!replay) this.metrics.lastActionAt = this.now();
  }

  _complete(state, completedAt, reason, replay = false) {
    const status = state.firstAmmTradeAt ? 'COMPLETE' : 'RIGHT_CENSORED';
    this.store.completeMigrationSecondLegObservation(state.mint, {
      status,
      completedAt,
      completionReason: reason,
    });
    this.states.delete(state.mint);
    if (status === 'COMPLETE') this.metrics.completed += 1;
    else this.metrics.rightCensored += 1;
    if (!replay) this.metrics.lastActionAt = this.now();
  }
}

module.exports = { MigrationSecondLegObserver };
