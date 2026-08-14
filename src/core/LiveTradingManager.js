'use strict';

const fs = require('fs');
const path = require('path');

const LIVE_RULE_VERSION = 'post_migration_gd25_35_xleg_reentry2_v2';

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
    this.tracked = new Map();
    this.detectors = new Map([...this.strategies.keys()].map((id) => [id, new Map()]));
    this.ammPriceStates = new Map();
    this.positions = new Map();
    this.timers = new Map();
    this.pending = new Set();
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
      } else if (this.mode !== 'DISABLED') this._scheduleMaxHold(position);
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
        ruleVersion: LIVE_RULE_VERSION,
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

  onGraduated(token) {
    if (!this._trackingEnabled() || !token?.mint) return;
    const graduatedAt = Number(
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
      if (now - token.graduatedAt <= this._maxTrackingAgeMs()) continue;
      if (this.positions.has(mint)) continue;
      this.tracked.delete(mint);
      for (const states of this.detectors.values()) states.delete(mint);
      this.ammPriceStates.delete(mint);
    }
    return [...this.tracked.keys()];
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
        for (const strategy of this.strategies.values()) {
          this._observeStrategy(strategy, observedTrade, graduatedAt);
        }
      }
    }

    const position = this.positions.get(observedTrade?.mint);
    if (!position || !Number.isFinite(observedTrade.price) || observedTrade.price <= 0) {
      return;
    }
    if (position.status !== 'OPEN') return;
    if (observedTrade.market === 'PUMP_AMM') {
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
    return this.strategies.size > 0;
  }

  _maxTrackingAgeMs() {
    return Math.max(0, ...[...this.strategies.values()]
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
    // The timestamp/slot/low tuple makes each fresh causal drop-rebound cycle
    // durable across restarts. The successful-entry limit is enforced from
    // live_positions, so rejected or failed buys do not consume an entry.
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
      ruleVersion: LIVE_RULE_VERSION,
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
    const maxSignalAgeMs = strategy?.maxSignalAgeMs || this.config.maxSignalAgeMs;
    if (Number.isFinite(receivedAt)
      && this.now() - receivedAt > maxSignalAgeMs) return 'STALE_SIGNAL';
    if (this.positions.has(event.mint)) return 'ACTIVE_MINT';
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
    const riskReason = this._riskReason(event);
    if (riskReason) {
      this.metrics.riskRejected += 1;
      this.store.updateLiveStrategyDecision(decision.id, 'RISK_REJECTED', riskReason);
      return;
    }

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
        entryMarket: 'PUMP_AMM',
        entryPrice: event.price,
      });
      position.tokenAmountRaw = null;
      position.openedAt = null;
      position.strategy = strategy;
      this.positions.set(position.mint, position);
    } catch (error) {
      this.metrics.riskRejected += 1;
      this.store.updateLiveStrategyDecision(decision.id, 'RISK_REJECTED', 'ACTIVE_MINT');
      return;
    }

    const submittedAt = this.now();
    position.entryStartedAt = submittedAt;
    try {
      let result;
      if (this.mode === 'DRY_RUN') {
        if (!(event.price > 0)) throw new Error('Missing PumpSwap signal price for simulation');
        const raw = BigInt(Math.max(
          1,
          Math.round((strategy.positionSizeSol / event.price) * 1e6),
        ));
        result = {
          signature: `DRY-${strategy.id}-${decision.id}`,
          venue: 'PUMP_AMM',
          tokenAmountRaw: raw.toString(),
          expectedPrice: event.price,
          execution: {
            version: 2,
            buyMode: 'DRY_RUN_PUMP_AMM_FIXED_SOL',
            positionSol: strategy.positionSizeSol,
            signalSlot: Number.isSafeInteger(Number(event.slot)) ? Number(event.slot) : null,
            readCommitment: this.config.readCommitment || 'processed',
            confirmationCommitment: this.config.confirmationCommitment
              || this.config.commitment
              || 'confirmed',
          },
        };
      } else {
        result = await this.executor.buyAmm({
          mint: event.mint,
          solAmount: strategy.positionSizeSol,
          referencePrice: event.price,
          maxPriceJumpPct: strategy.maxEntryPriceJumpPct,
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
        venue: 'PUMP_AMM',
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
      this.store.updateLivePosition(position.id, {
        status: 'ENTRY_FAILED',
        entrySignature: error.signature,
        entryError: errorText(error),
        exitReason: transactionFailed ? 'ENTRY_TRANSACTION_FAILED' : 'ENTRY_REJECTED',
      });
      this.store.updateLiveStrategyDecision(decision.id, 'ENTRY_FAILED', error.code || errorText(error));
      this.positions.delete(position.mint);
      this.metrics.entryFailures += 1;
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
      this.positions.delete(position.mint);
      this.metrics.entryFailures += 1;
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

    const unresolved = errorText(lastError || initialError || 'Transaction status is still unknown');
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
    return 'UNKNOWN';
  }

  _armPositionExit(position) {
    const strategy = position.strategy || this.strategies.get(position.strategyId);
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
    const delay = Math.max(0, openedAt + (strategy?.maxHoldMs || this.config.maxHoldMs) - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(position.id);
      this._requestExit(position, 'MAX_HOLD', null);
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
    if (strategy.fastTakeProfitPct > 0 && ageMs <= strategy.fastTakeProfitWindowMs
      && grossReturnPct >= strategy.fastTakeProfitPct) reason = 'FAST_TAKE_PROFIT';
    if (!reason && peakReturnPct >= strategy.trailingActivationPct
      && drawdownPct >= strategy.trailingStopPct) reason = 'TRAILING_XLEG';
    if (!reason && strategy.lossCheckAtMs > 0 && ageMs >= strategy.lossCheckAtMs
      && grossReturnPct < 0) reason = 'LOSS_CHECK';
    if (!reason && ageMs >= strategy.maxHoldMs) reason = 'MAX_HOLD';
    if (reason) this._requestExit(position, reason, price);
  }

  _requestExit(position, reason, observedPrice) {
    if (this.stopping || !position || !['OPEN', 'EXIT_FAILED'].includes(position.status)) return;
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
