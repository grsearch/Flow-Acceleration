'use strict';

const { costBreakdown } = require('./CostModel');
const { executableSell } = require('./ShadowExecutionModel');
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

function valueOf(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function shadowPrice(trade) {
  const reserve = finite(trade?.reservePrice);
  return reserve > 0 ? reserve : finite(trade?.price);
}

function beijingHourAllowed(timestampMs, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return true;
  const timestamp = Number(timestampMs);
  if (!Number.isFinite(timestamp)) return false;
  const hour = new Date(timestamp + 8 * 60 * 60_000).getUTCHours();
  return ranges.some(([start, end]) => hour >= Number(start) && hour < Number(end));
}

function curveBuyAveragePrice(trade, positionSol, fallbackPrice) {
  try {
    const x = BigInt(trade.virtualSolReservesRaw || 0);
    const y = BigInt(trade.virtualTokenReservesRaw || 0);
    const input = BigInt(Math.max(1, Math.round(positionSol * 1e9)));
    if (x <= 0n || y <= 0n) return fallbackPrice;
    const tokensOutRaw = y - ((x * y) / (x + input));
    const tokenUnits = Number(tokensOutRaw) / 1e6;
    return tokenUnits > 0 ? positionSol / tokenUnits : fallbackPrice;
  } catch (_) {
    return fallbackPrice;
  }
}

function rowPosition(row) {
  return {
    id: row.id,
    cohortId: valueOf(row, 'cohort_id', 'cohortId'),
    entryProfileId: valueOf(row, 'entry_profile_id', 'entryProfileId'),
    exitProfileId: valueOf(row, 'exit_profile_id', 'exitProfileId'),
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    positionSol: finite(valueOf(row, 'position_sol', 'positionSol'), 1),
    configuredCostPct: finite(valueOf(row, 'configured_cost_pct', 'configuredCostPct'), 0),
    signalAt: valueOf(row, 'signal_at', 'signalAt'),
    signalPrice: finite(valueOf(row, 'signal_price', 'signalPrice')),
    entryTargetAt: valueOf(row, 'entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: valueOf(row, 'entry_deadline_at', 'entryDeadlineAt'),
    entryAt: valueOf(row, 'entry_at', 'entryAt'),
    entryPrice: finite(valueOf(row, 'entry_price', 'entryPrice')),
    highestPrice: finite(valueOf(row, 'highest_price', 'highestPrice')),
    lowestPrice: finite(valueOf(row, 'lowest_price', 'lowestPrice')),
    maxFavorableReturnPct: finite(valueOf(row, 'max_favorable_return_pct', 'maxFavorableReturnPct'), 0),
    maxAdverseReturnPct: finite(valueOf(row, 'max_adverse_return_pct', 'maxAdverseReturnPct'), 0),
    partialStage: finite(valueOf(row, 'partial_stage', 'partialStage'), 0),
    pendingPartialStage: finite(valueOf(row, 'pending_partial_stage', 'pendingPartialStage'), 0),
    partialExitTargetAt: valueOf(row, 'partial_exit_target_at', 'partialExitTargetAt'),
    partialExitDeadlineAt: valueOf(row, 'partial_exit_deadline_at', 'partialExitDeadlineAt'),
    scale1At: valueOf(row, 'scale1_at', 'scale1At'),
    scale1Price: finite(valueOf(row, 'scale1_price', 'scale1Price')),
    scale2At: valueOf(row, 'scale2_at', 'scale2At'),
    scale2Price: finite(valueOf(row, 'scale2_price', 'scale2Price')),
    graduatedAt: valueOf(row, 'graduated_at', 'graduatedAt'),
    lastCurvePrice: finite(valueOf(row, 'last_curve_price', 'lastCurvePrice')),
    ammPriceScale: finite(valueOf(row, 'amm_price_scale', 'ammPriceScale')),
    exitTargetMarket: valueOf(row, 'exit_target_market', 'exitTargetMarket'),
    exitTriggerAt: valueOf(row, 'exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: valueOf(row, 'exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: valueOf(row, 'exit_deadline_at', 'exitDeadlineAt'),
    exitReason: valueOf(row, 'exit_reason', 'exitReason'),
  };
}

class QualityLeaderShadowSuite {
  constructor({ config, store, now = () => Date.now(), onLiveSignal = null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.onLiveSignal = typeof onLiveSignal === 'function' ? onLiveSignal : null;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.snapshots = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      evaluated: 0, matched: 0, replayMatchesSuppressed: 0,
      priceJump: 0, noEntry: 0, opened: 0, partialExits: 0,
      graduated: 0, closed: 0, noExit: 0, lastActionAt: null, lastError: null,
      liveSignalsEmitted: 0, replayLiveSignalsSuppressed: 0,
    };
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.store.activeQualityLeaderShadowPositions()) {
      const position = rowPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const now = this.now();
    const since = now - this.config.maxHoldMs - this.config.exitTimeoutMs - 5_000;
    const trades = [
      ...this.store.recentCurveTrades(since),
      ...this.store.recentAmmTrades(since),
    ].sort((a, b) => a.timestampMs - b.timestampMs);
    for (const trade of trades) this.observeTrade(trade, { replay: true });
    this.advanceTime(now);
  }

  stop() {}

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_QL',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        scope: 'PRE_MIGRATION_QUALITY_LEADER_10S_20S',
        entryDelayMs: this.config.entryDelayMs,
        entryTimeoutMs: this.config.entryTimeoutMs,
        maxHoldMs: this.config.maxHoldMs,
        cohortCount: [...this.entryProfiles.values()].reduce(
          (sum, profile) => sum + (profile.exitProfileIds || []).length, 0,
        ),
        research: {
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          isolatedTable: 'quality_leader_shadow_positions',
          normalizedAcrossMigration: true,
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

  onSnapshot(snapshot, { replay = false } = {}) {
    if (!this.config.enabled || !snapshot?.mint || !(snapshot.price > 0)
      || snapshot.observationLagMs > this.config.maxSnapshotLagMs
      || ![this.config.snapshot10Ms, this.config.snapshot20Ms].includes(snapshot.horizonMs)) return;
    const state = this.snapshots.get(snapshot.mint) || {};
    if (snapshot.horizonMs === this.config.snapshot10Ms) state.s10 = snapshot;
    if (snapshot.horizonMs === this.config.snapshot20Ms) state.s20 = snapshot;
    this.snapshots.set(snapshot.mint, state);
    if (snapshot.horizonMs !== this.config.snapshot20Ms || !state.s10) return;
    this.metrics.evaluated += 1;
    for (const profile of this.entryProfiles.values()) {
      if (!this._matches(profile, state.s10, state.s20)) continue;
      this.metrics.matched += 1;
      if (replay) {
        this.metrics.replayMatchesSuppressed += 1;
        continue;
      }
      for (const exitProfileId of profile.exitProfileIds || []) {
        const exitProfile = this.exitProfiles.get(exitProfileId);
        if (exitProfile) this._createPending(profile, exitProfile, state.s10, state.s20);
      }
    }
  }

  onGraduated(tokenOrEvent) {
    const mint = tokenOrEvent?.mint;
    if (!this.config.enabled || !mint) return;
    const graduatedAt = finite(
      tokenOrEvent.graduated_at ?? tokenOrEvent.graduatedAt
      ?? tokenOrEvent.migrated_at ?? tokenOrEvent.migratedAt
      ?? tokenOrEvent.completedAt ?? tokenOrEvent.timestampMs,
      this.now(),
    );
    for (const id of [...(this.rowsByMint.get(mint) || [])]) {
      const position = this.positions.get(id);
      if (!position) continue;
      position.graduatedAt = graduatedAt;
      position.ammPriceScale = null;
      if (position.status === STATUS.EXIT_PENDING) {
        position.exitTargetMarket = 'PUMP_AMM';
        position.exitTargetAt = graduatedAt + this.config.exitDelayMs;
        position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
      }
      this.store.updateQualityLeaderShadowPosition(id, {
        graduatedAt,
        exitTargetMarket: position.status === STATUS.EXIT_PENDING ? 'PUMP_AMM' : null,
        exitTargetAt: position.status === STATUS.EXIT_PENDING ? position.exitTargetAt : null,
        exitDeadlineAt: position.status === STATUS.EXIT_PENDING ? position.exitDeadlineAt : null,
      });
    }
    this.metrics.graduated += 1;
  }

  observeTrade(trade, { replay = false } = {}) {
    const timestampMs = finite(trade?.timestampMs);
    const rawPrice = shadowPrice(trade);
    if (!this.config.enabled || !trade?.mint || !(timestampMs > 0) || !(rawPrice > 0)
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade.market)) return;
    this.advanceTime(timestampMs);
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const pending = this.pendingEntries.get(id);
      if (pending) {
        if (trade.market === 'PUMP_BONDING_CURVE'
          && timestampMs >= pending.entryTargetAt && timestampMs <= pending.entryDeadlineAt) {
          this._open(pending, trade, rawPrice, { replay });
        }
        continue;
      }
      const position = this.positions.get(id);
      if (!position) continue;
      const price = this._normalizedPrice(position, trade, rawPrice);
      if (!(price > 0)) continue;
      if (trade.market === 'PUMP_BONDING_CURVE') {
        position.lastCurvePrice = price;
        this.store.updateQualityLeaderShadowPosition(id, { lastCurvePrice: price });
      }
      if (position.graduatedAt && trade.market !== 'PUMP_AMM') continue;
      if (!position.graduatedAt && trade.market !== 'PUMP_BONDING_CURVE') continue;
      if (position.status === STATUS.EXIT_PENDING) {
        if (trade.market === position.exitTargetMarket
          && timestampMs >= position.exitTargetAt && timestampMs <= position.exitDeadlineAt) {
          this._close(position, trade, price);
        }
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      if (position.partialExitTargetAt) {
        if (timestampMs >= position.partialExitTargetAt
          && timestampMs <= position.partialExitDeadlineAt) this._fillPartial(position, trade, price);
        else if (timestampMs > position.partialExitDeadlineAt) {
          position.partialExitTargetAt = null;
          position.partialExitDeadlineAt = null;
          this.store.updateQualityLeaderShadowPosition(id, { clearPartialExitPending: true });
        }
      }
      this._observeOpen(position, trade, price);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateQualityLeaderShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'NO_CURVE_TRADE_IN_ENTRY_WINDOW',
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        this._markNoExit(position, 'NO_EXECUTABLE_EXIT_TRADE');
      } else if (position.status === STATUS.OPEN) {
        if (now >= position.entryAt + this.config.noStrengthMs
          && position.maxFavorableReturnPct < this.config.strengthActivationPct) {
          this._requestExit(position, position.entryAt + this.config.noStrengthMs, 'NO_STRENGTH_30S');
        } else if (now >= position.entryAt + this.config.maxHoldMs) {
          this._requestExit(position, position.entryAt + this.config.maxHoldMs, 'MAX_HOLD_5M');
        }
      }
    }
  }

  _matches(profile, s10, s20) {
    const buyerDelta = finite(s20.buyers, 0) - finite(s10.buyers, 0);
    const netFlowDelta = finite(s20.netFlowSol, 0) - finite(s10.netFlowSol, 0);
    const sellBuyRatio = finite(s20.buyTx, 0) > 0
      ? finite(s20.sellTx, 0) / finite(s20.buyTx, 0) : Infinity;
    const rugRiskPass = !profile.requireHealthyRugRisk
      || (s20.rugRisk?.sampleReady && !s20.rugRisk.flagged);
    return finite(s10.priceReturnPct, -Infinity) >= profile.minReturn10Pct
      && finite(s20.drawdownPct, Infinity) <= profile.maxDrawdown20Pct
      && buyerDelta >= profile.minBuyerDelta
      && netFlowDelta >= profile.minNetFlowDeltaSol
      && finite(s20.retentionPct, -1) >= profile.minRetentionPct
      && finite(s20.creatorSharePct, 101) <= profile.maxCreatorSharePct
      && finite(s20.curvePct, -1) >= profile.minCurvePct
      && finite(s20.curvePct, 101) <= profile.maxCurvePct
      && sellBuyRatio <= profile.maxSellBuyRatio
      && finite(s20.virtualSolReserves, -1) >= profile.minVirtualSolReserves
      && rugRiskPass
      && beijingHourAllowed(s20.observedAt, profile.beijingHourRanges);
  }

  _createPending(profile, exitProfile, s10, s20) {
    const cohortId = `${profile.id}:${exitProfile.id}`;
    const token = this.store.getToken(s20.mint) || {};
    const buyerDelta = finite(s20.buyers, 0) - finite(s10.buyers, 0);
    const netFlowDeltaSol = finite(s20.netFlowSol, 0) - finite(s10.netFlowSol, 0);
    const sellBuyRatio = finite(s20.buyTx, 0) > 0
      ? finite(s20.sellTx, 0) / finite(s20.buyTx, 0) : null;
    const saved = this.store.createQualityLeaderShadowPosition({
      cohortId,
      entryProfileId: profile.id,
      exitProfileId: exitProfile.id,
      mint: s20.mint,
      symbol: token.symbol || null,
      status: STATUS.PENDING_ENTRY,
      positionSol: this.config.positionSizeSol,
      configuredCostPct: this.costs.deterministicCostPct,
      signalAt: s20.observedAt,
      signalPrice: s20.price,
      return10Pct: s10.priceReturnPct,
      drawdown20Pct: s20.drawdownPct,
      buyers10: s10.buyers,
      buyers20: s20.buyers,
      buyerDelta,
      netFlow10Sol: s10.netFlowSol,
      netFlow20Sol: s20.netFlowSol,
      netFlowDeltaSol,
      retention20Pct: s20.retentionPct,
      creatorShare20Pct: s20.creatorSharePct,
      curve20Pct: s20.curvePct,
      sellBuyRatio20: sellBuyRatio,
      virtualSol20: s20.virtualSolReserves,
      features: { s10, s20 },
      entryTargetAt: s20.observedAt + this.config.entryDelayMs,
      entryDeadlineAt: s20.observedAt + this.config.entryDelayMs + this.config.entryTimeoutMs,
    });
    if (!saved?.inserted) return;
    const position = rowPosition(saved);
    position.liveFeatures = {
      entryProfileId: profile.id,
      exitProfileId: exitProfile.id,
      return10Pct: s10.priceReturnPct,
      drawdown20Pct: s20.drawdownPct,
      buyers10: s10.buyers,
      buyers20: s20.buyers,
      buyerDelta,
      netFlow10Sol: s10.netFlowSol,
      netFlow20Sol: s20.netFlowSol,
      netFlowDeltaSol,
      retention20Pct: s20.retentionPct,
      creatorShare20Pct: s20.creatorSharePct,
      curve20Pct: s20.curvePct,
      sellBuyRatio20: sellBuyRatio,
      virtualSol20: s20.virtualSolReserves,
    };
    this.pendingEntries.set(position.id, position);
    this._index(position);
    this.metrics.lastActionAt = this.now();
  }

  _open(position, trade, marketPrice, { replay = false } = {}) {
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: `QUALITY_LEADER:${position.cohortId}`,
      mint: position.mint,
      timestampMs: trade.timestampMs,
      market: trade.market,
    });
    if (rugGuard.blocked) {
      this.store.updateQualityLeaderShadowPosition(position.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'PRE_ENTRY_RUG_RISK',
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      return;
    }
    const entryPrice = curveBuyAveragePrice(trade, position.positionSol, marketPrice);
    const jumpPct = ((entryPrice / position.signalPrice) - 1) * 100;
    const impactPct = ((entryPrice / marketPrice) - 1) * 100;
    if (jumpPct > this.config.maxEntryPriceJumpPct
      || jumpPct < -this.config.maxEntryPriceDropPct) {
      this.store.updateQualityLeaderShadowPosition(position.id, {
        status: STATUS.PRICE_JUMP,
        rejectionReason: `ENTRY_PRICE_MOVE_${jumpPct.toFixed(2)}PCT`,
        entryJumpPct: jumpPct,
        entryImpactPct: impactPct,
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
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      maxFavorableReturnPct: ((marketPrice / entryPrice) - 1) * 100,
      maxAdverseReturnPct: Math.min(0, ((marketPrice / entryPrice) - 1) * 100),
      lastCurvePrice: marketPrice,
    });
    this.store.updateQualityLeaderShadowPosition(position.id, {
      status: STATUS.OPEN,
      entryAt: position.entryAt,
      entryMarket: trade.market,
      entryPrice,
      entryJumpPct: jumpPct,
      entryImpactPct: impactPct,
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
      lastObservedAt: trade.timestampMs,
      lastPrice: marketPrice,
      lastCurvePrice: marketPrice,
    });
    this.pendingEntries.delete(position.id);
    this.positions.set(position.id, position);
    this.metrics.opened += 1;
    this._emitLiveSignal(position, trade, marketPrice, jumpPct, impactPct, replay);
  }

  _emitLiveSignal(position, trade, marketPrice, jumpPct, impactPct, replay) {
    const profile = this.entryProfiles.get(position.entryProfileId);
    if (!this.onLiveSignal || !profile?.liveStrategyId
      || position.exitProfileId !== 'QL_PROTECTED') return;
    if (replay) {
      this.metrics.replayLiveSignalsSuppressed += 1;
      return;
    }
    try {
      this.onLiveSignal({
        strategyId: profile.liveStrategyId,
        episodeId: `${position.mint}:${position.entryProfileId}:${position.exitProfileId}:${position.signalAt}`,
        mint: position.mint,
        symbol: position.symbol || trade.symbol || null,
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
          ...(position.liveFeatures || {}),
          shadowEntryJumpPct: jumpPct,
          shadowEntryImpactPct: impactPct,
          shadowEntryPrice: position.entryPrice,
          shadowCohortId: position.cohortId,
        },
      });
      this.metrics.liveSignalsEmitted += 1;
    } catch (error) {
      this.metrics.lastError = String(error?.message || error).slice(0, 1_000);
    }
  }

  _normalizedPrice(position, trade, rawPrice) {
    if (trade.market !== 'PUMP_AMM') return rawPrice;
    if (!position.ammPriceScale) {
      const anchor = position.lastCurvePrice || position.entryPrice;
      position.ammPriceScale = anchor > 0 ? anchor / rawPrice : 1;
      this.store.updateQualityLeaderShadowPosition(position.id, {
        ammPriceScale: position.ammPriceScale,
      });
    }
    return rawPrice * position.ammPriceScale;
  }

  _observeOpen(position, trade, price) {
    position.highestPrice = Math.max(position.highestPrice || position.entryPrice, price);
    position.lowestPrice = Math.min(position.lowestPrice || position.entryPrice, price);
    const gross = ((price / position.entryPrice) - 1) * 100;
    position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct || 0,
      ((position.highestPrice / position.entryPrice) - 1) * 100);
    position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct || 0,
      ((position.lowestPrice / position.entryPrice) - 1) * 100);
    this.store.updateQualityLeaderShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: trade.timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    if (gross <= -this.config.hardStopPct) {
      this._requestExit(position, trade.timestampMs, 'HARD_STOP_20');
      return;
    }
    const exitProfile = this.exitProfiles.get(position.exitProfileId);
    if (exitProfile?.mode === 'BARBELL' && !position.partialExitTargetAt) {
      if (position.partialStage === 0 && gross >= exitProfile.scale1TriggerPct) {
        this._requestPartial(position, trade.timestampMs, 1);
      } else if (position.partialStage === 1 && gross >= exitProfile.scale2TriggerPct) {
        this._requestPartial(position, trade.timestampMs, 2);
      }
    }
    if (position.maxFavorableReturnPct >= this.config.strengthActivationPct) {
      const floor = this._protectedFloor(position.maxFavorableReturnPct);
      if (gross <= floor) this._requestExit(position, trade.timestampMs, `PROTECTED_FLOOR_${floor}`);
    }
  }

  _protectedFloor(peakPct) {
    if (peakPct >= 200) return Math.max(100, peakPct - 80);
    if (peakPct >= 100) return Math.max(40, peakPct - 40);
    if (peakPct >= 50) return Math.max(15, peakPct - 25);
    return Math.max(0, peakPct - 15);
  }

  _requestPartial(position, triggerAt, stage) {
    position.partialExitTargetAt = triggerAt + this.config.exitDelayMs;
    position.partialExitDeadlineAt = position.partialExitTargetAt + this.config.exitTimeoutMs;
    position.pendingPartialStage = stage;
    this.store.updateQualityLeaderShadowPosition(position.id, {
      partialExitTargetAt: position.partialExitTargetAt,
      partialExitDeadlineAt: position.partialExitDeadlineAt,
      pendingPartialStage: stage,
    });
  }

  _fillPartial(position, trade, price) {
    const stage = position.pendingPartialStage || (position.partialStage + 1);
    const exitProfile = this.exitProfiles.get(position.exitProfileId);
    const fractionPct = stage === 1
      ? finite(exitProfile?.scale1FractionPct, 0)
      : finite(exitProfile?.scale2FractionPct, 0);
    const markReturnPct = ((price / position.entryPrice) - 1) * 100;
    const execution = executableSell(
      trade,
      (position.positionSol / position.entryPrice) * fractionPct / 100,
      price,
      { rugMarkReturnPct: markReturnPct },
    );
    const executablePrice = execution.price ?? price;
    position.partialStage = stage;
    position.partialExitTargetAt = null;
    position.partialExitDeadlineAt = null;
    position.pendingPartialStage = null;
    const patch = {
      partialStage: stage,
      clearPartialExitPending: true,
      pendingPartialStage: 0,
    };
    if (stage === 1) {
      position.scale1At = trade.timestampMs;
      position.scale1Price = executablePrice;
      patch.scale1At = position.scale1At;
      patch.scale1Price = price;
    } else {
      position.scale2At = trade.timestampMs;
      position.scale2Price = executablePrice;
      patch.scale2At = position.scale2At;
      patch.scale2Price = price;
    }
    this.store.updateQualityLeaderShadowPosition(position.id, patch);
    this.metrics.partialExits += 1;
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTargetMarket = position.graduatedAt ? 'PUMP_AMM' : 'PUMP_BONDING_CURVE';
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updateQualityLeaderShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTargetMarket: position.exitTargetMarket,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _close(position, trade, price) {
    const exitProfile = this.exitProfiles.get(position.exitProfileId);
    const firstWeight = exitProfile?.mode === 'BARBELL' && position.scale1Price
      ? exitProfile.scale1FractionPct / 100 : 0;
    const secondWeight = exitProfile?.mode === 'BARBELL' && position.scale2Price
      ? exitProfile.scale2FractionPct / 100 : 0;
    const runnerWeight = Math.max(0, 1 - firstWeight - secondWeight);
    const markReturnPct = ((price / position.entryPrice) - 1) * 100;
    const execution = executableSell(
      trade,
      (position.positionSol / position.entryPrice) * runnerWeight,
      price,
      { rugMarkReturnPct: markReturnPct },
    );
    const executablePrice = execution.price ?? price;
    let weightedRatio = executablePrice / position.entryPrice;
    let partialCount = 0;
    if (exitProfile?.mode === 'BARBELL') {
      weightedRatio = firstWeight * ((position.scale1Price || executablePrice) / position.entryPrice)
        + secondWeight * ((position.scale2Price || executablePrice) / position.entryPrice)
        + runnerWeight * (executablePrice / position.entryPrice);
      partialCount = Number(Boolean(position.scale1Price)) + Number(Boolean(position.scale2Price));
    }
    const executableReturnPct = (weightedRatio - 1) * 100;
    if (executableReturnPct > this.config.maxPlausibleReturnPct || executableReturnPct < -100) {
      this._markNoExit(position, `IMPLAUSIBLE_EXIT_RETURN_${executableReturnPct.toFixed(2)}PCT`);
      return;
    }
    const netReturnPct = executableReturnPct - position.configuredCostPct
      - partialCount * this.costs.fixedCostPct;
    this.store.updateQualityLeaderShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: executablePrice,
      grossReturnPct: markReturnPct,
      netReturnPct,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
  }

  _markNoExit(position, reason) {
    this.store.updateQualityLeaderShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      rejectionReason: reason,
      grossReturnPct: -100,
      netReturnPct: -100 - finite(
        position.configuredCostPct,
        this.costs.deterministicCostPct,
      ),
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.noExit += 1;
  }

  _index(position) {
    const ids = this.rowsByMint.get(position.mint) || new Set();
    ids.add(position.id);
    this.rowsByMint.set(position.mint, ids);
  }

  _unindex(position) {
    const ids = this.rowsByMint.get(position.mint);
    if (!ids) return;
    ids.delete(position.id);
    if (!ids.size) this.rowsByMint.delete(position.mint);
  }
}

module.exports = { QualityLeaderShadowSuite, STATUS, curveBuyAveragePrice };
