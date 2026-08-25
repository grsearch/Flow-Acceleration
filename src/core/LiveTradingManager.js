'use strict';

const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');
const { executableSell } = require('./ShadowExecutionModel');

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

function rawTokenUnits(value) {
  try {
    const raw = BigInt(value || 0);
    return raw > 0n ? Number(raw) / 1e6 : null;
  } catch (_) {
    return null;
  }
}

function rawSol(value) {
  try {
    const raw = BigInt(value || 0);
    return raw >= 0n ? Number(raw) / 1e9 : null;
  } catch (_) {
    return null;
  }
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
    this.settlementOrdersInFlight = new Set();
    this.settlementSweepPromise = null;
    this.nextSettlementSweepAt = 0;
    this.coreExitPending = new Set();
    this.mintExitQueues = new Map();
    this.graduationGateTrades = new Map();
    this.entryQueue = Promise.resolve();
    this.stopping = false;
    this.metrics = {
      evaluated: 0,
      matched: 0,
      riskRejected: 0,
      entries: 0,
      entryFailures: 0,
      entryMigrationsBeforeSubmit: 0,
      entryPreSubmitRejected: 0,
      entryTransactionFailures: 0,
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

  _addPosition(position) {
    this.positions.set(Number(position.id), position);
  }

  _removePosition(position) {
    this.positions.delete(Number(position?.id));
  }

  _hasPosition(position) {
    return this.positions.has(Number(position?.id));
  }

  _positionsForMint(mint) {
    if (!mint) return [];
    return [...this.positions.values()].filter((position) => position.mint === mint);
  }

  _hasActiveMint(mint) {
    return this._positionsForMint(mint).length > 0;
  }

  start() {
    for (const row of this.store.activeLivePositions()) {
      const position = restoredPosition(row);
      position.strategy = this.strategies.get(position.strategyId) || null;
      if (['GRADUATION_CORE_RUNNER', 'PBR_CORE_RUNNER']
        .includes(position.strategy?.exitMode)) {
        const token = this.store.getToken(position.mint);
        position.graduatedAt = Number(token?.graduated_at) || null;
        const lastSell = this.store.latestLiveOrderForPositionSide(position.id, 'SELL');
        const partialSell = this.store.confirmedPartialLiveOrderForPosition(position.id);
        position.coreExited = Boolean(partialSell);
        position.coreExitAttempted = Boolean(lastSell);
        if (position.coreExited) position.highestPrice = Number(row.highest_price) || 0;
      }
      this._addPosition(position);
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
        if (this.positions.has(Number(row.id))) continue;
        const position = restoredPosition(row);
        position.strategy = this.strategies.get(position.strategyId) || null;
        position.status = 'EXIT_FAILED';
        position.tokenAmountRaw = null;
        position.exitReason = 'ENTRY_CONFIRMATION_UNKNOWN';
        this._addPosition(position);
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
      this._scheduleSettlementReconciliation(this.now(), true);
    }
  }

  async _reconcileOrderSettlement({ orderId, positionId, signature, attempts = 5 }) {
    if (!signature || !this.executor?.transactionSettlement) return null;
    const key = Number(orderId);
    if (this.settlementOrdersInFlight.has(key)) return null;
    this.settlementOrdersInFlight.add(key);
    const delayMs = Math.max(250, Number(this.config.entryReconcileDelayMs) || 1_000);
    try {
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
    } finally {
      this.settlementOrdersInFlight.delete(key);
    }
  }

  async _reconcileHistoricalSettlements() {
    const rows = this.store.unsettledLiveOrders(2_000);
    for (const positionId of new Set(rows.map((row) => row.position_id))) {
      this.store.refreshLivePositionSettlement(positionId);
    }
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

  _scheduleSettlementReconciliation(now = this.now(), force = false) {
    if (this.mode !== 'LIVE' || this.stopping || !this.executor?.transactionSettlement
      || typeof this.store.unsettledLiveOrders !== 'function') return;
    if (this.settlementSweepPromise || (!force && now < this.nextSettlementSweepAt)) return;
    this.nextSettlementSweepAt = now + 30_000;
    const sweep = this._reconcileHistoricalSettlements()
      .catch((error) => {
        this._rememberError(error);
      })
      .finally(() => {
        if (this.settlementSweepPromise === sweep) this.settlementSweepPromise = null;
      });
    this.settlementSweepPromise = sweep;
    this._track(sweep);
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
      maxConcurrentPositionsPerMint: this.config.maxConcurrentPositionsPerMint,
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
    for (const position of this._positionsForMint(token.mint)) {
      if (position?.strategy?.exitMode === 'GRADUATION_CORE_RUNNER') {
        position.graduatedAt = position.graduatedAt || graduatedAt;
        this._scheduleMaxHold(position);
      } else if (position?.strategy?.exitMode === 'QUALITY_PROTECTED_RUNNER') {
        position.graduatedAt = position.graduatedAt || graduatedAt;
      }
    }
  }

  trackedMints(now = this.now()) {
    for (const [mint, token] of this.tracked) {
      if (now - token.graduatedAt <= this._maxTrackingAgeMs()) continue;
      if (this._hasActiveMint(mint)) continue;
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

    if (!Number.isFinite(observedTrade?.price) || observedTrade.price <= 0) return;
    for (const position of this._positionsForMint(observedTrade.mint)) {
      this._observePositionTrade(position, observedTrade);
    }
  }

  _observePositionTrade(position, observedTrade) {
    if (position.status !== 'OPEN') return;
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    const graduatedAt = Number(this.store.getToken(observedTrade.mint)?.graduated_at)
      || position.graduatedAt;
    if (strategy?.exitMode === 'GRADUATION_CORE_RUNNER') {
      if (graduatedAt) {
        position.graduatedAt = position.graduatedAt || graduatedAt;
        if (observedTrade.market !== 'PUMP_AMM'
          || observedTrade.timestampMs < graduatedAt) return;
        position.lastObservedPrice = observedTrade.price;
        const highest = Math.max(Number(position.highestPrice) || 0, observedTrade.price);
        if (highest !== position.highestPrice) {
          position.highestPrice = highest;
          this.store.updateLivePosition(position.id, { highestPrice: highest });
        }
        const immediateStop = this._immediateHardStopReason(
          position,
          strategy,
          observedTrade,
          observedTrade.price,
        );
        if (immediateStop) {
          this._requestExit(position, immediateStop, observedTrade.price);
          return;
        }
        this._recordGraduationGateTrade(position, observedTrade);
        const gate = this._graduationGateDecision(position, observedTrade.timestampMs);
        if (strategy.postMigrationGate) {
          if (!gate) return;
          if (!gate.passed) {
            this._requestExit(position, 'POST_MIGRATION_GATE_FAIL', observedTrade.price);
            return;
          }
        }
        if (!position.coreExited) {
          this._requestCoreExit(position);
          return;
        }
      } else if (observedTrade.market !== 'PUMP_BONDING_CURVE') return;
    } else if (strategy?.exitMode === 'QUALITY_PROTECTED_RUNNER') {
      if (graduatedAt) {
        position.graduatedAt = position.graduatedAt || graduatedAt;
        if (observedTrade.market !== 'PUMP_AMM'
          || observedTrade.timestampMs < graduatedAt) return;
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
    this._evaluatePositionExit(
      position,
      observedTrade.timestampMs,
      observedTrade.price,
      observedTrade,
    );
  }

  advanceTime(now = this.now()) {
    this._scheduleSettlementReconciliation(now);
    for (const states of this.detectors.values()) {
      for (const [mint, state] of states) {
        if (state.candidate && now > state.candidate.expiresAt) state.candidate = null;
        if (!state.candidate && now - state.lastTimestampMs > 60_000) states.delete(mint);
      }
    }
    for (const position of this.positions.values()) {
      if (position.status === 'OPEN' && position.lastObservedPrice > 0) {
        const strategy = position.strategy || this.strategies.get(position.strategyId);
        if (strategy?.exitMode === 'GRADUATION_CORE_RUNNER'
          && strategy.postMigrationGate && position.graduatedAt) {
          const gate = this._graduationGateDecision(position, now);
          if (!gate) continue;
          if (!gate.passed) {
            this._requestExit(position, 'POST_MIGRATION_GATE_FAIL', position.lastObservedPrice);
            continue;
          }
          if (!position.coreExited) {
            this._requestCoreExit(position);
            continue;
          }
        }
        this._evaluatePositionExit(position, now, position.lastObservedPrice);
      }
    }
    this.trackedMints(now);
  }

  _recordGraduationGateTrade(position, trade) {
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    const gate = strategy?.postMigrationGate;
    if (!gate || !position.graduatedAt || trade.market !== 'PUMP_AMM') return;
    if (trade.timestampMs < position.graduatedAt
      || trade.timestampMs > position.graduatedAt + gate.windowMs) return;
    let state = this.graduationGateTrades.get(position.id);
    if (!state) {
      state = { rows: [], keys: new Set(), decision: null };
      this.graduationGateTrades.set(position.id, state);
    }
    const key = trade.signature || [
      trade.timestampMs,
      trade.side,
      trade.wallet || '',
      Number(trade.solAmount) || 0,
    ].join(':');
    if (state.keys.has(key)) return;
    state.keys.add(key);
    state.rows.push({
      side: trade.side,
      wallet: trade.wallet || null,
      solAmount: Math.max(0, Number(trade.solAmount) || 0),
    });
  }

  _graduationGateDecision(position, now) {
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    const gate = strategy?.postMigrationGate;
    if (!gate || !position.graduatedAt) return null;
    const evaluatedAt = position.graduatedAt + gate.windowMs;
    if (now < evaluatedAt) return null;
    let state = this.graduationGateTrades.get(position.id);
    if (!state) {
      state = { rows: [], keys: new Set(), decision: null };
      this.graduationGateTrades.set(position.id, state);
    }
    if (state.decision) return state.decision;
    const buys = state.rows.filter((row) => row.side === 'BUY');
    const sells = state.rows.filter((row) => row.side === 'SELL');
    const buyers = new Set(buys.map((row) => row.wallet).filter(Boolean)).size;
    const netFlowSol = buys.reduce((sum, row) => sum + row.solAmount, 0)
      - sells.reduce((sum, row) => sum + row.solAmount, 0);
    state.decision = {
      evaluatedAt,
      buyers,
      netFlowSol,
      passed: buyers >= gate.minBuyers && netFlowSol >= gate.minNetFlowSol,
    };
    return state.decision;
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

  _queueMintExit(mint, task) {
    const previous = this.mintExitQueues.get(mint) || Promise.resolve();
    const current = previous.catch(() => null).then(task);
    this.mintExitQueues.set(mint, current);
    return current.finally(() => {
      if (this.mintExitQueues.get(mint) === current) this.mintExitQueues.delete(mint);
    });
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
  }

  _maxTrackingAgeMs() {
    return Math.max(0, ...[...this.detectorStrategies.values()]
      .map((strategy) => Number(strategy.trackingAgeMs) || 0));
  }

  _acceptAmmPrice(trade) {
    const settings = this.config.ammPriceContinuity || {
      minRatio: 0.2,
      maxRatio: 5,
      resetAfterMs: 15_000,
    };
    const current = this.ammPriceStates.get(trade.mint);
    if (!current || trade.timestampMs - current.at > settings.resetAfterMs) {
      this.ammPriceStates.set(trade.mint, { price: trade.price, at: trade.timestampMs });
      return true;
    }
    const ratio = trade.price / current.price;
    if (ratio < settings.minRatio || ratio > settings.maxRatio) return false;
    current.price = trade.price;
    current.at = trade.timestampMs;
    return true;
  }

  _observeStrategy(strategy, trade, graduatedAt) {
    if (!(graduatedAt > 0) || trade.timestampMs < graduatedAt
      || trade.timestampMs - graduatedAt > strategy.trackingAgeMs) return;
    const states = this.detectors.get(strategy.id);
    if (!states) return;
    let state = states.get(trade.mint);
    if (!state) {
      state = { prices: [], candidate: null, dropReady: true, lastTimestampMs: 0 };
      states.set(trade.mint, state);
    }
    if (state.lastTimestampMs && trade.timestampMs < state.lastTimestampMs) return;
    state.lastTimestampMs = trade.timestampMs;
    state.prices.push({ timestampMs: trade.timestampMs, price: trade.price });
    const cutoff = trade.timestampMs - strategy.windowMs;
    while (state.prices.length && state.prices[0].timestampMs < cutoff) state.prices.shift();
    let peak = state.prices[0];
    for (const row of state.prices) if (row.price > peak.price) peak = row;
    const rollingDropPct = ((trade.price / peak.price) - 1) * 100;
    if (rollingDropPct > -strategy.dropMinPct) state.dropReady = true;
    if (rollingDropPct < -strategy.dropMaxPct) state.dropReady = false;

    if (state.candidate) {
      const candidate = state.candidate;
      if (trade.timestampMs > candidate.expiresAt) {
        state.candidate = null;
      } else {
        if (trade.price < candidate.lowPrice) {
          candidate.lowPrice = trade.price;
          candidate.lowAt = trade.timestampMs;
        }
        const dropPct = ((candidate.lowPrice / candidate.peakPrice) - 1) * 100;
        const reboundPct = ((trade.price / candidate.lowPrice) - 1) * 100;
        if (dropPct < -strategy.dropMaxPct) {
          state.candidate = null;
          state.dropReady = false;
        } else if (reboundPct >= strategy.reboundMinPct) {
          state.candidate = null;
          state.dropReady = false;
          if (reboundPct <= strategy.reboundMaxPct) {
            this._emitStrategySignal(strategy, trade, graduatedAt, candidate, dropPct, reboundPct);
          }
        }
      }
    }

    if (!state.candidate && state.dropReady
      && rollingDropPct <= -strategy.dropMinPct && rollingDropPct >= -strategy.dropMaxPct) {
      state.candidate = {
        peakPrice: peak.price,
        peakAt: peak.timestampMs,
        lowPrice: trade.price,
        lowAt: trade.timestampMs,
        expiresAt: trade.timestampMs + strategy.reboundTimeoutMs,
      };
      state.dropReady = false;
      this.metrics.candidates += 1;
    }
  }

  _emitStrategySignal(strategy, trade, graduatedAt, candidate, dropPct, reboundPct) {
    const maxSignalsPerMint = Number(strategy.maxSignalsPerMint);
    if (Number.isFinite(maxSignalsPerMint) && maxSignalsPerMint > 0
      && typeof this.store.liveStrategyDecisionCountForMintStrategy === 'function'
      && this.store.liveStrategyDecisionCountForMintStrategy(trade.mint, strategy.id)
        >= maxSignalsPerMint) {
      return;
    }
    // The timestamp/slot/low tuple makes each fresh causal drop-rebound cycle
    // durable across restarts. Strategies without maxSignalsPerMint retain the
    // older successful-entry behavior; F1 consumes its first matched decision.
    const episodeId = [
      strategy.id,
      trade.mint,
      trade.timestampMs,
      Number.isSafeInteger(Number(trade.slot)) ? Number(trade.slot) : 'NA',
      candidate.lowAt,
    ].join(':');
    this.metrics.evaluated += 1;
    this.metrics.matched += 1;
    this.metrics.signals += 1;
    const decision = this.store.recordLiveStrategyDecision({
      strategyId: strategy.id,
      episodeId,
      timestampMs: trade.timestampMs,
      receivedAtMs: trade.receivedAtMs || trade.timestampMs,
      mint: trade.mint,
      symbol: this.tracked.get(trade.mint)?.symbol || null,
      ruleVersion: strategy.ruleVersion || LIVE_RULE_VERSION,
      market: 'PUMP_AMM',
      referencePrice: trade.price,
      features: {
        migratedAt: graduatedAt,
        migrationAgeMs: trade.timestampMs - graduatedAt,
        peakAt: candidate.peakAt,
        lowAt: candidate.lowAt,
        dropPct,
        reboundPct,
        windowMs: strategy.windowMs,
        referencePriceSource: Number(trade.reservePrice) > 0
          ? 'EFFECTIVE_POOL_RESERVES'
          : 'TRADE_AVERAGE',
        poolBaseReservesRaw: trade.poolBaseReservesRaw || null,
        poolQuoteReservesRaw: trade.poolQuoteReservesRaw || null,
        virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw || null,
        maxEntryPriceJumpPct: strategy.maxEntryPriceJumpPct,
        maxEntrySelfImpactPct: strategy.maxEntrySelfImpactPct
          ?? this.config.maxEntrySelfImpactPct,
      },
      ruleMatched: true,
      rejectionReasons: [],
      mode: this.mode,
      actionStatus: this.mode === 'DISABLED' ? 'MATCHED_DISABLED' : 'QUEUED',
    });
    if (!decision?.inserted || this.mode === 'DISABLED' || this.stopping) return;
    const event = {
      strategyId: strategy.id,
      episodeId,
      mint: trade.mint,
      symbol: this.tracked.get(trade.mint)?.symbol || null,
      price: trade.price,
      slot: trade.slot,
      timestampMs: trade.timestampMs,
      receivedAtMs: trade.receivedAtMs || trade.timestampMs,
      market: 'PUMP_AMM',
      poolBaseReservesRaw: trade.poolBaseReservesRaw || null,
      poolQuoteReservesRaw: trade.poolQuoteReservesRaw || null,
      virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw || null,
    };
    this.entryQueue = this.entryQueue
      .then(() => this._enter(decision, event))
      .catch((error) => this._rememberError(error));
    this._track(this.entryQueue);
  }

  _riskReason(event) {
    if (this._killSwitchActive()) return 'KILL_SWITCH';
    const receivedAt = Number(event.receivedAtMs ?? event.createdAt);
    const strategy = this.strategies.get(event.strategyId);
    if (!strategy || strategy.entryEnabled === false) return 'STRATEGY_ENTRY_DISABLED';
    const shadowEntryImpactPct = Number(event.features?.shadowEntryImpactPct);
    const maxShadowEntryImpactPct = Number(strategy.maxShadowEntryImpactPct);
    if (Number.isFinite(shadowEntryImpactPct)
      && Number.isFinite(maxShadowEntryImpactPct)
      && shadowEntryImpactPct > maxShadowEntryImpactPct) {
      return 'SHADOW_ENTRY_IMPACT';
    }
    const maxSignalAgeMs = strategy?.maxSignalAgeMs || this.config.maxSignalAgeMs;
    if (Number.isFinite(receivedAt)
      && this.now() - receivedAt > maxSignalAgeMs) return 'STALE_SIGNAL';
    const maxPerMint = Math.max(
      1,
      Number(this.config.maxConcurrentPositionsPerMint) || 3,
    );
    if (this._positionsForMint(event.mint).length >= maxPerMint) {
      return 'MAX_POSITIONS_PER_MINT';
    }
    if (this.positions.size >= this.config.maxConcurrentPositions) return 'MAX_POSITIONS';
    const maxEntriesPerMint = Math.max(1, Number(strategy?.maxEntriesPerMint) || 1);
    const successfulEntries = typeof this.store.successfulLiveEntryCountForMintStrategy === 'function'
      ? this.store.successfulLiveEntryCountForMintStrategy(event.mint, event.strategyId)
      : 0;
    if (successfulEntries >= maxEntriesPerMint) return 'MINT_ENTRY_LIMIT';
    const lastSuccessful = typeof this.store.lastSuccessfulLivePositionForMintStrategy === 'function'
      ? this.store.lastSuccessfulLivePositionForMintStrategy(event.mint, event.strategyId)
      : this.store.lastLivePositionForMint(event.mint);
    const cooldownMs = Number.isFinite(Number(strategy?.reentryCooldownMs))
      ? Math.max(0, Number(strategy.reentryCooldownMs))
      : this.config.mintCooldownMs;
    if (lastSuccessful
      && this.now() - Number(
        lastSuccessful.closed_at || lastSuccessful.updated_at || lastSuccessful.created_at,
      ) < cooldownMs) {
      return 'MINT_REENTRY_COOLDOWN';
    }
    return null;
  }

  async _enter(decision, event) {
    if (this.stopping) return;
    const strategy = this.strategies.get(event.strategyId);
    if (!strategy) return;
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: strategy.id,
      mint: event.mint,
      timestampMs: this.now(),
      source: 'LIVE',
    });
    if (rugGuard.blocked) {
      this.metrics.riskRejected += 1;
      this.store.updateLiveStrategyDecision(decision.id, 'RISK_REJECTED', 'PRE_ENTRY_RUG_RISK');
      return;
    }
    const riskReason = this._riskReason(event);
    if (riskReason) {
      this.metrics.riskRejected += 1;
      this.store.updateLiveStrategyDecision(decision.id, 'RISK_REJECTED', riskReason);
      return;
    }

    const allowExistingBalance = this._hasActiveMint(event.mint);
    let position;
    try {
      position = this.store.createLivePosition({
        strategyDecisionId: decision.id,
        strategyId: strategy.id,
        signalId: null,
        sourceType: strategy.id,
        mint: event.mint,
        triggerWallet: null,
        mode: this.mode,
        status: 'OPENING',
        positionSol: strategy.positionSizeSol,
        entryMarket: event.market || strategy.market,
        entryPrice: event.price,
      });
      position.tokenAmountRaw = null;
      position.openedAt = null;
      position.strategy = strategy;
      this._addPosition(position);
    } catch (error) {
      this.metrics.riskRejected += 1;
      this.store.updateLiveStrategyDecision(
        decision.id,
        'RISK_REJECTED',
        error.code || 'POSITION_CREATE_FAILED',
      );
      return;
    }

    const submittedAt = this.now();
    position.entryStartedAt = submittedAt;
    try {
      let result;
      if (this.mode === 'DRY_RUN') {
        if (!(event.price > 0)) throw new Error('Missing strategy signal price for simulation');
        const venue = event.market || strategy.market || 'PUMP_AMM';
        const raw = BigInt(Math.max(
          1,
          Math.round((strategy.positionSizeSol / event.price) * 1e6),
        ));
        result = {
          signature: `DRY-${strategy.id}-${decision.id}`,
          venue,
          tokenAmountRaw: raw.toString(),
          expectedPrice: event.price,
          execution: {
            version: 2,
            buyMode: `DRY_RUN_${venue}_FIXED_SOL`,
            positionSol: strategy.positionSizeSol,
            signalSlot: Number.isSafeInteger(Number(event.slot)) ? Number(event.slot) : null,
            readCommitment: this.config.readCommitment || 'processed',
            confirmationCommitment: this.config.confirmationCommitment
              || this.config.commitment
              || 'confirmed',
          },
        };
      } else if ((event.market || strategy.market) === 'PUMP_BONDING_CURVE') {
        result = await this.executor.buy({
          mint: event.mint,
          solAmount: strategy.positionSizeSol,
          referencePrice: event.price,
          maxPriceJumpPct: strategy.maxEntryPriceJumpPct,
          signalSlot: event.slot,
          allowExistingBalance,
        });
      } else {
        result = await this.executor.buyAmm({
          mint: event.mint,
          solAmount: strategy.positionSizeSol,
          referencePrice: event.price,
          maxPriceJumpPct: strategy.maxEntryPriceJumpPct,
          maxSelfImpactPct: strategy.maxEntrySelfImpactPct
            ?? this.config.maxEntrySelfImpactPct,
          signalPoolBaseReservesRaw: event.poolBaseReservesRaw,
          signalPoolQuoteReservesRaw: event.poolQuoteReservesRaw,
          signalVirtualQuoteReservesRaw: event.virtualQuoteReservesRaw,
          allowExistingBalance,
        });
      }
      const openedAt = this.now();
      position.status = 'OPEN';
      position.tokenAmountRaw = result.tokenAmountRaw;
      position.entryPrice = result.expectedPrice || event.price;
      position.highestPrice = position.entryPrice;
      position.lastObservedPrice = null;
      position.openedAt = openedAt;
      const settlement = result.execution?.settlement || null;
      const orderId = this.store.recordLiveOrder({
        positionId: position.id,
        strategyDecisionId: decision.id,
        strategyId: strategy.id,
        mint: position.mint,
        side: 'BUY',
        venue: result.venue,
        attempt: 1,
        requestedSol: strategy.positionSizeSol,
        requestedTokenRaw: result.tokenAmountRaw,
        status: 'CONFIRMED',
        signature: result.signature,
        walletSolDelta: settlement?.walletSolDelta,
        networkFeeSol: settlement?.networkFeeSol,
        execution: orderExecution(result.execution, event, submittedAt, openedAt),
        submittedAt,
        confirmedAt: openedAt,
      });
      this.store.updateLivePosition(position.id, {
        status: 'OPEN',
        tokenAmountRaw: result.tokenAmountRaw,
        entryMarket: result.venue,
        entryPrice: position.entryPrice,
        entrySignature: result.signature,
        highestPrice: position.highestPrice,
        openedAt,
      });
      this.store.refreshLivePositionSettlement(position.id);
      if (position.mode === 'LIVE' && !settlement && result.signature) {
        this._track(this._reconcileOrderSettlement({
          orderId,
          positionId: position.id,
          signature: result.signature,
        }));
      }
      this.store.updateLiveStrategyDecision(decision.id, 'OPEN', null);
      this.metrics.entries += 1;
      this.metrics.lastActionAt = openedAt;
      this._armPositionExit(position);
      if (strategy.exitMode === 'GRADUATION_CORE_RUNNER') {
        const token = this.store.getToken(position.mint);
        if (token?.graduated_at) this.onGraduated(token);
      }
    } catch (error) {
      const failedAt = this.now();
      const transactionFailed = error.transactionFailed || error.code === 'TRANSACTION_FAILED';
      const confirmationUnknown = Boolean(error.signature) && !transactionFailed;
      const orderId = this.store.recordLiveOrder({
        positionId: position.id,
        strategyDecisionId: decision.id,
        strategyId: strategy.id,
        mint: position.mint,
        side: 'BUY',
        venue: event.market || strategy.market || 'PUMP_AMM',
        attempt: 1,
        requestedSol: strategy.positionSizeSol,
        status: confirmationUnknown ? 'CONFIRMATION_UNKNOWN' : 'FAILED',
        signature: error.signature,
        error: errorText(error),
        walletSolDelta: error.execution?.settlement?.walletSolDelta,
        networkFeeSol: error.execution?.settlement?.networkFeeSol,
        execution: orderExecution(error.execution, event, submittedAt, failedAt),
        submittedAt,
      });
      if (position.mode === 'LIVE' && transactionFailed && error.signature) {
        this._track(this._reconcileOrderSettlement({
          orderId,
          positionId: position.id,
          signature: error.signature,
        }));
      }
      if (confirmationUnknown) {
        position.status = 'EXIT_FAILED';
        position.tokenAmountRaw = null;
        position.entrySignature = error.signature;
        position.entryError = errorText(error);
        position.exitReason = 'ENTRY_CONFIRMATION_UNKNOWN';
        this.store.updateLivePosition(position.id, {
          status: 'EXIT_FAILED',
          entrySignature: error.signature,
          entryError: errorText(error),
          exitReason: 'ENTRY_CONFIRMATION_UNKNOWN',
        });
        this.store.updateLiveStrategyDecision(
          decision.id,
          'ENTRY_CONFIRMATION_UNKNOWN',
          errorText(error),
        );
        this.metrics.lastActionAt = failedAt;
        this._rememberError(error);
        await this._recoverUnknownEntry(position, { orderId, initialError: error });
        return;
      }
      const rejectionReason = transactionFailed
        ? 'ENTRY_TRANSACTION_FAILED'
        : error.code === 'CURVE_COMPLETE'
          ? 'ENTRY_MIGRATED_BEFORE_SUBMIT'
        : error.code === 'PRICE_JUMP'
          ? 'ENTRY_PRICE_JUMP'
        : error.code === 'WALLET_RESERVE'
          ? 'ENTRY_WALLET_RESERVE_REJECTED'
        : error.code === 'MARKET_PRICE_MOVED'
          ? 'ENTRY_MARKET_PRICE_MOVED'
          : error.code === 'SELF_IMPACT_REJECTED'
            ? 'ENTRY_SELF_IMPACT_REJECTED'
            : 'ENTRY_REJECTED';
      this.store.updateLivePosition(position.id, {
        status: 'ENTRY_FAILED',
        entrySignature: error.signature,
        entryError: errorText(error),
        exitReason: rejectionReason,
      });
      this.store.updateLiveStrategyDecision(decision.id, 'ENTRY_FAILED', error.code || errorText(error));
      this._removePosition(position);
      this.metrics.entryFailures += 1;
      if (error.code === 'CURVE_COMPLETE') this.metrics.entryMigrationsBeforeSubmit += 1;
      else if (transactionFailed) this.metrics.entryTransactionFailures += 1;
      else this.metrics.entryPreSubmitRejected += 1;
      this.metrics.lastActionAt = failedAt;
      this._rememberError(error);
    }
  }

  async _recoverUnknownEntry(position, { orderId = null, initialError = null } = {}) {
    const attempts = Math.max(1, Number(this.config.entryReconcileCount) || 5);
    const delayMs = Math.max(100, Number(this.config.entryReconcileDelayMs) || 1_000);
    let result = { state: 'UNKNOWN' };
    let lastError = initialError;

    if (!this.executor || typeof this.executor.reconcileBuy !== 'function') {
      lastError = new Error('Executor cannot reconcile an unknown buy transaction');
    } else {
      for (let attempt = 1; attempt <= attempts && !this.stopping; attempt += 1) {
        try {
          result = await this.executor.reconcileBuy({
            mint: position.mint,
            signature: position.entrySignature || null,
            allowExistingBalance: this._positionsForMint(position.mint)
              .some((other) => Number(other.id) !== Number(position.id)),
          });
        } catch (error) {
          lastError = error;
          result = { state: 'UNKNOWN' };
        }
        if (result?.state === 'EMPTY') {
          result = {
            ...result,
            state: 'UNKNOWN',
            error: result.error || 'Confirmed buy token receipt has not been reconciled yet',
          };
        }
        if (result?.state && result.state !== 'UNKNOWN') break;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    const reconciledAt = this.now();
    const signature = position.entrySignature || null;
    if (result.state === 'FAILED') {
      const failure = result.error || errorText(lastError || initialError || 'Transaction failed');
      if (orderId) this.store.updateLiveOrder(orderId, { status: 'FAILED', error: failure });
      position.status = 'ENTRY_FAILED';
      position.entryError = failure;
      position.exitReason = 'ENTRY_TRANSACTION_FAILED';
      this.store.updateLivePosition(position.id, {
        status: 'ENTRY_FAILED',
        entrySignature: signature,
        entryError: failure,
        exitReason: 'ENTRY_TRANSACTION_FAILED',
        exitError: null,
      });
      this._updatePositionDecision(position, 'ENTRY_FAILED', failure);
      this._removePosition(position);
      this.metrics.entryFailures += 1;
      this.metrics.entryTransactionFailures += 1;
      this.metrics.lastActionAt = reconciledAt;
      return 'FAILED';
    }

    if (result.state === 'CONFIRMED' && result.tokenAmountRaw !== '0') {
      const openedAt = position.openedAt || position.createdAt || reconciledAt;
      if (orderId) {
        this.store.updateLiveOrder(orderId, {
          status: 'CONFIRMED',
          requestedTokenRaw: result.tokenAmountRaw,
          error: null,
          confirmedAt: reconciledAt,
        });
        if (position.mode === 'LIVE' && signature) {
          this._track(this._reconcileOrderSettlement({
            orderId,
            positionId: position.id,
            signature,
          }));
        }
      }
      position.status = 'OPEN';
      position.tokenAmountRaw = result.tokenAmountRaw;
      position.openedAt = openedAt;
      position.exitReason = 'ENTRY_RECONCILED';
      position.highestPrice = position.entryPrice;
      position.lastObservedPrice = null;
      this.store.updateLivePosition(position.id, {
        status: 'OPEN',
        tokenAmountRaw: result.tokenAmountRaw,
        entrySignature: signature,
        entryError: null,
        highestPrice: position.highestPrice,
        exitReason: 'ENTRY_RECONCILED',
        exitError: null,
        openedAt,
      });
      this._updatePositionDecision(position, 'OPEN', 'ENTRY_RECONCILED');
      this.metrics.entries += 1;
      this.metrics.entryRecoveries += 1;
      this.metrics.lastActionAt = reconciledAt;
      const strategy = position.strategy || this.strategies.get(position.strategyId);
      if (reconciledAt - openedAt >= (strategy?.maxHoldMs || this.config.maxHoldMs)) {
        this._requestExit(position, 'ENTRY_RECONCILED_MAX_HOLD', null);
      } else {
        this._armPositionExit(position);
      }
      return 'CONFIRMED';
    }

    const unresolved = errorText(lastError || initialError || position.entryError
      || 'Transaction status is still unknown');
    const unknownAgeMs = reconciledAt - Number(position.createdAt || reconciledAt);
    const expiredReleaseMs = Math.max(
      60_000,
      Number(this.config.expiredEntryReleaseMs) || 10 * 60_000,
    );
    const signatureExpired = /(?:signature .* expired|block height exceeded)/i.test(unresolved);
    const safelyAbsent = !result.confirmationStatus
      && result.transactionObserved !== true
      && String(result.tokenAmountRaw || '0') === '0';
    if (signature && signatureExpired && safelyAbsent && unknownAgeMs >= expiredReleaseMs) {
      const failure = `Expired entry was not found on chain after ${Math.round(unknownAgeMs / 1_000)}s`;
      if (orderId) this.store.updateLiveOrder(orderId, { status: 'FAILED', error: failure });
      position.status = 'ENTRY_FAILED';
      position.entryError = failure;
      position.exitReason = 'ENTRY_EXPIRED_UNOBSERVED';
      this.store.updateLivePosition(position.id, {
        status: 'ENTRY_FAILED',
        entrySignature: signature,
        entryError: failure,
        exitReason: 'ENTRY_EXPIRED_UNOBSERVED',
        exitError: null,
      });
      this._updatePositionDecision(position, 'ENTRY_FAILED', 'ENTRY_EXPIRED_UNOBSERVED');
      this._removePosition(position);
      this.metrics.entryFailures += 1;
      this.metrics.entryTransactionFailures += 1;
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
      if (this.stopping || !this._hasPosition(position)) return;
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
    if (strategy?.exitMode === 'QUALITY_PROTECTED_RUNNER') {
      this._scheduleMaxHold(position);
      return;
    }
    if (strategy?.exitMode === 'PBR_CORE_RUNNER') {
      this._scheduleMaxHold(position);
      return;
    }
    if (strategy?.exitMode === 'TAIL' || strategy?.exitMode === 'TRAILING') {
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
        : (strategy?.exitMode === 'QUALITY_PROTECTED_RUNNER' ? 'MAX_HOLD_5M' : 'MAX_HOLD'));
    const delay = Math.max(0, anchorAt + holdMs - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(position.id);
      this._requestExit(position, reason, null);
    }, delay);
    if (timer.unref) timer.unref();
    this.timers.set(position.id, timer);
  }

  _evaluatePositionExit(position, timestampMs, price, trade = null) {
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    if (!strategy || position.status !== 'OPEN' || !(position.entryPrice > 0) || !(price > 0)) return;
    const ageMs = timestampMs - position.openedAt;
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    const peakReturnPct = ((position.highestPrice / position.entryPrice) - 1) * 100;
    const drawdownPct = ((price / position.highestPrice) - 1) * -100;
    let reason = null;
    const immediateStop = this._immediateHardStopReason(position, strategy, trade, price);
    if (immediateStop) {
      this._requestExit(position, immediateStop, price);
      return;
    }
    if (strategy.exitMode === 'FIXED_HOLD') {
      if (strategy.hardStopPct > 0 && grossReturnPct <= -strategy.hardStopPct) {
        reason = 'HARD_STOP';
      } else if (ageMs >= strategy.fixedHoldMs) {
        reason = `FIXED_HOLD_${strategy.fixedHoldMs}MS`;
      }
      if (reason) this._requestExit(position, reason, price);
      return;
    }
    if (strategy.exitMode === 'TAIL') {
      if (strategy.hardStopPct > 0 && grossReturnPct <= -strategy.hardStopPct) {
        reason = 'HARD_STOP';
      } else if (ageMs >= strategy.maxHoldMs) {
        reason = 'TAIL_MAX_HOLD';
      }
      if (reason) this._requestExit(position, reason, price);
      return;
    }
    if (strategy.exitMode === 'TRAILING') {
      if (strategy.fastTakeProfitPct > 0
        && ageMs <= strategy.fastTakeProfitWindowMs
        && grossReturnPct >= strategy.fastTakeProfitPct) {
        reason = 'FAST_TAKE_PROFIT';
      } else if (strategy.hardStopPct > 0 && grossReturnPct <= -strategy.hardStopPct) {
        reason = 'HARD_STOP';
      } else if (ageMs >= (strategy.minHoldMs || 0)
        && peakReturnPct >= strategy.trailingActivationPct
        && drawdownPct >= strategy.trailingStopPct) {
        reason = 'TRAILING_STOP';
      } else if (ageMs >= strategy.maxHoldMs) {
        reason = 'MAX_HOLD';
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
    if (strategy.exitMode === 'QUALITY_PROTECTED_RUNNER') {
      if (strategy.hardStopPct > 0 && grossReturnPct <= -strategy.hardStopPct) {
        reason = 'HARD_STOP';
      } else if (ageMs >= strategy.noStrengthMs
        && peakReturnPct < strategy.strengthActivationPct) {
        reason = `NO_STRENGTH_${strategy.noStrengthMs}MS`;
      } else if (peakReturnPct >= strategy.strengthActivationPct) {
        const floorPct = this._qualityProtectedFloor(strategy, peakReturnPct);
        if (floorPct != null && grossReturnPct <= floorPct) {
          reason = `PROTECTED_FLOOR_${Number(floorPct.toFixed(2))}`;
        }
      }
      if (!reason && ageMs >= strategy.maxHoldMs) reason = 'MAX_HOLD_5M';
      if (reason) this._requestExit(position, reason, price);
      return;
    }
    if (strategy.exitMode === 'PBR_CORE_RUNNER') {
      if (!position.coreExited && strategy.hardStopPct > 0
        && grossReturnPct <= -strategy.hardStopPct) {
        this._requestExit(position, 'HARD_STOP', price);
        return;
      }
      if (!position.coreExited && grossReturnPct >= strategy.coreActivationPct) {
        this._requestCoreExit(position);
        return;
      }
      if (position.coreExited && peakReturnPct >= strategy.trailingActivationPct) {
        let drawdownLimit = strategy.baseTrailingDrawdownPct;
        for (const tier of strategy.trailingTiers || []) {
          if (peakReturnPct >= tier.activationPct) drawdownLimit = tier.drawdownPct;
        }
        if (drawdownPct >= drawdownLimit) {
          reason = `PBR_RUNNER_TRAIL_D${drawdownLimit}`;
        }
      }
      if (!reason && ageMs >= strategy.maxHoldMs) reason = 'PBR_MAX_HOLD';
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

  _executableExitRisk(position, strategy, trade, markPrice) {
    if (!trade || position.coreExited || !(strategy?.hardStopPct > 0)) return null;
    const tokenUnits = rawTokenUnits(position.tokenAmountRaw);
    const entrySol = Number(position.positionSol);
    if (!(tokenUnits > 0) || !(entrySol > 0)) return null;
    const markReturnPct = ((markPrice / position.entryPrice) - 1) * 100;
    const quote = executableSell(trade, tokenUnits, markPrice, { rugMarkReturnPct: markReturnPct });
    if (!quote.available || !(quote.proceedsSol >= 0)) return null;
    let proceedsSol = quote.proceedsSol;
    // Pump bonding-curve events expose both virtual pricing reserves and the
    // actual SOL available to sellers. The virtual constant-product quote can
    // otherwise materially overstate recovery during a liquidity collapse.
    if (trade.market === 'PUMP_BONDING_CURVE'
      && trade.realSolReservesRaw !== undefined
      && trade.realSolReservesRaw !== null) {
      const realSolAvailable = rawSol(trade.realSolReservesRaw);
      if (realSolAvailable !== null) proceedsSol = Math.min(proceedsSol, realSolAvailable);
    }
    return {
      returnPct: ((proceedsSol / entrySol) - 1) * 100,
      proceedsSol,
      impactPct: quote.impactPct,
      reserveSource: quote.reserveSource,
    };
  }

  _immediateHardStopReason(position, strategy, trade, markPrice) {
    if (!(strategy?.hardStopPct > 0) || !(position.entryPrice > 0) || !(markPrice > 0)) {
      return null;
    }
    const executableRisk = this._executableExitRisk(position, strategy, trade, markPrice);
    if (executableRisk && executableRisk.returnPct <= -strategy.hardStopPct) {
      position.lastExecutableReturnPct = executableRisk.returnPct;
      position.lastExecutableProceedsSol = executableRisk.proceedsSol;
      position.lastExecutableQuoteAt = Number(trade?.timestampMs) || this.now();
      return 'EXECUTABLE_HARD_STOP';
    }
    const markReturnPct = ((markPrice / position.entryPrice) - 1) * 100;
    return markReturnPct <= -strategy.hardStopPct ? 'HARD_STOP' : null;
  }

  _exitRetryDelay(reason, attempt) {
    const normalDelay = Math.max(0, Number(this.config.exitRetryDelayMs) || 0);
    if (!/HARD_STOP|RUG/i.test(String(reason || ''))) return normalDelay;
    const emergencyBase = Math.max(
      0,
      Number(this.config.emergencyExitRetryDelayMs) || Math.min(normalDelay, 100),
    );
    // Retry the first stale/slippage quote almost immediately, while applying
    // a short linear backoff so repeated RPC failures cannot form a hot loop.
    return Math.min(normalDelay, emergencyBase * Math.max(1, Number(attempt) || 1));
  }

  _qualityProtectedFloor(strategy, peakReturnPct) {
    let selected = null;
    for (const tier of strategy.protectedFloors || []) {
      if (peakReturnPct >= tier.activationPct) selected = tier;
    }
    if (!selected) return null;
    return Math.max(
      Number(selected.minFloorPct) || 0,
      peakReturnPct - (Number(selected.peakGivebackPct) || 0),
    );
  }

  _requestCoreExit(position) {
    const strategy = position?.strategy || this.strategies.get(position?.strategyId);
    if (this.stopping || !position || position.status !== 'OPEN'
      || position.coreExited || position.coreExitAttempted
      || !['GRADUATION_CORE_RUNNER', 'PBR_CORE_RUNNER'].includes(strategy?.exitMode)
      || this.coreExitPending.has(position.id)) return;
    position.coreExitAttempted = true;
    this.coreExitPending.add(position.id);
    const promise = this._queueMintExit(
      position.mint,
      () => this._takeGraduationCore(position),
    )
      .catch((error) => this._rememberError(error))
      .finally(() => this.coreExitPending.delete(position.id));
    this._track(promise);
  }

  async _takeGraduationCore(position) {
    const strategy = position.strategy || this.strategies.get(position.strategyId);
    const balanceRaw = BigInt(position.tokenAmountRaw || 0);
    const sellRaw = (balanceRaw * BigInt(Math.round(strategy.coreExitPct))) / 100n;
    if (sellRaw <= 0n) throw new Error('Core exit has no token balance');
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
      // The executor reports the wallet's aggregate balance for this Mint. When
      // several live position lots share a Mint, only subtract the amount sold
      // from this position's own lot.
      const soldRaw = result.alreadyEmpty
        ? 0n
        : BigInt(result.tokenAmountRaw || sellRaw);
      const remainingRaw = balanceRaw > soldRaw ? balanceRaw - soldRaw : 0n;
      if (remainingRaw <= 0n) {
        throw new Error('Core exit unexpectedly sold the complete position');
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
          liveExitStage: strategy.exitMode === 'PBR_CORE_RUNNER'
            ? 'PBR_PROFIT_CORE'
            : 'GRADUATION_CORE',
          coreExitPct: strategy.coreExitPct,
          remainingTokenAmountRaw: remainingRaw.toString(),
        },
        submittedAt,
        confirmedAt,
      });
      position.coreExited = true;
      position.tokenAmountRaw = remainingRaw.toString();
      if (strategy.exitMode === 'GRADUATION_CORE_RUNNER') {
        position.highestPrice = 0;
        position.lastObservedPrice = null;
      }
      this.store.updateLivePosition(position.id, {
        tokenAmountRaw: position.tokenAmountRaw,
        highestPrice: position.highestPrice,
        exitReason: strategy.exitMode === 'PBR_CORE_RUNNER'
          ? `PBR_CORE_${strategy.coreExitPct}_CONFIRMED`
          : `GRADUATION_CORE_${strategy.coreExitPct}_CONFIRMED`,
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
        execution: error.execution || {
          liveExitStage: strategy.exitMode === 'PBR_CORE_RUNNER'
            ? 'PBR_PROFIT_CORE'
            : 'GRADUATION_CORE',
        },
        submittedAt,
      });
      this.store.updateLivePosition(position.id, {
        exitReason: strategy.exitMode === 'PBR_CORE_RUNNER'
          ? 'PBR_CORE_EXIT_FAILED'
          : 'GRADUATION_CORE_EXIT_FAILED',
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
    const promise = this._queueMintExit(
      position.mint,
      () => this._exit(position, reason, observedPrice),
    )
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
            tokenAmountRaw: position.tokenAmountRaw,
          });
        if (result.alreadyEmpty
          && ['ENTRY_CONFIRMATION_UNKNOWN', 'RESTART_RECOVERY'].includes(reason)) {
          throw new Error('Entry state is still unresolved; no token balance is visible yet');
        }
        const closedAt = this.now();
        const requestedPositionRaw = BigInt(position.tokenAmountRaw || 0);
        const soldPositionRaw = result.alreadyEmpty
          ? requestedPositionRaw
          : BigInt(result.tokenAmountRaw || 0);
        const remainingPositionRaw = requestedPositionRaw > soldPositionRaw
          ? requestedPositionRaw - soldPositionRaw
          : 0n;
        const residualBalance = remainingPositionRaw > 0n;
        const balanceUnverified = result.balanceVerified === false;
        const incompleteReason = balanceUnverified
          ? `Sell confirmed but balance verification failed: ${result.balanceCheckError || 'unknown error'}`
          : residualBalance
            ? `Sell confirmed with ${remainingPositionRaw.toString()} raw tokens remaining in this position lot`
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
            await new Promise((resolve) => setTimeout(
              resolve,
              this._exitRetryDelay(reason, attempt),
            ));
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
        this._removePosition(position);
        this.graduationGateTrades.delete(position.id);
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
          await new Promise((resolve) => setTimeout(
            resolve,
            this._exitRetryDelay(reason, attempt),
          ));
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
