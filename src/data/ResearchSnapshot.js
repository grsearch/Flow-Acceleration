'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { RAW_COLUMNS, rawSelectProjection } = require('./RawTradeShardManager');

function snapshotName(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `flow-research-${stamp}.db`;
}

function mergeRawShards(snapshotPath) {
  const db = new Database(snapshotPath);
  let mergedRows = 0;
  let mergedShards = 0;
  try {
    const hasMeta = db.prepare(`
      SELECT 1 present FROM sqlite_master
      WHERE type='table' AND name='raw_trade_shard_meta'
    `).get();
    if (!hasMeta) return { mergedRows, mergedShards };
    const meta = db.prepare('SELECT * FROM raw_trade_shard_meta WHERE id=1').get();
    if (!meta?.shard_dir || !fs.existsSync(meta.shard_dir)) {
      throw new Error(`Raw trade shard directory is unavailable: ${meta?.shard_dir || 'unset'}`);
    }
    const availableColumns = new Set(
      db.prepare('PRAGMA table_info(raw_trades)').all().map((row) => row.name),
    );
    const columns = RAW_COLUMNS.filter((column) => column !== 'id' && availableColumns.has(column));
    const quoted = columns.map((column) => `"${column}"`).join(', ');
    const files = fs.readdirSync(meta.shard_dir)
      .filter((name) => /^raw-trades-\d{4}-\d{2}-\d{2}-CST\.db$/.test(name))
      .sort();
    for (const name of files) {
      const filePath = path.join(meta.shard_dir, name);
      db.prepare('ATTACH DATABASE ? AS raw_snapshot_shard').run(filePath);
      try {
        const result = db.prepare(`
          INSERT OR IGNORE INTO main.raw_trades (${quoted})
          SELECT ${rawSelectProjection(db, 'raw_snapshot_shard', columns)} FROM raw_snapshot_shard.raw_trades
        `).run();
        mergedRows += result.changes;
        mergedShards += 1;
      } finally {
        db.exec('DETACH DATABASE raw_snapshot_shard');
      }
    }
    // A portable snapshot owns its merged raw rows and must not retain pointers
    // to mutable production shard files.
    db.exec('DROP TABLE raw_trade_shard_meta');
    return { mergedRows, mergedShards };
  } finally {
    db.close();
  }
}

async function createResearchSnapshot(sourcePath, destinationPath) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) throw new Error('Snapshot destination must differ from source database');
  if (!fs.existsSync(source)) throw new Error(`Source database does not exist: ${source}`);
  if (fs.existsSync(destination)) throw new Error(`Snapshot already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } catch (error) {
    try { fs.rmSync(destination, { force: true }); } catch (_) {}
    throw error;
  } finally {
    db.close();
  }

  const rawShardMerge = mergeRawShards(destination);

  const snapshot = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = snapshot.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Snapshot integrity check failed: ${integrity}`);
    const raw = snapshot.prepare(`
      SELECT COUNT(*) AS rows, MIN(timestamp_ms) AS first_ms, MAX(timestamp_ms) AS last_ms
      FROM raw_trades
    `).get();
    const signals = snapshot.prepare(`
      SELECT COUNT(*) AS rows, COUNT(DISTINCT mint) AS mints,
        MIN(timestamp_ms) AS first_ms, MAX(timestamp_ms) AS last_ms
      FROM flow_signals
    `).get();
    return {
      source,
      destination,
      createdAt: Date.now(),
      bytes: fs.statSync(destination).size,
      integrity,
      rawTrades: raw,
      rawShardMerge,
      signals,
    };
  } finally {
    snapshot.close();
  }
}

module.exports = {
  createResearchSnapshot,
  mergeRawShards,
  snapshotName,
};
