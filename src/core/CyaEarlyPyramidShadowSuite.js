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

function shadowPrice(trade) {
  const reservePrice = finite(trade?.reservePrice);
  return reservePrice > 0 ? reservePrice : finite(trade?.price);
}

function rowPosition(row) {
  const value = (snake, camel) => row[snake] ?? row[camel];
  const number = (snake, camel, fallback = null) => finite(value(snake, camel), fallback);
  return {
    id: row.id,
    cohortId: value('cohort_id', 'cohortId'),
    entryProfileId: value('entry_profile_id', 'entryProfileId'),
    exitProfileId: value('exit_profile_id', 'exitProfileId'),
    episodeId: value('episode_id', 'episodeId'),
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    positionSol: number('position_sol', 'positionSol', 1),
    signalAt: number('signal_at', 'signalAt'),
    signalPrice: number('signal_price', 'signalPrice'),
    entryTargetAt: number('entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: number('entry_deadline_at', 'entryDeadlineAt'),
    entryAt: number('entry_at', 'entryAt'),
    entryMarket: value('entry_market', 'entryMarket'),
    entryPrice: number('entry_price', 'entryPrice'),
    entryJumpPct: number('entry_jump_pct', 'entryJumpPct'),
    averageEntryPrice: number('average_entry_price', 'averageEntryPrice'),
    totalInvestedSol: number('total_invested_sol', 'totalInvestedSol', 0),
    tokenUnits: number('token_units', 'tokenUnits', 0),
    remainingTokenUnits: number('remaining_token_units', 'remainingTokenUnits', 0),
    realizedProceedsSol: number('realized_proceeds_sol', 'realizedProceedsSol', 0),
    addCount: Math.max(0, Math.trunc(number('add_count', 'addCount', 0))),
    lastAddAt: number('last_add_at', 'lastAddAt'),
    lastAddPrice: number('last_add_price', 'lastAddPrice'),
    firstTakeProfitAt: number('first_take_profit_at', 'firstTakeProfitAt'),
    secondTakeProfitAt: number('second_take_profit_at', 'secondTakeProfitAt'),
    scaleOutCount: Math.max(0, Math.trunc(number('scale_out_count', 'scaleOutCount', 0))),
    highestPrice: number('highest_price', 'highestPrice'),
    lowestPrice: number('lowest_price', 'lowestPrice'),
    maxFavorableReturnPct: number('max_favorable_return_pct', 'maxFavorableReturnPct', 0),
    maxAdverseReturnPct: number('max_adverse_return_pct', 'maxAdverseReturnPct', 0),
    trailingStopPct: number('trailing_stop_pct', 'trailingStopPct'),
    hardStopPct: number('hard_stop_pct', 'hardStopPct'),
    noStrengthMs: number('no_strength_ms', 'noStrengthMs'),
    noStrengthMfePct: number('no_strength_mfe_pct', 'noStrengthMfePct'),
    maxHoldMs: number('max_hold_ms', 'maxHoldMs'),
    exitTriggerAt: number('exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: number('exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: number('exit_deadline_at', 'exitDeadlineAt'),
    exitReason: value('exit_reason', 'exitReason'),
  };
}

class CyaEarlyPyramidShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      curveTrades: 0,
      evaluated: 0,
      signals: 0,
      replaySignalsSuppressed: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      adds: 0,
      partialExits: 0,
      closed: 0,
      noExit: 0,
      lastActionAt: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.store.activeCyaEarlyPyramidShadowPositions()) {
      const position = rowPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const now = this.now();
    const replay = this.store.recentCurveTrades(now - this.config.stateWindowMs)
      .sort((left, right) => left.timestampMs - right.timestampMs);
    for (const trade of replay) this.observeTrade(trade, { replay: true });
    this.advanceTime(now);
  }

  stop() {}

  trackedMints() {
    return [...this.rowsByMint.keys()];
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_K',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        scope: 'PRE_MIGRATION_PUMP_BONDING_CURVE',
        source: 'PUBLIC_ORDER_FLOW_NOT_WALLET_FOLLOWING',
        entryDelayMs: this.config.entryDelayMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        addStepPct: this.config.addStepPct,
        addFraction: this.config.addFraction,
        maxAdds: this.config.maxAdds,
        firstTakeProfitPct: this.config.firstTakeProfitPct,
        secondTakeProfitPct: this.config.secondTakeProfitPct,
        hardStopPct: this.config.hardStopPct,
        noStrengthMs: this.config.noStrengthMs,
        noStrengthMfePct: this.config.noStrengthMfePct,
        maxHoldMs: this.config.maxHoldMs,
        research: {
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          isolatedPositionTable: 'cya_early_pyramid_shadow_positions',
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  observeTrade(trade, { replay = false } = {}) {
    const timestampMs = finite(trade?.timestampMs);
    const price = shadowPrice(trade);
    if (!this.config.enabled || !trade?.mint
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade.market)
      || !(timestampMs > 0) || !(price > 0)) return;
    this.advanceTime(timestampMs);
    let features = null;
    if (trade.market === 'PUMP_BONDING_CURVE' && this._isPreMigrationTrade(trade)) {
      features = this._observeState(trade, price);
      this.metrics.curveTrades += 1;
    }
    this._observePositions(trade, price, features);
    if (features && String(trade.side || '').toUpperCase() === 'BUY') {
      this._evaluateEntries(trade, price, features, replay);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateCyaEarlyPyramidShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'NO_BONDING_CURVE_TRADE_WITHIN_ENTRY_WINDOW',
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        this._markNoExit(position);
      } else if (position.status === STATUS.OPEN) {
        const heldMs = now - position.entryAt;
        if (heldMs >= position.maxHoldMs) {
          this._requestExit(position, position.entryAt + position.maxHoldMs, 'MAX_HOLD');
        } else if (heldMs >= position.noStrengthMs
          && position.maxFavorableReturnPct < position.noStrengthMfePct) {
          this._requestExit(position, position.entryAt + position.noStrengthMs, 'NO_STRENGTH_25S');
        }
      }
    }
    for (const [mint, state] of this.states) {
      if (now - state.lastTimestampMs <= this.config.stateRetentionMs) continue;
      if (!this.rowsByMint.has(mint)) this.states.delete(mint);
    }
  }

  _isPreMigrationTrade(trade) {
    const graduatedAt = finite(this.store.getToken(trade.mint)?.graduated_at);
    return !(graduatedAt > 0) || trade.timestampMs < graduatedAt;
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = { events: [], signaledProfiles: new Set(), lastTimestampMs: 0 };
      this.states.set(mint, state);
    }
    return state;
  }

  _observeState(trade, price) {
    const state = this._state(trade.mint);
    state.lastTimestampMs = Math.max(state.lastTimestampMs, trade.timestampMs);
    state.events.push({
      timestampMs: trade.timestampMs,
      side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      price,
    });
    const cutoff = trade.timestampMs - this.config.stateWindowMs;
    while (state.events.length && state.events[0].timestampMs < cutoff) state.events.shift();
    const window = (ms) => state.events.filter((row) => row.timestampMs >= trade.timestampMs - ms);
    const summarize = (rows) => {
      const buys = rows.filter((row) => row.side === 'BUY');
      const sells = rows.filter((row) => row.side === 'SELL');
      return {
        netFlow: buys.reduce((sum, row) => sum + row.solAmount, 0)
          - sells.reduce((sum, row) => sum + row.solAmount, 0),
        buyers: new Set(buys.map((row) => row.wallet).filter(Boolean)).size,
      };
    };
    const rows5 = window(5_000);
    const rows1 = window(1_000);
    const rows2 = window(2_000);
    const base2 = rows2[0]?.price || price;
    const token = this.store.getToken(trade.mint);
    const createdAt = finite(token?.created_at ?? token?.createdAt);
    const five = summarize(rows5);
    const one = summarize(rows1);
    return {
      ageMs: finite(trade.ageMs, createdAt == null ? null : trade.timestampMs - createdAt),
      curvePct: finite(trade.curvePct),
      buyers1s: one.buyers,
      buyers5s: five.buyers,
      netFlow1s: one.netFlow,
      netFlow5s: five.netFlow,
      return2sPct: ((price / base2) - 1) * 100,
    };
  }

  _profilePasses(profile, features) {
    return features.ageMs >= profile.minAgeMs && features.ageMs <= profile.maxAgeMs
      && features.curvePct >= profile.minCurvePct && features.curvePct <= profile.maxCurvePct
      && features.buyers5s >= profile.minBuyers5s && features.buyers5s <= profile.maxBuyers5s
      && features.netFlow5s >= profile.minNetFlow5s && features.netFlow5s <= profile.maxNetFlow5s
      && features.return2sPct <= profile.maxReturn2sPct;
  }

  _evaluateEntries(trade, price, features, replay) {
    const state = this._state(trade.mint);
    for (const profile of this.entryProfiles.values()) {
      this.metrics.evaluated += 1;
      if (state.signaledProfiles.has(profile.id) || !this._profilePasses(profile, features)) continue;
      state.signaledProfiles.add(profile.id);
      if (replay) {
        this.metrics.replaySignalsSuppressed += 1;
        continue;
      }
      this._emitSignal(profile, trade, price, features);
    }
  }

  _emitSignal(profile, trade, price, features) {
    const episodeId = `${trade.mint}:${profile.id}`;
    this.metrics.signals += 1;
    for (const exitProfile of this.exitProfiles.values()) {
      const cohortId = `${profile.id}_${exitProfile.id}`;
      const saved = this.store.createCyaEarlyPyramidShadowPosition({
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
        trailingStopPct: exitProfile.trailingStopPct,
        hardStopPct: this.config.hardStopPct,
        noStrengthMs: this.config.noStrengthMs,
        noStrengthMfePct: this.config.noStrengthMfePct,
        maxHoldMs: this.config.maxHoldMs,
      });
      if (!saved?.inserted) continue;
      const pending = rowPosition(saved);
      this.pendingEntries.set(pending.id, pending);
      this._index(pending);
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
          this.store.updateCyaEarlyPyramidShadowPosition(position.id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
          });
          this.pendingEntries.delete(position.id);
          this._unindex(position);
          this.metrics.priceJump += 1;
          continue;
        }
        this._open(position, trade, price, jumpPct);
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        if (this._eligibleExitTrade(position, trade, price)
          && trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) {
          this._close(position, trade, price);
        }
        continue;
      }
      if (position.status !== STATUS.OPEN || trade.timestampMs < position.entryAt
        || !this._eligibleExitTrade(position, trade, price)) continue;
      this._mark(position, trade.timestampMs, price);
      if (features) this._maybeAdd(position, trade, price, features);
      this._maybeScaleOut(position, trade, price);
      this._evaluateExit(position, trade.timestampMs, price);
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
    const ratio = price / (position.averageEntryPrice || position.entryPrice);
    return ratio >= 0.05 && ratio <= 20;
  }

  _open(position, trade, price, jumpPct) {
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: `CYA:${position.cohortId}`,
      mint: position.mint,
      timestampMs: trade.timestampMs,
    });
    if (rugGuard.blocked) {
      this.store.updateCyaEarlyPyramidShadowPosition(position.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'PRE_ENTRY_RUG_RISK',
      });
      this.pendingEntries.delete(position.id);
      return;
    }
    Object.assign(position, {
      status: STATUS.OPEN,
      entryAt: trade.timestampMs,
      entryMarket: trade.market,
      entryPrice: price,
      entryJumpPct: jumpPct,
      averageEntryPrice: price,
      totalInvestedSol: position.positionSol,
      tokenUnits: position.positionSol / price,
      remainingTokenUnits: position.positionSol / price,
      realizedProceedsSol: 0,
      addCount: 0,
      scaleOutCount: 0,
      lastAddAt: trade.timestampMs,
      lastAddPrice: price,
      highestPrice: price,
      lowestPrice: price,
    });
    this.store.updateCyaEarlyPyramidShadowPosition(position.id, {
      status: STATUS.OPEN,
      entryAt: position.entryAt,
      entryMarket: position.entryMarket,
      entryPrice: price,
      entryJumpPct: jumpPct,
      averageEntryPrice: price,
      totalInvestedSol: position.totalInvestedSol,
      tokenUnits: position.tokenUnits,
      remainingTokenUnits: position.remainingTokenUnits,
      realizedProceedsSol: 0,
      addCount: 0,
      scaleOutCount: 0,
      lastAddAt: position.lastAddAt,
      lastAddPrice: price,
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
  }

  _mark(position, timestampMs, price) {
    position.highestPrice = Math.max(position.highestPrice || price, price);
    position.lowestPrice = Math.min(position.lowestPrice || price, price);
    position.maxFavorableReturnPct = Math.max(
      position.maxFavorableReturnPct || 0,
      ((position.highestPrice / position.averageEntryPrice) - 1) * 100,
    );
    position.maxAdverseReturnPct = Math.min(
      position.maxAdverseReturnPct || 0,
      ((position.lowestPrice / position.averageEntryPrice) - 1) * 100,
    );
    this.store.updateCyaEarlyPyramidShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _maybeAdd(position, trade, price, features) {
    if (position.firstTakeProfitAt || position.addCount >= this.config.maxAdds
      || trade.timestampMs - position.lastAddAt < this.config.addCooldownMs
      || price < position.lastAddPrice * (1 + this.config.addStepPct / 100)) return;
    const profile = this.entryProfiles.get(position.entryProfileId);
    if (!profile || features.buyers5s > profile.maxBuyers5s
      || features.netFlow5s < profile.minNetFlow5s
      || features.netFlow5s > profile.maxNetFlow5s) return;
    const addSol = position.positionSol * this.config.addFraction;
    const addTokens = addSol / price;
    position.totalInvestedSol += addSol;
    position.tokenUnits += addTokens;
    position.remainingTokenUnits += addTokens;
    position.averageEntryPrice = position.totalInvestedSol / position.tokenUnits;
    position.addCount += 1;
    position.lastAddAt = trade.timestampMs;
    position.lastAddPrice = price;
    this.store.updateCyaEarlyPyramidShadowPosition(position.id, {
      averageEntryPrice: position.averageEntryPrice,
      totalInvestedSol: position.totalInvestedSol,
      tokenUnits: position.tokenUnits,
      remainingTokenUnits: position.remainingTokenUnits,
      addCount: position.addCount,
      lastAddAt: position.lastAddAt,
      lastAddPrice: position.lastAddPrice,
    });
    this.metrics.adds += 1;
  }

  _maybeScaleOut(position, trade, price) {
    const gross = ((price / position.averageEntryPrice) - 1) * 100;
    let sellUnits = 0;
    const patch = {};
    if (!position.firstTakeProfitAt && gross >= this.config.firstTakeProfitPct) {
      sellUnits = position.remainingTokenUnits * 0.25;
      position.firstTakeProfitAt = trade.timestampMs;
      patch.firstTakeProfitAt = trade.timestampMs;
      patch.firstTakeProfitPrice = price;
    } else if (position.firstTakeProfitAt && !position.secondTakeProfitAt
      && gross >= this.config.secondTakeProfitPct) {
      sellUnits = position.remainingTokenUnits / 3;
      position.secondTakeProfitAt = trade.timestampMs;
      patch.secondTakeProfitAt = trade.timestampMs;
      patch.secondTakeProfitPrice = price;
    }
    if (!(sellUnits > 0)) return;
    position.remainingTokenUnits -= sellUnits;
    position.realizedProceedsSol += sellUnits * price;
    position.scaleOutCount += 1;
    Object.assign(patch, {
      remainingTokenUnits: position.remainingTokenUnits,
      realizedProceedsSol: position.realizedProceedsSol,
      scaleOutCount: position.scaleOutCount,
    });
    this.store.updateCyaEarlyPyramidShadowPosition(position.id, patch);
    this.metrics.partialExits += 1;
  }

  _evaluateExit(position, timestampMs, price) {
    const heldMs = timestampMs - position.entryAt;
    const gross = ((price / position.averageEntryPrice) - 1) * 100;
    const drawdown = ((price / position.highestPrice) - 1) * -100;
    let reason = null;
    let triggerAt = timestampMs;
    if (!position.firstTakeProfitAt && gross <= -position.hardStopPct) reason = 'HARD_STOP';
    else if (position.firstTakeProfitAt && drawdown >= position.trailingStopPct) {
      reason = `RUNNER_TRAIL_${position.trailingStopPct}PCT`;
    } else if (heldMs >= position.noStrengthMs
      && position.maxFavorableReturnPct < position.noStrengthMfePct) {
      reason = 'NO_STRENGTH_25S';
      triggerAt = position.entryAt + position.noStrengthMs;
    } else if (heldMs >= position.maxHoldMs) {
      reason = 'MAX_HOLD';
      triggerAt = position.entryAt + position.maxHoldMs;
    }
    if (reason) this._requestExit(position, triggerAt, reason);
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    Object.assign(position, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: triggerAt,
      exitTargetAt: triggerAt + this.config.exitDelayMs,
      exitDeadlineAt: triggerAt + this.config.exitDelayMs + this.config.exitTimeoutMs,
    });
    this.store.updateCyaEarlyPyramidShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _estimatedCostSol(position) {
    const variablePct = this.costs.platformFeePct + this.costs.buySlippagePct
      + this.costs.sellSlippagePct + this.costs.priceImpactPct;
    const extraExecutions = position.addCount + position.scaleOutCount;
    return position.totalInvestedSol * variablePct / 100
      + this.costs.totalFixedCostSol * (1 + extraExecutions);
  }

  _close(position, trade, price) {
    this._mark(position, trade.timestampMs, price);
    const grossProceedsSol = position.realizedProceedsSol + position.remainingTokenUnits * price;
    const grossReturnPct = (grossProceedsSol / position.totalInvestedSol - 1) * 100;
    const estimatedCostSol = this._estimatedCostSol(position);
    const netReturnPct = (grossProceedsSol - estimatedCostSol) / position.totalInvestedSol * 100 - 100;
    this.store.updateCyaEarlyPyramidShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
      grossReturnPct,
      netReturnPct,
      estimatedCostSol,
      remainingTokenUnits: 0,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    const estimatedCostSol = this._estimatedCostSol(position);
    this.store.updateCyaEarlyPyramidShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      grossReturnPct: -100,
      netReturnPct: -100 - estimatedCostSol / position.totalInvestedSol * 100,
      estimatedCostSol,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.noExit += 1;
  }

  _index(position) {
    let ids = this.rowsByMint.get(position.mint);
    if (!ids) {
      ids = new Set();
      this.rowsByMint.set(position.mint, ids);
    }
    ids.add(position.id);
  }

  _unindex(position) {
    const ids = this.rowsByMint.get(position.mint);
    if (!ids) return;
    ids.delete(position.id);
    if (!ids.size) this.rowsByMint.delete(position.mint);
  }
}

module.exports = { CyaEarlyPyramidShadowSuite, STATUS, shadowPrice };
