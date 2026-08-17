'use strict';

const { costBreakdown } = require('./CostModel');

const STATUS = Object.freeze({
  PENDING_ENTRY: 'PENDING_ENTRY',
  PRICE_JUMP: 'PRICE_JUMP',
  NO_ENTRY: 'NO_ENTRY',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  NO_EXIT: 'NO_EXIT',
});

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function priceOf(trade) {
  const reserve = finite(trade?.reservePrice);
  return reserve > 0 ? reserve : finite(trade?.price);
}

function returnPct(price, base) {
  return price > 0 && base > 0 ? ((price / base) - 1) * 100 : null;
}

function camelRow(row) {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    entryProfileId: row.entry_profile_id,
    exitProfileId: row.exit_profile_id,
    episodeId: row.episode_id,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    positionSol: finite(row.position_sol, 1),
    configuredCostPct: finite(row.configured_cost_pct, 0),
    graduatedAt: finite(row.graduated_at),
    baselinePrice: finite(row.baseline_price),
    signalAt: finite(row.signal_at),
    signalPrice: finite(row.signal_price),
    entryTargetAt: finite(row.entry_target_at),
    entryDeadlineAt: finite(row.entry_deadline_at),
    entryAt: finite(row.entry_at),
    entryPrice: finite(row.entry_price),
    entryMarketPrice: finite(row.entry_market_price),
    entryImpactPct: finite(row.entry_impact_pct),
    highestPrice: finite(row.highest_price),
    lowestPrice: finite(row.lowest_price),
    lastObservedAt: finite(row.last_observed_at),
    maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
    maxAdverseReturnPct: finite(row.max_adverse_return_pct, 0),
    coreWeight: finite(row.core_weight_pct, 0) / 100,
    coreExitAt: finite(row.core_exit_at),
    coreExitPrice: finite(row.core_exit_price),
    coreReturnPct: finite(row.core_return_pct),
    runnerHighPrice: finite(row.runner_high_price),
  };
}

function percentile(values, q) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] * (upper - position) + ordered[upper] * (position - lower);
}

class BigWinnerShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      observedTrades: 0,
      priceScaleRows: 0,
      evaluated: 0,
      qualifiedSignals: 0,
      replaySignalsSuppressed: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      coreExits: 0,
      closed: 0,
      noExit: 0,
      lastActionAt: null,
      lastError: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS big_winner_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        graduated_at INTEGER NOT NULL,
        baseline_price REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        signal_age_ms INTEGER,
        first_wave_pct REAL,
        pullback_pct REAL,
        rebound_pct REAL,
        net_flow_3s REAL,
        previous_net_flow_3s REAL,
        buyers_3s INTEGER,
        max_sell_3s REAL,
        net_flow_8s REAL,
        buyers_8s INTEGER,
        largest_buyer_share_8s REAL,
        runup_pct REAL,
        drawdown_10s_pct REAL,
        jump_2s_pct REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_price REAL,
        entry_market_price REAL,
        entry_jump_pct REAL,
        entry_impact_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        core_weight_pct REAL NOT NULL,
        core_exit_at INTEGER,
        core_exit_price REAL,
        core_return_pct REAL,
        runner_high_price REAL,
        runner_stop_price REAL,
        runner_tier TEXT,
        exit_at INTEGER,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        estimated_cost_sol REAL,
        hold_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_big_winner_shadow_status
        ON big_winner_shadow_positions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_big_winner_shadow_mint
        ON big_winner_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_big_winner_shadow_profiles
        ON big_winner_shadow_positions(entry_profile_id, exit_profile_id, signal_at DESC);
    `);
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO big_winner_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id, mint, symbol,
        status, rejection_reason, position_sol, configured_cost_pct,
        graduated_at, baseline_price, signal_at, signal_price, signal_age_ms,
        first_wave_pct, pullback_pct, rebound_pct, net_flow_3s,
        previous_net_flow_3s, buyers_3s, max_sell_3s, net_flow_8s,
        buyers_8s, largest_buyer_share_8s, runup_pct, drawdown_10s_pct,
        jump_2s_pct, features_json, entry_target_at, entry_deadline_at,
        core_weight_pct, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId, @mint, @symbol,
        @status, @rejectionReason, @positionSol, @configuredCostPct,
        @graduatedAt, @baselinePrice, @signalAt, @signalPrice, @signalAgeMs,
        @firstWavePct, @pullbackPct, @reboundPct, @netFlow3s,
        @previousNetFlow3s, @buyers3s, @maxSell3s, @netFlow8s,
        @buyers8s, @largestBuyerShare8s, @runupPct, @drawdown10sPct,
        @jump2sPct, @featuresJson, @entryTargetAt, @entryDeadlineAt,
        @coreWeightPct, @createdAt, @updatedAt
      )
    `);
    this.active = this.store.db.prepare(`
      SELECT * FROM big_winner_shadow_positions
      WHERE status IN ('PENDING_ENTRY','OPEN') ORDER BY signal_at, id
    `);
    this.update = this.store.db.prepare(`
      UPDATE big_winner_shadow_positions SET
        status=COALESCE(@status,status),
        rejection_reason=COALESCE(@rejectionReason,rejection_reason),
        entry_at=COALESCE(@entryAt,entry_at),
        entry_price=COALESCE(@entryPrice,entry_price),
        entry_market_price=COALESCE(@entryMarketPrice,entry_market_price),
        entry_jump_pct=COALESCE(@entryJumpPct,entry_jump_pct),
        entry_impact_pct=COALESCE(@entryImpactPct,entry_impact_pct),
        highest_price=COALESCE(@highestPrice,highest_price),
        lowest_price=COALESCE(@lowestPrice,lowest_price),
        last_observed_at=COALESCE(@lastObservedAt,last_observed_at),
        last_price=COALESCE(@lastPrice,last_price),
        max_favorable_return_pct=COALESCE(@maxFavorableReturnPct,max_favorable_return_pct),
        max_adverse_return_pct=COALESCE(@maxAdverseReturnPct,max_adverse_return_pct),
        core_exit_at=COALESCE(@coreExitAt,core_exit_at),
        core_exit_price=COALESCE(@coreExitPrice,core_exit_price),
        core_return_pct=COALESCE(@coreReturnPct,core_return_pct),
        runner_high_price=COALESCE(@runnerHighPrice,runner_high_price),
        runner_stop_price=COALESCE(@runnerStopPrice,runner_stop_price),
        runner_tier=COALESCE(@runnerTier,runner_tier),
        exit_at=COALESCE(@exitAt,exit_at),
        exit_price=COALESCE(@exitPrice,exit_price),
        exit_reason=COALESCE(@exitReason,exit_reason),
        gross_return_pct=COALESCE(@grossReturnPct,gross_return_pct),
        net_return_pct=COALESCE(@netReturnPct,net_return_pct),
        estimated_cost_sol=COALESCE(@estimatedCostSol,estimated_cost_sol),
        hold_ms=COALESCE(@holdMs,hold_ms),
        updated_at=@updatedAt
      WHERE id=@id
    `);
    this.markNoExit = this.store.db.prepare(`
      UPDATE big_winner_shadow_positions
      SET status='NO_EXIT', exit_reason=@exitReason, net_return_pct=NULL,
        gross_return_pct=NULL, updated_at=@updatedAt WHERE id=@id
    `);
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.active.all()) {
      const position = camelRow(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const since = this.now() - this.config.stateRetentionMs;
    const replay = this.store.recentAmmTrades(since);
    for (const trade of replay) this.observeTrade(trade, { replay: true });
    const recentSignals = this.store.db.prepare(`
      SELECT DISTINCT mint, entry_profile_id
      FROM big_winner_shadow_positions
      WHERE signal_at >= ?
    `).all(since);
    for (const row of recentSignals) this._state(row.mint).fired.add(row.entry_profile_id);
    this.advanceTime(this.now());
  }

  stop() {}

  trackedMints() {
    return [...this.rowsByMint.keys()];
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_BW',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        name: 'Big Winner Pullback + Flow Runner',
        cohortCount: this.entryProfiles.size * this.exitProfiles.size,
        entryDelayMs: this.config.entryDelayMs,
        entryTimeoutMs: this.config.entryTimeoutMs,
        positionSizeSol: this.config.positionSizeSol,
        research: {
          isolatedTable: 'big_winner_shadow_positions',
          historicalBacktest: '2026-08-11..2026-08-17 train/test split',
          noExitPricedAsTotalLoss: false,
          sameMarketOnly: 'PUMP_AMM',
          sendsTransactions: false,
        },
      },
      ...this.metrics,
    };
  }

  onGraduated(tokenOrEvent) {
    if (!this.config.enabled || !tokenOrEvent?.mint) return;
    const graduatedAt = finite(
      tokenOrEvent.graduated_at ?? tokenOrEvent.graduatedAt
      ?? tokenOrEvent.migrated_at ?? tokenOrEvent.migratedAt
      ?? tokenOrEvent.completedAt ?? tokenOrEvent.timestampMs,
      this.now(),
    );
    const state = this._state(tokenOrEvent.mint);
    state.graduatedAt = graduatedAt;
    state.symbol = tokenOrEvent.symbol || state.symbol || null;
  }

  observeTrade(trade, { replay = false } = {}) {
    const timestampMs = finite(trade?.timestampMs);
    const price = priceOf(trade);
    if (!this.config.enabled || trade?.market !== 'PUMP_AMM' || !trade?.mint
      || !(timestampMs > 0) || !(price > 0)) return;
    this.advanceTime(timestampMs);
    const state = this._state(trade.mint);
    const previousPrice = state.events[state.events.length - 1]?.price;
    if (previousPrice > 0) {
      const scale = price / previousPrice;
      if (scale > this.config.maxAdjacentPriceRatio
        || scale < 1 / this.config.maxAdjacentPriceRatio) {
        this.metrics.priceScaleRows += 1;
        return;
      }
    }
    const features = this._observeState(state, trade, price);
    this._observePositions(trade, price);
    this.metrics.observedTrades += 1;
    if (replay) {
      this.metrics.replaySignalsSuppressed += 1;
      return;
    }
    for (const profile of this.entryProfiles.values()) {
      if (state.fired.has(profile.id) || !this._matches(profile, features)) continue;
      state.fired.add(profile.id);
      this.metrics.qualifiedSignals += 1;
      this._recordSignal(profile, state, trade, price, features);
    }
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const position of [...this.pendingEntries.values()]) {
      if (now <= position.entryDeadlineAt) continue;
      this._patch(position.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'NO_PUMPSWAP_TRADE_IN_ENTRY_WINDOW',
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      const exit = this.exitProfiles.get(position.exitProfileId);
      const deadline = position.entryAt + exit.maxHoldMs + this.config.noExitGraceMs;
      if (now <= deadline || position.lastObservedAt >= position.entryAt + exit.maxHoldMs) continue;
      this.markNoExit.run({
        id: position.id,
        exitReason: 'NO_EXECUTABLE_PUMPSWAP_EXIT_TRADE',
        updatedAt: now,
      });
      this.positions.delete(position.id);
      this._unindex(position);
      this.metrics.noExit += 1;
    }
    const cutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      if (state.lastAt < cutoff && !this.rowsByMint.has(mint)) this.states.delete(mint);
    }
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      const token = this.store.getToken(mint) || {};
      state = {
        mint,
        symbol: token.symbol || null,
        graduatedAt: finite(token.graduated_at ?? token.graduatedAt),
        baselinePrice: null,
        peakPrice: null,
        peakAt: null,
        pullbackLowPrice: null,
        events: [],
        fired: new Set(),
        lastAt: 0,
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _observeState(state, trade, price) {
    if (!(state.graduatedAt > 0)) {
      const token = this.store.getToken(trade.mint) || {};
      state.graduatedAt = finite(token.graduated_at ?? token.graduatedAt, trade.timestampMs);
      state.symbol = token.symbol || state.symbol;
    }
    if (!(state.baselinePrice > 0)) {
      state.baselinePrice = price;
      state.peakPrice = price;
      state.peakAt = trade.timestampMs;
      state.pullbackLowPrice = price;
    } else if (price > state.peakPrice) {
      state.peakPrice = price;
      state.peakAt = trade.timestampMs;
      state.pullbackLowPrice = price;
    } else if (trade.timestampMs > state.peakAt) {
      state.pullbackLowPrice = Math.min(state.pullbackLowPrice || price, price);
    }
    state.lastAt = trade.timestampMs;
    state.events.push({
      timestampMs: trade.timestampMs,
      side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      price,
    });
    const cutoff = trade.timestampMs - this.config.stateWindowMs;
    while (state.events.length && state.events[0].timestampMs < cutoff) state.events.shift();
    return this._features(state, trade.timestampMs, price);
  }

  _window(state, timestampMs, startMs, endMs = 0) {
    const startAt = timestampMs - startMs;
    const endAt = timestampMs - endMs;
    const rows = state.events.filter((row) => row.timestampMs >= startAt && row.timestampMs <= endAt);
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buySol = buys.reduce((sum, row) => sum + row.solAmount, 0);
    const sellSol = sells.reduce((sum, row) => sum + row.solAmount, 0);
    const byWallet = new Map();
    for (const row of buys) {
      if (!row.wallet) continue;
      byWallet.set(row.wallet, (byWallet.get(row.wallet) || 0) + row.solAmount);
    }
    return {
      buySol,
      sellSol,
      netFlow: buySol - sellSol,
      buyers: byWallet.size,
      maxSell: sells.reduce((max, row) => Math.max(max, row.solAmount), 0),
      concentration: buySol > 0 ? Math.max(0, ...byWallet.values()) / buySol : 1,
      high: rows.reduce((max, row) => Math.max(max, row.price), 0),
      firstPrice: rows[0]?.price || null,
    };
  }

  _features(state, timestampMs, price) {
    const w3 = this._window(state, timestampMs, 3_000);
    const previous3 = this._window(state, timestampMs, 6_000, 3_000);
    const previous5 = this._window(state, timestampMs, 8_000, 3_000);
    const w8 = this._window(state, timestampMs, 8_000);
    const w10 = this._window(state, timestampMs, 10_000);
    const w2 = this._window(state, timestampMs, 2_000);
    const ageMs = timestampMs - state.graduatedAt;
    const firstWavePct = returnPct(state.peakPrice, state.baselinePrice);
    const pullbackPct = state.peakPrice > 0 ? (1 - price / state.peakPrice) * 100 : null;
    const reboundPct = returnPct(price, state.pullbackLowPrice);
    const runupPct = returnPct(price, state.baselinePrice);
    const drawdown10sPct = w10.high > 0 ? returnPct(price, w10.high) : 0;
    const jump2sPct = w2.firstPrice > 0 ? returnPct(price, w2.firstPrice) : 0;
    return {
      ageMs,
      firstWavePct,
      pullbackPct,
      reboundPct,
      netFlow3s: w3.netFlow,
      previousNetFlow3s: previous3.netFlow,
      previousNetFlow5s: previous5.netFlow,
      buyers3s: w3.buyers,
      maxSell3s: w3.maxSell,
      netFlow8s: w8.netFlow,
      buyers8s: w8.buyers,
      largestBuyerShare8s: w8.concentration,
      runupPct,
      drawdown10sPct,
      jump2sPct,
    };
  }

  _matches(profile, f) {
    this.metrics.evaluated += 1;
    if (profile.family === 'PULLBACK') {
      return f.ageMs >= profile.minAgeMs && f.ageMs <= profile.maxAgeMs
        && f.firstWavePct >= profile.minFirstWavePct
        && f.pullbackPct >= profile.minPullbackPct
        && f.pullbackPct <= profile.maxPullbackPct
        && f.reboundPct >= profile.minReboundPct
        && f.reboundPct <= profile.maxReboundPct
        && f.netFlow3s >= profile.minNetFlow3sSol
        && f.buyers3s >= profile.minBuyers3s
        && f.netFlow3s > Math.max(0, f.previousNetFlow3s)
        && f.maxSell3s <= profile.maxSingleSell3sSol
        && f.runupPct >= profile.minCurrentVsBaselinePct;
    }
    if (profile.family === 'FLOW') {
      const flowContinuous = f.netFlow3s > 0 && (
        f.previousNetFlow5s <= 0
        || (f.netFlow3s / 3) >= (f.previousNetFlow5s / 5) * profile.minRecentFlowRatio
      );
      return f.ageMs >= profile.minAgeMs && f.ageMs <= profile.maxAgeMs
        && f.netFlow8s >= profile.minNetFlow8sSol
        && f.buyers8s >= profile.minBuyers8s
        && f.largestBuyerShare8s <= profile.maxLargestBuyerShare8s
        && f.runupPct >= 0 && f.runupPct <= profile.maxRunupPct
        && f.drawdown10sPct >= -profile.maxDistanceFromHigh10sPct
        && f.jump2sPct <= profile.maxJump2sPct
        && flowContinuous;
    }
    return false;
  }

  _recordSignal(profile, state, trade, price, features) {
    const episodeId = `${trade.mint}:${profile.id}:${trade.timestampMs}`;
    const now = this.now();
    for (const exit of this.exitProfiles.values()) {
      const result = this.insert.run({
        cohortId: `${profile.id}:${exit.id}`,
        entryProfileId: profile.id,
        exitProfileId: exit.id,
        episodeId,
        mint: trade.mint,
        symbol: state.symbol,
        status: STATUS.PENDING_ENTRY,
        rejectionReason: null,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        graduatedAt: state.graduatedAt,
        baselinePrice: state.baselinePrice,
        signalAt: trade.timestampMs,
        signalPrice: price,
        signalAgeMs: features.ageMs,
        firstWavePct: features.firstWavePct,
        pullbackPct: features.pullbackPct,
        reboundPct: features.reboundPct,
        netFlow3s: features.netFlow3s,
        previousNetFlow3s: features.previousNetFlow3s,
        buyers3s: features.buyers3s,
        maxSell3s: features.maxSell3s,
        netFlow8s: features.netFlow8s,
        buyers8s: features.buyers8s,
        largestBuyerShare8s: features.largestBuyerShare8s,
        runupPct: features.runupPct,
        drawdown10sPct: features.drawdown10sPct,
        jump2sPct: features.jump2sPct,
        featuresJson: JSON.stringify(features),
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
        coreWeightPct: exit.coreWeightPct,
        createdAt: now,
        updatedAt: now,
      });
      if (!result.changes) continue;
      const row = this.store.db.prepare('SELECT * FROM big_winner_shadow_positions WHERE id=?')
        .get(Number(result.lastInsertRowid));
      const position = camelRow(row);
      this.pendingEntries.set(position.id, position);
      this._index(position);
    }
    this.metrics.lastActionAt = now;
  }

  _observePositions(trade, marketPrice) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const pending = this.pendingEntries.get(id);
      if (pending) {
        if (trade.timestampMs < pending.entryTargetAt || trade.timestampMs > pending.entryDeadlineAt) {
          continue;
        }
        this._open(pending, trade, marketPrice);
        continue;
      }
      const position = this.positions.get(id);
      if (!position || position.status !== STATUS.OPEN || trade.timestampMs < position.entryAt) continue;
      this._observeOpen(position, trade.timestampMs, marketPrice);
    }
  }

  _simulatedEntryPrice(trade, marketPrice, positionSol) {
    try {
      const baseRaw = BigInt(trade.poolBaseReservesRaw || 0);
      const quoteRaw = BigInt(trade.poolQuoteReservesRaw || 0)
        + BigInt(trade.virtualQuoteReservesRaw || 0);
      const inputRaw = BigInt(Math.max(1, Math.round(positionSol * 1e9)));
      if (baseRaw <= 0n || quoteRaw <= 0n) return marketPrice;
      const outputRaw = baseRaw - ((baseRaw * quoteRaw) / (quoteRaw + inputRaw));
      const outputTokens = Number(outputRaw) / 1e6;
      return outputTokens > 0 ? positionSol / outputTokens : marketPrice;
    } catch (_) {
      return marketPrice;
    }
  }

  _open(position, trade, marketPrice) {
    const entryPrice = this._simulatedEntryPrice(trade, marketPrice, position.positionSol);
    const jumpPct = returnPct(entryPrice, position.signalPrice);
    const impactPct = returnPct(entryPrice, marketPrice);
    if (jumpPct > this.config.maxEntryPriceJumpPct
      || jumpPct < -this.config.maxEntryPriceDropPct
      || impactPct > this.config.maxEntryImpactPct) {
      this._patch(position.id, {
        status: STATUS.PRICE_JUMP,
        rejectionReason: impactPct > this.config.maxEntryImpactPct
          ? `ENTRY_IMPACT_${impactPct.toFixed(2)}PCT`
          : `ENTRY_PRICE_MOVE_${jumpPct.toFixed(2)}PCT`,
        entryJumpPct: jumpPct,
        entryImpactPct: impactPct,
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
      entryMarketPrice: marketPrice,
      entryImpactPct: impactPct,
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      lastObservedAt: trade.timestampMs,
      maxFavorableReturnPct: Math.max(0, returnPct(marketPrice, entryPrice)),
      maxAdverseReturnPct: Math.min(0, returnPct(marketPrice, entryPrice)),
      runnerHighPrice: marketPrice,
    });
    this._patch(position.id, {
      status: STATUS.OPEN,
      entryAt: position.entryAt,
      entryPrice,
      entryMarketPrice: marketPrice,
      entryJumpPct: jumpPct,
      entryImpactPct: impactPct,
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      lastObservedAt: trade.timestampMs,
      lastPrice: marketPrice,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
      runnerHighPrice: marketPrice,
    });
    this.pendingEntries.delete(position.id);
    this.positions.set(position.id, position);
    this.metrics.opened += 1;
  }

  _observeOpen(position, timestampMs, price) {
    position.highestPrice = Math.max(position.highestPrice || price, price);
    position.lowestPrice = Math.min(position.lowestPrice || price, price);
    position.lastObservedAt = timestampMs;
    position.runnerHighPrice = Math.max(position.runnerHighPrice || price, price);
    position.maxFavorableReturnPct = Math.max(
      position.maxFavorableReturnPct || 0,
      returnPct(position.highestPrice, position.entryPrice),
    );
    position.maxAdverseReturnPct = Math.min(
      position.maxAdverseReturnPct || 0,
      returnPct(position.lowestPrice, position.entryPrice),
    );
    const gross = returnPct(price, position.entryPrice);
    const exit = this.exitProfiles.get(position.exitProfileId);
    if (!position.coreExitAt && gross >= exit.coreActivationPct) {
      position.coreExitAt = timestampMs;
      position.coreExitPrice = price;
      position.coreReturnPct = gross;
      this.metrics.coreExits += 1;
    }
    const runnerStop = this._runnerStop(position, exit);
    this._patch(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
      coreExitAt: position.coreExitAt,
      coreExitPrice: position.coreExitPrice,
      coreReturnPct: position.coreReturnPct,
      runnerHighPrice: position.runnerHighPrice,
      runnerStopPrice: runnerStop.price,
      runnerTier: runnerStop.tier,
    });
    let reason = null;
    if (!position.coreExitAt && gross <= -exit.hardStopPct) reason = `HARD_STOP_${exit.hardStopPct}`;
    else if (runnerStop.price > 0 && price <= runnerStop.price) reason = runnerStop.reason;
    else if (timestampMs >= position.entryAt + exit.maxHoldMs) reason = 'MAX_HOLD';
    if (reason) this._close(position, timestampMs, price, reason);
  }

  _runnerStop(position, exit) {
    const highReturn = returnPct(position.runnerHighPrice, position.entryPrice);
    let price = null;
    let tier = null;
    let reason = null;
    if (highReturn >= exit.trailingActivationPct) {
      let drawdown = exit.baseTrailingDrawdownPct;
      for (const row of exit.trailingTiers || []) {
        if (highReturn >= row.activationPct) drawdown = row.drawdownPct;
      }
      price = position.runnerHighPrice * (1 - drawdown / 100);
      tier = `TRAIL_${drawdown}`;
      reason = tier;
    }
    for (const row of exit.profitFloors || []) {
      if (highReturn < row.activationPct) continue;
      const floorPrice = position.entryPrice * (1 + row.lockPct / 100);
      if (!(price > 0) || floorPrice > price) {
        price = floorPrice;
        tier = `LOCK_${row.lockPct}`;
        reason = tier;
      }
    }
    return { price, tier, reason };
  }

  _close(position, timestampMs, price, reason) {
    const runnerReturn = returnPct(price, position.entryPrice);
    const coreReturn = position.coreExitAt ? position.coreReturnPct : runnerReturn;
    const grossReturnPct = coreReturn * position.coreWeight
      + runnerReturn * (1 - position.coreWeight);
    const extraFixedCostSol = position.coreExitAt ? this.costs.totalFixedCostSol : 0;
    const estimatedCostSol = position.positionSol * position.configuredCostPct / 100
      + extraFixedCostSol;
    const netReturnPct = grossReturnPct - (estimatedCostSol / position.positionSol) * 100;
    this._patch(position.id, {
      status: STATUS.CLOSED,
      exitAt: timestampMs,
      exitPrice: price,
      exitReason: reason,
      grossReturnPct,
      netReturnPct,
      estimatedCostSol,
      holdMs: timestampMs - position.entryAt,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _patch(id, values) {
    const keys = [
      'status', 'rejectionReason', 'entryAt', 'entryPrice', 'entryMarketPrice',
      'entryJumpPct', 'entryImpactPct', 'highestPrice', 'lowestPrice',
      'lastObservedAt', 'lastPrice', 'maxFavorableReturnPct', 'maxAdverseReturnPct',
      'coreExitAt', 'coreExitPrice', 'coreReturnPct', 'runnerHighPrice',
      'runnerStopPrice', 'runnerTier', 'exitAt', 'exitPrice', 'exitReason',
      'grossReturnPct', 'netReturnPct', 'estimatedCostSol', 'holdMs',
    ];
    const row = { id, updatedAt: this.now() };
    for (const key of keys) row[key] = values[key] ?? null;
    this.update.run(row);
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

  dashboard({ positionLimit = 100 } = {}) {
    const limit = Math.min(300, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const positions = this.store.db.prepare(`
      SELECT * FROM big_winner_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY','OPEN') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC LIMIT ?
    `).all(limit);
    const groups = this.store.db.prepare(`
      SELECT cohort_id, entry_profile_id, exit_profile_id,
        COUNT(*) attempts, COUNT(DISTINCT mint) independent_mints,
        SUM(status='PRICE_JUMP') price_jump, SUM(status='NO_ENTRY') no_entry,
        SUM(status IN ('PENDING_ENTRY','OPEN')) active,
        SUM(status='CLOSED') resolved, SUM(status='NO_EXIT') no_exit,
        AVG(signal_age_ms) average_signal_age_ms,
        AVG(first_wave_pct) average_first_wave_pct,
        AVG(pullback_pct) average_pullback_pct,
        AVG(rebound_pct) average_rebound_pct,
        AVG(net_flow_3s) average_net_flow_3s,
        AVG(buyers_3s) average_buyers_3s,
        AVG(net_flow_8s) average_net_flow_8s,
        AVG(buyers_8s) average_buyers_8s,
        AVG(entry_jump_pct) average_entry_jump_pct,
        AVG(entry_impact_pct) average_entry_impact_pct,
        AVG(max_favorable_return_pct) average_mfe_pct,
        AVG(max_adverse_return_pct) average_mae_pct,
        AVG(net_return_pct) average_net_return_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>0 THEN 100.0 ELSE 0 END END)
          win_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>=20 THEN 100.0 ELSE 0 END END)
          big20_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>=50 THEN 100.0 ELSE 0 END END)
          big50_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>=100 THEN 100.0 ELSE 0 END END)
          big100_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN max_favorable_return_pct>=50 THEN 100.0 ELSE 0 END END)
          mfe50_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN max_favorable_return_pct>=100 THEN 100.0 ELSE 0 END END)
          mfe100_rate_pct,
        MAX(net_return_pct) max_winner_pct
      FROM big_winner_shadow_positions
      GROUP BY cohort_id, entry_profile_id, exit_profile_id
      ORDER BY entry_profile_id, exit_profile_id
    `).all();
    const returns = this.store.db.prepare(`
      SELECT net_return_pct, max_favorable_return_pct
      FROM big_winner_shadow_positions
      WHERE cohort_id=? AND status='CLOSED' AND net_return_pct IS NOT NULL
      ORDER BY net_return_pct DESC
    `);
    const cohorts = groups.map((group) => {
      const rows = returns.all(group.cohort_id);
      const values = rows.map((row) => Number(row.net_return_pct));
      const wins = values.filter((value) => value > 0);
      const losses = values.filter((value) => value < 0);
      const profit = wins.reduce((sum, value) => sum + value, 0);
      const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const top5 = values.slice(0, 5);
      const top10 = values.slice(0, 10);
      const mfe50 = rows.filter((row) => Number(row.max_favorable_return_pct) >= 50).length;
      const mfe100 = rows.filter((row) => Number(row.max_favorable_return_pct) >= 100).length;
      const big50 = rows.filter((row) => Number(row.net_return_pct) >= 50).length;
      const big100 = rows.filter((row) => Number(row.net_return_pct) >= 100).length;
      return {
        ...group,
        median_net_return_pct: percentile(values, 0.5),
        profit_factor: loss > 0 ? profit / loss : (profit > 0 ? null : 0),
        average_net_return_ex_top5_pct: values.length > 5
          ? values.slice(5).reduce((sum, value) => sum + value, 0) / (values.length - 5) : null,
        top_5_total_pnl_contribution_pct: values.reduce((sum, value) => sum + value, 0) !== 0
          ? top5.reduce((sum, value) => sum + value, 0)
            / values.reduce((sum, value) => sum + value, 0) * 100 : null,
        top_10_total_pnl_contribution_pct: values.reduce((sum, value) => sum + value, 0) !== 0
          ? top10.reduce((sum, value) => sum + value, 0)
            / values.reduce((sum, value) => sum + value, 0) * 100 : null,
        big50_capture_pct: mfe50 > 0 ? big50 / mfe50 * 100 : null,
        big100_capture_pct: mfe100 > 0 ? big100 / mfe100 * 100 : null,
      };
    });
    return { cohorts, positions };
  }
}

module.exports = { BigWinnerShadowSuite, STATUS, priceOf, returnPct };
