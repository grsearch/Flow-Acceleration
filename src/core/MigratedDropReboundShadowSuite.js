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
    reboundAt: value('rebound_at', 'reboundAt'),
    reboundPrice: value('rebound_price', 'reboundPrice'),
    entryTargetAt: value('entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: value('entry_deadline_at', 'entryDeadlineAt'),
    entryAt: value('entry_at', 'entryAt'),
    entryMarket: value('entry_market', 'entryMarket'),
    entryPrice: value('entry_price', 'entryPrice'),
    entryJumpPct: value('entry_jump_pct', 'entryJumpPct'),
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
    maxHoldMs: value('max_hold_ms', 'maxHoldMs'),
    exitTriggerAt: value('exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: value('exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: value('exit_deadline_at', 'exitDeadlineAt'),
    exitReason: value('exit_reason', 'exitReason'),
  };
}

class MigratedDropReboundShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((profile) => [profile.id, profile]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((profile) => [profile.id, profile]));
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
    this.ammPriceStates = new Map();
    this.metrics = {
      candidates: 0,
      signals: 0,
      replaySignalsSuppressed: 0,
      reboundTimeouts: 0,
      dropExceededMax: 0,
      reboundExceededMax: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      closed: 0,
      noExit: 0,
      ammPriceOutliersIgnored: 0,
      ammPriceRegimesConfirmed: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    for (const token of this.store.allTokens()) {
      const graduatedAt = finite(token.graduated_at);
      if (graduatedAt && now - graduatedAt <= this.config.trackingAgeMs) {
        this.onGraduated(token);
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
      });
    }

    const replayHorizonMs = Math.max(
      1_000,
      ...[...this.entryProfiles.values()].map((profile) => (
        profile.windowMs + profile.reboundTimeoutMs
      )),
    );
    const replayTrades = [
      ...this.store.recentCurveTrades(now - replayHorizonMs),
      ...this.store.recentAmmTrades(now - replayHorizonMs),
    ].sort((left, right) => left.timestampMs - right.timestampMs);
    for (const trade of replayTrades) {
      this.observeTrade(trade, { replay: true });
    }
    this.advanceTime(now);
  }

  stop() {}

  onGraduated(token) {
    if (!this.config.enabled || !token?.mint) return;
    const graduatedAt = finite(
      token.graduated_at ?? token.graduatedAt ?? token.migratedAt
        ?? token.completedAt ?? token.timestampMs,
    );
    if (!(graduatedAt > 0)) return;
    const current = this.tracked.get(token.mint);
    this.tracked.set(token.mint, {
      mint: token.mint,
      symbol: token.symbol || current?.symbol || null,
      graduatedAt: Math.min(graduatedAt, current?.graduatedAt || graduatedAt),
    });
  }

  trackedMints(now = this.now()) {
    for (const [mint, token] of this.tracked) {
      if (now - token.graduatedAt <= this.config.trackingAgeMs) continue;
      if (this._hasActiveMint(mint)) continue;
      this.tracked.delete(mint);
      for (const detector of this.detectors.values()) detector.states.delete(mint);
      this.ammPriceStates.delete(mint);
    }
    return [...this.tracked.keys()];
  }

  observeTrade(trade, { replay = false } = {}) {
    const price = shadowPrice(trade);
    const timestampMs = finite(trade?.timestampMs);
    if (!this.config.enabled || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade?.market)
      || !trade?.mint
      || !(price > 0) || !(timestampMs > 0)) return;
    if (!this._acceptAmmPrice(trade, price)) return;
    const token = this.store.getToken(trade.mint);
    const graduatedAt = finite(token?.graduated_at ?? this.tracked.get(trade.mint)?.graduatedAt);
    this._observeRowsForMint(trade, price);
    const lifecycleStage = trade.market === 'PUMP_BONDING_CURVE'
      && (!(graduatedAt > 0) || timestampMs < graduatedAt)
      ? 'PRE_MIGRATION'
      : trade.market === 'PUMP_AMM' && graduatedAt > 0 && timestampMs >= graduatedAt
        ? 'POST_MIGRATION'
        : null;
    // A disabled lifecycle stage has no detector. Ignore it here so one
    // research suite cannot abort the shared runtime trade pipeline.
    if (!lifecycleStage || !this.lifecycleStageIds.has(lifecycleStage)) return;
    if (lifecycleStage === 'POST_MIGRATION') {
      if (!this.tracked.has(trade.mint)) this.onGraduated(token);
      if (timestampMs - graduatedAt > this.config.trackingAgeMs
        && !this._hasActiveMint(trade.mint)) return;
    }
    const anchorAt = lifecycleStage === 'POST_MIGRATION'
      ? graduatedAt
      : finite(token?.created_at, timestampMs);
    for (const profile of this.entryProfiles.values()) {
      this._observeDetector(profile, lifecycleStage, trade, price, anchorAt, replay);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const detector of this.detectors.values()) {
      const profile = this.entryProfiles.get(detector.profileId);
      for (const [mint, state] of detector.states) {
        if (state.candidate && now > state.candidate.expiresAt) {
          state.candidate = null;
          this.metrics.reboundTimeouts += 1;
        }
        this._prune(state, now, profile.windowMs);
        if (!state.candidate && now - state.lastTimestampMs > this.config.stateRetentionMs) {
          detector.states.delete(mint);
        }
      }
    }
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateMigratedDropReboundShadowPosition(pending.id, { status: STATUS.NO_ENTRY });
      this.pendingEntries.delete(pending.id);
      this._unindexRow(pending);
      this.metrics.noEntry += 1;
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
      trackedMints: this.tracked.size,
      detectorStates: Object.fromEntries(this.lifecycleStages.map((stage) => [
        stage.id,
        [...this.detectors.values()]
          .filter((detector) => detector.stage === stage.id)
          .reduce((total, detector) => total + detector.states.size, 0),
      ])),
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      lifecycleStages: this.lifecycleStages,
      strategy: {
        scope: 'PRE_MIGRATION_BONDING_CURVE_AND_POST_MIGRATION_PUMP_AMM',
        trackingAgeMs: this.config.trackingAgeMs,
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
      state = { prices: [], lastTimestampMs: 0, dropReady: true, candidate: null };
      states.set(mint, state);
    }
    return state;
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
    });
    this._prune(state, timestampMs, profile.windowMs);

    let rollingPeak = state.prices[0];
    for (const row of state.prices) if (row.price > rollingPeak.price) rollingPeak = row;
    const rollingDropPct = ((price / rollingPeak.price) - 1) * 100;
    if (rollingDropPct > -profile.dropMinPct) state.dropReady = true;
    if (rollingDropPct < -profile.dropMaxPct) state.dropReady = false;

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
            if (reboundPct > profile.reboundMaxPct) {
              this.metrics.reboundExceededMax += 1;
            } else if (replay) {
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
              });
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

  _emitSignal({
    profile,
    lifecycleStage,
    trade,
    price,
    anchorAt,
    candidate,
    dropPct,
    reboundPct,
  }) {
    const stageCode = lifecycleStage === 'PRE_MIGRATION' ? 'PRE' : 'POST';
    const episodeId = `${trade.mint}:${stageCode}:${profile.id}:${candidate.startedAt}:${trade.timestampMs}`;
    this.metrics.signals += 1;
    for (const exitProfile of this.exitProfiles.values()) {
      const cohortId = `${stageCode}_${profile.id}_${exitProfile.id}`;
      const saved = this.store.createMigratedDropReboundShadowPosition({
        cohortId,
        lifecycleStage,
        entryProfileId: profile.id,
        exitProfileId: exitProfile.id,
        episodeId,
        mint: trade.mint,
        symbol: trade.symbol || this.store.getToken(trade.mint)?.symbol || null,
        status: STATUS.PENDING_ENTRY,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
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
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryDelayMs
          + this.config.entryTimeoutMs,
        exitMode: exitProfile.exitMode,
        fixedHoldMs: exitProfile.fixedHoldMs,
        trailingActivationPct: exitProfile.trailingActivationPct,
        trailingStopPct: exitProfile.trailingStopPct,
        hardStopPct: exitProfile.hardStopPct,
        fastTakeProfitPct: exitProfile.fastTakeProfitPct,
        fastTakeProfitWindowMs: exitProfile.fastTakeProfitWindowMs,
        lossCheckAtMs: exitProfile.lossCheckAtMs,
        maxHoldMs: exitProfile.maxHoldMs,
      });
      if (!saved?.inserted) continue;
      const pending = rowPosition(saved);
      this.pendingEntries.set(pending.id, pending);
      this._indexRow(pending);
    }
    this.metrics.lastActionAt = this.now();
  }

  _observeRowsForMint(trade, price) {
    const ids = [...(this.rowsByMint.get(trade.mint) || [])];
    for (const id of ids) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (!this._eligibleEntryTrade(position, trade)) continue;
        if (trade.timestampMs < position.entryTargetAt
          || trade.timestampMs > position.entryDeadlineAt) continue;
        const jumpPct = ((price / position.reboundPrice) - 1) * 100;
        if (jumpPct > this.config.maxEntryPriceJumpPct) {
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
        position.status = STATUS.OPEN;
        position.entryAt = trade.timestampMs;
        position.entryMarket = trade.market;
        position.entryPrice = price;
        position.entryJumpPct = jumpPct;
        position.highestPrice = price;
        position.lowestPrice = price;
        position.lastObservedAt = trade.timestampMs;
        position.lastPrice = price;
        this.store.updateMigratedDropReboundShadowPosition(position.id, {
          status: STATUS.OPEN,
          entryAt: trade.timestampMs,
          entryMarket: trade.market,
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
      this._updateExtrema(position, trade.timestampMs, price);
      this._evaluateExit(position, trade.timestampMs, price);
      if (position.status === STATUS.EXIT_PENDING) {
        if (trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
        else if (trade.timestampMs > position.exitDeadlineAt) this._markNoExit(position);
      }
    }
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
    } else if (position.exitMode === 'LEGACY') {
      if (position.fastTakeProfitPct > 0 && ageMs <= position.fastTakeProfitWindowMs
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
        reason = 'LOSS_CHECK';
        triggerAt = position.entryAt + position.lossCheckAtMs;
      }
      if (!reason && ageMs >= position.maxHoldMs) {
        reason = 'MAX_HOLD';
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
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    this.store.updateMigratedDropReboundShadowPosition(position.id, {
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
    this._unindexRow(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateMigratedDropReboundShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      grossReturnPct: -100,
      netReturnPct: -100 - this.costs.deterministicCostPct,
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
}

module.exports = { MigratedDropReboundShadowSuite, STATUS, shadowPrice };
