'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const POSITION_TABLE = 'holder_growth_shadow_positions';
const EXPORT_TABLES = Object.freeze([
  {
    name: POSITION_TABLE,
    anchor: 'signal_at',
    where: ({ startMs, endMs }) => (
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? { sql: 'source_row.signal_at >= ? AND source_row.signal_at < ?', bind: [startMs, endMs] }
        : { sql: '1 = 1', bind: [] }
    ),
  },
  {
    name: 'flow_tokens',
    anchor: 'updated_at',
    where: () => ({
      sql: `source_row.mint IN (SELECT DISTINCT mint FROM main.${POSITION_TABLE})`,
      bind: [],
    }),
  },
  {
    name: 'launch_quality_observations',
    anchor: 'first_trade_at',
    where: () => ({
      sql: `source_row.mint IN (SELECT DISTINCT mint FROM main.${POSITION_TABLE})`,
      bind: [],
    }),
  },
  {
    name: 'launch_quality_snapshots',
    anchor: 'observed_at',
    where: () => ({
      sql: `source_row.mint IN (SELECT DISTINCT mint FROM main.${POSITION_TABLE})`,
      bind: [],
    }),
  },
  {
    name: 'raw_trades',
    anchor: 'timestamp_ms',
    where: () => ({
      sql: `EXISTS (
        SELECT 1 FROM main.${POSITION_TABLE} AS position
        WHERE position.mint = source_row.mint
          AND source_row.timestamp_ms >= position.signal_at - 5000
          AND source_row.timestamp_ms <= COALESCE(
            position.exit_at,
            position.exit_deadline_at,
            position.updated_at,
            position.signal_at
          ) + 5000
      )`,
      bind: [],
    }),
  },
]);

function parseArgs(argv) {
  const result = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, value = 'true'] = item.slice(2).split('=', 2);
    result[key] = value;
  }
  return result;
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
  return `CREATE ${match[1] || ''}INDEX main.${quoteIdentifier(name)} ${sourceSql.slice(match[0].length)}`;
}

function createSchemaFile(databasePath, schemaPath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const sql = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name
    `).all().map((row) => `${row.sql};`).join('\n\n');
    fs.writeFileSync(schemaPath, `${sql}\n`, { encoding: 'utf8', mode: 0o600 });
  } finally {
    db.close();
  }
}

function exportHolderGrowthShadow({
  sourcePath,
  destinationPath,
  manifestPath = null,
  schemaPath = null,
  startMs = null,
  endMs = null,
}) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  const hasWindow = Number.isFinite(startMs) || Number.isFinite(endMs);
  if (hasWindow && !(Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs)) {
    throw new Error('Provide both startMs and endMs with startMs < endMs, or omit both');
  }
  if (source === destination) throw new Error('Export destination must differ from source database');
  if (!fs.existsSync(source)) throw new Error(`Source database does not exist: ${source}`);
  if (fs.existsSync(destination)) throw new Error(`Export destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const db = new Database(destination, { timeout: 10_000 });
  const tableStats = [];
  let transactionOpen = false;
  try {
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = OFF');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('temp_store = FILE');
    db.prepare('ATTACH DATABASE ? AS source').run(source);
    db.exec('BEGIN');
    transactionOpen = true;
    db.prepare('SELECT COUNT(*) AS count FROM source.sqlite_master').get();

    for (const table of EXPORT_TABLES) {
      const schema = db.prepare(`
        SELECT sql FROM source.sqlite_master
        WHERE type = 'table' AND name = ? AND sql IS NOT NULL
      `).get(table.name);
      if (!schema) throw new Error(`Required source table is missing: ${table.name}`);
      db.exec(tableCreateSql(table.name, schema.sql));
      const filter = table.where({ startMs, endMs });
      const expected = db.prepare(`
        SELECT COUNT(*) AS count
        FROM source.${quoteIdentifier(table.name)} AS source_row
        WHERE ${filter.sql}
      `).get(...filter.bind).count;
      const inserted = db.prepare(`
        INSERT INTO main.${quoteIdentifier(table.name)}
        SELECT source_row.*
        FROM source.${quoteIdentifier(table.name)} AS source_row
        WHERE ${filter.sql}
      `).run(...filter.bind).changes;
      const actual = db.prepare(`
        SELECT COUNT(*) AS count FROM main.${quoteIdentifier(table.name)}
      `).get().count;
      if (expected !== inserted || inserted !== actual) {
        throw new Error(`${table.name} copy verification failed: ${expected}/${inserted}/${actual}`);
      }
      const range = db.prepare(`
        SELECT MIN(${quoteIdentifier(table.anchor)}) AS first_ms,
               MAX(${quoteIdentifier(table.anchor)}) AS last_ms
        FROM main.${quoteIdentifier(table.name)}
      `).get();
      tableStats.push({
        table: table.name,
        sourceRows: expected,
        exportRows: actual,
        verified: true,
        firstMs: range.first_ms,
        lastMs: range.last_ms,
      });
    }

    const selected = new Set(EXPORT_TABLES.map((table) => table.name));
    const indexes = db.prepare(`
      SELECT name, tbl_name, sql FROM source.sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY name
    `).all().filter((index) => selected.has(index.tbl_name));
    for (const index of indexes) db.exec(indexCreateSql(index.name, index.sql));

    db.exec('COMMIT');
    transactionOpen = false;
    db.exec('DETACH DATABASE source');
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    }
    try { db.exec('DETACH DATABASE source'); } catch (_) {}
    try { fs.rmSync(destination, { force: true }); } catch (_) {}
    throw error;
  } finally {
    db.close();
  }

  const output = new Database(destination, { readonly: true, fileMustExist: true });
  let integrity;
  try {
    integrity = output.pragma('quick_check', { simple: true });
  } finally {
    output.close();
  }
  if (integrity !== 'ok') throw new Error(`Export integrity check failed: ${integrity}`);
  if (schemaPath) createSchemaFile(destination, path.resolve(schemaPath));

  const result = {
    formatVersion: 1,
    mode: 'HOLDER_GROWTH_SHADOW_VERIFIED_RELATED_DATA',
    createdAtMs: Date.now(),
    createdAtUtc: new Date().toISOString(),
    source,
    destination,
    filter: hasWindow ? { startMs, endMs } : { allHistory: true },
    sourceBytes: fs.statSync(source).size,
    exportBytes: fs.statSync(destination).size,
    integrity,
    safety: {
      sourceWritesExecuted: false,
      walCheckpointExecuted: false,
      sourceServiceRestarted: false,
    },
    tables: tableStats,
  };
  if (manifestPath) {
    fs.writeFileSync(path.resolve(manifestPath), `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600,
    });
  }
  return result;
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  const sourcePath = input.db || process.env.FLOW_DB_PATH || './data/flow-research.db';
  if (!input.out) throw new Error('--out=/path/to/holder-growth.db is required');
  const startMs = input['start-ms'] == null ? null : Number(input['start-ms']);
  const endMs = input['end-ms'] == null ? null : Number(input['end-ms']);
  const result = exportHolderGrowthShadow({
    sourcePath,
    destinationPath: input.out,
    manifestPath: input.manifest || `${input.out}.manifest.json`,
    schemaPath: input.schema || null,
    startMs,
    endMs,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[HolderGrowthExport] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { EXPORT_TABLES, exportHolderGrowthShadow, parseArgs };

