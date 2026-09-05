'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DAY_MS = 24 * 60 * 60_000;
const RAW_COLUMNS = Object.freeze([
  'id',
  'timestamp_ms',
  'chain_timestamp_ms',
  'received_at_ms',
  'slot',
  'signature',
  'event_index',
  'market',
  'mint',
  'bonding_curve',
  'wallet',
  'side',
  'sol_amount',
  'token_amount',
  'price',
  'reserve_price',
  'curve_pct',
  'virtual_sol_reserves_raw',
  'virtual_token_reserves_raw',
  'real_sol_reserves_raw',
  'real_token_reserves_raw',
  'pool',
  'pool_base_reserves_raw',
  'pool_quote_reserves_raw',
  'virtual_quote_reserves_raw',
]);

const INSERT_COLUMNS = RAW_COLUMNS.filter((column) => column !== 'id');
const EXECUTION_COLUMNS = Object.freeze([
  'pool', 'pool_base_reserves_raw', 'pool_quote_reserves_raw', 'virtual_quote_reserves_raw',
]);

// Normalize at the final write boundary too: an older producer or an already
// queued object may predate these optional columns. Never infer pool state,
// coerce reserve integers through Number, or mutate the retry queue's objects.
function normalizeRawExecutionContext(trade) {
  return {
    ...trade,
    pool: trade.pool ?? null,
    poolBaseReservesRaw: trade.poolBaseReservesRaw == null
      ? null : String(trade.poolBaseReservesRaw),
    poolQuoteReservesRaw: trade.poolQuoteReservesRaw == null
      ? null : String(trade.poolQuoteReservesRaw),
    virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw == null
      ? null : String(trade.virtualQuoteReservesRaw),
  };
}

function rawColumnSet(db, schema = 'main') {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid raw schema');
  return new Set(db.prepare(`PRAGMA ${schema}.table_info(raw_trades)`).all()
    .map((row) => row.name));
}

// Only a schema change: no historical UPDATE or table scan at startup.
function ensureRawExecutionColumns(db, schema = 'main') {
  const available = rawColumnSet(db, schema);
  for (const column of EXECUTION_COLUMNS) {
    if (!available.has(column)) db.exec(`ALTER TABLE ${schema}.raw_trades ADD COLUMN ${column} TEXT`);
  }
}

// Historical shards remain untouched on read. New execution context is NULL
// for old rows, never reconstructed from a later pool state.
function rawSelectProjection(db, schema = 'main', columns = RAW_COLUMNS) {
  const available = rawColumnSet(db, schema);
  return columns.map((column) => {
    if (!RAW_COLUMNS.includes(column)) throw new Error('Invalid raw column');
    return available.has(column) ? `"${column}"` : `NULL AS "${column}"`;
  }).join(', ');
}

function shanghaiDay(timestampMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestampMs));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function aliasForDay(day) {
  return `raw_${String(day).replace(/-/g, '')}`;
}

function createShard(filePath, busyTimeoutMs, cacheSizeKb) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const shard = new Database(filePath);
  try {
    shard.pragma('journal_mode = WAL');
    shard.pragma('synchronous = NORMAL');
    shard.pragma(`busy_timeout = ${busyTimeoutMs}`);
    shard.pragma(`cache_size = -${cacheSizeKb}`);
    shard.exec(`
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
    `);
    ensureRawExecutionColumns(shard);
  } finally {
    shard.close();
  }
}

function attachRawTradeReadView(db, { dbPath, readDays = 3, now = Date.now() } = {}) {
  db.exec('DROP VIEW IF EXISTS temp.raw_trades_all');
  const hasMeta = db.prepare(`
    SELECT 1 AS present FROM main.sqlite_master
    WHERE type='table' AND name='raw_trade_shard_meta'
  `).get();
  if (!hasMeta) {
    db.exec('CREATE TEMP VIEW raw_trades_all AS SELECT * FROM main.raw_trades');
    return { enabled: false, attachedDays: [] };
  }
  const meta = db.prepare('SELECT * FROM main.raw_trade_shard_meta WHERE id=1').get();
  if (!meta) {
    db.exec('CREATE TEMP VIEW raw_trades_all AS SELECT * FROM main.raw_trades');
    return { enabled: false, attachedDays: [] };
  }
  const directory = path.resolve(meta.shard_dir || path.join(
    path.dirname(path.resolve(dbPath)), 'raw-daily',
  ));
  const minimumDay = shanghaiDay(now - Math.max(2, Number(readDays) || 3) * DAY_MS);
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory).map((name) => {
      const day = name.match(/^raw-trades-(\d{4}-\d{2}-\d{2})-CST\.db$/)?.[1];
      return day ? { day, filePath: path.join(directory, name) } : null;
    }).filter((item) => item && (item.day >= minimumDay || item.day === meta.active_day))
    : [];
  const attachedDays = [];
  for (const { day, filePath } of files.sort((left, right) => left.day.localeCompare(right.day))) {
    const alias = aliasForDay(day);
    db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(filePath);
    attachedDays.push({ day, alias });
  }
  const hotFloor = now - Math.max(2, Number(readDays) || 3) * DAY_MS;
  const selects = [
    `SELECT ${rawSelectProjection(db)} FROM main.raw_trades
      WHERE timestamp_ms >= ${Math.trunc(hotFloor)}
        AND timestamp_ms < ${Math.trunc(meta.enabled_at)}`,
    ...attachedDays.map(({ alias }) => `SELECT ${rawSelectProjection(db, alias)} FROM ${alias}.raw_trades`),
  ];
  db.exec(`CREATE TEMP VIEW raw_trades_all AS ${selects.join(' UNION ALL ')}`);
  return {
    enabled: true,
    cutoverAt: Number(meta.enabled_at) || null,
    directory,
    attachedDays: attachedDays.map(({ day }) => day),
  };
}

class RawTradeShardManager {
  constructor({ db, dbPath, config = {}, now = () => Date.now() }) {
    this.db = db;
    this.dbPath = dbPath;
    this.config = config;
    this.now = now;
    this.enabled = config.rawShardingEnabled === true && dbPath !== ':memory:';
    this.busyTimeoutMs = Math.max(50, Number(config.busyTimeoutMs) || 5_000);
    this.cacheSizeKb = Math.max(2_000, Number(config.cacheSizeKb) || 64 * 1_024);
    this.readDays = Math.max(2, Math.min(7, Number(config.rawShardReadDays) || 3));
    this.directory = this.enabled
      ? path.resolve(config.rawShardDir || path.join(path.dirname(path.resolve(dbPath)), 'raw-daily'))
      : null;
    this.attached = new Map();
    this.insertStatements = new Map();
    this.writableSchemaDays = new Set();
    this.cutoverAt = null;
    this.activeDay = null;
    this.metrics = {
      rotations: 0,
      tradesWritten: 0,
      duplicateTrades: 0,
      lastRotationAt: null,
      lastWriteAt: null,
      lastError: null,
    };
    if (this.enabled) this._initialize();
    else this._createCompatibilityView();
  }

  _initialize() {
    fs.mkdirSync(this.directory, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_trade_shard_meta (
        id INTEGER PRIMARY KEY CHECK(id=1),
        enabled_at INTEGER NOT NULL,
        active_day TEXT NOT NULL,
        shard_dir TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const now = this.now();
    const today = shanghaiDay(now);
    let meta = this.db.prepare('SELECT * FROM raw_trade_shard_meta WHERE id=1').get();
    if (!meta) {
      this.db.prepare(`
        INSERT INTO raw_trade_shard_meta(id, enabled_at, active_day, shard_dir, updated_at)
        VALUES(1, ?, ?, ?, ?)
      `).run(now, today, this.directory, now);
      meta = this.db.prepare('SELECT * FROM raw_trade_shard_meta WHERE id=1').get();
    }
    this.cutoverAt = Number(meta.enabled_at) || now;
    const days = [];
    for (let offset = this.readDays - 1; offset >= 0; offset -= 1) {
      days.push(shanghaiDay(now - offset * DAY_MS));
    }
    if (!days.includes(meta.active_day)) days.push(meta.active_day);
    for (const day of [...new Set(days)]) {
      const filePath = this.pathForDay(day);
      if (day === today || fs.existsSync(filePath)) this._attach(day, { create: day === today });
    }
    this.activeDay = today;
    this._rebuildView();
    if (meta.active_day !== today) this._recordRotation(today, now);
  }

  _createCompatibilityView() {
    this.db.exec('DROP VIEW IF EXISTS temp.raw_trades_all');
    this.db.exec('CREATE TEMP VIEW raw_trades_all AS SELECT * FROM main.raw_trades');
  }

  pathForDay(day) {
    return path.join(this.directory, `raw-trades-${day}-CST.db`);
  }

  _attach(day, { create = false } = {}) {
    if (this.attached.has(day)) return this.attached.get(day);
    const filePath = this.pathForDay(day);
    if (!create && !fs.existsSync(filePath)) return null;
    if (create) createShard(filePath, this.busyTimeoutMs, this.cacheSizeKb);
    const alias = aliasForDay(day);
    this.db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(filePath);
    this.db.pragma(`${alias}.journal_mode = WAL`);
    this.db.pragma(`${alias}.synchronous = NORMAL`);
    this.db.pragma(`${alias}.cache_size = -${this.cacheSizeKb}`);
    this.attached.set(day, { alias, filePath });
    return this.attached.get(day);
  }

  _rebuildView() {
    this.db.exec('DROP VIEW IF EXISTS temp.raw_trades_all');
    const hotFloor = this.now() - this.readDays * DAY_MS;
    const selects = [
      `SELECT ${rawSelectProjection(this.db)} FROM main.raw_trades
        WHERE timestamp_ms >= ${Math.trunc(hotFloor)}
          AND timestamp_ms < ${Math.trunc(this.cutoverAt)}`,
      ...[...this.attached.values()].map(({ alias }) => (
        `SELECT ${rawSelectProjection(this.db, alias)} FROM ${alias}.raw_trades`
      )),
    ];
    this.db.exec(`CREATE TEMP VIEW raw_trades_all AS ${selects.join(' UNION ALL ')}`);
  }

  _recordRotation(day, at) {
    this.db.prepare(`
      UPDATE raw_trade_shard_meta SET active_day=?, shard_dir=?, updated_at=? WHERE id=1
    `).run(day, this.directory, at);
    this.activeDay = day;
    this.metrics.rotations += 1;
    this.metrics.lastRotationAt = at;
  }

  prepareBatch(trades) {
    if (!this.enabled || !trades.length) return;
    let changed = false;
    const batchDays = new Set(trades.map((trade) => shanghaiDay(trade.timestampMs)));
    const latestAt = Math.max(...trades.map((trade) => Number(trade.timestampMs) || 0));
    const keepDays = new Set(batchDays);
    for (let offset = 0; offset < this.readDays; offset += 1) {
      keepDays.add(shanghaiDay(latestAt - offset * DAY_MS));
    }
    const removable = [...this.attached.keys()].filter((day) => !keepDays.has(day));
    if (removable.length) this.db.exec('DROP VIEW IF EXISTS temp.raw_trades_all');
    for (const day of removable) {
      const shard = this.attached.get(day);
      this.insertStatements.delete(day);
      this.writableSchemaDays.delete(day);
      this.db.exec(`DETACH DATABASE ${shard.alias}`);
      this.attached.delete(day);
      changed = true;
    }
    for (const day of batchDays) {
      if (!this.attached.has(day)) {
        this._attach(day, { create: true });
        changed = true;
      }
      if (!this.writableSchemaDays.has(day)) {
        ensureRawExecutionColumns(this.db, this.attached.get(day).alias);
        this.writableSchemaDays.add(day);
        changed = true;
      }
    }
    const latestDay = shanghaiDay(latestAt);
    if (latestDay !== this.activeDay) this._recordRotation(latestDay, this.now());
    if (changed) this._rebuildView();
  }

  insert(trade) {
    if (!this.enabled) throw new Error('Raw trade sharding is disabled');
    const day = shanghaiDay(trade.timestampMs);
    const shard = this.attached.get(day);
    if (!shard) throw new Error(`Raw trade shard ${day} is not attached`);
    let statement = this.insertStatements.get(day);
    if (!statement) {
      statement = this.db.prepare(`
        INSERT OR IGNORE INTO ${shard.alias}.raw_trades (${INSERT_COLUMNS.join(', ')})
        VALUES (${INSERT_COLUMNS.map((column) => `@${RawTradeShardManager.parameterFor(column)}`).join(', ')})
      `);
      this.insertStatements.set(day, statement);
    }
    const result = statement.run(normalizeRawExecutionContext(trade));
    if (result.changes > 0) {
      this.metrics.tradesWritten += 1;
      this.metrics.lastWriteAt = this.now();
    } else {
      this.metrics.duplicateTrades += 1;
    }
    return result;
  }

  health() {
    return {
      enabled: this.enabled,
      mode: this.enabled ? 'DAILY_CST_SHARDS' : 'LEGACY_MAIN_TABLE',
      directory: this.directory,
      cutoverAt: this.cutoverAt,
      activeDay: this.activeDay,
      attachedDays: [...this.attached.keys()].sort(),
      readDays: this.readDays,
      ...this.metrics,
    };
  }

  static parameterFor(column) {
    return column.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
  }
}

module.exports = {
  DAY_MS,
  RAW_COLUMNS,
  EXECUTION_COLUMNS,
  normalizeRawExecutionContext,
  ensureRawExecutionColumns,
  rawSelectProjection,
  RawTradeShardManager,
  attachRawTradeReadView,
  aliasForDay,
  shanghaiDay,
};
