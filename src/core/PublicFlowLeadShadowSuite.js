'use strict';

const { costBreakdown } = require('./CostModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');

const STATUS = Object.freeze({
  PENDING_ENTRY: 'PENDING_ENTRY',
  PRICE_JUMP: 'PRICE_JUMP',
  NO_ENTRY: 'NO_ENTRY',
  OPEN: 'OPEN',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED: 'CLOSED',
  NO_EXIT: 'NO_EXIT',
  OBSERVED: 'OBSERVED',
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
    exitProfileId: row.exit_profile_id,
    episodeId: row.episode_id,
    mint: row.mint,
    status: row.status,
    signalAt: finite(row.signal_at),
    signalMarket: row.signal_market,
    signalPrice: finite(row.signal_price),
    entryTargetAt: finite(row.entry_target_at),
    entryDeadlineAt: finite(row.entry_deadline_at),
    entryAt: finite(row.entry_at),
    entryMarket: row.entry_market,
    entryPrice: finite(row.entry_price),
    highestPrice: finite(row.highest_price),
    lowestPrice: finite(row.lowest_price),
    lastPrice: finite(row.last_price),
    lastMarket: row.last_market,
    maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
    maxAdverseReturnPct: finite(row.max_adverse_return_pct, 0),
    exitTriggerAt: finite(row.exit_trigger_at),
    exitTargetAt: finite(row.exit_target_at),
    exitDeadlineAt: finite(row.exit_deadline_at),
    exitReason: row.exit_reason,
    positionSol: finite(row.position_sol, 1),
  };
}

class PublicFlowLeadShadowSuite {
  constructor({ config, store, rugRiskTracker = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.rugRiskTracker = rugRiskTracker;
    this.now = now;
    this.simulatePositions = config.simulatePositions === true;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.smartWallets = new Set(config.smartWallets || []);
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.lastEpisodes = new Map();
    this.metrics = {
      observedTrades: 0,
      observedPublicTrades: 0,
      excludedSmartTrades: 0,
      evaluatedStates: 0,
      riskSnapshots: 0,
      riskRejected: 0,
      qualifiedSignals: 0,
      observerSignals: 0,
      replaySignalsSuppressed: 0,
      smartOpenLabels: 0,
      ignoredSmartAdds: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      closed: 0,
      noExit: 0,
      lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS public_flow_lead_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_market TEXT NOT NULL,
        signal_price REAL NOT NULL,
        age_ms INTEGER,
        curve_pct REAL,
        public_buyers_1s INTEGER,
        public_buyers_5s INTEGER,
        public_buy_tx_1s INTEGER,
        public_buy_tx_5s INTEGER,
        public_sell_tx_5s INTEGER,
        public_buy_flow_1s REAL,
        previous_buy_flow_1s REAL,
        public_buy_flow_5s REAL,
        public_sell_flow_5s REAL,
        public_net_flow_5s REAL,
        largest_buyer_share_pct REAL,
        sell_buy_ratio REAL,
        return_5s_pct REAL,
        flow_acceleration_ratio REAL,
        pre_risk_sample_ready INTEGER,
        pre_risk_flagged INTEGER,
        pre_return_pct REAL,
        pre_max_consecutive_buys INTEGER,
        pre_buy_share_pct REAL,
        pre_side_alternation_pct REAL,
        pre_repeated_buy_size_pct REAL,
        pre_largest_wallet_share_pct REAL,
        features_json TEXT NOT NULL,
        smart_open_at INTEGER,
        smart_open_delay_ms INTEGER,
        smart_open_wallet TEXT,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_jump_pct REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_market TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_public_flow_lead_status
        ON public_flow_lead_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_public_flow_lead_mint
        ON public_flow_lead_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_public_flow_lead_profiles
        ON public_flow_lead_shadow_positions(entry_profile_id, exit_profile_id);
    `);
    this._ensureFeatureColumns();
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO public_flow_lead_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id, mint, symbol,
        status, rejection_reason, position_sol, configured_cost_pct,
        signal_at, signal_market, signal_price, age_ms, curve_pct,
        public_buyers_1s, public_buyers_5s, public_buy_tx_1s, public_buy_tx_5s,
        public_sell_tx_5s, public_buy_flow_1s, previous_buy_flow_1s,
        public_buy_flow_5s, public_sell_flow_5s, public_net_flow_5s,
        largest_buyer_share_pct, sell_buy_ratio, return_5s_pct,
        flow_acceleration_ratio, pre_risk_sample_ready, pre_risk_flagged,
        pre_return_pct, pre_max_consecutive_buys, pre_buy_share_pct,
        pre_side_alternation_pct, pre_repeated_buy_size_pct,
        pre_largest_wallet_share_pct, features_json, entry_target_at,
        entry_deadline_at, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId, @mint, @symbol,
        @status, @rejectionReason, @positionSol, @configuredCostPct,
        @signalAt, @signalMarket, @signalPrice, @ageMs, @curvePct,
        @publicBuyers1s, @publicBuyers5s, @publicBuyTx1s, @publicBuyTx5s,
        @publicSellTx5s, @publicBuyFlow1s, @previousBuyFlow1s,
        @publicBuyFlow5s, @publicSellFlow5s, @publicNetFlow5s,
        @largestBuyerSharePct, @sellBuyRatio, @return5sPct,
        @flowAccelerationRatio, @preRiskSampleReady, @preRiskFlagged,
        @preReturnPct, @preMaxConsecutiveBuys, @preBuySharePct,
        @preSideAlternationPct, @preRepeatedBuySizePct,
        @preLargestWalletSharePct, @featuresJson, @entryTargetAt,
        @entryDeadlineAt, @createdAt, @updatedAt
      )
    `);
    this.active = this.store.db.prepare(`
      SELECT * FROM public_flow_lead_shadow_positions
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') ORDER BY signal_at, id
    `);
    this.update = this.store.db.prepare(`
      UPDATE public_flow_lead_shadow_positions SET
        status=COALESCE(@status,status),
        rejection_reason=COALESCE(@rejectionReason,rejection_reason),
        entry_at=COALESCE(@entryAt,entry_at),
        entry_market=COALESCE(@entryMarket,entry_market),
        entry_price=COALESCE(@entryPrice,entry_price),
        entry_jump_pct=COALESCE(@entryJumpPct,entry_jump_pct),
        highest_price=COALESCE(@highestPrice,highest_price),
        lowest_price=COALESCE(@lowestPrice,lowest_price),
        last_observed_at=COALESCE(@lastObservedAt,last_observed_at),
        last_market=COALESCE(@lastMarket,last_market),
        last_price=COALESCE(@lastPrice,last_price),
        max_favorable_return_pct=COALESCE(@maxFavorableReturnPct,max_favorable_return_pct),
        max_adverse_return_pct=COALESCE(@maxAdverseReturnPct,max_adverse_return_pct),
        exit_trigger_at=COALESCE(@exitTriggerAt,exit_trigger_at),
        exit_target_at=COALESCE(@exitTargetAt,exit_target_at),
        exit_deadline_at=COALESCE(@exitDeadlineAt,exit_deadline_at),
        exit_at=COALESCE(@exitAt,exit_at),
        exit_market=COALESCE(@exitMarket,exit_market),
        exit_price=COALESCE(@exitPrice,exit_price),
        exit_reason=COALESCE(@exitReason,exit_reason),
        gross_return_pct=COALESCE(@grossReturnPct,gross_return_pct),
        net_return_pct=COALESCE(@netReturnPct,net_return_pct),
        estimated_cost_sol=COALESCE(@estimatedCostSol,estimated_cost_sol),
        updated_at=@updatedAt
      WHERE id=@id
    `);
    this.markNoExit = this.store.db.prepare(`
      UPDATE public_flow_lead_shadow_positions
      SET status='NO_EXIT', exit_reason=@exitReason,
        estimated_cost_sol=@estimatedCostSol, updated_at=@updatedAt
      WHERE id=@id
    `);
    this.labelSmartOpen = this.store.db.prepare(`
      UPDATE public_flow_lead_shadow_positions
      SET smart_open_at=@smartOpenAt,
        smart_open_delay_ms=@smartOpenAt-signal_at,
        smart_open_wallet=@smartOpenWallet,
        updated_at=@updatedAt
      WHERE mint=@mint AND signal_at<@smartOpenAt
        AND signal_at>=@smartOpenAt-@labelWindowMs
        AND smart_open_at IS NULL
    `);
  }

  _ensureFeatureColumns() {
    const columns = new Set(this.store.db.prepare(
      'PRAGMA table_info(public_flow_lead_shadow_positions)',
    ).all().map((row) => row.name));
    const additions = [
      ['pre_risk_sample_ready', 'INTEGER'],
      ['pre_risk_flagged', 'INTEGER'],
      ['pre_return_pct', 'REAL'],
      ['pre_max_consecutive_buys', 'INTEGER'],
      ['pre_buy_share_pct', 'REAL'],
      ['pre_side_alternation_pct', 'REAL'],
      ['pre_repeated_buy_size_pct', 'REAL'],
      ['pre_largest_wallet_share_pct', 'REAL'],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) {
        this.store.db.exec(
          `ALTER TABLE public_flow_lead_shadow_positions ADD COLUMN ${name} ${type}`,
        );
      }
    }
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.active.all()) {
      const position = camelRow(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const recent = this.store.db.prepare(`
      SELECT mint, entry_profile_id, MAX(signal_at) signal_at
      FROM public_flow_lead_shadow_positions
      WHERE signal_at>=? GROUP BY mint, entry_profile_id
    `).all(this.now() - this.config.stateRetentionMs);
    for (const row of recent) {
      this.lastEpisodes.set(`${row.mint}:${row.entry_profile_id}`, Number(row.signal_at));
    }
    this.advanceTime(this.now());
  }

  stop() {}

  trackedMints() { return [...this.rowsByMint.keys()]; }

  health() {
    return {
      enabled: this.config.enabled,
      mode: this.simulatePositions ? 'SHADOW_PFL' : 'OBSERVER_PFL',
      sendsTransactions: false,
      observerOnly: !this.simulatePositions,
      simulatesPositions: this.simulatePositions,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        name: 'Public Flow Lead',
        positionSizeSol: this.config.positionSizeSol,
        featureWindowMs: this.config.featureWindowMs,
        entryDelayMs: this.config.entryDelayMs,
        smartLabelWindowMs: this.config.smartLabelWindowMs,
        smartWalletCount: this.smartWallets.size,
        research: {
          isolatedPositionTable: 'public_flow_lead_shadow_positions',
          entryUsesSmartWallet: false,
          smartOpenIsFutureLabelOnly: true,
          smartAddsIgnored: true,
          newSimulatedEntriesEnabled: this.simulatePositions,
          historicalSimulatedPositionsRetained: true,
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
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade.market)) return [];
    this.advanceTime(timestampMs);
    this._observePositions(trade, price);
    this.metrics.observedTrades += 1;
    if (this.smartWallets.has(trade.wallet)) {
      this.metrics.excludedSmartTrades += 1;
      return [];
    }
    this.metrics.observedPublicTrades += 1;
    this._observeState(trade, price);
    if (replay || trade.market !== 'PUMP_BONDING_CURVE') {
      if (replay) this.metrics.replaySignalsSuppressed += 1;
      return [];
    }
    return this._evaluatePublicFlow(trade, price);
  }

  onSmartWalletEvent(event) {
    if (!this.config.enabled || !event?.mint || !event?.wallet
      || !this.smartWallets.has(event.wallet)
      || String(event.side || '').toUpperCase() !== 'BUY') return 0;
    const phase = String(event.positionPhase || '').toUpperCase();
    if (phase !== 'OPEN') {
      if (phase === 'ADD') this.metrics.ignoredSmartAdds += 1;
      return 0;
    }
    const smartOpenAt = finite(event.timestampMs);
    if (!(smartOpenAt > 0)) return 0;
    const result = this.labelSmartOpen.run({
      mint: event.mint,
      smartOpenAt,
      smartOpenWallet: event.wallet,
      labelWindowMs: this.config.smartLabelWindowMs,
      updatedAt: this.now(),
    });
    this.metrics.smartOpenLabels += result.changes;
    return result.changes;
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const pending of [...this.pendingEntries.values()]) {
      if (now <= pending.entryDeadlineAt) continue;
      this._patch(pending.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: 'NO_TRADE_IN_ENTRY_WINDOW',
      });
      this.pendingEntries.delete(pending.id);
      this._unindex(pending);
      this.metrics.noEntry += 1;
    }
    for (const position of [...this.positions.values()]) {
      if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        this.markNoExit.run({
          id: position.id,
          exitReason: position.exitReason || 'NO_EXIT_PRICE',
          estimatedCostSol: this._estimatedCostSol(position),
          updatedAt: this.now(),
        });
        this.positions.delete(position.id);
        this._unindex(position);
        this.metrics.noExit += 1;
      } else if (position.status === STATUS.OPEN) {
        const exit = this.exitProfiles.get(position.exitProfileId);
        if (now - position.entryAt >= exit.maxHoldMs) {
          this._requestExit(position, position.entryAt + exit.maxHoldMs, 'MAX_HOLD');
        }
      }
    }
    const cutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      this._pruneState(state, now);
      if (state.lastAt < cutoff && !this.rowsByMint.has(mint)) this.states.delete(mint);
    }
    for (const [key, timestampMs] of this.lastEpisodes) {
      if (timestampMs < cutoff) this.lastEpisodes.delete(key);
    }
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = { trades: [], lastAt: 0 };
      this.states.set(mint, state);
    }
    return state;
  }

  _observeState(trade, price) {
    const state = this._state(trade.mint);
    state.lastAt = Math.max(state.lastAt, trade.timestampMs);
    state.trades.push({
      timestampMs: trade.timestampMs,
      side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      price,
      curvePct: finite(trade.curvePct),
      ageMs: finite(trade.ageMs),
    });
    this._pruneState(state, trade.timestampMs);
  }

  _pruneState(state, timestampMs) {
    const cutoff = timestampMs - this.config.featureWindowMs;
    while (state.trades.length && state.trades[0].timestampMs < cutoff) state.trades.shift();
  }

  _features(mint, timestampMs) {
    const rows = (this.states.get(mint)?.trades || []).filter((row) => (
      row.timestampMs >= timestampMs - this.config.featureWindowMs
      && row.timestampMs <= timestampMs
    ));
    const current1s = rows.filter((row) => row.timestampMs >= timestampMs - 1_000);
    const previous1s = rows.filter((row) => row.timestampMs >= timestampMs - 2_000
      && row.timestampMs < timestampMs - 1_000);
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buys1s = current1s.filter((row) => row.side === 'BUY');
    const previousBuys1s = previous1s.filter((row) => row.side === 'BUY');
    const buyFlow1s = buys1s.reduce((sum, row) => sum + row.solAmount, 0);
    const previousBuyFlow1s = previousBuys1s.reduce((sum, row) => sum + row.solAmount, 0);
    const buyFlow5s = buys.reduce((sum, row) => sum + row.solAmount, 0);
    const sellFlow5s = sells.reduce((sum, row) => sum + row.solAmount, 0);
    const flowByBuyer = new Map();
    for (const row of buys) {
      if (!row.wallet) continue;
      flowByBuyer.set(row.wallet, (flowByBuyer.get(row.wallet) || 0) + row.solAmount);
    }
    const latest = rows[rows.length - 1];
    const first = rows[0];
    const token = this.store.getToken(mint);
    const createdAt = finite(token?.created_at ?? token?.createdAt);
    const largest = Math.max(0, ...flowByBuyer.values());
    return {
      ageMs: finite(latest?.ageMs, createdAt == null ? null : timestampMs - createdAt),
      curvePct: finite(latest?.curvePct),
      publicBuyers1s: new Set(buys1s.map((row) => row.wallet).filter(Boolean)).size,
      publicBuyers5s: flowByBuyer.size,
      publicBuyTx1s: buys1s.length,
      publicBuyTx5s: buys.length,
      publicSellTx5s: sells.length,
      publicBuyFlow1s: buyFlow1s,
      previousBuyFlow1s,
      publicBuyFlow5s: buyFlow5s,
      publicSellFlow5s: sellFlow5s,
      publicNetFlow5s: buyFlow5s - sellFlow5s,
      largestBuyerSharePct: buyFlow5s > 0 ? largest / buyFlow5s * 100 : 0,
      sellBuyRatio: buyFlow5s > 0 ? sellFlow5s / buyFlow5s : null,
      return5sPct: first?.price > 0 && latest?.price > 0
        ? (latest.price / first.price - 1) * 100 : 0,
      flowAccelerationRatio: previousBuyFlow1s > 0
        ? buyFlow1s / previousBuyFlow1s : (buyFlow1s > 0 ? null : 0),
    };
  }

  _preRiskFeatures(mint, timestampMs) {
    const risk = this.rugRiskTracker?.snapshot?.(mint, timestampMs) || null;
    this.metrics.riskSnapshots += 1;
    return {
      preRiskSampleReady: Boolean(risk?.sampleReady),
      preRiskFlagged: Boolean(risk?.flagged),
      preReturnPct: finite(risk?.returnPct),
      preMaxConsecutiveBuys: finite(risk?.maxConsecutiveBuys, 0),
      preBuySharePct: finite(risk?.buySharePct),
      preSideAlternationPct: finite(risk?.sideAlternationPct),
      preRepeatedBuySizePct: finite(risk?.repeatedBuySizeSharePct),
      preLargestWalletSharePct: finite(risk?.maxWalletBuyTxSharePct),
    };
  }

  _profileNeedsPreRisk(profile) {
    return Boolean(profile.requirePreRiskSampleReady
      || profile.maxPreReturnPct != null
      || profile.maxPreConsecutiveBuys != null);
  }

  _entryReasons(profile, features, { includeRisk = true } = {}) {
    const reasons = [];
    const below = (value, limit) => limit != null && !(value >= limit);
    const above = (value, limit) => limit != null && !(value <= limit);
    if (below(features.ageMs, profile.minAgeMs)) reasons.push('AGE_BELOW_MIN');
    if (above(features.ageMs, profile.maxAgeMs)) reasons.push('AGE_ABOVE_MAX');
    if (below(features.curvePct, profile.minCurvePct)) reasons.push('CURVE_BELOW_MIN');
    if (above(features.curvePct, profile.maxCurvePct)) reasons.push('CURVE_ABOVE_MAX');
    if (below(features.publicBuyers1s, profile.minPublicBuyers1s)) reasons.push('BUYERS_1S_BELOW_MIN');
    if (above(features.publicBuyers1s, profile.maxPublicBuyers1s)) reasons.push('BUYERS_1S_ABOVE_MAX');
    if (below(features.publicBuyers5s, profile.minPublicBuyers5s)) reasons.push('BUYERS_5S_BELOW_MIN');
    if (below(features.publicBuyFlow1s, profile.minPublicBuyFlow1sSol)) reasons.push('BUY_FLOW_1S_BELOW_MIN');
    if (below(features.publicBuyFlow5s, profile.minPublicBuyFlow5sSol)) reasons.push('BUY_FLOW_5S_BELOW_MIN');
    if (above(features.publicBuyFlow5s, profile.maxPublicBuyFlow5sSol)) reasons.push('BUY_FLOW_5S_ABOVE_MAX');
    if (below(features.publicNetFlow5s, profile.minPublicNetFlow5sSol)) reasons.push('NET_FLOW_5S_BELOW_MIN');
    if (above(features.largestBuyerSharePct, profile.maxLargestBuyerSharePct)) reasons.push('TOP1_ABOVE_MAX');
    if (below(features.sellBuyRatio, profile.minSellBuyRatio)) reasons.push('SELL_BUY_RATIO_BELOW_MIN');
    if (above(features.sellBuyRatio, profile.maxSellBuyRatio)) reasons.push('SELL_BUY_RATIO_ABOVE_MAX');
    if (below(features.return5sPct, profile.minReturn5sPct)) reasons.push('RETURN_5S_BELOW_MIN');
    if (above(features.return5sPct, profile.maxReturn5sPct)) reasons.push('RETURN_5S_ABOVE_MAX');
    if (profile.minFlowAccelerationRatio != null
      && (features.flowAccelerationRatio == null
        || features.flowAccelerationRatio < profile.minFlowAccelerationRatio)) {
      reasons.push('FLOW_ACCEL_BELOW_MIN');
    }
    if (profile.maxFlowAccelerationRatio != null
      && (features.flowAccelerationRatio == null
        || features.flowAccelerationRatio > profile.maxFlowAccelerationRatio)) {
      reasons.push('FLOW_ACCEL_ABOVE_MAX');
    }
    if (includeRisk) {
      if (profile.requirePreRiskSampleReady && !features.preRiskSampleReady) {
        reasons.push('PRE_RISK_SAMPLE_INCOMPLETE');
      }
      if (above(features.preReturnPct, profile.maxPreReturnPct)) {
        reasons.push('PRE_RETURN_ABOVE_MAX');
      }
      if (above(features.preMaxConsecutiveBuys, profile.maxPreConsecutiveBuys)) {
        reasons.push('PRE_CONSECUTIVE_BUYS_ABOVE_MAX');
      }
    }
    return reasons;
  }

  _evaluatePublicFlow(trade, price) {
    const publicFeatures = this._features(trade.mint, trade.timestampMs);
    this.metrics.evaluatedStates += 1;
    const candidates = [];
    for (const profile of this.entryProfiles.values()) {
      const key = `${trade.mint}:${profile.id}`;
      const prior = this.lastEpisodes.get(key);
      if (prior != null && trade.timestampMs - prior < this.config.episodeCooldownMs) continue;
      if (!this._entryReasons(profile, publicFeatures, { includeRisk: false }).length) {
        candidates.push(profile);
      }
    }
    if (!candidates.length) return [];
    const needsPreRisk = candidates.some((profile) => this._profileNeedsPreRisk(profile));
    const features = needsPreRisk
      ? { ...publicFeatures, ...this._preRiskFeatures(trade.mint, trade.timestampMs) }
      : publicFeatures;
    const results = [];
    for (const profile of candidates) {
      const key = `${trade.mint}:${profile.id}`;
      if (this._entryReasons(profile, features).length) {
        this.metrics.riskRejected += 1;
        continue;
      }
      this.lastEpisodes.set(key, trade.timestampMs);
      results.push(...this._recordSignal(profile, trade, price, features));
    }
    return results;
  }

  _recordSignal(profile, trade, price, features) {
    const episodeId = `${trade.mint}:${profile.id}:${trade.timestampMs}`;
    const results = [];
    this.metrics.qualifiedSignals += 1;
    if (!this.simulatePositions) {
      const now = this.now();
      const result = this.insert.run({
        cohortId: `${profile.id}_OBS`,
        entryProfileId: profile.id,
        exitProfileId: 'OBS',
        episodeId,
        mint: trade.mint,
        symbol: trade.symbol || this.store.getToken(trade.mint)?.symbol || null,
        status: STATUS.OBSERVED,
        rejectionReason: 'OBSERVER_ONLY_NO_SIMULATED_ENTRY',
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        signalAt: trade.timestampMs,
        signalMarket: trade.market,
        signalPrice: price,
        ageMs: features.ageMs,
        curvePct: features.curvePct,
        publicBuyers1s: features.publicBuyers1s,
        publicBuyers5s: features.publicBuyers5s,
        publicBuyTx1s: features.publicBuyTx1s,
        publicBuyTx5s: features.publicBuyTx5s,
        publicSellTx5s: features.publicSellTx5s,
        publicBuyFlow1s: features.publicBuyFlow1s,
        previousBuyFlow1s: features.previousBuyFlow1s,
        publicBuyFlow5s: features.publicBuyFlow5s,
        publicSellFlow5s: features.publicSellFlow5s,
        publicNetFlow5s: features.publicNetFlow5s,
        largestBuyerSharePct: features.largestBuyerSharePct,
        sellBuyRatio: features.sellBuyRatio,
        return5sPct: features.return5sPct,
        flowAccelerationRatio: features.flowAccelerationRatio,
        preRiskSampleReady: features.preRiskSampleReady == null
          ? null : Number(features.preRiskSampleReady),
        preRiskFlagged: features.preRiskFlagged == null
          ? null : Number(features.preRiskFlagged),
        preReturnPct: features.preReturnPct,
        preMaxConsecutiveBuys: features.preMaxConsecutiveBuys,
        preBuySharePct: features.preBuySharePct,
        preSideAlternationPct: features.preSideAlternationPct,
        preRepeatedBuySizePct: features.preRepeatedBuySizePct,
        preLargestWalletSharePct: features.preLargestWalletSharePct,
        featuresJson: JSON.stringify(features),
        entryTargetAt: trade.timestampMs,
        entryDeadlineAt: trade.timestampMs,
        createdAt: now,
        updatedAt: now,
      });
      if (result.changes) {
        const row = this.store.db.prepare(
          'SELECT * FROM public_flow_lead_shadow_positions WHERE id=?',
        ).get(Number(result.lastInsertRowid));
        this.metrics.observerSignals += 1;
        this.metrics.lastActionAt = now;
        results.push(row);
      }
      return results;
    }
    for (const exit of this.exitProfiles.values()) {
      const now = this.now();
      const cohortId = `${profile.id}_${exit.id}`;
      const result = this.insert.run({
        cohortId,
        entryProfileId: profile.id,
        exitProfileId: exit.id,
        episodeId,
        mint: trade.mint,
        symbol: trade.symbol || this.store.getToken(trade.mint)?.symbol || null,
        status: STATUS.PENDING_ENTRY,
        rejectionReason: null,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        signalAt: trade.timestampMs,
        signalMarket: trade.market,
        signalPrice: price,
        ageMs: features.ageMs,
        curvePct: features.curvePct,
        publicBuyers1s: features.publicBuyers1s,
        publicBuyers5s: features.publicBuyers5s,
        publicBuyTx1s: features.publicBuyTx1s,
        publicBuyTx5s: features.publicBuyTx5s,
        publicSellTx5s: features.publicSellTx5s,
        publicBuyFlow1s: features.publicBuyFlow1s,
        previousBuyFlow1s: features.previousBuyFlow1s,
        publicBuyFlow5s: features.publicBuyFlow5s,
        publicSellFlow5s: features.publicSellFlow5s,
        publicNetFlow5s: features.publicNetFlow5s,
        largestBuyerSharePct: features.largestBuyerSharePct,
        sellBuyRatio: features.sellBuyRatio,
        return5sPct: features.return5sPct,
        flowAccelerationRatio: features.flowAccelerationRatio,
        preRiskSampleReady: features.preRiskSampleReady == null
          ? null : Number(features.preRiskSampleReady),
        preRiskFlagged: features.preRiskFlagged == null
          ? null : Number(features.preRiskFlagged),
        preReturnPct: features.preReturnPct,
        preMaxConsecutiveBuys: features.preMaxConsecutiveBuys,
        preBuySharePct: features.preBuySharePct,
        preSideAlternationPct: features.preSideAlternationPct,
        preRepeatedBuySizePct: features.preRepeatedBuySizePct,
        preLargestWalletSharePct: features.preLargestWalletSharePct,
        featuresJson: JSON.stringify(features),
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
        createdAt: now,
        updatedAt: now,
      });
      if (!result.changes) continue;
      const row = this.store.db.prepare(
        'SELECT * FROM public_flow_lead_shadow_positions WHERE id=?',
      ).get(Number(result.lastInsertRowid));
      const position = camelRow(row);
      this.pendingEntries.set(position.id, position);
      this._index(position);
      results.push(row);
    }
    this.metrics.lastActionAt = this.now();
    return results;
  }

  _observePositions(trade, price) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (trade.timestampMs < position.entryTargetAt
          || trade.timestampMs > position.entryDeadlineAt
          || trade.market !== position.signalMarket) continue;
        const jumpPct = (price / position.signalPrice - 1) * 100;
        if (jumpPct > this.config.maxEntryPriceJumpPct
          || jumpPct < -this.config.maxEntryPriceDropPct) {
          this._patch(position.id, {
            status: STATUS.PRICE_JUMP,
            rejectionReason: `ENTRY_PRICE_MOVE_${jumpPct.toFixed(2)}PCT`,
            entryJumpPct: jumpPct,
          });
          this.pendingEntries.delete(position.id);
          this._unindex(position);
          this.metrics.priceJump += 1;
        } else this._open(position, trade, price, jumpPct);
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        if (trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt
          && this._comparablePrice(position, trade, price)) this._close(position, trade, price);
        continue;
      }
      if (position.status !== STATUS.OPEN || trade.timestampMs < position.entryAt
        || !this._comparablePrice(position, trade, price)) continue;
      this._mark(position, trade.timestampMs, trade.market, price);
      const exit = this.exitProfiles.get(position.exitProfileId);
      const gross = (price / position.entryPrice - 1) * 100;
      if (gross <= -exit.hardStopPct) {
        this._requestExit(position, trade.timestampMs, `HARD_STOP_${exit.hardStopPct}`);
      } else if (trade.timestampMs - position.entryAt >= exit.maxHoldMs) {
        this._requestExit(position, position.entryAt + exit.maxHoldMs, 'MAX_HOLD');
      }
    }
  }

  _comparablePrice(position, trade, price) {
    if (trade.market === position.lastMarket || trade.market === position.entryMarket) return true;
    const graduatedAt = finite(this.store.getToken(position.mint)?.graduated_at);
    if (!(graduatedAt > 0) || trade.market !== 'PUMP_AMM' || trade.timestampMs < graduatedAt) return false;
    const reference = position.lastPrice || position.entryPrice;
    return Math.abs((price / reference - 1) * 100) <= this.config.maxCrossMarketPriceJumpPct;
  }

  _open(position, trade, price, jumpPct) {
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: `PUBLIC_FLOW_LEAD:${position.cohortId}`,
      mint: position.mint,
      timestampMs: trade.timestampMs,
    });
    if (rugGuard.blocked) {
      this._patch(position.id, { status: STATUS.NO_ENTRY, rejectionReason: 'PRE_ENTRY_RUG_RISK' });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      return;
    }
    Object.assign(position, {
      status: STATUS.OPEN,
      entryAt: trade.timestampMs,
      entryMarket: trade.market,
      entryPrice: price,
      highestPrice: price,
      lowestPrice: price,
      lastPrice: price,
      lastMarket: trade.market,
      maxFavorableReturnPct: 0,
      maxAdverseReturnPct: 0,
    });
    this._patch(position.id, {
      status: STATUS.OPEN,
      entryAt: trade.timestampMs,
      entryMarket: trade.market,
      entryPrice: price,
      entryJumpPct: jumpPct,
      highestPrice: price,
      lowestPrice: price,
      lastObservedAt: trade.timestampMs,
      lastMarket: trade.market,
      lastPrice: price,
      maxFavorableReturnPct: 0,
      maxAdverseReturnPct: 0,
    });
    this.pendingEntries.delete(position.id);
    this.positions.set(position.id, position);
    this.metrics.opened += 1;
  }

  _mark(position, timestampMs, market, price) {
    position.highestPrice = Math.max(position.highestPrice || price, price);
    position.lowestPrice = Math.min(position.lowestPrice || price, price);
    position.lastPrice = price;
    position.lastMarket = market;
    position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct || 0,
      (position.highestPrice / position.entryPrice - 1) * 100);
    position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct || 0,
      (position.lowestPrice / position.entryPrice - 1) * 100);
    this._patch(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: timestampMs,
      lastMarket: market,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    Object.assign(position, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: triggerAt,
      exitTargetAt: triggerAt + this.config.exitDelayMs,
      exitDeadlineAt: triggerAt + this.config.exitDelayMs + this.config.exitTimeoutMs,
    });
    this._patch(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: position.exitTriggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _estimatedCostSol(position) {
    const variablePct = this.costs.platformFeePct + this.costs.buySlippagePct
      + this.costs.sellSlippagePct + this.costs.priceImpactPct;
    return position.positionSol * variablePct / 100 + this.costs.totalFixedCostSol * 2;
  }

  _close(position, trade, price) {
    this._mark(position, trade.timestampMs, trade.market, price);
    const grossReturnPct = (price / position.entryPrice - 1) * 100;
    const estimatedCostSol = this._estimatedCostSol(position);
    const netReturnPct = grossReturnPct - estimatedCostSol / position.positionSol * 100;
    this._patch(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: price,
      grossReturnPct,
      netReturnPct,
      estimatedCostSol,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _patch(id, values) {
    const keys = [
      'status', 'rejectionReason', 'entryAt', 'entryMarket', 'entryPrice', 'entryJumpPct',
      'highestPrice', 'lowestPrice', 'lastObservedAt', 'lastMarket', 'lastPrice',
      'maxFavorableReturnPct', 'maxAdverseReturnPct', 'exitTriggerAt', 'exitTargetAt',
      'exitDeadlineAt', 'exitAt', 'exitMarket', 'exitPrice', 'exitReason',
      'grossReturnPct', 'netReturnPct', 'estimatedCostSol',
    ];
    const row = { id, updatedAt: this.now() };
    for (const key of keys) row[key] = values[key] ?? null;
    this.update.run(row);
  }

  _index(position) {
    let ids = this.rowsByMint.get(position.mint);
    if (!ids) {
      ids = new Set();
      this.rowsByMint.set(position.mint, ids);
    }
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
      FROM public_flow_lead_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC LIMIT ?
    `).all(limit);
    const groups = this.store.db.prepare(`
      SELECT cohort_id, entry_profile_id, exit_profile_id,
        COUNT(*) signals, COUNT(DISTINCT mint) independent_mints,
        SUM(status='PRICE_JUMP') price_jump, SUM(status='NO_ENTRY') no_entry,
        SUM(status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING')) active,
        SUM(status='CLOSED') resolved, SUM(status='NO_EXIT') no_exit,
        AVG(public_buyers_5s) average_public_buyers_5s,
        AVG(public_buy_flow_5s) average_public_buy_flow_5s,
        AVG(public_net_flow_5s) average_public_net_flow_5s,
        AVG(largest_buyer_share_pct) average_largest_buyer_share_pct,
        AVG(flow_acceleration_ratio) average_flow_acceleration_ratio,
        AVG(pre_risk_sample_ready*100.0) pre_risk_ready_rate_pct,
        AVG(pre_risk_flagged*100.0) pre_risk_flagged_rate_pct,
        AVG(pre_return_pct) average_pre_return_pct,
        AVG(pre_max_consecutive_buys) average_pre_max_consecutive_buys,
        AVG(max_favorable_return_pct) average_mfe_pct,
        AVG(max_adverse_return_pct) average_mae_pct,
        AVG(net_return_pct) average_net_return_pct,
        AVG(CASE WHEN smart_open_delay_ms<=5000 THEN 100.0 ELSE 0 END) smart_open_5s_rate_pct,
        AVG(CASE WHEN smart_open_delay_ms<=15000 THEN 100.0 ELSE 0 END) smart_open_15s_rate_pct,
        AVG(CASE WHEN status='CLOSED'
          THEN CASE WHEN net_return_pct>0 THEN 100.0 ELSE 0 END END) win_rate_pct,
        AVG(CASE WHEN status='CLOSED'
          THEN CASE WHEN net_return_pct>=50 THEN 100.0 ELSE 0 END END) big50_rate_pct,
        AVG(CASE WHEN status='CLOSED'
          THEN CASE WHEN net_return_pct>=100 THEN 100.0 ELSE 0 END END) big100_rate_pct,
        MAX(net_return_pct) max_winner_pct
      FROM public_flow_lead_shadow_positions
      WHERE exit_profile_id<>'OBS'
      GROUP BY cohort_id, entry_profile_id, exit_profile_id
      ORDER BY entry_profile_id, exit_profile_id
    `).all();
    const returns = this.store.db.prepare(`
      SELECT net_return_pct FROM public_flow_lead_shadow_positions
      WHERE cohort_id=? AND status='CLOSED' AND net_return_pct IS NOT NULL
      ORDER BY net_return_pct
    `);
    const cohorts = groups.map((group) => {
      const values = returns.all(group.cohort_id).map((row) => Number(row.net_return_pct));
      const wins = values.filter((value) => value > 0);
      const losses = values.filter((value) => value < 0);
      const profit = wins.reduce((sum, value) => sum + value, 0);
      const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const middle = Math.floor(values.length / 2);
      const sortedWins = [...wins].sort((a, b) => b - a);
      const top5Profit = sortedWins.slice(0, 5).reduce((sum, value) => sum + value, 0);
      return {
        ...group,
        median_net_return_pct: values.length
          ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2)
          : null,
        profit_factor: loss > 0 ? profit / loss : (profit > 0 ? null : 0),
        top_5_winner_contribution_pct: profit > 0 ? top5Profit / profit * 100 : null,
      };
    });
    const observerStats = this.store.db.prepare(`
      SELECT COUNT(*) signals, COUNT(DISTINCT mint) independent_mints,
        MAX(signal_at) latest_signal_at,
        SUM(smart_open_at IS NOT NULL) smart_open_labels,
        AVG(CASE WHEN smart_open_delay_ms<=5000 THEN 100.0 ELSE 0 END)
          smart_open_5s_rate_pct,
        AVG(CASE WHEN smart_open_delay_ms<=15000 THEN 100.0 ELSE 0 END)
          smart_open_15s_rate_pct,
        AVG(public_buyers_5s) average_public_buyers_5s,
        AVG(public_net_flow_5s) average_public_net_flow_5s
      FROM public_flow_lead_shadow_positions WHERE exit_profile_id='OBS'
    `).get();
    return { cohorts, positions, observerStats };
  }
}

module.exports = { PublicFlowLeadShadowSuite, STATUS, priceOf };
