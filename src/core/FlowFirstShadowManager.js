'use strict';

const { costBreakdown } = require('./CostModel');

const STATUS = Object.freeze({
  RULE_REJECTED: 'RULE_REJECTED',
  PENDING_ENTRY: 'PENDING_ENTRY',
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

function restoredPosition(row) {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    signalId: row.signal_id,
    signalEpisodeId: row.signal_episode_id,
    signalRankInMint: row.signal_rank_in_mint,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    signalAt: row.signal_at,
    signalPrice: row.signal_price,
    entryTargetAt: row.entry_target_at,
    entryDeadlineAt: row.entry_deadline_at,
    entryAt: row.entry_at,
    entryMarket: row.entry_market,
    entryPrice: row.entry_price,
    entryJumpPct: row.entry_jump_pct,
    highestPrice: row.highest_price,
    maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
    exitTriggerAt: row.exit_trigger_at,
    exitTargetAt: row.exit_target_at,
    exitDeadlineAt: row.exit_deadline_at,
    exitReason: row.exit_reason,
  };
}

class FlowFirstShadowManager {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.metrics = {
      signalsSeen: 0,
      episodes: 0,
      deduplicated: 0,
      rejected: 0,
      opened: 0,
      closed: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    for (const row of this.store.activeFlowFirstShadowPositions(this.config.cohortId)) {
      const position = restoredPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) {
        this.pendingEntries.set(position.mint, position);
      } else {
        this.positions.set(position.mint, position);
      }
    }
    this.advanceTime(this.now());
  }

  stop() {}

  health() {
    const fixedHold = this.config.exitMode === 'FIXED_HOLD';
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW',
      cohortId: this.config.cohortId,
      cohortLabel: this.config.cohortLabel,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      strategy: {
        name: `Flow-First ${this.config.cohortId}`,
        entry: {
          signalVariant: this.config.signalVariant,
          episodeDedup: true,
          episodeGapMs: this.config.episodeGapMs,
          maxSignalAgeMs: this.config.maxSignalAgeMs,
          entryDelayMs: this.config.entryDelayMs,
          entryTimeoutMs: this.config.entryTimeoutMs,
          market: 'PUMP_BONDING_CURVE',
        },
        exit: {
          policy: fixedHold ? 'FIXED_HOLD' : 'IMMEDIATE_TRAILING',
          fixedHoldMs: fixedHold ? this.config.fixedHoldMs : null,
          trailingActivationPct: fixedHold ? null : 0,
          trailingStopPct: fixedHold ? null : this.config.trailingStopPct,
          maxHoldMs: fixedHold ? this.config.fixedHoldMs : this.config.maxHoldMs,
          exitDelayMs: this.config.exitDelayMs,
          exitTimeoutMs: this.config.exitTimeoutMs,
        },
        research: {
          bigWinnerPct: this.config.bigWinnerPct,
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  hasActiveMint(mint) {
    return this.pendingEntries.has(mint) || this.positions.has(mint);
  }

  onSignal(signal) {
    if (!this.config.enabled || signal?.signalVariant !== this.config.signalVariant
      || !(signal?.isPrimary === true || Number(signal?.isPrimary) === 1)) return null;

    const signalAt = finite(signal.timestampMs);
    const signalPrice = finite(signal.price);
    if (!(signalAt > 0) || !(signalPrice > 0) || !signal.mint || !signal.signalId) return null;

    this.metrics.signalsSeen += 1;
    const signalCreatedAt = finite(signal.createdAt, signalAt);
    const signalAgeMs = Math.max(0, this.now() - signalCreatedAt);
    const reasons = [];
    if (signalAgeMs > this.config.maxSignalAgeMs) reasons.push('STALE_SIGNAL');
    if (signal.flowFirstSharedRejection) reasons.push(signal.flowFirstSharedRejection);
    else if (this.hasActiveMint(signal.mint)) reasons.push('MINT_ALREADY_ACTIVE');
    const matched = reasons.length === 0;
    const episodeId = signal.signalEpisodeId
      || `${signal.mint}:${this.config.signalVariant}:${signalAt}`;
    const saved = this.store.createFlowFirstShadowPosition({
      cohortId: this.config.cohortId,
      signalId: signal.signalId,
      signalEpisodeId: episodeId,
      signalRankInMint: signal.signalRankInMint,
      mint: signal.mint,
      symbol: signal.symbol,
      status: matched ? STATUS.PENDING_ENTRY : STATUS.RULE_REJECTED,
      rejectionReason: reasons.join(',') || null,
      positionSol: this.config.positionSizeSol,
      configuredCostPct: this.costs.deterministicCostPct,
      signalAt,
      signalPrice,
      entryTargetAt: matched ? signalAt + this.config.entryDelayMs : null,
      entryDeadlineAt: matched
        ? signalAt + this.config.entryDelayMs + this.config.entryTimeoutMs
        : null,
      netFlowW3: signal.netFlowW3,
      uniqueBuyersW3: signal.uniqueBuyersW3,
    });
    if (!saved?.inserted) {
      this.metrics.deduplicated += 1;
      return saved;
    }

    this.metrics.episodes += 1;
    if (!matched) {
      this.metrics.rejected += 1;
      return saved;
    }
    this.pendingEntries.set(signal.mint, restoredPosition({
      id: saved.id,
      cohort_id: this.config.cohortId,
      signal_id: signal.signalId,
      signal_episode_id: episodeId,
      signal_rank_in_mint: signal.signalRankInMint || null,
      mint: signal.mint,
      symbol: signal.symbol || null,
      status: STATUS.PENDING_ENTRY,
      signal_at: signalAt,
      signal_price: signalPrice,
      entry_target_at: signalAt + this.config.entryDelayMs,
      entry_deadline_at: signalAt + this.config.entryDelayMs + this.config.entryTimeoutMs,
    }));
    this.metrics.lastActionAt = this.now();
    return saved;
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint || !(finite(trade.price) > 0)
      || !(finite(trade.timestampMs) > 0)) return;
    const timestampMs = Number(trade.timestampMs);
    this.advanceTime(timestampMs);

    let position = this.positions.get(trade.mint);
    if (position?.status === STATUS.EXIT_PENDING && this._eligibleExitTrade(position, trade)) {
      this._updatePeak(position, trade);
      if (timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
        this._close(position, trade);
        position = null;
      }
    }

    const pending = this.pendingEntries.get(trade.mint);
    if (pending && trade.market === 'PUMP_BONDING_CURVE'
      && timestampMs >= pending.entryTargetAt
      && timestampMs <= pending.entryDeadlineAt) {
      pending.status = STATUS.OPEN;
      pending.entryAt = timestampMs;
      pending.entryMarket = trade.market;
      pending.entryPrice = trade.price;
      pending.entryJumpPct = ((trade.price / pending.signalPrice) - 1) * 100;
      pending.highestPrice = trade.price;
      pending.maxFavorableReturnPct = 0;
      this.store.updateFlowFirstShadowPosition(pending.id, {
        status: STATUS.OPEN,
        entryAt: timestampMs,
        entryMarket: trade.market,
        entryPrice: trade.price,
        entryJumpPct: pending.entryJumpPct,
        highestPrice: trade.price,
        maxFavorableReturnPct: 0,
      });
      this.pendingEntries.delete(trade.mint);
      this.positions.set(trade.mint, pending);
      this.metrics.opened += 1;
      this.metrics.lastActionAt = this.now();
      position = pending;
    }

    position = position || this.positions.get(trade.mint);
    if (!position || position.status !== STATUS.OPEN || !this._eligibleExitTrade(position, trade)) {
      return;
    }
    this._updatePeak(position, trade);
    if (this.config.exitMode !== 'TRAILING') return;
    const drawdownPct = ((position.highestPrice - trade.price) / position.highestPrice) * 100;
    if (drawdownPct >= this.config.trailingStopPct) {
      this._requestExit(position, `TRAILING_${this.config.trailingStopPct}PCT`, timestampMs);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateFlowFirstShadowPosition(pending.id, { status: STATUS.NO_ENTRY });
      this.pendingEntries.delete(pending.mint);
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      if (this.config.exitMode === 'FIXED_HOLD') {
        const triggerAt = position.entryAt + this.config.fixedHoldMs;
        if (now >= triggerAt) this._requestExit(position, 'FIXED_HOLD_5S', triggerAt);
      } else {
        const triggerAt = position.entryAt + this.config.maxHoldMs;
        if (now >= triggerAt) this._requestExit(position, 'MAX_HOLD_60S', triggerAt);
      }
    }
  }

  _eligibleExitTrade(position, trade) {
    if (trade.market === 'PUMP_BONDING_CURVE') return true;
    if (trade.market !== 'PUMP_AMM') return false;
    const token = this.store.getToken(trade.mint);
    if (!token?.graduated_at || trade.timestampMs < token.graduated_at) return false;
    const ratio = trade.price / position.entryPrice;
    return ratio >= 0.05 && ratio <= 20;
  }

  _updatePeak(position, trade) {
    position.highestPrice = Math.max(position.highestPrice || position.entryPrice, trade.price);
    position.maxFavorableReturnPct = Math.max(
      position.maxFavorableReturnPct || 0,
      ((position.highestPrice / position.entryPrice) - 1) * 100,
    );
    this.store.updateFlowFirstShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
  }

  _requestExit(position, reason, triggerAt) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updateFlowFirstShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
    this.metrics.lastActionAt = this.now();
  }

  _close(position, trade) {
    this._updatePeak(position, trade);
    const grossReturnPct = ((trade.price / position.entryPrice) - 1) * 100;
    const netReturnPct = grossReturnPct - this.costs.deterministicCostPct;
    this.store.updateFlowFirstShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: trade.price,
      grossReturnPct,
      netReturnPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
    this.positions.delete(position.mint);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateFlowFirstShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      grossReturnPct: -100,
      netReturnPct: -100 - this.costs.deterministicCostPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
    this.positions.delete(position.mint);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }
}

module.exports = { FlowFirstShadowManager, STATUS };
