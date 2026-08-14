'use strict';

const { costBreakdown } = require('./CostModel');

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

function positionFromRow(row) {
  const value = (snake, camel) => row[snake] ?? row[camel];
  return {
    id: row.id,
    cohortId: value('cohort_id', 'cohortId'),
    entryProfileId: value('entry_profile_id', 'entryProfileId'),
    exitProfileId: value('exit_profile_id', 'exitProfileId'),
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    signalAt: value('signal_at', 'signalAt'),
    signalPrice: value('signal_price', 'signalPrice'),
    entryTargetAt: value('entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: value('entry_deadline_at', 'entryDeadlineAt'),
    entryAt: value('entry_at', 'entryAt'),
    entryMarket: value('entry_market', 'entryMarket'),
    entryPrice: value('entry_price', 'entryPrice'),
    highestPrice: value('highest_price', 'highestPrice'),
    lowestPrice: value('lowest_price', 'lowestPrice'),
    lastObservedAt: value('last_observed_at', 'lastObservedAt'),
    lastPrice: value('last_price', 'lastPrice'),
    maxFavorableReturnPct: finite(
      value('max_favorable_return_pct', 'maxFavorableReturnPct'),
      0,
    ),
    maxAdverseReturnPct: finite(
      value('max_adverse_return_pct', 'maxAdverseReturnPct'),
      0,
    ),
    trailingActivatedAt: value('trailing_activated_at', 'trailingActivatedAt'),
    hardStopPct: value('hard_stop_pct', 'hardStopPct'),
    trailingActivationPct: value('trailing_activation_pct', 'trailingActivationPct'),
    trailingStopPct: value('trailing_stop_pct', 'trailingStopPct'),
    maxHoldMs: value('max_hold_ms', 'maxHoldMs'),
    exitTriggerAt: value('exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: value('exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: value('exit_deadline_at', 'exitDeadlineAt'),
    exitReason: value('exit_reason', 'exitReason'),
  };
}

class HolderGrowthShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfile = config.exitProfile;
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      evaluated: 0,
      matched: 0,
      replayMatchesSuppressed: 0,
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
    for (const row of this.store.activeHolderGrowthShadowPositions()) {
      const position = positionFromRow(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const now = this.now();
    const lookbackMs = this.exitProfile.maxHoldMs + this.config.exitTimeoutMs + 5_000;
    for (const trade of this.store.recentCurveTrades(now - lookbackMs)) {
      this.observeTrade(trade, { replay: true });
    }
    this.advanceTime(now);
  }

  stop() {}

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_N',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfile: this.exitProfile,
      strategy: {
        scope: 'PRE_MIGRATION_OBSERVED_HOLDER_GROWTH',
        snapshotHorizonMs: this.config.snapshotHorizonMs,
        entryDelayMs: this.config.entryDelayMs,
        entryTimeoutMs: this.config.entryTimeoutMs,
        maxSnapshotLagMs: this.config.maxSnapshotLagMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        research: {
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          isolatedTable: 'holder_growth_shadow_positions',
          holderDefinition: 'Observed unique buyers plus first-20 buyer retention; not chain holder count',
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  onSnapshot(snapshot, { replay = false } = {}) {
    if (!this.config.enabled || !snapshot?.mint
      || snapshot.horizonMs !== this.config.snapshotHorizonMs
      || !(snapshot.price > 0)
      || snapshot.observationLagMs > this.config.maxSnapshotLagMs) return;
    this.metrics.evaluated += 1;
    for (const profile of this.entryProfiles.values()) {
      if (!this._matches(profile, snapshot)) continue;
      this.metrics.matched += 1;
      if (replay) {
        this.metrics.replayMatchesSuppressed += 1;
        continue;
      }
      this._createPending(profile, snapshot);
    }
  }

  observeTrade(trade) {
    const timestampMs = finite(trade?.timestampMs);
    const price = shadowPrice(trade);
    if (!this.config.enabled || trade?.market !== 'PUMP_BONDING_CURVE'
      || !trade?.mint || !(timestampMs > 0) || !(price > 0)) return;
    this.advanceTime(timestampMs);
    const ids = [...(this.rowsByMint.get(trade.mint) || [])];
    for (const id of ids) {
      const pending = this.pendingEntries.get(id);
      if (pending) {
        if (timestampMs < pending.entryTargetAt || timestampMs > pending.entryDeadlineAt) continue;
        this._open(pending, trade, price);
        continue;
      }
      const position = this.positions.get(id);
      if (!position || trade.market !== position.entryMarket) continue;
      if (position.status === STATUS.EXIT_PENDING) {
        if (timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
          this._close(position, trade, price);
        }
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      this._observeOpen(position, trade, price);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateHolderGrowthShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'NO_CURVE_TRADE_WITHIN_ENTRY_WINDOW',
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status === STATUS.OPEN && now - position.entryAt >= position.maxHoldMs) {
        this._requestExit(position, position.entryAt + position.maxHoldMs, 'MAX_HOLD_120S');
      }
    }
  }

  _matches(profile, snapshot) {
    return snapshot.buyers >= profile.minBuyers
      && snapshot.newBuyers >= profile.minNewBuyers
      && finite(snapshot.retentionPct, -1) >= profile.minRetentionPct
      && snapshot.netFlowSol >= profile.minNetFlowSol
      && finite(snapshot.top3SharePct, 101) <= profile.maxTop3SharePct;
  }

  _createPending(profile, snapshot) {
    const cohortId = `${profile.id}:${this.exitProfile.id}`;
    const token = this.store.getToken(snapshot.mint) || {};
    const row = this.store.createHolderGrowthShadowPosition({
      cohortId,
      entryProfileId: profile.id,
      exitProfileId: this.exitProfile.id,
      mint: snapshot.mint,
      symbol: token.symbol || null,
      status: STATUS.PENDING_ENTRY,
      positionSol: this.config.positionSizeSol,
      configuredCostPct: this.costs.deterministicCostPct,
      horizonMs: snapshot.horizonMs,
      signalAt: snapshot.observedAt,
      signalPrice: snapshot.price,
      observationLagMs: snapshot.observationLagMs,
      buyers: snapshot.buyers,
      newBuyers: snapshot.newBuyers,
      retentionPct: snapshot.retentionPct,
      netFlowSol: snapshot.netFlowSol,
      top3SharePct: snapshot.top3SharePct,
      curvePct: snapshot.curvePct,
      virtualSolReserves: snapshot.virtualSolReserves,
      features: snapshot,
      entryTargetAt: snapshot.observedAt + this.config.entryDelayMs,
      entryDeadlineAt: snapshot.observedAt + this.config.entryDelayMs
        + this.config.entryTimeoutMs,
      hardStopPct: this.exitProfile.hardStopPct,
      trailingActivationPct: this.exitProfile.trailingActivationPct,
      trailingStopPct: this.exitProfile.trailingStopPct,
      maxHoldMs: this.exitProfile.maxHoldMs,
    });
    if (!row?.inserted) return;
    const position = positionFromRow(row);
    this.pendingEntries.set(position.id, position);
    this._index(position);
    this.metrics.lastActionAt = this.now();
  }

  _open(position, trade, price) {
    const jumpPct = ((price / position.signalPrice) - 1) * 100;
    if (jumpPct > this.config.maxEntryPriceJumpPct
      || jumpPct < -this.config.maxEntryPriceDropPct) {
      this.store.updateHolderGrowthShadowPosition(position.id, {
        status: STATUS.PRICE_JUMP,
        rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}pct`,
        entryJumpPct: jumpPct,
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.priceJump += 1;
      return;
    }
    Object.assign(position, {
      status: STATUS.OPEN,
      entryAt: trade.timestampMs,
      entryMarket: trade.market,
      entryPrice: price,
      highestPrice: price,
      lowestPrice: price,
      lastObservedAt: trade.timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: 0,
      maxAdverseReturnPct: 0,
    });
    this.store.updateHolderGrowthShadowPosition(position.id, {
      status: STATUS.OPEN,
      entryAt: position.entryAt,
      entryMarket: position.entryMarket,
      entryPrice: price,
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
    this.metrics.lastActionAt = this.now();
  }

  _observeOpen(position, trade, price) {
    this._updateExtrema(position, trade.timestampMs, price);
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    if (!position.trailingActivatedAt
      && grossReturnPct >= position.trailingActivationPct) {
      position.trailingActivatedAt = trade.timestampMs;
      this.store.updateHolderGrowthShadowPosition(position.id, {
        trailingActivatedAt: trade.timestampMs,
      });
    }
    if (grossReturnPct <= -position.hardStopPct) {
      this._requestExit(position, trade.timestampMs, 'HARD_STOP');
      return;
    }
    const peakDrawdownPct = (1 - price / position.highestPrice) * 100;
    if (position.trailingActivatedAt && peakDrawdownPct >= position.trailingStopPct) {
      this._requestExit(position, trade.timestampMs, 'TRAILING_15PCT');
    }
  }

  _updateExtrema(position, timestampMs, price) {
    position.highestPrice = Math.max(position.highestPrice || price, price);
    position.lowestPrice = Math.min(position.lowestPrice || price, price);
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
    this.store.updateHolderGrowthShadowPosition(position.id, {
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
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updateHolderGrowthShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _close(position, trade, price) {
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    if (grossReturnPct > this.config.maxPlausibleReturnPct || grossReturnPct < -100) return;
    this._updateExtrema(position, trade.timestampMs, price);
    this.store.updateHolderGrowthShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
      grossReturnPct,
      netReturnPct: grossReturnPct - this.costs.deterministicCostPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateHolderGrowthShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      grossReturnPct: -100,
      netReturnPct: -100 - this.costs.deterministicCostPct,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
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

module.exports = { HolderGrowthShadowSuite, STATUS, shadowPrice };
