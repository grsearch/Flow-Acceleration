'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
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
    this.maxConsensusWindowMs = Math.max(0, ...(config.entryProfiles || [])
      .map((row) => finite(row.consensusWindowMs, 0)));
    this.states = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.lastEpisodes = new Map();
    this.metrics = {
      observedTrades: 0,
      observedSmartOpens: 0,
      consensusSignals: 0,
      scoutOpened: 0,
      directOpened: 0,
      flowConfirmed: 0,
      scaled: 0,
      coreSold: 0,
      closed: 0,
      noEntry: 0,
      noExit: 0,
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
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_consensus_flow_runner_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id, mint, status,
        signal_strength, signal_at, signal_market, signal_price, signal_curve_pct,
        required_clusters, available_clusters, distinct_clusters,
        selection_a_clusters, copy_a_clusters, weighted_score, cluster_votes_json,
        registry_version, position_sol, scout_fraction, configured_cost_pct,
        rug_label_json, graduated_at, entry_target_at, entry_deadline_at,
        created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId, @mint, @status,
        @signalStrength, @signalAt, @signalMarket, @signalPrice, @signalCurvePct,
        @requiredClusters, @availableClusters, @distinctClusters,
        @selectionAClusters, @copyAClusters, @weightedScore, @clusterVotesJson,
        @registryVersion, @positionSol, @scoutFraction, @configuredCostPct,
        @rugLabelJson, @graduatedAt, @entryTargetAt, @entryDeadlineAt,
        @createdAt, @updatedAt
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
        updated_at=@updatedAt
      WHERE id=@id
    `);
    this.close = this.store.db.prepare(`
      UPDATE smart_wallet_consensus_flow_runner_shadow_positions SET
        status=@status, exit_tx_count=@exitTxCount, exit_at=@exitAt,
        exit_market=@exitMarket, exit_price=@exitPrice, exit_reason=@exitReason,
        gross_return_pct=@grossReturnPct, net_return_pct=@netReturnPct,
        estimated_cost_sol=@estimatedCostSol, updated_at=@updatedAt
      WHERE id=@id
    `);
  }

  start() {
    if (!this.config.enabled) return;
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    const rows = this.store.db.prepare(`
      SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions
      WHERE status IN (${placeholders}) ORDER BY signal_at, id
    `).all(...ACTIVE_STATUSES);
    for (const row of rows) {
      const position = rowToPosition(row);
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
    this.advanceTime(this.now());
  }

  stop() {}

  trackedMints() { return [...this.rowsByMint.keys()]; }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SMART_CONSENSUS_FLOW_RUNNER_V2',
      observerOnly: true,
      sendsTransactions: false,
      rugPolicy: 'OBSERVE_ONLY_NOT_AN_ENTRY_FILTER',
      activePositions: this.positions.size,
      trackedMints: this.rowsByMint.size,
      dynamicThresholds: this._thresholdSnapshot(this.now()),
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      table: 'smart_wallet_consensus_flow_runner_shadow_positions',
      ...this.metrics,
    };
  }

  dashboard(limit = 100) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    return {
      ...this.health(),
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
          SUM(CASE WHEN status='NO_EXIT' THEN 1 ELSE 0 END) censored,
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
      recent: this.store.db.prepare(`
        SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions
        ORDER BY signal_at DESC, id DESC LIMIT ?
      `).all(capped),
    };
  }

  onSmartWalletEvent(event, {
    replay = false, walletSnapshot = null, persist = true,
  } = {}) {
    if (!this.config.enabled || replay || !event?.mint || !event?.wallet
      || String(event.side || '').toUpperCase() !== 'BUY'
      || String(event.positionPhase || event.position_phase || '').toUpperCase() !== 'OPEN') return [];
    const timestampMs = finite(event.timestampMs ?? event.timestamp_ms);
    const price = tradePrice(event);
    const snapshot = walletSnapshot
      || (typeof this.registry.cachedWalletSnapshot === 'function'
        ? this.registry.cachedWalletSnapshot(event.wallet, timestampMs)
        : this.registry.walletSnapshot(event.wallet, timestampMs));
    if (!(timestampMs > 0) || !(price > 0) || !snapshot) return [];
    if (persist) persistVotingSnapshot(this.store, event, snapshot, this.now());
    const state = this._state(event.mint);
    this._rememberSmartOpen(event, snapshot);
    const created = [];
    for (const profile of this.entryProfiles.values()) {
      if (profile.enabled === false || !this._profileAcceptsSignal(profile, event, state)) continue;
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
    const price = tradePrice(trade);
    if (!(timestampMs > 0) || !(price > 0)) return;
    this.advanceTime(timestampMs);
    const state = this._state(trade.mint);
    state.lastAt = Math.max(state.lastAt, timestampMs);
    state.trades.push({
      timestampMs,
      market: trade.market,
      side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      registeredWallet: Boolean(trade.wallet && (
        typeof this.registry.cachedMonitoringSnapshot === 'function'
          ? this.registry.cachedMonitoringSnapshot(trade.wallet, timestampMs)
          : this.registry.monitoringSnapshot(trade.wallet, timestampMs)
      )),
    });
    this._prune(state, timestampMs);
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.positions.get(id);
      if (position) this._observePosition(position, trade, timestampMs, price, state);
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
        && now > position.graduatedAt + this._maxFlowWaitMs(position)) {
        if (position.tokenUnits > 0) this._requestExit(position, now, 'FLOW_CONFIRM_TIMEOUT');
        else this._finishWithoutPosition(position, 'NO_ENTRY', 'FLOW_CONFIRM_TIMEOUT');
      } else if (position.status === 'SCALE_PENDING' && now > position.entryDeadlineAt) {
        if (position.tokenUnits > 0) this._requestExit(position, now, 'SCALE_ENTRY_TIMEOUT');
        else this._finishWithoutPosition(position, 'NO_ENTRY', 'POST_FLOW_ENTRY_TIMEOUT');
      } else if (position.status === 'EXIT_PENDING' && now > position.exitDeadlineAt) {
        this._closeNoExit(position, 'NO_EXIT_QUOTE');
      } else if (['OPEN', 'RUNNER'].includes(position.status)) {
        const exit = this.exitProfiles.get(position.exitProfileId);
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
        smartBuys: [], trades: [], lastAt: 0,
        graduatedAt: finite(token?.graduated_at ?? token?.graduatedAt),
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _prune(state, at) {
    const smartCutoff = at - this.maxConsensusWindowMs;
    const flowCutoff = at - Math.max(this.config.flowWindowMs, this.maxConsensusWindowMs);
    while (state.smartBuys.length && state.smartBuys[0].timestampMs < smartCutoff) {
      state.smartBuys.shift();
    }
    while (state.trades.length && state.trades[0].timestampMs < flowCutoff) {
      state.trades.shift();
    }
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
    if (!profile?.directCurveEntry) return true;
    const curvePct = finite(event.curvePct ?? event.curve_pct);
    const market = String(event.market || '').toUpperCase();
    return !state?.graduatedAt
      && market === 'PUMP_BONDING_CURVE'
      && curvePct != null
      && curvePct >= finite(profile.minCurvePct, 0)
      && curvePct < finite(profile.maxCurvePct, 100);
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
    const votes = [...byCluster.values()].sort((left, right) => left.timestampMs - right.timestampMs);
    const thresholds = this._thresholdSnapshot(at);
    const required = finite(
      profile.requiredClusters,
      profile.strength === 'STRONG' ? thresholds.strong : thresholds.ordinary,
    );
    const selectionA = votes.filter((row) => row.selectionGrade === 'S_A').length;
    const copyA = votes.filter((row) => row.copyGrade === 'C_A').length;
    const weightedScore = votes.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
    const configuredRequiredA = finite(profile.minSelectionAClusters, 0);
    const requiredA = thresholds.eligible >= this.config.enforceAGradeAfterClusters
      && thresholds.selectionA >= configuredRequiredA ? configuredRequiredA : 0;
    if (votes.length < required || selectionA < requiredA
      || weightedScore < required * profile.minWeightedScoreRatio) return null;
    return { votes, thresholds, required, selectionA, copyA, weightedScore };
  }

  _recordSignal(event, profile, consensus, at, price) {
    const token = this.store.getToken(event.mint);
    const graduatedAt = finite(token?.graduated_at ?? token?.graduatedAt);
    const rugLabel = this.rugRiskTracker?.snapshot
      ? this.rugRiskTracker.snapshot(event.mint, at) : null;
    if (rugLabel) this.metrics.rugLabelsObserved += 1;
    const rows = [];
    for (const exit of this._exitProfilesFor(profile)) {
      const episodeId = `${event.mint}:${profile.id}:${at}`;
      const directCurveEntry = profile.directCurveEntry === true && !graduatedAt;
      const scoutFraction = directCurveEntry
        ? 1 : (graduatedAt ? 0 : finite(profile.scoutFraction, 0));
      const status = scoutFraction > 0 ? 'PENDING_SCOUT'
        : (graduatedAt ? 'WAITING_FLOW' : 'WAITING_GRADUATION');
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
        positionSol: this.config.positionSizeSol,
        scoutFraction,
        configuredCostPct: this.costs.deterministicCostPct,
        rugLabelJson: rugLabel ? JSON.stringify(rugLabel) : null,
        graduatedAt,
        entryTargetAt: scoutFraction > 0 ? at + this.config.entryDelayMs : null,
        entryDeadlineAt: scoutFraction > 0
          ? at + this.config.entryDelayMs + this.config.entryTimeoutMs : null,
        createdAt: now,
        updatedAt: now,
      });
      if (!result.changes) continue;
      const row = this.store.db.prepare(`
        SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE id=?
      `).get(Number(result.lastInsertRowid));
      const position = rowToPosition(row);
      this.positions.set(position.id, position);
      this._index(position);
      rows.push(position);
    }
    if (rows.length) {
      this.metrics.consensusSignals += 1;
      this.metrics.lastActionAt = this.now();
    }
    return rows;
  }

  _observePosition(position, trade, at, price, state) {
    position.lastObservedAt = at;
    position.lastMarket = trade.market;
    position.lastPrice = price;
    if (position.status === 'PENDING_SCOUT') {
      if (trade.market === 'PUMP_BONDING_CURVE' && at >= position.entryTargetAt
        && at <= position.entryDeadlineAt) {
        const profile = this.entryProfiles.get(position.entryProfileId);
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
      const features = this._flowFeatures(state, at);
      const profile = this.entryProfiles.get(position.entryProfileId);
      if (this._flowQualified(features, profile, position, at)) {
        position.flowConfirmedAt = at;
        position.flowFeatures = features;
        position.status = 'SCALE_PENDING';
        position.entryTargetAt = at + this.config.entryDelayMs;
        position.entryDeadlineAt = position.entryTargetAt + this.config.entryTimeoutMs;
        this.metrics.flowConfirmed += 1;
        this._save(position);
      }
    }
    if (position.status === 'SCALE_PENDING' && trade.market === 'PUMP_AMM'
      && at >= position.entryTargetAt && at <= position.entryDeadlineAt) {
      const remaining = Math.max(0, position.positionSol - position.capitalInSol);
      this._buy(position, trade, price, remaining, 'SCALE');
      return;
    }
    if (!['SCOUT_OPEN', 'OPEN', 'RUNNER', 'EXIT_PENDING'].includes(position.status)
      || !(position.tokenUnits > 0)) return;
    const markReturn = (price / position.entryPrice - 1) * 100;
    position.highestReturnPct = Math.max(position.highestReturnPct, markReturn);
    const exit = this.exitProfiles.get(position.exitProfileId);
    if (position.status !== 'EXIT_PENDING' && markReturn <= -Math.abs(exit.hardStopPct)) {
      this._requestExit(position, at, 'HARD_STOP');
    } else if (position.status === 'SCOUT_OPEN'
      && finite(exit.scoutProtectActivationPct, Infinity) <= position.highestReturnPct) {
      const protectionFloor = Math.max(
        finite(exit.scoutProtectFloorPct, 0),
        position.highestReturnPct - finite(exit.scoutProtectTrailPct, Infinity),
      );
      if (markReturn <= protectionFloor) this._requestExit(position, at, 'SCOUT_PROTECT');
    } else if (position.status === 'OPEN') {
      if (exit.mode === 'FIXED_HOLD' && at >= position.entryAt + exit.fixedHoldMs) {
        this._requestExit(position, at, 'FIXED_HOLD');
      } else if (exit.mode === 'CORE_RUNNER'
        && markReturn >= exit.coreActivationPct && !position.coreSoldAt) {
        this._sellCore(position, trade, price, at, exit);
      }
    } else if (position.status === 'RUNNER') {
      const drawdown = position.highestReturnPct - markReturn;
      if (drawdown >= exit.runnerTrailPct) this._requestExit(position, at, 'RUNNER_TRAIL');
    }
    if (position.status === 'EXIT_PENDING' && at >= position.exitTargetAt
      && at <= position.exitDeadlineAt) this._sellAll(position, trade, price, at);
    else this._save(position);
  }

  _buy(position, trade, price, sol, leg) {
    if (!(sol > 0)) return false;
    const quote = executableBuy(trade, sol, price);
    if (!quote.available || !(quote.tokenUnits > 0)) return false;
    position.capitalInSol += sol;
    position.tokenUnits += quote.tokenUnits;
    position.entryTxCount += 1;
    position.entryAt = position.entryAt || trade.timestampMs;
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

  _flowFeatures(state, at) {
    const rows = state.trades.filter((row) => row.market === 'PUMP_AMM'
      && !row.registeredWallet && row.timestampMs >= at - this.config.flowWindowMs
      && row.timestampMs <= at);
    const splitAt = at - this.config.flowWindowMs / 2;
    const summarize = (sample) => {
      const buys = sample.filter((row) => row.side === 'BUY');
      const sells = sample.filter((row) => row.side === 'SELL');
      const buyFlow = buys.reduce((sum, row) => sum + row.solAmount, 0);
      const sellFlow = sells.reduce((sum, row) => sum + row.solAmount, 0);
      const grossFlow = buyFlow + sellFlow;
      const netFlow = buyFlow - sellFlow;
      return {
        buyers: new Set(buys.map((row) => row.wallet).filter(Boolean)).size,
        buyTx: buys.length,
        sellTx: sells.length,
        buyFlowSol: buyFlow,
        sellFlowSol: sellFlow,
        grossFlowSol: grossFlow,
        netFlowSol: netFlow,
        netFlowSharePct: grossFlow > 0 ? netFlow / grossFlow * 100 : 0,
      };
    };
    return {
      windowMs: this.config.flowWindowMs,
      current: summarize(rows.filter((row) => row.timestampMs >= splitAt)),
      previous: summarize(rows.filter((row) => row.timestampMs < splitAt)),
    };
  }

  _flowQualified(features, profile, position, at) {
    const baseQualified = features.current.netFlowSol >= this.config.minFlowNetSol
      && features.current.buyers >= this.config.minFlowBuyers
      && features.current.buyTx >= this.config.minFlowBuyTx
      && features.current.buyTx > features.previous.buyTx;
    if (!baseQualified || profile?.flowGate !== 'STRICT') return baseQualified;
    return features.current.netFlowSol >= this.config.strictMinFlowNetSol
      && features.current.netFlowSharePct >= this.config.strictMinFlowNetSharePct
      && at <= position.graduatedAt + this.config.strictMaxFlowConfirmationDelayMs;
  }

  _maxFlowWaitMs(position) {
    const profile = this.entryProfiles.get(position.entryProfileId);
    return profile?.flowGate === 'STRICT'
      ? Math.min(this.config.maxFlowWaitMs, this.config.strictMaxFlowConfirmationDelayMs)
      : this.config.maxFlowWaitMs;
  }

  _sellCore(position, trade, price, at, exit) {
    const units = position.tokenUnits * exit.coreFraction;
    const quote = executableSell(trade, units, price);
    if (!quote.available || !(quote.proceedsSol >= 0)) return false;
    position.tokenUnits -= units;
    position.runnerUnits = position.tokenUnits;
    position.coreProceedsSol += quote.proceedsSol;
    position.coreSoldAt = at;
    position.exitTxCount += 1;
    position.status = 'RUNNER';
    this.metrics.coreSold += 1;
    this._save(position);
    return true;
  }

  _requestExit(position, at, reason) {
    if (position.status === 'EXIT_PENDING') return;
    position.status = 'EXIT_PENDING';
    position.exitTriggerAt = at;
    position.exitTargetAt = at + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    position.exitReason = reason;
    this._save(position);
  }

  _sellAll(position, trade, price, at) {
    const markReturn = (price / position.entryPrice - 1) * 100;
    const quote = executableSell(trade, position.tokenUnits, price, { rugMarkReturnPct: markReturn });
    if (!quote.available && !quote.conservative) return false;
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
      updatedAt: this.now(),
    });
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
    this._remove(position);
    return true;
  }

  _estimatedCostSol(position) {
    const variablePct = this.costs.platformFeePct + this.costs.buySlippagePct
      + this.costs.sellSlippagePct + this.costs.priceImpactPct;
    const txCount = Math.max(2, position.entryTxCount + position.exitTxCount);
    return position.capitalInSol * variablePct / 100 + txCount * this.costs.totalFixedCostSol;
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
      updatedAt: this.now(),
    });
    this.metrics.noExit += 1;
    this._remove(position);
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
      updatedAt: this.now(),
    });
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
