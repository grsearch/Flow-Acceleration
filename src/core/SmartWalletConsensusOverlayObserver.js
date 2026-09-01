'use strict';

const MODEL_VERSION = 'SWC_OVERLAY_V1';
const TERMINAL_STATUSES = new Set([
  'CLOSED', 'NO_EXIT', 'NO_ENTRY', 'PRICE_JUMP', 'EXPIRED',
  'CANCELLED', 'REJECTED', 'RISK_REJECTED',
]);

const SOURCE_ADAPTERS = Object.freeze({
  MIGRATED_DROP_REBOUND: {
    table: 'migrated_drop_rebound_shadow_positions',
    cohortColumn: 'cohort_id',
    signalColumn: 'rebound_at',
    select: `
      SELECT id source_row_id, cohort_id source_cohort_id, mint,
        rebound_at source_signal_at, status source_status,
        rejection_reason source_rejection_reason,
        entry_at, exit_at, gross_return_pct, net_return_pct,
        max_favorable_return_pct mfe_pct, max_adverse_return_pct mae_pct,
        created_at source_created_at
      FROM migrated_drop_rebound_shadow_positions
    `,
  },
  GRADUATION_ACCELERATION: {
    table: 'graduation_acceleration_shadow_positions',
    cohortColumn: 'cohort_id',
    signalColumn: 'signal_at',
    select: `
      SELECT id source_row_id, cohort_id source_cohort_id, mint,
        signal_at source_signal_at, status source_status,
        rejection_reason source_rejection_reason,
        entry_at, exit_at, gross_return_pct, net_return_pct,
        max_favorable_return_pct mfe_pct, max_adverse_return_pct mae_pct,
        created_at source_created_at
      FROM graduation_acceleration_shadow_positions
    `,
  },
  FEATURE_EDGE_BNH: {
    table: 'feature_edge_audit_bnh_shadow_positions',
    cohortColumn: 'profile_id',
    signalColumn: 'signal_at_ms',
    select: `
      SELECT id source_row_id, profile_id source_cohort_id, mint,
        signal_at_ms source_signal_at, status source_status,
        COALESCE(exit_reason, missing_exit_reason) source_rejection_reason,
        signal_at_ms entry_at, exit_at_ms exit_at,
        gross_return_pct, net_return_pct, mfe_pct, mae_pct,
        created_at_ms source_created_at
      FROM feature_edge_audit_bnh_shadow_positions
    `,
  },
});

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableFinite(value) {
  if (value == null || value === '') return null;
  return finite(value);
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function performance(rows) {
  const resolved = rows.filter((row) => (
    row.source_status === 'CLOSED' && Number.isFinite(nullableFinite(row.net_return_pct))
  ));
  const entered = rows.filter((row) => row.entry_at != null);
  const returns = resolved.map((row) => nullableFinite(row.net_return_pct));
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    signals: rows.length,
    entered: entered.length,
    resolved: resolved.length,
    pending: Math.max(0, rows.length - resolved.length),
    averageNetReturnPct: returns.length
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    medianNetReturnPct: median(returns),
    winRatePct: returns.length ? wins.length / returns.length * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
    big50RatePct: returns.length
      ? returns.filter((value) => value >= 50).length / returns.length * 100 : null,
    big100RatePct: returns.length
      ? returns.filter((value) => value >= 100).length / returns.length * 100 : null,
  };
}

class SmartWalletConsensusOverlayObserver {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.lastSyncAt = 0;
    this.startedAt = 0;
    this.metrics = {
      syncs: 0,
      classified: 0,
      consensusPassed: 0,
      sourceRowsUpdated: 0,
      lastActionAt: null,
      lastError: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS smart_wallet_consensus_overlay_meta (
        id INTEGER PRIMARY KEY CHECK(id=1),
        model_version TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_sync_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS smart_wallet_consensus_overlay_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_version TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        profile_label TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_row_id INTEGER NOT NULL,
        source_cohort_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        source_signal_at INTEGER NOT NULL,
        source_status TEXT NOT NULL,
        source_rejection_reason TEXT,
        gate_status TEXT NOT NULL,
        gate_evaluated_at INTEGER NOT NULL,
        gate_finalized_at INTEGER,
        consensus_at INTEGER,
        consensus_delay_ms INTEGER,
        consensus_entry_profile_id TEXT,
        consensus_strength TEXT,
        required_clusters INTEGER,
        distinct_clusters INTEGER,
        selection_a_clusters INTEGER,
        copy_a_clusters INTEGER,
        weighted_score REAL,
        cluster_votes_json TEXT,
        entry_at INTEGER,
        exit_at INTEGER,
        gross_return_pct REAL,
        net_return_pct REAL,
        mfe_pct REAL,
        mae_pct REAL,
        source_created_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(profile_id, source_table, source_row_id)
      );
      CREATE INDEX IF NOT EXISTS idx_swc_overlay_profile_gate
        ON smart_wallet_consensus_overlay_rows(profile_id, gate_status, source_signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swc_overlay_mint_signal
        ON smart_wallet_consensus_overlay_rows(mint, source_signal_at DESC);
    `);
    this.getExisting = this.store.db.prepare(`
      SELECT * FROM smart_wallet_consensus_overlay_rows
      WHERE profile_id=? AND source_table=? AND source_row_id=?
    `);
    this.upsert = this.store.db.prepare(`
      INSERT INTO smart_wallet_consensus_overlay_rows (
        model_version, profile_id, profile_label, source_table, source_row_id,
        source_cohort_id, mint, source_signal_at, source_status,
        source_rejection_reason, gate_status, gate_evaluated_at, gate_finalized_at,
        consensus_at, consensus_delay_ms, consensus_entry_profile_id,
        consensus_strength, required_clusters, distinct_clusters,
        selection_a_clusters, copy_a_clusters, weighted_score, cluster_votes_json,
        entry_at, exit_at, gross_return_pct, net_return_pct, mfe_pct, mae_pct,
        source_created_at, created_at, updated_at
      ) VALUES (
        @modelVersion, @profileId, @profileLabel, @sourceTable, @sourceRowId,
        @sourceCohortId, @mint, @sourceSignalAt, @sourceStatus,
        @sourceRejectionReason, @gateStatus, @gateEvaluatedAt, @gateFinalizedAt,
        @consensusAt, @consensusDelayMs, @consensusEntryProfileId,
        @consensusStrength, @requiredClusters, @distinctClusters,
        @selectionAClusters, @copyAClusters, @weightedScore, @clusterVotesJson,
        @entryAt, @exitAt, @grossReturnPct, @netReturnPct, @mfePct, @maePct,
        @sourceCreatedAt, @createdAt, @updatedAt
      ) ON CONFLICT(profile_id, source_table, source_row_id) DO UPDATE SET
        source_status=excluded.source_status,
        source_rejection_reason=excluded.source_rejection_reason,
        gate_status=excluded.gate_status,
        gate_evaluated_at=excluded.gate_evaluated_at,
        gate_finalized_at=excluded.gate_finalized_at,
        consensus_at=excluded.consensus_at,
        consensus_delay_ms=excluded.consensus_delay_ms,
        consensus_entry_profile_id=excluded.consensus_entry_profile_id,
        consensus_strength=excluded.consensus_strength,
        required_clusters=excluded.required_clusters,
        distinct_clusters=excluded.distinct_clusters,
        selection_a_clusters=excluded.selection_a_clusters,
        copy_a_clusters=excluded.copy_a_clusters,
        weighted_score=excluded.weighted_score,
        cluster_votes_json=excluded.cluster_votes_json,
        entry_at=excluded.entry_at,
        exit_at=excluded.exit_at,
        gross_return_pct=excluded.gross_return_pct,
        net_return_pct=excluded.net_return_pct,
        mfe_pct=excluded.mfe_pct,
        mae_pct=excluded.mae_pct,
        updated_at=excluded.updated_at
    `);
  }

  _tableExists(table) {
    return Boolean(this.store.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
    `).get(table));
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_consensus_overlay_meta (
        id, model_version, started_at, last_sync_at, updated_at
      ) VALUES (1, ?, ?, NULL, ?)
    `).run(MODEL_VERSION, now, now);
    const meta = this.store.db.prepare(`
      SELECT * FROM smart_wallet_consensus_overlay_meta WHERE id=1
    `).get();
    this.startedAt = finite(meta?.started_at, now);
    this.lastSyncAt = finite(meta?.last_sync_at, 0);
    this.sync(now, { force: true });
  }

  stop() {}

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    const syncMs = Math.max(1_000, finite(this.config.syncMs, 5_000));
    if (this.lastSyncAt && now - this.lastSyncAt < syncMs) return;
    this.sync(now);
  }

  _profiles() {
    return (this.config.profiles || []).filter((profile) => (
      profile.enabled !== false && SOURCE_ADAPTERS[profile.source]
    ));
  }

  _sourceRows(profile, now) {
    const adapter = SOURCE_ADAPTERS[profile.source];
    if (!this._tableExists(adapter.table)) return [];
    const lastSourceId = finite(this.store.db.prepare(`
      SELECT MAX(source_row_id) id FROM smart_wallet_consensus_overlay_rows
      WHERE profile_id=? AND source_table=?
    `).get(profile.id, adapter.table)?.id, 0);
    const maxRows = Math.max(10, finite(this.config.maxRowsPerSync, 2_000));
    const lateCutoff = now - Math.max(5_000, finite(this.config.gateFinalizeDelayMs, 60_000));
    return this.store.db.prepare(`
      ${adapter.select}
      WHERE ${adapter.cohortColumn}=@sourceCohortId
        AND ${adapter.signalColumn}>=@startedAt
        AND (
          id>@lastSourceId
          OR id IN (
            SELECT source_row_id FROM smart_wallet_consensus_overlay_rows
            WHERE profile_id=@profileId AND source_table=@sourceTable
              AND (source_status NOT IN (
                'CLOSED','NO_EXIT','NO_ENTRY','PRICE_JUMP','EXPIRED',
                'CANCELLED','REJECTED','RISK_REJECTED'
              ) OR (gate_status='NO_CONSENSUS' AND source_signal_at>=@lateCutoff))
          )
        )
      ORDER BY id
      LIMIT @maxRows
    `).all({
      sourceCohortId: profile.sourceCohortId,
      startedAt: this.startedAt,
      lastSourceId,
      profileId: profile.id,
      sourceTable: adapter.table,
      lateCutoff,
      maxRows,
    });
  }

  _consensus(mint, sourceSignalAt) {
    if (!this._tableExists('smart_wallet_consensus_flow_runner_shadow_positions')) return null;
    const gateWindowMs = Math.max(1_000, finite(this.config.gateWindowMs, 15 * 60_000));
    return this.store.db.prepare(`
      SELECT signal_at, entry_profile_id, signal_strength,
        required_clusters, distinct_clusters, selection_a_clusters,
        copy_a_clusters, weighted_score, cluster_votes_json
      FROM smart_wallet_consensus_flow_runner_shadow_positions
      WHERE mint=? AND signal_at>=? AND signal_at<=?
        AND distinct_clusters>=required_clusters
      ORDER BY signal_at DESC, distinct_clusters DESC, id DESC
      LIMIT 1
    `).get(mint, sourceSignalAt - gateWindowMs, sourceSignalAt);
  }

  _save(profile, source, consensus, now) {
    const adapter = SOURCE_ADAPTERS[profile.source];
    const existing = this.getExisting.get(profile.id, adapter.table, source.source_row_id);
    const retainedConsensus = consensus || (existing?.gate_status === 'PASS' ? {
      signal_at: existing.consensus_at,
      entry_profile_id: existing.consensus_entry_profile_id,
      signal_strength: existing.consensus_strength,
      required_clusters: existing.required_clusters,
      distinct_clusters: existing.distinct_clusters,
      selection_a_clusters: existing.selection_a_clusters,
      copy_a_clusters: existing.copy_a_clusters,
      weighted_score: existing.weighted_score,
      cluster_votes_json: existing.cluster_votes_json,
    } : null);
    const passed = Boolean(retainedConsensus);
    const finalizeDelayMs = Math.max(
      5_000, finite(this.config.gateFinalizeDelayMs, 60_000),
    );
    const gateFinalizedAt = passed
      ? now : (now - source.source_signal_at >= finalizeDelayMs ? now : null);
    const result = this.upsert.run({
      modelVersion: MODEL_VERSION,
      profileId: profile.id,
      profileLabel: profile.label || profile.id,
      sourceTable: adapter.table,
      sourceRowId: source.source_row_id,
      sourceCohortId: source.source_cohort_id,
      mint: source.mint,
      sourceSignalAt: source.source_signal_at,
      sourceStatus: source.source_status,
      sourceRejectionReason: source.source_rejection_reason || null,
      gateStatus: passed ? 'PASS' : 'NO_CONSENSUS',
      gateEvaluatedAt: now,
      gateFinalizedAt,
      consensusAt: retainedConsensus?.signal_at ?? null,
      consensusDelayMs: retainedConsensus
        ? source.source_signal_at - retainedConsensus.signal_at : null,
      consensusEntryProfileId: retainedConsensus?.entry_profile_id || null,
      consensusStrength: retainedConsensus?.signal_strength || null,
      requiredClusters: retainedConsensus?.required_clusters ?? null,
      distinctClusters: retainedConsensus?.distinct_clusters ?? null,
      selectionAClusters: retainedConsensus?.selection_a_clusters ?? null,
      copyAClusters: retainedConsensus?.copy_a_clusters ?? null,
      weightedScore: retainedConsensus?.weighted_score ?? null,
      clusterVotesJson: retainedConsensus?.cluster_votes_json || null,
      entryAt: source.entry_at ?? null,
      exitAt: source.exit_at ?? null,
      grossReturnPct: source.gross_return_pct ?? null,
      netReturnPct: source.net_return_pct ?? null,
      mfePct: source.mfe_pct ?? null,
      maePct: source.mae_pct ?? null,
      sourceCreatedAt: source.source_created_at ?? null,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });
    if (!existing) {
      this.metrics.classified += 1;
      if (passed) this.metrics.consensusPassed += 1;
    } else if (existing.gate_status !== 'PASS' && passed) {
      this.metrics.consensusPassed += 1;
    }
    if (result.changes) this.metrics.sourceRowsUpdated += 1;
  }

  sync(now = this.now(), { force = false } = {}) {
    if (!this.config.enabled) return null;
    const syncMs = Math.max(1_000, finite(this.config.syncMs, 5_000));
    if (!force && this.lastSyncAt && now - this.lastSyncAt < syncMs) return null;
    let processed = 0;
    try {
      const saveRows = this.store.db.transaction((items) => {
        for (const item of items) {
          this._save(item.profile, item.source, item.consensus, now);
        }
      });
      const items = [];
      for (const profile of this._profiles()) {
        for (const source of this._sourceRows(profile, now)) {
          items.push({
            profile,
            source,
            consensus: this._consensus(source.mint, source.source_signal_at),
          });
        }
      }
      saveRows(items);
      processed = items.length;
      this.lastSyncAt = now;
      this.metrics.syncs += 1;
      this.metrics.lastActionAt = now;
      this.metrics.lastError = null;
      this.store.db.prepare(`
        UPDATE smart_wallet_consensus_overlay_meta
        SET model_version=?, last_sync_at=?, updated_at=? WHERE id=1
      `).run(MODEL_VERSION, now, now);
    } catch (error) {
      this.metrics.lastError = String(error?.message || error).slice(0, 1_000);
      throw error;
    }
    return { processed };
  }

  dashboard(limit = 100) {
    const capped = Math.max(1, Math.min(500, finite(limit, 100)));
    const rows = this.store.db.prepare(`
      SELECT * FROM smart_wallet_consensus_overlay_rows
      WHERE model_version=? ORDER BY source_signal_at DESC, id DESC
    `).all(MODEL_VERSION);
    const profiles = this._profiles().map((profile) => {
      const sample = rows.filter((row) => row.profile_id === profile.id);
      const gated = sample.filter((row) => row.gate_status === 'PASS');
      const baseline = performance(sample);
      const consensus = performance(gated);
      return {
        id: profile.id,
        label: profile.label || profile.id,
        source: profile.source,
        sourceCohortId: profile.sourceCohortId,
        consensusPassRatePct: sample.length ? gated.length / sample.length * 100 : null,
        baseline,
        consensus,
        deltaAverageNetReturnPct: Number.isFinite(baseline.averageNetReturnPct)
          && Number.isFinite(consensus.averageNetReturnPct)
          ? consensus.averageNetReturnPct - baseline.averageNetReturnPct : null,
        deltaWinRatePct: Number.isFinite(baseline.winRatePct)
          && Number.isFinite(consensus.winRatePct)
          ? consensus.winRatePct - baseline.winRatePct : null,
      };
    });
    return {
      ...this.health(),
      modelVersion: MODEL_VERSION,
      startedAt: this.startedAt,
      gatePolicy: {
        gateWindowMs: Math.max(1_000, finite(this.config.gateWindowMs, 15 * 60_000)),
        sourceSignalMustFollowConsensus: true,
        usesQualifiedRegistryClusters: true,
        duplicatesSourceExecution: false,
        originalCohortsUnchanged: true,
      },
      profiles,
      recent: rows.slice(0, capped),
    };
  }

  health() {
    const counts = this.store.db.prepare(`
      SELECT gate_status, COUNT(*) count
      FROM smart_wallet_consensus_overlay_rows
      WHERE model_version=? GROUP BY gate_status
    `).all(MODEL_VERSION);
    const byGate = Object.fromEntries(counts.map((row) => [row.gate_status, row.count]));
    return {
      enabled: this.config.enabled,
      mode: MODEL_VERSION,
      observerOnly: true,
      sendsTransactions: false,
      profiles: this._profiles().length,
      classified: (byGate.PASS || 0) + (byGate.NO_CONSENSUS || 0),
      consensusPassed: byGate.PASS || 0,
      noConsensus: byGate.NO_CONSENSUS || 0,
      lastSyncAt: this.lastSyncAt || null,
      ...this.metrics,
    };
  }
}

module.exports = {
  SmartWalletConsensusOverlayObserver,
  MODEL_VERSION,
  SOURCE_ADAPTERS,
  TERMINAL_STATUSES,
};
