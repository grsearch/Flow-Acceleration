'use strict';

const { costBreakdown } = require('./CostModel');
const { evaluatePrimarySignal, RULE_VERSION } = require('./PrimarySignalStrategy');

const STATUS = Object.freeze({
  RULE_REJECTED: 'RULE_REJECTED',
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

function restoredPosition(row) {
  return {
    id: row.id,
    signalId: row.signal_id,
    signalEpisodeId: row.signal_episode_id,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    signalAt: row.signal_at,
    signalPrice: row.signal_price,
    entryTargetAt: row.entry_target_at,
    entryDeadlineAt: row.entry_deadline_at,
    entryAt: row.entry_at,
    entryPrice: row.entry_price,
    entryMarket: row.entry_market,
    highestPrice: row.highest_price,
    exitTriggerAt: row.exit_trigger_at,
    exitTargetAt: row.exit_target_at,
    exitDeadlineAt: row.exit_deadline_at,
    exitReason: row.exit_reason,
  };
}

class PrimarySignalShadowManager {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.metrics = {
      evaluated: 0,
      matched: 0,
      opened: 0,
      closed: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    const now = this.now();
    for (const row of this.store.activePrimarySignalShadowPositions(this.config.signalVariant)) {
      const position = restoredPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) {
        this.pendingEntries.set(position.mint, position);
      } else {
        this.positions.set(position.mint, position);
      }
    }
    this.advanceTime(now);
  }

  stop() {}

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW',
      profileId: this.config.profileId,
      activePositions: this.positions.size,
      pendingEntries: this.pendingEntries.size,
      strategy: {
        name: `Primary Early ${this.config.profileId} Immediate Trailing Shadow`,
        ruleVersion: RULE_VERSION,
        entry: {
          signalVariant: this.config.signalVariant,
          minNetFlowW3Sol: this.config.minNetFlowW3Sol,
          minUniqueBuyersW3: this.config.minUniqueBuyersW3,
          maxSignalAgeMs: this.config.maxSignalAgeMs,
          entryDelayMs: this.config.entryDelayMs,
          entryTimeoutMs: this.config.entryTimeoutMs,
          maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
          market: 'PUMP_BONDING_CURVE',
        },
        exit: {
          trailingActivationPct: 0,
          trailingStopPct: this.config.trailingStopPct,
          maxHoldMs: this.config.maxHoldMs,
          exitDelayMs: this.config.exitDelayMs,
          exitTimeoutMs: this.config.exitTimeoutMs,
        },
        risk: {
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  onSignal(signal) {
    if (!this.config.enabled || signal?.signalVariant !== this.config.signalVariant) {
      return null;
    }
    const signalAt = finite(signal.timestampMs);
    const signalPrice = finite(signal.price);
    if (!(signalAt > 0) || !(signalPrice > 0) || !signal.mint || !signal.signalId) return null;

    this.metrics.evaluated += 1;
    const evaluated = evaluatePrimarySignal(signal, this.config, this.now());
    const reasons = [...evaluated.rejectReasons];
    if (this.pendingEntries.has(signal.mint) || this.positions.has(signal.mint)) {
      reasons.push('MINT_ALREADY_ACTIVE');
    }

    const matched = reasons.length === 0;
    const saved = this.store.createPrimarySignalShadowPosition({
      signalId: signal.signalId,
      signalEpisodeId: signal.signalEpisodeId,
      mint: signal.mint,
      symbol: signal.symbol,
      status: matched ? STATUS.PENDING_ENTRY : STATUS.RULE_REJECTED,
      ruleMatched: matched,
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
    if (!saved?.inserted) return saved;
    if (matched) {
      this.metrics.matched += 1;
      this.pendingEntries.set(signal.mint, restoredPosition({
        id: saved.id,
        signal_id: signal.signalId,
        signal_episode_id: signal.signalEpisodeId,
        mint: signal.mint,
        symbol: signal.symbol,
        status: STATUS.PENDING_ENTRY,
        signal_at: signalAt,
        signal_price: signalPrice,
        entry_target_at: signalAt + this.config.entryDelayMs,
        entry_deadline_at: signalAt + this.config.entryDelayMs + this.config.entryTimeoutMs,
        confirming_wallets_json: '[]',
      }));
      this.metrics.lastActionAt = this.now();
    }
    return saved;
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint || !(finite(trade.price) > 0)
      || !(finite(trade.timestampMs) > 0)) return;
    const timestampMs = Number(trade.timestampMs);
    this.advanceTime(timestampMs);

    let position = this.positions.get(trade.mint);
    if (position?.status === STATUS.EXIT_PENDING
      && timestampMs >= position.exitTargetAt
      && timestampMs <= position.exitDeadlineAt
      && this._eligibleExitTrade(position, trade)) {
      this._close(position, trade);
      position = null;
    }

    const pending = this.pendingEntries.get(trade.mint);
    if (pending && trade.market === 'PUMP_BONDING_CURVE'
      && timestampMs >= pending.entryTargetAt
      && timestampMs <= pending.entryDeadlineAt) {
      const jumpPct = ((trade.price / pending.signalPrice) - 1) * 100;
      if (jumpPct > this.config.maxEntryPriceJumpPct) {
        this.store.updatePrimarySignalShadowPosition(pending.id, {
          status: STATUS.PRICE_JUMP,
          rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}pct`,
        });
        this.pendingEntries.delete(trade.mint);
      } else {
        pending.status = STATUS.OPEN;
        pending.entryAt = timestampMs;
        pending.entryMarket = trade.market;
        pending.entryPrice = trade.price;
        pending.highestPrice = trade.price;
        this.store.updatePrimarySignalShadowPosition(pending.id, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice: trade.price,
          highestPrice: trade.price,
        });
        this.pendingEntries.delete(trade.mint);
        this.positions.set(trade.mint, pending);
        this.metrics.opened += 1;
        this.metrics.lastActionAt = this.now();
        position = pending;
      }
    }

    position = position || this.positions.get(trade.mint);
    if (!position || position.status !== STATUS.OPEN || !this._eligibleExitTrade(position, trade)) {
      return;
    }

    position.highestPrice = Math.max(position.highestPrice || position.entryPrice, trade.price);
    this.store.updatePrimarySignalShadowPosition(position.id, {
      highestPrice: position.highestPrice,
    });
    const drawdownPct = ((position.highestPrice - trade.price) / position.highestPrice) * 100;
    if (drawdownPct >= this.config.trailingStopPct) {
      this._requestExit(position, 'TRAILING_IMMEDIATE', timestampMs);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updatePrimarySignalShadowPosition(pending.id, { status: STATUS.NO_ENTRY });
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

  _eligibleExitTrade(position, trade) {
    if (trade.market === 'PUMP_BONDING_CURVE') return true;
    if (trade.market !== 'PUMP_AMM') return false;
    const token = this.store.getToken(trade.mint);
    if (!token?.graduated_at || trade.timestampMs < token.graduated_at) return false;
    const ratio = trade.price / position.entryPrice;
    return ratio >= 0.05 && ratio <= 20;
  }

  _requestExit(position, reason, triggerAt) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updatePrimarySignalShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
    this.metrics.lastActionAt = this.now();
  }

  _close(position, trade) {
    const grossReturnPct = ((trade.price / position.entryPrice) - 1) * 100;
    const netReturnPct = grossReturnPct - this.costs.deterministicCostPct;
    this.store.updatePrimarySignalShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: trade.price,
      grossReturnPct,
      netReturnPct,
    });
    this.positions.delete(position.mint);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updatePrimarySignalShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      grossReturnPct: -100,
      netReturnPct: -100 - this.costs.deterministicCostPct,
    });
    this.positions.delete(position.mint);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }
}

module.exports = { PrimarySignalShadowManager, STATUS };
