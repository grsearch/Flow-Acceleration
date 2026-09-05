'use strict';

const { costBreakdown } = require('./CostModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');
const { hardBlockSignaturesForLifecycle } = require('./RugGuardPolicy');
const { executableSell } = require('./ShadowExecutionModel');
const LONG_EXIT_EXPERIMENT = 'HO500_LONG_EXIT_V1';
const MAX_LONG_EXIT_HOLD_MS = 60 * 60_000;
const LONG_EXIT_TRADE_MAX_AGE_MS = 3_000;
const LONG_EXIT_HEARTBEAT_MS = 1_000;
const LONG_EXIT_RESTORE_ROWS_PER_STATUS = 12_000;
const POST_EXECUTION_MODEL = 'POST_TRADE_V1';
const LEGACY_EXECUTION_MODEL = 'PRE_TRADE_LEGACY';
const POST_PENDING_SLOT_EVENT_LIMIT = 256;

function postTradePoint(trade, now) {
  const slot = finite(trade.slot);
  const chainTimestampMs = finite(trade.chainTimestampMs);
  const timestampMs = finite(trade.timestampMs);
  const receivedAtMs = finite(trade.receivedAtMs ?? trade.timestampMs);
  const pool = trade.pool || trade.poolAddress;
  const signature = typeof trade.signature === 'string' && trade.signature ? trade.signature : null;
  const eventIndex = trade.eventIndex == null ? null : finite(trade.eventIndex);
  if (trade.ammQuoteState !== POST_EXECUTION_MODEL || !pool || !(slot > 0)
    || !(chainTimestampMs > 0) || !(timestampMs > 0) || !(receivedAtMs > 0)
    || !signature || eventIndex == null || !Number.isInteger(eventIndex) || eventIndex < 0) return null;
  if (now - chainTimestampMs > LONG_EXIT_TRADE_MAX_AGE_MS || chainTimestampMs > now + 1_000
    || now - receivedAtMs > LONG_EXIT_TRADE_MAX_AGE_MS || receivedAtMs > now + 1_000
    || receivedAtMs - chainTimestampMs > LONG_EXIT_TRADE_MAX_AGE_MS) return null;
  return { pool, slot, chainTimestampMs, timestampMs, receivedAtMs, signature, eventIndex };
}

function postCursorEventKeys(cursor) {
  return cursor?.seenEventKeys || (cursor?.signature ? [`${cursor.signature}:${cursor.eventIndex}`] : []);
}

function canAdvancePostCursor(cursor, point) {
  if (!cursor) return true;
  if (point.slot < cursor.slot || point.chainTimestampMs < cursor.chainTimestampMs
    || point.timestampMs < cursor.timestampMs
    || point.receivedAtMs < (cursor.receivedAtMs || cursor.timestampMs)) return false;
  if (point.slot !== cursor.slot) return true;
  const keys = postCursorEventKeys(cursor);
  const prefix = `${point.signature}:`;
  // Event indices order events within one transaction. Across transactions in
  // the same slot only deduplication is provable from this stream's metadata.
  if (keys.some((key) => key.startsWith(prefix) && Number(key.slice(prefix.length)) >= point.eventIndex)) return false;
  return keys.length < POST_PENDING_SLOT_EVENT_LIMIT;
}

function advancePostCursor(cursor, point) {
  return { ...point, seenEventKeys: [
    ...(cursor?.slot === point.slot ? postCursorEventKeys(cursor) : []),
    `${point.signature}:${point.eventIndex}`,
  ] };
}

function decodedFeatures(row) {
  if (row?.features && typeof row.features === 'object') return row.features;
  try { return JSON.parse(row?.features_json || row?.featuresJson || '{}'); } catch (_) { return {}; }
}

const STATUS = Object.freeze({
  PENDING_ENTRY: 'PENDING_ENTRY',
  PRICE_JUMP: 'PRICE_JUMP',
  NO_ENTRY: 'NO_ENTRY',
  OPEN: 'OPEN',
  CORE_EXIT_PENDING: 'CORE_EXIT_PENDING',
  RUNNER: 'RUNNER',
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

function capacityId(positionSol) {
  return `${String(positionSol).replace('.', '_')}SOL`;
}

function beijingHour(timestampMs) {
  const value = finite(timestampMs);
  if (!(value > 0)) return null;
  return new Date(value + (8 * 60 * 60_000)).getUTCHours();
}

function matchesBeijingSession(profile, timestampMs) {
  const start = finite(profile?.sessionStartHourCst);
  const end = finite(profile?.sessionEndHourCst);
  if (start == null || end == null) return true;
  const hour = beijingHour(timestampMs);
  if (hour == null) return false;
  if (start === end) return true;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

function rowPosition(row) {
  const features = decodedFeatures(row);
  return {
    id: row.id,
    cohortId: valueOf(row, 'cohort_id', 'cohortId'),
    episodeId: valueOf(row, 'episode_id', 'episodeId'),
    entryProfileId: valueOf(row, 'entry_profile_id', 'entryProfileId'),
    mint: row.mint,
    symbol: row.symbol,
    creator: row.creator,
    status: row.status,
    positionSol: finite(valueOf(row, 'position_sol', 'positionSol'), 1),
    configuredCostPct: finite(valueOf(row, 'configured_cost_pct', 'configuredCostPct'), 0),
    signalAt: valueOf(row, 'signal_at', 'signalAt'),
    signalPrice: valueOf(row, 'signal_price', 'signalPrice'),
    signalCurvePct: valueOf(row, 'signal_curve_pct', 'signalCurvePct'),
    entryTargetAt: valueOf(row, 'entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: valueOf(row, 'entry_deadline_at', 'entryDeadlineAt'),
    entryAt: valueOf(row, 'entry_at', 'entryAt'),
    entryMarket: valueOf(row, 'entry_market', 'entryMarket'),
    entryPrice: valueOf(row, 'entry_price', 'entryPrice'),
    entryJumpPct: valueOf(row, 'entry_jump_pct', 'entryJumpPct'),
    entryImpactPct: valueOf(row, 'entry_impact_pct', 'entryImpactPct'),
    tokenUnits: valueOf(row, 'token_units', 'tokenUnits'),
    highestPrice: valueOf(row, 'highest_price', 'highestPrice'),
    lowestPrice: valueOf(row, 'lowest_price', 'lowestPrice'),
    lastObservedAt: valueOf(row, 'last_observed_at', 'lastObservedAt'),
    lastPrice: valueOf(row, 'last_price', 'lastPrice'),
    lastExtremaPersistedAt: valueOf(row, 'last_observed_at', 'lastObservedAt'),
    maxFavorableReturnPct: finite(valueOf(row, 'max_favorable_return_pct', 'maxFavorableReturnPct'), 0),
    maxAdverseReturnPct: finite(valueOf(row, 'max_adverse_return_pct', 'maxAdverseReturnPct'), 0),
    graduatedAt: valueOf(row, 'graduated_at', 'graduatedAt'),
    coreWeightPct: finite(valueOf(row, 'core_weight_pct', 'coreWeightPct'), 50),
    coreExitAt: valueOf(row, 'core_exit_at', 'coreExitAt'),
    coreExitPrice: valueOf(row, 'core_exit_price', 'coreExitPrice'),
    runnerHighestPrice: valueOf(row, 'runner_highest_price', 'runnerHighestPrice'),
    runnerTierIndex: finite(valueOf(row, 'runner_tier_index', 'runnerTierIndex'), -1),
    runnerStopPrice: valueOf(row, 'runner_stop_price', 'runnerStopPrice'),
    exitTargetMarket: valueOf(row, 'exit_target_market', 'exitTargetMarket'),
    exitTriggerAt: valueOf(row, 'exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: valueOf(row, 'exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: valueOf(row, 'exit_deadline_at', 'exitDeadlineAt'),
    exitReason: valueOf(row, 'exit_reason', 'exitReason'),
    features,
    lastAcceptedSlot: features.longExitTradeCursor?.slot,
    lastAcceptedChainTimestampMs: features.longExitTradeCursor?.chainTimestampMs,
    lastAcceptedTradeAt: features.longExitTradeCursor?.timestampMs,
  };
}

function curveBuyAveragePrice(trade, positionSol, fallbackPrice) {
  try {
    const x = BigInt(trade.virtualSolReservesRaw || 0);
    const y = BigInt(trade.virtualTokenReservesRaw || 0);
    const input = BigInt(Math.max(1, Math.round(positionSol * 1e9)));
    if (x <= 0n || y <= 0n) return fallbackPrice;
    const tokensOutRaw = y - ((x * y) / (x + input));
    const tokenUnits = Number(tokensOutRaw) / 1e6;
    if (!(tokenUnits > 0)) return fallbackPrice;
    return positionSol / tokenUnits;
  } catch (_) {
    return fallbackPrice;
  }
}

function hasCurveReserves(trade) {
  try {
    return BigInt(trade?.virtualSolReservesRaw || 0) > 0n
      && BigInt(trade?.virtualTokenReservesRaw || 0) > 0n;
  } catch (_) {
    return false;
  }
}

function ammBuyAveragePrice(trade, positionSol, fallbackPrice) {
  try {
    if (trade.ammQuoteState != null && trade.ammQuoteState !== POST_EXECUTION_MODEL) {
      return { price: null, impactPct: null, available: false };
    }
    const base = BigInt(trade.poolBaseReservesRaw || 0);
    const quote = BigInt(trade.poolQuoteReservesRaw || 0)
      + BigInt(trade.virtualQuoteReservesRaw || 0);
    const input = BigInt(Math.max(1, Math.round(positionSol * 1e9)));
    if (base <= 0n || quote <= 0n) {
      return { price: fallbackPrice, impactPct: null, available: false };
    }
    const tokensOutRaw = (base * input) / (quote + input);
    const tokenUnits = Number(tokensOutRaw) / 1e6;
    const spotPrice = (Number(quote) / 1e9) / (Number(base) / 1e6);
    if (!(tokenUnits > 0) || !(spotPrice > 0)) {
      return { price: fallbackPrice, impactPct: null, available: false };
    }
    const price = positionSol / tokenUnits;
    return { price, impactPct: ((price / spotPrice) - 1) * 100, available: true };
  } catch (_) {
    return { price: fallbackPrice, impactPct: null, available: false };
  }
}

function emptyProfileDiagnostics() {
  return {
    evaluated: 0,
    signals: 0,
    persistenceArmed: 0,
    persistenceBaseRejected: 0,
    persistenceConfirmationRejected: 0,
    lastEvaluatedAt: null,
    lastArmedAt: null,
    lastSignalAt: null,
    lastReason: null,
  };
}

class GraduationAccelerationShadowSuite {
  constructor({ config, store, now = () => Date.now(), onLiveSignal = null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.onLiveSignal = typeof onLiveSignal === 'function' ? onLiveSignal : null;
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.capacitySols = [...new Set((config.capacitySols || [0.05, 0.5, 1])
      .map(Number).filter((value) => Number.isFinite(value) && value > 0))];
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.noExitWatches = new Map();
    this.longExitObservations = new Map();
    this.rowsByMint = new Map();
    this.graduatedMints = new Set();
    this.postMigrationTrades = new Map();
    this.postMigrationTradeCursors = new Map();
    this.postEvidenceStartedAt = null;
    this.profileDiagnostics = new Map([...this.entryProfiles.keys()]
      .map((profileId) => [profileId, emptyProfileDiagnostics()]));
    this.metrics = {
      evaluated: 0,
      signals: 0,
      deduplicated: 0,
      replayEvaluationsSuppressed: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      graduated: 0,
      coreExits: 0,
      postMigrationGatePassed: 0,
      postMigrationGateFailed: 0,
      migrationHandoffPassed: 0,
      migrationHandoffRejected: 0,
      liveMigrationFailuresObserved: 0,
      liveMigrationHandoffRows: 0,
      relaxedJumpBandPassed: 0,
      relaxedJumpBandRejected: 0,
      runnerExits: 0,
      closed: 0,
      noExit: 0,
      noExitWatchRecovered: 0,
      lateExitObserved: 0,
      lateExitObservationExpired: 0,
      rugGuardEvaluated: 0,
      rugGuardSampleInsufficient: 0,
      rugGuardRiskFlagged: 0,
      rugGuardHardBlocked: 0,
      rugGuardSignatureHits: {},
      persistenceArmed: 0,
      persistenceRejected: 0,
      lastActionAt: null,
      lastError: null,
      pairedLongEntries: 0,
      longExitObservationEvictions: 0,
      longExitRestoreRowsRead: 0,
      longExitRestoreTruncatedStatuses: 0,
      longExitTradeRejections: {},
    };
  }

  start() {
    if (!this.config.enabled) return;
    const startupAt = this.now();
    this.postEvidenceStartedAt = startupAt;
    for (const row of this.store.activeGraduationAccelerationShadowPositions()) {
      const position = rowPosition(row);
      if (position.status === STATUS.PENDING_ENTRY && this._retiredEntryProfile(position)) {
        this.store.updateGraduationAccelerationShadowPosition(position.id, {
          status: STATUS.NO_ENTRY, rejectionReason: 'LEGACY_QUOTE_MODEL_RETIRED',
          features: { ...position.features, executionModelVersion: LEGACY_EXECUTION_MODEL },
        });
        continue;
      }
      if (position.features?.experimentGroup === LONG_EXIT_EXPERIMENT || this._isPostPosition(position)) {
        position.notBeforeChainTimestampMs = startupAt;
      }
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      if (position.graduatedAt) this.graduatedMints.add(position.mint);
      this._index(position);
      this._restorePostEntryCursor(position.mint, position.features?.postEntryTradeCursor);
    }
    this._restoreLongExitObservations(startupAt);
    const noExitObservationMs = finite(this.config.noExitObservationMs, 10 * 60_000);
    for (const row of this.store.recoverableGraduationAccelerationNoExitPositions()) {
      const position = rowPosition(row);
      if (position.features?.experimentGroup === LONG_EXIT_EXPERIMENT || this._isPostPosition(position)) {
        position.notBeforeChainTimestampMs = startupAt;
      }
      if (!(position.exitDeadlineAt > 0)
        || startupAt > position.exitDeadlineAt + noExitObservationMs) {
        this.store.updateGraduationAccelerationShadowPosition(position.id, {
          lateExitStatus: 'EXPIRED_NO_EXECUTABLE_TRADE',
        });
        this.metrics.lateExitObservationExpired += 1;
        continue;
      }
      this.noExitWatches.set(position.id, position);
      this._index(position);
      this.metrics.noExitWatchRecovered += 1;
    }
    const postMigrationSince = startupAt - Math.max(this.config.maxPostGraduationHoldMs, 30_000);
    for (const trade of this.store.recentAmmTrades(postMigrationSince)) {
      this._recordPostMigrationTrade(trade, { replay: true });
    }
    const since = startupAt - Math.max(this.config.maxPreGraduationHoldMs, 30_000);
    for (const trade of this.store.recentCurveTrades(since)) this._recordState(trade);
    for (const state of this.states.values()) {
      for (const profile of this.entryProfiles.values()) {
        if (profile.mode === 'FIXED_10S'
          && startupAt >= state.createdAt + profile.horizonMs) {
          state.fixedEvaluated = true;
          this.metrics.replayEvaluationsSuppressed += 1;
        } else if (['CURVE_MILESTONE', 'CURVE_MILESTONE_PERSISTENCE'].includes(profile.mode)
          && state.events.some((row) => row.curvePct >= profile.thresholdPct)) {
          state.crossed.add(profile.id);
          this.metrics.replayEvaluationsSuppressed += 1;
        }
      }
    }
    this.advanceTime(startupAt);
  }

  stop() {
    for (const position of [...this.positions.values(), ...this.noExitWatches.values()]) {
      if (position.features?.experimentGroup === LONG_EXIT_EXPERIMENT || this._isPostPosition(position)) {
        this.store.updateGraduationAccelerationShadowPosition(position.id, this._longExitSnapshot(position));
      }
    }
  }

  _profileDiagnostics(profileId) {
    if (!this.profileDiagnostics.has(profileId)) {
      this.profileDiagnostics.set(profileId, emptyProfileDiagnostics());
    }
    return this.profileDiagnostics.get(profileId);
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_O',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      lateExitPending: this.noExitWatches.size,
      trackedMints: this.trackedMints().length,
      longExitObservations: this.longExitObservations.size,
      entryProfiles: [...this.entryProfiles.values()],
      profileDiagnostics: [...this.entryProfiles.keys()].map((profileId) => ({
        profileId,
        ...this._profileDiagnostics(profileId),
      })),
      capacitySols: this.capacitySols,
      strategy: {
        name: 'Graduation Acceleration O',
        entryDelayMs: this.config.entryDelayMs,
        entryTimeoutMs: this.config.entryTimeoutMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        coreExitPct: this.config.coreExitPct,
        maxPreGraduationHoldMs: this.config.maxPreGraduationHoldMs,
        maxPostGraduationHoldMs: this.config.maxPostGraduationHoldMs,
        trailingTiers: this.config.trailingTiers,
        research: {
          isolatedTable: 'graduation_acceleration_shadow_positions',
          capacityAwareBondingCurveEntry: true,
          relaxedEntryShadowOnly: true,
          relaxedEntryCapacitySols: [...new Set([...this.entryProfiles.values()]
            .flatMap((profile) => profile.capacitySols || []))],
          noExitPricedAsLoss: false,
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  trackedMints(now = this.now()) {
    for (const [mint, until] of this.longExitObservations) {
      if (now > until) this.longExitObservations.delete(mint);
    }
    return [...new Set([
      ...[...this.pendingEntries.values(), ...this.positions.values()].map((row) => row.mint),
      ...this.longExitObservations.keys(),
    ])];
  }

  _positionProfile(position) {
    // Persist the paired exit policy with its entry so disabling new cohorts or
    // changing future defaults cannot change an already-open experiment.
    if (position.features?.experimentGroup === LONG_EXIT_EXPERIMENT
      && position.features.exitPolicy) return position.features.exitPolicy;
    if (position.features?.delayedEntryPolicy) return position.features.delayedEntryPolicy;
    return this.entryProfiles.get(position.entryProfileId);
  }

  _isPostPosition(position) {
    return position?.features?.executionModelVersion === POST_EXECUTION_MODEL
      || this.entryProfiles.get(position?.entryProfileId)?.executionModelVersion === POST_EXECUTION_MODEL;
  }

  _retiredEntryProfile(position) {
    const profile = this.entryProfiles.get(position.entryProfileId);
    return profile?.migrationHandoff && profile.newEntriesEnabled === false
      && profile.executionModelVersion === LEGACY_EXECUTION_MODEL;
  }

  _tradeForPosition(position, trade) {
    if (trade.market !== 'PUMP_AMM') return trade;
    if (trade.ammQuoteState != null && trade.ammQuoteState !== POST_EXECUTION_MODEL) return null;
    if (this._isPostPosition(position)) {
      return trade.ammQuoteState === POST_EXECUTION_MODEL ? trade : null;
    }
    const profile = this._positionProfile(position);
    if (!profile?.migrationHandoff || trade.ammQuoteState !== POST_EXECUTION_MODEL) return trade;
    // Existing handoff positions retain the historical pre-trade mark/exit
    // convention. This local view never escapes into the live signal bridge.
    if (trade.prePoolBaseReservesRaw == null || trade.prePoolQuoteReservesRaw == null) return null;
    const legacy = { ...trade,
      poolBaseReservesRaw: trade.prePoolBaseReservesRaw,
      poolQuoteReservesRaw: trade.prePoolQuoteReservesRaw,
      reservePrice: trade.preReservePrice,
      ammQuoteState: null,
      legacyQuoteView: true,
    };
    if (!(legacy.reservePrice > 0)) {
      try {
        legacy.reservePrice = (Number(BigInt(legacy.poolQuoteReservesRaw)
          + BigInt(legacy.virtualQuoteReservesRaw || 0)) / 1e9)
          / (Number(BigInt(legacy.poolBaseReservesRaw)) / 1e6);
      } catch (_) { return null; }
    }
    return legacy.reservePrice > 0 ? legacy : null;
  }

  _freshPostEntryTrade(position, trade, qualification = null) {
    const point = postTradePoint(trade, this.now());
    if (!point || point.chainTimestampMs < (position.notBeforeChainTimestampMs || 0)) return false;
    const cursor = position.features?.postEntryTradeCursor;
    const fixedPool = qualification?.pool || position.features?.pendingEntryPool || cursor?.pool;
    if (fixedPool && point.pool !== fixedPool) return false;
    if (qualification && (point.slot <= qualification.slot
      || point.chainTimestampMs < qualification.chainTimestampMs)) return false;
    return canAdvancePostCursor(cursor, point);
  }

  _acceptPostPendingTrade(position, trade) {
    if (!this._freshPostEntryTrade(position, trade, position.features?.qualification)) return false;
    const point = postTradePoint(trade, this.now());
    const features = { ...position.features,
      pendingEntryPool: position.features?.qualification?.pool || position.features?.pendingEntryPool || point.pool,
      postEntryTradeCursor: advancePostCursor(position.features?.postEntryTradeCursor, point),
    };
    // Pending windows are short. Persist every accepted cursor before applying
    // the time gate so a crash cannot resurrect a lower slot or duplicate event.
    this.store.updateGraduationAccelerationShadowPosition(position.id, { features });
    position.features = features;
    return true;
  }

  _restorePostEntryCursor(mint, cursor) {
    if (!cursor || !(cursor.slot > 0)) return;
    const current = this.postMigrationTradeCursors.get(mint);
    if (!current || cursor.slot > current.slot) {
      this.postMigrationTradeCursors.set(mint, cursor);
      return;
    }
    if (cursor.slot !== current.slot) return;
    const latest = cursor.timestampMs > current.timestampMs ? cursor : current;
    this.postMigrationTradeCursors.set(mint, { ...latest,
      chainTimestampMs: Math.max(cursor.chainTimestampMs, current.chainTimestampMs),
      receivedAtMs: Math.max(cursor.receivedAtMs || cursor.timestampMs, current.receivedAtMs || current.timestampMs),
      seenEventKeys: [...new Set([...postCursorEventKeys(current), ...postCursorEventKeys(cursor)])]
        .slice(0, POST_PENDING_SLOT_EVENT_LIMIT),
    });
  }

  _longExitObservationGraceMs() {
    return Math.min(5 * 60_000, Math.max(0, finite(this.config.longExitObservationGraceMs, 5 * 60_000)));
  }

  _retainLongExitObservation(position) {
    if (position.features?.experimentGroup !== LONG_EXIT_EXPERIMENT) return;
    const until = finite(position.features.longExitObservationUntil);
    if (!(until > this.now())) return;
    this.longExitObservations.set(position.mint,
      Math.max(this.longExitObservations.get(position.mint) || 0, until));
    const limit = Math.max(1, Math.trunc(finite(this.config.longExitObservationMaxMints, 2_000)));
    while (this.longExitObservations.size > limit) {
      let earliest;
      for (const entry of this.longExitObservations) {
        if (!earliest || entry[1] < earliest[1]) earliest = entry;
      }
      this.longExitObservations.delete(earliest[0]);
      this.metrics.longExitObservationEvictions += 1;
    }
  }

  _restoreLongExitObservations(now) {
    for (const position of this.positions.values()) this._retainLongExitObservation(position);
    // Bound the raw indexed reads, not just grouped output. Busy windows may
    // truncate optional closed-row observation (reported in health); active
    // positions are restored separately and never lose their subscriptions.
    const since = now - MAX_LONG_EXIT_HOLD_MS - 5 * 60_000;
    const recent = this.store.db.prepare(`
      SELECT mint, entry_at, features_json
      FROM graduation_acceleration_shadow_positions INDEXED BY idx_graduation_accel_status
      WHERE status = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?
    `);
    for (const status of [STATUS.CLOSED, STATUS.NO_EXIT]) {
      const rows = recent.all(status, since, LONG_EXIT_RESTORE_ROWS_PER_STATUS + 1);
      this.metrics.longExitRestoreRowsRead += rows.length;
      if (rows.length > LONG_EXIT_RESTORE_ROWS_PER_STATUS) this.metrics.longExitRestoreTruncatedStatuses += 1;
      for (const row of rows.slice(0, LONG_EXIT_RESTORE_ROWS_PER_STATUS)) {
        if (row.entry_at >= since) this._retainLongExitObservation({
          mint: row.mint, features: decodedFeatures(row),
        });
      }
    }
  }

  _acceptLongExitTrade(position, trade) {
    if (position.features?.experimentGroup !== LONG_EXIT_EXPERIMENT && !this._isPostPosition(position)) return true;
    const features = position.features;
    const pool = trade.pool || trade.poolAddress;
    const slot = finite(trade.slot);
    const chainAt = finite(trade.chainTimestampMs);
    const timestampMs = finite(trade.timestampMs);
    const entrySlot = finite(features.entrySlot);
    const entryChainAt = finite(features.entryChainTimestampMs);
    const maxAgeMs = finite(this._positionProfile(position)?.maxPositionTradeAgeMs,
      LONG_EXIT_TRADE_MAX_AGE_MS);
    let rejection = null;
    if (trade.market !== 'PUMP_AMM') rejection = 'MARKET_MISMATCH';
    else if (!features.entryPool || !pool) rejection = 'POOL_MISSING';
    else if (String(pool) !== String(features.entryPool)) rejection = 'POOL_MISMATCH';
    else if (!(slot > 0) || !(entrySlot > 0)) rejection = 'SLOT_MISSING';
    else if (!(chainAt > 0) || !(entryChainAt > 0)) rejection = 'CHAIN_TIME_MISSING';
    else if (this.now() - chainAt > maxAgeMs || chainAt > this.now() + 1_000) rejection = 'STALE_CHAIN_TIME';
    else if (chainAt < (position.notBeforeChainTimestampMs || 0)) rejection = 'BEFORE_RESTART_CHAIN_TIME';
    else if (slot <= entrySlot) rejection = 'PRE_ENTRY_SLOT';
    else if (slot < (position.lastAcceptedSlot || entrySlot)) rejection = 'OUT_OF_ORDER_SLOT';
    else if (chainAt < (position.lastAcceptedChainTimestampMs || entryChainAt)) rejection = 'OUT_OF_ORDER_CHAIN_TIME';
    else if (timestampMs < (position.lastAcceptedTradeAt || position.lastObservedAt || position.entryAt)) rejection = 'OUT_OF_ORDER_RECEIVE_TIME';
    if (rejection) {
      this.metrics.longExitTradeRejections[rejection] = (this.metrics.longExitTradeRejections[rejection] || 0) + 1;
      return false;
    }
    position.lastAcceptedSlot = slot;
    position.lastAcceptedChainTimestampMs = chainAt;
    position.lastAcceptedTradeAt = timestampMs;
    return true;
  }

  onCreate(token) {
    if (!this.config.enabled || !token?.mint) return;
    this.states.set(token.mint, {
      mint: token.mint,
      symbol: token.symbol || null,
      creator: token.creator || null,
      createdAt: finite(token.createdAt ?? token.created_at),
      events: [],
      firstCurvePct: null,
      fixedEvaluated: false,
      crossed: new Set(),
      triggered: new Set(),
      confirmations: new Map(),
      creatorSold: false,
      lastAt: finite(token.createdAt ?? token.created_at),
    });
  }

  onGraduated(tokenOrEvent) {
    if (!this.config.enabled || !tokenOrEvent?.mint) return;
    const firstGraduationEvent = !this.graduatedMints.has(tokenOrEvent.mint);
    this.graduatedMints.add(tokenOrEvent.mint);
    const graduatedAt = finite(
      tokenOrEvent.graduated_at ?? tokenOrEvent.migrated_at
      ?? tokenOrEvent.completedAt ?? tokenOrEvent.migratedAt
      ?? tokenOrEvent.timestampMs,
      this.now(),
    );
    if (firstGraduationEvent) this.metrics.graduated += 1;
    for (const id of [...(this.rowsByMint.get(tokenOrEvent.mint) || [])]) {
      const pending = this.pendingEntries.get(id);
      if (pending) {
        const profile = this.entryProfiles.get(pending.entryProfileId);
        if (profile?.pairedSignalProfileId || pending.features?.pairedSignalProfileId) continue;
        if (profile?.migrationHandoff) {
          const windowMs = finite(profile.postMigrationEntryGate?.windowMs, 5_000);
          const handoffDelayMs = finite(profile.postMigrationEntryGate?.entryDelayMs, windowMs);
          const entryTimeoutMs = finite(profile.entryTimeoutMs, this.config.entryTimeoutMs);
          pending.graduatedAt = pending.graduatedAt > 0
            ? Math.min(pending.graduatedAt, graduatedAt) : graduatedAt;
          pending.entryTargetAt = pending.graduatedAt + handoffDelayMs;
          pending.entryDeadlineAt = pending.entryTargetAt + entryTimeoutMs;
          this.store.updateGraduationAccelerationShadowPosition(id, {
            graduatedAt: pending.graduatedAt,
            entryTargetAt: pending.entryTargetAt,
            entryDeadlineAt: pending.entryDeadlineAt,
          });
          continue;
        }
        this.store.updateGraduationAccelerationShadowPosition(id, {
          status: STATUS.NO_ENTRY,
          rejectionReason: 'MIGRATED_BEFORE_SIMULATED_ENTRY',
          graduatedAt,
        });
        this.pendingEntries.delete(id);
        this._unindex(pending);
        this.metrics.noEntry += 1;
        continue;
      }
      const position = this.positions.get(id);
      if (!position) continue;
      position.graduatedAt = Math.max(finite(position.graduatedAt, 0), graduatedAt);
      if (position.status === STATUS.EXIT_PENDING) {
        position.exitTargetMarket = 'PUMP_AMM';
        position.exitTargetAt = graduatedAt + this.config.exitDelayMs;
        position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
        position.exitReason = `${position.exitReason || 'EXIT'}_MIGRATION_REROUTE`;
        this.store.updateGraduationAccelerationShadowPosition(id, {
          graduatedAt: position.graduatedAt,
          exitTargetMarket: position.exitTargetMarket,
          exitTargetAt: position.exitTargetAt,
          exitDeadlineAt: position.exitDeadlineAt,
          exitReason: position.exitReason,
        });
      } else if (position.status === STATUS.CORE_EXIT_PENDING) {
        position.exitTargetAt = Math.min(
          position.exitTargetAt || Infinity,
          graduatedAt + this.config.exitDelayMs,
        );
        position.exitDeadlineAt = Math.max(
          position.exitDeadlineAt || 0,
          graduatedAt + this.config.maxPostGraduationHoldMs,
        );
        this.store.updateGraduationAccelerationShadowPosition(id, {
          graduatedAt: position.graduatedAt,
          exitTargetAt: position.exitTargetAt,
          exitDeadlineAt: position.exitDeadlineAt,
        });
      } else if (position.status === STATUS.OPEN) {
        position.status = STATUS.CORE_EXIT_PENDING;
        position.exitTargetMarket = 'PUMP_AMM';
        position.exitTargetAt = graduatedAt + this.config.exitDelayMs;
        position.exitDeadlineAt = graduatedAt + this.config.maxPostGraduationHoldMs;
        position.exitReason = 'GRADUATION_CORE_50';
        this.store.updateGraduationAccelerationShadowPosition(id, {
          status: position.status,
          graduatedAt: position.graduatedAt,
          exitTargetMarket: position.exitTargetMarket,
          exitTriggerAt: graduatedAt,
          exitTargetAt: position.exitTargetAt,
          exitDeadlineAt: position.exitDeadlineAt,
          exitReason: position.exitReason,
        });
      } else if (position.status === STATUS.RUNNER) {
        this.store.updateGraduationAccelerationShadowPosition(id, {
          graduatedAt: position.graduatedAt,
        });
      }
    }
  }

  observeTrade(trade) {
    const timestampMs = finite(trade?.timestampMs);
    const price = shadowPrice(trade);
    if (!this.config.enabled || !trade?.mint || !(timestampMs > 0) || !(price > 0)) return;
    const postEvidence = trade.market === 'PUMP_AMM' ? this._recordPostMigrationTrade(trade) : null;
    this.advanceTime(timestampMs);
    this._observePositions(trade, price, postEvidence);
    if (trade.market !== 'PUMP_BONDING_CURVE') return;
    const state = this._recordState(trade);
    if (!state) return;
    this._evaluateEntries(state, trade, price);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      const profile = this.entryProfiles.get(pending.entryProfileId);
      this.store.updateGraduationAccelerationShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: pending.features?.pairedSignalProfileId
          ? 'NO_POST_TRADE_IN_DELAYED_ENTRY_WINDOW' : profile?.migrationHandoff
          ? 'NO_PUMPSWAP_TRADE_IN_HANDOFF_WINDOW'
          : profile?.entryPriceJumpBand
            ? 'NO_CURVE_TRADE_FOR_JUMP_BAND'
            : 'NO_CURVE_TRADE_IN_ENTRY_WINDOW',
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if ([STATUS.CORE_EXIT_PENDING, STATUS.EXIT_PENDING].includes(position.status)) {
        if (now > position.exitDeadlineAt) this._markNoExit(position, 'NO_EXECUTABLE_EXIT_TRADE');
        continue;
      }
      if (position.status === STATUS.OPEN
        && now >= position.entryAt + this.config.maxPreGraduationHoldMs) {
        this._requestExit(position, position.entryAt + this.config.maxPreGraduationHoldMs,
          'MAX_PRE_GRAD_HOLD', 'PUMP_BONDING_CURVE');
      } else if (position.status === STATUS.RUNNER) {
        const profile = this._positionProfile(position);
        const gate = this._postMigrationGateDecision(position, now);
        if (gate && !gate.passed) {
          this._requestExit(position, gate.evaluatedAt, 'POST_MIGRATION_GATE_FAIL', 'PUMP_AMM');
          this.metrics.postMigrationGateFailed += 1;
          continue;
        }
        if (gate?.passed && !gate.counted) {
          gate.counted = true;
          this.metrics.postMigrationGatePassed += 1;
        }
        const maxHoldMs = profile?.runnerMaxHoldMs ?? this.config.maxPostGraduationHoldMs;
        const runnerStartedAt = profile?.migrationHandoff
          ? position.entryAt
          : position.graduatedAt;
        if (now >= runnerStartedAt + maxHoldMs) {
          this._requestExit(position,
            runnerStartedAt + maxHoldMs,
            'MAX_POST_GRAD_RUNNER', 'PUMP_AMM');
        }
      }
    }
    const noExitObservationMs = finite(this.config.noExitObservationMs, 10 * 60_000);
    for (const position of [...this.noExitWatches.values()]) {
      if (now <= position.exitDeadlineAt + noExitObservationMs) continue;
      this.store.updateGraduationAccelerationShadowPosition(position.id, {
        lateExitStatus: 'EXPIRED_NO_EXECUTABLE_TRADE',
      });
      this.noExitWatches.delete(position.id);
      this._unindex(position);
      this.metrics.lateExitObservationExpired += 1;
    }
    for (const [mint, state] of this.states) {
      if (now - finite(state.lastAt, now) > this.config.maxPreGraduationHoldMs + 60_000) {
        this.states.delete(mint);
      }
    }
  }

  _stateFor(trade) {
    let state = this.states.get(trade.mint);
    if (state) return state;
    const token = this.store.getToken(trade.mint);
    const createdAt = finite(token?.created_at, timestampFromAge(trade));
    if (!(createdAt > 0)) return null;
    state = {
      mint: trade.mint,
      symbol: token?.symbol || trade.symbol || null,
      creator: token?.creator || null,
      createdAt,
      events: [],
      firstCurvePct: null,
      fixedEvaluated: false,
      crossed: new Set(),
      triggered: new Set(),
      confirmations: new Map(),
      creatorSold: false,
      lastAt: trade.timestampMs,
    };
    this.states.set(trade.mint, state);
    return state;
  }

  _recordState(trade) {
    const state = this._stateFor(trade);
    if (!state) return null;
    const timestampMs = Number(trade.timestampMs);
    const curvePct = finite(trade.curvePct);
    if (state.firstCurvePct == null && curvePct != null) state.firstCurvePct = curvePct;
    if (trade.side === 'SELL' && trade.wallet && trade.wallet === state.creator) {
      state.creatorSold = true;
    }
    state.events.push({
      timestampMs,
      side: trade.side,
      solAmount: finite(trade.solAmount, 0),
      wallet: trade.wallet || null,
      curvePct,
      price: shadowPrice(trade),
    });
    state.lastAt = timestampMs;
    const cutoff = timestampMs - Math.max(this.config.maxPreGraduationHoldMs, 30_000);
    while (state.events.length && state.events[0].timestampMs < cutoff) state.events.shift();
    return state;
  }

  _evaluateEntries(state, trade, price) {
    const ageMs = trade.timestampMs - state.createdAt;
    if (ageMs < 0) return;
    for (const profile of this.entryProfiles.values()) {
      if (profile.newEntriesEnabled === false || profile.pairedEntryProfileId || profile.pairedSignalProfileId) continue;
      if (state.triggered.has(profile.id)) continue;
      // These cohorts are seeded only by a real live pre-submit migration
      // rejection. They must not create ordinary Curve-triggered entries.
      if (profile.mode === 'LIVE_MIGRATION_FAILURE') continue;
      if (profile.mode === 'CURVE_MILESTONE_PERSISTENCE') {
        this._evaluatePersistenceEntry(state, profile, trade, price);
        continue;
      }
      let matched = false;
      let features = null;
      const sessionAllowed = matchesBeijingSession(profile, trade.timestampMs);
      if (profile.mode === 'FIXED_10S') {
        if (ageMs < profile.horizonMs || state.fixedEvaluated) continue;
        state.fixedEvaluated = true;
        const rows = state.events.filter((row) => row.timestampMs <= state.createdAt + profile.horizonMs);
        features = this._features(rows);
        const ratio = features.buySol > 0 ? features.sellSol / features.buySol : null;
        matched = features.curvePct >= profile.minCurvePct
          && features.buyers >= profile.minBuyers
          && ratio != null && ratio <= profile.maxSellBuyRatio
          && sessionAllowed;
        features.sellBuyRatio = ratio;
      } else if (profile.mode === 'CURVE_MILESTONE') {
        if (finite(trade.curvePct, -Infinity) < profile.thresholdPct
          || state.crossed.has(profile.id)) continue;
        state.crossed.add(profile.id);
        const rows = state.events.filter((row) => (
          row.timestampMs >= trade.timestampMs - profile.recentWindowMs
        ));
        features = this._features(rows);
        matched = features.curveDeltaPct >= profile.minCurveDeltaPct
          && features.buyers >= profile.minBuyers
          && features.netFlowSol >= finite(profile.minNetFlowSol, -Infinity)
          && features.sellTx <= profile.maxSellTx
          && (!profile.requireNoCreatorSell || !state.creatorSold)
          && sessionAllowed;
      }
      if (features) {
        features.signalCstHour = beijingHour(trade.timestampMs);
        features.sessionAllowed = sessionAllowed;
      }
      this.metrics.evaluated += 1;
      if (!matched) continue;
      state.triggered.add(profile.id);
      this.metrics.signals += 1;
      this._createPendingRows(state, profile, trade, price, features);
    }
  }

  _evaluatePersistenceEntry(state, profile, trade, price) {
    const diagnostics = this._profileDiagnostics(profile.id);
    let confirmation = state.confirmations.get(profile.id);
    if (!confirmation) {
      if (state.crossed.has(profile.id)
        || finite(trade.curvePct, -Infinity) < profile.thresholdPct) return;
      state.crossed.add(profile.id);
      const rows = state.events.filter((row) => (
        row.timestampMs >= trade.timestampMs - profile.recentWindowMs
      ));
      const features = this._features(rows);
      const baseMatched = features.curveDeltaPct >= profile.minCurveDeltaPct
        && features.buyers >= profile.minBuyers
        && features.sellTx <= profile.maxSellTx
        && (!profile.requireNoCreatorSell || !state.creatorSold);
      this.metrics.evaluated += 1;
      diagnostics.evaluated += 1;
      diagnostics.lastEvaluatedAt = trade.timestampMs;
      if (!baseMatched) {
        this.metrics.persistenceRejected += 1;
        diagnostics.persistenceBaseRejected += 1;
        diagnostics.lastReason = 'PERSISTENCE_BASE_REJECTED';
        return;
      }
      confirmation = {
        armedAt: trade.timestampMs,
        deadlineAt: trade.timestampMs + profile.persistenceMs,
        price,
        buyers: features.buyers,
      };
      state.confirmations.set(profile.id, confirmation);
      this.metrics.persistenceArmed += 1;
      diagnostics.persistenceArmed += 1;
      diagnostics.lastArmedAt = trade.timestampMs;
      diagnostics.lastReason = 'PERSISTENCE_ARMED';
      return;
    }
    if (trade.timestampMs < confirmation.deadlineAt) return;
    state.confirmations.delete(profile.id);
    const rows = state.events.filter((row) => (
      row.timestampMs >= confirmation.armedAt && row.timestampMs <= trade.timestampMs
    ));
    const features = this._features(rows);
    const pullbackPct = confirmation.price > 0
      ? Math.max(0, ((confirmation.price - price) / confirmation.price) * 100) : Infinity;
    features.persistenceMs = trade.timestampMs - confirmation.armedAt;
    features.persistenceBuyers = features.buyers;
    features.persistencePullbackPct = pullbackPct;
    const matched = finite(trade.curvePct, -Infinity) >= profile.thresholdPct
      && features.buyers >= confirmation.buyers
      && features.sellTx <= profile.maxPersistenceSellTx
      && pullbackPct <= profile.maxPersistencePullbackPct
      && (!profile.requireNoCreatorSell || !state.creatorSold);
    this.metrics.evaluated += 1;
    diagnostics.evaluated += 1;
    diagnostics.lastEvaluatedAt = trade.timestampMs;
    if (!matched) {
      this.metrics.persistenceRejected += 1;
      diagnostics.persistenceConfirmationRejected += 1;
      diagnostics.lastReason = 'PERSISTENCE_CONFIRMATION_REJECTED';
      return;
    }
    state.triggered.add(profile.id);
    this.metrics.signals += 1;
    diagnostics.signals += 1;
    diagnostics.lastSignalAt = trade.timestampMs;
    diagnostics.lastReason = 'EMITTED';
    this._createPendingRows(state, profile, trade, price, features);
  }

  _features(rows) {
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const curves = rows.map((row) => row.curvePct).filter((value) => value != null);
    return {
      buySol: buys.reduce((sum, row) => sum + row.solAmount, 0),
      sellSol: sells.reduce((sum, row) => sum + row.solAmount, 0),
      netFlowSol: buys.reduce((sum, row) => sum + row.solAmount, 0)
        - sells.reduce((sum, row) => sum + row.solAmount, 0),
      buyers: new Set(buys.map((row) => row.wallet).filter(Boolean)).size,
      buyTx: buys.length,
      sellTx: sells.length,
      curvePct: curves.at(-1) ?? null,
      curveDeltaPct: curves.length >= 2 ? curves.at(-1) - curves[0] : 0,
    };
  }

  _createPendingRows(state, profile, trade, price, features) {
    if (profile.newEntriesEnabled === false || profile.pairedEntryProfileId || profile.pairedSignalProfileId) return;
    features = { ...features, executionModelVersion: profile.executionModelVersion || null,
      shadowExecutionDelayMs: finite(profile.shadowExecutionDelayMs, 0),
      feeModel: 'FLAT_ESTIMATE', feeModelIncludes: 'EXISTING_CONFIGURED_COSTS',
    };
    const episodeId = `${state.mint}:${profile.id}:${trade.timestampMs}`;
    if (this.onLiveSignal && profile.liveStrategyId) {
      try {
        this.onLiveSignal({
          strategyId: profile.liveStrategyId,
          episodeId,
          mint: state.mint,
          symbol: state.symbol,
          price,
          slot: trade.slot,
          timestampMs: trade.timestampMs,
          receivedAtMs: trade.receivedAtMs || trade.timestampMs,
          market: 'PUMP_BONDING_CURVE',
          virtualSolReservesRaw: trade.virtualSolReservesRaw || null,
          virtualTokenReservesRaw: trade.virtualTokenReservesRaw || null,
          features: {
            ...features,
            creator: state.creator,
            creatorSold: state.creatorSold,
            signalCurvePct: finite(trade.curvePct),
            recentWindowMs: profile.recentWindowMs,
          },
        });
      } catch (error) {
        this.metrics.lastError = String(error?.message || error).slice(0, 1_000);
      }
    }
    const profileCapacitySols = [...new Set((profile.capacitySols || this.capacitySols)
      .map(Number).filter((value) => Number.isFinite(value) && value > 0))];
    const entryDelayMs = finite(profile.entryDelayMs, this.config.entryDelayMs);
    const entryTimeoutMs = finite(profile.entryTimeoutMs, this.config.entryTimeoutMs);
    for (const positionSol of profileCapacitySols) {
      const costs = costBreakdown({ ...this.config.costModel, positionSizeSol: positionSol });
      const cohortId = `${profile.id}:${capacityId(positionSol)}`;
      const handoffWindowMs = profile.migrationHandoff
        ? finite(profile.postMigrationEntryGate?.windowMs, 5_000) : 0;
      const handoffDelayMs = profile.migrationHandoff
        ? finite(profile.postMigrationEntryGate?.entryDelayMs, handoffWindowMs) : 0;
      const initialDeadlineAt = profile.migrationHandoff
        ? trade.timestampMs + this.config.maxPreGraduationHoldMs
          + handoffDelayMs + entryTimeoutMs
        : trade.timestampMs + entryDelayMs + entryTimeoutMs;
      const saved = this.store.createGraduationAccelerationShadowPosition({
        cohortId,
        episodeId,
        entryProfileId: profile.id,
        mint: state.mint,
        symbol: state.symbol,
        creator: state.creator,
        status: STATUS.PENDING_ENTRY,
        positionSol,
        configuredCostPct: costs.deterministicCostPct,
        signalAt: trade.timestampMs,
        signalPrice: price,
        signalCurvePct: finite(trade.curvePct),
        features,
        entryTargetAt: trade.timestampMs + entryDelayMs,
        entryDeadlineAt: initialDeadlineAt,
        coreWeightPct: profile.coreExitPct ?? this.config.coreExitPct,
      });
      if (!saved?.inserted) {
        this.metrics.deduplicated += 1;
        continue;
      }
      const position = rowPosition(saved);
      this.pendingEntries.set(position.id, position);
      this._index(position);
    }
    this.metrics.lastActionAt = this.now();
  }

  _observePositions(incomingTrade, incomingPrice, postEvidence = null) {
    for (const id of [...(this.rowsByMint.get(incomingTrade.mint) || [])]) {
      const row = this.noExitWatches.get(id) || this.pendingEntries.get(id) || this.positions.get(id);
      if (!row) continue;
      const trade = this._tradeForPosition(row, incomingTrade);
      if (!trade) continue;
      const price = trade === incomingTrade ? incomingPrice : shadowPrice(trade);
      const noExitWatch = this.noExitWatches.get(id);
      if (noExitWatch) {
        if (this._acceptLongExitTrade(noExitWatch, trade)) this._observeLateExit(noExitWatch, trade, price);
        continue;
      }
      const pending = this.pendingEntries.get(id);
      if (pending) {
        const profile = this._positionProfile(pending);
        if (this._isPostPosition(pending)) {
          if (!postEvidence?.validPostEvidence || trade.market !== 'PUMP_AMM'
            || !(pending.graduatedAt > 0) || trade.timestampMs < pending.graduatedAt
            || trade.timestampMs > pending.entryDeadlineAt
            || !this._acceptPostPendingTrade(pending, trade)) continue;
        }
        if (profile?.pairedSignalProfileId || pending.features?.pairedSignalProfileId) {
          this._observeDelayedHandoffEntry(pending, profile, trade, price);
          continue;
        }
        if (profile?.migrationHandoff) {
          this._observeMigrationHandoffEntry(pending, profile, trade, price);
          continue;
        }
        if (trade.market !== 'PUMP_BONDING_CURVE'
          || trade.timestampMs < pending.entryTargetAt
          || trade.timestampMs > pending.entryDeadlineAt) continue;
        const selectiveRugPair = profile?.rugGuardMode === 'LIVE_CURVE_CATASTROPHE';
        const rugGuard = evaluateUniversalRugGuard(this.store, {
          strategyId: `GRADUATION_ACCEL:${pending.cohortId}`,
          mint: pending.mint,
          timestampMs: trade.timestampMs,
          source: 'SHADOW',
          market: 'PUMP_BONDING_CURVE',
          lifecycleStage: 'CURVE_MIGRATION',
          ...(selectiveRugPair ? {
            enforcementMode: 'HARD_BLOCK',
            hardBlockSignatures: hardBlockSignaturesForLifecycle({
              market: 'PUMP_BONDING_CURVE', lifecycleStage: 'CURVE_MIGRATION',
            }),
            policyReason: 'SHADOW_LIVE_CURVE_CATASTROPHE_PAIRED',
          } : {}),
        });
        this._recordRugGuard(rugGuard);
        if (rugGuard.blocked) {
          this.store.updateGraduationAccelerationShadowPosition(id, {
            status: STATUS.NO_ENTRY,
            rejectionReason: rugGuard.reason || 'PRE_ENTRY_RUG_RISK',
            rugGuard,
          });
          this.pendingEntries.delete(id);
          this._unindex(pending);
          this.metrics.noEntry += 1;
          continue;
        }
        const fillPrice = curveBuyAveragePrice(trade, pending.positionSol, price);
        const jumpPct = ((fillPrice / pending.signalPrice) - 1) * 100;
        const jumpBand = profile?.entryPriceJumpBand;
        if (jumpBand && !hasCurveReserves(trade)) {
          this.store.updateGraduationAccelerationShadowPosition(id, {
            status: STATUS.NO_ENTRY,
            rejectionReason: 'ENTRY_JUMP_RESERVES_UNAVAILABLE',
          });
          this.pendingEntries.delete(id);
          this._unindex(pending);
          this.metrics.noEntry += 1;
          this.metrics.relaxedJumpBandRejected += 1;
          continue;
        }
        this.store.updateGraduationAccelerationShadowPosition(id, { rugGuard });
        const maxEntryPriceJumpPct = jumpBand
          ? finite(jumpBand.maxPct, this.config.maxEntryPriceJumpPct)
          : finite(profile?.maxEntryPriceJumpPct, this.config.maxEntryPriceJumpPct);
        if (jumpBand && jumpPct < finite(jumpBand.minPct, 0)) {
          this.store.updateGraduationAccelerationShadowPosition(id, {
            status: STATUS.NO_ENTRY,
            rejectionReason: `ENTRY_JUMP_BELOW_BAND_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
            entryImpactPct: ((fillPrice / price) - 1) * 100,
          });
          this.pendingEntries.delete(id);
          this._unindex(pending);
          this.metrics.noEntry += 1;
          this.metrics.relaxedJumpBandRejected += 1;
          continue;
        }
        if (jumpPct > maxEntryPriceJumpPct) {
          this.store.updateGraduationAccelerationShadowPosition(id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: jumpBand
              ? `ENTRY_JUMP_ABOVE_BAND_${jumpPct.toFixed(2)}PCT`
              : `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
            entryImpactPct: ((fillPrice / price) - 1) * 100,
          });
          this.pendingEntries.delete(id);
          this._unindex(pending);
          this.metrics.priceJump += 1;
          if (jumpBand) this.metrics.relaxedJumpBandRejected += 1;
          continue;
        }
        if (jumpBand) {
          const confirmation = this._postSignalJumpConfirmation(pending, jumpBand, trade);
          if (!confirmation.passed) {
            this.store.updateGraduationAccelerationShadowPosition(id, {
              status: STATUS.NO_ENTRY,
              rejectionReason: `ENTRY_JUMP_CONFIRM_FAIL_${confirmation.reason}`,
              entryJumpPct: jumpPct,
              entryImpactPct: ((fillPrice / price) - 1) * 100,
            });
            this.pendingEntries.delete(id);
            this._unindex(pending);
            this.metrics.noEntry += 1;
            this.metrics.relaxedJumpBandRejected += 1;
            continue;
          }
          this.metrics.relaxedJumpBandPassed += 1;
        }
        pending.status = STATUS.OPEN;
        pending.entryAt = trade.timestampMs;
        pending.entryMarket = trade.market;
        pending.entryPrice = fillPrice;
        pending.entryJumpPct = jumpPct;
        pending.entryImpactPct = ((fillPrice / price) - 1) * 100;
        pending.tokenUnits = pending.positionSol / fillPrice;
        pending.highestPrice = price;
        pending.lowestPrice = price;
        this.store.updateGraduationAccelerationShadowPosition(id, {
          status: STATUS.OPEN,
          entryAt: pending.entryAt,
          entryMarket: pending.entryMarket,
          entryPrice: pending.entryPrice,
          entryJumpPct: pending.entryJumpPct,
          entryImpactPct: pending.entryImpactPct,
          tokenUnits: pending.tokenUnits,
          highestPrice: price,
          lowestPrice: price,
          maxFavorableReturnPct: 0,
          maxAdverseReturnPct: 0,
        });
        this.pendingEntries.delete(id);
        this.positions.set(id, pending);
        this.metrics.opened += 1;
        continue;
      }
      const position = this.positions.get(id);
      if (!position) continue;
      if (!this._acceptLongExitTrade(position, trade)) continue;
      if (position.status === STATUS.CORE_EXIT_PENDING) {
        if (trade.market === 'PUMP_AMM' && trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._takeCore(position, trade, price);
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        if (trade.market === position.exitTargetMarket
          && trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
        continue;
      }
      if (![STATUS.OPEN, STATUS.RUNNER].includes(position.status)) continue;
      if (position.status === STATUS.OPEN && trade.market !== 'PUMP_BONDING_CURVE') continue;
      if (position.status === STATUS.RUNNER && trade.market !== 'PUMP_AMM') continue;
      this._updateExtrema(position, trade.timestampMs, price);
      const gross = ((price / position.entryPrice) - 1) * 100;
      const profile = this._positionProfile(position);
      const hardStopPct = finite(profile?.hardStopPct, this.config.hardStopPct);
      if (hardStopPct > 0 && gross <= -hardStopPct) {
        this._requestExit(position, trade.timestampMs, 'HARD_STOP', trade.market);
        continue;
      }
      if (position.status === STATUS.RUNNER) this._observeRunner(position, trade, price, gross);
    }
  }

  _takeCore(position, trade, price) {
    this._updateExtrema(position, trade.timestampMs, price);
    const profile = this.entryProfiles.get(position.entryProfileId);
    const coreWeight = position.coreWeightPct / 100;
    let corePrice = price;
    if (coreWeight > 0 && profile?.capacityAwareExit) {
      const markReturnPct = ((price / position.entryPrice) - 1) * 100;
      const execution = executableSell(
        trade,
        position.tokenUnits * coreWeight,
        price,
        { rugMarkReturnPct: markReturnPct },
      );
      if (!execution.available && !execution.conservative) return;
      corePrice = execution.price ?? price;
    }
    position.coreExitAt = trade.timestampMs;
    position.coreExitPrice = coreWeight > 0 ? corePrice : null;
    position.status = STATUS.RUNNER;
    position.runnerHighestPrice = price;
    position.runnerTierIndex = -1;
    position.runnerStopPrice = null;
    position.exitTargetAt = null;
    position.exitDeadlineAt = null;
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      status: STATUS.RUNNER,
      coreExitAt: position.coreExitAt,
      coreExitPrice: position.coreExitPrice,
      runnerHighestPrice: price,
      runnerTierIndex: -1,
      clearExitPending: true,
    });
    this.metrics.coreExits += 1;
  }

  _observeRunner(position, trade, price, gross) {
    const profile = this._positionProfile(position);
    const gate = this._postMigrationGateDecision(position, trade.timestampMs);
    if (profile?.postMigrationGate && !gate) return;
    if (gate && !gate.passed) {
      this._requestExit(position, gate.evaluatedAt, 'POST_MIGRATION_GATE_FAIL', 'PUMP_AMM');
      this.metrics.postMigrationGateFailed += 1;
      return;
    }
    if (gate?.passed && !gate.counted) {
      gate.counted = true;
      this.metrics.postMigrationGatePassed += 1;
    }
    const maxHoldMs = profile?.runnerMaxHoldMs ?? this.config.maxPostGraduationHoldMs;
    if (profile?.runnerExitMode === 'FIXED_HOLD') {
      const runnerStartedAt = profile?.migrationHandoff
        ? position.entryAt
        : position.graduatedAt;
      if (trade.timestampMs >= runnerStartedAt + maxHoldMs) {
        this._requestExit(position, runnerStartedAt + maxHoldMs,
          `RUNNER_FIXED_${maxHoldMs / 1_000}S`, 'PUMP_AMM');
      }
      return;
    }
    const previousHighest = position.runnerHighestPrice;
    position.runnerHighestPrice = Math.max(position.runnerHighestPrice || price, price);
    if (profile?.runnerExitMode === 'TRAILING') {
      const peakPct = ((position.runnerHighestPrice / position.entryPrice) - 1) * 100;
      const activationPct = finite(profile.trailingActivationPct, 0);
      const drawdownPct = finite(profile.trailingStopPct, 0);
      const previousTier = position.runnerTierIndex;
      const previousStop = position.runnerStopPrice;
      const armed = drawdownPct > 0 && peakPct >= activationPct;
      if (!armed && profile.experimentGroup !== LONG_EXIT_EXPERIMENT) return;
      if (armed) {
        position.runnerTierIndex = 0;
        position.runnerStopPrice = position.runnerHighestPrice * (1 - drawdownPct / 100);
      }
      if (profile.experimentGroup !== LONG_EXIT_EXPERIMENT
        || position.runnerHighestPrice !== previousHighest
        || position.runnerTierIndex !== previousTier || position.runnerStopPrice !== previousStop) {
        this.store.updateGraduationAccelerationShadowPosition(position.id, {
          ...this._longExitSnapshot(position),
          runnerHighestPrice: position.runnerHighestPrice,
          runnerTierIndex: position.runnerTierIndex,
          runnerStopPrice: position.runnerStopPrice,
        });
      }
      if (armed && price <= position.runnerStopPrice) {
        this._requestExit(position, trade.timestampMs,
          `RUNNER_TRAILING_A${activationPct}_D${drawdownPct}`, 'PUMP_AMM');
      }
      return;
    }
    let tierIndex = -1;
    for (let index = 0; index < this.config.trailingTiers.length; index += 1) {
      if (gross >= this.config.trailingTiers[index].activationPct) tierIndex = index;
    }
    if (tierIndex >= 0) position.runnerTierIndex = Math.max(position.runnerTierIndex, tierIndex);
    if (position.runnerTierIndex < 0) return;
    const activeTier = this.config.trailingTiers[position.runnerTierIndex];
    position.runnerStopPrice = position.runnerHighestPrice * (1 - activeTier.drawdownPct / 100);
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      runnerHighestPrice: position.runnerHighestPrice,
      runnerTierIndex: position.runnerTierIndex,
      runnerStopPrice: position.runnerStopPrice,
    });
    if (price <= position.runnerStopPrice) {
      this._requestExit(position, trade.timestampMs,
        `RUNNER_STAIR_T${activeTier.activationPct}_D${activeTier.drawdownPct}`, 'PUMP_AMM');
    }
  }

  _recordPostMigrationTrade(trade, { replay = false } = {}) {
    if (trade?.market !== 'PUMP_AMM' || !trade.mint) return;
    const timestampMs = finite(trade.timestampMs);
    if (!(timestampMs > 0)) return;
    const positions = [...(this.rowsByMint.get(trade.mint) || [])]
      .map((id) => this.positions.get(id) || this.pendingEntries.get(id))
      .filter(Boolean);
    const gated = positions.filter((position) => (
      (this._positionProfile(position)?.postMigrationGate
        || this._positionProfile(position)?.postMigrationEntryGate)
      && position.graduatedAt > 0
    ));
    if (!gated.length) return;
    const point = replay ? null : postTradePoint(trade, this.now());
    const latest = this.postMigrationTradeCursors.get(trade.mint);
    const poolAllowed = point && gated.some((position) => {
      if (!this._isPostPosition(position)) return false;
      const features = position.features || {};
      const fixedPool = features.qualification?.pool || features.pendingEntryPool || features.entryPool;
      return !fixedPool || fixedPool === point.pool;
    });
    const validPostEvidence = Boolean(point
      && poolAllowed
      && point.chainTimestampMs >= (this.postEvidenceStartedAt || 0)
      && canAdvancePostCursor(latest, point));
    if (validPostEvidence) this.postMigrationTradeCursors.set(trade.mint, advancePostCursor(latest, point));
    const evidence = { validPostEvidence };
    const graduatedAt = Math.min(...gated.map((position) => position.graduatedAt));
    const maxWindowMs = Math.max(...gated.map((position) => (
      (() => {
        const gate = this._positionProfile(position).postMigrationGate
          || this._positionProfile(position).postMigrationEntryGate;
        return finite(gate.captureWindowMs, gate.windowMs);
      })()
    )));
    if (timestampMs < graduatedAt || timestampMs > graduatedAt + maxWindowMs) return evidence;
    const rows = this.postMigrationTrades.get(trade.mint) || [];
    rows.push({
      timestampMs,
      receivedAtMs: finite(trade.receivedAtMs ?? trade.timestampMs),
      chainTimestampMs: finite(trade.chainTimestampMs),
      slot: finite(trade.slot),
      signature: trade.signature || null,
      eventIndex: trade.eventIndex ?? null,
      validPostEvidence,
      replay,
      pool: trade.pool || null,
      side: trade.side,
      wallet: trade.wallet || null,
      solAmount: finite(trade.solAmount, 0),
      price: shadowPrice(trade),
      poolBaseReservesRaw: trade.poolBaseReservesRaw || null,
      poolQuoteReservesRaw: trade.poolQuoteReservesRaw || null,
      virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw || null,
      ammQuoteState: trade.ammQuoteState || null,
    });
    rows.sort((left, right) => left.timestampMs - right.timestampMs);
    this.postMigrationTrades.set(trade.mint, rows);
    return evidence;
  }

  _observeMigrationHandoffEntry(pending, profile, trade, price) {
    if (trade.market !== 'PUMP_AMM' || !(pending.graduatedAt > 0)
      || trade.timestampMs < pending.entryTargetAt
      || trade.timestampMs > pending.entryDeadlineAt) return;
    const gate = this._postMigrationEntryGateDecision(pending, profile, trade.timestampMs, trade.pool);
    if (!gate) return;
    if (profile.postMigrationEntryGate?.waitForQualification
      && gate.retryable
      && trade.timestampMs < pending.entryDeadlineAt) return;
    if (!gate.passed) {
      this.store.updateGraduationAccelerationShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: `POST_MIGRATION_ENTRY_GATE_FAIL_${gate.reason}`,
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
      this.metrics.migrationHandoffRejected += 1;
      return;
    }
    const selectiveRugPair = profile?.rugGuardMode === 'HIGH_CONFIDENCE_CATASTROPHE';
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: `GRADUATION_ACCEL:${pending.cohortId}`,
      mint: pending.mint,
      timestampMs: trade.timestampMs,
      source: 'SHADOW',
      market: 'PUMP_AMM',
      lifecycleStage: 'AMM_EARLY',
      lifecycleAgeMs: trade.timestampMs - pending.graduatedAt,
      enforcementMode: selectiveRugPair ? 'HARD_BLOCK' : 'LABEL_ONLY',
      ...(selectiveRugPair ? {
        hardBlockSignatures: hardBlockSignaturesForLifecycle({
          market: 'PUMP_AMM', lifecycleStage: 'AMM_EARLY',
        }),
        policyReason: 'SHADOW_POST_GRAD_CATASTROPHE_PAIRED',
      } : {
        policyReason: 'SHADOW_POST_GRAD_BASELINE_LABEL_ONLY',
      }),
    });
    this._recordRugGuard(rugGuard);
    if (rugGuard.blocked) {
      this.store.updateGraduationAccelerationShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: rugGuard.reason || 'PRE_ENTRY_RUG_RISK',
        rugGuard,
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
      this.metrics.migrationHandoffRejected += 1;
      return;
    }
    this.store.updateGraduationAccelerationShadowPosition(pending.id, { rugGuard });
    this._fillMigrationHandoffEntry(pending, profile, trade, price, gate, rugGuard);
  }

  _observeDelayedHandoffEntry(pending, profile, trade, price) {
    const qualification = pending.features?.qualification;
    if (!qualification || trade.market !== 'PUMP_AMM'
      || trade.timestampMs < pending.entryTargetAt || trade.timestampMs > pending.entryDeadlineAt) return;
    // Eligibility belongs to the source signal. Only execution price/impact is
    // evaluated after the delay; a later sell must not rewrite that eligibility.
    this._fillMigrationHandoffEntry(pending, profile, trade, price, qualification.gate,
      pending.features.qualificationRugGuard || null);
  }

  _fillMigrationHandoffEntry(pending, profile, trade, price, gate, rugGuard) {
    const execution = ammBuyAveragePrice(trade, pending.positionSol, price);
    if (!execution.available) {
      this.store.updateGraduationAccelerationShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'HANDOFF_RESERVES_UNAVAILABLE',
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
      this.metrics.migrationHandoffRejected += 1;
      return;
    }
    const fillPrice = execution.price;
    const referencePrice = gate.firstPrice || price;
    const marketMovePct = ((price / referencePrice) - 1) * 100;
    const maxMarketMovePct = finite(profile.postMigrationEntryGate?.maxMarketMovePct, 15);
    const maxSelfImpactPct = finite(profile.postMigrationEntryGate?.maxSelfImpactPct, 10);
    if (marketMovePct > maxMarketMovePct
      || (execution.impactPct != null && execution.impactPct > maxSelfImpactPct)) {
      this.store.updateGraduationAccelerationShadowPosition(pending.id, {
        status: STATUS.PRICE_JUMP,
        rejectionReason: marketMovePct > maxMarketMovePct
          ? `HANDOFF_MARKET_MOVE_${marketMovePct.toFixed(2)}PCT`
          : `HANDOFF_SELF_IMPACT_${execution.impactPct.toFixed(2)}PCT`,
        entryJumpPct: marketMovePct,
        entryImpactPct: execution.impactPct,
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.priceJump += 1;
      this.metrics.migrationHandoffRejected += 1;
      return;
    }
    const fill = {
      status: STATUS.RUNNER,
      entryAt: trade.timestampMs,
      entryMarket: trade.market,
      entryPrice: fillPrice,
      entryJumpPct: marketMovePct,
      entryImpactPct: execution.impactPct,
      tokenUnits: pending.positionSol / fillPrice,
      highestPrice: price,
      lowestPrice: price,
      coreWeightPct: 0,
      runnerHighestPrice: price,
      runnerTierIndex: -1,
      maxFavorableReturnPct: 0,
      maxAdverseReturnPct: 0,
    };
    if (this._isPostPosition(pending)) {
      const qualification = pending.features?.qualification || {
        at: trade.timestampMs,
        pool: trade.pool || trade.poolAddress || null,
        slot: finite(trade.slot),
        signature: trade.signature || null,
        eventIndex: trade.eventIndex ?? null,
        chainTimestampMs: finite(trade.chainTimestampMs),
        gate: { ...gate },
      };
      fill.features = {
        ...pending.features,
        executionModelVersion: POST_EXECUTION_MODEL,
        reserveState: trade.ammQuoteState,
        feeModel: 'FLAT_ESTIMATE', feeModelIncludes: 'EXISTING_CONFIGURED_COSTS',
        executionFeesAppliedSeparately: false,
        qualification,
        qualifiedAt: qualification.at,
        entryPool: trade.pool || trade.poolAddress || null,
        entrySlot: finite(trade.slot),
        entrySignature: trade.signature || null,
        entryEventIndex: trade.eventIndex ?? null,
        entryChainTimestampMs: finite(trade.chainTimestampMs),
        entryGate: { ...gate },
        actualExecutionDelayMs: trade.timestampMs - qualification.at,
      };
    }
    const pairedProfiles = [...this.entryProfiles.values()].filter((candidate) => (
      candidate.experimentGroup === LONG_EXIT_EXPERIMENT
      && candidate.newEntriesEnabled !== false
      && candidate.pairedEntryProfileId === profile.id
      && (candidate.capacitySols || []).includes(pending.positionSol)
    ));
    let paired = [];
    let delayed = [];
    if (pairedProfiles.length || this._isPostPosition(pending)) {
      this.store.db.transaction(() => {
        this.store.updateGraduationAccelerationShadowPosition(pending.id, fill);
        const source = { ...pending, ...fill };
        paired = this._clonePairedEntries(source, pairedProfiles, trade, gate, rugGuard);
        delayed = this._createDelayedHandoffEntries(source, profile, rugGuard);
      })();
    } else this.store.updateGraduationAccelerationShadowPosition(pending.id, fill);
    Object.assign(pending, fill);
    for (const position of paired) {
      this.positions.set(position.id, position);
      this._index(position);
      this._retainLongExitObservation(position);
      this.metrics.pairedLongEntries += 1;
      this.metrics.opened += 1;
    }
    this._emitMigrationHandoffLiveSignal(pending, profile, trade, price, gate, execution);
    this.pendingEntries.delete(pending.id);
    this.positions.set(pending.id, pending);
    this.metrics.opened += 1;
    this.metrics.migrationHandoffPassed += 1;
    // The pending comparison was committed atomically with the source. Its
    // execution remains event-driven; the live callback never waits one second.
    for (const position of delayed) {
      this.pendingEntries.set(position.id, position);
      this._index(position);
      this.metrics.signals += 1;
    }
  }

  _createDelayedHandoffEntries(source, sourceProfile, rugGuard) {
    if (sourceProfile.pairedSignalProfileId || !this._isPostPosition(source)
      || Math.abs(source.positionSol - 0.1) > 1e-9) return [];
    const delayed = [];
    const profiles = [...this.entryProfiles.values()].filter((profile) => (
      profile.newEntriesEnabled !== false && profile.pairedSignalProfileId === source.entryProfileId
      && (profile.capacitySols || []).includes(source.positionSol)
    ));
    for (const profile of profiles) {
      const delayMs = Math.max(0, finite(profile.shadowExecutionDelayMs, 1_000));
      const entryTargetAt = source.entryAt + delayMs;
      const entryDeadlineAt = entryTargetAt + finite(profile.entryTimeoutMs, this.config.entryTimeoutMs);
      const features = {
        ...source.features,
        pairedSignalProfileId: source.entryProfileId,
        pairedSourcePositionId: source.id,
        pairedSourceCohortId: source.cohortId,
        pairedSourceEpisodeId: source.episodeId,
        shadowExecutionDelayMs: delayMs,
        actualExecutionDelayMs: null,
        qualificationRugGuard: rugGuard,
        delayedEntryPolicy: { ...profile, handoffLiveStrategyId: null, liveStrategyId: null },
      };
      // Pending rows carry qualification evidence, never the source's fill.
      for (const key of ['entryPool', 'entrySlot', 'entrySignature', 'entryEventIndex', 'entryChainTimestampMs']) {
        delete features[key];
      }
      const saved = this.store.createGraduationAccelerationShadowPosition({
          cohortId: `${profile.id}:${capacityId(source.positionSol)}`,
          episodeId: source.episodeId,
          entryProfileId: profile.id,
          mint: source.mint, symbol: source.symbol, creator: source.creator,
          status: STATUS.PENDING_ENTRY, positionSol: source.positionSol,
          configuredCostPct: source.configuredCostPct,
          signalAt: source.signalAt, signalPrice: source.signalPrice,
          signalCurvePct: source.signalCurvePct, entryTargetAt, entryDeadlineAt,
          coreWeightPct: 0, features,
      });
      if (!saved) throw new Error(`Delayed entry could not be persisted: ${profile.id}`);
      if (!saved?.inserted) continue;
      this.store.updateGraduationAccelerationShadowPosition(saved.id, { graduatedAt: source.graduatedAt });
      delayed.push({ ...rowPosition(saved), graduatedAt: source.graduatedAt });
    }
    return delayed;
  }

  _clonePairedEntries(source, profiles, trade, gate, rugGuard) {
    const paired = [];
    for (const profile of profiles) {
      const exitPolicy = {
        experimentGroup: LONG_EXIT_EXPERIMENT,
        executionModelVersion: profile.executionModelVersion || null,
        migrationHandoff: true,
        capacityAwareExit: true,
        coreExitPct: 0,
        runnerExitMode: 'TRAILING',
        runnerMaxHoldMs: Math.min(MAX_LONG_EXIT_HOLD_MS, Math.max(1, finite(profile.runnerMaxHoldMs, MAX_LONG_EXIT_HOLD_MS))),
        trailingActivationPct: finite(profile.trailingActivationPct, 0),
        trailingStopPct: finite(profile.trailingStopPct, 0),
        hardStopPct: finite(profile.hardStopPct, this.config.hardStopPct),
        exitDelayMs: Math.max(0, finite(this.config.exitDelayMs ?? 200, 200)),
        exitTimeoutMs: Math.max(0, finite(this.config.exitTimeoutMs ?? 15_000, 15_000)),
        maxPositionTradeAgeMs: LONG_EXIT_TRADE_MAX_AGE_MS,
      };
      const features = {
        ...source.features,
        experimentGroup: LONG_EXIT_EXPERIMENT,
        executionModelVersion: profile.executionModelVersion || source.features?.executionModelVersion || null,
        pairedEntryProfileId: source.entryProfileId,
        pairedSourcePositionId: source.id,
        pairedSourceCohortId: source.cohortId,
        pairedSourceEpisodeId: source.episodeId,
        pairedAt: source.entryAt,
        entryPool: trade.pool || trade.poolAddress || null,
        entrySlot: trade.slot ?? null,
        entrySignature: trade.signature || null,
        entryEventIndex: trade.eventIndex ?? null,
        entryChainTimestampMs: trade.chainTimestampMs ?? null,
        entryGate: { ...gate },
        exitPolicy,
        longExitObservationUntil: source.entryAt + exitPolicy.runnerMaxHoldMs
          + this._longExitObservationGraceMs(),
      };
      const saved = this.store.createGraduationAccelerationShadowPosition({
        ...source,
        cohortId: `${profile.id}:${capacityId(source.positionSol)}`,
        entryProfileId: profile.id,
        features,
        rugGuard,
      });
      if (!saved) throw new Error(`Paired entry could not be persisted: ${profile.id}`);
      if (!saved.inserted) continue;
      this.store.updateGraduationAccelerationShadowPosition(saved.id, {
        ...source,
        features,
        graduatedAt: source.graduatedAt,
      });
      paired.push({
        ...source,
        id: saved.id,
        cohortId: `${profile.id}:${capacityId(source.positionSol)}`,
        entryProfileId: profile.id,
        features,
      });
    }
    return paired;
  }

  _emitMigrationHandoffLiveSignal(position, profile, trade, price, gate, execution) {
    if (!this.onLiveSignal || !profile?.handoffLiveStrategyId || profile.pairedEntryProfileId
      || profile.pairedSignalProfileId || profile.newEntriesEnabled === false || trade.legacyQuoteView) return;
    const bridgeCapacity = finite(profile.liveBridgeCapacitySol, 1);
    if (Math.abs(position.positionSol - bridgeCapacity) > 1e-9) return;
    try {
      this.onLiveSignal({
        strategyId: profile.handoffLiveStrategyId,
        episodeId: `${position.episodeId}:HANDOFF`,
        mint: position.mint,
        symbol: position.symbol,
        price,
        slot: trade.slot,
        signature: trade.signature || null,
        eventIndex: trade.eventIndex ?? null,
        chainTimestampMs: trade.chainTimestampMs ?? null,
        pool: trade.pool || null,
        timestampMs: trade.timestampMs,
        receivedAtMs: trade.receivedAtMs || trade.timestampMs,
        market: 'PUMP_AMM',
        poolBaseReservesRaw: trade.poolBaseReservesRaw || null,
        poolQuoteReservesRaw: trade.poolQuoteReservesRaw || null,
        virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw || null,
        ammQuoteState: trade.ammQuoteState || null,
        ammQuoteStateReason: trade.ammQuoteStateReason ?? null,
        prePoolBaseReservesRaw: trade.prePoolBaseReservesRaw ?? null,
        prePoolQuoteReservesRaw: trade.prePoolQuoteReservesRaw ?? null,
        preReservePrice: trade.preReservePrice ?? null,
        ammExecutionFees: trade.ammExecutionFees ?? null,
        features: {
          sourceShadowCohortId: position.cohortId,
          executionModelVersion: position.features?.executionModelVersion || null,
          feeModel: 'FLAT_ESTIMATE',
          signalCurvePct: position.signalCurvePct,
          graduatedAt: position.graduatedAt,
          migrationHandoff: true,
          handoffDelayMs: trade.timestampMs - position.graduatedAt,
          handoffBuyers: gate.buyers,
          handoffNetFlowSol: gate.netFlowSol,
          handoffSellBuyRatio: gate.sellBuyRatio,
          handoffDrawdownPct: gate.drawdownPct,
          shadowEntryImpactPct: execution.impactPct,
        },
      });
    } catch (error) {
      this.metrics.lastError = String(error?.message || error).slice(0, 1_000);
    }
  }

  onLiveEntryFailure(event) {
    if (!this.config.enabled || !event?.mint
      || event.rejectionReason !== 'ENTRY_MIGRATED_BEFORE_SUBMIT') return;
    const profiles = [...this.entryProfiles.values()].filter((profile) => (
      profile.mode === 'LIVE_MIGRATION_FAILURE'
      && profile.newEntriesEnabled !== false
      && (!profile.sourceLiveStrategyId || profile.sourceLiveStrategyId === event.strategyId)
    ));
    if (!profiles.length) return;
    const failedAt = finite(event.failedAt, this.now());
    const signalAt = finite(event.signalAt, failedAt);
    const signalPrice = finite(event.signalPrice);
    if (!(signalPrice > 0)) return;
    const token = this.store.getToken(event.mint);
    this.graduatedMints.add(event.mint);
    this.metrics.liveMigrationFailuresObserved += 1;
    for (const profile of profiles) {
      const capacities = [...new Set((profile.capacitySols || [1])
        .map(Number).filter((value) => Number.isFinite(value) && value > 0))];
      const gate = profile.postMigrationEntryGate || {};
      const entryDelayMs = finite(gate.entryDelayMs, 500);
      const entryTimeoutMs = finite(profile.entryTimeoutMs, 2_500);
      const baseEpisodeId = event.episodeId
        || `${event.strategyId || 'LIVE'}:${event.mint}:${signalAt}`;
      for (const positionSol of capacities) {
        const costs = costBreakdown({ ...this.config.costModel, positionSizeSol: positionSol });
        const cohortId = `${profile.id}:${capacityId(positionSol)}`;
        const episodeId = `${baseEpisodeId}:MIGRATED_HANDOFF`;
        const saved = this.store.createGraduationAccelerationShadowPosition({
          cohortId,
          episodeId,
          entryProfileId: profile.id,
          mint: event.mint,
          symbol: event.symbol || token?.symbol || null,
          creator: event.features?.creator || token?.creator || null,
          status: STATUS.PENDING_ENTRY,
          positionSol,
          configuredCostPct: costs.deterministicCostPct,
          signalAt,
          signalPrice,
          signalCurvePct: finite(event.signalCurvePct),
          features: {
            ...(event.features || {}),
            executionModelVersion: profile.executionModelVersion || null,
            shadowExecutionDelayMs: 0,
            feeModel: 'FLAT_ESTIMATE', feeModelIncludes: 'EXISTING_CONFIGURED_COSTS',
            sourceLiveStrategyId: event.strategyId || null,
            sourceLiveRejectionReason: event.rejectionReason,
            sourceLiveErrorCode: event.errorCode || null,
            sourceLiveFailedAt: failedAt,
            sourceLiveSlot: event.slot || null,
          },
          entryTargetAt: failedAt + entryDelayMs,
          entryDeadlineAt: failedAt + entryDelayMs + entryTimeoutMs,
          coreWeightPct: 0,
        });
        if (!saved?.inserted) {
          this.metrics.deduplicated += 1;
          continue;
        }
        const position = rowPosition(saved);
        position.graduatedAt = failedAt;
        this.store.updateGraduationAccelerationShadowPosition(position.id, {
          graduatedAt: failedAt,
        });
        this.pendingEntries.set(position.id, position);
        this._index(position);
        this.metrics.liveMigrationHandoffRows += 1;
      }
      this.metrics.signals += 1;
    }
    this.metrics.lastActionAt = failedAt;
  }

  _postMigrationEntryGateDecision(position, profile, now, entryPool = null) {
    const gate = profile?.postMigrationEntryGate;
    if (!gate || !(position.graduatedAt > 0)) return null;
    const targetAt = position.graduatedAt + finite(gate.entryDelayMs, gate.windowMs);
    if (now < targetAt) return null;
    const evaluatedAt = gate.evaluateAtFill ? now : position.graduatedAt + gate.windowMs;
    const rows = (this.postMigrationTrades.get(position.mint) || []).filter((row) => (
      row.timestampMs >= position.graduatedAt && row.timestampMs <= evaluatedAt
      && (!entryPool || row.pool === entryPool)
      && (!this._isPostPosition(position)
        || (row.ammQuoteState === POST_EXECUTION_MODEL && row.validPostEvidence === true))
    ));
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buyers = new Set(buys.map((row) => row.wallet).filter(Boolean)).size;
    const buySol = buys.reduce((sum, row) => sum + row.solAmount, 0);
    const sellSol = sells.reduce((sum, row) => sum + row.solAmount, 0);
    const netFlowSol = buySol - sellSol;
    const sellBuyRatio = buySol > 0 ? sellSol / buySol : Infinity;
    const largestSellSol = sells.reduce((max, row) => Math.max(max, row.solAmount), 0);
    const prices = rows.map((row) => row.price).filter((value) => value > 0);
    const firstPrice = prices[0] || null;
    const lastPrice = prices.at(-1) || null;
    const peakPrice = prices.length ? Math.max(...prices) : null;
    const drawdownPct = peakPrice > 0 && lastPrice > 0
      ? ((peakPrice - lastPrice) / peakPrice) * 100 : Infinity;
    const checks = [
      ['NO_PRICE', firstPrice > 0 && lastPrice > 0],
      ['TRADES', rows.length >= finite(gate.minTrades, 0)],
      ['BUY_TX', buys.length >= finite(gate.minBuyTx, 0)],
      ['BUYERS', buyers >= finite(gate.minBuyers, 0)],
      ['NET_FLOW', netFlowSol >= finite(gate.minNetFlowSol, -Infinity)],
      ['SELL_BUY', sellBuyRatio <= finite(gate.maxSellBuyRatio, Infinity)],
      ['LARGEST_SELL', largestSellSol <= finite(gate.maxLargestSellSol, Infinity)],
      ['DRAWDOWN', drawdownPct <= finite(gate.maxDrawdownPct, Infinity)],
    ];
    const failed = checks.find(([, passed]) => !passed);
    const reason = failed?.[0] || 'PASSED';
    return {
      evaluatedAt,
      pool: entryPool || null,
      trades: rows.length,
      buyTx: buys.length,
      buyers,
      netFlowSol,
      sellBuyRatio,
      largestSellSol,
      drawdownPct,
      firstPrice,
      lastPrice,
      passed: !failed,
      reason,
      retryable: ['NO_PRICE', 'TRADES', 'BUY_TX', 'BUYERS', 'NET_FLOW'].includes(reason),
    };
  }

  _postSignalJumpConfirmation(position, band, trade) {
    const state = this.states.get(position.mint);
    const priorRows = (state?.events || []).filter((row) => (
      row.timestampMs > position.signalAt && row.timestampMs < trade.timestampMs
    ));
    const rows = [...priorRows, {
      timestampMs: trade.timestampMs,
      side: trade.side,
      wallet: trade.wallet || null,
      solAmount: finite(trade.solAmount, 0),
      curvePct: finite(trade.curvePct),
      price: shadowPrice(trade),
    }];
    const features = this._features(rows);
    const checks = [
      ['SELL_TX', features.sellTx <= finite(band.maxPostSignalSellTx, Infinity)],
      ['BUYERS', features.buyers >= finite(band.minPostSignalBuyers, 0)],
      ['NET_FLOW', features.netFlowSol >= finite(band.minPostSignalNetFlowSol, -Infinity)],
    ];
    const failed = checks.find(([, passed]) => !passed);
    return { passed: !failed, reason: failed?.[0] || 'PASSED', ...features };
  }

  _postMigrationGateDecision(position, now) {
    const profile = this.entryProfiles.get(position.entryProfileId);
    const gate = profile?.postMigrationGate;
    if (!gate || !(position.graduatedAt > 0)) return null;
    const evaluatedAt = position.graduatedAt + gate.windowMs;
    if (now < evaluatedAt) return null;
    const rows = (this.postMigrationTrades.get(position.mint) || []).filter((row) => (
      row.timestampMs >= position.graduatedAt && row.timestampMs <= evaluatedAt
    ));
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buyers = new Set(buys.map((row) => row.wallet).filter(Boolean)).size;
    const netFlowSol = buys.reduce((sum, row) => sum + row.solAmount, 0)
      - sells.reduce((sum, row) => sum + row.solAmount, 0);
    const key = `${position.id}:${evaluatedAt}`;
    if (!this._gateDecisions) this._gateDecisions = new Map();
    let decision = this._gateDecisions.get(key);
    if (!decision) {
      decision = {
        evaluatedAt,
        buyers,
        netFlowSol,
        passed: buyers >= gate.minBuyers && netFlowSol >= gate.minNetFlowSol,
        counted: false,
      };
      this._gateDecisions.set(key, decision);
    }
    return decision;
  }

  _updateExtrema(position, timestampMs, price) {
    const previous = [position.highestPrice, position.lowestPrice,
      position.maxFavorableReturnPct, position.maxAdverseReturnPct];
    position.highestPrice = Math.max(position.highestPrice || position.entryPrice, price);
    position.lowestPrice = Math.min(position.lowestPrice || position.entryPrice, price);
    position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct || 0,
      ((position.highestPrice / position.entryPrice) - 1) * 100);
    position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct || 0,
      ((position.lowestPrice / position.entryPrice) - 1) * 100);
    position.lastObservedAt = timestampMs;
    position.lastPrice = price;
    if (position.features?.experimentGroup === LONG_EXIT_EXPERIMENT
      && previous[0] === position.highestPrice && previous[1] === position.lowestPrice
      && previous[2] === position.maxFavorableReturnPct && previous[3] === position.maxAdverseReturnPct
      && timestampMs - (position.lastExtremaPersistedAt || 0) < LONG_EXIT_HEARTBEAT_MS) return;
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      ...this._longExitSnapshot(position),
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    position.lastExtremaPersistedAt = timestampMs;
  }

  _longExitSnapshot(position) {
    if (position.features?.experimentGroup !== LONG_EXIT_EXPERIMENT && !this._isPostPosition(position)) return {};
    return {
      features: {
        ...position.features,
        longExitTradeCursor: {
          slot: position.lastAcceptedSlot ?? position.features.entrySlot,
          chainTimestampMs: position.lastAcceptedChainTimestampMs ?? position.features.entryChainTimestampMs,
          timestampMs: position.lastAcceptedTradeAt ?? position.entryAt,
        },
      },
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: position.lastObservedAt,
      lastPrice: position.lastPrice,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
      runnerHighestPrice: position.runnerHighestPrice,
      runnerTierIndex: position.runnerTierIndex,
      runnerStopPrice: position.runnerStopPrice,
    };
  }

  _requestExit(position, triggerAt, reason, market) {
    if (![STATUS.OPEN, STATUS.RUNNER].includes(position.status)) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTargetMarket = market;
    position.exitTriggerAt = triggerAt;
    const policy = position.features?.experimentGroup === LONG_EXIT_EXPERIMENT
      ? this._positionProfile(position) : null;
    position.exitTargetAt = triggerAt + finite(policy?.exitDelayMs ?? this.config.exitDelayMs, 200);
    position.exitDeadlineAt = position.exitTargetAt + finite(policy?.exitTimeoutMs ?? this.config.exitTimeoutMs, 15_000);
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      ...this._longExitSnapshot(position),
      status: position.status,
      exitReason: reason,
      exitTargetMarket: market,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _close(position, trade, price) {
    this._updateExtrema(position, trade.timestampMs, price);
    const profile = this._positionProfile(position);
    const coreWeight = position.coreExitPrice ? position.coreWeightPct / 100 : 0;
    const runnerWeight = 1 - coreWeight;
    let runnerPrice = price;
    let exitImpactPct = null;
    const markReturnPct = ((price / position.entryPrice) - 1) * 100;
    // Every capacity-aware cohort uses the pool quote. Additionally, any
    // catastrophic mark move must use executable liquidity even for a legacy
    // cohort: otherwise a direct RUG is falsely recorded near the configured
    // -30% stop while a real 1 SOL position may recover almost nothing.
    if (profile?.capacityAwareExit || markReturnPct <= -35) {
      const execution = executableSell(
        trade,
        position.tokenUnits * runnerWeight,
        price,
        { rugMarkReturnPct: markReturnPct },
      );
      if (!execution.available && (profile?.experimentGroup === LONG_EXIT_EXPERIMENT
        || this._isPostPosition(position)
        || !execution.conservative)) return;
      runnerPrice = execution.price ?? price;
      exitImpactPct = execution.impactPct;
    }
    const proceeds = position.tokenUnits
      * ((position.coreExitPrice || 0) * coreWeight + runnerPrice * runnerWeight);
    const grossReturnPct = ((proceeds / position.positionSol) - 1) * 100;
    const costs = costBreakdown({ ...this.config.costModel, positionSizeSol: position.positionSol });
    const extraExitCostPct = position.coreExitPrice ? costs.fixedCostPct : 0;
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      ...this._longExitSnapshot(position),
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: runnerPrice,
      exitImpactPct,
      exitReason: position.exitReason,
      grossReturnPct,
      netReturnPct: grossReturnPct - position.configuredCostPct - extraExitCostPct,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    if (position.coreExitPrice) this.metrics.runnerExits += 1;
    this.metrics.lastActionAt = this.now();
  }

  _recordRugGuard(rugGuard) {
    if (!rugGuard) return;
    this.metrics.rugGuardEvaluated += 1;
    if (!rugGuard.sampleReady) this.metrics.rugGuardSampleInsufficient += 1;
    if (rugGuard.riskFlagged || rugGuard.flagged) this.metrics.rugGuardRiskFlagged += 1;
    if (rugGuard.blocked) this.metrics.rugGuardHardBlocked += 1;
    for (const [signature, matched] of Object.entries(rugGuard.signatures || {})) {
      if (!matched) continue;
      this.metrics.rugGuardSignatureHits[signature] =
        (this.metrics.rugGuardSignatureHits[signature] || 0) + 1;
    }
  }

  _observeLateExit(position, trade, price) {
    const noExitObservationMs = finite(this.config.noExitObservationMs, 10 * 60_000);
    if (trade.market !== position.exitTargetMarket
      || trade.timestampMs <= position.exitDeadlineAt
      || trade.timestampMs > position.exitDeadlineAt + noExitObservationMs) return;
    const coreWeight = position.coreExitPrice ? position.coreWeightPct / 100 : 0;
    const runnerWeight = 1 - coreWeight;
    const markReturnPct = ((price / position.entryPrice) - 1) * 100;
    const execution = executableSell(
      trade,
      position.tokenUnits * runnerWeight,
      price,
      { rugMarkReturnPct: markReturnPct },
    );
    // This diagnostic is specifically the first demonstrably executable trade.
    // A conservative zero quote caused by absent reserves remains unobserved.
    if (!execution.available) return;
    const lateExitPrice = execution.price;
    const proceeds = position.tokenUnits
      * ((position.coreExitPrice || 0) * coreWeight + lateExitPrice * runnerWeight);
    const grossReturnPct = ((proceeds / position.positionSol) - 1) * 100;
    const costs = costBreakdown({ ...this.config.costModel, positionSizeSol: position.positionSol });
    const extraExitCostPct = position.coreExitPrice ? costs.fixedCostPct : 0;
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      lateExitStatus: 'OBSERVED_EXECUTABLE',
      lateExitAt: trade.timestampMs,
      lateExitMarket: trade.market,
      lateExitMarkPrice: price,
      lateExitPrice,
      lateExitImpactPct: execution.impactPct,
      lateExitDelayMs: Math.max(0, trade.timestampMs - position.exitTargetAt),
      lateExitAfterDeadlineMs: Math.max(0, trade.timestampMs - position.exitDeadlineAt),
      lateExitNetReturnPct: grossReturnPct - position.configuredCostPct - extraExitCostPct,
    });
    this.noExitWatches.delete(position.id);
    this._unindex(position);
    this.metrics.lateExitObserved += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position, reason) {
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      ...this._longExitSnapshot(position),
      status: STATUS.NO_EXIT,
      rejectionReason: reason,
      exitReason: position.exitReason || reason,
      grossReturnPct: null,
      netReturnPct: null,
      lateExitStatus: 'PENDING',
    });
    this.positions.delete(position.id);
    this.noExitWatches.set(position.id, position);
    this.metrics.noExit += 1;
    this.metrics.lastActionAt = this.now();
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
    if (!ids.size) {
      this.rowsByMint.delete(position.mint);
      this.postMigrationTrades.delete(position.mint);
      this.postMigrationTradeCursors.delete(position.mint);
    }
    const gate = this.entryProfiles.get(position.entryProfileId)?.postMigrationGate;
    if (gate && position.graduatedAt > 0 && this._gateDecisions) {
      this._gateDecisions.delete(`${position.id}:${position.graduatedAt + gate.windowMs}`);
    }
  }
}

function timestampFromAge(trade) {
  const timestampMs = finite(trade?.timestampMs);
  const ageMs = finite(trade?.ageMs);
  return timestampMs != null && ageMs != null ? timestampMs - ageMs : null;
}

module.exports = {
  GraduationAccelerationShadowSuite,
  STATUS,
  curveBuyAveragePrice,
  ammBuyAveragePrice,
};
