'use strict';

const { costBreakdown } = require('./CostModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');

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
    cohortId: row.cohort_id,
    smartEventId: row.smart_event_id,
    smartWallet: row.smart_wallet,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    smartOpenAt: row.smart_open_at,
    smartOpenPrice: row.smart_open_price,
    smartOpenSol: row.smart_open_sol,
    entryTargetAt: row.entry_target_at,
    entryDeadlineAt: row.entry_deadline_at,
    entryAt: row.entry_at,
    entryMarket: row.entry_market,
    entryPrice: row.entry_price,
    entryJumpPct: row.entry_jump_pct,
    highestPrice: row.highest_price,
    maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
    trailingActivatedAt: row.trailing_activated_at,
    exitTriggerAt: row.exit_trigger_at,
    exitTargetAt: row.exit_target_at,
    exitDeadlineAt: row.exit_deadline_at,
    exitReason: row.exit_reason,
  };
}

class SmartOpenShadowManager {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.metrics = {
      evaluated: 0,
      qualifiedOpens: 0,
      rejected: 0,
      opened: 0,
      closed: 0,
      smartExits: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    for (const row of this.store.activeSmartOpenShadowPositions(this.config.cohortId)) {
      const position = restoredPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.mint, position);
      else this.positions.set(position.mint, position);
    }
    this.advanceTime(this.now());
  }

  stop() {}

  health() {
    const fixedHold = this.config.exitMode === 'FIXED_HOLD';
    const delayedTrailing = this.config.exitMode === 'DELAYED_TRAILING';
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW',
      cohortId: this.config.cohortId,
      cohortLabel: this.config.cohortLabel,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      strategy: {
        name: `Smart OPEN ${this.config.cohortId}`,
        entry: {
          positionPhase: 'OPEN',
          market: 'PUMP_BONDING_CURVE',
          minSmartOpenSol: this.config.minSmartOpenSol,
          preBuyWindowMs: this.config.preBuyWindowMs,
          minPreBuyers: this.config.minPreBuyers,
          maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
          entryDelayMs: this.config.entryDelayMs,
          entryTimeoutMs: this.config.entryTimeoutMs,
        },
        exit: {
          policy: fixedHold
            ? 'FIXED_HOLD'
            : delayedTrailing ? 'DELAYED_TRAILING' : 'SMART_REDUCE_OR_CLOSE',
          fixedHoldMs: fixedHold ? this.config.fixedHoldMs : null,
          hardStopPct: fixedHold ? null : this.config.hardStopPct,
          trailingActivationPct: delayedTrailing ? this.config.trailingActivationPct : null,
          trailingStopPct: delayedTrailing ? this.config.trailingStopPct : null,
          followSmartExit: Boolean(this.config.followSmartExit),
          maxHoldMs: fixedHold ? this.config.fixedHoldMs : this.config.maxHoldMs,
          exitDelayMs: this.config.exitDelayMs,
          exitTimeoutMs: this.config.exitTimeoutMs,
        },
        research: {
          bigWinnerPct: this.config.bigWinnerPct,
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          sendsTransactions: false,
          isolatedTable: 'smart_open_shadow_positions',
        },
      },
      ...this.metrics,
    };
  }

  onSmartWalletEvent(event, context = {}) {
    if (!this.config.enabled || !event?.mint || !event?.wallet || !event?.id) return null;
    const phase = String(event.positionPhase || '').toUpperCase();
    if (event.side === 'SELL' || ['REDUCE', 'CLOSE'].includes(phase)) {
      this._onSmartExit(event, phase);
      return null;
    }
    if (event.side !== 'BUY') return null;

    const smartOpenAt = finite(event.timestampMs);
    const smartOpenPrice = finite(event.price);
    if (!(smartOpenAt > 0) || !(smartOpenPrice > 0)) return null;
    this.metrics.evaluated += 1;

    const preBuyers = Math.max(0, Math.trunc(finite(context.uniqueBuyers, 0)));
    const reasons = [];
    if (phase !== 'OPEN') reasons.push('NOT_OPEN');
    if (event.market !== 'PUMP_BONDING_CURVE') reasons.push('NOT_BONDING_CURVE');
    if (finite(event.solAmount, 0) < this.config.minSmartOpenSol) {
      reasons.push('SMART_OPEN_BELOW_MIN_SOL');
    }
    if (preBuyers < this.config.minPreBuyers) reasons.push('INSUFFICIENT_PREBUY_BUYERS');
    if (this.pendingEntries.has(event.mint) || this.positions.has(event.mint)) {
      reasons.push('MINT_ALREADY_ACTIVE');
    }
    const matched = reasons.length === 0;
    const saved = this.store.createSmartOpenShadowPosition({
      cohortId: this.config.cohortId,
      smartEventId: event.id,
      smartWallet: event.wallet,
      mint: event.mint,
      symbol: event.symbol,
      status: matched ? STATUS.PENDING_ENTRY : STATUS.RULE_REJECTED,
      rejectionReason: reasons.join(',') || null,
      positionSol: this.config.positionSizeSol,
      configuredCostPct: this.costs.deterministicCostPct,
      smartOpenAt,
      smartOpenPrice,
      smartOpenSol: event.solAmount,
      curvePct: event.curvePct,
      ageMs: event.ageMs,
      preBuyWindowMs: context.windowMs || this.config.preBuyWindowMs,
      preBuyers,
      preBuyTx: context.buyTx,
      preBuyFlowSol: context.buyFlowSol,
      preSellFlowSol: context.sellFlowSol,
      preNetFlowSol: context.netFlowSol,
      entryTargetAt: matched ? smartOpenAt + this.config.entryDelayMs : null,
      entryDeadlineAt: matched
        ? smartOpenAt + this.config.entryDelayMs + this.config.entryTimeoutMs
        : null,
    });
    if (!saved?.inserted) return saved;
    if (!matched) {
      this.metrics.rejected += 1;
      return saved;
    }

    this.pendingEntries.set(event.mint, restoredPosition({
      id: saved.id,
      cohort_id: this.config.cohortId,
      smart_event_id: event.id,
      smart_wallet: event.wallet,
      mint: event.mint,
      symbol: event.symbol || null,
      status: STATUS.PENDING_ENTRY,
      smart_open_at: smartOpenAt,
      smart_open_price: smartOpenPrice,
      smart_open_sol: event.solAmount,
      entry_target_at: smartOpenAt + this.config.entryDelayMs,
      entry_deadline_at: smartOpenAt + this.config.entryDelayMs + this.config.entryTimeoutMs,
    }));
    this.metrics.qualifiedOpens += 1;
    this.metrics.lastActionAt = this.now();
    return saved;
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint || !(finite(trade.price) > 0)
      || !(finite(trade.timestampMs) > 0)) return;
    const timestampMs = Number(trade.timestampMs);
    this.advanceTime(timestampMs);

    const pending = this.pendingEntries.get(trade.mint);
    if (pending && trade.market === 'PUMP_BONDING_CURVE'
      && timestampMs >= pending.entryTargetAt && timestampMs <= pending.entryDeadlineAt) {
      const rugGuard = evaluateUniversalRugGuard(this.store, {
        strategyId: `SMART_OPEN:${this.config.cohortId}`,
        mint: trade.mint,
        timestampMs,
      });
      const entryJumpPct = ((trade.price / pending.smartOpenPrice) - 1) * 100;
      if (rugGuard.blocked) {
        this.store.updateSmartOpenShadowPosition(pending.id, {
          status: STATUS.NO_ENTRY,
          rejectionReason: 'PRE_ENTRY_RUG_RISK',
        });
        this.pendingEntries.delete(pending.mint);
      } else if (entryJumpPct > this.config.maxEntryPriceJumpPct) {
        this.store.updateSmartOpenShadowPosition(pending.id, {
          status: STATUS.PRICE_JUMP,
          rejectionReason: `ENTRY_PRICE_JUMP_${entryJumpPct.toFixed(2)}pct`,
          entryJumpPct,
        });
        this.pendingEntries.delete(pending.mint);
      } else {
        Object.assign(pending, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice: trade.price,
          entryJumpPct,
          highestPrice: trade.price,
          maxFavorableReturnPct: 0,
        });
        this.store.updateSmartOpenShadowPosition(pending.id, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice: trade.price,
          entryJumpPct,
          highestPrice: trade.price,
          maxFavorableReturnPct: 0,
        });
        this.pendingEntries.delete(pending.mint);
        this.positions.set(pending.mint, pending);
        this.metrics.opened += 1;
        this.metrics.lastActionAt = this.now();
      }
    }

    let position = this.positions.get(trade.mint);
    if (position?.status === STATUS.EXIT_PENDING && this._eligibleExitTrade(position, trade)) {
      this._updatePeak(position, trade);
      if (timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
        this._close(position, trade);
        position = null;
      }
    }
    position = position || this.positions.get(trade.mint);
    if (!position || position.status !== STATUS.OPEN || !this._eligibleExitTrade(position, trade)) {
      return;
    }

    this._updatePeak(position, trade);
    const grossReturnPct = ((trade.price / position.entryPrice) - 1) * 100;
    if (this.config.hardStopPct > 0 && grossReturnPct <= -this.config.hardStopPct) {
      this._requestExit(position, `HARD_STOP_${this.config.hardStopPct}PCT`, timestampMs);
      return;
    }
    if (this.config.exitMode !== 'DELAYED_TRAILING') return;
    if (!position.trailingActivatedAt
      && grossReturnPct >= this.config.trailingActivationPct) {
      position.trailingActivatedAt = timestampMs;
      this.store.updateSmartOpenShadowPosition(position.id, {
        trailingActivatedAt: timestampMs,
      });
    }
    if (!position.trailingActivatedAt) return;
    const drawdownPct = ((position.highestPrice - trade.price) / position.highestPrice) * 100;
    if (drawdownPct >= this.config.trailingStopPct) {
      this._requestExit(position, `TRAILING_${this.config.trailingStopPct}PCT`, timestampMs);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateSmartOpenShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'ENTRY_TIMEOUT',
      });
      this.pendingEntries.delete(pending.mint);
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      const maxHoldMs = this.config.exitMode === 'FIXED_HOLD'
        ? this.config.fixedHoldMs : this.config.maxHoldMs;
      if (now < position.entryAt + maxHoldMs) continue;
      const reason = this.config.exitMode === 'FIXED_HOLD'
        ? 'FIXED_HOLD_5S' : `MAX_HOLD_${Math.round(maxHoldMs / 1000)}S`;
      this._requestExit(position, reason, position.entryAt + maxHoldMs);
    }
  }

  _onSmartExit(event, phase) {
    if (!this.config.followSmartExit) return;
    const pending = this.pendingEntries.get(event.mint);
    if (pending?.smartWallet === event.wallet) {
      this.store.updateSmartOpenShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: `SMART_${phase || 'SELL'}_BEFORE_ENTRY`,
      });
      this.pendingEntries.delete(pending.mint);
    }
    const position = this.positions.get(event.mint);
    if (!position || position.smartWallet !== event.wallet || position.status !== STATUS.OPEN) return;
    this.metrics.smartExits += 1;
    this._requestExit(position, `SMART_WALLET_${phase || 'SELL'}`, event.timestampMs);
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
    this.store.updateSmartOpenShadowPosition(position.id, {
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
    this.store.updateSmartOpenShadowPosition(position.id, {
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
    this.store.updateSmartOpenShadowPosition(position.id, {
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
    this.store.updateSmartOpenShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
    this.positions.delete(position.mint);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }
}

module.exports = { SmartOpenShadowManager, STATUS };
