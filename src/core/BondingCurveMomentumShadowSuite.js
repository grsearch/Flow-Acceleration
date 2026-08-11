'use strict';

const { costBreakdown } = require('./CostModel');

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

function rawSol(value) {
  try {
    return Number(BigInt(value || 0)) / 1e9;
  } catch (_) {
    return null;
  }
}

function shadowPrice(trade) {
  const reservePrice = finite(trade?.reservePrice);
  return reservePrice > 0 ? reservePrice : finite(trade?.price);
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
    entryTargetAt: value('entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: value('entry_deadline_at', 'entryDeadlineAt'),
    entryAt: value('entry_at', 'entryAt'),
    entryMarket: value('entry_market', 'entryMarket'),
    entryPrice: value('entry_price', 'entryPrice'),
    entryJumpPct: value('entry_jump_pct', 'entryJumpPct'),
    highestPrice: value('highest_price', 'highestPrice'),
    lowestPrice: value('lowest_price', 'lowestPrice'),
    lastObservedAt: value('last_observed_at', 'lastObservedAt'),
    lastPrice: value('last_price', 'lastPrice'),
    maxFavorableReturnPct: finite(value('max_favorable_return_pct', 'maxFavorableReturnPct'), 0),
    maxAdverseReturnPct: finite(value('max_adverse_return_pct', 'maxAdverseReturnPct'), 0),
    trailingActivatedAt: value('trailing_activated_at', 'trailingActivatedAt'),
    exitMode: value('exit_mode', 'exitMode'),
    fixedHoldMs: value('fixed_hold_ms', 'fixedHoldMs'),
    minHoldMs: value('min_hold_ms', 'minHoldMs'),
    maxHoldMs: value('max_hold_ms', 'maxHoldMs'),
    trailingActivationPct: value('trailing_activation_pct', 'trailingActivationPct'),
    trailingStopPct: value('trailing_stop_pct', 'trailingStopPct'),
    exitTriggerAt: value('exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: value('exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: value('exit_deadline_at', 'exitDeadlineAt'),
    exitReason: value('exit_reason', 'exitReason'),
  };
}

class BondingCurveMomentumShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((profile) => [profile.id, profile]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((profile) => [profile.id, profile]));
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.episodeTrackers = new Map();
    this.episodesByMint = new Map();
    this.snapshotHorizonsMs = [...new Set(config.snapshotHorizonsMs || [])]
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    this.maxSnapshotHorizonMs = Math.max(0, ...this.snapshotHorizonsMs);
    this.maxEntryProfileAgeMs = Math.max(0, ...[...this.entryProfiles.values()]
      .map((profile) => profile.maxAgeMs || 0));
    this.metrics = {
      curveTrades: 0,
      evaluated: 0,
      signals: 0,
      replaySignalsSuppressed: 0,
      activeRuleSuppressed: 0,
      cooldownSuppressed: 0,
      activePositionSuppressed: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      closed: 0,
      noExit: 0,
      snapshotsWritten: 0,
      snapshotsMissed: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.store.activeBondingCurveMomentumShadowPositions()) {
      const position = rowPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._indexPosition(position);
    }

    const now = this.now();
    const restoreSince = now - this.maxSnapshotHorizonMs - this.config.maxSnapshotLagMs;
    for (const row of this.store.recentBondingCurveMomentumEpisodes(restoreSince)) {
      this._restoreEpisodeTracker(row);
    }

    const replayLookbackMs = Math.max(
      this.config.stateWindowMs,
      this.maxSnapshotHorizonMs + this.config.maxSnapshotLagMs,
      this.maxEntryProfileAgeMs,
    );
    const replayTrades = [
      ...this.store.recentCurveTrades(now - replayLookbackMs),
      ...this.store.recentAmmTrades(now - replayLookbackMs),
    ].sort((left, right) => left.timestampMs - right.timestampMs);
    for (const trade of replayTrades) this.observeTrade(trade, { replay: true });
    this.advanceTime(now);
  }

  stop() {}

  trackedMints() {
    return [...new Set([
      ...this.rowsByMint.keys(),
      ...this.episodesByMint.keys(),
    ])];
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_H',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      trackedEpisodes: this.episodeTrackers.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        scope: 'PRE_MIGRATION_PUMP_BONDING_CURVE',
        signalEdge: 'FALSE_TO_TRUE_WITH_PER_MINT_COOLDOWN',
        entryDelayMs: this.config.entryDelayMs,
        entryTimeoutMs: this.config.entryTimeoutMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        snapshotHorizonsMs: this.snapshotHorizonsMs,
        maxSnapshotLagMs: this.config.maxSnapshotLagMs,
        research: {
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          isolatedPositionTable: 'bonding_curve_momentum_shadow_positions',
          isolatedSnapshotTable: 'bonding_curve_momentum_shadow_snapshots',
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  observeTrade(trade, { replay = false } = {}) {
    const timestampMs = finite(trade?.timestampMs);
    const price = shadowPrice(trade);
    if (!this.config.enabled || !trade?.mint || !(timestampMs > 0) || !(price > 0)
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade.market)) return;

    this.advanceTime(timestampMs);
    let features = this.states.get(trade.mint)?.lastFeatures || null;
    if (trade.market === 'PUMP_BONDING_CURVE' && this._isPreMigrationTrade(trade)) {
      features = this._observeCurveState(trade, price);
      this.metrics.curveTrades += 1;
    }

    // Curve-derived order-flow features become stale after migration. Continue
    // marking prices from PumpSwap, but never let stale curve flow trigger an exit.
    const liveCurveFeatures = trade.market === 'PUMP_BONDING_CURVE' ? features : null;
    this._observeEpisodeTrackers(trade, price, liveCurveFeatures);
    this._observePositions(trade, price, liveCurveFeatures);

    if (trade.market !== 'PUMP_BONDING_CURVE' || !this._isPreMigrationTrade(trade)
      || !features) return;
    this._evaluateEntryProfiles(trade, price, features, replay);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateBondingCurveMomentumShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'NO_BONDING_CURVE_TRADE_WITHIN_ENTRY_WINDOW',
      });
      this.pendingEntries.delete(pending.id);
      this._unindexPosition(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      const ageMs = now - position.entryAt;
      if (position.exitMode === 'FIXED_HOLD' && ageMs >= position.fixedHoldMs) {
        this._requestExit(position, position.entryAt + position.fixedHoldMs, 'FIXED_HOLD_3S');
      } else if (ageMs >= position.maxHoldMs) {
        this._requestExit(position, position.entryAt + position.maxHoldMs, 'MAX_HOLD');
      }
    }
    for (const tracker of [...this.episodeTrackers.values()]) {
      this._markMissedSnapshots(tracker, now);
      if (tracker.captured.size >= this.snapshotHorizonsMs.length) this._removeTracker(tracker);
    }
    for (const [mint, state] of this.states) {
      if (now - state.lastTimestampMs
        <= Math.max(this.config.stateRetentionMs, this.maxEntryProfileAgeMs)) continue;
      if (this.rowsByMint.has(mint) || this.episodesByMint.has(mint)) continue;
      this.states.delete(mint);
    }
  }

  _isPreMigrationTrade(trade) {
    const graduatedAt = finite(this.store.getToken(trade.mint)?.graduated_at);
    return !(graduatedAt > 0) || trade.timestampMs < graduatedAt;
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = {
        events: [],
        firstBuyAt: new Map(),
        profileStates: new Map(),
        lastTimestampMs: 0,
        lastFeatures: null,
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _observeCurveState(trade, price) {
    const state = this._state(trade.mint);
    if (state.lastTimestampMs && trade.timestampMs < state.lastTimestampMs) return state.lastFeatures;
    state.lastTimestampMs = trade.timestampMs;
    const event = {
      timestampMs: trade.timestampMs,
      side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      price,
      curvePct: finite(trade.curvePct),
      virtualSol: rawSol(trade.virtualSolReservesRaw),
    };
    state.events.push(event);
    if (event.side === 'BUY' && event.wallet && !state.firstBuyAt.has(event.wallet)) {
      state.firstBuyAt.set(event.wallet, event.timestampMs);
    }
    const cutoff = trade.timestampMs - this.config.stateWindowMs;
    while (state.events.length && state.events[0].timestampMs < cutoff) state.events.shift();
    state.lastFeatures = this._features(state, trade, event);
    return state.lastFeatures;
  }

  _window(state, startAt, endAt, includeEnd = true) {
    const events = state.events.filter((event) => (
      event.timestampMs >= startAt
      && (includeEnd ? event.timestampMs <= endAt : event.timestampMs < endAt)
    ));
    const buys = events.filter((event) => event.side === 'BUY');
    const sells = events.filter((event) => event.side === 'SELL');
    const buySol = buys.reduce((sum, event) => sum + event.solAmount, 0);
    const sellSol = sells.reduce((sum, event) => sum + event.solAmount, 0);
    const walletSol = new Map();
    for (const event of buys) {
      if (!event.wallet) continue;
      walletSol.set(event.wallet, (walletSol.get(event.wallet) || 0) + event.solAmount);
    }
    return {
      buySol,
      sellSol,
      netFlow: buySol - sellSol,
      buyTx: buys.length,
      sellTx: sells.length,
      buyers: walletSol.size,
      top1SharePct: buySol > 0 ? Math.max(0, ...walletSol.values()) / buySol * 100 : 100,
    };
  }

  _features(state, trade, event) {
    const now = trade.timestampMs;
    const current1 = this._window(state, now - 1_000, now);
    const prior1 = this._window(state, now - 2_000, now - 1_000, false);
    const windows = {};
    for (const width of [250, 500, 2_000, 5_000]) {
      windows[width] = this._window(state, now - width, now);
    }
    const newBuyers1 = [...state.firstBuyAt.values()]
      .filter((firstAt) => firstAt >= now - 1_000 && firstAt <= now).length;
    const before1 = [...state.events].reverse().find((row) => row.timestampMs < now - 1_000);
    const before2 = [...state.events].reverse().find((row) => row.timestampMs < now - 2_000);
    const curveDelta1 = event.curvePct != null && before1?.curvePct != null
      ? event.curvePct - before1.curvePct : null;
    const priorCurveDelta1 = before1?.curvePct != null && before2?.curvePct != null
      ? before1.curvePct - before2.curvePct : null;
    const token = this.store.getToken(trade.mint);
    const createdAt = finite(token?.created_at ?? token?.createdAt);
    return {
      timestampMs: now,
      ageMs: createdAt == null ? null : Math.max(0, now - createdAt),
      curvePct: event.curvePct,
      virtualSolReserves: event.virtualSol,
      virtualSolDelta1: event.virtualSol != null && before1?.virtualSol != null
        ? event.virtualSol - before1.virtualSol : null,
      curveDelta1,
      curveAccel1: curveDelta1 != null && priorCurveDelta1 != null
        ? curveDelta1 - priorCurveDelta1 : null,
      netFlow250ms: windows[250].netFlow,
      netFlow500ms: windows[500].netFlow,
      netFlow1s: current1.netFlow,
      netFlow2s: windows[2_000].netFlow,
      netFlow5s: windows[5_000].netFlow,
      priorNetFlow1s: prior1.netFlow,
      flowAccel1s: current1.netFlow - prior1.netFlow,
      flowImpulse1s: current1.netFlow - windows[5_000].netFlow / 5,
      buySol1s: current1.buySol,
      sellSol1s: current1.sellSol,
      priorSellSol1s: prior1.sellSol,
      sellDecayRatio: current1.sellSol / Math.max(prior1.sellSol, 0.05),
      buyers1s: current1.buyers,
      newBuyers1s: newBuyers1,
      buyTx1s: current1.buyTx,
      sellTx1s: current1.sellTx,
      priorBuyTx1s: prior1.buyTx,
      buyTxAccel1s: current1.buyTx - prior1.buyTx,
      top1SharePct: current1.top1SharePct,
    };
  }

  _profilePasses(profile, features) {
    const checks = [
      ['minAgeMs', (value) => features.ageMs >= value],
      ['maxAgeMs', (value) => features.ageMs <= value],
      ['minCurvePct', (value) => features.curvePct >= value],
      ['maxCurvePct', (value) => features.curvePct <= value],
      ['minNetFlow1s', (value) => features.netFlow1s >= value],
      ['minFlowAccel1s', (value) => features.flowAccel1s >= value],
      ['minBuyers1s', (value) => features.buyers1s >= value],
      ['minNewBuyers1s', (value) => features.newBuyers1s >= value],
      ['minBuyTx1s', (value) => features.buyTx1s >= value],
      ['minBuyTxAccel1s', (value) => features.buyTxAccel1s >= value],
      ['maxTop1SharePct', (value) => features.top1SharePct <= value],
      ['minPriorSellSol1s', (value) => features.priorSellSol1s >= value],
      ['maxSellDecayRatio', (value) => features.sellDecayRatio <= value],
    ];
    return checks.every(([key, predicate]) => profile[key] == null || predicate(profile[key]));
  }

  _evaluateEntryProfiles(trade, price, features, replay) {
    const state = this._state(trade.mint);
    for (const profile of this.entryProfiles.values()) {
      this.metrics.evaluated += 1;
      let profileState = state.profileStates.get(profile.id);
      if (!profileState) {
        profileState = { active: false, lastSignalAt: -Infinity };
        state.profileStates.set(profile.id, profileState);
      }
      const pass = this._profilePasses(profile, features);
      if (!pass) {
        profileState.active = false;
        continue;
      }
      if (profileState.active) {
        this.metrics.activeRuleSuppressed += 1;
        continue;
      }
      profileState.active = true;
      if (trade.timestampMs - profileState.lastSignalAt < this.config.episodeCooldownMs) {
        this.metrics.cooldownSuppressed += 1;
        continue;
      }
      profileState.lastSignalAt = trade.timestampMs;
      if (replay) {
        this.metrics.replaySignalsSuppressed += 1;
        continue;
      }
      this._emitSignal(profile, trade, price, features);
    }
  }

  _emitSignal(profile, trade, price, features) {
    const episodeId = `${trade.mint}:${profile.id}:${trade.timestampMs}`;
    this.metrics.signals += 1;
    this._createEpisodeTracker({
      episodeId,
      entryProfileId: profile.id,
      mint: trade.mint,
      symbol: trade.symbol || this.store.getToken(trade.mint)?.symbol || null,
      signalAt: trade.timestampMs,
      signalPrice: price,
    });
    for (const exitProfile of this.exitProfiles.values()) {
      const cohortId = `${profile.id}_${exitProfile.id}`;
      if (this._hasActiveCohortMint(cohortId, trade.mint)) {
        this.metrics.activePositionSuppressed += 1;
        continue;
      }
      const saved = this.store.createBondingCurveMomentumShadowPosition({
        cohortId,
        entryProfileId: profile.id,
        exitProfileId: exitProfile.id,
        episodeId,
        mint: trade.mint,
        symbol: trade.symbol || this.store.getToken(trade.mint)?.symbol || null,
        status: STATUS.PENDING_ENTRY,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        signalAt: trade.timestampMs,
        signalPrice: price,
        features,
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
        exitMode: exitProfile.exitMode,
        fixedHoldMs: exitProfile.fixedHoldMs,
        minHoldMs: exitProfile.minHoldMs,
        maxHoldMs: exitProfile.maxHoldMs,
        trailingActivationPct: exitProfile.trailingActivationPct,
        trailingStopPct: exitProfile.trailingStopPct,
      });
      if (!saved?.inserted) continue;
      const pending = rowPosition(saved);
      this.pendingEntries.set(pending.id, pending);
      this._indexPosition(pending);
    }
    this.metrics.lastActionAt = this.now();
  }

  _observePositions(trade, price, features) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (trade.market !== 'PUMP_BONDING_CURVE' || !this._isPreMigrationTrade(trade)
          || trade.timestampMs < position.entryTargetAt
          || trade.timestampMs > position.entryDeadlineAt) continue;
        const jumpPct = ((price / position.signalPrice) - 1) * 100;
        if (jumpPct > this.config.maxEntryPriceJumpPct) {
          this.store.updateBondingCurveMomentumShadowPosition(position.id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
          });
          this.pendingEntries.delete(position.id);
          this._unindexPosition(position);
          this.metrics.priceJump += 1;
          continue;
        }
        position.status = STATUS.OPEN;
        position.entryAt = trade.timestampMs;
        position.entryMarket = trade.market;
        position.entryPrice = price;
        position.entryJumpPct = jumpPct;
        position.highestPrice = price;
        position.lowestPrice = price;
        position.lastObservedAt = trade.timestampMs;
        position.lastPrice = price;
        this.store.updateBondingCurveMomentumShadowPosition(position.id, {
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
        if (!this._eligibleExitTrade(position, trade, price)) continue;
        if (trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
        continue;
      }
      if (position.status !== STATUS.OPEN || trade.timestampMs < position.entryAt
        || !this._eligibleExitTrade(position, trade, price)) continue;
      this._updateExtrema(position, trade.timestampMs, price);
      this._evaluateExit(position, trade.timestampMs, price, features);
    }
  }

  _eligibleExitTrade(position, trade, price) {
    const graduatedAt = finite(this.store.getToken(position.mint)?.graduated_at);
    if (trade.market === 'PUMP_BONDING_CURVE') {
      return !(graduatedAt > 0) || trade.timestampMs < graduatedAt;
    }
    if (trade.market !== 'PUMP_AMM' || !(graduatedAt > 0) || trade.timestampMs < graduatedAt) {
      return false;
    }
    const ratio = price / position.entryPrice;
    return ratio >= 0.05 && ratio <= 20;
  }

  _flowReversed(features) {
    if (!features) return false;
    if (features.netFlow1s <= this.config.flowExitNetFlowSol) return true;
    return features.buyTxAccel1s <= this.config.flowExitMaxBuyTxAccel
      && features.sellSol1s >= this.config.flowExitMinSellSol
      && features.sellSol1s > features.priorSellSol1s;
  }

  _evaluateExit(position, timestampMs, price, features) {
    const ageMs = timestampMs - position.entryAt;
    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    const drawdownPct = ((price / position.highestPrice) - 1) * -100;
    let reason = null;
    let triggerAt = timestampMs;
    if (position.exitMode === 'FIXED_HOLD' && ageMs >= position.fixedHoldMs) {
      reason = 'FIXED_HOLD_3S';
      triggerAt = position.entryAt + position.fixedHoldMs;
    } else if (position.exitMode === 'FLOW_REVERSAL') {
      if (ageMs >= position.minHoldMs && this._flowReversed(features)) reason = 'FLOW_REVERSAL';
      if (!reason && ageMs >= position.maxHoldMs) {
        reason = 'FLOW_MAX_HOLD';
        triggerAt = position.entryAt + position.maxHoldMs;
      }
    } else if (position.exitMode === 'WINNER_TRAIL') {
      if (!position.trailingActivatedAt && peakReturnPct >= position.trailingActivationPct) {
        position.trailingActivatedAt = timestampMs;
        this.store.updateBondingCurveMomentumShadowPosition(position.id, {
          trailingActivatedAt: timestampMs,
        });
      }
      if (position.trailingActivatedAt && drawdownPct >= position.trailingStopPct) {
        reason = 'WINNER_TRAILING_STOP';
      }
      if (!reason && !position.trailingActivatedAt && ageMs >= position.minHoldMs
        && this._flowReversed(features)) reason = 'PRE_ACTIVATION_FLOW_REVERSAL';
      if (!reason && ageMs >= position.maxHoldMs) {
        reason = 'WINNER_MAX_HOLD';
        triggerAt = position.entryAt + position.maxHoldMs;
      }
    }
    if (reason) this._requestExit(position, triggerAt, reason);
  }

  _updateExtrema(position, timestampMs, price) {
    const previousHigh = position.highestPrice || position.entryPrice;
    const previousLow = position.lowestPrice || position.entryPrice;
    position.highestPrice = Math.max(previousHigh, price);
    position.lowestPrice = Math.min(previousLow, price);
    position.lastObservedAt = timestampMs;
    position.lastPrice = price;
    position.maxFavorableReturnPct = Math.max(
      position.maxFavorableReturnPct || 0,
      ((position.highestPrice / position.entryPrice) - 1) * 100,
    );
    position.maxAdverseReturnPct = Math.min(
      position.maxAdverseReturnPct || 0,
      ((position.lowestPrice / position.entryPrice) - 1) * 100,
    );
    this.store.updateBondingCurveMomentumShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updateBondingCurveMomentumShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
    this.metrics.lastActionAt = this.now();
  }

  _close(position, trade, price) {
    this._updateExtrema(position, trade.timestampMs, price);
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    this.store.updateBondingCurveMomentumShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
      grossReturnPct,
      netReturnPct: grossReturnPct - this.costs.deterministicCostPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.positions.delete(position.id);
    this._unindexPosition(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateBondingCurveMomentumShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      grossReturnPct: -100,
      netReturnPct: -100 - this.costs.deterministicCostPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.positions.delete(position.id);
    this._unindexPosition(position);
    this.metrics.closed += 1;
    this.metrics.noExit += 1;
    this.metrics.lastActionAt = this.now();
  }

  _createEpisodeTracker(row) {
    if (this.episodeTrackers.has(row.episodeId)) return this.episodeTrackers.get(row.episodeId);
    const tracker = {
      ...row,
      highestPrice: row.signalPrice,
      lowestPrice: row.signalPrice,
      lastTradeAt: row.signalAt,
      captured: new Set(),
    };
    this.episodeTrackers.set(tracker.episodeId, tracker);
    let ids = this.episodesByMint.get(tracker.mint);
    if (!ids) {
      ids = new Set();
      this.episodesByMint.set(tracker.mint, ids);
    }
    ids.add(tracker.episodeId);
    return tracker;
  }

  _restoreEpisodeTracker(row) {
    const tracker = this._createEpisodeTracker({
      episodeId: row.episode_id,
      entryProfileId: row.entry_profile_id,
      mint: row.mint,
      symbol: row.symbol,
      signalAt: row.signal_at,
      signalPrice: row.signal_price,
    });
    for (const horizon of this.store.bondingCurveMomentumSnapshotHorizons(row.episode_id)) {
      tracker.captured.add(Number(horizon));
    }
  }

  _observeEpisodeTrackers(trade, price, features) {
    for (const episodeId of [...(this.episodesByMint.get(trade.mint) || [])]) {
      const tracker = this.episodeTrackers.get(episodeId);
      if (!tracker || trade.timestampMs < tracker.signalAt) continue;
      tracker.highestPrice = Math.max(tracker.highestPrice, price);
      tracker.lowestPrice = Math.min(tracker.lowestPrice, price);
      tracker.lastTradeAt = trade.timestampMs;
      for (const horizonMs of this.snapshotHorizonsMs) {
        if (tracker.captured.has(horizonMs)) continue;
        const targetAt = tracker.signalAt + horizonMs;
        if (trade.timestampMs < targetAt) continue;
        if (trade.timestampMs - targetAt > this.config.maxSnapshotLagMs) continue;
        const grossReturnPct = ((price / tracker.signalPrice) - 1) * 100;
        const saved = this.store.recordBondingCurveMomentumShadowSnapshot({
          episodeId: tracker.episodeId,
          entryProfileId: tracker.entryProfileId,
          mint: tracker.mint,
          horizonMs,
          status: 'OBSERVED',
          targetAt,
          observedAt: trade.timestampMs,
          observationLagMs: trade.timestampMs - targetAt,
          market: trade.market,
          price,
          grossReturnPct,
          maxFavorableReturnPct: ((tracker.highestPrice / tracker.signalPrice) - 1) * 100,
          maxAdverseReturnPct: ((tracker.lowestPrice / tracker.signalPrice) - 1) * 100,
          features,
        });
        tracker.captured.add(horizonMs);
        if (saved.inserted) this.metrics.snapshotsWritten += 1;
      }
      if (tracker.captured.size >= this.snapshotHorizonsMs.length) this._removeTracker(tracker);
    }
  }

  _markMissedSnapshots(tracker, now) {
    for (const horizonMs of this.snapshotHorizonsMs) {
      if (tracker.captured.has(horizonMs)) continue;
      const targetAt = tracker.signalAt + horizonMs;
      if (now <= targetAt + this.config.maxSnapshotLagMs) continue;
      const saved = this.store.recordBondingCurveMomentumShadowSnapshot({
        episodeId: tracker.episodeId,
        entryProfileId: tracker.entryProfileId,
        mint: tracker.mint,
        horizonMs,
        status: 'NO_TRADE',
        targetAt,
        observedAt: null,
        observationLagMs: null,
        market: null,
        price: null,
        grossReturnPct: null,
        maxFavorableReturnPct: ((tracker.highestPrice / tracker.signalPrice) - 1) * 100,
        maxAdverseReturnPct: ((tracker.lowestPrice / tracker.signalPrice) - 1) * 100,
        features: null,
      });
      tracker.captured.add(horizonMs);
      if (saved.inserted) {
        this.metrics.snapshotsWritten += 1;
        this.metrics.snapshotsMissed += 1;
      }
    }
  }

  _removeTracker(tracker) {
    this.episodeTrackers.delete(tracker.episodeId);
    const ids = this.episodesByMint.get(tracker.mint);
    if (!ids) return;
    ids.delete(tracker.episodeId);
    if (!ids.size) this.episodesByMint.delete(tracker.mint);
  }

  _indexPosition(position) {
    let ids = this.rowsByMint.get(position.mint);
    if (!ids) {
      ids = new Set();
      this.rowsByMint.set(position.mint, ids);
    }
    ids.add(position.id);
  }

  _unindexPosition(position) {
    const ids = this.rowsByMint.get(position.mint);
    if (!ids) return;
    ids.delete(position.id);
    if (!ids.size) this.rowsByMint.delete(position.mint);
  }

  _hasActiveCohortMint(cohortId, mint) {
    for (const id of this.rowsByMint.get(mint) || []) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (position?.cohortId === cohortId) return true;
    }
    return false;
  }
}

module.exports = { BondingCurveMomentumShadowSuite, STATUS, shadowPrice };
