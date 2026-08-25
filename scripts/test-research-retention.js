'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  DEFAULTS,
  HARD_MAX_ROWS_PER_RUN,
  cleanupResearchRetention,
  validateCosGate,
} = require('./cleanup-research-retention');

function writeGate(directory, now, state = 'CLEANING') {
  const archive = path.join(directory, 'flow-acceleration-last24h-test.tar.gz');
  fs.writeFileSync(archive, 'verified archive');
  const sha = crypto.createHash('sha256').update('verified archive').digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${sha}  ${path.basename(archive)}\n`);
  const statePath = path.join(directory, 'last-run.env');
  fs.writeFileSync(statePath, [
    `STATE=${state}`,
    `UPDATED_AT=${new Date(now).toISOString()}`,
    `ARCHIVE=${archive.replace(/\\/g, '/')}`,
    'REMOTE=cos://flowbackup/flow-acceleration/daily/test.tar.gz',
    `DETAIL=sha256=${sha}`,
    '',
  ].join('\n'));
  return { archive, sha, statePath };
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-retention-'));
  const dbPath = path.join(directory, 'flow-research.db');
  const reportPath = path.join(directory, 'retention-last-run.json');
  const now = Date.now();
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE raw_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_ms INTEGER NOT NULL,
      mint TEXT
    );
    CREATE INDEX idx_raw_trades_ts ON raw_trades(timestamp_ms);
    CREATE TABLE flow_signals (
      signal_id INTEGER PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL
    );
    CREATE TABLE live_positions (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sample_shadow_positions (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const insertTrade = db.prepare('INSERT INTO raw_trades(timestamp_ms, mint) VALUES (?, ?)');
  insertTrade.run(now - 100 * 60 * 60_000, 'old-100');
  insertTrade.run(now - 50 * 60 * 60_000, 'old-50');
  insertTrade.run(now - 47 * 60 * 60_000, 'hot-47');
  insertTrade.run(now - 1 * 60 * 60_000, 'hot-1');
  db.prepare('INSERT INTO flow_signals VALUES (?, ?)').run(1, now - 100 * 60 * 60_000);
  db.prepare('INSERT INTO live_positions VALUES (?, ?, ?)').run(1, 'OPEN', now - 100 * 60 * 60_000);
  db.prepare('INSERT INTO sample_shadow_positions VALUES (?, ?, ?)')
    .run(1, 'CLOSED', now - 100 * 60 * 60_000);
  db.close();

  const gate = writeGate(directory, now);
  assert.strictEqual(validateCosGate(gate.statePath, now).STATE, 'CLEANING');

  const dryRun = await cleanupResearchRetention({
    dbPath,
    statePath: gate.statePath,
    reportPath,
    now,
    hotRawHours: DEFAULTS.hotRawHours,
    batchRows: 100,
    maxRows: 100,
    pauseMs: 0,
    dryRun: true,
  });
  assert.strictEqual(dryRun.deletedRows, 0);
  assert.strictEqual(dryRun.stopReason, 'DRY_RUN');
  assert.strictEqual(fs.existsSync(reportPath), false, 'dry run must not replace the formal report');

  const result = await cleanupResearchRetention({
    dbPath,
    statePath: gate.statePath,
    reportPath,
    now,
    hotRawHours: DEFAULTS.hotRawHours,
    batchRows: 100,
    maxRows: 100,
    pauseMs: 0,
  });
  assert.strictEqual(result.deletedRows, 2);
  assert.strictEqual(result.safety.signalsDeleted, false);
  assert.strictEqual(result.safety.openPositionsDeleted, false);
  assert.strictEqual(result.safety.shadowPositionsDeleted, false);
  assert.strictEqual(result.safety.walCheckpointExecuted, false);
  assert.strictEqual(result.safety.vacuumExecuted, false);
  assert.strictEqual(result.hotRawHours, 48);
  assert.strictEqual(result.optimize.executed, true);
  assert.strictEqual(result.optimize.error, null);
  assert.strictEqual(result.limits.hardMaxRowsPerRun, 5_000_000);
  assert.strictEqual(HARD_MAX_ROWS_PER_RUN, 5_000_000);

  await assert.rejects(
    () => cleanupResearchRetention({
      dbPath,
      statePath: gate.statePath,
      reportPath,
      now,
      pauseMs: 0,
    }),
    /already completed one retention run/,
  );
  const cappedDryRun = await cleanupResearchRetention({
    dbPath,
    statePath: gate.statePath,
    reportPath,
    now,
    maxRows: 9_000_000,
    pauseMs: 0,
    dryRun: true,
  });
  assert.strictEqual(cappedDryRun.maxRows, 5_000_000);
  assert.strictEqual(cappedDryRun.limits.requestedMaxRows, 9_000_000);

  const forced = await cleanupResearchRetention({
    dbPath,
    statePath: gate.statePath,
    reportPath,
    now,
    pauseMs: 0,
    force: true,
  });
  assert.strictEqual(forced.deletedRows, 0);
  assert.strictEqual(forced.limits.forceOverride, true);

  const verify = new Database(dbPath, { readonly: true });
  assert.deepStrictEqual(
    verify.prepare('SELECT mint FROM raw_trades ORDER BY timestamp_ms').all().map((row) => row.mint),
    ['hot-47', 'hot-1'],
  );
  assert.strictEqual(verify.prepare('SELECT COUNT(*) AS n FROM flow_signals').get().n, 1);
  assert.strictEqual(verify.prepare('SELECT COUNT(*) AS n FROM live_positions').get().n, 1);
  assert.strictEqual(verify.prepare('SELECT COUNT(*) AS n FROM sample_shadow_positions').get().n, 1);
  verify.close();

  const badGate = writeGate(directory, now, 'DONE');
  assert.throws(
    () => validateCosGate(badGate.statePath, now),
    /must be CLEANING/,
  );
  assert.ok(fs.existsSync(reportPath));
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('test-research-retention: ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
