'use strict';

const { costBreakdown } = require('./CostModel');

const STATUS = Object.freeze({
  RULE_REJECTED: 'RULE_REJECTED',
  PENDING_ENTRY: 'PENDING_ENTRY',
  PRICE_JUMP: 'PRICE_JUMP',
  NO_ENTRY: 'NO_ENTRY',
  OPEN: 'OPEN',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED: 'CLOSED',
  NO_EXIT: 'NO_EXIT',
});

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function priceOf(trade) {
  const reserve = finite(trade?.reservePrice);
  return reserve > 0 ? reserve : finite(trade?.price);
}

function camelRow(row) {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    entryProfileId: row.entry_profile_id,
    addProfileId: row.add_profile_id,
    exitProfileId: row.exit_profile_id,
    episodeId: row.episode_id,
    sourceType: row.source_type,
    sourceEventId: row.source_event_id,
    sourceWallet: row.source_wallet,
    sourceCluster: row.source_cluster,
    flowSignalId: row.flow_signal_id,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    positionSol: finite(row.position_sol, 1),
    signalAt: finite(row.signal_at),
    signalPrice: finite(row.signal_price),
    entryTargetAt: finite(row.entry_target_at),
    entryDeadlineAt: finite(row.entry_deadline_at),
    entryAt: finite(row.entry_at),
    entryMarket: row.entry_market,
    entryPrice: finite(row.entry_price),
    averageEntryPrice: finite(row.average_entry_price),
    totalInvestedSol: finite(row.total_invested_sol, 0),
    tokenUnits: finite(row.token_units, 0),
    remainingTokenUnits: finite(row.remaining_token_units, 0),
    realizedProceedsSol: finite(row.realized_proceeds_sol, 0),
    addCount: Math.max(0, Math.trunc(finite(row.add_count, 0))),
    nextAddIndex: Math.max(0, Math.trunc(finite(row.next_add_index, 0))),
    partialExitCount: Math.max(0, Math.trunc(finite(row.partial_exit_count, 0))),
    partialExitAt: finite(row.partial_exit_at),
    highestPrice: finite(row.highest_price),
    lowestPrice: finite(row.lowest_price),
    maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
    maxAdverseReturnPct: finite(row.max_adverse_return_pct, 0),
    exitTriggerAt: finite(row.exit_trigger_at),
    exitTargetAt: finite(row.exit_target_at),
    exitDeadlineAt: finite(row.exit_deadline_at),
    exitReason: row.exit_reason,
  };
}

class SmartLikeEarlyShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.addProfiles = new Map((config.addProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.priorityWallets = new Set(config.priorityWallets || []);
    this.walletClusters = new Map();
    for (const cluster of config.walletClusters || []) {
      for (const wallet of cluster.wallets || []) this.walletClusters.set(wallet, cluster.id);
    }
    this.states = new Map();
    this.clusterOpens = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.metrics = {
      observedTrades: 0, evaluatedSmartOpens: 0, evaluatedFlowSignals: 0,
      qualifiedSignals: 0, rejectedSignals: 0, replaySignalsSuppressed: 0,
      priceJump: 0, noEntry: 0, opened: 0, adds: 0, partialExits: 0,
      smartConfirmations: 0, closed: 0, noExit: 0, lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS smart_like_early_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        add_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_event_id INTEGER,
        source_wallet TEXT,
        source_cluster TEXT,
        flow_signal_id INTEGER,
        flow_signal_delay_ms INTEGER,
        smart_confirmed_at INTEGER,
        smart_confirm_wallet TEXT,
        smart_confirm_cluster TEXT,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        age_ms INTEGER,
        curve_pct REAL,
        buyers_1s INTEGER,
        buyers_5s INTEGER,
        net_flow_1s REAL,
        net_flow_5s REAL,
        sell_tx_1s INTEGER,
        return_5s_pct REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        average_entry_price REAL,
        total_invested_sol REAL,
        token_units REAL,
        remaining_token_units REAL,
        realized_proceeds_sol REAL NOT NULL DEFAULT 0,
        add_count INTEGER NOT NULL DEFAULT 0,
        next_add_index INTEGER NOT NULL DEFAULT 0,
        partial_exit_count INTEGER NOT NULL DEFAULT 0,
        partial_exit_at INTEGER,
        partial_exit_price REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
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
      CREATE INDEX IF NOT EXISTS idx_smart_like_early_status
        ON smart_like_early_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_smart_like_early_mint
        ON smart_like_early_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_smart_like_early_profiles
        ON smart_like_early_shadow_positions(entry_profile_id, add_profile_id, exit_profile_id);
    `);
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_like_early_shadow_positions (
        cohort_id, entry_profile_id, add_profile_id, exit_profile_id, episode_id,
        source_type, source_event_id, source_wallet, source_cluster, flow_signal_id,
        flow_signal_delay_ms, smart_confirmed_at, smart_confirm_wallet,
        smart_confirm_cluster, mint, symbol, status, rejection_reason,
        position_sol, configured_cost_pct, signal_at, signal_price,
        age_ms, curve_pct, buyers_1s, buyers_5s, net_flow_1s, net_flow_5s,
        sell_tx_1s, return_5s_pct, features_json, entry_target_at, entry_deadline_at,
        created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @addProfileId, @exitProfileId, @episodeId,
        @sourceType, @sourceEventId, @sourceWallet, @sourceCluster, @flowSignalId,
        @flowSignalDelayMs, @smartConfirmedAt, @smartConfirmWallet,
        @smartConfirmCluster, @mint, @symbol, @status, @rejectionReason,
        @positionSol, @configuredCostPct, @signalAt, @signalPrice,
        @ageMs, @curvePct, @buyers1s, @buyers5s, @netFlow1s, @netFlow5s,
        @sellTx1s, @return5sPct, @featuresJson, @entryTargetAt, @entryDeadlineAt,
        @createdAt, @updatedAt
      )
    `);
    this.active = this.store.db.prepare(`
      SELECT * FROM smart_like_early_shadow_positions
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') ORDER BY signal_at, id
    `);
    this.update = this.store.db.prepare(`
      UPDATE smart_like_early_shadow_positions SET
        status=COALESCE(@status,status), rejection_reason=COALESCE(@rejectionReason,rejection_reason),
        smart_confirmed_at=COALESCE(@smartConfirmedAt,smart_confirmed_at),
        smart_confirm_wallet=COALESCE(@smartConfirmWallet,smart_confirm_wallet),
        smart_confirm_cluster=COALESCE(@smartConfirmCluster,smart_confirm_cluster),
        entry_at=COALESCE(@entryAt,entry_at), entry_market=COALESCE(@entryMarket,entry_market),
        entry_price=COALESCE(@entryPrice,entry_price), entry_jump_pct=COALESCE(@entryJumpPct,entry_jump_pct),
        average_entry_price=COALESCE(@averageEntryPrice,average_entry_price),
        total_invested_sol=COALESCE(@totalInvestedSol,total_invested_sol),
        token_units=COALESCE(@tokenUnits,token_units),
        remaining_token_units=COALESCE(@remainingTokenUnits,remaining_token_units),
        realized_proceeds_sol=COALESCE(@realizedProceedsSol,realized_proceeds_sol),
        add_count=COALESCE(@addCount,add_count), next_add_index=COALESCE(@nextAddIndex,next_add_index),
        partial_exit_count=COALESCE(@partialExitCount,partial_exit_count),
        partial_exit_at=COALESCE(@partialExitAt,partial_exit_at),
        partial_exit_price=COALESCE(@partialExitPrice,partial_exit_price),
        highest_price=COALESCE(@highestPrice,highest_price), lowest_price=COALESCE(@lowestPrice,lowest_price),
        last_observed_at=COALESCE(@lastObservedAt,last_observed_at), last_price=COALESCE(@lastPrice,last_price),
        max_favorable_return_pct=COALESCE(@maxFavorableReturnPct,max_favorable_return_pct),
        max_adverse_return_pct=COALESCE(@maxAdverseReturnPct,max_adverse_return_pct),
        exit_trigger_at=COALESCE(@exitTriggerAt,exit_trigger_at),
        exit_target_at=COALESCE(@exitTargetAt,exit_target_at),
        exit_deadline_at=COALESCE(@exitDeadlineAt,exit_deadline_at),
        exit_at=COALESCE(@exitAt,exit_at), exit_market=COALESCE(@exitMarket,exit_market),
        exit_price=COALESCE(@exitPrice,exit_price), exit_reason=COALESCE(@exitReason,exit_reason),
        gross_return_pct=COALESCE(@grossReturnPct,gross_return_pct),
        net_return_pct=COALESCE(@netReturnPct,net_return_pct),
        estimated_cost_sol=COALESCE(@estimatedCostSol,estimated_cost_sol), updated_at=@updatedAt
      WHERE id=@id
    `);
    this.markNoExit = this.store.db.prepare(`
      UPDATE smart_like_early_shadow_positions SET status='NO_EXIT', exit_reason=@exitReason,
        estimated_cost_sol=@estimatedCostSol, updated_at=@updatedAt WHERE id=@id
    `);
    this.confirmPredictive = this.store.db.prepare(`
      UPDATE smart_like_early_shadow_positions SET smart_confirmed_at=@smartConfirmedAt,
        smart_confirm_wallet=@smartConfirmWallet, smart_confirm_cluster=@smartConfirmCluster,
        flow_signal_delay_ms=@flowSignalDelayMs, updated_at=@updatedAt
      WHERE mint=@mint AND source_type='FLOW_PREDICT' AND signal_at<=@smartConfirmedAt
        AND signal_at>=@smartConfirmedAt-@maxDelayMs AND smart_confirmed_at IS NULL
    `);
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.active.all()) {
      const position = camelRow(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const since = this.now() - this.config.stateWindowMs;
    const replay = [
      ...this.store.recentCurveTrades(since),
      ...(this.store.recentAmmTrades?.(since) || []),
    ].sort((a, b) => a.timestampMs - b.timestampMs);
    for (const trade of replay) this.observeTrade(trade, { replay: true });
    this.advanceTime(this.now());
  }

  stop() {}

  trackedMints() { return [...this.rowsByMint.keys()]; }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SMART_LIKE_EARLY',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      addProfiles: [...this.addProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        name: 'Smart-Like Early Entry',
        positionSizeSol: this.config.positionSizeSol,
        maxCurvePct: this.config.maxCurvePct,
        maxAgeMs: this.config.maxAgeMs,
        maxReturn5sPct: this.config.maxReturn5sPct,
        minNetFlow5s: this.config.minNetFlow5s,
        priorityWallets: [...this.priorityWallets],
        walletClusters: this.config.walletClusters,
        addThresholdsPct: this.config.addThresholdsPct,
        addFraction: this.config.addFraction,
        research: {
          isolatedPositionTable: 'smart_like_early_shadow_positions',
          retrospectiveEntry: false,
          sendsTransactions: false,
          noExitPricedAsTotalLoss: false,
        },
      },
      ...this.metrics,
    };
  }

  observeTrade(trade, { replay = false } = {}) {
    const timestampMs = finite(trade?.timestampMs);
    const price = priceOf(trade);
    if (!this.config.enabled || !trade?.mint || !(timestampMs > 0) || !(price > 0)
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade.market)) return;
    this.advanceTime(timestampMs);
    const features = this._observeState(trade, price);
    this._observePositions(trade, price, features);
    this.metrics.observedTrades += 1;
    if (replay) this.metrics.replaySignalsSuppressed += 1;
  }

  onSignal(signal, { replay = false } = {}) {
    if (!this.config.enabled || !signal?.mint) return [];
    const variant = signal.signalVariant || signal.signal_variant;
    const rank = finite(signal.signalRankInMint ?? signal.signal_rank_in_mint);
    if (variant !== 'primary_3w' || rank !== 1) return [];
    this.metrics.evaluatedFlowSignals += 1;
    const timestampMs = finite(signal.timestampMs ?? signal.timestamp_ms);
    const price = finite(signal.price ?? signal.p0);
    const features = this._features(signal.mint, timestampMs);
    const decisionFeatures = { ...features,
      ageMs: finite(signal.ageMs ?? signal.age_ms, features.ageMs),
      curvePct: finite(signal.curvePct ?? signal.curve_pct, features.curvePct),
    };
    const profile = this.entryProfiles.get('FLOW_PREDICT');
    if (!profile || !(timestampMs > 0) || !(price > 0)) return [];
    const reasons = this._entryReasons(profile, decisionFeatures);
    if (replay) return [];
    return this._recordSignal({
      profile, sourceType: 'FLOW_PREDICT', sourceEventId: null, sourceWallet: null,
      sourceCluster: null, flowSignalId: signal.signalId ?? signal.signal_id ?? null,
      flowSignalDelayMs: null, mint: signal.mint, symbol: signal.symbol,
      timestampMs, price, features: decisionFeatures, reasons,
    });
  }

  onSmartWalletEvent(event) {
    if (!this.config.enabled || !event?.mint || !event?.wallet
      || event.side !== 'BUY' || String(event.positionPhase || '').toUpperCase() !== 'OPEN') return [];
    const priorityWallet = this.priorityWallets.has(event.wallet);
    if (!priorityWallet && !this.walletClusters.has(event.wallet)) return [];
    const timestampMs = finite(event.timestampMs);
    const price = priceOf(event);
    if (!(timestampMs > 0) || !(price > 0)) return [];
    this.metrics.evaluatedSmartOpens += 1;
    const cluster = this._cluster(event.wallet);
    const signalDelay = finite(event.timeFromFlowSignalMs);
    const features = this._features(event.mint, timestampMs, event.signature, event.eventIndex);
    const decisionFeatures = {
      ...features,
      ageMs: finite(event.ageMs, features.ageMs),
      curvePct: finite(event.curvePct, features.curvePct),
      flowSignalDelayMs: signalDelay,
      smartSol: finite(event.solAmount, 0),
    };
    const results = [];
    const clusterKey = `${event.mint}:${cluster}`;
    const priorClusterOpen = this.clusterOpens.get(clusterKey);
    const duplicateClusterOpen = priorClusterOpen != null
      && timestampMs - priorClusterOpen <= this.config.clusterDedupMs;
    if (priorityWallet && !duplicateClusterOpen) {
      this.clusterOpens.set(clusterKey, timestampMs);
      for (const id of ['SMART_DIRECT', 'SMART_STRICT']) {
        const profile = this.entryProfiles.get(id);
        if (!profile) continue;
        const reasons = this._entryReasons(profile, decisionFeatures);
        results.push(...this._recordSignal({
          profile, sourceType: 'SMART_OPEN', sourceEventId: event.id || null,
          sourceWallet: event.wallet, sourceCluster: cluster,
          flowSignalId: event.nearestFlowSignal || null, flowSignalDelayMs: signalDelay,
          mint: event.mint, symbol: event.symbol, timestampMs, price,
          features: decisionFeatures, reasons,
        }));
      }
    }
    const confirmation = this.confirmPredictive.run({
      mint: event.mint,
      smartConfirmedAt: timestampMs,
      smartConfirmWallet: event.wallet,
      smartConfirmCluster: cluster,
      flowSignalDelayMs: signalDelay,
      maxDelayMs: this.config.smartConfirmationMs,
      updatedAt: this.now(),
    });
    if (confirmation.changes > 0) this.metrics.smartConfirmations += 1;
    return results;
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this._patch(pending.id, { status: STATUS.NO_ENTRY, rejectionReason: 'NO_TRADE_IN_ENTRY_WINDOW' });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        const cost = this._estimatedCostSol(position);
        this.markNoExit.run({ id: position.id, exitReason: position.exitReason || 'NO_EXIT_PRICE',
          estimatedCostSol: cost, updatedAt: this.now() });
        this.positions.delete(position.id);
        this._unindex(position);
        this.metrics.noExit += 1;
      } else if (position.status === STATUS.OPEN) {
        const exit = this.exitProfiles.get(position.exitProfileId);
        const heldMs = now - position.entryAt;
        if (heldMs >= exit.maxHoldMs) this._requestExit(position, position.entryAt + exit.maxHoldMs, 'MAX_HOLD');
        else if (exit.mode !== 'FIXED_HOLD' && heldMs >= this.config.noStrengthMs
          && position.maxFavorableReturnPct < this.config.noStrengthMfePct) {
          this._requestExit(position, position.entryAt + this.config.noStrengthMs, 'NO_STRENGTH');
        }
      }
    }
    const cutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      if (state.lastAt < cutoff && !this.rowsByMint.has(mint)) this.states.delete(mint);
    }
    for (const [key, timestampMs] of this.clusterOpens) {
      if (timestampMs < cutoff) this.clusterOpens.delete(key);
    }
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = { events: [], lastAt: 0 };
      this.states.set(mint, state);
    }
    return state;
  }

  _observeState(trade, price) {
    const state = this._state(trade.mint);
    state.lastAt = Math.max(state.lastAt, trade.timestampMs);
    state.events.push({
      timestampMs: trade.timestampMs, side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null, solAmount: Math.max(0, finite(trade.solAmount, 0)),
      price, market: trade.market, signature: trade.signature || null,
      eventIndex: finite(trade.eventIndex, 0), curvePct: finite(trade.curvePct),
      ageMs: finite(trade.ageMs),
    });
    const cutoff = trade.timestampMs - this.config.stateWindowMs;
    while (state.events.length && state.events[0].timestampMs < cutoff) state.events.shift();
    return this._features(trade.mint, trade.timestampMs);
  }

  _features(mint, timestampMs, excludeSignature = null, excludeEventIndex = null) {
    const rows = (this.states.get(mint)?.events || []).filter((row) => (
      row.timestampMs <= timestampMs
      && row.timestampMs >= timestampMs - this.config.stateWindowMs
      && !(excludeSignature && row.signature === excludeSignature
        && row.eventIndex === finite(excludeEventIndex, 0))
    ));
    const recent = (ms) => rows.filter((row) => row.timestampMs >= timestampMs - ms);
    const summarize = (items) => {
      const buys = items.filter((row) => row.side === 'BUY');
      const sells = items.filter((row) => row.side === 'SELL');
      return {
        buyers: new Set(buys.map((row) => row.wallet).filter(Boolean)).size,
        netFlow: buys.reduce((sum, row) => sum + row.solAmount, 0)
          - sells.reduce((sum, row) => sum + row.solAmount, 0),
        sellTx: sells.length,
      };
    };
    const one = summarize(recent(1_000));
    const fiveRows = recent(5_000);
    const five = summarize(fiveRows);
    const latest = rows[rows.length - 1];
    const base = fiveRows[0]?.price;
    const token = this.store.getToken(mint);
    const createdAt = finite(token?.created_at ?? token?.createdAt);
    return {
      ageMs: finite(latest?.ageMs, createdAt == null ? null : timestampMs - createdAt),
      curvePct: finite(latest?.curvePct),
      buyers1s: one.buyers,
      buyers5s: five.buyers,
      netFlow1s: one.netFlow,
      netFlow5s: five.netFlow,
      sellTx1s: one.sellTx,
      return5sPct: base > 0 && latest?.price > 0 ? (latest.price / base - 1) * 100 : 0,
    };
  }

  _entryReasons(profile, features) {
    const reasons = [];
    if (features.curvePct == null || features.curvePct > this.config.maxCurvePct) reasons.push('CURVE_ABOVE_MAX');
    if (features.return5sPct > this.config.maxReturn5sPct) reasons.push('CHASED_5S_RETURN');
    if (features.netFlow5s < this.config.minNetFlow5s) reasons.push('NEGATIVE_NETFLOW_5S');
    if (profile.requireAge && (features.ageMs == null || features.ageMs > this.config.maxAgeMs)) reasons.push('AGE_ABOVE_MAX');
    if (profile.requireFlowConfirmation && !(features.flowSignalDelayMs >= 0
      && features.flowSignalDelayMs <= this.config.smartConfirmationMs)) reasons.push('NO_RECENT_PRIMARY_FLOW');
    if (profile.sourceType === 'SMART_OPEN' && features.smartSol < this.config.minSmartOpenSol) reasons.push('SMART_OPEN_BELOW_MIN_SOL');
    return reasons;
  }

  _recordSignal(input) {
    const matched = input.reasons.length === 0;
    const episodeId = `${input.mint}:${input.profile.id}:${input.timestampMs}`;
    const results = [];
    if (matched) this.metrics.qualifiedSignals += 1;
    else this.metrics.rejectedSignals += 1;
    for (const addProfile of this.addProfiles.values()) {
      for (const exitProfile of this.exitProfiles.values()) {
        if (Array.isArray(exitProfile.allowedAddProfileIds)
          && !exitProfile.allowedAddProfileIds.includes(addProfile.id)) continue;
        const now = this.now();
        const cohortId = `${input.profile.id}_${addProfile.id}_${exitProfile.id}`;
        const result = this.insert.run({
          cohortId, entryProfileId: input.profile.id, addProfileId: addProfile.id,
          exitProfileId: exitProfile.id, episodeId, sourceType: input.sourceType,
          sourceEventId: input.sourceEventId, sourceWallet: input.sourceWallet,
          sourceCluster: input.sourceCluster, flowSignalId: input.flowSignalId,
          flowSignalDelayMs: input.flowSignalDelayMs, mint: input.mint,
          smartConfirmedAt: input.sourceType === 'SMART_OPEN' ? input.timestampMs : null,
          smartConfirmWallet: input.sourceType === 'SMART_OPEN' ? input.sourceWallet : null,
          smartConfirmCluster: input.sourceType === 'SMART_OPEN' ? input.sourceCluster : null,
          symbol: input.symbol || this.store.getToken(input.mint)?.symbol || null,
          status: matched ? STATUS.PENDING_ENTRY : STATUS.RULE_REJECTED,
          rejectionReason: input.reasons.join(',') || null,
          positionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          signalAt: input.timestampMs, signalPrice: input.price,
          ageMs: input.features.ageMs, curvePct: input.features.curvePct,
          buyers1s: input.features.buyers1s, buyers5s: input.features.buyers5s,
          netFlow1s: input.features.netFlow1s, netFlow5s: input.features.netFlow5s,
          sellTx1s: input.features.sellTx1s, return5sPct: input.features.return5sPct,
          featuresJson: JSON.stringify(input.features),
          entryTargetAt: input.timestampMs + this.config.entryDelayMs,
          entryDeadlineAt: input.timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
          createdAt: now, updatedAt: now,
        });
        if (!result.changes) continue;
        const row = this.store.db.prepare('SELECT * FROM smart_like_early_shadow_positions WHERE id=?')
          .get(Number(result.lastInsertRowid));
        const position = camelRow(row);
        if (matched) {
          this.pendingEntries.set(position.id, position);
          this._index(position);
        }
        results.push(row);
      }
    }
    this.metrics.lastActionAt = this.now();
    return results;
  }

  _observePositions(trade, price, features) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (trade.market !== 'PUMP_BONDING_CURVE' || trade.timestampMs < position.entryTargetAt
          || trade.timestampMs > position.entryDeadlineAt) continue;
        const jumpPct = (price / position.signalPrice - 1) * 100;
        if (jumpPct > this.config.maxEntryPriceJumpPct || jumpPct < -this.config.maxEntryPriceDropPct) {
          this._patch(position.id, { status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_MOVE_${jumpPct.toFixed(2)}PCT`, entryJumpPct: jumpPct });
          this.pendingEntries.delete(position.id);
          this._unindex(position);
          this.metrics.priceJump += 1;
        } else this._open(position, trade, price, jumpPct);
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        if (trade.timestampMs >= position.exitTargetAt && trade.timestampMs <= position.exitDeadlineAt
          && this._comparablePrice(position, trade, price)) this._close(position, trade, price);
        continue;
      }
      if (position.status !== STATUS.OPEN || trade.timestampMs < position.entryAt
        || !this._comparablePrice(position, trade, price)) continue;
      this._mark(position, trade.timestampMs, price);
      this._maybeAdd(position, trade, price, features);
      this._maybePartialExit(position, trade, price);
      this._evaluateExit(position, trade.timestampMs, price, features);
    }
  }

  _comparablePrice(position, trade, price) {
    const graduatedAt = finite(this.store.getToken(position.mint)?.graduated_at);
    if (trade.market === 'PUMP_BONDING_CURVE') return !(graduatedAt > 0) || trade.timestampMs < graduatedAt;
    if (trade.market !== 'PUMP_AMM' || !(graduatedAt > 0) || trade.timestampMs < graduatedAt) return false;
    const ratio = price / (position.averageEntryPrice || position.entryPrice);
    return ratio >= 0.1 && ratio <= 10;
  }

  _open(position, trade, price, jumpPct) {
    Object.assign(position, {
      status: STATUS.OPEN, entryAt: trade.timestampMs, entryMarket: trade.market,
      entryPrice: price, averageEntryPrice: price, totalInvestedSol: position.positionSol,
      tokenUnits: position.positionSol / price, remainingTokenUnits: position.positionSol / price,
      realizedProceedsSol: 0, addCount: 0, nextAddIndex: 0, partialExitCount: 0,
      highestPrice: price, lowestPrice: price,
    });
    this._patch(position.id, {
      status: STATUS.OPEN, entryAt: trade.timestampMs, entryMarket: trade.market,
      entryPrice: price, entryJumpPct: jumpPct, averageEntryPrice: price,
      totalInvestedSol: position.totalInvestedSol, tokenUnits: position.tokenUnits,
      remainingTokenUnits: position.remainingTokenUnits, realizedProceedsSol: 0,
      addCount: 0, nextAddIndex: 0, partialExitCount: 0,
      highestPrice: price, lowestPrice: price, lastObservedAt: trade.timestampMs,
      lastPrice: price, maxFavorableReturnPct: 0, maxAdverseReturnPct: 0,
    });
    this.pendingEntries.delete(position.id);
    this.positions.set(position.id, position);
    this.metrics.opened += 1;
  }

  _mark(position, timestampMs, price) {
    position.highestPrice = Math.max(position.highestPrice || price, price);
    position.lowestPrice = Math.min(position.lowestPrice || price, price);
    position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct || 0,
      (position.highestPrice / position.averageEntryPrice - 1) * 100);
    position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct || 0,
      (position.lowestPrice / position.averageEntryPrice - 1) * 100);
    this._patch(position.id, {
      highestPrice: position.highestPrice, lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs, lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _maybeAdd(position, trade, price, features) {
    const profile = this.addProfiles.get(position.addProfileId);
    const thresholds = profile?.thresholdsPct || [];
    const threshold = thresholds[position.nextAddIndex];
    if (threshold == null || position.partialExitAt || features.netFlow5s < 0
      || price < position.averageEntryPrice * (1 + threshold / 100)) return;
    const addSol = position.positionSol * (profile.addFraction ?? this.config.addFraction);
    const addTokens = addSol / price;
    position.totalInvestedSol += addSol;
    position.tokenUnits += addTokens;
    position.remainingTokenUnits += addTokens;
    position.averageEntryPrice = position.totalInvestedSol / position.tokenUnits;
    position.addCount += 1;
    position.nextAddIndex += 1;
    this._patch(position.id, {
      totalInvestedSol: position.totalInvestedSol, tokenUnits: position.tokenUnits,
      remainingTokenUnits: position.remainingTokenUnits,
      averageEntryPrice: position.averageEntryPrice,
      addCount: position.addCount, nextAddIndex: position.nextAddIndex,
    });
    this.metrics.adds += 1;
  }

  _maybePartialExit(position, trade, price) {
    if (position.partialExitAt) return;
    const exit = this.exitProfiles.get(position.exitProfileId);
    if (exit?.mode === 'FIXED_HOLD') return;
    const gross = (price / position.averageEntryPrice - 1) * 100;
    if (gross < exit.activationPct) return;
    const units = position.remainingTokenUnits * exit.sellFraction;
    position.remainingTokenUnits -= units;
    position.realizedProceedsSol += units * price;
    position.partialExitAt = trade.timestampMs;
    position.partialExitCount += 1;
    this._patch(position.id, {
      remainingTokenUnits: position.remainingTokenUnits,
      realizedProceedsSol: position.realizedProceedsSol,
      partialExitAt: trade.timestampMs, partialExitPrice: price,
      partialExitCount: position.partialExitCount,
    });
    this.metrics.partialExits += 1;
  }

  _evaluateExit(position, timestampMs, price, features) {
    const exit = this.exitProfiles.get(position.exitProfileId);
    const heldMs = timestampMs - position.entryAt;
    const gross = (price / position.averageEntryPrice - 1) * 100;
    const drawdown = (1 - price / position.highestPrice) * 100;
    const fixedHold = exit.mode === 'FIXED_HOLD';
    const hardStopPct = exit.hardStopPct ?? this.config.hardStopPct;
    let reason = null;
    if (!position.partialExitAt && gross <= -hardStopPct) reason = `HARD_STOP_${hardStopPct}`;
    else if (!fixedHold && position.partialExitAt && exit.flowDecayExit
      && (features.netFlow1s <= this.config.flowDecayNetFlow1s
        || features.sellTx1s >= this.config.flowDecaySellTx1s)) reason = 'FLOW_DECAY';
    else if (!fixedHold && position.partialExitAt
      && drawdown >= exit.trailingStopPct) reason = 'RUNNER_TRAIL';
    else if (!fixedHold && heldMs >= this.config.noStrengthMs
      && position.maxFavorableReturnPct < this.config.noStrengthMfePct) reason = 'NO_STRENGTH';
    else if (heldMs >= exit.maxHoldMs) reason = 'MAX_HOLD';
    if (reason) this._requestExit(position, timestampMs, reason);
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    Object.assign(position, { status: STATUS.EXIT_PENDING, exitReason: reason,
      exitTriggerAt: triggerAt, exitTargetAt: triggerAt + this.config.exitDelayMs,
      exitDeadlineAt: triggerAt + this.config.exitDelayMs + this.config.exitTimeoutMs });
    this._patch(position.id, {
      status: STATUS.EXIT_PENDING, exitReason: reason, exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt, exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _estimatedCostSol(position) {
    const variablePct = this.costs.platformFeePct + this.costs.buySlippagePct
      + this.costs.sellSlippagePct + this.costs.priceImpactPct;
    const executions = 2 + position.addCount + position.partialExitCount;
    return position.totalInvestedSol * variablePct / 100 + this.costs.totalFixedCostSol * executions;
  }

  _close(position, trade, price) {
    this._mark(position, trade.timestampMs, price);
    const proceeds = position.realizedProceedsSol + position.remainingTokenUnits * price;
    const grossReturnPct = (proceeds / position.totalInvestedSol - 1) * 100;
    const estimatedCostSol = this._estimatedCostSol(position);
    const netReturnPct = (proceeds - estimatedCostSol) / position.totalInvestedSol * 100 - 100;
    this._patch(position.id, {
      status: STATUS.CLOSED, exitAt: trade.timestampMs, exitMarket: trade.market,
      exitPrice: price, grossReturnPct, netReturnPct, estimatedCostSol,
      remainingTokenUnits: 0,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _cluster(wallet) { return this.walletClusters.get(wallet) || wallet; }

  _patch(id, values) {
    const keys = [
      'status','rejectionReason','smartConfirmedAt','smartConfirmWallet','smartConfirmCluster',
      'entryAt','entryMarket','entryPrice','entryJumpPct','averageEntryPrice','totalInvestedSol',
      'tokenUnits','remainingTokenUnits','realizedProceedsSol','addCount','nextAddIndex',
      'partialExitCount','partialExitAt','partialExitPrice','highestPrice','lowestPrice',
      'lastObservedAt','lastPrice','maxFavorableReturnPct','maxAdverseReturnPct','exitTriggerAt',
      'exitTargetAt','exitDeadlineAt','exitAt','exitMarket','exitPrice','exitReason',
      'grossReturnPct','netReturnPct','estimatedCostSol',
    ];
    const row = { id, updatedAt: this.now() };
    for (const key of keys) row[key] = values[key] ?? null;
    this.update.run(row);
  }

  _index(position) {
    let ids = this.rowsByMint.get(position.mint);
    if (!ids) { ids = new Set(); this.rowsByMint.set(position.mint, ids); }
    ids.add(position.id);
  }

  _unindex(position) {
    const ids = this.rowsByMint.get(position.mint);
    if (!ids) return;
    ids.delete(position.id);
    if (!ids.size) this.rowsByMint.delete(position.mint);
  }

  dashboard({ positionLimit = 100 } = {}) {
    const limit = Math.min(300, Math.max(1, Math.trunc(Number(positionLimit) || 100)));
    const positions = this.store.db.prepare(`
      SELECT *, CASE WHEN entry_at IS NOT NULL AND exit_at IS NOT NULL
        THEN exit_at-entry_at ELSE NULL END AS hold_ms
      FROM smart_like_early_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC LIMIT ?
    `).all(limit);
    const groups = this.store.db.prepare(`
      SELECT cohort_id, entry_profile_id, add_profile_id, exit_profile_id,
        COUNT(*) attempts, COUNT(DISTINCT episode_id) signals, COUNT(DISTINCT mint) independent_mints,
        SUM(status='RULE_REJECTED') rule_rejected, SUM(status='PRICE_JUMP') price_jump,
        SUM(status='NO_ENTRY') no_entry,
        SUM(status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING')) active,
        SUM(status='CLOSED') resolved, SUM(status='NO_EXIT') no_exit,
        AVG(age_ms) average_age_ms, AVG(curve_pct) average_curve_pct,
        AVG(return_5s_pct) average_return_5s_pct, AVG(net_flow_5s) average_net_flow_5s,
        AVG(add_count) average_add_count, AVG(partial_exit_count) average_partial_exit_count,
        AVG(total_invested_sol) average_invested_sol, AVG(max_favorable_return_pct) average_mfe_pct,
        AVG(max_adverse_return_pct) average_mae_pct,
        AVG(CASE WHEN status IN ('CLOSED','NO_EXIT')
          THEN CASE WHEN smart_confirmed_at IS NOT NULL THEN 100.0 ELSE 0 END END)
          smart_confirmation_rate_pct,
        AVG(net_return_pct) average_net_return_pct,
        AVG(CASE WHEN status='CLOSED'
          THEN CASE WHEN net_return_pct>0 THEN 100.0 ELSE 0 END END) win_rate_pct,
        MAX(net_return_pct) max_winner_pct
      FROM smart_like_early_shadow_positions
      GROUP BY cohort_id, entry_profile_id, add_profile_id, exit_profile_id
      ORDER BY entry_profile_id, add_profile_id, exit_profile_id
    `).all();
    const returns = this.store.db.prepare(`SELECT net_return_pct FROM smart_like_early_shadow_positions
      WHERE cohort_id=? AND status='CLOSED' AND net_return_pct IS NOT NULL ORDER BY net_return_pct`);
    const cohorts = groups.map((group) => {
      const values = returns.all(group.cohort_id).map((row) => Number(row.net_return_pct));
      const wins = values.filter((value) => value > 0);
      const losses = values.filter((value) => value < 0);
      const profit = wins.reduce((sum, value) => sum + value, 0);
      const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const middle = Math.floor(values.length / 2);
      return { ...group,
        median_net_return_pct: values.length ? (values.length % 2 ? values[middle]
          : (values[middle - 1] + values[middle]) / 2) : null,
        profit_factor: loss > 0 ? profit / loss : (profit > 0 ? null : 0),
      };
    });
    return { cohorts, positions };
  }
}

module.exports = { SmartLikeEarlyShadowSuite, STATUS, priceOf };
