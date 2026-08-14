'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const EXPLICIT_FILTERS = Object.freeze({
  flow_tokens: {
    where: `(
      (updated_at >= ? AND updated_at < ?)
      OR mint IN (
        SELECT mint FROM source.raw_trades WHERE timestamp_ms >= ? AND timestamp_ms < ?
        UNION
        SELECT mint FROM source.flow_signals WHERE timestamp_ms >= ? AND timestamp_ms < ?
      )
    )`,
    anchor: 'updated_at',
    bind: (startMs, endMs) => [startMs, endMs, startMs, endMs, startMs, endMs],
  },
  raw_trades: { where: 'timestamp_ms >= ? AND timestamp_ms < ?', anchor: 'timestamp_ms' },
  flow_signals: { where: 'timestamp_ms >= ? AND timestamp_ms < ?', anchor: 'timestamp_ms' },
  signal_returns: {
    where: `signal_id IN (
      SELECT signal_id FROM source.flow_signals
      WHERE timestamp_ms >= ? AND timestamp_ms < ?
    )`,
    anchor: null,
  },
  smart_wallet_events: { where: 'timestamp_ms >= ? AND timestamp_ms < ?', anchor: 'timestamp_ms' },
  smart_signal_confirmations: {
    where: 'open_timestamp_ms >= ? AND open_timestamp_ms < ?', anchor: 'open_timestamp_ms',
  },
  smart_wallet_positions: { where: 'updated_at >= ? AND updated_at < ?', anchor: 'updated_at' },
  smart_open_decisions: { where: 'timestamp_ms >= ? AND timestamp_ms < ?', anchor: 'timestamp_ms' },
  primary_live_decisions: { where: 'timestamp_ms >= ? AND timestamp_ms < ?', anchor: 'timestamp_ms' },
  live_strategy_decisions: { where: 'timestamp_ms >= ? AND timestamp_ms < ?', anchor: 'timestamp_ms' },
  live_positions: {
    where: `(
      (created_at >= ? AND created_at < ?)
      OR (updated_at >= ? AND updated_at < ?)
      OR status IN ('ENTRY_PENDING', 'OPEN', 'EXIT_PENDING', 'ENTRY_UNKNOWN')
    )`,
    anchor: 'updated_at',
    bind: (startMs, endMs) => [startMs, endMs, startMs, endMs],
  },
  live_orders: { where: 'created_at >= ? AND created_at < ?', anchor: 'created_at' },
  primary_signal_shadow_positions: { where: 'signal_at >= ? AND signal_at < ?', anchor: 'signal_at' },
  flow_first_shadow_positions: { where: 'signal_at >= ? AND signal_at < ?', anchor: 'signal_at' },
  smart_pullback_shadow_positions: {
    where: 'smart_buy_at >= ? AND smart_buy_at < ?', anchor: 'smart_buy_at',
  },
  smart_open_shadow_positions: { where: 'smart_open_at >= ? AND smart_open_at < ?', anchor: 'smart_open_at' },
  flow_smart_confirm_shadow_positions: {
    where: 'smart_open_at >= ? AND smart_open_at < ?', anchor: 'smart_open_at',
  },
  launch_pullback_shadow_positions: { where: 'reference_at >= ? AND reference_at < ?', anchor: 'reference_at' },
  migrated_drop_rebound_shadow_positions: { where: 'rebound_at >= ? AND rebound_at < ?', anchor: 'rebound_at' },
  migration_continuity_shadow_positions: { where: 'signal_at >= ? AND signal_at < ?', anchor: 'signal_at' },
  range_scalper_shadow_positions: { where: 'signal_at >= ? AND signal_at < ?', anchor: 'signal_at' },
  cya_early_pyramid_shadow_positions: { where: 'signal_at >= ? AND signal_at < ?', anchor: 'signal_at' },
  bonding_curve_momentum_shadow_positions: { where: 'signal_at >= ? AND signal_at < ?', anchor: 'signal_at' },
  graduation_hold_shadow_positions: { where: 'signal_at >= ? AND signal_at < ?', anchor: 'signal_at' },
  bonding_curve_momentum_shadow_snapshots: { where: 'target_at >= ? AND target_at < ?', anchor: 'target_at' },
  launch_quality_observations: {
    where: `(
      (first_trade_at >= ? AND first_trade_at < ?)
      OR (updated_at >= ? AND updated_at < ?)
    )`,
    anchor: 'first_trade_at',
    bind: (startMs, endMs) => [startMs, endMs, startMs, endMs],
  },
  launch_quality_snapshots: { where: 'observed_at >= ? AND observed_at < ?', anchor: 'observed_at' },
});

const GENERIC_TIME_COLUMNS = [
  'timestamp_ms', 'signal_at', 'reference_at', 'smart_buy_at', 'smart_open_at',
  'rebound_at', 'observed_at', 'target_at', 'created_at', 'updated_at',
];

function args(argv) {
  const values = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, raw = 'true'] = item.slice(2).split('=', 2);
    values[key] = raw;
  }
  return values;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableCreateSql(name, sourceSql) {
  const bodyAt = sourceSql.indexOf('(');
  if (bodyAt < 0) throw new Error(`Cannot parse CREATE TABLE for ${name}`);
  return `CREATE TABLE main.${quoteIdentifier(name)} ${sourceSql.slice(bodyAt)}`;
}

function indexCreateSql(name, sourceSql) {
  const match = sourceSql.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+/i);
  if (!match) throw new Error(`Cannot parse CREATE INDEX for ${name}`);
  const unique = match[1] || '';
  return `CREATE ${unique}INDEX main.${quoteIdentifier(name)} ${sourceSql.slice(match[0].length)}`;
}

function chooseFilter(table, columns) {
  const explicit = EXPLICIT_FILTERS[table];
  if (explicit) return explicit;
  const anchor = GENERIC_TIME_COLUMNS.find((candidate) => columns.includes(candidate));
  if (!anchor) return { where: '1 = 1', anchor: null, fullTable: true };
  return { where: `${quoteIdentifier(anchor)} >= ? AND ${quoteIdentifier(anchor)} < ?`, anchor };
}

function formatShanghai(timestampMs) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestampMs)).replace(' ', 'T') + '+08:00';
}

function createSchemaFile(databasePath, schemaPath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const statements = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name
    `).all().map((row) => `${row.sql};`).join('\n\n');
    fs.writeFileSync(schemaPath, `${statements}\n`, { encoding: 'utf8', mode: 0o600 });
  } finally {
    db.close();
  }
}

function exportResearchWindow({ sourcePath, destinationPath, startMs, endMs, schemaPath = null }) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error('A valid startMs < endMs window is required');
  }
  if (source === destination) throw new Error('Export destination must differ from source database');
  if (!fs.existsSync(source)) throw new Error(`Source database does not exist: ${source}`);
  if (fs.existsSync(destination)) throw new Error(`Export destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const sourceBytes = fs.statSync(source).size;
  const db = new Database(destination, { timeout: 10_000 });
  const tableStats = [];
  let committed = false;
  try {
    db.pragma('busy_timeout = 10000');
    db.pragma('cache_size = -32768');
    db.pragma('temp_store = FILE');
    // Tables are intentionally copied before indexes and in a deterministic
    // name order. Some shadow tables reference flow_signals, which may not have
    // been created in the destination yet. The source remains read-only and the
    // completed archive is verified with quick_check after the copy.
    db.pragma('foreign_keys = OFF');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    // The connection never executes source schema writes, checkpoints or VACUUM.
    // SQLite ATTACH URI support varies across bundled Windows/Linux builds, so the
    // source is attached by its absolute path and treated as immutable by this code.
    db.prepare('ATTACH DATABASE ? AS source').run(source);
    db.exec('BEGIN');

    // The first source read pins one WAL snapshot for every copied table.
    db.prepare('SELECT COUNT(*) AS count FROM source.sqlite_master').get();
    const tables = db.prepare(`
      SELECT name, sql FROM source.sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY name
    `).all();

    for (const table of tables) {
      const columns = db.prepare(`PRAGMA source.table_info(${quoteIdentifier(table.name)})`)
        .all().map((column) => column.name);
      const filter = chooseFilter(table.name, columns);
      db.exec(tableCreateSql(table.name, table.sql));
      const bind = filter.bind ? filter.bind(startMs, endMs) : (
        filter.fullTable ? [] : [startMs, endMs]
      );
      const insert = db.prepare(`
        INSERT INTO main.${quoteIdentifier(table.name)}
        SELECT * FROM source.${quoteIdentifier(table.name)} WHERE ${filter.where}
      `).run(...bind);
      let firstMs = null;
      let lastMs = null;
      if (filter.anchor && columns.includes(filter.anchor)) {
        const range = db.prepare(`
          SELECT MIN(${quoteIdentifier(filter.anchor)}) AS first_ms,
                 MAX(${quoteIdentifier(filter.anchor)}) AS last_ms
          FROM main.${quoteIdentifier(table.name)}
        `).get();
        firstMs = range.first_ms;
        lastMs = range.last_ms;
      }
      tableStats.push({
        table: table.name,
        rows: insert.changes,
        filter: filter.fullTable ? 'FULL_METADATA_TABLE' : filter.where.replace(/\s+/g, ' ').trim(),
        anchor: filter.anchor,
        firstMs,
        lastMs,
      });
    }

    const indexes = db.prepare(`
      SELECT name, sql FROM source.sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY name
    `).all();
    for (const index of indexes) db.exec(indexCreateSql(index.name, index.sql));

    db.exec('COMMIT');
    committed = true;
    db.exec('DETACH DATABASE source');
  } catch (error) {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    }
    try { db.exec('DETACH DATABASE source'); } catch (_) {}
    try { fs.rmSync(destination, { force: true }); } catch (_) {}
    throw error;
  } finally {
    db.close();
  }

  const exported = new Database(destination, { readonly: true, fileMustExist: true });
  let integrity;
  try {
    integrity = exported.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Export integrity check failed: ${integrity}`);
  } finally {
    exported.close();
  }
  if (schemaPath) createSchemaFile(destination, path.resolve(schemaPath));

  return {
    formatVersion: 1,
    mode: 'CONSISTENT_READ_TRANSACTION_24H_WINDOW',
    source,
    destination,
    createdAtMs: Date.now(),
    createdAtUtc: new Date().toISOString(),
    range: {
      startMs,
      endMs,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(endMs).toISOString(),
      startCst: formatShanghai(startMs),
      endCst: formatShanghai(endMs),
    },
    sourceBytes,
    exportBytes: fs.statSync(destination).size,
    integrity,
    safety: {
      sourceWritesExecuted: false,
      walCheckpointExecuted: false,
      backupApiUsed: false,
      sourceServiceRestarted: false,
      destinationForeignKeysDisabledDuringCopy: true,
    },
    tables: tableStats,
  };
}

function main() {
  const input = args(process.argv.slice(2));
  const source = input.db || process.env.FLOW_DB_PATH || './data/flow-research.db';
  const destination = input.out;
  if (!destination) throw new Error('--out=/path/to/export.db is required');
  const hours = Number(input.hours || 24);
  const endMs = input['end-ms'] ? Number(input['end-ms']) : Date.now();
  const startMs = input['start-ms'] ? Number(input['start-ms']) : endMs - hours * 60 * 60 * 1_000;
  const manifestPath = input.manifest || `${destination}.manifest.json`;
  const result = exportResearchWindow({
    sourcePath: source,
    destinationPath: destination,
    startMs,
    endMs,
    schemaPath: input.schema || null,
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[WindowExport] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { args, chooseFilter, exportResearchWindow, formatShanghai };
