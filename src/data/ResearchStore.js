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
        slot INTEGER,
        signature TEXT,
        event_index INTEGER NOT NULL DEFAULT 0,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        sol_amount REAL NOT NULL,
        price REAL,
        curve_pct REAL,
        age_ms INTEGER,
        nearest_flow_signal INTEGER,
        time_from_flow_signal_ms INTEGER,
        UNIQUE(signature, event_index, wallet)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_wallet_events_wallet_ts
        ON smart_wallet_events(wallet, timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_smart_wallet_events_mint_ts
        ON smart_wallet_events(mint, timestamp_ms);
    `);

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
    ];
    for (const [column, sql] of signalMigrations) {
      if (!signalColumns.has(column)) this.db.exec(sql);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_flow_signals_variant_ts
      ON flow_signals(signal_variant, timestamp_ms)
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
          signal_variant, is_primary, created_at
        ) VALUES (
          @timestampMs, @slot, @signature, @mint, @symbol, @ageMs, @curvePct, @price,
          @buyFlowW1, @buyFlowW2, @buyFlowW3,
          @sellFlowW1, @sellFlowW2, @sellFlowW3,
          @netFlowW1, @netFlowW2, @netFlowW3,
          @deltaNetFlow12, @deltaNetFlow23,
          @uniqueBuyersW1, @uniqueBuyersW2, @uniqueBuyersW3,
          @buyTxW1, @buyTxW2, @buyTxW3,
          @flowAccel1, @flowAccel2, @flowAccel,
          @signalVariant, @isPrimary, @createdAt
        )
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
      insertSmartWallet: this.db.prepare(`
        INSERT OR IGNORE INTO smart_wallet_events (
          timestamp_ms, slot, signature, event_index, wallet, mint, side,
          sol_amount, price, curve_pct, age_ms, nearest_flow_signal, time_from_flow_signal_ms
        ) VALUES (
          @timestampMs, @slot, @signature, @eventIndex, @wallet, @mint, @side,
          @solAmount, @price, @curvePct, @ageMs, @nearestFlowSignal, @timeFromFlowSignalMs
        )
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
    const signalRow = {
      ...signal,
      signalVariant,
      isPrimary: signal.isPrimary == null
        ? Number(signalVariant === 'primary_3w')
        : Number(signal.isPrimary !== false),
      flowAccel: Number.isFinite(signal.flowAccel)
        ? signal.flowAccel
        : acceleration.length ? Math.min(...acceleration) : null,
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

  recordSmartWalletEvent(trade) {
    const nearest = this.findNearestSignal(trade.mint, trade.timestampMs);
    this.stmts.insertSmartWallet.run({
      timestampMs: trade.timestampMs,
      slot: trade.slot || null,
      signature: trade.signature || null,
      eventIndex: trade.eventIndex || 0,
      wallet: trade.wallet,
      mint: trade.mint,
      side: trade.side,
      solAmount: trade.solAmount,
      price: finiteOrNull(trade.price),
      curvePct: finiteOrNull(trade.curvePct),
      ageMs: Number.isFinite(trade.ageMs) ? trade.ageMs : null,
      nearestFlowSignal: nearest?.signal_id || null,
      timeFromFlowSignalMs: nearest ? trade.timestampMs - nearest.timestamp_ms : null,
    });
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
        SELECT COUNT(*) AS n FROM flow_signals WHERE timestamp_ms >= ? AND is_primary = 0
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
      const buys = events.filter((event) => event.side === 'BUY');
      const open = new Map();
      const holds = [];
      for (const event of events) {
        if (event.side === 'BUY' && !open.has(event.mint)) open.set(event.mint, event.timestamp_ms);
        if (event.side === 'SELL' && open.has(event.mint)) {
          holds.push(event.timestamp_ms - open.get(event.mint));
          open.delete(event.mint);
        }
      }
      const average = (values) => values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : null;
      result.push({
        wallet,
        trades: events.length,
        boughtTokens: new Set(buys.map((event) => event.mint)).size,
        averageHoldMs: average(holds),
        averageBuyCurvePct: average(buys.map((event) => event.curve_pct).filter(Number.isFinite)),
        averageBuyAgeMs: average(buys.map((event) => event.age_ms).filter(Number.isFinite)),
        flowSignalOverlapPct: buys.length
          ? (buys.filter((event) => event.nearest_flow_signal != null).length / buys.length) * 100
          : null,
        averageTimeFromSignalMs: average(
          buys.map((event) => event.time_from_flow_signal_ms).filter(Number.isFinite),
        ),
      });
    }
    return result;
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
      shadowSignalRows: signalRows - primarySignalRows,
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
