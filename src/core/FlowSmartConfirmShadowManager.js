'use strict';

const { costBreakdown } = require('./CostModel');
const { shadowPrice } = require('./LaunchPullbackShadowManager');
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
    signalId: row.signal_id,
    smartWallet: row.smart_wallet,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    smartOpenAt: row.smart_open_at,
    smartOpenPrice: row.smart_open_price,
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

class FlowSmartConfirmShadowManager {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.metrics = {
      evaluated: 0,
      confirmed: 0,
      rejected: 0,
      priceJump: 0,
      opened: 0,
      closed: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    for (const row of this.store.activeFlowSmartConfirmShadowPositions(this.config.cohortId)) {
      const position = restoredPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.mint, position);
      else this.positions.set(position.mint, position);
    }
    this.advanceTime(this.now());
  }

  stop() {}

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW',
      cohortId: this.config.cohortId,
      cohortLabel: this.config.cohortLabel,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      strategy: {
        name: `Flow then Smart ${this.config.cohortId}`,
        entry: {
          signalVariant: 'primary_3w',
          signalRankInMint: 1,
          confirmationPhase: 'OPEN',
          maxConfirmationDelayMs: this.config.maxConfirmationDelayMs,
          minSmartOpenSol: this.config.minSmartOpenSol,
          entryDelayMs: this.config.entryDelayMs,
          entryTimeoutMs: this.config.entryTimeoutMs,
          maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
          market: 'PUMP_BONDING_CURVE',
          priceBasis: 'FIRST_TRADE_AFTER_SMART_OPEN',
        },
        exit: this.config.exitPolicy === 'FIXED_HOLD'
          ? {
            policy: 'FIXED_HOLD',
            fixedHoldMs: this.config.fixedHoldMs,
            exitDelayMs: this.config.exitDelayMs,
            exitTimeoutMs: this.config.exitTimeoutMs,
          }
          : {
            policy: 'TRAILING_STOP',
            activationPct: this.config.trailingActivationPct,
            drawdownPct: this.config.trailingDrawdownPct,
            hardStopPct: this.config.hardStopPct,
            minHoldMs: this.config.minHoldMs,
            maxHoldMs: this.config.maxHoldMs,
            exitDelayMs: this.config.exitDelayMs,
            exitTimeoutMs: this.config.exitTimeoutMs,
          },
        research: {
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          isolatedTable: 'flow_smart_confirm_shadow_positions',
          retrospectiveEntry: false,
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  onSmartWalletOpen(event) {
    if (!this.config.enabled || !event?.id || !event?.mint || !event?.wallet) return null;
    const phase = String(event.positionPhase || '').toUpperCase();
    if (event.side !== 'BUY' || phase !== 'OPEN') return null;
    const smartOpenAt = finite(event.timestampMs);
    const smartOpenPrice = finite(event.reservePrice, finite(event.price));
    if (!(smartOpenAt > 0) || !(smartOpenPrice > 0)) return null;
    this.metrics.evaluated += 1;

    const signalId = finite(event.nearestFlowSignal);
    const signal = signalId ? this.store.flowSignal(signalId) : null;
    const confirmationDelayMs = signal ? smartOpenAt - signal.timestamp_ms : null;
    const reasons = [];
    if (event.market !== 'PUMP_BONDING_CURVE') reasons.push('NOT_BONDING_CURVE');
    if (!signal) reasons.push('NO_PRIMARY_SIGNAL');
    if (signal && signal.signal_variant !== 'primary_3w') reasons.push('NOT_PRIMARY_3W');
    if (signal && Number(signal.signal_rank_in_mint) !== 1) reasons.push('NOT_SIGNAL_RANK_1');
    if (signal && (confirmationDelayMs < 0
      || confirmationDelayMs > this.config.maxConfirmationDelayMs)) {
      reasons.push('CONFIRMATION_OUTSIDE_WINDOW');
    }
    if (finite(event.solAmount, 0) < this.config.minSmartOpenSol) {
      reasons.push('SMART_OPEN_BELOW_MIN_SOL');
    }
    if (this.pendingEntries.has(event.mint) || this.positions.has(event.mint)) {
      reasons.push('MINT_ALREADY_ACTIVE');
    }
    const matched = reasons.length === 0;
    const entryTargetAt = matched ? smartOpenAt + this.config.entryDelayMs : null;
    const saved = this.store.createFlowSmartConfirmShadowPosition({
      cohortId: this.config.cohortId,
      smartEventId: event.id,
      signalId: signal?.signal_id || signalId || null,
      smartWallet: event.wallet,
      mint: event.mint,
      symbol: event.symbol || signal?.symbol,
      status: matched ? STATUS.PENDING_ENTRY : STATUS.RULE_REJECTED,
      rejectionReason: reasons.join(',') || null,
      positionSol: this.config.positionSizeSol,
      configuredCostPct: this.costs.deterministicCostPct,
      signalAt: signal?.timestamp_ms || smartOpenAt,
      signalPrice: signal?.p0 || smartOpenPrice,
      signalRankInMint: signal?.signal_rank_in_mint,
      signalVariant: signal?.signal_variant || 'UNKNOWN',
      netFlowW3: signal?.netflow_w3,
      uniqueBuyersW3: signal?.unique_buyers_w3,
      smartOpenAt,
      smartOpenPrice,
      smartOpenSol: event.solAmount,
      confirmationDelayMs: confirmationDelayMs ?? -1,
      curvePct: event.curvePct,
      ageMs: event.ageMs,
      entryTargetAt,
      entryDeadlineAt: matched ? entryTargetAt + this.config.entryTimeoutMs : null,
    });
    if (!saved?.inserted) return saved;
    if (!matched) {
      this.metrics.rejected += 1;
      return saved;
    }

    const position = restoredPosition({
      id: saved.id,
      cohort_id: this.config.cohortId,
      smart_event_id: event.id,
      signal_id: signal.signal_id,
      smart_wallet: event.wallet,
      mint: event.mint,
      symbol: event.symbol || signal.symbol || null,
      status: STATUS.PENDING_ENTRY,
      smart_open_at: smartOpenAt,
      smart_open_price: smartOpenPrice,
      entry_target_at: entryTargetAt,
      entry_deadline_at: entryTargetAt + this.config.entryTimeoutMs,
    });
    this.pendingEntries.set(event.mint, position);
    this.metrics.confirmed += 1;
    this.metrics.lastActionAt = this.now();
    return saved;
  }

  observeTrade(trade) {
    const price = shadowPrice(trade);
    const timestampMs = finite(trade?.timestampMs);
    if (!this.config.enabled || !trade?.mint || !(price > 0) || !(timestampMs > 0)) return;
    this.advanceTime(timestampMs);

    const pending = this.pendingEntries.get(trade.mint);
    if (pending && trade.market === 'PUMP_BONDING_CURVE'
      && timestampMs >= pending.entryTargetAt && timestampMs <= pending.entryDeadlineAt) {
      const rugGuard = evaluateUniversalRugGuard(this.store, {
        strategyId: `FLOW_SMART_CONFIRM:${this.config.cohortId}`,
        mint: trade.mint,
        timestampMs,
      });
      const entryJumpPct = ((price / pending.smartOpenPrice) - 1) * 100;
      if (rugGuard.blocked) {
        this.store.updateFlowSmartConfirmShadowPosition(pending.id, {
          status: STATUS.NO_ENTRY,
          rejectionReason: 'PRE_ENTRY_RUG_RISK',
        });
        this.pendingEntries.delete(pending.mint);
      } else if (entryJumpPct > this.config.maxEntryPriceJumpPct) {
        this.store.updateFlowSmartConfirmShadowPosition(pending.id, {
          status: STATUS.PRICE_JUMP,
          rejectionReason: `ENTRY_PRICE_JUMP_${entryJumpPct.toFixed(2)}PCT`,
          entryJumpPct,
        });
        this.pendingEntries.delete(pending.mint);
        this.metrics.priceJump += 1;
      } else {
        Object.assign(pending, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice: price,
          entryJumpPct,
          highestPrice: price,
          maxFavorableReturnPct: 0,
        });
        this.store.updateFlowSmartConfirmShadowPosition(pending.id, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice: price,
          entryJumpPct,
          highestPrice: price,
          maxFavorableReturnPct: 0,
        });
        this.pendingEntries.delete(pending.mint);
        this.positions.set(pending.mint, pending);
        this.metrics.opened += 1;
      }
      this.metrics.lastActionAt = this.now();
    }

    let position = this.positions.get(trade.mint);
    if (position?.status === STATUS.EXIT_PENDING && this._eligibleExitTrade(position, trade, price)) {
      this._updatePeak(position, price);
      if (timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
        this._close(position, trade, price);
        position = null;
      }
    }
    position = position || this.positions.get(trade.mint);
    if (!position || position.status !== STATUS.OPEN
      || !this._eligibleExitTrade(position, trade, price)) return;
    this._updatePeak(position, price);
    this._evaluateExit(position, price, timestampMs);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateFlowSmartConfirmShadowPosition(pending.id, {
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
      const maxHoldMs = this.config.exitPolicy === 'FIXED_HOLD'
        ? this.config.fixedHoldMs : this.config.maxHoldMs;
      if (now >= position.entryAt + maxHoldMs) {
        this._requestExit(position, position.entryAt + maxHoldMs, `MAX_HOLD_${maxHoldMs / 1_000}S`);
      }
    }
  }

  _eligibleExitTrade(position, trade, price) {
    if (trade.market === 'PUMP_BONDING_CURVE') return true;
    if (trade.market !== 'PUMP_AMM') return false;
    const token = this.store.getToken(trade.mint);
    if (!token?.graduated_at || trade.timestampMs < token.graduated_at) return false;
    const ratio = price / position.entryPrice;
    return ratio >= 0.05 && ratio <= 20;
  }

  _updatePeak(position, price) {
    position.highestPrice = Math.max(position.highestPrice || position.entryPrice, price);
    position.maxFavorableReturnPct = Math.max(
      position.maxFavorableReturnPct || 0,
      ((position.highestPrice / position.entryPrice) - 1) * 100,
    );
    this.store.updateFlowSmartConfirmShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
  }

  _evaluateExit(position, price, timestampMs) {
    if (this.config.exitPolicy !== 'TRAILING_STOP') return;
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    if (grossReturnPct <= -this.config.hardStopPct) {
      this._requestExit(position, timestampMs, `HARD_STOP_${this.config.hardStopPct}PCT`);
      return;
    }
    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    const drawdownPct = (1 - price / position.highestPrice) * 100;
    if (peakReturnPct >= this.config.trailingActivationPct
      && timestampMs - position.entryAt >= this.config.minHoldMs
      && drawdownPct >= this.config.trailingDrawdownPct) {
      this._requestExit(position, timestampMs, `TRAILING_${this.config.trailingDrawdownPct}PCT`);
    }
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
    this.store.updateFlowSmartConfirmShadowPosition(position.id, {
      status: position.status,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _close(position, trade, price) {
    this._updatePeak(position, price);
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    this.store.updateFlowSmartConfirmShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
      grossReturnPct,
      netReturnPct: grossReturnPct - this.costs.deterministicCostPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
    this.positions.delete(position.mint);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateFlowSmartConfirmShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
    this.positions.delete(position.mint);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }
}

module.exports = { FlowSmartConfirmShadowManager, STATUS };
