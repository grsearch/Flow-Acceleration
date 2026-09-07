'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const strictAmm = require('./StrictAmmShadowExecution');
const { tradePrice } = require('./PreEntryRugRiskTracker');
const {
  initializeVotingSnapshotStorage,
  persistVotingSnapshot,
  recentVotingOpenSnapshots,
} = require('./SmartWalletVotingSnapshotStore');

const ACTIVE_STATUSES = [
  'PENDING_SCOUT', 'SCOUT_OPEN', 'WAITING_GRADUATION', 'WAITING_FLOW',
  'SCALE_PENDING', 'OPEN', 'RUNNER', 'EXIT_PENDING',
];

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function json(value, fallback = {}) {
  try {
    return JSON.parse(value || '') || fallback;
  } catch (_) {
    return fallback;
  }
}

function rowToPosition(row) {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    entryProfileId: row.entry_profile_id,
    exitProfileId: row.exit_profile_id,
    episodeId: row.episode_id,
    mint: row.mint,
    status: row.status,
    signalStrength: row.signal_strength,
    signalAt: row.signal_at,
    signalMarket: row.signal_market,
    signalPrice: row.signal_price,
    signalCurvePct: row.signal_curve_pct,
    requiredClusters: row.required_clusters,
    availableClusters: row.available_clusters,
    distinctClusters: row.distinct_clusters,
    selectionAClusters: row.selection_a_clusters,
    copyAClusters: row.copy_a_clusters,
    weightedScore: row.weighted_score,
    votes: json(row.cluster_votes_json, []),
    registryVersion: row.registry_version,
    positionSol: row.position_sol,
    scoutFraction: row.scout_fraction,
    configuredCostPct: row.configured_cost_pct,
    graduatedAt: row.graduated_at,
    flowConfirmedAt: row.flow_confirmed_at,
    flowFeatures: json(row.flow_features_json, null),
    entryTargetAt: row.entry_target_at,
    entryDeadlineAt: row.entry_deadline_at,
    capitalInSol: finite(row.capital_in_sol, 0),
    tokenUnits: finite(row.token_units, 0),
    entryTxCount: finite(row.entry_tx_count, 0),
    exitTxCount: finite(row.exit_tx_count, 0),
    entryAt: row.entry_at,
    entryMarket: row.entry_market,
    entryPrice: row.entry_price,
    coreSoldAt: row.core_sold_at,
    coreProceedsSol: finite(row.core_proceeds_sol, 0),
    runnerUnits: finite(row.runner_units, 0),
    highestReturnPct: finite(row.highest_return_pct, 0),
    lastObservedAt: row.last_observed_at,
    lastMarket: row.last_market,
    lastPrice: row.last_price,
    exitTriggerAt: row.exit_trigger_at,
    exitTargetAt: row.exit_target_at,
    exitDeadlineAt: row.exit_deadline_at,
    exitReason: row.exit_reason,
    executionState: json(row.execution_state_json, {}),
  };
}

class SmartWalletConsensusFlowRunnerShadowSuite {
  constructor({ config, store, registry, rugRiskTracker = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.registry = registry;
    this.rugRiskTracker = rugRiskTracker;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.hasStrictHoldingExecution = [...this.entryProfiles.values()].some(row => row.strictExecution);
    this.maxConsensusWindowMs = Math.max(0, ...(config.entryProfiles || [])
      .map((row) => finite(row.consensusWindowMs, 0)));
    this.maxFlowWindowMs = Math.max(
      finite(config.flowWindowMs, 0),
      ...(config.entryProfiles || []).map((row) => finite(row.flowWindowMs, 0)),
      ...(config.postGradSnapshotHorizonsMs || []).map((value) => finite(value, 0)),
    );
    this.postGradSnapshotHorizonsMs = [...new Set(config.postGradSnapshotHorizonsMs || [])]
      .map((value) => finite(value, 0))
      .filter((value) => value > 0)
      .sort((left, right) => left - right);
    this.postGradHoldingProfiles = [...this.entryProfiles.values()].filter(
      (row) => row.postGraduationHoldingConsensus === true && row.enabled !== false
        && row.newEntriesEnabled !== false,
    );
    this.minPostGradHoldingClusters = Math.min(
      Infinity,
      ...this.postGradHoldingProfiles.map((row) => finite(row.requiredHoldingClusters, 3)),
    );
    this.states = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.lastEpisodes = new Map();
    this.metrics = {
      observedTrades: 0,
      observedSmartOpens: 0,
      observedSmartPositionEvents: 0,
      restoredSmartHoldings: 0,
      firstAmmHoldingEvaluations: 0,
      holdingConsensusQualified: 0,
      holdingConsensusRejected: 0,
      migrationAnchorRejected: 0,
      consensusSignals: 0,
      scoutOpened: 0,
      directOpened: 0,
      flowConfirmed: 0,
      scaled: 0,
      coreSold: 0,
      closed: 0,
      noEntry: 0,
      noExit: 0,
      invalidExitQuotes: 0,
      unconfirmedQuoteJumps: 0,
      incompatiblePoolQuotes: 0,
      coreExitRequested: 0,
      invalidHistoricalRowsQuarantined: 0,
      restartCensored: 0,
      rugLabelsObserved: 0,
      rugBlocksApplied: 0,
      lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS smart_wallet_consensus_flow_runner_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        status TEXT NOT NULL,
        signal_strength TEXT NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_market TEXT NOT NULL,
        signal_price REAL NOT NULL,
        signal_curve_pct REAL,
        required_clusters INTEGER NOT NULL,
        available_clusters INTEGER NOT NULL,
        distinct_clusters INTEGER NOT NULL,
        selection_a_clusters INTEGER NOT NULL,
        copy_a_clusters INTEGER NOT NULL,
        weighted_score REAL NOT NULL,
        cluster_votes_json TEXT NOT NULL,
        registry_version INTEGER NOT NULL,
        position_sol REAL NOT NULL,
        scout_fraction REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        rug_label_json TEXT,
        graduated_at INTEGER,
        flow_confirmed_at INTEGER,
        flow_features_json TEXT,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        capital_in_sol REAL NOT NULL DEFAULT 0,
        token_units REAL NOT NULL DEFAULT 0,
        entry_tx_count INTEGER NOT NULL DEFAULT 0,
        exit_tx_count INTEGER NOT NULL DEFAULT 0,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        core_sold_at INTEGER,
        core_proceeds_sol REAL NOT NULL DEFAULT 0,
        runner_units REAL NOT NULL DEFAULT 0,
        highest_return_pct REAL,
        last_observed_at INTEGER,
        last_market TEXT,
        last_price REAL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        estimated_cost_sol REAL,
        execution_state_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_swcfr_status
        ON smart_wallet_consensus_flow_runner_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_swcfr_mint
        ON smart_wallet_consensus_flow_runner_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swcfr_profiles
        ON smart_wallet_consensus_flow_runner_shadow_positions(
          entry_profile_id, exit_profile_id, status
        );
      CREATE TABLE IF NOT EXISTS smart_wallet_post_grad_holding_evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_profile_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        evaluated_at INTEGER NOT NULL,
        migrated_at INTEGER,
        first_amm_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        required_clusters INTEGER NOT NULL,
        distinct_clusters INTEGER NOT NULL,
        eligible_wallets INTEGER NOT NULL,
        selection_a_clusters INTEGER NOT NULL,
        weighted_score REAL NOT NULL,
        cluster_votes_json TEXT NOT NULL,
        registry_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(entry_profile_id, mint)
      );
      CREATE INDEX IF NOT EXISTS idx_swc_post_grad_holding_status
        ON smart_wallet_post_grad_holding_evaluations(status, evaluated_at DESC);
    `);
    initializeVotingSnapshotStorage(this.store);
    const columns = new Set(this.store.db.prepare(
      'PRAGMA table_info(smart_wallet_consensus_flow_runner_shadow_positions)',
    ).all().map((row) => row.name));
    if (!columns.has('signal_curve_pct')) {
      this.store.db.exec(`
        ALTER TABLE smart_wallet_consensus_flow_runner_shadow_positions
        ADD COLUMN signal_curve_pct REAL
      `);
    }
    if (!columns.has('execution_state_json')) {
      this.store.db.exec(`
        ALTER TABLE smart_wallet_consensus_flow_runner_shadow_positions
        ADD COLUMN execution_state_json TEXT
      `);
    }
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_consensus_flow_runner_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id, mint, status,
        signal_strength, signal_at, signal_market, signal_price, signal_curve_pct,
        required_clusters, available_clusters, distinct_clusters,
        selection_a_clusters, copy_a_clusters, weighted_score, cluster_votes_json,
        registry_version, position_sol, scout_fraction, configured_cost_pct,
        rug_label_json, graduated_at, entry_target_at, entry_deadline_at,
        execution_state_json, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId, @mint, @status,
        @signalStrength, @signalAt, @signalMarket, @signalPrice, @signalCurvePct,
        @requiredClusters, @availableClusters, @distinctClusters,
        @selectionAClusters, @copyAClusters, @weightedScore, @clusterVotesJson,
        @registryVersion, @positionSol, @scoutFraction, @configuredCostPct,
        @rugLabelJson, @graduatedAt, @entryTargetAt, @entryDeadlineAt,
        @executionStateJson, @createdAt, @updatedAt
      )
    `);
    this.update = this.store.db.prepare(`
      UPDATE smart_wallet_consensus_flow_runner_shadow_positions SET
        status=@status,
        graduated_at=@graduatedAt,
        flow_confirmed_at=@flowConfirmedAt,
        flow_features_json=@flowFeaturesJson,
        entry_target_at=@entryTargetAt,
        entry_deadline_at=@entryDeadlineAt,
        capital_in_sol=@capitalInSol,
        token_units=@tokenUnits,
        entry_tx_count=@entryTxCount,
        exit_tx_count=@exitTxCount,
        entry_at=@entryAt,
        entry_market=@entryMarket,
        entry_price=@entryPrice,
        core_sold_at=@coreSoldAt,
        core_proceeds_sol=@coreProceedsSol,
        runner_units=@runnerUnits,
        highest_return_pct=@highestReturnPct,
        last_observed_at=@lastObservedAt,
        last_market=@lastMarket,
        last_price=@lastPrice,
        exit_trigger_at=@exitTriggerAt,
        exit_target_at=@exitTargetAt,
        exit_deadline_at=@exitDeadlineAt,
        exit_reason=@exitReason,
        execution_state_json=@executionStateJson,
        updated_at=@updatedAt
      WHERE id=@id
    `);
    this.close = this.store.db.prepare(`
      UPDATE smart_wallet_consensus_flow_runner_shadow_positions SET
        status=@status, exit_tx_count=@exitTxCount, exit_at=@exitAt,
        exit_market=@exitMarket, exit_price=@exitPrice, exit_reason=@exitReason,
        gross_return_pct=@grossReturnPct, net_return_pct=@netReturnPct,
        estimated_cost_sol=@estimatedCostSol, execution_state_json=@executionStateJson,
        updated_at=@updatedAt
      WHERE id=@id
    `);
    this.insertHoldingEvaluation = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_post_grad_holding_evaluations (
        entry_profile_id, mint, evaluated_at, migrated_at, first_amm_at,
        status, rejection_reason, required_clusters, distinct_clusters,
        eligible_wallets, selection_a_clusters, weighted_score,
        cluster_votes_json, registry_version, created_at
      ) VALUES (
        @entryProfileId, @mint, @evaluatedAt, @migratedAt, @firstAmmAt,
        @status, @rejectionReason, @requiredClusters, @distinctClusters,
        @eligibleWallets, @selectionAClusters, @weightedScore,
        @clusterVotesJson, @registryVersion, @createdAt
      )
    `);
  }

  start() {
    if (!this.config.enabled) return;
    // Preserve the raw quote fields for forensics, but remove impossible legacy
    // proceeds from performance aggregates. These rows were produced before
    // quote/mark consistency validation existed.
    const historicalMultiple = Math.max(
      100,
      finite(this.config.maxHistoricalExitProceedsMultiple, 1_000),
    );
    const quarantined = this.store.db.prepare(`
      UPDATE smart_wallet_consensus_flow_runner_shadow_positions
      SET status='INVALID_QUOTE',
        exit_reason='EXIT_CAPACITY_QUOTE_MARK_PRICE_MISMATCH',
        gross_return_pct=NULL,
        net_return_pct=NULL,
        updated_at=?
      WHERE capital_in_sol>0
        AND core_proceeds_sol>capital_in_sol*?
        AND status IN ('RUNNER','EXIT_PENDING','CLOSED')
    `).run(this.now(), historicalMultiple);
    this.metrics.invalidHistoricalRowsQuarantined = quarantined.changes;
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    const rows = this.store.db.prepare(`
      SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions
      WHERE status IN (${placeholders}) ORDER BY signal_at, id
    `).all(...ACTIVE_STATUSES);
    const restored = rows.map(rowToPosition);
    const restartCensored = restored.filter(position => (
      position.executionState.forwardStudy?.forwardOnly === true
        && position.executionState.strictExecution
    ));
    this.store.db.transaction(() => {
      for (const position of restartCensored) {
        this._closeRightCensored(position, 'RESTART_CENSORED', { countMetric: false });
      }
    })();
    this.metrics.restartCensored += restartCensored.length;
    const censoredIds = new Set(restartCensored.map(position => position.id));
    for (const position of restored) {
      if (censoredIds.has(position.id)) continue;
      if (position.executionState.strictExecution) {
        position.strictRestoredAt = this.now();
        this.hasStrictHoldingExecution = true;
      }
      this.positions.set(position.id, position);
      this._index(position);
    }
    const episodes = this.store.db.prepare(`
      SELECT mint, entry_profile_id, MAX(signal_at) signal_at
      FROM smart_wallet_consensus_flow_runner_shadow_positions
      WHERE signal_at>=? GROUP BY mint, entry_profile_id
    `).all(this.now() - this.config.stateRetentionMs);
    for (const row of episodes) {
      this.lastEpisodes.set(`${row.mint}:${row.entry_profile_id}`, row.signal_at);
    }
    for (const restored of recentVotingOpenSnapshots(
      this.store,
      this.now() - this.maxConsensusWindowMs,
      this.now(),
    )) {
      this._rememberSmartOpen(restored.event, restored.walletSnapshot, { restored: true });
    }
    this._restoreSmartHoldings(this.now());
    this.advanceTime(this.now());
  }

  stop() {
    for (const position of this.positions.values()) {
      if (position.executionState.strictExecution) this._save(position);
    }
  }

  trackedMints() {
    const mints = new Set(this.rowsByMint.keys());
    if (Number.isFinite(this.minPostGradHoldingClusters)) {
      const at = this.now();
      for (const [mint, state] of this.states) {
        // Holding-grade wallets keep a not-yet-migrated mint subscribed even
        // when they are not S_A/S_B graduation-prediction voters. Once the
        // first AMM trade has been evaluated, active Shadow rows own the
        // subscription and prevent an unnecessary 24-hour broad AMM tail.
        if (state.firstAmmObservedAt != null) continue;
        const votes = this._holdingVotes(state, at);
        if (votes.length >= this.minPostGradHoldingClusters) mints.add(mint);
      }
    }
    return [...mints];
  }

  health({ includeDatabase = true } = {}) {
    const at = this.now();
    let dynamicThresholds;
    if (includeDatabase) {
      this.healthHoldingSnapshot = { generatedAt: at, count: this.trackedMints().filter(
        (mint) => !this.rowsByMint.has(mint),
      ).length };
      dynamicThresholds = this._thresholdSnapshot(at);
    } else {
      // Never call registry accessors or holding-vote evaluation from IPC
      // sampling: legacy accessors may query SQL or refresh eligibility.
      const snapshot = this.registry.walletEligibilitySnapshot;
      const counts = snapshot?.generatedAt > 0 ? snapshot.clusterCounts : null;
      const tiers = this.config.dynamicThresholds || [];
      const tier = counts ? tiers.find(row => counts.eligible <= row.maxEligibleClusters)
        || tiers[tiers.length - 1] : null;
      dynamicThresholds = counts ? { ...counts, ordinary: tier?.ordinary || 2,
        strong: tier?.strong || 3, generatedAt: snapshot.generatedAt,
        status: snapshot.expiresAt <= at ? 'STALE' : 'CACHED' }
        : { eligible: null, selectionA: null, ordinary: null, strong: null,
          generatedAt: null, status: 'UNAVAILABLE' };
    }
    return {
      executionPolicyVersion: 'CAUSAL_CORE_POOL_V2',
      enabled: this.config.enabled,
      mode: 'SHADOW_SMART_CONSENSUS_FLOW_RUNNER_V2',
      observerOnly: true,
      sendsTransactions: false,
      rugPolicy: 'OBSERVE_ONLY_NOT_AN_ENTRY_FILTER',
      forwardHoldingStudy: this.config.forwardHoldingStudy || null,
      activePositions: this.positions.size,
      trackedMints: this.rowsByMint.size,
      holdingSubscriptionMints: this.healthHoldingSnapshot?.count ?? null,
      holdingSubscriptionSnapshot: {
        status: includeDatabase ? 'READY' : this.healthHoldingSnapshot ? 'CACHED' : 'UNAVAILABLE',
        generatedAt: this.healthHoldingSnapshot?.generatedAt ?? null,
      },
      dynamicThresholds,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      table: 'smart_wallet_consensus_flow_runner_shadow_positions',
      postGradHoldingEvaluationTable: 'smart_wallet_post_grad_holding_evaluations',
      ...this.metrics,
    };
  }

  dashboard(limit = 100) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    return {
      ...this.health(),
      forwardPairAudit: this._forwardPairAudit(),
      summary: this.store.db.prepare(`
        SELECT entry_profile_id, exit_profile_id, status, COUNT(*) n,
          AVG(net_return_pct) avg_net_return_pct,
          SUM(CASE WHEN net_return_pct>0 THEN 1 ELSE 0 END) winners
        FROM smart_wallet_consensus_flow_runner_shadow_positions
        GROUP BY entry_profile_id, exit_profile_id, status
        ORDER BY entry_profile_id, exit_profile_id, status
      `).all(),
      capitalSummary: this.store.db.prepare(`
        SELECT entry_profile_id, exit_profile_id,
          COUNT(*) opportunities, COUNT(DISTINCT mint) independent_mints,
          SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) closed,
          SUM(CASE WHEN status IN ('NO_EXIT','RIGHT_CENSORED') THEN 1 ELSE 0 END) censored,
          SUM(CASE WHEN status='RIGHT_CENSORED' THEN 1 ELSE 0 END) right_censored,
          SUM(CASE WHEN status IN ('CLOSED','EXPIRED','NO_ENTRY') THEN 1 ELSE 0 END) resolved,
          SUM(position_sol) planned_capital_sol,
          SUM(capital_in_sol) deployed_capital_sol,
          SUM(CASE WHEN status IN ('CLOSED','EXPIRED','NO_ENTRY')
            THEN position_sol ELSE 0 END) resolved_planned_capital_sol,
          SUM(CASE WHEN net_return_pct IS NOT NULL
            THEN capital_in_sol ELSE 0 END) realized_deployed_capital_sol,
          SUM(CASE WHEN net_return_pct IS NOT NULL
            THEN net_return_pct * capital_in_sol / 100.0 ELSE 0 END) net_pnl_sol,
          CASE WHEN SUM(CASE WHEN status IN ('CLOSED','EXPIRED','NO_ENTRY')
            THEN position_sol ELSE 0 END)>0 THEN 100.0 * SUM(CASE
            WHEN net_return_pct IS NOT NULL THEN net_return_pct * capital_in_sol / 100.0
            ELSE 0 END) / SUM(CASE WHEN status IN ('CLOSED','EXPIRED','NO_ENTRY')
              THEN position_sol ELSE 0 END) ELSE NULL END planned_capital_return_pct,
          CASE WHEN SUM(CASE WHEN net_return_pct IS NOT NULL
            THEN capital_in_sol ELSE 0 END)>0 THEN 100.0 * SUM(CASE
            WHEN net_return_pct IS NOT NULL THEN net_return_pct * capital_in_sol / 100.0
            ELSE 0 END) / SUM(CASE WHEN net_return_pct IS NOT NULL
              THEN capital_in_sol ELSE 0 END) ELSE NULL END deployed_capital_return_pct
        FROM smart_wallet_consensus_flow_runner_shadow_positions
        GROUP BY entry_profile_id, exit_profile_id
        ORDER BY entry_profile_id, exit_profile_id
      `).all(),
      postGradHoldingSummary: this.store.db.prepare(`
        SELECT entry_profile_id, status, rejection_reason, COUNT(*) n,
          AVG(distinct_clusters) avg_distinct_clusters,
          MAX(distinct_clusters) max_distinct_clusters
        FROM smart_wallet_post_grad_holding_evaluations
        GROUP BY entry_profile_id, status, rejection_reason
        ORDER BY entry_profile_id, status, rejection_reason
      `).all(),
      recentPostGradHoldingEvaluations: this.store.db.prepare(`
        SELECT * FROM smart_wallet_post_grad_holding_evaluations
        ORDER BY evaluated_at DESC, id DESC LIMIT ?
      `).all(capped),
      recent: this.store.db.prepare(`
        SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions
        ORDER BY signal_at DESC, id DESC LIMIT ?
      `).all(capped),
    };
  }

  _forwardPairAudit() {
    const study = this.config.forwardHoldingStudy;
    const entryIds = Array.isArray(study?.entryProfileIds) ? study.entryProfileIds : [];
    const exitIds = Array.isArray(study?.exitProfileIds) ? study.exitProfileIds : [];
    const expectedPairs = entryIds.flatMap(entryId => (
      exitIds.map(exitId => [entryId, exitId])
    ));
    const expectedArms = expectedPairs.length;
    if (!study?.version || !expectedArms) return null;

    const expectedPairSql = expectedPairs.map(() => `
      SUM(CASE WHEN entry_profile_id=? AND exit_profile_id=? THEN 1 ELSE 0 END)=1
    `).join(' AND ');
    const idPlaceholders = entryIds.map(() => '?').join(',');
    const audit = this.store.db.prepare(`
      WITH forward_rows AS (
        SELECT *,
          json_extract(execution_state_json, '$.forwardStudy.pairedOpportunityId') opportunity_id,
          json_extract(execution_state_json, '$.strictExecution.pool') strict_pool,
          json_extract(execution_state_json, '$.forwardStudy.signalReceivedAtMs') source_received_at,
          json_extract(execution_state_json, '$.forwardStudy.signalChainTimestampMs') source_chain_at,
          json_extract(execution_state_json, '$.strictExecution.cursor') source_cursor,
          json_extract(execution_state_json, '$.strictExecution.policy') frozen_policy,
          json_extract(execution_state_json, '$.strictExecution.costs') frozen_costs
        FROM smart_wallet_consensus_flow_runner_shadow_positions
        WHERE CASE WHEN json_valid(execution_state_json)
          THEN json_extract(execution_state_json, '$.forwardStudy.version') END=?
          AND entry_profile_id IN (${idPlaceholders})
      ), grouped AS (
        SELECT opportunity_id, COUNT(*) arms,
          COUNT(DISTINCT entry_profile_id || char(0) || exit_profile_id) distinct_arms,
          COUNT(DISTINCT mint) mint_variants,
          COUNT(DISTINCT signal_at) signal_at_variants,
          COUNT(DISTINCT signal_market) market_variants,
          COUNT(DISTINCT signal_price) price_variants,
          COUNT(DISTINCT strict_pool) pool_variants,
          COUNT(DISTINCT source_received_at) received_at_variants,
          COUNT(DISTINCT source_chain_at) chain_at_variants,
          COUNT(DISTINCT source_cursor) source_cursor_variants,
          COUNT(DISTINCT position_sol) position_size_variants,
          COUNT(DISTINCT configured_cost_pct) configured_cost_variants,
          COUNT(DISTINCT frozen_policy) policy_variants,
          COUNT(DISTINCT frozen_costs) cost_snapshot_variants,
          SUM(CASE WHEN json_extract(execution_state_json, '$.forwardStudy.forwardOnly')=1
            AND json_extract(execution_state_json, '$.strictExecution.entry.id')=entry_profile_id
            AND json_extract(execution_state_json, '$.strictExecution.exit.id')=exit_profile_id
            AND cohort_id=entry_profile_id || '|' || exit_profile_id
            AND json_extract(execution_state_json, '$.strictExecution.feeConvention')='ROUND_TRIP_ONCE'
            THEN 0 ELSE 1 END) protocol_errors,
          CASE WHEN ${expectedPairSql} THEN 1 ELSE 0 END exact_pair_set
        FROM forward_rows
        WHERE opportunity_id IS NOT NULL
        GROUP BY opportunity_id
      )
      SELECT
        (SELECT COUNT(*) FROM forward_rows) total_rows,
        COUNT(*) total_opportunities,
        COALESCE(SUM(arms=? AND distinct_arms=? AND exact_pair_set=1), 0) complete_opportunities,
        COALESCE(SUM(NOT (arms=? AND distinct_arms=? AND exact_pair_set=1)), 0) incomplete_opportunities,
        COALESCE(SUM(mint_variants!=1 OR signal_at_variants!=1 OR market_variants!=1
          OR price_variants!=1 OR pool_variants!=1 OR received_at_variants!=1
          OR chain_at_variants!=1 OR source_cursor_variants!=1), 0) source_mismatch_opportunities,
        COALESCE(SUM(protocol_errors!=0 OR position_size_variants!=1
          OR configured_cost_variants!=1 OR policy_variants!=1
          OR cost_snapshot_variants!=1), 0) protocol_mismatch_opportunities,
        (SELECT COUNT(*) FROM forward_rows WHERE opportunity_id IS NULL) unpaired_rows,
        COALESCE(SUM(arms=? AND distinct_arms=? AND exact_pair_set=1
          AND mint_variants=1 AND signal_at_variants=1 AND market_variants=1
          AND price_variants=1 AND pool_variants=1 AND received_at_variants=1
          AND chain_at_variants=1 AND source_cursor_variants=1
          AND protocol_errors=0 AND position_size_variants=1
          AND configured_cost_variants=1 AND policy_variants=1
          AND cost_snapshot_variants=1), 0) comparable_opportunities
      FROM grouped
    `).get(
      study.version,
      ...entryIds,
      ...expectedPairs.flat(),
      expectedArms, expectedArms,
      expectedArms, expectedArms,
      expectedArms, expectedArms,
    );
    const taggedPlaceholders = entryIds.map(() => '?').join(',');
    const untagged = this.store.db.prepare(`
      SELECT COUNT(*) n
      FROM smart_wallet_consensus_flow_runner_shadow_positions
      WHERE entry_profile_id IN (${taggedPlaceholders})
        AND CASE WHEN json_valid(execution_state_json)
          THEN json_extract(execution_state_json, '$.forwardStudy.version') END IS NOT ?
    `).get(...entryIds, study.version).n;
    return {
      studyVersion: study.version,
      expectedArms,
      totalRows: finite(audit.total_rows, 0),
      totalOpportunities: finite(audit.total_opportunities, 0),
      completeOpportunities: finite(audit.complete_opportunities, 0),
      incompleteOpportunities: finite(audit.incomplete_opportunities, 0),
      sourceMismatchOpportunities: finite(audit.source_mismatch_opportunities, 0),
      protocolMismatchOpportunities: finite(audit.protocol_mismatch_opportunities, 0),
      unpairedRows: finite(audit.unpaired_rows, 0),
      untaggedRows: finite(untagged, 0),
      comparableOpportunities: finite(audit.comparable_opportunities, 0),
    };
  }

  _restoreSmartHoldings(at) {
    if (!this.postGradHoldingProfiles.length) return;
    const limit = Math.max(100, Math.trunc(finite(
      this.config.maxRestoredHoldingRows, 20_000,
    )));
    const rows = this.store.db.prepare(`
      SELECT position.wallet, position.mint, position.token_balance,
        position.updated_at
      FROM smart_wallet_positions position
      JOIN flow_tokens token ON token.mint=position.mint
      WHERE position.token_balance>0 AND position.updated_at>=?
        AND token.migrated_at IS NULL
      ORDER BY position.updated_at DESC
      LIMIT ?
    `).all(at - this.config.stateRetentionMs, limit);
    for (const row of rows) {
      const snapshot = typeof this.registry.cachedMonitoringSnapshot === 'function'
        ? this.registry.cachedMonitoringSnapshot(row.wallet, at)
        : this.registry.monitoringSnapshot(row.wallet, at);
      if (!snapshot) continue;
      this._rememberSmartHolding({
        wallet: row.wallet,
        mint: row.mint,
        timestampMs: row.updated_at,
        tokenBalanceAfter: row.token_balance,
      }, snapshot);
      this.metrics.restoredSmartHoldings += 1;
    }
  }

  onSmartWalletPositionEvent(event, { walletSnapshot = null } = {}) {
    if (!this.config.enabled || !event?.mint || !event?.wallet) return false;
    const timestampMs = finite(event.timestampMs ?? event.timestamp_ms);
    const snapshot = walletSnapshot
      || (typeof this.registry.cachedMonitoringSnapshot === 'function'
        ? this.registry.cachedMonitoringSnapshot(event.wallet, timestampMs)
        : this.registry.monitoringSnapshot(event.wallet, timestampMs));
    if (!(timestampMs > 0) || !snapshot) return false;
    const remembered = this._rememberSmartHolding(event, snapshot);
    if (remembered) this.metrics.observedSmartPositionEvents += 1;
    return remembered;
  }

  _rememberSmartHolding(event, snapshot) {
    const timestampMs = finite(event.timestampMs ?? event.timestamp_ms);
    const tokenBalanceAfter = finite(
      event.tokenBalanceAfter ?? event.token_balance_after,
    );
    if (!(timestampMs > 0) || tokenBalanceAfter == null || !event.wallet || !snapshot) {
      return false;
    }
    const state = this._state(event.mint);
    const previous = state.smartHoldings.get(event.wallet);
    if (previous && previous.timestampMs > timestampMs) return false;
    if (!(tokenBalanceAfter > 0)) {
      state.smartHoldings.delete(event.wallet);
    } else {
      state.smartHoldings.set(event.wallet, {
        timestampMs,
        wallet: event.wallet,
        eventId: finite(event.id ?? event.smartEventId ?? event.smart_event_id),
        tokenBalanceAfter,
        clusterId: snapshot.clusterId || event.wallet,
        selectionGrade: snapshot.selectionGrade,
        copyGrade: snapshot.copyGrade,
        holdingGrade: snapshot.holdingGrade,
        registryVersion: finite(snapshot.registryVersion, 0),
        weight: Number.isFinite(snapshot.voteWeight)
          ? snapshot.voteWeight
          : finite(snapshot.selectionWeight, 1),
        votingEligible: snapshot.votingEligible === true,
      });
    }
    state.lastAt = Math.max(state.lastAt, timestampMs);
    return true;
  }

  onSmartWalletEvent(event, {
    replay = false, walletSnapshot = null, persist = true,
  } = {}) {
    if (!this.config.enabled || replay || !event?.mint || !event?.wallet) return [];
    const timestampMs = finite(event.timestampMs ?? event.timestamp_ms);
    const snapshot = walletSnapshot
      || (typeof this.registry.cachedWalletSnapshot === 'function'
        ? this.registry.cachedWalletSnapshot(event.wallet, timestampMs)
        : this.registry.walletSnapshot(event.wallet, timestampMs));
    this._rememberSmartHolding(event, snapshot);
    if (String(event.side || '').toUpperCase() !== 'BUY'
      || String(event.positionPhase || event.position_phase || '').toUpperCase() !== 'OPEN') return [];
    const price = tradePrice(event);
    if (!(timestampMs > 0) || !(price > 0) || !snapshot) return [];
    if (persist) persistVotingSnapshot(this.store, event, snapshot, this.now());
    const state = this._state(event.mint);
    this._rememberSmartOpen(event, snapshot);
    const created = [];
    for (const profile of this.entryProfiles.values()) {
      if (profile.enabled === false || profile.newEntriesEnabled === false
        || !this._profileAcceptsSignal(profile, event, state)) continue;
      const episodeKey = `${event.mint}:${profile.id}`;
      if (timestampMs - finite(this.lastEpisodes.get(episodeKey), -Infinity)
        < this.config.episodeCooldownMs) continue;
      const consensus = this._consensus(state, timestampMs, profile);
      if (!consensus) continue;
      this.lastEpisodes.set(episodeKey, timestampMs);
      created.push(...this._recordSignal(event, profile, consensus, timestampMs, price));
    }
    return created;
  }

  _rememberSmartOpen(event, snapshot, { restored = false } = {}) {
    const timestampMs = finite(event.timestampMs ?? event.timestamp_ms);
    const price = tradePrice(event);
    if (!(timestampMs > 0) || !(price > 0) || !snapshot) return false;
    const state = this._state(event.mint);
    const eventId = finite(event.id ?? event.smartEventId ?? event.smart_event_id);
    const duplicate = state.smartBuys.some((row) => row.wallet === event.wallet
      && row.eventId === eventId);
    if (duplicate) return false;
    state.smartBuys.push({
      timestampMs,
      wallet: event.wallet,
      eventId,
      clusterId: snapshot.clusterId,
      selectionGrade: snapshot.selectionGrade,
      copyGrade: snapshot.copyGrade,
      holdingGrade: snapshot.holdingGrade,
      registryVersion: finite(snapshot.registryVersion, 0),
      snapshotGeneratedAt: finite(snapshot.snapshotGeneratedAt),
      snapshotExpiresAt: finite(snapshot.snapshotExpiresAt),
      weight: Number.isFinite(snapshot.voteWeight)
        ? snapshot.voteWeight
        : (snapshot.status === 'PROBATION'
          ? this.config.probationVoteWeight : finite(snapshot.selectionWeight, 1)),
      market: event.market,
      price,
    });
    state.smartBuys.sort((left, right) => left.timestampMs - right.timestampMs);
    state.lastAt = Math.max(state.lastAt, timestampMs);
    this._prune(state, timestampMs);
    if (!restored) this.metrics.observedSmartOpens += 1;
    return true;
  }

  onGraduated(event) {
    if (!this.config.enabled || !event?.mint) return;
    const at = finite(event.graduated_at ?? event.graduatedAt
      ?? event.completedAt ?? event.migratedAt ?? event.timestampMs);
    if (!(at > 0)) return;
    const state = this._state(event.mint);
    state.graduatedAt = at;
    const migratedAt = finite(event.migrated_at ?? event.migratedAt);
    if (migratedAt > 0) {
      state.migratedAt = migratedAt;
      state.migrationObservedLive = true;
      state.migrationPool = event.migration_pool ?? event.migrationPool
        ?? event.pool ?? state.migrationPool;
    }
    this.store.db.prepare(`
      UPDATE smart_wallet_consensus_flow_runner_shadow_positions
      SET graduated_at=COALESCE(graduated_at,?), updated_at=?
      WHERE mint=? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
    `).run(at, this.now(), event.mint, ...ACTIVE_STATUSES);
    for (const id of this.rowsByMint.get(event.mint) || []) {
      const position = this.positions.get(id);
      if (!position) continue;
      position.graduatedAt = at;
      if (position.status === 'WAITING_GRADUATION') position.status = 'WAITING_FLOW';
      this._save(position);
    }
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade.market)) return;
    const timestampMs = finite(trade.timestampMs);
    const receivedAtMs = finite(trade.receivedAtMs);
    const strictObservedAt = trade.market === 'PUMP_AMM' && this.hasStrictHoldingExecution
      ? finite(receivedAtMs, timestampMs) : timestampMs;
    const price = tradePrice(trade);
    if (!(strictObservedAt > 0)) return;
    if (!(price > 0)) {
      if (trade.market === 'PUMP_AMM') this._evaluatePostGradHoldingProfiles(
        trade, this._state(trade.mint), strictObservedAt, price, { strictOnly: true },
      );
      return;
    }
    // Strict studies use the local processing clock for deadlines. The event's
    // untrusted generic timestamp must never expire positions before the
    // received/chain clocks have passed strict validation.
    this.advanceTime(this.hasStrictHoldingExecution ? this.now() : timestampMs);
    const state = this._state(trade.mint);
    state.lastAt = Math.max(state.lastAt, strictObservedAt);
    // Strict FLOW arms must not count stale, duplicate, regressing or cross-pool
    // trades simply because a later valid trade asks for the 60s aggregate.
    let strictFlowAccepted = false;
    if (trade.market === 'PUMP_AMM' && this.hasStrictHoldingExecution) {
      const token = this.store.getToken(trade.mint);
      const migrationPool = token?.migration_pool ?? token?.migrationPool ?? state.migrationPool;
      const migratedAt = finite(token?.migrated_at ?? token?.migratedAt ?? state.migratedAt);
      if (typeof migrationPool === 'string' && migrationPool.trim()
        && migratedAt > 0
        && trade.pool === migrationPool
        && receivedAtMs >= migratedAt && finite(trade.chainTimestampMs) >= migratedAt) {
        if (!state.strictFlowState || state.strictFlowState.pool !== migrationPool) {
          state.strictFlowState = {
            policy: { version: strictAmm.VERSION, maxTradeAgeMs: 3_000 },
            pool: migrationPool,
          };
        }
        strictFlowAccepted = strictAmm.accept(trade, state.strictFlowState, this.now());
      }
    }
    state.trades.push({
      timestampMs,
      strictFlowAccepted,
      receivedAtMs,
      chainTimestampMs: finite(trade.chainTimestampMs),
      pool: trade.pool,
      signature: trade.signature || null,
      eventIndex: trade.eventIndex ?? null,
      market: trade.market,
      side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      registeredWallet: Boolean(trade.wallet && (
        typeof this.registry.cachedMonitoringSnapshot === 'function'
          ? this.registry.cachedMonitoringSnapshot(trade.wallet, strictObservedAt)
          : this.registry.monitoringSnapshot(trade.wallet, strictObservedAt)
      )),
    });
    this._prune(state, strictObservedAt);
    if (trade.market === 'PUMP_AMM') {
      this._evaluatePostGradHoldingProfiles(trade, state, strictObservedAt, price);
    }
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.positions.get(id);
      if (position) this._observePosition(position, trade, strictObservedAt, price, state);
    }
    this.metrics.observedTrades += 1;
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const position of [...this.positions.values()]) {
      if (position.status === 'PENDING_SCOUT' && now > position.entryDeadlineAt) {
        this._finishWithoutPosition(position, 'NO_ENTRY', 'SCOUT_ENTRY_TIMEOUT');
      } else if (position.status === 'WAITING_GRADUATION'
        && now > position.signalAt + this.config.maxScoutWaitMs) {
        this._finishWithoutPosition(position, 'EXPIRED', 'NO_GRADUATION');
      } else if (position.status === 'SCOUT_OPEN' && !position.graduatedAt
        && now > position.signalAt + this.config.maxScoutWaitMs) {
        this._requestExit(position, now, 'NO_GRADUATION');
      } else if (['SCOUT_OPEN', 'WAITING_FLOW'].includes(position.status)
        && position.graduatedAt
        && now > (position.executionState.strictExecution
          ? position.signalAt : position.graduatedAt) + this._maxFlowWaitMs(position)) {
        if (position.tokenUnits > 0) this._requestExit(position, now, 'FLOW_CONFIRM_TIMEOUT');
        else this._finishWithoutPosition(position, 'NO_ENTRY', 'FLOW_CONFIRM_TIMEOUT');
      } else if (position.status === 'SCALE_PENDING' && now > position.entryDeadlineAt) {
        const profile = this._entryFor(position);
        if (position.tokenUnits > 0) this._requestExit(position, now, 'SCALE_ENTRY_TIMEOUT');
        else this._finishWithoutPosition(
          position,
          'NO_ENTRY',
          profile?.directPostGraduationEntry === true
            ? 'DIRECT_AMM_ENTRY_TIMEOUT' : 'POST_FLOW_ENTRY_TIMEOUT',
        );
      } else if (position.status === 'EXIT_PENDING' && now > position.exitDeadlineAt) {
        this._closeNoExit(position, 'NO_EXIT_QUOTE');
      } else if (position.executionState?.corePending
        && now > position.executionState.corePending.deadlineAt) {
        this._closeNoExit(position, 'CORE_EXIT_TIMEOUT');
      } else if (['OPEN', 'RUNNER'].includes(position.status)) {
        const exit = this._exitFor(position);
        const strictDeadline = position.entryAt
          + (exit.mode === 'FIXED_HOLD' ? exit.fixedHoldMs : exit.maxHoldMs);
        if (position.executionState.strictExecution && now >= strictDeadline) {
          this._requestExit(position, strictDeadline, exit.mode === 'FIXED_HOLD' ? 'FIXED_HOLD' : 'MAX_HOLD');
          continue;
        }
        if (now > position.entryAt + exit.maxHoldMs) {
          this._requestExit(position, now, 'MAX_HOLD');
        }
      }
    }
    const cutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      this._prune(state, now);
      if (state.lastAt < cutoff && !this.rowsByMint.has(mint)) this.states.delete(mint);
    }
    for (const [key, at] of this.lastEpisodes) {
      if (at < cutoff) this.lastEpisodes.delete(key);
    }
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      const token = this.store.getToken(mint);
      state = {
        smartBuys: [], smartHoldings: new Map(), trades: [], lastAt: 0,
        graduatedAt: finite(token?.graduated_at ?? token?.graduatedAt),
        migratedAt: finite(token?.migrated_at ?? token?.migratedAt),
        migrationPool: token?.migration_pool ?? token?.migrationPool ?? null,
        migrationObservedLive: false,
        firstAmmObservedAt: null,
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _prune(state, at) {
    const smartCutoff = at - this.maxConsensusWindowMs;
    const flowCutoff = at - Math.max(this.maxFlowWindowMs, this.maxConsensusWindowMs);
    while (state.smartBuys.length && state.smartBuys[0].timestampMs < smartCutoff) {
      state.smartBuys.shift();
    }
    state.trades = state.trades.filter((row) => (
      finite(row.receivedAtMs, row.timestampMs) >= flowCutoff
    ));
  }

  _thresholdSnapshot(at) {
    const counts = this.registry.activeClusterCounts(at);
    const tier = (this.config.dynamicThresholds || []).find((row) => (
      counts.eligible <= row.maxEligibleClusters
    )) || this.config.dynamicThresholds[this.config.dynamicThresholds.length - 1];
    return {
      ...counts,
      ordinary: tier?.ordinary || 2,
      strong: tier?.strong || 3,
    };
  }

  _profileAcceptsSignal(profile, event, state) {
    if (profile?.postGraduationHoldingConsensus) return false;
    if (!profile?.directCurveEntry) return true;
    const curvePct = finite(event.curvePct ?? event.curve_pct);
    const market = String(event.market || '').toUpperCase();
    return !state?.graduatedAt
      && market === 'PUMP_BONDING_CURVE'
      && curvePct != null
      && curvePct >= finite(profile.minCurvePct, 0)
      && curvePct < finite(profile.maxCurvePct, 100);
  }

  _holdingConsensus(state, at, profile) {
    const votes = this._holdingVotes(state, at, profile);
    const eligibleWallets = votes.reduce((sum, row) => sum + row.walletCount, 0);
    const required = Math.max(2, Math.trunc(finite(profile.requiredHoldingClusters, 3)));
    const selectionA = votes.filter((row) => row.selectionGrade === 'S_A').length;
    const copyA = votes.filter((row) => row.copyGrade === 'C_A').length;
    const weightedScore = votes.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
    const minWeightedScore = required * finite(profile.minWeightedScoreRatio, 0.5);
    let rejectionReason = null;
    if (votes.length < required) rejectionReason = `HOLDING_CLUSTERS_LT_${required}`;
    else if (weightedScore < minWeightedScore) rejectionReason = 'HOLDING_WEIGHT_TOO_LOW';
    return {
      votes,
      thresholds: this._thresholdSnapshot(at),
      required,
      selectionA,
      copyA,
      weightedScore,
      eligibleWallets,
      rejectionReason,
    };
  }

  _holdingSnapshotEligible(snapshot) {
    if (!snapshot || snapshot.ageEligible === false || snapshot.pnlEligible === false) {
      return false;
    }
    if (!snapshot.longTermElite && !['H_A', 'H_B'].includes(snapshot.holdingGrade)) {
      return false;
    }
    return snapshot.source === 'CONFIG_SEED' || snapshot.clusterKnown !== false;
  }

  _holdingVotes(state, at, profile = null) {
    const byCluster = new Map();
    for (const holding of state.smartHoldings.values()) {
      if (!(holding.tokenBalanceAfter > 0) || holding.timestampMs > at) continue;
      // Post-graduation holding consensus is a different capability from
      // predicting graduation. It may use H_A/H_B or a 60d elite wallet, while
      // pre-graduation _consensus() below remains restricted to S_A/S_B votes.
      const snapshot = typeof this.registry.cachedMonitoringSnapshot === 'function'
        ? this.registry.cachedMonitoringSnapshot(holding.wallet, at)
        : this.registry.monitoringSnapshot(holding.wallet, at);
      if (!this._holdingSnapshotEligible(snapshot)) continue;
      if (profile?.strictExecution && (!Number.isFinite(snapshot.snapshotGeneratedAt)
        || !Number.isFinite(snapshot.snapshotExpiresAt)
        || snapshot.snapshotGeneratedAt <= 0
        || snapshot.snapshotGeneratedAt > at || snapshot.snapshotExpiresAt < at)) continue;
      const holdingWeight = snapshot.longTermElite || snapshot.holdingGrade === 'H_A'
        ? 1 : 0.5;
      const vote = {
        timestampMs: holding.timestampMs,
        wallet: holding.wallet,
        eventId: holding.eventId,
        clusterId: snapshot.clusterId || holding.clusterId || holding.wallet,
        selectionGrade: snapshot.selectionGrade,
        copyGrade: snapshot.copyGrade,
        holdingGrade: snapshot.holdingGrade,
        registryVersion: finite(snapshot.registryVersion, holding.registryVersion || 0),
        weight: holdingWeight,
        tokenBalanceAfter: holding.tokenBalanceAfter,
        walletCount: 1,
        ...(profile?.strictExecution ? { snapshotGeneratedAt: snapshot.snapshotGeneratedAt,
          snapshotExpiresAt: snapshot.snapshotExpiresAt } : {}),
      };
      const current = byCluster.get(vote.clusterId);
      if (!current || vote.weight > current.weight
        || (vote.weight === current.weight
          && vote.tokenBalanceAfter > current.tokenBalanceAfter)) {
        vote.walletCount = finite(current?.walletCount, 0) + 1;
        byCluster.set(vote.clusterId, vote);
      } else {
        current.walletCount += 1;
      }
    }
    return [...byCluster.values()].sort(
      (left, right) => left.timestampMs - right.timestampMs,
    );
  }

  _evaluatePostGradHoldingProfiles(trade, state, at, price, { strictOnly = false } = {}) {
    if (!this.postGradHoldingProfiles.length) return [];
    state.holdingEvaluatedProfiles ||= new Set();
    const token = this.store.getToken(trade.mint);
    const migratedAt = finite(
      token?.migrated_at ?? token?.migratedAt ?? state.migratedAt,
    );
    const migrationPool = token?.migration_pool ?? token?.migrationPool ?? state.migrationPool;
    const receivedAtMs = finite(trade.receivedAtMs);
    const chainTimestampMs = finite(trade.chainTimestampMs);
    const profiles = this.postGradHoldingProfiles.filter((profile) => {
      if (strictOnly && !profile.strictExecution) return false;
      if (state.holdingEvaluatedProfiles.has(profile.id)) return false;
      if (!profile.strictExecution || !(migratedAt > 0)
        || typeof migrationPool !== 'string' || !migrationPool.trim()) return true;
      // A different pool or a quote ordered before migration is not the first
      // canonical post-migration AMM observation and must not consume it.
      const canonicalTime = Number.isSafeInteger(trade.receivedAtMs)
        && Number.isSafeInteger(trade.chainTimestampMs)
        && receivedAtMs >= migratedAt && chainTimestampMs >= migratedAt;
      return trade.pool === migrationPool && canonicalTime;
    });
    if (!profiles.length) return [];

    const decisions = profiles.map((profile) => {
      const evaluatedAt = profile.strictExecution ? finite(receivedAtMs, at) : at;
      const consensus = this._holdingConsensus(state, evaluatedAt, profile);
      let rejectionReason = consensus.rejectionReason;
      if (!(migratedAt > 0)) rejectionReason = 'MIGRATION_ANCHOR_MISSING';
      else if (profile.strictExecution
        && (typeof migrationPool !== 'string' || !migrationPool.trim())) {
        rejectionReason = 'MIGRATION_POOL_MISSING';
      }
      else if (!state.migrationObservedLive) rejectionReason = 'FIRST_AMM_EVENT_MISSED';
      if (profile.strictExecution) {
        const policy = strictAmm.freezePolicy(profile, this.config);
        rejectionReason = strictAmm.rejection(trade, { policy }, this.now()) || rejectionReason;
      }
      const status = rejectionReason ? 'REJECTED' : 'QUALIFIED';
      const registryVersion = consensus.votes.reduce(
        (maximum, vote) => Math.max(maximum, finite(vote.registryVersion, 0)),
        0,
      );
      return {
        profile, evaluatedAt, consensus, rejectionReason, status, registryVersion,
        evaluation: {
          entryProfileId: profile.id,
          mint: trade.mint,
          evaluatedAt,
          migratedAt: migratedAt ?? null,
          firstAmmAt: evaluatedAt,
          status,
          rejectionReason,
          requiredClusters: consensus.required,
          distinctClusters: consensus.votes.length,
          eligibleWallets: consensus.eligibleWallets,
          selectionAClusters: consensus.selectionA,
          weightedScore: consensus.weightedScore,
          clusterVotesJson: JSON.stringify(consensus.votes),
          registryVersion,
          createdAt: this.now(),
        },
      };
    });

    const forwardStudy = this.config.forwardHoldingStudy;
    const forwardEntryIds = Array.isArray(forwardStudy?.entryProfileIds)
      ? forwardStudy.entryProfileIds : [];
    const forwardExitIds = Array.isArray(forwardStudy?.exitProfileIds)
      ? forwardStudy.exitProfileIds : [];
    const matrixDecisions = decisions.filter(decision => (
      decision.profile.studyVersion === forwardStudy?.version
        && forwardEntryIds.includes(decision.profile.id)
    ));
    const matrixDecisionSet = new Set(matrixDecisions);
    const committed = [];
    this.store.db.transaction(() => {
      let skipExistingMatrix = false;
      if (matrixDecisions.length) {
        const completeEntrySet = matrixDecisions.length === forwardEntryIds.length
          && forwardEntryIds.every(id => matrixDecisions.some(row => row.profile.id === id));
        const placeholders = forwardEntryIds.map(() => '?').join(',');
        const existing = completeEntrySet ? this.store.db.prepare(`
          SELECT COUNT(*) n FROM smart_wallet_post_grad_holding_evaluations
          WHERE mint=? AND entry_profile_id IN (${placeholders})
        `).get(trade.mint, ...forwardEntryIds).n : 1;
        // A pre-existing/legacy partial matrix is never completed using a later
        // opportunity. The dashboard audit exposes it, while new writes remain
        // all-or-nothing and source-paired.
        skipExistingMatrix = !completeEntrySet || existing > 0;
      }
      for (const decision of decisions) {
        if (skipExistingMatrix && matrixDecisionSet.has(decision)) {
          committed.push({ ...decision, inserted: false, rows: [] });
          continue;
        }
        const result = this.insertHoldingEvaluation.run(decision.evaluation);
        if (!result.changes) {
          if (matrixDecisionSet.has(decision)) {
            throw new Error(`HOLD3 evaluation uniqueness race for ${decision.profile.id}`);
          }
          committed.push({ ...decision, inserted: false, rows: [] });
          continue;
        }
        const rows = decision.rejectionReason ? [] : this._recordSignal(
          trade, decision.profile, decision.consensus, decision.evaluatedAt, price,
          { deferCommit: true },
        );
        const expectedRows = decision.rejectionReason
          ? 0 : this._exitProfilesFor(decision.profile).length;
        if (rows.length !== expectedRows) {
          throw new Error(`Incomplete paired HOLD3 matrix for ${decision.profile.id}: `
            + `${rows.length}/${expectedRows}`);
        }
        committed.push({ ...decision, inserted: true, rows });
      }
      if (matrixDecisions.length && !skipExistingMatrix) {
        const qualificationStates = new Set(matrixDecisions.map(row => row.status));
        if (qualificationStates.size !== 1) {
          throw new Error('HOLD3 paired entries produced mixed qualification states');
        }
        if (matrixDecisions[0].status === 'QUALIFIED') {
          const matrixRows = committed.filter(row => (
            row.profile.studyVersion === forwardStudy.version
              && forwardEntryIds.includes(row.profile.id)
          ))
            .flatMap(row => row.rows);
          const expectedPairs = new Set(forwardEntryIds.flatMap(entryId => (
            forwardExitIds.map(exitId => `${entryId}\u0000${exitId}`)
          )));
          const actualPairs = new Set(matrixRows.map(row => (
            `${row.entryProfileId}\u0000${row.exitProfileId}`
          )));
          if (matrixRows.length !== expectedPairs.size || actualPairs.size !== expectedPairs.size
            || [...expectedPairs].some(pair => !actualPairs.has(pair))) {
            throw new Error(`Incomplete paired HOLD3 matrix: ${matrixRows.length}/${expectedPairs.size}`);
          }
        }
      }
    })();

    for (const decision of decisions) state.holdingEvaluatedProfiles.add(decision.profile.id);
    if (this.postGradHoldingProfiles.every(profile => (
      state.holdingEvaluatedProfiles.has(profile.id)
    ))) {
      state.firstAmmObservedAt ??= Math.max(
        ...decisions.map(decision => decision.evaluatedAt),
      );
    }
    const created = [];
    for (const decision of committed) {
      if (!decision.inserted) continue;
      this.metrics.firstAmmHoldingEvaluations += 1;
      if (decision.rejectionReason) {
        this.metrics.holdingConsensusRejected += 1;
        if (decision.rejectionReason === 'MIGRATION_ANCHOR_MISSING'
          || decision.rejectionReason === 'MIGRATION_POOL_MISSING'
          || decision.rejectionReason === 'FIRST_AMM_EVENT_MISSED') {
          this.metrics.migrationAnchorRejected += 1;
        }
        continue;
      }
      this.metrics.holdingConsensusQualified += 1;
      this.lastEpisodes.set(`${trade.mint}:${decision.profile.id}`, decision.evaluatedAt);
      this._commitSignalRows(decision.rows);
      if (decision.rows.rugLabelObserved) this.metrics.rugLabelsObserved += 1;
      created.push(...decision.rows);
    }
    if (created.length) {
      this.metrics.consensusSignals += committed.filter(row => row.rows.length).length;
      this.metrics.lastActionAt = this.now();
    }
    return created;
  }

  _exitProfilesFor(profile) {
    const allowed = new Set(profile?.exitProfileIds || []);
    return [...this.exitProfiles.values()].filter((exit) => (
      (!allowed.size || allowed.has(exit.id))
      && (!Array.isArray(exit.entryProfileIds) || exit.entryProfileIds.includes(profile.id))
    ));
  }

  _consensus(state, at, profile) {
    const rows = state.smartBuys.filter((row) => (
      row.timestampMs >= at - profile.consensusWindowMs && row.timestampMs <= at
    ));
    const byCluster = new Map();
    for (const row of rows) {
      const current = byCluster.get(row.clusterId);
      if (!current || row.weight > current.weight
        || (row.weight === current.weight && row.timestampMs < current.timestampMs)) {
        byCluster.set(row.clusterId, row);
      }
    }
    const allVotes = [...byCluster.values()]
      .sort((left, right) => left.timestampMs - right.timestampMs);
    const votes = profile.selectionGradeOnly
      ? allVotes.filter((row) => row.selectionGrade === profile.selectionGradeOnly)
      : allVotes;
    const thresholds = this._thresholdSnapshot(at);
    const required = finite(
      profile.requiredClusters,
      profile.strength === 'STRONG' ? thresholds.strong : thresholds.ordinary,
    );
    const selectionA = votes.filter((row) => row.selectionGrade === 'S_A').length;
    const copyA = votes.filter((row) => row.copyGrade === 'C_A').length;
    const weightedScore = votes.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
    const configuredRequiredA = finite(profile.minSelectionAClusters, 0);
    // Fail closed: pool growth must never silently turn a P_A requirement into
    // zero. Broad behavior is retained only in explicit research-control
    // profiles whose configuredRequiredA is intentionally zero.
    const requiredA = configuredRequiredA;
    if (votes.length < required || selectionA < requiredA
      || weightedScore < required * profile.minWeightedScoreRatio) return null;
    return { votes, thresholds, required, selectionA, copyA, weightedScore };
  }

  _recordSignal(event, profile, consensus, at, price, { deferCommit = false } = {}) {
    const token = this.store.getToken(event.mint);
    const graduatedAt = profile.postGraduationHoldingConsensus
      ? finite(token?.migrated_at ?? token?.migratedAt ?? at)
      : finite(token?.graduated_at ?? token?.graduatedAt);
    const rugLabel = this.rugRiskTracker?.snapshot
      ? this.rugRiskTracker.snapshot(event.mint, at) : null;
    if (rugLabel && !deferCommit) this.metrics.rugLabelsObserved += 1;
    const rows = [];
    rows.rugLabelObserved = Boolean(rugLabel);
    for (const exit of this._exitProfilesFor(profile)) {
      const strictPolicy = strictAmm.freezePolicy(profile, this.config, exit);
      const positionSol = strictPolicy ? finite(profile.positionSizeSol, this.config.positionSizeSol)
        : this.config.positionSizeSol;
      const strictCosts = strictPolicy ? costBreakdown({ ...this.config.costModel, ...profile.costModel,
        positionSizeSol: positionSol, priceImpactPct: 0 }) : null;
      const executionState = strictPolicy ? { strictExecution: {
        policy: strictPolicy, pool: event.pool, cursor: strictAmm.observation(event),
        entry: JSON.parse(JSON.stringify(profile)), exit: { ...exit },
        costs: strictCosts, feeConvention: 'ROUND_TRIP_ONCE',
        maxExitQuoteToMarketRatio: finite(this.config.maxExitQuoteToMarketRatio, 5),
      } } : {};
      if (profile.studyVersion) executionState.forwardStudy = {
        version: profile.studyVersion, forwardOnly: true,
        pairedOpportunityId: `${profile.studyVersion}:${event.mint}:${event.pool}:${event.slot}:${event.signature}:${event.eventIndex}`,
        signalReceivedAtMs: event.receivedAtMs,
        signalChainTimestampMs: event.chainTimestampMs,
        rugPolicy: 'LABEL_ONLY',
      };
      const episodeId = `${event.mint}:${profile.id}:${at}`;
      const directCurveEntry = profile.directCurveEntry === true && !graduatedAt;
      const directPostGraduationEntry = profile.postGraduationHoldingConsensus === true
        && profile.directPostGraduationEntry === true && Boolean(graduatedAt);
      const scoutFraction = directCurveEntry
        ? 1 : (graduatedAt ? 0 : finite(profile.scoutFraction, 0));
      const entryDelayMs = strictPolicy?.entryDelayMs ?? finite(profile.entryDelayMs, this.config.entryDelayMs);
      const entryTimeoutMs = strictPolicy?.entryTimeoutMs ?? finite(profile.entryTimeoutMs, this.config.entryTimeoutMs);
      const status = scoutFraction > 0 ? 'PENDING_SCOUT'
        : (directPostGraduationEntry ? 'SCALE_PENDING'
          : (graduatedAt ? 'WAITING_FLOW' : 'WAITING_GRADUATION'));
      const now = this.now();
      const result = this.insert.run({
        cohortId: `${profile.id}|${exit.id}`,
        entryProfileId: profile.id,
        exitProfileId: exit.id,
        episodeId,
        mint: event.mint,
        status,
        signalStrength: profile.strength,
        signalAt: at,
        signalMarket: event.market,
        signalPrice: price,
        signalCurvePct: finite(event.curvePct ?? event.curve_pct),
        requiredClusters: consensus.required,
        availableClusters: consensus.thresholds.eligible,
        distinctClusters: consensus.votes.length,
        selectionAClusters: consensus.selectionA,
        copyAClusters: consensus.copyA,
        weightedScore: consensus.weightedScore,
        clusterVotesJson: JSON.stringify(consensus.votes),
        registryVersion: consensus.votes.reduce(
          (maximum, vote) => Math.max(maximum, finite(vote.registryVersion, 0)),
          0,
        ),
        positionSol,
        scoutFraction,
        configuredCostPct: (strictCosts || this.costs).deterministicCostPct,
        rugLabelJson: rugLabel ? JSON.stringify(rugLabel) : null,
        graduatedAt,
        entryTargetAt: scoutFraction > 0 || directPostGraduationEntry
          ? (strictPolicy ? event.receivedAtMs : at) + entryDelayMs : null,
        entryDeadlineAt: scoutFraction > 0 || directPostGraduationEntry
          ? (strictPolicy ? event.receivedAtMs : at) + entryDelayMs + entryTimeoutMs : null,
        executionStateJson: JSON.stringify(executionState),
        createdAt: now,
        updatedAt: now,
      });
      if (!result.changes) continue;
      const row = this.store.db.prepare(`
        SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE id=?
      `).get(Number(result.lastInsertRowid));
      const position = rowToPosition(row);
      rows.push(position);
    }
    if (rows.length && !deferCommit) {
      this._commitSignalRows(rows);
      this.metrics.consensusSignals += 1;
      this.metrics.lastActionAt = this.now();
    }
    return rows;
  }

  _commitSignalRows(rows) {
    for (const position of rows) {
      this.positions.set(position.id, position);
      this._index(position);
    }
  }

  _observePosition(position, trade, at, price, state) {
    const strict = position.executionState.strictExecution;
    if (strict && !strictAmm.accept(trade, strict, this.now(), {
      notBeforeChainTimestampMs: position.strictRestoredAt,
    })) {
      this._saveStrictHeartbeat(position);
      return;
    }
    if (strict) at = trade.receivedAtMs;
    // A reserve-derived mark and its executable quote can share the same bad
    // event. Check against an earlier accepted observation before this event
    // can move a stop, inflate a peak, or supply an execution quote.
    if (!this._acceptExecutionObservation(position, trade, at, price)) {
      if (strict) this._saveStrictHeartbeat(position);
      else this._save(position);
      return;
    }
    position.lastObservedAt = at;
    position.lastMarket = trade.market;
    position.lastPrice = price;
    if (position.status === 'PENDING_SCOUT') {
      if (trade.market === 'PUMP_BONDING_CURVE' && at >= position.entryTargetAt
        && at <= position.entryDeadlineAt) {
        const profile = this._entryFor(position);
        this._buy(
          position,
          trade,
          price,
          position.positionSol * position.scoutFraction,
          profile?.directCurveEntry ? 'DIRECT' : 'SCOUT',
        );
      }
      return;
    }
    if (['SCOUT_OPEN', 'WAITING_FLOW'].includes(position.status)
      && position.graduatedAt && trade.market === 'PUMP_AMM') {
      const profile = this._entryFor(position);
      const features = this._flowFeatures(state, at, profile, position);
      if (this._flowQualified(features, profile, position, at)) {
        position.flowConfirmedAt = at;
        position.flowFeatures = features;
        position.status = 'SCALE_PENDING';
        position.entryTargetAt = at + (strict?.policy.entryDelayMs
          ?? finite(profile?.entryDelayMs, this.config.entryDelayMs));
        position.entryDeadlineAt = position.entryTargetAt
          + (strict?.policy.entryTimeoutMs ?? finite(profile?.entryTimeoutMs, this.config.entryTimeoutMs));
        this.metrics.flowConfirmed += 1;
        this._save(position);
      }
    }
    if (position.status === 'SCALE_PENDING' && trade.market === 'PUMP_AMM'
      && at >= position.entryTargetAt && at <= position.entryDeadlineAt) {
      if (strict && !strictAmm.afterTarget(trade, position.entryTargetAt)) {
        this._saveStrictHeartbeat(position);
        return;
      }
      const profile = this._entryFor(position);
      const remaining = Math.max(0, position.positionSol - position.capitalInSol);
      this._buy(
        position,
        trade,
        price,
        remaining,
        profile?.directPostGraduationEntry === true ? 'DIRECT' : 'SCALE',
      );
      return;
    }
    if (!['SCOUT_OPEN', 'OPEN', 'RUNNER', 'EXIT_PENDING'].includes(position.status)
      || !(position.tokenUnits > 0)) {
      if (strict) this._saveStrictHeartbeat(position);
      return;
    }
    this._capturePostGradSnapshot(position, trade, state, at, price);
    const markReturn = (price / position.entryPrice - 1) * 100;
    position.highestReturnPct = Math.max(position.highestReturnPct, markReturn);
    const exit = this._exitFor(position);
    if (position.status !== 'EXIT_PENDING' && exit.hardStopEnabled !== false
      && markReturn <= -Math.abs(exit.hardStopPct)) {
      this._requestExit(position, at, 'HARD_STOP', trade);
    } else if (position.status === 'SCOUT_OPEN'
      && finite(exit.scoutProtectActivationPct, Infinity) <= position.highestReturnPct) {
      const protectionFloor = Math.max(
        finite(exit.scoutProtectFloorPct, 0),
        position.highestReturnPct - finite(exit.scoutProtectTrailPct, Infinity),
      );
      if (markReturn <= protectionFloor) this._requestExit(position, at, 'SCOUT_PROTECT', trade);
    } else if (position.status === 'OPEN') {
      if (exit.mode === 'FIXED_HOLD' && at >= position.entryAt + exit.fixedHoldMs) {
        this._requestExit(position, at, 'FIXED_HOLD', trade);
      } else if (exit.mode === 'CORE_RUNNER'
        && markReturn >= exit.coreActivationPct && !position.coreSoldAt) {
        this._requestCoreExit(position, trade, at, exit);
      } else if (exit.mode === 'TRAILING'
        && position.highestReturnPct >= exit.trailingActivationPct) {
        const drawdownPct = (1 - (1 + markReturn / 100)
          / (1 + position.highestReturnPct / 100)) * 100;
        if (drawdownPct >= exit.trailingStopPct) {
          this._requestExit(position, at, 'TRAILING_STOP', trade);
        }
      }
    } else if (position.status === 'RUNNER') {
      const drawdown = position.highestReturnPct - markReturn;
      if (drawdown >= exit.runnerTrailPct) this._requestExit(position, at, 'RUNNER_TRAIL', trade);
    }
    const pendingCore = position.executionState.corePending;
    if (position.status === 'OPEN' && pendingCore
      && this._canExecuteAfter(pendingCore, trade, at)) {
      this._sellCore(position, trade, price, at, exit);
    }
    if (position.status === 'EXIT_PENDING' && this._canExecuteAfter({
      triggerAt: position.exitTriggerAt,
      targetAt: position.exitTargetAt,
      deadlineAt: position.exitDeadlineAt,
      signature: position.executionState.exitTriggerSignature,
    }, trade, at)) this._sellAll(position, trade, price, at);
    else if (strict) this._saveStrictHeartbeat(position);
    else this._save(position);
  }

  _acceptExecutionObservation(position, trade, at, price) {
    const execution = position.executionState || (position.executionState = {});
    execution.policyVersion = 'CAUSAL_CORE_POOL_V2';
    const observation = {
      at, price, market: trade.market, pool: trade.pool || null,
      signature: trade.signature || null, eventIndex: trade.eventIndex ?? null,
    };
    // Old rows have no verified pool/quote state. An entry price is a bounded
    // fallback reference, not proof of pool identity or historical validity.
    const reference = execution.reference || ((position.entryPrice || position.signalPrice) > 0 ? {
      at: position.entryAt || position.signalAt,
      price: position.entryPrice || position.signalPrice,
      market: position.entryMarket || position.signalMarket, pool: null, signature: null,
    } : null);
    let reason = null;
    if (reference && at < reference.at) reason = 'OUT_OF_ORDER_QUOTE';
    else if (reference?.market === 'PUMP_AMM' && trade.market !== 'PUMP_AMM') {
      reason = 'EXIT_MARKET_REGRESSION';
    } else if (reference?.market === 'PUMP_AMM' && trade.market === 'PUMP_AMM'
      && reference.pool && reference.pool !== observation.pool) {
      reason = observation.pool ? 'EXIT_POOL_MISMATCH' : 'EXIT_POOL_UNVERIFIED';
      this.metrics.incompatiblePoolQuotes += 1;
    }
    if (reason) {
      execution.lastRejected = { ...observation, reason };
      return false;
    }
    const maxStepRatio = Math.max(1, execution.strictExecution?.maxExitQuoteToMarketRatio
      ?? finite(this.config.maxExitQuoteToMarketRatio, 5));
    if (reference?.price > 0 && price / reference.price > maxStepRatio) {
      const candidate = execution.candidate;
      const exit = this._exitFor(position);
      const delayMs = Math.max(1, execution.strictExecution?.policy.exitDelayMs
        ?? finite(exit?.exitDelayMs, finite(this.config.exitDelayMs, 200)));
      const timeoutMs = Math.max(delayMs, finite(
        execution.strictExecution?.policy.exitTimeoutMs ?? exit?.exitTimeoutMs,
        finite(this.config.exitTimeoutMs, 5_000),
      ));
      const agrees = candidate && candidate.market === observation.market
        && candidate.pool === observation.pool
        && Math.abs(price / candidate.price - 1) <= 0.2;
      const independent = agrees && candidate.signature && observation.signature
        && candidate.signature !== observation.signature;
      if (!(independent && at >= candidate.at + delayMs
        && at <= candidate.at + timeoutMs)) {
        // Never let another event from the same signature confirm a jump.
        // Missing signatures cannot confirm a jump. A missing pool remains
        // explicitly unknown in the saved reference; time/price confirmation
        // does not establish pool identity. Trade size is not a capacity cap.
        if (!agrees || at > candidate.at + timeoutMs) execution.candidate = observation;
        execution.lastRejected = { ...observation, reason: 'UNCONFIRMED_UPWARD_QUOTE_JUMP' };
        this.metrics.unconfirmedQuoteJumps += 1;
        return false;
      }
    }
    execution.reference = observation;
    execution.candidate = null;
    return true;
  }

  _canExecuteAfter(pending, trade, at) {
    if (!(at > pending.triggerAt && at >= pending.targetAt && at <= pending.deadlineAt)) {
      return false;
    }
    if (pending.signature) return Boolean(trade.signature && pending.signature !== trade.signature);
    return pending.requireIndependentSignature !== true;
  }

  _requestCoreExit(position, trade, at, exit) {
    const execution = position.executionState;
    if (execution.corePending || position.coreSoldAt) return;
    const delayMs = Math.max(0, finite(exit?.exitDelayMs, finite(this.config.exitDelayMs, 200)));
    const timeoutMs = Math.max(0, finite(exit?.exitTimeoutMs, finite(this.config.exitTimeoutMs, 5_000)));
    execution.corePending = {
      triggerAt: at, targetAt: at + delayMs, deadlineAt: at + delayMs + timeoutMs,
      signature: trade.signature || null, requireIndependentSignature: true,
    };
    this.metrics.coreExitRequested += 1;
  }

  _buy(position, trade, price, sol, leg) {
    if (!(sol > 0)) return false;
    const strict = position.executionState.strictExecution;
    if (strict && !strictAmm.afterTarget(trade, position.entryTargetAt)) return false;
    const quote = strict ? strictAmm.buy(trade, sol, price) : executableBuy(trade, sol, price);
    if (!quote.available || !(quote.tokenUnits > 0)) {
      if (strict) { strict.lastExecutionRejection = { at: this.now(), reason: quote.reason };
        this._saveStrictHeartbeat(position); }
      return false;
    }
    position.capitalInSol += sol;
    position.tokenUnits += quote.tokenUnits;
    position.entryTxCount += 1;
    position.entryAt = position.entryAt || (strict ? trade.receivedAtMs : trade.timestampMs);
    position.entryMarket = trade.market;
    position.entryPrice = position.capitalInSol / position.tokenUnits;
    position.highestReturnPct = Math.max(0, (price / position.entryPrice - 1) * 100);
    if (leg === 'SCOUT') {
      position.status = 'SCOUT_OPEN';
      this.metrics.scoutOpened += 1;
    } else {
      position.status = 'OPEN';
      this.metrics.scaled += 1;
      if (leg === 'DIRECT') this.metrics.directOpened += 1;
    }
    this.metrics.lastActionAt = this.now();
    this._save(position);
    return true;
  }

  _flowFeatures(state, at, profile = null, position = null) {
    const windowMs = Math.max(1, finite(profile?.flowWindowMs, this.config.flowWindowMs));
    const cumulative = profile?.cumulativePostGraduationFlow === true;
    const startAt = cumulative
      ? Math.max(at - windowMs, finite(position?.signalAt, at - windowMs))
      : at - windowMs;
    const strict = position?.executionState?.strictExecution;
    const observedAt = (row) => strict
      ? finite(row.receivedAtMs) : finite(row.timestampMs);
    const rows = state.trades.filter((row) => row.market === 'PUMP_AMM'
      && !row.registeredWallet && observedAt(row) >= startAt
      && observedAt(row) <= at
      && (!strict || (row.strictFlowAccepted && row.pool === strict.pool
        && (!position.strictRestoredAt || row.chainTimestampMs >= position.strictRestoredAt))));
    const splitAt = at - windowMs / 2;
    const summarize = (sample) => {
      const buys = sample.filter((row) => row.side === 'BUY');
      const sells = sample.filter((row) => row.side === 'SELL');
      const transactionCount = (events) => {
        const signatures = new Set();
        let unidentified = 0;
        for (const event of events) {
          if (event.signature) signatures.add(event.signature);
          else unidentified += 1;
        }
        return signatures.size + unidentified;
      };
      const buyFlow = buys.reduce((sum, row) => sum + row.solAmount, 0);
      const sellFlow = sells.reduce((sum, row) => sum + row.solAmount, 0);
      const grossFlow = buyFlow + sellFlow;
      const netFlow = buyFlow - sellFlow;
      return {
        buyers: new Set(buys.map((row) => row.wallet).filter(Boolean)).size,
        buyTx: transactionCount(buys),
        sellTx: transactionCount(sells),
        buyFlowSol: buyFlow,
        sellFlowSol: sellFlow,
        grossFlowSol: grossFlow,
        netFlowSol: netFlow,
        netFlowSharePct: grossFlow > 0 ? netFlow / grossFlow * 100 : 0,
      };
    };
    return {
      windowMs,
      cumulative,
      current: summarize(cumulative ? rows : rows.filter((row) => observedAt(row) >= splitAt)),
      previous: summarize(cumulative ? [] : rows.filter((row) => observedAt(row) < splitAt)),
    };
  }

  _flowQualified(features, profile, position, at) {
    const minFlowNetSol = finite(profile?.minFlowNetSol, this.config.minFlowNetSol);
    const minFlowBuyers = finite(profile?.minFlowBuyers, this.config.minFlowBuyers);
    const minFlowBuyTx = finite(profile?.minFlowBuyTx, this.config.minFlowBuyTx);
    const positiveFlowQualified = profile?.requirePositiveFlow === true
      ? features.current.netFlowSol > 0
      : features.current.netFlowSol >= minFlowNetSol;
    const accelerationQualified = profile?.requireFlowAcceleration === false
      || features.current.buyTx > features.previous.buyTx;
    const baseQualified = positiveFlowQualified
      && features.current.netFlowSol >= minFlowNetSol
      && features.current.buyers >= minFlowBuyers
      && features.current.buyTx >= minFlowBuyTx
      && accelerationQualified;
    if (!baseQualified || profile?.flowGate !== 'STRICT') return baseQualified;
    return features.current.netFlowSol >= this.config.strictMinFlowNetSol
      && features.current.netFlowSharePct >= this.config.strictMinFlowNetSharePct
      && at <= position.graduatedAt + this.config.strictMaxFlowConfirmationDelayMs;
  }

  _capturePostGradSnapshot(position, trade, state, at, price) {
    const profile = this._entryFor(position);
    const exit = this._exitFor(position);
    if (profile?.directPostGraduationEntry !== true || trade.market !== 'PUMP_AMM'
      || finite(exit?.maxHoldMs, 0) < 30 * 60_000
      || !this.postGradSnapshotHorizonsMs.length) return;
    const features = position.flowFeatures && position.flowFeatures.kind === 'POST_GRAD_SNAPSHOTS'
      ? position.flowFeatures
      : { kind: 'POST_GRAD_SNAPSHOTS', snapshots: {} };
    let changed = false;
    for (const horizonMs of this.postGradSnapshotHorizonsMs) {
      if (features.snapshots[String(horizonMs)] || at < position.signalAt + horizonMs) continue;
      const flow = this._flowFeatures(state, at, {
        flowWindowMs: horizonMs,
        cumulativePostGraduationFlow: true,
      }, position);
      const holdings = this._holdingVotes(state, at);
      features.snapshots[String(horizonMs)] = {
        observedAt: at,
        markReturnPct: position.entryPrice > 0 ? (price / position.entryPrice - 1) * 100 : null,
        publicFlow: flow.current,
        qualifiedHoldingClusters: holdings.length,
        qualifiedHoldingWallets: holdings.reduce((sum, row) => sum + row.walletCount, 0),
        observedSmartHoldingWallets: [...state.smartHoldings.values()]
          .filter((row) => row.tokenBalanceAfter > 0 && row.timestampMs <= at).length,
      };
      changed = true;
    }
    if (changed) position.flowFeatures = features;
  }

  _maxFlowWaitMs(position) {
    const profile = this._entryFor(position);
    if (Number.isFinite(profile?.maxFlowWaitMs)) return profile.maxFlowWaitMs;
    return profile?.flowGate === 'STRICT'
      ? Math.min(this.config.maxFlowWaitMs, this.config.strictMaxFlowConfirmationDelayMs)
      : this.config.maxFlowWaitMs;
  }

  _sellCore(position, trade, price, at, exit) {
    const pending = position.executionState?.corePending;
    if (!pending || !this._canExecuteAfter(pending, trade, at)) return false;
    const units = position.tokenUnits * exit.coreFraction;
    const quote = executableSell(trade, units, price, {
      maxQuoteToMarketRatio: finite(this.config.maxExitQuoteToMarketRatio, 5),
    });
    if (!quote.available || !(quote.proceedsSol >= 0)) {
      if (quote.reason === 'EXIT_CAPACITY_QUOTE_MARK_PRICE_MISMATCH') {
        this.metrics.invalidExitQuotes += 1;
      }
      return false;
    }
    position.tokenUnits -= units;
    position.runnerUnits = position.tokenUnits;
    position.coreProceedsSol += quote.proceedsSol;
    position.coreSoldAt = at;
    position.exitTxCount += 1;
    position.status = 'RUNNER';
    position.executionState.corePending = null;
    this.metrics.coreSold += 1;
    this._save(position);
    return true;
  }

  _requestExit(position, at, reason, trade = null) {
    if (position.status === 'EXIT_PENDING') return;
    const exit = this._exitFor(position);
    const strict = position.executionState.strictExecution;
    const exitDelayMs = strict?.policy.exitDelayMs ?? finite(exit?.exitDelayMs, this.config.exitDelayMs);
    const exitTimeoutMs = strict?.policy.exitTimeoutMs ?? finite(exit?.exitTimeoutMs, this.config.exitTimeoutMs);
    position.status = 'EXIT_PENDING';
    position.exitTriggerAt = at;
    position.exitTargetAt = at + exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + exitTimeoutMs;
    position.exitReason = reason;
    const execution = position.executionState || (position.executionState = {});
    if (execution.corePending) {
      execution.cancelledCore = { ...execution.corePending, cancelledAt: at, reason };
      execution.corePending = null;
    }
    execution.exitTriggerSignature = trade?.signature || null;
    this._save(position);
  }

  _sellAll(position, trade, price, at) {
    const strict = position.executionState.strictExecution;
    if (strict && !strictAmm.afterTarget(trade, position.exitTargetAt)) return false;
    const markReturn = (price / position.entryPrice - 1) * 100;
    const quote = strict ? strictAmm.sell(trade, position.tokenUnits, price)
      : executableSell(trade, position.tokenUnits, price, {
      rugMarkReturnPct: markReturn,
      maxQuoteToMarketRatio: finite(this.config.maxExitQuoteToMarketRatio, 5),
    });
    if (quote.reason === 'EXIT_CAPACITY_QUOTE_MARK_PRICE_MISMATCH') {
      this.metrics.invalidExitQuotes += 1;
    }
    if (!quote.available && (strict || !quote.conservative)) {
      if (strict) { strict.lastExecutionRejection = { at: this.now(), reason: quote.reason };
        this._saveStrictHeartbeat(position); }
      return false;
    }
    const remainingProceeds = finite(quote.proceedsSol, 0);
    position.exitTxCount += 1;
    const totalProceeds = position.coreProceedsSol + remainingProceeds;
    const gross = position.capitalInSol > 0
      ? (totalProceeds / position.capitalInSol - 1) * 100 : null;
    const estimatedCostSol = this._estimatedCostSol(position);
    const net = gross == null ? null : gross - estimatedCostSol / position.capitalInSol * 100;
    this.close.run({
      id: position.id,
      status: 'CLOSED',
      exitTxCount: position.exitTxCount,
      exitAt: at,
      exitMarket: trade.market,
      exitPrice: finite(quote.price, 0),
      exitReason: position.exitReason,
      grossReturnPct: gross,
      netReturnPct: net,
      estimatedCostSol,
      executionStateJson: JSON.stringify(position.executionState || {}),
      updatedAt: this.now(),
    });
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
    this._remove(position);
    return true;
  }

  _estimatedCostSol(position) {
    const costs = position.executionState.strictExecution?.costs || this.costs;
    const variablePct = costs.platformFeePct + costs.buySlippagePct
      + costs.sellSlippagePct + costs.priceImpactPct;
    const txCount = Math.max(2, position.entryTxCount + position.exitTxCount);
    // The frozen micro-size model supplies round-trip fees, not per-leg fees.
    // These strict studies have exactly one buy and one full-size sell.
    if (position.executionState.strictExecution) {
      return position.capitalInSol * variablePct / 100 + costs.totalFixedCostSol;
    }
    return position.capitalInSol * variablePct / 100 + txCount * costs.totalFixedCostSol;
  }

  _finishWithoutPosition(position, status, reason) {
    this.close.run({
      id: position.id,
      status,
      exitTxCount: position.exitTxCount,
      exitAt: null,
      exitMarket: null,
      exitPrice: null,
      exitReason: reason,
      grossReturnPct: null,
      netReturnPct: null,
      estimatedCostSol: position.capitalInSol > 0 ? this._estimatedCostSol(position) : 0,
      executionStateJson: JSON.stringify(position.executionState || {}),
      updatedAt: this.now(),
    });
    this.metrics.noEntry += 1;
    this._remove(position);
  }

  _closeNoExit(position, reason) {
    this.close.run({
      id: position.id,
      status: 'NO_EXIT',
      exitTxCount: position.exitTxCount,
      exitAt: null,
      exitMarket: null,
      exitPrice: null,
      exitReason: reason,
      grossReturnPct: null,
      netReturnPct: null,
      estimatedCostSol: this._estimatedCostSol(position),
      executionStateJson: JSON.stringify(position.executionState || {}),
      updatedAt: this.now(),
    });
    this.metrics.noExit += 1;
    this._remove(position);
  }

  _closeRightCensored(position, reason, { countMetric = true } = {}) {
    const at = this.now();
    const execution = position.executionState || (position.executionState = {});
    execution.censoring = { reason, at, rightCensored: true };
    this.close.run({
      id: position.id,
      status: 'RIGHT_CENSORED',
      exitTxCount: position.exitTxCount,
      exitAt: null,
      exitMarket: null,
      exitPrice: null,
      exitReason: reason,
      grossReturnPct: null,
      netReturnPct: null,
      estimatedCostSol: position.capitalInSol > 0 ? this._estimatedCostSol(position) : 0,
      executionStateJson: JSON.stringify(execution),
      updatedAt: at,
    });
    if (countMetric) this.metrics.restartCensored += 1;
  }

  _exitFor(position) {
    return position.executionState.strictExecution?.exit || this.exitProfiles.get(position.exitProfileId);
  }

  _entryFor(position) {
    return position.executionState.strictExecution?.entry || this.entryProfiles.get(position.entryProfileId);
  }

  _saveStrictHeartbeat(position) {
    if (this.now() - (position.strictSavedAt || 0) >= 1_000
      || position.highestReturnPct > (position.strictSavedPeak ?? -Infinity)) this._save(position);
  }

  _save(position) {
    this.update.run({
      id: position.id,
      status: position.status,
      graduatedAt: position.graduatedAt ?? null,
      flowConfirmedAt: position.flowConfirmedAt ?? null,
      flowFeaturesJson: position.flowFeatures ? JSON.stringify(position.flowFeatures) : null,
      entryTargetAt: position.entryTargetAt ?? null,
      entryDeadlineAt: position.entryDeadlineAt ?? null,
      capitalInSol: position.capitalInSol,
      tokenUnits: position.tokenUnits,
      entryTxCount: position.entryTxCount,
      exitTxCount: position.exitTxCount,
      entryAt: position.entryAt ?? null,
      entryMarket: position.entryMarket ?? null,
      entryPrice: position.entryPrice ?? null,
      coreSoldAt: position.coreSoldAt ?? null,
      coreProceedsSol: position.coreProceedsSol,
      runnerUnits: position.runnerUnits,
      highestReturnPct: position.highestReturnPct,
      lastObservedAt: position.lastObservedAt ?? null,
      lastMarket: position.lastMarket ?? null,
      lastPrice: position.lastPrice ?? null,
      exitTriggerAt: position.exitTriggerAt ?? null,
      exitTargetAt: position.exitTargetAt ?? null,
      exitDeadlineAt: position.exitDeadlineAt ?? null,
      exitReason: position.exitReason ?? null,
      executionStateJson: JSON.stringify(position.executionState || {}),
      updatedAt: this.now(),
    });
    if (position.executionState.strictExecution) {
      position.strictSavedAt = this.now();
      position.strictSavedPeak = position.highestReturnPct;
    }
  }

  _index(position) {
    const bucket = this.rowsByMint.get(position.mint) || new Set();
    bucket.add(position.id);
    this.rowsByMint.set(position.mint, bucket);
  }

  _remove(position) {
    this.positions.delete(position.id);
    const bucket = this.rowsByMint.get(position.mint);
    bucket?.delete(position.id);
    if (bucket && !bucket.size) this.rowsByMint.delete(position.mint);
  }
}

module.exports = { SmartWalletConsensusFlowRunnerShadowSuite };
