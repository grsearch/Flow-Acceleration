'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');
const strictAmm = require('./StrictAmmShadowExecution');
const {
  LegacyEarlyFlowEntryTracker, ENTRY_MODE: LEGACY_ENTRY_MODE,
  EXECUTION_VERSION: LEGACY_EXECUTION_VERSION, matchesLegacyEntry, postPoolPrice,
  BASE_COHORT_ID: LEGACY_BASE_COHORT_ID,
  RUGX_COHORT_ID: LEGACY_RUGX_COHORT_ID,
  STUDY_VERSION: LEGACY_STUDY_VERSION,
  STUDY_ARMS: LEGACY_STUDY_ARMS,
  STUDY_COHORT_IDS: LEGACY_STUDY_COHORT_IDS,
  FIVE_ARM_COHORT_IDS: LEGACY_FIVE_ARM_COHORT_IDS,
  DEFAULT_THRESHOLDS: LEGACY_DEFAULT_THRESHOLDS,
} = require('./LegacyEarlyFlowEntryTracker');
const {
  hardBlockSignaturesForLifecycle,
  RUG_GUARD_ENFORCEMENT,
} = require('./RugGuardPolicy');

const STATUS = Object.freeze({
  PENDING_ENTRY: 'PENDING_ENTRY',
  PRICE_JUMP: 'PRICE_JUMP',
  NO_ENTRY: 'NO_ENTRY',
  OPEN: 'OPEN',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED: 'CLOSED',
  NO_EXIT: 'NO_EXIT',
  DATA_ERROR: 'DATA_ERROR',
});

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function priceOf(trade) {
  const reservePrice = finite(trade?.reservePrice);
  return reservePrice > 0 ? reservePrice : finite(trade?.price);
}

function valueOf(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function restore(row) {
  let features;
  try { features = typeof row.features === 'object' ? row.features
    : JSON.parse(row.features_json ?? row.featuresJson ?? '{}'); } catch (_) { features = {}; }
  return {
    features,
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
    migrationAt: valueOf(row, 'migration_at', 'migrationAt'),
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
  constructor({ config, store, now = () => Date.now(), onLiveSignal = null,
    getSolUsdReference = () => null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.onLiveSignal = onLiveSignal;
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
      maxObservedPriceRatio: config.maxObservedPriceRatio,
      hardStopPct: config.hardStopPct,
      trailingActivationPct: config.trailingActivationPct,
      trailingStopPct: config.trailingStopPct,
      maxHoldMs: config.maxHoldMs,
      rugGuardMode: config.rugGuardMode || RUG_GUARD_ENFORCEMENT.HARD_BLOCK,
      hardBlockSignatures: config.hardBlockSignatures || null,
      rugPolicyReason: config.rugPolicyReason || null,
      requireCapacityMetrics: config.requireCapacityMetrics !== false,
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
      ...(cohort.costModel || {}),
      ...(cohort.entryMode === LEGACY_ENTRY_MODE ? { priceImpactPct: 0 } : {}),
      positionSizeSol: cohort.positionSizeSol,
    })]));
    this.legacyCohorts = this.cohorts.filter(cohort => cohort.entryMode === LEGACY_ENTRY_MODE);
    this.legacyBaseCohort = this.legacyCohorts.find(
      cohort => cohort.id === LEGACY_BASE_COHORT_ID,
    ) || this.legacyCohorts[0];
    const configuredLegacyIds = new Set((Array.isArray(config.cohorts) ? config.cohorts : [])
      .map(cohort => cohort?.id).filter(Boolean));
    this.legacyStudyConfigured = LEGACY_STUDY_COHORT_IDS.some(id => configuredLegacyIds.has(id));
    this.legacyFiveArmConfigurationError = this._legacyFiveArmConfigurationError();
    this.legacyFiveArmReady = this.legacyStudyConfigured
      && this.legacyFiveArmConfigurationError == null;
    this.legacyTracker = new LegacyEarlyFlowEntryTracker({ store, now, getSolUsdReference,
      config: { ...(config.legacyEarlyFlow || {}), thresholds: this.legacyBaseCohort?.thresholds } });
    this.legacyMetrics = { signals: 0, rugRejected: 0, liveBridgeEmitted: 0,
      liveBridgeErrors: 0, persistenceErrors: 0, persistenceRetryErrors: 0,
      persistenceFailedRows: 0, existingEpisodesSuppressed: 0,
      incompleteHistoricalEpisodesSkipped: 0, partialEpisodeConflicts: 0,
      invalidFiveArmConfigurations: 0, strictRejectedByReason: {} };
    this.legacyPersistenceFailures = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.noExitWatches = new Map();
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
      noExitWatchRecovered: 0,
      lateExitObserved: 0,
      lateExitObservationExpired: 0,
      dataError: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  _legacyFiveArmConfigurationError() {
    if (!this.legacyStudyConfigured) return null;
    const byId = new Map(this.legacyCohorts.map(cohort => [cohort.id, cohort]));
    for (const id of LEGACY_FIVE_ARM_COHORT_IDS) {
      const cohort = byId.get(id);
      if (!cohort) return `MISSING_${id}`;
      if (cohort.newEntriesEnabled === false) return `DISABLED_${id}`;
      if (cohort.executionVersion !== LEGACY_EXECUTION_VERSION) return `EXECUTION_VERSION_${id}`;
      if (cohort.studyVersion !== LEGACY_STUDY_VERSION) return `STUDY_VERSION_${id}`;
    }
    const base = byId.get(LEGACY_BASE_COHORT_ID);
    const rugx = byId.get(LEGACY_RUGX_COHORT_ID);
    const thresholds = cohort => ({ ...LEGACY_DEFAULT_THRESHOLDS, ...(cohort.thresholds || {}) });
    if (!sameJson(thresholds(base), thresholds(rugx))) return 'RUGX_THRESHOLDS_DIFFER_FROM_BASE';
    const protocolKeys = ['executionVersion', 'strictExecution', 'positionSizeSol', 'costModel',
      'entryDelayMs', 'entryTimeoutMs', 'exitDelayMs', 'exitTimeoutMs',
      'maxEntryPriceJumpPct', 'maxNegativeEntryJumpPct', 'maxEntryImpactPct',
      'hardStopPct', 'trailingActivationPct', 'trailingStopPct', 'maxHoldMs', 'minHoldMs'];
    const protocol = cohort => Object.fromEntries(protocolKeys.map(key => [key, cohort[key]]));
    if (!sameJson(protocol(base), protocol(rugx))) return 'RUGX_PROTOCOL_DIFFERS_FROM_BASE';
    for (const id of LEGACY_STUDY_COHORT_IDS) {
      const cohort = byId.get(id);
      const definition = LEGACY_STUDY_ARMS[id];
      if (cohort.pairedBaselineCohortId !== LEGACY_BASE_COHORT_ID) {
        return `BASELINE_${id}`;
      }
      if (!sameJson(cohort.singleVariable, definition.singleVariable)) {
        return `SINGLE_VARIABLE_${id}`;
      }
      if (!sameJson(thresholds(cohort), { ...thresholds(base), ...definition.thresholdPatch })) {
        return `THRESHOLDS_${id}`;
      }
      if (!sameJson(protocol(cohort), protocol(base))) return `PROTOCOL_${id}`;
      if (cohort.rugGuardMode !== base.rugGuardMode || cohort.liveBridgeEnabled === true
        || cohort.liveStrategyId != null) return `ISOLATION_${id}`;
    }
    return null;
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.store.activeMigrationSecondLegShadowPositions()) {
      const position = restore(row);
      if (!this._restoreLegacy(position)) continue;
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const startupAt = this.now();
    const noExitObservationMs = finite(this.config.noExitObservationMs, 10 * 60_000);
    for (const row of this.store.recoverableMigrationSecondLegNoExitPositions()) {
      const position = restore(row);
      if (!this._restoreLegacy(position)) continue;
      if (!(position.exitDeadlineAt > 0)
        || startupAt > position.exitDeadlineAt + noExitObservationMs) {
        this.store.updateMigrationSecondLegShadowPosition(position.id, {
          lateExitStatus: 'EXPIRED_NO_EXECUTABLE_TRADE',
        });
        this.metrics.lateExitObservationExpired += 1;
        continue;
      }
      this.noExitWatches.set(position.id, position);
      this._index(position);
      this.metrics.noExitWatchRecovered += 1;
    }
    this.advanceTime(this.now());
  }

  stop() {
    for (const position of [...this.pendingEntries.values(), ...this.positions.values(),
      ...this.noExitWatches.values()]) {
      if (!this._isLegacy(position)) continue;
      try { this._saveLegacy(position, {}, true); }
      catch (error) { this._queueLegacyPersistenceFailure(position, error, 'STOP_FLUSH'); }
    }
    this._retryLegacyPersistenceFailures(this.now(), true);
    if (this.legacyPersistenceFailures.size > 0) {
      const error = new Error('Legacy Shadow persistence outcomes remain unsaved');
      error.code = 'LEGACY_SHADOW_PERSISTENCE_PENDING';
      error.pendingErrors = this.legacyPersistenceFailures.size;
      throw error;
    }
  }

  health() {
    const cohortHealth = this.cohorts.map((cohort) => ({
      id: cohort.id,
      label: cohort.label,
      studyMode: cohort.studyMode,
      confirmationMode: cohort.confirmationMode,
      hardStopPct: cohort.hardStopPct,
      trailingActivationPct: cohort.trailingActivationPct,
      trailingStopPct: cohort.trailingStopPct,
      maxHoldMs: cohort.maxHoldMs,
      rugGuardMode: cohort.rugGuardMode,
      hardBlockSignatures: cohort.hardBlockSignatures,
      requireCapacityMetrics: cohort.requireCapacityMetrics,
      configuredCostPct: this.costsByCohort.get(cohort.id)?.deterministicCostPct ?? null,
      entryMode: cohort.entryMode,
      executionVersion: cohort.executionVersion,
      studyVersion: cohort.studyVersion || null,
      singleVariable: cohort.singleVariable || null,
      thresholds: cohort.thresholds,
      positionSizeSol: cohort.positionSizeSol,
      strictExecution: cohort.strictExecution,
      liveBridgeEnabled: cohort.liveBridgeEnabled === true,
      liveStrategyId: cohort.liveStrategyId || null,
      newEntriesEnabled: this.config.newEntriesEnabled !== false && cohort.newEntriesEnabled !== false,
    }));
    return {
      enabled: this.config.enabled,
      newEntriesEnabled: this.config.newEntriesEnabled !== false,
      mode: 'SHADOW_PMO_STRICT_PAIR_MATRIX',
      code: this.cohorts.map((cohort) => cohort.id).join(' / '),
      sendsTransactions: false,
      liveDecisionIntegration: this.legacyCohorts.some(cohort => cohort.liveBridgeEnabled)
        ? 'LEGACY_EARLY_FLOW_RUGX_SOURCE_ONLY' : 'DISABLED',
      fiveArmStudy: { configured: this.legacyStudyConfigured,
        ready: this.legacyFiveArmReady, version: LEGACY_STUDY_VERSION,
        configurationError: this.legacyFiveArmConfigurationError,
        cohortIds: [...LEGACY_FIVE_ARM_COHORT_IDS] },
      sourceDiagnostics: { kind: 'LEGACY_EARLY_FLOW', ...this.legacyTracker.health(),
        ...this.legacyMetrics, sourceSignals: this.legacyTracker.metrics.signals,
        cohortSignals: this.legacyMetrics.signals,
        matched: this.legacyTracker.metrics.signals,
        pendingErrors: this.legacyPersistenceFailures.size },
      legacyEarlyFlow: { kind: 'LEGACY_EARLY_FLOW', ...this.legacyTracker.health(),
        ...this.legacyMetrics, sourceSignals: this.legacyTracker.metrics.signals,
        cohortSignals: this.legacyMetrics.signals,
        matched: this.legacyTracker.metrics.signals,
        liveSignals: this.legacyMetrics.liveBridgeEmitted,
        pendingErrors: this.legacyPersistenceFailures.size },
      marketRegimeUsage: 'SHADOW_ONLY_NEVER_LIVE',
      guardRequired: true,
      strictRugPairs: true,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      lateExitPending: this.noExitWatches.size,
      strategy: {
        name: this.config.strategyName
          || 'Late Post-Migration Stabilization LPS',
        positionSizeSol: this.config.positionSizeSol,
        entryDelayMs: this.config.entryDelayMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        hardStopPct: this.config.hardStopPct,
        maxHoldMs: this.config.maxHoldMs,
        thresholds: this.config.thresholds,
        configuredCostPct: this.costsByCohort.get(this.cohorts[0]?.id)
          ?.deterministicCostPct ?? null,
        cohorts: cohortHealth,
        isolatedTable: 'migration_second_leg_shadow_positions',
        marketRegime: this.marketRegime.snapshot(this.now()),
      },
      ...this.metrics,
    };
  }

  trackedMints() {
    return [...new Set([...this.rowsByMint.keys(),
      ...(this.config.enabled && this.legacyCohorts.length ? this.legacyTracker.trackedMints() : [])])];
  }

  observeGraduation(token) {
    if (!this.config.enabled || !this.legacyCohorts.length) return;
    this.legacyTracker.observeGraduation(token);
  }

  onSnapshot(snapshot, trade) {
    if (!this.config.enabled || !snapshot?.mint || !(snapshot.price > 0)) return;
    // Read the regime before this observation is incorporated. With the
    // default 120s maturity this is also strictly later than every SSR entry
    // horizon (<=90s), preventing the candidate from grading itself.
    const regime = this.marketRegime.snapshot(snapshot.observedAt);
    this.metrics.evaluated += 1;
    for (const cohort of this.cohorts) {
      if (cohort.entryMode === LEGACY_ENTRY_MODE) continue;
      if (cohort.newEntriesEnabled === false) continue;
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
    if (this.config.newEntriesEnabled === false || cohort.newEntriesEnabled === false) return;
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
      observationLagMs: snapshot.observationLagMs,
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
    if (this.config.enabled && this.config.newEntriesEnabled !== false
      && this.legacyCohorts.some(cohort => cohort.newEntriesEnabled !== false)) {
      const candidate = this.legacyTracker.observeTrade(trade);
      if (candidate) this._createLegacySignals(candidate);
    }
    const price = priceOf(trade);
    const timestampMs = finite(trade?.timestampMs);
    if (!this.config.enabled || trade?.market !== 'PUMP_AMM' || !trade?.mint) return;
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const legacyPosition = this.pendingEntries.get(id) || this.positions.get(id) || this.noExitWatches.get(id);
      if (this._isLegacy(legacyPosition)) {
        this._withLegacyPersistence(legacyPosition, 'TRADE_STATE',
          () => this._observeLegacyPosition(legacyPosition, trade));
        continue;
      }
      if (!(price > 0) || !(timestampMs > 0)) continue;
      const noExitWatch = this.noExitWatches.get(id);
      if (noExitWatch) {
        this._observeLateExit(noExitWatch, trade, price);
        continue;
      }
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.entryPrice > 0 && this._priceScaleDiscontinuity(position, price)) {
        this._markDataError(position, trade, price);
        continue;
      }
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
      else {
        const cohort = this._cohort(position);
        const activationPct = finite(cohort.trailingActivationPct);
        const drawdownLimitPct = finite(cohort.trailingStopPct);
        const highReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
        const peakDrawdownPct = (1 - price / position.highestPrice) * 100;
        if (activationPct != null && drawdownLimitPct > 0
          && highReturnPct >= activationPct
          && peakDrawdownPct >= drawdownLimitPct) {
          this._requestExit(
            position,
            timestampMs,
            `TRAILING_STOP_A${activationPct}_D${drawdownLimitPct}`,
          );
        }
      }
      if (position.status === STATUS.OPEN && heldMs >= position.maxHoldMs) {
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
    this._retryLegacyPersistenceFailures(now);
    this.legacyTracker.advanceTime(now);
    for (const position of [...this.pendingEntries.values()]) {
      if (now <= position.entryDeadlineAt) continue;
      this._withLegacyPersistence(position, 'ENTRY_TIMEOUT', () => {
        this.store.updateMigrationSecondLegShadowPosition(position.id, {
          status: STATUS.NO_ENTRY,
          rejectionReason: 'ENTRY_TIMEOUT',
        });
        this.pendingEntries.delete(position.id);
        this._unindex(position);
        this.metrics.noEntry += 1;
      });
    }
    for (const position of [...this.positions.values()]) {
      this._withLegacyPersistence(position, 'EXIT_TIMEOUT', () => {
        if (position.status === STATUS.OPEN && now >= position.entryAt + position.maxHoldMs) {
          this._requestExit(position, position.entryAt + position.maxHoldMs, 'FIXED_HOLD');
        }
        if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
          this._markNoExit(position);
        }
      });
    }
    const noExitObservationMs = finite(this.config.noExitObservationMs, 10 * 60_000);
    for (const position of [...this.noExitWatches.values()]) {
      if (now <= position.exitDeadlineAt + noExitObservationMs) continue;
      this._withLegacyPersistence(position, 'LATE_EXIT_TIMEOUT', () => {
        this.store.updateMigrationSecondLegShadowPosition(position.id, {
          lateExitStatus: 'EXPIRED_NO_EXECUTABLE_TRADE',
        });
        this.noExitWatches.delete(position.id);
        this._unindex(position);
        this.metrics.lateExitObservationExpired += 1;
      });
    }
  }

  _matches(snapshot, cohort, regime = null) {
    const t = cohort.thresholds;
    const peakImpulsePct = snapshot.baselinePrice > 0
      ? ((snapshot.peakPrice / snapshot.baselinePrice) - 1) * 100 : null;
    const impact1Sol = finite(snapshot.estimatedImpact1SolPct);
    const observationLagMs = finite(snapshot.observationLagMs, Infinity);
    if (cohort.requireGreenRegime && regime?.state !== 'GREEN') return false;
    return snapshot.ageMs >= t.minAgeMs && snapshot.ageMs <= t.maxAgeMs
      && observationLagMs <= finite(t.maxObservationLagMs, Infinity)
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
      && (cohort.requireCapacityMetrics === false
        ? impact1Sol == null || impact1Sol <= t.maxEstimatedImpact1SolPct
        : impact1Sol != null && impact1Sol <= t.maxEstimatedImpact1SolPct);
  }

  _tryEntry(position, trade, price) {
    const cohort = this._cohort(position);
    const lifecycleAgeMs = Math.max(
      0,
      trade.timestampMs - finite(position.migrationAt, trade.timestampMs),
    );
    const lifecycleStage = lifecycleAgeMs <= 10_000 ? 'AMM_EARLY' : 'AMM_MATURE';
    const hardBlockSignatures = Array.isArray(cohort.hardBlockSignatures)
      ? cohort.hardBlockSignatures
      : (cohort.rugGuardMode === RUG_GUARD_ENFORCEMENT.HARD_BLOCK
        ? hardBlockSignaturesForLifecycle({ market: trade.market, lifecycleStage })
        : null);
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: position.cohortId,
      mint: position.mint,
      timestampMs: trade.timestampMs,
      source: 'SHADOW',
      market: trade.market,
      lifecycleStage,
      lifecycleAgeMs,
      enforcementMode: cohort.rugGuardMode,
      hardBlockSignatures,
      policyReason: cohort.rugPolicyReason,
    });
    if (rugGuard.blocked) {
      this.store.updateMigrationSecondLegShadowPosition(position.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: rugGuard.reason || 'PRE_ENTRY_RUG_RISK',
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

  _priceScaleDiscontinuity(position, price) {
    const cohort = this._cohort(position);
    const anchor = finite(position.lastPrice, finite(position.entryPrice));
    if (!(anchor > 0) || !(price > 0)) return false;
    return (price / anchor) > finite(cohort.maxObservedPriceRatio, 100);
  }

  _markDataError(position, trade, price) {
    const anchor = finite(position.lastPrice, finite(position.entryPrice));
    const ratio = anchor > 0 ? price / anchor : null;
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
      status: STATUS.DATA_ERROR,
      lastObservedAt: trade.timestampMs,
      lastPrice: price,
      exitReason: ratio == null
        ? 'PRICE_SCALE_DISCONTINUITY'
        : `PRICE_SCALE_DISCONTINUITY_${ratio.toFixed(2)}X`,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.pendingEntries.delete(position.id);
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.dataError += 1;
    this.metrics.lastActionAt = this.now();
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    const cohort = this._cohort(position);
    const legacy = this._isLegacy(position) ? position.features.strictExecution : null;
    const exitDelayMs = legacy?.policy.exitDelayMs ?? cohort.exitDelayMs;
    const exitTimeoutMs = legacy?.policy.exitTimeoutMs ?? cohort.exitTimeoutMs;
    if (legacy) {
      const next = { ...position, status: STATUS.EXIT_PENDING, exitReason: reason,
        exitTriggerAt: triggerAt, exitTargetAt: triggerAt + exitDelayMs,
        exitDeadlineAt: triggerAt + exitDelayMs + exitTimeoutMs };
      this._saveLegacy(next, { status: next.status, exitReason: next.exitReason,
        exitTriggerAt: next.exitTriggerAt, exitTargetAt: next.exitTargetAt,
        exitDeadlineAt: next.exitDeadlineAt }, true);
      // Publish the transition only after the exact trigger is durable.
      Object.assign(position, next);
      return;
    }
    Object.assign(position, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: triggerAt,
      exitTargetAt: triggerAt + exitDelayMs,
      exitDeadlineAt: triggerAt + exitDelayMs + exitTimeoutMs,
    });
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
      ...(legacy ? { features: position.features } : {}),
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

  _isLegacy(position) {
    return Boolean(position && (position.features?.executionVersion === LEGACY_EXECUTION_VERSION
      || String(position.cohortId || '').startsWith('LEGACY-EARLY-FLOW-')));
  }

  _restoreLegacy(position) {
    if (!this._isLegacy(position)) return true;
    const strict = position.features?.strictExecution;
    const cohort = strict?.cohort;
    if (position.features?.executionVersion !== LEGACY_EXECUTION_VERSION
      || strict?.policy?.version !== strictAmm.VERSION || !strict.pool || !strict.source
      || strict.policy.maxTradeAgeMs !== 3_000 || strict.policy.entryDelayMs !== 1_000
      || strict.policy.exitDelayMs !== 1_000
      || !Number.isFinite(strict.policy.entryTimeoutMs) || strict.policy.entryTimeoutMs < 0
      || !Number.isFinite(strict.policy.exitTimeoutMs) || strict.policy.exitTimeoutMs < 0
      || cohort?.executionVersion !== LEGACY_EXECUTION_VERSION || cohort.id !== position.cohortId
      || !(cohort.maxHoldMs > 0) || !(cohort.hardStopPct > 0)
      || !Number.isFinite(cohort.maxEntryImpactPct) || cohort.maxEntryImpactPct < 0
      || position.maxHoldMs !== cohort.maxHoldMs || position.hardStopPct !== cohort.hardStopPct
      || position.positionSol !== 0.02
      || (position.entryAt && (!Number.isFinite(strict.tokenUnits) || !(strict.tokenUnits > 0)))) {
      this._withLegacyPersistence(position, 'RESTORE_INVALID', () => {
        this.store.updateMigrationSecondLegShadowPosition(position.id, {
          status: STATUS.DATA_ERROR, rejectionReason: 'LEGACY_FROZEN_EXECUTION_INVALID',
        });
        this.metrics.dataError += 1;
      });
      return false;
    }
    if (position.status === STATUS.PENDING_ENTRY && this.now() >= position.entryTargetAt) {
      // The process was absent for part of the fill window. Neither a fill nor
      // an ordinary no-market timeout can be reconstructed from cached quotes.
      this._withLegacyPersistence(position, 'RESTORE_PENDING_UNKNOWN', () => {
        this.store.updateMigrationSecondLegShadowPosition(position.id, {
          status: STATUS.DATA_ERROR, rejectionReason: 'LEGACY_RESTART_PENDING_OUTCOME_UNKNOWN',
        });
        this.metrics.dataError += 1;
      });
      return false;
    }
    position.strictRestoredAt = this.now();
    return true;
  }

  _legacyTradeEvidence(trade) {
    const evidence = Object.fromEntries(['market', 'pool', 'signature', 'slot', 'eventIndex',
      'timestampMs', 'receivedAtMs', 'chainTimestampMs', 'ammQuoteState',
      'poolBaseReservesRaw', 'poolQuoteReservesRaw', 'virtualQuoteReservesRaw',
      'prePoolBaseReservesRaw', 'prePoolQuoteReservesRaw', 'preReservePrice', 'ammQuoteStateReason',
      'price', 'reservePrice', 'side', 'wallet', 'solAmount', 'tokenAmount']
      .map(key => [key, trade[key] ?? null]));
    if (trade.ammExecutionFees && typeof trade.ammExecutionFees === 'object') {
      evidence.ammExecutionFees = Object.fromEntries(['quoteAmountRaw', 'poolQuoteAmountRaw',
        'userQuoteAmountRaw', 'lpFeeBasisPoints', 'lpFeeRaw', 'protocolFeeBasisPoints',
        'protocolFeeRaw', 'coinCreatorFeeBasisPoints', 'coinCreatorFeeRaw', 'cashbackFeeBasisPoints',
        'cashbackRaw', 'buybackFeeBasisPoints', 'buybackRaw', 'ixName'].flatMap(key => {
        const value = trade.ammExecutionFees[key];
        return value === null || (typeof value === 'number' && Number.isFinite(value))
          ? [[key, value]] : typeof value === 'string' ? [[key, value.slice(0, 160)]] : [];
      }));
    }
    return evidence;
  }

  _legacyGuard(cohort, trade, migrationAt, sourceAt = trade.receivedAtMs) {
    const requestedLifecycleAgeMs = trade.chainTimestampMs - migrationAt;
    const requestedLifecycleStage = requestedLifecycleAgeMs <= 10_000 ? 'AMM_EARLY' : 'AMM_MATURE';
    const enforcementMode = cohort.rugGuardMode === RUG_GUARD_ENFORCEMENT.HARD_BLOCK
      ? RUG_GUARD_ENFORCEMENT.HARD_BLOCK : RUG_GUARD_ENFORCEMENT.LABEL_ONLY;
    const hardBlockSignatures = hardBlockSignaturesForLifecycle({ market: 'PUMP_AMM',
      lifecycleStage: requestedLifecycleStage });
    let guard;
    try {
      guard = evaluateUniversalRugGuard(this.store, { strategyId: cohort.id,
        mint: trade.mint, timestampMs: sourceAt, source: 'SHADOW', market: 'PUMP_AMM',
        lifecycleStage: requestedLifecycleStage, lifecycleAgeMs: null, enforcementMode, hardBlockSignatures,
        policyReason: 'LEGACY_EARLY_FLOW_STAGE_SCOPED_REPEAT_ACTOR_ONLY' });
    } catch (_) { guard = { enabled: false, blocked: false, reason: 'RUG_GUARD_ERROR' }; }
    // The real tracker returns a decision without an `enabled` property;
    // explicit disabled/error replies do include false. Do not mistake every
    // ordinary real decision for an unavailable guard (the stub has enabled).
    const trackerAvailable = this.store?.preEntryRugRisk?.config?.enabled === true
      && typeof this.store.preEntryRugRisk.evaluateGuard === 'function';
    const unknown = !trackerAvailable || guard?.enabled === false || typeof guard?.blocked !== 'boolean';
    // Entry age uses confirmed migration; the existing RUG memory uses its
    // first observed AMM clock. Keep its actual stage/template association.
    // In particular evaluateGuard's top-level age may be caller metadata,
    // whereas firstCliffCounterfactual contains the observed lifecycle age.
    const evaluatedLifecycleStage = typeof guard?.lifecycleStage === 'string'
      && guard.lifecycleStage ? guard.lifecycleStage : null;
    const rawAge = guard?.firstCliffCounterfactual?.lifecycleAgeMs ?? guard?.lifecycleAgeMs;
    const evaluatedLifecycleAgeMs = rawAge == null || rawAge === '' ? null : finite(rawAge);
    const lifecycleStageMismatch = evaluatedLifecycleStage == null ? null
      : evaluatedLifecycleStage !== requestedLifecycleStage;
    const lifecycleClockMismatch = evaluatedLifecycleStage == null && evaluatedLifecycleAgeMs == null
      ? null : lifecycleStageMismatch === true
        || (evaluatedLifecycleAgeMs != null && evaluatedLifecycleAgeMs !== requestedLifecycleAgeMs);
    return { ...guard, enabled: !unknown, lifecycleStage: evaluatedLifecycleStage,
      lifecycleAgeMs: evaluatedLifecycleAgeMs,
      requestedLifecycleStage, requestedLifecycleAgeMs,
      evaluatedLifecycleStage, evaluatedLifecycleAgeMs, lifecycleStageMismatch, lifecycleClockMismatch,
      enforcementMode, hardBlockSignatures,
      blocked: enforcementMode === RUG_GUARD_ENFORCEMENT.HARD_BLOCK
        && (unknown || guard.blocked),
      ...(unknown ? { reason: 'PRE_ENTRY_RUG_GUARD_UNAVAILABLE', evidenceUnknown: true } : {}) };
  }

  _createLegacySignals(candidate) {
    const { trade, features, price } = candidate;
    const sourceAt = trade.receivedAtMs;
    if (this.legacyStudyConfigured && !this.legacyFiveArmReady) {
      this.legacyMetrics.invalidFiveArmConfigurations += 1;
      this._legacyReject('LEGACY_FIVE_ARM_CONFIGURATION_INVALID');
      this.legacyTracker.markSignaled(candidate);
      return;
    }
    const eligible = this.legacyFiveArmReady
      ? LEGACY_FIVE_ARM_COHORT_IDS.map(id => this.cohortById.get(id))
      : this.legacyCohorts.filter((cohort) => cohort.newEntriesEnabled !== false
        && matchesLegacyEntry(features, cohort.thresholds));
    if (!eligible.length) return;
    // One mint per immutable execution version, even if a later confirmed
    // migration timestamp replaces the explicit completion fallback.
    const episodeId = `${trade.mint}:${LEGACY_EXECUTION_VERSION}`;
    const rows = [];
    for (const cohort of eligible) {
      if (cohort.executionVersion !== LEGACY_EXECUTION_VERSION
        || cohort.strictExecution?.version !== strictAmm.VERSION
        || cohort.positionSizeSol !== 0.02 || !(cohort.hardStopPct > 0)
        || !(cohort.maxHoldMs > 0)) {
        this._legacyReject('LEGACY_PROFILE_INVALID');
        return;
      }
      const policy = strictAmm.freezePolicy(cohort, this.config, cohort);
      const studyDefinition = LEGACY_STUDY_ARMS[cohort.id] || null;
      const frozenCohort = { id: cohort.id, entryMode: LEGACY_ENTRY_MODE,
        executionVersion: LEGACY_EXECUTION_VERSION, positionSizeSol: cohort.positionSizeSol,
        maxEntryPriceJumpPct: cohort.maxEntryPriceJumpPct,
        maxNegativeEntryJumpPct: cohort.maxNegativeEntryJumpPct,
        maxEntryImpactPct: finite(cohort.maxEntryImpactPct, 15),
        hardStopPct: cohort.hardStopPct, trailingActivationPct: cohort.trailingActivationPct,
        trailingStopPct: cohort.trailingStopPct, maxHoldMs: cohort.maxHoldMs,
        rugGuardMode: cohort.rugGuardMode, liveBridgeEnabled: cohort.liveBridgeEnabled === true,
        liveStrategyId: cohort.liveStrategyId || null };
      const gate = this._legacyGuard(cohort, trade, features.migrationAt, sourceAt);
      const studyRejectionReason = studyDefinition
        && !matchesLegacyEntry(features, cohort.thresholds)
        ? studyDefinition.rejectionReason : null;
      const frozen = { executionVersion: LEGACY_EXECUTION_VERSION, entryMode: LEGACY_ENTRY_MODE,
        ...(this.legacyFiveArmReady ? { studyVersion: LEGACY_STUDY_VERSION,
          studyCohortIds: [...LEGACY_FIVE_ARM_COHORT_IDS] } : {}),
        sourceFeatures: features, sourceGuard: gate,
        ...(studyDefinition ? { studyThresholds: {
          ...LEGACY_DEFAULT_THRESHOLDS, ...(cohort.thresholds || {}),
        }, singleVariable: { ...studyDefinition.singleVariable } } : {}),
        studyFilter: studyDefinition ? {
          passed: studyRejectionReason == null,
          rejectionReason: studyRejectionReason,
        } : null,
        liveEligible: !gate.blocked && studyRejectionReason == null,
        strictExecution: { policy, pool: trade.pool,
          cursor: { ...strictAmm.observation(trade), seenEventKeys: [`${trade.signature}:${trade.eventIndex}`] },
          source: this._legacyTradeEvidence(trade), cohort: frozenCohort,
          costs: this.costsByCohort.get(cohort.id), tokenUnits: null } };
      rows.push({ cohort, gate, studyRejectionReason, record: { cohortId: cohort.id, episodeId,
        mint: trade.mint, symbol: trade.symbol || candidate.state.symbol,
        status: gate.blocked || studyRejectionReason ? STATUS.NO_ENTRY : STATUS.PENDING_ENTRY,
        rejectionReason: studyRejectionReason || (gate.blocked
          ? (String(gate.reason || '').startsWith('PRE_ENTRY_RUG_')
            ? gate.reason : `PRE_ENTRY_RUG_${gate.reason || 'BLOCKED'}`) : null),
        positionSol: cohort.positionSizeSol, configuredCostPct: frozen.strictExecution.costs.deterministicCostPct,
        migrationAt: features.migrationAt, signalAt: sourceAt, signalPrice: price,
        signalAgeMs: features.ageMs, features: frozen, rugGuard: gate,
        entryTargetAt: sourceAt + policy.entryDelayMs,
        entryDeadlineAt: sourceAt + policy.entryDelayMs + policy.entryTimeoutMs,
        hardStopPct: cohort.hardStopPct, maxHoldMs: cohort.maxHoldMs } });
    }
    let persisted;
    try {
      const expectedIds = new Set(rows.map(item => item.cohort.id));
      const insert = () => {
        const existing = typeof this.store.migrationSecondLegShadowPositionsByEpisode === 'function'
          ? this.store.migrationSecondLegShadowPositionsByEpisode(episodeId)
            .filter(row => expectedIds.has(row.cohort_id ?? row.cohortId)) : [];
        // Never backfill missing study arms onto a candidate already captured by
        // the historical two-arm build. Its later process-local feature window
        // is not the original BASE candidate and therefore is not comparable.
        if (existing.length) return { existing, savedRows: null };
        const savedRows = rows.map(item => ({ ...item,
          saved: this.store.createMigrationSecondLegShadowPosition(item.record) }));
        if (savedRows.some(item => item.saved?.inserted !== true)) {
          const error = new Error('Legacy episode appeared during atomic cohort insertion');
          error.code = 'LEGACY_EPISODE_PARTIAL_CONFLICT';
          throw error;
        }
        return { existing: [], savedRows };
      };
      // The paired source/study rows commit together. No HTTP/RPC or guard
      // scan occurs inside the transaction; a failed write cannot split them.
      persisted = this.store.db?.transaction ? this.store.db.transaction(insert)() : insert();
    } catch (error) {
      if (error?.code === 'LEGACY_EPISODE_PARTIAL_CONFLICT') {
        this.legacyMetrics.partialEpisodeConflicts += 1;
        this._legacyReject(error.code);
        this.legacyTracker.markSignaled(candidate);
        return;
      }
      this.legacyMetrics.persistenceErrors += 1;
      return;
    }
    if (persisted.existing.length) {
      const expectedIds = new Set(rows.map(item => item.cohort.id));
      const existingIds = new Set(persisted.existing.map(row => row.cohort_id ?? row.cohortId));
      const complete = expectedIds.size === existingIds.size
        && [...expectedIds].every(id => existingIds.has(id));
      this.metrics.deduplicated += persisted.existing.length;
      this.legacyMetrics.existingEpisodesSuppressed += 1;
      if (!complete) {
        this.legacyMetrics.incompleteHistoricalEpisodesSkipped += 1;
        this._legacyReject('LEGACY_EXISTING_EPISODE_INCOMPLETE');
      }
      this.legacyTracker.markSignaled(candidate);
      this.metrics.lastActionAt = this.now();
      return;
    }
    const savedRows = persisted.savedRows;
    this.legacyTracker.markSignaled(candidate);
    for (const { cohort, gate, studyRejectionReason, saved } of savedRows) {
      if (!saved?.inserted) { this.metrics.deduplicated += 1; continue; }
      this.metrics.matched += 1;
      this.legacyMetrics.signals += 1;
      if (studyRejectionReason) {
        this.metrics.noEntry += 1;
        this._legacyReject(studyRejectionReason);
        continue;
      }
      if (gate.blocked) {
        this.metrics.rugRejected += 1;
        this.legacyMetrics.rugRejected += 1;
        continue;
      }
      const pending = restore(saved);
      this.pendingEntries.set(pending.id, pending);
      this._index(pending);
      // Persisted inserted=true is the only bridge permission. Restoring an
      // existing row or replaying its source can never resubmit a live signal.
      if (cohort.id === LEGACY_RUGX_COHORT_ID && cohort.liveBridgeEnabled === true
        && cohort.liveStrategyId === 'legacy_early_flow_rugx_live'
        && typeof this.onLiveSignal === 'function') {
        const event = { ...this._legacyTradeEvidence(trade), mint: trade.mint,
          symbol: pending.symbol, timestampMs: sourceAt, price, reservePrice: price,
          strategyId: cohort.liveStrategyId, episodeId,
          features: { ...features, sourceCohortId: cohort.id, sourcePositionId: pending.id,
            sourceEpisodeId: episodeId, sourceSignalAt: sourceAt,
            sourceChainTimestampMs: trade.chainTimestampMs,
            calibrationVersion: LEGACY_EXECUTION_VERSION, shadowPositionSol: 0.02,
            sourceGuard: gate, sourceExecutionPolicy: pending.features.strictExecution.policy } };
        try {
          const result = this.onLiveSignal(event);
          this.legacyMetrics.liveBridgeEmitted += 1;
          if (result?.catch) result.catch(() => { this.legacyMetrics.liveBridgeErrors += 1; });
        } catch (_) { this.legacyMetrics.liveBridgeErrors += 1; }
      }
    }
    this.metrics.lastActionAt = this.now();
  }

  _legacyReject(reason) {
    this.legacyMetrics.strictRejectedByReason[reason] =
      (this.legacyMetrics.strictRejectedByReason[reason] || 0) + 1;
  }

  _withLegacyPersistence(position, operation, work) {
    if (!this._isLegacy(position)) return work();
    try { return work(); }
    catch (error) { this._queueLegacyPersistenceFailure(position, error, operation); }
  }

  _queueLegacyPersistenceFailure(position, error, operation) {
    if (this.legacyPersistenceFailures.has(position.id)) return;
    const at = this.now();
    const code = String(error?.code || error?.message || 'WRITE_FAILED');
    const errorClass = code.includes('SQLITE_BUSY') ? 'SQLITE_BUSY'
      : code.includes('SQLITE_LOCKED') ? 'SQLITE_LOCKED' : 'WRITE_FAILED';
    position.features = { ...position.features, persistenceFailure: {
      at, priorStatus: position.status, operation, errorClass,
      resultUnknown: true, excludedFromStrictPairs: true } };
    position.status = STATUS.DATA_ERROR;
    this.pendingEntries.delete(position.id);
    this.positions.delete(position.id);
    this.noExitWatches.delete(position.id);
    this._unindex(position);
    this.legacyPersistenceFailures.set(position.id, { position, nextAttemptAt: at });
    this.legacyMetrics.persistenceErrors += 1;
    this.legacyMetrics.persistenceFailedRows += 1;
    this.metrics.dataError += 1;
    this.metrics.lastError = `LEGACY_STATE_PERSISTENCE:${errorClass}`;
    // Do not retry the simulated fill against a later (more convenient) quote.
    // Only its explicit unknown outcome is retried; no live action is invoked.
    this._persistLegacyFailure(this.legacyPersistenceFailures.get(position.id), at);
  }

  _persistLegacyFailure(item, now) {
    try {
      this.store.updateMigrationSecondLegShadowPosition(item.position.id, {
        status: STATUS.DATA_ERROR, rejectionReason: 'SHADOW_STATE_PERSISTENCE_FAILED',
        features: item.position.features,
      });
      this.legacyPersistenceFailures.delete(item.position.id);
    } catch (_) {
      item.nextAttemptAt = now + 1_000;
      this.legacyMetrics.persistenceRetryErrors += 1;
    }
  }

  _retryLegacyPersistenceFailures(now, force = false) {
    let attempted = 0;
    for (const item of this.legacyPersistenceFailures.values()) {
      if (!force && now < item.nextAttemptAt) continue;
      if (attempted++ >= 16) break;
      this._persistLegacyFailure(item, now);
    }
  }

  _saveLegacy(position, patch = {}, force = false) {
    const now = this.now();
    if (!force && now - (position.strictSavedAt || 0) < 1_000) return;
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
      features: position.features,
      ...(position.entryAt ? { lastObservedAt: position.lastObservedAt, lastPrice: position.lastPrice,
        highestPrice: position.highestPrice, lowestPrice: position.lowestPrice,
        maxFavorableReturnPct: position.maxFavorableReturnPct,
        maxAdverseReturnPct: position.maxAdverseReturnPct } : {}), ...patch,
    });
    position.strictSavedAt = now;
  }

  _observeLegacyPosition(position, trade) {
    const state = position.features?.strictExecution;
    const price = postPoolPrice(trade);
    if (!state || !(price > 0)) { this._legacyReject('LEGACY_POST_POOL_UNAVAILABLE'); return; }
    const normalized = { ...trade, reservePrice: price };
    const reason = strictAmm.rejection(normalized, state, this.now(), {
      notBeforeChainTimestampMs: position.strictRestoredAt });
    if (reason) { this._legacyReject(reason); return; }
    strictAmm.accept(normalized, state, this.now());
    const at = trade.receivedAtMs;
    if (this.noExitWatches.has(position.id)) {
      if (at <= position.exitDeadlineAt
        || at > position.exitDeadlineAt + finite(this.config.noExitObservationMs, 600_000)) return;
      const execution = strictAmm.sell(normalized, state.tokenUnits, price);
      if (!execution.available) { this._saveLegacy(position); return; }
      state.lateExit = { ...this._legacyTradeEvidence(normalized), ...execution };
      this._saveLegacy(position, { lateExitStatus: 'OBSERVED_EXECUTABLE', lateExitAt: at,
        lateExitMarket: trade.market, lateExitMarkPrice: price, lateExitPrice: execution.price,
        lateExitImpactPct: execution.impactPct, lateExitDelayMs: at - position.exitTargetAt,
        lateExitAfterDeadlineMs: at - position.exitDeadlineAt,
        lateExitNetReturnPct: (execution.proceedsSol / position.positionSol - 1) * 100 - position.configuredCostPct }, true);
      this.noExitWatches.delete(position.id); this._unindex(position);
      this.metrics.lateExitObserved += 1;
      return;
    }
    if (position.status === STATUS.PENDING_ENTRY) {
      this._saveLegacy(position);
      if (!strictAmm.afterTarget(trade, position.entryTargetAt) || at > position.entryDeadlineAt) return;
      const guard = this._legacyGuard(state.cohort, trade, position.migrationAt);
      position.features.entryGuard = guard;
      if (guard.blocked) {
        this._saveLegacy(position, { status: STATUS.NO_ENTRY,
          rejectionReason: String(guard.reason || '').startsWith('PRE_ENTRY_RUG_')
            ? guard.reason : `PRE_ENTRY_RUG_${guard.reason || 'BLOCKED'}`, rugGuard: guard }, true);
        this.pendingEntries.delete(position.id); this._unindex(position);
        this.metrics.rugRejected += 1; this.legacyMetrics.rugRejected += 1;
        return;
      }
      const execution = strictAmm.buy(normalized, position.positionSol, price);
      if (!execution.available) { this._legacyReject(execution.reason || 'STRICT_BUY_UNAVAILABLE'); return; }
      if (!Number.isFinite(execution.impactPct)
        || execution.impactPct > state.cohort.maxEntryImpactPct) {
        position.features.entryRejectedExecution = { ...this._legacyTradeEvidence(normalized), ...execution };
        this._saveLegacy(position, { status: STATUS.NO_ENTRY,
          rejectionReason: 'ENTRY_SELF_IMPACT', entryImpactPct: execution.impactPct }, true);
        this.pendingEntries.delete(position.id); this._unindex(position);
        this.metrics.noEntry += 1;
        this._legacyReject('ENTRY_SELF_IMPACT');
        return;
      }
      const jump = (execution.price / position.signalPrice - 1) * 100;
      const maxUp = finite(state.cohort.maxEntryPriceJumpPct, 15);
      const maxDown = finite(state.cohort.maxNegativeEntryJumpPct, 50);
      if (jump > maxUp || jump < -maxDown) {
        this._saveLegacy(position, { status: STATUS.PRICE_JUMP,
          rejectionReason: `ENTRY_PRICE_JUMP_${jump.toFixed(2)}PCT`, entryJumpPct: jump }, true);
        this.pendingEntries.delete(position.id); this._unindex(position); this.metrics.priceJump += 1;
        return;
      }
      const next = { ...position, status: STATUS.OPEN, entryAt: at, entryPrice: execution.price,
        highestPrice: price, lowestPrice: price, lastPrice: price, lastObservedAt: at,
        maxFavorableReturnPct: 0, maxAdverseReturnPct: 0,
        features: { ...position.features, strictExecution: { ...state,
          tokenUnits: execution.tokenUnits,
          entry: { ...this._legacyTradeEvidence(normalized), ...execution } } } };
      this._saveLegacy(next, { status: STATUS.OPEN, entryAt: at, entryPrice: execution.price,
        entryImpactPct: execution.impactPct, entryJumpPct: jump, rugGuard: guard }, true);
      Object.assign(position, next);
      this.pendingEntries.delete(position.id); this.positions.set(position.id, position);
      this.metrics.opened += 1;
      return;
    }
    if (at < position.entryAt) return;
    const newPeak = price > position.highestPrice;
    position.highestPrice = Math.max(position.highestPrice, price);
    position.lowestPrice = Math.min(position.lowestPrice, price);
    position.lastPrice = price; position.lastObservedAt = at;
    position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct,
      (position.highestPrice / position.entryPrice - 1) * 100);
    position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct,
      (position.lowestPrice / position.entryPrice - 1) * 100);
    const execution = strictAmm.sell(normalized, state.tokenUnits, price);
    if (position.status === STATUS.OPEN) {
      const executableReturn = execution.available
        ? (execution.proceedsSol / position.positionSol - 1) * 100 : null;
      const markReturn = (price / position.entryPrice - 1) * 100;
      if (markReturn <= -position.hardStopPct
        || (executableReturn != null && executableReturn <= -position.hardStopPct)) {
        this._requestExit(position, at, 'HARD_STOP');
      } else if (position.maxFavorableReturnPct >= state.cohort.trailingActivationPct
        && (1 - price / position.highestPrice) * 100 >= state.cohort.trailingStopPct) {
        this._requestExit(position, at, 'TRAILING_STOP_A10_D5');
      } else if (at >= position.entryAt + position.maxHoldMs) {
        this._requestExit(position, position.entryAt + position.maxHoldMs, 'FIXED_HOLD');
      }
    }
    if (position.status === STATUS.EXIT_PENDING && strictAmm.afterTarget(trade, position.exitTargetAt)
      && at <= position.exitDeadlineAt && execution.available) {
      state.exit = { ...this._legacyTradeEvidence(normalized), ...execution };
      this._saveLegacy(position, { status: STATUS.CLOSED, exitAt: at, exitPrice: execution.price,
        exitImpactPct: execution.impactPct, grossReturnPct: (price / position.entryPrice - 1) * 100,
        netReturnPct: (execution.proceedsSol / position.positionSol - 1) * 100 - position.configuredCostPct }, true);
      this.positions.delete(position.id); this._unindex(position); this.metrics.closed += 1;
      return;
    }
    // The trailing watermark is exit-critical, not a heartbeat. Losing a new
    // peak in the throttle interval could disable a valid stop after restart.
    this._saveLegacy(position, {}, newPeak);
  }

  _observeLateExit(position, trade, price) {
    const noExitObservationMs = finite(this.config.noExitObservationMs, 10 * 60_000);
    if (trade.market !== 'PUMP_AMM'
      || trade.timestampMs <= position.exitDeadlineAt
      || trade.timestampMs > position.exitDeadlineAt + noExitObservationMs) return;
    if (position.entryPrice > 0 && this._priceScaleDiscontinuity(position, price)) return;
    const markReturnPct = ((price / position.entryPrice) - 1) * 100;
    const execution = executableSell(
      trade,
      position.positionSol / position.entryPrice,
      price,
      { rugMarkReturnPct: markReturnPct },
    );
    if (!execution.available) return;
    const lateExitPrice = execution.price;
    const executableReturnPct = ((lateExitPrice / position.entryPrice) - 1) * 100;
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
      lateExitStatus: 'OBSERVED_EXECUTABLE',
      lateExitAt: trade.timestampMs,
      lateExitMarket: trade.market,
      lateExitMarkPrice: price,
      lateExitPrice,
      lateExitImpactPct: execution.impactPct,
      lateExitDelayMs: Math.max(0, trade.timestampMs - position.exitTargetAt),
      lateExitAfterDeadlineMs: Math.max(0, trade.timestampMs - position.exitDeadlineAt),
      lateExitNetReturnPct: executableReturnPct - position.configuredCostPct,
    });
    this.noExitWatches.delete(position.id);
    this._unindex(position);
    this.metrics.lateExitObserved += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateMigrationSecondLegShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      exitReason: position.exitReason || 'NO_EXIT',
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
      lateExitStatus: 'PENDING',
    });
    this.positions.delete(position.id);
    this.noExitWatches.set(position.id, position);
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
    if (this._isLegacy(position)) return position.features.strictExecution.cohort;
    return this.cohortById.get(position.cohortId) || {
      ...this.config,
      id: position.cohortId,
    };
  }
}

module.exports = { MigrationSecondLegShadowSuite, MarketRegimeTracker, STATUS };
