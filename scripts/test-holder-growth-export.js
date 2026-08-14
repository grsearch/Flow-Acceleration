'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { exportHolderGrowthShadow } = require('./export-holder-growth-shadow');

function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'holder-growth-export-'));
  const sourcePath = path.join(directory, 'source.db');
  const outputPath = path.join(directory, 'holder-growth.db');
  const manifestPath = path.join(directory, 'manifest.json');
  const schemaPath = path.join(directory, 'schema.sql');
  const source = new Database(sourcePath);
  try {
    source.exec(`
      CREATE TABLE holder_growth_shadow_positions (
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        signal_at INTEGER NOT NULL,
        exit_at INTEGER,
        exit_deadline_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_holder_growth_mint
        ON holder_growth_shadow_positions(mint, signal_at);
      CREATE TABLE flow_tokens (
        mint TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE launch_quality_observations (
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        first_trade_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE launch_quality_snapshots (
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        observed_at INTEGER NOT NULL
      );
      CREATE TABLE raw_trades (
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_raw_mint_time ON raw_trades(mint, timestamp_ms);

      INSERT INTO holder_growth_shadow_positions VALUES
        (1, 'mint-a', 1000, 3000, 8000, 3000),
        (2, 'mint-b', 10000, NULL, 12000, 12000);
      INSERT INTO flow_tokens VALUES
        ('mint-a', 3000), ('mint-b', 12000), ('mint-unrelated', 5000);
      INSERT INTO launch_quality_observations VALUES
        (1, 'mint-a', 500, 3000), (2, 'mint-b', 9000, 12000),
        (3, 'mint-unrelated', 1000, 2000);
      INSERT INTO launch_quality_snapshots VALUES
        (1, 'mint-a', 1500), (2, 'mint-a', 2500), (3, 'mint-b', 11000),
        (4, 'mint-unrelated', 1200);
      INSERT INTO raw_trades VALUES
        (1, 'mint-a', 0), (2, 'mint-a', 7000), (3, 'mint-a', 8001),
        (4, 'mint-b', 5000), (5, 'mint-b', 17000), (6, 'mint-b', 17001),
        (7, 'mint-unrelated', 2000);
    `);
  } finally {
    source.close();
  }

  const result = exportHolderGrowthShadow({
    sourcePath,
    destinationPath: outputPath,
    manifestPath,
    schemaPath,
  });
  assert.strictEqual(result.integrity, 'ok');
  assert.strictEqual(result.safety.walCheckpointExecuted, false);
  assert.ok(result.tables.every((table) => table.verified));
  assert.deepStrictEqual(
    Object.fromEntries(result.tables.map((table) => [table.table, table.exportRows])),
    {
      holder_growth_shadow_positions: 2,
      flow_tokens: 2,
      launch_quality_observations: 2,
      launch_quality_snapshots: 3,
      raw_trades: 4,
    },
  );

  const output = new Database(outputPath, { readonly: true });
  try {
    assert.strictEqual(
      output.prepare("SELECT COUNT(*) AS count FROM raw_trades WHERE mint='mint-unrelated'")
        .get().count,
      0,
    );
    assert.strictEqual(
      output.prepare("SELECT COUNT(*) AS count FROM raw_trades WHERE timestamp_ms IN (8001, 17001)")
        .get().count,
      0,
    );
    assert.ok(output.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND name='idx_raw_mint_time'
    `).get());
  } finally {
    output.close();
  }
  assert.match(fs.readFileSync(schemaPath, 'utf8'), /CREATE TABLE\s+"?raw_trades"?/);
  assert.strictEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).integrity, 'ok');

  const sourceAfter = new Database(sourcePath, { readonly: true });
  try {
    assert.strictEqual(sourceAfter.prepare('SELECT COUNT(*) AS count FROM raw_trades').get().count, 7);
  } finally {
    sourceAfter.close();
  }
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('test-holder-growth-export: ok');
}

run();
