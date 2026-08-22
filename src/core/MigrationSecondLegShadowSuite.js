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
    configuredCostPct: finite(valueOf(
      row, 'configured_cost_pct', 'configuredCostPct',
    ), 0),
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
    hardStopPct: finite(valueOf(row, 'hard_stop_pct', 'hardStopPct'), 100),
    maxHoldMs: finite(valueOf(row, 'max_hold_ms', 'maxHoldMs'), 10_000),
    exitTriggerAt: valueOf(row, 'exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: valueOf(row, 'exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: valueOf(row, 'exit_deadline_at', 'exitDeadlineAt'),
    exitReason: valueOf(row, 'exit_reason', 'exitReason'),
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Cross-token regime labels are deliberately owned by the M2F shadow suite.
// They are never exported as a live signal and cannot gate LiveTradingManager.
class MarketRegimeTracker {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      maturityAgeMs: finite(config.maturityAgeMs, 120_000),
      lookbackMs: finite(config.lookbackMs, 10 * 60_000),
      minMints: finite(config.minMints, 12),
      minPositiveReturnRatePct: finite(config.minPositiveReturnRatePct, 50),
      maxRugCollapseRatePct: finite(config.maxRugCollapseRatePct, 15),
      minPositiveNetFlowRatePct: finite(config.minPositiveNetFlowRatePct, 55),
      maxMedianEstimatedImpact1SolPct: finite(
        config.maxMedianEstimatedImpact1SolPct, 5,
      ),
    };
    this.outcomes = new Map();
    this.cachedSnapshot = null;
  }

  observe(snapshot) {
    if (!this.config.enabled || !snapshot?.mint
      || finite(snapshot.ageMs, -1) < this.config.maturityAgeMs
      || this.outcomes.has(snapshot.mint)) return;
    const baseline = finite(snapshot.baselinePrice);
    const price = finite(snapshot.price);
    if (!(baseline > 0) || !(price > 0)) return;
    const returnPct = ((price / baseline) - 1) * 100;
    const rugRisk = snapshot.featureCompleteness?.preEntryRugRisk;
    this.outcomes.set(snapshot.mint, {
      mint: snapshot.mint,
      observedAt: finite(snapshot.observedAt, Date.now()),
      returnPct,
      rugCollapse: returnPct <= -50
        || rugRisk?.flagged === true
        || rugRisk?.blocked === true,
      positiveNetFlow: finite(snapshot.netFlow10s, 0) > 0,
      estimatedImpact1SolPct: finite(snapshot.estimatedImpact1SolPct),
    });
    this.cachedSnapshot = null;
    this._prune(finite(snapshot.observedAt, Date.now()));
  }

  snapshot(now = Date.now()) {
    this._prune(now);
    if (this.cachedSnapshot) return { ...this.cachedSnapshot };
    const rows = [...this.outcomes.values()];
    const count = rows.length;
    const percent = (matched) => (count ? (matched / count) * 100 : 0);
    const positiveReturnRatePct = percent(rows.filter((row) => row.returnPct > 0).length);
    const rugCollapseRatePct = percent(rows.filter((row) => row.rugCollapse).length);
    const positiveNetFlowRatePct = percent(rows.filter((row) => row.positiveNetFlow).length);
    const medianEstimatedImpact1SolPct = median(
      rows.map((row) => row.estimatedImpact1SolPct),
    );
    const sufficient = count >= this.config.minMints;
    const green = sufficient
      && positiveReturnRatePct >= this.config.minPositiveReturnRatePct
      && rugCollapseRatePct <= this.config.maxRugCollapseRatePct
      && positiveNetFlowRatePct >= this.config.minPositiveNetFlowRatePct
      && medianEstimatedImpact1SolPct != null
      && medianEstimatedImpact1SolPct <= this.config.maxMedianEstimatedImpact1SolPct;
    this.cachedSnapshot = {
      state: sufficient ? (green ? 'GREEN' : 'RED') : 'INSUFFICIENT',
      shadowOnly: true,
      sampleMints: count,
      positiveReturnRatePct,
      rugCollapseRatePct,
      positiveNetFlowRatePct,
      medianEstimatedImpact1SolPct,
      lookbackMs: this.config.lookbackMs,
    };
    return { ...this.cachedSnapshot };
  }

  _prune(now) {
    const cutoff = now - this.config.lookbackMs;
    let changed = false;
    for (const [mint, row] of this.outcomes) {
      if (row.observedAt < cutoff) {
        this.outcomes.delete(mint);
        changed = true;
      }
    }
    if (changed) this.cachedSnapshot = null;
  }
}

class MigrationSecondLegShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    const legacy = {
      id: config.cohortId,
      label: 'M2F Near-High Flow + Universal RUG Guard B',
      enabled: true,
      studyMode: 'ENTRY_CONTROL',
      confirmationMode: 'IMMEDIATE',
      positionSizeSol: config.positionSizeSol,
      entryDelayMs: config.entryDelayMs,
      entryTimeoutMs: config.entryTimeoutMs,
      exitDelayMs: config.exitDelayMs,
      exitTimeoutMs: config.exitTimeoutMs,
      maxEntryPriceJumpPct: config.maxEntryPriceJumpPct,
      maxNegativeEntryJumpPct: config.maxNegativeEntryJumpPct,
      hardStopPct: config.hardStopPct,
      maxHoldMs: config.maxHoldMs,
      thresholds: config.thresholds,
    };
    this.cohorts = (Array.isArray(config.cohorts) && config.cohorts.length
      ? config.cohorts : [legacy])
      .filter((cohort) => cohort?.enabled !== false && cohort?.id)
      .map((cohort) => ({ ...legacy, ...cohort, thresholds: {
        ...(config.thresholds || {}), ...(cohort.thresholds || {}),
      } }));
    this.cohortById = new Map(this.cohorts.map((cohort) => [cohort.id, cohort]));
    this.costsByCohort = new Map(this.cohorts.map((cohort) => [cohort.id, costBreakdown({
      ...(config.costModel || {}),
      positionSizeSol: cohort.positionSizeSol,
    })]));
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.confirmationByCohort = new Map(this.cohorts
      .filter((cohort) => cohort.confirmationMode !== 'IMMEDIATE')
      .map((cohort) => [cohort.id, new Map()]));
    this.marketRegime = new MarketRegimeTracker(config.marketRegime);
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
    const cohortHealth = this.cohorts.map((cohort) => ({
      id: cohort.id,
      label: cohort.label,
      studyMode: cohort.studyMode,
      confirmationMode: cohort.confirmationMode,
      hardStopPct: cohort.hardStopPct,
      maxHoldMs: cohort.maxHoldMs,
      configuredCostPct: this.costsByCohort.get(cohort.id)?.deterministicCostPct ?? null,
    }));
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_M2F_RESEARCH_MATRIX',
      code: this.cohorts.map((cohort) => cohort.id).join(' / '),
      sendsTransactions: false,
      liveDecisionIntegration: 'DISABLED',
      marketRegimeUsage: 'SHADOW_ONLY_NEVER_LIVE',
      guardRequired: true,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      strategy: {
        name: 'M2F Entry Control / Hold Extension / Confirmation Filter',
        positionSizeSol: this.config.positionSizeSol,
        entryDelayMs: this.config.entryDelayMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        hardStopPct: this.config.hardStopPct,
        maxHoldMs: this.config.maxHoldMs,
        thresholds: this.config.thresholds,
        configuredCostPct: this.costsByCohort.get(this.config.cohortId)
          ?.deterministicCostPct ?? null,
        cohorts: cohortHealth,
        isolatedTable: 'migration_second_leg_shadow_positions',
        marketRegime: this.marketRegime.snapshot(this.now()),
      },
      ...this.metrics,
    };
  }

  trackedMints() {
    return [...this.rowsByMint.keys()];
  }

  onSnapshot(snapshot, trade) {
    if (!this.config.enabled || !snapshot?.mint || !(snapshot.price > 0)) return;
    // Read the regime before this observation is incorporated. With the
    // default 120s maturity this is also strictly later than every SSR entry
    // horizon (<=90s), preventing the candidate from grading itself.
    const regime = this.marketRegime.snapshot(snapshot.observedAt);
    this.metrics.evaluated += 1;
    for (const cohort of this.cohorts) {
      const matched = this._matches(snapshot, cohort, regime);
      if (!matched) {
        // CF2 means two consecutive qualifying observer snapshots. A failed
        // snapshot breaks persistence instead of letting an older good sample
        // bridge across a transient flow deterioration.
        this.confirmationByCohort.get(cohort.id)?.delete(snapshot.mint);
        continue;
      }
      if (!this._confirmationPassed(snapshot, cohort)) continue;
      this._createSignal(snapshot, trade, cohort, regime);
    }
    this.marketRegime.observe(snapshot);
  }

  _createSignal(snapshot, trade, cohort, regime) {
    const migrationAt = finite(snapshot.migrationAt, snapshot.observedAt - snapshot.ageMs);
    const episodeId = `${snapshot.mint}:${migrationAt}:${cohort.id}`;
    const features = {
      studyMode: cohort.studyMode,
      confirmationMode: cohort.confirmationMode,
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
      marketRegime: regime,
      marketRegimeRequired: cohort.requireGreenRegime === true,
      liveEligible: false,
    };
    const saved = this.store.createMigrationSecondLegShadowPosition({
      cohortId: cohort.id,
      episodeId,
      mint: snapshot.mint,
      symbol: snapshot.symbol || trade?.symbol || null,
      status: STATUS.PENDING_ENTRY,
      positionSol: cohort.positionSizeSol,
      configuredCostPct: this.costsByCohort.get(cohort.id).deterministicCostPct,
      migrationAt,
      signalAt: snapshot.observedAt,
      signalPrice: snapshot.price,
      signalAgeMs: snapshot.ageMs,
      features,
      entryTargetAt: snapshot.observedAt + cohort.entryDelayMs,
      entryDeadlineAt: snapshot.observedAt + cohort.entryDelayMs
        + cohort.entryTimeoutMs,
      hardStopPct: cohort.hardStopPct,
      maxHoldMs: cohort.maxHoldMs,
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

  _confirmationPassed(snapshot, cohort) {
    if (cohort.confirmationMode === 'IMMEDIATE') return true;
    const states = this.confirmationByCohort.get(cohort.id);
    if (!states) return false;
    const previous = states.get(snapshot.mint);
    states.set(snapshot.mint, {
      observedAt: snapshot.observedAt,
      migrationAt: snapshot.migrationAt,
      netFlow3s: finite(snapshot.netFlow3s, 0),
      buyers10s: finite(snapshot.buyers10s, 0),
      sellDecelerationRatio: finite(snapshot.sellDecelerationRatio, Infinity),
    });
    if (!previous) return false;
    const gapMs = snapshot.observedAt - previous.observedAt;
    if (gapMs < finite(cohort.confirmationMinGapMs, 500)
      || gapMs > finite(cohort.confirmationMaxGapMs, 2_500)) return false;
    if (previous.migrationAt != null && snapshot.migrationAt != null
      && finite(previous.migrationAt) !== finite(snapshot.migrationAt)) return false;
    return finite(snapshot.netFlow3s, 0) > 0
      && finite(snapshot.netFlow3s, 0) >= previous.netFlow3s
      && finite(snapshot.buyers10s, 0) >= previous.buyers10s
      && finite(snapshot.sellDecelerationRatio, Infinity)
        <= previous.sellDecelerationRatio + finite(cohort.maxSellDecelerationIncrease, 0.1);
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
      if (gross <= -position.hardStopPct) this._requestExit(position, timestampMs, 'HARD_STOP');
      else if (heldMs >= position.maxHoldMs) {
        this._requestExit(position, position.entryAt + position.maxHoldMs, 'FIXED_HOLD');
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
      if (position.status === STATUS.OPEN && now >= position.entryAt + position.maxHoldMs) {
        this._requestExit(position, position.entryAt + position.maxHoldMs, 'FIXED_HOLD');
      }
      if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        this._markNoExit(position);
      }
    }
  }

  _matches(snapshot, cohort, regime = null) {
    const t = cohort.thresholds;
    const peakImpulsePct = snapshot.baselinePrice > 0
      ? ((snapshot.peakPrice / snapshot.baselinePrice) - 1) * 100 : null;
    const impact1Sol = finite(snapshot.estimatedImpact1SolPct);
    if (cohort.requireGreenRegime && regime?.state !== 'GREEN') return false;
    return snapshot.ageMs >= t.minAgeMs && snapshot.ageMs <= t.maxAgeMs
      && snapshot.openingImpulsePct >= t.minCurrentImpulsePct
      && snapshot.openingImpulsePct <= t.maxCurrentImpulsePct
      && peakImpulsePct >= t.minPeakImpulsePct
      && snapshot.pullbackPct >= t.minPullbackPct
      && snapshot.pullbackPct <= t.maxPullbackPct
      && snapshot.reboundPct >= t.minReboundPct
      && snapshot.reboundPct <= finite(t.maxReboundPct, Infinity)
      && snapshot.netFlow10s >= t.minNetFlow10sSol
      && snapshot.netFlow3s >= t.minNetFlow3sSol
      && snapshot.buyers10s >= t.minBuyers10s
      && snapshot.buyers3s >= t.minBuyers3s
      && finite(snapshot.largestBuyerShare10sPct, 100) <= t.maxLargestBuyerSharePct
      && finite(snapshot.buySpeedRatio, 0) >= t.minBuySpeedRatio
      && finite(snapshot.netFlowAcceleration, -Infinity) >= t.minNetFlowAcceleration
      && finite(snapshot.sellDecelerationRatio, Infinity) <= t.maxSellDecelerationRatio
      && snapshot.observedHolderDiffusionIndex >= t.minHolderDiffusionIndex
      && finite(snapshot.quoteReserveSol, 0) >= finite(t.minQuoteReserveSol, 0)
      && impact1Sol != null && impact1Sol <= t.maxEstimatedImpact1SolPct;
  }

  _tryEntry(position, trade, price) {
    const cohort = this._cohort(position);
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: position.cohortId,
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
    if (jumpPct > cohort.maxEntryPriceJumpPct
      || jumpPct < -cohort.maxNegativeEntryJumpPct) {
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
    const cohort = this._cohort(position);
    Object.assign(position, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: triggerAt,
      exitTargetAt: triggerAt + cohort.exitDelayMs,
      exitDeadlineAt: triggerAt + cohort.exitDelayMs + cohort.exitTimeoutMs,
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
      netReturnPct: executableReturnPct - position.configuredCostPct,
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
      netReturnPct: -100 - position.configuredCostPct,
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

  _cohort(position) {
    return this.cohortById.get(position.cohortId) || {
      ...this.config,
      id: position.cohortId,
    };
  }
}

module.exports = { MigrationSecondLegShadowSuite, MarketRegimeTracker, STATUS };
