'use strict';

const { costBreakdown } = require('./CostModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');

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

function rowPosition(row) {
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
    this.rowsByMint = new Map();
    this.graduatedMints = new Set();
    this.postMigrationTrades = new Map();
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
      runnerExits: 0,
      closed: 0,
      noExit: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.store.activeGraduationAccelerationShadowPositions()) {
      const position = rowPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      if (position.graduatedAt) this.graduatedMints.add(position.mint);
      this._index(position);
    }
    const startupAt = this.now();
    const postMigrationSince = startupAt - Math.max(this.config.maxPostGraduationHoldMs, 30_000);
    for (const trade of this.store.recentAmmTrades(postMigrationSince)) {
      this._recordPostMigrationTrade(trade);
    }
    const since = startupAt - Math.max(this.config.maxPreGraduationHoldMs, 30_000);
    for (const trade of this.store.recentCurveTrades(since)) this._recordState(trade);
    for (const state of this.states.values()) {
      for (const profile of this.entryProfiles.values()) {
        if (profile.mode === 'FIXED_10S'
          && startupAt >= state.createdAt + profile.horizonMs) {
          state.fixedEvaluated = true;
          this.metrics.replayEvaluationsSuppressed += 1;
        } else if (profile.mode === 'CURVE_MILESTONE'
          && state.events.some((row) => row.curvePct >= profile.thresholdPct)) {
          state.crossed.add(profile.id);
          this.metrics.replayEvaluationsSuppressed += 1;
        }
      }
    }
    this.advanceTime(startupAt);
  }

  stop() {}

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_O',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      trackedMints: this.trackedMints().length,
      entryProfiles: [...this.entryProfiles.values()],
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
          noExitPricedAsLoss: false,
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  trackedMints() {
    return [...new Set([...this.pendingEntries.values(), ...this.positions.values()]
      .map((row) => row.mint))];
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
    if (trade.market === 'PUMP_AMM') this._recordPostMigrationTrade(trade);
    this.advanceTime(timestampMs);
    this._observePositions(trade, price);
    if (trade.market !== 'PUMP_BONDING_CURVE') return;
    const state = this._recordState(trade);
    if (!state) return;
    this._evaluateEntries(state, trade, price);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this.store.updateGraduationAccelerationShadowPosition(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'NO_CURVE_TRADE_IN_ENTRY_WINDOW',
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
        const profile = this.entryProfiles.get(position.entryProfileId);
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
        if (now >= position.graduatedAt + maxHoldMs) {
          this._requestExit(position,
            position.graduatedAt + maxHoldMs,
            'MAX_POST_GRAD_RUNNER', 'PUMP_AMM');
        }
      }
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
      if (state.triggered.has(profile.id)) continue;
      let matched = false;
      let features = null;
      if (profile.mode === 'FIXED_10S') {
        if (ageMs < profile.horizonMs || state.fixedEvaluated) continue;
        state.fixedEvaluated = true;
        const rows = state.events.filter((row) => row.timestampMs <= state.createdAt + profile.horizonMs);
        features = this._features(rows);
        const ratio = features.buySol > 0 ? features.sellSol / features.buySol : null;
        matched = features.curvePct >= profile.minCurvePct
          && features.buyers >= profile.minBuyers
          && ratio != null && ratio <= profile.maxSellBuyRatio;
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
          && features.sellTx <= profile.maxSellTx
          && (!profile.requireNoCreatorSell || !state.creatorSold);
      }
      this.metrics.evaluated += 1;
      if (!matched) continue;
      state.triggered.add(profile.id);
      this.metrics.signals += 1;
      this._createPendingRows(state, profile, trade, price, features);
    }
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
    for (const positionSol of this.capacitySols) {
      const costs = costBreakdown({ ...this.config.costModel, positionSizeSol: positionSol });
      const cohortId = `${profile.id}:${capacityId(positionSol)}`;
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
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
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

  _observePositions(trade, price) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const pending = this.pendingEntries.get(id);
      if (pending) {
        if (trade.market !== 'PUMP_BONDING_CURVE'
          || trade.timestampMs < pending.entryTargetAt
          || trade.timestampMs > pending.entryDeadlineAt) continue;
        const rugGuard = evaluateUniversalRugGuard(this.store, {
          strategyId: `GRADUATION_ACCEL:${pending.cohortId}`,
          mint: pending.mint,
          timestampMs: trade.timestampMs,
        });
        if (rugGuard.blocked) {
          this.store.updateGraduationAccelerationShadowPosition(id, {
            status: STATUS.NO_ENTRY,
            rejectionReason: 'PRE_ENTRY_RUG_RISK',
          });
          this.pendingEntries.delete(id);
          this._unindex(pending);
          continue;
        }
        const fillPrice = curveBuyAveragePrice(trade, pending.positionSol, price);
        const jumpPct = ((fillPrice / pending.signalPrice) - 1) * 100;
        if (jumpPct > this.config.maxEntryPriceJumpPct) {
          this.store.updateGraduationAccelerationShadowPosition(id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_JUMP_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
            entryImpactPct: ((fillPrice / price) - 1) * 100,
          });
          this.pendingEntries.delete(id);
          this._unindex(pending);
          this.metrics.priceJump += 1;
          continue;
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
      if (gross <= -this.config.hardStopPct) {
        this._requestExit(position, trade.timestampMs, 'HARD_STOP', trade.market);
        continue;
      }
      if (position.status === STATUS.RUNNER) this._observeRunner(position, trade, price, gross);
    }
  }

  _takeCore(position, trade, price) {
    this._updateExtrema(position, trade.timestampMs, price);
    position.coreExitAt = trade.timestampMs;
    position.coreExitPrice = price;
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
    const profile = this.entryProfiles.get(position.entryProfileId);
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
      if (trade.timestampMs >= position.graduatedAt + maxHoldMs) {
        this._requestExit(position, position.graduatedAt + maxHoldMs,
          `RUNNER_FIXED_${maxHoldMs / 1_000}S`, 'PUMP_AMM');
      }
      return;
    }
    position.runnerHighestPrice = Math.max(position.runnerHighestPrice || price, price);
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

  _recordPostMigrationTrade(trade) {
    if (trade?.market !== 'PUMP_AMM' || !trade.mint) return;
    const timestampMs = finite(trade.timestampMs);
    if (!(timestampMs > 0)) return;
    const positions = [...(this.rowsByMint.get(trade.mint) || [])]
      .map((id) => this.positions.get(id))
      .filter(Boolean);
    const gated = positions.filter((position) => (
      this.entryProfiles.get(position.entryProfileId)?.postMigrationGate
      && position.graduatedAt > 0
    ));
    if (!gated.length) return;
    const graduatedAt = Math.min(...gated.map((position) => position.graduatedAt));
    const maxWindowMs = Math.max(...gated.map((position) => (
      this.entryProfiles.get(position.entryProfileId).postMigrationGate.windowMs
    )));
    if (timestampMs < graduatedAt || timestampMs > graduatedAt + maxWindowMs) return;
    const rows = this.postMigrationTrades.get(trade.mint) || [];
    rows.push({
      timestampMs,
      side: trade.side,
      wallet: trade.wallet || null,
      solAmount: finite(trade.solAmount, 0),
    });
    rows.sort((left, right) => left.timestampMs - right.timestampMs);
    this.postMigrationTrades.set(trade.mint, rows);
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
    position.highestPrice = Math.max(position.highestPrice || position.entryPrice, price);
    position.lowestPrice = Math.min(position.lowestPrice || position.entryPrice, price);
    position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct || 0,
      ((position.highestPrice / position.entryPrice) - 1) * 100);
    position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct || 0,
      ((position.lowestPrice / position.entryPrice) - 1) * 100);
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _requestExit(position, triggerAt, reason, market) {
    if (![STATUS.OPEN, STATUS.RUNNER].includes(position.status)) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitReason = reason;
    position.exitTargetMarket = market;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
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
    const coreWeight = position.coreExitPrice ? position.coreWeightPct / 100 : 0;
    const runnerWeight = 1 - coreWeight;
    const proceeds = position.tokenUnits
      * ((position.coreExitPrice || 0) * coreWeight + price * runnerWeight);
    const grossReturnPct = ((proceeds / position.positionSol) - 1) * 100;
    const costs = costBreakdown({ ...this.config.costModel, positionSizeSol: position.positionSol });
    const extraExitCostPct = position.coreExitPrice ? costs.fixedCostPct : 0;
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
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

  _markNoExit(position, reason) {
    this.store.updateGraduationAccelerationShadowPosition(position.id, {
      status: STATUS.NO_EXIT,
      rejectionReason: reason,
      exitReason: position.exitReason || reason,
      grossReturnPct: null,
      netReturnPct: null,
    });
    this.positions.delete(position.id);
    this._unindex(position);
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
};
