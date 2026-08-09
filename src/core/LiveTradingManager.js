'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateSmartOpen } = require('./SmartOpenStrategy');

function errorText(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/([?&](?:api-key|api_key|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Authorization:\s*(?:Bearer\s+)?)[^\s]+/gi, '$1[REDACTED]')
    .slice(0, 1_000);
}

function startOfLocalDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function restoredPosition(row) {
  return {
    id: row.id,
    decisionId: row.decision_id,
    mint: row.mint,
    triggerWallet: row.trigger_wallet,
    mode: row.mode,
    status: row.status,
    positionSol: row.position_sol,
    tokenAmountRaw: row.token_amount_raw,
    entryMarket: row.entry_market,
    entryPrice: row.entry_price,
    highestPrice: row.highest_price,
    openedAt: row.opened_at,
    createdAt: row.created_at,
  };
}

class LiveTradingManager {
  constructor({ config, store, executor = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.executor = executor;
    this.now = now;
    this.mode = !config.enabled ? 'DISABLED' : (config.dryRun ? 'DRY_RUN' : 'LIVE');
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
      exits: 0,
      exitFailures: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    for (const row of this.store.activeLivePositions()) {
      const position = restoredPosition(row);
      this.positions.set(position.mint, position);
      if (position.mode === 'LIVE' && this.mode !== 'LIVE') {
        this.metrics.lastError = 'ACTIVE_LIVE_POSITION_REQUIRES_LIVE_MODE';
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
  }

  health() {
    return {
      mode: this.mode,
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      rule: {
        phase: 'OPEN',
        market: 'PUMP_BONDING_CURVE',
        minSmartOpenSol: this.config.minSmartOpenSol,
        minPreBuyers: this.config.minPreBuyers,
        preBuyWindowMs: this.config.preBuyWindowMs,
      },
      activePositions: this.positions.size,
      killSwitchActive: this._killSwitchActive(),
      ...this.metrics,
    };
  }

  onSmartWalletEvent(event, context = {}) {
    if (!event?.inserted || !event.id) return null;
    const evaluated = evaluateSmartOpen(event, context, this.config, this.now());
    this.metrics.evaluated += 1;
    if (evaluated.matched) this.metrics.matched += 1;
    const initialStatus = !evaluated.matched
      ? 'RULE_REJECTED'
      : this.mode === 'DISABLED' ? 'MATCHED_DISABLED' : 'QUEUED';
    const decision = this.store.recordSmartOpenDecision({
      smartEventId: event.id,
      timestampMs: event.timestampMs,
      receivedAtMs: event.receivedAtMs,
      wallet: event.wallet,
      mint: event.mint,
      ruleVersion: evaluated.ruleVersion,
      market: event.market,
      positionPhase: event.positionPhase,
      smartSol: event.solAmount,
      smartPrice: event.price,
      preBuyWindowMs: context.windowMs || this.config.preBuyWindowMs,
      preBuyers: evaluated.preBuyers,
      preBuyTx: evaluated.preBuyTx,
      preBuyFlowSol: evaluated.preBuyFlowSol,
      preSellFlowSol: evaluated.preSellFlowSol,
      preNetFlowSol: evaluated.preNetFlowSol,
      eventAgeMs: evaluated.eventAgeMs,
      ruleMatched: evaluated.matched,
      rejectionReasons: evaluated.rejectReasons,
      mode: this.mode,
      actionStatus: initialStatus,
      actionReason: evaluated.rejectReasons.join(',') || null,
    });

    this._considerSmartExit(event);
    if (evaluated.matched && this.mode !== 'DISABLED' && !this.stopping) {
      this.entryQueue = this.entryQueue
        .then(() => this._enter(decision, event))
        .catch((error) => this._rememberError(error));
      this._track(this.entryQueue);
    }
    return decision;
  }

  observeTrade(trade) {
    const position = this.positions.get(trade?.mint);
    if (!position || position.status !== 'OPEN' || !Number.isFinite(trade.price) || trade.price <= 0) {
      return;
    }
    if (trade.market === 'PUMP_AMM') {
      const token = this.store.getToken(trade.mint);
      if (!token?.graduated_at || trade.timestampMs < token.graduated_at) return;
      if (position.entryPrice > 0) {
        const ratio = trade.price / position.entryPrice;
        if (ratio < 0.05 || ratio > 20) return;
      }
    } else if (trade.market !== 'PUMP_BONDING_CURVE') return;

    const now = this.now();
    const openedAt = position.openedAt || position.createdAt || now;
    const highest = Math.max(Number(position.highestPrice) || 0, trade.price);
    if (highest !== position.highestPrice) {
      position.highestPrice = highest;
      this.store.updateLivePosition(position.id, { highestPrice: highest });
    }
    if (now - openedAt < this.config.minHoldMs || !(position.entryPrice > 0)) return;
    const returnPct = ((trade.price / position.entryPrice) - 1) * 100;
    if (this.config.stopLossPct > 0 && returnPct <= -this.config.stopLossPct) {
      this._requestExit(position, 'STOP_LOSS', trade.price);
      return;
    }
    if (this.config.takeProfitPct > 0 && returnPct >= this.config.takeProfitPct) {
      this._requestExit(position, 'TAKE_PROFIT', trade.price);
      return;
    }
    const peakReturnPct = ((highest / position.entryPrice) - 1) * 100;
    const drawdownPct = ((trade.price / highest) - 1) * 100;
    if (this.config.trailingStopPct > 0
      && peakReturnPct >= this.config.trailingActivationPct
      && drawdownPct <= -this.config.trailingStopPct) {
      this._requestExit(position, 'TRAILING_STOP', trade.price);
    }
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

  _killSwitchActive() {
    if (!this.config.killSwitchFile) return false;
    return fs.existsSync(path.resolve(this.config.killSwitchFile));
  }

  _riskReason(event) {
    if (this._killSwitchActive()) return 'KILL_SWITCH';
    if (this.positions.has(event.mint)) return 'ACTIVE_MINT';
    if (this.positions.size >= this.config.maxConcurrentPositions) return 'MAX_POSITIONS';
    const last = this.store.lastLivePositionForMint(event.mint);
    if (last && this.now() - Number(last.updated_at || last.created_at) < this.config.mintCooldownMs) {
      return 'MINT_COOLDOWN';
    }
    const spent = this.store.liveSpendSince(startOfLocalDay(this.now()), this.mode);
    if (spent + this.config.positionSizeSol > this.config.maxDailySpendSol) {
      return 'DAILY_SPEND_LIMIT';
    }
    return null;
  }

  async _enter(decision, event) {
    if (this.stopping) return;
    const riskReason = this._riskReason(event);
    if (riskReason) {
      this.metrics.riskRejected += 1;
      this.store.updateSmartOpenDecision(decision.id, 'RISK_REJECTED', riskReason);
      return;
    }

    let position;
    try {
      position = this.store.createLivePosition({
        decisionId: decision.id,
        mint: event.mint,
        triggerWallet: event.wallet,
        mode: this.mode,
        status: 'OPENING',
        positionSol: this.config.positionSizeSol,
        entryMarket: 'PUMP_BONDING_CURVE',
        entryPrice: event.price,
      });
      position.tokenAmountRaw = null;
      position.openedAt = null;
      this.positions.set(position.mint, position);
    } catch (error) {
      this.metrics.riskRejected += 1;
      this.store.updateSmartOpenDecision(decision.id, 'RISK_REJECTED', 'ACTIVE_MINT');
      return;
    }

    const submittedAt = this.now();
    try {
      let result;
      if (this.mode === 'DRY_RUN') {
        if (!(event.price > 0)) throw new Error('Missing smart OPEN price for simulation');
        const raw = BigInt(Math.max(
          1,
          Math.round((this.config.positionSizeSol / event.price) * 1e6),
        ));
        result = {
          signature: `DRY-${decision.id}`,
          venue: 'PUMP_BONDING_CURVE',
          tokenAmountRaw: raw.toString(),
          expectedPrice: event.price,
        };
      } else {
        result = await this.executor.buy({
          mint: event.mint,
          solAmount: this.config.positionSizeSol,
          referencePrice: event.price,
          maxPriceJumpPct: this.config.maxEntryPriceJumpPct,
        });
      }
      const openedAt = this.now();
      position.status = 'OPEN';
      position.tokenAmountRaw = result.tokenAmountRaw;
      position.entryPrice = result.expectedPrice || event.price;
      position.highestPrice = position.entryPrice;
      position.openedAt = openedAt;
      this.store.recordLiveOrder({
        positionId: position.id,
        decisionId: decision.id,
        mint: position.mint,
        side: 'BUY',
        venue: result.venue,
        attempt: 1,
        requestedSol: this.config.positionSizeSol,
        requestedTokenRaw: result.tokenAmountRaw,
        status: 'CONFIRMED',
        signature: result.signature,
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
      this.store.updateSmartOpenDecision(decision.id, 'OPEN', null);
      this.metrics.entries += 1;
      this.metrics.lastActionAt = openedAt;
      this._scheduleMaxHold(position);
    } catch (error) {
      const failedAt = this.now();
      const confirmationUnknown = Boolean(error.signature);
      this.store.recordLiveOrder({
        positionId: position.id,
        decisionId: decision.id,
        mint: position.mint,
        side: 'BUY',
        venue: 'PUMP_BONDING_CURVE',
        attempt: 1,
        requestedSol: this.config.positionSizeSol,
        status: confirmationUnknown ? 'CONFIRMATION_UNKNOWN' : 'FAILED',
        signature: error.signature,
        error: errorText(error),
        submittedAt,
      });
      if (confirmationUnknown) {
        position.status = 'EXIT_FAILED';
        position.tokenAmountRaw = null;
        this.store.updateLivePosition(position.id, {
          status: 'EXIT_FAILED',
          entrySignature: error.signature,
          entryError: errorText(error),
          exitReason: 'ENTRY_CONFIRMATION_UNKNOWN',
        });
        this.store.updateSmartOpenDecision(
          decision.id,
          'ENTRY_CONFIRMATION_UNKNOWN',
          errorText(error),
        );
        this.metrics.entryFailures += 1;
        this.metrics.lastActionAt = failedAt;
        this._rememberError(error);
        this._requestExit(position, 'ENTRY_CONFIRMATION_UNKNOWN', null);
        return;
      }
      this.store.updateLivePosition(position.id, {
        status: 'ENTRY_FAILED',
        entryError: errorText(error),
      });
      this.store.updateSmartOpenDecision(decision.id, 'ENTRY_FAILED', error.code || errorText(error));
      this.positions.delete(position.mint);
      this.metrics.entryFailures += 1;
      this.metrics.lastActionAt = failedAt;
      this._rememberError(error);
    }
  }

  _considerSmartExit(event) {
    if (!this.config.exitOnTriggerWalletSell || event.side !== 'SELL') return;
    const position = this.positions.get(event.mint);
    if (!position || position.triggerWallet !== event.wallet || position.status !== 'OPEN') return;
    const openedAt = position.openedAt || position.createdAt || 0;
    if (this.now() - openedAt < this.config.minHoldMs) return;
    this._requestExit(position, `SMART_WALLET_${event.positionPhase || 'SELL'}`, event.price);
  }

  _scheduleMaxHold(position) {
    if (this.timers.has(position.id)) clearTimeout(this.timers.get(position.id));
    const openedAt = position.openedAt || position.createdAt || this.now();
    const delay = Math.max(0, openedAt + this.config.maxHoldMs - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(position.id);
      this._requestExit(position, 'MAX_HOLD', null);
    }, delay);
    if (timer.unref) timer.unref();
    this.timers.set(position.id, timer);
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
            signature: `DRY-SELL-${position.decisionId}`,
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
        this.store.recordLiveOrder({
          positionId: position.id,
          decisionId: position.decisionId,
          mint: position.mint,
          side: 'SELL',
          venue: result.venue,
          attempt,
          requestedTokenRaw: position.tokenAmountRaw,
          status: result.alreadyEmpty ? 'ALREADY_EMPTY' : 'CONFIRMED',
          signature: result.signature,
          submittedAt,
          confirmedAt: closedAt,
        });
        this.store.updateLivePosition(position.id, {
          status: 'CLOSED',
          exitMarket: result.venue,
          exitPrice: observedPrice,
          exitSignature: result.signature,
          exitReason: reason,
          closedAt,
        });
        this.store.updateSmartOpenDecision(position.decisionId, 'CLOSED', reason);
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
        this.store.recordLiveOrder({
          positionId: position.id,
          decisionId: position.decisionId,
          mint: position.mint,
          side: 'SELL',
          attempt,
          requestedTokenRaw: position.tokenAmountRaw,
          status: 'FAILED',
          signature: error.signature,
          error: errorText(error),
          submittedAt,
        });
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
    this.store.updateSmartOpenDecision(
      position.decisionId,
      'EXIT_FAILED',
      errorText(lastError),
    );
    this.metrics.exitFailures += 1;
    this._rememberError(lastError);
  }
}

module.exports = LiveTradingManager;
