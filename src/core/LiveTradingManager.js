'use strict';

const fs = require('fs');
const path = require('path');

const LIVE_RULE_VERSION = 'post_migration_drop_rebound_xleg';

function errorText(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/([?&](?:api-key|api_key|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Authorization:\s*(?:Bearer\s+)?)[^\s]+/gi, '$1[REDACTED]')
    .slice(0, 1_000);
}

function orderExecution(execution, event, submittedAt, finishedAt) {
  return {
    ...(execution || {}),
    manager: {
      triggerType: event.signalVariant?.startsWith('primary_early_')
        ? 'PRIMARY_THRESHOLD'
        : (event.strategyId ? 'LIVE_STRATEGY' : (event.signalId ? 'PRIMARY_SIGNAL' : 'LEGACY_EVENT')),
      strategyId: event.strategyId || null,
      episodeId: event.episodeId || null,
      signalId: event.signalId || null,
      signalEpisodeId: event.signalEpisodeId || null,
      signalSlot: Number.isSafeInteger(Number(event.slot)) ? Number(event.slot) : null,
      signalTimestampMs: event.timestampMs || null,
      signalPersistedAtMs: event.receivedAtMs || null,
      signalToEntryStartMs: Number.isFinite(event.timestampMs)
        ? submittedAt - event.timestampMs
        : null,
      eventSlot: Number.isSafeInteger(Number(event.slot)) ? Number(event.slot) : null,
      eventTimestampMs: event.timestampMs || null,
      eventReceivedAtMs: event.receivedAtMs || null,
      entryStartedAtMs: submittedAt,
      entryFinishedAtMs: finishedAt,
      eventToEntryStartMs: Number.isFinite(event.timestampMs)
        ? submittedAt - event.timestampMs
        : null,
      receiveToEntryStartMs: Number.isFinite(event.receivedAtMs)
        ? submittedAt - event.receivedAtMs
        : null,
      managerElapsedMs: finishedAt - submittedAt,
    },
  };
}

function restoredPosition(row) {
  return {
    id: row.id,
    decisionId: row.decision_id,
    primaryDecisionId: row.primary_decision_id,
    strategyDecisionId: row.strategy_decision_id,
    strategyId: row.strategy_id,
    signalId: row.signal_id,
    sourceType: row.source_type,
    mint: row.mint,
    triggerWallet: row.trigger_wallet,
    mode: row.mode,
    status: row.status,
    positionSol: row.position_sol,
    tokenAmountRaw: row.token_amount_raw,
    entryMarket: row.entry_market,
    entryPrice: row.entry_price,
    entrySignature: row.entry_signature,
    entryError: row.entry_error,
    highestPrice: row.highest_price,
    exitReason: row.exit_reason,
    exitError: row.exit_error,
    openedAt: row.opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class LiveTradingManager {
  constructor({ config, store, executor = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.executor = executor;
    this.now = now;
    this.mode = !config.enabled ? 'DISABLED' : (config.dryRun ? 'DRY_RUN' : 'LIVE');
    this.strategies = new Map((config.strategies || [])
      .filter((strategy) => strategy.enabled !== false)
      .map((strategy) => [strategy.id, strategy]));
    this.entryStrategies = new Map([...this.strategies]
      .filter(([, strategy]) => strategy.entryEnabled !== false));
    this.detectorStrategies = new Map([...this.entryStrategies]
      .filter(([, strategy]) => !strategy.signalSource));
    this.tracked = new Map();
    this.detectors = new Map([...this.detectorStrategies.keys()].map((id) => [id, new Map()]));
    this.ammPriceStates = new Map();
    this.positions = new Map();
    this.timers = new Map();
    this.pending = new Set();
    this.coreExitPending = new Set();
    this.entryQueue = Promise.resolve();
    this.stopping = false;
    this.metrics = {
      evaluated: 0,
      matched: 0,
      riskRejected: 0,
      entries: 0,
      entryFailures: 0,
      entryUnknown: 0,
      entryRecoveries: 0,
      exits: 0,
      exitFailures: 0,
      lastActionAt: null,
      lastError: null,
      candidates: 0,
      signals: 0,
    };
  }

  start() {
    for (const row of this.store.activeLivePositions()) {
      const position = restoredPosition(row);
      position.strategy = this.strategies.get(position.strategyId) || null;
      if (position.strategy?.exitMode === 'GRADUATION_CORE_RUNNER') {
        const token = this.store.getToken(position.mint);
        position.graduatedAt = Number(token?.graduated_at) || null;
        const lastSell = this.store.latestLiveOrderForPositionSide(position.id, 'SELL');
        const partialSell = this.store.confirmedPartialLiveOrderForPosition(position.id);
        position.coreExited = Boolean(partialSell);
        position.coreExitAttempted = Boolean(lastSell);
        if (position.coreExited) position.highestPrice = Number(row.highest_price) || 0;
      }
      this.positions.set(position.mint, position);
      if (position.mode === 'LIVE' && this.mode !== 'LIVE') {
        this.metrics.lastError = 'ACTIVE_LIVE_POSITION_REQUIRES_LIVE_MODE';
        continue;
      }
      const unresolvedEntry = position.mode === 'LIVE'
        && !position.tokenAmountRaw
        && (position.status === 'OPENING'
          || position.exitReason === 'ENTRY_CONFIRMATION_UNKNOWN');
      if (unresolvedEntry && this.mode === 'LIVE') {
        const order = this.store.latestLiveOrderForPositionSide(position.id, 'BUY');
        const recovery = this._recoverUnknownEntry(position, {
          orderId: order?.id || null,
          initialError: position.entryError || position.exitError,
        });
        this._track(recovery);
        continue;
      }
      if (position.status === 'OPENING' || position.status === 'EXITING') {
        position.status = 'EXIT_FAILED';
        this.store.updateLivePosition(position.id, {
          status: 'EXIT_FAILED',
          exitReason: 'RESTART_RECOVERY',
          exitError: 'Process restarted during an unconfirmed position transition',
        });
        this._requestExit(position, 'RESTART_RECOVERY', null);
      } else if (this.mode !== 'DISABLED') this._armPositionExit(position);
    }
    // Versions before the receipt-based reconciliation fix could close a
    // confirmed Token-2022 buy while its ATA was still absent from the RPC
    // account index. Recheck those exact historical false-empty rows on boot.
    if (this.mode === 'LIVE' && typeof this.store.confirmedEmptyLivePositions === 'function') {
      for (const row of this.store.confirmedEmptyLivePositions()) {
        if (this.positions.has(row.mint)) continue;
        const position = restoredPosition(row);
        position.strategy = this.strategies.get(position.strategyId) || null;
        position.status = 'EXIT_FAILED';
        position.tokenAmountRaw = null;
        position.exitReason = 'ENTRY_CONFIRMATION_UNKNOWN';
        this.positions.set(position.mint, position);
        this.store.reopenLivePositionForReconciliation(
          position.id,
          'Rechecking a legacy confirmed-empty entry against transaction metadata',
        );
        const order = this.store.latestLiveOrderForPositionSide(position.id, 'BUY');
        this._track(this._recoverUnknownEntry(position, {
          orderId: order?.id || null,
          initialError: 'LEGACY_CONFIRMED_EMPTY_RECHECK',
        }));
      }
    }
    if (this._trackingEnabled()) {
      const now = this.now();
      for (const token of this.store.allTokens()) {
        const graduatedAt = Number(token.graduated_at);
        if (graduatedAt > 0 && now - graduatedAt <= this._maxTrackingAgeMs()) {
          this.onGraduated(token);
        }
      }
    }
    if (this.mode === 'LIVE' && this.executor?.transactionSettlement
      && typeof this.store.unsettledLiveOrders === 'function') {
      this._track(this._reconcileHistoricalSettlements());
    }
  }

  async _reconcileOrderSettlement({ orderId, positionId, signature, attempts = 5 }) {
    if (!signature || !this.executor?.transactionSettlement) return null;
    const delayMs = Math.max(250, Number(this.config.entryReconcileDelayMs) || 1_000);
    for (let attempt = 1; attempt <= attempts && !this.stopping; attempt += 1) {
      try {
        const settlement = await this.executor.transactionSettlement(signature);
        if (settlement && Number.isFinite(settlement.walletSolDelta)) {
          this.store.updateLiveOrderSettlement(orderId, settlement);
          return this.store.refreshLivePositionSettlement(positionId);
        }
      } catch (error) {
        if (attempt === attempts) this._rememberError(error);
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  async _reconcileHistoricalSettlements() {
    const rows = this.store.unsettledLiveOrders(500);
    const concurrency = 4;
    for (let index = 0; index < rows.length && !this.stopping; index += concurrency) {
      const batch = rows.slice(index, index + concurrency);
      await Promise.allSettled(batch.map((row) => this._reconcileOrderSettlement({
        orderId: row.id,
        positionId: row.position_id,
        signature: row.signature,
        attempts: 1,
      })));
    }
  }

  health() {
    return {
      mode: this.mode,
      enabled: this.config.enabled,
      requestedEnabled: this.config.requestedEnabled,
      safetyLock: this.config.safetyLock,
      dryRun: this.config.dryRun,
      strategies: [...this.strategies.values()].map((strategy) => ({
        ...strategy,
        mode: this.mode,
        ruleVersion: strategy.ruleVersion || LIVE_RULE_VERSION,
        activePositions: [...this.positions.values()]
          .filter((position) => position.strategyId === strategy.id).length,
      })),
      maxConcurrentPositions: this.config.maxConcurrentPositions,
      minWalletReserveSol: this.config.minWalletReserveSol,
      buySlippagePct: this.config.buySlippagePct ?? this.config.slippagePct,
      sellSlippagePct: this.config.sellSlippagePct ?? this.config.slippagePct,
      computeUnitLimit: this.config.computeUnitLimit,
      priorityFeeSol: this.config.priorityFeeSol,
      priorityFeeMicroLamports: this.config.priorityFeeMicroLamports,
      trackedMints: this.tracked.size,
      activePositions: this.positions.size,
      killSwitchActive: this._killSwitchActive(),
      ...this.metrics,
    };
  }

  onSignal() {
    // Legacy Primary live entry is intentionally retired. Primary signals remain
    // fully persisted and may still feed independent Shadow research.
    return null;
  }

  onExternalStrategySignal(event) {
    const strategy = this.strategies.get(event?.strategyId);
    if (!strategy || !event?.mint || !event?.episodeId) return null;
    this.metrics.evaluated += 1;
    this.metrics.matched += 1;
    this.metrics.signals += 1;
    const decision = this.store.recordLiveStrategyDecision({
      strategyId: strategy.id,
      episodeId: event.episodeId,
      timestampMs: event.timestampMs,
      receivedAtMs: event.receivedAtMs || event.timestampMs,
      mint: event.mint,
      symbol: event.symbol || null,
      ruleVersion: strategy.ruleVersion || LIVE_RULE_VERSION,
      market: event.market || strategy.market,
      referencePrice: event.price,
      features: {
        ...(event.features || {}),
        maxEntryPriceJumpPct: strategy.maxEntryPriceJumpPct,
        maxEntrySelfImpactPct: strategy.maxEntrySelfImpactPct
          ?? this.config.maxEntrySelfImpactPct,
      },
      ruleMatched: true,
      rejectionReasons: [],
      mode: this.mode,
      actionStatus: strategy.entryEnabled === false
        ? 'MATCHED_ENTRY_DISABLED'
        : (this.mode === 'DISABLED' ? 'MATCHED_DISABLED' : 'QUEUED'),
    });
    if (!decision?.inserted || strategy.entryEnabled === false
      || this.mode === 'DISABLED' || this.stopping) return decision;
    this.entryQueue = this.entryQueue
      .then(() => this._enter(decision, event))
      .catch((error) => this._rememberError(error));
    this._track(this.entryQueue);
    return decision;
  }

  onGraduated(token) {
    if (!token?.mint) return;
    const graduatedAt = Number(
      token.graduated_at ?? token.graduatedAt ?? token.migratedAt
        ?? token.completedAt ?? token.timestampMs,
    );
    if (!(graduatedAt > 0)) return;
    if (this._trackingEnabled()) {
      const current = this.tracked.get(token.mint);
      this.tracked.set(token.mint, {
        mint: token.mint,
        symbol: token.symbol || current?.symbol || null,
        graduatedAt: Math.min(graduatedAt, current?.graduatedAt || graduatedAt),
      });
    }
    const position = this.positions.get(token.mint);
    if (position?.strategy?.exitMode === 'GRADUATION_CORE_RUNNER') {
      position.graduatedAt = position.graduatedAt || graduatedAt;
      this._scheduleMaxHold(position);
    }
  }

  trackedMints(now = this.now()) {
    for (const [mint, token] of this.tracked) {
      if (now - token.graduatedAt <= this._maxTrackingAgeMs()) continue;
      if (this.positions.has(mint)) continue;
      this.tracked.delete(mint);
      for (const states of this.detectors.values()) states.delete(mint);
      this.ammPriceStates.delete(mint);
    }
    return [...new Set([
      ...this.tracked.keys(),
      ...[...this.positions.values()]
        .filter((position) => position.graduatedAt || this.store.getToken(position.mint)?.graduated_at)
        .map((position) => position.mint),
    ])];
  }

  observeTrade(trade) {
    const ammPrice = Number(trade?.reservePrice) > 0
      ? Number(trade.reservePrice)
      : Number(trade?.price);
    const observedTrade = trade?.market === 'PUMP_AMM' && ammPrice > 0
      ? { ...trade, price: ammPrice }
      : trade;
    if (observedTrade?.market === 'PUMP_AMM' && observedTrade?.mint && ammPrice > 0) {
      const token = this.store.getToken(observedTrade.mint);
      const graduatedAt = Number(token?.graduated_at
        ?? this.tracked.get(observedTrade.mint)?.graduatedAt);
      if (graduatedAt > 0 && !this.tracked.has(observedTrade.mint)) this.onGraduated(token);
      if (this.tracked.has(observedTrade.mint) && this._acceptAmmPrice(observedTrade)) {
        for (const strategy of this.detectorStrategies.values()) {
          this._observeStrategy(strategy, observedTrade, graduatedAt);
        }
      }
    }

    const position = this.positions.get(observedTrade?.mint);
    if (!position || !Number.isFinite(observedTrade.price) || observedTrade.price <= 0) {
      return;
    }
    if (position.status !== 'OPEN') return;
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    const graduatedAt = Number(this.store.getToken(observedTrade.mint)?.graduated_at)
      || position.graduatedAt;
    if (strategy?.exitMode === 'GRADUATION_CORE_RUNNER') {
      if (graduatedAt) {
        position.graduatedAt = position.graduatedAt || graduatedAt;
        if (observedTrade.market !== 'PUMP_AMM'
          || observedTrade.timestampMs < graduatedAt) return;
        if (!position.coreExited) {
          this._requestCoreExit(position);
          return;
        }
      } else if (observedTrade.market !== 'PUMP_BONDING_CURVE') return;
    } else if (observedTrade.market === 'PUMP_AMM') {
      const token = this.store.getToken(observedTrade.mint);
      if (!token?.graduated_at || observedTrade.timestampMs < token.graduated_at) return;
      if (position.entryPrice > 0) {
        const ratio = observedTrade.price / position.entryPrice;
        if (ratio < 0.05 || ratio > 20) return;
      }
    } else if (observedTrade.market !== 'PUMP_BONDING_CURVE') return;

    const highest = Math.max(Number(position.highestPrice) || 0, observedTrade.price);
    position.lastObservedPrice = observedTrade.price;
    if (highest !== position.highestPrice) {
      position.highestPrice = highest;
      this.store.updateLivePosition(position.id, { highestPrice: highest });
    }
    if (!(position.entryPrice > 0)) return;
    this._evaluatePositionExit(position, observedTrade.timestampMs, observedTrade.price);
  }

  advanceTime(now = this.now()) {
    for (const states of this.detectors.values()) {
      for (const [mint, state] of states) {
        if (state.candidate && now > state.candidate.expiresAt) state.candidate = null;
        if (!state.candidate && now - state.lastTimestampMs > 60_000) states.delete(mint);
      }
    }
    for (const position of this.positions.values()) {
      if (position.status === 'OPEN' && position.lastObservedPrice > 0) {
        this._evaluatePositionExit(position, now, position.lastObservedPrice);
      }
    }
    this.trackedMints(now);
  }

  async stop() {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.pending]);
  }

  _track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
  }

  _rememberError(error) {
    this.metrics.lastError = errorText(error);
    this.metrics.lastActionAt = this.now();
  }

  _updatePositionDecision(position, actionStatus, actionReason = null) {
    if (position.strategyDecisionId) {
      this.store.updateLiveStrategyDecision(
        position.strategyDecisionId,
        actionStatus,
        actionReason,
      );
    } else if (position.primaryDecisionId) {
      this.store.updatePrimaryLiveDecision(
        position.primaryDecisionId,
        actionStatus,
        actionReason,
      );
    } else if (position.decisionId) {
      this.store.updateSmartOpenDecision(position.decisionId, actionStatus, actionReason);
    }
  }

  _killSwitchActive() {
    if (!this.config.killSwitchFile) return false;
    return fs.existsSync(path.resolve(this.config.killSwitchFile));
  }

  _trackingEnabled() {
    // DISABLED is execution-disabled, not observation-disabled. Keep recording
    // strategy matches so a safety-locked deployment still produces evidence.
    return this.detectorStrategies.size > 0;
…5825 tokens truncated…D_UNOBSERVED';
      this.store.updateLivePosition(position.id, {
        status: 'ENTRY_FAILED',
        entrySignature: signature,
        entryError: failure,
        exitReason: 'ENTRY_EXPIRED_UNOBSERVED',
        exitError: null,
      });
      this._updatePositionDecision(position, 'ENTRY_FAILED', 'ENTRY_EXPIRED_UNOBSERVED');
      this.positions.delete(position.mint);
      this.metrics.entryFailures += 1;
      this.metrics.lastActionAt = reconciledAt;
      return 'FAILED';
    }

    if (orderId) {
      this.store.updateLiveOrder(orderId, {
        status: 'CONFIRMATION_UNKNOWN',
        error: unresolved,
      });
    }
    position.status = 'EXIT_FAILED';
    position.entryError = unresolved;
    position.exitReason = 'ENTRY_CONFIRMATION_UNKNOWN';
    this.store.updateLivePosition(position.id, {
      status: 'EXIT_FAILED',
      entrySignature: signature,
      entryError: unresolved,
      exitReason: 'ENTRY_CONFIRMATION_UNKNOWN',
      exitError: unresolved,
    });
    this._updatePositionDecision(
      position,
      'ENTRY_CONFIRMATION_UNKNOWN',
      unresolved,
    );
    this.metrics.entryUnknown += 1;
    this.metrics.lastActionAt = reconciledAt;
    this.metrics.lastError = unresolved;
    if (signature && signatureExpired && unknownAgeMs < expiredReleaseMs) {
      this._scheduleUnknownEntryRecovery(position, orderId, expiredReleaseMs - unknownAgeMs);
    }
    return 'UNKNOWN';
  }

  _scheduleUnknownEntryRecovery(position, orderId, delayMs) {
    if (this.timers.has(position.id)) clearTimeout(this.timers.get(position.id));
    const timer = setTimeout(() => {
      this.timers.delete(position.id);
      if (this.stopping || !this.positions.has(position.mint)) return;
      this._track(this._recoverUnknownEntry(position, {
        orderId,
        initialError: position.entryError,
      }));
    }, Math.max(100, delayMs));
    if (timer.unref) timer.unref();
    this.timers.set(position.id, timer);
  }

  _armPositionExit(position) {
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    if (strategy?.exitMode === 'FIXED_HOLD') {
      this._scheduleMaxHold(position);
      return;
    }
    if (strategy?.exitMode === 'GRADUATION_CORE_RUNNER') {
      const token = this.store.getToken(position.mint);
      const graduatedAt = Number(token?.graduated_at) || position.graduatedAt;
      if (graduatedAt) {
        position.graduatedAt = graduatedAt;
      }
      this._scheduleMaxHold(position);
      return;
    }
    const lastPrice = position.lastObservedPrice == null
      ? Number.NaN
      : Number(position.lastObservedPrice);
    const drawdownPct = Number.isFinite(lastPrice) && position.highestPrice > 0
      ? ((lastPrice / position.highestPrice) - 1) * 100
      : 0;
    const peakReturnPct = position.entryPrice > 0 && position.highestPrice > 0
      ? ((position.highestPrice / position.entryPrice) - 1) * 100
      : 0;
    if (peakReturnPct >= (strategy?.trailingActivationPct || 0)
      && drawdownPct <= -(strategy?.trailingStopPct || 0)) {
      this._requestExit(position, 'TRAILING_XLEG', lastPrice);
    } else {
      this._scheduleMaxHold(position);
    }
  }

  _scheduleMaxHold(position) {
    if (this.timers.has(position.id)) clearTimeout(this.timers.get(position.id));
    const openedAt = position.openedAt || position.createdAt || this.now();
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    const graduationRunner = strategy?.exitMode === 'GRADUATION_CORE_RUNNER';
    const anchorAt = graduationRunner && position.graduatedAt ? position.graduatedAt : openedAt;
    const holdMs = graduationRunner
      ? (position.graduatedAt
        ? strategy.maxPostGraduationHoldMs
        : strategy.maxPreGraduationHoldMs)
      : (strategy?.maxHoldMs || this.config.maxHoldMs);
    const reason = graduationRunner
      ? (position.graduatedAt ? 'MAX_POST_GRAD_RUNNER' : 'MAX_PRE_GRAD_HOLD')
      : (strategy?.exitMode === 'FIXED_HOLD'
        ? `FIXED_HOLD_${strategy.fixedHoldMs || holdMs}MS`
        : 'MAX_HOLD');
    const delay = Math.max(0, anchorAt + holdMs - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(position.id);
      this._requestExit(position, reason, null);
    }, delay);
    if (timer.unref) timer.unref();
    this.timers.set(position.id, timer);
  }

  _evaluatePositionExit(position, timestampMs, price) {
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    if (!strategy || position.status !== 'OPEN' || !(position.entryPrice > 0) || !(price > 0)) return;
    const ageMs = timestampMs - position.openedAt;
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    const drawdownPct = ((price / position.highestPrice) - 1) * -100;
    let reason = null;
    if (strategy.exitMode === 'FIXED_HOLD') {
      if (strategy.hardStopPct > 0 && grossReturnPct <= -strategy.hardStopPct) {
        reason = 'HARD_STOP';
      } else if (ageMs >= strategy.fixedHoldMs) {
        reason = `FIXED_HOLD_${strategy.fixedHoldMs}MS`;
      }
      if (reason) this._requestExit(position, reason, price);
      return;
    }
    if (strategy.exitMode === 'GRADUATION_CORE_RUNNER') {
      if (strategy.hardStopPct > 0 && grossReturnPct <= -strategy.hardStopPct) {
        this._requestExit(position, 'HARD_STOP', price);
        return;
      }
      if (!position.graduatedAt) {
        if (ageMs >= strategy.maxPreGraduationHoldMs) {
          this._requestExit(position, 'MAX_PRE_GRAD_HOLD', price);
        }
        return;
      }
      if (!position.coreExited) return;
      let tierIndex = -1;
      for (let index = 0; index < strategy.trailingTiers.length; index += 1) {
        if (peakReturnPct >= strategy.trailingTiers[index].activationPct) tierIndex = index;
      }
      if (tierIndex >= 0) {
        const tier = strategy.trailingTiers[tierIndex];
        if (drawdownPct >= tier.drawdownPct) {
          reason = `RUNNER_STAIR_T${tier.activationPct}_D${tier.drawdownPct}`;
        }
      }
      if (!reason && timestampMs - position.graduatedAt >= strategy.maxPostGraduationHoldMs) {
        reason = 'MAX_POST_GRAD_RUNNER';
      }
      if (reason) this._requestExit(position, reason, price);
      return;
    }
    if (strategy.fastTakeProfitPct > 0 && ageMs <= strategy.fastTakeProfitWindowMs
      && grossReturnPct >= strategy.fastTakeProfitPct) reason = 'FAST_TAKE_PROFIT';
    if (!reason && peakReturnPct >= strategy.trailingActivationPct
      && drawdownPct >= strategy.trailingStopPct) reason = 'TRAILING_XLEG';
    if (!reason && strategy.lossCheckAtMs > 0 && ageMs >= strategy.lossCheckAtMs
      && grossReturnPct < 0) reason = 'LOSS_CHECK';
    if (!reason && ageMs >= strategy.maxHoldMs) reason = 'MAX_HOLD';
    if (reason) this._requestExit(position, reason, price);
  }

  _requestCoreExit(position) {
    const strategy = position?.strategy || this.strategies.get(position?.strategyId);
    if (this.stopping || !position || position.status !== 'OPEN'
      || position.coreExited || position.coreExitAttempted
      || strategy?.exitMode !== 'GRADUATION_CORE_RUNNER'
      || this.coreExitPending.has(position.id)) return;
    position.coreExitAttempted = true;
    this.coreExitPending.add(position.id);
    const promise = this._takeGraduationCore(position)
      .catch((error) => this._rememberError(error))
      .finally(() => this.coreExitPending.delete(position.id));
    this._track(promise);
  }

  async _takeGraduationCore(position) {
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    const balanceRaw = BigInt(position.tokenAmountRaw || 0);
    const sellRaw = (balanceRaw * BigInt(Math.round(strategy.coreExitPct))) / 100n;
    if (sellRaw <= 0n) throw new Error('Graduation core exit has no token balance');
    const submittedAt = this.now();
    try {
      const result = position.mode === 'DRY_RUN'
        ? {
          signature: `DRY-CORE-${position.strategyDecisionId}`,
          venue: 'PUMP_AMM',
          tokenAmountRaw: sellRaw.toString(),
          remainingTokenAmountRaw: (balanceRaw - sellRaw).toString(),
          balanceVerified: true,
        }
        : await this.executor.sell({
          mint: position.mint,
          tokenAmountRaw: sellRaw.toString(),
        });
      if (result.alreadyEmpty || result.balanceVerified === false) {
        throw new Error(result.balanceCheckError || 'Graduation core exit balance is unavailable');
      }
      const remainingRaw = result.remainingTokenAmountRaw == null
        ? balanceRaw - sellRaw
        : BigInt(result.remainingTokenAmountRaw);
      if (remainingRaw <= 0n) {
        throw new Error('Graduation core exit unexpectedly sold the complete position');
      }
      const confirmedAt = this.now();
      const settlement = result.settlement || null;
      const orderId = this.store.recordLiveOrder({
        positionId: position.id,
        strategyDecisionId: position.strategyDecisionId,
        strategyId: position.strategyId,
        mint: position.mint,
        side: 'SELL',
        venue: result.venue,
        attempt: 1,
        requestedTokenRaw: result.tokenAmountRaw || sellRaw.toString(),
        status: 'CONFIRMED_PARTIAL',
        signature: result.signature,
        walletSolDelta: settlement?.walletSolDelta,
        networkFeeSol: settlement?.networkFeeSol,
        execution: {
          settlement,
          liveExitStage: 'GRADUATION_CORE',
          coreExitPct: strategy.coreExitPct,
          remainingTokenAmountRaw: remainingRaw.toString(),
        },
        submittedAt,
        confirmedAt,
      });
      position.coreExited = true;
      position.tokenAmountRaw = remainingRaw.toString();
      position.highestPrice = 0;
      position.lastObservedPrice = null;
      this.store.updateLivePosition(position.id, {
        tokenAmountRaw: position.tokenAmountRaw,
        highestPrice: 0,
        exitReason: `GRADUATION_CORE_${strategy.coreExitPct}_CONFIRMED`,
        exitError: null,
      });
      this.store.refreshLivePositionSettlement(position.id);
      if (position.mode === 'LIVE' && !settlement && result.signature) {
        this._track(this._reconcileOrderSettlement({
          orderId,
          positionId: position.id,
          signature: result.signature,
        }));
      }
      this.metrics.lastActionAt = confirmedAt;
    } catch (error) {
      this.store.recordLiveOrder({
        positionId: position.id,
        strategyDecisionId: position.strategyDecisionId,
        strategyId: position.strategyId,
        mint: position.mint,
        side: 'SELL',
        venue: 'PUMP_AMM',
        attempt: 1,
        requestedTokenRaw: sellRaw.toString(),
        status: error.signature ? 'CONFIRMATION_UNKNOWN' : 'FAILED',
        signature: error.signature,
        error: errorText(error),
        execution: error.execution || { liveExitStage: 'GRADUATION_CORE' },
        submittedAt,
      });
      this.store.updateLivePosition(position.id, {
        exitReason: 'GRADUATION_CORE_EXIT_FAILED',
        exitError: errorText(error),
      });
      this.metrics.exitFailures += 1;
      throw error;
    }
  }

  _requestExit(position, reason, observedPrice) {
    if (this.stopping || !position || !['OPEN', 'EXIT_FAILED'].includes(position.status)) return;
    if (this.coreExitPending.has(position.id)) {
      const timer = setTimeout(() => this._requestExit(position, reason, observedPrice), 1_000);
      if (timer.unref) timer.unref();
      this.timers.set(position.id, timer);
      return;
    }
    position.status = 'EXITING';
    this.store.updateLivePosition(position.id, {
      status: 'EXITING',
      exitReason: reason,
      exitPrice: observedPrice,
      exitRequestedAt: this.now(),
    });
    const promise = this._exit(position, reason, observedPrice)
      .catch((error) => this._rememberError(error));
    this._track(promise);
  }

  async _exit(position, reason, observedPrice) {
    const attempts = this.config.exitRetryCount + 1;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts && !this.stopping; attempt += 1) {
      const submittedAt = this.now();
      try {
        const result = position.mode === 'DRY_RUN'
          ? {
            signature: `DRY-SELL-${position.strategyDecisionId
              || position.primaryDecisionId || position.decisionId}`,
            venue: this.store.getToken(position.mint)?.graduated_at
              ? 'PUMP_AMM' : 'PUMP_BONDING_CURVE',
            tokenAmountRaw: position.tokenAmountRaw,
          }
          : await this.executor.sell({
            mint: position.mint,
          });
        if (result.alreadyEmpty
          && ['ENTRY_CONFIRMATION_UNKNOWN', 'RESTART_RECOVERY'].includes(reason)) {
          throw new Error('Entry state is still unresolved; no token balance is visible yet');
        }
        const closedAt = this.now();
        const remainingTokenAmountRaw = result.remainingTokenAmountRaw == null
          ? null
          : BigInt(result.remainingTokenAmountRaw);
        const residualBalance = remainingTokenAmountRaw !== null
          && remainingTokenAmountRaw > 0n;
        const balanceUnverified = result.balanceVerified === false;
        const incompleteReason = balanceUnverified
          ? `Sell confirmed but balance verification failed: ${result.balanceCheckError || 'unknown error'}`
          : residualBalance
            ? `Sell confirmed with ${remainingTokenAmountRaw.toString()} raw tokens remaining`
            : null;
        const orderStatus = result.alreadyEmpty
          ? 'ALREADY_EMPTY'
          : balanceUnverified
            ? 'CONFIRMED_UNVERIFIED'
            : residualBalance
              ? 'CONFIRMED_PARTIAL'
              : 'CONFIRMED';
        const settlement = result.settlement || null;
        const orderId = this.store.recordLiveOrder({
          positionId: position.id,
          decisionId: position.decisionId,
          primaryDecisionId: position.primaryDecisionId,
          strategyDecisionId: position.strategyDecisionId,
          strategyId: position.strategyId,
          mint: position.mint,
          side: 'SELL',
          venue: result.venue,
          attempt,
          requestedTokenRaw: result.tokenAmountRaw || position.tokenAmountRaw,
          status: orderStatus,
          signature: result.signature,
          walletSolDelta: settlement?.walletSolDelta,
          networkFeeSol: settlement?.networkFeeSol,
          execution: settlement ? { settlement } : null,
          error: incompleteReason,
          submittedAt,
          confirmedAt: closedAt,
        });
        if (balanceUnverified || residualBalance) {
          lastError = new Error(incompleteReason);
          this.store.updateLivePosition(position.id, {
            exitMarket: result.venue,
            exitSignature: result.signature,
            exitError: incompleteReason,
          });
          if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, this.config.exitRetryDelayMs));
          }
          continue;
        }
        this.store.updateLivePosition(position.id, {
          status: 'CLOSED',
          exitMarket: result.venue,
          exitPrice: observedPrice,
          exitSignature: result.signature,
          exitReason: reason,
          closedAt,
        });
        this.store.refreshLivePositionSettlement(position.id);
        if (position.mode === 'LIVE' && !settlement && result.signature) {
          this._track(this._reconcileOrderSettlement({
            orderId,
            positionId: position.id,
            signature: result.signature,
          }));
        }
        this._updatePositionDecision(position, 'CLOSED', reason);
        position.status = 'CLOSED';
        this.positions.delete(position.mint);
        const timer = this.timers.get(position.id);
        if (timer) clearTimeout(timer);
        this.timers.delete(position.id);
        this.metrics.exits += 1;
        this.metrics.lastActionAt = closedAt;
        return;
      } catch (error) {
        lastError = error;
        const settlement = error.execution?.settlement || null;
        const orderId = this.store.recordLiveOrder({
          positionId: position.id,
          decisionId: position.decisionId,
          primaryDecisionId: position.primaryDecisionId,
          strategyDecisionId: position.strategyDecisionId,
          strategyId: position.strategyId,
          mint: position.mint,
          side: 'SELL',
          attempt,
          requestedTokenRaw: position.tokenAmountRaw,
          status: 'FAILED',
          signature: error.signature,
          error: errorText(error),
          walletSolDelta: settlement?.walletSolDelta,
          networkFeeSol: settlement?.networkFeeSol,
          execution: error.execution || null,
          submittedAt,
        });
        if (position.mode === 'LIVE' && !settlement && error.signature) {
          this._track(this._reconcileOrderSettlement({
            orderId,
            positionId: position.id,
            signature: error.signature,
          }));
        }
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, this.config.exitRetryDelayMs));
        }
      }
    }
    position.status = 'EXIT_FAILED';
    this.store.updateLivePosition(position.id, {
      status: 'EXIT_FAILED',
      exitReason: reason,
      exitError: errorText(lastError),
    });
    this._updatePositionDecision(
      position,
      'EXIT_FAILED',
      errorText(lastError),
    );
    this.metrics.exitFailures += 1;
    this._rememberError(lastError);
  }
}

module.exports = LiveTradingManager;
