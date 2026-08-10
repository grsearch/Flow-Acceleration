'use strict';

const { costBreakdown } = require('./CostModel');

const STATUS = Object.freeze({
  WAITING_PULLBACK: 'WAITING_PULLBACK',
  WAITING_REBOUND: 'WAITING_REBOUND',
  PENDING_ENTRY: 'PENDING_ENTRY',
  PRICE_JUMP: 'PRICE_JUMP',
  PRICE_CAP: 'PRICE_CAP',
  NO_CONFIRMATION: 'NO_CONFIRMATION',
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

function parseWallets(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch (_error) {
    return new Set();
  }
}

function restoredPosition(row) {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    episodeId: row.episode_id,
    smartEventId: row.smart_event_id,
    smartWallet: row.smart_wallet,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    smartBuyAt: row.smart_buy_at,
    smartBuyPrice: row.smart_buy_price,
    smartBuySol: row.smart_buy_sol,
    confirmationDeadlineAt: row.confirmation_deadline_at,
    peakBeforePullback: row.peak_before_pullback,
    pullbackArmedAt: row.pullback_armed_at,
    pullbackLowPrice: row.pullback_low_price,
    reboundBuyers: parseWallets(row.rebound_buyers_json),
    confirmationAt: row.confirmation_at,
    confirmationPrice: row.confirmation_price,
    entryTargetAt: row.entry_target_at,
    entryDeadlineAt: row.entry_deadline_at,
    entryAt: row.entry_at,
    entryMarket: row.entry_market,
    entryPrice: row.entry_price,
    highestPrice: row.highest_price,
    maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
    exitTriggerAt: row.exit_trigger_at,
    exitTargetAt: row.exit_target_at,
    exitDeadlineAt: row.exit_deadline_at,
    exitReason: row.exit_reason,
  };
}

class SmartPullbackShadowManager {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.candidates = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.lastSmartBuyAtByMint = new Map();
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.metrics = {
      evaluated: 0,
      episodes: 0,
      confirmed: 0,
      opened: 0,
      closed: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    const now = this.now();
    for (const event of this.store.recentSmartWalletEvents(now - this.config.episodeGapMs)) {
      if (event.side === 'BUY') this.lastSmartBuyAtByMint.set(event.mint, event.timestamp_ms);
    }
    for (const row of this.store.activeSmartPullbackShadowPositions(this.config.cohortId)) {
      const position = restoredPosition(row);
      if ([STATUS.WAITING_PULLBACK, STATUS.WAITING_REBOUND].includes(position.status)) {
        this.candidates.set(position.mint, position);
      } else if (position.status === STATUS.PENDING_ENTRY) {
        this.pendingEntries.set(position.mint, position);
      } else {
        this.positions.set(position.mint, position);
      }
      this.lastSmartBuyAtByMint.set(
        position.mint,
        Math.max(this.lastSmartBuyAtByMint.get(position.mint) || 0, position.smartBuyAt || 0),
      );
    }
    this.advanceTime(now);
  }

  stop() {}

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW',
      cohortId: this.config.cohortId,
      cohortLabel: this.config.cohortLabel,
      candidates: this.candidates.size,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      strategy: {
        name: `Smart Wallet Pullback ${this.config.cohortId}`,
        entry: {
          smartBuyMinSol: this.config.minSmartBuySol,
          episodeGapMs: this.config.episodeGapMs,
          confirmationWindowMs: this.config.confirmationWindowMs,
          pullbackPct: this.config.pullbackPct,
          reboundPct: this.config.reboundPct,
          minReboundBuyers: this.config.minReboundBuyers,
          maxEntryVsSmartBuyPct: this.config.maxEntryVsSmartBuyPct,
          maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
          entryDelayMs: this.config.entryDelayMs,
          entryTimeoutMs: this.config.entryTimeoutMs,
          market: 'PUMP_BONDING_CURVE',
        },
        exit: {
          trailingActivationPct: 0,
          trailingStopPct: this.config.trailingStopPct,
          maxHoldMs: this.config.maxHoldMs,
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

  onSmartWalletBuy(event) {
    if (!this.config.enabled || event?.side !== 'BUY'
      || event.market !== 'PUMP_BONDING_CURVE'
      || !(finite(event.solAmount) >= this.config.minSmartBuySol)
      || !(finite(event.price) > 0) || !(finite(event.timestampMs) > 0)
      || !event.mint || !event.wallet) return null;

    const smartBuyAt = Number(event.timestampMs);
    this.metrics.evaluated += 1;
    const previousAt = this.lastSmartBuyAtByMint.get(event.mint);
    this.lastSmartBuyAtByMint.set(event.mint, smartBuyAt);
    if (Number.isFinite(previousAt) && smartBuyAt - previousAt <= this.config.episodeGapMs) {
      return null;
    }
    if (this.candidates.has(event.mint) || this.pendingEntries.has(event.mint)
      || this.positions.has(event.mint)) return null;

    const episodeId = `smart-${event.id || `${event.mint}-${smartBuyAt}`}`;
    const confirmationDeadlineAt = smartBuyAt + this.config.confirmationWindowMs;
    const saved = this.store.createSmartPullbackShadowPosition({
      cohortId: this.config.cohortId,
      episodeId,
      smartEventId: event.id || null,
      smartWallet: event.wallet,
      mint: event.mint,
      symbol: event.symbol,
      status: STATUS.WAITING_PULLBACK,
      positionSol: this.config.positionSizeSol,
      configuredCostPct: this.costs.deterministicCostPct,
      smartBuyAt,
      smartBuyPrice: event.price,
      smartBuySol: event.solAmount,
      confirmationDeadlineAt,
      peakBeforePullback: event.price,
    });
    if (!saved?.inserted) return saved;

    const candidate = restoredPosition({
      ...saved,
      cohort_id: this.config.cohortId,
      episode_id: episodeId,
      smart_event_id: event.id || null,
      smart_wallet: event.wallet,
      mint: event.mint,
      symbol: event.symbol || null,
      status: STATUS.WAITING_PULLBACK,
      smart_buy_at: smartBuyAt,
      smart_buy_price: event.price,
      smart_buy_sol: event.solAmount,
      confirmation_deadline_at: confirmationDeadlineAt,
      peak_before_pullback: event.price,
      rebound_buyers_json: '[]',
    });
    this.candidates.set(event.mint, candidate);
    this.metrics.episodes += 1;
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
      const confirmationJumpPct = ((trade.price / pending.confirmationPrice) - 1) * 100;
      const smartBuyJumpPct = ((trade.price / pending.smartBuyPrice) - 1) * 100;
      if (confirmationJumpPct > this.config.maxEntryPriceJumpPct) {
        this._rejectPending(pending, STATUS.PRICE_JUMP,
          `CONFIRMATION_PRICE_JUMP_${confirmationJumpPct.toFixed(2)}pct`);
      } else if (smartBuyJumpPct > this.config.maxEntryVsSmartBuyPct) {
        this._rejectPending(pending, STATUS.PRICE_CAP,
          `SMART_BUY_PRICE_CAP_${smartBuyJumpPct.toFixed(2)}pct`);
      } else {
        pending.status = STATUS.OPEN;
        pending.entryAt = timestampMs;
        pending.entryMarket = trade.market;
        pending.entryPrice = trade.price;
        pending.highestPrice = trade.price;
        pending.maxFavorableReturnPct = 0;
        this.store.updateSmartPullbackShadowPosition(pending.id, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice: trade.price,
          highestPrice: trade.price,
          maxFavorableReturnPct: 0,
        });
        this.pendingEntries.delete(trade.mint);
        this.positions.set(trade.mint, pending);
        this.metrics.opened += 1;
        this.metrics.lastActionAt = this.now();
        position = pending;
      }
    }

    this._observeCandidate(trade, timestampMs);

    position = position || this.positions.get(trade.mint);
    if (!position || position.status !== STATUS.OPEN || !this._eligibleExitTrade(position, trade)) {
      return;
    }
    this._updatePeak(position, trade);
    const drawdownPct = ((position.highestPrice - trade.price) / position.highestPrice) * 100;
    if (drawdownPct >= this.config.trailingStopPct) {
      this._requestExit(position, 'TRAILING_IMMEDIATE', timestampMs);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const candidate of [...this.candidates.values()]) {
      if (now <= candidate.confirmationDeadlineAt) continue;
      this.store.updateSmartPullbackShadowPosition(candidate.id, {
        status: STATUS.NO_CONFIRMATION,
        rejectionReason: 'PULLBACK_REBOUND_NOT_CONFIRMED',
      });
      this.candidates.delete(candidate.mint);
    }
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateSmartPullbackShadowPosition(pending.id, { status: STATUS.NO_ENTRY });
      this.pendingEntries.delete(pending.mint);
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      if (now >= position.entryAt + this.config.maxHoldMs) {
        this._requestExit(position, 'MAX_HOLD_60S', position.entryAt + this.config.maxHoldMs);
      }
    }
  }

  _observeCandidate(trade, timestampMs) {
    const candidate = this.candidates.get(trade.mint);
    if (!candidate || timestampMs <= candidate.smartBuyAt
      || timestampMs > candidate.confirmationDeadlineAt
      || trade.market !== 'PUMP_BONDING_CURVE') return;

    if (candidate.status === STATUS.WAITING_PULLBACK) {
      candidate.peakBeforePullback = Math.max(
        candidate.peakBeforePullback || candidate.smartBuyPrice,
        trade.price,
      );
      const drawdownPct = (
        (candidate.peakBeforePullback - trade.price) / candidate.peakBeforePullback
      ) * 100;
      const patch = { peakBeforePullback: candidate.peakBeforePullback };
      if (drawdownPct >= this.config.pullbackPct) {
        candidate.status = STATUS.WAITING_REBOUND;
        candidate.pullbackArmedAt = timestampMs;
        candidate.pullbackLowPrice = trade.price;
        candidate.reboundBuyers = new Set();
        if (trade.side === 'BUY' && trade.wallet) candidate.reboundBuyers.add(trade.wallet);
        Object.assign(patch, {
          status: STATUS.WAITING_REBOUND,
          pullbackArmedAt: timestampMs,
          pullbackLowPrice: trade.price,
          reboundBuyers: [...candidate.reboundBuyers],
        });
      }
      this.store.updateSmartPullbackShadowPosition(candidate.id, patch);
      return;
    }

    if (candidate.status !== STATUS.WAITING_REBOUND) return;
    if (trade.price < candidate.pullbackLowPrice) {
      candidate.pullbackLowPrice = trade.price;
      candidate.reboundBuyers.clear();
    }
    if (trade.side === 'BUY' && trade.wallet) candidate.reboundBuyers.add(trade.wallet);
    const reboundPct = ((trade.price / candidate.pullbackLowPrice) - 1) * 100;
    this.store.updateSmartPullbackShadowPosition(candidate.id, {
      pullbackLowPrice: candidate.pullbackLowPrice,
      reboundBuyers: [...candidate.reboundBuyers],
    });
    if (reboundPct < this.config.reboundPct
      || candidate.reboundBuyers.size < this.config.minReboundBuyers
      || trade.price > candidate.smartBuyPrice * (1 + this.config.maxEntryVsSmartBuyPct / 100)) {
      return;
    }

    candidate.status = STATUS.PENDING_ENTRY;
    candidate.confirmationAt = timestampMs;
    candidate.confirmationPrice = trade.price;
    candidate.entryTargetAt = timestampMs + this.config.entryDelayMs;
    candidate.entryDeadlineAt = candidate.entryTargetAt + this.config.entryTimeoutMs;
    this.store.updateSmartPullbackShadowPosition(candidate.id, {
      status: STATUS.PENDING_ENTRY,
      confirmationAt: timestampMs,
      confirmationPrice: trade.price,
      reboundBuyers: [...candidate.reboundBuyers],
      entryTargetAt: candidate.entryTargetAt,
      entryDeadlineAt: candidate.entryDeadlineAt,
    });
    this.candidates.delete(candidate.mint);
    this.pendingEntries.set(candidate.mint, candidate);
    this.metrics.confirmed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _rejectPending(pending, status, rejectionReason) {
    this.store.updateSmartPullbackShadowPosition(pending.id, { status, rejectionReason });
    this.pendingEntries.delete(pending.mint);
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
    this.store.updateSmartPullbackShadowPosition(position.id, {
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
    this.store.updateSmartPullbackShadowPosition(position.id, {
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
    this.store.updateSmartPullbackShadowPosition(position.id, {
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
    this.store.updateSmartPullbackShadowPosition(position.id, {
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

module.exports = { SmartPullbackShadowManager, STATUS };
