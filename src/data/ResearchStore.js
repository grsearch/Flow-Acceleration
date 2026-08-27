'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const Database = require('better-sqlite3');
const { costBreakdown, normalizeCostModel } = require('../core/CostModel');

const LAUNCH_QUALITY_COLUMNS = Object.freeze({
  status: 'status',
  completedAt: 'completed_at',
  censorReason: 'censor_reason',
  firstTradeAt: 'first_trade_at',
  baselinePrice: 'baseline_price',
  lastTradeAt: 'last_trade_at',
  lastPrice: 'last_price',
  peakAt: 'peak_at',
  peakPrice: 'peak_price',
  maxReturnPct: 'max_return_pct',
  pump25At: 'pump_25_at',
  pump50At: 'pump_50_at',
  pump100At: 'pump_100_at',
  referencePeakAt: 'reference_peak_at',
  referencePeakPrice: 'reference_peak_price',
  firstPullbackAt: 'first_pullback_at',
  pullbackLowPrice: 'pullback_low_price',
  maxPullbackPct: 'max_pullback_pct',
  reboundAt: 'rebound_at',
  reboundPrice: 'rebound_price',
  referenceFeaturesJson: 'reference_features_json',
  labelStatus: 'label_status',
  return3s: 'return_3s',
  return5s: 'return_5s',
  return10s: 'return_10s',
  return30s: 'return_30s',
  mfe3s: 'mfe_3s',
  mae3s: 'mae_3s',
  mfe5s: 'mfe_5s',
  mae5s: 'mae_5s',
  mfe10s: 'mfe_10s',
  mae10s: 'mae_10s',
  mfe30s: 'mfe_30s',
  mae30s: 'mae_30s',
});

function ensureParent(filePath) {
  if (filePath === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function receivedTimestampMs(value, eventTimestampMs) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return eventTimestampMs;
  while (Math.abs(timestamp) > 100_000_000_000_000) timestamp /= 1_000;
  if (!Number.isFinite(eventTimestampMs)) return timestamp;
  return Math.abs(timestamp - eventTimestampMs) <= 86_400_000
    ? timestamp
    : eventTimestampMs;
}

function curveProgress(initialRaw, currentRaw) {
  try {
    const initial = BigInt(initialRaw);
    const current = BigInt(currentRaw);
    if (initial <= 0n) return null;
    const basisPoints = ((initial - current) * 1_000_000n) / initial;
    const percentage = Number(basisPoints) / 10_000;
    return Math.min(100, Math.max(0, percentage));
  } catch (_) {
    return null;
  }
}

function legacyCostModel(configuredCostPct = 0) {
  return normalizeCostModel({
    platformFeePct: configuredCostPct,
    buySlippagePct: 0,
    sellSlippagePct: 0,
    priceImpactPct: 0,
    baseTxFeeSol: 0,
    priorityFeeSol: 0,
    jitoTipSol: 0,
    fixedCostSol: 0,
    positionSizeSol: 0.2,
    failureRatePct: 0,
    failureLossPct: 1,
  });
}

class ResearchStore {
  constructor(storageConfig, labelsConfig) {
    const startupStartedAt = Date.now();
    this.config = storageConfig;
    this.labelsConfig = labelsConfig;
    ensureParent(storageConfig.dbPath);
    console.log(`[Startup:DB] opening ${storageConfig.dbPath}`);
    this.db = new Database(storageConfig.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    console.log(`[Startup:DB] connection ready in ${Date.now() - startupStartedAt}ms; initializing schema`);
    const schemaStartedAt = Date.now();
    this._initSchema();
    console.log(`[Startup:DB] schema ready in ${Date.now() - schemaStartedAt}ms; preparing statements`);
    const prepareStartedAt = Date.now();
    this._prepare();
    console.log(`[Startup:DB] statements ready in ${Date.now() - prepareStartedAt}ms; loading token registry`);

    this.startupTradeReplayCache = null;
    this.startupTradeReplayStats = {
      primed: false,
      active: false,
      sinceMs: null,
      curveRows: 0,
      ammRows: 0,
      dbReads: 0,
      cacheHits: 0,
      primeDurationMs: null,
      releasedAt: null,
    };

    this.tokens = new Map();
    for (const token of this.stmts.allTokens.all()) this.tokens.set(token.mint, token);
    console.log(
      `[Startup:DB] token registry ready (${this.tokens.size} tokens); total ${Date.now() - startupStartedAt}ms`,
    );
    this.rawBuffer = [];
    this.returnUpdateStatements = new Map();
    this.launchQualityUpdateStatements = new Map();
    this.dashboardStatsCache = new Map();
    this.databaseHealthSnapshot = null;
    this.databaseHealthWorker = null;
    this.databaseHealthStartTimer = null;
    this.databaseHealthTimer = null;
    this.databaseHealthState = {
      status: storageConfig.dbPath === ':memory:' ? 'IN_MEMORY' : 'PENDING',
      generatedAt: null,
      durationMs: null,
      lastError: null,
      refreshes: 0,
    };
    this.metrics = {
      tradesQueued: 0,
      tradesWritten: 0,
      writeErrors: 0,
      timestampCorrections: 0,
      lastFlushAt: null,
      lastFlushMs: null,
      lastArchiveAt: null,
    };

    this.flushTimer = setInterval(() => {
      try {
        this.flushRawTrades();
      } catch (error) {
        console.error('[Database] raw trade flush failed:', error.message);
      }
    }, storageConfig.flushMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  _cachedDashboardStats(key, ttlMs, compute) {
    const now = Date.now();
    const cached = this.dashboardStatsCache.get(key);
    if (cached && now - cached.createdAt < ttlMs) return cached.value;
    const value = compute();
    this.dashboardStatsCache.set(key, { createdAt: now, value });
    return value;
  }

  startHealthSampler(refreshMs = this.config.healthRefreshMs || 15 * 60_000) {
    if (
      this.config.dbPath === ':memory:'
      || this.databaseHealthStartTimer
      || this.databaseHealthTimer
    ) return;
    const intervalMs = Math.max(60_000, Number(refreshMs) || 15 * 60_000);
    const sample = () => void this.refreshHealthSnapshot();
    this.databaseHealthStartTimer = setTimeout(() => {
      this.databaseHealthStartTimer = null;
      sample();
      this.databaseHealthTimer = setInterval(sample, intervalMs);
      if (this.databaseHealthTimer.unref) this.databaseHealthTimer.unref();
    }, Math.min(30_000, intervalMs));
    if (this.databaseHealthStartTimer.unref) this.databaseHealthStartTimer.unref();
  }

  refreshHealthSnapshot() {
    if (this.config.dbPath === ':memory:') {
      const startedAt = Date.now();
      this.databaseHealthSnapshot = this.health();
      this.databaseHealthState = {
        status: 'READY',
        generatedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        lastError: null,
        refreshes: this.databaseHealthState.refreshes + 1,
      };
      return Promise.resolve(this.databaseHealthSnapshot);
    }
    if (this.databaseHealthWorker) return this.databaseHealthWorker.promise;

    const startedAt = Date.now();
    this.databaseHealthState = {
      ...this.databaseHealthState,
      status: this.databaseHealthSnapshot ? 'REFRESHING' : 'PENDING',
      lastError: null,
    };
    const worker = new Worker(path.join(__dirname, 'database-health-worker.js'), {
      workerData: { dbPath: path.resolve(this.config.dbPath) },
    });
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    this.databaseHealthWorker = { worker, promise };

    const finish = ({ snapshot = null, error = null } = {}) => {
      if (this.databaseHealthWorker?.worker !== worker) return;
      if (snapshot) this.databaseHealthSnapshot = snapshot;
      this.databaseHealthState = {
        status: snapshot ? 'READY' : (this.databaseHealthSnapshot ? 'STALE' : 'ERROR'),
        generatedAt: snapshot ? Date.now() : this.databaseHealthState.generatedAt,
        durationMs: Date.now() - startedAt,
        lastError: error ? String(error) : null,
        refreshes: this.databaseHealthState.refreshes + (snapshot ? 1 : 0),
      };
      this.databaseHealthWorker = null;
      settle(this.databaseHealthSnapshot);
    };
    worker.once('message', (message) => {
      if (message?.ok) finish({ snapshot: message.snapshot });
      else finish({ error: message?.error || 'database health worker failed' });
    });
    worker.once('error', (error) => finish({ error: error.message }));
    worker.once('exit', (code) => {
      if (this.databaseHealthWorker?.worker === worker && code !== 0) {
        finish({ error: `database health worker exited with code ${code}` });
      }
    });
    return promise;
  }

  healthSnapshot() {
    if (this.config.dbPath === ':memory:' && !this.databaseHealthSnapshot) {
      this.databaseHealthSnapshot = this.health();
      this.databaseHealthState = {
        status: 'READY',
        generatedAt: Date.now(),
        durationMs: 0,
        lastError: null,
        refreshes: 1,
      };
    }
    return {
      ...(this.databaseHealthSnapshot || {}),
      ...this.metrics,
      pendingWrites: this.rawBuffer.length,
      dbPath: path.resolve(this.config.dbPath),
      statsSnapshot: {
        ...this.databaseHealthState,
        staleMs: this.databaseHealthState.generatedAt
          ? Math.max(0, Date.now() - this.databaseHealthState.generatedAt)
          : null,
      },
    };
  }

  shadowTimeSessionDashboard(strategyId) {
    const strategies = {
      'primary-shadow': {
        label: 'Primary Early',
        table: 'primary_signal_shadow_positions',
        anchor: 'signal_at',
      },
      'flow-first': {
        label: 'Flow-First · C',
        table: 'flow_first_shadow_positions',
        anchor: 'signal_at',
      },
      'smart-pullback': {
        label: 'Smart 回踩 · A/B',
        table: 'smart_pullback_shadow_positions',
        anchor: 'smart_buy_at',
      },
      'smart-open': {
        label: 'Smart OPEN · D',
        table: 'smart_open_shadow_positions',
        anchor: 'smart_open_at',
      },
      'flow-smart-confirm': {
        label: 'Flow to Smart Confirm L',
        table: 'flow_smart_confirm_shadow_positions',
        anchor: 'smart_open_at',
      },
      'smart-like-early': {
        label: 'Smart-Like Early Entry',
        table: 'smart_like_early_shadow_positions',
        anchor: 'signal_at',
      },
      'smart-resonance': {
        label: 'Smart Resonance Right-Tail · SR',
        table: 'smart_resonance_shadow_positions',
        anchor: 'signal_at',
      },
      'public-flow-lead': {
        label: 'Public Flow Lead · PFL',
        table: 'public_flow_lead_shadow_positions',
        anchor: 'signal_at',
      },
      'creator-affinity': {
        label: 'Creator Affinity + Public Flow · CAF',
        table: 'creator_affinity_shadow_positions',
        anchor: 'signal_at',
      },
      'cya-slot-flow': {
        label: 'CYA Slot Flow · CSF',
        table: 'cya_slot_flow_shadow_positions',
        anchor: 'signal_at',
      },
      'launch-pullback': {
        label: 'Launch 回踩 · F',
        table: 'launch_pullback_shadow_positions',
        anchor: 'reference_at',
      },
      'migrated-rebound': {
        label: '生命周期超跌反弹 · G',
        table: 'migrated_drop_rebound_shadow_positions',
        anchor: 'rebound_at',
      },
      'migration-continuity': {
        label: 'Migration Continuity · M',
        table: 'migration_continuity_shadow_positions',
        anchor: 'signal_at',
      },
      'range-scalper': {
        label: 'PumpSwap Range Scalper · J',
        table: 'range_scalper_shadow_positions',
        anchor: 'signal_at',
      },
      'cya-early-pyramid': {
        label: 'CYA Early Pyramid · K',
        table: 'cya_early_pyramid_shadow_positions',
        anchor: 'signal_at',
      },
      'bonding-momentum': {
        label: 'Bonding Curve 动量 · H',
        table: 'bonding_curve_momentum_shadow_positions',
        anchor: 'signal_at',
      },
      'graduation-hold': {
        label: '毕业概率持仓 · I',
        table: 'graduation_hold_shadow_positions',
        anchor: 'signal_at',
      },
      'holder-growth': {
        label: 'Observed Holder Growth · N',
        table: 'holder_growth_shadow_positions',
        anchor: 'signal_at',
      },
      'quality-leader': {
        label: 'Quality Leader · QL',
        table: 'quality_leader_shadow_positions',
        anchor: 'signal_at',
      },
      'big-winner': {
        label: 'Big Winner Pullback + Flow - BW',
        table: 'big_winner_shadow_positions',
        anchor: 'signal_at',
      },
    };
    const strategy = strategies[strategyId];
    if (!strategy) throw new Error(`Unknown Shadow time-session strategy: ${strategyId}`);
    const definitions = [
      { id: '00-04', label: '00:00–04:00', note: '深夜' },
      { id: '04-08', label: '04:00–08:00', note: '凌晨' },
      { id: '08-18', label: '08:00–18:00', note: '白天' },
      { id: '18-24', label: '18:00–24:00', note: '晚间' },
    ];
    const hour = `CAST(strftime('%H', ${strategy.anchor} / 1000.0,
      'unixepoch', '+8 hours') AS INTEGER)`;
    const session = `CASE
      WHEN ${hour} < 4 THEN '00-04'
      WHEN ${hour} < 8 THEN '04-08'
      WHEN ${hour} < 18 THEN '08-18'
      ELSE '18-24'
    END`;
    const compute = () => {
      const standardSql = `
        SELECT ${session} AS session_id,
          COUNT(*) AS resolved,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(net_return_pct > 0), 0) AS wins,
          AVG(net_return_pct) AS average_net_return_pct,
          COALESCE(SUM(CASE WHEN net_return_pct > 0 THEN net_return_pct ELSE 0 END), 0)
            AS total_profit_pct,
          ABS(COALESCE(SUM(CASE WHEN net_return_pct < 0 THEN net_return_pct ELSE 0 END), 0))
            AS total_loss_pct
        FROM ${strategy.table}
        WHERE status IN ('CLOSED', 'NO_EXIT') AND net_return_pct IS NOT NULL
        GROUP BY session_id
      `;
      const holderGrowthSql = `
        SELECT ${session} AS session_id,
          COALESCE(SUM(status = 'CLOSED'), 0) AS resolved,
          COUNT(DISTINCT CASE WHEN status = 'CLOSED' THEN mint END) AS independent_mints,
          COALESCE(SUM(status = 'CLOSED' AND net_return_pct > 0), 0) AS wins,
          AVG(CASE WHEN status = 'CLOSED' THEN net_return_pct END)
            AS average_net_return_pct,
          COALESCE(SUM(CASE WHEN status = 'CLOSED' AND net_return_pct > 0
            THEN net_return_pct ELSE 0 END), 0) AS total_profit_pct,
          ABS(COALESCE(SUM(CASE WHEN status = 'CLOSED' AND net_return_pct < 0
            THEN net_return_pct ELSE 0 END), 0)) AS total_loss_pct,
          COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
          AVG(CASE WHEN status = 'CLOSED' THEN net_return_pct
            WHEN status = 'NO_EXIT' THEN -100 - configured_cost_pct END)
            AS conservative_average_net_return_pct
        FROM ${strategy.table}
        WHERE status IN ('CLOSED', 'NO_EXIT')
        GROUP BY session_id
      `;
      const rows = this.db.prepare(
        ['holder-growth', 'quality-leader'].includes(strategyId)
          ? holderGrowthSql : standardSql,
      ).all();
      const byId = new Map(rows.map((row) => [row.session_id, row]));
      return definitions.map((definition) => {
        const row = byId.get(definition.id) || {};
        const resolved = Number(row.resolved) || 0;
        const wins = Number(row.wins) || 0;
        const noExit = Number(row.no_exit) || 0;
        const profit = Number(row.total_profit_pct) || 0;
        const loss = Number(row.total_loss_pct) || 0;
        return {
          ...definition,
          resolved,
          independent_mints: Number(row.independent_mints) || 0,
          wins,
          no_exit: noExit,
          no_exit_rate_pct: resolved + noExit ? noExit / (resolved + noExit) * 100 : null,
          win_rate_pct: resolved ? wins / resolved * 100 : null,
          average_net_return_pct: resolved ? Number(row.average_net_return_pct) : null,
          conservative_average_net_return_pct: row.conservative_average_net_return_pct == null
            ? null : Number(row.conservative_average_net_return_pct),
          profit_factor: loss > 0 ? profit / loss : (profit > 0 ? null : 0),
        };
      });
    };
    return {
      strategyId,
      strategyLabel: strategy.label,
      timezone: 'Asia/Shanghai',
      observationOnly: true,
      countingUnit: 'resolved cohort positions',
      sessions: this._cachedDashboardStats(`shadow-time-sessions:${strategyId}`, 60_000, compute),
    };
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flow_tokens (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        uri TEXT,
        bonding_curve TEXT,
        creator TEXT,
        created_at INTEGER,
        graduated_at INTEGER,
        migration_pool TEXT,
        initial_real_token_reserves_raw TEXT,
        token_total_supply_raw TEXT,
        last_real_token_reserves_raw TEXT,
        curve_pct REAL,
        last_price REAL,
        last_trade_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_flow_tokens_last_trade ON flow_tokens(last_trade_at);
      CREATE INDEX IF NOT EXISTS idx_flow_tokens_pool ON flow_tokens(migration_pool);
      CREATE INDEX IF NOT EXISTS idx_flow_tokens_creator_created
        ON flow_tokens(creator, created_at);

      CREATE TABLE IF NOT EXISTS raw_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        chain_timestamp_ms INTEGER,
        received_at_ms INTEGER NOT NULL,
        slot INTEGER,
        signature TEXT,
        event_index INTEGER NOT NULL DEFAULT 0,
        market TEXT NOT NULL,
        mint TEXT NOT NULL,
        bonding_curve TEXT,
        wallet TEXT,
        side TEXT NOT NULL,
        sol_amount REAL NOT NULL,
        token_amount REAL NOT NULL,
        price REAL NOT NULL,
        reserve_price REAL,
        curve_pct REAL,
        virtual_sol_reserves_raw TEXT,
        virtual_token_reserves_raw TEXT,
        real_sol_reserves_raw TEXT,
        real_token_reserves_raw TEXT,
        UNIQUE(signature, event_index, market)
      );
      CREATE INDEX IF NOT EXISTS idx_raw_trades_ts ON raw_trades(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_raw_trades_mint_ts ON raw_trades(mint, timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_raw_trades_wallet_ts ON raw_trades(wallet, timestamp_ms);

      CREATE TABLE IF NOT EXISTS flow_signals (
        signal_id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        slot INTEGER,
        signature TEXT,
        mint TEXT NOT NULL,
        symbol TEXT,
        age_ms INTEGER,
        curve_pct REAL,
        p0 REAL NOT NULL,
        buy_flow_w1 REAL NOT NULL,
        buy_flow_w2 REAL NOT NULL,
        buy_flow_w3 REAL NOT NULL,
        sell_flow_w1 REAL NOT NULL,
        sell_flow_w2 REAL NOT NULL,
        sell_flow_w3 REAL NOT NULL,
        netflow_w1 REAL NOT NULL,
        netflow_w2 REAL NOT NULL,
        netflow_w3 REAL NOT NULL,
        delta_netflow_12 REAL NOT NULL,
        delta_netflow_23 REAL NOT NULL,
        unique_buyers_w1 INTEGER NOT NULL,
        unique_buyers_w2 INTEGER NOT NULL,
        unique_buyers_w3 INTEGER NOT NULL,
        buy_tx_w1 INTEGER NOT NULL,
        buy_tx_w2 INTEGER NOT NULL,
        buy_tx_w3 INTEGER NOT NULL,
        flow_accel_1 REAL,
        flow_accel_2 REAL,
        flow_accel REAL,
        signal_variant TEXT NOT NULL DEFAULT 'primary_3w',
        is_primary INTEGER NOT NULL DEFAULT 1,
        signal_episode_id TEXT,
        signal_rank_in_mint INTEGER,
        previous_signal_gap_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_flow_signals_ts ON flow_signals(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_flow_signals_mint_ts ON flow_signals(mint, timestamp_ms);

      CREATE TABLE IF NOT EXISTS signal_returns (
        signal_id INTEGER PRIMARY KEY REFERENCES flow_signals(signal_id) ON DELETE CASCADE,
        p0 REAL NOT NULL,
        configured_cost_pct REAL NOT NULL DEFAULT 0,
        cost_model_json TEXT,
        label_status TEXT NOT NULL DEFAULT 'PENDING',
        censor_reason TEXT,
        missing_horizons_json TEXT,
        horizon_observation_lags_json TEXT,
        return_1s REAL, return_2s REAL, return_3s REAL, return_5s REAL,
        return_8s REAL, return_10s REAL, return_15s REAL, return_20s REAL,
        return_30s REAL, return_60s REAL,
        net_return_1s REAL, net_return_2s REAL, net_return_3s REAL, net_return_5s REAL,
        net_return_8s REAL, net_return_10s REAL, net_return_15s REAL, net_return_20s REAL,
        net_return_30s REAL, net_return_60s REAL,
        mfe_5s REAL, mae_5s REAL,
        mfe_10s REAL, mae_10s REAL,
        mfe_30s REAL, mae_30s REAL,
        last_observed_at INTEGER,
        finalized_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS smart_wallet_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        received_at_ms INTEGER,
        slot INTEGER,
        signature TEXT,
        event_index INTEGER NOT NULL DEFAULT 0,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        market TEXT,
        sol_amount REAL NOT NULL,
        token_amount REAL,
        price REAL,
        curve_pct REAL,
        age_ms INTEGER,
        position_phase TEXT,
        token_balance_before REAL,
        token_balance_after REAL,
        nearest_flow_signal INTEGER,
        time_from_flow_signal_ms INTEGER,
        UNIQUE(signature, event_index, wallet)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_wallet_events_wallet_ts
        ON smart_wallet_events(wallet, timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_smart_wallet_events_mint_ts
        ON smart_wallet_events(mint, timestamp_ms);

      CREATE TABLE IF NOT EXISTS smart_signal_confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL REFERENCES flow_signals(signal_id) ON DELETE CASCADE,
        smart_event_id INTEGER NOT NULL REFERENCES smart_wallet_events(id) ON DELETE CASCADE,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        open_timestamp_ms INTEGER NOT NULL,
        delay_ms INTEGER NOT NULL,
        open_sol REAL NOT NULL,
        UNIQUE(signal_id, smart_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_signal_confirmations_signal
        ON smart_signal_confirmations(signal_id);
      CREATE INDEX IF NOT EXISTS idx_smart_signal_confirmations_mint_ts
        ON smart_signal_confirmations(mint, open_timestamp_ms);

      CREATE TABLE IF NOT EXISTS smart_wallet_positions (
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        token_balance REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(wallet, mint)
      );

      CREATE TABLE IF NOT EXISTS smart_open_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        smart_event_id INTEGER NOT NULL UNIQUE
          REFERENCES smart_wallet_events(id) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        received_at_ms INTEGER,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        market TEXT,
        position_phase TEXT,
        smart_sol REAL NOT NULL,
        smart_price REAL,
        prebuy_window_ms INTEGER NOT NULL,
        prebuy_buyers INTEGER NOT NULL,
        prebuy_buy_tx INTEGER NOT NULL,
        prebuy_buy_flow_sol REAL NOT NULL,
        prebuy_sell_flow_sol REAL NOT NULL,
        prebuy_net_flow_sol REAL NOT NULL,
        event_age_ms INTEGER NOT NULL,
        rule_matched INTEGER NOT NULL,
        rejection_reasons_json TEXT NOT NULL,
        mode TEXT NOT NULL,
        action_status TEXT NOT NULL,
        action_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_smart_open_decisions_ts
        ON smart_open_decisions(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_smart_open_decisions_match_ts
        ON smart_open_decisions(rule_matched, timestamp_ms);

      CREATE TABLE IF NOT EXISTS primary_live_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL UNIQUE
          REFERENCES flow_signals(signal_id) ON DELETE CASCADE,
        signal_episode_id TEXT,
        timestamp_ms INTEGER NOT NULL,
        received_at_ms INTEGER,
        mint TEXT NOT NULL,
        symbol TEXT,
        rule_version TEXT NOT NULL,
        signal_variant TEXT NOT NULL,
        netflow_w3 REAL NOT NULL,
        unique_buyers_w3 INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        signal_age_ms INTEGER NOT NULL,
        rule_matched INTEGER NOT NULL,
        rejection_reasons_json TEXT NOT NULL,
        mode TEXT NOT NULL,
        action_status TEXT NOT NULL,
        action_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_primary_live_decisions_episode
        ON primary_live_decisions(signal_episode_id)
        WHERE signal_episode_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_primary_live_decisions_ts
        ON primary_live_decisions(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_primary_live_decisions_match_ts
        ON primary_live_decisions(rule_matched, timestamp_ms);

      CREATE TABLE IF NOT EXISTS live_strategy_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        received_at_ms INTEGER,
        mint TEXT NOT NULL,
        symbol TEXT,
        rule_version TEXT NOT NULL,
        market TEXT NOT NULL,
        reference_price REAL,
        features_json TEXT NOT NULL DEFAULT '{}',
        rule_matched INTEGER NOT NULL,
        rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
        mode TEXT NOT NULL,
        action_status TEXT NOT NULL,
        action_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(strategy_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_live_strategy_decisions_ts
        ON live_strategy_decisions(strategy_id, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_live_strategy_decisions_match_ts
        ON live_strategy_decisions(strategy_id, rule_matched, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_live_strategy_decisions_strategy_mint
        ON live_strategy_decisions(strategy_id, mint, rule_matched);

      CREATE TABLE IF NOT EXISTS live_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER REFERENCES smart_open_decisions(id),
        primary_decision_id INTEGER REFERENCES primary_live_decisions(id),
        strategy_decision_id INTEGER REFERENCES live_strategy_decisions(id),
        strategy_id TEXT,
        source_type TEXT NOT NULL DEFAULT 'PRIMARY_SIGNAL',
        signal_id INTEGER REFERENCES flow_signals(signal_id),
        mint TEXT NOT NULL,
        trigger_wallet TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        position_sol REAL NOT NULL,
        entry_sol_delta REAL,
        exit_sol_delta REAL,
        realized_pnl_sol REAL,
        realized_return_pct REAL,
        token_amount_raw TEXT,
        entry_market TEXT,
        entry_price REAL,
        entry_signature TEXT,
        entry_error TEXT,
        highest_price REAL,
        exit_market TEXT,
        exit_price REAL,
        exit_signature TEXT,
        exit_reason TEXT,
        exit_error TEXT,
        opened_at INTEGER,
        exit_requested_at INTEGER,
        closed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_live_positions_status
        ON live_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_live_positions_active_mint
        ON live_positions(mint, status, updated_at)
        WHERE status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED');

      CREATE TABLE IF NOT EXISTS live_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL REFERENCES live_positions(id),
        decision_id INTEGER REFERENCES smart_open_decisions(id),
        primary_decision_id INTEGER REFERENCES primary_live_decisions(id),
        strategy_decision_id INTEGER REFERENCES live_strategy_decisions(id),
        strategy_id TEXT,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        venue TEXT,
        attempt INTEGER NOT NULL,
        requested_sol REAL,
        requested_token_raw TEXT,
        wallet_sol_delta REAL,
        network_fee_sol REAL,
        status TEXT NOT NULL,
        signature TEXT,
        error TEXT,
        execution_json TEXT,
        submitted_at INTEGER,
        confirmed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_live_orders_position
        ON live_orders(position_id, id);
      CREATE INDEX IF NOT EXISTS idx_live_orders_created_id
        ON live_orders(created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS primary_signal_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL UNIQUE
          REFERENCES flow_signals(signal_id) ON DELETE CASCADE,
        signal_episode_id TEXT,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rule_matched INTEGER NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        highest_price REAL,
        smart_confirmed_at INTEGER,
        confirming_wallets_json TEXT NOT NULL DEFAULT '[]',
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        netflow_w3 REAL,
        unique_buyers_w3 INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_primary_shadow_episode
        ON primary_signal_shadow_positions(signal_episode_id)
        WHERE signal_episode_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_primary_shadow_status
        ON primary_signal_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_primary_shadow_mint
        ON primary_signal_shadow_positions(mint, signal_at DESC);

      CREATE TABLE IF NOT EXISTS flow_first_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        signal_id INTEGER NOT NULL
          REFERENCES flow_signals(signal_id) ON DELETE CASCADE,
        signal_episode_id TEXT NOT NULL,
        signal_rank_in_mint INTEGER,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        netflow_w3 REAL,
        unique_buyers_w3 INTEGER,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        max_favorable_return_pct REAL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, signal_episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_flow_first_shadow_status
        ON flow_first_shadow_positions(cohort_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_flow_first_shadow_mint
        ON flow_first_shadow_positions(mint, signal_at DESC);

      CREATE TABLE IF NOT EXISTS smart_pullback_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        smart_event_id INTEGER REFERENCES smart_wallet_events(id) ON DELETE SET NULL,
        smart_wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        smart_buy_at INTEGER NOT NULL,
        smart_buy_price REAL NOT NULL,
        smart_buy_sol REAL NOT NULL,
        confirmation_deadline_at INTEGER NOT NULL,
        peak_before_pullback REAL,
        pullback_armed_at INTEGER,
        pullback_low_price REAL,
        rebound_buyers_json TEXT NOT NULL DEFAULT '[]',
        confirmation_at INTEGER,
        confirmation_price REAL,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        highest_price REAL,
        max_favorable_return_pct REAL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_pullback_shadow_status
        ON smart_pullback_shadow_positions(cohort_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_smart_pullback_shadow_mint
        ON smart_pullback_shadow_positions(mint, smart_buy_at DESC);

      CREATE TABLE IF NOT EXISTS smart_open_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        smart_event_id INTEGER NOT NULL
          REFERENCES smart_wallet_events(id) ON DELETE CASCADE,
        smart_wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        smart_open_at INTEGER NOT NULL,
        smart_open_price REAL NOT NULL,
        smart_open_sol REAL NOT NULL,
        curve_pct REAL,
        age_ms INTEGER,
        prebuy_window_ms INTEGER NOT NULL,
        prebuy_buyers INTEGER NOT NULL,
        prebuy_buy_tx INTEGER NOT NULL,
        prebuy_buy_flow_sol REAL NOT NULL,
        prebuy_sell_flow_sol REAL NOT NULL,
        prebuy_net_flow_sol REAL NOT NULL,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        max_favorable_return_pct REAL,
        trailing_activated_at INTEGER,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, smart_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_open_shadow_status
        ON smart_open_shadow_positions(cohort_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_smart_open_shadow_mint
        ON smart_open_shadow_positions(mint, smart_open_at DESC);

      CREATE TABLE IF NOT EXISTS flow_smart_confirm_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        smart_event_id INTEGER NOT NULL
          REFERENCES smart_wallet_events(id) ON DELETE CASCADE,
        signal_id INTEGER
          REFERENCES flow_signals(signal_id) ON DELETE CASCADE,
        smart_wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        signal_rank_in_mint INTEGER,
        signal_variant TEXT NOT NULL,
        netflow_w3 REAL,
        unique_buyers_w3 INTEGER,
        smart_open_at INTEGER NOT NULL,
        smart_open_price REAL NOT NULL,
        smart_open_sol REAL NOT NULL,
        confirmation_delay_ms INTEGER NOT NULL,
        curve_pct REAL,
        age_ms INTEGER,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        max_favorable_return_pct REAL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, smart_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_flow_smart_confirm_shadow_status
        ON flow_smart_confirm_shadow_positions(cohort_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_flow_smart_confirm_shadow_mint
        ON flow_smart_confirm_shadow_positions(mint, smart_open_at DESC);

      CREATE TABLE IF NOT EXISTS launch_pullback_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        reference_profile_id TEXT NOT NULL DEFAULT 'LEGACY_7_5_R3',
        reference_at INTEGER NOT NULL,
        reference_price REAL NOT NULL,
        pump_25_at INTEGER,
        reference_peak_at INTEGER,
        reference_peak_price REAL,
        first_pullback_at INTEGER,
        pullback_low_price REAL,
        max_pullback_pct REAL,
        reference_rebound_pct REAL,
        low_stable_ms INTEGER,
        buyers_since_pullback_low INTEGER,
        window_net_flow_sol REAL,
        flow_window_ms INTEGER,
        net_flow_sol REAL,
        creator_share_pct REAL,
        buyers INTEGER,
        recent_buyers INTEGER,
        retention_pct REAL,
        top1_share_pct REAL,
        top3_share_pct REAL,
        sell_sol_since_peak REAL,
        buy_sol_since_peak REAL,
        buy_refill_ratio REAL,
        recent_net_flow_1s REAL,
        previous_net_flow_1s REAL,
        net_flow_acceleration_1s REAL,
        market_regime_observed_at INTEGER,
        market_regime_independent_mints INTEGER,
        market_regime_average_net_return_5s REAL,
        market_regime_win_rate_5s REAL,
        market_regime_big20_rate_5s REAL,
        flow_confirmation_at INTEGER,
        flow_confirmation_variant TEXT,
        flow_confirmation_buyers_w3 INTEGER,
        flow_confirmation_netflow_w3 REAL,
        flow_confirmation_window_ms INTEGER,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        max_favorable_return_pct REAL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, mint)
      );
      CREATE INDEX IF NOT EXISTS idx_launch_pullback_shadow_status
        ON launch_pullback_shadow_positions(cohort_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_launch_pullback_shadow_mint
        ON launch_pullback_shadow_positions(mint, reference_at DESC);

      CREATE TABLE IF NOT EXISTS migrated_drop_rebound_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        lifecycle_stage TEXT NOT NULL DEFAULT 'POST_MIGRATION',
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        confirmation_json TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        migrated_at INTEGER NOT NULL,
        migration_age_ms INTEGER NOT NULL,
        window_ms INTEGER NOT NULL,
        drop_min_pct REAL NOT NULL,
        drop_max_pct REAL NOT NULL,
        rebound_min_pct REAL NOT NULL,
        rebound_max_pct REAL NOT NULL,
        rebound_timeout_ms INTEGER NOT NULL,
        peak_at INTEGER NOT NULL,
        peak_price REAL NOT NULL,
        low_at INTEGER NOT NULL,
        low_price REAL NOT NULL,
        drop_pct REAL NOT NULL,
        rebound_at INTEGER NOT NULL,
        rebound_price REAL NOT NULL,
        rebound_pct REAL NOT NULL,
        rebound_elapsed_ms INTEGER NOT NULL,
        rebound_from_low_ms INTEGER NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        entry_impact_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        trailing_activated_at INTEGER,
        exit_mode TEXT NOT NULL,
        fixed_hold_ms INTEGER,
        trailing_activation_pct REAL,
        trailing_stop_pct REAL,
        hard_stop_pct REAL,
        fast_take_profit_pct REAL,
        fast_take_profit_window_ms INTEGER,
        loss_check_at_ms INTEGER,
        loss_check_recovery_pct REAL,
        max_hold_ms INTEGER,
        core_weight_pct REAL,
        runner_hold_ms INTEGER,
        core_exit_target_at INTEGER,
        core_exit_at INTEGER,
        core_exit_price REAL,
        core_exit_reason TEXT,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_migrated_drop_rebound_status
        ON migrated_drop_rebound_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_migrated_drop_rebound_mint
        ON migrated_drop_rebound_shadow_positions(mint, rebound_at DESC);
      CREATE INDEX IF NOT EXISTS idx_migrated_drop_rebound_profiles
        ON migrated_drop_rebound_shadow_positions(entry_profile_id, exit_profile_id, rebound_at);

      CREATE TABLE IF NOT EXISTS migration_continuity_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        graduated_at INTEGER NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        entry_buyers INTEGER NOT NULL,
        entry_buy_sol REAL NOT NULL,
        entry_sell_sol REAL NOT NULL,
        entry_net_flow_sol REAL NOT NULL,
        entry_sell_buy_ratio REAL NOT NULL,
        entry_return_pct REAL NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        trailing_activated_at INTEGER,
        exit_mode TEXT NOT NULL,
        min_hold_ms INTEGER,
        fixed_hold_ms INTEGER,
        trailing_activation_pct REAL,
        trailing_stop_pct REAL,
        hard_stop_pct REAL,
        max_hold_ms INTEGER,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_migration_continuity_shadow_status
        ON migration_continuity_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_migration_continuity_shadow_mint
        ON migration_continuity_shadow_positions(mint, signal_at DESC);

      CREATE TABLE IF NOT EXISTS range_scalper_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        swing_index INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        migrated_at INTEGER NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        range_score REAL NOT NULL,
        window_ms INTEGER NOT NULL,
        trade_count INTEGER NOT NULL,
        volume_sol REAL NOT NULL,
        unique_wallets INTEGER NOT NULL,
        buy_share_pct REAL NOT NULL,
        range_pct REAL NOT NULL,
        efficiency_ratio REAL NOT NULL,
        mean_crosses INTEGER NOT NULL,
        top_wallet_share_pct REAL NOT NULL,
        trend_pct REAL NOT NULL,
        midline_price REAL NOT NULL,
        lower_band_price REAL NOT NULL,
        upper_band_price REAL NOT NULL,
        deviation_sigma REAL NOT NULL,
        rebound_pct REAL NOT NULL,
        recent_netflow_sol REAL NOT NULL,
        recent_buyers INTEGER NOT NULL,
        sell_decay_ratio REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        exit_mode TEXT NOT NULL,
        take_profit_pct REAL,
        hard_stop_pct REAL NOT NULL,
        max_hold_ms INTEGER NOT NULL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_range_scalper_shadow_status
        ON range_scalper_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_range_scalper_shadow_mint
        ON range_scalper_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_range_scalper_shadow_profiles
        ON range_scalper_shadow_positions(entry_profile_id, exit_profile_id, signal_at);

      CREATE TABLE IF NOT EXISTS cya_early_pyramid_shadow_positions (
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
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        age_ms INTEGER,
        curve_pct REAL,
        buyers_1s INTEGER,
        buyers_5s INTEGER,
        net_flow_1s REAL,
        net_flow_5s REAL,
        return_2s_pct REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        average_entry_price REAL,
        total_invested_sol REAL,
        token_units REAL,
        remaining_token_units REAL,
        realized_proceeds_sol REAL NOT NULL DEFAULT 0,
        add_count INTEGER NOT NULL DEFAULT 0,
        last_add_at INTEGER,
        last_add_price REAL,
        first_take_profit_at INTEGER,
        first_take_profit_price REAL,
        second_take_profit_at INTEGER,
        second_take_profit_price REAL,
        scale_out_count INTEGER NOT NULL DEFAULT 0,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        trailing_stop_pct REAL NOT NULL,
        hard_stop_pct REAL NOT NULL,
        no_strength_ms INTEGER NOT NULL,
        no_strength_mfe_pct REAL NOT NULL,
        max_hold_ms INTEGER NOT NULL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        estimated_cost_sol REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cya_early_pyramid_status
        ON cya_early_pyramid_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_cya_early_pyramid_mint
        ON cya_early_pyramid_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cya_early_pyramid_profiles
        ON cya_early_pyramid_shadow_positions(entry_profile_id, exit_profile_id, signal_at);

      CREATE TABLE IF NOT EXISTS bonding_curve_momentum_shadow_positions (
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
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        age_ms INTEGER,
        curve_pct REAL,
        virtual_sol_reserves REAL,
        net_flow_1s REAL NOT NULL,
        prior_net_flow_1s REAL NOT NULL,
        flow_accel_1s REAL NOT NULL,
        buy_sol_1s REAL NOT NULL,
        sell_sol_1s REAL NOT NULL,
        prior_sell_sol_1s REAL NOT NULL,
        sell_decay_ratio REAL NOT NULL,
        buyers_1s INTEGER NOT NULL,
        new_buyers_1s INTEGER NOT NULL,
        buy_tx_1s INTEGER NOT NULL,
        prior_buy_tx_1s INTEGER NOT NULL,
        buy_tx_accel_1s INTEGER NOT NULL,
        top1_share_pct REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        trailing_activated_at INTEGER,
        exit_mode TEXT NOT NULL,
        fixed_hold_ms INTEGER,
        min_hold_ms INTEGER,
        max_hold_ms INTEGER NOT NULL,
        trailing_activation_pct REAL,
        trailing_stop_pct REAL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bonding_momentum_status
        ON bonding_curve_momentum_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_bonding_momentum_mint
        ON bonding_curve_momentum_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bonding_momentum_profiles
        ON bonding_curve_momentum_shadow_positions(entry_profile_id, exit_profile_id, signal_at);

      CREATE TABLE IF NOT EXISTS graduation_hold_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        signal_id INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        signal_curve_pct REAL,
        signal_netflow_w3 REAL,
        signal_buyers_w3 INTEGER,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        exit_mode TEXT NOT NULL,
        current_checkpoint_pct REAL,
        next_checkpoint_pct REAL,
        checkpoint_deadline_at INTEGER,
        gates_passed INTEGER NOT NULL DEFAULT 0,
        last_gate_at INTEGER,
        last_gate_pass INTEGER,
        last_features_json TEXT,
        checkpoint_history_json TEXT NOT NULL DEFAULT '[]',
        graduation_ready INTEGER NOT NULL DEFAULT 0,
        graduated_at INTEGER,
        exit_target_market TEXT,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_graduation_hold_status
        ON graduation_hold_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_graduation_hold_mint
        ON graduation_hold_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_graduation_hold_cohort
        ON graduation_hold_shadow_positions(cohort_id, signal_at DESC);

      CREATE TABLE IF NOT EXISTS bonding_curve_momentum_shadow_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        horizon_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        target_at INTEGER NOT NULL,
        observed_at INTEGER,
        observation_lag_ms INTEGER,
        market TEXT,
        price REAL,
        gross_return_pct REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        net_flow_1s REAL,
        flow_accel_1s REAL,
        buyers_1s INTEGER,
        new_buyers_1s INTEGER,
        buy_tx_accel_1s INTEGER,
        sell_decay_ratio REAL,
        curve_pct REAL,
        virtual_sol_reserves REAL,
        features_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(episode_id, horizon_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_bonding_momentum_snapshots_horizon
        ON bonding_curve_momentum_shadow_snapshots(horizon_ms, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bonding_momentum_snapshots_mint
        ON bonding_curve_momentum_shadow_snapshots(mint, target_at DESC);

      CREATE TABLE IF NOT EXISTS launch_quality_observations (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        creator TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'OBSERVING',
        completed_at INTEGER,
        censor_reason TEXT,
        first_trade_at INTEGER,
        baseline_price REAL,
        last_trade_at INTEGER,
        last_price REAL,
        peak_at INTEGER,
        peak_price REAL,
        max_return_pct REAL,
        pump_25_at INTEGER,
        pump_50_at INTEGER,
        pump_100_at INTEGER,
        reference_peak_at INTEGER,
        reference_peak_price REAL,
        first_pullback_at INTEGER,
        pullback_low_price REAL,
        max_pullback_pct REAL,
        rebound_at INTEGER,
        rebound_price REAL,
        reference_features_json TEXT,
        label_status TEXT NOT NULL DEFAULT 'WAITING_REFERENCE',
        return_3s REAL,
        return_5s REAL,
        return_10s REAL,
        return_30s REAL,
        mfe_3s REAL,
        mae_3s REAL,
        mfe_5s REAL,
        mae_5s REAL,
        mfe_10s REAL,
        mae_10s REAL,
        mfe_30s REAL,
        mae_30s REAL,
        record_created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_launch_quality_status
        ON launch_quality_observations(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_launch_quality_reference
        ON launch_quality_observations(rebound_at DESC)
        WHERE rebound_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS launch_quality_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL REFERENCES launch_quality_observations(mint) ON DELETE CASCADE,
        horizon_ms INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        last_trade_at INTEGER,
        observation_lag_ms INTEGER NOT NULL,
        price REAL,
        price_return_pct REAL,
        peak_return_pct REAL,
        drawdown_pct REAL,
        buyers INTEGER NOT NULL,
        recent_buyers INTEGER NOT NULL,
        new_buyers INTEGER NOT NULL,
        buy_tx INTEGER NOT NULL,
        sell_tx INTEGER NOT NULL,
        buy_sol REAL NOT NULL,
        sell_sol REAL NOT NULL,
        net_flow_sol REAL NOT NULL,
        top1_share_pct REAL,
        top3_share_pct REAL,
        retention_pct REAL,
        creator_share_pct REAL,
        sell_sol_since_peak REAL NOT NULL,
        buy_sol_since_peak REAL NOT NULL,
        sell_impact_pct_per_sol REAL,
        sell_depth_fraction_pct REAL,
        depth_adjusted_sell_impact REAL,
        sell_decay_ratio REAL,
        curve_pct REAL,
        virtual_sol_reserves REAL,
        created_at INTEGER NOT NULL,
        UNIQUE(mint, horizon_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_launch_quality_snapshots_horizon
        ON launch_quality_snapshots(horizon_ms, observed_at DESC);

      -- M2F-OBS is deliberately isolated from all position tables. These are
      -- small append-only observer tables; no ALTER is performed on the large
      -- historical trade tables during startup.
      CREATE TABLE IF NOT EXISTS migration_second_leg_observations (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        creator TEXT,
        migration_at INTEGER NOT NULL,
        migration_source TEXT,
        status TEXT NOT NULL DEFAULT 'OBSERVING',
        first_amm_trade_at INTEGER,
        baseline_price REAL,
        last_trade_at INTEGER,
        last_price REAL,
        peak_at INTEGER,
        peak_price REAL,
        max_return_pct REAL,
        first_pullback_at INTEGER,
        pullback_low_at INTEGER,
        pullback_low_price REAL,
        max_pullback_pct REAL,
        rebound_at INTEGER,
        snapshot_count INTEGER NOT NULL DEFAULT 0,
        boost_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        mayhem_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        cashback_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        canonical_pool_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        entity_cluster_status TEXT NOT NULL DEFAULT 'UNAVAILABLE',
        quote_reserve_status TEXT NOT NULL DEFAULT 'UNAVAILABLE',
        completed_at INTEGER,
        completion_reason TEXT,
        record_created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_m2f_observations_status
        ON migration_second_leg_observations(status, migration_at DESC);

      CREATE TABLE IF NOT EXISTS migration_second_leg_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL REFERENCES migration_second_leg_observations(mint) ON DELETE CASCADE,
        second_bucket INTEGER NOT NULL,
        age_ms INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        last_trade_at INTEGER,
        observation_lag_ms INTEGER,
        slot INTEGER,
        price REAL,
        baseline_price REAL,
        peak_price REAL,
        opening_impulse_pct REAL,
        pullback_pct REAL,
        pullback_duration_ms INTEGER,
        rebound_pct REAL,
        micro_high_break INTEGER NOT NULL DEFAULT 0,
        buy_sol_3s REAL,
        sell_sol_3s REAL,
        net_flow_3s REAL,
        buy_sol_10s REAL,
        sell_sol_10s REAL,
        net_flow_10s REAL,
        buy_sol_prev_20s REAL,
        sell_sol_prev_20s REAL,
        net_flow_prev_20s REAL,
        buyers_3s INTEGER,
        buyers_10s INTEGER,
        largest_buyer_share_10s_pct REAL,
        buy_speed_ratio REAL,
        net_flow_acceleration REAL,
        sell_deceleration_ratio REAL,
        observed_retained_buyers INTEGER,
        observed_exited_buyers INTEGER,
        observed_holder_diffusion_index INTEGER,
        quote_reserve_sol REAL,
        onfi_10_pct REAL,
        estimated_impact_005_pct REAL,
        estimated_impact_01_pct REAL,
        estimated_impact_025_pct REAL,
        boost_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        mayhem_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        cashback_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        canonical_pool_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        entity_cluster_status TEXT NOT NULL DEFAULT 'UNAVAILABLE',
        feature_completeness_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(mint, second_bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_m2f_snapshots_observed
        ON migration_second_leg_snapshots(observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_m2f_snapshots_mint_age
        ON migration_second_leg_snapshots(mint, age_ms);

      -- B-only M2F trading hypothesis. This stays isolated from the observer
      -- tables and avoids ALTER work on any large historical table.
      CREATE TABLE IF NOT EXISTS migration_second_leg_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        migration_at INTEGER NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        signal_age_ms INTEGER NOT NULL,
        features_json TEXT NOT NULL,
        rug_guard_json TEXT,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_price REAL,
        entry_jump_pct REAL,
        entry_impact_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        hard_stop_pct REAL NOT NULL,
        max_hold_ms INTEGER NOT NULL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_m2f_shadow_status
        ON migration_second_leg_shadow_positions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_m2f_shadow_mint_signal
        ON migration_second_leg_shadow_positions(mint, signal_at DESC);

      CREATE TABLE IF NOT EXISTS holder_growth_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        horizon_ms INTEGER NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        observation_lag_ms INTEGER NOT NULL,
        buyers INTEGER NOT NULL,
        new_buyers INTEGER NOT NULL,
        retention_pct REAL NOT NULL,
        net_flow_sol REAL NOT NULL,
        top3_share_pct REAL NOT NULL,
        curve_pct REAL,
        virtual_sol_reserves REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        trailing_activated_at INTEGER,
        exit_mode TEXT NOT NULL DEFAULT 'TRAILING',
        fixed_hold_ms INTEGER,
        hard_stop_pct REAL NOT NULL,
        trailing_activation_pct REAL NOT NULL,
        trailing_stop_pct REAL NOT NULL,
        trailing_tiers_json TEXT,
        trailing_tier_index INTEGER NOT NULL DEFAULT -1,
        stop_price REAL,
        scale_out_trigger_pct REAL,
        scale_out_fraction_pct REAL,
        partial_exit_target_at INTEGER,
        partial_exit_deadline_at INTEGER,
        scale_out_at INTEGER,
        scale_out_price REAL,
        flow_check_horizon_ms INTEGER,
        min_buyer_velocity_ratio REAL,
        min_net_flow_delta_sol REAL,
        flow_check_at INTEGER,
        flow_check_status TEXT,
        flow_buyer_velocity_ratio REAL,
        flow_net_flow_delta_sol REAL,
        max_hold_ms INTEGER NOT NULL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, mint)
      );
      CREATE INDEX IF NOT EXISTS idx_holder_growth_shadow_status
        ON holder_growth_shadow_positions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_holder_growth_shadow_signal
        ON holder_growth_shadow_positions(signal_at DESC, entry_profile_id);

      CREATE TABLE IF NOT EXISTS quality_leader_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        return_10_pct REAL,
        drawdown_20_pct REAL,
        buyers_10 INTEGER,
        buyers_20 INTEGER,
        buyer_delta INTEGER,
        net_flow_10_sol REAL,
        net_flow_20_sol REAL,
        net_flow_delta_sol REAL,
        retention_20_pct REAL,
        creator_share_20_pct REAL,
        curve_20_pct REAL,
        sell_buy_ratio_20 REAL,
        virtual_sol_20 REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        entry_impact_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        partial_stage INTEGER NOT NULL DEFAULT 0,
        pending_partial_stage INTEGER NOT NULL DEFAULT 0,
        partial_exit_target_at INTEGER,
        partial_exit_deadline_at INTEGER,
        scale1_at INTEGER,
        scale1_price REAL,
        scale2_at INTEGER,
        scale2_price REAL,
        graduated_at INTEGER,
        last_curve_price REAL,
        amm_price_scale REAL,
        exit_target_market TEXT,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, mint)
      );
      CREATE INDEX IF NOT EXISTS idx_quality_leader_shadow_status
        ON quality_leader_shadow_positions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_quality_leader_shadow_signal
        ON quality_leader_shadow_positions(signal_at DESC, entry_profile_id);

      CREATE TABLE IF NOT EXISTS graduation_acceleration_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        creator TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        signal_curve_pct REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        entry_impact_pct REAL,
        token_units REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        graduated_at INTEGER,
        core_weight_pct REAL NOT NULL,
        core_exit_at INTEGER,
        core_exit_price REAL,
        runner_highest_price REAL,
        runner_tier_index INTEGER NOT NULL DEFAULT -1,
        runner_stop_price REAL,
        exit_target_market TEXT,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_graduation_accel_status
        ON graduation_acceleration_shadow_positions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_graduation_accel_profile
        ON graduation_acceleration_shadow_positions(entry_profile_id, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_graduation_accel_mint
        ON graduation_acceleration_shadow_positions(mint, signal_at DESC);
    `);

    const graduationAccelerationColumns = new Set(
      this.db.prepare('PRAGMA table_info(graduation_acceleration_shadow_positions)')
        .all().map((column) => column.name),
    );
    if (!graduationAccelerationColumns.has('exit_impact_pct')) {
      this.db.exec(`ALTER TABLE graduation_acceleration_shadow_positions
        ADD COLUMN exit_impact_pct REAL`);
    }

    this._migrateLiveTradingSchema();

    const pullbackColumns = new Set(
      this.db.prepare('PRAGMA table_info(launch_pullback_shadow_positions)')
        .all().map((column) => column.name),
    );
    const pullbackMigrations = [
      [
        'reference_profile_id',
        "ALTER TABLE launch_pullback_shadow_positions ADD COLUMN reference_profile_id TEXT NOT NULL DEFAULT 'LEGACY_7_5_R3'",
      ],
      [
        'reference_rebound_pct',
        'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN reference_rebound_pct REAL',
      ],
      ['low_stable_ms', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN low_stable_ms INTEGER'],
      [
        'buyers_since_pullback_low',
        'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN buyers_since_pullback_low INTEGER',
      ],
      [
        'window_net_flow_sol',
        'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN window_net_flow_sol REAL',
      ],
      ['flow_window_ms', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN flow_window_ms INTEGER'],
      ['sell_sol_since_peak', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN sell_sol_since_peak REAL'],
      ['buy_sol_since_peak', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN buy_sol_since_peak REAL'],
      ['buy_refill_ratio', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN buy_refill_ratio REAL'],
      ['recent_net_flow_1s', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN recent_net_flow_1s REAL'],
      ['previous_net_flow_1s', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN previous_net_flow_1s REAL'],
      ['net_flow_acceleration_1s', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN net_flow_acceleration_1s REAL'],
      ['market_regime_observed_at', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN market_regime_observed_at INTEGER'],
      ['market_regime_independent_mints', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN market_regime_independent_mints INTEGER'],
      ['market_regime_average_net_return_5s', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN market_regime_average_net_return_5s REAL'],
      ['market_regime_win_rate_5s', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN market_regime_win_rate_5s REAL'],
      ['market_regime_big20_rate_5s', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN market_regime_big20_rate_5s REAL'],
      ['flow_confirmation_at', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN flow_confirmation_at INTEGER'],
      ['flow_confirmation_variant', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN flow_confirmation_variant TEXT'],
      ['flow_confirmation_buyers_w3', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN flow_confirmation_buyers_w3 INTEGER'],
      ['flow_confirmation_netflow_w3', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN flow_confirmation_netflow_w3 REAL'],
      ['flow_confirmation_window_ms', 'ALTER TABLE launch_pullback_shadow_positions ADD COLUMN flow_confirmation_window_ms INTEGER'],
    ];
    for (const [column, sql] of pullbackMigrations) {
      if (!pullbackColumns.has(column)) this.db.exec(sql);
    }

    const reboundColumns = new Set(
      this.db.prepare('PRAGMA table_info(migrated_drop_rebound_shadow_positions)')
        .all().map((column) => column.name),
    );
    if (!reboundColumns.has('lifecycle_stage')) {
      this.db.exec(`
        ALTER TABLE migrated_drop_rebound_shadow_positions
        ADD COLUMN lifecycle_stage TEXT NOT NULL DEFAULT 'POST_MIGRATION'
      `);
    }
    const reboundMigrations = [
      ['entry_impact_pct', 'REAL'],
      ['exit_impact_pct', 'REAL'],
      ['loss_check_recovery_pct', 'REAL'],
      ['core_weight_pct', 'REAL'],
      ['runner_hold_ms', 'INTEGER'],
      ['core_exit_target_at', 'INTEGER'],
      ['core_exit_at', 'INTEGER'],
      ['core_exit_price', 'REAL'],
      ['core_exit_reason', 'TEXT'],
      ['confirmation_json', 'TEXT'],
    ];
    for (const [column, definition] of reboundMigrations) {
      if (!reboundColumns.has(column)) {
        this.db.exec(`ALTER TABLE migrated_drop_rebound_shadow_positions ADD COLUMN ${column} ${definition}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_migrated_drop_rebound_lifecycle_profiles
      ON migrated_drop_rebound_shadow_positions(
        lifecycle_stage, entry_profile_id, exit_profile_id, rebound_at DESC
      )
    `);

    const holderGrowthColumns = new Set(
      this.db.prepare('PRAGMA table_info(holder_growth_shadow_positions)')
        .all().map((column) => column.name),
    );
    const holderGrowthMigrations = [
      ['exit_mode', "TEXT NOT NULL DEFAULT 'TRAILING'"],
      ['fixed_hold_ms', 'INTEGER'],
      ['trailing_tiers_json', 'TEXT'],
      ['trailing_tier_index', 'INTEGER NOT NULL DEFAULT -1'],
      ['stop_price', 'REAL'],
      ['scale_out_trigger_pct', 'REAL'],
      ['scale_out_fraction_pct', 'REAL'],
      ['partial_exit_target_at', 'INTEGER'],
      ['partial_exit_deadline_at', 'INTEGER'],
      ['scale_out_at', 'INTEGER'],
      ['scale_out_price', 'REAL'],
      ['flow_check_horizon_ms', 'INTEGER'],
      ['min_buyer_velocity_ratio', 'REAL'],
      ['min_net_flow_delta_sol', 'REAL'],
      ['flow_check_at', 'INTEGER'],
      ['flow_check_status', 'TEXT'],
      ['flow_buyer_velocity_ratio', 'REAL'],
      ['flow_net_flow_delta_sol', 'REAL'],
    ];
    for (const [column, definition] of holderGrowthMigrations) {
      if (!holderGrowthColumns.has(column)) {
        this.db.exec(`ALTER TABLE holder_growth_shadow_positions ADD COLUMN ${column} ${definition}`);
      }
    }

    const signalColumns = new Set(
      this.db.prepare('PRAGMA table_info(flow_signals)').all().map((column) => column.name),
    );
    const signalMigrations = [
      [
        'signal_variant',
        "ALTER TABLE flow_signals ADD COLUMN signal_variant TEXT NOT NULL DEFAULT 'primary_3w'",
      ],
      [
        'is_primary',
        'ALTER TABLE flow_signals ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 1',
      ],
      ['signal_episode_id', 'ALTER TABLE flow_signals ADD COLUMN signal_episode_id TEXT'],
      ['signal_rank_in_mint', 'ALTER TABLE flow_signals ADD COLUMN signal_rank_in_mint INTEGER'],
      [
        'previous_signal_gap_ms',
        'ALTER TABLE flow_signals ADD COLUMN previous_signal_gap_ms INTEGER',
      ],
    ];
    let signalEpisodeBackfillRequired = false;
    for (const [column, sql] of signalMigrations) {
      if (!signalColumns.has(column)) {
        this.db.exec(sql);
        if (['signal_episode_id', 'signal_rank_in_mint', 'previous_signal_gap_ms'].includes(column)) {
          signalEpisodeBackfillRequired = true;
        }
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_flow_signals_variant_ts
      ON flow_signals(signal_variant, timestamp_ms)
    `);
    // Historical window-function backfills are expensive on a large research
    // database. Run this only on the one startup that actually adds the episode
    // columns; all new signals populate these fields in recordSignal(). A normal
    // restart must never rescan and rewrite the full signal history.
    if (signalEpisodeBackfillRequired) {
      this.db.exec(`
        WITH gaps AS (
          SELECT signal_id, mint, signal_variant, timestamp_ms,
            ROW_NUMBER() OVER (
              PARTITION BY mint, signal_variant ORDER BY timestamp_ms, signal_id
            ) AS signal_rank,
            timestamp_ms - LAG(timestamp_ms) OVER (
              PARTITION BY mint, signal_variant ORDER BY timestamp_ms, signal_id
            ) AS signal_gap
          FROM flow_signals
        ), grouped AS (
          SELECT *, SUM(CASE WHEN signal_gap IS NULL OR signal_gap > 30000 THEN 1 ELSE 0 END)
            OVER (
              PARTITION BY mint, signal_variant ORDER BY timestamp_ms, signal_id
            ) AS episode_rank
          FROM gaps
        ), episodes AS (
          SELECT *, MIN(timestamp_ms) OVER (
            PARTITION BY mint, signal_variant, episode_rank
          ) AS episode_started_at
          FROM grouped
        )
        UPDATE flow_signals SET
          signal_rank_in_mint = (
            SELECT signal_rank FROM episodes WHERE episodes.signal_id = flow_signals.signal_id
          ),
          previous_signal_gap_ms = (
            SELECT signal_gap FROM episodes WHERE episodes.signal_id = flow_signals.signal_id
          ),
          signal_episode_id = mint || ':' || signal_variant || ':' || (
            SELECT episode_started_at FROM episodes WHERE episodes.signal_id = flow_signals.signal_id
          )
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_flow_signals_episode_id
      ON flow_signals(signal_episode_id) WHERE signal_episode_id IS NOT NULL
    `);

    const smartEventColumns = new Set(
      this.db.prepare('PRAGMA table_info(smart_wallet_events)').all()
        .map((column) => column.name),
    );
    const smartEventMigrations = [
      ['received_at_ms', 'ALTER TABLE smart_wallet_events ADD COLUMN received_at_ms INTEGER'],
      ['market', 'ALTER TABLE smart_wallet_events ADD COLUMN market TEXT'],
      ['token_amount', 'ALTER TABLE smart_wallet_events ADD COLUMN token_amount REAL'],
      ['position_phase', 'ALTER TABLE smart_wallet_events ADD COLUMN position_phase TEXT'],
      [
        'token_balance_before',
        'ALTER TABLE smart_wallet_events ADD COLUMN token_balance_before REAL',
      ],
      [
        'token_balance_after',
        'ALTER TABLE smart_wallet_events ADD COLUMN token_balance_after REAL',
      ],
    ];
    let smartEventBackfillRequired = false;
    let smartPositionBackfillRequired = false;
    for (const [column, sql] of smartEventMigrations) {
      if (!smartEventColumns.has(column)) {
        this.db.exec(sql);
        if (['received_at_ms', 'market', 'token_amount'].includes(column)) {
          smartEventBackfillRequired = true;
        }
        if (['position_phase', 'token_balance_before', 'token_balance_after'].includes(column)) {
          smartPositionBackfillRequired = true;
        }
      }
    }
    const liveOrderColumns = new Set(
      this.db.prepare('PRAGMA table_info(live_orders)').all().map((column) => column.name),
    );
    if (!liveOrderColumns.has('execution_json')) {
      this.db.exec('ALTER TABLE live_orders ADD COLUMN execution_json TEXT');
    }
    // The legacy lookup touches raw_trades. It is a one-time schema migration,
    // not startup maintenance, so never repeat it after the columns exist.
    if (smartEventBackfillRequired) {
      this.db.exec(`
        UPDATE smart_wallet_events AS event SET
          received_at_ms = COALESCE(received_at_ms, (
            SELECT trade.received_at_ms FROM raw_trades AS trade
            WHERE trade.signature = event.signature
              AND trade.event_index = event.event_index
              AND trade.mint = event.mint
              AND trade.wallet = event.wallet
            ORDER BY trade.id LIMIT 1
          ), timestamp_ms),
          market = COALESCE(market, (
            SELECT trade.market FROM raw_trades AS trade
            WHERE trade.signature = event.signature
              AND trade.event_index = event.event_index
              AND trade.mint = event.mint
              AND trade.wallet = event.wallet
            ORDER BY trade.id LIMIT 1
          )),
          token_amount = COALESCE(token_amount, (
            SELECT trade.token_amount FROM raw_trades AS trade
            WHERE trade.signature = event.signature
              AND trade.event_index = event.event_index
              AND trade.mint = event.mint
              AND trade.wallet = event.wallet
            ORDER BY trade.id LIMIT 1
          ))
        WHERE received_at_ms IS NULL OR market IS NULL OR token_amount IS NULL
      `);
    }
    const needsSmartPositionRebuild = smartPositionBackfillRequired && this.db.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM smart_wallet_events
        WHERE token_balance_before IS NULL OR token_balance_after IS NULL
        LIMIT 1
      ) AS needed
    `).get().needed === 1;
    const smartRows = needsSmartPositionRebuild ? this.db.prepare(`
      SELECT id, wallet, mint, side, token_amount, timestamp_ms
      FROM smart_wallet_events
      ORDER BY wallet, mint, timestamp_ms, id
    `).all() : [];
    const updateSmartPhase = this.db.prepare(`
      UPDATE smart_wallet_events SET
        position_phase = ?, token_balance_before = ?, token_balance_after = ?
      WHERE id = ?
    `);
    const upsertSmartPosition = this.db.prepare(`
      INSERT INTO smart_wallet_positions (wallet, mint, token_balance, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(wallet, mint) DO UPDATE SET
        token_balance = excluded.token_balance,
        updated_at = excluded.updated_at
    `);
    const rebuildSmartPositions = this.db.transaction(() => {
      this.db.prepare('DELETE FROM smart_wallet_positions').run();
      const balances = new Map();
      for (const event of smartRows) {
        const key = `${event.wallet}:${event.mint}`;
        const before = balances.get(key) || 0;
        const amount = Math.max(0, Number(event.token_amount) || 0);
        let after = before;
        let phase;
        if (event.side === 'BUY') {
          phase = before > 0 ? 'ADD' : 'OPEN';
          after = before + amount;
        } else if (before <= 0) {
          phase = 'SELL';
          after = 0;
        } else {
          after = Math.max(0, before - amount);
          const dust = Math.max(1e-9, before * 0.005);
          phase = after <= dust ? 'CLOSE' : 'REDUCE';
          if (phase === 'CLOSE') after = 0;
        }
        balances.set(key, after);
        updateSmartPhase.run(phase, before, after, event.id);
        upsertSmartPosition.run(event.wallet, event.mint, after, event.timestamp_ms);
      }
    });
    if (needsSmartPositionRebuild) rebuildSmartPositions();
    if (smartPositionBackfillRequired) {
      this.db.exec(`
        INSERT OR IGNORE INTO smart_wallet_positions (wallet, mint, token_balance, updated_at)
        SELECT event.wallet, event.mint, COALESCE(event.token_balance_after, 0), event.timestamp_ms
        FROM smart_wallet_events AS event
        WHERE event.id = (
          SELECT latest.id FROM smart_wallet_events AS latest
          WHERE latest.wallet = event.wallet AND latest.mint = event.mint
          ORDER BY latest.timestamp_ms DESC, latest.id DESC LIMIT 1
        )
      `);
      this.db.exec(`
        DELETE FROM smart_signal_confirmations
        WHERE smart_event_id IN (
          SELECT id FROM smart_wallet_events WHERE position_phase != 'OPEN'
        );
        INSERT OR IGNORE INTO smart_signal_confirmations (
          signal_id, smart_event_id, wallet, mint, open_timestamp_ms, delay_ms, open_sol
        )
        SELECT nearest_flow_signal, id, wallet, mint, timestamp_ms,
          time_from_flow_signal_ms, sol_amount
        FROM smart_wallet_events
        WHERE position_phase = 'OPEN'
          AND nearest_flow_signal IS NOT NULL
          AND time_from_flow_signal_ms BETWEEN 0 AND 30000
      `);
    }

    const returnColumns = new Set(
      this.db.prepare('PRAGMA table_info(signal_returns)').all().map((column) => column.name),
    );
    const returnMigrations = [
      ['cost_model_json', 'ALTER TABLE signal_returns ADD COLUMN cost_model_json TEXT'],
      [
        'label_status',
        "ALTER TABLE signal_returns ADD COLUMN label_status TEXT NOT NULL DEFAULT 'PENDING'",
      ],
      ['censor_reason', 'ALTER TABLE signal_returns ADD COLUMN censor_reason TEXT'],
      [
        'missing_horizons_json',
        'ALTER TABLE signal_returns ADD COLUMN missing_horizons_json TEXT',
      ],
      [
        'horizon_observation_lags_json',
        'ALTER TABLE signal_returns ADD COLUMN horizon_observation_lags_json TEXT',
      ],
    ];
    let returnLabelBackfillRequired = false;
    for (const [column, sql] of returnMigrations) {
      if (!returnColumns.has(column)) {
        this.db.exec(sql);
        if (['label_status', 'censor_reason', 'missing_horizons_json'].includes(column)) {
          returnLabelBackfillRequired = true;
        }
      }
    }
    if (returnLabelBackfillRequired) {
      this.db.exec(`
        UPDATE signal_returns SET
          label_status = CASE
            WHEN return_1s IS NOT NULL AND return_2s IS NOT NULL
              AND return_3s IS NOT NULL AND return_5s IS NOT NULL
              AND return_8s IS NOT NULL AND return_10s IS NOT NULL
              AND return_15s IS NOT NULL AND return_20s IS NOT NULL
              AND return_30s IS NOT NULL AND return_60s IS NOT NULL
              THEN 'COMPLETE'
            ELSE 'RIGHT_CENSORED'
          END,
          censor_reason = CASE
            WHEN return_1s IS NOT NULL AND return_2s IS NOT NULL
              AND return_3s IS NOT NULL AND return_5s IS NOT NULL
              AND return_8s IS NOT NULL AND return_10s IS NOT NULL
              AND return_15s IS NOT NULL AND return_20s IS NOT NULL
              AND return_30s IS NOT NULL AND return_60s IS NOT NULL
              THEN NULL
            ELSE COALESCE(censor_reason, 'LEGACY_MISSING_HORIZON')
          END,
          missing_horizons_json = CASE
            WHEN return_1s IS NOT NULL AND return_2s IS NOT NULL
              AND return_3s IS NOT NULL AND return_5s IS NOT NULL
              AND return_8s IS NOT NULL AND return_10s IS NOT NULL
              AND return_15s IS NOT NULL AND return_20s IS NOT NULL
              AND return_30s IS NOT NULL AND return_60s IS NOT NULL
              THEN '[]'
            ELSE '[' || rtrim(
              CASE WHEN return_1s IS NULL THEN '1,' ELSE '' END
              || CASE WHEN return_2s IS NULL THEN '2,' ELSE '' END
              || CASE WHEN return_3s IS NULL THEN '3,' ELSE '' END
              || CASE WHEN return_5s IS NULL THEN '5,' ELSE '' END
              || CASE WHEN return_8s IS NULL THEN '8,' ELSE '' END
              || CASE WHEN return_10s IS NULL THEN '10,' ELSE '' END
              || CASE WHEN return_15s IS NULL THEN '15,' ELSE '' END
              || CASE WHEN return_20s IS NULL THEN '20,' ELSE '' END
              || CASE WHEN return_30s IS NULL THEN '30,' ELSE '' END
              || CASE WHEN return_60s IS NULL THEN '60,' ELSE '' END,
              ','
            ) || ']'
          END
        WHERE finalized_at IS NOT NULL
      `);
    }
  }

  _migrateLiveTradingSchema() {
    const positionColumns = this.db.prepare('PRAGMA table_info(live_positions)').all();
    const orderColumns = this.db.prepare('PRAGMA table_info(live_orders)').all();
    const positionByName = new Map(positionColumns.map((column) => [column.name, column]));
    const orderByName = new Map(orderColumns.map((column) => [column.name, column]));
    const needsRebuild = !positionByName.has('primary_decision_id')
      || !positionByName.has('source_type')
      || !positionByName.has('signal_id')
      || Number(positionByName.get('decision_id')?.notnull) === 1
      || Number(positionByName.get('trigger_wallet')?.notnull) === 1
      || !orderByName.has('primary_decision_id')
      || Number(orderByName.get('decision_id')?.notnull) === 1;
    if (!needsRebuild) {
      if (!positionByName.has('strategy_decision_id')) {
        this.db.exec(`ALTER TABLE live_positions
          ADD COLUMN strategy_decision_id INTEGER REFERENCES live_strategy_decisions(id)`);
      }
      if (!positionByName.has('strategy_id')) {
        this.db.exec('ALTER TABLE live_positions ADD COLUMN strategy_id TEXT');
      }
      if (!orderByName.has('strategy_decision_id')) {
        this.db.exec(`ALTER TABLE live_orders
          ADD COLUMN strategy_decision_id INTEGER REFERENCES live_strategy_decisions(id)`);
      }
      if (!orderByName.has('strategy_id')) {
        this.db.exec('ALTER TABLE live_orders ADD COLUMN strategy_id TEXT');
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_live_positions_strategy
          ON live_positions(strategy_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_live_positions_strategy_mint
          ON live_positions(strategy_id, mint, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_live_orders_strategy
          ON live_orders(strategy_id, created_at DESC);
      `);
      this._ensureLiveSettlementColumns();
      this._ensureLivePositionIndexes();
      return;
    }

    const executionExpression = orderByName.has('execution_json') ? 'execution_json' : 'NULL';
    const foreignKeys = Number(this.db.pragma('foreign_keys', { simple: true })) === 1;
    if (foreignKeys) this.db.pragma('foreign_keys = OFF');
    try {
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE live_orders RENAME TO live_orders_legacy_primary_migration;
          ALTER TABLE live_positions RENAME TO live_positions_legacy_primary_migration;

          CREATE TABLE live_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            decision_id INTEGER REFERENCES smart_open_decisions(id),
            primary_decision_id INTEGER REFERENCES primary_live_decisions(id),
            strategy_decision_id INTEGER REFERENCES live_strategy_decisions(id),
            strategy_id TEXT,
            source_type TEXT NOT NULL DEFAULT 'PRIMARY_SIGNAL',
            signal_id INTEGER REFERENCES flow_signals(signal_id),
            mint TEXT NOT NULL,
            trigger_wallet TEXT,
            mode TEXT NOT NULL,
            status TEXT NOT NULL,
            position_sol REAL NOT NULL,
            token_amount_raw TEXT,
            entry_market TEXT,
            entry_price REAL,
            entry_signature TEXT,
            entry_error TEXT,
            highest_price REAL,
            exit_market TEXT,
            exit_price REAL,
            exit_signature TEXT,
            exit_reason TEXT,
            exit_error TEXT,
            opened_at INTEGER,
            exit_requested_at INTEGER,
            closed_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO live_positions (
            id, decision_id, source_type, mint, trigger_wallet, mode, status,
            position_sol, token_amount_raw, entry_market, entry_price, entry_signature,
            entry_error, highest_price, exit_market, exit_price, exit_signature,
            exit_reason, exit_error, opened_at, exit_requested_at, closed_at,
            created_at, updated_at
          ) SELECT
            id, decision_id, 'SMART_OPEN', mint, trigger_wallet, mode, status,
            position_sol, token_amount_raw, entry_market, entry_price, entry_signature,
            entry_error, highest_price, exit_market, exit_price, exit_signature,
            exit_reason, exit_error, opened_at, exit_requested_at, closed_at,
            created_at, updated_at
          FROM live_positions_legacy_primary_migration;

          CREATE TABLE live_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            position_id INTEGER NOT NULL REFERENCES live_positions(id),
            decision_id INTEGER REFERENCES smart_open_decisions(id),
            primary_decision_id INTEGER REFERENCES primary_live_decisions(id),
            strategy_decision_id INTEGER REFERENCES live_strategy_decisions(id),
            strategy_id TEXT,
            mint TEXT NOT NULL,
            side TEXT NOT NULL,
            venue TEXT,
            attempt INTEGER NOT NULL,
            requested_sol REAL,
            requested_token_raw TEXT,
            status TEXT NOT NULL,
            signature TEXT,
            error TEXT,
            execution_json TEXT,
            submitted_at INTEGER,
            confirmed_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO live_orders (
            id, position_id, decision_id, mint, side, venue, attempt,
            requested_sol, requested_token_raw, status, signature, error,
            execution_json, submitted_at, confirmed_at, created_at, updated_at
          ) SELECT
            id, position_id, decision_id, mint, side, venue, attempt,
            requested_sol, requested_token_raw, status, signature, error,
            ${executionExpression}, submitted_at, confirmed_at, created_at, updated_at
          FROM live_orders_legacy_primary_migration;

          DROP TABLE live_orders_legacy_primary_migration;
          DROP TABLE live_positions_legacy_primary_migration;
          CREATE INDEX idx_live_positions_status
            ON live_positions(status, updated_at);
          CREATE INDEX idx_live_positions_active_mint
            ON live_positions(mint, status, updated_at)
            WHERE status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED');
          CREATE INDEX idx_live_orders_position ON live_orders(position_id, id);
          CREATE INDEX idx_live_orders_created_id
            ON live_orders(created_at DESC, id DESC);
          CREATE INDEX idx_live_positions_strategy
            ON live_positions(strategy_id, updated_at DESC);
          CREATE INDEX idx_live_positions_strategy_mint
            ON live_positions(strategy_id, mint, created_at DESC);
          CREATE INDEX idx_live_orders_strategy
            ON live_orders(strategy_id, created_at DESC);
        `);
      })();
    } finally {
      if (foreignKeys) this.db.pragma('foreign_keys = ON');
    }
    const violations = this.db.pragma('foreign_key_check');
    if (violations.length > 0) {
      throw new Error(`Live trading schema migration has ${violations.length} FK violation(s)`);
    }
    this._ensureLiveSettlementColumns();
    this._ensureLivePositionIndexes();
  }

  _ensureLivePositionIndexes() {
    // Older releases enforced one active row per Mint in SQLite. Live position
    // lots are now isolated by position id, while the configurable per-Mint
    // limit is enforced atomically by LiveTradingManager's entry queue.
    this.db.exec(`
      DROP INDEX IF EXISTS idx_live_positions_one_active_mint;
      CREATE INDEX IF NOT EXISTS idx_live_positions_active_mint
        ON live_positions(mint, status, updated_at)
        WHERE status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED');
    `);
  }

  _ensureLiveSettlementColumns() {
    const ensure = (table, name, definition) => {
      const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all()
        .map((column) => column.name));
      if (!columns.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    };
    ensure('live_positions', 'entry_sol_delta', 'REAL');
    ensure('live_positions', 'exit_sol_delta', 'REAL');
    ensure('live_positions', 'realized_pnl_sol', 'REAL');
    ensure('live_positions', 'realized_return_pct', 'REAL');
    ensure('live_orders', 'wallet_sol_delta', 'REAL');
    ensure('live_orders', 'network_fee_sol', 'REAL');
  }

  _prepare() {
    this.stmts = {
      allTokens: this.db.prepare('SELECT * FROM flow_tokens'),
      getToken: this.db.prepare('SELECT * FROM flow_tokens WHERE mint = ?'),
      getTokenByPool: this.db.prepare('SELECT * FROM flow_tokens WHERE migration_pool = ? LIMIT 1'),
      ensureToken: this.db.prepare(`
        INSERT INTO flow_tokens (mint, bonding_curve, updated_at)
        VALUES (@mint, @bondingCurve, @updatedAt)
        ON CONFLICT(mint) DO UPDATE SET
          bonding_curve = COALESCE(flow_tokens.bonding_curve, excluded.bonding_curve),
          updated_at = excluded.updated_at
      `),
      upsertCreate: this.db.prepare(`
        INSERT INTO flow_tokens (
          mint, symbol, name, uri, bonding_curve, creator, created_at,
          initial_real_token_reserves_raw, token_total_supply_raw, updated_at
        ) VALUES (
          @mint, @symbol, @name, @uri, @bondingCurve, @creator, @createdAt,
          @initialRealTokenReservesRaw, @tokenTotalSupplyRaw, @updatedAt
        )
        ON CONFLICT(mint) DO UPDATE SET
          symbol = COALESCE(excluded.symbol, flow_tokens.symbol),
          name = COALESCE(excluded.name, flow_tokens.name),
          uri = COALESCE(excluded.uri, flow_tokens.uri),
          bonding_curve = COALESCE(excluded.bonding_curve, flow_tokens.bonding_curve),
          creator = COALESCE(excluded.creator, flow_tokens.creator),
          created_at = COALESCE(excluded.created_at, flow_tokens.created_at),
          initial_real_token_reserves_raw = COALESCE(
            excluded.initial_real_token_reserves_raw,
            flow_tokens.initial_real_token_reserves_raw
          ),
          token_total_supply_raw = COALESCE(excluded.token_total_supply_raw, flow_tokens.token_total_supply_raw),
          updated_at = excluded.updated_at
      `),
      markComplete: this.db.prepare(`
        UPDATE flow_tokens SET
          graduated_at = COALESCE(graduated_at, @graduatedAt),
          bonding_curve = COALESCE(bonding_curve, @bondingCurve),
          updated_at = @updatedAt
        WHERE mint = @mint
      `),
      markMigration: this.db.prepare(`
        UPDATE flow_tokens SET
          graduated_at = COALESCE(graduated_at, @migratedAt),
          migration_pool = COALESCE(@pool, migration_pool),
          bonding_curve = COALESCE(bonding_curve, @bondingCurve),
          updated_at = @updatedAt
        WHERE mint = @mint
      `),
      insertRawTrade: this.db.prepare(`
        INSERT OR IGNORE INTO raw_trades (
          timestamp_ms, chain_timestamp_ms, received_at_ms, slot, signature, event_index,
          market, mint, bonding_curve, wallet, side, sol_amount, token_amount, price,
          reserve_price, curve_pct, virtual_sol_reserves_raw, virtual_token_reserves_raw,
          real_sol_reserves_raw, real_token_reserves_raw
        ) VALUES (
          @timestampMs, @chainTimestampMs, @receivedAtMs, @slot, @signature, @eventIndex,
          @market, @mint, @bondingCurve, @wallet, @side, @solAmount, @tokenAmount, @price,
          @reservePrice, @curvePct, @virtualSolReservesRaw, @virtualTokenReservesRaw,
          @realSolReservesRaw, @realTokenReservesRaw
        )
      `),
      updateTokenTrade: this.db.prepare(`
        UPDATE flow_tokens SET
          last_real_token_reserves_raw = COALESCE(@realTokenReservesRaw, last_real_token_reserves_raw),
          curve_pct = COALESCE(@curvePct, curve_pct),
          last_price = @price,
          last_trade_at = @timestampMs,
          updated_at = @timestampMs
        WHERE mint = @mint
      `),
      insertSignal: this.db.prepare(`
        INSERT INTO flow_signals (
          timestamp_ms, slot, signature, mint, symbol, age_ms, curve_pct, p0,
          buy_flow_w1, buy_flow_w2, buy_flow_w3,
          sell_flow_w1, sell_flow_w2, sell_flow_w3,
          netflow_w1, netflow_w2, netflow_w3,
          delta_netflow_12, delta_netflow_23,
          unique_buyers_w1, unique_buyers_w2, unique_buyers_w3,
          buy_tx_w1, buy_tx_w2, buy_tx_w3,
          flow_accel_1, flow_accel_2, flow_accel,
          signal_variant, is_primary, signal_episode_id, signal_rank_in_mint,
          previous_signal_gap_ms, created_at
        ) VALUES (
          @timestampMs, @slot, @signature, @mint, @symbol, @ageMs, @curvePct, @price,
          @buyFlowW1, @buyFlowW2, @buyFlowW3,
          @sellFlowW1, @sellFlowW2, @sellFlowW3,
          @netFlowW1, @netFlowW2, @netFlowW3,
          @deltaNetFlow12, @deltaNetFlow23,
          @uniqueBuyersW1, @uniqueBuyersW2, @uniqueBuyersW3,
          @buyTxW1, @buyTxW2, @buyTxW3,
          @flowAccel1, @flowAccel2, @flowAccel,
          @signalVariant, @isPrimary, @signalEpisodeId, @signalRankInMint,
          @previousSignalGapMs, @createdAt
        )
      `),
      latestSignalEpisode: this.db.prepare(`
        SELECT signal_id, timestamp_ms, signal_rank_in_mint, signal_episode_id
        FROM flow_signals
        WHERE mint = ? AND signal_variant = ?
        ORDER BY timestamp_ms DESC, signal_id DESC
        LIMIT 1
      `),
      insertReturn: this.db.prepare(`
        INSERT INTO signal_returns (
          signal_id, p0, configured_cost_pct, cost_model_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `),
      recentPendingSignals: this.db.prepare(`
        SELECT s.*, r.*
        FROM flow_signals s
        JOIN signal_returns r USING(signal_id)
        WHERE r.finalized_at IS NULL AND s.timestamp_ms >= ?
        ORDER BY s.timestamp_ms
      `),
      labelSamples: this.db.prepare(`
        SELECT timestamp_ms, price
        FROM raw_trades
        WHERE mint = ? AND timestamp_ms >= ? AND timestamp_ms <= ? AND price > 0
        ORDER BY timestamp_ms, id
      `),
      nearestSignal: this.db.prepare(`
        SELECT signal_id, timestamp_ms
        FROM flow_signals
        WHERE mint = ? AND timestamp_ms <= ? AND timestamp_ms >= ? AND is_primary = 1
        ORDER BY timestamp_ms DESC
        LIMIT 1
      `),
      flowSignalById: this.db.prepare(`
        SELECT * FROM flow_signals WHERE signal_id = ?
      `),
      recentCurveTrades: this.db.prepare(`
        SELECT timestamp_ms AS timestampMs, received_at_ms AS receivedAtMs,
          market, mint, wallet, side, sol_amount AS solAmount,
          token_amount AS tokenAmount, price, reserve_price AS reservePrice,
          curve_pct AS curvePct, virtual_sol_reserves_raw AS virtualSolReservesRaw
        FROM raw_trades
        WHERE market = 'PUMP_BONDING_CURVE' AND timestamp_ms >= ?
        ORDER BY timestamp_ms, id
      `),
      launchMarketRegimeSnapshot: this.db.prepare(`
        SELECT
          COUNT(DISTINCT f.mint) AS independent_mints,
          AVG(r.net_return_5s) AS average_net_return_5s,
          AVG(CASE WHEN r.net_return_5s > 0 THEN 100.0 ELSE 0.0 END) AS win_rate_5s,
          AVG(CASE WHEN r.net_return_5s >= 20 THEN 100.0 ELSE 0.0 END) AS big20_rate_5s
        FROM flow_signals AS f
        JOIN signal_returns AS r USING(signal_id)
        WHERE f.is_primary = 1
          AND f.signal_rank_in_mint = 1
          AND f.timestamp_ms >= @startAt
          AND f.timestamp_ms < @cutoffAt
          AND r.finalized_at IS NOT NULL
          AND r.finalized_at <= @observedAt
          AND r.net_return_5s IS NOT NULL
      `),
      recentAmmTrades: this.db.prepare(`
        SELECT timestamp_ms AS timestampMs, received_at_ms AS receivedAtMs,
          slot, signature, event_index AS eventIndex,
          market, mint, wallet, side, sol_amount AS solAmount,
          token_amount AS tokenAmount, price, reserve_price AS reservePrice,
          curve_pct AS curvePct
        FROM raw_trades
        WHERE market = 'PUMP_AMM' AND timestamp_ms >= ?
        ORDER BY timestamp_ms, id
      `),
      smartWalletPosition: this.db.prepare(`
        SELECT token_balance
        FROM smart_wallet_positions
        WHERE wallet = ? AND mint = ?
      `),
      upsertSmartWalletPosition: this.db.prepare(`
        INSERT INTO smart_wallet_positions (wallet, mint, token_balance, updated_at)
        VALUES (@wallet, @mint, @tokenBalance, @updatedAt)
        ON CONFLICT(wallet, mint) DO UPDATE SET
          token_balance = excluded.token_balance,
          updated_at = excluded.updated_at
      `),
      insertSmartWallet: this.db.prepare(`
        INSERT OR IGNORE INTO smart_wallet_events (
          timestamp_ms, received_at_ms, slot, signature, event_index, wallet, mint, side, market,
          sol_amount, token_amount, price, curve_pct, age_ms, position_phase,
          token_balance_before, token_balance_after, nearest_flow_signal, time_from_flow_signal_ms
        ) VALUES (
          @timestampMs, @receivedAtMs, @slot, @signature, @eventIndex, @wallet, @mint, @side, @market,
          @solAmount, @tokenAmount, @price, @curvePct, @ageMs, @positionPhase,
          @tokenBalanceBefore, @tokenBalanceAfter, @nearestFlowSignal, @timeFromFlowSignalMs
        )
      `),
      insertSmartSignalConfirmation: this.db.prepare(`
        INSERT OR IGNORE INTO smart_signal_confirmations (
          signal_id, smart_event_id, wallet, mint, open_timestamp_ms, delay_ms, open_sol
        ) VALUES (
          @signalId, @smartEventId, @wallet, @mint, @openTimestampMs, @delayMs, @openSol
        )
      `),
      insertSmartOpenDecision: this.db.prepare(`
        INSERT OR IGNORE INTO smart_open_decisions (
          smart_event_id, timestamp_ms, received_at_ms, wallet, mint, rule_version,
          market, position_phase, smart_sol, smart_price, prebuy_window_ms,
          prebuy_buyers, prebuy_buy_tx, prebuy_buy_flow_sol, prebuy_sell_flow_sol,
          prebuy_net_flow_sol, event_age_ms, rule_matched, rejection_reasons_json,
          mode, action_status, action_reason, created_at, updated_at
        ) VALUES (
          @smartEventId, @timestampMs, @receivedAtMs, @wallet, @mint, @ruleVersion,
          @market, @positionPhase, @smartSol, @smartPrice, @preBuyWindowMs,
          @preBuyers, @preBuyTx, @preBuyFlowSol, @preSellFlowSol,
          @preNetFlowSol, @eventAgeMs, @ruleMatched, @rejectionReasonsJson,
          @mode, @actionStatus, @actionReason, @createdAt, @updatedAt
        )
      `),
      getSmartOpenDecisionByEvent: this.db.prepare(`
        SELECT * FROM smart_open_decisions WHERE smart_event_id = ?
      `),
      updateSmartOpenDecision: this.db.prepare(`
        UPDATE smart_open_decisions SET
          action_status = @actionStatus,
          action_reason = @actionReason,
          updated_at = @updatedAt
        WHERE id = @id
      `),
      insertPrimaryLiveDecision: this.db.prepare(`
        INSERT OR IGNORE INTO primary_live_decisions (
          signal_id, signal_episode_id, timestamp_ms, received_at_ms, mint, symbol,
          rule_version, signal_variant, netflow_w3, unique_buyers_w3, signal_price,
          signal_age_ms, rule_matched, rejection_reasons_json, mode,
          action_status, action_reason, created_at, updated_at
        ) VALUES (
          @signalId, @signalEpisodeId, @timestampMs, @receivedAtMs, @mint, @symbol,
          @ruleVersion, @signalVariant, @netFlowW3, @uniqueBuyersW3, @signalPrice,
          @signalAgeMs, @ruleMatched, @rejectionReasonsJson, @mode,
          @actionStatus, @actionReason, @createdAt, @updatedAt
        )
      `),
      getPrimaryLiveDecisionBySignal: this.db.prepare(`
        SELECT * FROM primary_live_decisions WHERE signal_id = ?
      `),
      getPrimaryLiveDecisionByEpisode: this.db.prepare(`
        SELECT * FROM primary_live_decisions WHERE signal_episode_id = ?
      `),
      updatePrimaryLiveDecision: this.db.prepare(`
        UPDATE primary_live_decisions SET
          action_status = @actionStatus,
          action_reason = @actionReason,
          updated_at = @updatedAt
        WHERE id = @id
      `),
      insertLiveStrategyDecision: this.db.prepare(`
        INSERT OR IGNORE INTO live_strategy_decisions (
          strategy_id, episode_id, timestamp_ms, received_at_ms, mint, symbol,
          rule_version, market, reference_price, features_json, rule_matched,
          rejection_reasons_json, mode, action_status, action_reason, created_at, updated_at
        ) VALUES (
          @strategyId, @episodeId, @timestampMs, @receivedAtMs, @mint, @symbol,
          @ruleVersion, @market, @referencePrice, @featuresJson, @ruleMatched,
          @rejectionReasonsJson, @mode, @actionStatus, @actionReason, @createdAt, @updatedAt
        )
      `),
      getLiveStrategyDecision: this.db.prepare(`
        SELECT * FROM live_strategy_decisions WHERE strategy_id = ? AND episode_id = ?
      `),
      liveStrategyDecisionCountForMintStrategy: this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM live_strategy_decisions
        WHERE mint = ? AND strategy_id = ? AND rule_matched = 1
      `),
      updateLiveStrategyDecision: this.db.prepare(`
        UPDATE live_strategy_decisions SET
          action_status = @actionStatus,
          action_reason = @actionReason,
          updated_at = @updatedAt
        WHERE id = @id
      `),
      insertLivePosition: this.db.prepare(`
        INSERT INTO live_positions (
          decision_id, primary_decision_id, strategy_decision_id, strategy_id,
          source_type, signal_id,
          mint, trigger_wallet, mode, status, position_sol,
          entry_market, entry_price, highest_price, created_at, updated_at
        ) VALUES (
          @decisionId, @primaryDecisionId, @strategyDecisionId, @strategyId,
          @sourceType, @signalId,
          @mint, @triggerWallet, @mode, @status, @positionSol,
          @entryMarket, @entryPrice, @highestPrice, @createdAt, @updatedAt
        )
      `),
      updateLivePosition: this.db.prepare(`
        UPDATE live_positions SET
          status = COALESCE(@status, status),
          token_amount_raw = COALESCE(@tokenAmountRaw, token_amount_raw),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_signature = COALESCE(@entrySignature, entry_signature),
          entry_error = @entryError,
          entry_sol_delta = COALESCE(@entrySolDelta, entry_sol_delta),
          highest_price = COALESCE(@highestPrice, highest_price),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_signature = COALESCE(@exitSignature, exit_signature),
          exit_reason = COALESCE(@exitReason, exit_reason),
          exit_error = @exitError,
          exit_sol_delta = COALESCE(@exitSolDelta, exit_sol_delta),
          realized_pnl_sol = COALESCE(@realizedPnlSol, realized_pnl_sol),
          realized_return_pct = COALESCE(@realizedReturnPct, realized_return_pct),
          opened_at = COALESCE(@openedAt, opened_at),
          exit_requested_at = COALESCE(@exitRequestedAt, exit_requested_at),
          closed_at = COALESCE(@closedAt, closed_at),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeLivePositions: this.db.prepare(`
        SELECT * FROM live_positions
        WHERE status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED')
        ORDER BY created_at
      `),
      confirmedEmptyLivePositions: this.db.prepare(`
        SELECT * FROM live_positions
        WHERE mode = 'LIVE'
          AND status = 'CLOSED'
          AND exit_reason = 'ENTRY_CONFIRMED_EMPTY'
          AND entry_signature IS NOT NULL
        ORDER BY created_at
      `),
      lastLivePositionForMint: this.db.prepare(`
        SELECT * FROM live_positions WHERE mint = ? ORDER BY created_at DESC LIMIT 1
      `),
      successfulLiveEntryCountForMintStrategy: this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM live_positions
        WHERE mint = ?
          AND strategy_id = ?
          AND status <> 'ENTRY_FAILED'
          AND (
            opened_at IS NOT NULL
            OR status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED')
          )
      `),
      lastSuccessfulLivePositionForMintStrategy: this.db.prepare(`
        SELECT *
        FROM live_positions
        WHERE mint = ?
          AND strategy_id = ?
          AND status <> 'ENTRY_FAILED'
          AND (
            opened_at IS NOT NULL
            OR status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED')
          )
        ORDER BY COALESCE(closed_at, updated_at, created_at) DESC, id DESC
        LIMIT 1
      `),
      insertLiveOrder: this.db.prepare(`
        INSERT INTO live_orders (
          position_id, decision_id, primary_decision_id, strategy_decision_id, strategy_id,
          mint, side, venue, attempt,
          requested_sol, requested_token_raw, status, signature, error,
          wallet_sol_delta, network_fee_sol, execution_json,
          submitted_at, confirmed_at, created_at, updated_at
        ) VALUES (
          @positionId, @decisionId, @primaryDecisionId, @strategyDecisionId, @strategyId,
          @mint, @side, @venue, @attempt,
          @requestedSol, @requestedTokenRaw, @status, @signature, @error,
          @walletSolDelta, @networkFeeSol, @executionJson,
          @submittedAt, @confirmedAt, @createdAt, @updatedAt
        )
      `),
      updateLiveOrder: this.db.prepare(`
        UPDATE live_orders SET
          status = COALESCE(@status, status),
          requested_token_raw = COALESCE(@requestedTokenRaw, requested_token_raw),
          error = @error,
          wallet_sol_delta = COALESCE(@walletSolDelta, wallet_sol_delta),
          network_fee_sol = COALESCE(@networkFeeSol, network_fee_sol),
          execution_json = COALESCE(@executionJson, execution_json),
          confirmed_at = COALESCE(@confirmedAt, confirmed_at),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      latestLiveOrderForPositionSide: this.db.prepare(`
        SELECT * FROM live_orders
        WHERE position_id = ? AND side = ?
        ORDER BY id DESC
        LIMIT 1
      `),
      confirmedPartialLiveOrderForPosition: this.db.prepare(`
        SELECT * FROM live_orders
        WHERE position_id = ? AND side = 'SELL' AND status = 'CONFIRMED_PARTIAL'
        ORDER BY id DESC
        LIMIT 1
      `),
      insertPrimarySignalShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO primary_signal_shadow_positions (
          signal_id, signal_episode_id, mint, symbol, status, rule_matched,
          rejection_reason, position_sol, configured_cost_pct,
          signal_at, signal_price, entry_target_at, entry_deadline_at,
          netflow_w3, unique_buyers_w3, created_at, updated_at
        ) VALUES (
          @signalId, @signalEpisodeId, @mint, @symbol, @status, @ruleMatched,
          @rejectionReason, @positionSol, @configuredCostPct,
          @signalAt, @signalPrice, @entryTargetAt, @entryDeadlineAt,
          @netFlowW3, @uniqueBuyersW3, @createdAt, @updatedAt
        )
      `),
      getPrimarySignalShadowPositionBySignal: this.db.prepare(`
        SELECT * FROM primary_signal_shadow_positions WHERE signal_id = ?
      `),
      getPrimarySignalShadowPositionByEpisode: this.db.prepare(`
        SELECT * FROM primary_signal_shadow_positions WHERE signal_episode_id = ?
      `),
      updatePrimarySignalShadowPosition: this.db.prepare(`
        UPDATE primary_signal_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          highest_price = COALESCE(@highestPrice, highest_price),
          smart_confirmed_at = COALESCE(@smartConfirmedAt, smart_confirmed_at),
          confirming_wallets_json = COALESCE(@confirmingWalletsJson, confirming_wallets_json),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activePrimarySignalShadowPositions: this.db.prepare(`
        SELECT p.*
        FROM primary_signal_shadow_positions p
        JOIN flow_signals s ON s.signal_id = p.signal_id
        WHERE p.status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
          AND s.signal_variant = ?
        ORDER BY p.signal_at, p.id
      `),
      insertFlowFirstShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO flow_first_shadow_positions (
          cohort_id, signal_id, signal_episode_id, signal_rank_in_mint,
          mint, symbol, status, rejection_reason, position_sol, configured_cost_pct,
          signal_at, signal_price, netflow_w3, unique_buyers_w3,
          entry_target_at, entry_deadline_at, created_at, updated_at
        ) VALUES (
          @cohortId, @signalId, @signalEpisodeId, @signalRankInMint,
          @mint, @symbol, @status, @rejectionReason, @positionSol, @configuredCostPct,
          @signalAt, @signalPrice, @netFlowW3, @uniqueBuyersW3,
          @entryTargetAt, @entryDeadlineAt, @createdAt, @updatedAt
        )
      `),
      getFlowFirstShadowPosition: this.db.prepare(`
        SELECT * FROM flow_first_shadow_positions
        WHERE cohort_id = ? AND signal_episode_id = ?
      `),
      updateFlowFirstShadowPosition: this.db.prepare(`
        UPDATE flow_first_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct,
            max_favorable_return_pct
          ),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeFlowFirstShadowPositions: this.db.prepare(`
        SELECT * FROM flow_first_shadow_positions
        WHERE cohort_id = ? AND status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY signal_at, id
      `),
      insertSmartPullbackShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO smart_pullback_shadow_positions (
          cohort_id, episode_id, smart_event_id, smart_wallet, mint, symbol,
          status, rejection_reason, position_sol, configured_cost_pct,
          smart_buy_at, smart_buy_price, smart_buy_sol, confirmation_deadline_at,
          peak_before_pullback, created_at, updated_at
        ) VALUES (
          @cohortId, @episodeId, @smartEventId, @smartWallet, @mint, @symbol,
          @status, @rejectionReason, @positionSol, @configuredCostPct,
          @smartBuyAt, @smartBuyPrice, @smartBuySol, @confirmationDeadlineAt,
          @peakBeforePullback, @createdAt, @updatedAt
        )
      `),
      getSmartPullbackShadowPosition: this.db.prepare(`
        SELECT * FROM smart_pullback_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      updateSmartPullbackShadowPosition: this.db.prepare(`
        UPDATE smart_pullback_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          peak_before_pullback = COALESCE(@peakBeforePullback, peak_before_pullback),
          pullback_armed_at = COALESCE(@pullbackArmedAt, pullback_armed_at),
          pullback_low_price = COALESCE(@pullbackLowPrice, pullback_low_price),
          rebound_buyers_json = COALESCE(@reboundBuyersJson, rebound_buyers_json),
          confirmation_at = COALESCE(@confirmationAt, confirmation_at),
          confirmation_price = COALESCE(@confirmationPrice, confirmation_price),
          entry_target_at = COALESCE(@entryTargetAt, entry_target_at),
          entry_deadline_at = COALESCE(@entryDeadlineAt, entry_deadline_at),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          highest_price = COALESCE(@highestPrice, highest_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct,
            max_favorable_return_pct
          ),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeSmartPullbackShadowPositions: this.db.prepare(`
        SELECT * FROM smart_pullback_shadow_positions
        WHERE cohort_id = ?
          AND status IN (
            'WAITING_PULLBACK', 'WAITING_REBOUND', 'PENDING_ENTRY',
            'OPEN', 'EXIT_PENDING'
          )
        ORDER BY smart_buy_at, id
      `),
      insertSmartOpenShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO smart_open_shadow_positions (
          cohort_id, smart_event_id, smart_wallet, mint, symbol,
          status, rejection_reason, position_sol, configured_cost_pct,
          smart_open_at, smart_open_price, smart_open_sol, curve_pct, age_ms,
          prebuy_window_ms, prebuy_buyers, prebuy_buy_tx, prebuy_buy_flow_sol,
          prebuy_sell_flow_sol, prebuy_net_flow_sol, entry_target_at,
          entry_deadline_at, created_at, updated_at
        ) VALUES (
          @cohortId, @smartEventId, @smartWallet, @mint, @symbol,
          @status, @rejectionReason, @positionSol, @configuredCostPct,
          @smartOpenAt, @smartOpenPrice, @smartOpenSol, @curvePct, @ageMs,
          @preBuyWindowMs, @preBuyers, @preBuyTx, @preBuyFlowSol,
          @preSellFlowSol, @preNetFlowSol, @entryTargetAt,
          @entryDeadlineAt, @createdAt, @updatedAt
        )
      `),
      getSmartOpenShadowPosition: this.db.prepare(`
        SELECT * FROM smart_open_shadow_positions
        WHERE cohort_id = ? AND smart_event_id = ?
      `),
      updateSmartOpenShadowPosition: this.db.prepare(`
        UPDATE smart_open_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_target_at = COALESCE(@entryTargetAt, entry_target_at),
          entry_deadline_at = COALESCE(@entryDeadlineAt, entry_deadline_at),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct,
            max_favorable_return_pct
          ),
          trailing_activated_at = COALESCE(@trailingActivatedAt, trailing_activated_at),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeSmartOpenShadowPositions: this.db.prepare(`
        SELECT * FROM smart_open_shadow_positions
        WHERE cohort_id = ? AND status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY smart_open_at, id
      `),
      insertFlowSmartConfirmShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO flow_smart_confirm_shadow_positions (
          cohort_id, smart_event_id, signal_id, smart_wallet, mint, symbol,
          status, rejection_reason, position_sol, configured_cost_pct,
          signal_at, signal_price, signal_rank_in_mint, signal_variant,
          netflow_w3, unique_buyers_w3, smart_open_at, smart_open_price,
          smart_open_sol, confirmation_delay_ms, curve_pct, age_ms,
          entry_target_at, entry_deadline_at, created_at, updated_at
        ) VALUES (
          @cohortId, @smartEventId, @signalId, @smartWallet, @mint, @symbol,
          @status, @rejectionReason, @positionSol, @configuredCostPct,
          @signalAt, @signalPrice, @signalRankInMint, @signalVariant,
          @netFlowW3, @uniqueBuyersW3, @smartOpenAt, @smartOpenPrice,
          @smartOpenSol, @confirmationDelayMs, @curvePct, @ageMs,
          @entryTargetAt, @entryDeadlineAt, @createdAt, @updatedAt
        )
      `),
      getFlowSmartConfirmShadowPosition: this.db.prepare(`
        SELECT * FROM flow_smart_confirm_shadow_positions
        WHERE cohort_id = ? AND smart_event_id = ?
      `),
      updateFlowSmartConfirmShadowPosition: this.db.prepare(`
        UPDATE flow_smart_confirm_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          max_favorable_return_pct = COALESCE(@maxFavorableReturnPct, max_favorable_return_pct),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeFlowSmartConfirmShadowPositions: this.db.prepare(`
        SELECT * FROM flow_smart_confirm_shadow_positions
        WHERE cohort_id = ? AND status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY smart_open_at, id
      `),
      insertLaunchPullbackShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO launch_pullback_shadow_positions (
          cohort_id, mint, symbol, status, rejection_reason,
          position_sol, configured_cost_pct, reference_profile_id,
          reference_at, reference_price,
          pump_25_at, reference_peak_at, reference_peak_price,
          first_pullback_at, pullback_low_price, max_pullback_pct,
          reference_rebound_pct, low_stable_ms, buyers_since_pullback_low,
          window_net_flow_sol, flow_window_ms,
          net_flow_sol, creator_share_pct, buyers, recent_buyers,
          retention_pct, top1_share_pct, top3_share_pct,
          sell_sol_since_peak, buy_sol_since_peak, buy_refill_ratio,
          recent_net_flow_1s, previous_net_flow_1s, net_flow_acceleration_1s,
          market_regime_observed_at, market_regime_independent_mints,
          market_regime_average_net_return_5s, market_regime_win_rate_5s,
          market_regime_big20_rate_5s,
          flow_confirmation_at, flow_confirmation_variant, flow_confirmation_buyers_w3,
          flow_confirmation_netflow_w3, flow_confirmation_window_ms,
          entry_target_at, entry_deadline_at, created_at, updated_at
        ) VALUES (
          @cohortId, @mint, @symbol, @status, @rejectionReason,
          @positionSol, @configuredCostPct, @referenceProfileId,
          @referenceAt, @referencePrice,
          @pump25At, @referencePeakAt, @referencePeakPrice,
          @firstPullbackAt, @pullbackLowPrice, @maxPullbackPct,
          @referenceReboundPct, @lowStableMs, @buyersSincePullbackLow,
          @windowNetFlowSol, @flowWindowMs,
          @netFlowSol, @creatorSharePct, @buyers, @recentBuyers,
          @retentionPct, @top1SharePct, @top3SharePct,
          @sellSolSincePeak, @buySolSincePeak, @buyRefillRatio,
          @recentNetFlow1s, @previousNetFlow1s, @netFlowAcceleration1s,
          @marketRegimeObservedAt, @marketRegimeIndependentMints,
          @marketRegimeAverageNetReturn5s, @marketRegimeWinRate5s,
          @marketRegimeBig20Rate5s,
          @flowConfirmationAt, @flowConfirmationVariant, @flowConfirmationBuyersW3,
          @flowConfirmationNetFlowW3, @flowConfirmationWindowMs,
          @entryTargetAt, @entryDeadlineAt, @createdAt, @updatedAt
        )
      `),
      getLaunchPullbackShadowPosition: this.db.prepare(`
        SELECT * FROM launch_pullback_shadow_positions
        WHERE cohort_id = ? AND mint = ?
      `),
      updateLaunchPullbackShadowPosition: this.db.prepare(`
        UPDATE launch_pullback_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct,
            max_favorable_return_pct
          ),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeLaunchPullbackShadowPositions: this.db.prepare(`
        SELECT * FROM launch_pullback_shadow_positions
        WHERE cohort_id = ? AND status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY reference_at, id
      `),
      insertMigratedDropReboundShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO migrated_drop_rebound_shadow_positions (
          cohort_id, lifecycle_stage, entry_profile_id, exit_profile_id, episode_id,
          mint, symbol, status, rejection_reason, confirmation_json,
          position_sol, configured_cost_pct,
          migrated_at, migration_age_ms, window_ms, drop_min_pct, drop_max_pct,
          rebound_min_pct, rebound_max_pct, rebound_timeout_ms,
          peak_at, peak_price, low_at, low_price, drop_pct,
          rebound_at, rebound_price, rebound_pct, rebound_elapsed_ms,
          rebound_from_low_ms, entry_target_at, entry_deadline_at,
          exit_mode, fixed_hold_ms, trailing_activation_pct, trailing_stop_pct,
          hard_stop_pct, fast_take_profit_pct, fast_take_profit_window_ms,
          loss_check_at_ms, loss_check_recovery_pct, max_hold_ms,
          core_weight_pct, runner_hold_ms, created_at, updated_at
        ) VALUES (
          @cohortId, @lifecycleStage, @entryProfileId, @exitProfileId, @episodeId,
          @mint, @symbol, @status, @rejectionReason, @confirmationJson,
          @positionSol, @configuredCostPct,
          @migratedAt, @migrationAgeMs, @windowMs, @dropMinPct, @dropMaxPct,
          @reboundMinPct, @reboundMaxPct, @reboundTimeoutMs,
          @peakAt, @peakPrice, @lowAt, @lowPrice, @dropPct,
          @reboundAt, @reboundPrice, @reboundPct, @reboundElapsedMs,
          @reboundFromLowMs, @entryTargetAt, @entryDeadlineAt,
          @exitMode, @fixedHoldMs, @trailingActivationPct, @trailingStopPct,
          @hardStopPct, @fastTakeProfitPct, @fastTakeProfitWindowMs,
          @lossCheckAtMs, @lossCheckRecoveryPct, @maxHoldMs,
          @coreWeightPct, @runnerHoldMs, @createdAt, @updatedAt
        )
      `),
      getMigratedDropReboundShadowPosition: this.db.prepare(`
        SELECT * FROM migrated_drop_rebound_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      updateMigratedDropReboundShadowPosition: this.db.prepare(`
        UPDATE migrated_drop_rebound_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          confirmation_json = COALESCE(@confirmationJson, confirmation_json),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          entry_impact_pct = COALESCE(@entryImpactPct, entry_impact_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct,
            max_favorable_return_pct
          ),
          max_adverse_return_pct = COALESCE(
            @maxAdverseReturnPct,
            max_adverse_return_pct
          ),
          trailing_activated_at = COALESCE(@trailingActivatedAt, trailing_activated_at),
          core_exit_target_at = COALESCE(@coreExitTargetAt, core_exit_target_at),
          core_exit_at = COALESCE(@coreExitAt, core_exit_at),
          core_exit_price = COALESCE(@coreExitPrice, core_exit_price),
          core_exit_reason = COALESCE(@coreExitReason, core_exit_reason),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_impact_pct = COALESCE(@exitImpactPct, exit_impact_pct),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeMigratedDropReboundShadowPositions: this.db.prepare(`
        SELECT * FROM migrated_drop_rebound_shadow_positions
        WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY rebound_at, id
      `),
      countMigratedDropReboundShadowSignals: this.db.prepare(`
        SELECT COUNT(DISTINCT episode_id) AS count
        FROM migrated_drop_rebound_shadow_positions
        WHERE lifecycle_stage = ? AND entry_profile_id = ? AND mint = ?
      `),
      insertMigrationContinuityShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO migration_continuity_shadow_positions (
          cohort_id, exit_profile_id, episode_id, mint, symbol, status,
          rejection_reason, position_sol, configured_cost_pct, graduated_at,
          signal_at, signal_price, entry_buyers, entry_buy_sol, entry_sell_sol,
          entry_net_flow_sol, entry_sell_buy_ratio, entry_return_pct,
          entry_target_at, entry_deadline_at, exit_mode, min_hold_ms,
          fixed_hold_ms, trailing_activation_pct, trailing_stop_pct,
          hard_stop_pct, max_hold_ms, created_at, updated_at
        ) VALUES (
          @cohortId, @exitProfileId, @episodeId, @mint, @symbol, @status,
          @rejectionReason, @positionSol, @configuredCostPct, @graduatedAt,
          @signalAt, @signalPrice, @entryBuyers, @entryBuySol, @entrySellSol,
          @entryNetFlowSol, @entrySellBuyRatio, @entryReturnPct,
          @entryTargetAt, @entryDeadlineAt, @exitMode, @minHoldMs,
          @fixedHoldMs, @trailingActivationPct, @trailingStopPct,
          @hardStopPct, @maxHoldMs, @createdAt, @updatedAt
        )
      `),
      getMigrationContinuityShadowPosition: this.db.prepare(`
        SELECT * FROM migration_continuity_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      updateMigrationContinuityShadowPosition: this.db.prepare(`
        UPDATE migration_continuity_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct, max_favorable_return_pct
          ),
          max_adverse_return_pct = COALESCE(
            @maxAdverseReturnPct, max_adverse_return_pct
          ),
          trailing_activated_at = COALESCE(@trailingActivatedAt, trailing_activated_at),
          fixed_hold_ms = COALESCE(@fixedHoldMs, fixed_hold_ms),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeMigrationContinuityShadowPositions: this.db.prepare(`
        SELECT * FROM migration_continuity_shadow_positions
        WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY signal_at, id
      `),
      hasMigrationContinuityShadowSignal: this.db.prepare(`
        SELECT 1 AS present
        FROM migration_continuity_shadow_positions
        WHERE mint = ?
        LIMIT 1
      `),
      insertRangeScalperShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO range_scalper_shadow_positions (
          cohort_id, entry_profile_id, exit_profile_id, episode_id, swing_index,
          mint, symbol, status, rejection_reason, position_sol, configured_cost_pct,
          migrated_at, signal_at, signal_price, range_score, window_ms,
          trade_count, volume_sol, unique_wallets, buy_share_pct, range_pct,
          efficiency_ratio, mean_crosses, top_wallet_share_pct, trend_pct,
          midline_price, lower_band_price, upper_band_price, deviation_sigma,
          rebound_pct, recent_netflow_sol, recent_buyers, sell_decay_ratio,
          features_json, entry_target_at, entry_deadline_at,
          exit_mode, take_profit_pct, hard_stop_pct, max_hold_ms,
          created_at, updated_at
        ) VALUES (
          @cohortId, @entryProfileId, @exitProfileId, @episodeId, @swingIndex,
          @mint, @symbol, @status, @rejectionReason, @positionSol, @configuredCostPct,
          @migratedAt, @signalAt, @signalPrice, @rangeScore, @windowMs,
          @tradeCount, @volumeSol, @uniqueWallets, @buySharePct, @rangePct,
          @efficiencyRatio, @meanCrosses, @topWalletSharePct, @trendPct,
          @midlinePrice, @lowerBandPrice, @upperBandPrice, @deviationSigma,
          @reboundPct, @recentNetFlowSol, @recentBuyers, @sellDecayRatio,
          @featuresJson, @entryTargetAt, @entryDeadlineAt,
          @exitMode, @takeProfitPct, @hardStopPct, @maxHoldMs,
          @createdAt, @updatedAt
        )
      `),
      getRangeScalperShadowPosition: this.db.prepare(`
        SELECT * FROM range_scalper_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      updateRangeScalperShadowPosition: this.db.prepare(`
        UPDATE range_scalper_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct,
            max_favorable_return_pct
          ),
          max_adverse_return_pct = COALESCE(
            @maxAdverseReturnPct,
            max_adverse_return_pct
          ),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeRangeScalperShadowPositions: this.db.prepare(`
        SELECT * FROM range_scalper_shadow_positions
        WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY signal_at, id
      `),
      maxRangeScalperSwingIndex: this.db.prepare(`
        SELECT MAX(swing_index) AS max_swing_index
        FROM range_scalper_shadow_positions
        WHERE entry_profile_id = ? AND mint = ?
      `),
      insertCyaEarlyPyramidShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO cya_early_pyramid_shadow_positions (
          cohort_id, entry_profile_id, exit_profile_id, episode_id,
          mint, symbol, status, rejection_reason, position_sol, configured_cost_pct,
          signal_at, signal_price, age_ms, curve_pct, buyers_1s, buyers_5s,
          net_flow_1s, net_flow_5s, return_2s_pct, features_json,
          entry_target_at, entry_deadline_at, trailing_stop_pct, hard_stop_pct,
          no_strength_ms, no_strength_mfe_pct, max_hold_ms, created_at, updated_at
        ) VALUES (
          @cohortId, @entryProfileId, @exitProfileId, @episodeId,
          @mint, @symbol, @status, @rejectionReason, @positionSol, @configuredCostPct,
          @signalAt, @signalPrice, @ageMs, @curvePct, @buyers1s, @buyers5s,
          @netFlow1s, @netFlow5s, @return2sPct, @featuresJson,
          @entryTargetAt, @entryDeadlineAt, @trailingStopPct, @hardStopPct,
          @noStrengthMs, @noStrengthMfePct, @maxHoldMs, @createdAt, @updatedAt
        )
      `),
      getCyaEarlyPyramidShadowPosition: this.db.prepare(`
        SELECT * FROM cya_early_pyramid_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      updateCyaEarlyPyramidShadowPosition: this.db.prepare(`
        UPDATE cya_early_pyramid_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          average_entry_price = COALESCE(@averageEntryPrice, average_entry_price),
          total_invested_sol = COALESCE(@totalInvestedSol, total_invested_sol),
          token_units = COALESCE(@tokenUnits, token_units),
          remaining_token_units = COALESCE(@remainingTokenUnits, remaining_token_units),
          realized_proceeds_sol = COALESCE(@realizedProceedsSol, realized_proceeds_sol),
          add_count = COALESCE(@addCount, add_count),
          last_add_at = COALESCE(@lastAddAt, last_add_at),
          last_add_price = COALESCE(@lastAddPrice, last_add_price),
          first_take_profit_at = COALESCE(@firstTakeProfitAt, first_take_profit_at),
          first_take_profit_price = COALESCE(@firstTakeProfitPrice, first_take_profit_price),
          second_take_profit_at = COALESCE(@secondTakeProfitAt, second_take_profit_at),
          second_take_profit_price = COALESCE(@secondTakeProfitPrice, second_take_profit_price),
          scale_out_count = COALESCE(@scaleOutCount, scale_out_count),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(@maxFavorableReturnPct, max_favorable_return_pct),
          max_adverse_return_pct = COALESCE(@maxAdverseReturnPct, max_adverse_return_pct),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          estimated_cost_sol = COALESCE(@estimatedCostSol, estimated_cost_sol),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      reopenLivePositionForReconciliation: this.db.prepare(`
        UPDATE live_positions SET
          status = 'EXIT_FAILED',
          token_amount_raw = NULL,
          entry_error = @entryError,
          exit_market = NULL,
          exit_price = NULL,
          exit_signature = NULL,
          exit_reason = 'ENTRY_CONFIRMATION_UNKNOWN',
          exit_error = NULL,
          exit_requested_at = NULL,
          closed_at = NULL,
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeCyaEarlyPyramidShadowPositions: this.db.prepare(`
        SELECT * FROM cya_early_pyramid_shadow_positions
        WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY signal_at, id
      `),
      insertBondingCurveMomentumShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO bonding_curve_momentum_shadow_positions (
          cohort_id, entry_profile_id, exit_profile_id, episode_id,
          mint, symbol, status, rejection_reason, position_sol, configured_cost_pct,
          signal_at, signal_price, age_ms, curve_pct, virtual_sol_reserves,
          net_flow_1s, prior_net_flow_1s, flow_accel_1s,
          buy_sol_1s, sell_sol_1s, prior_sell_sol_1s, sell_decay_ratio,
          buyers_1s, new_buyers_1s, buy_tx_1s, prior_buy_tx_1s,
          buy_tx_accel_1s, top1_share_pct, features_json,
          entry_target_at, entry_deadline_at, exit_mode, fixed_hold_ms,
          min_hold_ms, max_hold_ms, trailing_activation_pct, trailing_stop_pct,
          created_at, updated_at
        ) VALUES (
          @cohortId, @entryProfileId, @exitProfileId, @episodeId,
          @mint, @symbol, @status, @rejectionReason, @positionSol, @configuredCostPct,
          @signalAt, @signalPrice, @ageMs, @curvePct, @virtualSolReserves,
          @netFlow1s, @priorNetFlow1s, @flowAccel1s,
          @buySol1s, @sellSol1s, @priorSellSol1s, @sellDecayRatio,
          @buyers1s, @newBuyers1s, @buyTx1s, @priorBuyTx1s,
          @buyTxAccel1s, @top1SharePct, @featuresJson,
          @entryTargetAt, @entryDeadlineAt, @exitMode, @fixedHoldMs,
          @minHoldMs, @maxHoldMs, @trailingActivationPct, @trailingStopPct,
          @createdAt, @updatedAt
        )
      `),
      getBondingCurveMomentumShadowPosition: this.db.prepare(`
        SELECT * FROM bonding_curve_momentum_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      updateBondingCurveMomentumShadowPosition: this.db.prepare(`
        UPDATE bonding_curve_momentum_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct,
            max_favorable_return_pct
          ),
          max_adverse_return_pct = COALESCE(
            @maxAdverseReturnPct,
            max_adverse_return_pct
          ),
          trailing_activated_at = COALESCE(@trailingActivatedAt, trailing_activated_at),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeBondingCurveMomentumShadowPositions: this.db.prepare(`
        SELECT * FROM bonding_curve_momentum_shadow_positions
        WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY signal_at, id
      `),
      insertGraduationHoldShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO graduation_hold_shadow_positions (
          cohort_id, episode_id, signal_id, mint, symbol, status, rejection_reason,
          position_sol, configured_cost_pct, signal_at, signal_price,
          signal_curve_pct, signal_netflow_w3, signal_buyers_w3,
          entry_target_at, entry_deadline_at, exit_mode,
          created_at, updated_at
        ) VALUES (
          @cohortId, @episodeId, @signalId, @mint, @symbol, @status, @rejectionReason,
          @positionSol, @configuredCostPct, @signalAt, @signalPrice,
          @signalCurvePct, @signalNetFlowW3, @signalBuyersW3,
          @entryTargetAt, @entryDeadlineAt, @exitMode,
          @createdAt, @updatedAt
        )
      `),
      getGraduationHoldShadowPosition: this.db.prepare(`
        SELECT * FROM graduation_hold_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      getGraduationHoldShadowPositionById: this.db.prepare(`
        SELECT * FROM graduation_hold_shadow_positions WHERE id = ?
      `),
      updateGraduationHoldShadowPosition: this.db.prepare(`
        UPDATE graduation_hold_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(@maxFavorableReturnPct, max_favorable_return_pct),
          max_adverse_return_pct = COALESCE(@maxAdverseReturnPct, max_adverse_return_pct),
          current_checkpoint_pct = COALESCE(@currentCheckpointPct, current_checkpoint_pct),
          next_checkpoint_pct = CASE WHEN @clearNextCheckpoint = 1
            THEN NULL ELSE COALESCE(@nextCheckpointPct, next_checkpoint_pct) END,
          checkpoint_deadline_at = CASE WHEN @clearCheckpointDeadline = 1
            THEN NULL ELSE COALESCE(@checkpointDeadlineAt, checkpoint_deadline_at) END,
          gates_passed = COALESCE(@gatesPassed, gates_passed),
          last_gate_at = COALESCE(@lastGateAt, last_gate_at),
          last_gate_pass = COALESCE(@lastGatePass, last_gate_pass),
          last_features_json = COALESCE(@lastFeaturesJson, last_features_json),
          checkpoint_history_json = COALESCE(@checkpointHistoryJson, checkpoint_history_json),
          graduation_ready = COALESCE(@graduationReady, graduation_ready),
          graduated_at = COALESCE(@graduatedAt, graduated_at),
          exit_target_market = COALESCE(@exitTargetMarket, exit_target_market),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeGraduationHoldShadowPositions: this.db.prepare(`
        SELECT * FROM graduation_hold_shadow_positions
        WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY signal_at, id
      `),
      insertBondingCurveMomentumShadowSnapshot: this.db.prepare(`
        INSERT OR IGNORE INTO bonding_curve_momentum_shadow_snapshots (
          episode_id, entry_profile_id, mint, horizon_ms, status,
          target_at, observed_at, observation_lag_ms, market, price,
          gross_return_pct, max_favorable_return_pct, max_adverse_return_pct,
          net_flow_1s, flow_accel_1s, buyers_1s, new_buyers_1s,
          buy_tx_accel_1s, sell_decay_ratio, curve_pct, virtual_sol_reserves,
          features_json, created_at
        ) VALUES (
          @episodeId, @entryProfileId, @mint, @horizonMs, @status,
          @targetAt, @observedAt, @observationLagMs, @market, @price,
          @grossReturnPct, @maxFavorableReturnPct, @maxAdverseReturnPct,
          @netFlow1s, @flowAccel1s, @buyers1s, @newBuyers1s,
          @buyTxAccel1s, @sellDecayRatio, @curvePct, @virtualSolReserves,
          @featuresJson, @createdAt
        )
      `),
      recentBondingCurveMomentumEpisodes: this.db.prepare(`
        SELECT entry_profile_id, episode_id, mint, symbol, signal_at, signal_price
        FROM bonding_curve_momentum_shadow_positions
        WHERE signal_at >= ?
        GROUP BY episode_id
        ORDER BY signal_at, episode_id
      `),
      bondingCurveMomentumSnapshotHorizons: this.db.prepare(`
        SELECT horizon_ms FROM bonding_curve_momentum_shadow_snapshots
        WHERE episode_id = ?
        ORDER BY horizon_ms
      `),
      insertHolderGrowthShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO holder_growth_shadow_positions (
          cohort_id, entry_profile_id, exit_profile_id, mint, symbol,
          status, rejection_reason, position_sol, configured_cost_pct,
          horizon_ms, signal_at, signal_price, observation_lag_ms,
          buyers, new_buyers, retention_pct, net_flow_sol, top3_share_pct,
          curve_pct, virtual_sol_reserves, features_json,
          entry_target_at, entry_deadline_at, exit_mode, fixed_hold_ms,
          hard_stop_pct, trailing_activation_pct, trailing_stop_pct,
          trailing_tiers_json, trailing_tier_index, stop_price,
          scale_out_trigger_pct, scale_out_fraction_pct,
          partial_exit_target_at, partial_exit_deadline_at,
          scale_out_at, scale_out_price, flow_check_horizon_ms,
          min_buyer_velocity_ratio, min_net_flow_delta_sol,
          flow_check_at, flow_check_status, flow_buyer_velocity_ratio,
          flow_net_flow_delta_sol, max_hold_ms,
          created_at, updated_at
        ) VALUES (
          @cohortId, @entryProfileId, @exitProfileId, @mint, @symbol,
          @status, @rejectionReason, @positionSol, @configuredCostPct,
          @horizonMs, @signalAt, @signalPrice, @observationLagMs,
          @buyers, @newBuyers, @retentionPct, @netFlowSol, @top3SharePct,
          @curvePct, @virtualSolReserves, @featuresJson,
          @entryTargetAt, @entryDeadlineAt, @exitMode, @fixedHoldMs,
          @hardStopPct, @trailingActivationPct, @trailingStopPct,
          @trailingTiersJson, @trailingTierIndex, @stopPrice,
          @scaleOutTriggerPct, @scaleOutFractionPct,
          @partialExitTargetAt, @partialExitDeadlineAt,
          @scaleOutAt, @scaleOutPrice, @flowCheckHorizonMs,
          @minBuyerVelocityRatio, @minNetFlowDeltaSol,
          @flowCheckAt, @flowCheckStatus, @flowBuyerVelocityRatio,
          @flowNetFlowDeltaSol, @maxHoldMs,
          @createdAt, @updatedAt
        )
      `),
      getHolderGrowthShadowPosition: this.db.prepare(`
        SELECT * FROM holder_growth_shadow_positions
        WHERE cohort_id = ? AND mint = ?
      `),
      updateHolderGrowthShadowPosition: this.db.prepare(`
        UPDATE holder_growth_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct, max_favorable_return_pct
          ),
          max_adverse_return_pct = COALESCE(
            @maxAdverseReturnPct, max_adverse_return_pct
          ),
          trailing_activated_at = COALESCE(@trailingActivatedAt, trailing_activated_at),
          trailing_tier_index = COALESCE(@trailingTierIndex, trailing_tier_index),
          stop_price = COALESCE(@stopPrice, stop_price),
          partial_exit_target_at = CASE WHEN @clearPartialExitPending = 1
            THEN NULL ELSE COALESCE(@partialExitTargetAt, partial_exit_target_at) END,
          partial_exit_deadline_at = CASE WHEN @clearPartialExitPending = 1
            THEN NULL ELSE COALESCE(@partialExitDeadlineAt, partial_exit_deadline_at) END,
          scale_out_at = COALESCE(@scaleOutAt, scale_out_at),
          scale_out_price = COALESCE(@scaleOutPrice, scale_out_price),
          flow_check_at = COALESCE(@flowCheckAt, flow_check_at),
          flow_check_status = COALESCE(@flowCheckStatus, flow_check_status),
          flow_buyer_velocity_ratio = COALESCE(
            @flowBuyerVelocityRatio, flow_buyer_velocity_ratio
          ),
          flow_net_flow_delta_sol = COALESCE(
            @flowNetFlowDeltaSol, flow_net_flow_delta_sol
          ),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeHolderGrowthShadowPositions: this.db.prepare(`
        SELECT * FROM holder_growth_shadow_positions
        WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY signal_at, id
      `),
      insertGraduationAccelerationShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO graduation_acceleration_shadow_positions (
          cohort_id, episode_id, entry_profile_id, mint, symbol, creator,
          status, rejection_reason, position_sol, configured_cost_pct,
          signal_at, signal_price, signal_curve_pct, features_json,
          entry_target_at, entry_deadline_at, core_weight_pct,
          created_at, updated_at
        ) VALUES (
          @cohortId, @episodeId, @entryProfileId, @mint, @symbol, @creator,
          @status, @rejectionReason, @positionSol, @configuredCostPct,
          @signalAt, @signalPrice, @signalCurvePct, @featuresJson,
          @entryTargetAt, @entryDeadlineAt, @coreWeightPct,
          @createdAt, @updatedAt
        )
      `),
      getGraduationAccelerationShadowPosition: this.db.prepare(`
        SELECT * FROM graduation_acceleration_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      updateGraduationAccelerationShadowPosition: this.db.prepare(`
        UPDATE graduation_acceleration_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          entry_target_at = COALESCE(@entryTargetAt, entry_target_at),
          entry_deadline_at = COALESCE(@entryDeadlineAt, entry_deadline_at),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_market = COALESCE(@entryMarket, entry_market),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          entry_impact_pct = COALESCE(@entryImpactPct, entry_impact_pct),
          token_units = COALESCE(@tokenUnits, token_units),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct, max_favorable_return_pct
          ),
          max_adverse_return_pct = COALESCE(
            @maxAdverseReturnPct, max_adverse_return_pct
          ),
          graduated_at = COALESCE(@graduatedAt, graduated_at),
          core_exit_at = COALESCE(@coreExitAt, core_exit_at),
          core_exit_price = COALESCE(@coreExitPrice, core_exit_price),
          runner_highest_price = COALESCE(@runnerHighestPrice, runner_highest_price),
          runner_tier_index = COALESCE(@runnerTierIndex, runner_tier_index),
          runner_stop_price = COALESCE(@runnerStopPrice, runner_stop_price),
          exit_target_market = CASE WHEN @clearExitPending = 1
            THEN NULL ELSE COALESCE(@exitTargetMarket, exit_target_market) END,
          exit_trigger_at = CASE WHEN @clearExitPending = 1
            THEN NULL ELSE COALESCE(@exitTriggerAt, exit_trigger_at) END,
          exit_target_at = CASE WHEN @clearExitPending = 1
            THEN NULL ELSE COALESCE(@exitTargetAt, exit_target_at) END,
          exit_deadline_at = CASE WHEN @clearExitPending = 1
            THEN NULL ELSE COALESCE(@exitDeadlineAt, exit_deadline_at) END,
          exit_at = COALESCE(@exitAt, exit_at),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_impact_pct = COALESCE(@exitImpactPct, exit_impact_pct),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      activeGraduationAccelerationShadowPositions: this.db.prepare(`
        SELECT * FROM graduation_acceleration_shadow_positions
        WHERE status IN (
          'PENDING_ENTRY', 'OPEN', 'CORE_EXIT_PENDING', 'RUNNER', 'EXIT_PENDING'
        )
        ORDER BY signal_at, id
      `),
      insertLaunchQualityObservation: this.db.prepare(`
        INSERT OR IGNORE INTO launch_quality_observations (
          mint, symbol, creator, created_at, status, label_status,
          record_created_at, updated_at
        ) VALUES (
          @mint, @symbol, @creator, @createdAt, 'OBSERVING', 'WAITING_REFERENCE',
          @recordCreatedAt, @updatedAt
        )
      `),
      getLaunchQualityObservation: this.db.prepare(`
        SELECT * FROM launch_quality_observations WHERE mint = ?
      `),
      insertLaunchQualitySnapshot: this.db.prepare(`
        INSERT OR IGNORE INTO launch_quality_snapshots (
          mint, horizon_ms, observed_at, last_trade_at, observation_lag_ms,
          price, price_return_pct, peak_return_pct, drawdown_pct,
          buyers, recent_buyers, new_buyers, buy_tx, sell_tx,
          buy_sol, sell_sol, net_flow_sol, top1_share_pct, top3_share_pct,
          retention_pct, creator_share_pct, sell_sol_since_peak, buy_sol_since_peak,
          sell_impact_pct_per_sol, sell_depth_fraction_pct,
          depth_adjusted_sell_impact, sell_decay_ratio, curve_pct,
          virtual_sol_reserves, created_at
        ) VALUES (
          @mint, @horizonMs, @observedAt, @lastTradeAt, @observationLagMs,
          @price, @priceReturnPct, @peakReturnPct, @drawdownPct,
          @buyers, @recentBuyers, @newBuyers, @buyTx, @sellTx,
          @buySol, @sellSol, @netFlowSol, @top1SharePct, @top3SharePct,
          @retentionPct, @creatorSharePct, @sellSolSincePeak, @buySolSincePeak,
          @sellImpactPctPerSol, @sellDepthFractionPct,
          @depthAdjustedSellImpact, @sellDecayRatio, @curvePct,
          @virtualSolReserves, @createdAt
        )
      `),
      insertMigrationSecondLegObservation: this.db.prepare(`
        INSERT OR IGNORE INTO migration_second_leg_observations (
          mint, symbol, creator, migration_at, migration_source, status,
          record_created_at, updated_at
        ) VALUES (
          @mint, @symbol, @creator, @migrationAt, @migrationSource, 'OBSERVING',
          @recordCreatedAt, @updatedAt
        )
      `),
      getMigrationSecondLegObservation: this.db.prepare(`
        SELECT * FROM migration_second_leg_observations WHERE mint = ?
      `),
      updateMigrationSecondLegObservation: this.db.prepare(`
        UPDATE migration_second_leg_observations SET
          first_amm_trade_at = COALESCE(@firstAmmTradeAt, first_amm_trade_at),
          baseline_price = COALESCE(@baselinePrice, baseline_price),
          last_trade_at = COALESCE(@lastTradeAt, last_trade_at),
          last_price = COALESCE(@lastPrice, last_price),
          peak_at = COALESCE(@peakAt, peak_at),
          peak_price = COALESCE(@peakPrice, peak_price),
          max_return_pct = COALESCE(@maxReturnPct, max_return_pct),
          first_pullback_at = COALESCE(@firstPullbackAt, first_pullback_at),
          pullback_low_at = COALESCE(@pullbackLowAt, pullback_low_at),
          pullback_low_price = COALESCE(@pullbackLowPrice, pullback_low_price),
          max_pullback_pct = COALESCE(@maxPullbackPct, max_pullback_pct),
          rebound_at = COALESCE(@reboundAt, rebound_at),
          boost_status = COALESCE(@boostStatus, boost_status),
          cashback_status = COALESCE(@cashbackStatus, cashback_status),
          canonical_pool_status = COALESCE(@canonicalPoolStatus, canonical_pool_status),
          quote_reserve_status = COALESCE(@quoteReserveStatus, quote_reserve_status),
          updated_at = @updatedAt
        WHERE mint = @mint AND status = 'OBSERVING'
      `),
      completeMigrationSecondLegObservation: this.db.prepare(`
        UPDATE migration_second_leg_observations SET
          status = @status,
          completed_at = @completedAt,
          completion_reason = @completionReason,
          updated_at = @updatedAt
        WHERE mint = @mint AND status = 'OBSERVING'
      `),
      censorOpenMigrationSecondLegObservations: this.db.prepare(`
        UPDATE migration_second_leg_observations SET
          status = 'RIGHT_CENSORED',
          completed_at = @completedAt,
          completion_reason = @completionReason,
          updated_at = @updatedAt
        WHERE status = 'OBSERVING'
      `),
      insertMigrationSecondLegSnapshot: this.db.prepare(`
        INSERT OR IGNORE INTO migration_second_leg_snapshots (
          mint, second_bucket, age_ms, observed_at, last_trade_at,
          observation_lag_ms, slot, price, baseline_price, peak_price,
          opening_impulse_pct, pullback_pct, pullback_duration_ms, rebound_pct,
          micro_high_break, buy_sol_3s, sell_sol_3s, net_flow_3s,
          buy_sol_10s, sell_sol_10s, net_flow_10s, buy_sol_prev_20s,
          sell_sol_prev_20s, net_flow_prev_20s, buyers_3s, buyers_10s,
          largest_buyer_share_10s_pct, buy_speed_ratio, net_flow_acceleration,
          sell_deceleration_ratio, observed_retained_buyers,
          observed_exited_buyers, observed_holder_diffusion_index,
          quote_reserve_sol, onfi_10_pct, estimated_impact_005_pct,
          estimated_impact_01_pct, estimated_impact_025_pct, boost_status,
          mayhem_status, cashback_status, canonical_pool_status,
          entity_cluster_status, feature_completeness_json, created_at
        ) VALUES (
          @mint, @secondBucket, @ageMs, @observedAt, @lastTradeAt,
          @observationLagMs, @slot, @price, @baselinePrice, @peakPrice,
          @openingImpulsePct, @pullbackPct, @pullbackDurationMs, @reboundPct,
          @microHighBreak, @buySol3s, @sellSol3s, @netFlow3s,
          @buySol10s, @sellSol10s, @netFlow10s, @buySolPrev20s,
          @sellSolPrev20s, @netFlowPrev20s, @buyers3s, @buyers10s,
          @largestBuyerShare10sPct, @buySpeedRatio, @netFlowAcceleration,
          @sellDecelerationRatio, @observedRetainedBuyers,
          @observedExitedBuyers, @observedHolderDiffusionIndex,
          @quoteReserveSol, @onfi10Pct, @estimatedImpact005Pct,
          @estimatedImpact01Pct, @estimatedImpact025Pct, @boostStatus,
          @mayhemStatus, @cashbackStatus, @canonicalPoolStatus,
          @entityClusterStatus, @featureCompletenessJson, @createdAt
        )
      `),
      incrementMigrationSecondLegSnapshotCount: this.db.prepare(`
        UPDATE migration_second_leg_observations SET
          snapshot_count = snapshot_count + 1,
          updated_at = @updatedAt
        WHERE mint = @mint
      `),
      insertMigrationSecondLegShadowPosition: this.db.prepare(`
        INSERT OR IGNORE INTO migration_second_leg_shadow_positions (
          cohort_id, episode_id, mint, symbol, status, rejection_reason,
          position_sol, configured_cost_pct, migration_at, signal_at,
          signal_price, signal_age_ms, features_json, rug_guard_json,
          entry_target_at, entry_deadline_at, hard_stop_pct, max_hold_ms,
          created_at, updated_at
        ) VALUES (
          @cohortId, @episodeId, @mint, @symbol, @status, @rejectionReason,
          @positionSol, @configuredCostPct, @migrationAt, @signalAt,
          @signalPrice, @signalAgeMs, @featuresJson, @rugGuardJson,
          @entryTargetAt, @entryDeadlineAt, @hardStopPct, @maxHoldMs,
          @createdAt, @updatedAt
        )
      `),
      getMigrationSecondLegShadowPosition: this.db.prepare(`
        SELECT * FROM migration_second_leg_shadow_positions
        WHERE cohort_id = ? AND episode_id = ?
      `),
      activeMigrationSecondLegShadowPositions: this.db.prepare(`
        SELECT * FROM migration_second_leg_shadow_positions
        WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        ORDER BY updated_at, id
      `),
      updateMigrationSecondLegShadowPosition: this.db.prepare(`
        UPDATE migration_second_leg_shadow_positions SET
          status = COALESCE(@status, status),
          rejection_reason = COALESCE(@rejectionReason, rejection_reason),
          rug_guard_json = COALESCE(@rugGuardJson, rug_guard_json),
          entry_at = COALESCE(@entryAt, entry_at),
          entry_price = COALESCE(@entryPrice, entry_price),
          entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
          entry_impact_pct = COALESCE(@entryImpactPct, entry_impact_pct),
          highest_price = COALESCE(@highestPrice, highest_price),
          lowest_price = COALESCE(@lowestPrice, lowest_price),
          last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
          last_price = COALESCE(@lastPrice, last_price),
          max_favorable_return_pct = COALESCE(
            @maxFavorableReturnPct, max_favorable_return_pct
          ),
          max_adverse_return_pct = COALESCE(
            @maxAdverseReturnPct, max_adverse_return_pct
          ),
          exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
          exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
          exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
          exit_at = COALESCE(@exitAt, exit_at),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_impact_pct = COALESCE(@exitImpactPct, exit_impact_pct),
          exit_reason = COALESCE(@exitReason, exit_reason),
          gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
          net_return_pct = COALESCE(@netReturnPct, net_return_pct),
          updated_at = @updatedAt
        WHERE id = @id
      `),
      recentSmartWalletEvents: this.db.prepare(`
        SELECT * FROM smart_wallet_events
        WHERE timestamp_ms >= ?
        ORDER BY timestamp_ms, id
      `),
    };

    this._writeTrades = this.db.transaction((trades) => {
      for (const trade of trades) {
        const result = this.stmts.insertRawTrade.run(trade);
        if (result.changes > 0) {
          this.stmts.updateTokenTrade.run(trade);
          this.metrics.tradesWritten += 1;
        }
      }
    });

    this._writeSmartWalletEvent = this.db.transaction((row) => {
      const current = this.stmts.smartWalletPosition.get(row.wallet, row.mint);
      const before = Math.max(0, Number(current?.token_balance) || 0);
      const amount = Math.max(0, Number(row.tokenAmount) || 0);
      let after = before;
      if (row.side === 'BUY') {
        row.positionPhase = before > 0 ? 'ADD' : 'OPEN';
        after = before + amount;
      } else if (before <= 0) {
        row.positionPhase = 'SELL';
        after = 0;
      } else {
        after = Math.max(0, before - amount);
        const dust = Math.max(1e-9, before * 0.005);
        row.positionPhase = after <= dust ? 'CLOSE' : 'REDUCE';
        if (row.positionPhase === 'CLOSE') after = 0;
      }
      row.tokenBalanceBefore = before;
      row.tokenBalanceAfter = after;
      const result = this.stmts.insertSmartWallet.run(row);
      if (result.changes === 0) return { ...row, id: null, inserted: false };
      this.stmts.upsertSmartWalletPosition.run({
        wallet: row.wallet,
        mint: row.mint,
        tokenBalance: after,
        updatedAt: row.timestampMs,
      });
      const id = Number(result.lastInsertRowid);
      if (row.positionPhase === 'OPEN' && row.nearestFlowSignal) {
        this.stmts.insertSmartSignalConfirmation.run({
          signalId: row.nearestFlowSignal,
          smartEventId: id,
          wallet: row.wallet,
          mint: row.mint,
          openTimestampMs: row.timestampMs,
          delayMs: row.timeFromFlowSignalMs,
          openSol: row.solAmount,
        });
      }
      return { ...row, id, inserted: true };
    });
  }

  recordCreate(event) {
    const row = { ...event, updatedAt: Date.now() };
    this.stmts.upsertCreate.run(row);
    const token = this.stmts.getToken.get(event.mint);
    if (token) this.tokens.set(event.mint, token);
    return token;
  }

  ensureToken(mint, bondingCurve = null) {
    let token = this.tokens.get(mint);
    if (token) return token;
    this.stmts.ensureToken.run({ mint, bondingCurve, updatedAt: Date.now() });
    token = this.stmts.getToken.get(mint);
    if (token) this.tokens.set(mint, token);
    return token;
  }

  recordComplete(event) {
    this.ensureToken(event.mint, event.bondingCurve);
    const now = Date.now();
    this.stmts.markComplete.run({
      mint: event.mint,
      bondingCurve: event.bondingCurve || null,
      graduatedAt: event.completedAt || event.timestampMs || now,
      updatedAt: now,
    });
    const token = this.stmts.getToken.get(event.mint);
    if (token) this.tokens.set(event.mint, token);
    return token;
  }

  recordMigration(event) {
    this.ensureToken(event.mint, event.bondingCurve);
    const now = Date.now();
    this.stmts.markMigration.run({
      mint: event.mint,
      bondingCurve: event.bondingCurve || null,
      pool: event.pool || null,
      migratedAt: event.migratedAt || event.timestampMs || now,
      updatedAt: now,
    });
    const token = this.stmts.getToken.get(event.mint);
    if (token) this.tokens.set(event.mint, token);
    return token;
  }

  enrichTrade(trade) {
    const token = this.ensureToken(trade.mint, trade.bondingCurve);
    const curvePct = trade.market === 'PUMP_BONDING_CURVE'
      ? curveProgress(token?.initial_real_token_reserves_raw, trade.realTokenReservesRaw)
      : token?.curve_pct ?? null;
    return {
      ...trade,
      bondingCurve: trade.bondingCurve || token?.bonding_curve || null,
      curvePct: finiteOrNull(curvePct),
      ageMs: token?.created_at && trade.timestampMs >= token.created_at
        ? trade.timestampMs - token.created_at
        : null,
      symbol: token?.symbol || null,
    };
  }

  resolveAmmMint(pool, candidateMint = null) {
    if (pool) {
      const token = this.stmts.getTokenByPool.get(pool);
      if (token) return token.mint;
    }
    return candidateMint && this.tokens.has(candidateMint) ? candidateMint : null;
  }

  queueRawTrade(trade) {
    const normalizedReceivedAtMs = receivedTimestampMs(trade.receivedAtMs, trade.timestampMs);
    if (normalizedReceivedAtMs !== trade.receivedAtMs) this.metrics.timestampCorrections += 1;
    this.rawBuffer.push({
      timestampMs: trade.timestampMs,
      chainTimestampMs: trade.chainTimestampMs || null,
      receivedAtMs: normalizedReceivedAtMs,
      slot: trade.slot || null,
      signature: trade.signature || null,
      eventIndex: trade.eventIndex || 0,
      market: trade.market,
      mint: trade.mint,
      bondingCurve: trade.bondingCurve || null,
      wallet: trade.wallet || null,
      side: trade.side,
      solAmount: trade.solAmount,
      tokenAmount: trade.tokenAmount,
      price: trade.price,
      reservePrice: finiteOrNull(trade.reservePrice),
      curvePct: finiteOrNull(trade.curvePct),
      virtualSolReservesRaw: trade.virtualSolReservesRaw || null,
      virtualTokenReservesRaw: trade.virtualTokenReservesRaw || null,
      realSolReservesRaw: trade.realSolReservesRaw || null,
      realTokenReservesRaw: trade.realTokenReservesRaw || null,
    });
    this.metrics.tradesQueued += 1;
    if (this.rawBuffer.length >= this.config.flushMax) this.flushRawTrades();
  }

  flushRawTrades() {
    if (this.rawBuffer.length === 0) return 0;
    const trades = this.rawBuffer.splice(0, this.rawBuffer.length);
    const started = Date.now();
    try {
      this._writeTrades(trades);
      this.metrics.lastFlushAt = Date.now();
      this.metrics.lastFlushMs = this.metrics.lastFlushAt - started;
      for (const trade of trades) {
        const token = this.stmts.getToken.get(trade.mint);
        if (token) this.tokens.set(trade.mint, token);
      }
      return trades.length;
    } catch (error) {
      this.metrics.writeErrors += 1;
      this.rawBuffer.unshift(...trades);
      throw error;
    }
  }

  recordSignal(signal) {
    const createdAt = Date.now();
    const acceleration = [signal.flowAccel1, signal.flowAccel2].filter(Number.isFinite);
    const signalVariant = signal.signalVariant || 'primary_3w';
    const previous = this.stmts.latestSignalEpisode.get(signal.mint, signalVariant);
    const signalRankInMint = Number.isFinite(previous?.signal_rank_in_mint)
      ? previous.signal_rank_in_mint + 1
      : 1;
    const previousSignalGapMs = Number.isFinite(previous?.timestamp_ms)
      ? signal.timestampMs - previous.timestamp_ms
      : null;
    const signalRow = {
      ...signal,
      signalVariant,
      isPrimary: signal.isPrimary == null
        ? Number(signalVariant === 'primary_3w')
        : Number(signal.isPrimary !== false),
      flowAccel: Number.isFinite(signal.flowAccel)
        ? signal.flowAccel
        : acceleration.length ? Math.min(...acceleration) : null,
      signalEpisodeId: signal.signalEpisodeId
        || (Number.isFinite(previousSignalGapMs) && previousSignalGapMs <= 30_000
          ? previous.signal_episode_id
          : `${signal.mint}:${signalVariant}:${signal.timestampMs}`),
      signalRankInMint,
      previousSignalGapMs,
      createdAt,
    };
    const result = this.stmts.insertSignal.run(signalRow);
    const signalId = Number(result.lastInsertRowid);
    const costModel = this.labelsConfig.costModel
      ? normalizeCostModel(this.labelsConfig.costModel)
      : legacyCostModel(this.labelsConfig.configuredTradingCostPct);
    const configuredCostPct = costBreakdown(costModel).deterministicCostPct;
    this.stmts.insertReturn.run(
      signalId,
      signal.price,
      configuredCostPct,
      JSON.stringify(costModel),
      createdAt,
    );
    return { ...signalRow, signalId, configuredCostPct, costModel };
  }

  updateSignalReturn(signalId, patch) {
    const allowed = new Set([
      'return_1s', 'return_2s', 'return_3s', 'return_5s', 'return_8s',
      'return_10s', 'return_15s', 'return_20s', 'return_30s', 'return_60s',
      'net_return_1s', 'net_return_2s', 'net_return_3s', 'net_return_5s', 'net_return_8s',
      'net_return_10s', 'net_return_15s', 'net_return_20s', 'net_return_30s', 'net_return_60s',
      'mfe_5s', 'mae_5s', 'mfe_10s', 'mae_10s', 'mfe_30s', 'mae_30s',
      'last_observed_at', 'finalized_at', 'label_status', 'censor_reason',
      'missing_horizons_json', 'horizon_observation_lags_json',
    ]);
    const keys = Object.keys(patch).filter((key) => allowed.has(key));
    if (keys.length === 0) return;
    keys.sort();
    const cacheKey = keys.join(',');
    let statement = this.returnUpdateStatements.get(cacheKey);
    if (!statement) {
      statement = this.db.prepare(`
        UPDATE signal_returns SET
          ${keys.map((key) => `${key} = @${key}`).join(', ')},
          updated_at = @updatedAt
        WHERE signal_id = @signalId
      `);
      this.returnUpdateStatements.set(cacheKey, statement);
    }
    statement.run({ ...patch, signalId, updatedAt: Date.now() });
  }

  restorePendingSignals(now = Date.now()) {
    const maxHorizonMs = Math.max(0, ...(this.labelsConfig.horizonsSeconds || [])) * 1_000;
    const maxObservationLagMs = Math.max(
      0,
      Number(this.labelsConfig.maxObservationLagMs ?? 2_000),
    );
    const restoreLookbackMs = Math.max(120_000, maxHorizonMs + maxObservationLagMs + 60_000);
    return this.stmts.recentPendingSignals.all(now - restoreLookbackMs);
  }

  labelSamples(mint, startMs, endMs) {
    return this.stmts.labelSamples.all(mint, startMs, endMs);
  }

  findNearestSignal(mint, timestampMs, lookbackMs = 30_000) {
    return this.stmts.nearestSignal.get(mint, timestampMs, timestampMs - lookbackMs) || null;
  }

  recentCurveTrades(sinceMs) {
    const cached = this._startupReplayRows('curve', sinceMs);
    if (cached) return cached;
    this.startupTradeReplayStats.dbReads += 1;
    return this.stmts.recentCurveTrades.all(sinceMs);
  }

  primeStartupTradeReplay(sinceMs) {
    const normalizedSince = Math.max(0, Number(sinceMs) || 0);
    const startedAt = Date.now();
    const curve = this.stmts.recentCurveTrades.all(normalizedSince);
    const amm = this.stmts.recentAmmTrades.all(normalizedSince);
    this.startupTradeReplayCache = { sinceMs: normalizedSince, curve, amm };
    this.startupTradeReplayStats = {
      primed: true,
      active: true,
      sinceMs: normalizedSince,
      curveRows: curve.length,
      ammRows: amm.length,
      dbReads: 2,
      cacheHits: 0,
      primeDurationMs: Date.now() - startedAt,
      releasedAt: null,
    };
    return this.startupTradeReplayHealth();
  }

  releaseStartupTradeReplay() {
    this.startupTradeReplayCache = null;
    this.startupTradeReplayStats.active = false;
    this.startupTradeReplayStats.releasedAt = Date.now();
    return this.startupTradeReplayHealth();
  }

  startupTradeReplayHealth() {
    return { ...this.startupTradeReplayStats };
  }

  _startupReplayRows(market, sinceMs) {
    const cache = this.startupTradeReplayCache;
    const normalizedSince = Number(sinceMs) || 0;
    if (!cache || normalizedSince < cache.sinceMs) return null;
    const rows = market === 'curve' ? cache.curve : cache.amm;
    this.startupTradeReplayStats.cacheHits += 1;
    return rows
      .filter((row) => Number(row.timestampMs ?? row.timestamp_ms) >= normalizedSince)
      .map((row) => ({ ...row }));
  }

  launchMarketRegimeSnapshot({ startAt, cutoffAt, observedAt }) {
    return this.stmts.launchMarketRegimeSnapshot.get({ startAt, cutoffAt, observedAt });
  }

  recentAmmTrades(sinceMs) {
    const cached = this._startupReplayRows('amm', sinceMs);
    if (cached) return cached;
    this.startupTradeReplayStats.dbReads += 1;
    return this.stmts.recentAmmTrades.all(sinceMs);
  }

  recordSmartWalletEvent(trade) {
    const nearest = this.findNearestSignal(trade.mint, trade.timestampMs);
    const row = {
      timestampMs: trade.timestampMs,
      receivedAtMs: receivedTimestampMs(trade.receivedAtMs, trade.timestampMs),
      slot: trade.slot || null,
      signature: trade.signature || null,
      eventIndex: trade.eventIndex || 0,
      wallet: trade.wallet,
      mint: trade.mint,
      side: trade.side,
      market: trade.market || null,
      solAmount: trade.solAmount,
      tokenAmount: finiteOrNull(trade.tokenAmount),
      price: finiteOrNull(trade.price),
      curvePct: finiteOrNull(trade.curvePct),
      ageMs: Number.isFinite(trade.ageMs) ? trade.ageMs : null,
      positionPhase: null,
      tokenBalanceBefore: null,
      tokenBalanceAfter: null,
      nearestFlowSignal: nearest?.signal_id || null,
      timeFromFlowSignalMs: nearest ? trade.timestampMs - nearest.timestamp_ms : null,
    };
    return this._writeSmartWalletEvent(row);
  }

  recordSmartOpenDecision(decision) {
    const now = Date.now();
    const row = {
      smartEventId: decision.smartEventId,
      timestampMs: decision.timestampMs,
      receivedAtMs: decision.receivedAtMs || decision.timestampMs,
      wallet: decision.wallet,
      mint: decision.mint,
      ruleVersion: decision.ruleVersion,
      market: decision.market || null,
      positionPhase: decision.positionPhase || null,
      smartSol: decision.smartSol,
      smartPrice: finiteOrNull(decision.smartPrice),
      preBuyWindowMs: decision.preBuyWindowMs,
      preBuyers: decision.preBuyers,
      preBuyTx: decision.preBuyTx,
      preBuyFlowSol: decision.preBuyFlowSol,
      preSellFlowSol: decision.preSellFlowSol,
      preNetFlowSol: decision.preNetFlowSol,
      eventAgeMs: decision.eventAgeMs,
      ruleMatched: Number(decision.ruleMatched === true),
      rejectionReasonsJson: JSON.stringify(decision.rejectionReasons || []),
      mode: decision.mode,
      actionStatus: decision.actionStatus,
      actionReason: decision.actionReason || null,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertSmartOpenDecision.run(row);
    const saved = result.changes > 0
      ? { ...row, id: Number(result.lastInsertRowid) }
      : this.stmts.getSmartOpenDecisionByEvent.get(decision.smartEventId);
    return saved;
  }

  updateSmartOpenDecision(id, actionStatus, actionReason = null) {
    this.stmts.updateSmartOpenDecision.run({
      id,
      actionStatus,
      actionReason,
      updatedAt: Date.now(),
    });
  }

  recordPrimaryLiveDecision(decision) {
    const now = Date.now();
    const row = {
      signalId: decision.signalId,
      signalEpisodeId: decision.signalEpisodeId || null,
      timestampMs: decision.timestampMs,
      receivedAtMs: decision.receivedAtMs || decision.timestampMs,
      mint: decision.mint,
      symbol: decision.symbol || null,
      ruleVersion: decision.ruleVersion,
      signalVariant: decision.signalVariant,
      netFlowW3: decision.netFlowW3,
      uniqueBuyersW3: decision.uniqueBuyersW3,
      signalPrice: decision.signalPrice,
      signalAgeMs: decision.signalAgeMs,
      ruleMatched: Number(decision.ruleMatched === true),
      rejectionReasonsJson: JSON.stringify(decision.rejectionReasons || []),
      mode: decision.mode,
      actionStatus: decision.actionStatus,
      actionReason: decision.actionReason || null,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertPrimaryLiveDecision.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = row.signalEpisodeId
      ? this.stmts.getPrimaryLiveDecisionByEpisode.get(row.signalEpisodeId)
      : this.stmts.getPrimaryLiveDecisionBySignal.get(row.signalId);
    return existing ? { ...existing, inserted: false } : null;
  }

  updatePrimaryLiveDecision(id, actionStatus, actionReason = null) {
    this.stmts.updatePrimaryLiveDecision.run({
      id,
      actionStatus,
      actionReason,
      updatedAt: Date.now(),
    });
  }

  recordLiveStrategyDecision(decision) {
    const now = Date.now();
    const row = {
      strategyId: decision.strategyId,
      episodeId: decision.episodeId,
      timestampMs: decision.timestampMs,
      receivedAtMs: decision.receivedAtMs || decision.timestampMs,
      mint: decision.mint,
      symbol: decision.symbol || null,
      ruleVersion: decision.ruleVersion,
      market: decision.market,
      referencePrice: finiteOrNull(decision.referencePrice),
      featuresJson: JSON.stringify(decision.features || {}),
      ruleMatched: Number(decision.ruleMatched === true),
      rejectionReasonsJson: JSON.stringify(decision.rejectionReasons || []),
      mode: decision.mode,
      actionStatus: decision.actionStatus,
      actionReason: decision.actionReason || null,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertLiveStrategyDecision.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getLiveStrategyDecision.get(
      decision.strategyId,
      decision.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateLiveStrategyDecision(id, actionStatus, actionReason = null) {
    this.stmts.updateLiveStrategyDecision.run({
      id,
      actionStatus,
      actionReason,
      updatedAt: Date.now(),
    });
  }

  liveStrategyDecisionCountForMintStrategy(mint, strategyId) {
    return Number(
      this.stmts.liveStrategyDecisionCountForMintStrategy.get(mint, strategyId)?.n || 0,
    );
  }

  createLivePosition(position) {
    const now = Date.now();
    const row = {
      decisionId: position.decisionId || null,
      primaryDecisionId: position.primaryDecisionId || null,
      strategyDecisionId: position.strategyDecisionId || null,
      strategyId: position.strategyId || null,
      sourceType: position.sourceType || 'PRIMARY_SIGNAL',
      signalId: position.signalId || null,
      mint: position.mint,
      triggerWallet: position.triggerWallet || null,
      mode: position.mode,
      status: position.status || 'OPENING',
      positionSol: position.positionSol,
      entryMarket: position.entryMarket || 'PUMP_BONDING_CURVE',
      entryPrice: finiteOrNull(position.entryPrice),
      highestPrice: finiteOrNull(position.entryPrice),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertLivePosition.run(row);
    return { ...row, id: Number(result.lastInsertRowid) };
  }

  updateLivePosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    this.stmts.updateLivePosition.run({
      id,
      status: value('status'),
      tokenAmountRaw: value('tokenAmountRaw'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entrySignature: value('entrySignature'),
      entryError: value('entryError'),
      entrySolDelta: finiteOrNull(value('entrySolDelta')),
      highestPrice: finiteOrNull(value('highestPrice')),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitSignature: value('exitSignature'),
      exitReason: value('exitReason'),
      exitError: value('exitError'),
      exitSolDelta: finiteOrNull(value('exitSolDelta')),
      realizedPnlSol: finiteOrNull(value('realizedPnlSol')),
      realizedReturnPct: finiteOrNull(value('realizedReturnPct')),
      openedAt: value('openedAt'),
      exitRequestedAt: value('exitRequestedAt'),
      closedAt: value('closedAt'),
      updatedAt: Date.now(),
    });
  }

  activeLivePositions() {
    return this.stmts.activeLivePositions.all();
  }

  flowSignal(signalId) {
    return this.stmts.flowSignalById.get(signalId) || null;
  }

  reopenLivePositionForReconciliation(id, entryError) {
    this.stmts.reopenLivePositionForReconciliation.run({
      id,
      entryError,
      updatedAt: Date.now(),
    });
  }

  confirmedEmptyLivePositions() {
    return this.stmts.confirmedEmptyLivePositions.all();
  }

  lastLivePositionForMint(mint) {
    return this.stmts.lastLivePositionForMint.get(mint) || null;
  }

  successfulLiveEntryCountForMintStrategy(mint, strategyId) {
    return Number(
      this.stmts.successfulLiveEntryCountForMintStrategy.get(mint, strategyId)?.n || 0,
    );
  }

  lastSuccessfulLivePositionForMintStrategy(mint, strategyId) {
    return this.stmts.lastSuccessfulLivePositionForMintStrategy.get(mint, strategyId) || null;
  }

  recordLiveOrder(order) {
    const now = Date.now();
    const result = this.stmts.insertLiveOrder.run({
      positionId: order.positionId,
      decisionId: order.decisionId || null,
      primaryDecisionId: order.primaryDecisionId || null,
      strategyDecisionId: order.strategyDecisionId || null,
      strategyId: order.strategyId || null,
      mint: order.mint,
      side: order.side,
      venue: order.venue || null,
      attempt: order.attempt || 1,
      requestedSol: finiteOrNull(order.requestedSol),
      requestedTokenRaw: order.requestedTokenRaw || null,
      status: order.status,
      signature: order.signature || null,
      error: order.error || null,
      walletSolDelta: finiteOrNull(order.walletSolDelta),
      networkFeeSol: finiteOrNull(order.networkFeeSol),
      executionJson: order.execution ? JSON.stringify(order.execution) : null,
      submittedAt: order.submittedAt || null,
      confirmedAt: order.confirmedAt || null,
      createdAt: now,
      updatedAt: now,
    });
    return Number(result.lastInsertRowid);
  }

  updateLiveOrder(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    this.stmts.updateLiveOrder.run({
      id,
      status: value('status'),
      requestedTokenRaw: value('requestedTokenRaw'),
      error: value('error'),
      walletSolDelta: finiteOrNull(value('walletSolDelta')),
      networkFeeSol: finiteOrNull(value('networkFeeSol')),
      executionJson: value('execution') ? JSON.stringify(value('execution')) : null,
      confirmedAt: value('confirmedAt'),
      updatedAt: Date.now(),
    });
  }

  latestLiveOrderForPositionSide(positionId, side) {
    return this.stmts.latestLiveOrderForPositionSide.get(positionId, side) || null;
  }

  confirmedPartialLiveOrderForPosition(positionId) {
    return this.stmts.confirmedPartialLiveOrderForPosition.get(positionId) || null;
  }

  unsettledLiveOrders(limit = 500) {
    return this.db.prepare(`
      SELECT o.*
      FROM live_orders o
      JOIN live_positions p ON p.id = o.position_id
      WHERE p.mode = 'LIVE'
        AND o.signature IS NOT NULL
        AND o.wallet_sol_delta IS NULL
      ORDER BY o.id ASC
      LIMIT ?
    `).all(Math.min(2_000, Math.max(1, Math.trunc(Number(limit) || 500))));
  }

  refreshLivePositionSettlement(positionId) {
    const totals = this.db.prepare(`
      SELECT
        SUM(CASE WHEN side = 'BUY' THEN wallet_sol_delta ELSE 0 END) AS entry_delta,
        SUM(CASE WHEN side = 'SELL' THEN wallet_sol_delta ELSE 0 END) AS exit_delta,
        SUM(wallet_sol_delta) AS pnl_sol,
        SUM(side = 'BUY' AND wallet_sol_delta IS NOT NULL) AS settled_buys,
        SUM(side = 'SELL' AND wallet_sol_delta IS NOT NULL) AS settled_sells,
        SUM(signature IS NOT NULL AND wallet_sol_delta IS NULL) AS pending_settlements
      FROM live_orders
      WHERE position_id = ?
    `).get(positionId);
    const entryDelta = finiteOrNull(totals.entry_delta);
    const exitDelta = finiteOrNull(totals.exit_delta);
    const pnlSol = finiteOrNull(totals.pnl_sol);
    const position = this.db.prepare('SELECT status FROM live_positions WHERE id = ?').get(positionId);
    const complete = position?.status === 'CLOSED'
      && Number(totals.settled_buys) > 0
      && Number(totals.settled_sells) > 0
      && Number(totals.pending_settlements) === 0
      && entryDelta < 0;
    const realizedPnlSol = complete ? pnlSol : null;
    const realizedReturnPct = complete ? (pnlSol / Math.abs(entryDelta)) * 100 : null;
    this.db.prepare(`
      UPDATE live_positions SET
        entry_sol_delta = ?,
        exit_sol_delta = ?,
        realized_pnl_sol = ?,
        realized_return_pct = ?,
        updated_at = updated_at
      WHERE id = ?
    `).run(entryDelta, exitDelta, realizedPnlSol, realizedReturnPct, positionId);
    return {
      entrySolDelta: entryDelta,
      exitSolDelta: exitDelta,
      realizedPnlSol,
      realizedReturnPct,
      complete,
      pendingSettlements: Number(totals.pending_settlements) || 0,
    };
  }

  createPrimarySignalShadowPosition(position) {
    const now = Date.now();
    const row = {
      signalId: position.signalId,
      signalEpisodeId: position.signalEpisodeId || null,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      ruleMatched: Number(position.ruleMatched === true),
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      signalAt: position.signalAt,
      signalPrice: position.signalPrice,
      entryTargetAt: position.entryTargetAt || null,
      entryDeadlineAt: position.entryDeadlineAt || null,
      netFlowW3: finiteOrNull(position.netFlowW3),
      uniqueBuyersW3: Number.isFinite(position.uniqueBuyersW3)
        ? Math.trunc(position.uniqueBuyersW3)
        : null,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertPrimarySignalShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    if (row.signalEpisodeId) {
      const existing = this.stmts.getPrimarySignalShadowPositionByEpisode.get(row.signalEpisodeId);
      return existing ? { ...existing, inserted: false } : null;
    }
    const existing = this.stmts.getPrimarySignalShadowPositionBySignal.get(row.signalId);
    return existing ? { ...existing, inserted: false } : null;
  }

  updatePrimarySignalShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    this.stmts.updatePrimarySignalShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryTargetAt: value('entryTargetAt'),
      entryDeadlineAt: value('entryDeadlineAt'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      highestPrice: finiteOrNull(value('highestPrice')),
      smartConfirmedAt: value('smartConfirmedAt'),
      confirmingWalletsJson: value('confirmingWallets')
        ? JSON.stringify(value('confirmingWallets'))
        : value('confirmingWalletsJson'),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activePrimarySignalShadowPositions(signalVariant = 'primary_3w') {
    return this.stmts.activePrimarySignalShadowPositions.all(signalVariant);
  }

  createFlowFirstShadowPosition(position) {
    const now = Date.now();
    const row = {
      cohortId: position.cohortId,
      signalId: position.signalId,
      signalEpisodeId: position.signalEpisodeId,
      signalRankInMint: Number.isFinite(position.signalRankInMint)
        ? Math.trunc(position.signalRankInMint)
        : null,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      signalAt: position.signalAt,
      signalPrice: position.signalPrice,
      netFlowW3: finiteOrNull(position.netFlowW3),
      uniqueBuyersW3: Number.isFinite(position.uniqueBuyersW3)
        ? Math.trunc(position.uniqueBuyersW3)
        : null,
      entryTargetAt: position.entryTargetAt || null,
      entryDeadlineAt: position.entryDeadlineAt || null,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertFlowFirstShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getFlowFirstShadowPosition.get(
      row.cohortId,
      row.signalEpisodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateFlowFirstShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    this.stmts.updateFlowFirstShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeFlowFirstShadowPositions(cohortId) {
    return this.stmts.activeFlowFirstShadowPositions.all(cohortId);
  }

  createSmartPullbackShadowPosition(position) {
    const now = Date.now();
    const row = {
      cohortId: position.cohortId,
      episodeId: position.episodeId,
      smartEventId: position.smartEventId || null,
      smartWallet: position.smartWallet,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      smartBuyAt: position.smartBuyAt,
      smartBuyPrice: position.smartBuyPrice,
      smartBuySol: position.smartBuySol,
      confirmationDeadlineAt: position.confirmationDeadlineAt,
      peakBeforePullback: finiteOrNull(position.peakBeforePullback),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertSmartPullbackShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getSmartPullbackShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateSmartPullbackShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    this.stmts.updateSmartPullbackShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      peakBeforePullback: finiteOrNull(value('peakBeforePullback')),
      pullbackArmedAt: value('pullbackArmedAt'),
      pullbackLowPrice: finiteOrNull(value('pullbackLowPrice')),
      reboundBuyersJson: value('reboundBuyers')
        ? JSON.stringify(value('reboundBuyers'))
        : value('reboundBuyersJson'),
      confirmationAt: value('confirmationAt'),
      confirmationPrice: finiteOrNull(value('confirmationPrice')),
      entryTargetAt: value('entryTargetAt'),
      entryDeadlineAt: value('entryDeadlineAt'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      highestPrice: finiteOrNull(value('highestPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeSmartPullbackShadowPositions(cohortId) {
    return this.stmts.activeSmartPullbackShadowPositions.all(cohortId);
  }

  createSmartOpenShadowPosition(position) {
    const now = Date.now();
    const row = {
      cohortId: position.cohortId,
      smartEventId: position.smartEventId,
      smartWallet: position.smartWallet,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      smartOpenAt: position.smartOpenAt,
      smartOpenPrice: position.smartOpenPrice,
      smartOpenSol: position.smartOpenSol,
      curvePct: finiteOrNull(position.curvePct),
      ageMs: Number.isFinite(position.ageMs) ? Math.trunc(position.ageMs) : null,
      preBuyWindowMs: Math.max(1, Math.trunc(Number(position.preBuyWindowMs) || 1)),
      preBuyers: Math.max(0, Math.trunc(Number(position.preBuyers) || 0)),
      preBuyTx: Math.max(0, Math.trunc(Number(position.preBuyTx) || 0)),
      preBuyFlowSol: finiteOrNull(position.preBuyFlowSol) ?? 0,
      preSellFlowSol: finiteOrNull(position.preSellFlowSol) ?? 0,
      preNetFlowSol: finiteOrNull(position.preNetFlowSol) ?? 0,
      entryTargetAt: position.entryTargetAt || null,
      entryDeadlineAt: position.entryDeadlineAt || null,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertSmartOpenShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getSmartOpenShadowPosition.get(
      row.cohortId,
      row.smartEventId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateSmartOpenShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    this.stmts.updateSmartOpenShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryTargetAt: value('entryTargetAt'),
      entryDeadlineAt: value('entryDeadlineAt'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      trailingActivatedAt: value('trailingActivatedAt'),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeSmartOpenShadowPositions(cohortId) {
    return this.stmts.activeSmartOpenShadowPositions.all(cohortId);
  }

  createLaunchPullbackShadowPosition(position) {
    const now = Date.now();
    const row = {
      cohortId: position.cohortId,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      referenceProfileId: position.referenceProfileId || 'LEGACY_7_5_R3',
      referenceAt: position.referenceAt,
      referencePrice: position.referencePrice,
      pump25At: position.pump25At || null,
      referencePeakAt: position.referencePeakAt || null,
      referencePeakPrice: finiteOrNull(position.referencePeakPrice),
      firstPullbackAt: position.firstPullbackAt || null,
      pullbackLowPrice: finiteOrNull(position.pullbackLowPrice),
      maxPullbackPct: finiteOrNull(position.maxPullbackPct),
      referenceReboundPct: finiteOrNull(position.referenceReboundPct),
      lowStableMs: Number.isFinite(position.lowStableMs) ? Math.trunc(position.lowStableMs) : null,
      buyersSincePullbackLow: Number.isFinite(position.buyersSincePullbackLow)
        ? Math.trunc(position.buyersSincePullbackLow) : null,
      windowNetFlowSol: finiteOrNull(position.windowNetFlowSol),
      flowWindowMs: Number.isFinite(position.flowWindowMs)
        ? Math.trunc(position.flowWindowMs) : null,
      netFlowSol: finiteOrNull(position.netFlowSol),
      creatorSharePct: finiteOrNull(position.creatorSharePct),
      buyers: Number.isFinite(position.buyers) ? Math.trunc(position.buyers) : null,
      recentBuyers: Number.isFinite(position.recentBuyers)
        ? Math.trunc(position.recentBuyers) : null,
      retentionPct: finiteOrNull(position.retentionPct),
      top1SharePct: finiteOrNull(position.top1SharePct),
      top3SharePct: finiteOrNull(position.top3SharePct),
      sellSolSincePeak: finiteOrNull(position.sellSolSincePeak),
      buySolSincePeak: finiteOrNull(position.buySolSincePeak),
      buyRefillRatio: finiteOrNull(position.buyRefillRatio),
      recentNetFlow1s: finiteOrNull(position.recentNetFlow1s),
      previousNetFlow1s: finiteOrNull(position.previousNetFlow1s),
      netFlowAcceleration1s: finiteOrNull(position.netFlowAcceleration1s),
      marketRegimeObservedAt: Number.isFinite(position.marketRegimeObservedAt)
        ? Math.trunc(position.marketRegimeObservedAt) : null,
      marketRegimeIndependentMints: Number.isFinite(position.marketRegimeIndependentMints)
        ? Math.trunc(position.marketRegimeIndependentMints) : null,
      marketRegimeAverageNetReturn5s: finiteOrNull(position.marketRegimeAverageNetReturn5s),
      marketRegimeWinRate5s: finiteOrNull(position.marketRegimeWinRate5s),
      marketRegimeBig20Rate5s: finiteOrNull(position.marketRegimeBig20Rate5s),
      flowConfirmationAt: Number.isFinite(position.flowConfirmationAt)
        ? Math.trunc(position.flowConfirmationAt) : null,
      flowConfirmationVariant: position.flowConfirmationVariant || null,
      flowConfirmationBuyersW3: Number.isFinite(position.flowConfirmationBuyersW3)
        ? Math.trunc(position.flowConfirmationBuyersW3) : null,
      flowConfirmationNetFlowW3: finiteOrNull(position.flowConfirmationNetFlowW3),
      flowConfirmationWindowMs: Number.isFinite(position.flowConfirmationWindowMs)
        ? Math.trunc(position.flowConfirmationWindowMs) : null,
      entryTargetAt: position.entryTargetAt || null,
      entryDeadlineAt: position.entryDeadlineAt || null,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertLaunchPullbackShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getLaunchPullbackShadowPosition.get(row.cohortId, row.mint);
    return existing ? { ...existing, inserted: false } : null;
  }

  updateLaunchPullbackShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.stmts.updateLaunchPullbackShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeLaunchPullbackShadowPositions(cohortId) {
    return this.stmts.activeLaunchPullbackShadowPositions.all(cohortId);
  }

  createMigratedDropReboundShadowPosition(position) {
    const now = Date.now();
    const nullableInteger = (value) => (Number.isFinite(value) ? Math.trunc(value) : null);
    const row = {
      cohortId: position.cohortId,
      lifecycleStage: position.lifecycleStage || 'POST_MIGRATION',
      entryProfileId: position.entryProfileId,
      exitProfileId: position.exitProfileId,
      episodeId: position.episodeId,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      confirmationJson: position.confirmationJson || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      migratedAt: Math.trunc(position.migratedAt),
      migrationAgeMs: Math.max(0, Math.trunc(position.migrationAgeMs)),
      windowMs: Math.trunc(position.windowMs),
      dropMinPct: position.dropMinPct,
      dropMaxPct: position.dropMaxPct,
      reboundMinPct: position.reboundMinPct,
      reboundMaxPct: position.reboundMaxPct,
      reboundTimeoutMs: Math.trunc(position.reboundTimeoutMs),
      peakAt: Math.trunc(position.peakAt),
      peakPrice: position.peakPrice,
      lowAt: Math.trunc(position.lowAt),
      lowPrice: position.lowPrice,
      dropPct: position.dropPct,
      reboundAt: Math.trunc(position.reboundAt),
      reboundPrice: position.reboundPrice,
      reboundPct: position.reboundPct,
      reboundElapsedMs: Math.max(0, Math.trunc(position.reboundElapsedMs)),
      reboundFromLowMs: Math.max(0, Math.trunc(position.reboundFromLowMs)),
      entryTargetAt: Math.trunc(position.entryTargetAt),
      entryDeadlineAt: Math.trunc(position.entryDeadlineAt),
      exitMode: position.exitMode,
      fixedHoldMs: nullableInteger(position.fixedHoldMs),
      trailingActivationPct: finiteOrNull(position.trailingActivationPct),
      trailingStopPct: finiteOrNull(position.trailingStopPct),
      hardStopPct: finiteOrNull(position.hardStopPct),
      fastTakeProfitPct: finiteOrNull(position.fastTakeProfitPct),
      fastTakeProfitWindowMs: nullableInteger(position.fastTakeProfitWindowMs),
      lossCheckAtMs: nullableInteger(position.lossCheckAtMs),
      lossCheckRecoveryPct: finiteOrNull(position.lossCheckRecoveryPct),
      maxHoldMs: nullableInteger(position.maxHoldMs),
      coreWeightPct: finiteOrNull(position.coreWeightPct),
      runnerHoldMs: nullableInteger(position.runnerHoldMs),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertMigratedDropReboundShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getMigratedDropReboundShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateMigratedDropReboundShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.stmts.updateMigratedDropReboundShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      confirmationJson: value('confirmationJson'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      entryImpactPct: finiteOrNull(value('entryImpactPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'),
      lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      trailingActivatedAt: value('trailingActivatedAt'),
      coreExitTargetAt: value('coreExitTargetAt'),
      coreExitAt: value('coreExitAt'),
      coreExitPrice: finiteOrNull(value('coreExitPrice')),
      coreExitReason: value('coreExitReason'),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitImpactPct: finiteOrNull(value('exitImpactPct')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeMigratedDropReboundShadowPositions() {
    return this.stmts.activeMigratedDropReboundShadowPositions.all();
  }

  migratedDropReboundShadowSignalCount(lifecycleStage, entryProfileId, mint) {
    return Number(this.stmts.countMigratedDropReboundShadowSignals.get(
      lifecycleStage,
      entryProfileId,
      mint,
    )?.count || 0);
  }

  createMigrationContinuityShadowPosition(position) {
    const now = Date.now();
    const nullableInteger = (value) => (Number.isFinite(value) ? Math.trunc(value) : null);
    const row = {
      cohortId: position.cohortId,
      exitProfileId: position.exitProfileId,
      episodeId: position.episodeId,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      graduatedAt: Math.trunc(position.graduatedAt),
      signalAt: Math.trunc(position.signalAt),
      signalPrice: position.signalPrice,
      entryBuyers: Math.max(0, Math.trunc(position.entryBuyers || 0)),
      entryBuySol: finiteOrNull(position.entryBuySol) ?? 0,
      entrySellSol: finiteOrNull(position.entrySellSol) ?? 0,
      entryNetFlowSol: finiteOrNull(position.entryNetFlowSol) ?? 0,
      entrySellBuyRatio: finiteOrNull(position.entrySellBuyRatio) ?? 0,
      entryReturnPct: finiteOrNull(position.entryReturnPct) ?? 0,
      entryTargetAt: Math.trunc(position.entryTargetAt),
      entryDeadlineAt: Math.trunc(position.entryDeadlineAt),
      exitMode: position.exitMode,
      minHoldMs: nullableInteger(position.minHoldMs),
      fixedHoldMs: nullableInteger(position.fixedHoldMs),
      trailingActivationPct: finiteOrNull(position.trailingActivationPct),
      trailingStopPct: finiteOrNull(position.trailingStopPct),
      hardStopPct: finiteOrNull(position.hardStopPct),
      maxHoldMs: nullableInteger(position.maxHoldMs),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertMigrationContinuityShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getMigrationContinuityShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateMigrationContinuityShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.stmts.updateMigrationContinuityShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'),
      lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      trailingActivatedAt: value('trailingActivatedAt'),
      fixedHoldMs: Number.isFinite(value('fixedHoldMs'))
        ? Math.trunc(value('fixedHoldMs'))
        : null,
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeMigrationContinuityShadowPositions() {
    return this.stmts.activeMigrationContinuityShadowPositions.all();
  }

  hasMigrationContinuityShadowSignal(mint) {
    return Boolean(this.stmts.hasMigrationContinuityShadowSignal.get(mint));
  }

  createRangeScalperShadowPosition(position) {
    const now = Date.now();
    const features = position.features || {};
    const row = {
      cohortId: position.cohortId,
      entryProfileId: position.entryProfileId,
      exitProfileId: position.exitProfileId,
      episodeId: position.episodeId,
      swingIndex: Math.max(1, Math.trunc(position.swingIndex || 1)),
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      migratedAt: Math.trunc(position.migratedAt),
      signalAt: Math.trunc(position.signalAt),
      signalPrice: position.signalPrice,
      rangeScore: finiteOrNull(position.rangeScore) ?? 0,
      windowMs: Math.max(1, Math.trunc(position.windowMs)),
      tradeCount: Math.max(0, Math.trunc(position.tradeCount || 0)),
      volumeSol: finiteOrNull(position.volumeSol) ?? 0,
      uniqueWallets: Math.max(0, Math.trunc(position.uniqueWallets || 0)),
      buySharePct: finiteOrNull(position.buySharePct) ?? 0,
      rangePct: finiteOrNull(position.rangePct) ?? 0,
      efficiencyRatio: finiteOrNull(position.efficiencyRatio) ?? 0,
      meanCrosses: Math.max(0, Math.trunc(position.meanCrosses || 0)),
      topWalletSharePct: finiteOrNull(position.topWalletSharePct) ?? 0,
      trendPct: finiteOrNull(position.trendPct) ?? 0,
      midlinePrice: position.midlinePrice,
      lowerBandPrice: position.lowerBandPrice,
      upperBandPrice: position.upperBandPrice,
      deviationSigma: finiteOrNull(position.deviationSigma) ?? 0,
      reboundPct: finiteOrNull(position.reboundPct) ?? 0,
      recentNetFlowSol: finiteOrNull(position.recentNetFlowSol) ?? 0,
      recentBuyers: Math.max(0, Math.trunc(position.recentBuyers || 0)),
      sellDecayRatio: finiteOrNull(position.sellDecayRatio),
      featuresJson: JSON.stringify(features),
      entryTargetAt: Math.trunc(position.entryTargetAt),
      entryDeadlineAt: Math.trunc(position.entryDeadlineAt),
      exitMode: position.exitMode,
      takeProfitPct: finiteOrNull(position.takeProfitPct),
      hardStopPct: finiteOrNull(position.hardStopPct) ?? 0,
      maxHoldMs: Math.max(1, Math.trunc(position.maxHoldMs)),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertRangeScalperShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getRangeScalperShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateRangeScalperShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.stmts.updateRangeScalperShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'),
      lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeRangeScalperShadowPositions() {
    return this.stmts.activeRangeScalperShadowPositions.all();
  }

  rangeScalperMaxSwingIndex(entryProfileId, mint) {
    return Number(this.stmts.maxRangeScalperSwingIndex.get(
      entryProfileId,
      mint,
    )?.max_swing_index || 0);
  }

  createFlowSmartConfirmShadowPosition(position) {
    const now = Date.now();
    const row = {
      cohortId: position.cohortId,
      smartEventId: position.smartEventId,
      signalId: position.signalId,
      smartWallet: position.smartWallet,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      signalAt: position.signalAt,
      signalPrice: position.signalPrice,
      signalRankInMint: Number.isFinite(position.signalRankInMint)
        ? Math.trunc(position.signalRankInMint) : null,
      signalVariant: position.signalVariant,
      netFlowW3: finiteOrNull(position.netFlowW3),
      uniqueBuyersW3: Number.isFinite(position.uniqueBuyersW3)
        ? Math.trunc(position.uniqueBuyersW3) : null,
      smartOpenAt: position.smartOpenAt,
      smartOpenPrice: position.smartOpenPrice,
      smartOpenSol: position.smartOpenSol,
      confirmationDelayMs: Math.trunc(position.confirmationDelayMs),
      curvePct: finiteOrNull(position.curvePct),
      ageMs: Number.isFinite(position.ageMs) ? Math.trunc(position.ageMs) : null,
      entryTargetAt: position.entryTargetAt || null,
      entryDeadlineAt: position.entryDeadlineAt || null,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertFlowSmartConfirmShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getFlowSmartConfirmShadowPosition.get(
      row.cohortId,
      row.smartEventId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateFlowSmartConfirmShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.stmts.updateFlowSmartConfirmShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeFlowSmartConfirmShadowPositions(cohortId) {
    return this.stmts.activeFlowSmartConfirmShadowPositions.all(cohortId);
  }

  createCyaEarlyPyramidShadowPosition(position) {
    const now = Date.now();
    const features = position.features || {};
    const row = {
      cohortId: position.cohortId,
      entryProfileId: position.entryProfileId,
      exitProfileId: position.exitProfileId,
      episodeId: position.episodeId,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      signalAt: Math.trunc(position.signalAt),
      signalPrice: position.signalPrice,
      ageMs: Number.isFinite(features.ageMs) ? Math.trunc(features.ageMs) : null,
      curvePct: finiteOrNull(features.curvePct),
      buyers1s: Math.max(0, Math.trunc(features.buyers1s || 0)),
      buyers5s: Math.max(0, Math.trunc(features.buyers5s || 0)),
      netFlow1s: finiteOrNull(features.netFlow1s) ?? 0,
      netFlow5s: finiteOrNull(features.netFlow5s) ?? 0,
      return2sPct: finiteOrNull(features.return2sPct),
      featuresJson: JSON.stringify(features),
      entryTargetAt: Math.trunc(position.entryTargetAt),
      entryDeadlineAt: Math.trunc(position.entryDeadlineAt),
      trailingStopPct: position.trailingStopPct,
      hardStopPct: position.hardStopPct,
      noStrengthMs: Math.trunc(position.noStrengthMs),
      noStrengthMfePct: position.noStrengthMfePct,
      maxHoldMs: Math.trunc(position.maxHoldMs),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertCyaEarlyPyramidShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getCyaEarlyPyramidShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateCyaEarlyPyramidShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.stmts.updateCyaEarlyPyramidShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      averageEntryPrice: finiteOrNull(value('averageEntryPrice')),
      totalInvestedSol: finiteOrNull(value('totalInvestedSol')),
      tokenUnits: finiteOrNull(value('tokenUnits')),
      remainingTokenUnits: finiteOrNull(value('remainingTokenUnits')),
      realizedProceedsSol: finiteOrNull(value('realizedProceedsSol')),
      addCount: value('addCount'),
      lastAddAt: value('lastAddAt'),
      lastAddPrice: finiteOrNull(value('lastAddPrice')),
      firstTakeProfitAt: value('firstTakeProfitAt'),
      firstTakeProfitPrice: finiteOrNull(value('firstTakeProfitPrice')),
      secondTakeProfitAt: value('secondTakeProfitAt'),
      secondTakeProfitPrice: finiteOrNull(value('secondTakeProfitPrice')),
      scaleOutCount: value('scaleOutCount'),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'),
      lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      estimatedCostSol: finiteOrNull(value('estimatedCostSol')),
      updatedAt: Date.now(),
    });
  }

  updateLiveOrderSettlement(id, settlement) {
    this.db.prepare(`
      UPDATE live_orders SET
        wallet_sol_delta = ?,
        network_fee_sol = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      finiteOrNull(settlement?.walletSolDelta),
      finiteOrNull(settlement?.networkFeeSol),
      Date.now(),
      id,
    );
  }

  activeCyaEarlyPyramidShadowPositions() {
    return this.stmts.activeCyaEarlyPyramidShadowPositions.all();
  }

  createBondingCurveMomentumShadowPosition(position) {
    const now = Date.now();
    const features = position.features || {};
    const nullableInteger = (value) => (Number.isFinite(value) ? Math.trunc(value) : null);
    const row = {
      cohortId: position.cohortId,
      entryProfileId: position.entryProfileId,
      exitProfileId: position.exitProfileId,
      episodeId: position.episodeId,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      signalAt: Math.trunc(position.signalAt),
      signalPrice: position.signalPrice,
      ageMs: nullableInteger(features.ageMs),
      curvePct: finiteOrNull(features.curvePct),
      virtualSolReserves: finiteOrNull(features.virtualSolReserves),
      netFlow1s: finiteOrNull(features.netFlow1s) ?? 0,
      priorNetFlow1s: finiteOrNull(features.priorNetFlow1s) ?? 0,
      flowAccel1s: finiteOrNull(features.flowAccel1s) ?? 0,
      buySol1s: finiteOrNull(features.buySol1s) ?? 0,
      sellSol1s: finiteOrNull(features.sellSol1s) ?? 0,
      priorSellSol1s: finiteOrNull(features.priorSellSol1s) ?? 0,
      sellDecayRatio: finiteOrNull(features.sellDecayRatio) ?? 0,
      buyers1s: Math.max(0, Math.trunc(features.buyers1s || 0)),
      newBuyers1s: Math.max(0, Math.trunc(features.newBuyers1s || 0)),
      buyTx1s: Math.max(0, Math.trunc(features.buyTx1s || 0)),
      priorBuyTx1s: Math.max(0, Math.trunc(features.priorBuyTx1s || 0)),
      buyTxAccel1s: Math.trunc(features.buyTxAccel1s || 0),
      top1SharePct: finiteOrNull(features.top1SharePct),
      featuresJson: JSON.stringify(features),
      entryTargetAt: Math.trunc(position.entryTargetAt),
      entryDeadlineAt: Math.trunc(position.entryDeadlineAt),
      exitMode: position.exitMode,
      fixedHoldMs: nullableInteger(position.fixedHoldMs),
      minHoldMs: nullableInteger(position.minHoldMs),
      maxHoldMs: Math.trunc(position.maxHoldMs ?? position.fixedHoldMs),
      trailingActivationPct: finiteOrNull(position.trailingActivationPct),
      trailingStopPct: finiteOrNull(position.trailingStopPct),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertBondingCurveMomentumShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getBondingCurveMomentumShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateBondingCurveMomentumShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.stmts.updateBondingCurveMomentumShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'),
      lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      trailingActivatedAt: value('trailingActivatedAt'),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeBondingCurveMomentumShadowPositions() {
    return this.stmts.activeBondingCurveMomentumShadowPositions.all();
  }

  createGraduationHoldShadowPosition(position) {
    const now = Date.now();
    const nullableInteger = (value) => (Number.isFinite(value) ? Math.trunc(value) : null);
    const row = {
      cohortId: position.cohortId,
      episodeId: position.episodeId,
      signalId: Math.trunc(position.signalId),
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: position.positionSol,
      configuredCostPct: position.configuredCostPct,
      signalAt: Math.trunc(position.signalAt),
      signalPrice: position.signalPrice,
      signalCurvePct: finiteOrNull(position.signalCurvePct),
      signalNetFlowW3: finiteOrNull(position.signalNetFlowW3),
      signalBuyersW3: nullableInteger(position.signalBuyersW3),
      entryTargetAt: nullableInteger(position.entryTargetAt),
      entryDeadlineAt: nullableInteger(position.entryDeadlineAt),
      exitMode: position.exitMode,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertGraduationHoldShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getGraduationHoldShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateGraduationHoldShadowPosition(id, patch = {}) {
    const owns = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    const value = (key) => (owns(key) ? patch[key] : null);
    let checkpointHistoryJson = null;
    if (patch.appendCheckpointHistory) {
      const current = this.stmts.getGraduationHoldShadowPositionById.get(id);
      let history = [];
      try {
        history = JSON.parse(current?.checkpoint_history_json || '[]');
        if (!Array.isArray(history)) history = [];
      } catch (_) {
        history = [];
      }
      history.push(patch.appendCheckpointHistory);
      checkpointHistoryJson = JSON.stringify(history.slice(-20));
    }
    return this.stmts.updateGraduationHoldShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'),
      lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      currentCheckpointPct: finiteOrNull(value('currentCheckpointPct')),
      nextCheckpointPct: finiteOrNull(value('nextCheckpointPct')),
      clearNextCheckpoint: owns('nextCheckpointPct') && patch.nextCheckpointPct == null ? 1 : 0,
      checkpointDeadlineAt: value('checkpointDeadlineAt'),
      clearCheckpointDeadline: owns('checkpointDeadlineAt')
        && patch.checkpointDeadlineAt == null ? 1 : 0,
      gatesPassed: value('gatesPassed'),
      lastGateAt: value('lastGateAt'),
      lastGatePass: value('lastGatePass'),
      lastFeaturesJson: value('lastFeaturesJson'),
      checkpointHistoryJson,
      graduationReady: value('graduationReady'),
      graduatedAt: value('graduatedAt'),
      exitTargetMarket: value('exitTargetMarket'),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeGraduationHoldShadowPositions() {
    return this.stmts.activeGraduationHoldShadowPositions.all();
  }

  recentBondingCurveMomentumEpisodes(sinceMs) {
    return this.stmts.recentBondingCurveMomentumEpisodes.all(sinceMs);
  }

  bondingCurveMomentumSnapshotHorizons(episodeId) {
    return this.stmts.bondingCurveMomentumSnapshotHorizons
      .all(episodeId).map((row) => row.horizon_ms);
  }

  recordBondingCurveMomentumShadowSnapshot(snapshot) {
    const features = snapshot.features || {};
    const row = {
      episodeId: snapshot.episodeId,
      entryProfileId: snapshot.entryProfileId,
      mint: snapshot.mint,
      horizonMs: Math.trunc(snapshot.horizonMs),
      status: snapshot.status,
      targetAt: Math.trunc(snapshot.targetAt),
      observedAt: Number.isFinite(snapshot.observedAt) ? Math.trunc(snapshot.observedAt) : null,
      observationLagMs: Number.isFinite(snapshot.observationLagMs)
        ? Math.max(0, Math.trunc(snapshot.observationLagMs)) : null,
      market: snapshot.market || null,
      price: finiteOrNull(snapshot.price),
      grossReturnPct: finiteOrNull(snapshot.grossReturnPct),
      maxFavorableReturnPct: finiteOrNull(snapshot.maxFavorableReturnPct),
      maxAdverseReturnPct: finiteOrNull(snapshot.maxAdverseReturnPct),
      netFlow1s: finiteOrNull(features.netFlow1s),
      flowAccel1s: finiteOrNull(features.flowAccel1s),
      buyers1s: Number.isFinite(features.buyers1s) ? Math.trunc(features.buyers1s) : null,
      newBuyers1s: Number.isFinite(features.newBuyers1s)
        ? Math.trunc(features.newBuyers1s) : null,
      buyTxAccel1s: Number.isFinite(features.buyTxAccel1s)
        ? Math.trunc(features.buyTxAccel1s) : null,
      sellDecayRatio: finiteOrNull(features.sellDecayRatio),
      curvePct: finiteOrNull(features.curvePct),
      virtualSolReserves: finiteOrNull(features.virtualSolReserves),
      featuresJson: snapshot.features ? JSON.stringify(features) : null,
      createdAt: Date.now(),
    };
    const result = this.stmts.insertBondingCurveMomentumShadowSnapshot.run(row);
    return { ...row, inserted: result.changes > 0 };
  }

  createHolderGrowthShadowPosition(position) {
    const now = Date.now();
    const nullableInteger = (value) => (Number.isFinite(value) ? Math.trunc(value) : null);
    const row = {
      cohortId: position.cohortId,
      entryProfileId: position.entryProfileId,
      exitProfileId: position.exitProfileId,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: finiteOrNull(position.positionSol) ?? 1,
      configuredCostPct: finiteOrNull(position.configuredCostPct) ?? 0,
      horizonMs: Math.max(1, Math.trunc(Number(position.horizonMs) || 1)),
      signalAt: Math.trunc(position.signalAt),
      signalPrice: position.signalPrice,
      observationLagMs: Math.max(0, Math.trunc(position.observationLagMs || 0)),
      buyers: Math.max(0, Math.trunc(position.buyers || 0)),
      newBuyers: Math.max(0, Math.trunc(position.newBuyers || 0)),
      retentionPct: finiteOrNull(position.retentionPct) ?? 0,
      netFlowSol: finiteOrNull(position.netFlowSol) ?? 0,
      top3SharePct: finiteOrNull(position.top3SharePct) ?? 100,
      curvePct: finiteOrNull(position.curvePct),
      virtualSolReserves: finiteOrNull(position.virtualSolReserves),
      featuresJson: JSON.stringify(position.features || {}),
      entryTargetAt: Math.trunc(position.entryTargetAt),
      entryDeadlineAt: Math.trunc(position.entryDeadlineAt),
      exitMode: position.exitMode || 'TRAILING',
      fixedHoldMs: nullableInteger(position.fixedHoldMs),
      hardStopPct: finiteOrNull(position.hardStopPct) ?? 20,
      trailingActivationPct: finiteOrNull(position.trailingActivationPct) ?? 15,
      trailingStopPct: finiteOrNull(position.trailingStopPct) ?? 15,
      trailingTiersJson: Array.isArray(position.trailingTiers)
        ? JSON.stringify(position.trailingTiers) : null,
      trailingTierIndex: Number.isFinite(position.trailingTierIndex)
        ? Math.trunc(position.trailingTierIndex) : -1,
      stopPrice: finiteOrNull(position.stopPrice),
      scaleOutTriggerPct: finiteOrNull(position.scaleOutTriggerPct),
      scaleOutFractionPct: finiteOrNull(position.scaleOutFractionPct),
      partialExitTargetAt: nullableInteger(position.partialExitTargetAt),
      partialExitDeadlineAt: nullableInteger(position.partialExitDeadlineAt),
      scaleOutAt: nullableInteger(position.scaleOutAt),
      scaleOutPrice: finiteOrNull(position.scaleOutPrice),
      flowCheckHorizonMs: nullableInteger(position.flowCheckHorizonMs),
      minBuyerVelocityRatio: finiteOrNull(position.minBuyerVelocityRatio),
      minNetFlowDeltaSol: finiteOrNull(position.minNetFlowDeltaSol),
      flowCheckAt: nullableInteger(position.flowCheckAt),
      flowCheckStatus: position.flowCheckStatus || null,
      flowBuyerVelocityRatio: finiteOrNull(position.flowBuyerVelocityRatio),
      flowNetFlowDeltaSol: finiteOrNull(position.flowNetFlowDeltaSol),
      maxHoldMs: Math.max(1, Math.trunc(position.maxHoldMs || 120_000)),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertHolderGrowthShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getHolderGrowthShadowPosition.get(
      row.cohortId,
      row.mint,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateHolderGrowthShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.stmts.updateHolderGrowthShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'),
      lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      trailingActivatedAt: value('trailingActivatedAt'),
      trailingTierIndex: value('trailingTierIndex'),
      stopPrice: finiteOrNull(value('stopPrice')),
      partialExitTargetAt: value('partialExitTargetAt'),
      partialExitDeadlineAt: value('partialExitDeadlineAt'),
      clearPartialExitPending: patch.clearPartialExitPending ? 1 : 0,
      scaleOutAt: value('scaleOutAt'),
      scaleOutPrice: finiteOrNull(value('scaleOutPrice')),
      flowCheckAt: value('flowCheckAt'),
      flowCheckStatus: value('flowCheckStatus'),
      flowBuyerVelocityRatio: finiteOrNull(value('flowBuyerVelocityRatio')),
      flowNetFlowDeltaSol: finiteOrNull(value('flowNetFlowDeltaSol')),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeHolderGrowthShadowPositions() {
    return this.stmts.activeHolderGrowthShadowPositions.all();
  }

  createQualityLeaderShadowPosition(position) {
    const now = Date.now();
    const row = {
      cohortId: position.cohortId,
      entryProfileId: position.entryProfileId,
      exitProfileId: position.exitProfileId,
      mint: position.mint,
      symbol: position.symbol || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: finiteOrNull(position.positionSol) ?? 1,
      configuredCostPct: finiteOrNull(position.configuredCostPct) ?? 0,
      signalAt: Math.trunc(position.signalAt),
      signalPrice: finiteOrNull(position.signalPrice),
      return10Pct: finiteOrNull(position.return10Pct),
      drawdown20Pct: finiteOrNull(position.drawdown20Pct),
      buyers10: Math.max(0, Math.trunc(position.buyers10 || 0)),
      buyers20: Math.max(0, Math.trunc(position.buyers20 || 0)),
      buyerDelta: Math.trunc(position.buyerDelta || 0),
      netFlow10Sol: finiteOrNull(position.netFlow10Sol),
      netFlow20Sol: finiteOrNull(position.netFlow20Sol),
      netFlowDeltaSol: finiteOrNull(position.netFlowDeltaSol),
      retention20Pct: finiteOrNull(position.retention20Pct),
      creatorShare20Pct: finiteOrNull(position.creatorShare20Pct),
      curve20Pct: finiteOrNull(position.curve20Pct),
      sellBuyRatio20: finiteOrNull(position.sellBuyRatio20),
      virtualSol20: finiteOrNull(position.virtualSol20),
      featuresJson: JSON.stringify(position.features || {}),
      entryTargetAt: Math.trunc(position.entryTargetAt),
      entryDeadlineAt: Math.trunc(position.entryDeadlineAt),
      createdAt: now,
      updatedAt: now,
    };
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO quality_leader_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, mint, symbol,
        status, rejection_reason, position_sol, configured_cost_pct,
        signal_at, signal_price, return_10_pct, drawdown_20_pct,
        buyers_10, buyers_20, buyer_delta, net_flow_10_sol, net_flow_20_sol,
        net_flow_delta_sol, retention_20_pct, creator_share_20_pct,
        curve_20_pct, sell_buy_ratio_20, virtual_sol_20, features_json,
        entry_target_at, entry_deadline_at, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @mint, @symbol,
        @status, @rejectionReason, @positionSol, @configuredCostPct,
        @signalAt, @signalPrice, @return10Pct, @drawdown20Pct,
        @buyers10, @buyers20, @buyerDelta, @netFlow10Sol, @netFlow20Sol,
        @netFlowDeltaSol, @retention20Pct, @creatorShare20Pct,
        @curve20Pct, @sellBuyRatio20, @virtualSol20, @featuresJson,
        @entryTargetAt, @entryDeadlineAt, @createdAt, @updatedAt
      )
    `);
    const result = statement.run(row);
    if (result.changes > 0) return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    const existing = this.db.prepare(`
      SELECT * FROM quality_leader_shadow_positions WHERE cohort_id = ? AND mint = ?
    `).get(row.cohortId, row.mint);
    return existing ? { ...existing, inserted: false } : null;
  }

  updateQualityLeaderShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : null);
    return this.db.prepare(`
      UPDATE quality_leader_shadow_positions SET
        status = COALESCE(@status, status),
        rejection_reason = COALESCE(@rejectionReason, rejection_reason),
        entry_at = COALESCE(@entryAt, entry_at),
        entry_market = COALESCE(@entryMarket, entry_market),
        entry_price = COALESCE(@entryPrice, entry_price),
        entry_jump_pct = COALESCE(@entryJumpPct, entry_jump_pct),
        entry_impact_pct = COALESCE(@entryImpactPct, entry_impact_pct),
        highest_price = COALESCE(@highestPrice, highest_price),
        lowest_price = COALESCE(@lowestPrice, lowest_price),
        last_observed_at = COALESCE(@lastObservedAt, last_observed_at),
        last_price = COALESCE(@lastPrice, last_price),
        max_favorable_return_pct = COALESCE(@maxFavorableReturnPct, max_favorable_return_pct),
        max_adverse_return_pct = COALESCE(@maxAdverseReturnPct, max_adverse_return_pct),
        partial_stage = COALESCE(@partialStage, partial_stage),
        pending_partial_stage = COALESCE(@pendingPartialStage, pending_partial_stage),
        partial_exit_target_at = CASE WHEN @clearPartialExitPending = 1
          THEN NULL ELSE COALESCE(@partialExitTargetAt, partial_exit_target_at) END,
        partial_exit_deadline_at = CASE WHEN @clearPartialExitPending = 1
          THEN NULL ELSE COALESCE(@partialExitDeadlineAt, partial_exit_deadline_at) END,
        scale1_at = COALESCE(@scale1At, scale1_at),
        scale1_price = COALESCE(@scale1Price, scale1_price),
        scale2_at = COALESCE(@scale2At, scale2_at),
        scale2_price = COALESCE(@scale2Price, scale2_price),
        graduated_at = COALESCE(@graduatedAt, graduated_at),
        last_curve_price = COALESCE(@lastCurvePrice, last_curve_price),
        amm_price_scale = COALESCE(@ammPriceScale, amm_price_scale),
        exit_target_market = COALESCE(@exitTargetMarket, exit_target_market),
        exit_trigger_at = COALESCE(@exitTriggerAt, exit_trigger_at),
        exit_target_at = COALESCE(@exitTargetAt, exit_target_at),
        exit_deadline_at = COALESCE(@exitDeadlineAt, exit_deadline_at),
        exit_at = COALESCE(@exitAt, exit_at),
        exit_market = COALESCE(@exitMarket, exit_market),
        exit_price = COALESCE(@exitPrice, exit_price),
        exit_reason = COALESCE(@exitReason, exit_reason),
        gross_return_pct = COALESCE(@grossReturnPct, gross_return_pct),
        net_return_pct = COALESCE(@netReturnPct, net_return_pct),
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      status: value('status'), rejectionReason: value('rejectionReason'),
      entryAt: value('entryAt'), entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      entryImpactPct: finiteOrNull(value('entryImpactPct')),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'), lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      partialStage: value('partialStage'), pendingPartialStage: value('pendingPartialStage'),
      partialExitTargetAt: value('partialExitTargetAt'),
      partialExitDeadlineAt: value('partialExitDeadlineAt'),
      clearPartialExitPending: patch.clearPartialExitPending ? 1 : 0,
      scale1At: value('scale1At'), scale1Price: finiteOrNull(value('scale1Price')),
      scale2At: value('scale2At'), scale2Price: finiteOrNull(value('scale2Price')),
      graduatedAt: value('graduatedAt'), lastCurvePrice: finiteOrNull(value('lastCurvePrice')),
      ammPriceScale: finiteOrNull(value('ammPriceScale')),
      exitTargetMarket: value('exitTargetMarket'), exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'), exitDeadlineAt: value('exitDeadlineAt'),
      exitAt: value('exitAt'), exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')), exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')), updatedAt: Date.now(),
    });
  }

  activeQualityLeaderShadowPositions() {
    return this.db.prepare(`
      SELECT * FROM quality_leader_shadow_positions
      WHERE status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
      ORDER BY signal_at, id
    `).all();
  }

  createGraduationAccelerationShadowPosition(position) {
    const now = Date.now();
    const row = {
      cohortId: position.cohortId,
      episodeId: position.episodeId,
      entryProfileId: position.entryProfileId,
      mint: position.mint,
      symbol: position.symbol || null,
      creator: position.creator || null,
      status: position.status,
      rejectionReason: position.rejectionReason || null,
      positionSol: finiteOrNull(position.positionSol) ?? 1,
      configuredCostPct: finiteOrNull(position.configuredCostPct) ?? 0,
      signalAt: Math.trunc(position.signalAt),
      signalPrice: finiteOrNull(position.signalPrice),
      signalCurvePct: finiteOrNull(position.signalCurvePct),
      featuresJson: JSON.stringify(position.features || {}),
      entryTargetAt: Math.trunc(position.entryTargetAt),
      entryDeadlineAt: Math.trunc(position.entryDeadlineAt),
      coreWeightPct: finiteOrNull(position.coreWeightPct) ?? 50,
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertGraduationAccelerationShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getGraduationAccelerationShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : null;
  }

  updateGraduationAccelerationShadowPosition(id, patch = {}) {
    const value = (key) => (Object.prototype.hasOwnProperty.call(patch, key)
      ? patch[key] : null);
    return this.stmts.updateGraduationAccelerationShadowPosition.run({
      id,
      status: value('status'),
      rejectionReason: value('rejectionReason'),
      entryTargetAt: value('entryTargetAt'),
      entryDeadlineAt: value('entryDeadlineAt'),
      entryAt: value('entryAt'),
      entryMarket: value('entryMarket'),
      entryPrice: finiteOrNull(value('entryPrice')),
      entryJumpPct: finiteOrNull(value('entryJumpPct')),
      entryImpactPct: finiteOrNull(value('entryImpactPct')),
      tokenUnits: finiteOrNull(value('tokenUnits')),
      highestPrice: finiteOrNull(value('highestPrice')),
      lowestPrice: finiteOrNull(value('lowestPrice')),
      lastObservedAt: value('lastObservedAt'),
      lastPrice: finiteOrNull(value('lastPrice')),
      maxFavorableReturnPct: finiteOrNull(value('maxFavorableReturnPct')),
      maxAdverseReturnPct: finiteOrNull(value('maxAdverseReturnPct')),
      graduatedAt: value('graduatedAt'),
      coreExitAt: value('coreExitAt'),
      coreExitPrice: finiteOrNull(value('coreExitPrice')),
      runnerHighestPrice: finiteOrNull(value('runnerHighestPrice')),
      runnerTierIndex: value('runnerTierIndex'),
      runnerStopPrice: finiteOrNull(value('runnerStopPrice')),
      exitTargetMarket: value('exitTargetMarket'),
      exitTriggerAt: value('exitTriggerAt'),
      exitTargetAt: value('exitTargetAt'),
      exitDeadlineAt: value('exitDeadlineAt'),
      clearExitPending: patch.clearExitPending ? 1 : 0,
      exitAt: value('exitAt'),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitImpactPct: finiteOrNull(value('exitImpactPct')),
      exitReason: value('exitReason'),
      grossReturnPct: finiteOrNull(value('grossReturnPct')),
      netReturnPct: finiteOrNull(value('netReturnPct')),
      updatedAt: Date.now(),
    });
  }

  activeGraduationAccelerationShadowPositions() {
    return this.stmts.activeGraduationAccelerationShadowPositions.all();
  }

  createLaunchQualityObservation(token) {
    const now = Date.now();
    const createdAt = Number(token.createdAt ?? token.created_at);
    if (!token.mint || !Number.isFinite(createdAt)) return null;
    const row = {
      mint: token.mint,
      symbol: token.symbol || null,
      creator: token.creator || null,
      createdAt,
      recordCreatedAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertLaunchQualityObservation.run(row);
    return { ...row, inserted: result.changes > 0 };
  }

  getLaunchQualityObservation(mint) {
    return mint ? this.stmts.getLaunchQualityObservation.get(mint) || null : null;
  }

  updateLaunchQualityObservation(mint, patch = {}) {
    if (!mint) return;
    const normalized = { ...patch };
    if (Object.prototype.hasOwnProperty.call(normalized, 'referenceFeatures')) {
      normalized.referenceFeaturesJson = normalized.referenceFeatures == null
        ? null
        : JSON.stringify(normalized.referenceFeatures);
      delete normalized.referenceFeatures;
    }
    const keys = Object.keys(normalized)
      .filter((key) => Object.prototype.hasOwnProperty.call(LAUNCH_QUALITY_COLUMNS, key))
      .filter((key) => normalized[key] !== undefined)
      .sort();
    if (keys.length === 0) return;
    const cacheKey = keys.join(',');
    let statement = this.launchQualityUpdateStatements.get(cacheKey);
    if (!statement) {
      statement = this.db.prepare(`
        UPDATE launch_quality_observations SET
          ${keys.map((key) => `${LAUNCH_QUALITY_COLUMNS[key]} = @${key}`).join(', ')},
          updated_at = @updatedAt
        WHERE mint = @mint
          AND label_status NOT IN ('COMPLETE', 'RIGHT_CENSORED', 'NO_REFERENCE')
      `);
      this.launchQualityUpdateStatements.set(cacheKey, statement);
    }
    const values = { mint, updatedAt: Date.now() };
    for (const key of keys) {
      const value = normalized[key];
      values[key] = typeof value === 'number' ? finiteOrNull(value) : value;
    }
    return statement.run(values);
  }

  recordLaunchQualitySnapshot(snapshot) {
    const row = {
      mint: snapshot.mint,
      horizonMs: Math.max(1, Math.trunc(Number(snapshot.horizonMs) || 1)),
      observedAt: Math.trunc(Number(snapshot.observedAt) || Date.now()),
      lastTradeAt: Number.isFinite(snapshot.lastTradeAt)
        ? Math.trunc(snapshot.lastTradeAt) : null,
      observationLagMs: Math.max(0, Math.trunc(Number(snapshot.observationLagMs) || 0)),
      price: finiteOrNull(snapshot.price),
      priceReturnPct: finiteOrNull(snapshot.priceReturnPct),
      peakReturnPct: finiteOrNull(snapshot.peakReturnPct),
      drawdownPct: finiteOrNull(snapshot.drawdownPct),
      buyers: Math.max(0, Math.trunc(Number(snapshot.buyers) || 0)),
      recentBuyers: Math.max(0, Math.trunc(Number(snapshot.recentBuyers) || 0)),
      newBuyers: Math.max(0, Math.trunc(Number(snapshot.newBuyers) || 0)),
      buyTx: Math.max(0, Math.trunc(Number(snapshot.buyTx) || 0)),
      sellTx: Math.max(0, Math.trunc(Number(snapshot.sellTx) || 0)),
      buySol: finiteOrNull(snapshot.buySol) ?? 0,
      sellSol: finiteOrNull(snapshot.sellSol) ?? 0,
      netFlowSol: finiteOrNull(snapshot.netFlowSol) ?? 0,
      top1SharePct: finiteOrNull(snapshot.top1SharePct),
      top3SharePct: finiteOrNull(snapshot.top3SharePct),
      retentionPct: finiteOrNull(snapshot.retentionPct),
      creatorSharePct: finiteOrNull(snapshot.creatorSharePct),
      sellSolSincePeak: finiteOrNull(snapshot.sellSolSincePeak) ?? 0,
      buySolSincePeak: finiteOrNull(snapshot.buySolSincePeak) ?? 0,
      sellImpactPctPerSol: finiteOrNull(snapshot.sellImpactPctPerSol),
      sellDepthFractionPct: finiteOrNull(snapshot.sellDepthFractionPct),
      depthAdjustedSellImpact: finiteOrNull(snapshot.depthAdjustedSellImpact),
      sellDecayRatio: finiteOrNull(snapshot.sellDecayRatio),
      curvePct: finiteOrNull(snapshot.curvePct),
      virtualSolReserves: finiteOrNull(snapshot.virtualSolReserves),
      createdAt: Date.now(),
    };
    const result = this.stmts.insertLaunchQualitySnapshot.run(row);
    // RUG-risk features are deliberately forward-only and remain transient here.
    // Downstream Shadow rows persist them inside their existing features_json,
    // avoiding an ALTER TABLE on the large historical snapshot table.
    return { ...row, rugRisk: snapshot.rugRisk || null, inserted: result.changes > 0 };
  }

  createMigrationSecondLegObservation(token) {
    const now = Date.now();
    const migrationAt = Number(token.migrationAt ?? token.graduated_at ?? token.graduatedAt);
    if (!token.mint || !Number.isFinite(migrationAt)) return null;
    const row = {
      mint: token.mint,
      symbol: token.symbol || null,
      creator: token.creator || null,
      migrationAt: Math.trunc(migrationAt),
      migrationSource: token.migrationSource || null,
      recordCreatedAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertMigrationSecondLegObservation.run(row);
    return { ...row, inserted: result.changes > 0 };
  }

  getMigrationSecondLegObservation(mint) {
    return mint ? this.stmts.getMigrationSecondLegObservation.get(mint) || null : null;
  }

  updateMigrationSecondLegObservation(mint, patch = {}) {
    if (!mint) return null;
    const value = (key) => {
      const number = Number(patch[key]);
      return Number.isFinite(number) ? number : null;
    };
    return this.stmts.updateMigrationSecondLegObservation.run({
      mint,
      firstAmmTradeAt: value('firstAmmTradeAt'),
      baselinePrice: value('baselinePrice'),
      lastTradeAt: value('lastTradeAt'),
      lastPrice: value('lastPrice'),
      peakAt: value('peakAt'),
      peakPrice: value('peakPrice'),
      maxReturnPct: value('maxReturnPct'),
      firstPullbackAt: value('firstPullbackAt'),
      pullbackLowAt: value('pullbackLowAt'),
      pullbackLowPrice: value('pullbackLowPrice'),
      maxPullbackPct: value('maxPullbackPct'),
      reboundAt: value('reboundAt'),
      boostStatus: patch.boostStatus && patch.boostStatus !== 'UNKNOWN'
        ? String(patch.boostStatus) : null,
      cashbackStatus: patch.cashbackStatus && patch.cashbackStatus !== 'UNKNOWN'
        ? String(patch.cashbackStatus) : null,
      canonicalPoolStatus: patch.canonicalPoolStatus
        && patch.canonicalPoolStatus !== 'UNKNOWN'
        ? String(patch.canonicalPoolStatus) : null,
      quoteReserveStatus: patch.quoteReserveStatus
        && patch.quoteReserveStatus !== 'UNAVAILABLE'
        ? String(patch.quoteReserveStatus) : null,
      updatedAt: Date.now(),
    });
  }

  completeMigrationSecondLegObservation(mint, patch = {}) {
    if (!mint) return null;
    return this.stmts.completeMigrationSecondLegObservation.run({
      mint,
      status: patch.status || 'COMPLETE',
      completedAt: Number.isFinite(Number(patch.completedAt))
        ? Math.trunc(Number(patch.completedAt)) : Date.now(),
      completionReason: patch.completionReason || null,
      updatedAt: Date.now(),
    });
  }

  censorOpenMigrationSecondLegObservations({ completedAt, completionReason } = {}) {
    const now = Date.now();
    return this.stmts.censorOpenMigrationSecondLegObservations.run({
      completedAt: Number.isFinite(Number(completedAt))
        ? Math.trunc(Number(completedAt)) : now,
      completionReason: completionReason || 'PROCESS_RESTART_NO_REPLAY',
      updatedAt: now,
    });
  }

  recordMigrationSecondLegSnapshot(snapshot) {
    const numberOrNull = (value) => (
      value == null || (typeof value === 'string' && value.trim() === '')
        ? null
        : finiteOrNull(Number(value))
    );
    const integer = (value, fallback = 0) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.trunc(number) : fallback;
    };
    const row = {
      mint: snapshot.mint,
      secondBucket: Math.max(0, integer(snapshot.secondBucket)),
      ageMs: Math.max(0, integer(snapshot.ageMs)),
      observedAt: integer(snapshot.observedAt, Date.now()),
      lastTradeAt: numberOrNull(snapshot.lastTradeAt),
      observationLagMs: Math.max(0, integer(snapshot.observationLagMs)),
      slot: numberOrNull(snapshot.slot),
      price: numberOrNull(snapshot.price),
      baselinePrice: numberOrNull(snapshot.baselinePrice),
      peakPrice: numberOrNull(snapshot.peakPrice),
      openingImpulsePct: numberOrNull(snapshot.openingImpulsePct),
      pullbackPct: numberOrNull(snapshot.pullbackPct),
      pullbackDurationMs: numberOrNull(snapshot.pullbackDurationMs),
      reboundPct: numberOrNull(snapshot.reboundPct),
      microHighBreak: snapshot.microHighBreak ? 1 : 0,
      buySol3s: numberOrNull(snapshot.buySol3s),
      sellSol3s: numberOrNull(snapshot.sellSol3s),
      netFlow3s: numberOrNull(snapshot.netFlow3s),
      buySol10s: numberOrNull(snapshot.buySol10s),
      sellSol10s: numberOrNull(snapshot.sellSol10s),
      netFlow10s: numberOrNull(snapshot.netFlow10s),
      buySolPrev20s: numberOrNull(snapshot.buySolPrev20s),
      sellSolPrev20s: numberOrNull(snapshot.sellSolPrev20s),
      netFlowPrev20s: numberOrNull(snapshot.netFlowPrev20s),
      buyers3s: Math.max(0, integer(snapshot.buyers3s)),
      buyers10s: Math.max(0, integer(snapshot.buyers10s)),
      largestBuyerShare10sPct: numberOrNull(snapshot.largestBuyerShare10sPct),
      buySpeedRatio: numberOrNull(snapshot.buySpeedRatio),
      netFlowAcceleration: numberOrNull(snapshot.netFlowAcceleration),
      sellDecelerationRatio: numberOrNull(snapshot.sellDecelerationRatio),
      observedRetainedBuyers: Math.max(0, integer(snapshot.observedRetainedBuyers)),
      observedExitedBuyers: Math.max(0, integer(snapshot.observedExitedBuyers)),
      observedHolderDiffusionIndex: integer(snapshot.observedHolderDiffusionIndex),
      quoteReserveSol: numberOrNull(snapshot.quoteReserveSol),
      onfi10Pct: numberOrNull(snapshot.onfi10Pct),
      estimatedImpact005Pct: numberOrNull(snapshot.estimatedImpact005Pct),
      estimatedImpact01Pct: numberOrNull(snapshot.estimatedImpact01Pct),
      estimatedImpact025Pct: numberOrNull(snapshot.estimatedImpact025Pct),
      boostStatus: snapshot.boostStatus || 'UNKNOWN',
      mayhemStatus: snapshot.mayhemStatus || 'UNKNOWN',
      cashbackStatus: snapshot.cashbackStatus || 'UNKNOWN',
      canonicalPoolStatus: snapshot.canonicalPoolStatus || 'UNKNOWN',
      entityClusterStatus: snapshot.entityClusterStatus || 'UNAVAILABLE',
      featureCompletenessJson: JSON.stringify(snapshot.featureCompleteness || {}),
      createdAt: Date.now(),
    };
    const result = this.stmts.insertMigrationSecondLegSnapshot.run(row);
    if (result.changes > 0) {
      this.stmts.incrementMigrationSecondLegSnapshotCount.run({
        mint: row.mint,
        updatedAt: Date.now(),
      });
    }
    return { ...row, inserted: result.changes > 0 };
  }

  createMigrationSecondLegShadowPosition(position) {
    const now = Date.now();
    const row = {
      cohortId: String(position.cohortId),
      episodeId: String(position.episodeId),
      mint: String(position.mint),
      symbol: position.symbol || null,
      status: position.status || 'PENDING_ENTRY',
      rejectionReason: position.rejectionReason || null,
      positionSol: Number(position.positionSol),
      configuredCostPct: Number(position.configuredCostPct),
      migrationAt: Math.trunc(Number(position.migrationAt)),
      signalAt: Math.trunc(Number(position.signalAt)),
      signalPrice: Number(position.signalPrice),
      signalAgeMs: Math.trunc(Number(position.signalAgeMs)),
      featuresJson: JSON.stringify(position.features || {}),
      rugGuardJson: position.rugGuard ? JSON.stringify(position.rugGuard) : null,
      entryTargetAt: Math.trunc(Number(position.entryTargetAt)),
      entryDeadlineAt: Math.trunc(Number(position.entryDeadlineAt)),
      hardStopPct: Number(position.hardStopPct),
      maxHoldMs: Math.trunc(Number(position.maxHoldMs)),
      createdAt: now,
      updatedAt: now,
    };
    const result = this.stmts.insertMigrationSecondLegShadowPosition.run(row);
    if (result.changes > 0) {
      return { ...row, id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.stmts.getMigrationSecondLegShadowPosition.get(
      row.cohortId,
      row.episodeId,
    );
    return existing ? { ...existing, inserted: false } : { ...row, inserted: false };
  }

  activeMigrationSecondLegShadowPositions() {
    return this.stmts.activeMigrationSecondLegShadowPositions.all();
  }

  updateMigrationSecondLegShadowPosition(id, patch = {}) {
    const numberOrNull = (key) => {
      const number = Number(patch[key]);
      return Number.isFinite(number) ? number : null;
    };
    return this.stmts.updateMigrationSecondLegShadowPosition.run({
      id,
      status: patch.status || null,
      rejectionReason: patch.rejectionReason || null,
      rugGuardJson: patch.rugGuard ? JSON.stringify(patch.rugGuard) : null,
      entryAt: numberOrNull('entryAt'),
      entryPrice: numberOrNull('entryPrice'),
      entryJumpPct: numberOrNull('entryJumpPct'),
      entryImpactPct: numberOrNull('entryImpactPct'),
      highestPrice: numberOrNull('highestPrice'),
      lowestPrice: numberOrNull('lowestPrice'),
      lastObservedAt: numberOrNull('lastObservedAt'),
      lastPrice: numberOrNull('lastPrice'),
      maxFavorableReturnPct: numberOrNull('maxFavorableReturnPct'),
      maxAdverseReturnPct: numberOrNull('maxAdverseReturnPct'),
      exitTriggerAt: numberOrNull('exitTriggerAt'),
      exitTargetAt: numberOrNull('exitTargetAt'),
      exitDeadlineAt: numberOrNull('exitDeadlineAt'),
      exitAt: numberOrNull('exitAt'),
      exitPrice: numberOrNull('exitPrice'),
      exitImpactPct: numberOrNull('exitImpactPct'),
      exitReason: patch.exitReason || null,
      grossReturnPct: numberOrNull('grossReturnPct'),
      netReturnPct: numberOrNull('netReturnPct'),
      updatedAt: Date.now(),
    });
  }

  migrationSecondLegShadowDashboard({ positionLimit = 100 } = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const stats = this.db.prepare(`
      SELECT COUNT(*) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
        COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
        COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
        COALESCE(SUM(rejection_reason = 'PRE_ENTRY_RUG_RISK'), 0) AS rug_rejected,
        AVG(CASE WHEN status IN ('CLOSED', 'NO_EXIT') THEN net_return_pct END)
          AS average_net_return_pct,
        AVG(CASE WHEN status IN ('CLOSED', 'NO_EXIT') THEN gross_return_pct END)
          AS average_gross_return_pct,
        COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT') AND net_return_pct > 0), 0) AS wins,
        COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT') AND net_return_pct IS NOT NULL), 0)
          AS resolved,
        MAX(CASE WHEN status IN ('CLOSED', 'NO_EXIT') THEN net_return_pct END)
          AS maximum_winner_pct,
        SUM(CASE WHEN status IN ('CLOSED', 'NO_EXIT') AND net_return_pct > 0
          THEN net_return_pct ELSE 0 END) AS gross_profit_pct,
        ABS(SUM(CASE WHEN status IN ('CLOSED', 'NO_EXIT') AND net_return_pct < 0
          THEN net_return_pct ELSE 0 END)) AS gross_loss_pct
      FROM migration_second_leg_shadow_positions
    `).get();
    const resolved = Number(stats.resolved) || 0;
    const wins = Number(stats.wins) || 0;
    const loss = Number(stats.gross_loss_pct) || 0;
    const cohorts = this.db.prepare(`
      SELECT cohort_id,
        COUNT(*) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
        COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
        COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT')), 0) AS resolved,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
        COALESCE(SUM(rejection_reason = 'PRE_ENTRY_RUG_RISK'), 0) AS rug_rejected,
        COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT') AND net_return_pct > 0), 0)
          AS wins,
        AVG(CASE WHEN status IN ('CLOSED', 'NO_EXIT') THEN net_return_pct END)
          AS average_net_return_pct,
        MAX(CASE WHEN status IN ('CLOSED', 'NO_EXIT') THEN net_return_pct END)
          AS maximum_winner_pct,
        SUM(CASE WHEN status IN ('CLOSED', 'NO_EXIT') AND net_return_pct > 0
          THEN net_return_pct ELSE 0 END) AS gross_profit_pct,
        ABS(SUM(CASE WHEN status IN ('CLOSED', 'NO_EXIT') AND net_return_pct < 0
          THEN net_return_pct ELSE 0 END)) AS gross_loss_pct
      FROM migration_second_leg_shadow_positions
      GROUP BY cohort_id
      ORDER BY cohort_id
    `).all().map((row) => {
      const cohortResolved = Number(row.resolved) || 0;
      const cohortLoss = Number(row.gross_loss_pct) || 0;
      return {
        ...row,
        win_rate_pct: cohortResolved > 0
          ? (Number(row.wins) || 0) / cohortResolved * 100 : null,
        profit_factor: cohortLoss > 0
          ? (Number(row.gross_profit_pct) || 0) / cohortLoss : null,
      };
    });
    const positions = this.db.prepare(`
      SELECT *,
        CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
          THEN exit_at - entry_at ELSE NULL END AS hold_ms
      FROM migration_second_leg_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        THEN 0 ELSE 1 END, updated_at DESC, id DESC
      LIMIT ?
    `).all(limit).map((row) => ({
      ...row,
      features: (() => {
        try { return JSON.parse(row.features_json || '{}'); } catch (_) { return {}; }
      })(),
      rug_guard: (() => {
        try { return JSON.parse(row.rug_guard_json || '{}'); } catch (_) { return {}; }
      })(),
    }));
    return {
      stats: {
        ...stats,
        win_rate_pct: resolved > 0 ? wins / resolved * 100 : null,
        profit_factor: loss > 0 ? (Number(stats.gross_profit_pct) || 0) / loss : null,
      },
      cohorts,
      positions,
    };
  }

  migrationSecondLegDashboard({ observationLimit = 40, snapshotLimit = 100 } = {}) {
    const observationsLimit = Math.min(200, Math.max(1, Math.trunc(Number(observationLimit) || 40)));
    const snapshotsLimit = Math.min(500, Math.max(1, Math.trunc(Number(snapshotLimit) || 100)));
    const summary = this.db.prepare(`
      SELECT COUNT(*) AS observations,
        COALESCE(SUM(status = 'OBSERVING'), 0) AS active,
        COALESCE(SUM(status = 'COMPLETE'), 0) AS complete,
        COALESCE(SUM(status = 'RIGHT_CENSORED'), 0) AS right_censored,
        COALESCE(SUM(first_pullback_at IS NOT NULL), 0) AS first_pullbacks,
        COALESCE(SUM(rebound_at IS NOT NULL), 0) AS rebounds,
        COALESCE(SUM(snapshot_count), 0) AS snapshots,
        AVG(max_return_pct) AS average_max_return_pct,
        MAX(max_return_pct) AS maximum_return_pct
      FROM migration_second_leg_observations
    `).get();
    const publicCandidates = this.db.prepare(`
      SELECT COUNT(*) AS snapshots,
        COUNT(DISTINCT mint) AS mints
      FROM migration_second_leg_snapshots
      WHERE age_ms BETWEEN 75000 AND 300000
        AND net_flow_10s > 0
        AND buyers_10s >= 3
        AND (largest_buyer_share_10s_pct IS NULL OR largest_buyer_share_10s_pct <= 60)
        AND pullback_pct BETWEEN 8 AND 35
    `).get();
    const observations = this.db.prepare(`
      SELECT * FROM migration_second_leg_observations
      ORDER BY CASE WHEN status = 'OBSERVING' THEN 0 ELSE 1 END,
        updated_at DESC, migration_at DESC
      LIMIT ?
    `).all(observationsLimit);
    const snapshots = this.db.prepare(`
      SELECT s.*, o.symbol, o.migration_at, o.status AS observation_status
      FROM migration_second_leg_snapshots s
      JOIN migration_second_leg_observations o ON o.mint = s.mint
      ORDER BY s.observed_at DESC, s.id DESC
      LIMIT ?
    `).all(snapshotsLimit).map((row) => ({
      ...row,
      feature_completeness: (() => {
        try { return JSON.parse(row.feature_completeness_json || '{}'); } catch (_) { return {}; }
      })(),
    }));
    return {
      summary,
      publicCandidates,
      shadow: this.migrationSecondLegShadowDashboard({ positionLimit: snapshotLimit }),
      featureAvailability: {
        observed: [
          'effective quote reserve',
          '0.05/0.1/0.25 SOL constant-product impact',
          'canonical pool local verification',
        ],
        provisional: [
          'gross normalized 10s net flow (BOOST/wash/entity not removed)',
          'canBoost and trade cashback event hints',
        ],
        unavailable: [
          'exact BOOST transaction classification',
          'Mayhem authoritative flag',
          'entity/funding/bot clusters',
        ],
      },
      missingArticleFeatures: [
        'exact organic ONFI10',
        'exact BOOST / Mayhem classification',
        'entity/funding/bot clusters',
      ],
      observations,
      snapshots,
    };
  }

  launchPullbackShadowDashboard({ positionLimit = 200, bigWinnerPct = 50, cacheStats = false } = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(positionLimit) || 200)));
    const threshold = Math.max(1, Number(bigWinnerPct) || 50);
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL THEN exit_at - entry_at
          ELSE NULL
        END AS hold_ms
      FROM launch_pullback_shadow_positions
      ORDER BY
        CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => {
      const cohortIds = this.db.prepare(`
        SELECT DISTINCT cohort_id FROM launch_pullback_shadow_positions ORDER BY cohort_id
      `).all().map((row) => row.cohort_id);
      return cohortIds.map((cohortId) => {
        const counts = this.db.prepare(`
          SELECT
            COUNT(*) AS evaluated,
            COUNT(DISTINCT mint) AS independent_mints,
            COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rule_rejected,
            COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
            COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
            COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
            COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
            COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
            COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
            AVG(entry_jump_pct) AS average_entry_jump_pct
          FROM launch_pullback_shadow_positions WHERE cohort_id = ?
        `).get(cohortId);
        const resolved = this.db.prepare(`
          SELECT net_return_pct, gross_return_pct, max_favorable_return_pct
          FROM launch_pullback_shadow_positions
          WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
            AND net_return_pct IS NOT NULL
          ORDER BY net_return_pct
        `).all(cohortId);
        const returns = resolved.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
        const wins = returns.filter((value) => value > 0).sort((left, right) => right - left);
        const losses = returns.filter((value) => value < 0);
        const flat = returns.filter((value) => value === 0);
        const totalProfit = wins.reduce((sum, value) => sum + value, 0);
        const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
        const median = returns.length
          ? returns.length % 2 === 1
            ? returns[(returns.length - 1) / 2]
            : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2
          : null;
        const exTop5 = [...wins.slice(5), ...flat, ...losses];
        const bigOpportunities = resolved.filter((row) => (
          Number(row.max_favorable_return_pct) >= threshold
        ));
        const bigWinners = resolved.filter((row) => Number(row.gross_return_pct) >= threshold);
        const captures = bigOpportunities.map((row) => {
          const maximum = Number(row.max_favorable_return_pct);
          const realized = Number(row.gross_return_pct);
          return maximum > 0 && Number.isFinite(realized) ? realized / maximum * 100 : null;
        }).filter(Number.isFinite);
        return {
          cohort_id: cohortId,
          ...counts,
          qualified_references: Number(counts.evaluated || 0) - Number(counts.rule_rejected || 0),
          resolved: returns.length,
          average_net_return_pct: returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
          median_net_return_pct: median,
          average_net_return_ex_top5_pct: exTop5.length
            ? exTop5.reduce((sum, value) => sum + value, 0) / exTop5.length : null,
          win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
          profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
          max_winner_pct: wins[0] ?? null,
          top_5_winner_contribution_pct: totalProfit > 0
            ? wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit * 100
            : null,
          big_winner_threshold_pct: threshold,
          big_winner_opportunities: bigOpportunities.length,
          big_winners_realized: bigWinners.length,
          big_winner_realization_rate_pct: bigOpportunities.length
            ? bigWinners.length / bigOpportunities.length * 100 : null,
          average_big_winner_capture_pct: captures.length
            ? captures.reduce((sum, value) => sum + value, 0) / captures.length : null,
        };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats(`launch-pullback-shadow:${threshold}`, 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  migratedDropReboundShadowDashboard({
    positionLimit = 200,
    bigWinnerPct = 50,
    cacheStats = false,
  } = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(positionLimit) || 200)));
    const threshold = Math.max(1, Number(bigWinnerPct) || 50);
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL THEN exit_at - entry_at
          ELSE NULL
        END AS hold_ms
      FROM migrated_drop_rebound_shadow_positions
      ORDER BY
        CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => {
      const cohortRows = this.db.prepare(`
        SELECT cohort_id, lifecycle_stage, entry_profile_id, exit_profile_id,
          MIN(window_ms) AS window_ms,
          MIN(drop_min_pct) AS drop_min_pct,
          MIN(drop_max_pct) AS drop_max_pct,
          MIN(rebound_min_pct) AS rebound_min_pct,
          MIN(rebound_max_pct) AS rebound_max_pct,
          MIN(rebound_timeout_ms) AS rebound_timeout_ms,
          MIN(exit_mode) AS exit_mode,
          MIN(fixed_hold_ms) AS fixed_hold_ms,
          MIN(trailing_activation_pct) AS trailing_activation_pct,
          MIN(trailing_stop_pct) AS trailing_stop_pct,
          MIN(hard_stop_pct) AS hard_stop_pct,
          MIN(loss_check_at_ms) AS loss_check_at_ms,
          MIN(loss_check_recovery_pct) AS loss_check_recovery_pct,
          MIN(core_weight_pct) AS core_weight_pct,
          MIN(runner_hold_ms) AS runner_hold_ms,
          MIN(max_hold_ms) AS max_hold_ms,
          COUNT(*) AS signals,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
          COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
          COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
          COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
          AVG(position_sol) AS average_position_sol,
          AVG(entry_jump_pct) AS average_entry_jump_pct,
          AVG(entry_impact_pct) AS average_entry_impact_pct,
          AVG(exit_impact_pct) AS average_exit_impact_pct,
          AVG(json_extract(confirmation_json, '$.uniqueBuyers'))
            AS average_confirmation_buyers,
          AVG(json_extract(confirmation_json, '$.netFlowSol'))
            AS average_confirmation_net_flow_sol,
          AVG(json_extract(confirmation_json, '$.netFlowAccelerationSol'))
            AS average_confirmation_net_flow_accel_sol,
          AVG(json_extract(confirmation_json, '$.topBuyerSharePct'))
            AS average_confirmation_top_buyer_share_pct,
          AVG(json_extract(confirmation_json, '$.roundTripImpactPct'))
            AS average_confirmation_round_trip_impact_pct,
          AVG(migration_age_ms) AS average_migration_age_ms,
          AVG(drop_pct) AS average_drop_pct,
          AVG(rebound_pct) AS average_rebound_pct,
          AVG(rebound_elapsed_ms) AS average_rebound_elapsed_ms,
          AVG(max_favorable_return_pct) AS average_mfe_pct,
          AVG(max_adverse_return_pct) AS average_mae_pct
        FROM migrated_drop_rebound_shadow_positions
        GROUP BY cohort_id, lifecycle_stage, entry_profile_id, exit_profile_id
        ORDER BY lifecycle_stage, entry_profile_id, exit_profile_id
      `).all();
      return cohortRows.map((cohort) => {
        const resolved = this.db.prepare(`
          SELECT net_return_pct, gross_return_pct, max_favorable_return_pct
          FROM migrated_drop_rebound_shadow_positions
          WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
            AND net_return_pct IS NOT NULL
          ORDER BY net_return_pct
        `).all(cohort.cohort_id);
        const returns = resolved.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
        const wins = returns.filter((value) => value > 0).sort((left, right) => right - left);
        const losses = returns.filter((value) => value < 0);
        const flat = returns.filter((value) => value === 0);
        const totalProfit = wins.reduce((sum, value) => sum + value, 0);
        const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
        const median = returns.length
          ? returns.length % 2 === 1
            ? returns[(returns.length - 1) / 2]
            : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2
          : null;
        const exTop5 = [...wins.slice(5), ...flat, ...losses];
        const opportunities = resolved.filter((row) => (
          Number(row.max_favorable_return_pct) >= threshold
        ));
        const realized = resolved.filter((row) => Number(row.gross_return_pct) >= threshold);
        const captures = opportunities.map((row) => {
          const maximum = Number(row.max_favorable_return_pct);
          const outcome = Number(row.gross_return_pct);
          return maximum > 0 && Number.isFinite(outcome) ? outcome / maximum * 100 : null;
        }).filter(Number.isFinite);
        return {
          ...cohort,
          resolved: returns.length,
          average_net_return_pct: returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
          median_net_return_pct: median,
          average_net_return_ex_top5_pct: exTop5.length
            ? exTop5.reduce((sum, value) => sum + value, 0) / exTop5.length : null,
          win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
          profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
          max_winner_pct: wins[0] ?? null,
          top_5_winner_contribution_pct: totalProfit > 0
            ? wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit * 100
            : null,
          big_winner_threshold_pct: threshold,
          big_winner_opportunities: opportunities.length,
          big_winners_realized: realized.length,
          big_winner_realization_rate_pct: opportunities.length
            ? realized.length / opportunities.length * 100 : null,
          average_big_winner_capture_pct: captures.length
            ? captures.reduce((sum, value) => sum + value, 0) / captures.length : null,
        };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats(`migrated-drop-rebound:${threshold}`, 60_000, computeCohorts)
      : computeCohorts();
    const entryProfiles = this.db.prepare(`
      SELECT lifecycle_stage, entry_profile_id,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS independent_mints,
        AVG(drop_pct) AS average_drop_pct,
        AVG(rebound_pct) AS average_rebound_pct,
        AVG(rebound_elapsed_ms) AS average_rebound_elapsed_ms
      FROM migrated_drop_rebound_shadow_positions
      GROUP BY lifecycle_stage, entry_profile_id
      ORDER BY lifecycle_stage, entry_profile_id
    `).all();
    return { cohorts, entryProfiles, positions };
  }

  migrationContinuityShadowDashboard({ positionLimit = 100, cacheStats = false } = {}) {
    const limit = Math.min(300, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const positions = this.db.prepare(`
      SELECT *,
        CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
          THEN exit_at - entry_at ELSE NULL END AS hold_ms
      FROM migration_continuity_shadow_positions
      ORDER BY
        CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => this.db.prepare(`
      SELECT cohort_id, exit_profile_id,
        MIN(exit_mode) AS exit_mode,
        MIN(min_hold_ms) AS min_hold_ms,
        MIN(fixed_hold_ms) AS fixed_hold_ms,
        MIN(trailing_activation_pct) AS trailing_activation_pct,
        MIN(trailing_stop_pct) AS trailing_stop_pct,
        MIN(hard_stop_pct) AS hard_stop_pct,
        MIN(max_hold_ms) AS max_hold_ms,
        COUNT(*) AS signals,
        COUNT(DISTINCT mint) AS independent_mints,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
        COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
        COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT')), 0) AS resolved,
        AVG(entry_buyers) AS average_entry_buyers,
        AVG(entry_net_flow_sol) AS average_entry_net_flow_sol,
        AVG(entry_sell_buy_ratio) AS average_entry_sell_buy_ratio,
        AVG(entry_return_pct) AS average_entry_return_pct,
        AVG(entry_jump_pct) AS average_entry_jump_pct,
        AVG(max_favorable_return_pct) AS average_mfe_pct,
        AVG(max_adverse_return_pct) AS average_mae_pct,
        AVG(CASE WHEN status IN ('CLOSED', 'NO_EXIT') THEN net_return_pct END)
          AS average_net_return_pct,
        100.0 * COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT') AND net_return_pct > 0), 0)
          / NULLIF(SUM(status IN ('CLOSED', 'NO_EXIT')), 0) AS win_rate_pct,
        SUM(CASE WHEN status IN ('CLOSED', 'NO_EXIT') AND net_return_pct > 0
          THEN net_return_pct ELSE 0 END)
          / NULLIF(ABS(SUM(CASE WHEN status IN ('CLOSED', 'NO_EXIT') AND net_return_pct < 0
            THEN net_return_pct ELSE 0 END)), 0) AS profit_factor
      FROM migration_continuity_shadow_positions
      GROUP BY cohort_id, exit_profile_id
      ORDER BY exit_profile_id
    `).all().map((cohort) => {
      const rows = this.db.prepare(`
        SELECT net_return_pct
        FROM migration_continuity_shadow_positions
        WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
          AND net_return_pct IS NOT NULL
        ORDER BY net_return_pct
      `).all(cohort.cohort_id).map((row) => Number(row.net_return_pct));
      const middle = Math.floor(rows.length / 2);
      return {
        ...cohort,
        median_net_return_pct: rows.length
          ? rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2
          : null,
      };
    });
    const cohorts = cacheStats
      ? this._cachedDashboardStats('migration-continuity-shadow', 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  rangeScalperShadowDashboard({ positionLimit = 100, cacheStats = false } = {}) {
    const limit = Math.min(300, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL THEN exit_at - entry_at
          ELSE NULL
        END AS hold_ms
      FROM range_scalper_shadow_positions
      ORDER BY
        CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => {
      const groups = this.db.prepare(`
        SELECT cohort_id, entry_profile_id, exit_profile_id,
          MIN(exit_mode) AS exit_mode,
          MIN(take_profit_pct) AS take_profit_pct,
          MIN(hard_stop_pct) AS hard_stop_pct,
          MIN(max_hold_ms) AS max_hold_ms,
          COUNT(*) AS attempts,
          COUNT(DISTINCT episode_id) AS signals,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
          COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
          COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT')), 0) AS resolved,
          AVG(range_score) AS average_range_score,
          AVG(volume_sol) AS average_volume_sol,
          AVG(unique_wallets) AS average_unique_wallets,
          AVG(range_pct) AS average_range_pct,
          AVG(efficiency_ratio) AS average_efficiency_ratio,
          AVG(entry_jump_pct) AS average_entry_jump_pct,
          AVG(max_favorable_return_pct) AS average_mfe_pct,
          AVG(max_adverse_return_pct) AS average_mae_pct
        FROM range_scalper_shadow_positions
        GROUP BY cohort_id, entry_profile_id, exit_profile_id
        ORDER BY entry_profile_id, exit_profile_id
      `).all();
      const resolvedStatement = this.db.prepare(`
        SELECT net_return_pct
        FROM range_scalper_shadow_positions
        WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
          AND net_return_pct IS NOT NULL
        ORDER BY net_return_pct
      `);
      return groups.map((group) => {
        const returns = resolvedStatement.all(group.cohort_id)
          .map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
        const wins = returns.filter((value) => value > 0).sort((a, b) => b - a);
        const losses = returns.filter((value) => value < 0);
        const totalProfit = wins.reduce((sum, value) => sum + value, 0);
        const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
        const median = returns.length
          ? returns.length % 2
            ? returns[(returns.length - 1) / 2]
            : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2
          : null;
        return {
          ...group,
          resolved: returns.length,
          average_net_return_pct: returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
          median_net_return_pct: median,
          win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
          profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
          max_winner_pct: wins[0] ?? null,
        };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats('range-scalper-shadow', 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  cyaEarlyPyramidShadowDashboard({ positionLimit = 100, cacheStats = false } = {}) {
    const limit = Math.min(300, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const positions = this.db.prepare(`
      SELECT *, CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
        THEN exit_at - entry_at ELSE NULL END AS hold_ms
      FROM cya_early_pyramid_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        THEN 0 ELSE 1 END, updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => {
      const groups = this.db.prepare(`
        SELECT cohort_id, entry_profile_id, exit_profile_id,
          MIN(trailing_stop_pct) AS trailing_stop_pct,
          COUNT(*) AS attempts,
          COUNT(DISTINCT episode_id) AS signals,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
          COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT')), 0) AS resolved,
          AVG(age_ms) AS average_age_ms,
          AVG(curve_pct) AS average_curve_pct,
          AVG(buyers_5s) AS average_buyers_5s,
          AVG(net_flow_5s) AS average_net_flow_5s,
          AVG(entry_jump_pct) AS average_entry_jump_pct,
          AVG(total_invested_sol) AS average_invested_sol,
          AVG(add_count) AS average_add_count,
          AVG(scale_out_count) AS average_scale_out_count,
          AVG(estimated_cost_sol) AS average_estimated_cost_sol,
          AVG(max_favorable_return_pct) AS average_mfe_pct,
          AVG(max_adverse_return_pct) AS average_mae_pct
        FROM cya_early_pyramid_shadow_positions
        GROUP BY cohort_id, entry_profile_id, exit_profile_id
        ORDER BY entry_profile_id, exit_profile_id
      `).all();
      const resolved = this.db.prepare(`
        SELECT net_return_pct FROM cya_early_pyramid_shadow_positions
        WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
          AND net_return_pct IS NOT NULL ORDER BY net_return_pct
      `);
      return groups.map((group) => {
        const returns = resolved.all(group.cohort_id)
          .map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
        const wins = returns.filter((value) => value > 0).sort((a, b) => b - a);
        const losses = returns.filter((value) => value < 0);
        const totalProfit = wins.reduce((sum, value) => sum + value, 0);
        const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
        const sorted = [...returns].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const median = sorted.length
          ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
          : null;
        return {
          ...group,
          resolved: returns.length,
          average_net_return_pct: returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
          median_net_return_pct: median,
          win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
          profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
          max_winner_pct: wins[0] ?? null,
        };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats('cya-early-pyramid-shadow', 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  bondingCurveMomentumShadowDashboard({
    positionLimit = 30,
    snapshotLimit = 40,
    bigWinnerPct = 50,
    cacheStats = false,
  } = {}) {
    const safeLimit = (value, fallback) => Math.min(
      200,
      Math.max(1, Math.trunc(Number(value) || fallback)),
    );
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL THEN exit_at - entry_at
          ELSE NULL
        END AS hold_ms
      FROM bonding_curve_momentum_shadow_positions
      ORDER BY
        CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(safeLimit(positionLimit, 30));

    const threshold = Math.max(1, Number(bigWinnerPct) || 50);
    const computeCohorts = () => {
      const groups = this.db.prepare(`
        SELECT cohort_id, entry_profile_id, exit_profile_id,
          COUNT(*) AS attempts,
          COUNT(DISTINCT episode_id) AS signals,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active,
          COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT')), 0) AS resolved,
          AVG(entry_jump_pct) AS average_entry_jump_pct,
          AVG(max_favorable_return_pct) AS average_mfe_pct,
          AVG(max_adverse_return_pct) AS average_mae_pct
        FROM bonding_curve_momentum_shadow_positions
        GROUP BY cohort_id, entry_profile_id, exit_profile_id
        ORDER BY entry_profile_id, exit_profile_id
      `).all();
      return groups.map((group) => {
        const resolved = this.db.prepare(`
          SELECT net_return_pct, gross_return_pct, max_favorable_return_pct
          FROM bonding_curve_momentum_shadow_positions
          WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
            AND net_return_pct IS NOT NULL
          ORDER BY net_return_pct
        `).all(group.cohort_id);
        const returns = resolved.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
        const wins = returns.filter((value) => value > 0).sort((left, right) => right - left);
        const losses = returns.filter((value) => value < 0);
        const flat = returns.filter((value) => value === 0);
        const totalProfit = wins.reduce((sum, value) => sum + value, 0);
        const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
        const middle = Math.floor(returns.length / 2);
        const median = returns.length
          ? returns.length % 2 ? returns[middle] : (returns[middle - 1] + returns[middle]) / 2
          : null;
        const exTop5 = [...wins.slice(5), ...flat, ...losses];
        const opportunities = resolved.filter((row) => (
          Number(row.max_favorable_return_pct) >= threshold
        ));
        const realized = resolved.filter((row) => Number(row.gross_return_pct) >= threshold);
        const captures = opportunities.map((row) => {
          const maximum = Number(row.max_favorable_return_pct);
          const outcome = Number(row.gross_return_pct);
          return maximum > 0 && Number.isFinite(outcome) ? outcome / maximum * 100 : null;
        }).filter(Number.isFinite);
        return {
          ...group,
          resolved: returns.length,
          average_net_return_pct: returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
          median_net_return_pct: median,
          average_net_return_ex_top5_pct: exTop5.length
            ? exTop5.reduce((sum, value) => sum + value, 0) / exTop5.length : null,
          win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
          profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
          max_winner_pct: wins[0] ?? null,
          top_5_winner_contribution_pct: totalProfit > 0
            ? wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit * 100
            : null,
          big_winner_threshold_pct: threshold,
          big_winner_opportunities: opportunities.length,
          big_winners_realized: realized.length,
          big_winner_realization_rate_pct: opportunities.length
            ? realized.length / opportunities.length * 100 : null,
          average_big_winner_capture_pct: captures.length
            ? captures.reduce((sum, value) => sum + value, 0) / captures.length : null,
        };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats(`bonding-momentum:${threshold}`, 60_000, computeCohorts)
      : computeCohorts();
    const snapshots = this.db.prepare(`
      SELECT * FROM bonding_curve_momentum_shadow_snapshots
      ORDER BY COALESCE(observed_at, target_at) DESC, id DESC
      LIMIT ?
    `).all(safeLimit(snapshotLimit, 40));
    const snapshotStats = this.db.prepare(`
      SELECT entry_profile_id, horizon_ms,
        COUNT(*) AS samples,
        COALESCE(SUM(status = 'OBSERVED'), 0) AS observed,
        COALESCE(SUM(status = 'NO_TRADE'), 0) AS no_trade,
        AVG(CASE WHEN status = 'OBSERVED' THEN gross_return_pct END)
          AS average_gross_return_pct,
        AVG(CASE WHEN status = 'OBSERVED' THEN max_favorable_return_pct END)
          AS average_mfe_pct,
        AVG(CASE WHEN status = 'OBSERVED' THEN max_adverse_return_pct END)
          AS average_mae_pct
      FROM bonding_curve_momentum_shadow_snapshots
      GROUP BY entry_profile_id, horizon_ms
      ORDER BY entry_profile_id, horizon_ms
    `).all();
    return { cohorts, positions, snapshots, snapshotStats };
  }

  graduationHoldShadowDashboard({ positionLimit = 30, bigWinnerPct = 50 } = {}) {
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(positionLimit) || 30)));
    const positions = this.db.prepare(`
      SELECT *,
        CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
          THEN exit_at - entry_at ELSE NULL END AS hold_ms
      FROM graduation_hold_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')
        THEN 0 ELSE 1 END, updated_at DESC, id DESC
      LIMIT ?
    `).all(limit).map((row) => {
      let lastFeatures = null;
      let checkpointHistory = [];
      try { lastFeatures = row.last_features_json ? JSON.parse(row.last_features_json) : null; }
      catch (_) { lastFeatures = { parseError: true }; }
      try { checkpointHistory = JSON.parse(row.checkpoint_history_json || '[]'); }
      catch (_) { checkpointHistory = []; }
      return { ...row, last_features: lastFeatures, checkpoint_history: checkpointHistory };
    });
    const groups = this.db.prepare(`
      SELECT cohort_id, exit_mode,
        COUNT(*) AS attempts,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS independent_mints,
        COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rejected,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
        COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
        COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT')), 0) AS resolved,
        COALESCE(SUM(graduation_ready = 1), 0) AS graduation_ready,
        COALESCE(SUM(graduated_at IS NOT NULL), 0) AS graduated,
        AVG(gates_passed) AS average_gates_passed,
        AVG(entry_jump_pct) AS average_entry_jump_pct,
        AVG(max_favorable_return_pct) AS average_mfe_pct,
        AVG(max_adverse_return_pct) AS average_mae_pct
      FROM graduation_hold_shadow_positions
      GROUP BY cohort_id, exit_mode
      ORDER BY cohort_id
    `).all();
    const threshold = Math.max(1, Number(bigWinnerPct) || 50);
    const cohorts = groups.map((group) => {
      const resolved = this.db.prepare(`
        SELECT net_return_pct, gross_return_pct, max_favorable_return_pct
        FROM graduation_hold_shadow_positions
        WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
          AND net_return_pct IS NOT NULL
        ORDER BY net_return_pct
      `).all(group.cohort_id);
      const returns = resolved.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
      const wins = returns.filter((value) => value > 0).sort((a, b) => b - a);
      const losses = returns.filter((value) => value < 0);
      const totalProfit = wins.reduce((sum, value) => sum + value, 0);
      const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const exTop5 = [...wins.slice(5), ...returns.filter((value) => value <= 0)];
      const sorted = [...returns].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length
        ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
        : null;
      const opportunities = resolved.filter((row) => Number(row.max_favorable_return_pct) >= threshold);
      const realized = resolved.filter((row) => Number(row.gross_return_pct) >= threshold);
      return {
        ...group,
        resolved: returns.length,
        average_net_return_pct: returns.length
          ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
        median_net_return_pct: median,
        win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
        profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
        average_net_return_ex_top5_pct: exTop5.length
          ? exTop5.reduce((sum, value) => sum + value, 0) / exTop5.length : null,
        top_5_winner_contribution_pct: totalProfit > 0
          ? wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit * 100 : null,
        big_winner_threshold_pct: threshold,
        big_winner_opportunities: opportunities.length,
        big_winners_realized: realized.length,
        big_winner_realization_rate_pct: opportunities.length
          ? realized.length / opportunities.length * 100 : null,
      };
    });
    return { cohorts, positions };
  }

  graduationAccelerationShadowDashboard({
    positionLimit = 100,
    bigWinnerPct = 50,
    cacheStats = false,
  } = {}) {
    const limit = Math.min(300, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const positions = this.db.prepare(`
      SELECT *, CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
        THEN exit_at - entry_at ELSE NULL END AS hold_ms
      FROM graduation_acceleration_shadow_positions
      ORDER BY CASE WHEN status IN (
        'PENDING_ENTRY', 'OPEN', 'CORE_EXIT_PENDING', 'RUNNER', 'EXIT_PENDING'
      ) THEN 0 ELSE 1 END, updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const threshold = Math.max(1, Number(bigWinnerPct) || 50);
    const computeCohorts = () => {
      const groups = this.db.prepare(`
        SELECT cohort_id, entry_profile_id, position_sol,
          COUNT(*) AS signals,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status IN (
            'PENDING_ENTRY', 'OPEN', 'CORE_EXIT_PENDING', 'RUNNER', 'EXIT_PENDING'
          )), 0) AS active,
          COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
          COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
          COALESCE(SUM(graduated_at IS NOT NULL), 0) AS graduated,
          AVG(entry_jump_pct) AS average_entry_jump_pct,
          AVG(entry_impact_pct) AS average_entry_impact_pct,
          AVG(max_favorable_return_pct) AS average_mfe_pct,
          AVG(max_adverse_return_pct) AS average_mae_pct
        FROM graduation_acceleration_shadow_positions
        GROUP BY cohort_id, entry_profile_id, position_sol
        ORDER BY entry_profile_id, position_sol
      `).all();
      const resolved = this.db.prepare(`
        SELECT net_return_pct, max_favorable_return_pct
        FROM graduation_acceleration_shadow_positions
        WHERE cohort_id = ? AND status = 'CLOSED' AND net_return_pct IS NOT NULL
        ORDER BY net_return_pct
      `);
      return groups.map((group) => {
        const rows = resolved.all(group.cohort_id);
        const returns = rows.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
        const wins = returns.filter((value) => value > 0).sort((a, b) => b - a);
        const losses = returns.filter((value) => value < 0);
        const sorted = [...returns].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const median = sorted.length
          ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
          : null;
        const totalProfit = wins.reduce((sum, value) => sum + value, 0);
        const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
        const bigWinners = rows.filter((row) => Number(row.net_return_pct) >= threshold);
        const exTop1 = wins.length ? [...wins.slice(1), ...losses] : losses;
        return {
          ...group,
          resolved: returns.length,
          exit_coverage_pct: group.closed + group.no_exit > 0
            ? group.closed / (group.closed + group.no_exit) * 100 : null,
          migration_rate_pct: group.signals > 0 ? group.graduated / group.signals * 100 : null,
          average_net_return_pct: returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
          median_net_return_pct: median,
          win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
          profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
          max_winner_pct: wins[0] ?? null,
          average_net_return_ex_top1_pct: exTop1.length
            ? exTop1.reduce((sum, value) => sum + value, 0) / exTop1.length : null,
          big_winners: bigWinners.length,
          top_3_winner_contribution_pct: totalProfit > 0
            ? wins.slice(0, 3).reduce((sum, value) => sum + value, 0) / totalProfit * 100
            : null,
        };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats(`graduation-accel:${threshold}`, 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  holderGrowthShadowDashboard({
    positionLimit = 100,
    bigWinnerPct = 50,
    cacheStats = false,
  } = {}) {
    const limit = Math.min(300, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const positions = this.db.prepare(`
      SELECT *,
        CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
          THEN exit_at - entry_at ELSE NULL END AS hold_ms
      FROM holder_growth_shadow_positions
      ORDER BY
        CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const compute = () => {
      const groups = this.db.prepare(`
        SELECT cohort_id, entry_profile_id, exit_profile_id,
          COUNT(*) AS attempts,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
          COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
          COALESCE(SUM(status = 'CLOSED'), 0) AS resolved,
          COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
          COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT')), 0) AS exit_attempts,
          AVG(buyers) AS average_buyers,
          AVG(new_buyers) AS average_new_buyers,
          AVG(retention_pct) AS average_retention_pct,
          AVG(net_flow_sol) AS average_net_flow_sol,
          AVG(top3_share_pct) AS average_top3_share_pct,
          AVG(entry_jump_pct) AS average_entry_jump_pct,
          AVG(max_favorable_return_pct) AS average_mfe_pct,
          AVG(max_adverse_return_pct) AS average_mae_pct
        FROM holder_growth_shadow_positions
        GROUP BY cohort_id, entry_profile_id, exit_profile_id
        ORDER BY entry_profile_id
      `).all();
      const outcomesStatement = this.db.prepare(`
        SELECT status, configured_cost_pct, net_return_pct, gross_return_pct,
          max_favorable_return_pct
        FROM holder_growth_shadow_positions
        WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
        ORDER BY net_return_pct
      `);
      return groups.map((group) => {
        const outcomeRows = outcomesStatement.all(group.cohort_id);
        const resolvedRows = outcomeRows.filter((row) => (
          row.status === 'CLOSED' && Number.isFinite(Number(row.net_return_pct))
        ));
        const returns = resolvedRows.map((row) => Number(row.net_return_pct))
          .filter(Number.isFinite);
        const noExitRows = outcomeRows.filter((row) => row.status === 'NO_EXIT');
        const conservativeReturns = outcomeRows.map((row) => (
          row.status === 'CLOSED' && Number.isFinite(Number(row.net_return_pct))
            ? Number(row.net_return_pct)
            : -100 - (Number(row.configured_cost_pct) || 0)
        ));
        const wins = returns.filter((value) => value > 0).sort((a, b) => b - a);
        const losses = returns.filter((value) => value < 0);
        const totalProfit = wins.reduce((sum, value) => sum + value, 0);
        const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
        const middle = Math.floor(returns.length / 2);
        const median = returns.length
          ? returns.length % 2 ? returns[middle] : (returns[middle - 1] + returns[middle]) / 2
          : null;
        const exTop5 = [...returns].sort((left, right) => right - left).slice(5);
        const opportunities = resolvedRows.filter((row) => (
          Number(row.max_favorable_return_pct) >= bigWinnerPct
        ));
        const realizedBigWinners = resolvedRows.filter((row) => (
          Number(row.gross_return_pct) >= bigWinnerPct
        ));
        const captures = resolvedRows.map((row) => {
          const mfe = Number(row.max_favorable_return_pct);
          const gross = Number(row.gross_return_pct);
          return mfe > 0 && Number.isFinite(gross) ? gross / mfe * 100 : null;
        }).filter(Number.isFinite);
        return {
          ...group,
          resolved: returns.length,
          no_exit: noExitRows.length,
          no_exit_rate_pct: outcomeRows.length
            ? noExitRows.length / outcomeRows.length * 100 : null,
          average_net_return_pct: returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
          conservative_average_net_return_pct: conservativeReturns.length
            ? conservativeReturns.reduce((sum, value) => sum + value, 0)
              / conservativeReturns.length
            : null,
          conservative_win_rate_pct: conservativeReturns.length
            ? conservativeReturns.filter((value) => value > 0).length
              / conservativeReturns.length * 100
            : null,
          median_net_return_pct: median,
          win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
          profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
          average_net_return_ex_top5_pct: exTop5.length
            ? exTop5.reduce((sum, value) => sum + value, 0) / exTop5.length : null,
          max_winner_pct: wins[0] ?? null,
          top_5_winner_contribution_pct: totalProfit > 0
            ? wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit * 100
            : null,
          big_winner_threshold_pct: bigWinnerPct,
          big_winner_opportunities: opportunities.length,
          big_winners_realized: realizedBigWinners.length,
          big_winner_realization_rate_pct: opportunities.length
            ? realizedBigWinners.length / opportunities.length * 100 : null,
          average_mfe_capture_pct: captures.length
            ? captures.reduce((sum, value) => sum + value, 0) / captures.length : null,
        };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats('holder-growth-shadow', 60_000, compute)
      : compute();
    return { cohorts, positions };
  }

  qualityLeaderShadowDashboard({ positionLimit = 100, bigWinnerPct = 100 } = {}) {
    const limit = Math.min(300, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const positions = this.db.prepare(`
      SELECT *, CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
        THEN exit_at - entry_at ELSE NULL END AS hold_ms
      FROM quality_leader_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const groups = this.db.prepare(`
      SELECT cohort_id, entry_profile_id, exit_profile_id,
        COUNT(*) AS attempts, COUNT(DISTINCT mint) AS independent_mints,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
        COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
        COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
        COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
        COALESCE(SUM(status = 'CLOSED'), 0) AS resolved,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        AVG(return_10_pct) AS average_return_10_pct,
        AVG(drawdown_20_pct) AS average_drawdown_20_pct,
        AVG(buyer_delta) AS average_buyer_delta,
        AVG(net_flow_delta_sol) AS average_net_flow_delta_sol,
        AVG(retention_20_pct) AS average_retention_20_pct,
        AVG(creator_share_20_pct) AS average_creator_share_20_pct,
        AVG(curve_20_pct) AS average_curve_20_pct,
        AVG(entry_jump_pct) AS average_entry_jump_pct,
        AVG(max_favorable_return_pct) AS average_mfe_pct,
        AVG(max_adverse_return_pct) AS average_mae_pct
      FROM quality_leader_shadow_positions
      GROUP BY cohort_id, entry_profile_id, exit_profile_id
      ORDER BY entry_profile_id, exit_profile_id
    `).all();
    const outcomes = this.db.prepare(`
      SELECT net_return_pct, gross_return_pct, max_favorable_return_pct
      FROM quality_leader_shadow_positions
      WHERE cohort_id = ? AND status = 'CLOSED' AND net_return_pct IS NOT NULL
      ORDER BY net_return_pct DESC
    `);
    const cohorts = groups.map((group) => {
      const rows = outcomes.all(group.cohort_id);
      const returns = rows.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
      const sorted = [...returns].sort((a, b) => a - b);
      const wins = returns.filter((value) => value > 0).sort((a, b) => b - a);
      const losses = returns.filter((value) => value < 0);
      const totalProfit = wins.reduce((sum, value) => sum + value, 0);
      const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const middle = Math.floor(sorted.length / 2);
      const exTop5 = [...returns].sort((a, b) => b - a).slice(5);
      const opportunities = rows.filter((row) => Number(row.max_favorable_return_pct) >= bigWinnerPct);
      const realized = rows.filter((row) => Number(row.gross_return_pct) >= bigWinnerPct);
      return {
        ...group,
        resolved: returns.length,
        average_net_return_pct: returns.length
          ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
        median_net_return_pct: sorted.length
          ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
          : null,
        win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
        profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
        average_net_return_ex_top5_pct: exTop5.length
          ? exTop5.reduce((sum, value) => sum + value, 0) / exTop5.length : null,
        max_winner_pct: wins[0] ?? null,
        top_5_winner_contribution_pct: totalProfit > 0
          ? wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit * 100 : null,
        big_winner_threshold_pct: bigWinnerPct,
        big_winner_opportunities: opportunities.length,
        big_winners_realized: realized.length,
        big_winner_realization_rate_pct: opportunities.length
          ? realized.length / opportunities.length * 100 : null,
      };
    });
    return { cohorts, positions };
  }

  launchQualityDashboard({ observationLimit = 30, snapshotLimit = 60 } = {}) {
    const safeLimit = (value, fallback) => Math.min(
      200,
      Math.max(1, Math.trunc(Number(value) || fallback)),
    );
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) AS observations,
        COALESCE(SUM(status = 'OBSERVING'), 0) AS observing,
        COALESCE(SUM(rebound_at IS NOT NULL), 0) AS reference_pullbacks,
        COALESCE(SUM(label_status = 'COMPLETE'), 0) AS complete_labels,
        COALESCE(SUM(label_status = 'RIGHT_CENSORED'), 0) AS right_censored,
        COALESCE(SUM(label_status = 'NO_REFERENCE'), 0) AS no_reference,
        AVG(CASE WHEN label_status = 'COMPLETE' THEN return_3s END) AS average_return_3s,
        AVG(CASE WHEN label_status = 'COMPLETE' THEN return_5s END) AS average_return_5s,
        AVG(CASE WHEN label_status = 'COMPLETE' THEN return_10s END) AS average_return_10s,
        AVG(CASE WHEN label_status = 'COMPLETE' THEN return_30s END) AS average_return_30s
      FROM launch_quality_observations
    `).get();
    const observations = this.db.prepare(`
      SELECT * FROM launch_quality_observations
      ORDER BY
        CASE WHEN status = 'OBSERVING' THEN 0 ELSE 1 END,
        updated_at DESC, created_at DESC
      LIMIT ?
    `).all(safeLimit(observationLimit, 30)).map((row) => {
      let referenceFeatures = null;
      try {
        referenceFeatures = row.reference_features_json
          ? JSON.parse(row.reference_features_json) : null;
      } catch (_) {
        referenceFeatures = { parseError: true };
      }
      return { ...row, reference_features: referenceFeatures };
    });
    const snapshots = this.db.prepare(`
      SELECT snapshot.*, observation.symbol, observation.creator
      FROM launch_quality_snapshots AS snapshot
      JOIN launch_quality_observations AS observation USING(mint)
      ORDER BY snapshot.observed_at DESC, snapshot.id DESC
      LIMIT ?
    `).all(safeLimit(snapshotLimit, 60));
    return { stats, observations, snapshots };
  }

  recentSmartWalletEvents(timestampMs) {
    return this.stmts.recentSmartWalletEvents.all(timestampMs);
  }

  primarySignalShadowDashboard({ positionLimit = 200, cacheStats = false } = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(positionLimit) || 200)));
    const positions = this.db.prepare(`
      SELECT p.*, s.signal_variant,
        CASE
          WHEN p.entry_at IS NOT NULL AND p.exit_at IS NOT NULL THEN p.exit_at - p.entry_at
          ELSE NULL
        END AS hold_ms
      FROM primary_signal_shadow_positions p
      JOIN flow_signals s ON s.signal_id = p.signal_id
      ORDER BY
        CASE WHEN p.status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        p.updated_at DESC, p.id DESC
      LIMIT ?
    `).all(limit);
    const computeStats = () => this.db.prepare(`
      SELECT
        COUNT(*) AS evaluated,
        COALESCE(SUM(rule_matched = 1), 0) AS matched,
        COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rule_rejected,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
        COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
        COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
        COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        AVG(CASE WHEN status IN ('CLOSED', 'NO_EXIT') THEN net_return_pct END)
          AS average_net_return_pct,
        COALESCE(SUM(status IN ('CLOSED', 'NO_EXIT') AND net_return_pct > 0), 0) AS wins,
        AVG(CASE
          WHEN status = 'CLOSED' AND entry_at IS NOT NULL AND exit_at IS NOT NULL
            THEN exit_at - entry_at
        END) AS average_hold_ms
      FROM primary_signal_shadow_positions
    `).get();
    const stats = cacheStats
      ? this._cachedDashboardStats('primary-signal-shadow:stats', 60_000, computeStats)
      : computeStats();
    const computeProfiles = () => this.db.prepare(`
      SELECT
        s.signal_variant,
        COUNT(*) AS evaluated,
        COALESCE(SUM(p.rule_matched = 1), 0) AS matched,
        COALESCE(SUM(p.status = 'CLOSED'), 0) AS closed_positions,
        COALESCE(SUM(p.status = 'NO_EXIT'), 0) AS no_exit,
        AVG(CASE WHEN p.status IN ('CLOSED', 'NO_EXIT') THEN p.net_return_pct END)
          AS average_net_return_pct,
        COALESCE(SUM(p.status IN ('CLOSED', 'NO_EXIT') AND p.net_return_pct > 0), 0) AS wins
      FROM primary_signal_shadow_positions p
      JOIN flow_signals s ON s.signal_id = p.signal_id
      GROUP BY s.signal_variant
      ORDER BY s.signal_variant
    `).all().map((profile) => {
      const profileResolved = Number(profile.closed_positions || 0) + Number(profile.no_exit || 0);
      return {
        ...profile,
        win_rate_pct: profileResolved > 0
          ? (Number(profile.wins) / profileResolved) * 100
          : null,
      };
    });
    const profiles = cacheStats
      ? this._cachedDashboardStats('primary-signal-shadow:profiles', 60_000, computeProfiles)
      : computeProfiles();
    const resolved = Number(stats.closed_positions || 0) + Number(stats.no_exit || 0);
    return {
      stats: {
        ...stats,
        win_rate_pct: resolved > 0 ? (Number(stats.wins) / resolved) * 100 : null,
      },
      profiles,
      positions,
    };
  }

  flowFirstShadowDashboard({ positionLimit = 200, bigWinnerPct = 50, cacheStats = false } = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(positionLimit) || 200)));
    const threshold = Math.max(1, Number(bigWinnerPct) || 50);
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL THEN exit_at - entry_at
          ELSE NULL
        END AS hold_ms
      FROM flow_first_shadow_positions
      ORDER BY
        CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => {
      const cohortIds = this.db.prepare(`
        SELECT DISTINCT cohort_id FROM flow_first_shadow_positions ORDER BY cohort_id
      `).all().map((row) => row.cohort_id);
      return cohortIds.map((cohortId) => {
      const counts = this.db.prepare(`
        SELECT
          COUNT(*) AS episodes,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rule_rejected,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
          COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
          COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
          COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
          AVG(entry_jump_pct) AS average_entry_jump_pct
        FROM flow_first_shadow_positions WHERE cohort_id = ?
      `).get(cohortId);
      const resolved = this.db.prepare(`
        SELECT net_return_pct, gross_return_pct, max_favorable_return_pct
        FROM flow_first_shadow_positions
        WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
          AND net_return_pct IS NOT NULL
        ORDER BY net_return_pct
      `).all(cohortId);
      const returns = resolved.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
      const wins = returns.filter((value) => value > 0).sort((left, right) => right - left);
      const losses = returns.filter((value) => value < 0);
      const flat = returns.filter((value) => value === 0);
      const totalProfit = wins.reduce((sum, value) => sum + value, 0);
      const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const bigOpportunities = resolved.filter((row) => (
        Number(row.max_favorable_return_pct) >= threshold
      ));
      const bigWinners = resolved.filter((row) => Number(row.gross_return_pct) >= threshold);
      const captures = bigOpportunities.map((row) => {
        const maximum = Number(row.max_favorable_return_pct);
        const realized = Number(row.gross_return_pct);
        return maximum > 0 && Number.isFinite(realized) ? (realized / maximum) * 100 : null;
      }).filter(Number.isFinite);
      const median = returns.length
        ? returns.length % 2 === 1
          ? returns[(returns.length - 1) / 2]
          : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2
        : null;
      const exTop5 = [...wins.slice(5), ...flat, ...losses];
      return {
        cohort_id: cohortId,
        ...counts,
        resolved: returns.length,
        average_net_return_pct: returns.length
          ? returns.reduce((sum, value) => sum + value, 0) / returns.length
          : null,
        median_net_return_pct: median,
        average_net_return_ex_top5_pct: exTop5.length
          ? exTop5.reduce((sum, value) => sum + value, 0) / exTop5.length
          : null,
        win_rate_pct: returns.length ? (wins.length / returns.length) * 100 : null,
        profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
        max_winner_pct: wins[0] ?? null,
        top_5_winner_contribution_pct: totalProfit > 0
          ? (wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit) * 100
          : null,
        big_winner_threshold_pct: threshold,
        big_winner_opportunities: bigOpportunities.length,
        big_winners_realized: bigWinners.length,
        big_winner_realization_rate_pct: bigOpportunities.length
          ? (bigWinners.length / bigOpportunities.length) * 100
          : null,
        average_big_winner_capture_pct: captures.length
          ? captures.reduce((sum, value) => sum + value, 0) / captures.length
          : null,
      };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats(`flow-first-shadow:${threshold}`, 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  smartPullbackShadowDashboard({ positionLimit = 200, bigWinnerPct = 50, cacheStats = false } = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(positionLimit) || 200)));
    const threshold = Math.max(1, Number(bigWinnerPct) || 50);
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL THEN exit_at - entry_at
          ELSE NULL
        END AS hold_ms
      FROM smart_pullback_shadow_positions
      ORDER BY
        CASE WHEN status IN (
          'WAITING_PULLBACK', 'WAITING_REBOUND', 'PENDING_ENTRY', 'OPEN', 'EXIT_PENDING'
        ) THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => {
      const cohortIds = this.db.prepare(`
        SELECT DISTINCT cohort_id FROM smart_pullback_shadow_positions ORDER BY cohort_id
      `).all().map((row) => row.cohort_id);
      return cohortIds.map((cohortId) => {
      const counts = this.db.prepare(`
        SELECT
          COUNT(*) AS episodes,
          COALESCE(SUM(status = 'NO_CONFIRMATION'), 0) AS no_confirmation,
          COALESCE(SUM(status IN ('PRICE_JUMP', 'PRICE_CAP')), 0) AS price_rejected,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status IN (
            'WAITING_PULLBACK', 'WAITING_REBOUND', 'PENDING_ENTRY'
          )), 0) AS pending_entries,
          COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
          COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
          COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit
        FROM smart_pullback_shadow_positions WHERE cohort_id = ?
      `).get(cohortId);
      const resolved = this.db.prepare(`
        SELECT net_return_pct, gross_return_pct, max_favorable_return_pct
        FROM smart_pullback_shadow_positions
        WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
          AND net_return_pct IS NOT NULL
        ORDER BY net_return_pct
      `).all(cohortId);
      const returns = resolved.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
      const wins = returns.filter((value) => value > 0).sort((left, right) => right - left);
      const losses = returns.filter((value) => value < 0);
      const totalProfit = wins.reduce((sum, value) => sum + value, 0);
      const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const bigOpportunities = resolved.filter((row) => (
        Number(row.max_favorable_return_pct) >= threshold
      ));
      const bigWinners = resolved.filter((row) => Number(row.gross_return_pct) >= threshold);
      const captures = bigOpportunities.map((row) => {
        const maximum = Number(row.max_favorable_return_pct);
        const realized = Number(row.gross_return_pct);
        return maximum > 0 && Number.isFinite(realized) ? (realized / maximum) * 100 : null;
      }).filter(Number.isFinite);
      const median = returns.length
        ? returns.length % 2 === 1
          ? returns[(returns.length - 1) / 2]
          : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2
        : null;
      return {
        cohort_id: cohortId,
        ...counts,
        resolved: returns.length,
        average_net_return_pct: returns.length
          ? returns.reduce((sum, value) => sum + value, 0) / returns.length
          : null,
        median_net_return_pct: median,
        win_rate_pct: returns.length ? (wins.length / returns.length) * 100 : null,
        profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
        max_winner_pct: wins[0] ?? null,
        top_5_winner_contribution_pct: totalProfit > 0
          ? (wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit) * 100
          : null,
        big_winner_threshold_pct: threshold,
        big_winner_opportunities: bigOpportunities.length,
        big_winners_realized: bigWinners.length,
        big_winner_realization_rate_pct: bigOpportunities.length
          ? (bigWinners.length / bigOpportunities.length) * 100
          : null,
        average_big_winner_capture_pct: captures.length
          ? captures.reduce((sum, value) => sum + value, 0) / captures.length
          : null,
      };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats(`smart-pullback-shadow:${threshold}`, 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  smartOpenShadowDashboard({ positionLimit = 200, bigWinnerPct = 50, cacheStats = false } = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(positionLimit) || 200)));
    const threshold = Math.max(1, Number(bigWinnerPct) || 50);
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL THEN exit_at - entry_at
          ELSE NULL
        END AS hold_ms
      FROM smart_open_shadow_positions
      ORDER BY
        CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => {
      const cohortIds = this.db.prepare(`
        SELECT DISTINCT cohort_id FROM smart_open_shadow_positions ORDER BY cohort_id
      `).all().map((row) => row.cohort_id);
      return cohortIds.map((cohortId) => {
        const counts = this.db.prepare(`
          SELECT
            COUNT(*) AS evaluated,
            COUNT(DISTINCT mint) AS independent_mints,
            COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rule_rejected,
            COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
            COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
            COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
            COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
            COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
            COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
            AVG(entry_jump_pct) AS average_entry_jump_pct
          FROM smart_open_shadow_positions WHERE cohort_id = ?
        `).get(cohortId);
        const resolved = this.db.prepare(`
          SELECT net_return_pct, gross_return_pct, max_favorable_return_pct, entry_jump_pct
          FROM smart_open_shadow_positions
          WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
            AND net_return_pct IS NOT NULL
          ORDER BY net_return_pct
        `).all(cohortId);
        const returns = resolved.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
        const wins = returns.filter((value) => value > 0).sort((left, right) => right - left);
        const losses = returns.filter((value) => value < 0);
        const flat = returns.filter((value) => value === 0);
        const totalProfit = wins.reduce((sum, value) => sum + value, 0);
        const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
        const bigOpportunities = resolved.filter((row) => (
          Number(row.max_favorable_return_pct) >= threshold
        ));
        const bigWinners = resolved.filter((row) => Number(row.gross_return_pct) >= threshold);
        const captures = bigOpportunities.map((row) => {
          const maximum = Number(row.max_favorable_return_pct);
          const realized = Number(row.gross_return_pct);
          return maximum > 0 && Number.isFinite(realized) ? (realized / maximum) * 100 : null;
        }).filter(Number.isFinite);
        const median = returns.length
          ? returns.length % 2 === 1
            ? returns[(returns.length - 1) / 2]
            : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2
          : null;
        const exTop5 = [...wins.slice(5), ...flat, ...losses];
        const bucketDefinitions = [
          ['at_or_below_2', '≤2%', -Infinity, 2],
          ['between_2_and_5', '2–5%', 2, 5],
          ['between_5_and_10', '5–10%', 5, 10],
          ['above_10', '>10%', 10, Infinity],
        ];
        const entryJumpBuckets = bucketDefinitions.map(([id, label, lower, upper]) => {
          const bucketRows = resolved.filter((row) => {
            const jump = Number(row.entry_jump_pct);
            return Number.isFinite(jump) && jump > lower && jump <= upper;
          });
          return {
            id,
            label,
            resolved: bucketRows.length,
            average_net_return_pct: bucketRows.length
              ? bucketRows.reduce((sum, row) => sum + Number(row.net_return_pct), 0)
                / bucketRows.length
              : null,
          };
        });
        return {
          cohort_id: cohortId,
          ...counts,
          qualified_opens: Number(counts.evaluated || 0) - Number(counts.rule_rejected || 0),
          resolved: returns.length,
          average_net_return_pct: returns.length
            ? returns.reduce((sum, value) => sum + value, 0) / returns.length
            : null,
          median_net_return_pct: median,
          average_net_return_ex_top5_pct: exTop5.length
            ? exTop5.reduce((sum, value) => sum + value, 0) / exTop5.length
            : null,
          win_rate_pct: returns.length ? (wins.length / returns.length) * 100 : null,
          profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
          max_winner_pct: wins[0] ?? null,
          top_5_winner_contribution_pct: totalProfit > 0
            ? (wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit) * 100
            : null,
          big_winner_threshold_pct: threshold,
          big_winner_opportunities: bigOpportunities.length,
          big_winners_realized: bigWinners.length,
          big_winner_realization_rate_pct: bigOpportunities.length
            ? (bigWinners.length / bigOpportunities.length) * 100
            : null,
          average_big_winner_capture_pct: captures.length
            ? captures.reduce((sum, value) => sum + value, 0) / captures.length
            : null,
          entry_jump_buckets: entryJumpBuckets,
        };
      });
    };
    const cohorts = cacheStats
      ? this._cachedDashboardStats(`smart-open-shadow:${threshold}`, 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  flowSmartConfirmShadowDashboard({ positionLimit = 200, cacheStats = false } = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(positionLimit) || 200)));
    const positions = this.db.prepare(`
      SELECT *, CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
        THEN exit_at - entry_at ELSE NULL END AS hold_ms
      FROM flow_smart_confirm_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    const computeCohorts = () => this.db.prepare(`
      SELECT DISTINCT cohort_id FROM flow_smart_confirm_shadow_positions ORDER BY cohort_id
    `).all().map(({ cohort_id: cohortId }) => {
      const counts = this.db.prepare(`
        SELECT COUNT(*) AS evaluated, COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rule_rejected,
          COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
          COALESCE(SUM(status = 'NO_ENTRY'), 0) AS no_entry,
          COALESCE(SUM(status = 'PENDING_ENTRY'), 0) AS pending_entries,
          COALESCE(SUM(status IN ('OPEN', 'EXIT_PENDING')), 0) AS active_positions,
          COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
          COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
          AVG(confirmation_delay_ms) AS average_confirmation_delay_ms,
          AVG(entry_jump_pct) AS average_entry_jump_pct
        FROM flow_smart_confirm_shadow_positions WHERE cohort_id = ?
      `).get(cohortId);
      const returns = this.db.prepare(`
        SELECT net_return_pct FROM flow_smart_confirm_shadow_positions
        WHERE cohort_id = ? AND status IN ('CLOSED', 'NO_EXIT')
          AND net_return_pct IS NOT NULL ORDER BY net_return_pct
      `).all(cohortId).map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
      const wins = returns.filter((value) => value > 0).sort((a, b) => b - a);
      const losses = returns.filter((value) => value < 0);
      const totalProfit = wins.reduce((sum, value) => sum + value, 0);
      const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const median = returns.length
        ? returns.length % 2
          ? returns[(returns.length - 1) / 2]
          : (returns[returns.length / 2 - 1] + returns[returns.length / 2]) / 2
        : null;
      return {
        cohort_id: cohortId,
        ...counts,
        qualified_confirmations: Number(counts.evaluated || 0) - Number(counts.rule_rejected || 0),
        resolved: returns.length,
        average_net_return_pct: returns.length
          ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
        median_net_return_pct: median,
        win_rate_pct: returns.length ? wins.length / returns.length * 100 : null,
        profit_factor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? null : 0),
        max_winner_pct: wins[0] ?? null,
        top_5_winner_contribution_pct: totalProfit > 0
          ? wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalProfit * 100 : null,
      };
    });
    const cohorts = cacheStats
      ? this._cachedDashboardStats('flow-smart-confirm-shadow', 60_000, computeCohorts)
      : computeCohorts();
    return { cohorts, positions };
  }

  liveTradingDashboard({
    strategyId = null,
    positionLimit = 100,
    orderLimit = 100,
    decisionLimit = 100,
  } = {}) {
    const safeLimit = (value) => Math.min(500, Math.max(1, Math.trunc(Number(value) || 100)));
    const strategy = strategyId ? String(strategyId) : null;
    const filter = strategy ? 'WHERE strategy_id = ?' : '';
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN opened_at IS NOT NULL AND closed_at IS NOT NULL THEN closed_at - opened_at
          ELSE NULL
        END AS hold_ms,
        CASE
          WHEN entry_price > 0 AND exit_price > 0 THEN ((exit_price / entry_price) - 1) * 100
          ELSE NULL
        END AS price_return_pct,
        CASE
          WHEN realized_return_pct IS NOT NULL THEN realized_return_pct
          WHEN mode = 'DRY_RUN' AND entry_price > 0 AND exit_price > 0
            THEN ((exit_price / entry_price) - 1) * 100
          ELSE NULL
        END AS gross_return_pct
      FROM live_positions
      ${filter}
      ORDER BY
        CASE WHEN status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED') THEN 0 ELSE 1 END,
        updated_at DESC,
        id DESC
      LIMIT ?
    `).all(...(strategy ? [strategy, safeLimit(positionLimit)] : [safeLimit(positionLimit)]))
      .map((row) => {
        const legacyCurveComplete = row.status === 'ENTRY_FAILED'
          && row.entry_signature == null
          && /(?:bonding curve already complete|curve complete)/i.test(row.entry_error || '');
        return {
          ...row,
          entry_failure_category: legacyCurveComplete
            ? 'ENTRY_MIGRATED_BEFORE_SUBMIT'
            : null,
        };
      });
    const orders = this.db.prepare(`
      SELECT * FROM live_orders ${filter}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...(strategy ? [strategy, safeLimit(orderLimit)] : [safeLimit(orderLimit)])).map((row) => {
      let execution = null;
      try {
        execution = row.execution_json ? JSON.parse(row.execution_json) : null;
      } catch (_) {
        execution = { parseError: true };
      }
      return { ...row, execution };
    });
    const decisions = this.db.prepare(`
      SELECT * FROM live_strategy_decisions ${filter}
      ORDER BY timestamp_ms DESC, id DESC
      LIMIT ?
    `).all(...(strategy ? [strategy, safeLimit(decisionLimit)] : [safeLimit(decisionLimit)])).map((row) => {
      let rejectionReasons = [];
      let features = {};
      try {
        const parsed = JSON.parse(row.rejection_reasons_json || '[]');
        if (Array.isArray(parsed)) rejectionReasons = parsed;
      } catch (_) {
        rejectionReasons = ['INVALID_REJECTION_REASONS'];
      }
      try {
        features = JSON.parse(row.features_json || '{}');
      } catch (_) {
        features = { parseError: true };
      }
      return { ...row, rejection_reasons: rejectionReasons, features };
    });
    const decisionStats = this.db.prepare(`
      SELECT
        COUNT(*) AS decisions,
        COALESCE(SUM(rule_matched = 1), 0) AS matched,
        COALESCE(SUM(action_status = 'RULE_REJECTED'), 0) AS rule_rejected,
        COALESCE(SUM(action_status = 'MATCHED_DISABLED'), 0) AS matched_disabled,
        COALESCE(SUM(action_status = 'RISK_REJECTED'), 0) AS risk_rejected
      FROM live_strategy_decisions ${filter}
    `).get(...(strategy ? [strategy] : []));
    const positionStats = this.db.prepare(`
      SELECT
        COUNT(*) AS positions,
        COALESCE(SUM(status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED')), 0) AS active_positions,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
        COALESCE(SUM(status = 'ENTRY_FAILED'), 0) AS entry_failed_positions,
        COALESCE(SUM(
          status = 'ENTRY_FAILED' AND (
            COALESCE(exit_reason, '') = 'ENTRY_MIGRATED_BEFORE_SUBMIT'
            OR (
              entry_signature IS NULL
              AND (
                COALESCE(entry_error, '') LIKE '%Bonding curve already complete%'
                OR COALESCE(entry_error, '') LIKE '%Curve complete%'
              )
            )
          )
        ), 0) AS pre_submit_migrated_positions,
        COALESCE(SUM(
          status = 'ENTRY_FAILED'
          AND NOT (
            COALESCE(exit_reason, '') = 'ENTRY_MIGRATED_BEFORE_SUBMIT'
            OR (
              entry_signature IS NULL
              AND (
                COALESCE(entry_error, '') LIKE '%Bonding curve already complete%'
                OR COALESCE(entry_error, '') LIKE '%Curve complete%'
              )
            )
          )
          AND entry_signature IS NULL AND exit_reason IN (
            'ENTRY_REJECTED', 'ENTRY_PRICE_JUMP', 'ENTRY_WALLET_RESERVE_REJECTED',
            'ENTRY_MARKET_PRICE_MOVED', 'ENTRY_SELF_IMPACT_REJECTED'
          )
        ), 0) AS pre_submit_guard_rejected_positions,
        COALESCE(SUM(
          status = 'ENTRY_FAILED' AND NOT (
            COALESCE(exit_reason, '') = 'ENTRY_MIGRATED_BEFORE_SUBMIT'
            OR (
              entry_signature IS NULL
              AND (
                COALESCE(entry_error, '') LIKE '%Bonding curve already complete%'
                OR COALESCE(entry_error, '') LIKE '%Curve complete%'
              )
            )
            OR (
              entry_signature IS NULL AND exit_reason IN (
                'ENTRY_REJECTED', 'ENTRY_PRICE_JUMP', 'ENTRY_WALLET_RESERVE_REJECTED',
                'ENTRY_MARKET_PRICE_MOVED', 'ENTRY_SELF_IMPACT_REJECTED'
              )
            )
          )
        ), 0) AS execution_entry_failed_positions,
        COALESCE(SUM(status = 'EXIT_FAILED'), 0) AS exit_failed_positions,
        COALESCE(SUM(CASE WHEN opened_at IS NOT NULL THEN position_sol ELSE 0 END), 0) AS deployed_sol,
        AVG(CASE WHEN opened_at IS NOT NULL AND closed_at IS NOT NULL THEN closed_at - opened_at END) AS average_hold_ms,
        COALESCE(SUM(status = 'CLOSED' AND entry_price > 0 AND exit_price > 0), 0) AS priced_closed_positions,
        COALESCE(SUM(status = 'CLOSED' AND realized_pnl_sol IS NOT NULL), 0) AS settled_closed_positions,
        COALESCE(SUM(status = 'CLOSED' AND realized_pnl_sol > 0), 0) AS wins,
        SUM(CASE WHEN status = 'CLOSED' THEN realized_pnl_sol END) AS total_realized_pnl_sol,
        AVG(CASE WHEN status = 'CLOSED' THEN realized_return_pct END)
          AS average_realized_return_pct,
        AVG(CASE
          WHEN status = 'CLOSED' AND entry_price > 0 AND exit_price > 0
            THEN ((exit_price / entry_price) - 1) * 100
        END) AS average_gross_return_pct
      FROM live_positions ${filter}
    `).get(...(strategy ? [strategy] : []));
    const orderStats = this.db.prepare(`
      SELECT
        COUNT(*) AS orders,
        COALESCE(SUM(status IN (
          'CONFIRMED', 'CONFIRMED_PARTIAL', 'CONFIRMED_UNVERIFIED', 'ALREADY_EMPTY'
        )), 0) AS confirmed_orders,
        COALESCE(SUM(status = 'FAILED'), 0) AS failed_orders,
        COALESCE(SUM(status = 'CONFIRMATION_UNKNOWN'), 0) AS unknown_orders
      FROM live_orders ${filter}
    `).get(...(strategy ? [strategy] : []));
    const settledClosed = Number(positionStats.settled_closed_positions) || 0;
    const wins = Number(positionStats.wins) || 0;

    return {
      stats: {
        ...decisionStats,
        ...positionStats,
        ...orderStats,
        win_rate_pct: settledClosed > 0 ? (wins / settledClosed) * 100 : null,
      },
      positions,
      orders,
      decisions,
      strategyId: strategy,
    };
  }

  overview(now = Date.now(), candidateCount = 0) {
    const localStart = new Date(now);
    localStart.setHours(0, 0, 0, 0);
    const since = localStart.getTime();
    const activeSince = now - 10 * 60_000;
    return {
      rawTradesToday: this.db.prepare('SELECT COUNT(*) AS n FROM raw_trades WHERE timestamp_ms >= ?').get(since).n,
      activeTokens: this.db.prepare('SELECT COUNT(*) AS n FROM flow_tokens WHERE last_trade_at >= ?').get(activeSince).n,
      candidateCount,
      flowSignalsToday: this.db.prepare(`
        SELECT COUNT(*) AS n FROM flow_signals WHERE timestamp_ms >= ? AND is_primary = 1
      `).get(since).n,
      shadowSignalsToday: this.db.prepare(`
        SELECT COUNT(*) AS n FROM flow_signals
        WHERE timestamp_ms >= ? AND is_primary = 0
          AND signal_variant NOT LIKE 'primary_early_%'
      `).get(since).n,
      earlyThresholdSignalsToday: this.db.prepare(`
        SELECT COUNT(*) AS n FROM flow_signals
        WHERE timestamp_ms >= ? AND signal_variant LIKE 'primary_early_%'
      `).get(since).n,
      smartWalletTradesToday: this.db.prepare('SELECT COUNT(*) AS n FROM smart_wallet_events WHERE timestamp_ms >= ?').get(since).n,
    };
  }

  recentSignals(limit = 200) {
    return this.db.prepare(`
      SELECT s.*, r.return_5s, r.return_10s, r.return_30s, r.mfe_10s, r.mae_10s
      FROM flow_signals s
      LEFT JOIN signal_returns r USING(signal_id)
      WHERE s.is_primary = 1
      ORDER BY s.timestamp_ms DESC
      LIMIT ?
    `).all(Math.min(1_000, Math.max(1, limit)));
  }

  smartWalletStats(wallets) {
    const result = [];
    const eventStatement = this.db.prepare(`
      SELECT * FROM smart_wallet_events WHERE wallet = ? ORDER BY timestamp_ms
    `);
    for (const wallet of wallets) {
      const events = eventStatement.all(wallet);
      const open = new Map();
      const holds = [];
      const phasedBuys = [];
      for (const event of events) {
        if (event.side === 'BUY') {
          const phase = event.position_phase || (open.has(event.mint) ? 'ADD' : 'OPEN');
          phasedBuys.push({ ...event, phase });
          if (phase === 'OPEN') open.set(event.mint, event.timestamp_ms);
        }
        if (event.position_phase === 'CLOSE' && open.has(event.mint)) {
          holds.push(event.timestamp_ms - open.get(event.mint));
          open.delete(event.mint);
        }
      }
      const buys = phasedBuys;
      const openingBuys = buys.filter((event) => event.phase === 'OPEN');
      const addBuys = buys.filter((event) => event.phase === 'ADD');
      const average = (values) => values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : null;
      const overlapPct = (rows, windowMs) => rows.length
        ? (rows.filter((event) => Number.isFinite(event.time_from_flow_signal_ms)
          && event.time_from_flow_signal_ms >= 0
          && event.time_from_flow_signal_ms <= windowMs).length / rows.length) * 100
        : null;
      result.push({
        wallet,
        trades: events.length,
        boughtTokens: new Set(buys.map((event) => event.mint)).size,
        averageHoldMs: average(holds),
        averageBuyCurvePct: average(buys.map((event) => event.curve_pct).filter(Number.isFinite)),
        averageBuyAgeMs: average(buys.map((event) => event.age_ms).filter(Number.isFinite)),
        buyEvents: buys.length,
        openBuys: openingBuys.length,
        addBuys: addBuys.length,
        primaryOverlap30Pct: overlapPct(buys, 30_000),
        openSignalOverlap5Pct: overlapPct(openingBuys, 5_000),
        openSignalOverlap10Pct: overlapPct(openingBuys, 10_000),
        openSignalOverlap30Pct: overlapPct(openingBuys, 30_000),
        addSignalOverlap30Pct: overlapPct(addBuys, 30_000),
        flowSignalOverlapPct: overlapPct(buys, 30_000),
        averageTimeFromSignalMs: average(
          buys.map((event) => event.time_from_flow_signal_ms).filter(Number.isFinite),
        ),
      });
    }
    return result;
  }

  signalRepetitionStats() {
    const signals = this.db.prepare(`
      SELECT signal_id, mint, timestamp_ms, signal_episode_id
      FROM flow_signals
      WHERE is_primary = 1
      ORDER BY timestamp_ms, signal_id
    `).all();
    const lastByMint = new Map();
    let laterSignals = 0;
    let within5s = 0;
    let within10s = 0;
    let within30s = 0;
    for (const signal of signals) {
      const previous = lastByMint.get(signal.mint);
      if (Number.isFinite(previous)) {
        laterSignals += 1;
        const gap = signal.timestamp_ms - previous;
        if (gap <= 5_000) within5s += 1;
        if (gap <= 10_000) within10s += 1;
        if (gap <= 30_000) within30s += 1;
      }
      lastByMint.set(signal.mint, signal.timestamp_ms);
    }
    const ratio = (value, denominator) => denominator ? value / denominator * 100 : null;
    return {
      primarySignals: signals.length,
      uniqueMints: lastByMint.size,
      signalEpisodes: new Set(signals.map((signal) => signal.signal_episode_id)
        .filter(Boolean)).size,
      laterSignals,
      laterSignalPct: ratio(laterSignals, signals.length),
      repeatedWithin5s: within5s,
      repeatedWithin5sPct: ratio(within5s, laterSignals),
      repeatedWithin10s: within10s,
      repeatedWithin10sPct: ratio(within10s, laterSignals),
      repeatedWithin30s: within30s,
      repeatedWithin30sPct: ratio(within30s, laterSignals),
    };
  }

  health() {
    const rawRows = this.db.prepare('SELECT COUNT(*) AS n FROM raw_trades').get().n;
    const signalRows = this.db.prepare('SELECT COUNT(*) AS n FROM flow_signals').get().n;
    const primarySignalRows = this.db.prepare(`
      SELECT COUNT(*) AS n FROM flow_signals WHERE is_primary = 1
    `).get().n;
    const earlyThresholdSignalRows = this.db.prepare(`
      SELECT COUNT(*) AS n FROM flow_signals WHERE signal_variant LIKE 'primary_early_%'
    `).get().n;
    const smartSignalConfirmations = this.db.prepare(`
      SELECT COUNT(*) AS n FROM smart_signal_confirmations
    `).get().n;
    const primaryLiveDecisions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(rule_matched = 1), 0) AS matched,
        COALESCE(SUM(action_status = 'OPEN'), 0) AS opened,
        COALESCE(SUM(action_status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(action_status IN ('ENTRY_FAILED', 'EXIT_FAILED')), 0) AS failed
      FROM primary_live_decisions
    `).get();
    const livePositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status IN ('ENTRY_FAILED', 'EXIT_FAILED')), 0) AS failed
      FROM live_positions
    `).get();
    const primarySignalShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit
      FROM primary_signal_shadow_positions
    `).get();
    const flowFirstShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit
      FROM flow_first_shadow_positions
    `).get();
    const smartPullbackShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status IN (
          'WAITING_PULLBACK', 'WAITING_REBOUND', 'PENDING_ENTRY', 'OPEN', 'EXIT_PENDING'
        )), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit
      FROM smart_pullback_shadow_positions
    `).get();
    const smartOpenShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rejected
      FROM smart_open_shadow_positions
    `).get();
    const flowSmartConfirmShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rejected
      FROM flow_smart_confirm_shadow_positions
    `).get();
    const launchPullbackShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rejected
      FROM launch_pullback_shadow_positions
    `).get();
    const migratedDropReboundShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COUNT(DISTINCT CASE WHEN lifecycle_stage = 'PRE_MIGRATION' THEN episode_id END)
          AS pre_migration_signals,
        COUNT(DISTINCT CASE WHEN lifecycle_stage = 'POST_MIGRATION' THEN episode_id END)
          AS post_migration_signals,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump
      FROM migrated_drop_rebound_shadow_positions
    `).get();
    const migrationContinuityShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump
      FROM migration_continuity_shadow_positions
    `).get();
    const rangeScalperShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump
      FROM range_scalper_shadow_positions
    `).get();
    const cyaEarlyPyramidShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
        COALESCE(SUM(add_count), 0) AS adds,
        COALESCE(SUM(scale_out_count), 0) AS partial_exits
      FROM cya_early_pyramid_shadow_positions
    `).get();
    const bondingCurveMomentumShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump
      FROM bonding_curve_momentum_shadow_positions
    `).get();
    const bondingCurveMomentumShadowSnapshots = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'OBSERVED'), 0) AS observed,
        COALESCE(SUM(status = 'NO_TRADE'), 0) AS no_trade
      FROM bonding_curve_momentum_shadow_snapshots
    `).get();
    const graduationHoldShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'RULE_REJECTED'), 0) AS rejected,
        COALESCE(SUM(graduation_ready = 1), 0) AS graduation_ready
      FROM graduation_hold_shadow_positions
    `).get();
    const graduationAccelerationShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT episode_id) AS signals,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status IN (
          'PENDING_ENTRY', 'OPEN', 'CORE_EXIT_PENDING', 'RUNNER', 'EXIT_PENDING'
        )), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump,
        COALESCE(SUM(graduated_at IS NOT NULL), 0) AS graduated
      FROM graduation_acceleration_shadow_positions
    `).get();
    const holderGrowthShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump
      FROM holder_growth_shadow_positions
    `).get();
    const qualityLeaderShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(DISTINCT mint) AS mints,
        COALESCE(SUM(status IN ('PENDING_ENTRY', 'OPEN', 'EXIT_PENDING')), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit,
        COALESCE(SUM(status = 'PRICE_JUMP'), 0) AS price_jump
      FROM quality_leader_shadow_positions
    `).get();
    const launchQualityObservations = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'OBSERVING'), 0) AS active,
        COALESCE(SUM(rebound_at IS NOT NULL), 0) AS reference_pullbacks,
        COALESCE(SUM(label_status = 'COMPLETE'), 0) AS complete,
        COALESCE(SUM(label_status = 'RIGHT_CENSORED'), 0) AS right_censored,
        COALESCE(SUM(label_status = 'NO_REFERENCE'), 0) AS no_reference
      FROM launch_quality_observations
    `).get();
    const migrationSecondLegObservations = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'OBSERVING'), 0) AS active,
        COALESCE(SUM(status = 'COMPLETE'), 0) AS complete,
        COALESCE(SUM(status = 'RIGHT_CENSORED'), 0) AS right_censored,
        COALESCE(SUM(snapshot_count), 0) AS snapshots
      FROM migration_second_leg_observations
    `).get();
    const labelRows = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(label_status = 'PENDING'), 0) AS pending,
        COALESCE(SUM(label_status = 'COMPLETE'), 0) AS complete,
        COALESCE(SUM(label_status = 'RIGHT_CENSORED'), 0) AS right_censored,
        COUNT(return_1s) AS observed_1s,
        COUNT(return_5s) AS observed_5s,
        COUNT(return_10s) AS observed_10s,
        COUNT(return_30s) AS observed_30s,
        COUNT(return_60s) AS observed_60s
      FROM signal_returns
    `).get();
    return {
      ...this.metrics,
      pendingWrites: this.rawBuffer.length,
      rawRows,
      signalRows,
      primarySignalRows,
      earlyThresholdSignalRows,
      shadowSignalRows: signalRows - primarySignalRows - earlyThresholdSignalRows,
      smartSignalConfirmations,
      primaryLiveDecisions,
      livePositions,
      primarySignalShadowPositions,
      flowFirstShadowPositions,
      smartPullbackShadowPositions,
      smartOpenShadowPositions,
      flowSmartConfirmShadowPositions,
      launchPullbackShadowPositions,
      migratedDropReboundShadowPositions,
      migrationContinuityShadowPositions,
      rangeScalperShadowPositions,
      cyaEarlyPyramidShadowPositions,
      bondingCurveMomentumShadowPositions,
      bondingCurveMomentumShadowSnapshots,
      graduationHoldShadowPositions,
      graduationAccelerationShadowPositions,
      holderGrowthShadowPositions,
      qualityLeaderShadowPositions,
      launchQualityObservations,
      migrationSecondLegObservations,
      labels: labelRows,
      dbPath: path.resolve(this.config.dbPath),
    };
  }

  allTokens() {
    return [...this.tokens.values()];
  }

  getToken(mint) {
    return this.tokens.get(mint) || null;
  }

  close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.databaseHealthStartTimer) clearTimeout(this.databaseHealthStartTimer);
    this.databaseHealthStartTimer = null;
    if (this.databaseHealthTimer) clearInterval(this.databaseHealthTimer);
    this.databaseHealthTimer = null;
    if (this.databaseHealthWorker?.worker) {
      void this.databaseHealthWorker.worker.terminate().catch(() => {});
    }
    this.databaseHealthWorker = null;
    this.flushRawTrades();
    this.db.close();
  }
}

module.exports = {
  ResearchStore,
  curveProgress,
};
