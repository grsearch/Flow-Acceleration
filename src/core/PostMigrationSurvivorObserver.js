'use strict';

const { executableBuy, executableSell } = require('./ShadowExecutionModel');

const MILESTONES = [300, 900, 1_800, 3_600];
const DEFAULT_SHADOW_HOLDS_MS = [30_000, 60_000, 120_000];

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pctReturn(price, baseline) {
  return price > 0 && baseline > 0 ? ((price / baseline) - 1) * 100 : null;
}

function normalizeSide(value) {
  const side = String(value || '').trim().toLowerCase();
  return side === 'buy' || side === 'sell' ? side : 'unknown';
}

function normalizeHoldMs(values) {
  const source = Array.isArray(values) && values.length ? values : DEFAULT_SHADOW_HOLDS_MS;
  return [...new Set(source.map((value) => Math.trunc(finite(value, 0)))
    .filter((value) => value >= 1_000 && value <= 30 * 60_000))].sort((a, b) => a - b);
}

function deterministicPercent(mint) {
  let hash = 2_166_136_261;
  for (const char of String(mint || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 10_000 / 100;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function aggregate(values) {
  const clean = values.filter(Number.isFinite);
  return {
    count: clean.length,
    averagePct: clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null,
    medianPct: median(clean),
    big50RatePct: clean.length ? clean.filter((value) => value >= 50).length / clean.length * 100 : null,
    big100RatePct: clean.length ? clean.filter((value) => value >= 100).length / clean.length * 100 : null,
    big200RatePct: clean.length ? clean.filter((value) => value >= 200).length / clean.length * 100 : null,
  };
}

class PostMigrationSurvivorObserver {
  constructor({ config = {}, store, rugRiskTracker = null }) {
    this.config = {
      enabled: config.enabled !== false,
      positionSol: finite(config.positionSol, 1),
      baselineStageMs: Math.max(60_000, finite(config.baselineStageMs, 5 * 60_000)),
      extendedStageMs: Math.max(5 * 60_000, finite(config.extendedStageMs, 30 * 60_000)),
      maxAgeMs: Math.max(30 * 60_000, finite(config.maxAgeMs, 60 * 60_000)),
      inactivityMs: Math.max(30_000, finite(config.inactivityMs, 180_000)),
      maxActive: Math.max(100, finite(config.maxActive, 3_000)),
      maxThirtyMinuteSurvivors: Math.max(10, finite(config.maxThirtyMinuteSurvivors, 500)),
      maxSixtyMinuteSurvivors: Math.max(5, finite(config.maxSixtyMinuteSurvivors, 100)),
      holdoutPct: clamp(finite(config.holdoutPct, 10), 0, 100),
      softFailConfirmations: Math.max(1, finite(config.softFailConfirmations, 2)),
      softFailConfirmationMs: Math.max(1_000, finite(config.softFailConfirmationMs, 30_000)),
      riskCheckIntervalMs: Math.max(500, finite(config.riskCheckIntervalMs, 2_000)),
      hardPriceRetentionPct: clamp(finite(config.hardPriceRetentionPct, 15), 0, 100),
      hardExecutableRecoveryPct: clamp(finite(config.hardExecutableRecoveryPct, 15), 0, 100),
      stage5MinPeakRetentionPct: clamp(finite(config.stage5MinPeakRetentionPct, 30), 0, 100),
      stage5MinTrades60s: Math.max(0, finite(config.stage5MinTrades60s, 8)),
      stage5MinBuyers60s: Math.max(0, finite(config.stage5MinBuyers60s, 3)),
      stage5MinBuyTx60s: Math.max(0, finite(config.stage5MinBuyTx60s, 2)),
      stage5MinSellTx60s: Math.max(0, finite(config.stage5MinSellTx60s, 1)),
      stage5MinExecutableRecoveryPct: clamp(
        finite(config.stage5MinExecutableRecoveryPct, 25), 0, 100,
      ),
      stage30MinBaselineReturnPct: finite(config.stage30MinBaselineReturnPct, -10),
      stage30MinPeakRetentionPct: clamp(finite(config.stage30MinPeakRetentionPct, 45), 0, 100),
      stage30MinTrades300s: Math.max(0, finite(config.stage30MinTrades300s, 12)),
      stage30MinBuyers300s: Math.max(0, finite(config.stage30MinBuyers300s, 5)),
      stage30MinNetFlowSol: finite(config.stage30MinNetFlowSol, 0),
      stage30MinExecutableRecoveryPct: clamp(
        finite(config.stage30MinExecutableRecoveryPct, 50), 0, 100,
      ),
      maxEventsPerMint: Math.max(64, finite(config.maxEventsPerMint, 512)),
      dashboardLimit: Math.max(100, finite(config.dashboardLimit, 2_000)),
      transientUpPriceRatio: Math.max(2, finite(config.transientUpPriceRatio, 20)),
      priceConfirmationWindowMs: Math.max(100, finite(config.priceConfirmationWindowMs, 500)),
      priceConfirmationMinPersistenceMs: Math.max(
        0, finite(config.priceConfirmationMinPersistenceMs, 150),
      ),
      priceConfirmationTolerancePct: clamp(
        finite(config.priceConfirmationTolerancePct, 25), 1, 100,
      ),
      priceConfirmationMinWallets: Math.max(
        1, finite(config.priceConfirmationMinWallets, 2),
      ),
      shadowEnabled: config.shadowEnabled !== false,
      shadowHoldMs: normalizeHoldMs(config.shadowHoldMs),
      shadowRoundTripCostPct: Math.max(0, finite(config.shadowRoundTripCostPct, 3.2)),
      shadowNoExitGraceMs: Math.max(1_000, finite(config.shadowNoExitGraceMs, 60_000)),
    };
    this.store = store;
    this.db = store?.db;
    this.rugRiskTracker = rugRiskTracker;
    this.states = new Map();
    this.statements = {};
    this.metrics = {
      migrationsObserved: 0,
      admissionSkipped: 0,
      duplicateMigrations: 0,
      tradesObserved: 0,
      passedFiveMinutes: 0,
      passedThirtyMinutes: 0,
      dropped: 0,
      hardDropped: 0,
      capDropped: 0,
      holdoutTracked: 0,
      completed: 0,
      rightCensored: 0,
      milestonesWritten: 0,
      invalidSides: 0,
      transientPricesWithheld: 0,
      transientPricesConfirmed: 0,
      shadowOpened: 0,
      shadowClosed: 0,
      shadowNoEntry: 0,
      shadowNoExit: 0,
      lastMigrationAt: null,
      lastCompletedAt: null,
    };
  }

  start() {
    if (!this.config.enabled || !this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_migration_survivor_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL UNIQUE,
        symbol TEXT,
        creator TEXT,
        migration_at_ms INTEGER NOT NULL,
        first_trade_at_ms INTEGER,
        baseline_price REAL,
        peak_price REAL,
        trough_price REAL,
        last_price REAL,
        last_trade_at_ms INTEGER,
        current_stage TEXT NOT NULL DEFAULT 'BASELINE_5M',
        status TEXT NOT NULL DEFAULT 'OBSERVING',
        passed_5m INTEGER NOT NULL DEFAULT 0,
        passed_30m INTEGER NOT NULL DEFAULT 0,
        is_holdout INTEGER NOT NULL DEFAULT 0,
        would_drop_at_ms INTEGER,
        drop_reason TEXT,
        return_5m_pct REAL,
        return_15m_pct REAL,
        return_30m_pct REAL,
        return_60m_pct REAL,
        mfe_pct REAL NOT NULL DEFAULT 0,
        mae_pct REAL NOT NULL DEFAULT 0,
        executable_recovery_pct REAL,
        executable_mfe_pct REAL NOT NULL DEFAULT 0,
        executable_mae_pct REAL NOT NULL DEFAULT 0,
        post_drop_mfe_pct REAL,
        post_drop_executable_mfe_pct REAL,
        price_anomaly_count INTEGER NOT NULL DEFAULT 0,
        final_reason TEXT,
        decision_json TEXT,
        finalized_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pm_survivor_migration
        ON post_migration_survivor_observations(migration_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_pm_survivor_status
        ON post_migration_survivor_observations(status, migration_at_ms DESC);
      CREATE TABLE IF NOT EXISTS post_migration_survivor_milestones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL,
        mint TEXT NOT NULL,
        milestone TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        age_ms INTEGER NOT NULL,
        mark_return_pct REAL,
        peak_retention_pct REAL,
        executable_recovery_pct REAL,
        trades INTEGER NOT NULL DEFAULT 0,
        buyers INTEGER NOT NULL DEFAULT 0,
        buy_tx INTEGER NOT NULL DEFAULT 0,
        sell_tx INTEGER NOT NULL DEFAULT 0,
        net_flow_sol REAL NOT NULL DEFAULT 0,
        stale_ms INTEGER,
        decision TEXT,
        reason TEXT,
        UNIQUE(observation_id, milestone)
      );
      CREATE INDEX IF NOT EXISTS idx_pm_survivor_milestone_time
        ON post_migration_survivor_milestones(observed_at_ms DESC);
      CREATE TABLE IF NOT EXISTS post_migration_survivor_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL,
        mint TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        hold_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        signal_at_ms INTEGER NOT NULL,
        entry_at_ms INTEGER,
        entry_price REAL,
        entry_market_price REAL,
        entry_impact_pct REAL,
        token_units REAL,
        position_sol REAL NOT NULL,
        highest_executable_return_pct REAL NOT NULL DEFAULT 0,
        lowest_executable_return_pct REAL NOT NULL DEFAULT 0,
        exit_at_ms INTEGER,
        exit_price REAL,
        exit_market_price REAL,
        exit_impact_pct REAL,
        gross_return_pct REAL,
        net_return_pct REAL,
        exit_reason TEXT,
        missing_exit_reason TEXT,
        entry_execution_json TEXT,
        exit_execution_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(observation_id, profile_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pm_survivor_shadow_profile
        ON post_migration_survivor_shadow_positions(profile_id, status, signal_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_pm_survivor_shadow_mint
        ON post_migration_survivor_shadow_positions(mint, signal_at_ms DESC);
    `);
    const observationColumns = new Set(this.db.prepare(
      'PRAGMA table_info(post_migration_survivor_observations)',
    ).all().map((row) => row.name));
    const observationAdditions = [
      ['executable_mfe_pct', 'REAL NOT NULL DEFAULT 0'],
      ['executable_mae_pct', 'REAL NOT NULL DEFAULT 0'],
      ['post_drop_executable_mfe_pct', 'REAL'],
      ['price_anomaly_count', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of observationAdditions) {
      if (!observationColumns.has(name)) {
        this.db.exec(
          `ALTER TABLE post_migration_survivor_observations ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    const now = Date.now();
    const censored = this.db.prepare(`
      UPDATE post_migration_survivor_observations
      SET status='RIGHT_CENSORED', final_reason='PROCESS_RESTART_NO_REPLAY',
          finalized_at_ms=?
      WHERE status='OBSERVING'
    `).run(now).changes;
    this.metrics.rightCensored += censored;
    this.db.prepare(`
      UPDATE post_migration_survivor_shadow_positions
      SET status='RIGHT_CENSORED', exit_reason='PROCESS_RESTART_NO_REPLAY',
          updated_at_ms=?
      WHERE status='OPEN'
    `).run(now);
    this.statements.insert = this.db.prepare(`
      INSERT OR IGNORE INTO post_migration_survivor_observations (
        mint, symbol, creator, migration_at_ms, current_stage, status,
        is_holdout, created_at_ms
      ) VALUES (@mint, @symbol, @creator, @migrationAtMs, 'BASELINE_5M',
        'OBSERVING', @isHoldout, @createdAtMs)
    `);
    this.statements.idByMint = this.db.prepare(`
      SELECT id FROM post_migration_survivor_observations WHERE mint=?
    `);
    this.statements.update = this.db.prepare(`
      UPDATE post_migration_survivor_observations SET
        first_trade_at_ms=@firstTradeAtMs, baseline_price=@baselinePrice,
        peak_price=@peakPrice, trough_price=@troughPrice, last_price=@lastPrice,
        last_trade_at_ms=@lastTradeAtMs, current_stage=@currentStage,
        status=@status, passed_5m=@passed5m, passed_30m=@passed30m,
        is_holdout=@isHoldout, would_drop_at_ms=@wouldDropAtMs,
        drop_reason=@dropReason, return_5m_pct=@return5mPct,
        return_15m_pct=@return15mPct, return_30m_pct=@return30mPct,
        return_60m_pct=@return60mPct, mfe_pct=@mfePct, mae_pct=@maePct,
        executable_recovery_pct=@executableRecoveryPct,
        executable_mfe_pct=@executableMfePct, executable_mae_pct=@executableMaePct,
        post_drop_mfe_pct=@postDropMfePct,
        post_drop_executable_mfe_pct=@postDropExecutableMfePct,
        price_anomaly_count=@priceAnomalyCount, final_reason=@finalReason,
        decision_json=@decisionJson, finalized_at_ms=@finalizedAtMs
      WHERE id=@id
    `);
    this.statements.milestone = this.db.prepare(`
      INSERT OR IGNORE INTO post_migration_survivor_milestones (
        observation_id, mint, milestone, observed_at_ms, age_ms,
        mark_return_pct, peak_retention_pct, executable_recovery_pct,
        trades, buyers, buy_tx, sell_tx, net_flow_sol, stale_ms, decision, reason
      ) VALUES (
        @observationId, @mint, @milestone, @observedAtMs, @ageMs,
        @markReturnPct, @peakRetentionPct, @executableRecoveryPct,
        @trades, @buyers, @buyTx, @sellTx, @netFlowSol, @staleMs, @decision, @reason
      )
    `);
    this.statements.recent = this.db.prepare(`
      SELECT * FROM post_migration_survivor_observations
      ORDER BY migration_at_ms DESC LIMIT ?
    `);
    this.statements.recentMilestones = this.db.prepare(`
      SELECT * FROM post_migration_survivor_milestones
      ORDER BY observed_at_ms DESC LIMIT ?
    `);
    this.statements.insertShadow = this.db.prepare(`
      INSERT OR IGNORE INTO post_migration_survivor_shadow_positions (
        observation_id, mint, profile_id, hold_ms, status, signal_at_ms,
        entry_at_ms, entry_price, entry_market_price, entry_impact_pct,
        token_units, position_sol, entry_execution_json, created_at_ms, updated_at_ms
      ) VALUES (
        @observationId, @mint, @profileId, @holdMs, @status, @signalAtMs,
        @entryAtMs, @entryPrice, @entryMarketPrice, @entryImpactPct,
        @tokenUnits, @positionSol, @entryExecutionJson, @createdAtMs, @updatedAtMs
      )
    `);
    this.statements.updateShadow = this.db.prepare(`
      UPDATE post_migration_survivor_shadow_positions SET
        status=@status,
        highest_executable_return_pct=@highestExecutableReturnPct,
        lowest_executable_return_pct=@lowestExecutableReturnPct,
        exit_at_ms=@exitAtMs, exit_price=@exitPrice,
        exit_market_price=@exitMarketPrice, exit_impact_pct=@exitImpactPct,
        gross_return_pct=@grossReturnPct, net_return_pct=@netReturnPct,
        exit_reason=@exitReason, missing_exit_reason=@missingExitReason,
        exit_execution_json=@exitExecutionJson, updated_at_ms=@updatedAtMs
      WHERE id=@id
    `);
    this.statements.recentShadow = this.db.prepare(`
      SELECT * FROM post_migration_survivor_shadow_positions
      ORDER BY signal_at_ms DESC, hold_ms ASC LIMIT ?
    `);
  }

  onGraduated(event = {}) {
    if (!this.config.enabled || !this.statements.insert || !event.mint) return null;
    const migrationAtMs = finite(
      event.migratedAt || event.completedAt || event.timestampMs || event.timestamp,
      Date.now(),
    );
    if (this.states.has(event.mint)) {
      this.metrics.duplicateMigrations += 1;
      return this.states.get(event.mint);
    }
    if (this.states.size >= this.config.maxActive) {
      this.metrics.admissionSkipped += 1;
      return null;
    }
    const isHoldout = deterministicPercent(event.mint) < this.config.holdoutPct;
    const row = {
      mint: event.mint,
      symbol: event.symbol || null,
      creator: event.creator || null,
      migrationAtMs,
      isHoldout: Number(isHoldout),
      createdAtMs: Date.now(),
    };
    const inserted = this.statements.insert.run(row);
    if (!inserted.changes) {
      this.metrics.duplicateMigrations += 1;
      return null;
    }
    const state = {
      ...row,
      id: Number(inserted.lastInsertRowid || this.statements.idByMint.get(event.mint)?.id),
      isHoldout,
      firstTradeAtMs: null,
      baselinePrice: null,
      entryTokenUnits: null,
      peakPrice: null,
      troughPrice: null,
      lastPrice: null,
      lastTradeAtMs: null,
      currentStage: 'BASELINE_5M',
      status: 'OBSERVING',
      passed5m: false,
      passed30m: false,
      wouldDropAtMs: null,
      dropReason: null,
      returns: {},
      mfePct: 0,
      maePct: 0,
      executableRecoveryPct: null,
      executableMfePct: 0,
      executableMaePct: 0,
      postDropMfePct: null,
      postDropExecutableMfePct: null,
      priceAnomalyCount: 0,
      finalReason: null,
      finalizedAtMs: null,
      events: [],
      milestones: new Set(),
      softFailure: null,
      latestDecision: null,
      lastRiskCheckAtMs: 0,
      lastRiskFlagged: false,
      pendingUpwardPrice: null,
      shadowEntryPendingAtMs: null,
      shadowPositions: new Map(),
    };
    this.states.set(state.mint, state);
    this.metrics.migrationsObserved += 1;
    this.metrics.lastMigrationAt = migrationAtMs;
    return state;
  }

  observeTrade(trade = {}) {
    if (!this.config.enabled || trade.market !== 'PUMP_AMM') return;
    const state = this.states.get(trade.mint);
    const timestampMs = finite(trade.timestampMs || trade.timestamp);
    const rawPrice = finite(trade.price);
    if (!state || !(timestampMs > 0) || !(rawPrice > 0)) return;
    if (timestampMs < state.migrationAtMs) return;
    this.metrics.tradesObserved += 1;
    const side = normalizeSide(trade.side);
    if (side === 'unknown') this.metrics.invalidSides += 1;
    const price = this._acceptedMarkPrice(state, trade, timestampMs, rawPrice);
    if (!state.firstTradeAtMs) {
      if (!(price > 0)) return;
      state.firstTradeAtMs = timestampMs;
      state.baselinePrice = price;
      state.peakPrice = price;
      state.troughPrice = price;
      const buy = executableBuy(trade, this.config.positionSol, price);
      state.entryTokenUnits = buy.available ? finite(buy.tokenUnits) : null;
    }
    state.lastTradeAtMs = timestampMs;
    if (price > 0) {
      state.lastPrice = price;
      state.peakPrice = Math.max(state.peakPrice || price, price);
      state.troughPrice = Math.min(state.troughPrice || price, price);
    }
    const markReturnPct = pctReturn(state.lastPrice, state.baselinePrice);
    if (Number.isFinite(markReturnPct)) {
      state.mfePct = Math.max(state.mfePct, markReturnPct);
      state.maePct = Math.min(state.maePct, markReturnPct);
      if (state.wouldDropAtMs && timestampMs >= state.wouldDropAtMs) {
        state.postDropMfePct = Math.max(state.postDropMfePct ?? -Infinity, markReturnPct);
      }
    }
    if (price > 0 && state.entryTokenUnits > 0) {
      const sell = executableSell(trade, state.entryTokenUnits, price, {
        rugMarkReturnPct: markReturnPct,
      });
      if (Number.isFinite(sell.proceedsSol)) {
        state.executableRecoveryPct = sell.proceedsSol / this.config.positionSol * 100;
        const executableReturnPct = state.executableRecoveryPct - 100;
        state.executableMfePct = Math.max(state.executableMfePct, executableReturnPct);
        state.executableMaePct = Math.min(state.executableMaePct, executableReturnPct);
        if (state.wouldDropAtMs && timestampMs >= state.wouldDropAtMs) {
          state.postDropExecutableMfePct = Math.max(
            state.postDropExecutableMfePct ?? -Infinity,
            executableReturnPct,
          );
        }
      }
    }
    state.events.push({
      timestampMs,
      wallet: trade.wallet || null,
      side,
      solAmount: finite(trade.solAmount, 0),
      price: rawPrice,
    });
    const pruneBefore = timestampMs - Math.max(5 * 60_000, this.config.inactivityMs);
    while (state.events.length > this.config.maxEventsPerMint
      || (state.events[0] && state.events[0].timestampMs < pruneBefore)) {
      state.events.shift();
    }
    this._captureDueMilestones(state, timestampMs);
    if (price > 0 && state.shadowEntryPendingAtMs
      && timestampMs >= state.shadowEntryPendingAtMs) {
      this._openShadowPositions(state, trade, timestampMs, price);
    }
    if (price > 0) this._advanceShadowPositions(state, trade, timestampMs, price);
    const hardReason = this._hardDropReason(state, timestampMs);
    if (hardReason) this._drop(state, hardReason, timestampMs, { hard: true });
  }

  advanceTime(now = Date.now(), censorReason = null) {
    if (!this.config.enabled) return;
    for (const state of [...this.states.values()]) {
      this._expireShadowPositions(state, now);
      if (censorReason) {
        this._finalize(state, 'RIGHT_CENSORED', censorReason, now);
        continue;
      }
      this._captureDueMilestones(state, now);
      const ageMs = now - state.migrationAtMs;
      if (state.currentStage === 'BASELINE_5M' && ageMs >= this.config.baselineStageMs) {
        this._evaluateFiveMinuteGate(state, now);
      } else if (state.currentStage === 'TO_30M' && ageMs >= this.config.extendedStageMs) {
        this._evaluateThirtyMinuteGate(state, now);
      }
      if (this.states.has(state.mint) && ageMs >= this.config.maxAgeMs) {
        this._finalize(state, 'COMPLETE', 'MAX_60M_OBSERVATION', now);
      }
    }
    this._enforceCaps(now);
  }

  trackedMints(now = Date.now()) {
    this.advanceTime(now);
    return [...this.states.keys()];
  }

  stop() {
    this.advanceTime(Date.now(), 'PROCESS_STOP_NO_REPLAY');
  }

  _stats(state, now, windowMs) {
    const from = now - windowMs;
    const rows = state.events.filter((event) => event.timestampMs >= from && event.timestampMs <= now);
    // Persisted/replayed trades may use BUY/SELL while live events historically
    // used lower-case values. Normalize at the boundary and again here so a
    // casing mismatch can never silently turn a healthy flow window into zero.
    const buys = rows.filter((event) => normalizeSide(event.side) === 'buy');
    const sells = rows.filter((event) => normalizeSide(event.side) === 'sell');
    return {
      trades: rows.length,
      buyers: new Set(buys.map((event) => event.wallet).filter(Boolean)).size,
      buyTx: buys.length,
      sellTx: sells.length,
      netFlowSol: buys.reduce((sum, event) => sum + event.solAmount, 0)
        - sells.reduce((sum, event) => sum + event.solAmount, 0),
    };
  }

  _hardDropReason(state, now) {
    if (!state.baselinePrice || !state.lastPrice) return null;
    const baselineRetention = state.lastPrice / state.baselinePrice * 100;
    if (baselineRetention <= this.config.hardPriceRetentionPct) return 'HARD_PRICE_COLLAPSE';
    if (Number.isFinite(state.executableRecoveryPct)
      && state.executableRecoveryPct <= this.config.hardExecutableRecoveryPct) {
      return 'HARD_EXECUTABLE_CAPACITY_COLLAPSE';
    }
    if (now - state.lastRiskCheckAtMs >= this.config.riskCheckIntervalMs) {
      const risk = this.rugRiskTracker?.snapshot?.(state.mint, now) || {};
      state.lastRiskCheckAtMs = now;
      state.lastRiskFlagged = Boolean(
        risk.flagged || risk.blocked || risk.highRisk || risk.riskLevel === 'HIGH',
      );
    }
    if (state.lastRiskFlagged) {
      return 'RUG_GUARD_HIGH_RISK';
    }
    return null;
  }

  _evaluateFiveMinuteGate(state, now) {
    const stats = this._stats(state, now, 60_000);
    const peakRetentionPct = state.lastPrice > 0 && state.peakPrice > 0
      ? state.lastPrice / state.peakPrice * 100 : null;
    const staleMs = state.lastTradeAtMs ? now - state.lastTradeAtMs : Infinity;
    const reasons = [];
    if (!state.firstTradeAtMs) reasons.push('NO_PUMPSWAP_TRADE');
    if (staleMs > this.config.inactivityMs) reasons.push('INACTIVE_180S');
    if (!(peakRetentionPct >= this.config.stage5MinPeakRetentionPct)) reasons.push('LOW_PEAK_RETENTION');
    if (stats.trades < this.config.stage5MinTrades60s) reasons.push('LOW_RECENT_TRADES');
    if (stats.buyers < this.config.stage5MinBuyers60s) reasons.push('LOW_RECENT_BUYERS');
    if (stats.buyTx < this.config.stage5MinBuyTx60s) reasons.push('LOW_RECENT_BUYS');
    if (stats.sellTx < this.config.stage5MinSellTx60s) reasons.push('NO_TWO_WAY_ACTIVITY');
    if (Number.isFinite(state.executableRecoveryPct)
      && state.executableRecoveryPct < this.config.stage5MinExecutableRecoveryPct) {
      reasons.push('LOW_EXECUTABLE_RECOVERY');
    }
    const decision = {
      gate: '5M', reasons, stats, peakRetentionPct, staleMs,
      executableRecoveryPct: state.executableRecoveryPct,
    };
    state.latestDecision = decision;
    if (reasons.length) {
      this._considerSoftDrop(state, `GATE_5M:${reasons.join('+')}`, now, decision);
      return;
    }
    state.softFailure = null;
    state.passed5m = true;
    state.currentStage = 'TO_30M';
    if (this.config.shadowEnabled) state.shadowEntryPendingAtMs = now;
    this.metrics.passedFiveMinutes += 1;
    this._recordMilestone(state, 'GATE_5M', now, 60_000, 'PASS', null, stats);
    this._persist(state);
  }

  _evaluateThirtyMinuteGate(state, now) {
    const stats = this._stats(state, now, 5 * 60_000);
    const baselineReturnPct = pctReturn(state.lastPrice, state.baselinePrice);
    const peakRetentionPct = state.lastPrice > 0 && state.peakPrice > 0
      ? state.lastPrice / state.peakPrice * 100 : null;
    const staleMs = state.lastTradeAtMs ? now - state.lastTradeAtMs : Infinity;
    const structurePass = baselineReturnPct >= this.config.stage30MinBaselineReturnPct
      || peakRetentionPct >= this.config.stage30MinPeakRetentionPct;
    const reasons = [];
    if (staleMs > this.config.inactivityMs) reasons.push('INACTIVE_180S');
    if (!structurePass) reasons.push('WEAK_PRICE_STRUCTURE');
    if (stats.trades < this.config.stage30MinTrades300s) reasons.push('LOW_5M_TRADES');
    if (stats.buyers < this.config.stage30MinBuyers300s) reasons.push('LOW_5M_BUYERS');
    if (stats.netFlowSol < this.config.stage30MinNetFlowSol) reasons.push('NEGATIVE_5M_NETFLOW');
    if (Number.isFinite(state.executableRecoveryPct)
      && state.executableRecoveryPct < this.config.stage30MinExecutableRecoveryPct) {
      reasons.push('LOW_EXECUTABLE_RECOVERY');
    }
    const decision = {
      gate: '30M', reasons, stats, baselineReturnPct, peakRetentionPct, staleMs,
      executableRecoveryPct: state.executableRecoveryPct,
    };
    state.latestDecision = decision;
    if (reasons.length) {
      this._considerSoftDrop(state, `GATE_30M:${reasons.join('+')}`, now, decision);
      return;
    }
    state.softFailure = null;
    state.passed30m = true;
    state.currentStage = 'TO_60M';
    this.metrics.passedThirtyMinutes += 1;
    this._recordMilestone(state, 'GATE_30M', now, 5 * 60_000, 'PASS', null, stats);
    this._persist(state);
  }

  _considerSoftDrop(state, reason, now, decision) {
    if (!state.softFailure || state.softFailure.reason !== reason) {
      state.softFailure = { reason, count: 1, lastAt: now };
      return;
    }
    if (now - state.softFailure.lastAt < this.config.softFailConfirmationMs) return;
    state.softFailure.count += 1;
    state.softFailure.lastAt = now;
    if (state.softFailure.count >= this.config.softFailConfirmations) {
      this._drop(state, reason, now, { decision });
    }
  }

  _drop(state, reason, now, { hard = false, cap = false, decision = null, allowHoldout = true } = {}) {
    if (!this.states.has(state.mint)) return;
    // Audit holdouts remain subscribed after the first would-be drop so their
    // counterfactual outcome can be measured. Do not count every later trade
    // as another drop or overwrite the original decision boundary.
    if (state.wouldDropAtMs) return;
    state.wouldDropAtMs ||= now;
    state.dropReason ||= reason;
    state.latestDecision = decision || state.latestDecision;
    this.metrics.dropped += 1;
    if (hard) this.metrics.hardDropped += 1;
    if (cap) this.metrics.capDropped += 1;
    const keepAudit = allowHoldout && state.isHoldout;
    this._recordMilestone(state, 'DROP', now, 5 * 60_000, keepAudit ? 'AUDIT_HOLDOUT' : 'DROP', reason);
    if (keepAudit) {
      state.currentStage = 'AUDIT_HOLDOUT';
      state.softFailure = null;
      this.metrics.holdoutTracked += 1;
      this._persist(state);
      return;
    }
    this._finalize(state, 'DROPPED', reason, now);
  }

  _captureDueMilestones(state, now) {
    for (const seconds of MILESTONES) {
      const dueAt = state.migrationAtMs + seconds * 1_000;
      if (now < dueAt || state.milestones.has(`${seconds / 60}M`)) continue;
      const statsWindow = seconds <= 300 ? 60_000 : 5 * 60_000;
      const stats = this._stats(state, now, statsWindow);
      this._recordMilestone(state, `${seconds / 60}M`, now, statsWindow, 'OBSERVED', null, stats);
      state.returns[seconds] = pctReturn(state.lastPrice, state.baselinePrice);
    }
  }

  _recordMilestone(state, milestone, now, windowMs, decision, reason, suppliedStats = null) {
    if (!this.statements.milestone || state.milestones.has(milestone)) return;
    const stats = suppliedStats || this._stats(state, now, windowMs);
    const peakRetentionPct = state.lastPrice > 0 && state.peakPrice > 0
      ? state.lastPrice / state.peakPrice * 100 : null;
    const result = this.statements.milestone.run({
      observationId: state.id,
      mint: state.mint,
      milestone,
      observedAtMs: now,
      ageMs: Math.max(0, now - state.migrationAtMs),
      markReturnPct: pctReturn(state.lastPrice, state.baselinePrice),
      peakRetentionPct,
      executableRecoveryPct: state.executableRecoveryPct,
      trades: stats.trades,
      buyers: stats.buyers,
      buyTx: stats.buyTx,
      sellTx: stats.sellTx,
      netFlowSol: stats.netFlowSol,
      staleMs: state.lastTradeAtMs ? now - state.lastTradeAtMs : null,
      decision,
      reason,
    });
    state.milestones.add(milestone);
    if (result.changes) this.metrics.milestonesWritten += 1;
  }

  _acceptedMarkPrice(state, trade, timestampMs, rawPrice) {
    if (!(rawPrice > 0)) return null;
    const reference = finite(state.lastPrice, finite(state.baselinePrice));
    const pending = state.pendingUpwardPrice;
    if (pending && timestampMs - pending.firstAtMs > this.config.priceConfirmationWindowMs) {
      state.pendingUpwardPrice = null;
    }
    // Fast downward moves are always accepted immediately. The protection is
    // deliberately one-sided so it cannot hide a rug or make stop losses look
    // better than they would have been on chain.
    if (!(reference > 0) || rawPrice <= reference
      || rawPrice / reference < this.config.transientUpPriceRatio) {
      if (rawPrice <= reference) state.pendingUpwardPrice = null;
      return rawPrice;
    }
    const tolerance = this.config.priceConfirmationTolerancePct / 100;
    let candidate = state.pendingUpwardPrice;
    if (!candidate || Math.abs(rawPrice / candidate.price - 1) > tolerance) {
      candidate = {
        price: rawPrice,
        firstAtMs: timestampMs,
        lastAtMs: timestampMs,
        wallets: new Set(),
      };
      state.pendingUpwardPrice = candidate;
    }
    candidate.lastAtMs = timestampMs;
    if (trade.wallet) candidate.wallets.add(String(trade.wallet));
    const persisted = timestampMs - candidate.firstAtMs
      >= this.config.priceConfirmationMinPersistenceMs;
    const distributed = candidate.wallets.size >= this.config.priceConfirmationMinWallets;
    if (persisted || distributed) {
      state.pendingUpwardPrice = null;
      this.metrics.transientPricesConfirmed += 1;
      return rawPrice;
    }
    state.priceAnomalyCount += 1;
    this.metrics.transientPricesWithheld += 1;
    return null;
  }

  _shadowProfileId(holdMs) {
    return `PM5_X${Math.round(holdMs / 1_000)}`;
  }

  _openShadowPositions(state, trade, timestampMs, rawPrice) {
    const signalAtMs = state.shadowEntryPendingAtMs;
    state.shadowEntryPendingAtMs = null;
    for (const holdMs of this.config.shadowHoldMs) {
      const profileId = this._shadowProfileId(holdMs);
      const entry = executableBuy(trade, this.config.positionSol, rawPrice);
      const available = Boolean(entry.available && entry.price > 0 && entry.tokenUnits > 0);
      const row = {
        observationId: state.id,
        mint: state.mint,
        profileId,
        holdMs,
        status: available ? 'OPEN' : 'NO_ENTRY',
        signalAtMs,
        entryAtMs: available ? timestampMs : null,
        entryPrice: available ? entry.price : null,
        entryMarketPrice: finite(entry.marketPrice),
        entryImpactPct: finite(entry.impactPct),
        tokenUnits: available ? entry.tokenUnits : null,
        positionSol: this.config.positionSol,
        entryExecutionJson: JSON.stringify(entry),
        createdAtMs: timestampMs,
        updatedAtMs: timestampMs,
      };
      const inserted = this.statements.insertShadow.run(row);
      if (!inserted.changes) continue;
      if (!available) {
        this.metrics.shadowNoEntry += 1;
        continue;
      }
      const position = {
        id: Number(inserted.lastInsertRowid),
        ...row,
        highestExecutableReturnPct: 0,
        lowestExecutableReturnPct: 0,
        exitAtMs: null,
        exitPrice: null,
        exitMarketPrice: null,
        exitImpactPct: null,
        grossReturnPct: null,
        netReturnPct: null,
        exitReason: null,
        missingExitReason: null,
        exitExecutionJson: null,
      };
      state.shadowPositions.set(profileId, position);
      this.metrics.shadowOpened += 1;
    }
  }

  _advanceShadowPositions(state, trade, timestampMs, rawPrice) {
    for (const position of state.shadowPositions.values()) {
      if (position.status !== 'OPEN') continue;
      const exit = executableSell(trade, position.tokenUnits, rawPrice);
      const available = Boolean(exit.available && Number.isFinite(exit.proceedsSol));
      let grossReturnPct = null;
      if (available) {
        grossReturnPct = exit.proceedsSol / position.positionSol * 100 - 100;
        position.highestExecutableReturnPct = Math.max(
          position.highestExecutableReturnPct, grossReturnPct,
        );
        position.lowestExecutableReturnPct = Math.min(
          position.lowestExecutableReturnPct, grossReturnPct,
        );
      }
      const dueAtMs = position.entryAtMs + position.holdMs;
      // MFE/MAE remains in memory until the position is resolved. Persisting
      // every open position on every PumpSwap trade turns this observer into a
      // synchronous hot-path writer and can stall the collector on busy mints.
      if (timestampMs < dueAtMs) continue;
      if (available) {
        position.status = 'CLOSED';
        position.exitAtMs = timestampMs;
        position.exitPrice = finite(exit.price);
        position.exitMarketPrice = finite(exit.marketPrice);
        position.exitImpactPct = finite(exit.impactPct);
        position.grossReturnPct = grossReturnPct;
        position.netReturnPct = grossReturnPct - this.config.shadowRoundTripCostPct;
        position.exitReason = `FIXED_HOLD_${Math.round(position.holdMs / 1_000)}S`;
        position.exitExecutionJson = JSON.stringify(exit);
        this.metrics.shadowClosed += 1;
      } else if (timestampMs >= dueAtMs + this.config.shadowNoExitGraceMs) {
        position.status = 'NO_EXIT';
        position.exitAtMs = timestampMs;
        position.exitReason = `NO_EXIT_AFTER_${Math.round(position.holdMs / 1_000)}S`;
        position.missingExitReason = exit.reason || 'EXIT_CAPACITY_QUOTE_MISSING';
        position.exitExecutionJson = JSON.stringify(exit);
        this.metrics.shadowNoExit += 1;
      }
      this._persistShadowPosition(position, timestampMs);
    }
  }

  _expireShadowPositions(state, now) {
    for (const position of state.shadowPositions.values()) {
      if (position.status !== 'OPEN') continue;
      const expiresAtMs = position.entryAtMs + position.holdMs + this.config.shadowNoExitGraceMs;
      if (now < expiresAtMs) continue;
      position.status = 'NO_EXIT';
      position.exitAtMs = now;
      position.exitReason = `NO_EXIT_AFTER_${Math.round(position.holdMs / 1_000)}S`;
      position.missingExitReason = 'NO_FUTURE_EXECUTABLE_QUOTE';
      this.metrics.shadowNoExit += 1;
      this._persistShadowPosition(position, now);
    }
  }

  _finalizeShadowPositions(state, now, reason, status) {
    state.shadowEntryPendingAtMs = null;
    for (const position of state.shadowPositions.values()) {
      if (position.status !== 'OPEN') continue;
      const processBoundary = status === 'RIGHT_CENSORED';
      position.status = processBoundary ? 'RIGHT_CENSORED' : 'NO_EXIT';
      position.exitAtMs = now;
      position.exitReason = reason;
      position.missingExitReason = processBoundary
        ? 'PROCESS_BOUNDARY_NO_REPLAY' : 'OBSERVER_ENDED_BEFORE_EXECUTABLE_EXIT';
      if (!processBoundary) this.metrics.shadowNoExit += 1;
      this._persistShadowPosition(position, now);
    }
  }

  _persistShadowPosition(position, now) {
    if (!this.statements.updateShadow || !position?.id) return;
    this.statements.updateShadow.run({
      id: position.id,
      status: position.status,
      highestExecutableReturnPct: position.highestExecutableReturnPct,
      lowestExecutableReturnPct: position.lowestExecutableReturnPct,
      exitAtMs: position.exitAtMs,
      exitPrice: position.exitPrice,
      exitMarketPrice: position.exitMarketPrice,
      exitImpactPct: position.exitImpactPct,
      grossReturnPct: position.grossReturnPct,
      netReturnPct: position.netReturnPct,
      exitReason: position.exitReason,
      missingExitReason: position.missingExitReason,
      exitExecutionJson: position.exitExecutionJson,
      updatedAtMs: now,
    });
  }

  _finalize(state, status, reason, now) {
    if (!this.states.has(state.mint)) return;
    this._finalizeShadowPositions(state, now, reason, status);
    state.status = status;
    state.currentStage = status;
    state.finalReason = reason;
    state.finalizedAtMs = now;
    this._persist(state);
    this.states.delete(state.mint);
    if (status === 'COMPLETE') {
      this.metrics.completed += 1;
      this.metrics.lastCompletedAt = now;
    } else if (status === 'RIGHT_CENSORED') this.metrics.rightCensored += 1;
  }

  _persist(state) {
    if (!this.statements.update) return;
    this.statements.update.run({
      id: state.id,
      firstTradeAtMs: state.firstTradeAtMs,
      baselinePrice: state.baselinePrice,
      peakPrice: state.peakPrice,
      troughPrice: state.troughPrice,
      lastPrice: state.lastPrice,
      lastTradeAtMs: state.lastTradeAtMs,
      currentStage: state.currentStage,
      status: state.status,
      passed5m: Number(state.passed5m),
      passed30m: Number(state.passed30m),
      isHoldout: Number(state.isHoldout),
      wouldDropAtMs: state.wouldDropAtMs,
      dropReason: state.dropReason,
      return5mPct: state.returns[300] ?? null,
      return15mPct: state.returns[900] ?? null,
      return30mPct: state.returns[1_800] ?? null,
      return60mPct: state.returns[3_600] ?? null,
      mfePct: state.mfePct,
      maePct: state.maePct,
      executableRecoveryPct: state.executableRecoveryPct,
      executableMfePct: state.executableMfePct,
      executableMaePct: state.executableMaePct,
      postDropMfePct: Number.isFinite(state.postDropMfePct) ? state.postDropMfePct : null,
      postDropExecutableMfePct: Number.isFinite(state.postDropExecutableMfePct)
        ? state.postDropExecutableMfePct : null,
      priceAnomalyCount: state.priceAnomalyCount,
      finalReason: state.finalReason,
      decisionJson: state.latestDecision ? JSON.stringify(state.latestDecision) : null,
      finalizedAtMs: state.finalizedAtMs,
    });
  }

  _score(state, now) {
    const stats = this._stats(state, now, 5 * 60_000);
    const mark = finite(pctReturn(state.lastPrice, state.baselinePrice), -100);
    const retention = state.lastPrice > 0 && state.peakPrice > 0
      ? state.lastPrice / state.peakPrice * 100 : 0;
    const recovery = finite(state.executableRecoveryPct, 0);
    return mark * 0.2 + retention * 0.15 + recovery * 0.1
      + Math.log1p(stats.trades) * 5 + Math.log1p(stats.buyers) * 8
      + stats.netFlowSol * 0.5;
  }

  _enforceCaps(now) {
    const trim = (states, limit, reason) => {
      if (states.length <= limit) return;
      states.sort((a, b) => this._score(b, now) - this._score(a, now));
      for (const state of states.slice(limit)) {
        this._drop(state, reason, now, { cap: true, allowHoldout: false });
      }
    };
    trim([...this.states.values()].filter((state) => state.currentStage === 'TO_30M'),
      this.config.maxThirtyMinuteSurvivors, 'CAP_30M_LOWEST_SCORE');
    trim([...this.states.values()].filter((state) => state.currentStage === 'TO_60M'),
      this.config.maxSixtyMinuteSurvivors, 'CAP_60M_LOWEST_SCORE');
  }

  dashboard({ limit = this.config.dashboardLimit } = {}) {
    if (!this.config.enabled || !this.statements.recent) {
      return {
        runtime: this.health(), summary: {}, stages: [], dropReasons: [],
        shadowCohorts: [], shadowPositions: [], recent: [], milestones: [],
      };
    }
    const rows = this.statements.recent.all(Math.min(10_000, Math.max(100, Number(limit) || 2_000)));
    const shadowRows = this.statements.recentShadow
      ? this.statements.recentShadow.all(Math.min(20_000, Math.max(300, Number(limit) * 3 || 6_000)))
      : [];
    const completed = rows.filter((row) => row.status === 'COMPLETE');
    const dropped = rows.filter((row) => row.status === 'DROPPED' || row.would_drop_at_ms);
    const holdouts = rows.filter((row) => row.is_holdout && row.would_drop_at_ms);
    const falseNegatives = holdouts.filter(
      (row) => finite(row.post_drop_executable_mfe_pct, -Infinity) >= 50,
    );
    const byStage = new Map();
    for (const row of rows) byStage.set(row.current_stage, (byStage.get(row.current_stage) || 0) + 1);
    const byReason = new Map();
    for (const row of dropped) {
      const reason = row.drop_reason || 'UNKNOWN';
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
    }
    const mfe = aggregate(completed.map((row) => finite(row.mfe_pct)).filter(Number.isFinite));
    const executableMfe = aggregate(
      completed.map((row) => finite(row.executable_mfe_pct)).filter(Number.isFinite),
    );
    const shadowGroups = new Map();
    for (const row of shadowRows) {
      const group = shadowGroups.get(row.profile_id) || [];
      group.push(row);
      shadowGroups.set(row.profile_id, group);
    }
    const shadowCohorts = [...shadowGroups.entries()].map(([profileId, cohortRows]) => {
      const entered = cohortRows.filter((row) => row.status !== 'NO_ENTRY');
      const priced = cohortRows.filter(
        (row) => row.status === 'CLOSED' && Number.isFinite(Number(row.net_return_pct)),
      );
      const returns = priced.map((row) => Number(row.net_return_pct));
      const winners = returns.filter((value) => value > 0);
      const losers = returns.filter((value) => value < 0);
      const profit = winners.reduce((sum, value) => sum + value, 0);
      const loss = Math.abs(losers.reduce((sum, value) => sum + value, 0));
      return {
        profileId,
        holdMs: finite(cohortRows[0]?.hold_ms, 0),
        signals: cohortRows.length,
        entered: entered.length,
        priced: priced.length,
        winRatePct: priced.length ? winners.length / priced.length * 100 : null,
        returns: aggregate(returns),
        profitFactor: loss > 0 ? profit / loss : (profit > 0 ? null : 0),
        maxWinnerPct: returns.length ? Math.max(...returns) : null,
        big50RatePct: priced.length
          ? returns.filter((value) => value >= 50).length / priced.length * 100 : null,
        big100RatePct: priced.length
          ? returns.filter((value) => value >= 100).length / priced.length * 100 : null,
        noEntry: cohortRows.filter((row) => row.status === 'NO_ENTRY').length,
        noExit: cohortRows.filter((row) => row.status === 'NO_EXIT').length,
        rightCensored: cohortRows.filter((row) => row.status === 'RIGHT_CENSORED').length,
        averageMfePct: aggregate(priced.map(
          (row) => finite(row.highest_executable_return_pct),
        )).averagePct,
        averageMaePct: aggregate(priced.map(
          (row) => finite(row.lowest_executable_return_pct),
        )).averagePct,
      };
    }).sort((a, b) => a.holdMs - b.holdMs);
    return {
      runtime: this.health(),
      summary: {
        rowsLoaded: rows.length,
        completed: completed.length,
        dropped: dropped.length,
        holdoutDrops: holdouts.length,
        holdoutBig50FalseNegatives: falseNegatives.length,
        estimatedBig50MissRatePct: holdouts.length ? falseNegatives.length / holdouts.length * 100 : null,
        mfe,
        executableMfe,
        priceAnomalies: rows.reduce(
          (sum, row) => sum + Math.max(0, finite(row.price_anomaly_count, 0)), 0,
        ),
        passed5mBig50RatePct: completed.filter((row) => row.passed_5m).length
          ? completed.filter(
            (row) => row.passed_5m && finite(row.executable_mfe_pct, -Infinity) >= 50,
          ).length
            / completed.filter((row) => row.passed_5m).length * 100 : null,
        passed30mBig50RatePct: completed.filter((row) => row.passed_30m).length
          ? completed.filter(
            (row) => row.passed_30m && finite(row.executable_mfe_pct, -Infinity) >= 50,
          ).length
            / completed.filter((row) => row.passed_30m).length * 100 : null,
      },
      stages: [...byStage.entries()].map(([stage, count]) => ({ stage, count }))
        .sort((a, b) => b.count - a.count),
      dropReasons: [...byReason.entries()].map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count).slice(0, 20),
      shadowCohorts,
      shadowPositions: shadowRows.slice(0, 150).map((row) => ({
        id: row.id,
        mint: row.mint,
        profileId: row.profile_id,
        holdMs: row.hold_ms,
        status: row.status,
        signalAtMs: row.signal_at_ms,
        entryAtMs: row.entry_at_ms,
        entryPrice: row.entry_price,
        entryMarketPrice: row.entry_market_price,
        entryImpactPct: row.entry_impact_pct,
        highestExecutableReturnPct: row.highest_executable_return_pct,
        lowestExecutableReturnPct: row.lowest_executable_return_pct,
        exitAtMs: row.exit_at_ms,
        exitPrice: row.exit_price,
        exitImpactPct: row.exit_impact_pct,
        netReturnPct: row.net_return_pct,
        exitReason: row.exit_reason,
        missingExitReason: row.missing_exit_reason,
      })),
      recent: rows.slice(0, 100).map((row) => ({
        id: row.id,
        mint: row.mint,
        symbol: row.symbol,
        migrationAtMs: row.migration_at_ms,
        stage: row.current_stage,
        status: row.status,
        passed5m: Boolean(row.passed_5m),
        passed30m: Boolean(row.passed_30m),
        isHoldout: Boolean(row.is_holdout),
        dropReason: row.drop_reason,
        return5mPct: row.return_5m_pct,
        return30mPct: row.return_30m_pct,
        return60mPct: row.return_60m_pct,
        mfePct: row.mfe_pct,
        maePct: row.mae_pct,
        executableMfePct: row.executable_mfe_pct,
        executableMaePct: row.executable_mae_pct,
        executableRecoveryPct: row.executable_recovery_pct,
        postDropMfePct: row.post_drop_mfe_pct,
        postDropExecutableMfePct: row.post_drop_executable_mfe_pct,
        priceAnomalyCount: row.price_anomaly_count,
      })),
      milestones: this.statements.recentMilestones.all(100),
    };
  }

  health() {
    const stageCounts = {};
    for (const state of this.states.values()) {
      stageCounts[state.currentStage] = (stageCounts[state.currentStage] || 0) + 1;
    }
    const activeShadowPositions = [...this.states.values()].reduce(
      (sum, state) => sum + [...state.shadowPositions.values()]
        .filter((position) => position.status === 'OPEN').length,
      0,
    );
    return {
      enabled: this.config.enabled,
      mode: 'PM_SURV_OBSERVER_SHADOW',
      observerOnly: true,
      sendsTransactions: false,
      extraRpcCalls: false,
      requestedAmmMints: this.states.size,
      active: this.states.size,
      stageCounts,
      ...this.metrics,
      positionSol: this.config.positionSol,
      baselineStageMs: this.config.baselineStageMs,
      extendedStageMs: this.config.extendedStageMs,
      maxAgeMs: this.config.maxAgeMs,
      holdoutPct: this.config.holdoutPct,
      maxActive: this.config.maxActive,
      shadowEnabled: this.config.shadowEnabled,
      shadowHoldMs: this.config.shadowHoldMs,
      shadowRoundTripCostPct: this.config.shadowRoundTripCostPct,
      activeShadowPositions,
      transientUpPriceRatio: this.config.transientUpPriceRatio,
      priceConfirmationWindowMs: this.config.priceConfirmationWindowMs,
      priceConfirmationMinPersistenceMs: this.config.priceConfirmationMinPersistenceMs,
      priceConfirmationMinWallets: this.config.priceConfirmationMinWallets,
    };
  }
}

module.exports = {
  PostMigrationSurvivorObserver,
  aggregate,
  deterministicPercent,
};
