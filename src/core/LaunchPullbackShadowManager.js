'use strict';

const { costBreakdown } = require('./CostModel');

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

function shadowPrice(trade) {
  const reservePrice = finite(trade?.reservePrice);
  return reservePrice > 0 ? reservePrice : finite(trade?.price);
}

function restoredPosition(row) {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    referenceAt: row.reference_at,
    referencePrice: row.reference_price,
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

class LaunchPullbackShadowManager {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.metrics = {
      referencesSeen: 0,
      qualifiedReferences: 0,
      deduplicated: 0,
      rejected: 0,
      priceJump: 0,
      opened: 0,
      closed: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    for (const row of this.store.activeLaunchPullbackShadowPositions(this.config.cohortId)) {
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
        name: `Launch Pullback ${this.config.cohortId}`,
        entry: {
          profileId: this.config.profileId,
          reference: 'PUMP_25_PULLBACK_7.5_REBOUND_3',
          minNetFlowSol: this.config.minNetFlowSol,
          maxCreatorSharePct: this.config.maxCreatorSharePct,
          entryDelayMs: this.config.entryDelayMs,
          entryTimeoutMs: this.config.entryTimeoutMs,
          maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
          market: 'PUMP_BONDING_CURVE',
        },
        exit: this.config.exitPolicy === 'TRAILING_STOP'
          ? {
            policy: 'TRAILING_STOP',
            activationPct: this.config.trailingActivationPct,
            drawdownPct: this.config.trailingDrawdownPct,
            minHoldMs: this.config.minHoldMs,
            maxHoldMs: this.config.maxHoldMs,
            hardStopPct: this.config.hardStopPct,
            exitDelayMs: this.config.exitDelayMs,
            exitTimeoutMs: this.config.exitTimeoutMs,
          }
          : {
            policy: 'FIXED_HOLD',
            fixedHoldMs: this.config.fixedHoldMs,
            exitDelayMs: this.config.exitDelayMs,
            exitTimeoutMs: this.config.exitTimeoutMs,
          },
        research: {
          bigWinnerPct: this.config.bigWinnerPct,
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          isolatedTable: 'launch_pullback_shadow_positions',
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  onReference(reference) {
    if (!this.config.enabled || !reference?.mint) return null;
    const referenceAt = finite(reference.referenceAt);
    const referencePrice = finite(reference.referencePrice);
    if (!(referenceAt > 0) || !(referencePrice > 0)) return null;

    this.metrics.referencesSeen += 1;
    const features = reference.features || {};
    const netFlowSol = finite(features.netFlowSol);
    const creatorSharePct = finite(features.creatorSharePct, 0);
    const reasons = [];
    if (!(netFlowSol >= this.config.minNetFlowSol)) reasons.push('NET_FLOW_BELOW_MIN');
    if (creatorSharePct > this.config.maxCreatorSharePct) {
      reasons.push('CREATOR_SHARE_ABOVE_MAX');
    }
    const matched = reasons.length === 0;
    const saved = this.store.createLaunchPullbackShadowPosition({
      cohortId: this.config.cohortId,
      mint: reference.mint,
      symbol: reference.symbol,
      status: matched ? STATUS.PENDING_ENTRY : STATUS.RULE_REJECTED,
      rejectionReason: reasons.join(',') || null,
      positionSol: this.config.positionSizeSol,
      configuredCostPct: this.costs.deterministicCostPct,
      referenceAt,
      referencePrice,
      pump25At: reference.pump25At,
      referencePeakAt: reference.referencePeakAt,
      referencePeakPrice: reference.referencePeakPrice,
      firstPullbackAt: reference.firstPullbackAt,
      pullbackLowPrice: reference.pullbackLowPrice,
      maxPullbackPct: reference.maxPullbackPct,
      netFlowSol,
      creatorSharePct,
      buyers: finite(features.buyers),
      recentBuyers: finite(features.recentBuyers),
      retentionPct: finite(features.retentionPct),
      top1SharePct: finite(features.top1SharePct),
      top3SharePct: finite(features.top3SharePct),
      entryTargetAt: matched ? referenceAt + this.config.entryDelayMs : null,
      entryDeadlineAt: matched
        ? referenceAt + this.config.entryDelayMs + this.config.entryTimeoutMs : null,
    });
    if (!saved?.inserted) {
      this.metrics.deduplicated += 1;
      return saved;
    }
    if (!matched) {
      this.metrics.rejected += 1;
      return saved;
    }

    this.metrics.qualifiedReferences += 1;
    this.pendingEntries.set(reference.mint, restoredPosition({
      id: saved.id,
      cohort_id: this.config.cohortId,
      mint: reference.mint,
      symbol: reference.symbol || null,
      status: STATUS.PENDING_ENTRY,
      reference_at: referenceAt,
      reference_price: referencePrice,
      entry_target_at: referenceAt + this.config.entryDelayMs,
      entry_deadline_at: referenceAt + this.config.entryDelayMs + this.config.entryTimeoutMs,
    }));
    this.metrics.lastActionAt = this.now();
    return saved;
  }

  observeTrade(trade) {
    const price = shadowPrice(trade);
    const timestampMs = finite(trade?.timestampMs);
    if (!this.config.enabled || !trade?.mint || !(price > 0) || !(timestampMs > 0)) return;
    this.advanceTime(timestampMs);

    let position = this.positions.get(trade.mint);
    if (position?.status === STATUS.EXIT_PENDING && this._eligibleExitTrade(position, trade, price)) {
      this._updatePeak(position, price);
      if (timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
        this._close(position, trade, price);
        position = null;
      }
    }

    const pending = this.pendingEntries.get(trade.mint);
    if (pending && trade.market === 'PUMP_BONDING_CURVE'
      && timestampMs >= pending.entryTargetAt && timestampMs <= pending.entryDeadlineAt) {
      const entryJumpPct = ((price / pending.referencePrice) - 1) * 100;
      if (entryJumpPct > this.config.maxEntryPriceJumpPct) {
        this.store.updateLaunchPullbackShadowPosition(pending.id, {
          status: STATUS.PRICE_JUMP,
          rejectionReason: `ENTRY_PRICE_JUMP_${entryJumpPct.toFixed(2)}PCT`,
          entryJumpPct,
        });
        this.pendingEntries.delete(trade.mint);
        this.metrics.priceJump += 1;
        this.metrics.lastActionAt = this.now();
      } else {
        pending.status = STATUS.OPEN;
        pending.entryAt = timestampMs;
        pending.entryMarket = trade.market;
        pending.entryPrice = price;
        pending.entryJumpPct = entryJumpPct;
        pending.highestPrice = price;
        pending.maxFavorableReturnPct = 0;
        this.store.updateLaunchPullbackShadowPosition(pending.id, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice: price,
          entryJumpPct,
          highestPrice: price,
          maxFavorableReturnPct: 0,
        });
        this.pendingEntries.delete(trade.mint);
        this.positions.set(trade.mint, pending);
        this.metrics.opened += 1;
        this.metrics.lastActionAt = this.now();
        position = pending;
      }
    }

    position = position || this.positions.get(trade.mint);
    if (position?.status === STATUS.OPEN && this._eligibleExitTrade(position, trade, price)) {
      this._updatePeak(position, price);
      this._evaluateTrailingExit(position, price, timestampMs);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateLaunchPullbackShadowPosition(pending.id, { status: STATUS.NO_ENTRY });
      this.pendingEntries.delete(pending.mint);
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      const holdMs = this.config.exitPolicy === 'TRAILING_STOP'
        ? this.config.maxHoldMs
        : this.config.fixedHoldMs;
      const triggerAt = position.entryAt + holdMs;
      if (now >= triggerAt) {
        const reason = this.config.exitPolicy === 'TRAILING_STOP'
          ? `MAX_HOLD_${holdMs / 1_000}S`
          : `FIXED_HOLD_${holdMs / 1_000}S`;
        this._requestExit(position, triggerAt, reason);
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
    this.store.updateLaunchPullbackShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
  }

  _evaluateTrailingExit(position, price, timestampMs) {
    if (this.config.exitPolicy !== 'TRAILING_STOP' || position.status !== STATUS.OPEN) return;
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    if (this.config.hardStopPct != null && grossReturnPct <= -this.config.hardStopPct) {
      this._requestExit(
        position,
        timestampMs,
        `HARD_STOP_${this.config.hardStopPct}PCT`,
      );
      return;
    }

    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    const armed = peakReturnPct >= this.config.trailingActivationPct;
    const oldEnough = timestampMs - position.entryAt >= this.config.minHoldMs;
    const drawdownPct = (1 - price / position.highestPrice) * 100;
    if (armed && oldEnough && drawdownPct >= this.config.trailingDrawdownPct) {
      this._requestExit(
        position,
        timestampMs,
        `TRAILING_DRAWDOWN_${this.config.trailingDrawdownPct}PCT`,
      );
    }
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updateLaunchPullbackShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: position.exitReason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
    this.metrics.lastActionAt = this.now();
  }

  _close(position, trade, price) {
    this._updatePeak(position, price);
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    const netReturnPct = grossReturnPct - this.costs.deterministicCostPct;
    this.store.updateLaunchPullbackShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
      grossReturnPct,
      netReturnPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
    });
    this.positions.delete(position.mint);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateLaunchPullbackShadowPosition(position.id, {
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

module.exports = { LaunchPullbackShadowManager, STATUS, shadowPrice };
