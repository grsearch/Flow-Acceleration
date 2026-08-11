'use strict';

const { costBreakdown } = require('./CostModel');

const STATUS = Object.freeze({
  RULE_REJECTED: 'RULE_REJECTED',
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

function valueOf(row, snake, camel) {
  return row?.[snake] ?? row?.[camel];
}

function restoredPosition(row) {
  return {
    id: row.id,
    cohortId: valueOf(row, 'cohort_id', 'cohortId'),
    episodeId: valueOf(row, 'episode_id', 'episodeId'),
    signalId: valueOf(row, 'signal_id', 'signalId'),
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    signalAt: valueOf(row, 'signal_at', 'signalAt'),
    signalPrice: valueOf(row, 'signal_price', 'signalPrice'),
    signalCurvePct: valueOf(row, 'signal_curve_pct', 'signalCurvePct'),
    entryTargetAt: valueOf(row, 'entry_target_at', 'entryTargetAt'),
    entryDeadlineAt: valueOf(row, 'entry_deadline_at', 'entryDeadlineAt'),
    entryAt: valueOf(row, 'entry_at', 'entryAt'),
    entryMarket: valueOf(row, 'entry_market', 'entryMarket'),
    entryPrice: valueOf(row, 'entry_price', 'entryPrice'),
    entryJumpPct: valueOf(row, 'entry_jump_pct', 'entryJumpPct'),
    highestPrice: valueOf(row, 'highest_price', 'highestPrice'),
    lowestPrice: valueOf(row, 'lowest_price', 'lowestPrice'),
    maxFavorableReturnPct: finite(
      valueOf(row, 'max_favorable_return_pct', 'maxFavorableReturnPct'),
      0,
    ),
    maxAdverseReturnPct: finite(
      valueOf(row, 'max_adverse_return_pct', 'maxAdverseReturnPct'),
      0,
    ),
    currentCheckpointPct: valueOf(row, 'current_checkpoint_pct', 'currentCheckpointPct'),
    nextCheckpointPct: valueOf(row, 'next_checkpoint_pct', 'nextCheckpointPct'),
    checkpointDeadlineAt: valueOf(row, 'checkpoint_deadline_at', 'checkpointDeadlineAt'),
    gatesPassed: finite(valueOf(row, 'gates_passed', 'gatesPassed'), 0),
    lastGateAt: valueOf(row, 'last_gate_at', 'lastGateAt'),
    lastGatePass: valueOf(row, 'last_gate_pass', 'lastGatePass'),
    graduationReady: Number(valueOf(row, 'graduation_ready', 'graduationReady') || 0) === 1,
    graduatedAt: valueOf(row, 'graduated_at', 'graduatedAt'),
    exitTargetMarket: valueOf(row, 'exit_target_market', 'exitTargetMarket'),
    exitTriggerAt: valueOf(row, 'exit_trigger_at', 'exitTriggerAt'),
    exitTargetAt: valueOf(row, 'exit_target_at', 'exitTargetAt'),
    exitDeadlineAt: valueOf(row, 'exit_deadline_at', 'exitDeadlineAt'),
    exitReason: valueOf(row, 'exit_reason', 'exitReason'),
  };
}

class GraduationHoldShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.cohorts = new Map((config.cohorts || []).map((cohort) => [cohort.id, cohort]));
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      signalsSeen: 0,
      eligibleSignals: 0,
      rejected: 0,
      deduplicated: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      gatesEvaluated: 0,
      gatesPassed: 0,
      gatesFailed: 0,
      graduationReady: 0,
      graduated: 0,
      closed: 0,
      noExit: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.store.activeGraduationHoldShadowPositions()) {
      const position = restoredPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const since = this.now() - this.config.stateRetentionMs;
    for (const trade of this.store.recentCurveTrades(since)) this._recordState(trade);
    this.advanceTime(this.now());
  }

  stop() {}

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_I',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      trackedMints: this.trackedMints().length,
      cohorts: [...this.cohorts.values()],
      strategy: {
        name: 'Graduation Probability Hold Overlay I0 / I1 / I2',
        entry: {
          signalVariant: this.config.signalVariant,
          maxSignalCurvePct: this.config.maxSignalCurvePct,
          entryDelayMs: this.config.entryDelayMs,
          entryTimeoutMs: this.config.entryTimeoutMs,
          maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
          freshEntryAboveMaxCurveBlocked: true,
        },
        checkpoints: this.config.checkpointRules,
        stepTimeoutMs: this.config.stepTimeoutMs,
        firstCheckpointTimeoutMs: this.config.firstCheckpointTimeoutMs,
        graduationTimeoutMs: this.config.graduationTimeoutMs,
        ammExitDelayMs: this.config.ammExitDelayMs,
        research: {
          isolatedTable: 'graduation_hold_shadow_positions',
          configuredCostPct: this.costs.deterministicCostPct,
          simulatedPositionSol: this.config.positionSizeSol,
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  trackedMints() {
    return [...new Set([
      ...[...this.pendingEntries.values()].map((row) => row.mint),
      ...[...this.positions.values()].map((row) => row.mint),
    ])];
  }

  onSignal(signal) {
    if (!this.config.enabled || signal?.signalVariant !== this.config.signalVariant
      || !(signal?.isPrimary === true || Number(signal?.isPrimary) === 1)) return [];
    this.metrics.signalsSeen += 1;
    const signalAt = finite(signal.timestampMs);
    const signalPrice = finite(signal.price);
    const curvePct = finite(signal.curvePct ?? signal.curve_pct);
    const ageMs = finite(signal.ageMs ?? signal.age_ms);
    if (!(signalAt > 0) || !(signalPrice > 0) || !signal.mint || !signal.signalId) return [];

    const reasons = [];
    const eventAgeMs = Math.max(0, this.now() - finite(signal.createdAt, signalAt));
    if (eventAgeMs > this.config.maxSignalLatencyMs) reasons.push('STALE_SIGNAL');
    if (curvePct == null) reasons.push('MISSING_CURVE');
    else if (curvePct > this.config.maxSignalCurvePct) reasons.push('HIGH_CURVE_FRESH_ENTRY_BLOCKED');
    if (ageMs != null && ageMs > this.config.maxTokenAgeMs) reasons.push('TOKEN_TOO_OLD');
    if ((this.rowsByMint.get(signal.mint)?.size || 0) > 0) reasons.push('MINT_ALREADY_ACTIVE');
    const episodeId = signal.signalEpisodeId
      || `${signal.mint}:${this.config.signalVariant}:${signalAt}`;
    const matched = reasons.length === 0;
    if (matched) this.metrics.eligibleSignals += 1;

    const savedRows = [];
    for (const cohort of this.cohorts.values()) {
      const saved = this.store.createGraduationHoldShadowPosition({
        cohortId: cohort.id,
        episodeId,
        signalId: signal.signalId,
        mint: signal.mint,
        symbol: signal.symbol,
        status: matched ? STATUS.PENDING_ENTRY : STATUS.RULE_REJECTED,
        rejectionReason: reasons.join(',') || null,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        signalAt,
        signalPrice,
        signalCurvePct: curvePct,
        signalNetFlowW3: finite(signal.netFlowW3),
        signalBuyersW3: finite(signal.uniqueBuyersW3),
        entryTargetAt: matched ? signalAt + this.config.entryDelayMs : null,
        entryDeadlineAt: matched
          ? signalAt + this.config.entryDelayMs + this.config.entryTimeoutMs : null,
        exitMode: cohort.exitMode,
      });
      if (!saved?.inserted) {
        this.metrics.deduplicated += 1;
        savedRows.push(saved);
        continue;
      }
      savedRows.push(saved);
      if (!matched) {
        this.metrics.rejected += 1;
        continue;
      }
      const position = restoredPosition(saved);
      this.pendingEntries.set(position.id, position);
      this._index(position);
    }
    this.metrics.lastActionAt = this.now();
    return savedRows;
  }

  onGraduated(tokenOrEvent) {
    const mint = tokenOrEvent?.mint;
    if (!this.config.enabled || !mint) return;
    const graduatedAt = finite(
      tokenOrEvent.graduated_at
      ?? tokenOrEvent.migrated_at
      ?? tokenOrEvent.completedAt
      ?? tokenOrEvent.migratedAt
      ?? tokenOrEvent.timestampMs,
      this.now(),
    );
    this.metrics.graduated += 1;
    for (const id of [...(this.rowsByMint.get(mint) || [])]) {
      const position = this.positions.get(id);
      if (!position) continue;
      position.graduatedAt = graduatedAt;
      this.store.updateGraduationHoldShadowPosition(position.id, { graduatedAt });
      if (position.status === STATUS.EXIT_PENDING) {
        this._rerouteExitToAmm(position, graduatedAt);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      if (position.cohortId === 'I2' && position.graduationReady) {
        this._requestExit(
          position,
          graduatedAt + this.config.ammExitDelayMs,
          'GRADUATED_AMM_DELAY',
          'PUMP_AMM',
        );
      } else {
        this._requestExit(position, graduatedAt, 'GRADUATED_FALLBACK_EXIT', 'PUMP_AMM');
      }
    }
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint || !(finite(trade.timestampMs) > 0)) return;
    const price = shadowPrice(trade);
    if (!(price > 0)) return;
    if (trade.market === 'PUMP_BONDING_CURVE') this._recordState(trade);
    const timestampMs = Number(trade.timestampMs);
    this.advanceTime(timestampMs);

    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      let position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (trade.market !== 'PUMP_BONDING_CURVE'
          || timestampMs < position.entryTargetAt || timestampMs > position.entryDeadlineAt) continue;
        const jumpPct = ((price / position.signalPrice) - 1) * 100;
        if (jumpPct > this.config.maxEntryPriceJumpPct) {
          this.store.updateGraduationHoldShadowPosition(position.id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
          });
          this.pendingEntries.delete(position.id);
          this._unindex(position);
          this.metrics.priceJump += 1;
          continue;
        }
        position.status = STATUS.OPEN;
        position.entryAt = timestampMs;
        position.entryMarket = trade.market;
        position.entryPrice = price;
        position.entryJumpPct = jumpPct;
        position.highestPrice = price;
        position.lowestPrice = price;
        position.currentCheckpointPct = position.cohortId === 'I0'
          ? finite(trade.curvePct, position.signalCurvePct)
          : position.signalCurvePct;
        position.nextCheckpointPct = this._nextCheckpoint(position.currentCheckpointPct);
        position.checkpointDeadlineAt = position.cohortId === 'I0' ? null
          : timestampMs + this.config.firstCheckpointTimeoutMs;
        this.store.updateGraduationHoldShadowPosition(position.id, {
          status: STATUS.OPEN,
          entryAt: timestampMs,
          entryMarket: trade.market,
          entryPrice: price,
          entryJumpPct: jumpPct,
          highestPrice: price,
          lowestPrice: price,
          maxFavorableReturnPct: 0,
          maxAdverseReturnPct: 0,
          currentCheckpointPct: position.currentCheckpointPct,
          nextCheckpointPct: position.nextCheckpointPct,
          checkpointDeadlineAt: position.checkpointDeadlineAt,
        });
        this.pendingEntries.delete(position.id);
        this.positions.set(position.id, position);
        this.metrics.opened += 1;
        if (position.cohortId !== 'I0') this._evaluateCheckpoints(position, trade);
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        if (this._eligibleExitTrade(position, trade, price)
          && timestampMs >= position.exitTargetAt
          && timestampMs <= position.exitDeadlineAt) this._close(position, trade, price);
        continue;
      }
      if (position.status !== STATUS.OPEN || timestampMs < position.entryAt
        || !this._eligibleObservedTrade(position, trade, price)) continue;
      this._updateExtrema(position, timestampMs, price);
      const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
      if (grossReturnPct <= -this.config.hardStopPct) {
        this._requestExit(position, timestampMs, 'HARD_STOP', trade.market);
        continue;
      }
      if (position.cohortId === 'I0') {
        const drawdownPct = (1 - price / position.highestPrice) * 100;
        if (drawdownPct >= this.config.controlTrailingStopPct) {
          this._requestExit(position, timestampMs, 'CONTROL_TRAILING', trade.market);
        }
        continue;
      }
      if (trade.market !== 'PUMP_BONDING_CURVE') continue;
      this._evaluateCheckpoints(position, trade);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const position of [...this.pendingEntries.values()]) {
      if (now <= position.entryDeadlineAt) continue;
      this.store.updateGraduationHoldShadowPosition(position.id, { status: STATUS.NO_ENTRY });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING) {
        if (now > position.exitDeadlineAt) this._markNoExit(position);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      const maxHoldMs = position.cohortId === 'I0'
        ? this.config.controlMaxHoldMs : this.config.maxHoldMs;
      if (now >= position.entryAt + maxHoldMs) {
        this._requestExit(position, position.entryAt + maxHoldMs, 'MAX_HOLD', null);
        continue;
      }
      if (position.cohortId !== 'I0' && position.checkpointDeadlineAt
        && now > position.checkpointDeadlineAt) {
        const reason = position.graduationReady
          ? 'GRADUATION_TIMEOUT' : `CHECKPOINT_${position.nextCheckpointPct}_TIMEOUT`;
        this._requestExit(position, position.checkpointDeadlineAt, reason, null);
      }
    }
    for (const [mint, state] of this.states) {
      if (now - state.lastAt > this.config.stateRetentionMs) this.states.delete(mint);
    }
  }

  _recordState(trade) {
    const timestampMs = finite(trade.timestampMs);
    if (!(timestampMs > 0)) return;
    let state = this.states.get(trade.mint);
    if (!state) {
      state = { events: [], totalCurveTrades: 0, lastAt: timestampMs };
      this.states.set(trade.mint, state);
    }
    state.totalCurveTrades += 1;
    state.lastAt = timestampMs;
    state.events.push({
      timestampMs,
      side: trade.side,
      solAmount: finite(trade.solAmount, 0),
      wallet: trade.wallet || null,
      curvePct: finite(trade.curvePct),
    });
    const cutoff = timestampMs - 5_000;
    while (state.events.length && state.events[0].timestampMs < cutoff) state.events.shift();
  }

  _features(mint, timestampMs, currentCurvePct) {
    const state = this.states.get(mint) || { events: [], totalCurveTrades: 0 };
    const rows = state.events.filter((row) => row.timestampMs >= timestampMs - 5_000);
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buySol5 = buys.reduce((sum, row) => sum + row.solAmount, 0);
    const sellSol5 = sells.reduce((sum, row) => sum + row.solAmount, 0);
    const firstCurve = rows.find((row) => row.curvePct != null)?.curvePct;
    return {
      curvePct: finite(currentCurvePct),
      netFlow5: buySol5 - sellSol5,
      buySol5,
      sellSol5,
      buyers5: new Set(buys.map((row) => row.wallet).filter(Boolean)).size,
      buyTx5: buys.length,
      sellTx5: sells.length,
      curveDelta5: firstCurve == null || currentCurvePct == null
        ? null : currentCurvePct - firstCurve,
      cumulativeCurveTrades: state.totalCurveTrades,
    };
  }

  _evaluateCheckpoints(position, trade) {
    let checkpoint = position.nextCheckpointPct;
    const curvePct = finite(trade.curvePct);
    if (checkpoint == null || curvePct == null || curvePct < checkpoint) return;
    while (checkpoint != null && curvePct >= checkpoint && position.status === STATUS.OPEN) {
      if (checkpoint >= 97) {
        position.currentCheckpointPct = 97;
        position.nextCheckpointPct = null;
        if (position.cohortId === 'I1') {
          this._requestExit(position, trade.timestampMs, 'PRE_GRAD_CURVE_97', 'PUMP_BONDING_CURVE');
        } else {
          position.graduationReady = true;
          position.checkpointDeadlineAt = trade.timestampMs + this.config.graduationTimeoutMs;
          this.metrics.graduationReady += 1;
          this.store.updateGraduationHoldShadowPosition(position.id, {
            currentCheckpointPct: 97,
            nextCheckpointPct: null,
            checkpointDeadlineAt: position.checkpointDeadlineAt,
            graduationReady: 1,
          });
        }
        return;
      }
      const features = this._features(position.mint, trade.timestampMs, curvePct);
      const gate = this._gate(position.cohortId, checkpoint, features);
      this.metrics.gatesEvaluated += 1;
      const history = {
        checkpoint,
        observedAt: trade.timestampMs,
        pass: gate.pass,
        reasons: gate.reasons,
        features,
      };
      this.store.updateGraduationHoldShadowPosition(position.id, {
        lastGateAt: trade.timestampMs,
        lastGatePass: gate.pass ? 1 : 0,
        lastFeaturesJson: JSON.stringify(features),
        appendCheckpointHistory: history,
      });
      position.lastGateAt = trade.timestampMs;
      position.lastGatePass = gate.pass ? 1 : 0;
      if (!gate.pass) {
        this.metrics.gatesFailed += 1;
        this._requestExit(
          position,
          trade.timestampMs,
          `GATE_${checkpoint}_FAIL_${gate.reasons.join('_')}`,
          'PUMP_BONDING_CURVE',
        );
        return;
      }
      this.metrics.gatesPassed += 1;
      position.gatesPassed += 1;
      position.currentCheckpointPct = checkpoint;
      position.nextCheckpointPct = this._nextCheckpoint(checkpoint);
      position.checkpointDeadlineAt = trade.timestampMs + this.config.stepTimeoutMs;
      this.store.updateGraduationHoldShadowPosition(position.id, {
        currentCheckpointPct: checkpoint,
        nextCheckpointPct: position.nextCheckpointPct,
        checkpointDeadlineAt: position.checkpointDeadlineAt,
        gatesPassed: position.gatesPassed,
      });
      checkpoint = position.nextCheckpointPct;
    }
  }

  _gate(cohortId, checkpoint, features) {
    const rule = [...this.config.checkpointRules]
      .reverse().find((item) => checkpoint >= item.thresholdPct) || {};
    const reasons = [];
    if (features.netFlow5 < (rule.minNetFlow5Sol ?? -Infinity)) reasons.push('NET5');
    if (features.buyers5 < (rule.minBuyers5 ?? 0)) reasons.push('BUYERS5');
    if (rule.maxSellSol5 != null && features.sellSol5 > rule.maxSellSol5) reasons.push('SELL5');
    if (rule.minCurveDelta5 != null
      && finite(features.curveDelta5, -Infinity) < rule.minCurveDelta5) reasons.push('CURVE_DELTA5');
    if (cohortId === 'I2' && checkpoint >= 90) {
      if (features.buyers5 < this.config.bridgeMinBuyers5) reasons.push('BRIDGE_BUYERS5');
      if (checkpoint >= 95
        && features.cumulativeCurveTrades > this.config.bridgeMaxCumulativeTrades) {
        reasons.push('BRIDGE_TRADE_COUNT');
      }
    }
    return { pass: reasons.length === 0, reasons };
  }

  _nextCheckpoint(curvePct) {
    return this.config.checkpoints.find((checkpoint) => checkpoint > finite(curvePct, 0)) ?? null;
  }

  _eligibleObservedTrade(position, trade, price) {
    if (trade.market === 'PUMP_BONDING_CURVE') return !position.graduatedAt;
    if (trade.market !== 'PUMP_AMM' || !position.graduatedAt
      || trade.timestampMs < position.graduatedAt) return false;
    const ratio = price / position.entryPrice;
    return ratio >= 0.05 && ratio <= 20;
  }

  _eligibleExitTrade(position, trade, price) {
    if (!this._eligibleObservedTrade(position, trade, price)) return false;
    return !position.exitTargetMarket || trade.market === position.exitTargetMarket;
  }

  _updateExtrema(position, timestampMs, price) {
    position.highestPrice = Math.max(position.highestPrice || position.entryPrice, price);
    position.lowestPrice = Math.min(position.lowestPrice || position.entryPrice, price);
    position.maxFavorableReturnPct = Math.max(
      position.maxFavorableReturnPct || 0,
      ((position.highestPrice / position.entryPrice) - 1) * 100,
    );
    position.maxAdverseReturnPct = Math.min(
      position.maxAdverseReturnPct || 0,
      ((position.lowestPrice / position.entryPrice) - 1) * 100,
    );
    this.store.updateGraduationHoldShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _requestExit(position, triggerAt, reason, targetMarket) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    position.exitTargetMarket = targetMarket;
    this.store.updateGraduationHoldShadowPosition(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTargetMarket: targetMarket,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
    this.metrics.lastActionAt = this.now();
  }

  _rerouteExitToAmm(position, graduatedAt) {
    position.exitReason = `${position.exitReason || 'EXIT'}_MIGRATION_REROUTE`;
    position.exitTriggerAt = graduatedAt;
    position.exitTargetAt = graduatedAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    position.exitTargetMarket = 'PUMP_AMM';
    this.store.updateGraduationHoldShadowPosition(position.id, {
      exitReason: position.exitReason,
      exitTargetMarket: position.exitTargetMarket,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
    this.metrics.lastActionAt = this.now();
  }

  _close(position, trade, price) {
    this._updateExtrema(position, trade.timestampMs, price);
    const grossReturnPct = ((price / position.entryPrice) - 1) * 100;
    this.store.updateGraduationHoldShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
      grossReturnPct,
      netReturnPct: grossReturnPct - this.costs.deterministicCostPct,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _markNoExit(position) {
    this.store.updateGraduationHoldShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      grossReturnPct: -100,
      netReturnPct: -100 - this.costs.deterministicCostPct,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
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
    if (!ids.size) this.rowsByMint.delete(position.mint);
  }
}

module.exports = { GraduationHoldShadowSuite, STATUS, shadowPrice };
