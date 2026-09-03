'use strict';

const insertStatements = new WeakMap();

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function initializeVotingSnapshotStorage(store) {
  if (insertStatements.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS smart_wallet_voting_event_snapshots (
      smart_event_id INTEGER PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      position_phase TEXT NOT NULL,
      market TEXT,
      price REAL,
      curve_pct REAL,
      cluster_id TEXT NOT NULL,
      wallet_status TEXT,
      selection_grade TEXT,
      copy_grade TEXT,
      holding_grade TEXT,
      selection_weight REAL,
      vote_weight REAL,
      pnl_eligibility_class TEXT,
      registry_version INTEGER NOT NULL,
      snapshot_generated_at INTEGER,
      snapshot_expires_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_swv_snapshot_mint_ts
      ON smart_wallet_voting_event_snapshots(mint, timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_swv_snapshot_ts
      ON smart_wallet_voting_event_snapshots(timestamp_ms);
  `);
  insertStatements.set(store, store.db.prepare(`
    INSERT OR IGNORE INTO smart_wallet_voting_event_snapshots (
      smart_event_id, timestamp_ms, wallet, mint, side, position_phase,
      market, price, curve_pct, cluster_id, wallet_status, selection_grade,
      copy_grade, holding_grade, selection_weight, vote_weight,
      pnl_eligibility_class, registry_version, snapshot_generated_at,
      snapshot_expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `));
}

function persistVotingSnapshot(store, event, walletSnapshot, createdAt = Date.now()) {
  const smartEventId = finite(event?.id ?? event?.smartEventId ?? event?.smart_event_id);
  const timestampMs = finite(event?.timestampMs ?? event?.timestamp_ms);
  if (!(smartEventId > 0) || !(timestampMs > 0) || !event?.wallet || !event?.mint
    || !walletSnapshot) return false;
  initializeVotingSnapshotStorage(store);
  const result = insertStatements.get(store).run(
    smartEventId,
    timestampMs,
    event.wallet,
    event.mint,
    String(event.side || '').toUpperCase(),
    String(event.positionPhase || event.position_phase || '').toUpperCase(),
    event.market || null,
    finite(event.price),
    finite(event.curvePct ?? event.curve_pct),
    walletSnapshot.clusterId || event.wallet,
    walletSnapshot.status || null,
    walletSnapshot.selectionGrade || null,
    walletSnapshot.copyGrade || null,
    walletSnapshot.holdingGrade || null,
    finite(walletSnapshot.selectionWeight),
    finite(walletSnapshot.voteWeight),
    walletSnapshot.pnlEligibilityClass || null,
    finite(walletSnapshot.registryVersion, 0),
    finite(walletSnapshot.snapshotGeneratedAt),
    finite(walletSnapshot.snapshotExpiresAt),
    createdAt,
  );
  return result.changes > 0;
}

function recentVotingOpenSnapshots(store, sinceMs, untilMs = Date.now()) {
  return store.db.prepare(`
    SELECT * FROM smart_wallet_voting_event_snapshots
    WHERE timestamp_ms>=? AND timestamp_ms<=?
      AND side='BUY' AND position_phase='OPEN'
    ORDER BY timestamp_ms, smart_event_id
  `).all(sinceMs, untilMs).map((row) => ({
    event: {
      id: row.smart_event_id,
      timestampMs: row.timestamp_ms,
      wallet: row.wallet,
      mint: row.mint,
      side: row.side,
      positionPhase: row.position_phase,
      market: row.market,
      price: row.price,
      curvePct: row.curve_pct,
    },
    walletSnapshot: {
      wallet: row.wallet,
      clusterId: row.cluster_id,
      status: row.wallet_status,
      selectionGrade: row.selection_grade,
      copyGrade: row.copy_grade,
      holdingGrade: row.holding_grade,
      selectionWeight: row.selection_weight,
      voteWeight: row.vote_weight,
      pnlEligibilityClass: row.pnl_eligibility_class,
      registryVersion: row.registry_version,
      snapshotGeneratedAt: row.snapshot_generated_at,
      snapshotExpiresAt: row.snapshot_expires_at,
      votingEligible: true,
    },
  }));
}

module.exports = {
  initializeVotingSnapshotStorage,
  persistVotingSnapshot,
  recentVotingOpenSnapshots,
};
