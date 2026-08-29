'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
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

function valueOf(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function restoredPosition(row) {
  return {
    id: row.id,
    cohortId: valueOf(row, 'cohort_id', 'cohortId'),
    exitProfileId: valueOf(row, 'exit_profile_id', 'exitProfileId'),
    episodeId: valueOf(row, 'episode_id', 'episodeId'),
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    graduatedAt: valueOf(row, 'graduated_at', 'graduatedAt'),
    signalAt: valueOf(row, 'signal_at', 'signalAt'),
    signalPrice: valueOf(row, 'signal_price', 'signalPrice'),
    entryTargetAt: valueOf(row, 'entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: valueOf(row, 'entry_deadline_at', 'entryDeadlineAt'),
    entryAt: valueOf(row, 'entry_at', 'entryAt'),
    entryPrice: valueOf(row, 'entry_price', 'entryPrice'),
    highestPrice: valueOf(row, 'highest_price', 'highestPrice'),
    lowestPrice: valueOf(row, 'lowest_price', 'lowestPrice'),
    lastObservedAt: valueOf(row, 'last_observed_at', 'lastObservedAt'),
    lastPrice: valueOf(row, 'last_price', 'lastPrice'),
    maxFavorableReturnPct: finite(
      valueOf(row, 'max_favorable_return_pct', 'maxFavorableReturnPct'),
      0,
    ),
    maxAdverseReturnPct: finite(
      valueOf(row, 'max_adverse_return_pct', 'maxAdverseReturnPct'),
      0,
    ),
    trailingActivatedAt: valueOf(row, 'trailing_activated_at', 'trailingActivatedAt'),
    exitTriggerAt: valueOf(row, 'exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: valueOf(row, 'exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: valueOf(row, 'exit_deadline_at', 'exitDeadlineAt'),
    exitReason: valueOf(row, 'exit_reason', 'exitReason'),
    fixedHoldMs: finite(valueOf(row, 'fixed_hold_ms', 'fixedHoldMs'), null),
  };
}

class MigrationContinuityShadowSuite {
  constructor({ config, store, now = () => Date.now(), onLiveSignal = null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.onLiveSignal = typeof onLiveSignal === 'function' ? onLiveSignal : null;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.exitProfiles = new Map((config.exitProfiles || []).map((profile) => [
      profile.id,
      profile,
    ]));
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      evaluated: 0,
      matched: 0,
      rejected: 0,
      replayEvaluationsSuppressed: 0,
      deduplicated: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      closed: 0,
      noExit: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    for (const row of this.store.activeMigrationContinuityShadowPositions()) {
      const position = restoredPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
      const token = this.store.getToken(position.mint);
      this.onGraduated(token || {
        mint: position.mint,
        symbol: position.symbol,
        graduated_at: position.graduatedAt,
      });
    }
    for (const token of this.store.allTokens()) {
      const graduatedAt = finite(token.graduated_at);
      if (graduatedAt && now - graduatedAt <= this.config.detectionDeadlineMs) {
        this.onGraduated(token);
      }
    }
    const replaySince = now - Math.max(this.config.detectionDeadlineMs, this.config.flowWindowMs);
    for (const trade of this.store.recentAmmTrades(replaySince)) {
      this.observeTrade(trade, { replay: true });
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
    const current = this.states.get(token.mint);
    this.states.set(token.mint, {
      mint: token.mint,
      symbol: token.symbol || current?.symbol || null,
      graduatedAt: Math.min(graduatedAt, current?.graduatedAt || graduatedAt),
      firstPrice: current?.firstPrice || null,
      trades: current?.trades || [],
      evaluated: current?.evaluated || this.store.hasMigrationContinuityShadowSignal(token.mint),
    });
  }

  trackedMints(now = this.now()) {
    for (const [mint, state] of this.states) {
      if (now - state.graduatedAt <= this.config.detectionDeadlineMs) continue;
      if (this._hasActiveMint(mint)) continue;
      this.states.delete(mint);
    }
    return [...this.states.keys()];
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_M',
      sendsTransactions: false,
      trackedMints: this.states.size,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfile: this.config.entryProfile,
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        name: 'Migration Continuity Shadow M',
        entryDelayMs: this.config.entryDelayMs,
        entryTimeoutMs: this.config.entryTimeoutMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        flowWindowMs: this.config.flowWindowMs,
        research: {
          isolatedTable: 'migration_continuity_shadow_positions',
          configuredCostPct: this.costs.deterministicCostPct,
          simulatedPositionSol: this.config.positionSizeSol,
          subscriptionPolicy: 'all graduates for detection window; only active mints afterward',
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  observeTrade(trade, { replay = false } = {}) {
    const price = shadowPrice(trade);
    const timestampMs = finite(trade?.timestampMs);
    if (!this.config.enabled || trade?.market !== 'PUMP_AMM' || !trade?.mint
      || !(price > 0) || !(timestampMs > 0)) return;
    let state = this.states.get(trade.mint);
    if (!state) {
      const token = this.store.getToken(trade.mint);
      const graduatedAt = finite(token?.graduated_at);
      if (!(graduatedAt > 0) || timestampMs < graduatedAt
        || timestampMs - graduatedAt > this.config.detectionDeadlineMs) return;
      this.onGraduated(token);
      state = this.states.get(trade.mint);
    }
    if (timestampMs < state.graduatedAt) return;
    if (!state.firstPrice) state.firstPrice = price;
    state.trades.push({
      timestampMs,
      price,
      side: trade.side,
      solAmount: finite(trade.solAmount, 0),
      wallet: trade.wallet || trade.signature || `${timestampMs}:${state.trades.length}`,
    });
    const retentionMs = Math.max(this.config.confirmWindowMs, this.config.flowWindowMs);
    const cutoff = timestampMs - retentionMs;
    while (state.trades.length && state.trades[0].timestampMs < cutoff) state.trades.shift();

    this._observeRowsForMint(trade, price, state);
    if (state.evaluated || timestampMs < state.graduatedAt + this.config.confirmWindowMs) return;
    if (timestampMs > state.graduatedAt + this.config.detectionDeadlineMs) {
      state.evaluated = true;
      return;
    }
    const features = this._entryFeatures(state, timestampMs, price);
    this.metrics.evaluated += 1;
    state.evaluated = true;
    if (!this._entryPass(features)) {
      this.metrics.rejected += 1;
      return;
    }
    if (replay) {
      this.metrics.replayEvaluationsSuppressed += 1;
      return;
    }
    this.metrics.matched += 1;
    this._emitSignal(state, trade, price, features);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateMigrationContinuityShadowPosition(pending.id, { status: STATUS.NO_ENTRY });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status === STATUS.OPEN) this._evaluateExit(position, now, position.lastPrice);
    }
    this.trackedMints(now);
  }

  _entryFeatures(state, timestampMs, price) {
    const rows = state.trades.filter((row) => row.timestampMs >= state.graduatedAt
      && row.timestampMs <= timestampMs);
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buySol = buys.reduce((sum, row) => sum + row.solAmount, 0);
    const sellSol = sells.reduce((sum, row) => sum + row.solAmount, 0);
    return {
      buyers: new Set(buys.map((row) => row.wallet)).size,
      buySol,
      sellSol,
      netFlowSol: buySol - sellSol,
      sellBuyRatio: buySol > 0 ? sellSol / buySol : null,
      returnPct: state.firstPrice > 0 ? ((price / state.firstPrice) - 1) * 100 : null,
    };
  }

  _entryPass(features) {
    const profile = this.config.entryProfile;
    return features.buyers >= profile.minBuyers
      && features.netFlowSol >= profile.minNetFlowSol
      && features.returnPct >= profile.minReturnPct
      && features.sellBuyRatio != null
      && features.sellBuyRatio <= profile.maxSellBuyRatio;
  }

  _emitSignal(state, trade, price, features) {
    const episodeId = `${state.mint}:MC_C5:${state.graduatedAt}`;
    if (this.onLiveSignal && this.config.entryProfile.liveStrategyId) {
      try {
        this.onLiveSignal({
          strategyId: this.config.entryProfile.liveStrategyId,
          episodeId,
          mint: state.mint,
          symbol: trade.symbol || state.symbol,
          price,
          slot: trade.slot,
          timestampMs: trade.timestampMs,
          receivedAtMs: trade.receivedAtMs || trade.timestampMs,
          market: 'PUMP_AMM',
          poolBaseReservesRaw: trade.poolBaseReservesRaw || null,
          poolQuoteReservesRaw: trade.poolQuoteReservesRaw || null,
          virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw || null,
          features: {
            ...features,
            graduatedAt: state.graduatedAt,
            migrationAgeMs: trade.timestampMs - state.graduatedAt,
            confirmWindowMs: this.config.confirmWindowMs,
            flowWindowMs: this.config.flowWindowMs,
          },
        });
      } catch (error) {
        this.metrics.lastError = String(error?.message || error).slice(0, 1_000);
      }
    }
    for (const exitProfile of this.exitProfiles.values()) {
      if (exitProfile.newEntriesEnabled === false) continue;
      const saved = this.store.createMigrationContinuityShadowPosition({
        cohortId: `MC_C5_${exitProfile.id}`,
        exitProfileId: exitProfile.id,
        episodeId,
        mint: state.mint,
        symbol: trade.symbol || state.symbol,
        status: STATUS.PENDING_ENTRY,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        graduatedAt: state.graduatedAt,
        signalAt: trade.timestampMs,
        signalPrice: price,
        entryBuyers: features.buyers,
        entryBuySol: features.buySol,
        entrySellSol: features.sellSol,
        entryNetFlowSol: features.netFlowSol,
        entrySellBuyRatio: features.sellBuyRatio,
        entryReturnPct: features.returnPct,
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryDelayMs
          + this.config.entryTimeoutMs,
        exitMode: exitProfile.exitMode,
        minHoldMs: exitProfile.minHoldMs,
        fixedHoldMs: exitProfile.fixedHoldMs,
        trailingActivationPct: exitProfile.trailingActivationPct,
        trailingStopPct: exitProfile.trailingStopPct,
        hardStopPct: exitProfile.hardStopPct,
        maxHoldMs: exitProfile.maxHoldMs,
      });
      if (!saved?.inserted) {
        this.metrics.deduplicated += 1;
        continue;
      }
      const pending = restoredPosition(saved);
      this.pendingEntries.set(pending.id, pending);
      this._index(pending);
    }
    this.metrics.lastActionAt = this.now();
  }

  _observeRowsForMint(trade, price, state) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (trade.timestampMs < position.entryTargetAt
          || trade.timestampMs > position.entryDeadlineAt) continue;
        const rugGuard = evaluateUniversalRugGuard(this.store, {
          strategyId: `MIGRATION_CONTINUITY:${position.cohortId}`,
          mint: position.mint,
          timestampMs: trade.timestampMs,
        });
        if (rugGuard.blocked) {
          this.store.updateMigrationContinuityShadowPosition(position.id, {
            status: STATUS.NO_ENTRY,
            rejectionReason: 'PRE_ENTRY_RUG_RISK',
          });
          this.pendingEntries.delete(position.id);
          this._unindex(position);
          continue;
        }
        const entryExecution = executableBuy(trade, position.positionSol, price);
        const entryPrice = entryExecution.price ?? price;
        const jumpPct = ((entryPrice / position.signalPrice) - 1) * 100;
        if (jumpPct > this.config.maxEntryPriceJumpPct) {
          this.store.updateMigrationContinuityShadowPosition(position.id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
          });
          this.pendingEntries.delete(position.id);
          this._unindex(position);
          this.metrics.priceJump += 1;
          continue;
        }
        Object.assign(position, {
          status: STATUS.OPEN,
          entryAt: trade.timestampMs,
          entryPrice,
          highestPrice: price,
          lowestPrice: price,
          lastObservedAt: trade.timestampMs,
          lastPrice: price,
        });
        this.store.updateMigrationContinuityShadowPosition(position.id, {
          status: STATUS.OPEN,
          entryAt: trade.timestampMs,
          entryPrice,
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
        if (trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
        continue;
      }
      if (position.status !== STATUS.OPEN || trade.timestampMs < position.entryAt) continue;
      this._updateExtrema(position, trade.timestampMs, price);
      this._evaluateExit(position, trade.timestampMs, price, state);
      if (position.status === STATUS.EXIT_PENDING
        && trade.timestampMs >= position.exitTargetAt
        && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
    }
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
    this.store.updateMigrationContinuityShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _flowFeatures(state, timestampMs) {
    const rows = state.trades.filter((row) => row.timestampMs >= timestampMs - this.config.flowWindowMs);
    const buySol = rows.filter((row) => row.side === 'BUY')
      .reduce((sum, row) => sum + row.solAmount, 0);
    const sellSol = rows.filter((row) => row.side === 'SELL')
      .reduce((sum, row) => sum + row.solAmount, 0);
    return {
      netFlowSol: buySol - sellSol,
      sellBuyRatio: buySol > 0 ? sellSol / buySol : (sellSol > 0 ? Infinity : 0),
      buyers: new Set(rows.filter((row) => row.side === 'BUY')
        .map((row) => row.wallet).filter(Boolean)).size,
    };
  }

  _evaluateExit(position, timestampMs, price, state = this.states.get(position.mint)) {
    if (position.status !== STATUS.OPEN || !(price > 0)) return;
    const profile = this.exitProfiles.get(position.exitProfileId);
    if (!profile) return;
    const ageMs = timestampMs - position.entryAt;
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    const drawdownPct = ((price / position.highestPrice) - 1) * -100;
    let reason = null;
    let triggerAt = timestampMs;

    if (profile.hardStopPct > 0 && grossReturnPct <= -profile.hardStopPct) {
      reason = 'HARD_STOP';
    } else if (profile.exitMode === 'FIXED_HOLD' && ageMs >= profile.fixedHoldMs) {
      reason = `FIXED_HOLD_${profile.fixedHoldMs}MS`;
      triggerAt = position.entryAt + profile.fixedHoldMs;
    } else if (profile.exitMode === 'FLOW_FADE' && ageMs >= profile.minHoldMs && state) {
      const flow = this._flowFeatures(state, timestampMs);
      if (flow.sellBuyRatio >= profile.minSellBuyRatio
        && flow.netFlowSol <= profile.maxNetFlowSol) reason = 'FLOW_FADE';
    } else if (profile.exitMode === 'ADAPTIVE_HORIZON' && state) {
      if (!(position.fixedHoldMs > 0) && ageMs >= profile.decisionAtMs) {
        const flow = this._flowFeatures(state, timestampMs);
        const strong = flow.netFlowSol >= profile.minStrongNetFlowSol
          && flow.sellBuyRatio <= profile.maxStrongSellBuyRatio
          && flow.buyers >= profile.minStrongBuyers;
        position.fixedHoldMs = strong ? profile.strongHoldMs : profile.weakHoldMs;
        this.store.updateMigrationContinuityShadowPosition(position.id, {
          fixedHoldMs: position.fixedHoldMs,
        });
      }
      if (position.fixedHoldMs > 0 && ageMs >= position.fixedHoldMs) {
        reason = `ADAPTIVE_HORIZON_${position.fixedHoldMs}MS`;
        triggerAt = position.entryAt + position.fixedHoldMs;
      }
    } else if (['TRAILING', 'ADAPTIVE_TRAILING'].includes(profile.exitMode)) {
      if (!position.trailingActivatedAt && peakReturnPct >= profile.trailingActivationPct) {
        position.trailingActivatedAt = timestampMs;
        this.store.updateMigrationContinuityShadowPosition(position.id, {
          trailingActivatedAt: timestampMs,
        });
      }
      let trailingStopPct = profile.trailingStopPct;
      if (profile.exitMode === 'ADAPTIVE_TRAILING') {
        const tier = profile.trailingTiers.find((item) => peakReturnPct < item.belowPct)
          || profile.trailingTiers[profile.trailingTiers.length - 1];
        trailingStopPct = tier.stopPct;
      }
      if (position.trailingActivatedAt && ageMs >= profile.minHoldMs
        && drawdownPct >= trailingStopPct) reason = 'TRAILING_STOP';
    }
    if (!reason && profile.maxHoldMs > 0 && ageMs >= profile.maxHoldMs) {
      reason = 'MAX_HOLD';
      triggerAt = position.entryAt + profile.maxHoldMs;
    }
    if (reason) this._requestExit(position, triggerAt, reason);
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updateMigrationContinuityShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _close(position, trade, price) {
    this._updateExtrema(position, trade.timestampMs, price);
    const markReturnPct = ((price / position.entryPrice) - 1) * 100;
    const execution = executableSell(
      trade,
      position.positionSol / position.entryPrice,
      price,
      { rugMarkReturnPct: markReturnPct },
    );
    const executablePrice = execution.price ?? price;
    const executableReturnPct = ((executablePrice / position.entryPrice) - 1) * 100;
    this.store.updateMigrationContinuityShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitPrice: executablePrice,
      // Keep the observable mark return for audit; net return is the capacity-aware
      // executable result used by strategy profitability statistics.
      grossReturnPct: markReturnPct,
      netReturnPct: executableReturnPct - this.costs.deterministicCostPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position, reason = 'NO_EXECUTABLE_EXIT_TRADE') {
    this.store.updateMigrationContinuityShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      rejectionReason: reason,
      exitReason: reason,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.noExit += 1;
  }

  _index(position) {
    let rows = this.rowsByMint.get(position.mint);
    if (!rows) {
      rows = new Set();
      this.rowsByMint.set(position.mint, rows);
    }
    rows.add(position.id);
  }

  _unindex(position) {
    const rows = this.rowsByMint.get(position.mint);
    if (!rows) return;
    rows.delete(position.id);
    if (!rows.size) this.rowsByMint.delete(position.mint);
  }

  _hasActiveMint(mint) {
    return (this.rowsByMint.get(mint)?.size || 0) > 0;
  }
}

module.exports = { MigrationContinuityShadowSuite, STATUS, shadowPrice };
