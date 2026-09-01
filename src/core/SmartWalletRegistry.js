'use strict';

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
  constructor({ config, store, now = () => Date.now(), fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.labelPositionSol });
    this.labels = new Map();
    this.labelsByMint = new Map();
    this.pnlSnapshotCache = new Map();
    this.ageChecks = new Map();
    this.ageAbortControllers = new Set();
    this.ageHistoryFloor = null;
    this.ageHistoryFloorCheckedAt = 0;
    this.gradeRefreshRequested = false;
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
      gradeRefreshes: 0,
      ageChecksStarted: 0,
      ageChecksCompleted: 0,
      ageChecksFailed: 0,
      lastGradeRefreshAt: null,
      lastAgeCheckAt: null,
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
    `);
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

  _backfillActualWalletEvents() {
    const rows = this.store.db.prepare(`
      SELECT event.* FROM smart_wallet_events event
      JOIN smart_wallet_registry registry ON registry.wallet=event.wallet
      LEFT JOIN smart_wallet_pnl_processed_events processed
        ON processed.smart_event_id=event.id
      WHERE processed.smart_event_id IS NULL
      ORDER BY event.timestamp_ms, event.id
    `).all();
    let processed = 0;
    for (const row of rows) {
      if (this.processActualWalletEvent(row)) processed += 1;
    }
    this.metrics.actualBackfilled += processed;
    return processed;
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
    const cacheMs = Math.max(100, finite(this.config.pnlSnapshotCacheMs, 1_000));
    const cacheBucket = Math.floor(at / cacheMs);
    const cached = this.pnlSnapshotCache.get(wallet);
    if (cached?.bucket === cacheBucket) return cached.snapshot;
    const maxLookbackMs = Math.max(
      30 * DAY_MS,
      finite(this.config.lookbackMs, 60 * DAY_MS),
      finite(this.config.pnlWindowMs, DAY_MS),
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
    const lookback = this._pnlWindowSummary(rows, at - maxLookbackMs, at);
    const minClosedPositions = Math.max(1, finite(this.config.pnlMinClosedPositions, 1));
    const minRealizedSol = Math.max(0, finite(this.config.pnlMinRealizedSol, 0));
    const minCapitalReturnPct = Math.max(0, finite(this.config.pnlMinCapitalReturnPct, 0));
    let status = 'PNL_BYPASS';
    let eligible = true;
    if (this.config.pnlGateEnabled !== false) {
      if (window24h.closedPositions < minClosedPositions) {
        status = 'PNL_PENDING';
        eligible = false;
      } else if (window24h.realizedPnlSol > minRealizedSol
        && window24h.capitalReturnPct > minCapitalReturnPct) {
        status = 'PNL_PROFITABLE';
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
      windowMs: pnlWindowMs,
      window24h,
      window7d,
      window30d,
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

  start() {
    if (!this.config.enabled) return;
    this.stopping = false;
    const now = this.now();
    for (const wallet of this.config.seedWallets || []) {
      const created = this.discoverWallet({
        wallet,
        source: 'CONFIG_SEED',
        discoveredAt: now,
        effectiveFrom: now,
      });
      if (created) this.metrics.seeded += 1;
    }
    for (const cluster of this.config.seedClusters || []) {
      for (const wallet of cluster.wallets || []) {
        this.setCluster({
          wallet,
          clusterId: cluster.id,
          confidence: 'CONFIRMED',
          reason: { source: 'CONFIG_SEED' },
          validFrom: now,
        });
      }
    }
    this._backfillActualWalletEvents();
    const active = this.store.db.prepare(`
      SELECT * FROM smart_wallet_forward_labels
      WHERE status IN ('PENDING_ENTRY','OPEN')
      ORDER BY signal_at, id
    `).all();
    for (const row of active) this._hydrateLabel(row);
    const meta = this._meta();
    const needsActualGradeMigration = Boolean(this.store.db.prepare(`
      SELECT 1 FROM smart_wallet_registry
      WHERE metrics_json NOT LIKE '%"actualPnl30d"%'
      LIMIT 1
    `).get());
    if (needsActualGradeMigration) this.refreshGrades(now, { forceModelMigration: true });
    else if (!meta.last_grade_refresh_at
      || now - meta.last_grade_refresh_at >= this.config.gradeRefreshMs) this.refreshGrades(now);
    this._scheduleAgeChecks(now);
  }

  stop() {
    this.stopping = true;
    for (const controller of this.ageAbortControllers) controller.abort();
    this.ageAbortControllers.clear();
    this.labels.clear();
    this.labelsByMint.clear();
    this.pnlSnapshotCache.clear();
    this.ageChecks.clear();
  }

  _meta() {
    return this.store.db.prepare('SELECT * FROM smart_wallet_registry_meta WHERE id=1').get();
  }

  _nextVersion(now = this.now()) {
    this.store.db.prepare(`
      UPDATE smart_wallet_registry_meta
      SET registry_version=registry_version+1, updated_at=? WHERE id=1
    `).run(now);
    return this._meta().registry_version;
  }

  version() {
    return Number(this._meta().registry_version) || 1;
  }

  _ageHardRejectMs() {
    return Math.max(0, finite(this.config.ageHardRejectMs, 7 * DAY_MS));
  }

  _ageMinVoteMs() {
    return Math.max(
      this._ageHardRejectMs(),
      finite(this.config.ageMinVoteMs, 30 * DAY_MS),
    );
  }

  _ageBypassed(row) {
    return this.config.ageCheckEnabled === false
      || (row?.source === 'CONFIG_SEED' && this.config.ageSeedBypass === true)
      || row?.age_status === 'BYPASSED';
  }

  _ageEligibleRow(row, at = this.now()) {
    if (this._ageBypassed(row)) return true;
    const firstActivityAt = nullableFinite(row?.first_chain_activity_at);
    return row?.age_status === 'ELIGIBLE'
      && firstActivityAt != null
      && firstActivityAt <= at - this._ageMinVoteMs();
  }

  _ageMonitoringAllowed(row) {
    return this._ageBypassed(row) || row?.age_status !== 'TOO_NEW';
  }

  _votingEligibleRow(row, at = this.now()) {
    if (!row || row.effective_from > at || row.risk_status !== 'OK'
      || !['PROBATION', 'ACTIVE'].includes(row.status)
      || !this._ageEligibleRow(row, at)
      || !this._pnlEligibleRow(row, at)) return false;
    if (row.source === 'CONFIG_SEED') return true;
    if (this.config.autoVoteRequiresActive !== false && row.status !== 'ACTIVE') return false;
    if (this.config.autoVoteRequiresKnownCluster !== false
      && (!row.cluster_id || row.cluster_confidence === 'UNKNOWN')) return false;
    return true;
  }

  _ageStatus(firstActivityAt, at = this.now()) {
    const ageMs = at - finite(firstActivityAt, at);
    if (ageMs < this._ageHardRejectMs()) return 'TOO_NEW';
    if (ageMs < this._ageMinVoteMs()) return 'PROBATION';
    return 'ELIGIBLE';
  }

  _localAgeEvidence(wallet, cutoffAt) {
    const row = this.store.db.prepare(`
      SELECT MIN(observed_at) first_activity_at FROM (
        SELECT MIN(timestamp_ms) observed_at FROM raw_trades WHERE wallet=?
        UNION ALL
        SELECT MIN(signal_at) observed_at FROM smart_wallet_forward_labels WHERE wallet=?
      )
    `).get(wallet, wallet);
    const firstActivityAt = nullableFinite(row?.first_activity_at);
    return firstActivityAt != null && firstActivityAt <= cutoffAt ? firstActivityAt : null;
  }

  async _ageRpc(method, params = []) {
    if (!this.config.ageRpcUrl) throw new Error('AGE_RPC_URL_MISSING');
    if (typeof this.fetchImpl !== 'function') throw new Error('AGE_FETCH_UNAVAILABLE');
    const controller = new AbortController();
    this.ageAbortControllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1_000, finite(this.config.ageRpcTimeoutMs, 10_000)),
    );
    try {
      const response = await this.fetchImpl(this.config.ageRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      if (!response?.ok) throw new Error(`AGE_RPC_HTTP_${response?.status || 'FAILED'}`);
      const payload = await response.json();
      if (payload?.error) {
        throw new Error(`AGE_RPC_${payload.error.code || 'ERROR'}:${payload.error.message || ''}`);
      }
      return payload?.result;
    } finally {
      clearTimeout(timeout);
      this.ageAbortControllers.delete(controller);
    }
  }

  async _providerHistoryFloorAt(at = this.now()) {
    if (this.ageHistoryFloorCheckedAt
      && at - this.ageHistoryFloorCheckedAt < DAY_MS) return this.ageHistoryFloor;
    const firstSlot = nullableFinite(await this._ageRpc('getFirstAvailableBlock'));
    let floorAt = null;
    if (firstSlot != null && firstSlot <= 1) floorAt = 0;
    else if (firstSlot != null) {
      const blockTime = nullableFinite(await this._ageRpc('getBlockTime', [firstSlot]));
      if (blockTime != null) floorAt = blockTime * 1_000;
    }
    this.ageHistoryFloor = floorAt;
    this.ageHistoryFloorCheckedAt = at;
    return floorAt;
  }

  async _resolveWalletAge(wallet, at = this.now()) {
    const current = this.store.db.prepare(
      'SELECT * FROM smart_wallet_registry WHERE wallet=?',
    ).get(wallet);
    if (!current) throw new Error('AGE_WALLET_NOT_FOUND');
    if (this._ageBypassed(current)) {
      return { status: 'BYPASSED', source: 'CONFIG_BYPASS', nextCheckAt: null };
    }
    const voteCutoffAt = at - this._ageMinVoteMs();
    const localFirstAt = this._localAgeEvidence(wallet, voteCutoffAt);
    if (localFirstAt != null) {
      return {
        status: 'ELIGIBLE', firstActivityAt: localFirstAt,
        source: 'LOCAL_HISTORY_LOWER_BOUND', historyComplete: false, nextCheckAt: null,
      };
    }
    const storedFirstAt = nullableFinite(current.first_chain_activity_at);
    if (current.age_history_complete && storedFirstAt != null) {
      const status = this._ageStatus(storedFirstAt, at);
      const nextBoundaryAt = status === 'TOO_NEW'
        ? storedFirstAt + this._ageHardRejectMs()
        : (status === 'PROBATION' ? storedFirstAt + this._ageMinVoteMs() : null);
      return {
        status, firstActivityAt: storedFirstAt,
        source: current.age_source || 'SOLANA_RPC', historyComplete: true,
        nextCheckAt: nextBoundaryAt == null ? null : nextBoundaryAt + 1_000,
      };
    }

    const historyFloorAt = await this._providerHistoryFloorAt(at);
    const pageSize = Math.max(1, Math.min(1_000, finite(this.config.ageRpcPageSize, 1_000)));
    const maxPages = Math.max(1, finite(this.config.ageRpcPagesPerCheck, 2));
    let before = current.age_scan_before_signature || null;
    let firstActivityAt = storedFirstAt;
    let historyComplete = false;
    for (let page = 0; page < maxPages; page += 1) {
      const options = { limit: pageSize };
      if (before) options.before = before;
      const signatures = await this._ageRpc('getSignaturesForAddress', [wallet, options]);
      if (!Array.isArray(signatures)) throw new Error('AGE_RPC_INVALID_SIGNATURE_HISTORY');
      for (const row of signatures) {
        const blockTime = nullableFinite(row?.blockTime);
        const timestampMs = blockTime == null ? null : blockTime * 1_000;
        if (timestampMs != null) {
          firstActivityAt = firstActivityAt == null
            ? timestampMs : Math.min(firstActivityAt, timestampMs);
        }
      }
      if (firstActivityAt != null && firstActivityAt <= voteCutoffAt) {
        return {
          status: 'ELIGIBLE', firstActivityAt, source: 'SOLANA_RPC_LOWER_BOUND',
          historyComplete: false, before: null, nextCheckAt: null,
        };
      }
      if (signatures.length < pageSize) {
        historyComplete = true;
        before = null;
        break;
      }
      const nextBefore = signatures[signatures.length - 1]?.signature;
      if (!nextBefore || nextBefore === before) throw new Error('AGE_RPC_CURSOR_STALLED');
      before = nextBefore;
    }
    if (historyComplete && firstActivityAt != null && historyFloorAt != null
      && historyFloorAt <= voteCutoffAt) {
      const status = this._ageStatus(firstActivityAt, at);
      const nextBoundaryAt = status === 'TOO_NEW'
        ? firstActivityAt + this._ageHardRejectMs()
        : (status === 'PROBATION' ? firstActivityAt + this._ageMinVoteMs() : null);
      return {
        status, firstActivityAt, source: 'SOLANA_RPC_COMPLETE', historyComplete: true,
        before: null,
        nextCheckAt: nextBoundaryAt == null ? null : nextBoundaryAt + 1_000,
      };
    }
    const retryMs = Math.max(60_000, finite(this.config.ageRetryMs, 60 * 60_000));
    return {
      status: 'UNKNOWN', firstActivityAt, source: 'SOLANA_RPC_PARTIAL',
      historyComplete: false, before,
      error: historyComplete ? 'PROVIDER_HISTORY_TOO_SHALLOW' : 'HISTORY_SCAN_INCOMPLETE',
      nextCheckAt: at + (historyComplete ? retryMs : Math.min(retryMs, 60_000)),
    };
  }

  _recordAgeResult(wallet, result, at = this.now()) {
    const current = this.store.db.prepare(
      'SELECT * FROM smart_wallet_registry WHERE wallet=?',
    ).get(wallet);
    if (!current || this.stopping) return null;
    const wasEligible = this._ageEligibleRow(current, at);
    const nextStatus = result.status || current.age_status || 'UNKNOWN';
    const firstActivityAt = nullableFinite(
      result.firstActivityAt ?? current.first_chain_activity_at,
    );
    const changed = nextStatus !== current.age_status
      || firstActivityAt !== nullableFinite(current.first_chain_activity_at)
      || (result.source || null) !== (current.age_source || null)
      || Number(Boolean(result.historyComplete)) !== Number(Boolean(current.age_history_complete));
    const version = changed ? this._nextVersion(at) : current.registry_version;
    this.store.db.prepare(`
      UPDATE smart_wallet_registry SET
        age_status=?, first_chain_activity_at=?, age_verified_at=?, age_source=?,
        age_check_error=?, age_check_after=?, age_scan_before_signature=?,
        age_history_complete=?, registry_version=?, updated_at=?
      WHERE wallet=?
    `).run(
      nextStatus,
      firstActivityAt,
      result.verifiedAt ?? at,
      result.source || current.age_source || null,
      result.error ? String(result.error).slice(0, 240) : null,
      result.nextCheckAt ?? null,
      result.before ?? null,
      result.historyComplete ? 1 : 0,
      version,
      at,
      wallet,
    );
    const updated = this.store.db.prepare(
      'SELECT * FROM smart_wallet_registry WHERE wallet=?',
    ).get(wallet);
    if (wasEligible !== this._ageEligibleRow(updated, at)) this.gradeRefreshRequested = true;
    this.metrics.ageChecksCompleted += 1;
    this.metrics.lastAgeCheckAt = at;
    this.metrics.lastActionAt = at;
    return updated;
  }

  async verifyWalletAge(wallet, at = this.now()) {
    if (!wallet || this.stopping) return null;
    this.metrics.ageChecksStarted += 1;
    try {
      const result = await this._resolveWalletAge(wallet, at);
      return this._recordAgeResult(wallet, result, at);
    } catch (error) {
      this.metrics.ageChecksFailed += 1;
      if (this.stopping) return null;
      const current = this.store.db.prepare(
        'SELECT * FROM smart_wallet_registry WHERE wallet=?',
      ).get(wallet);
      if (!current) return null;
      const stableStatus = ['TOO_NEW', 'PROBATION', 'ELIGIBLE', 'BYPASSED']
        .includes(current.age_status) ? current.age_status : 'UNKNOWN';
      return this._recordAgeResult(wallet, {
        status: stableStatus,
        firstActivityAt: current.first_chain_activity_at,
        source: current.age_source || 'AGE_CHECK_ERROR',
        historyComplete: Boolean(current.age_history_complete),
        before: current.age_scan_before_signature,
        error: error?.message || String(error),
        nextCheckAt: at + Math.max(60_000, finite(this.config.ageRetryMs, 60 * 60_000)),
      }, at);
    }
  }

  _scheduleAgeChecks(at = this.now()) {
    if (this.config.ageCheckEnabled === false || this.stopping) return;
    const concurrency = Math.max(1, finite(this.config.ageCheckConcurrency, 2));
    const capacity = Math.max(0, concurrency - this.ageChecks.size);
    if (!capacity) return;
    const rows = this.store.db.prepare(`
      SELECT wallet FROM smart_wallet_registry
      WHERE age_status NOT IN ('ELIGIBLE','BYPASSED')
        AND COALESCE(age_check_after, 0)<=?
      ORDER BY COALESCE(age_check_after, 0), discovered_at, wallet
      LIMIT ?
    `).all(at, capacity);
    for (const row of rows) {
      if (this.ageChecks.has(row.wallet)) continue;
      const check = this.verifyWalletAge(row.wallet, at)
        .catch(() => null)
        .finally(() => this.ageChecks.delete(row.wallet));
      this.ageChecks.set(row.wallet, check);
    }
  }

  discoverWallet({
    wallet, source = 'ROLLING_DISCOVERY', seedMint = null,
    discoveredAt = this.now(), effectiveFrom = null,
  }) {
    if (!this.config.enabled || !wallet) return false;
    const now = this.now();
    const version = this.version();
    const ageBypassed = this.config.ageCheckEnabled === false
      || (source === 'CONFIG_SEED' && this.config.ageSeedBypass === true);
    const result = this.insertRegistry.run({
      wallet,
      status: 'PROBATION',
      selectionGrade: 'S_C',
      copyGrade: 'C_C',
      holdingGrade: 'H_C',
      riskStatus: 'OK',
      source,
      discoveredAt,
      effectiveFrom: effectiveFrom == null
        ? discoveredAt + this.config.discoveryDelayMs
        : effectiveFrom,
      ageStatus: ageBypassed ? 'BYPASSED' : 'PENDING',
      ageCheckAfter: ageBypassed ? null : now,
      metricsJson: JSON.stringify({ candidateStreak: 0, candidateGrades: null }),
      registryVersion: version,
      createdAt: now,
      updatedAt: now,
    });
    if (seedMint) {
      this.insertSeed.run({ wallet, seedMint, source, discoveredAt, createdAt: now });
    }
    if (result.changes) {
      this.metrics.discovered += 1;
      this.metrics.lastActionAt = now;
    }
    return Boolean(result.changes);
  }

  nominateWallet({ wallet, seedMint, source = 'GRADUATED_EARLY_BUYER', discoveredAt }) {
    if (!this.config.enabled || !wallet || !seedMint) return false;
    const now = this.now();
    this.insertSeed.run({ wallet, seedMint, source, discoveredAt, createdAt: now });
    const seedCount = this.store.db.prepare(`
      SELECT COUNT(DISTINCT seed_mint) n
      FROM smart_wallet_discovery_seeds WHERE wallet=?
    `).get(wallet).n;
    if (seedCount < this.config.discoveryMinSeedMints) return false;
    return this.discoverWallet({ wallet, source, discoveredAt });
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
    return true;
  }

  walletSnapshot(wallet, at = this.now(), observedSnapshot = null) {
    const snapshot = observedSnapshot || this.monitoringSnapshot(wallet, at);
    if (!snapshot || snapshot.effectiveFrom > at) return null;
    if (!snapshot.ageEligible) return null;
    if (!snapshot.pnlEligible) return null;
    if (snapshot.source !== 'CONFIG_SEED') {
      if (this.config.autoVoteRequiresActive !== false && snapshot.status !== 'ACTIVE') return null;
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
      actualPnl24h: pnl.window24h,
      actualPnl7d: pnl.window7d,
      actualPnl30d: pnl.window30d,
      actualOpenPositions: pnl.openPositions,
      actualOpenCostSol: pnl.openCostSol,
      registryVersion: row.registry_version,
      effectiveFrom: row.effective_from,
      votingEligible: false,
    };
  }

  activeClusterCounts(at = this.now()) {
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

  trackedWallets(at = this.now()) {
    return this.store.db.prepare(`
      SELECT * FROM smart_wallet_registry
      WHERE discovered_at<=? AND status IN ('PROBATION','ACTIVE') AND risk_status='OK'
      ORDER BY wallet
    `).all(at).filter((row) => this._ageMonitoringAllowed(row)).map((row) => row.wallet);
  }

  votingWallets(at = this.now()) {
    return this.trackedWallets(at).filter((wallet) => Boolean(this.walletSnapshot(wallet, at)));
  }

  onSmartWalletEvent(event) {
    if (!this.config.enabled || !event?.wallet || !event?.mint) return null;
    const signalAt = finite(event.timestampMs ?? event.timestamp_ms);
    if (!(signalAt > 0)) return null;
    // Candidate wallets are labelled from discovery time, but walletSnapshot()
    // keeps them out of consensus until they are graded and clustered.
    const snapshot = this.monitoringSnapshot(event.wallet, signalAt);
    if (!snapshot) return null;
    this.store.db.prepare(`
      UPDATE smart_wallet_registry SET last_seen_at=?, updated_at=? WHERE wallet=?
    `).run(signalAt, this.now(), event.wallet);
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
    const meta = this._meta();
    if (this.gradeRefreshRequested || !meta.last_grade_refresh_at
      || now - meta.last_grade_refresh_at >= this.config.gradeRefreshMs) {
      this.gradeRefreshRequested = false;
      this.refreshGrades(now);
    }
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
      const performanceQualified = selectionGrade !== 'S_C' || copyGrade !== 'C_C';
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
        actualPnl24h: pnl.window24h,
        actualPnl7d: pnl.window7d,
        actualPnl30d: pnl.window30d,
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
    this.metrics.gradeRefreshes += 1;
    this.metrics.lastGradeRefreshAt = now;
  }

  dashboard(limit = 100) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    const observedAt = this.now();
    const wallets = this.store.db.prepare(`
      SELECT r.*, c.cluster_id, c.confidence cluster_confidence
      FROM smart_wallet_registry r
      LEFT JOIN smart_wallet_cluster_memberships c ON c.wallet=r.wallet
        AND c.valid_from<=? AND (c.valid_to IS NULL OR c.valid_to>?)
      ORDER BY r.status, r.selection_grade, r.copy_grade, r.wallet
      LIMIT ?
    `).all(observedAt, observedAt, capped).map((row) => {
      const pnl = this._actualPnlSnapshot(row.wallet, observedAt);
      const votingEligible = this._votingEligibleRow(row, observedAt);
      return {
        ...row,
        age_ms: nullableFinite(row.first_chain_activity_at) == null
          ? null : Math.max(0, observedAt - Number(row.first_chain_activity_at)),
        age_eligible: this._ageEligibleRow(row, observedAt) ? 1 : 0,
        pnl_status: pnl.status,
        pnl_eligible: pnl.eligible ? 1 : 0,
        pnl_24h_realized_sol: pnl.window24h.realizedPnlSol,
        pnl_24h_return_pct: pnl.window24h.capitalReturnPct,
        pnl_24h_closed_positions: pnl.window24h.closedPositions,
        pnl_7d_realized_sol: pnl.window7d.realizedPnlSol,
        pnl_30d_realized_sol: pnl.window30d.realizedPnlSol,
        actual_open_positions: pnl.openPositions,
        actual_open_cost_sol: pnl.openCostSol,
        voting_eligible: votingEligible ? 1 : 0,
      };
    });
    return {
      enabled: this.config.enabled,
      mode: 'SMART_WALLET_ROLLING_REGISTRY',
      observerOnly: true,
      sendsTransactions: false,
      observedAt,
      registryVersion: this.version(),
      agePolicy: {
        enabled: this.config.ageCheckEnabled !== false,
        hardRejectMs: this._ageHardRejectMs(),
        minVoteMs: this._ageMinVoteMs(),
        seedBypass: this.config.ageSeedBypass === true,
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

  health() {
    const now = this.now();
    const registryRows = this.store.db.prepare(`
      SELECT r.*, c.cluster_id, c.confidence cluster_confidence
      FROM smart_wallet_registry r
      LEFT JOIN smart_wallet_cluster_memberships c ON c.wallet=r.wallet
        AND c.valid_from<=? AND (c.valid_to IS NULL OR c.valid_to>?)
    `).all(now, now);
    const monitoredRows = registryRows.filter((row) => row.discovered_at <= now
      && ['PROBATION', 'ACTIVE'].includes(row.status) && row.risk_status === 'OK'
      && this._ageMonitoringAllowed(row));
    const votingEligible = registryRows.filter((row) => this._votingEligibleRow(row, now)).length;
    const pnlCounts = registryRows.reduce((counts, row) => {
      const status = this._actualPnlSnapshot(row.wallet, now).status;
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});
    const ageCounts = registryRows.reduce((counts, row) => {
      const status = row.age_status || 'UNKNOWN';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});
    return {
      enabled: this.config.enabled,
      mode: 'SMART_WALLET_ROLLING_REGISTRY',
      observerOnly: true,
      sendsTransactions: false,
      registryVersion: this.version(),
      wallets: registryRows.length,
      active: this.store.db.prepare(`
        SELECT COUNT(*) n FROM smart_wallet_registry WHERE status='ACTIVE'
      `).get().n,
      probation: this.store.db.prepare(`
        SELECT COUNT(*) n FROM smart_wallet_registry WHERE status='PROBATION'
      `).get().n,
      quarantined: this.store.db.prepare(`
        SELECT COUNT(*) n FROM smart_wallet_registry WHERE status='QUARANTINED'
      `).get().n,
      pendingLabels: this.labels.size,
      pendingLegacyLabels: this.labels.size,
      pnlProfitable: pnlCounts.PNL_PROFITABLE || 0,
      pnlLossBlocked: pnlCounts.LOSS_BLOCKED || 0,
      pnlPending: pnlCounts.PNL_PENDING || 0,
      pnlBypassed: pnlCounts.PNL_BYPASS || 0,
      ageEligible: ageCounts.ELIGIBLE || 0,
      ageTooNew: ageCounts.TOO_NEW || 0,
      ageProbation: ageCounts.PROBATION || 0,
      ageUnknown: (ageCounts.UNKNOWN || 0) + (ageCounts.PENDING || 0),
      ageBypassed: ageCounts.BYPASSED || 0,
      ageChecksInFlight: this.ageChecks.size,
      monitored: monitoredRows.length,
      votingEligible,
      observationOnly: Math.max(0, monitoredRows.length - votingEligible),
      ...this.metrics,
    };
  }
}

module.exports = {
  SmartWalletRegistry,
  gradeWeight,
  copyWeight,
};
