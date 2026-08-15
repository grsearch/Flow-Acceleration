'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { repriceHolderGrowthNoExit } = require('./reprice-holder-growth-no-exit');

function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'holder-growth-reprice-'));
  const dbPath = path.join(directory, 'research.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE holder_growth_shadow_positions (
        id INTEGER PRIMARY KEY,
        cohort_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        entry_at INTEGER,
        entry_price REAL,
        highest_price REAL,
        lowest_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        exit_mode TEXT,
        scale_out_at INTEGER,
        scale_out_price REAL,
        scale_out_fraction_pct REAL,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE flow_tokens (mint TEXT PRIMARY KEY, graduated_at INTEGER);
      CREATE TABLE raw_trades (
        id INTEGER PRIMARY KEY,
        timestamp_ms INTEGER NOT NULL,
        market TEXT NOT NULL,
        mint TEXT NOT NULL,
        price REAL NOT NULL,
        reserve_price REAL
      );
      CREATE INDEX idx_test_raw_mint_ts ON raw_trades(mint, timestamp_ms);

      INSERT INTO flow_tokens VALUES ('recoverable', NULL), ('censored', NULL);
      INSERT INTO holder_growth_shadow_positions VALUES
        (1, 'HG30_BAL:X15_FIXED', 'recoverable', 'NO_EXIT',
          'NO_EXIT_BONDING_CURVE_TIMEOUT', 1, 2.25, 5000, 1, 1.02, 0.95,
          2, -5, 'FIXED_HOLD', NULL, NULL, NULL, 10000, 15000,
          NULL, NULL, NULL, 'FIXED_HOLD', -100, -102.25, 15001),
        (2, 'HG30_BAL:X15_FIXED', 'censored', 'NO_EXIT', NULL,
          1, 2.25, 5000, 1, 1.01, 0.9, 1, -10, 'FIXED_HOLD',
          NULL, NULL, NULL, 10000, 15000, NULL, NULL, NULL,
          'FIXED_HOLD', -100, -102.25, 15001);
      INSERT INTO raw_trades VALUES
        (1, 20000, 'PUMP_BONDING_CURVE', 'recoverable', 1.1, 1.1),
        (2, 45000, 'PUMP_BONDING_CURVE', 'censored', 1.2, 1.2);
    `);
  } finally {
    db.close();
  }

  const dryRun = repriceHolderGrowthNoExit({ dbPath, windowMs: 30_000 });
  assert.strictEqual(dryRun.mode, 'DRY_RUN');
  assert.strictEqual(dryRun.scannedNoExit, 2);
  assert.strictEqual(dryRun.recoverable, 1);
  assert.strictEqual(dryRun.stillCensored, 1);
  assert.ok(Math.abs(dryRun.recoveredAverageNetReturnPct - 7.75) < 1e-9);
  assert.strictEqual(dryRun.recoveredWinRatePct, 100);
  assert.strictEqual(dryRun.projectedPricedAfterRecovery.count, 1);
  assert.strictEqual(dryRun.safety.walCheckpointExecuted, false);

  let verify = new Database(dbPath, { readonly: true });
  assert.strictEqual(
    verify.prepare('SELECT net_return_pct FROM holder_growth_shadow_positions WHERE id=1')
      .get().net_return_pct,
    -102.25,
    'dry-run must not mutate historical rows',
  );
  verify.close();

  const applied = repriceHolderGrowthNoExit({
    dbPath,
    apply: true,
    windowMs: 30_000,
    now: 1_900_000_000_000,
  });
  assert.strictEqual(applied.mode, 'APPLY');
  assert.strictEqual(applied.recoverable, 1);
  assert.ok(applied.runId);

  verify = new Database(dbPath, { readonly: true });
  try {
    const recovered = verify.prepare(`
      SELECT * FROM holder_growth_shadow_positions WHERE id=1
    `).get();
    assert.strictEqual(recovered.status, 'CLOSED');
    assert.strictEqual(recovered.exit_at, 20000);
    assert.strictEqual(recovered.exit_market, 'PUMP_BONDING_CURVE');
    assert.ok(Math.abs(recovered.gross_return_pct - 10) < 1e-9);
    assert.ok(Math.abs(recovered.net_return_pct - 7.75) < 1e-9);
    assert.match(recovered.exit_reason, /^FIXED_HOLD_RECOVERED_10000MS$/);

    const censored = verify.prepare(`
      SELECT * FROM holder_growth_shadow_positions WHERE id=2
    `).get();
    assert.strictEqual(censored.status, 'NO_EXIT');
    assert.strictEqual(censored.gross_return_pct, null);
    assert.strictEqual(censored.net_return_pct, null);
    assert.strictEqual(censored.rejection_reason, 'NO_EXIT_BONDING_CURVE_TIMEOUT');
    assert.strictEqual(
      verify.prepare('SELECT COUNT(*) AS n FROM holder_growth_no_exit_recovery_audit').get().n,
      2,
    );
  } finally {
    verify.close();
  }

  fs.rmSync(directory, { recursive: true, force: true });
  console.log('test-holder-growth-reprice: ok');
}

run();
