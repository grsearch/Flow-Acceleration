'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
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
    this.config = storageConfig;
    this.labelsConfig = labelsConfig;
    ensureParent(storageConfig.dbPath);
    this.db = new Database(storageConfig.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this._initSchema();
    this.db.pragma('optimize');
    this._prepare();

    this.tokens = new Map();
    for (const token of this.stmts.allTokens.all()) this.tokens.set(token.mint, token);
    this.rawBuffer = [];
    this.returnUpdateStatements = new Map();
    this.launchQualityUpdateStatements = new Map();
    this.dashboardStatsCache = new Map();
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
        strategyId === 'holder-growth' ? holderGrowthSql : standardSql,
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
      sessions: this._cachedDashboardStats(`shadow-time-sessions:${strategyId}`, 15_000, compute),
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
        signal_episode_id TEXT…76683 tokens truncated…NFIRMED', 'CONFIRMED_PARTIAL', 'CONFIRMED_UNVERIFIED', 'ALREADY_EMPTY'
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

  archiveExpiredRawTrades(now = Date.now(), limit = 100_000) {
    this.flushRawTrades();
    if (this.config.dbPath === ':memory:') return null;
    const cutoff = now - this.config.rawRetentionHours * 3_600_000;
    const rows = this.db.prepare(`
      SELECT * FROM raw_trades WHERE timestamp_ms < ? ORDER BY id LIMIT ?
    `).all(cutoff, limit);
    if (rows.length === 0) return null;

    fs.mkdirSync(this.config.archiveDir, { recursive: true });
    const first = rows[0].timestamp_ms;
    const last = rows[rows.length - 1].timestamp_ms;
    const archivePath = path.join(
      this.config.archiveDir,
      `raw-trades-${first}-${last}-${now}.ndjson.gz`,
    );
    const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(archivePath, zlib.gzipSync(body, { level: 6 }));
    const maxId = rows[rows.length - 1].id;
    this.db.prepare('DELETE FROM raw_trades WHERE timestamp_ms < ? AND id <= ?').run(cutoff, maxId);
    this.metrics.lastArchiveAt = now;
    return { archivePath, rows: rows.length, first, last };
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
    const launchQualityObservations = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'OBSERVING'), 0) AS active,
        COALESCE(SUM(rebound_at IS NOT NULL), 0) AS reference_pullbacks,
        COALESCE(SUM(label_status = 'COMPLETE'), 0) AS complete,
        COALESCE(SUM(label_status = 'RIGHT_CENSORED'), 0) AS right_censored,
        COALESCE(SUM(label_status = 'NO_REFERENCE'), 0) AS no_reference
      FROM launch_quality_observations
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
      launchQualityObservations,
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
    this.flushRawTrades();
    this.db.close();
  }
}

module.exports = {
  ResearchStore,
  curveProgress,
};
