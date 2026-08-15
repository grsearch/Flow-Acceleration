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

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
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
    horizonMs: value('horizon_ms', 'horizonMs'),
    buyers: value('buyers', 'buyers'),
    newBuyers: value('new_buyers', 'newBuyers'),
    netFlowSol: value('net_flow_sol', 'netFlowSol'),
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
    exitMode: value('exit_mode', 'exitMode') || 'TRAILING',
    fixedHoldMs: value('fixed_hold_ms', 'fixedHoldMs'),
    hardStopPct: value('hard_stop_pct', 'hardStopPct'),
    trailingActivationPct: value('trailing_activation_pct', 'trailingActivationPct'),
    trailingStopPct: value('trailing_stop_pct', 'trailingStopPct'),
    trailingTiers: jsonArray(value('trailing_tiers_json', 'trailingTiersJson')),
    trailingTierIndex: finite(value('trailing_tier_index', 'trailingTierIndex'), -1),
    stopPrice: finite(value('stop_price', 'stopPrice')),
    scaleOutTriggerPct: value('scale_out_trigger_pct', 'scaleOutTriggerPct'),
    scaleOutFractionPct: value('scale_out_fraction_pct', 'scaleOutFractionPct'),
    partialExitTargetAt: value('partial_exit_target_at', 'partialExitTargetAt'),
    partialExitDeadlineAt: value('partial_exit_deadline_at', 'partialExitDeadlineAt'),
    scaleOutAt: value('scale_out_at', 'scaleOutAt'),
    scaleOutPrice: value('scale_out_price', 'scaleOutPrice'),
    flowCheckHorizonMs: value('flow_check_horizon_ms', 'flowCheckHorizonMs'),
    minBuyerVelocityRatio: value('min_buyer_velocity_ratio', 'minBuyerVelocityRatio'),
    minNetFlowDeltaSol: value('min_net_flow_delta_sol', 'minNetFlowDeltaSol'),
    flowCheckAt: value('flow_check_at', 'flowCheckAt'),
    flowCheckStatus: value('flow_check_status', 'flowCheckStatus'),
    flowBuyerVelocityRatio: value('flow_buyer_velocity_ratio', 'flowBuyerVelocityRatio'),
    flowNetFlowDeltaSol: value('flow_net_flow_delta_sol', 'flowNetFlowDeltaSol'),
    configuredCostPct: finite(value('configured_cost_pct', 'configuredCostPct'), 0),
    maxHoldMs: value('max_hold_ms', 'maxHoldMs'),
    exitTriggerAt: value('exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: value('exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: value('exit_deadline_at', 'exitDeadlineAt'),
    exitReason: value('exit_reason', 'exitReason'),
    exitTargetMarket: value('exit_target_market', 'exitTargetMarket'),
    graduatedAt: value('graduated_at', 'graduatedAt'),
  };
}

class HolderGrowthShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    const exitProfiles = config.exitProfiles || (config.exitProfile ? [config.exitProfile] : []);
    this.exitProfiles = new Map(exitProfiles.map((row) => [row.id, row]));
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
      position.graduatedAt = finite(
        position.graduatedAt ?? this.store.getToken(position.mint)?.graduated_at,
      );
      if (position.graduatedAt && position.status === STATUS.EXIT_PENDING) {
        position.exitTargetMarket = 'PUMP_AMM';
      }
      if (position.status === STATUS.EXIT_PENDING && position.exitTargetAt) {
        const extendedDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
        if (!position.exitDeadlineAt || position.exitDeadlineAt < extendedDeadlineAt) {
          position.exitDeadlineAt = extendedDeadlineAt;
          this.store.updateHolderGrowthShadowPosition(position.id, {
            exitDeadlineAt: extendedDeadlineAt,
          });
        }
      }
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const now = this.now();
    const maxHoldMs = Math.max(0, ...[...this.exitProfiles.values()]
      .map((profile) => finite(profile.maxHoldMs, 0)));
    const lookbackMs = maxHoldMs + this.config.exitTimeoutMs + 5_000;
    const replayTrades = [
      ...this.store.recentCurveTrades(now - lookbackMs),
      ...this.store.recentAmmTrades(now - lookbackMs),
    ].sort((left, right) => left.timestampMs - right.timestampMs);
    for (const trade of replayTrades) {
      this.observeTrade(trade, { replay: true });
    }
    this.advanceTime(now);
  }

  stop() {}

  health() {
    const entryProfiles = [...this.entryProfiles.values()];
    const cohortCount = entryProfiles.reduce((total, profile) => (
      total + this._exitProfilesFor(profile).length
    ), 0);
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_N',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles,
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        scope: 'PRE_MIGRATION_OBSERVED_HOLDER_GROWTH',
        snapshotHorizonsMs: [...new Set([...this.entryProfiles.values()]
          .map((profile) => profile.horizonMs || this.config.snapshotHorizonMs))]
          .sort((left, right) => left - right),
        entryDelayMs: this.config.entryDelayMs,
        entryTimeoutMs: this.config.entryTimeoutMs,
        maxSnapshotLagMs: this.config.maxSnapshotLagMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        cohortCount,
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

  trackedMints() {
    return [...new Set([...this.positions.values()]
      .filter((position) => position.graduatedAt)
      .map((position) => position.mint))];
  }

  onGraduated(tokenOrEvent) {
    const mint = tokenOrEvent?.mint;
    if (!this.config.enabled || !mint) return;
    const graduatedAt = finite(
      tokenOrEvent.graduated_at
      ?? tokenOrEvent.graduatedAt
      ?? tokenOrEvent.migrated_at
      ?? tokenOrEvent.completedAt
      ?? tokenOrEvent.migratedAt
      ?? tokenOrEvent.timestampMs,
      this.now(),
    );
    for (const id of [...(this.rowsByMint.get(mint) || [])]) {
      const position = this.positions.get(id);
      if (!position) continue;
      position.graduatedAt = graduatedAt;
      if (position.status === STATUS.EXIT_PENDING) {
        position.exitReason = `${position.exitReason || 'EXIT'}_MIGRATION_REROUTE`;
        position.exitTriggerAt = graduatedAt;
        position.exitTargetAt = graduatedAt + this.config.exitDelayMs;
        position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
        position.exitTargetMarket = 'PUMP_AMM';
        this.store.updateHolderGrowthShadowPosition(position.id, {
          exitReason: position.exitReason,
          exitTriggerAt: position.exitTriggerAt,
          exitTargetAt: position.exitTargetAt,
          exitDeadlineAt: position.exitDeadlineAt,
        });
      }
    }
  }

  onSnapshot(snapshot, { replay = false } = {}) {
    if (!this.config.enabled || !snapshot?.mint || !(snapshot.price > 0)
      || snapshot.observationLagMs > this.config.maxSnapshotLagMs) return;
    const entryProfiles = [...this.entryProfiles.values()].filter((profile) => (
      snapshot.horizonMs === (profile.horizonMs || this.config.snapshotHorizonMs)
    ));
    if (!entryProfiles.length) {
      this._observeFlowCheckpoint(snapshot, { replay });
      return;
    }
    this.metrics.evaluated += 1;
    for (const profile of entryProfiles) {
      if (!this._matches(profile, snapshot)) continue;
      this.metrics.matched += 1;
      if (replay) {
        this.metrics.replayMatchesSuppressed += 1;
        continue;
      }
      this._createPendingRows(profile, snapshot);
    }
  }

  observeTrade(trade) {
    const timestampMs = finite(trade?.timestampMs);
    const price = shadowPrice(trade);
    if (!this.config.enabled || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade?.market)
      || !trade?.mint || !(timestampMs > 0) || !(price > 0)) return;
    this.advanceTime(timestampMs);
    const ids = [...(this.rowsByMint.get(trade.mint) || [])];
    for (const id of ids) {
      const pending = this.pendingEntries.get(id);
      if (pending) {
        if (trade.market !== 'PUMP_BONDING_CURVE'
          || timestampMs < pending.entryTargetAt || timestampMs > pending.entryDeadlineAt) continue;
        this._open(pending, trade, price);
        continue;
      }
      const position = this.positions.get(id);
      if (!position || !this._eligibleObservedTrade(position, trade, price)) continue;
      if (position.status === STATUS.EXIT_PENDING) {
        if ((!position.exitTargetMarket || trade.market === position.exitTargetMarket)
          && timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
          this._close(position, trade, price);
        }
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      if (position.partialExitTargetAt && !position.scaleOutAt) {
        if (timestampMs >= position.partialExitTargetAt
          && timestampMs <= position.partialExitDeadlineAt) {
          this._fillScaleOut(position, trade, price);
        } else if (timestampMs > position.partialExitDeadlineAt) {
          position.partialExitTargetAt = null;
          position.partialExitDeadlineAt = null;
          this.store.updateHolderGrowthShadowPosition(position.id, {
            clearPartialExitPending: true,
          });
        }
      }
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
        const reason = position.exitMode === 'FIXED_HOLD' ? 'FIXED_HOLD' : 'MAX_HOLD';
        this._requestExit(position, position.entryAt + position.maxHoldMs, reason);
      }
    }
  }

  _matches(profile, snapshot) {
    return snapshot.buyers >= profile.minBuyers
      && snapshot.newBuyers >= profile.minNewBuyers
      && (profile.minRecentBuyers == null
        || finite(snapshot.recentBuyers, -1) >= profile.minRecentBuyers)
      && finite(snapshot.retentionPct, -1) >= profile.minRetentionPct
      && snapshot.netFlowSol >= profile.minNetFlowSol
      && finite(snapshot.top3SharePct, 101) <= profile.maxTop3SharePct;
  }

  _createPendingRows(profile, snapshot) {
    for (const exitProfile of this._exitProfilesFor(profile)) {
      this._createPending(profile, exitProfile, snapshot);
    }
  }

  _exitProfilesFor(profile) {
    const allowed = Array.isArray(profile?.exitProfileIds) && profile.exitProfileIds.length
      ? new Set(profile.exitProfileIds)
      : null;
    return [...this.exitProfiles.values()].filter((exitProfile) => (
      !allowed || allowed.has(exitProfile.id)
    ));
  }

  _createPending(profile, exitProfile, snapshot) {
    const cohortId = `${profile.id}:${exitProfile.id}`;
    const token = this.store.getToken(snapshot.mint) || {};
    const row = this.store.createHolderGrowthShadowPosition({
      cohortId,
      entryProfileId: profile.id,
      exitProfileId: exitProfile.id,
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
      exitMode: exitProfile.exitMode || 'TRAILING',
      fixedHoldMs: exitProfile.fixedHoldMs,
      hardStopPct: exitProfile.hardStopPct,
      trailingActivationPct: exitProfile.trailingActivationPct,
      trailingStopPct: exitProfile.trailingStopPct,
      trailingTiers: exitProfile.trailingTiers,
      scaleOutTriggerPct: exitProfile.scaleOutTriggerPct,
      scaleOutFractionPct: exitProfile.scaleOutFractionPct,
      flowCheckHorizonMs: exitProfile.flowCheckHorizonMs,
      minBuyerVelocityRatio: exitProfile.minBuyerVelocityRatio,
      minNetFlowDeltaSol: exitProfile.minNetFlowDeltaSol,
      maxHoldMs: exitProfile.maxHoldMs,
    });
    if (!row?.inserted) return;
    const position = positionFromRow(row);
    this.pendingEntries.set(position.id, position);
    this._index(position);
    this.metrics.lastActionAt = this.now();
  }

  _open(position, trade, price) {
    const jumpPct = ((price / position.signalPrice) - 1) * 100;
    const entryProfile = this.entryProfiles.get(position.entryProfileId) || {};
    const minJumpPct = finite(entryProfile.minEntryJumpPct, -this.config.maxEntryPriceDropPct);
    const maxJumpPct = finite(entryProfile.maxEntryJumpPct, this.config.maxEntryPriceJumpPct);
    if (jumpPct > maxJumpPct || jumpPct < minJumpPct) {
      this.store.updateHolderGrowthShadowPosition(position.id, {
        status: STATUS.PRICE_JUMP,
        rejectionReason: `ENTRY_PRICE_OUTSIDE_${minJumpPct.toFixed(2)}_${maxJumpPct.toFixed(2)}_${jumpPct.toFixed(2)}PCT`,
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
    if (grossReturnPct <= -position.hardStopPct) {
      this._requestExit(position, trade.timestampMs, 'HARD_STOP');
      return;
    }

    if (position.exitMode === 'FIXED_HOLD') {
      if (trade.timestampMs - position.entryAt >= position.fixedHoldMs) {
        this._requestExit(position, position.entryAt + position.fixedHoldMs, 'FIXED_HOLD');
      }
      return;
    }

    if (position.exitMode === 'FIXED_SCALE_RUNNER' && !position.scaleOutAt) {
      if (position.partialExitTargetAt) return;
      if (trade.timestampMs - position.entryAt < position.fixedHoldMs) return;
      if (grossReturnPct < position.scaleOutTriggerPct) {
        this._requestExit(position, position.entryAt + position.fixedHoldMs, 'FIXED_HOLD_WEAK');
        return;
      }
      position.partialExitTargetAt = trade.timestampMs + this.config.exitDelayMs;
      position.partialExitDeadlineAt = position.partialExitTargetAt + this.config.exitTimeoutMs;
      this.store.updateHolderGrowthShadowPosition(position.id, {
        partialExitTargetAt: position.partialExitTargetAt,
        partialExitDeadlineAt: position.partialExitDeadlineAt,
      });
      return;
    }

    if (position.exitMode === 'ADAPTIVE_TRAILING') {
      this._observeAdaptiveTrailing(position, trade.timestampMs, price);
      return;
    }

    if (['SCALE_RUNNER', 'SCALE_ADAPTIVE'].includes(position.exitMode)
      && !position.scaleOutAt && !position.partialExitTargetAt
      && grossReturnPct >= position.scaleOutTriggerPct) {
      position.partialExitTargetAt = trade.timestampMs + this.config.exitDelayMs;
      position.partialExitDeadlineAt = position.partialExitTargetAt + this.config.exitTimeoutMs;
      this.store.updateHolderGrowthShadowPosition(position.id, {
        partialExitTargetAt: position.partialExitTargetAt,
        partialExitDeadlineAt: position.partialExitDeadlineAt,
      });
    }

    if (position.exitMode === 'SCALE_ADAPTIVE') {
      this._observeAdaptiveTrailing(position, trade.timestampMs, price);
      return;
    }

    if (!position.trailingActivatedAt
      && grossReturnPct >= position.trailingActivationPct) {
      position.trailingActivatedAt = trade.timestampMs;
      position.stopPrice = position.highestPrice * (1 - position.trailingStopPct / 100);
      this.store.updateHolderGrowthShadowPosition(position.id, {
        trailingActivatedAt: trade.timestampMs,
        stopPrice: position.stopPrice,
      });
    } else if (position.trailingActivatedAt) {
      position.stopPrice = Math.max(
        position.stopPrice || 0,
        position.highestPrice * (1 - position.trailingStopPct / 100),
      );
      this.store.updateHolderGrowthShadowPosition(position.id, {
        stopPrice: position.stopPrice,
      });
    }
    if (position.trailingActivatedAt && price <= position.stopPrice) {
      this._requestExit(position, trade.timestampMs, `TRAILING_${position.trailingStopPct}PCT`);
    }
  }

  _observeAdaptiveTrailing(position, timestampMs, price) {
    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    const tiers = [...(position.trailingTiers || [])]
      .sort((left, right) => left.activationPct - right.activationPct);
    let reachedIndex = -1;
    for (let index = 0; index < tiers.length; index += 1) {
      if (peakReturnPct >= tiers[index].activationPct) reachedIndex = index;
    }
    if (reachedIndex > position.trailingTierIndex) {
      position.trailingTierIndex = reachedIndex;
      position.trailingActivatedAt ??= timestampMs;
    }
    if (position.trailingTierIndex >= 0) {
      const tier = tiers[position.trailingTierIndex];
      const candidateStop = position.highestPrice * (1 - tier.drawdownPct / 100);
      // A wider high-profit tier may never loosen an already-earned stop.
      position.stopPrice = Math.max(position.stopPrice || 0, candidateStop);
      this.store.updateHolderGrowthShadowPosition(position.id, {
        trailingActivatedAt: position.trailingActivatedAt,
        trailingTierIndex: position.trailingTierIndex,
        stopPrice: position.stopPrice,
      });
      if (price <= position.stopPrice) {
        this._requestExit(
          position,
          timestampMs,
          `STAIR_T${position.trailingTierIndex + 1}_${tier.drawdownPct}PCT`,
        );
      }
    }
  }

  _fillScaleOut(position, trade, price) {
    position.scaleOutAt = trade.timestampMs;
    position.scaleOutPrice = price;
    position.partialExitTargetAt = null;
    position.partialExitDeadlineAt = null;
    this.store.updateHolderGrowthShadowPosition(position.id, {
      scaleOutAt: position.scaleOutAt,
      scaleOutPrice: price,
      clearPartialExitPending: true,
    });
  }

  _observeFlowCheckpoint(snapshot, { replay = false } = {}) {
    if (replay) return;
    const ids = [...(this.rowsByMint.get(snapshot.mint) || [])];
    for (const id of ids) {
      const position = this.positions.get(id);
      if (!position || position.status !== STATUS.OPEN
        || position.exitMode !== 'FLOW_CHECK'
        || position.flowCheckAt
        || snapshot.horizonMs !== position.flowCheckHorizonMs) continue;
      const entryWindowMs = position.horizonMs <= 10_000 ? 5_000 : 10_000;
      const checkWindowMs = Math.max(1, snapshot.horizonMs - position.horizonMs);
      const baselineVelocity = finite(position.newBuyers, 0) / entryWindowMs;
      const currentVelocity = finite(snapshot.newBuyers, 0) / checkWindowMs;
      const velocityRatio = baselineVelocity > 0 ? currentVelocity / baselineVelocity : 0;
      const netFlowDeltaSol = finite(snapshot.netFlowSol, 0) - finite(position.netFlowSol, 0);
      const passed = velocityRatio >= position.minBuyerVelocityRatio
        && netFlowDeltaSol > position.minNetFlowDeltaSol;
      Object.assign(position, {
        flowCheckAt: snapshot.observedAt,
        flowCheckStatus: passed ? 'PASS' : 'FAIL',
        flowBuyerVelocityRatio: velocityRatio,
        flowNetFlowDeltaSol: netFlowDeltaSol,
      });
      this.store.updateHolderGrowthShadowPosition(position.id, {
        flowCheckAt: position.flowCheckAt,
        flowCheckStatus: position.flowCheckStatus,
        flowBuyerVelocityRatio: velocityRatio,
        flowNetFlowDeltaSol: netFlowDeltaSol,
      });
      if (!passed) this._requestExit(position, snapshot.observedAt, 'FLOW_DECAY_60S');
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

  _requestExit(position, triggerAt, reason, targetMarket = null) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    position.exitTargetMarket = targetMarket
      || (position.graduatedAt ? 'PUMP_AMM' : position.entryMarket);
    this.store.updateHolderGrowthShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _close(position, trade, price) {
    const runnerGrossReturnPct = ((price / position.entryPrice) - 1) * 100;
    let grossReturnPct = runnerGrossReturnPct;
    let effectiveExitPrice = price;
    if (['SCALE_RUNNER', 'SCALE_ADAPTIVE', 'FIXED_SCALE_RUNNER'].includes(position.exitMode)
      && position.scaleOutAt) {
      const fraction = Math.min(1, Math.max(0, finite(position.scaleOutFractionPct, 50) / 100));
      const scaleGrossReturnPct = ((position.scaleOutPrice / position.entryPrice) - 1) * 100;
      grossReturnPct = scaleGrossReturnPct * fraction + runnerGrossReturnPct * (1 - fraction);
      effectiveExitPrice = position.entryPrice * (1 + grossReturnPct / 100);
    }
    if (grossReturnPct > this.config.maxPlausibleReturnPct || grossReturnPct < -100) return;
    this._updateExtrema(position, trade.timestampMs, price);
    const realizedCostPct = finite(
      position.configuredCostPct,
      this.costs.deterministicCostPct,
    ) + (position.scaleOutAt ? this.costs.fixedCostPct : 0);
    this.store.updateHolderGrowthShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: effectiveExitPrice,
      grossReturnPct,
      netReturnPct: grossReturnPct - realizedCostPct,
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
      rejectionReason: position.graduatedAt
        ? 'NO_EXIT_AFTER_MIGRATION_AMM_TIMEOUT'
        : 'NO_EXIT_BONDING_CURVE_TIMEOUT',
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.noExit += 1;
  }

  _eligibleObservedTrade(position, trade, price) {
    if (trade.market === 'PUMP_BONDING_CURVE') {
      return !position.graduatedAt || trade.timestampMs < position.graduatedAt;
    }
    if (trade.market !== 'PUMP_AMM' || !position.graduatedAt
      || trade.timestampMs < position.graduatedAt) return false;
    const ratio = price / position.entryPrice;
    return ratio >= 0.05 && ratio <= 20;
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
