'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
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
  constructor({ config, store, now = () => Date.now(), onLiveSignal = null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.onLiveSignal = typeof onLiveSignal === 'function' ? onLiveSignal : null;
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
      liveSignalsEmitted: 0,
      replayLiveSignalsSuppressed: 0,
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
          referenceProfileId: this.config.referenceProfileId || 'LEGACY_7_5_R3',
          reference: {
            pumpPct: 25,
            pullbackPct: this.config.referencePullbackPct ?? 7.5,
            reboundPct: this.config.referenceReboundPct ?? 3,
            lowStableMs: this.config.lowStableMs || 0,
            minNewBuyers: this.config.minNewBuyers || 0,
            flowWindowMs: this.config.flowWindowMs || 0,
            minWindowNetFlowSol: this.config.minWindowNetFlowSol ?? null,
            maxPullbackPct: this.config.maxPullbackPct ?? null,
          },
          minNetFlowSol: this.config.minNetFlowSol,
          maxNetFlowSol: this.config.maxNetFlowSol ?? null,
          maxCreatorSharePct: this.config.maxCreatorSharePct,
          minBuyers: this.config.minBuyers || 0,
          minRecentBuyers: this.config.minRecentBuyers || 0,
          minRetentionPct: this.config.minRetentionPct || 0,
          maxTop3SharePct: this.config.maxTop3SharePct ?? 100,
          minSellSolSincePeak: this.config.minSellSolSincePeak ?? null,
          minBuyRefillRatio: this.config.minBuyRefillRatio ?? null,
          minRecentNetFlow1s: this.config.minRecentNetFlow1s ?? null,
          minNetFlowAcceleration1s: this.config.minNetFlowAcceleration1s ?? null,
          flowConfirmationWindowMs: this.config.flowConfirmationWindowMs ?? null,
          minFlowSignalBuyersW3: this.config.minFlowSignalBuyersW3 ?? null,
          entryDelayMs: this.config.entryDelayMs,
          entryTimeoutMs: this.config.entryTimeoutMs,
          maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
          market: 'PUMP_BONDING_CURVE',
        },
        exit: {
          policy: this.config.exitPolicy,
          fixedHoldMs: this.config.fixedHoldMs ?? null,
          activationPct: this.config.trailingActivationPct ?? null,
          drawdownPct: this.config.trailingDrawdownPct ?? null,
          trailingTiers: this.config.trailingTiers || null,
          strengthCheckMs: this.config.strengthCheckMs ?? null,
          minStrengthMfePct: this.config.minStrengthMfePct ?? null,
          minHoldMs: this.config.minHoldMs ?? null,
          maxHoldMs: this.config.maxHoldMs ?? null,
          hardStopPct: this.config.hardStopPct ?? null,
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
    const referenceProfileId = reference.referenceProfileId || 'LEGACY_7_5_R3';
    if (referenceProfileId !== (this.config.referenceProfileId || 'LEGACY_7_5_R3')) return null;
    const referenceAt = finite(reference.referenceAt);
    const referencePrice = finite(reference.referencePrice);
    if (!(referenceAt > 0) || !(referencePrice > 0)) return null;

    this.metrics.referencesSeen += 1;
    const features = reference.features || {};
    const netFlowSol = finite(features.netFlowSol);
    const creatorSharePct = finite(features.creatorSharePct, 0);
    const sellSolSincePeak = Math.max(0, finite(features.sellSolSincePeak, 0));
    const buySolSincePeak = Math.max(0, finite(features.buySolSincePeak, 0));
    const buyRefillRatio = buySolSincePeak / Math.max(sellSolSincePeak, 0.05);
    const recentNetFlow1s = finite(features.recentNetFlow1s, 0);
    const previousNetFlow1s = finite(features.previousNetFlow1s, 0);
    const netFlowAcceleration1s = finite(
      features.netFlowAcceleration1s,
      recentNetFlow1s - previousNetFlow1s,
    );
    const flowConfirmationAt = features.flowConfirmationAt == null
      ? null : finite(features.flowConfirmationAt);
    const flowConfirmationVariant = features.flowConfirmationVariant == null
      ? null : String(features.flowConfirmationVariant);
    const flowConfirmationBuyersW3 = features.flowConfirmationBuyersW3 == null
      ? null : finite(features.flowConfirmationBuyersW3);
    const flowConfirmationNetFlowW3 = features.flowConfirmationNetFlowW3 == null
      ? null : finite(features.flowConfirmationNetFlowW3);
    const flowConfirmationWindowMs = finite(
      features.flowConfirmationWindowMs,
      this.config.flowConfirmationWindowMs,
    );
    const reasons = reference.rejectionReason ? [reference.rejectionReason] : [];
    if (!(netFlowSol >= this.config.minNetFlowSol)) reasons.push('NET_FLOW_BELOW_MIN');
    if (this.config.maxNetFlowSol != null && netFlowSol > this.config.maxNetFlowSol) {
      reasons.push('NET_FLOW_ABOVE_MAX');
    }
    if (creatorSharePct > this.config.maxCreatorSharePct) {
      reasons.push('CREATOR_SHARE_ABOVE_MAX');
    }
    if (finite(features.buyers, 0) < (this.config.minBuyers || 0)) {
      reasons.push('BUYERS_BELOW_MIN');
    }
    if (finite(features.recentBuyers, 0) < (this.config.minRecentBuyers || 0)) {
      reasons.push('RECENT_BUYERS_BELOW_MIN');
    }
    if (finite(features.retentionPct, 0) < (this.config.minRetentionPct || 0)) {
      reasons.push('RETENTION_BELOW_MIN');
    }
    if (finite(features.top3SharePct, 0) > (this.config.maxTop3SharePct ?? 100)) {
      reasons.push('TOP3_SHARE_ABOVE_MAX');
    }
    if (this.config.minSellSolSincePeak != null
      && sellSolSincePeak < this.config.minSellSolSincePeak) {
      reasons.push('SELL_SINCE_PEAK_BELOW_MIN');
    }
    if (this.config.minBuyRefillRatio != null
      && buyRefillRatio < this.config.minBuyRefillRatio) {
      reasons.push('BUY_REFILL_BELOW_MIN');
    }
    if (this.config.minRecentNetFlow1s != null
      && recentNetFlow1s < this.config.minRecentNetFlow1s) {
      reasons.push('RECENT_NET_FLOW_1S_BELOW_MIN');
    }
    if (this.config.minNetFlowAcceleration1s != null
      && netFlowAcceleration1s < this.config.minNetFlowAcceleration1s) {
      reasons.push('NET_FLOW_ACCEL_1S_BELOW_MIN');
    }
    if (this.config.minFlowSignalBuyersW3 != null
      && !(flowConfirmationBuyersW3 >= this.config.minFlowSignalBuyersW3)) {
      reasons.push('FLOW_CONFIRMATION_BUYERS_W3_BELOW_MIN');
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
      referenceProfileId,
      referenceAt,
      referencePrice,
      pump25At: reference.pump25At,
      referencePeakAt: reference.referencePeakAt,
      referencePeakPrice: reference.referencePeakPrice,
      firstPullbackAt: reference.firstPullbackAt,
      pullbackLowPrice: reference.pullbackLowPrice,
      maxPullbackPct: reference.maxPullbackPct,
      referenceReboundPct: finite(
        features.deepReboundPct,
        finite(reference.pullbackLowPrice) > 0
          ? ((referencePrice / reference.pullbackLowPrice) - 1) * 100 : null,
      ),
      lowStableMs: finite(features.lowStableMs),
      buyersSincePullbackLow: finite(features.buyersSincePullbackLow),
      windowNetFlowSol: finite(features.windowNetFlowSol),
      flowWindowMs: finite(features.flowWindowMs),
      netFlowSol,
      creatorSharePct,
      buyers: finite(features.buyers),
      recentBuyers: finite(features.recentBuyers),
      retentionPct: finite(features.retentionPct),
      top1SharePct: finite(features.top1SharePct),
      top3SharePct: finite(features.top3SharePct),
      sellSolSincePeak,
      buySolSincePeak,
      buyRefillRatio,
      recentNetFlow1s,
      previousNetFlow1s,
      netFlowAcceleration1s,
      flowConfirmationAt,
      flowConfirmationVariant,
      flowConfirmationBuyersW3,
      flowConfirmationNetFlowW3,
      flowConfirmationWindowMs,
      marketRegimeObservedAt: finite(features.marketRegimeObservedAt),
      marketRegimeIndependentMints: finite(features.marketRegimeIndependentMints),
      marketRegimeAverageNetReturn5s: features.marketRegimeAverageNetReturn5s == null
        ? null : finite(features.marketRegimeAverageNetReturn5s),
      marketRegimeWinRate5s: features.marketRegimeWinRate5s == null
        ? null : finite(features.marketRegimeWinRate5s),
      marketRegimeBig20Rate5s: features.marketRegimeBig20Rate5s == null
        ? null : finite(features.marketRegimeBig20Rate5s),
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

  observeTrade(trade, { replay = false } = {}) {
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
      const rugGuard = evaluateUniversalRugGuard(this.store, {
        strategyId: `LAUNCH_PULLBACK:${this.config.cohortId}`,
        mint: trade.mint,
        timestampMs,
      });
      const entryExecution = executableBuy(trade, pending.positionSol, price);
      const entryPrice = entryExecution.price ?? price;
      const entryJumpPct = ((entryPrice / pending.referencePrice) - 1) * 100;
      if (rugGuard.blocked) {
        this.store.updateLaunchPullbackShadowPosition(pending.id, {
          status: STATUS.NO_ENTRY,
          rejectionReason: 'PRE_ENTRY_RUG_RISK',
        });
        this.pendingEntries.delete(trade.mint);
      } else if (entryJumpPct > this.config.maxEntryPriceJumpPct) {
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
        pending.entryPrice = entryPrice;
        pending.entryJumpPct = entryJumpPct;
        pending.highestPrice = price;
        pending.maxFavorableReturnPct = 0;
        this.store.updateLaunchPullbackShadowPosition(pending.id, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice,
          entryJumpPct,
          highestPrice: price,
          maxFavorableReturnPct: 0,
        });
        this.pendingEntries.delete(trade.mint);
        this.positions.set(trade.mint, pending);
        this.metrics.opened += 1;
        this.metrics.lastActionAt = this.now();
        this._emitLiveSignal(pending, trade, price, replay);
        position = pending;
      }
    }

    position = position || this.positions.get(trade.mint);
    if (position?.status === STATUS.OPEN && this._eligibleExitTrade(position, trade, price)) {
      this._updatePeak(position, price);
      this._evaluateTrailingExit(position, price, timestampMs);
    }
  }

  _emitLiveSignal(position, trade, marketPrice, replay) {
    if (!this.onLiveSignal || !this.config.liveStrategyId) return;
    if (replay) {
      this.metrics.replayLiveSignalsSuppressed += 1;
      return;
    }
    try {
      this.onLiveSignal({
        strategyId: this.config.liveStrategyId,
        episodeId: `${position.mint}:${position.cohortId}:${position.referenceAt}`,
        mint: position.mint,
        symbol: position.symbol || null,
        price: marketPrice,
        slot: trade.slot,
        timestampMs: trade.timestampMs,
        receivedAtMs: trade.receivedAtMs || trade.timestampMs,
        market: 'PUMP_BONDING_CURVE',
        virtualSolReservesRaw: trade.virtualSolReservesRaw || null,
        virtualTokenReservesRaw: trade.virtualTokenReservesRaw || null,
        realSolReservesRaw: trade.realSolReservesRaw || null,
        realTokenReservesRaw: trade.realTokenReservesRaw || null,
        features: {
          shadowCohortId: position.cohortId,
          shadowReferenceAt: position.referenceAt,
          shadowReferencePrice: position.referencePrice,
          shadowEntryJumpPct: position.entryJumpPct,
        },
      });
      this.metrics.liveSignalsEmitted += 1;
    } catch (error) {
      this.metrics.lastError = error.message;
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
      const holdMs = this.config.exitPolicy === 'FIXED_HOLD'
        ? this.config.fixedHoldMs
        : this.config.maxHoldMs;
      const triggerAt = position.entryAt + holdMs;
      if (now >= triggerAt) {
        const reason = this.config.exitPolicy === 'FIXED_HOLD'
          ? `FIXED_HOLD_${holdMs / 1_000}S`
          : `MAX_HOLD_${holdMs / 1_000}S`;
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
    if (position.status !== STATUS.OPEN) return;
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    if (this.config.hardStopPct != null && grossReturnPct <= -this.config.hardStopPct) {
      this._requestExit(
        position,
        timestampMs,
        `HARD_STOP_${this.config.hardStopPct}PCT`,
      );
      return;
    }
    if (this.config.exitPolicy === 'FIXED_HOLD') return;

    const ageMs = timestampMs - position.entryAt;
    if (this.config.exitPolicy === 'EARLY_STRENGTH'
      && ageMs >= this.config.strengthCheckMs
      && position.maxFavorableReturnPct < this.config.minStrengthMfePct) {
      this._requestExit(position, timestampMs,
        `NO_STRENGTH_${this.config.strengthCheckMs / 1_000}S`);
      return;
    }

    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    if (this.config.exitPolicy === 'TIERED_TRAILING') {
      const tier = [...(this.config.trailingTiers || [])]
        .sort((left, right) => left.activationPct - right.activationPct)
        .filter((row) => peakReturnPct >= row.activationPct)
        .at(-1);
      const oldEnough = ageMs >= (this.config.minHoldMs || 0);
      const drawdownPct = (1 - price / position.highestPrice) * 100;
      if (tier && oldEnough && drawdownPct >= tier.drawdownPct) {
        this._requestExit(position, timestampMs,
          `TIERED_TRAILING_${tier.activationPct}_${tier.drawdownPct}`);
      }
      return;
    }
    if (this.config.exitPolicy !== 'TRAILING_STOP') return;
    const armed = peakReturnPct >= this.config.trailingActivationPct;
    const oldEnough = ageMs >= this.config.minHoldMs;
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
    const markReturnPct = ((price / position.entryPrice) - 1) * 100;
    const execution = executableSell(
      trade,
      position.positionSol / position.entryPrice,
      price,
      { rugMarkReturnPct: markReturnPct },
    );
    const executablePrice = execution.price ?? price;
    const executableReturnPct = ((executablePrice / position.entryPrice) - 1) * 100;
    const netReturnPct = executableReturnPct - this.costs.deterministicCostPct;
    this.store.updateLaunchPullbackShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: executablePrice,
      grossReturnPct: markReturnPct,
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
