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
    CREATE TABLE flow_first_shadow_positions (
      id INTEGER PRIMARY KEY,
      signal_id INTEGER REFERENCES flow_signals(signal_id),
      signal_at INTEGER NOT NULL,
      mint TEXT
    );
    CREATE TABLE flow_smart_confirm_shadow_positions (
      id INTEGER PRIMARY KEY, smart_open_at INTEGER NOT NULL, mint TEXT
    );
    CREATE TABLE public_flow_lead_shadow_positions (
      id INTEGER PRIMARY KEY, signal_at INTEGER NOT NULL, mint TEXT
    );
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
  db.prepare('INSERT INTO flow_first_shadow_positions VALUES (?, ?, ?, ?)')
    .run(12, 10, startMs + 15, 'inside');
  db.prepare('INSERT INTO flow_smart_confirm_shadow_positions VALUES (?, ?, ?)')
    .run(20, startMs + 20, 'confirmed-inside');
  db.prepare('INSERT INTO flow_smart_confirm_shadow_positions VALUES (?, ?, ?)')
    .run(21, endMs + 20, 'confirmed-future');
  db.prepare('INSERT INTO public_flow_lead_shadow_positions VALUES (?, ?, ?)')
    .run(30, startMs + 30, 'public-flow-inside');
  db.prepare('INSERT INTO public_flow_lead_shadow_positions VALUES (?, ?, ?)')
    .run(31, endMs + 30, 'public-flow-future');
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('version', 'test');
  const walPath = `${source}-wal`;
  const walBytesBefore = fs.statSync(walPath).size;

  const result = exportResearchWindow({ sourcePath: source, destinationPath: destination, startMs, endMs, schemaPath: schema });
  assert.strictEqual(result.integrity, 'ok');
  assert.strictEqual(result.safety.walCheckpointExecuted, false);
  assert.strictEqual(result.safety.backupApiUsed, false);
  assert.strictEqual(result.safety.sourceWritesExecuted, false);
  assert.strictEqual(result.safety.destinationForeignKeysDisabledDuringCopy, true);
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
  assert.deepStrictEqual(
    exported.prepare('SELECT id FROM flow_smart_confirm_shadow_positions ORDER BY id')
      .all().map((row) => row.id),
    [20],
  );
  assert.deepStrictEqual(
    exported.prepare('SELECT id FROM flow_first_shadow_positions ORDER BY id')
      .all().map((row) => row.id),
    [12],
  );
  assert.deepStrictEqual(
    exported.prepare('SELECT id FROM public_flow_lead_shadow_positions ORDER BY id')
      .all().map((row) => row.id),
    [30],
  );
  assert.ok(exported.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_raw_trades_ts'").get().count);
  exported.close();
  assert.match(fs.readFileSync(schema, 'utf8'), /CREATE TABLE\s+(?:main\.)?["']?raw_trades/i);
  const backupScript = fs.readFileSync(path.join(__dirname, 'export-last24h-cos.sh'), 'utf8');
  const timer = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'flow-acceleration-backup.timer'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'flow-acceleration-backup.service'), 'utf8');
  const credentialTemplate = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'backup-cos.env.example'), 'utf8');
  const installer = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'install-daily-export.sh'), 'utf8');
  assert.ok(backupScript.includes('guigu-1403019446'));
  assert.ok(backupScript.includes('cos.na-siliconvalley.myqcloud.com'));
  assert.ok(backupScript.includes('flock -n'));
  assert.ok(backupScript.includes('sha256sums.txt'));
  assert.ok(backupScript.includes('[REDACTED]'));
  assert.ok(backupScript.includes('FLOW_BACKUP_UPLOAD_TIMEOUT'));
  assert.match(backupScript, /FLOW_BACKUP_LOCAL_RETENTION_DAYS:-2/);
  assert.ok(backupScript.includes('last-run.env'));
  assert.ok(backupScript.includes('write_state VERIFYING'));
  assert.ok(backupScript.includes('write_state CLEANING'));
  assert.ok(backupScript.includes('cleanup-research-retention.js'));
  assert.match(backupScript, /timeout --foreground "\$UPLOAD_TIMEOUT"/);
  assert.match(backupScript, /mktemp --suffix=\.yaml/);
  assert.match(backupScript, /--fail-output=false/);
  assert.ok(!/wal_checkpoint|\.backup\b|db\.backup\b/i.test(backupScript));
  assert.match(timer, /OnCalendar=\*-\*-\* 08:00:00 Asia\/Shanghai/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /Environment=HOME=@INSTALL_DIR@\/data\/exports\/\.coscli-home/);
  assert.match(service, /ReadWritePaths=@INSTALL_DIR@\/data/);
  assert.match(installer, /remove_legacy_cron/);
  assert.match(installer, /cos-auto-upload-export\\\.sh/);
  assert.match(credentialTemplate, /FLOW_BACKUP_COS_SECRET_ID=\r?\n/);
  assert.match(credentialTemplate, /FLOW_BACKUP_COS_SECRET_KEY=\r?\n/);
  assert.match(credentialTemplate, /FLOW_BACKUP_LOCAL_RETENTION_DAYS=2/);
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('test-daily-window-export: ok');
}

main();
