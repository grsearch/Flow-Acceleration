'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { exportResearchWindow } = require('./export-research-window');

function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-daily-export-'));
  const source = path.join(directory, 'source.db');
  const destination = path.join(directory, 'last24h.db');
  const schema = path.join(directory, 'schema.sql');
  const startMs = 1_000_000;
  const endMs = startMs + 86_400_000;
  const db = new Database(source);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE raw_trades (id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, mint TEXT);
    CREATE INDEX idx_raw_trades_ts ON raw_trades(timestamp_ms);
    CREATE TABLE flow_signals (signal_id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, mint TEXT);
    CREATE TABLE signal_returns (signal_id INTEGER PRIMARY KEY, updated_at INTEGER NOT NULL, return_5s REAL);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO raw_trades VALUES (?, ?, ?)').run(1, startMs - 1, 'old');
  db.prepare('INSERT INTO raw_trades VALUES (?, ?, ?)').run(2, startMs, 'inside');
  db.prepare('INSERT INTO raw_trades VALUES (?, ?, ?)').run(3, endMs - 1, 'inside-2');
  db.prepare('INSERT INTO raw_trades VALUES (?, ?, ?)').run(4, endMs, 'future');
  db.prepare('INSERT INTO flow_signals VALUES (?, ?, ?)').run(10, startMs + 5, 'inside');
  db.prepare('INSERT INTO flow_signals VALUES (?, ?, ?)').run(11, startMs - 5, 'old');
  db.prepare('INSERT INTO signal_returns VALUES (?, ?, ?)').run(10, endMs + 10_000, 12.3);
  db.prepare('INSERT INTO signal_returns VALUES (?, ?, ?)').run(11, startMs + 10, -5);
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('version', 'test');
  const walPath = `${source}-wal`;
  const walBytesBefore = fs.statSync(walPath).size;

  const result = exportResearchWindow({ sourcePath: source, destinationPath: destination, startMs, endMs, schemaPath: schema });
  assert.strictEqual(result.integrity, 'ok');
  assert.strictEqual(result.safety.walCheckpointExecuted, false);
  assert.strictEqual(result.safety.backupApiUsed, false);
  assert.strictEqual(result.safety.sourceWritesExecuted, false);
  assert.strictEqual(fs.statSync(walPath).size, walBytesBefore, 'export must not checkpoint or truncate WAL');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM raw_trades').get().count, 4);
  const exported = new Database(destination, { readonly: true });
  assert.deepStrictEqual(
    exported.prepare('SELECT id FROM raw_trades ORDER BY id').all().map((row) => row.id),
    [2, 3],
  );
  assert.deepStrictEqual(
    exported.prepare('SELECT signal_id FROM signal_returns ORDER BY signal_id').all().map((row) => row.signal_id),
    [10],
  );
  assert.strictEqual(exported.prepare('SELECT COUNT(*) AS count FROM metadata').get().count, 1);
  assert.ok(exported.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_raw_trades_ts'").get().count);
  exported.close();
  assert.match(fs.readFileSync(schema, 'utf8'), /CREATE TABLE\s+(?:main\.)?["']?raw_trades/i);
  const backupScript = fs.readFileSync(path.join(__dirname, 'export-last24h-cos.sh'), 'utf8');
  const timer = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'flow-acceleration-backup.timer'), 'utf8');
  const credentialTemplate = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'backup-cos.env.example'), 'utf8');
  assert.ok(backupScript.includes('guigu-1403019446'));
  assert.ok(backupScript.includes('cos.na-siliconvalley.myqcloud.com'));
  assert.ok(backupScript.includes('flock -n'));
  assert.ok(backupScript.includes('sha256sums.txt'));
  assert.ok(backupScript.includes('[REDACTED]'));
  assert.ok(!/wal_checkpoint|\.backup\b|db\.backup\b/i.test(backupScript));
  assert.match(timer, /OnCalendar=\*-\*-\* 08:00:00 Asia\/Shanghai/);
  assert.match(credentialTemplate, /FLOW_BACKUP_COS_SECRET_ID=\r?\n/);
  assert.match(credentialTemplate, /FLOW_BACKUP_COS_SECRET_KEY=\r?\n/);
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('test-daily-window-export: ok');
}

main();
