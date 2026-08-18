'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ResearchStore } = require('../src/data/ResearchStore');

function storage(dbPath, directory) {
  return {
    dbPath, archiveDir: directory, rawRetentionHours: 48,
    flushMs: 60_000, flushMax: 1_000,
  };
}

function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-startup-no-rewrite-'));
  const dbPath = path.join(directory, 'research.db');
  const labels = { configuredTradingCostPct: 0 };
  const first = new ResearchStore(storage(dbPath, directory), labels);
  first.recordSignal({
    timestampMs: 1_800_000_000_000,
    slot: 1,
    signature: 'startup-signal',
    mint: 'startup-mint',
    symbol: 'START',
    ageMs: 10_000,
    curvePct: 70,
    price: 1,
    buyFlowW1: 1,
    buyFlowW2: 2,
    buyFlowW3: 3,
    sellFlowW1: 0,
    sellFlowW2: 0,
    sellFlowW3: 0,
    netFlowW1: 1,
    netFlowW2: 2,
    netFlowW3: 3,
    deltaNetFlow12: 1,
    deltaNetFlow23: 1,
    uniqueBuyersW1: 1,
    uniqueBuyersW2: 2,
    uniqueBuyersW3: 3,
    buyTxW1: 1,
    buyTxW2: 2,
    buyTxW3: 3,
    flowAccel1: 2,
    flowAccel2: 1.5,
  });
  first.db.prepare(`
    UPDATE signal_returns SET finalized_at=?, label_status='COMPLETE',
      missing_horizons_json='[]' WHERE signal_id=1
  `).run(1_800_000_060_000);
  first.close();

  const guard = new Database(dbPath);
  guard.exec(`
    CREATE TRIGGER reject_startup_signal_rewrite
    BEFORE UPDATE ON flow_signals
    BEGIN SELECT RAISE(ABORT, 'startup rewrote flow_signals history'); END;
    CREATE TRIGGER reject_startup_return_rewrite
    BEFORE UPDATE ON signal_returns
    BEGIN SELECT RAISE(ABORT, 'startup rewrote signal_returns history'); END;
  `);
  guard.close();

  assert.doesNotThrow(() => {
    const restarted = new ResearchStore(storage(dbPath, directory), labels);
    restarted.close();
  }, 'normal restart must not rewrite historical signal or return tables');

  fs.rmSync(directory, { recursive: true, force: true });
  console.log('test-startup-no-history-rewrite: ok');
}

main();
