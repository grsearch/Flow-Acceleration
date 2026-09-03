'use strict';

const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const { tradePrice } = require('./PreEntryRugRiskTracker');

const DAY_MS = 24 * 60 * 60_000;

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
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function profitFactor(values) {
  const profit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(values.filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0));
  return loss > 0 ? profit / loss : (profit > 0 ? null : 0);
}

function topProfitContribution(values) {
  const wins = values.filter((value) => value > 0).sort((left, right) => right - left);
  const total = wins.reduce((sum, value) => sum + value, 0);
  return total > 0 ? wins[0] / total * 100 : null;
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '') || fallback;
  } catch (_) {
    return fallback;
  }
}

function gradeWeight(grade) {
  if (grade === 'S_A') return 1;
  if (grade === 'S_B') return 0.5;
  return 0;
}

function copyWeight(grade) {
  if (grade === 'C_A') return 1;
  if (grade === 'C_B') return 0.5;
  return 0;
}

class SmartWalletRegistry {
  constructor({
    config, store, now = () => Date.now(), fetchImpl = globalThis.fetch,
    transactionParser = null, maintenanceWorkerFactory = null,
  }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.transactionParser = transactionParser;
    this.maintenanceWorkerFactory = maintenanceWorkerFactory
      || ((workerPath, options) => new Worker(workerPath, options));
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.labelPositionSol });
    this.labels = new Map();
    this.labelsByMint = new Map();
    this.pnlSnapshotCache = new Map();
    this.ageChecks = new Map();
    this.ageAbortControllers = new Set();
    this.historyAbortControllers = new Set();
    this.historyBackfills = new Map();
    this.lastHistoryScheduleAt = 0;
    this.ageHistoryFloor = null;
    this.ageHistoryFloorCheckedAt = 0;
    this.gradeRefreshRequested = false;
    this.lastClusterRefreshAt = 0;
    this.lastGradeMaintenanceRequestedAt = 0;
    this.maintenanceQueue = [];
    this.maintenancePendingTypes = new Set();
    this.maintenanceWorker = null;
    this.maintenanceWorkerTimer = null;
    this.activeClusterCountsCache = null;
    this.walletEligibilitySnapshot = {
      generatedAt: 0,
      expiresAt: 0,
      registryVersion: 0,
      all: new Map(),
      monitoring: new Map(),
      voting: new Map(),
      clusterCounts: { eligible: 0, selectionA: 0 },
      pnlCounts: {},
      ageCounts: {},
      statusCounts: {},
    };
    this.walletEligibilitySnapshotDirty = true;
    this.lastSeenWrites = new Map();
    this.actualEventBackfillPending = true;
    this.lastActualEventBackfillAt = 0;
    this.stopping = false;
    this.metrics = {
      discovered: 0,
      seeded: 0,
      labelsCreated: 0,
      labelsCompleted: 0,
      labelsNoEntry: 0,
      labelsNoExit: 0,
      actualEventsProcessed: 0,
      actualEventsIgnored: 0,
      actualPositionsOpened: 0,
      actualPositionsClosed: 0,
      actualBackfilled: 0,
      clusterRefreshes: 0,
      clusterConfirmations: 0,
      clusterRelatedLinks: 0,
      gradeRefreshes: 0,
      ageChecksStarted: 0,
      ageChecksCompleted: 0,
      ageChecksFailed: 0,
      historyWalletsCompleted: 0,
      historyWalletsFailed: 0,
      historyPagesFetched: 0,
      historyCreditsSpent: 0,
      historyTransactionsSeen: 0,
      historyTradeEventsParsed: 0,
      historyEventsInserted: 0,
      maintenanceRunsStarted: 0,
      maintenanceRunsCompleted: 0,
      maintenanceRunsFailed: 0,
      maintenanceTimeouts: 0,
      lastMaintenanceType: null,
      lastMaintenanceStartedAt: null,
      lastMaintenanceCompletedAt: null,
      lastMaintenanceDurationMs: null,
      lastMaintenanceError: null,
      lastGradeRefreshAt: null,
      lastAgeCheckAt: null,
      eligibilitySnapshotRefreshes: 0,
      eligibilitySnapshotReads: 0,
      eligibilitySnapshotHits: 0,
      eligibilitySnapshotMisses: 0,
      eligibilitySnapshotStaleReads: 0,
      lastEligibilitySnapshotAt: null,
      lastEligibilitySnapshotDurationMs: null,
      lastEligibilitySnapshotError: null,
      lastSeenWrites: 0,
      lastSeenWritesSkipped: 0,
      actualBackfillBatches: 0,
      actualBackfillLastBatchSize: 0,
      actualBackfillLastBatchAt: null,
      actualBackfillLastError: null,
      lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS smart_wallet_registry_meta (
        id INTEGER PRIMARY KEY CHECK(id=1),
        registry_version INTEGER NOT NULL,
        last_grade_refresh_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO smart_wallet_registry_meta (
        id, registry_version, last_grade_refresh_at, updated_at
      ) VALUES (1, 1, NULL, 0);

      CREATE TABLE IF NOT EXISTS smart_wallet_registry (
        wallet TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        selection_grade TEXT NOT NULL,
        copy_grade TEXT NOT NULL,
        holding_grade TEXT NOT NULL,
        risk_status TEXT NOT NULL,
        source TEXT NOT NULL,
        discovered_at INTEGER NOT NULL,
        effective_from INTEGER NOT NULL,
        last_seen_at INTEGER,
        age_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        first_chain_activity_at INTEGER,
        age_verified_at INTEGER,
        age_source TEXT,
        age_check_error TEXT,
        age_check_after INTEGER,
        age_scan_before_signature TEXT,
        age_history_complete INTEGER NOT NULL DEFAULT 0,
        metrics_json TEXT NOT NULL,
        registry_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_status_effective
        ON smart_wallet_registry(status, effective_from);
      CREATE INDEX IF NOT EXISTS idx_swr_grades
        ON smart_wallet_registry(selection_grade, copy_grade, updated_at DESC);

      CREATE TABLE IF NOT EXISTS smart_wallet_discovery_seeds (
        wallet TEXT NOT NULL,
        seed_mint TEXT NOT NULL,
        source TEXT NOT NULL,
        discovered_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(wallet, seed_mint)
      );
      CREATE INDEX IF NOT EXISTS idx_swr_seed_mint
        ON smart_wallet_discovery_seeds(seed_mint, wallet);

      CREATE TABLE IF NOT EXISTS smart_wallet_cluster_memberships (
        wallet TEXT PRIMARY KEY,
        cluster_id TEXT NOT NULL,
        confidence TEXT NOT NULL,
        reason_json TEXT NOT NULL,
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        registry_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_cluster_active
        ON smart_wallet_cluster_memberships(cluster_id, valid_from, valid_to);

      CREATE TABLE IF NOT EXISTS smart_wallet_cluster_evaluations (
        wallet TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        eligible_at INTEGER NOT NULL,
        distinct_mints INTEGER NOT NULL DEFAULT 0,
        correlated_wallets INTEGER NOT NULL DEFAULT 0,
        cluster_id TEXT,
        reason_json TEXT NOT NULL,
        evaluated_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_cluster_eval_status
        ON smart_wallet_cluster_evaluations(status, eligible_at);

      CREATE TABLE IF NOT EXISTS smart_wallet_grade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        effective_at INTEGER NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        old_selection_grade TEXT,
        new_selection_grade TEXT NOT NULL,
        old_copy_grade TEXT,
        new_copy_grade TEXT NOT NULL,
        old_holding_grade TEXT,
        new_holding_grade TEXT NOT NULL,
        reason TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        registry_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_grade_history_wallet
        ON smart_wallet_grade_history(wallet, effective_at DESC);

      CREATE TABLE IF NOT EXISTS smart_wallet_forward_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        smart_event_id INTEGER NOT NULL UNIQUE,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        status TEXT NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_market TEXT NOT NULL,
        signal_price REAL NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_impact_pct REAL,
        token_units REAL,
        return_30s_pct REAL,
        return_300s_pct REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        graduated_at INTEGER,
        seed_excluded INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        rejection_reason TEXT,
        configured_cost_pct REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_labels_wallet_time
        ON smart_wallet_forward_labels(wallet, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swr_labels_mint_status
        ON smart_wallet_forward_labels(mint, status, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swr_labels_status_target
        ON smart_wallet_forward_labels(status, entry_target_at);

      CREATE TABLE IF NOT EXISTS smart_wallet_actual_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        total_bought_tokens REAL NOT NULL DEFAULT 0,
        total_sold_tokens REAL NOT NULL DEFAULT 0,
        total_buy_sol REAL NOT NULL DEFAULT 0,
        total_sell_sol REAL NOT NULL DEFAULT 0,
        token_balance REAL NOT NULL DEFAULT 0,
        remaining_cost_sol REAL NOT NULL DEFAULT 0,
        realized_cost_sol REAL NOT NULL DEFAULT 0,
        realized_pnl_sol REAL NOT NULL DEFAULT 0,
        realized_return_pct REAL,
        buy_count INTEGER NOT NULL DEFAULT 0,
        sell_count INTEGER NOT NULL DEFAULT 0,
        first_event_id INTEGER NOT NULL,
        last_event_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_swr_actual_active_wallet_mint
        ON smart_wallet_actual_positions(wallet, mint)
        WHERE status IN ('OPEN','PARTIAL');
      CREATE INDEX IF NOT EXISTS idx_swr_actual_wallet_closed
        ON smart_wallet_actual_positions(wallet, closed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swr_actual_closed_wallet
        ON smart_wallet_actual_positions(closed_at DESC, wallet);
      CREATE INDEX IF NOT EXISTS idx_swr_actual_mint_status
        ON smart_wallet_actual_positions(mint, status, opened_at DESC);

      CREATE TABLE IF NOT EXISTS smart_wallet_pnl_processed_events (
        smart_event_id INTEGER PRIMARY KEY,
        position_id INTEGER,
        accounting_status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(position_id) REFERENCES smart_wallet_actual_positions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_swr_pnl_event_position
        ON smart_wallet_pnl_processed_events(position_id, smart_event_id);

      CREATE TABLE IF NOT EXISTS smart_wallet_history_backfill_meta (
        id INTEGER PRIMARY KEY CHECK(id=1),
        initial_cutoff_at INTEGER NOT NULL,
        initialized_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS smart_wallet_history_backfills (
        wallet TEXT PRIMARY KEY,
        cohort TEXT NOT NULL,
        status TEXT NOT NULL,
        window_start_at INTEGER NOT NULL,
        window_end_at INTEGER NOT NULL,
        pagination_token TEXT,
        request_page_size INTEGER,
        pages_fetched INTEGER NOT NULL DEFAULT 0,
        credits_spent INTEGER NOT NULL DEFAULT 0,
        transactions_seen INTEGER NOT NULL DEFAULT 0,
        trade_events_parsed INTEGER NOT NULL DEFAULT 0,
        inserted_events INTEGER NOT NULL DEFAULT 0,
        ledger_complete INTEGER NOT NULL DEFAULT 0,
        orphan_events INTEGER NOT NULL DEFAULT 0,
        first_started_at INTEGER,
        last_started_at INTEGER,
        next_attempt_at INTEGER,
        completed_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_history_queue
        ON smart_wallet_history_backfills(status, cohort, next_attempt_at, created_at);

      CREATE TABLE IF NOT EXISTS smart_wallet_history_backfill_daily (
        day_start_at INTEGER PRIMARY KEY,
        wallets_started INTEGER NOT NULL DEFAULT 0,
        pages_fetched INTEGER NOT NULL DEFAULT 0,
        credits_spent INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    const historyColumns = new Set(this.store.db.prepare(
      'PRAGMA table_info(smart_wallet_history_backfills)',
    ).all().map((column) => column.name));
    if (!historyColumns.has('request_page_size')) {
      this.store.db.exec(
        'ALTER TABLE smart_wallet_history_backfills ADD COLUMN request_page_size INTEGER',
      );
    }
    const registryColumns = new Set(this.store.db.prepare(
      'PRAGMA table_info(smart_wallet_registry)',
    ).all().map((column) => column.name));
    const ageColumns = [
      ['age_status', "TEXT NOT NULL DEFAULT 'UNKNOWN'"],
      ['first_chain_activity_at', 'INTEGER'],
      ['age_verified_at', 'INTEGER'],
      ['age_source', 'TEXT'],
      ['age_check_error', 'TEXT'],
      ['age_check_after', 'INTEGER'],
      ['age_scan_before_signature', 'TEXT'],
      ['age_history_complete', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of ageColumns) {
      if (!registryColumns.has(name)) {
        this.store.db.exec(`ALTER TABLE smart_wallet_registry ADD COLUMN ${name} ${definition}`);
      }
    }
    this.store.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_swr_age_check
        ON smart_wallet_registry(age_status, age_check_after);
    `);
    this.insertRegistry = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_registry (
        wallet, status, selection_grade, copy_grade, holding_grade, risk_status,
        source, discovered_at, effective_from, last_seen_at, age_status,
        age_check_after, metrics_json,
        registry_version, created_at, updated_at
      ) VALUES (
        @wallet, @status, @selectionGrade, @copyGrade, @holdingGrade, @riskStatus,
        @source, @discoveredAt, @effectiveFrom, NULL, @ageStatus,
        @ageCheckAfter, @metricsJson,
        @registryVersion, @createdAt, @updatedAt
      )
    `);
    this.insertSeed = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_discovery_seeds (
        wallet, seed_mint, source, discovered_at, created_at
      ) VALUES (@wallet, @seedMint, @source, @discoveredAt, @createdAt)
    `);
    this.insertCluster = this.store.db.prepare(`
      INSERT INTO smart_wallet_cluster_memberships (
        wallet, cluster_id, confidence, reason_json, valid_from, valid_to,
        registry_version, created_at, updated_at
      ) VALUES (
        @wallet, @clusterId, @confidence, @reasonJson, @validFrom, NULL,
        @registryVersion, @createdAt, @updatedAt
      ) ON CONFLICT(wallet) DO UPDATE SET
        cluster_id=excluded.cluster_id,
        confidence=excluded.confidence,
        reason_json=excluded.reason_json,
        valid_from=excluded.valid_from,
        valid_to=NULL,
        registry_version=excluded.registry_version,
        updated_at=excluded.updated_at
    `);
    this.upsertClusterEvaluation = this.store.db.prepare(`
      INSERT INTO smart_wallet_cluster_evaluations (
        wallet, status, eligible_at, distinct_mints, correlated_wallets,
        cluster_id, reason_json, evaluated_at, updated_at
      ) VALUES (
        @wallet, @status, @eligibleAt, @distinctMints, @correlatedWallets,
        @clusterId, @reasonJson, @evaluatedAt, @updatedAt
      ) ON CONFLICT(wallet) DO UPDATE SET
        status=excluded.status,
        eligible_at=excluded.eligible_at,
        distinct_mints=excluded.distinct_mints,
        correlated_wallets=excluded.correlated_wallets,
        cluster_id=excluded.cluster_id,
        reason_json=excluded.reason_json,
        evaluated_at=excluded.evaluated_at,
        updated_at=excluded.updated_at
      WHERE smart_wallet_cluster_evaluations.status<>excluded.status
        OR smart_wallet_cluster_evaluations.eligible_at<>excluded.eligible_at
        OR smart_wallet_cluster_evaluations.distinct_mints<>excluded.distinct_mints
        OR smart_wallet_cluster_evaluations.correlated_wallets<>excluded.correlated_wallets
        OR smart_wallet_cluster_evaluations.cluster_id IS NOT excluded.cluster_id
        OR smart_wallet_cluster_evaluations.reason_json<>excluded.reason_json
    `);
    this.insertLabel = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_forward_labels (
        smart_event_id, wallet, mint, status, signal_at, signal_market, signal_price,
        entry_target_at, entry_deadline_at, seed_excluded, configured_cost_pct,
        created_at, updated_at
      ) VALUES (
        @smartEventId, @wallet, @mint, 'PENDING_ENTRY', @signalAt, @signalMarket,
        @signalPrice, @entryTargetAt, @entryDeadlineAt, @seedExcluded,
        @configuredCostPct, @createdAt, @updatedAt
      )
    `);
    this.updateLabel = this.store.db.prepare(`
      UPDATE smart_wallet_forward_labels SET
        status=@status,
        entry_at=@entryAt,
        entry_market=@entryMarket,
        entry_price=@entryPrice,
        entry_impact_pct=@entryImpactPct,
        token_units=@tokenUnits,
        return_30s_pct=@return30sPct,
        return_300s_pct=@return300sPct,
        max_favorable_return_pct=@maxFavorableReturnPct,
        max_adverse_return_pct=@maxAdverseReturnPct,
        graduated_at=@graduatedAt,
        completed_at=@completedAt,
        rejection_reason=@rejectionReason,
        updated_at=@updatedAt
      WHERE id=@id
    `);
    this.getProcessedActualEvent = this.store.db.prepare(`
      SELECT * FROM smart_wallet_pnl_processed_events WHERE smart_event_id=?
    `);
    this.insertProcessedActualEvent = this.store.db.prepare(`
      INSERT INTO smart_wallet_pnl_processed_events (
        smart_event_id, position_id, accounting_status, created_at
      ) VALUES (@smartEventId, @positionId, @accountingStatus, @createdAt)
    `);
    this.getActiveActualPosition = this.store.db.prepare(`
      SELECT * FROM smart_wallet_actual_positions
      WHERE wallet=? AND mint=? AND status IN ('OPEN','PARTIAL')
      ORDER BY opened_at DESC, id DESC LIMIT 1
    `);
    this.insertActualPosition = this.store.db.prepare(`
      INSERT INTO smart_wallet_actual_positions (
        wallet, mint, status, opened_at, closed_at,
        total_bought_tokens, total_sold_tokens, total_buy_sol, total_sell_sol,
        token_balance, remaining_cost_sol, realized_cost_sol, realized_pnl_sol,
        realized_return_pct, buy_count, sell_count, first_event_id, last_event_id,
        created_at, updated_at
      ) VALUES (
        @wallet, @mint, @status, @openedAt, NULL,
        @totalBoughtTokens, 0, @totalBuySol, 0,
        @tokenBalance, @remainingCostSol, 0, 0,
        NULL, 1, 0, @firstEventId, @lastEventId,
        @createdAt, @updatedAt
      )
    `);
    this.updateActualPosition = this.store.db.prepare(`
      UPDATE smart_wallet_actual_positions SET
        status=@status, closed_at=@closedAt,
        total_bought_tokens=@totalBoughtTokens,
        total_sold_tokens=@totalSoldTokens,
        total_buy_sol=@totalBuySol,
        total_sell_sol=@totalSellSol,
        token_balance=@tokenBalance,
        remaining_cost_sol=@remainingCostSol,
        realized_cost_sol=@realizedCostSol,
        realized_pnl_sol=@realizedPnlSol,
        realized_return_pct=@realizedReturnPct,
        buy_count=@buyCount, sell_count=@sellCount,
        last_event_id=@lastEventId, updated_at=@updatedAt
      WHERE id=@id
    `);
    this.processActualWalletEvent = this.store.db.transaction(
      (event) => this._applyActualWalletEvent(event),
    );
    this.processActualWalletEventBatch = this.store.db.transaction(
      (events) => events.reduce(
        (processed, event) => processed + (this._applyActualWalletEvent(event) ? 1 : 0),
        0,
      ),
    );
    this.rebuildActualWalletLedger = this.store.db.transaction(
      (wallet) => this._rebuildActualWalletLedger(wallet),
    );
  }

  _normalizeActualEvent(event) {
    const smartEventId = finite(event?.id ?? event?.smartEventId ?? event?.smart_event_id);
    const timestampMs = finite(event?.timestampMs ?? event?.timestamp_ms);
    const wallet = event?.wallet ? String(event.wallet) : '';
    const mint = event?.mint ? String(event.mint) : '';
    const side = String(event?.side || '').toUpperCase();
    const phase = String(event?.positionPhase || event?.position_phase || '').toUpperCase();
    const solAmount = Math.max(0, finite(event?.solAmount ?? event?.sol_amount, 0));
    let tokenAmount = Math.max(0, finite(event?.tokenAmount ?? event?.token_amount, 0));
    const price = finite(event?.price, tradePrice(event));
    if (!(tokenAmount > 0) && solAmount > 0 && price > 0) tokenAmount = solAmount / price;
    return {
      smartEventId, timestampMs, wallet, mint, side, phase, solAmount, tokenAmount,
      tokenBalanceBefore: nullableFinite(
        event?.tokenBalanceBefore ?? event?.token_balance_before,
      ),
      tokenBalanceAfter: nullableFinite(
        event?.tokenBalanceAfter ?? event?.token_balance_after,
      ),
    };
  }

  _markActualEvent(event, positionId, accountingStatus) {
    this.insertProcessedActualEvent.run({
      smartEventId: event.smartEventId,
      positionId: positionId ?? null,
      accountingStatus,
      createdAt: this.now(),
    });
    this.metrics.actualEventsProcessed += 1;
    if (accountingStatus.startsWith('IGNORED_')) this.metrics.actualEventsIgnored += 1;
    this.metrics.lastActionAt = this.now();
    return { positionId: positionId ?? null, accountingStatus };
  }

  _applyActualWalletEvent(rawEvent) {
    const event = this._normalizeActualEvent(rawEvent);
    if (!(event.smartEventId > 0)) return null;
    const processed = this.getProcessedActualEvent.get(event.smartEventId);
    if (processed) {
      return {
        positionId: processed.position_id,
        accountingStatus: processed.accounting_status,
        duplicate: true,
      };
    }
    if (!(event.timestampMs > 0) || !event.wallet || !event.mint
      || !['BUY', 'SELL'].includes(event.side)) {
      return this._markActualEvent(event, null, 'IGNORED_INVALID_EVENT');
    }
    const active = this.getActiveActualPosition.get(event.wallet, event.mint);
    if (event.side === 'BUY') {
      if (!(event.solAmount > 0) || !(event.tokenAmount > 0)) {
        return this._markActualEvent(event, active?.id, 'IGNORED_INVALID_BUY');
      }
      if (!active) {
        // ADD means the visible history started in the middle of a position. Do not
        // invent its earlier cost basis; wait for the next independently observed OPEN.
        if (event.phase === 'ADD') {
          return this._markActualEvent(event, null, 'IGNORED_ORPHAN_ADD');
        }
        const createdAt = this.now();
        const result = this.insertActualPosition.run({
          wallet: event.wallet,
          mint: event.mint,
          status: 'OPEN',
          openedAt: event.timestampMs,
          totalBoughtTokens: event.tokenAmount,
          totalBuySol: event.solAmount,
          tokenBalance: event.tokenAmount,
          remainingCostSol: event.solAmount,
          firstEventId: event.smartEventId,
          lastEventId: event.smartEventId,
          createdAt,
          updatedAt: createdAt,
        });
        const positionId = Number(result.lastInsertRowid);
        this.metrics.actualPositionsOpened += 1;
        this.pnlSnapshotCache.delete(event.wallet);
        return this._markActualEvent(event, positionId, 'OPENED');
      }
      this.updateActualPosition.run({
        id: active.id,
        status: active.status,
        closedAt: null,
        totalBoughtTokens: active.total_bought_tokens + event.tokenAmount,
        totalSoldTokens: active.total_sold_tokens,
        totalBuySol: active.total_buy_sol + event.solAmount,
        totalSellSol: active.total_sell_sol,
        tokenBalance: active.token_balance + event.tokenAmount,
        remainingCostSol: active.remaining_cost_sol + event.solAmount,
        realizedCostSol: active.realized_cost_sol,
        realizedPnlSol: active.realized_pnl_sol,
        realizedReturnPct: null,
        buyCount: active.buy_count + 1,
        sellCount: active.sell_count,
        lastEventId: event.smartEventId,
        updatedAt: this.now(),
      });
      this.pnlSnapshotCache.delete(event.wallet);
      return this._markActualEvent(event, active.id, 'ADDED');
    }

    if (!active) return this._markActualEvent(event, null, 'IGNORED_ORPHAN_SELL');
    const beforeBalance = Math.max(0, finite(active.token_balance, 0));
    let soldTokens = event.tokenAmount;
    if (!(soldTokens > 0) && event.tokenBalanceBefore != null
      && event.tokenBalanceAfter != null) {
      soldTokens = Math.max(0, event.tokenBalanceBefore - event.tokenBalanceAfter);
    }
    if (!(beforeBalance > 0) || !(soldTokens > 0) || !(event.solAmount >= 0)) {
      return this._markActualEvent(event, active.id, 'IGNORED_INVALID_SELL');
    }
    const dust = Math.max(1e-9, beforeBalance * 0.005);
    const phaseCloses = event.phase === 'CLOSE'
      || (event.tokenBalanceAfter != null && event.tokenBalanceAfter <= dust);
    const closes = phaseCloses || beforeBalance - soldTokens <= dust;
    const accountedTokens = closes ? beforeBalance : Math.min(beforeBalance, soldTokens);
    const saleFraction = closes ? 1 : Math.min(1, accountedTokens / soldTokens);
    const attributedSellSol = event.solAmount * saleFraction;
    const costFraction = closes ? 1 : accountedTokens / beforeBalance;
    const allocatedCost = active.remaining_cost_sol * Math.min(1, costFraction);
    const realizedCostSol = active.realized_cost_sol + allocatedCost;
    const realizedPnlSol = active.realized_pnl_sol + attributedSellSol - allocatedCost;
    const totalBuySol = active.total_buy_sol;
    const status = closes ? 'CLOSED' : 'PARTIAL';
    const realizedReturnPct = closes && totalBuySol > 0
      ? realizedPnlSol / totalBuySol * 100 : null;
    this.updateActualPosition.run({
      id: active.id,
      status,
      closedAt: closes ? event.timestampMs : null,
      totalBoughtTokens: active.total_bought_tokens,
      totalSoldTokens: active.total_sold_tokens + accountedTokens,
      totalBuySol,
      totalSellSol: active.total_sell_sol + attributedSellSol,
      tokenBalance: closes ? 0 : Math.max(0, beforeBalance - accountedTokens),
      remainingCostSol: closes ? 0 : Math.max(0, active.remaining_cost_sol - allocatedCost),
      realizedCostSol,
      realizedPnlSol,
      realizedReturnPct,
      buyCount: active.buy_count,
      sellCount: active.sell_count + 1,
      lastEventId: event.smartEventId,
      updatedAt: this.now(),
    });
    if (closes) {
      this.metrics.actualPositionsClosed += 1;
      this.gradeRefreshRequested = true;
    }
    this.pnlSnapshotCache.delete(event.wallet);
    return this._markActualEvent(event, active.id, closes ? 'CLOSED' : 'PARTIAL');
  }

  _backfillActualWalletEvents(limit = null) {
    const capped = limit != null && Number.isFinite(Number(limit))
      ? Math.max(1, Math.trunc(Number(limit))) : null;
    const rows = this.store.db.prepare(`
      SELECT event.* FROM smart_wallet_events event
      JOIN smart_wallet_registry registry ON registry.wallet=event.wallet
      LEFT JOIN smart_wallet_pnl_processed_events processed
        ON processed.smart_event_id=event.id
      WHERE processed.smart_event_id IS NULL
        AND COALESCE(event.event_source, 'LIVE')<>'HISTORICAL_BACKFILL'
      ORDER BY event.timestamp_ms, event.id
      ${capped == null ? '' : 'LIMIT ?'}
    `).all(...(capped == null ? [] : [capped]));
    const processed = rows.length ? this.processActualWalletEventBatch(rows) : 0;
    this.metrics.actualBackfilled += processed;
    this.metrics.actualBackfillBatches += 1;
    this.metrics.actualBackfillLastBatchSize = processed;
    this.metrics.actualBackfillLastBatchAt = this.now();
    this.metrics.actualBackfillLastError = null;
    this.actualEventBackfillPending = capped != null && rows.length >= capped;
    return processed;
  }

  _advanceActualEventBackfill(at = this.now(), { force = false } = {}) {
    if (!this.actualEventBackfillPending || this.stopping) return 0;
    const intervalMs = Math.max(
      1_000,
      finite(this.config.actualEventBackfillIntervalMs, 5_000),
    );
    if (!force && this.lastActualEventBackfillAt
      && at - this.lastActualEventBackfillAt < intervalMs) return 0;
    this.lastActualEventBackfillAt = at;
    const batchSize = Math.max(
      10,
      Math.trunc(finite(this.config.actualEventBackfillBatchSize, 250)),
    );
    try {
      return this._backfillActualWalletEvents(batchSize);
    } catch (error) {
      this.metrics.actualBackfillLastError = error.message;
      return 0;
    }
  }

  _rebuildActualWalletLedger(wallet) {
    const events = this.store.db.prepare(`
      SELECT * FROM smart_wallet_events
      WHERE wallet=? ORDER BY timestamp_ms, id
    `).all(wallet);
    this.store.db.prepare(`
      DELETE FROM smart_wallet_pnl_processed_events
      WHERE smart_event_id IN (SELECT id FROM smart_wallet_events WHERE wallet=?)
    `).run(wallet);
    this.store.db.prepare('DELETE FROM smart_wallet_actual_positions WHERE wallet=?').run(wallet);
    this.store.db.prepare('DELETE FROM smart_wallet_positions WHERE wallet=?').run(wallet);
    const balances = new Map();
    let orphanEvents = 0;
    for (const row of events) {
      const mint = String(row.mint || '');
      const side = String(row.side || '').toUpperCase();
      const amount = Math.max(0, finite(row.token_amount, 0));
      const before = Math.max(0, balances.get(mint) || 0);
      let after = before;
      let phase = row.position_phase;
      if (side === 'BUY') {
        phase = before > 0 ? 'ADD' : 'OPEN';
        after = before + amount;
      } else if (side === 'SELL' && before > 0 && amount > 0) {
        after = Math.max(0, before - amount);
        const dust = Math.max(1e-9, before * 0.005);
        phase = after <= dust ? 'CLOSE' : 'REDUCE';
        if (phase === 'CLOSE') after = 0;
      } else if (side === 'SELL') {
        phase = 'SELL';
        after = 0;
      }
      balances.set(mint, after);
      this.store.db.prepare(`
        UPDATE smart_wallet_events SET position_phase=?, token_balance_before=?,
          token_balance_after=? WHERE id=?
      `).run(phase, before, after, row.id);
      const accounting = this._applyActualWalletEvent({
        ...row,
        position_phase: phase,
        token_balance_before: before,
        token_balance_after: after,
      });
      if (!accounting || String(accounting.accountingStatus || '').startsWith('IGNORED_')) {
        orphanEvents += 1;
      }
    }
    const upsert = this.store.db.prepare(`
      INSERT INTO smart_wallet_positions (wallet, mint, token_balance, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(wallet, mint) DO UPDATE SET token_balance=excluded.token_balance,
        updated_at=excluded.updated_at
    `);
    for (const [mint, balance] of balances) {
      upsert.run(wallet, mint, balance, this.now());
    }
    this.pnlSnapshotCache.delete(wallet);
    this.gradeRefreshRequested = true;
    return { events: events.length, orphanEvents, ledgerComplete: orphanEvents === 0 };
  }

  _historyDayStart(at = this.now()) {
    const cstOffsetMs = 8 * 60 * 60_000;
    return Math.floor((at + cstOffsetMs) / DAY_MS) * DAY_MS - cstOffsetMs;
  }

  _initializeHistoryBackfills(at = this.now()) {
    if (this.config.historyBackfillEnabled !== true) return;
    this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_history_backfill_meta (
        id, initial_cutoff_at, initialized_at, updated_at
      ) VALUES (1, ?, ?, ?)
    `).run(at, at, at);
    this.store.db.prepare(`
      UPDATE smart_wallet_history_backfills SET status='PENDING', updated_at=?
      WHERE status='RUNNING'
    `).run(at);
    this._enqueueHistoryBackfills(at);
  }

  _enqueueHistoryBackfills(at = this.now()) {
    if (this.config.historyBackfillEnabled !== true) return 0;
    const meta = this.store.db.prepare(
      'SELECT * FROM smart_wallet_history_backfill_meta WHERE id=1',
    ).get();
    if (!meta) return 0;
    const historyWindowMs = Math.max(
      7 * DAY_MS, finite(this.config.historyWindowMs, 60 * DAY_MS),
    );
    const warmupMs = Math.max(0, finite(this.config.historyWarmupMs, 30 * DAY_MS));
    const insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_history_backfills (
        wallet, cohort, status, window_start_at, window_end_at,
        created_at, updated_at
      ) VALUES (?, ?, 'PENDING', ?, ?, ?, ?)
    `);
    let inserted = 0;
    const wallets = this.store.db.prepare(`
      SELECT r.wallet, r.discovered_at FROM smart_wallet_registry r
      LEFT JOIN smart_wallet_history_backfills h ON h.wallet=r.wallet
      WHERE h.wallet IS NULL ORDER BY r.discovered_at, r.wallet
    `).all();
    for (const row of wallets) {
      const initial = this.config.historyInitialAllEnabled !== false
        && row.discovered_at <= meta.initial_cutoff_at;
      inserted += insert.run(
        row.wallet,
        initial ? 'INITIAL' : 'DAILY',
        at - historyWindowMs - warmupMs,
        at,
        at,
        at,
      ).changes;
    }
    return inserted;
  }

  _historyDailyUsage(at = this.now()) {
    const dayStartAt = this._historyDayStart(at);
    this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_history_backfill_daily (
        day_start_at, wallets_started, pages_fetched, credits_spent, updated_at
      ) VALUES (?, 0, 0, 0, ?)
    `).run(dayStartAt, at);
    return this.store.db.prepare(`
      SELECT * FROM smart_wallet_history_backfill_daily WHERE day_start_at=?
    `).get(dayStartAt);
  }

  _claimHistoryBackfill(at = this.now()) {
    const candidates = this.store.db.prepare(`
      SELECT * FROM smart_wallet_history_backfills
      WHERE status IN ('PENDING','FAILED','PAUSED')
        AND COALESCE(next_attempt_at, 0)<=?
      ORDER BY CASE cohort WHEN 'INITIAL' THEN 0 ELSE 1 END,
        CASE WHEN first_started_at IS NULL THEN 1 ELSE 0 END,
        COALESCE(last_started_at, 0), created_at, wallet
      LIMIT 200
    `).all(at);
    const daily = this._historyDailyUsage(at);
    const walletLimit = Math.max(1, finite(this.config.historyDailyWalletLimit, 50));
    const creditLimit = Math.max(1_000, finite(
      this.config.historyDailyCreditLimit, 250_000,
    ));
    const row = candidates.find((candidate) => candidate.cohort === 'INITIAL'
      || candidate.first_started_at != null
      || (daily.wallets_started < walletLimit && daily.credits_spent < creditLimit));
    if (!row) return null;
    const firstStart = row.first_started_at == null;
    this.store.db.prepare(`
      UPDATE smart_wallet_history_backfills SET status='RUNNING',
        first_started_at=COALESCE(first_started_at, ?), last_started_at=?,
        next_attempt_at=NULL, updated_at=? WHERE wallet=?
    `).run(at, at, at, row.wallet);
    if (row.cohort === 'DAILY' && firstStart) {
      this.store.db.prepare(`
        UPDATE smart_wallet_history_backfill_daily
        SET wallets_started=wallets_started+1, updated_at=? WHERE day_start_at=?
      `).run(at, daily.day_start_at);
    }
    return this.store.db.prepare(
      'SELECT * FROM smart_wallet_history_backfills WHERE wallet=?',
    ).get(row.wallet);
  }

  async _historyRpc(wallet, row) {
    if (!this.config.historyRpcUrl) throw new Error('HISTORY_RPC_URL_MISSING');
    if (typeof this.fetchImpl !== 'function') throw new Error('HISTORY_FETCH_UNAVAILABLE');
    const controller = new AbortController();
    this.historyAbortControllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1_000, finite(this.config.historyRpcTimeoutMs, 30_000)),
    );
    const filters = {
      blockTime: {
        gte: Math.floor(row.window_start_at / 1_000),
        lt: Math.ceil(row.window_end_at / 1_000),
      },
      status: 'succeeded',
      tokenAccounts: 'balanceChanged',
    };
    const options = {
      transactionDetails: 'full',
      encoding: 'json',
      maxSupportedTransactionVersion: 0,
      sortOrder: 'asc',
      limit: Math.max(1, Math.min(1_000,
        row.request_page_size == null
          ? finite(this.config.historyPageSize, 1_000)
          : finite(row.request_page_size, finite(this.config.historyPageSize, 1_000)))),
      filters,
    };
    if (row.pagination_token) options.paginationToken = row.pagination_token;
    try {
      const response = await this.fetchImpl(this.config.historyRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress',
          params: [wallet, options],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HISTORY_RPC_HTTP_${response.status}`);
      const json = await response.json();
      if (json.error) throw new Error(`HISTORY_RPC_${json.error.code || 'ERROR'}`);
      const result = json.result || {};
      const data = Array.isArray(result)
        ? result : (Array.isArray(result.data) ? result.data : (result.transactions || []));
      const paginationToken = result.paginationToken
        || result.pagination_token
        || data[data.length - 1]?.paginationToken
        || data[data.length - 1]?.pagination_token
        || null;
      return { data, paginationToken };
    } finally {
      clearTimeout(timeout);
      this.historyAbortControllers.delete(controller);
    }
  }

  _recordHistoryPage(wallet, transactions) {
    let parsed = 0;
    let inserted = 0;
    for (const transaction of transactions) {
      const receivedAt = finite(transaction?.blockTime, 0) * 1_000 || this.now();
      const events = this.transactionParser.parseTransaction(transaction, receivedAt) || [];
      for (const event of events) {
        if (!['trade', 'ammTrade'].includes(event.type) || event.wallet !== wallet
          || !['BUY', 'SELL'].includes(String(event.side || '').toUpperCase())) continue;
        parsed += 1;
        if (this.store.recordHistoricalSmartWalletEvent(event).inserted) inserted += 1;
      }
    }
    return { parsed, inserted };
  }

  async _runHistoryBackfill(claimed) {
    let row = claimed;
    try {
      const maxPages = Math.max(1, finite(this.config.historyMaxPagesPerWallet, 500));
      while (!this.stopping && row.pages_fetched < maxPages) {
        if (row.cohort === 'DAILY') {
          const daily = this._historyDailyUsage(this.now());
          const creditLimit = Math.max(1_000, finite(
            this.config.historyDailyCreditLimit, 250_000,
          ));
          if (daily.credits_spent >= creditLimit) {
            const nextDay = daily.day_start_at + DAY_MS;
            this.store.db.prepare(`
              UPDATE smart_wallet_history_backfills SET status='PAUSED',
                next_attempt_at=?, updated_at=? WHERE wallet=?
            `).run(nextDay, this.now(), row.wallet);
            return;
          }
        }
        const page = await this._historyRpc(row.wallet, row);
        const stats = this._recordHistoryPage(row.wallet, page.data);
        const credits = Math.max(1, finite(this.config.historyCreditsPerPage, 50));
        const now = this.now();
        this.store.db.prepare(`
          UPDATE smart_wallet_history_backfills SET
            pagination_token=?, pages_fetched=pages_fetched+1,
            credits_spent=credits_spent+?, transactions_seen=transactions_seen+?,
            trade_events_parsed=trade_events_parsed+?, inserted_events=inserted_events+?,
            updated_at=? WHERE wallet=?
        `).run(
          page.paginationToken, credits, page.data.length, stats.parsed,
          stats.inserted, now, row.wallet,
        );
        if (row.cohort === 'DAILY') {
          const dayStart = this._historyDayStart(now);
          this.store.db.prepare(`
            UPDATE smart_wallet_history_backfill_daily SET
              pages_fetched=pages_fetched+1, credits_spent=credits_spent+?, updated_at=?
            WHERE day_start_at=?
          `).run(credits, now, dayStart);
        }
        this.metrics.historyPagesFetched += 1;
        this.metrics.historyCreditsSpent += credits;
        this.metrics.historyTransactionsSeen += page.data.length;
        this.metrics.historyTradeEventsParsed += stats.parsed;
        this.metrics.historyEventsInserted += stats.inserted;
        const priorToken = row.pagination_token;
        row = this.store.db.prepare(
          'SELECT * FROM smart_wallet_history_backfills WHERE wallet=?',
        ).get(row.wallet);
        if (!page.paginationToken || page.paginationToken === priorToken || !page.data.length) {
          const rebuilt = this.rebuildActualWalletLedger(row.wallet);
          this.store.db.prepare(`
            UPDATE smart_wallet_history_backfills SET status='COMPLETE',
              pagination_token=NULL, ledger_complete=?, orphan_events=?,
              completed_at=?, next_attempt_at=NULL, last_error=NULL, updated_at=?
            WHERE wallet=?
          `).run(
            rebuilt.ledgerComplete ? 1 : 0,
            rebuilt.orphanEvents,
            now,
            now,
            row.wallet,
          );
          this.metrics.historyWalletsCompleted += 1;
          return;
        }
      }
      throw new Error('HISTORY_MAX_PAGES_REACHED');
    } catch (error) {
      if (this.stopping && error?.name === 'AbortError') return;
      const now = this.now();
      const message = String(error?.message || error).slice(0, 500);
      const timeoutLike = error?.name === 'AbortError' || /abort|timeout/i.test(message);
      const currentPageSize = Math.max(1, Math.min(1_000,
        row.request_page_size == null
          ? finite(this.config.historyPageSize, 1_000)
          : finite(row.request_page_size, finite(this.config.historyPageSize, 1_000))));
      const nextPageSize = timeoutLike ? Math.max(100, Math.floor(currentPageSize / 2)) : null;
      this.store.db.prepare(`
        UPDATE smart_wallet_history_backfills SET status='FAILED', last_error=?,
          request_page_size=COALESCE(?,request_page_size),
          next_attempt_at=?, updated_at=? WHERE wallet=?
      `).run(
        message,
        nextPageSize,
        now + Math.max(60 * 60_000, finite(this.config.historyRetryMs, DAY_MS)),
        now,
        row.wallet,
      );
      this.metrics.historyWalletsFailed += 1;
    }
  }

  _scheduleHistoryBackfills(at = this.now(), { force = false } = {}) {
    if (this.config.historyBackfillEnabled !== true || this.stopping
      || !this.config.historyRpcUrl || !this.transactionParser) return;
    if (!force && at - this.lastHistoryScheduleAt < 1_000) return;
    this.lastHistoryScheduleAt = at;
    this._enqueueHistoryBackfills(at);
    const concurrency = Math.max(1, finite(this.config.historyConcurrency, 2));
    while (this.historyBackfills.size < concurrency) {
      const row = this._claimHistoryBackfill(at);
      if (!row || this.historyBackfills.has(row.wallet)) break;
      const task = this._runHistoryBackfill(row)
        .catch(() => null)
        .finally(() => {
          this.historyBackfills.delete(row.wallet);
          if (!this.stopping) this._scheduleHistoryBackfills(this.now(), { force: true });
        });
      this.historyBackfills.set(row.wallet, task);
    }
  }

  _pnlWindowSummary(rows, startAt, endAt) {
    const sample = rows.filter((row) => row.closed_at >= startAt && row.closed_at <= endAt);
    const pnlValues = sample.map((row) => finite(row.realized_pnl_sol, 0));
    const returnValues = sample.map((row) => finite(row.realized_return_pct))
      .filter(Number.isFinite);
    const investedSol = sample.reduce((sum, row) => sum + finite(row.total_buy_sol, 0), 0);
    const realizedPnlSol = pnlValues.reduce((sum, value) => sum + value, 0);
    const positiveDays = new Map();
    for (const row of sample) {
      const day = Math.floor(row.closed_at / DAY_MS);
      positiveDays.set(day, (positiveDays.get(day) || 0) + finite(row.realized_pnl_sol, 0));
    }
    const holdDurations = sample.map((row) => Math.max(0, row.closed_at - row.opened_at));
    return {
      closedPositions: sample.length,
      investedSol,
      realizedPnlSol,
      capitalReturnPct: investedSol > 0 ? realizedPnlSol / investedSol * 100 : null,
      winRatePct: sample.length
        ? pnlValues.filter((value) => value > 0).length / sample.length * 100 : null,
      profitFactor: profitFactor(pnlValues),
      averageReturnPct: average(returnValues),
      medianReturnPct: median(returnValues),
      top1ProfitContributionPct: topProfitContribution(pnlValues),
      activeDays: positiveDays.size,
      positiveDayPct: positiveDays.size
        ? [...positiveDays.values()].filter((value) => value > 0).length
          / positiveDays.size * 100
        : null,
      averageHoldMs: average(holdDurations),
      medianHoldMs: median(holdDurations),
      big50RatePct: sample.length
        ? returnValues.filter((value) => value >= 50).length / sample.length * 100 : 0,
      big100RatePct: sample.length
        ? returnValues.filter((value) => value >= 100).length / sample.length * 100 : 0,
    };
  }

  _actualPnlSnapshot(wallet, at = this.now()) {
    const cacheMs = Math.max(60_000, finite(this.config.pnlSnapshotCacheMs, 15 * 60_000));
    const cacheBucket = Math.floor(at / cacheMs);
    const cached = this.pnlSnapshotCache.get(wallet);
    if (cached?.bucket === cacheBucket) return cached.snapshot;
    const maxLookbackMs = Math.max(
      30 * DAY_MS,
      finite(this.config.lookbackMs, 60 * DAY_MS),
      finite(this.config.pnlWindowMs, DAY_MS),
      finite(this.config.elite60dWindowMs, 60 * DAY_MS),
    );
    const rows = this.store.db.prepare(`
      SELECT * FROM smart_wallet_actual_positions
      WHERE wallet=? AND status='CLOSED' AND closed_at>=? AND closed_at<=?
      ORDER BY closed_at, id
    `).all(wallet, at - maxLookbackMs, at);
    const open = this.store.db.prepare(`
      SELECT COUNT(*) open_positions,
        COALESCE(SUM(remaining_cost_sol), 0) open_cost_sol
      FROM smart_wallet_actual_positions
      WHERE wallet=? AND status IN ('OPEN','PARTIAL') AND opened_at<=?
    `).get(wallet, at);
    const pnlWindowMs = Math.max(DAY_MS, finite(this.config.pnlWindowMs, DAY_MS));
    const window24h = this._pnlWindowSummary(rows, at - pnlWindowMs, at);
    const window7d = this._pnlWindowSummary(rows, at - 7 * DAY_MS, at);
    const window30d = this._pnlWindowSummary(rows, at - 30 * DAY_MS, at);
    const eliteWindowMs = Math.max(
      7 * DAY_MS, finite(this.config.elite60dWindowMs, 60 * DAY_MS),
    );
    const window60d = this._pnlWindowSummary(rows, at - eliteWindowMs, at);
    const lookback = this._pnlWindowSummary(rows, at - maxLookbackMs, at);
    const minClosedPositions = Math.max(1, finite(this.config.pnlMinClosedPositions, 1));
    const minRealizedSol = Math.max(0, finite(this.config.pnlMinRealizedSol, 0));
    const minCapitalReturnPct = Math.max(0, finite(this.config.pnlMinCapitalReturnPct, 0));
    const history = this.store.db.prepare(`
      SELECT status, window_start_at, window_end_at, ledger_complete,
        orphan_events, completed_at, pages_fetched, credits_spent, last_error
      FROM smart_wallet_history_backfills WHERE wallet=?
    `).get(wallet);
    const historyComplete = history?.status === 'COMPLETE'
      && Boolean(history.ledger_complete)
      && history.window_start_at <= at - eliteWindowMs;
    const eliteMinRealizedSol = Math.max(
      0, finite(this.config.elite60dMinRealizedSol, 200),
    );
    const eliteQualified = this.config.elite60dEnabled === true
      && historyComplete
      && window60d.realizedPnlSol > eliteMinRealizedSol;
    let status = 'PNL_BYPASS';
    let eligible = true;
    let eligibilityClass = 'BYPASS';
    if (eliteQualified) {
      status = 'PNL_ELITE_60D';
      eligibilityClass = 'LONG_TERM_ELITE';
    } else if (this.config.pnlGateEnabled !== false) {
      if (window24h.closedPositions < minClosedPositions) {
        status = 'PNL_PENDING';
        eligible = false;
      } else if (window24h.realizedPnlSol > minRealizedSol
        && window24h.capitalReturnPct > minCapitalReturnPct) {
        status = 'PNL_PROFITABLE';
        eligibilityClass = 'ACTIVE_24H';
      } else {
        status = 'LOSS_BLOCKED';
        eligible = false;
      }
    }
    const snapshot = {
      status,
      eligible,
      minClosedPositions,
      minRealizedSol,
      minCapitalReturnPct,
      eliteMinRealizedSol,
      eliteWindowMs,
      eliteQualified,
      eligibilityClass,
      historyComplete,
      history: history || null,
      windowMs: pnlWindowMs,
      window24h,
      window7d,
      window30d,
      window60d,
      lookback,
      openPositions: Number(open?.open_positions) || 0,
      openCostSol: finite(open?.open_cost_sol, 0),
    };
    this.pnlSnapshotCache.set(wallet, { bucket: cacheBucket, snapshot });
    return snapshot;
  }

  _pnlEligibleRow(row, at = this.now()) {
    return Boolean(row?.wallet && this._actualPnlSnapshot(row.wallet, at).eligible);
  }

  _maintenanceWorkerEnabled() {
    return this.config.maintenanceWorkerEnabled !== false
      && this.store.config?.dbPath
      && this.store.config.dbPath !== ':memory:';
  }

  _maintenanceWorkerTimeoutMs() {
    return Math.max(
      60_000,
      finite(this.config.maintenanceWorkerTimeoutMs, 10 * 60_000),
    );
  }

  _gradeDirtyRefreshMinMs() {
    return Math.max(
      60_000,
      finite(this.config.gradeDirtyRefreshMinMs, 15 * 60_000),
    );
  }

  _clusterCountCacheMs() {
    return Math.max(60_000, finite(this.config.clusterCountCacheMs, 15 * 60_000));
  }

  _votingSnapshotRefreshMs() {
    return Math.max(
      60_000,
      finite(this.config.votingSnapshotRefreshMs, 15 * 60_000),
    );
  }

  _lastSeenWriteIntervalMs() {
    return Math.max(
      60_000,
      finite(this.config.lastSeenWriteIntervalMs, 15 * 60_000),
    );
  }

  _pnlSnapshotFromGradeRow(row) {
    const metrics = parseJson(row?.metrics_json, {});
    const emptyWindow = () => ({
      closedPositions: 0,
      investedSol: 0,
      realizedPnlSol: 0,
      capitalReturnPct: null,
      winRatePct: null,
      profitFactor: 0,
      top1ProfitContributionPct: null,
      activeDays: 0,
      positiveDayPct: null,
      averageHoldMs: null,
      medianHoldMs: null,
      big50RatePct: 0,
      big100RatePct: 0,
    });
    const hasAggregated24h = Object.prototype.hasOwnProperty.call(
      row || {}, 'pnl_24h_closed_positions',
    );
    const aggregated24h = hasAggregated24h ? {
      ...emptyWindow(),
      closedPositions: finite(row.pnl_24h_closed_positions, 0),
      investedSol: finite(row.pnl_24h_invested_sol, 0),
      realizedPnlSol: finite(row.pnl_24h_realized_sol, 0),
      capitalReturnPct: finite(row.pnl_24h_invested_sol, 0) > 0
        ? finite(row.pnl_24h_realized_sol, 0) / finite(row.pnl_24h_invested_sol, 0) * 100
        : null,
      winRatePct: finite(row.pnl_24h_closed_positions, 0) > 0
        ? finite(row.pnl_24h_winners, 0) / finite(row.pnl_24h_closed_positions, 0) * 100
        : null,
    } : null;
    const window24h = aggregated24h || metrics.actualPnl24h || emptyWindow();
    const longTermElite = metrics.longTermElite === true;
    const minClosedPositions = Math.max(1, finite(this.config.pnlMinClosedPositions, 1));
    const minRealizedSol = Math.max(0, finite(this.config.pnlMinRealizedSol, 0));
    const minCapitalReturnPct = Math.max(
      0,
      finite(this.config.pnlMinCapitalReturnPct, 0),
    );
    let eligible = true;
    let status = 'PNL_BYPASS';
    let eligibilityClass = 'BYPASS';
    if (longTermElite) {
      status = 'PNL_ELITE_60D';
      eligibilityClass = 'LONG_TERM_ELITE';
    } else if (this.config.pnlGateEnabled !== false) {
      if (window24h.closedPositions < minClosedPositions) {
        eligible = false;
        status = 'PNL_PENDING';
        eligibilityClass = 'PENDING';
      } else if (window24h.realizedPnlSol > minRealizedSol
        && window24h.capitalReturnPct > minCapitalReturnPct) {
        status = 'PNL_PROFITABLE';
        eligibilityClass = 'ACTIVE_24H';
      } else {
        eligible = false;
        status = 'LOSS_BLOCKED';
        eligibilityClass = 'BLOCKED';
      }
    }
    const history = row?.history_status ? {
      status: row.history_status,
      window_start_at: nullableFinite(row.history_window_start_at),
      window_end_at: nullableFinite(row.history_window_end_at),
      ledger_complete: finite(row.history_ledger_complete, 0),
      orphan_events: finite(row.history_orphan_events, 0),
      completed_at: nullableFinite(row.history_completed_at),
      pages_fetched: finite(row.history_pages_fetched, 0),
      credits_spent: finite(row.history_credits_spent, 0),
      last_error: row.history_last_error || null,
    } : null;
    return {
      status,
      eligible,
      eligibilityClass,
      eliteQualified: longTermElite,
      historyComplete: metrics.historyBackfillComplete === true
        || (history?.status === 'COMPLETE' && Boolean(history.ledger_complete)),
      history,
      window24h,
      window7d: metrics.actualPnl7d || emptyWindow(),
      window30d: metrics.actualPnl30d || emptyWindow(),
      window60d: metrics.actualPnl60d || emptyWindow(),
      openPositions: finite(metrics.actualOpenPositions, 0),
      openCostSol: finite(metrics.actualOpenCostSol, 0),
    };
  }

  _snapshotFromGradeRow(row, at, generatedAt, expiresAt) {
    const pnl = this._pnlSnapshotFromGradeRow(row);
    const ageEligible = this._ageEligibleRow(row, at);
    const clusterKnown = Boolean(row.cluster_id && row.cluster_confidence !== 'UNKNOWN');
    const snapshot = {
      wallet: row.wallet,
      status: row.status,
      selectionGrade: row.selection_grade,
      copyGrade: row.copy_grade,
      holdingGrade: row.holding_grade,
      source: row.source,
      selectionWeight: gradeWeight(row.selection_grade),
      copyWeight: copyWeight(row.copy_grade),
      clusterId: row.cluster_id || row.wallet,
      clusterKnown,
      clusterConfidence: row.cluster_confidence || 'UNKNOWN',
      ageStatus: row.age_status || 'UNKNOWN',
      firstChainActivityAt: nullableFinite(row.first_chain_activity_at),
      ageVerifiedAt: nullableFinite(row.age_verified_at),
      ageEligible,
      pnlStatus: pnl.status,
      pnlEligible: pnl.eligible,
      pnlEligibilityClass: pnl.eligibilityClass,
      longTermElite: pnl.eliteQualified,
      voteWeight: pnl.eliteQualified
        ? 1 : (row.status === 'PROBATION' ? null : gradeWeight(row.selection_grade)),
      actualPnl24h: pnl.window24h,
      actualPnl7d: pnl.window7d,
      actualPnl30d: pnl.window30d,
      actualPnl60d: pnl.window60d,
      historyBackfill: pnl.history,
      historyComplete: pnl.historyComplete,
      actualOpenPositions: pnl.openPositions,
      actualOpenCostSol: pnl.openCostSol,
      registryVersion: row.registry_version,
      effectiveFrom: row.effective_from,
      discoveredAt: row.discovered_at,
      lastSeenAt: nullableFinite(row.last_seen_at),
      snapshotGeneratedAt: generatedAt,
      snapshotExpiresAt: expiresAt,
      votingEligible: false,
    };
    const votingEligible = row.effective_from <= at && row.risk_status === 'OK'
      && ['PROBATION', 'ACTIVE'].includes(row.status)
      && ageEligible && pnl.eligible
      && (row.source === 'CONFIG_SEED' || (
        (pnl.eliteQualified || this.config.autoVoteRequiresActive === false
          || row.status === 'ACTIVE')
        && (this.config.autoVoteRequiresKnownCluster === false || clusterKnown)
      ));
    return votingEligible ? { ...snapshot, votingEligible: true } : snapshot;
  }

  _refreshWalletEligibilitySnapshot(at = this.now(), { force = false } = {}) {
    const current = this.walletEligibilitySnapshot;
    // A dirty registry is allowed to remain eventually consistent until the
    // configured refresh boundary. Live trade handling must never turn a
    // discovery/age update into an immediate full registry read.
    if (!force && current.generatedAt > 0 && at < current.expiresAt) return false;
    const startedAt = this.now();
    try {
      const expiresAt = at + this._votingSnapshotRefreshMs();
      const rows = this.store.db.prepare(`
        SELECT r.*, c.cluster_id, c.confidence cluster_confidence,
          h.status history_status, h.window_start_at history_window_start_at,
          h.window_end_at history_window_end_at,
          h.ledger_complete history_ledger_complete,
          h.orphan_events history_orphan_events,
          h.completed_at history_completed_at,
          h.pages_fetched history_pages_fetched,
          h.credits_spent history_credits_spent,
          h.last_error history_last_error,
          p.closed_positions pnl_24h_closed_positions,
          p.invested_sol pnl_24h_invested_sol,
          p.realized_sol pnl_24mp_ms, event.id
    `).all(at - lookbackMs, at);

    // Keep only the first observed OPEN per wallet/Mint. Repeated ADD behavior is
    // deliberately excluded so a pyramiding style cannot create a false identity link.
    const firstOpenByWalletMint = new Map();
    for (const event of events) {
      const registry = registryByWallet.get(event.wallet);
      if (!registry || event.timestamp_ms < registry.discovered_at) continue;
      const key = `${event.wallet}\u0000${event.mint}`;
      if (!firstOpenByWalletMint.has(key)) firstOpenByWalletMint.set(key, event);
    }
    const mintsByWallet = new Map(registryRows.map((row) => [row.wallet, new Set()]));
    const eventsByMint = new Map();
    for (const event of firstOpenByWalletMint.values()) {
      mintsByWallet.get(event.wallet)?.add(event.mint);
      const bucket = eventsByMint.get(event.mint) || [];
      bucket.push(event);
      eventsByMint.set(event.mint, bucket);
    }

    const parent = new Map(registryRows.map((row) => [row.wallet, row.wallet]));
    const find = (wallet) => {
      let root = parent.get(wallet) || wallet;
      while (parent.get(root) && parent.get(root) !== root) root = parent.get(root);
      let cursor = wallet;
      while (parent.get(cursor) && parent.get(cursor) !== root) {
        const next = parent.get(cursor);
        parent.set(cursor, root);
        cursor = next;
      }
      return root;
    };
    const unite = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot) return;
      const [first, second] = [leftRoot, rightRoot].sort();
      parent.set(second, first);
    };
    const memberships = this.store.db.prepare(`
      SELECT * FROM smart_wallet_cluster_memberships
      WHERE valid_from<=? AND (valid_to IS NULL OR valid_to>?)
        AND confidence='CONFIRMED'
    `).all(at, at);
    const membershipByWallet = new Map(memberships.map((row) => [row.wallet, row]));
    const membersByExistingCluster = new Map();
    for (const membership of memberships) {
      if (!registryByWallet.has(membership.wallet)) continue;
      const bucket = membersByExistingCluster.get(membership.cluster_id) || [];
      bucket.push(membership.wallet);
      membersByExistingCluster.set(membership.cluster_id, bucket);
    }
    // Existing multi-wallet relationships are sticky. Automatic refreshes may
    // merge a cluster but never split a previously confirmed related cluster.
    for (const members of membersByExistingCluster.values()) {
      if (members.length < 2) continue;
      for (let index = 1; index < members.length; index += 1) {
        unite(members[0], members[index]);
      }
    }
    const priorEvaluations = this.store.db.prepare(`
      SELECT wallet, reason_json FROM smart_wallet_cluster_evaluations
      WHERE status<>'CONFIG_SEED'
    `).all();
    for (const evaluation of priorEvaluations) {
      const reason = parseJson(evaluation.reason_json, {});
      if (reason.kind !== 'AUTO_RELATED' || !Array.isArray(reason.componentWallets)) continue;
      const members = reason.componentWallets.filter((wallet) => registryByWallet.has(wallet));
      for (let index = 1; index < members.length; index += 1) {
        unite(members[0], members[index]);
      }
    }

    const pairStats = new Map();
    const pairKey = (left, right) => [left, right].sort().join('\u0000');
    for (const mintEvents of eventsByMint.values()) {
      for (let leftIndex = 0; leftIndex < mintEvents.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < mintEvents.length; rightIndex += 1) {
          const left = mintEvents[leftIndex];
          const right = mintEvents[rightIndex];
          if (left.wallet === right.wallet) continue;
          const key = pairKey(left.wallet, right.wallet);
          const stats = pairStats.get(key) || { sharedMints: 0, synchronizedMints: 0 };
          stats.sharedMints += 1;
          const timeSynchronized = Math.abs(left.timestamp_ms - right.timestamp_ms)
            <= syncWindowMs;
          const maxAmount = Math.max(
            Math.abs(finite(left.sol_amount, 0)),
            Math.abs(finite(right.sol_amount, 0)),
          );
          const amountDifferencePct = maxAmount > 0
            ? Math.abs(left.sol_amount - right.sol_amount) / maxAmount * 100
            : Infinity;
          if (timeSynchronized && amountDifferencePct <= amountTolerancePct) {
            stats.synchronizedMints += 1;
          }
          pairStats.set(key, stats);
        }
      }
    }
    const linkedPairs = [];
    for (const [key, stats] of pairStats) {
      const [left, right] = key.split('\u0000');
      const leftMints = mintsByWallet.get(left)?.size || 0;
      const rightMints = mintsByWallet.get(right)?.size || 0;
      const comparableMints = Math.max(1, Math.min(leftMints, rightMints));
      const correlationPct = stats.synchronizedMints / comparableMints * 100;
      if (stats.synchronizedMints < minCorrelatedMints
        || correlationPct < minCorrelationPct) continue;
      unite(left, right);
      linkedPairs.push({
        left, right,
        sharedMints: stats.sharedMints,
        synchronizedMints: stats.synchronizedMints,
        correlationPct,
      });
    }

    const components = new Map();
    for (const row of registryRows) {
      const root = find(row.wallet);
      const bucket = components.get(root) || [];
      bucket.push(row.wallet);
      components.set(root, bucket);
    }
    const clusterIdByRoot = new Map();
    for (const [root, members] of components) {
      const configuredSeeds = members
        .filter((wallet) => registryByWallet.get(wallet)?.source === 'CONFIG_SEED')
        .sort();
      const reusableIds = members.map((wallet) => membershipByWallet.get(wallet))
        .filter(Boolean)
        .filter((membership) => (
          (membersByExistingCluster.get(membership.cluster_id)?.length || 0) > 1
          || membership.cluster_id !== membership.wallet
        ))
        .map((membership) => membership.cluster_id)
        .sort();
      let clusterId;
      if (reusableIds.length) clusterId = reusableIds[0];
      else if (configuredSeeds.length) {
        clusterId = membershipByWallet.get(configuredSeeds[0])?.cluster_id
          || configuredSeeds[0];
      } else if (members.length > 1) {
        const digest = crypto.createHash('sha256').update([...members].sort().join('|'))
          .digest('hex').slice(0, 16);
        clusterId = `AUTO_RELATED_${digest}`;
      } else clusterId = members[0];
      clusterIdByRoot.set(root, clusterId);
    }

    const linkedByWallet = new Map();
    for (const link of linkedPairs) {
      for (const [wallet, peer] of [[link.left, link.right], [link.right, link.left]]) {
        const bucket = linkedByWallet.get(wallet) || [];
        bucket.push({ wallet: peer, ...link });
        linkedByWallet.set(wallet, bucket);
      }
    }
    const evaluations = [];
    let confirmed = 0;
    let confirmationsChanged = 0;
    for (const row of registryRows) {
      const root = find(row.wallet);
      const members = components.get(root) || [row.wallet];
      const existing = membershipByWallet.get(row.wallet);
      const distinctMints = mintsByWallet.get(row.wallet)?.size || 0;
      const eligibleAt = row.discovered_at + observationMs;
      const alreadyConfirmed = existing?.confidence === 'CONFIRMED';
      const observationComplete = at >= eligibleAt;
      const activityComplete = distinctMints >= minDistinctMints;
      const related = members.length > 1;
      const desiredClusterId = clusterIdByRoot.get(root) || row.wallet;
      let status = 'OBSERVING';
      if (alreadyConfirmed || (observationComplete && activityComplete)) {
        status = related ? 'CONFIRMED_RELATED' : 'CONFIRMED_INDEPENDENT';
      } else if (observationComplete) status = 'INSUFFICIENT_ACTIVITY';
      const reason = {
        model: 'AUTO_CLUSTER_V1',
        kind: related ? 'AUTO_RELATED' : 'AUTO_INDEPENDENT',
        observationMs,
        minDistinctMints,
        syncWindowMs,
        amountTolerancePct,
        minCorrelatedMints,
        minCorrelationPct,
        componentWallets: [...members].sort().slice(0, 25),
        directLinks: (linkedByWallet.get(row.wallet) || []).slice(0, 25),
      };
      const canConfirm = status.startsWith('CONFIRMED_');
      // Configured seeds already vote as trusted seeds, but an observed relation
      // still receives a membership so it shares one cluster vote with its peers.
      const shouldWriteMembership = canConfirm
        || (row.source === 'CONFIG_SEED' && related);
      if (shouldWriteMembership) {
        const changed = this.setCluster({
          wallet: row.wallet,
          clusterId: desiredClusterId,
          confidence: 'CONFIRMED',
          reason,
          validFrom: at,
        });
        if (changed) confirmationsChanged += 1;
        confirmed += 1;
      }
      evaluations.push({
        wallet: row.wallet,
        status: row.source === 'CONFIG_SEED' && !related ? 'CONFIG_SEED' : status,
        eligibleAt,
        distinctMints,
        correlatedWallets: Math.max(0, members.length - 1),
        clusterId: shouldWriteMembership ? desiredClusterId : null,
        reasonJson: JSON.stringify(reason),
        evaluatedAt: at,
        updatedAt: at,
      });
    }
    const writeEvaluations = this.store.db.transaction((rows) => {
      for (const row of rows) this.upsertClusterEvaluation.run(row);
    });
    writeEvaluations(evaluations);
    this.lastClusterRefreshAt = at;
    this.walletEligibilitySnapshotDirty = true;
    this.metrics.clusterRefreshes += 1;
    this.metrics.clusterConfirmations += confirmationsChanged;
    this.metrics.clusterRelatedLinks = linkedPairs.length;
    this.metrics.lastActionAt = at;
    return {
      wallets: registryRows.length,
      confirmed,
      confirmationsChanged,
      relatedLinks: linkedPairs.length,
    };
  }

  setCluster({
    wallet, clusterId, confidence = 'UNKNOWN', reason = {}, validFrom = this.now(),
  }) {
    if (!this.config.enabled || !wallet || !clusterId) return false;
    const existing = this.store.db.prepare(
      'SELECT * FROM smart_wallet_cluster_memberships WHERE wallet=?',
    ).get(wallet);
    if (existing && existing.cluster_id === clusterId
      && existing.confidence === confidence) return false;
    const now = this.now();
    const version = this._nextVersion(now);
    this.insertCluster.run({
      wallet,
      clusterId,
      confidence,
      reasonJson: JSON.stringify(reason || {}),
      validFrom,
      registryVersion: version,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });
    this.activeClusterCountsCache = null;
    this.walletEligibilitySnapshotDirty = true;
    return true;
  }

  setGrades({
    wallet, selectionGrade, copyGrade, holdingGrade = 'H_C', status = 'ACTIVE',
    reason = 'MANUAL_REVIEW', metrics = {}, effectiveAt = this.now(),
  }) {
    const current = this.store.db.prepare('SELECT * FROM smart_wallet_registry WHERE wallet=?')
      .get(wallet);
    if (!current) return false;
    const now = this.now();
    const version = this._nextVersion(now);
    this.store.db.prepare(`
      UPDATE smart_wallet_registry SET
        status=?, selection_grade=?, copy_grade=?, holding_grade=?, metrics_json=?,
        registry_version=?, updated_at=? WHERE wallet=?
    `).run(
      status, selectionGrade, copyGrade, holdingGrade, JSON.stringify(metrics || {}),
      version, now, wallet,
    );
    this.store.db.prepare(`
      INSERT INTO smart_wallet_grade_history (
        wallet, effective_at, old_status, new_status,
        old_selection_grade, new_selection_grade,
        old_copy_grade, new_copy_grade,
        old_holding_grade, new_holding_grade,
        reason, metrics_json, registry_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wallet, effectiveAt, current.status, status,
      current.selection_grade, selectionGrade, current.copy_grade, copyGrade,
      current.holding_grade, holdingGrade, reason, JSON.stringify(metrics || {}), version, now,
    );
    this.activeClusterCountsCache = null;
    this.walletEligibilitySnapshotDirty = true;
    return true;
  }

  quarantine(wallet, reason = 'RISK_REVIEW', at = this.now()) {
    const row = this.store.db.prepare('SELECT * FROM smart_wallet_registry WHERE wallet=?').get(wallet);
    if (!row) return false;
    const version = this._nextVersion(at);
    this.store.db.prepare(`
      UPDATE smart_wallet_registry SET status='QUARANTINED', risk_status=?,
        registry_version=?, updated_at=? WHERE wallet=?
    `).run(reason, version, at, wallet);
    this.activeClusterCountsCache = null;
    this.walletEligibilitySnapshotDirty = true;
    return true;
  }

  walletSnapshot(wallet, at = this.now(), observedSnapshot = null) {
    const snapshot = observedSnapshot || this.monitoringSnapshot(wallet, at);
    if (!snapshot || snapshot.effectiveFrom > at) return null;
    if (!snapshot.ageEligible) return null;
    if (!snapshot.pnlEligible) return null;
    if (snapshot.source !== 'CONFIG_SEED') {
      if (snapshot.pnlEligibilityClass !== 'LONG_TERM_ELITE'
        && this.config.autoVoteRequiresActive !== false && snapshot.status !== 'ACTIVE') return null;
      if (this.config.autoVoteRequiresKnownCluster !== false && !snapshot.clusterKnown) return null;
    }
    return { ...snapshot, votingEligible: true };
  }

  monitoringSnapshot(wallet, at = this.now()) {
    const row = this.store.db.prepare(`
      SELECT * FROM smart_wallet_registry
      WHERE wallet=? AND discovered_at<=?
    `).get(wallet, at);
    if (!row || row.status === 'QUARANTINED' || row.risk_status !== 'OK') return null;
    if (!this._ageMonitoringAllowed(row)) return null;
    const cluster = this.store.db.prepare(`
      SELECT * FROM smart_wallet_cluster_memberships
      WHERE wallet=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)
    `).get(wallet, at, at);
    const pnl = this._actualPnlSnapshot(wallet, at);
    return {
      wallet,
      status: row.status,
      selectionGrade: row.selection_grade,
      copyGrade: row.copy_grade,
      holdingGrade: row.holding_grade,
      source: row.source,
      selectionWeight: gradeWeight(row.selection_grade),
      copyWeight: copyWeight(row.copy_grade),
      clusterId: cluster?.cluster_id || wallet,
      clusterKnown: Boolean(cluster && cluster.confidence !== 'UNKNOWN'),
      clusterConfidence: cluster?.confidence || 'UNKNOWN',
      ageStatus: row.age_status || 'UNKNOWN',
      firstChainActivityAt: nullableFinite(row.first_chain_activity_at),
      ageVerifiedAt: nullableFinite(row.age_verified_at),
      ageEligible: this._ageEligibleRow(row, at),
      pnlStatus: pnl.status,
      pnlEligible: pnl.eligible,
      pnlEligibilityClass: pnl.eligibilityClass,
      longTermElite: pnl.eliteQualified,
      voteWeight: pnl.eliteQualified
        ? 1 : (row.status === 'PROBATION' ? null : gradeWeight(row.selection_grade)),
      actualPnl24h: pnl.window24h,
      actualPnl7d: pnl.window7d,
      actualPnl30d: pnl.window30d,
      actualPnl60d: pnl.window60d,
      historyBackfill: pnl.history,
      historyComplete: pnl.historyComplete,
      actualOpenPositions: pnl.openPositions,
      actualOpenCostSol: pnl.openCostSol,
      registryVersion: row.registry_version,
      effectiveFrom: row.effective_from,
      votingEligible: false,
    };
  }

  _activeClusterCountsExact(at = this.now()) {
    const rows = this.store.db.prepare(`
      SELECT r.*,
        c.cluster_id, c.confidence cluster_confidence
      FROM smart_wallet_registry r
      LEFT JOIN smart_wallet_cluster_memberships c ON c.wallet=r.wallet
        AND c.valid_from<=? AND (c.valid_to IS NULL OR c.valid_to>?)
      WHERE r.effective_from<=? AND r.status IN ('PROBATION','ACTIVE')
        AND r.risk_status='OK'
    `).all(at, at, at);
    const eligible = new Set();
    const selectionA = new Set();
    for (const row of rows) {
      if (!this._votingEligibleRow(row, at)) continue;
      const clusterId = row.cluster_id || row.wallet;
      eligible.add(clusterId);
      if (row.selection_grade === 'S_A') selectionA.add(clusterId);
    }
    return { eligible: eligible.size, selectionA: selectionA.size };
  }

  _votingEligibleFromGradeSnapshot(row, at = this.now()) {
    if (!row || row.effective_from > at || row.risk_status !== 'OK'
      || !['PROBATION', 'ACTIVE'].includes(row.status)
      || !this._ageEligibleRow(row, at)) return false;
    const metrics = parseJson(row.metrics_json, {});
    const pnlEligible = this.config.pnlGateEnabled === false
      || metrics.pnlEligible === true
      || (metrics.pnlEligible == null && row.status === 'ACTIVE');
    if (!pnlEligible) return false;
    if (row.source === 'CONFIG_SEED') return true;
    const longTermElite = metrics.longTermElite === true;
    if (!longTermElite
      && this.config.autoVoteRequiresActive !== false && row.status !== 'ACTIVE') return false;
    if (this.config.autoVoteRequiresKnownCluster !== false
      && (!row.cluster_id || row.cluster_confidence === 'UNKNOWN')) return false;
    return true;
  }

  _activeClusterCountsFromGradeSnapshots(at = this.now()) {
    const rows = this.store.db.prepare(`
      SELECT r.wallet, r.status, r.selection_grade, r.risk_status, r.source,
        r.effective_from, r.age_status, r.first_chain_activity_at, r.metrics_json,
        c.cluster_id, c.confidence cluster_confidence
      FROM smart_wallet_registry r
      LEFT JOIN smart_wallet_cluster_memberships c ON c.wallet=r.wallet
        AND c.valid_from<=? AND (c.valid_to IS NULL OR c.valid_to>?)
      WHERE r.effective_from<=? AND r.status IN ('PROBATION','ACTIVE')
        AND r.risk_status='OK'
    `).all(at, at, at);
    const eligible = new Set();
    const selectionA = new Set();
    for (const row of rows) {
      if (!this._votingEligibleFromGradeSnapshot(row, at)) continue;
      const clusterId = row.cluster_id || row.wallet;
      eligible.add(clusterId);
      if (row.selection_grade === 'S_A') selectionA.add(clusterId);
    }
    return { eligible: eligible.size, selectionA: selectionA.size };
  }

  activeClusterCounts(at = this.now()) {
    // Test/in-memory stores retain exact synchronous behavior. Production uses
    // the last completed immutable eligibility snapshot for both the pool-size
    // threshold and individual votes. Refreshing it never happens per trade.
    if (!this._maintenanceWorkerEnabled()) return this._activeClusterCountsExact(at);
    if (!this.walletEligibilitySnapshot.generatedAt) {
      this._refreshWalletEligibilitySnapshot(at, { force: true });
    }
    return { ...this.walletEligibilitySnapshot.clusterCounts };
  }

  trackedWallets(at = this.now()) {
    if (this._maintenanceWorkerEnabled()) {
      if (!this.walletEligibilitySnapshot.generatedAt) {
        this._refreshWalletEligibilitySnapshot(at, { force: true });
      }
      return [...this.walletEligibilitySnapshot.monitoring.keys()];
    }
    return this.store.db.prepare(`
      SELECT * FROM smart_wallet_registry
      WHERE discovered_at<=? AND status IN ('PROBATION','ACTIVE') AND risk_status='OK'
      ORDER BY wallet
    `).all(at).filter((row) => this._ageMonitoringAllowed(row)).map((row) => row.wallet);
  }

  votingWallets(at = this.now()) {
    if (this._maintenanceWorkerEnabled()) {
      if (!this.walletEligibilitySnapshot.generatedAt) {
        this._refreshWalletEligibilitySnapshot(at, { force: true });
      }
      return [...this.walletEligibilitySnapshot.voting.keys()];
    }
    return this.trackedWallets(at).filter((wallet) => Boolean(this.walletSnapshot(wallet, at)));
  }

  onSmartWalletEvent(event, observedSnapshot = null) {
    if (!this.config.enabled || !event?.wallet || !event?.mint) return null;
    const signalAt = finite(event.timestampMs ?? event.timestamp_ms);
    if (!(signalAt > 0)) return null;
    // Candidate wallets are labelled from discovery time, but walletSnapshot()
    // keeps them out of consensus until they are graded and clustered.
    const snapshot = observedSnapshot || this.monitoringSnapshot(event.wallet, signalAt);
    if (!snapshot) return null;
    const lastSeenWriteAt = Math.max(
      finite(this.lastSeenWrites.get(event.wallet), 0),
      finite(snapshot.lastSeenAt, 0),
    );
    if (signalAt - lastSeenWriteAt >= this._lastSeenWriteIntervalMs()) {
      this.store.db.prepare(`
        UPDATE smart_wallet_registry SET last_seen_at=?, updated_at=? WHERE wallet=?
      `).run(signalAt, this.now(), event.wallet);
      this.lastSeenWrites.set(event.wallet, signalAt);
      this.metrics.lastSeenWrites += 1;
    } else {
      this.metrics.lastSeenWritesSkipped += 1;
    }
    // Eligibility is based on the wallet's own on-chain BUY/SELL ledger. The old
    // fixed-size 30s/300s follower simulation remains readable as legacy research,
    // but no new forward labels are created here.
    return this.processActualWalletEvent(event);
  }

  onGraduated(event) {
    if (!this.config.enabled || !event?.mint) return;
    const graduatedAt = finite(event.graduated_at ?? event.graduatedAt
      ?? event.completedAt ?? event.migratedAt ?? event.timestampMs);
    if (!(graduatedAt > 0)) return;
    this.store.db.prepare(`
      UPDATE smart_wallet_forward_labels SET graduated_at=?, updated_at=?
      WHERE mint=? AND signal_at<=? AND graduated_at IS NULL
    `).run(graduatedAt, this.now(), event.mint, graduatedAt);
    for (const id of this.labelsByMint.get(event.mint) || []) {
      const label = this.labels.get(id);
      if (!label) continue;
      label.graduatedAt = graduatedAt;
      this._saveLabel(label);
    }
    if (!this.config.discoveryEnabled) return;
    const token = this.store.getToken(event.mint);
    const candidates = this.store.db.prepare(`
      SELECT wallet, MIN(timestamp_ms) first_buy_at,
        SUM(CASE WHEN side='BUY' THEN sol_amount ELSE 0 END) buy_sol,
        SUM(CASE WHEN side='SELL' THEN sol_amount ELSE 0 END) sell_sol,
        MIN(CASE WHEN side='BUY' THEN curve_pct END) first_curve_pct
      FROM raw_trades
      WHERE mint=? AND market='PUMP_BONDING_CURVE' AND timestamp_ms<=?
        AND wallet IS NOT NULL AND wallet<>''
      GROUP BY wallet
      HAVING buy_sol>=? AND buy_sol>sell_sol
      ORDER BY first_buy_at
      LIMIT ?
    `).all(
      event.mint,
      graduatedAt,
      this.config.discoveryMinBuySol,
      this.config.discoveryMaxEarlyBuyers,
    );
    for (const candidate of candidates) {
      if (candidate.wallet === token?.creator) continue;
      if (finite(candidate.first_curve_pct, 101) > this.config.discoveryMaxCurvePct) continue;
      this.nominateWallet({
        wallet: candidate.wallet,
        seedMint: event.mint,
        discoveredAt: graduatedAt,
      });
    }
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint) return;
    const ids = this.labelsByMint.get(trade.mint);
    if (!ids?.size) return;
    const timestampMs = finite(trade.timestampMs);
    const price = tradePrice(trade);
    if (!(timestampMs > 0) || !(price > 0)) return;
    for (const id of [...ids]) {
      const label = this.labels.get(id);
      if (!label || timestampMs < label.signalAt) continue;
      if (label.status === 'PENDING_ENTRY') this._tryLabelEntry(label, trade, timestampMs, price);
      if (label.status !== 'OPEN') continue;
      if (!this._comparable(label, trade, price)) continue;
      const markReturn = (price / label.entryPrice - 1) * 100;
      label.maxFavorableReturnPct = Math.max(label.maxFavorableReturnPct || 0, markReturn);
      label.maxAdverseReturnPct = Math.min(label.maxAdverseReturnPct || 0, markReturn);
      const ageMs = timestampMs - label.entryAt;
      if (label.return30sPct == null && ageMs >= this.config.copyReturnHorizonMs) {
        label.return30sPct = this._executableReturn(label, trade, price);
      }
      if (ageMs >= this.config.selectionHorizonMs) {
        label.return300sPct = this._executableReturn(label, trade, price);
        label.status = 'COMPLETE';
        label.completedAt = timestampMs;
        this.metrics.labelsCompleted += 1;
        this._saveLabel(label);
        this._removeLabel(label);
      } else this._saveLabel(label);
    }
  }

  _tryLabelEntry(label, trade, timestampMs, price) {
    if (timestampMs < label.entryTargetAt) return;
    if (timestampMs > label.entryDeadlineAt) {
      label.status = 'NO_ENTRY';
      label.rejectionReason = 'ENTRY_TIMEOUT';
      this.metrics.labelsNoEntry += 1;
      this._saveLabel(label);
      this._removeLabel(label);
      return;
    }
    if (!this._comparable(label, trade, price)) return;
    const quote = executableBuy(trade, this.config.labelPositionSol, price);
    if (!quote.available || !(quote.price > 0) || !(quote.tokenUnits > 0)) return;
    label.status = 'OPEN';
    label.entryAt = timestampMs;
    label.entryMarket = trade.market;
    label.entryPrice = quote.price;
    label.entryImpactPct = quote.impactPct;
    label.tokenUnits = quote.tokenUnits;
    label.maxFavorableReturnPct = Math.max(0, (price / quote.price - 1) * 100);
    label.maxAdverseReturnPct = Math.min(0, (price / quote.price - 1) * 100);
    const token = this.store.getToken(label.mint);
    label.graduatedAt = finite(token?.graduated_at ?? token?.graduatedAt);
    this._saveLabel(label);
  }

  _comparable(label, trade, price) {
    if (trade.market === label.signalMarket || trade.market === label.entryMarket) return true;
    const graduatedAt = label.graduatedAt
      || finite(this.store.getToken(label.mint)?.graduated_at);
    if (!(graduatedAt > 0) || trade.market !== 'PUMP_AMM' || trade.timestampMs < graduatedAt) {
      return false;
    }
    const reference = label.entryPrice || label.signalPrice;
    return Math.abs((price / reference - 1) * 100) <= this.config.maxCrossMarketJumpPct;
  }

  _executableReturn(label, trade, price) {
    const markReturnPct = (price / label.entryPrice - 1) * 100;
    const quote = executableSell(trade, label.tokenUnits, price, { rugMarkReturnPct: markReturnPct });
    if (!quote.available && !quote.conservative) return null;
    const proceeds = finite(quote.proceedsSol, finite(quote.price, 0) * label.tokenUnits);
    const gross = (proceeds / this.config.labelPositionSol - 1) * 100;
    return gross - label.configuredCostPct;
  }

  _hydrateLabel(row) {
    const label = {
      id: row.id,
      smartEventId: row.smart_event_id,
      wallet: row.wallet,
      mint: row.mint,
      status: row.status,
      signalAt: row.signal_at,
      signalMarket: row.signal_market,
      signalPrice: row.signal_price,
      entryTargetAt: row.entry_target_at,
      entryDeadlineAt: row.entry_deadline_at,
      entryAt: row.entry_at,
      entryMarket: row.entry_market,
      entryPrice: row.entry_price,
      entryImpactPct: row.entry_impact_pct,
      tokenUnits: row.token_units,
      return30sPct: row.return_30s_pct,
      return300sPct: row.return_300s_pct,
      maxFavorableReturnPct: row.max_favorable_return_pct,
      maxAdverseReturnPct: row.max_adverse_return_pct,
      graduatedAt: row.graduated_at,
      seedExcluded: row.seed_excluded,
      configuredCostPct: row.configured_cost_pct,
      completedAt: row.completed_at,
      rejectionReason: row.rejection_reason,
    };
    this.labels.set(label.id, label);
    const bucket = this.labelsByMint.get(label.mint) || new Set();
    bucket.add(label.id);
    this.labelsByMint.set(label.mint, bucket);
    return label;
  }

  _saveLabel(label) {
    this.updateLabel.run({
      id: label.id,
      status: label.status,
      entryAt: label.entryAt ?? null,
      entryMarket: label.entryMarket ?? null,
      entryPrice: label.entryPrice ?? null,
      entryImpactPct: label.entryImpactPct ?? null,
      tokenUnits: label.tokenUnits ?? null,
      return30sPct: label.return30sPct ?? null,
      return300sPct: label.return300sPct ?? null,
      maxFavorableReturnPct: label.maxFavorableReturnPct ?? null,
      maxAdverseReturnPct: label.maxAdverseReturnPct ?? null,
      graduatedAt: label.graduatedAt ?? null,
      completedAt: label.completedAt ?? null,
      rejectionReason: label.rejectionReason ?? null,
      updatedAt: this.now(),
    });
  }

  _removeLabel(label) {
    this.labels.delete(label.id);
    const bucket = this.labelsByMint.get(label.mint);
    bucket?.delete(label.id);
    if (bucket && !bucket.size) this.labelsByMint.delete(label.mint);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    this._refreshWalletEligibilitySnapshot(now);
    this._advanceActualEventBackfill(now);
    for (const label of [...this.labels.values()]) {
      if (label.status === 'PENDING_ENTRY' && now > label.entryDeadlineAt) {
        label.status = 'NO_ENTRY';
        label.rejectionReason = 'ENTRY_TIMEOUT';
        this.metrics.labelsNoEntry += 1;
        this._saveLabel(label);
        this._removeLabel(label);
      } else if (label.status === 'OPEN'
        && now > label.entryAt + this.config.selectionHorizonMs + this.config.labelGraceMs) {
        label.status = 'NO_EXIT';
        label.return300sPct = finite(this.config.noExitReturnPct, -100);
        label.rejectionReason = 'NO_COMPARABLE_300S_QUOTE';
        label.completedAt = now;
        this.metrics.labelsNoExit += 1;
        this._saveLabel(label);
        this._removeLabel(label);
      }
    }
    this._scheduleAgeChecks(now);
    this._scheduleHistoryBackfills(now);
    this._scheduleClusterMaintenance(now);
    this._scheduleGradeMaintenance(now);
  }

  refreshGrades(now = this.now(), { forceModelMigration = false } = {}) {
    if (!this.config.enabled) return;
    const cutoff = now - this.config.lookbackMs;
    const rows = this.store.db.prepare(`
      SELECT * FROM smart_wallet_actual_positions
      WHERE status='CLOSED' AND closed_at>=? AND closed_at<=?
      ORDER BY wallet, closed_at, id
    `).all(cutoff, now);
    const grouped = new Map();
    for (const row of rows) {
      const bucket = grouped.get(row.wallet) || [];
      bucket.push(row);
      grouped.set(row.wallet, bucket);
    }
    const wallets = this.store.db.prepare('SELECT * FROM smart_wallet_registry').all();
    for (const current of wallets) {
      if (current.status === 'QUARANTINED') continue;
      const pnl = this._actualPnlSnapshot(current.wallet, now);
      const sample = (grouped.get(current.wallet) || [])
        .filter((row) => row.closed_at >= now - 30 * DAY_MS);
      const returns = sample.map((row) => finite(row.realized_return_pct))
        .filter(Number.isFinite);
      const pnlValues = sample.map((row) => finite(row.realized_pnl_sol, 0));
      const activeDays = pnl.window30d.activeDays;
      const positiveWindowPct = pnl.window30d.positiveDayPct ?? 0;
      const averageReturnPct = average(returns);
      const medianReturnPct = median(returns);
      const pf = profitFactor(pnlValues);
      const top1Pct = topProfitContribution(pnlValues);
      const profitable30d = pnl.window30d.realizedPnlSol > 0
        && pnl.window30d.capitalReturnPct > 0;
      let selectionGrade = 'S_C';
      if (sample.length >= this.config.selectionMinSamples
        && activeDays >= this.config.minActiveDays
        && profitable30d
        && (pf == null || pf >= this.config.minCopyPf)
        && positiveWindowPct >= this.config.minPositiveWindowPct
        && (top1Pct == null || top1Pct <= this.config.maxTop1ProfitPct)) {
        selectionGrade = 'S_A';
      }
      else if (sample.length >= Math.ceil(this.config.selectionMinSamples / 2)
        && profitable30d && (pf == null || pf >= 1)) selectionGrade = 'S_B';
      let copyGrade = 'C_C';
      if (returns.length >= this.config.copyMinSamples
        && activeDays >= this.config.minActiveDays
        && profitable30d && averageReturnPct > 0 && medianReturnPct > 0
        && (pf == null || pf >= this.config.minCopyPf)
        && positiveWindowPct >= this.config.minPositiveWindowPct
        && (top1Pct == null || top1Pct <= this.config.maxTop1ProfitPct)) copyGrade = 'C_A';
      else if (returns.length >= Math.ceil(this.config.copyMinSamples / 2)
        && profitable30d && averageReturnPct > 0
        && (pf == null || pf >= 1)) copyGrade = 'C_B';
      const bigWinnerRate = sample.length
        ? sample.filter((row) => finite(row.realized_return_pct, -Infinity)
          >= this.config.holdingBigWinnerPct).length / sample.length * 100
        : 0;
      let holdingGrade = 'H_C';
      if (sample.length >= this.config.holdingMinSamples
        && profitable30d
        && bigWinnerRate >= this.config.holdingMinBigWinnerRatePct) holdingGrade = 'H_A';
      else if (sample.length >= Math.ceil(this.config.holdingMinSamples / 2)
        && profitable30d && bigWinnerRate > 0) holdingGrade = 'H_B';
      const ageEligible = this._ageEligibleRow(current, now);
      const performanceQualified = pnl.eliteQualified
        || selectionGrade !== 'S_C' || copyGrade !== 'C_C';
      const desiredStatus = performanceQualified && ageEligible && pnl.eligible
        ? 'ACTIVE' : 'PROBATION';
      const metrics = {
        sampleSize: sample.length,
        activeDays,
        actualAverageReturnPct: averageReturnPct,
        actualMedianReturnPct: medianReturnPct,
        actualProfitFactor: pf,
        top1ProfitContributionPct: top1Pct,
        positiveWindowPct,
        bigWinnerRatePct: bigWinnerRate,
        pnlStatus: pnl.status,
        pnlEligible: pnl.eligible,
        pnlEligibilityClass: pnl.eligibilityClass,
        longTermElite: pnl.eliteQualified,
        actualPnl24h: pnl.window24h,
        actualPnl7d: pnl.window7d,
        actualPnl30d: pnl.window30d,
        actualPnl60d: pnl.window60d,
        historyBackfillComplete: pnl.historyComplete,
        actualOpenPositions: pnl.openPositions,
        actualOpenCostSol: pnl.openCostSol,
        ageStatus: current.age_status || 'UNKNOWN',
        ageEligible,
      };
      const prior = parseJson(current.metrics_json, {});
      const sameCandidate = prior.candidateGrades?.selectionGrade === selectionGrade
        && prior.candidateGrades?.copyGrade === copyGrade
        && prior.candidateGrades?.holdingGrade === holdingGrade
        && prior.candidateGrades?.status === desiredStatus;
      const candidateStreak = sameCandidate ? finite(prior.candidateStreak, 0) + 1 : 1;
      const nextMetrics = {
        ...metrics,
        candidateGrades: {
          selectionGrade, copyGrade, holdingGrade, status: desiredStatus,
        },
        candidateStreak,
      };
      const changed = current.selection_grade !== selectionGrade
        || current.copy_grade !== copyGrade || current.holding_grade !== holdingGrade
        || current.status !== desiredStatus;
      if (changed && (forceModelMigration
        || candidateStreak >= this.config.gradeConfirmationRuns)) {
        this.setGrades({
          wallet: current.wallet,
          selectionGrade,
          copyGrade,
          holdingGrade,
          status: desiredStatus,
          reason: forceModelMigration
            ? 'ACTUAL_WALLET_PNL_MODEL_MIGRATION' : 'ROLLING_ACTUAL_WALLET_PNL',
          metrics: nextMetrics,
          effectiveAt: now,
        });
      } else {
        this.store.db.prepare(`
          UPDATE smart_wallet_registry SET metrics_json=?, updated_at=? WHERE wallet=?
        `).run(JSON.stringify(nextMetrics), now, current.wallet);
      }
    }
    this.store.db.prepare(`
      UPDATE smart_wallet_registry_meta SET last_grade_refresh_at=?, updated_at=? WHERE id=1
    `).run(now, now);
    this.walletEligibilitySnapshotDirty = true;
    this.metrics.gradeRefreshes += 1;
    this.metrics.lastGradeRefreshAt = now;
  }

  dashboard(limit = 100) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    const observedAt = this.now();
    // The dashboard is allowed to display the last completed snapshot until its
    // refresh boundary. A newly discovered wallet must not turn every polling
    // request into a full rolling-PnL aggregation.
    this._refreshWalletEligibilitySnapshot(observedAt, {
      force: !this._maintenanceWorkerEnabled() && this.walletEligibilitySnapshotDirty,
    });
    const wallets = this.store.db.prepare(`
      SELECT r.*,
        c.cluster_id, c.confidence cluster_confidence,
        c.reason_json cluster_reason_json, c.valid_from cluster_valid_from,
        e.status cluster_evaluation_status, e.eligible_at cluster_eligible_at,
        e.distinct_mints cluster_distinct_mints,
        e.correlated_wallets cluster_correlated_wallets,
        e.reason_json cluster_evaluation_reason_json,
        e.evaluated_at cluster_evaluated_at
      FROM smart_wallet_registry r
      LEFT JOIN smart_wallet_cluster_memberships c ON c.wallet=r.wallet
        AND c.valid_from<=? AND (c.valid_to IS NULL OR c.valid_to>?)
      LEFT JOIN smart_wallet_cluster_evaluations e ON e.wallet=r.wallet
      ORDER BY r.status, r.selection_grade, r.copy_grade, r.wallet
      LIMIT ?
    `).all(observedAt, observedAt, capped).map((row) => {
      const cached = this.walletEligibilitySnapshot.all.get(row.wallet)
        || this._snapshotFromGradeRow(
          row,
          observedAt,
          this.walletEligibilitySnapshot.generatedAt || observedAt,
          this.walletEligibilitySnapshot.expiresAt || observedAt,
        );
      return {
        ...row,
        age_ms: nullableFinite(row.first_chain_activity_at) == null
          ? null : Math.max(0, observedAt - Number(row.first_chain_activity_at)),
        age_eligible: this._ageEligibleRow(row, observedAt) ? 1 : 0,
        pnl_status: cached.pnlStatus,
        pnl_eligible: cached.pnlEligible ? 1 : 0,
        pnl_eligibility_class: cached.pnlEligibilityClass,
        long_term_elite: cached.longTermElite ? 1 : 0,
        pnl_24h_realized_sol: cached.actualPnl24h.realizedPnlSol,
        pnl_24h_return_pct: cached.actualPnl24h.capitalReturnPct,
        pnl_24h_closed_positions: cached.actualPnl24h.closedPositions,
        pnl_7d_realized_sol: cached.actualPnl7d.realizedPnlSol,
        pnl_30d_realized_sol: cached.actualPnl30d.realizedPnlSol,
        pnl_60d_realized_sol: cached.actualPnl60d.realizedPnlSol,
        pnl_60d_closed_positions: cached.actualPnl60d.closedPositions,
        history_backfill_status: cached.historyBackfill?.status || 'NOT_QUEUED',
        history_backfill_complete: cached.historyComplete ? 1 : 0,
        history_backfill_pages: cached.historyBackfill?.pages_fetched || 0,
        history_backfill_credits: cached.historyBackfill?.credits_spent || 0,
        history_backfill_error: cached.historyBackfill?.last_error || null,
        actual_open_positions: cached.actualOpenPositions,
        actual_open_cost_sol: cached.actualOpenCostSol,
        voting_eligible: cached.votingEligible ? 1 : 0,
      };
    });
    return {
      enabled: this.config.enabled,
      mode: 'SMART_WALLET_ROLLING_REGISTRY',
      observerOnly: true,
      sendsTransactions: false,
      observedAt,
      registryVersion: this.walletEligibilitySnapshot.registryVersion,
      agePolicy: {
        enabled: this.config.ageCheckEnabled !== false,
        hardRejectMs: this._ageHardRejectMs(),
        minVoteMs: this._ageMinVoteMs(),
        seedBypass: this.config.ageSeedBypass === true,
        eventMonitoringRequiresResolvedAge:
          this.config.eventMonitoringRequiresResolvedAge !== false,
        failClosed: true,
      },
      pnlPolicy: {
        enabled: this.config.pnlGateEnabled !== false,
        windowMs: Math.max(DAY_MS, finite(this.config.pnlWindowMs, DAY_MS)),
        minClosedPositions: Math.max(1, finite(this.config.pnlMinClosedPositions, 1)),
        minRealizedSol: Math.max(0, finite(this.config.pnlMinRealizedSol, 0)),
        minCapitalReturnPct: Math.max(
          0, finite(this.config.pnlMinCapitalReturnPct, 0),
        ),
        realizedOnly: true,
        openPositionsAreNoExit: false,
        elite60d: {
          enabled: this.config.elite60dEnabled === true,
          windowMs: Math.max(
            7 * DAY_MS, finite(this.config.elite60dWindowMs, 60 * DAY_MS),
          ),
          minRealizedSolExclusive: Math.max(
            0, finite(this.config.elite60dMinRealizedSol, 200),
          ),
          ignores24hLoss: true,
          realizedOnly: true,
          requiresCompleteHistory: true,
        },
      },
      historyBackfillPolicy: {
        enabled: this.config.historyBackfillEnabled === true,
        rpcConfigured: Boolean(this.config.historyRpcUrl),
        initialAllEnabled: this.config.historyInitialAllEnabled !== false,
        dailyWalletLimit: Math.max(1, finite(this.config.historyDailyWalletLimit, 50)),
        dailyCreditLimit: Math.max(
          1_000, finite(this.config.historyDailyCreditLimit, 250_000),
        ),
        windowMs: Math.max(
          7 * DAY_MS, finite(this.config.historyWindowMs, 60 * DAY_MS),
        ),
        warmupMs: Math.max(0, finite(this.config.historyWarmupMs, 30 * DAY_MS)),
      },
      clusterPolicy: {
        enabled: this.config.clusterAutoEnabled !== false,
        observationMs: this._clusterObservationMs(),
        refreshMs: this._clusterRefreshMs(),
        lookbackMs: Math.max(
          this._clusterObservationMs(),
          finite(this.config.clusterLookbackMs, 7 * DAY_MS),
        ),
        minDistinctMints: Math.max(
          1, finite(this.config.clusterMinDistinctMints, 3),
        ),
        syncWindowMs: Math.max(0, finite(this.config.clusterSyncWindowMs, 5_000)),
        amountTolerancePct: Math.max(
          0, finite(this.config.clusterAmountTolerancePct, 15),
        ),
        minCorrelatedMints: Math.max(
          1, finite(this.config.clusterMinCorrelatedMints, 2),
        ),
        minCorrelationPct: Math.max(
          0, finite(this.config.clusterMinCorrelationPct, 50),
        ),
        stickyRelationships: true,
      },
      clusterCounts: this.activeClusterCounts(),
      sourceCounts: Object.fromEntries(this.store.db.prepare(`
        SELECT source, COUNT(*) count
        FROM smart_wallet_registry
        GROUP BY source
        ORDER BY source
      `).all().map((row) => [row.source, row.count])),
      wallets,
      walletLimit: capped,
      recentGradeChanges: this.store.db.prepare(`
        SELECT * FROM smart_wallet_grade_history ORDER BY effective_at DESC, id DESC LIMIT ?
      `).all(capped),
      recentActualPositions: this.store.db.prepare(`
        SELECT * FROM smart_wallet_actual_positions
        ORDER BY COALESCE(closed_at, opened_at) DESC, id DESC LIMIT ?
      `).all(capped),
      historyBackfills: this.store.db.prepare(`
        SELECT * FROM smart_wallet_history_backfills
        ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'FAILED' THEN 1
          WHEN 'PENDING' THEN 2 WHEN 'PAUSED' THEN 3 ELSE 4 END,
          updated_at DESC, wallet LIMIT ?
      `).all(capped),
      legacyForwardLabels: this.store.db.prepare(`
        SELECT * FROM smart_wallet_forward_labels ORDER BY signal_at DESC, id DESC LIMIT ?
      `).all(capped),
      // Compatibility alias for old dashboard clients. These rows are legacy
      // research only and no longer participate in eligibility or grading.
      recentLabels: this.store.db.prepare(`
        SELECT * FROM smart_wallet_forward_labels ORDER BY signal_at DESC, id DESC LIMIT ?
      `).all(capped),
      health: this.health(),
    };
  }

  maintenanceHealth() {
    const snapshot = this.walletEligibilitySnapshot;
    return {
      enabled: this.config.enabled,
      workerEnabled: this._maintenanceWorkerEnabled(),
      inFlight: this.maintenanceWorker?.task?.type || null,
      queued: this.maintenanceQueue.map((task) => task.type),
      pendingTypes: [...this.maintenancePendingTypes],
      gradeRefreshRequested: this.gradeRefreshRequested,
      clusterCountMode: this._maintenanceWorkerEnabled()
        ? 'MEMORY_VOTING_SNAPSHOT' : 'EXACT_INLINE',
      clusterCountCacheMs: this._clusterCountCacheMs(),
      clusterCountCached: snapshot.generatedAt > 0,
      eligibilitySnapshotRefreshMs: this._votingSnapshotRefreshMs(),
      eligibilitySnapshotGeneratedAt: snapshot.generatedAt || null,
      eligibilitySnapshotExpiresAt: snapshot.expiresAt || null,
      eligibilitySnapshotDirty: this.walletEligibilitySnapshotDirty,
      eligibilitySnapshotWallets: snapshot.all.size,
      eligibilitySnapshotMonitored: snapshot.monitoring.size,
      eligibilitySnapshotVoting: snapshot.voting.size,
      eventMonitoringRequiresResolvedAge:
        this.config.eventMonitoringRequiresResolvedAge !== false,
      actualEventBackfillPending: this.actualEventBackfillPending,
      actualEventBackfillBatchSize: Math.max(
        10,
        Math.trunc(finite(this.config.actualEventBackfillBatchSize, 250)),
      ),
      actualEventBackfillIntervalMs: Math.max(
        1_000,
        finite(this.config.actualEventBackfillIntervalMs, 5_000),
      ),
      lastClusterRefreshAt: this.lastClusterRefreshAt || null,
      lastGradeMaintenanceRequestedAt: this.lastGradeMaintenanceRequestedAt || null,
      maintenanceRunsStarted: this.metrics.maintenanceRunsStarted,
      maintenanceRunsCompleted: this.metrics.maintenanceRunsCompleted,
      maintenanceRunsFailed: this.metrics.maintenanceRunsFailed,
      maintenanceTimeouts: this.metrics.maintenanceTimeouts,
      lastMaintenanceType: this.metrics.lastMaintenanceType,
      lastMaintenanceStartedAt: this.metrics.lastMaintenanceStartedAt,
      lastMaintenanceCompletedAt: this.metrics.lastMaintenanceCompletedAt,
      lastMaintenanceDurationMs: this.metrics.lastMaintenanceDurationMs,
      lastMaintenanceError: this.metrics.lastMaintenanceError,
    };
  }

  health() {
    const now = this.now();
    // Health polling must stay O(1) between scheduled snapshot refreshes even
    // while discovery and background maintenance mark the snapshot dirty.
    this._refreshWalletEligibilitySnapshot(now, {
      force: !this._maintenanceWorkerEnabled() && this.walletEligibilitySnapshotDirty,
    });
    const eligibility = this.walletEligibilitySnapshot;
    const pnlCounts = eligibility.pnlCounts;
    const ageCounts = eligibility.ageCounts;
    const statusCounts = eligibility.statusCounts;
    const clusterEvaluationCounts = Object.fromEntries(this.store.db.prepare(`
      SELECT status, COUNT(*) count
      FROM smart_wallet_cluster_evaluations
      GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    const historyCounts = Object.fromEntries(this.store.db.prepare(`
      SELECT status, COUNT(*) count FROM smart_wallet_history_backfills GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    const historyTotals = this.store.db.prepare(`
      SELECT COALESCE(SUM(pages_fetched), 0) pages,
        COALESCE(SUM(credits_spent), 0) credits,
        COALESCE(SUM(transactions_seen), 0) transactions,
        COALESCE(SUM(inserted_events), 0) events
      FROM smart_wallet_history_backfills
    `).get();
    const historyDaily = this._historyDailyUsage(now);
    return {
      enabled: this.config.enabled,
      mode: 'SMART_WALLET_ROLLING_REGISTRY',
      observerOnly: true,
      sendsTransactions: false,
      maintenanceWorkerEnabled: this._maintenanceWorkerEnabled(),
      maintenanceInFlight: this.maintenanceWorker?.task?.type || null,
      maintenanceQueued: this.maintenanceQueue.map((task) => task.type),
      maintenancePendingTypes: [...this.maintenancePendingTypes],
      clusterCountMode: this._maintenanceWorkerEnabled()
        ? 'MEMORY_VOTING_SNAPSHOT' : 'EXACT_INLINE',
      clusterCountCacheMs: this._clusterCountCacheMs(),
      eligibilitySnapshotRefreshMs: this._votingSnapshotRefreshMs(),
      eligibilitySnapshotGeneratedAt: eligibility.generatedAt || null,
      eligibilitySnapshotExpiresAt: eligibility.expiresAt || null,
      eligibilitySnapshotDirty: this.walletEligibilitySnapshotDirty,
      eventMonitoringRequiresResolvedAge:
        this.config.eventMonitoringRequiresResolvedAge !== false,
      actualEventBackfillPending: this.actualEventBackfillPending,
      actualEventBackfillBatchSize: Math.max(
        10,
        Math.trunc(finite(this.config.actualEventBackfillBatchSize, 250)),
      ),
      actualEventBackfillIntervalMs: Math.max(
        1_000,
        finite(this.config.actualEventBackfillIntervalMs, 5_000),
      ),
      registryVersion: eligibility.registryVersion,
      wallets: eligibility.all.size,
      active: statusCounts.ACTIVE || 0,
      probation: statusCounts.PROBATION || 0,
      quarantined: statusCounts.QUARANTINED || 0,
      pendingLabels: this.labels.size,
      pendingLegacyLabels: this.labels.size,
      pnlProfitable: pnlCounts.PNL_PROFITABLE || 0,
      pnlElite60d: pnlCounts.PNL_ELITE_60D || 0,
      pnlLossBlocked: pnlCounts.LOSS_BLOCKED || 0,
      pnlPending: pnlCounts.PNL_PENDING || 0,
      pnlBypassed: pnlCounts.PNL_BYPASS || 0,
      ageEligible: ageCounts.ELIGIBLE || 0,
      ageTooNew: ageCounts.TOO_NEW || 0,
      ageProbation: ageCounts.PROBATION || 0,
      ageUnknown: (ageCounts.UNKNOWN || 0) + (ageCounts.PENDING || 0),
      ageBypassed: ageCounts.BYPASSED || 0,
      ageChecksInFlight: this.ageChecks.size,
      clusterConfirmedIndependent:
        clusterEvaluationCounts.CONFIRMED_INDEPENDENT || 0,
      clusterConfirmedRelated: clusterEvaluationCounts.CONFIRMED_RELATED || 0,
      clusterObserving: clusterEvaluationCounts.OBSERVING || 0,
      clusterInsufficientActivity:
        clusterEvaluationCounts.INSUFFICIENT_ACTIVITY || 0,
      clusterConfiguredSeeds: clusterEvaluationCounts.CONFIG_SEED || 0,
      lastClusterRefreshAt: this.lastClusterRefreshAt || null,
      monitored: eligibility.monitoring.size,
      votingEligible: eligibility.voting.size,
      observationOnly: Math.max(0, eligibility.monitoring.size - eligibility.voting.size),
      historyBackfillEnabled: this.config.historyBackfillEnabled === true,
      historyRpcConfigured: Boolean(this.config.historyRpcUrl),
      historyInFlight: this.historyBackfills.size,
      historyPending: historyCounts.PENDING || 0,
      historyRunning: historyCounts.RUNNING || 0,
      historyPaused: historyCounts.PAUSED || 0,
      historyComplete: historyCounts.COMPLETE || 0,
      historyFailed: historyCounts.FAILED || 0,
      historyLedgerIncomplete: this.store.db.prepare(`
        SELECT COUNT(*) n FROM smart_wallet_history_backfills
        WHERE status='COMPLETE' AND ledger_complete=0
      `).get().n,
      historyPagesTotal: historyTotals.pages,
      historyCreditsTotal: historyTotals.credits,
      historyTransactionsTotal: historyTotals.transactions,
      historyEventsTotal: historyTotals.events,
      historyDailyWalletsStarted: historyDaily.wallets_started,
      historyDailyPages: historyDaily.pages_fetched,
      historyDailyCredits: historyDaily.credits_spent,
      ...this.metrics,
    };
  }
}

module.exports = {
  SmartWalletRegistry,
  gradeWeight,
  copyWeight,
};
