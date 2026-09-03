'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const {
  SmartWalletConsensusOverlayObserver,
  MODEL_VERSION,
} = require('../src/core/SmartWalletConsensusOverlayObserver');

function insertSource(store, {
  episodeId, mint, signalAt, status = 'CLOSED', entryAt = signalAt + 200,
  netReturnPct = null,
}) {
  store.db.prepare(`
    INSERT INTO graduation_acceleration_shadow_positions (
      cohort_id, episode_id, entry_profile_id, mint, status,
      position_sol, configured_cost_pct, signal_at, signal_price,
      features_json, entry_target_at, entry_deadline_at, entry_at,
      core_weight_pct, gross_return_pct, net_return_pct, created_at, updated_at
    ) VALUES (
      'O_TEST:1SOL', ?, 'O_TEST', ?, ?,
      1, 2.251, ?, 1,
      '{}', ?, ?, ?,
      50, ?, ?, ?, ?
    )
  `).run(
    episodeId, mint, status, signalAt, signalAt + 200, signalAt + 2_000,
    entryAt, netReturnPct, netReturnPct, signalAt, signalAt,
  );
}

function insertConsensus(store, {
  mint, signalAt, clusters = 3, required = 2, entryProfileId = 'PA3_POST_FLOW_V1',
}) {
  store.db.prepare(`
    INSERT INTO smart_wallet_consensus_flow_runner_shadow_positions (
      mint, signal_at, entry_profile_id, signal_strength,
      required_clusters, distinct_clusters, selection_a_clusters,
      copy_a_clusters, weighted_score, cluster_votes_json
    ) VALUES (?, ?, ?, 'PREDICTION_A3', ?, ?, 2, 1, 2.5, '[]')
  `).run(mint, signalAt, entryProfileId, required, clusters);
}

function main() {
  const base = 1_900_000_000_000;
  let now = base;
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  store.db.exec(`
    CREATE TABLE smart_wallet_consensus_flow_runner_shadow_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL, signal_at INTEGER NOT NULL,
      entry_profile_id TEXT NOT NULL, signal_strength TEXT NOT NULL,
      required_clusters INTEGER NOT NULL, distinct_clusters INTEGER NOT NULL,
      selection_a_clusters INTEGER NOT NULL, copy_a_clusters INTEGER NOT NULL,
      weighted_score REAL NOT NULL, cluster_votes_json TEXT NOT NULL
    );
  `);
  const observer = new SmartWalletConsensusOverlayObserver({
    store,
    now: () => now,
    config: {
      enabled: true,
      consensusEntryProfileIds: ['PA3_POST_FLOW_V1'],
      gateWindowMs: 15 * 60_000,
      gateFinalizeDelayMs: 60_000,
      syncMs: 1_000,
      maxRowsPerSync: 100,
      profiles: [{
        id: 'SWC_O_TEST', label: 'O test + consensus',
        source: 'GRADUATION_ACCELERATION', sourceCohortId: 'O_TEST:1SOL',
      }],
    },
  });

  insertSource(store, {
    episodeId: 'historical', mint: 'historical-mint', signalAt: base - 1,
    netReturnPct: 99,
  });
  observer.start();
  assert.strictEqual(observer.dashboard().classified, 0,
    'the observer must not backfill source signals from before deployment');

  insertConsensus(store, { mint: 'pass-mint', signalAt: base + 500 });
  insertSource(store, {
    episodeId: 'pass', mint: 'pass-mint', signalAt: base + 1_000,
    netReturnPct: 20,
  });
  insertSource(store, {
    episodeId: 'late-persist', mint: 'late-persist-mint', signalAt: base + 2_000,
    netReturnPct: -10,
  });
  insertSource(store, {
    episodeId: 'future-only', mint: 'future-only-mint', signalAt: base + 3_000,
    netReturnPct: 5,
  });
  insertSource(store, {
    episodeId: 'unpriced-close', mint: 'unpriced-mint', signalAt: base + 4_000,
    netReturnPct: null,
  });
  insertConsensus(store, { mint: 'future-only-mint', signalAt: base + 3_100 });
  now = base + 5_000;
  observer.sync(now, { force: true });

  let rows = store.db.prepare(`
    SELECT * FROM smart_wallet_consensus_overlay_rows ORDER BY source_signal_at
  `).all();
  assert.deepStrictEqual(rows.map((row) => row.gate_status), [
    'PASS', 'NO_CONSENSUS', 'NO_CONSENSUS', 'NO_CONSENSUS',
  ]);
  assert.strictEqual(rows[0].consensus_delay_ms, 500);
  assert.strictEqual(rows[2].consensus_at, null,
    'consensus persisted after the source signal must never pass the causal gate');

  insertConsensus(store, { mint: 'late-persist-mint', signalAt: base + 1_900 });
  now = base + 6_000;
  observer.sync(now, { force: true });
  rows = store.db.prepare(`
    SELECT * FROM smart_wallet_consensus_overlay_rows ORDER BY source_signal_at
  `).all();
  assert.strictEqual(rows[1].gate_status, 'PASS',
    'a causally earlier consensus persisted shortly after the source row must be recovered');
  assert.strictEqual(rows[1].consensus_delay_ms, 100);

  const dashboard = observer.dashboard();
  assert.strictEqual(dashboard.modelVersion, MODEL_VERSION);
  assert.strictEqual(dashboard.observerOnly, true);
  assert.strictEqual(dashboard.sendsTransactions, false);
  assert.strictEqual(dashboard.classified, 4);
  assert.strictEqual(dashboard.consensusPassed, 2);
  assert.strictEqual(dashboard.noConsensus, 2);
  assert.strictEqual(dashboard.profiles[0].baseline.resolved, 3,
    'a CLOSED row without a priced return must not be counted as resolved');
  assert.strictEqual(dashboard.profiles[0].consensus.resolved, 2);
  assert.ok(Math.abs(dashboard.profiles[0].baseline.averageNetReturnPct - 5) < 1e-12);
  assert.ok(Math.abs(dashboard.profiles[0].consensus.averageNetReturnPct - 5) < 1e-12);
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) count FROM graduation_acceleration_shadow_positions')
      .get().count,
    5,
    'the overlay must not duplicate or mutate the source Shadow rows',
  );

  observer.stop();
  store.close();
  console.log('Smart Wallet consensus overlay tests: PASS');
}

main();
