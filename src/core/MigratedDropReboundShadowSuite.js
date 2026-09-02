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

function shadowPrice(trade) {
  const reservePrice = finite(trade?.reservePrice);
  return reservePrice > 0 ? reservePrice : finite(trade?.price);
}

const BLEND_EXIT_MODES = new Set([
  'BLEND_XLEG_X8',
  'BLEND_XLEG_RUNNER',
  'BLEND_XLEG_RUNNER_RISK',
]);

function capacityId(positionSol) {
  return `${String(positionSol).replace('.', '_')}SOL`;
}

function beijingHourAllowed(timestampMs, ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return true;
  const hour = new Date(timestampMs + 8 * 60 * 60_000).getUTCHours();
  return ranges.some(([start, end]) => hour >= Number(start) && hour < Number(end));
}

// Approximate an exact-SOL PumpSwap fill from the pool reserves carried by the
// causal trade. This deliberately excludes protocol/LP fees: those remain in
// configuredCostPct, while the size-dependent AMM curve impact is reflected in
// the entry price itself.
function ammBuyAveragePrice(trade, positionSol, fallbackPrice) {
  try {
    const base = BigInt(trade.poolBaseReservesRaw || 0);
    const quote = BigInt(trade.poolQuoteReservesRaw || 0)
      + BigInt(trade.virtualQuoteReservesRaw || 0);
    const input = BigInt(Math.max(1, Math.round(Number(positionSol) * 1e9)));
    if (base <= 0n || quote <= 0n || input <= 0n) {
      return { price: fallbackPrice, impactPct: null };
    }
    const tokensOutRaw = base * input / (quote + input);
    const tokenUnits = Number(tokensOutRaw) / 1e6;
    const baseTokens = Number(base) / 1e6;
    const spotPrice = (Number(quote) / 1e9) / baseTokens;
    const price = Number(positionSol) / tokenUnits;
    if (!(price > 0) || !(spotPrice > 0)) {
      return { price: fallbackPrice, impactPct: null };
    }
    return { price, impactPct: ((price / spotPrice) - 1) * 100 };
  } catch (_) {
    return { price: fallbackPrice, impactPct: null };
  }
}

function ammSellAveragePrice(trade, tokenUnits, fallbackPrice) {
  try {
    const base = BigInt(trade.poolBaseReservesRaw || 0);
    const quote = BigInt(trade.poolQuoteReservesRaw || 0)
      + BigInt(trade.virtualQuoteReservesRaw || 0);
    const input = BigInt(Math.max(1, Math.round(Number(tokenUnits) * 1e6)));
    if (base <= 0n || quote <= 0n || input <= 0n) {
      return { price: fallbackPrice, impactPct: null };
    }
    const quoteOutRaw = quote * input / (base + input);
    const solOut = Number(quoteOutRaw) / 1e9;
    const baseTokens = Number(base) / 1e6;
    const spotPrice = (Number(quote) / 1e9) / baseTokens;
    const price = solOut / Number(tokenUnits);
    if (!(price > 0) || !(spotPrice > 0)) {
      return { price: fallbackPrice, impactPct: null };
    }
    return { price, impactPct: ((price / spotPrice) - 1) * 100 };
  } catch (_) {
    return { price: fallbackPrice, impactPct: null };
  }
}

function rowPosition(row) {
  const value = (snake, camel) => row[snake] ?? row[camel];
  return {
    id: row.id,
    cohortId: value('cohort_id', 'cohortId'),
    lifecycleStage: value('lifecycle_stage', 'lifecycleStage') || 'POST_MIGRATION',
    entryProfileId: value('entry_profile_id', 'entryProfileId'),
    exitProfileId: value('exit_profile_id', 'exitProfileId'),
    episodeId: value('episode_id', 'episodeId'),
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    rejectionReason: value('rejection_reason', 'rejectionReason'),
    confirmationJson: value('confirmation_json', 'confirmationJson'),
    positionSol: finite(value('position_sol', 'positionSol'), 1),
    configuredCostPct: finite(value('configured_cost_pct', 'configuredCostPct'), 0),
    reboundAt: value('rebound_at', 'reboundAt'),
    reboundPrice: value('rebound_price', 'reboundPrice'),
    entryTargetAt: value('entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: value('entry_deadline_at', 'entryDeadlineAt'),
    entryAt: value('entry_at', 'entryAt'),
    entryMarket: value('entry_market', 'entryMarket'),
    entryPrice: value('entry_price', 'entryPrice'),
    entryJumpPct: value('entry_jump_pct', 'entryJumpPct'),
    entryImpactPct: value('entry_impact_pct', 'entryImpactPct'),
    exitImpactPct: value('exit_impact_pct', 'exitImpactPct'),
    highestPrice: value('highest_price', 'highestPrice'),
    lowestPrice: value('lowest_price', 'lowestPrice'),
    lastObservedAt: value('last_observed_at', 'lastObservedAt'),
    lastPrice: value('last_price', 'lastPrice'),
    maxFavorableReturnPct: finite(value('max_favorable_return_pct', 'maxFavorableReturnPct'), 0),
    maxAdverseReturnPct: finite(value('max_adverse_return_pct', 'maxAdverseReturnPct'), 0),
    trailingActivatedAt: value('trailing_activated_at', 'trailingActivatedAt'),
    exitMode: value('exit_mode', 'exitMode'),
    fixedHoldMs: value('fixed_hold_ms', 'fixedHoldMs'),
    trailingActivationPct: value('trailing_activation_pct', 'trailingActivationPct'),
    trailingStopPct: value('trailing_stop_pct', 'trailingStopPct'),
    hardStopPct: value('hard_stop_pct', 'hardStopPct'),
    fastTakeProfitPct: value('fast_take_profit_pct', 'fastTakeProfitPct'),
    fastTakeProfitWindowMs: value('fast_take_profit_window_ms', 'fastTakeProfitWindowMs'),
    lossCheckAtMs: value('loss_check_at_ms', 'lossCheckAtMs'),
    lossCheckRecoveryPct: value('loss_check_recovery_pct', 'lossCheckRecoveryPct'),
    maxHoldMs: value('max_hold_ms', 'maxHoldMs'),
    coreWeightPct: value('core_weight_pct', 'coreWeightPct'),
    runnerHoldMs: value('runner_hold_ms', 'runnerHoldMs'),
    coreExitTargetAt: value('core_exit_target_at', 'coreExitTargetAt'),
    coreExitAt: value('core_exit_at', 'coreExitAt'),
    coreExitPrice: value('core_exit_price', 'coreExitPrice'),
    coreExitReason: value('core_exit_reason', 'coreExitReason'),
    exitTriggerAt: value('exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: value('exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: value('exit_deadline_at', 'exitDeadlineAt'),
    exitReason: value('exit_reason', 'exitReason'),
  };
}

class MigratedDropReboundShadowSuite {
  constructor({
    config,
    store,
    now = () => Date.now(),
    rugRiskTracker = null,
    onLiveSignal = null,
  }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.rugRiskTracker = rugRiskTracker;
    this.onLiveSignal = typeof onLiveSignal === 'function' ? onLiveSignal : null;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((profile) => [profile.id, profile]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((profile) => [profile.id, profile]));
    this.retiredCohortPrefixes = (config.retiredCohortPrefixes || [])
      .map((prefix) => String(prefix || '').trim())
      .filter(Boolean);
    this.lifecycleStages = config.lifecycleStages || [
      { id: 'PRE_MIGRATION', label: '毕业前', market: 'PUMP_BONDING_CURVE' },
      { id: 'POST_MIGRATION', label: '毕业后', market: 'PUMP_AMM' },
    ];
    this.lifecycleStageIds = new Set(this.lifecycleStages.map((stage) => stage.id));
    this.detectors = new Map();
    for (const stage of this.lifecycleStages) {
      for (const profile of this.entryProfiles.values()) {
        this.detectors.set(`${stage.id}:${profile.id}`, {
          stage: stage.id,
          profileId: profile.id,
          states: new Map(),
        });
      }
    }
    this.tracked = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.signalCounts = new Map();
    this.ammPriceStates = new Map();
    this.fastConfirmationProfiles = [...this.entryProfiles.values()]
      .filter((profile) => profile.fastConfirmation);
    this.fastFlowRetentionMs = Math.max(
      1_000,
      ...this.fastConfirmationProfiles.map((profile) => (
        finite(profile.fastConfirmation?.confirmationMs, 0) + this.config.entryTimeoutMs
      )),
    );
    this.fastFlowMaxTradesPerMint = Math.max(
      32,
      Math.trunc(finite(this.config.fastFlowMaxTradesPerMint, 512)),
    );
    this.fastFlowSweepMs = Math.max(
      1_000,
      Math.trunc(finite(this.config.fastFlowSweepMs, 5_000)),
    );
    this.fastFlowByMint = new Map();
    this.liveSignalsEmitted = new Set();
    this.lastFastFlowSweepAt = 0;
    this.metrics = {
      graduationEventsObserved: 0,
      lastGraduationEventAt: null,
      startupRecoveredMints: 0,
      startupReplayTrades: 0,
      liveTradesObserved: 0,
      replayTradesObserved: 0,
      curveTradesObserved: 0,
      ammTradesObserved: 0,
      lastTradeObservedAt: null,
      lastAmmTradeObservedAt: null,
      postMigrationEligibleTrades: 0,
      lastPostMigrationEligibleTradeAt: null,
      missingGraduatedAtAmmTrades: 0,
      lastMissingGraduatedAtAmmTradeAt: null,
      candidates: 0,
      signals: 0,
      replaySignalsSuppressed: 0,
      replayLiveSignalsSuppressed: 0,
      reboundTimeouts: 0,
      dumpNextBuyCandidates: 0,
      dumpNextBuySignals: 0,
      dumpNextBuyTimeouts: 0,
      dropExceededMax: 0,
      reboundExceededMax: 0,
      reboundTooSlow: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      closed: 0,
      noExit: 0,
      ammPriceOutliersIgnored: 0,
      ammPriceRegimesConfirmed: 0,
      fastConfirmationPassed: 0,
      fastConfirmationRejected: 0,
      fastConfirmationFeatureComputations: 0,
      fastConfirmationCapacityComputations: 0,
      rugRiskRejected: 0,
      rugRiskSampleInsufficient: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    for (const token of this.store.allTokens()) {
      const graduatedAt = finite(token.graduated_at);
      if (graduatedAt && now - graduatedAt <= this._observationAgeMs()) {
        this.onGraduated(token, { source: 'startup' });
      }
    }
    for (const row of this.store.activeMigratedDropReboundShadowPositions()) {
      const position = rowPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._indexRow(position);
      const token = this.store.getToken(position.mint);
      this.onGraduated(token || {
        mint: position.mint,
        symbol: position.symbol,
        graduated_at: row.migrated_at,
      }, { source: 'startup' });
    }
    this.metrics.startupRecoveredMints = this.tracked.size;

    const replayHorizonMs = Math.max(
      1_000,
      ...[...this.entryProfiles.values()].map((profile) => (
        profile.windowMs + profile.reboundTimeoutMs
          + finite(profile.fastConfirmation?.confirmationMs, 0)
          + this.config.entryTimeoutMs
      )),
    );
    const replayTrades = [
      ...this.store.recentCurveTrades(now - replayHorizonMs),
      ...this.store.recentAmmTrades(now - replayHorizonMs),
    ].sort((left, right) => left.timestampMs - right.timestampMs);
    this.metrics.startupReplayTrades = replayTrades.length;
    for (const trade of replayTrades) {
      this.observeTrade(trade, { replay: true });
    }
    this.advanceTime(now);
  }

  stop() {}

  onGraduated(token, { source = 'event' } = {}) {
    if (!this.config.enabled || !token?.mint) return;
    const graduatedAt = finite(
      token.graduated_at ?? token.graduatedAt ?? token.migratedAt
        ?? token.completedAt ?? token.timestampMs,
    );
    if (!(graduatedAt > 0)) return;
    if (source === 'event') {
      this.metrics.graduationEventsObserved += 1;
      this.metrics.lastGraduationEventAt = this.now();
    }
    const current = this.tracked.get(token.mint);
    this.tracked.set(token.mint, {
      mint: token.mint,
      symbol: token.symbol || current?.symbol || null,
      graduatedAt: Math.min(graduatedAt, current?.graduatedAt || graduatedAt),
    });
  }

  trackedMints(now = this.now()) {
    for (const [mint, token] of this.tracked) {
      if (now - token.graduatedAt <= this._observationAgeMs()) continue;
      if (this._hasActiveMint(mint)) continue;
      this.tracked.delete(mint);
      for (const detector of this.detectors.values()) detector.states.delete(mint);
      for (const profile of this.entryProfiles.values()) {
        this.signalCounts.delete(this._signalCountKey('PRE_MIGRATION', profile.id, mint));
        this.signalCounts.delete(this._signalCountKey('POST_MIGRATION', profile.id, mint));
      }
      this.ammPriceStates.delete(mint);
      this.fastFlowByMint.delete(mint);
    }
    return [...this.tracked.keys()];
  }

  observeTrade(trade, { replay = false } = {}) {
    const price = shadowPrice(trade);
    const timestampMs = finite(trade?.timestampMs);
    if (!this.config.enabled || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade?.market)
      || !trade?.mint
      || !(price > 0) || !(timestampMs > 0)) return;
    if (replay) this.metrics.replayTradesObserved += 1;
    else this.metrics.liveTradesObserved += 1;
    this.metrics.lastTradeObservedAt = Math.max(
      finite(this.metrics.lastTradeObservedAt, 0),
      timestampMs,
    );
    if (trade.market === 'PUMP_AMM') {
      this.metrics.ammTradesObserved += 1;
      this.metrics.lastAmmTradeObservedAt = Math.max(
        finite(this.metrics.lastAmmTradeObservedAt, 0),
        timestampMs,
      );
    } else {
      this.metrics.curveTradesObserved += 1;
    }
    const token = this.store.getToken(trade.mint);
    const graduatedAt = finite(token?.graduated_at ?? this.tracked.get(trade.mint)?.graduatedAt);
    if (trade.market === 'PUMP_AMM' && !(graduatedAt > 0)) {
      this.metrics.missingGraduatedAtAmmTrades += 1;
      this.metrics.lastMissingGraduatedAtAmmTradeAt = timestampMs;
    }
    if (!this._acceptAmmPrice(trade, price)) return;
    const lifecycleStage = trade.market === 'PUMP_BONDING_CURVE'
      && (!(graduatedAt > 0) || timestampMs < graduatedAt)
      ? 'PRE_MIGRATION'
      : trade.market === 'PUMP_AMM' && graduatedAt > 0 && timestampMs >= graduatedAt
        ? 'POST_MIGRATION'
        : null;
    if (lifecycleStage === 'POST_MIGRATION') {
      this.metrics.postMigrationEligibleTrades += 1;
      this.metrics.lastPostMigrationEligibleTradeAt = timestampMs;
    }
    if (lifecycleStage === 'POST_MIGRATION' && this._needsFastFlowTrade(trade.mint)) {
      this._recordFastFlowTrade(trade);
    }
    this._observeRowsForMint(trade, price, { replay });
    // A disabled lifecycle stage has no detector. Ignore it here so one
    // research suite cannot abort the shared runtime trade pipeline.
    if (!lifecycleStage || !this.lifecycleStageIds.has(lifecycleStage)) return;
    if (lifecycleStage === 'POST_MIGRATION') {
      if (!this.tracked.has(trade.mint)) {
        this.onGraduated(token, { source: replay ? 'replay' : 'trade' });
      }
      if (timestampMs - graduatedAt > this._observationAgeMs()
        && !this._hasActiveMint(trade.mint)) return;
    }
    const anchorAt = lifecycleStage === 'POST_MIGRATION'
      ? graduatedAt
      : finite(token?.created_at, timestampMs);
    for (const profile of this.entryProfiles.values()) {
      if (profile.newEntriesEnabled === false) continue;
      const maxLifecycleAgeMs = finite(
        profile.maxLifecycleAgeMs,
        this.config.trackingAgeMs,
      );
      if (lifecycleStage === 'POST_MIGRATION'
        && timestampMs - anchorAt > maxLifecycleAgeMs) continue;
      this._observeDetector(profile, lifecycleStage, trade, price, anchorAt, replay);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    if (this.fastFlowByMint.size
      && now - this.lastFastFlowSweepAt >= this.fastFlowSweepMs) {
      for (const mint of this.fastFlowByMint.keys()) this._pruneFastFlowBuffer(mint, now);
      this.lastFastFlowSweepAt = now;
    }
    for (const detector of this.detectors.values()) {
      const profile = this.entryProfiles.get(detector.profileId);
      for (const [mint, state] of detector.states) {
        if (state.candidate && now > state.candidate.expiresAt) {
          state.candidate = null;
          if (profile.signalMode === 'DUMP_NEXT_BUY') this.metrics.dumpNextBuyTimeouts += 1;
          else this.metrics.reboundTimeouts += 1;
        }
        this._prune(state, now, profile.windowMs);
        if (!state.candidate && now - state.lastTimestampMs > this.config.stateRetentionMs) {
          detector.states.delete(mint);
        }
      }
    }
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      const profile = this.entryProfiles.get(pending.entryProfileId);
      const rejectionReason = pending.pendingRejectionReason
        || (profile?.fastConfirmation ? 'FAST_CONFIRM_NO_EXECUTABLE_ENTRY' : null);
      this.store.updateMigratedDropReboundShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason,
        confirmationJson: pending.confirmationJson,
      });
      this.pendingEntries.delete(pending.id);
      this._unindexRow(pending);
      this.metrics.noEntry += 1;
      if (profile?.fastConfirmation) this.metrics.fastConfirmationRejected += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      this._evaluateExit(position, now, position.lastPrice);
    }
    this.trackedMints(now);
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_G',
      sendsTransactions: false,
      gfrEnabled: this.config.gfrEnabled !== false && this.fastConfirmationProfiles.length > 0,
      trackedMints: this.tracked.size,
      detectorStates: Object.fromEntries(this.lifecycleStages.map((stage) => [
        stage.id,
        [...this.detectors.values()]
          .filter((detector) => detector.stage === stage.id)
          .reduce((total, detector) => total + detector.states.size, 0),
      ])),
      pendingEntries: this.pendingEntries.size,
      fastFlowBuffers: this.fastFlowByMint.size,
      fastFlowRows: [...this.fastFlowByMint.values()]
        .reduce((total, buffer) => total + Math.max(0, buffer.rows.length - buffer.start), 0),
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      enabledEntryProfileIds: [...this.entryProfiles.values()]
        .filter((profile) => profile.newEntriesEnabled !== false)
        .map((profile) => profile.id),
      stoppedEntryProfileIds: [...this.entryProfiles.values()]
        .filter((profile) => profile.newEntriesEnabled === false)
        .map((profile) => profile.id),
      exitProfiles: [...this.exitProfiles.values()],
      lifecycleStages: this.lifecycleStages,
      strategy: {
        scope: 'PRE_MIGRATION_BONDING_CURVE_AND_POST_MIGRATION_PUMP_AMM',
        trackingAgeMs: this.config.trackingAgeMs,
        observationAgeMs: this._observationAgeMs(),
        entryDelayMs: this.config.entryDelayMs,
        entryTimeoutMs: this.config.entryTimeoutMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        ammPriceContinuity: {
          enabled: true,
          ...(this.config.ammPriceContinuity || {}),
          behavior: 'outliers remain in raw trades but cannot update Shadow G',
        },
        research: {
          simulatedPositionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          isolatedTable: 'migrated_drop_rebound_shadow_positions',
          rawData: 'all pre-migration curve trades and the subscribed post-migration PUMP_AMM trades are retained for offline grid search',
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  _state(lifecycleStage, profileId, mint) {
    const detector = this.detectors.get(`${lifecycleStage}:${profileId}`);
    if (!detector) return null;
    const { states } = detector;
    let state = states.get(mint);
    if (!state) {
      state = {
        prices: [],
        lastTimestampMs: 0,
        dropReady: true,
        candidate: null,
        lastSignalAt: 0,
      };
      states.set(mint, state);
    }
    return state;
  }

  _signalCountKey(lifecycleStage, profileId, mint) {
    return `${lifecycleStage}:${profileId}:${mint}`;
  }

  _observationAgeMs() {
    return Math.max(
      finite(this.config.trackingAgeMs, 0),
      finite(this.config.observationAgeMs, 0),
    );
  }

  _signalCount(lifecycleStage, profile, mint) {
    const profileId = profile.id;
    const key = this._signalCountKey(lifecycleStage, profileId, mint);
    if (!this.signalCounts.has(key)) {
      const stored = this.store.migratedDropReboundShadowSignalCount(
        lifecycleStage,
        profileId,
        mint,
      );
      // A second-opportunity-only profile stores no row for opportunity one.
      // Once its row exists, restore the causal ordinal rather than treating a
      // process restart as another second opportunity.
      const ordinalOffset = stored > 0
        ? Math.max(0, Number(profile.minSignalOrdinal || 1) - 1)
        : 0;
      this.signalCounts.set(key, stored + ordinalOffset);
    }
    return this.signalCounts.get(key) || 0;
  }

  _acceptAmmPrice(trade, price) {
    if (trade.market !== 'PUMP_AMM') return true;
    const settings = {
      minRatio: 0.2,
      maxRatio: 5,
      resetAfterMs: 15_000,
      confirmationTrades: 2,
      confirmationWindowMs: 2_000,
      confirmationTolerancePct: 20,
      ...(this.config.ammPriceContinuity || {}),
    };
    const timestampMs = Number(trade.timestampMs);
    const state = this.ammPriceStates.get(trade.mint);
    if (!state || timestampMs - state.acceptedAt > settings.resetAfterMs) {
      this.ammPriceStates.set(trade.mint, {
        acceptedPrice: price,
        acceptedAt: timestampMs,
        candidate: null,
      });
      return true;
    }
    if (timestampMs < state.acceptedAt) return false;

    const ratio = price / state.acceptedPrice;
    if (ratio >= settings.minRatio && ratio <= settings.maxRatio) {
      state.acceptedPrice = price;
      state.acceptedAt = timestampMs;
      state.candidate = null;
      return true;
    }

    const candidate = state.candidate;
    const candidateRatio = candidate ? price / candidate.price : null;
    const withinCandidateRange = candidateRatio > 0
      && Math.abs(candidateRatio - 1) * 100 <= settings.confirmationTolerancePct;
    if (candidate
      && timestampMs - candidate.startedAt <= settings.confirmationWindowMs
      && withinCandidateRange) {
      candidate.count += 1;
      candidate.price = price;
      candidate.lastAt = timestampMs;
      if (candidate.count >= settings.confirmationTrades) {
        state.acceptedPrice = price;
        state.acceptedAt = timestampMs;
        state.candidate = null;
        this.metrics.ammPriceRegimesConfirmed += 1;
        return true;
      }
    } else {
      state.candidate = {
        price,
        count: 1,
        startedAt: timestampMs,
        lastAt: timestampMs,
      };
    }
    this.metrics.ammPriceOutliersIgnored += 1;
    return false;
  }

  _prune(state, timestampMs, windowMs) {
    const cutoff = timestampMs - windowMs;
    while (state.prices.length && state.prices[0].timestampMs < cutoff) state.prices.shift();
  }

  _flowTrade(trade) {
    return {
      timestampMs: Number(trade.timestampMs),
      side: trade.side === 'SELL' ? 'SELL' : 'BUY',
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      wallet: trade.wallet || null,
      signature: trade.signature || null,
    };
  }

  _needsFastFlowTrade(mint) {
    for (const profile of this.fastConfirmationProfiles) {
      const detector = this.detectors.get(`POST_MIGRATION:${profile.id}`);
      if (detector?.states.get(mint)?.candidate) return true;
    }
    for (const id of this.rowsByMint.get(mint) || []) {
      const pending = this.pendingEntries.get(id);
      if (!pending) continue;
      if (this.entryProfiles.get(pending.entryProfileId)?.fastConfirmation) return true;
    }
    return false;
  }

  _recordFastFlowTrade(trade) {
    const row = this._flowTrade(trade);
    let buffer = this.fastFlowByMint.get(trade.mint);
    if (!buffer) {
      buffer = { rows: [], start: 0, lastKey: null, lastTimestampMs: 0 };
      this.fastFlowByMint.set(trade.mint, buffer);
    }
    const rowKey = row.signature || [
      row.timestampMs,
      row.side,
      row.wallet || '',
      row.solAmount,
    ].join(':');
    if (rowKey === buffer.lastKey) return;
    buffer.rows.push(row);
    buffer.lastKey = rowKey;
    buffer.lastTimestampMs = row.timestampMs;
    this._pruneFastFlowBuffer(trade.mint, row.timestampMs);
  }

  _pruneFastFlowBuffer(mint, timestampMs) {
    const buffer = this.fastFlowByMint.get(mint);
    if (!buffer) return;
    const cutoff = timestampMs - this.fastFlowRetentionMs;
    while (buffer.start < buffer.rows.length
      && buffer.rows[buffer.start].timestampMs < cutoff) buffer.start += 1;
    const activeRows = buffer.rows.length - buffer.start;
    if (activeRows > this.fastFlowMaxTradesPerMint) {
      buffer.start = buffer.rows.length - this.fastFlowMaxTradesPerMint;
    }
    if (buffer.start >= buffer.rows.length) {
      this.fastFlowByMint.delete(mint);
      return;
    }
    if (buffer.start >= 128 && buffer.start * 2 >= buffer.rows.length) {
      buffer.rows = buffer.rows.slice(buffer.start);
      buffer.start = 0;
    }
  }

  _observeDetector(profile, lifecycleStage, trade, price, anchorAt, replay) {
    const timestampMs = trade.timestampMs;
    const state = this._state(lifecycleStage, profile.id, trade.mint);
    if (!state) return;
    if (state.lastTimestampMs && timestampMs < state.lastTimestampMs) return;
    state.lastTimestampMs = timestampMs;
    state.prices.push({
      timestampMs,
      price,
      slot: trade.slot || null,
      signature: trade.signature || null,
      side: trade.side || null,
      solAmount: finite(trade.solAmount, 0),
      wallet: trade.wallet || null,
    });
    this._prune(state, timestampMs, profile.windowMs);

    let rollingPeak = state.prices[0];
    for (const row of state.prices) if (row.price > rollingPeak.price) rollingPeak = row;
    const rollingDropPct = ((price / rollingPeak.price) - 1) * 100;
    if (rollingDropPct > -profile.dropMinPct) state.dropReady = true;
    if (rollingDropPct < -profile.dropMaxPct) state.dropReady = false;

    if (profile.signalMode === 'DUMP_NEXT_BUY') {
      this._observeDumpNextBuyDetector({
        profile,
        lifecycleStage,
        trade,
        price,
        anchorAt,
        state,
        rollingPeak,
        rollingDropPct,
        replay,
      });
      return;
    }

    if (state.candidate) {
      const candidate = state.candidate;
      if (timestampMs > candidate.expiresAt) {
        state.candidate = null;
        this.metrics.reboundTimeouts += 1;
      } else {
        if (price < candidate.lowPrice) {
          candidate.lowPrice = price;
          candidate.lowAt = timestampMs;
        }
        const dropPct = ((candidate.lowPrice / candidate.peakPrice) - 1) * 100;
        if (dropPct < -profile.dropMaxPct) {
          state.candidate = null;
          state.dropReady = false;
          this.metrics.dropExceededMax += 1;
        } else {
          const reboundPct = ((price / candidate.lowPrice) - 1) * 100;
          if (reboundPct >= profile.reboundMinPct) {
            state.candidate = null;
            state.dropReady = false;
            const reboundFromLowMs = timestampMs - candidate.lowAt;
            if (reboundPct > profile.reboundMaxPct) {
              this.metrics.reboundExceededMax += 1;
            } else if (profile.maxReboundFromLowMs != null
              && reboundFromLowMs > profile.maxReboundFromLowMs) {
              this.metrics.reboundTooSlow += 1;
            } else if (replay) {
              this.metrics.replaySignalsSuppressed += 1;
            } else {
              const lifecycleAgeMs = Math.max(0, trade.timestampMs - anchorAt);
              const signalKey = this._signalCountKey(lifecycleStage, profile.id, trade.mint);
              const signalCount = this._signalCount(lifecycleStage, profile, trade.mint);
              const signalOrdinal = signalCount + 1;
              const agePass = profile.maxLifecycleAgeMs == null
                || lifecycleAgeMs <= profile.maxLifecycleAgeMs;
              const countPass = profile.maxSignalsPerMint == null
                || signalOrdinal <= profile.maxSignalsPerMint;
              const minimumPass = profile.minSignalOrdinal == null
                || signalOrdinal >= profile.minSignalOrdinal;
              const timePass = beijingHourAllowed(
                trade.timestampMs,
                profile.beijingHourRanges,
              );
              if (agePass && countPass && timePass) {
                const rugRisk = profile.requireHealthyRugRisk
                  ? this.rugRiskTracker?.snapshot(trade.mint, trade.timestampMs) || null
                  : null;
                const rugRiskPass = !profile.requireHealthyRugRisk
                  || (rugRisk?.sampleReady && !rugRisk.flagged);
                if (minimumPass && rugRiskPass) {
                  this._emitSignal({
                    profile,
                    lifecycleStage,
                    trade,
                    price,
                    anchorAt,
                    candidate,
                    dropPct,
                    reboundPct,
                    rugRisk,
                  });
                } else if (minimumPass && profile.requireHealthyRugRisk) {
                  if (!rugRisk?.sampleReady) this.metrics.rugRiskSampleInsufficient += 1;
                  else if (rugRisk.flagged) this.metrics.rugRiskRejected += 1;
                }
                this.signalCounts.set(signalKey, signalOrdinal);
              }
            }
          }
        }
      }
    }

    if (!state.candidate && state.dropReady
      && rollingDropPct <= -profile.dropMinPct && rollingDropPct >= -profile.dropMaxPct) {
      state.candidate = {
        peakPrice: rollingPeak.price,
        peakAt: rollingPeak.timestampMs,
        lowPrice: price,
        lowAt: timestampMs,
        startedAt: timestampMs,
        expiresAt: timestampMs + profile.reboundTimeoutMs,
      };
      state.dropReady = false;
      this.metrics.candidates += 1;
    }
  }

  _observeDumpNextBuyDetector({
    profile,
    lifecycleStage,
    trade,
    price,
    anchorAt,
    state,
    rollingPeak,
    rollingDropPct,
    replay,
  }) {
    if (lifecycleStage !== 'POST_MIGRATION') return;
    const timestampMs = finite(trade.timestampMs);
    const lifecycleAgeMs = Math.max(0, timestampMs - anchorAt);
    const signalKey = this._signalCountKey(lifecycleStage, profile.id, trade.mint);

    if (state.candidate && timestampMs > state.candidate.expiresAt) {
      state.candidate = null;
      this.metrics.dumpNextBuyTimeouts += 1;
    }

    if (state.candidate && trade.side === 'BUY'
      && timestampMs > state.candidate.startedAt) {
      const candidate = state.candidate;
      const signalCount = this._signalCount(lifecycleStage, profile, trade.mint);
      const signalOrdinal = signalCount + 1;
      const agePass = profile.maxLifecycleAgeMs == null
        || lifecycleAgeMs <= profile.maxLifecycleAgeMs;
      const countPass = profile.maxSignalsPerMint == null
        || signalOrdinal <= profile.maxSignalsPerMint;
      const cooldownPass = timestampMs - finite(state.lastSignalAt, 0)
        >= finite(profile.reentryCooldownMs, 0);
      const timePass = beijingHourAllowed(timestampMs, profile.beijingHourRanges);
      const activePass = !this._hasActiveProfileMint(trade.mint, profile.id);
      if (agePass && countPass && cooldownPass && timePass && activePass) {
        const dropPct = ((candidate.lowPrice / candidate.peakPrice) - 1) * 100;
        const reboundPct = ((price / candidate.lowPrice) - 1) * 100;
        if (replay) {
          this.metrics.replaySignalsSuppressed += 1;
        } else {
          this._emitSignal({
            profile,
            lifecycleStage,
            trade,
            price,
            anchorAt,
            candidate,
            dropPct,
            reboundPct,
            confirmationDetails: {
              entryConfirmation: {
                mode: 'NEXT_ACTUAL_BUY_AFTER_LARGE_SELL',
                dumpAt: candidate.startedAt,
                dumpSignature: candidate.dumpSignature,
                dumpSlot: candidate.dumpSlot,
                dumpWallet: candidate.dumpWallet,
                dumpSolAmount: candidate.dumpSolAmount,
                nextBuyAt: timestampMs,
                nextBuySignature: trade.signature || null,
                nextBuySlot: trade.slot || null,
                nextBuyWallet: trade.wallet || null,
                nextBuySolAmount: finite(trade.solAmount, 0),
                confirmationDelayMs: timestampMs - candidate.startedAt,
              },
            },
          });
          state.lastSignalAt = timestampMs;
          this.metrics.dumpNextBuySignals += 1;
        }
        this.signalCounts.set(signalKey, signalOrdinal);
        state.candidate = null;
        state.dropReady = false;
        return;
      }
    }

    const signalCount = this._signalCount(lifecycleStage, profile, trade.mint);
    const canArm = trade.side === 'SELL'
      && finite(trade.solAmount, 0) >= finite(profile.minDumpSol, 0)
      && rollingDropPct <= -profile.dropMinPct
      && rollingDropPct >= -profile.dropMaxPct
      && (profile.maxLifecycleAgeMs == null || lifecycleAgeMs <= profile.maxLifecycleAgeMs)
      && (profile.maxSignalsPerMint == null || signalCount < profile.maxSignalsPerMint)
      && !this._hasActiveProfileMint(trade.mint, profile.id);
    if (!canArm) return;
    state.candidate = {
      peakPrice: rollingPeak.price,
      peakAt: rollingPeak.timestampMs,
      lowPrice: price,
      lowAt: timestampMs,
      startedAt: timestampMs,
      expiresAt: timestampMs + finite(profile.nextBuyWindowMs, profile.reboundTimeoutMs),
      dumpSignature: trade.signature || null,
      dumpSlot: trade.slot || null,
      dumpWallet: trade.wallet || null,
      dumpSolAmount: finite(trade.solAmount, 0),
    };
    state.dropReady = false;
    this.metrics.candidates += 1;
    this.metrics.dumpNextBuyCandidates += 1;
  }

  _emitSignal({
    profile,
    lifecycleStage,
    trade,
    price,
    anchorAt,
    candidate,
    dropPct,
    reboundPct,
    rugRisk = null,
    confirmationDetails = null,
  }) {
    const stageCode = lifecycleStage === 'PRE_MIGRATION' ? 'PRE' : 'POST';
    const episodeId = `${trade.mint}:${stageCode}:${profile.id}:${candidate.startedAt}:${trade.timestampMs}`;
    this.metrics.signals += 1;
    for (const exitProfile of this.exitProfiles.values()) {
      if (Array.isArray(exitProfile.entryProfileIds)
        && !exitProfile.entryProfileIds.includes(profile.id)) continue;
      if (Array.isArray(profile.exitProfileIds)
        && !profile.exitProfileIds.includes(exitProfile.id)) continue;
      const positionSols = Array.isArray(profile.positionSols) && profile.positionSols.length
        ? profile.positionSols : [this.config.positionSizeSol];
      for (const positionSol of positionSols) {
        const capacitySuffix = positionSols.length > 1 ? `_${capacityId(positionSol)}` : '';
        const cohortId = `${stageCode}_${profile.id}_${exitProfile.id}${capacitySuffix}`;
        if (this.retiredCohortPrefixes.some((prefix) => cohortId.startsWith(prefix))) continue;
        const costs = costBreakdown({
          ...this.config.costModel,
          positionSizeSol: positionSol,
        });
        const configuredCostPct = costs.deterministicCostPct
          - (profile.capacityAware ? costs.priceImpactPct : 0)
          + (BLEND_EXIT_MODES.has(exitProfile.exitMode) ? costs.fixedCostPct : 0);
        const confirmationMs = finite(profile.fastConfirmation?.confirmationMs, null);
        const entryTargetAt = trade.timestampMs
          + (confirmationMs == null ? this.config.entryDelayMs : confirmationMs);
        const saved = this.store.createMigratedDropReboundShadowPosition({
          cohortId,
          lifecycleStage,
          entryProfileId: profile.id,
          exitProfileId: exitProfile.id,
          episodeId,
          mint: trade.mint,
          symbol: trade.symbol || this.store.getToken(trade.mint)?.symbol || null,
          status: STATUS.PENDING_ENTRY,
          positionSol,
          configuredCostPct,
          migratedAt: anchorAt,
          migrationAgeMs: Math.max(0, trade.timestampMs - anchorAt),
          windowMs: profile.windowMs,
          dropMinPct: profile.dropMinPct,
          dropMaxPct: profile.dropMaxPct,
          reboundMinPct: profile.reboundMinPct,
          reboundMaxPct: profile.reboundMaxPct,
          reboundTimeoutMs: profile.reboundTimeoutMs,
          peakAt: candidate.peakAt,
          peakPrice: candidate.peakPrice,
          lowAt: candidate.lowAt,
          lowPrice: candidate.lowPrice,
          dropPct,
          reboundAt: trade.timestampMs,
          reboundPrice: price,
          reboundPct,
          reboundElapsedMs: trade.timestampMs - candidate.startedAt,
          reboundFromLowMs: trade.timestampMs - candidate.lowAt,
          entryTargetAt,
          entryDeadlineAt: entryTargetAt + this.config.entryTimeoutMs,
          confirmationJson: rugRisk || confirmationDetails
            ? JSON.stringify({
              ...(rugRisk ? { preEntryRugRisk: rugRisk } : {}),
              ...(confirmationDetails || {}),
            })
            : null,
          exitMode: exitProfile.exitMode,
          fixedHoldMs: exitProfile.fixedHoldMs,
          trailingActivationPct: exitProfile.trailingActivationPct,
          trailingStopPct: exitProfile.trailingStopPct,
          hardStopPct: exitProfile.hardStopPct,
          fastTakeProfitPct: exitProfile.fastTakeProfitPct,
          fastTakeProfitWindowMs: exitProfile.fastTakeProfitWindowMs,
          lossCheckAtMs: exitProfile.lossCheckAtMs,
          lossCheckRecoveryPct: exitProfile.lossCheckRecoveryPct,
          maxHoldMs: exitProfile.maxHoldMs,
          coreWeightPct: exitProfile.coreWeightPct,
          runnerHoldMs: exitProfile.runnerHoldMs,
        });
        if (!saved?.inserted) continue;
        const pending = rowPosition(saved);
        this.pendingEntries.set(pending.id, pending);
        this._indexRow(pending);
      }
    }
    this.metrics.lastActionAt = this.now();
  }

  _observeRowsForMint(trade, price, { replay = false } = {}) {
    const ids = [...(this.rowsByMint.get(trade.mint) || [])];
    const fastCache = {
      features: new Map(),
      capacities: new Map(),
    };
    for (const id of ids) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (!this._eligibleEntryTrade(position, trade)) continue;
        if (trade.timestampMs < position.entryTargetAt
          || trade.timestampMs > position.entryDeadlineAt) continue;
        const entryProfile = this.entryProfiles.get(position.entryProfileId);
        const universalRugGuard = evaluateUniversalRugGuard(this.store, {
          strategyId: `MIGRATED_DROP_REBOUND:${position.cohortId}`,
          mint: position.mint,
          timestampMs: trade.timestampMs,
          source: 'SHADOW',
          market: trade.market,
          lifecycleStage: position.lifecycleStage,
          lifecycleAgeMs: position.lifecycleStage === 'POST_MIGRATION'
            ? trade.timestampMs - finite(
              this.store.getToken(position.mint)?.graduated_at
                ?? this.tracked.get(position.mint)?.graduatedAt,
              trade.timestampMs,
            )
            : null,
        });
        if (entryProfile?.rugGuardMode === 'LABEL_ONLY') {
          position.confirmationJson = this._mergeConfirmationJson(
            position.confirmationJson,
            { preEntryUniversalRugGuard: universalRugGuard },
          );
        } else if (universalRugGuard.blocked) {
          this.store.updateMigratedDropReboundShadowPosition(position.id, {
            status: STATUS.NO_ENTRY,
            rejectionReason: 'PRE_ENTRY_RUG_RISK',
          });
          this.pendingEntries.delete(position.id);
          this._unindexRow(position);
          continue;
        }
        const jumpPct = ((price / position.reboundPrice) - 1) * 100;
        const maxEntryPriceJumpPct = Number.isFinite(Number(entryProfile?.maxEntryPriceJumpPct))
          ? Number(entryProfile.maxEntryPriceJumpPct)
          : this.config.maxEntryPriceJumpPct;
        if (jumpPct > maxEntryPriceJumpPct) {
          this.store.updateMigratedDropReboundShadowPosition(position.id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
          });
          this.pendingEntries.delete(position.id);
          this._unindexRow(position);
          this.metrics.priceJump += 1;
          continue;
        }
        let fill;
        if (entryProfile?.fastConfirmation) {
          const decision = this._fastConfirmationDecision({
            position,
            profile: entryProfile,
            trade,
            price,
            jumpPct,
            cache: fastCache,
          });
          position.pendingRejectionReason = decision.reason;
          position.confirmationJson = JSON.stringify(decision.features);
          if (!decision.pass) continue;
          fill = decision.fill;
          this.metrics.fastConfirmationPassed += 1;
          this._emitFastConfirmedLiveSignal(
            position,
            entryProfile,
            trade,
            price,
            decision,
            { replay },
          );
        } else {
          fill = entryProfile?.capacityAware && position.lifecycleStage === 'POST_MIGRATION'
            ? ammBuyAveragePrice(trade, position.positionSol, price)
            : { price, impactPct: null };
        }
        const maxEntryImpactPct = finite(entryProfile?.maxEntryImpactPct, null);
        if (maxEntryImpactPct != null
          && (fill.impactPct == null || fill.impactPct > maxEntryImpactPct)) {
          this.store.updateMigratedDropReboundShadowPosition(position.id, {
            status: STATUS.NO_ENTRY,
            rejectionReason: fill.impactPct == null
              ? 'ENTRY_CAPACITY_QUOTE_MISSING'
              : `ENTRY_SELF_IMPACT_${fill.impactPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
            entryImpactPct: fill.impactPct,
            confirmationJson: position.confirmationJson,
          });
          this.pendingEntries.delete(position.id);
          this._unindexRow(position);
          this.metrics.noEntry += 1;
          continue;
        }
        position.status = STATUS.OPEN;
        position.entryAt = trade.timestampMs;
        position.entryMarket = trade.market;
        position.entryPrice = fill.price;
        position.entryJumpPct = jumpPct;
        position.entryImpactPct = fill.impactPct;
        position.highestPrice = fill.price;
        position.lowestPrice = fill.price;
        position.lastObservedAt = trade.timestampMs;
        position.lastPrice = price;
        this.store.updateMigratedDropReboundShadowPosition(position.id, {
          status: STATUS.OPEN,
          entryAt: trade.timestampMs,
          entryMarket: trade.market,
          entryPrice: fill.price,
          entryJumpPct: jumpPct,
          entryImpactPct: fill.impactPct,
          confirmationJson: position.confirmationJson,
          highestPrice: fill.price,
          lowestPrice: fill.price,
          lastObservedAt: trade.timestampMs,
          lastPrice: price,
          maxFavorableReturnPct: 0,
          maxAdverseReturnPct: 0,
        });
        this.pendingEntries.delete(position.id);
        this.positions.set(position.id, position);
        this.metrics.opened += 1;
        if (!entryProfile?.fastConfirmation) {
          this._emitOpenedLiveSignal(position, entryProfile, trade, price, { replay });
        }
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        if (!this._eligibleExitTrade(position, trade, price)) continue;
        if (trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
        continue;
      }
      if (position.status !== STATUS.OPEN || trade.timestampMs < position.entryAt
        || !this._eligibleExitTrade(position, trade, price)) continue;
      if (BLEND_EXIT_MODES.has(position.exitMode)
        && position.coreExitTargetAt
        && !position.coreExitAt && trade.timestampMs >= position.coreExitTargetAt) {
        this._fillCoreExit(position, trade.timestampMs, price);
      }
      this._updateExtrema(position, trade.timestampMs, price);
      this._evaluateExit(position, trade.timestampMs, price);
      if (position.status === STATUS.EXIT_PENDING) {
        if (trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
        else if (trade.timestampMs > position.exitDeadlineAt) this._markNoExit(position);
      }
    }
  }

  _fastConfirmationFeatures({ position, trade, jumpPct }) {
    const buffer = this.fastFlowByMint.get(position.mint);
    const midpoint = position.reboundAt
      + Math.max(1, Math.trunc((trade.timestampMs - position.reboundAt) / 2));
    let buyTx = 0;
    let sellTx = 0;
    let buySol = 0;
    let sellSol = 0;
    let previousNetFlowSol = 0;
    let recentNetFlowSol = 0;
    const buyerTotals = new Map();
    const creator = this.store.getToken(position.mint)?.creator || null;
    let creatorSold = false;
    if (buffer) {
      for (let index = buffer.start; index < buffer.rows.length; index += 1) {
        const row = buffer.rows[index];
        if (row.timestampMs < position.reboundAt) continue;
        if (row.timestampMs > trade.timestampMs) break;
        const signedSol = row.side === 'BUY' ? row.solAmount : -row.solAmount;
        if (row.timestampMs < midpoint) previousNetFlowSol += signedSol;
        else recentNetFlowSol += signedSol;
        if (row.side === 'BUY') {
          buyTx += 1;
          buySol += row.solAmount;
          if (row.wallet) {
            buyerTotals.set(row.wallet, (buyerTotals.get(row.wallet) || 0) + row.solAmount);
          }
        } else {
          sellTx += 1;
          sellSol += row.solAmount;
          if (creator && row.wallet === creator) creatorSold = true;
        }
      }
    }
    const uniqueBuyers = buyerTotals.size;
    let topBuyerSol = 0;
    for (const total of buyerTotals.values()) topBuyerSol = Math.max(topBuyerSol, total);
    const netFlowSol = buySol - sellSol;
    return {
      confirmationMs: trade.timestampMs - position.reboundAt,
      priceContinuationPct: jumpPct,
      buyTx,
      sellTx,
      uniqueBuyers,
      buySol,
      sellSol,
      netFlowSol,
      previousNetFlowSol,
      recentNetFlowSol,
      netFlowAccelerationSol: recentNetFlowSol - previousNetFlowSol,
      sellBuyRatio: buySol > 0 ? sellSol / buySol : null,
      topBuyerSharePct: buySol > 0 ? topBuyerSol / buySol * 100 : 100,
      creatorSold,
    };
  }

  _emitOpenedLiveSignal(position, profile, trade, price, { replay = false } = {}) {
    const strategyId = profile?.liveExitStrategies?.[position.exitProfileId]
      || profile?.liveStrategyId;
    if (!this.onLiveSignal || !strategyId) return;
    const livePositionSol = Number(profile?.livePositionSol);
    if (Number.isFinite(livePositionSol) && livePositionSol > 0
      && Math.abs(Number(position.positionSol) - livePositionSol) > 1e-9) return;
    if (replay) {
      this.metrics.replayLiveSignalsSuppressed += 1;
      return;
    }
    const key = `${position.episodeId}:${profile.id}:${position.exitProfileId}:${strategyId}`;
    if (this.liveSignalsEmitted.has(key)) return;
    this.liveSignalsEmitted.add(key);
    try {
      this.onLiveSignal({
        strategyId,
        episodeId: `${position.episodeId}:${profile.id}:${position.exitProfileId}:OPEN`,
        mint: position.mint,
        symbol: position.symbol,
        price: position.entryPrice || price,
        slot: trade.slot,
        timestampMs: trade.timestampMs,
        receivedAtMs: trade.receivedAtMs || trade.timestampMs,
        market: 'PUMP_AMM',
        poolBaseReservesRaw: trade.poolBaseReservesRaw || null,
        poolQuoteReservesRaw: trade.poolQuoteReservesRaw || null,
        virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw || null,
        features: {
          entryProfileId: profile.id,
          exitProfileId: position.exitProfileId,
          sourceShadowCohortId: position.cohortId,
          migrationAgeMs: position.migrationAgeMs,
          dropPct: position.dropPct,
          reboundPct: position.reboundPct,
          shadowEntryJumpPct: position.entryJumpPct,
          shadowEntryImpactPct: position.entryImpactPct,
          shadowEntryPrice: position.entryPrice,
        },
      });
    } catch (error) {
      this.metrics.lastError = String(error?.message || error).slice(0, 1_000);
    }
  }

  _emitFastConfirmedLiveSignal(
    position,
    profile,
    trade,
    price,
    decision,
    { replay = false } = {},
  ) {
    if (!this.onLiveSignal || !profile?.liveStrategyId) return;
    if (replay) {
      this.metrics.replayLiveSignalsSuppressed += 1;
      return;
    }
    const key = `${position.episodeId}:${profile.id}`;
    if (this.liveSignalsEmitted.has(key)) return;
    this.liveSignalsEmitted.add(key);
    try {
      this.onLiveSignal({
        strategyId: profile.liveStrategyId,
        episodeId: `${position.episodeId}:FAST_CONFIRMED`,
        mint: position.mint,
        symbol: position.symbol,
        price,
        slot: trade.slot,
        timestampMs: trade.timestampMs,
        receivedAtMs: trade.receivedAtMs || trade.timestampMs,
        market: 'PUMP_AMM',
        poolBaseReservesRaw: trade.poolBaseReservesRaw || null,
        poolQuoteReservesRaw: trade.poolQuoteReservesRaw || null,
        virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw || null,
        features: {
          ...(decision.features || {}),
          entryProfileId: profile.id,
          sourceShadowCohortId: position.cohortId,
          migrationAgeMs: position.migrationAgeMs,
          dropPct: position.dropPct,
          reboundPct: position.reboundPct,
        },
      });
    } catch (error) {
      this.metrics.lastError = String(error?.message || error).slice(0, 1_000);
    }
  }

  _fastConfirmationDecision({ position, profile, trade, price, jumpPct, cache }) {
    const settings = profile.fastConfirmation || {};
    const featureKey = `${position.mint}:${position.reboundAt}:${trade.timestampMs}`;
    let baseFeatures = cache.features.get(featureKey);
    if (!baseFeatures) {
      baseFeatures = this._fastConfirmationFeatures({ position, trade, jumpPct });
      cache.features.set(featureKey, baseFeatures);
      this.metrics.fastConfirmationFeatureComputations += 1;
    }
    const baseChecks = [
      [jumpPct >= finite(settings.minPriceContinuationPct, 1), 'PRICE_NOT_CONTINUING'],
      [baseFeatures.buyTx >= finite(settings.minBuyTx, 2), 'BUY_TX_TOO_LOW'],
      [baseFeatures.uniqueBuyers >= finite(settings.minUniqueBuyers, 2), 'BUYERS_TOO_LOW'],
      [baseFeatures.netFlowSol >= finite(settings.minNetFlowSol, 0.5), 'NET_FLOW_TOO_LOW'],
      [baseFeatures.netFlowAccelerationSol >= finite(settings.minNetFlowAccelerationSol, 0),
        'NET_FLOW_DECELERATING'],
      [baseFeatures.sellBuyRatio != null
        && baseFeatures.sellBuyRatio <= finite(settings.maxSellBuyRatio, 0.5),
      'SELL_PRESSURE_HIGH'],
      [baseFeatures.topBuyerSharePct <= finite(settings.maxTopBuyerSharePct, 60),
        'BUYER_CONCENTRATION_HIGH'],
      [!baseFeatures.creatorSold, 'CREATOR_SOLD'],
    ];
    const baseFailed = baseChecks.find(([pass]) => !pass);
    if (baseFailed) {
      return {
        pass: false,
        reason: `FAST_CONFIRM_${baseFailed[1]}`,
        features: {
          ...baseFeatures,
          entryImpactPct: null,
          exitImpactPct: null,
          roundTripImpactPct: null,
        },
        fill: { price, impactPct: null },
      };
    }
    const capacityKey = `${featureKey}:${position.positionSol}`;
    let capacity = cache.capacities.get(capacityKey);
    if (!capacity) {
      const fill = ammBuyAveragePrice(trade, position.positionSol, price);
      const tokenUnits = fill.price > 0 ? position.positionSol / fill.price : null;
      const exitFill = tokenUnits > 0
        ? ammSellAveragePrice(trade, tokenUnits, price)
        : { price, impactPct: null };
      const roundTripImpactPct = Number.isFinite(fill.impactPct)
        && Number.isFinite(exitFill.impactPct)
        ? Math.max(0, fill.impactPct) + Math.abs(Math.min(0, exitFill.impactPct))
        : null;
      capacity = { fill, exitFill, roundTripImpactPct };
      cache.capacities.set(capacityKey, capacity);
      this.metrics.fastConfirmationCapacityComputations += 1;
    }
    const { fill, exitFill, roundTripImpactPct } = capacity;
    const features = {
      ...baseFeatures,
      entryImpactPct: fill.impactPct,
      exitImpactPct: exitFill.impactPct,
      roundTripImpactPct,
    };
    const checks = [
      [roundTripImpactPct != null, 'CAPACITY_QUOTE_MISSING'],
      [roundTripImpactPct != null
        && roundTripImpactPct <= finite(settings.maxRoundTripImpactPct, 5),
      'ROUND_TRIP_IMPACT_HIGH'],
    ];
    const failed = checks.find(([pass]) => !pass);
    return {
      pass: !failed,
      reason: failed ? `FAST_CONFIRM_${failed[1]}` : null,
      features,
      fill,
    };
  }

  _updateExtrema(position, timestampMs, price) {
    const previousHigh = position.highestPrice || position.entryPrice;
    const previousLow = position.lowestPrice || position.entryPrice;
    position.highestPrice = Math.max(previousHigh, price);
    position.lowestPrice = Math.min(previousLow, price);
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
    const patch = { lastObservedAt: timestampMs, lastPrice: price };
    if (position.highestPrice !== previousHigh) {
      patch.highestPrice = position.highestPrice;
      patch.maxFavorableReturnPct = position.maxFavorableReturnPct;
    }
    if (position.lowestPrice !== previousLow) {
      patch.lowestPrice = position.lowestPrice;
      patch.maxAdverseReturnPct = position.maxAdverseReturnPct;
    }
    this.store.updateMigratedDropReboundShadowPosition(position.id, patch);
  }

  _eligibleEntryTrade(position, trade) {
    if (position.lifecycleStage === 'POST_MIGRATION') return trade.market === 'PUMP_AMM';
    if (trade.market !== 'PUMP_BONDING_CURVE') return false;
    const graduatedAt = finite(this.store.getToken(position.mint)?.graduated_at);
    return !(graduatedAt > 0) || trade.timestampMs < graduatedAt;
  }

  _eligibleExitTrade(position, trade, price) {
    if (position.lifecycleStage === 'POST_MIGRATION') {
      return trade.market === 'PUMP_AMM';
    }
    const graduatedAt = finite(this.store.getToken(position.mint)?.graduated_at);
    if (trade.market === 'PUMP_BONDING_CURVE') {
      return !(graduatedAt > 0) || trade.timestampMs < graduatedAt;
    }
    if (trade.market !== 'PUMP_AMM') return false;
    if (!(graduatedAt > 0) || trade.timestampMs < graduatedAt) return false;
    const ratio = price / position.entryPrice;
    return ratio >= 0.05 && ratio <= 20;
  }

  _evaluateExit(position, timestampMs, price) {
    if (position.status !== STATUS.OPEN || !(price > 0)) return;
    const ageMs = timestampMs - position.entryAt;
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    const drawdownPct = ((price / position.highestPrice) - 1) * -100;
    let reason = null;
    let triggerAt = timestampMs;

    if (position.exitMode === 'FIXED_HOLD' && ageMs >= position.fixedHoldMs) {
      reason = `FIXED_HOLD_${position.fixedHoldMs}MS`;
      triggerAt = position.entryAt + position.fixedHoldMs;
    } else if (['LEGACY', 'RISK_XLEG', ...BLEND_EXIT_MODES]
      .includes(position.exitMode)) {
      const riskMode = position.exitMode === 'RISK_XLEG';
      const blendMode = BLEND_EXIT_MODES.has(position.exitMode);
      const blendRiskMode = position.exitMode === 'BLEND_XLEG_RUNNER_RISK';
      if (riskMode && position.hardStopPct > 0
        && grossReturnPct <= -position.hardStopPct) reason = 'RISK_HARD_STOP';
      if (blendRiskMode && position.hardStopPct > 0
        && grossReturnPct <= -position.hardStopPct) reason = 'BLEND_HARD_STOP';
      if (!reason && position.fastTakeProfitPct > 0
        && ageMs <= position.fastTakeProfitWindowMs
        && grossReturnPct >= position.fastTakeProfitPct) reason = 'FAST_TAKE_PROFIT';
      if (!reason && !position.trailingActivatedAt
        && peakReturnPct >= position.trailingActivationPct) {
        position.trailingActivatedAt = timestampMs;
        this.store.updateMigratedDropReboundShadowPosition(position.id, {
          trailingActivatedAt: timestampMs,
        });
      }
      if (!reason && position.trailingActivatedAt && drawdownPct >= position.trailingStopPct) {
        reason = 'TRAILING_STOP';
      }
      if (!reason && position.lossCheckAtMs > 0 && ageMs >= position.lossCheckAtMs
        && grossReturnPct < 0) {
        const recoveryFromLowPct = ((price / position.lowestPrice) - 1) * 100;
        const recoveryPass = !riskMode || position.lossCheckRecoveryPct == null
          || recoveryFromLowPct <= position.lossCheckRecoveryPct;
        if (recoveryPass) {
          reason = riskMode ? 'RISK_LOSS_CHECK' : 'LOSS_CHECK';
          triggerAt = position.entryAt + position.lossCheckAtMs;
        }
      }
      if (blendMode) {
        if (reason === 'BLEND_HARD_STOP') {
          // A full-position safety exit prevents the runner from deliberately
          // remaining exposed after a sudden post-migration collapse.
        } else {
          if (reason && !position.coreExitTargetAt && !position.coreExitAt) {
            this._requestCoreExit(position, triggerAt, reason);
          }
          // Legacy/runner exits only close the core. Once it is filled, keep
          // the runner open until its independent time horizon.
          reason = null;
        }
        if (!reason && ageMs >= position.runnerHoldMs) {
          reason = `BLEND_RUNNER_HOLD_${position.runnerHoldMs}MS`;
          triggerAt = position.entryAt + position.runnerHoldMs;
        }
      } else if (!reason && ageMs >= position.maxHoldMs) {
        reason = 'MAX_HOLD';
        triggerAt = position.entryAt + position.maxHoldMs;
      }
    } else if (position.exitMode === 'STAIR_TRAILING') {
      const exitProfile = this.exitProfiles.get(position.exitProfileId);
      const tiers = [...(exitProfile?.trailingTiers || [])]
        .sort((left, right) => left.activationPct - right.activationPct);
      const activeTier = tiers.filter((tier) => peakReturnPct >= tier.activationPct).at(-1);
      if (position.hardStopPct > 0 && grossReturnPct <= -position.hardStopPct) {
        reason = 'STAIR_HARD_STOP';
      }
      if (!reason && activeTier && !position.trailingActivatedAt) {
        position.trailingActivatedAt = timestampMs;
        this.store.updateMigratedDropReboundShadowPosition(position.id, {
          trailingActivatedAt: timestampMs,
        });
      }
      if (!reason && activeTier && drawdownPct >= activeTier.stopPct) {
        reason = `STAIR_TRAILING_${activeTier.activationPct}_${activeTier.stopPct}`;
      }
      if (!reason && ageMs >= position.maxHoldMs) {
        reason = 'STAIR_MAX_HOLD';
        triggerAt = position.entryAt + position.maxHoldMs;
      }
    } else if (position.exitMode === 'TAIL') {
      if (position.hardStopPct > 0 && grossReturnPct <= -position.hardStopPct) {
        reason = 'HARD_STOP';
      }
      if (!reason && !position.trailingActivatedAt
        && peakReturnPct >= position.trailingActivationPct) {
        position.trailingActivatedAt = timestampMs;
        this.store.updateMigratedDropReboundShadowPosition(position.id, {
          trailingActivatedAt: timestampMs,
        });
      }
      if (!reason && position.trailingActivatedAt && drawdownPct >= position.trailingStopPct) {
        reason = 'TAIL_TRAILING_STOP';
      }
      if (!reason && ageMs >= position.maxHoldMs) {
        reason = 'TAIL_MAX_HOLD';
        triggerAt = position.entryAt + position.maxHoldMs;
      }
    }
    if (reason) this._requestExit(position, triggerAt, reason);
  }

  _requestCoreExit(position, triggerAt, reason) {
    position.coreExitTargetAt = triggerAt + this.config.exitDelayMs;
    position.coreExitReason = reason;
    this.store.updateMigratedDropReboundShadowPosition(position.id, {
      coreExitTargetAt: position.coreExitTargetAt,
      coreExitReason: position.coreExitReason,
    });
  }

  _fillCoreExit(position, timestampMs, price) {
    position.coreExitAt = timestampMs;
    position.coreExitPrice = price;
    this.store.updateMigratedDropReboundShadowPosition(position.id, {
      coreExitAt: position.coreExitAt,
      coreExitPrice: position.coreExitPrice,
    });
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updateMigratedDropReboundShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _close(position, trade, price) {
    this._updateExtrema(position, trade.timestampMs, price);
    const entryProfile = this.entryProfiles.get(position.entryProfileId);
    const markReturnPct = ((price / position.entryPrice) - 1) * 100;
    const exitFill = entryProfile?.capacityAware
      ? executableSell(
        trade,
        position.positionSol / position.entryPrice,
        price,
        { rugMarkReturnPct: markReturnPct },
      )
      : { price, impactPct: null };
    const runnerExitPrice = exitFill.price;
    const runnerGrossReturnPct = ((runnerExitPrice / position.entryPrice) - 1) * 100;
    let grossReturnPct = runnerGrossReturnPct;
    let exitPrice = runnerExitPrice;
    let exitReason = position.exitReason;
    if (BLEND_EXIT_MODES.has(position.exitMode) && exitReason !== 'BLEND_HARD_STOP') {
      const coreWeight = Math.min(1, Math.max(0, finite(position.coreWeightPct, 50) / 100));
      const corePrice = finite(position.coreExitPrice, price);
      const coreGrossReturnPct = ((corePrice / position.entryPrice) - 1) * 100;
      grossReturnPct = coreGrossReturnPct * coreWeight
        + runnerGrossReturnPct * (1 - coreWeight);
      exitPrice = position.entryPrice * (1 + grossReturnPct / 100);
      const runnerTag = position.exitMode === 'BLEND_XLEG_X8'
        ? 'X8'
        : `RUNNER_${position.runnerHoldMs}MS`;
      exitReason = `BLEND_${position.coreExitReason || 'CORE_AT_RUNNER'}_${runnerTag}`;
    }
    const maxPlausibleReturnPct = finite(this.config.maxPlausibleReturnPct, 1_000);
    if (
      !Number.isFinite(grossReturnPct)
      || grossReturnPct < -100
      || grossReturnPct > maxPlausibleReturnPct
    ) {
      this._markNoExit(position, 'IMPLAUSIBLE_EXIT_RETURN');
      return;
    }
    this.store.updateMigratedDropReboundShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice,
      exitImpactPct: exitFill.impactPct,
      exitReason,
      grossReturnPct,
      netReturnPct: grossReturnPct - finite(
        position.configuredCostPct,
        this.costs.deterministicCostPct,
      ),
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.positions.delete(position.id);
    this._unindexRow(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position, reason = 'NO_EXECUTABLE_EXIT_TRADE') {
    this.store.updateMigratedDropReboundShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      rejectionReason: reason,
      exitReason: reason,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.positions.delete(position.id);
    this._unindexRow(position);
    this.metrics.closed += 1;
    this.metrics.noExit += 1;
    this.metrics.lastActionAt = this.now();
  }

  _indexRow(position) {
    let ids = this.rowsByMint.get(position.mint);
    if (!ids) {
      ids = new Set();
      this.rowsByMint.set(position.mint, ids);
    }
    ids.add(position.id);
  }

  _unindexRow(position) {
    const ids = this.rowsByMint.get(position.mint);
    if (!ids) return;
    ids.delete(position.id);
    if (!ids.size) this.rowsByMint.delete(position.mint);
  }

  _hasActiveMint(mint) {
    return (this.rowsByMint.get(mint)?.size || 0) > 0;
  }

  _hasActiveProfileMint(mint, entryProfileId) {
    for (const id of this.rowsByMint.get(mint) || []) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (position?.entryProfileId === entryProfileId) return true;
    }
    return false;
  }

  _mergeConfirmationJson(current, extra) {
    let parsed = {};
    if (current) {
      try {
        parsed = JSON.parse(current) || {};
      } catch {
        parsed = {};
      }
    }
    return JSON.stringify({ ...parsed, ...(extra || {}) });
  }
}

module.exports = {
  MigratedDropReboundShadowSuite,
  STATUS,
  shadowPrice,
  ammBuyAveragePrice,
  ammSellAveragePrice,
  beijingHourAllowed,
};
