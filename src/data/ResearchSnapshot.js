'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function snapshotName(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `flow-research-${stamp}.db`;
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
      signals,
    };
  } finally {
    snapshot.close();
  }
}

module.exports = {
  createResearchSnapshot,
  snapshotName,
};
