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

function priceOf(trade) {
  const reservePrice = finite(trade?.reservePrice);
  return reservePrice > 0 ? reservePrice : finite(trade?.price);
}

function valueOf(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function restore(row) {
  return {
    id: row.id,
    cohortId: valueOf(row, 'cohort_id', 'cohortId'),
    episodeId: valueOf(row, 'episode_id', 'episodeId'),
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    positionSol: finite(valueOf(row, 'position_sol', 'positionSol'), 1),
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
    maxFavorableReturnPct: finite(valueOf(
      row, 'max_favorable_return_pct', 'maxFavorableReturnPct',
    ), 0),
    maxAdverseReturnPct: finite(valueOf(
      row, 'max_adverse_return_pct', 'maxAdverseReturnPct',
    ), 0),
    exitTriggerAt: valueOf(row, 'exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: valueOf(row, 'exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: valueOf(row, 'exit_deadline_at', 'exitDeadlineAt'),
    exitReason: valueOf(row, 'exit_reason', 'exitReason'),
  };
}

class MigrationSecondLegShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown({
      ...(config.costModel || {}),
      positionSizeSol: config.positionSizeSol,
    });
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      evaluated: 0,
      matched: 0,
      deduplicated: 0,
      rugRejected: 0,
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
    for (const row of this.store.activeMigrationSecondLegShadowPositions()) {
      const position = restore(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    this.advanceTime(this.now());
  }

  stop() {}

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_M2F_GUARD_B',
      code: this.config.cohortId,
      sendsTransactions: false,
      guardRequired: true,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      strategy: {
        name: 'M2F Near-High Flow + Universal RUG Guard B',
        positionSizeSol: this.config.positionSizeSol,
        entryDelayMs: this.config.entryDelayMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        hardStopPct: this.config.hardStopPct,
        maxHoldMs: this.config.maxHoldMs,
        thresholds: this.config.thresholds,
        configuredCostPct: this.costs.deterministicCostPct,
        isolatedTable: 'migration_second_leg_shadow_positions',
      },
      ...this.metrics,
    };
  }

  trackedMints() {
    return [...this.rowsByMint.keys()];
  }

  onSnapshot(snapshot, trade) {
    if (!this.config.enabled || !snapshot?.mint || !(snapshot.price > 0)) return;
    this.metrics.evaluated += 1;
    if (!this._matches(snapshot)) return;
    const migrationAt = finite(snapshot.migrationAt, snapshot.observedAt - snapshot.ageMs);
    const episodeId = `${snapshot.mint}:${migrationAt}:${this.config.cohortId}`;
    const features = {
      openingImpulsePct: snapshot.openingImpulsePct,
      peakImpulsePct: snapshot.baselinePrice > 0
        ? ((snapshot.peakPrice / snapshot.baselinePrice) - 1) * 100 : null,
      pullbackPct: snapshot.pullbackPct,
      reboundPct: snapshot.reboundPct,
      netFlow3s: snapshot.netFlow3s,
      netFlow10s: snapshot.netFlow10s,
      buyers3s: snapshot.buyers3s,
      buyers10s: snapshot.buyers10s,
      largestBuyerShare10sPct: snapshot.largestBuyerShare10sPct,
      buySpeedRatio: snapshot.buySpeedRatio,
      netFlowAcceleration: snapshot.netFlowAcceleration,
      sellDecelerationRatio: snapshot.sellDecelerationRatio,
      holderDiffusionIndex: snapshot.observedHolderDiffusionIndex,
      quoteReserveSol: snapshot.quoteReserveSol,
      estimatedImpact1SolPct: snapshot.estimatedImpact1SolPct,
    };
    const saved = this.store.createMigrationSecondLegShadowPosition({
      cohortId: this.config.cohortId,
      episodeId,
      mint: snapshot.mint,
      symbol: snapshot.symbol || trade?.symbol || null,
      status: STATUS.PENDING_ENTRY,
      positionSol: this.config.positionSizeSol,
      configuredCostPct: this.costs.deterministicCostPct,
      migrationAt,
      signalAt: snapshot.observedAt,
      signalPrice: snapshot.price,
      signalAgeMs: snapshot.ageMs,
      features,
      entryTargetAt: snapshot.observedAt + this.config.entryDelayMs,
      entryDeadlineAt: snapshot.observedAt + this.config.entryDelayMs
        + this.config.entryTimeoutMs,
      hardStopPct: this.config.hardStopPct,
      maxHoldMs: this.config.maxHoldMs,
    });
    if (!saved?.inserted) {
      this.metrics.deduplicated += 1;
      return;
    }
    const pending = restore(saved);
    this.pendingEntries.set(pending.id, pending);
    this._index(pending);
    this.metrics.matched += 1;
    this.metrics.lastActionAt = this.now();
  }

  observeTrade(trade) {
    const price = priceOf(trade);
    const timestampMs = finite(trade?.timestampMs);
    if (!this.config.enabled || trade?.market !== 'PUMP_AMM' || !trade?.mint
      || !(price > 0) || !(timestampMs > 0)) return;
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (timestampMs < position.entryTargetAt || timestampMs > position.entryDeadlineAt) continue;
        this._tryEntry(position, trade, price);
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        if (timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
          this._close(position, trade, price);
        }
        continue;
      }
      if (position.status !== STATUS.OPEN || timestampMs < position.entryAt) continue;
      this._updateExtrema(position, timestampMs, price);
      const gross = ((price / position.entryPrice) - 1) * 100;
      const heldMs = timestampMs - position.entryAt;
      if (gross <= -this.config.hardStopPct) this._requestExit(position, timestampMs, 'HARD_STOP');
      else if (heldMs >= this.config.maxHoldMs) {
        this._requestExit(position, position.entryAt + this.config.maxHoldMs, 'FIXED_HOLD');
      }
      if (position.status === STATUS.EXIT_PENDING
        && timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
        this._close(position, trade, price);
      }
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const position of [...this.pendingEntries.values()]) {
      if (now <= position.entryDeadlineAt) continue;
      this.store.updateMigrationSecondLegShadowPosition(position.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'ENTRY_TIMEOUT',
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.OPEN && now >= position.entryAt + this.config.maxHoldMs) {
        this._requestExit(position, position.entryAt + this.config.maxHoldMs, 'FIXED_HOLD');
      }
      if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        this._markNoExit(position);
      }
    }
  }

  _matches(snapshot) {
    const t = this.config.thresholds;
    const peakImpulsePct = snapshot.baselinePrice > 0
      ? ((snapshot.peakPrice / snapshot.baselinePrice) - 1) * 100 : null;
    const impact1Sol = finite(snapshot.estimatedImpact1SolPct);
    return snapshot.ageMs >= t.minAgeMs && snapshot.ageMs <= t.maxAgeMs
      && snapshot.openingImpulsePct >= t.minCurrentImpulsePct
      && snapshot.openingImpulsePct <= t.maxCurrentImpulsePct
      && peakImpulsePct >= t.minPeakImpulsePct
      && snapshot.pullbackPct >= t.minPullbackPct
      && snapshot.pullbackPct <= t.maxPullbackPct
      && snapshot.reboundPct >= t.minReboundPct
      && snapshot.netFlow10s >= t.minNetFlow10sSol
      && snapshot.netFlow3s >= t.minNetFlow3sSol
      && snapshot.buyers10s >= t.minBuyers10s
      && snapshot.buyers3s >= t.minBuyers3s
      && finite(snapshot.largestBuyerShare10sPct, 100) <= t.maxLargestBuyerSharePct
      && finite(snapshot.buySpeedRatio, 0) >= t.minBuySpeedRatio
      && finite(snapshot.netFlowAcceleration, -Infinity) >= t.minNetFlowAcceleration
      && finite(snapshot.sellDecelerationRatio, Infinity) <= t.maxSellDecelerationRatio
      && snapshot.observedHolderDiffusionIndex >= t.minHolderDiffusionIndex
      && impact1Sol != null && impact1Sol <= t.maxEstimatedImpact1SolPct;
  }

  _tryEntry(position, trade, price) {
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: this.config.cohortId,
      mint: position.mint,
      timestampMs: trade.timestampMs,
      source: 'SHADOW',
    });
    if (rugGuard.blocked) {
      this.store.updateMigrationSecondLegShadowPosition(position.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'PRE_ENTRY_RUG_RISK',
        rugGuard,
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.rugRejected += 1;
      return;
    }
    const execution = executableBuy(trade, position.positionSol, price);
    if (!execution.available) {
      this.store.updateMigrationSecondLegShadowPosition(position.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: execution.reason || 'ENTRY_CAPACITY_QUOTE_MISSING',
        rugGuard,
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.noEntry += 1;
      return;
    }
    const entryPrice = execution.price ?? price;
    const jumpPct = ((entryPrice / position.signalPrice) - 1) * 100;
    if (jumpPct > this.config.maxEntryPriceJumpPct
      || jumpPct < -this.config.maxNegativeEntryJumpPct) {
      this.store.updateMigrationSecondLegShadowPosition(position.id, {
        status: STATUS.PRICE_JUMP,
        rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
        entryJumpPct: jumpPct,
        entryImpactPct: execution.impactPct,
        rugGuard,
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.priceJump += 1;
      return;
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
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
      status: STATUS.OPEN,
      entryAt: trade.timestampMs,
      entryPrice,
      entryJumpPct: jumpPct,
      entryImpactPct: execution.impactPct,
      highestPrice: price,
      lowestPrice: price,
      lastObservedAt: trade.timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: 0,
      maxAdverseReturnPct: 0,
      rugGuard,
    });
    this.pendingEntries.delete(position.id);
    this.positions.set(position.id, position);
    this.metrics.opened += 1;
  }

  _updateExtrema(position, timestampMs, price) {
    position.highestPrice = Math.max(position.highestPrice || position.entryPrice, price);
    position.lowestPrice = Math.min(position.lowestPrice || position.entryPrice, price);
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
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
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
    Object.assign(position, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: triggerAt,
      exitTargetAt: triggerAt + this.config.exitDelayMs,
      exitDeadlineAt: triggerAt + this.config.exitDelayMs + this.config.exitTimeoutMs,
    });
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
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
    // A missing normal quote is not a fill. Keep waiting until another causal
    // trade or the exit deadline. For an observed RUG, the execution model's
    // conservative zero-proceeds quote is intentionally accepted.
    if (!execution.available && !execution.conservative) return;
    const exitPrice = execution.price ?? price;
    const executableReturnPct = ((exitPrice / position.entryPrice) - 1) * 100;
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitPrice,
      exitImpactPct: execution.impactPct,
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

  _markNoExit(position) {
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      grossReturnPct: -100,
      netReturnPct: -100 - this.costs.deterministicCostPct,
      exitReason: position.exitReason || 'NO_EXIT',
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
}

module.exports = { MigrationSecondLegShadowSuite, STATUS };
