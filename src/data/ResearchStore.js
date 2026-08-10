'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { costBreakdown, normalizeCostModel } = require('../core/CostModel');

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

      CREATE TABLE IF NOT EXISTS live_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER REFERENCES smart_open_decisions(id),
        primary_decision_id INTEGER REFERENCES primary_live_decisions(id),
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
      CREATE INDEX IF NOT EXISTS idx_live_positions_status
        ON live_positions(status, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_live_positions_one_active_mint
        ON live_positions(mint)
        WHERE status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED');

      CREATE TABLE IF NOT EXISTS live_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL REFERENCES live_positions(id),
        decision_id INTEGER REFERENCES smart_open_decisions(id),
        primary_decision_id INTEGER REFERENCES primary_live_decisions(id),
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
    `);

    this._migrateLiveTradingSchema();

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
    for (const [column, sql] of signalMigrations) {
      if (!signalColumns.has(column)) this.db.exec(sql);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_flow_signals_variant_ts
      ON flow_signals(signal_variant, timestamp_ms)
    `);
    this.db.exec('DROP INDEX IF EXISTS idx_flow_signals_episode_id');
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
    for (const [column, sql] of smartEventMigrations) {
      if (!smartEventColumns.has(column)) this.db.exec(sql);
    }
    const liveOrderColumns = new Set(
      this.db.prepare('PRAGMA table_info(live_orders)').all().map((column) => column.name),
    );
    if (!liveOrderColumns.has('execution_json')) {
      this.db.exec('ALTER TABLE live_orders ADD COLUMN execution_json TEXT');
    }
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
    const needsSmartPositionRebuild = this.db.prepare(`
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
    for (const [column, sql] of returnMigrations) {
      if (!returnColumns.has(column)) this.db.exec(sql);
    }
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
    this.db.exec(`
      UPDATE flow_signals SET flow_accel = CASE
        WHEN flow_accel_1 IS NULL THEN flow_accel_2
        WHEN flow_accel_2 IS NULL THEN flow_accel_1
        WHEN flow_accel_1 <= flow_accel_2 THEN flow_accel_1
        ELSE flow_accel_2
      END
      WHERE flow_accel IS NOT CASE
        WHEN flow_accel_1 IS NULL THEN flow_accel_2
        WHEN flow_accel_2 IS NULL THEN flow_accel_1
        WHEN flow_accel_1 <= flow_accel_2 THEN flow_accel_1
        ELSE flow_accel_2
      END
    `);
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
    if (!needsRebuild) return;

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
          CREATE UNIQUE INDEX idx_live_positions_one_active_mint
            ON live_positions(mint)
            WHERE status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED');
          CREATE INDEX idx_live_orders_position ON live_orders(position_id, id);
          CREATE INDEX idx_live_orders_created_id
            ON live_orders(created_at DESC, id DESC);
        `);
      })();
    } finally {
      if (foreignKeys) this.db.pragma('foreign_keys = ON');
    }
    const violations = this.db.pragma('foreign_key_check');
    if (violations.length > 0) {
      throw new Error(`Live trading schema migration has ${violations.length} FK violation(s)`);
    }
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
      recentCurveTrades: this.db.prepare(`
        SELECT timestamp_ms AS timestampMs, received_at_ms AS receivedAtMs,
          market, mint, wallet, side, sol_amount AS solAmount,
          token_amount AS tokenAmount, price
        FROM raw_trades
        WHERE market = 'PUMP_BONDING_CURVE' AND timestamp_ms >= ?
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
      insertLivePosition: this.db.prepare(`
        INSERT INTO live_positions (
          decision_id, primary_decision_id, source_type, signal_id,
          mint, trigger_wallet, mode, status, position_sol,
          entry_market, entry_price, highest_price, created_at, updated_at
        ) VALUES (
          @decisionId, @primaryDecisionId, @sourceType, @signalId,
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
          highest_price = COALESCE(@highestPrice, highest_price),
          exit_market = COALESCE(@exitMarket, exit_market),
          exit_price = COALESCE(@exitPrice, exit_price),
          exit_signature = COALESCE(@exitSignature, exit_signature),
          exit_reason = COALESCE(@exitReason, exit_reason),
          exit_error = @exitError,
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
      lastLivePositionForMint: this.db.prepare(`
        SELECT * FROM live_positions WHERE mint = ? ORDER BY created_at DESC LIMIT 1
      `),
      insertLiveOrder: this.db.prepare(`
        INSERT INTO live_orders (
          position_id, decision_id, primary_decision_id, mint, side, venue, attempt,
          requested_sol, requested_token_raw, status, signature, error,
          execution_json, submitted_at, confirmed_at, created_at, updated_at
        ) VALUES (
          @positionId, @decisionId, @primaryDecisionId, @mint, @side, @venue, @attempt,
          @requestedSol, @requestedTokenRaw, @status, @signature, @error,
          @executionJson, @submittedAt, @confirmedAt, @createdAt, @updatedAt
        )
      `),
      updateLiveOrder: this.db.prepare(`
        UPDATE live_orders SET
          status = COALESCE(@status, status),
          requested_token_raw = COALESCE(@requestedTokenRaw, requested_token_raw),
          error = @error,
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
    return this.stmts.recentCurveTrades.all(sinceMs);
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

  createLivePosition(position) {
    const now = Date.now();
    const row = {
      decisionId: position.decisionId || null,
      primaryDecisionId: position.primaryDecisionId || null,
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
      highestPrice: finiteOrNull(value('highestPrice')),
      exitMarket: value('exitMarket'),
      exitPrice: finiteOrNull(value('exitPrice')),
      exitSignature: value('exitSignature'),
      exitReason: value('exitReason'),
      exitError: value('exitError'),
      openedAt: value('openedAt'),
      exitRequestedAt: value('exitRequestedAt'),
      closedAt: value('closedAt'),
      updatedAt: Date.now(),
    });
  }

  activeLivePositions() {
    return this.stmts.activeLivePositions.all();
  }

  lastLivePositionForMint(mint) {
    return this.stmts.lastLivePositionForMint.get(mint) || null;
  }

  recordLiveOrder(order) {
    const now = Date.now();
    const result = this.stmts.insertLiveOrder.run({
      positionId: order.positionId,
      decisionId: order.decisionId || null,
      primaryDecisionId: order.primaryDecisionId || null,
      mint: order.mint,
      side: order.side,
      venue: order.venue || null,
      attempt: order.attempt || 1,
      requestedSol: finiteOrNull(order.requestedSol),
      requestedTokenRaw: order.requestedTokenRaw || null,
      status: order.status,
      signature: order.signature || null,
      error: order.error || null,
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
      executionJson: value('execution') ? JSON.stringify(value('execution')) : null,
      confirmedAt: value('confirmedAt'),
      updatedAt: Date.now(),
    });
  }

  latestLiveOrderForPositionSide(positionId, side) {
    return this.stmts.latestLiveOrderForPositionSide.get(positionId, side) || null;
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

  recentSmartWalletEvents(timestampMs) {
    return this.stmts.recentSmartWalletEvents.all(timestampMs);
  }

  primarySignalShadowDashboard({ positionLimit = 200 } = {}) {
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
    const stats = this.db.prepare(`
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
    const profiles = this.db.prepare(`
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

  smartPullbackShadowDashboard({ positionLimit = 200, bigWinnerPct = 50 } = {}) {
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
    const cohortIds = this.db.prepare(`
      SELECT DISTINCT cohort_id FROM smart_pullback_shadow_positions ORDER BY cohort_id
    `).all().map((row) => row.cohort_id);
    const cohorts = cohortIds.map((cohortId) => {
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
    return { cohorts, positions };
  }

  liveTradingDashboard({ positionLimit = 100, orderLimit = 100, decisionLimit = 100 } = {}) {
    const safeLimit = (value) => Math.min(500, Math.max(1, Math.trunc(Number(value) || 100)));
    const positions = this.db.prepare(`
      SELECT *,
        CASE
          WHEN opened_at IS NOT NULL AND closed_at IS NOT NULL THEN closed_at - opened_at
          ELSE NULL
        END AS hold_ms,
        CASE
          WHEN entry_price > 0 AND exit_price > 0 THEN ((exit_price / entry_price) - 1) * 100
          ELSE NULL
        END AS gross_return_pct
      FROM live_positions
      ORDER BY
        CASE WHEN status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED') THEN 0 ELSE 1 END,
        updated_at DESC,
        id DESC
      LIMIT ?
    `).all(safeLimit(positionLimit));
    const orders = this.db.prepare(`
      SELECT * FROM live_orders
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(safeLimit(orderLimit)).map((row) => {
      let execution = null;
      try {
        execution = row.execution_json ? JSON.parse(row.execution_json) : null;
      } catch (_) {
        execution = { parseError: true };
      }
      return { ...row, execution };
    });
    const decisions = this.db.prepare(`
      SELECT * FROM primary_live_decisions
      ORDER BY timestamp_ms DESC, id DESC
      LIMIT ?
    `).all(safeLimit(decisionLimit)).map((row) => {
      let rejectionReasons = [];
      try {
        const parsed = JSON.parse(row.rejection_reasons_json || '[]');
        if (Array.isArray(parsed)) rejectionReasons = parsed;
      } catch (_) {
        rejectionReasons = ['INVALID_REJECTION_REASONS'];
      }
      return { ...row, rejection_reasons: rejectionReasons };
    });
    const decisionStats = this.db.prepare(`
      SELECT
        COUNT(*) AS decisions,
        COALESCE(SUM(rule_matched = 1), 0) AS matched,
        COALESCE(SUM(action_status = 'RULE_REJECTED'), 0) AS rule_rejected,
        COALESCE(SUM(action_status = 'MATCHED_DISABLED'), 0) AS matched_disabled,
        COALESCE(SUM(action_status = 'RISK_REJECTED'), 0) AS risk_rejected
      FROM primary_live_decisions
    `).get();
    const positionStats = this.db.prepare(`
      SELECT
        COUNT(*) AS positions,
        COALESCE(SUM(status IN ('OPENING', 'OPEN', 'EXITING', 'EXIT_FAILED')), 0) AS active_positions,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed_positions,
        COALESCE(SUM(status = 'ENTRY_FAILED'), 0) AS entry_failed_positions,
        COALESCE(SUM(status = 'EXIT_FAILED'), 0) AS exit_failed_positions,
        COALESCE(SUM(CASE WHEN opened_at IS NOT NULL THEN position_sol ELSE 0 END), 0) AS deployed_sol,
        AVG(CASE WHEN opened_at IS NOT NULL AND closed_at IS NOT NULL THEN closed_at - opened_at END) AS average_hold_ms,
        COALESCE(SUM(status = 'CLOSED' AND entry_price > 0 AND exit_price > 0), 0) AS priced_closed_positions,
        COALESCE(SUM(status = 'CLOSED' AND entry_price > 0 AND exit_price > entry_price), 0) AS wins,
        AVG(CASE
          WHEN status = 'CLOSED' AND entry_price > 0 AND exit_price > 0
            THEN ((exit_price / entry_price) - 1) * 100
        END) AS average_gross_return_pct
      FROM live_positions
    `).get();
    const orderStats = this.db.prepare(`
      SELECT
        COUNT(*) AS orders,
        COALESCE(SUM(status IN (
          'CONFIRMED', 'CONFIRMED_PARTIAL', 'CONFIRMED_UNVERIFIED', 'ALREADY_EMPTY'
        )), 0) AS confirmed_orders,
        COALESCE(SUM(status = 'FAILED'), 0) AS failed_orders,
        COALESCE(SUM(status = 'CONFIRMATION_UNKNOWN'), 0) AS unknown_orders
      FROM live_orders
    `).get();
    const pricedClosed = Number(positionStats.priced_closed_positions) || 0;
    const wins = Number(positionStats.wins) || 0;

    return {
      stats: {
        ...decisionStats,
        ...positionStats,
        ...orderStats,
        win_rate_pct: pricedClosed > 0 ? (wins / pricedClosed) * 100 : null,
      },
      positions,
      orders,
      decisions,
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
    const smartPullbackShadowPositions = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status IN (
          'WAITING_PULLBACK', 'WAITING_REBOUND', 'PENDING_ENTRY', 'OPEN', 'EXIT_PENDING'
        )), 0) AS active,
        COALESCE(SUM(status = 'CLOSED'), 0) AS closed,
        COALESCE(SUM(status = 'NO_EXIT'), 0) AS no_exit
      FROM smart_pullback_shadow_positions
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
      smartPullbackShadowPositions,
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
