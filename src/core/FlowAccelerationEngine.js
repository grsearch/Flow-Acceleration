'use strict';

const EventEmitter = require('events');

function sum(items, select) {
  let total = 0;
  for (const item of items) total += select(item);
  return total;
}

function uniqueWallets(items) {
  return new Set(items.map((item) => item.wallet).filter(Boolean)).size;
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

const SIGNAL_VARIANTS = Object.freeze({
  PRIMARY: 'primary_3w',
  TWO_WINDOW: 'shadow_2w',
  NETFLOW_BREAKOUT: 'shadow_netflow_breakout',
});

class FlowAccelerationEngine extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.primaryThresholdProfiles = (config.primaryThresholdProfiles || [])
      .filter((profile) => profile?.id && profile?.signalVariant)
      .map((profile) => ({
        id: String(profile.id),
        signalVariant: String(profile.signalVariant),
        minNetFlowW3Sol: Math.max(0, Number(profile.minNetFlowW3Sol) || 0),
        minUniqueBuyersW3: Math.max(0, Math.trunc(Number(profile.minUniqueBuyersW3) || 0)),
      }));
    this.states = new Map();
    this.tokens = new Map();
    this.graduated = new Set();
    this.metrics = {
      rawTrades: 0,
      candidatesCreated: 0,
      signalsCreated: 0,
      shadowSignalsCreated: 0,
      primaryThresholdSignalsCreated: 0,
      lastTradeAt: null,
      lastSignalAt: null,
      lastShadowSignalAt: null,
    };
  }

  hydrateTokens(tokens) {
    for (const token of tokens || []) {
      this.tokens.set(token.mint, token);
      if (token.graduated_at) this.graduated.add(token.mint);
    }
  }

  hydrateTrades(trades) {
    const ordered = [...(trades || [])]
      .filter((trade) => trade?.market === 'PUMP_BONDING_CURVE'
        && trade.mint && Number.isFinite(trade.timestampMs))
      .sort((left, right) => left.timestampMs - right.timestampMs);
    for (const trade of ordered) {
      const state = this._state(trade.mint);
      state.events.push(trade);
      state.lastTradeAt = Math.max(state.lastTradeAt, trade.timestampMs);
    }
    const now = Date.now();
    for (const state of this.states.values()) this._prune(state, now);
  }

  recentBuyContext(mint, timestampMs, windowMs = 2_000, excludeWallet = null) {
    const state = this.states.get(mint);
    const width = Math.max(1, Number(windowMs) || 2_000);
    const start = timestampMs - width;
    const events = (state?.events || []).filter((event) => (
      event.timestampMs >= start
      && event.timestampMs <= timestampMs
      && (!excludeWallet || event.wallet !== excludeWallet)
    ));
    const buys = events.filter((event) => event.side === 'BUY');
    const sells = events.filter((event) => event.side === 'SELL');
    const buyFlowSol = sum(buys, (event) => event.solAmount);
    const sellFlowSol = sum(sells, (event) => event.solAmount);
    return {
      windowMs: width,
      uniqueBuyers: uniqueWallets(buys),
      buyTx: buys.length,
      sellTx: sells.length,
      buyFlowSol: round(buyFlowSol, 8),
      sellFlowSol: round(sellFlowSol, 8),
      netFlowSol: round(buyFlowSol - sellFlowSol, 8),
    };
  }

  handleCreate(token) {
    const current = this.tokens.get(token.mint) || {};
    const merged = { ...current, ...token };
    this.tokens.set(token.mint, merged);
    if (merged.graduated_at) this.graduated.add(token.mint);
    else this.graduated.delete(token.mint);
  }

  handleComplete(event) {
    this.graduated.add(event.mint);
    const token = this.tokens.get(event.mint) || { mint: event.mint };
    this.tokens.set(event.mint, {
      ...token,
      graduated_at: event.completedAt || event.timestampMs || Date.now(),
    });
    const state = this.states.get(event.mint);
    if (state) {
      state.candidateSince = null;
      state.signalActive = false;
      state.variantActive.clear();
      state.triggeredPrimaryThresholds.clear();
    }
    this.emit('graduated', event);
  }

  handleTrade(trade, token = null) {
    if (!trade || trade.market !== 'PUMP_BONDING_CURVE') return null;
    if (!trade.mint || !Number.isFinite(trade.timestampMs)) return null;
    if (!Number.isFinite(trade.solAmount) || trade.solAmount <= 0) return null;

    this.metrics.rawTrades += 1;
    this.metrics.lastTradeAt = trade.timestampMs;
    if (token) this.tokens.set(trade.mint, { ...(this.tokens.get(trade.mint) || {}), ...token });
    if (this.graduated.has(trade.mint)) return null;

    const state = this._state(trade.mint);
    state.events.push(trade);
    state.lastTradeAt = trade.timestampMs;
    this._prune(state, trade.timestampMs);

    if (!state.candidateSince) {
      const activity = this._activity(state, trade.timestampMs);
      if (this._wakes(activity)) {
        state.candidateSince = trade.timestampMs;
        this.metrics.candidatesCreated += 1;
        this.emit('candidate', {
          mint: trade.mint,
          symbol: token?.symbol || this.tokens.get(trade.mint)?.symbol || null,
          timestampMs: trade.timestampMs,
          ...activity,
        });
      }
    }

    if (!state.candidateSince) return null;
    const metrics = this._signalMetrics(state, trade.timestampMs);
    const variants = [
      [SIGNAL_VARIANTS.PRIMARY, this._isSignal(metrics), true],
      [SIGNAL_VARIANTS.TWO_WINDOW, this._isTwoWindowSignal(metrics), false],
      [SIGNAL_VARIANTS.NETFLOW_BREAKOUT, this._isNetFlowBreakout(metrics), false],
    ];
    const tokenInfo = token || this.tokens.get(trade.mint) || {};
    let primarySignal = null;
    for (const [signalVariant, matches, isPrimary] of variants) {
      if (!matches) {
        state.variantActive.set(signalVariant, false);
        if (isPrimary) state.signalActive = false;
        continue;
      }
      if (state.variantActive.get(signalVariant)) continue;
      state.variantActive.set(signalVariant, true);
      if (isPrimary) state.signalActive = true;

      const lastSignalAt = state.lastSignalByVariant.get(signalVariant) || 0;
      if (trade.timestampMs - lastSignalAt < this.config.signalCooldownMs) continue;
      const signal = {
        timestampMs: trade.timestampMs,
        slot: trade.slot || null,
        signature: trade.signature || null,
        mint: trade.mint,
        symbol: tokenInfo.symbol || null,
        ageMs: Number.isFinite(trade.ageMs) ? trade.ageMs : null,
        curvePct: Number.isFinite(trade.curvePct) ? trade.curvePct : null,
        price: trade.price,
        signalVariant,
        isPrimary,
        ...metrics,
      };
      state.lastSignalByVariant.set(signalVariant, trade.timestampMs);
      if (isPrimary) {
        state.lastSignalAt = trade.timestampMs;
        this.metrics.signalsCreated += 1;
        this.metrics.lastSignalAt = trade.timestampMs;
        this.emit('signal', signal);
        primarySignal = signal;
      } else {
        this.metrics.shadowSignalsCreated += 1;
        this.metrics.lastShadowSignalAt = trade.timestampMs;
        this.emit('shadowSignal', signal);
      }
    }
    const primaryMatches = variants[0][1];
    for (const profile of this.primaryThresholdProfiles) {
      if (!primaryMatches
        || metrics.netFlowW3 < profile.minNetFlowW3Sol
        || metrics.uniqueBuyersW3 < profile.minUniqueBuyersW3
        || state.triggeredPrimaryThresholds.has(profile.id)) continue;

      state.triggeredPrimaryThresholds.add(profile.id);
      const signal = {
        timestampMs: trade.timestampMs,
        slot: trade.slot || null,
        signature: trade.signature || null,
        mint: trade.mint,
        symbol: tokenInfo.symbol || null,
        ageMs: Number.isFinite(trade.ageMs) ? trade.ageMs : null,
        curvePct: Number.isFinite(trade.curvePct) ? trade.curvePct : null,
        price: trade.price,
        signalVariant: profile.signalVariant,
        isPrimary: false,
        thresholdProfile: profile.id,
        ...metrics,
      };
      this.metrics.primaryThresholdSignalsCreated += 1;
      this.emit('primaryThresholdSignal', signal);
    }
    return primarySignal;
  }

  cleanup(now = Date.now()) {
    const deleteBefore = now - this.config.bufferMs;
    for (const [mint, state] of this.states) {
      this._prune(state, now);
      if (state.candidateSince && now - state.lastTradeAt > this.config.candidateIdleMs) {
        state.candidateSince = null;
        state.signalActive = false;
        state.variantActive.clear();
        state.triggeredPrimaryThresholds.clear();
      }
      if (state.events.length === 0 && state.lastTradeAt < deleteBefore) this.states.delete(mint);
    }
  }

  stats() {
    let candidateCount = 0;
    let bufferedTrades = 0;
    for (const state of this.states.values()) {
      if (state.candidateSince) candidateCount += 1;
      bufferedTrades += state.events.length;
    }
    return {
      ...this.metrics,
      trackedTokens: this.states.size,
      candidateCount,
      bufferedTrades,
      graduatedTokens: this.graduated.size,
    };
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = {
        events: [],
        candidateSince: null,
        signalActive: false,
        variantActive: new Map(),
        triggeredPrimaryThresholds: new Set(),
        lastSignalByVariant: new Map(),
        lastSignalAt: null,
        lastTradeAt: 0,
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _prune(state, now) {
    const cutoff = now - this.config.bufferMs;
    let remove = 0;
    while (remove < state.events.length && state.events[remove].timestampMs < cutoff) remove += 1;
    if (remove > 0) state.events.splice(0, remove);
  }

  _activity(state, now) {
    const start = now - this.config.activityWindowMs;
    const events = state.events.filter((event) => event.timestampMs >= start && event.timestampMs <= now);
    return {
      activityVolumeSol: round(sum(events, (event) => event.solAmount), 6),
      activityTxCount: events.length,
      activityUniqueWallets: uniqueWallets(events),
    };
  }

  _wakes(activity) {
    return activity.activityVolumeSol >= this.config.activityMinVolumeSol
      || activity.activityTxCount >= this.config.activityMinTxCount
      || activity.activityUniqueWallets >= this.config.activityMinUniqueWallets;
  }

  _signalMetrics(state, now) {
    const width = this.config.signalWindowMs;
    const ranges = [
      [now - width * 3, now - width * 2],
      [now - width * 2, now - width],
      [now - width, now + 1],
    ];
    const windows = ranges.map(([start, end], index) => state.events.filter((event) => (
      event.timestampMs >= start
      && (index === 2 ? event.timestampMs <= now : event.timestampMs < end)
    )));

    const rows = windows.map((events) => {
      const buys = events.filter((event) => event.side === 'BUY');
      const sells = events.filter((event) => event.side === 'SELL');
      const buyFlow = sum(buys, (event) => event.solAmount);
      const sellFlow = sum(sells, (event) => event.solAmount);
      return {
        buyFlow: round(buyFlow, 8),
        sellFlow: round(sellFlow, 8),
        netFlow: round(buyFlow - sellFlow, 8),
        uniqueBuyers: uniqueWallets(buys),
        buyTx: buys.length,
      };
    });

    const delta12 = rows[1].netFlow - rows[0].netFlow;
    const delta23 = rows[2].netFlow - rows[1].netFlow;
    const ratio = (next, previous) => previous > this.config.ratioFloorSol
      ? round(next / previous, 6)
      : null;
    const flowAccel1 = ratio(rows[1].netFlow, rows[0].netFlow);
    const flowAccel2 = ratio(rows[2].netFlow, rows[1].netFlow);
    const finiteAcceleration = [flowAccel1, flowAccel2].filter(Number.isFinite);

    return {
      buyFlowW1: rows[0].buyFlow,
      buyFlowW2: rows[1].buyFlow,
      buyFlowW3: rows[2].buyFlow,
      sellFlowW1: rows[0].sellFlow,
      sellFlowW2: rows[1].sellFlow,
      sellFlowW3: rows[2].sellFlow,
      netFlowW1: rows[0].netFlow,
      netFlowW2: rows[1].netFlow,
      netFlowW3: rows[2].netFlow,
      deltaNetFlow12: round(delta12, 8),
      deltaNetFlow23: round(delta23, 8),
      flowAccel1,
      flowAccel2,
      flowAccel: finiteAcceleration.length ? Math.min(...finiteAcceleration) : null,
      uniqueBuyersW1: rows[0].uniqueBuyers,
      uniqueBuyersW2: rows[1].uniqueBuyers,
      uniqueBuyersW3: rows[2].uniqueBuyers,
      buyTxW1: rows[0].buyTx,
      buyTxW2: rows[1].buyTx,
      buyTxW3: rows[2].buyTx,
    };
  }

  _isSignal(metrics) {
    const netIncreasing = metrics.netFlowW1 < metrics.netFlowW2
      && metrics.netFlowW2 < metrics.netFlowW3;
    if (!netIncreasing || metrics.netFlowW3 < this.config.minNetFlowW3Sol) return false;
    if (metrics.deltaNetFlow12 < this.config.minNetFlowDeltaSol
      || metrics.deltaNetFlow23 < this.config.minNetFlowDeltaSol) return false;

    const ratios = [metrics.flowAccel1, metrics.flowAccel2].filter(Number.isFinite);
    if (ratios.some((value) => value < this.config.minAccelerationRatio)) return false;

    const buyersIncreasing = metrics.uniqueBuyersW1 <= metrics.uniqueBuyersW2
      && metrics.uniqueBuyersW2 < metrics.uniqueBuyersW3;
    const txIncreasing = metrics.buyTxW1 <= metrics.buyTxW2
      && metrics.buyTxW2 < metrics.buyTxW3;
    return buyersIncreasing && txIncreasing;
  }

  _isTwoWindowSignal(metrics) {
    if (metrics.netFlowW2 >= metrics.netFlowW3
      || metrics.netFlowW3 < this.config.minNetFlowW3Sol
      || metrics.deltaNetFlow23 < this.config.minNetFlowDeltaSol) return false;
    if (Number.isFinite(metrics.flowAccel2)
      && metrics.flowAccel2 < this.config.minAccelerationRatio) return false;
    return metrics.uniqueBuyersW2 < metrics.uniqueBuyersW3
      && metrics.buyTxW2 < metrics.buyTxW3;
  }

  _isNetFlowBreakout(metrics) {
    return metrics.netFlowW2 < metrics.netFlowW3
      && metrics.netFlowW3 >= this.config.minNetFlowW3Sol
      && metrics.deltaNetFlow23 >= this.config.minNetFlowDeltaSol
      && metrics.uniqueBuyersW2 < metrics.uniqueBuyersW3
      && metrics.buyTxW2 < metrics.buyTxW3;
  }
}

module.exports = FlowAccelerationEngine;
