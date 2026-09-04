'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const {
  capturePoolQuote,
  parsePoolQuote,
  quoteTrade,
  quotePrice,
  cacheIsUsableForExit,
  exitCensorReason,
} = require('./ShadowPoolQuote');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');
const { LIVE_CURVE_HARD_BLOCK_SIGNATURES } = require('./RugGuardPolicy');
const { buildShadowRugPairComparison } = require('./ShadowRugPairComparison');

const STATUS = Object.freeze({
  PENDING_ENTRY: 'PENDING_ENTRY',
  PRICE_JUMP: 'PRICE_JUMP',
  NO_ENTRY: 'NO_ENTRY',
  OPEN: 'OPEN',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED: 'CLOSED',
  NO_EXIT: 'NO_EXIT',
  RIGHT_CENSORED: 'RIGHT_CENSORED',
});

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function priceOf(trade) {
  const reserve = finite(trade?.reservePrice);
  return reserve > 0 ? reserve : finite(trade?.price);
}

function returnPct(price, reference) {
  return price > 0 && reference > 0 ? (price / reference - 1) * 100 : null;
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
    positionSol: finite(row.position_sol, 1),
    configuredCostPct: finite(row.configured_cost_pct, 0),
    signalAt: finite(row.signal_at),
    signalMarket: row.signal_market,
    signalPrice: finite(row.signal_price),
    entryTargetAt: finite(row.entry_target_at),
    entryDeadlineAt: finite(row.entry_deadline_at),
    entryAt: finite(row.entry_at),
    entryMarket: row.entry_market,
    entryPrice: finite(row.entry_price),
    averageEntryPrice: finite(row.average_entry_price),
    totalInvestedSol: finite(row.total_invested_sol, 0),
    tokenUnits: finite(row.token_units, 0),
    highestPrice: finite(row.highest_price),
    lowestPrice: finite(row.lowest_price),
    lastPrice: finite(row.last_price),
    lastMarket: row.last_market,
    lastPoolQuote: parsePoolQuote(row.last_pool_quote_json),
    lastPoolQuoteAt: finite(row.last_pool_quote_at),
    lastPoolQuoteMarket: row.last_pool_quote_market,
    maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
    maxAdverseReturnPct: finite(row.max_adverse_return_pct, 0),
    coreExitTargetAt: finite(row.core_exit_target_at, 0),
    coreExitDeadlineAt: finite(row.core_exit_deadline_at, 0),
    coreExitAt: finite(row.core_exit_at),
    coreExitPrice: finite(row.core_exit_price),
    coreExitMarketPrice: finite(row.core_exit_market_price),
    coreExitImpactPct: finite(row.core_exit_impact_pct),
    coreProceedsSol: finite(row.core_proceeds_sol, 0),
    coreWeightPct: finite(row.core_weight_pct, 0),
    runnerStopPrice: finite(row.runner_stop_price),
    runnerTier: row.runner_tier,
    exitTargetAt: finite(row.exit_target_at),
    exitDeadlineAt: finite(row.exit_deadline_at),
    exitReason: row.exit_reason,
  };
}

class CyaOrganicBurstShadowSuite {
  constructor({ config, store, now = () => Date.now(), onLiveSignal = null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costModel = config.costModel || { positionSizeSol: config.positionSizeSol };
    this.costs = costBreakdown(this.costModel);
    this.entryProfiles = new Map((config.entryProfiles || []).map((profile) => [profile.id, profile]));
    this.profileCosts = new Map([...this.entryProfiles.values()].map((profile) => [
      profile.id,
      costBreakdown({
        ...this.costModel,
        positionSizeSol: profile.positionSizeSol ?? config.positionSizeSol,
      }),
    ]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((profile) => [profile.id, profile]));
    this.smartWallets = new Set(config.smartWallets || []);
    this.targetWallet = String(config.targetWallet || '');
    this.onLiveSignal = typeof onLiveSignal === 'function' ? onLiveSignal : null;
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
      qualifiedSignals: 0,
      retiredEntrySignalsSuppressed: 0,
      exclusiveSignalsSuppressed: 0,
      replaySignalsSuppressed: 0,
      targetOpenLabels: 0,
      rugGuardRejected: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      closed: 0,
      noExit: 0,
      rightCensored: 0,
      structureInvalidations: 0,
      flowFadeExits: 0,
      trailingExits: 0,
      coreExits: 0,
      runnerExits: 0,
      cachedReserveExits: 0,
      cachedReserveCoreExits: 0,
      liveSignals: 0,
      liveSignalErrors: 0,
      lastLiveSignalError: null,
      lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS cya_organic_burst_shadow_positions (
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
        buyers_2s INTEGER,
        buyers_5s INTEGER,
        buy_tx_5s INTEGER,
        sell_tx_5s INTEGER,
        buy_flow_5s REAL,
        sell_flow_5s REAL,
        net_flow_5s REAL,
        buy_tx_share_pct REAL,
        return_2s_pct REAL,
        return_5s_pct REAL,
        return_15s_pct REAL,
        runup_15s_pct REAL,
        drawdown_15s_pct REAL,
        features_json TEXT NOT NULL,
        target_open_at INTEGER,
        target_open_delay_ms INTEGER,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_market_price REAL,
        entry_jump_pct REAL,
        entry_impact_pct REAL,
        average_entry_price REAL,
        total_invested_sol REAL,
        token_units REAL,
        highest_price REAL,
        lowest_price REAL,
        last_observed_at INTEGER,
        last_market TEXT,
        last_price REAL,
        last_pool_quote_json TEXT,
        last_pool_quote_at INTEGER,
        last_pool_quote_market TEXT,
        recent_return_2s_pct REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        core_exit_target_at INTEGER,
        core_exit_deadline_at INTEGER,
        core_exit_at INTEGER,
        core_exit_price REAL,
        core_exit_market_price REAL,
        core_exit_impact_pct REAL,
        core_proceeds_sol REAL,
        core_weight_pct REAL,
        runner_stop_price REAL,
        runner_tier TEXT,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_price REAL,
        exit_market_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        estimated_cost_sol REAL,
        hold_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cya_organic_burst_status
        ON cya_organic_burst_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_cya_organic_burst_mint
        ON cya_organic_burst_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cya_organic_burst_profiles
        ON cya_organic_burst_shadow_positions(entry_profile_id, exit_profile_id);
      CREATE INDEX IF NOT EXISTS idx_cya_organic_burst_rug_pair
        ON cya_organic_burst_shadow_positions(
          entry_profile_id, exit_profile_id, signal_at, mint, position_sol
        );
    `);
    const columns = new Set(this.store.db.prepare(
      'PRAGMA table_info(cya_organic_burst_shadow_positions)',
    ).all().map((row) => row.name));
    const additions = [
      ['core_exit_target_at', 'INTEGER'], ['core_exit_deadline_at', 'INTEGER'],
      ['core_exit_at', 'INTEGER'], ['core_exit_price', 'REAL'],
      ['core_exit_market_price', 'REAL'], ['core_exit_impact_pct', 'REAL'],
      ['core_proceeds_sol', 'REAL'], ['core_weight_pct', 'REAL'],
      ['runner_stop_price', 'REAL'], ['runner_tier', 'TEXT'],
      ['last_pool_quote_json', 'TEXT'], ['last_pool_quote_at', 'INTEGER'],
      ['last_pool_quote_market', 'TEXT'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.store.db.exec(
          `ALTER TABLE cya_organic_burst_shadow_positions ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO cya_organic_burst_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id, mint, symbol,
        status, rejection_reason, position_sol, configured_cost_pct,
        signal_at, signal_market, signal_price, age_ms, curve_pct,
        buyers_2s, buyers_5s, buy_tx_5s, sell_tx_5s, buy_flow_5s,
        sell_flow_5s, net_flow_5s, buy_tx_share_pct, return_2s_pct,
        return_5s_pct, return_15s_pct, runup_15s_pct, drawdown_15s_pct,
        features_json, entry_target_at, entry_deadline_at, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId, @mint, @symbol,
        @status, @rejectionReason, @positionSol, @configuredCostPct,
        @signalAt, @signalMarket, @signalPrice, @ageMs, @curvePct,
        @buyers2s, @buyers5s, @buyTx5s, @sellTx5s, @buyFlow5s,
        @sellFlow5s, @netFlow5s, @buyTxSharePct, @return2sPct,
        @return5sPct, @return15sPct, @runup15sPct, @drawdown15sPct,
        @featuresJson, @entryTargetAt, @entryDeadlineAt, @createdAt, @updatedAt
      )
    `);
    this.active = this.store.db.prepare(`
      SELECT * FROM cya_organic_burst_shadow_positions
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') ORDER BY signal_at, id
    `);
    this.update = this.store.db.prepare(`
      UPDATE cya_organic_burst_shadow_positions SET
        status=COALESCE(@status,status), rejection_reason=COALESCE(@rejectionReason,rejection_reason),
        entry_at=COALESCE(@entryAt,entry_at), entry_market=COALESCE(@entryMarket,entry_market),
        entry_price=COALESCE(@entryPrice,entry_price),
        entry_market_price=COALESCE(@entryMarketPrice,entry_market_price),
        entry_jump_pct=COALESCE(@entryJumpPct,entry_jump_pct),
        entry_impact_pct=COALESCE(@entryImpactPct,entry_impact_pct),
        average_entry_price=COALESCE(@averageEntryPrice,average_entry_price),
        total_invested_sol=COALESCE(@totalInvestedSol,total_invested_sol),
        token_units=COALESCE(@tokenUnits,token_units),
        highest_price=COALESCE(@highestPrice,highest_price),
        lowest_price=COALESCE(@lowestPrice,lowest_price),
        last_observed_at=COALESCE(@lastObservedAt,last_observed_at),
        last_market=COALESCE(@lastMarket,last_market), last_price=COALESCE(@lastPrice,last_price),
        last_pool_quote_json=COALESCE(@lastPoolQuoteJson,last_pool_quote_json),
        last_pool_quote_at=COALESCE(@lastPoolQuoteAt,last_pool_quote_at),
        last_pool_quote_market=COALESCE(@lastPoolQuoteMarket,last_pool_quote_market),
        recent_return_2s_pct=COALESCE(@recentReturn2sPct,recent_return_2s_pct),
        max_favorable_return_pct=COALESCE(@maxFavorableReturnPct,max_favorable_return_pct),
        max_adverse_return_pct=COALESCE(@maxAdverseReturnPct,max_adverse_return_pct),
        core_exit_target_at=COALESCE(@coreExitTargetAt,core_exit_target_at),
        core_exit_deadline_at=COALESCE(@coreExitDeadlineAt,core_exit_deadline_at),
        core_exit_at=COALESCE(@coreExitAt,core_exit_at),
        core_exit_price=COALESCE(@coreExitPrice,core_exit_price),
        core_exit_market_price=COALESCE(@coreExitMarketPrice,core_exit_market_price),
        core_exit_impact_pct=COALESCE(@coreExitImpactPct,core_exit_impact_pct),
        core_proceeds_sol=COALESCE(@coreProceedsSol,core_proceeds_sol),
        core_weight_pct=COALESCE(@coreWeightPct,core_weight_pct),
        runner_stop_price=COALESCE(@runnerStopPrice,runner_stop_price),
        runner_tier=COALESCE(@runnerTier,runner_tier),
        exit_trigger_at=COALESCE(@exitTriggerAt,exit_trigger_at),
        exit_target_at=COALESCE(@exitTargetAt,exit_target_at),
        exit_deadline_at=COALESCE(@exitDeadlineAt,exit_deadline_at),
        exit_at=COALESCE(@exitAt,exit_at), exit_market=COALESCE(@exitMarket,exit_market),
        exit_price=COALESCE(@exitPrice,exit_price),
        exit_market_price=COALESCE(@exitMarketPrice,exit_market_price),
        exit_impact_pct=COALESCE(@exitImpactPct,exit_impact_pct),
        exit_reason=COALESCE(@exitReason,exit_reason),
        gross_return_pct=COALESCE(@grossReturnPct,gross_return_pct),
        net_return_pct=COALESCE(@netReturnPct,net_return_pct),
        estimated_cost_sol=COALESCE(@estimatedCostSol,estimated_cost_sol),
        hold_ms=COALESCE(@holdMs,hold_ms), updated_at=@updatedAt
      WHERE id=@id
    `);
    this.markNoExit = this.store.db.prepare(`
      UPDATE cya_organic_burst_shadow_positions
      SET status='NO_EXIT', exit_reason=@exitReason,
        estimated_cost_sol=@estimatedCostSol, updated_at=@updatedAt WHERE id=@id
    `);
    this.labelTargetOpen = this.store.db.prepare(`
      UPDATE cya_organic_burst_shadow_positions
      SET target_open_at=@targetOpenAt,
        target_open_delay_ms=@targetOpenAt-signal_at, updated_at=@updatedAt
      WHERE mint=@mint AND signal_at<@targetOpenAt
        AND signal_at>=@targetOpenAt-@labelWindowMs AND target_open_at IS NULL
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
    const recent = this.store.db.prepare(`
      SELECT mint, entry_profile_id, MAX(signal_at) signal_at
      FROM cya_organic_burst_shadow_positions WHERE signal_at>=?
      GROUP BY mint, entry_profile_id
    `).all(this.now() - this.config.stateRetentionMs);
    for (const row of recent) {
      const signalAt = Number(row.signal_at);
      const profile = this.entryProfiles.get(row.entry_profile_id);
      this.lastEpisodes.set(`${row.mint}:${row.entry_profile_id}`, signalAt);
      if (profile?.exclusiveGroup) {
        const groupKey = `${row.mint}:GROUP:${profile.exclusiveGroup}`;
        this.lastEpisodes.set(groupKey, Math.max(this.lastEpisodes.get(groupKey) || 0, signalAt));
      }
    }
    this.advanceTime(this.now());
  }

  stop() {}

  trackedMints() { return [...this.rowsByMint.keys()]; }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_COB',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      activeEntryProfiles: [...this.entryProfiles.values()].filter(
        (profile) => profile.newEntriesEnabled !== false,
      ),
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        name: 'CYA Organic Burst',
        positionSizeSol: this.config.positionSizeSol,
        entryDelayMs: this.config.entryDelayMs,
        targetWallet: this.targetWallet,
        publicFlowOnly: true,
        boundedPerMintTradeQueue: this.config.maxTradesPerMint,
        isolatedPositionTable: 'cya_organic_burst_shadow_positions',
        sameMintExclusiveGroups: [...new Set(
          [...this.entryProfiles.values()].map((profile) => profile.exclusiveGroup).filter(Boolean),
        )],
        liveReplayProfiles: [...this.entryProfiles.values()]
          .filter((profile) => profile.liveReplay === true)
          .map((profile) => ({
            id: profile.id,
            positionSizeSol: profile.positionSizeSol,
            entryDelayMs: profile.entryDelayMs,
            entryTimeoutMs: profile.entryTimeoutMs,
            maxEntryPriceJumpPct: profile.maxEntryPriceJumpPct,
            maxEntryImpactPct: profile.maxEntryImpactPct,
          })),
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
    const isSmartWalletTrade = this.smartWallets.has(trade.wallet);
    this._observePositions(trade, price, { allowEntryFill: !isSmartWalletTrade });
    this.metrics.observedTrades += 1;
    if (isSmartWalletTrade) {
      this.metrics.excludedSmartTrades += 1;
      return [];
    }
    this.metrics.observedPublicTrades += 1;
    this._observeState(trade, price);
    if (replay || trade.market !== 'PUMP_BONDING_CURVE') {
      if (replay) this.metrics.replaySignalsSuppressed += 1;
      return [];
    }
    return this._evaluate(trade, price);
  }

  onSmartWalletEvent(event) {
    if (!this.config.enabled || !event?.mint || event.wallet !== this.targetWallet
      || String(event.side || '').toUpperCase() !== 'BUY'
      || String(event.positionPhase || '').toUpperCase() !== 'OPEN') return 0;
    const targetOpenAt = finite(event.timestampMs);
    if (!(targetOpenAt > 0)) return 0;
    const result = this.labelTargetOpen.run({
      mint: event.mint,
      targetOpenAt,
      labelWindowMs: this.config.targetLabelWindowMs,
      updatedAt: this.now(),
    });
    this.metrics.targetOpenLabels += result.changes;
    return result.changes;
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
      if (position.status === STATUS.EXIT_PENDING
        && now >= position.exitTargetAt
        && this._closeFromCachedQuote(position, now)) {
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        const censorReason = exitCensorReason({
          mint: position.mint,
          entryMarket: position.entryMarket,
          exitTargetAt: position.exitTargetAt,
          store: this.store,
        });
        if (censorReason) {
          this._patch(position.id, {
            status: STATUS.RIGHT_CENSORED,
            exitReason: censorReason,
            estimatedCostSol: this._estimatedCostSol(position),
          });
          this.positions.delete(position.id);
          this._unindex(position);
          this.metrics.rightCensored += 1;
          continue;
        }
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
        if (!exit) continue;
        if (position.coreExitTargetAt > 0
          && now >= position.coreExitTargetAt
          && this._fillCoreFromCachedQuote(position, now, exit)) {
          // The core fill may activate the runner, but the position remains open.
        } else if (position.coreExitTargetAt > 0 && now > position.coreExitDeadlineAt) {
          position.coreExitTargetAt = 0;
          position.coreExitDeadlineAt = 0;
          this._patch(position.id, { coreExitTargetAt: 0, coreExitDeadlineAt: 0 });
        }
        if (now - position.entryAt >= exit.maxHoldMs) {
          this._requestExit(position, position.entryAt + exit.maxHoldMs, 'MAX_HOLD');
          this._closeFromCachedQuote(position, now);
        }
      }
    }
    const cutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      this._pruneState(state, now);
      if (state.lastAt < cutoff && !this.rowsByMint.has(mint)) this.states.delete(mint);
    }
    for (const [key, at] of this.lastEpisodes) if (at < cutoff) this.lastEpisodes.delete(key);
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
      ageMs: finite(trade.ageMs),
      curvePct: finite(trade.curvePct),
    });
    this._pruneState(state, trade.timestampMs);
  }

  _pruneState(state, timestampMs) {
    const cutoff = timestampMs - this.config.featureWindowMs;
    while (state.trades.length && state.trades[0].timestampMs < cutoff) state.trades.shift();
    if (state.trades.length > this.config.maxTradesPerMint) {
      state.trades.splice(0, state.trades.length - this.config.maxTradesPerMint);
    }
  }

  _windowReturn(rows) {
    return rows.length > 1 ? returnPct(rows[rows.length - 1].price, rows[0].price) : 0;
  }

  _features(mint, timestampMs) {
    const all = this.states.get(mint)?.trades || [];
    const rows15 = all.filter((row) => row.timestampMs >= timestampMs - 15_000 && row.timestampMs <= timestampMs);
    const rows5 = rows15.filter((row) => row.timestampMs >= timestampMs - 5_000);
    const rows2 = rows15.filter((row) => row.timestampMs >= timestampMs - 2_000);
    const previousRows2 = rows15.filter((row) => row.timestampMs >= timestampMs - 4_000
      && row.timestampMs < timestampMs - 2_000);
    const buys5 = rows5.filter((row) => row.side === 'BUY');
    const sells5 = rows5.filter((row) => row.side === 'SELL');
    const buys2 = rows2.filter((row) => row.side === 'BUY');
    const sells2 = rows2.filter((row) => row.side === 'SELL');
    const previousBuys2 = previousRows2.filter((row) => row.side === 'BUY');
    const previousSells2 = previousRows2.filter((row) => row.side === 'SELL');
    const latest = rows15[rows15.length - 1];
    const token = this.store.getToken(mint);
    const createdAt = finite(token?.created_at ?? token?.createdAt);
    const buyFlow5s = buys5.reduce((sum, row) => sum + row.solAmount, 0);
    const sellFlow5s = sells5.reduce((sum, row) => sum + row.solAmount, 0);
    const buyFlow2s = buys2.reduce((sum, row) => sum + row.solAmount, 0);
    const sellFlow2s = sells2.reduce((sum, row) => sum + row.solAmount, 0);
    const previousBuyFlow2s = previousBuys2.reduce((sum, row) => sum + row.solAmount, 0);
    const previousSellFlow2s = previousSells2.reduce((sum, row) => sum + row.solAmount, 0);
    const max15 = Math.max(0, ...rows15.map((row) => row.price));
    const first15 = rows15[0]?.price;
    return {
      ageMs: finite(latest?.ageMs, createdAt == null ? null : timestampMs - createdAt),
      curvePct: finite(latest?.curvePct),
      buyers2s: new Set(buys2.map((row) => row.wallet).filter(Boolean)).size,
      previousBuyers2s: new Set(previousBuys2.map((row) => row.wallet).filter(Boolean)).size,
      buyers5s: new Set(buys5.map((row) => row.wallet).filter(Boolean)).size,
      buyTx5s: buys5.length,
      sellTx5s: sells5.length,
      buyFlow5s,
      sellFlow5s,
      netFlow5s: buyFlow5s - sellFlow5s,
      buyFlow2s,
      sellFlow2s,
      netFlow2s: buyFlow2s - sellFlow2s,
      previousNetFlow2s: previousBuyFlow2s - previousSellFlow2s,
      buyTxShare2sPct: rows2.length ? buys2.length / rows2.length * 100 : 0,
      buyTxSharePct: rows5.length ? buys5.length / rows5.length * 100 : 0,
      return2sPct: this._windowReturn(rows2),
      return5sPct: this._windowReturn(rows5),
      return15sPct: this._windowReturn(rows15),
      runup15sPct: first15 > 0 ? (max15 / first15 - 1) * 100 : 0,
      drawdown15sPct: max15 > 0 && latest?.price > 0 ? (1 - latest.price / max15) * 100 : 0,
    };
  }

  _matches(profile, features) {
    const min = (value, limit) => limit == null || (value != null && value >= limit);
    const max = (value, limit) => limit == null || (value != null && value <= limit);
    return min(features.ageMs, profile.minAgeMs)
      && max(features.ageMs, profile.maxAgeMs)
      && max(features.curvePct, profile.maxCurvePct)
      && min(features.buyers5s, profile.minBuyers5s)
      && min(features.netFlow5s, profile.minNetFlow5sSol)
      && min(features.buyTxSharePct, profile.minBuyTxSharePct)
      && max(features.buyTxSharePct, profile.maxBuyTxSharePct)
      && min(features.return2sPct, profile.minReturn2sPct)
      && max(features.return2sPct, profile.maxReturn2sPct)
      && min(features.return5sPct, profile.minReturn5sPct)
      && max(features.return5sPct, profile.maxReturn5sPct)
      && max(features.return15sPct, profile.maxReturn15sPct)
      && min(features.drawdown15sPct, profile.minDrawdown15sPct);
  }

  _evaluate(trade, price) {
    const features = this._features(trade.mint, trade.timestampMs);
    this.metrics.evaluatedStates += 1;
    const results = [];
    for (const profile of this.entryProfiles.values()) {
      if (profile.newEntriesEnabled === false) {
        if (this._matches(profile, features)) this.metrics.retiredEntrySignalsSuppressed += 1;
        continue;
      }
      const key = profile.exclusiveGroup
        ? `${trade.mint}:GROUP:${profile.exclusiveGroup}`
        : `${trade.mint}:${profile.id}`;
      const prior = this.lastEpisodes.get(key);
      if (prior != null && trade.timestampMs - prior < this.config.episodeCooldownMs) {
        if (profile.exclusiveGroup && this._matches(profile, features)) {
          this.metrics.exclusiveSignalsSuppressed += 1;
        }
        continue;
      }
      if (!this._matches(profile, features)) continue;
      this.lastEpisodes.set(key, trade.timestampMs);
      this.lastEpisodes.set(`${trade.mint}:${profile.id}`, trade.timestampMs);
      results.push(...this._recordSignal(profile, trade, price, features));
    }
    return results;
  }

  _recordSignal(profile, trade, price, features) {
    const episodeId = `${trade.mint}:${profile.id}:${trade.timestampMs}`;
    const results = [];
    this.metrics.qualifiedSignals += 1;
    if (profile.liveStrategyId && this.onLiveSignal) {
      try {
        this.onLiveSignal({
          strategyId: profile.liveStrategyId,
          episodeId,
          mint: trade.mint,
          symbol: trade.symbol || this.store.getToken(trade.mint)?.symbol || null,
          price,
          slot: trade.slot ?? null,
          timestampMs: trade.timestampMs,
          receivedAtMs: trade.receivedAtMs ?? trade.timestampMs,
          market: trade.market,
          virtualSolReservesRaw: trade.virtualSolReservesRaw ?? null,
          virtualTokenReservesRaw: trade.virtualTokenReservesRaw ?? null,
          features: {
            ...features,
            shadowEntryProfileId: profile.id,
            shadowExitProfileId: profile.liveExitProfileId
              || profile.exitProfileIds?.[0]
              || null,
          },
        });
        this.metrics.liveSignals += 1;
        this.metrics.lastLiveSignalError = null;
      } catch (error) {
        this.metrics.liveSignalErrors += 1;
        this.metrics.lastLiveSignalError = String(error?.message || error);
      }
    }
    const permittedExitIds = profile.exitProfileIds?.length
      ? new Set(profile.exitProfileIds)
      : null;
    const positionSol = profile.positionSizeSol ?? this.config.positionSizeSol;
    const profileCosts = this.profileCosts.get(profile.id) || this.costs;
    const entryDelayMs = profile.entryDelayMs ?? this.config.entryDelayMs;
    const entryTimeoutMs = profile.entryTimeoutMs ?? this.config.entryTimeoutMs;
    for (const exit of this.exitProfiles.values()) {
      if (permittedExitIds && !permittedExitIds.has(exit.id)) continue;
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
        positionSol,
        configuredCostPct: profileCosts.deterministicCostPct,
        signalAt: trade.timestampMs,
        signalMarket: trade.market,
        signalPrice: price,
        ageMs: features.ageMs,
        curvePct: features.curvePct,
        buyers2s: features.buyers2s,
        buyers5s: features.buyers5s,
        buyTx5s: features.buyTx5s,
        sellTx5s: features.sellTx5s,
        buyFlow5s: features.buyFlow5s,
        sellFlow5s: features.sellFlow5s,
        netFlow5s: features.netFlow5s,
        buyTxSharePct: features.buyTxSharePct,
        return2sPct: features.return2sPct,
        return5sPct: features.return5sPct,
        return15sPct: features.return15sPct,
        runup15sPct: features.runup15sPct,
        drawdown15sPct: features.drawdown15sPct,
        featuresJson: JSON.stringify({
          ...features,
          liveReplay: profile.liveReplay === true,
          simulatedPositionSol: positionSol,
          maxEntryPriceJumpPct: profile.maxEntryPriceJumpPct
            ?? this.config.maxEntryPriceJumpPct,
          maxEntryImpactPct: profile.maxEntryImpactPct ?? this.config.maxEntryImpactPct,
        }),
        entryTargetAt: trade.timestampMs + entryDelayMs,
        entryDeadlineAt: trade.timestampMs + entryDelayMs + entryTimeoutMs,
        createdAt: now,
        updatedAt: now,
      });
      if (!result.changes) continue;
      const row = this.store.db.prepare('SELECT * FROM cya_organic_burst_shadow_positions WHERE id=?')
        .get(Number(result.lastInsertRowid));
      const position = camelRow(row);
      this.pendingEntries.set(position.id, position);
      this._index(position);
      results.push(row);
    }
    this.metrics.lastActionAt = this.now();
    return results;
  }

  _observePositions(trade, marketPrice, { allowEntryFill = true } = {}) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const position = this.pendingEntries.get(id) || this.positions.get(id);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        // Smart-wallet trades are future labels only. They must never provide
        // the simulated public fill that turns a causal signal into an entry.
        if (!allowEntryFill) continue;
        if (trade.timestampMs < position.entryTargetAt || trade.timestampMs > position.entryDeadlineAt
          || trade.market !== position.signalMarket) continue;
        this._open(position, trade, marketPrice);
        continue;
      }
      if (!this._comparable(position, trade, marketPrice)) continue;
      this._rememberPoolQuote(position, trade, marketPrice);
      if (position.status === STATUS.EXIT_PENDING) {
        if (trade.timestampMs >= position.exitTargetAt && trade.timestampMs <= position.exitDeadlineAt) {
          this._close(position, trade, marketPrice);
        }
        continue;
      }
      if (position.status !== STATUS.OPEN || trade.timestampMs < position.entryAt) continue;
      this._mark(position, trade, marketPrice);
      const exit = this.exitProfiles.get(position.exitProfileId);
      if (!exit) continue;
      const heldMs = trade.timestampMs - position.entryAt;
      if (position.coreExitTargetAt > 0 && !position.coreExitAt) {
        if (trade.timestampMs >= position.coreExitTargetAt
          && trade.timestampMs <= position.coreExitDeadlineAt) {
          this._fillCore(position, trade, marketPrice, exit);
        } else if (trade.timestampMs > position.coreExitDeadlineAt) {
          position.coreExitTargetAt = 0;
          position.coreExitDeadlineAt = 0;
          this._patch(position.id, { coreExitTargetAt: 0, coreExitDeadlineAt: 0 });
        }
      }
      if (exit.structureInvalidationEnabled && heldMs >= exit.minInvalidationHoldMs
        && heldMs <= exit.invalidationWindowMs) {
        const recent = this._features(position.mint, trade.timestampMs).return2sPct;
        const drawdown = position.highestPrice > 0 ? (1 - marketPrice / position.highestPrice) * 100 : 0;
        position.recentReturn2sPct = recent;
        this._patch(position.id, { recentReturn2sPct: recent });
        if (drawdown >= exit.invalidationDrawdownPct && recent <= exit.maxInvalidationReturn2sPct) {
          this.metrics.structureInvalidations += 1;
          this._requestExit(position, trade.timestampMs, 'STRUCTURE_INVALIDATION');
          continue;
        }
      }
      if (this._evaluateDynamicExit(position, trade, marketPrice, exit, heldMs)) continue;
      if (heldMs >= exit.maxHoldMs) this._requestExit(position, position.entryAt + exit.maxHoldMs, 'MAX_HOLD');
    }
  }

  _evaluateDynamicExit(position, trade, marketPrice, exit, heldMs) {
    const gross = returnPct(marketPrice, position.averageEntryPrice) || 0;
    const peak = returnPct(position.highestPrice, position.averageEntryPrice) || 0;
    const drawdown = position.highestPrice > 0
      ? (1 - marketPrice / position.highestPrice) * 100
      : 0;
    if (exit.hardStopPct > 0 && gross <= -exit.hardStopPct) {
      this._requestExit(position, trade.timestampMs, 'HARD_STOP');
      return true;
    }
    if (exit.mode === 'FLOW_FADE' && heldMs >= (exit.minHoldMs || 0)) {
      const features = this._features(position.mint, trade.timestampMs);
      const netFlowFlip = features.previousNetFlow2s > 0 && features.netFlow2s < 0;
      const sellPressure = features.sellFlow2s > 0
        && features.sellFlow2s / Math.max(0.001, features.buyFlow2s)
          >= (exit.minSellBuyFlowRatio || 0.8);
      const buyerRetention = features.previousBuyers2s > 0
        ? features.buyers2s / features.previousBuyers2s
        : 1;
      const buyerStall = features.previousBuyers2s >= 2
        && buyerRetention <= (exit.maxBuyerRetentionRatio || 0.5);
      const votes = Number(netFlowFlip) + Number(sellPressure) + Number(buyerStall);
      if (votes >= (exit.minFadeVotes || 2)) {
        this.metrics.flowFadeExits += 1;
        this._requestExit(position, trade.timestampMs, `FLOW_FADE_${votes}OF3`);
        return true;
      }
    }
    if (exit.mode === 'TRAILING'
      && heldMs >= (exit.minHoldMs || 0)
      && peak >= exit.trailingActivationPct
      && drawdown >= exit.trailingStopPct) {
      this.metrics.trailingExits += 1;
      this._requestExit(position, trade.timestampMs,
        `TRAILING_T${exit.trailingActivationPct}_D${exit.trailingStopPct}`);
      return true;
    }
    if (exit.mode === 'CORE_RUNNER') {
      if (!position.coreExitAt && !(position.coreExitTargetAt > 0)
        && gross >= exit.coreActivationPct) {
        position.coreExitTargetAt = trade.timestampMs + this.config.exitDelayMs;
        position.coreExitDeadlineAt = position.coreExitTargetAt + this.config.exitTimeoutMs;
        position.coreWeightPct = exit.coreWeightPct;
        this._patch(position.id, {
          coreExitTargetAt: position.coreExitTargetAt,
          coreExitDeadlineAt: position.coreExitDeadlineAt,
          coreWeightPct: position.coreWeightPct,
        });
      }
      if (position.coreExitAt) {
        const tier = this._runnerTier(exit, peak);
        position.runnerTier = tier?.label || null;
        position.runnerStopPrice = tier
          ? position.highestPrice * (1 - tier.drawdownPct / 100)
          : null;
        this._patch(position.id, {
          runnerTier: position.runnerTier,
          runnerStopPrice: position.runnerStopPrice,
        });
        if (tier && marketPrice <= position.runnerStopPrice) {
          this.metrics.runnerExits += 1;
          this._requestExit(position, trade.timestampMs, `RUNNER_${tier.label}`);
          return true;
        }
      }
    }
    return false;
  }

  _runnerTier(exit, peakReturnPct) {
    let active = null;
    for (const tier of exit.trailingTiers || []) {
      if (peakReturnPct >= tier.activationPct) {
        active = {
          ...tier,
          label: `T${tier.activationPct}_D${tier.drawdownPct}`,
        };
      }
    }
    return active;
  }

  _fillCore(position, trade, marketPrice, exit) {
    const weight = Math.max(0, Math.min(1, (exit.coreWeightPct || 0) / 100));
    const coreUnits = position.tokenUnits * weight;
    const markReturnPct = returnPct(marketPrice, position.averageEntryPrice);
    const execution = executableSell(trade, coreUnits, marketPrice, {
      rugMarkReturnPct: markReturnPct,
    });
    if (!(execution.price > 0)) return;
    position.coreExitAt = trade.timestampMs;
    position.coreExitPrice = execution.price;
    position.coreExitMarketPrice = marketPrice;
    position.coreExitImpactPct = execution.impactPct;
    position.coreProceedsSol = execution.proceedsSol ?? coreUnits * execution.price;
    position.coreWeightPct = exit.coreWeightPct;
    position.coreExitTargetAt = 0;
    position.coreExitDeadlineAt = 0;
    this._patch(position.id, {
      coreExitTargetAt: 0,
      coreExitDeadlineAt: 0,
      coreExitAt: position.coreExitAt,
      coreExitPrice: position.coreExitPrice,
      coreExitMarketPrice: position.coreExitMarketPrice,
      coreExitImpactPct: position.coreExitImpactPct,
      coreProceedsSol: position.coreProceedsSol,
      coreWeightPct: position.coreWeightPct,
    });
    this.metrics.coreExits += 1;
  }

  _comparable(position, trade, price) {
    void price;
    // A COB return is valid only inside the exact market where the simulated
    // fill happened. Bonding Curve and PumpSwap prices use different reserve
    // domains; accepting a later PUMP_AMM print silently manufactured both
    // huge winners and huge losses. Migration before an observed same-market
    // exit is right-censored (NO_EXIT), never a priced close.
    return Boolean(position.entryMarket)
      && String(trade.market || '') === String(position.entryMarket);
  }

  _open(position, trade, marketPrice) {
    const profile = this.entryProfiles.get(position.entryProfileId);
    const selectiveRugPair = profile?.rugGuardMode === 'LIVE_CURVE_CATASTROPHE';
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: `CYA_ORGANIC_BURST:${position.cohortId}`,
      mint: position.mint,
      timestampMs: trade.timestampMs,
      source: 'SHADOW',
      market: 'PUMP_BONDING_CURVE',
      lifecycleStage: 'CURVE_EARLY',
      ...(selectiveRugPair ? {
        enforcementMode: 'HARD_BLOCK',
        hardBlockSignatures: LIVE_CURVE_HARD_BLOCK_SIGNATURES,
        policyReason: 'SHADOW_LIVE_CURVE_CATASTROPHE_PAIRED',
      } : {
        enforcementMode: 'LABEL_ONLY',
        policyReason: 'CYA_SHADOW_RESEARCH_LABEL_ONLY',
      }),
    });
    if (rugGuard.blocked) {
      this._patch(position.id, {
        status: STATUS.NO_ENTRY,
        rejectionReason: rugGuard.reason || 'PRE_ENTRY_RUG_RISK',
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.rugGuardRejected += 1;
      return;
    }
    const execution = executableBuy(trade, position.positionSol, marketPrice);
    if (!execution.available || !(execution.price > 0)) {
      this._patch(position.id, { status: STATUS.NO_ENTRY, rejectionReason: execution.reason });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.noEntry += 1;
      return;
    }
    const jumpPct = returnPct(execution.price, position.signalPrice);
    const maxEntryPriceJumpPct = profile?.maxEntryPriceJumpPct
      ?? this.config.maxEntryPriceJumpPct;
    const maxEntryPriceDropPct = profile?.maxEntryPriceDropPct
      ?? this.config.maxEntryPriceDropPct;
    const maxEntryImpactPct = profile?.maxEntryImpactPct
      ?? this.config.maxEntryImpactPct;
    if (jumpPct > maxEntryPriceJumpPct || jumpPct < -maxEntryPriceDropPct
      || execution.impactPct > maxEntryImpactPct) {
      this._patch(position.id, {
        status: STATUS.PRICE_JUMP,
        rejectionReason: execution.impactPct > maxEntryImpactPct
          ? `ENTRY_IMPACT_${execution.impactPct.toFixed(2)}PCT`
          : `ENTRY_PRICE_MOVE_${jumpPct.toFixed(2)}PCT`,
        entryJumpPct: jumpPct,
        entryImpactPct: execution.impactPct,
      });
      this.pendingEntries.delete(position.id);
      this._unindex(position);
      this.metrics.priceJump += 1;
      return;
    }
    Object.assign(position, {
      status: STATUS.OPEN,
      entryAt: trade.timestampMs,
      entryMarket: trade.market,
      entryPrice: execution.price,
      averageEntryPrice: execution.price,
      totalInvestedSol: position.positionSol,
      tokenUnits: execution.tokenUnits,
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      lastPrice: marketPrice,
      lastMarket: trade.market,
      maxFavorableReturnPct: Math.max(0, returnPct(marketPrice, execution.price)),
      maxAdverseReturnPct: Math.min(0, returnPct(marketPrice, execution.price)),
    });
    this._rememberPoolQuote(position, trade, marketPrice, { persist: false });
    this._patch(position.id, {
      status: STATUS.OPEN,
      entryAt: position.entryAt,
      entryMarket: position.entryMarket,
      entryPrice: position.entryPrice,
      entryMarketPrice: marketPrice,
      entryJumpPct: jumpPct,
      entryImpactPct: execution.impactPct,
      averageEntryPrice: position.averageEntryPrice,
      totalInvestedSol: position.totalInvestedSol,
      tokenUnits: position.tokenUnits,
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      lastObservedAt: trade.timestampMs,
      lastMarket: trade.market,
      lastPrice: marketPrice,
      lastPoolQuoteJson: position.lastPoolQuote
        ? JSON.stringify(position.lastPoolQuote) : null,
      lastPoolQuoteAt: position.lastPoolQuoteAt,
      lastPoolQuoteMarket: position.lastPoolQuoteMarket,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
    this.pendingEntries.delete(position.id);
    this.positions.set(position.id, position);
    this.metrics.opened += 1;
  }

  _mark(position, trade, price) {
    position.highestPrice = Math.max(position.highestPrice || price, price);
    position.lowestPrice = Math.min(position.lowestPrice || price, price);
    position.lastPrice = price;
    position.lastMarket = trade.market;
    position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct || 0,
      returnPct(position.highestPrice, position.averageEntryPrice) || 0);
    position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct || 0,
      returnPct(position.lowestPrice, position.averageEntryPrice) || 0);
    this._patch(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: trade.timestampMs,
      lastMarket: trade.market,
      lastPrice: price,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _rememberPoolQuote(position, trade, marketPrice, { persist = true } = {}) {
    if (!position || trade?.market !== position.entryMarket) return false;
    const quote = capturePoolQuote(trade, marketPrice);
    if (!quote) return false;
    position.lastPoolQuote = quote;
    position.lastPoolQuoteAt = quote.timestampMs;
    position.lastPoolQuoteMarket = quote.market;
    if (persist) {
      this._patch(position.id, {
        lastPoolQuoteJson: JSON.stringify(quote),
        lastPoolQuoteAt: quote.timestampMs,
        lastPoolQuoteMarket: quote.market,
      });
    }
    return true;
  }

  _cachedQuoteTrade(position, now) {
    if (!cacheIsUsableForExit({
      quote: position.lastPoolQuote,
      mint: position.mint,
      entryMarket: position.entryMarket,
      exitTargetAt: position.exitTargetAt,
      now,
      store: this.store,
    })) return null;
    return quoteTrade(position.lastPoolQuote, position.mint);
  }

  _closeFromCachedQuote(position, now) {
    if (position.status !== STATUS.EXIT_PENDING || now < position.exitTargetAt) return false;
    const trade = this._cachedQuoteTrade(position, now);
    const marketPrice = quotePrice(position.lastPoolQuote);
    if (!trade || !(marketPrice > 0)) return false;
    const closed = this._close(position, {
      ...trade,
      timestampMs: Math.max(position.exitTargetAt, trade.timestampMs),
    }, marketPrice);
    if (closed) this.metrics.cachedReserveExits += 1;
    return closed;
  }

  _fillCoreFromCachedQuote(position, now, exit) {
    if (position.status !== STATUS.OPEN || position.coreExitAt
      || !(position.coreExitTargetAt > 0) || now < position.coreExitTargetAt) return false;
    const originalTarget = position.exitTargetAt;
    position.exitTargetAt = position.coreExitTargetAt;
    const trade = this._cachedQuoteTrade(position, now);
    position.exitTargetAt = originalTarget;
    const marketPrice = quotePrice(position.lastPoolQuote);
    if (!trade || !(marketPrice > 0)) return false;
    this._fillCore(position, {
      ...trade,
      timestampMs: Math.max(position.coreExitTargetAt, trade.timestampMs),
    }, marketPrice, exit);
    const filled = Boolean(position.coreExitAt);
    if (filled) this.metrics.cachedReserveCoreExits += 1;
    return filled;
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    Object.assign(position, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTargetAt: triggerAt + this.config.exitDelayMs,
      exitDeadlineAt: triggerAt + this.config.exitDelayMs + this.config.exitTimeoutMs,
    });
    this._patch(position.id, {
      status: STATUS.EXIT_PENDING,
      exitReason: reason,
      exitTriggerAt: triggerAt,
      exitTargetAt: position.exitTargetAt,
      exitDeadlineAt: position.exitDeadlineAt,
    });
  }

  _estimatedCostSol(position) {
    const costs = this.profileCosts.get(position.entryProfileId) || this.costs;
    const variablePct = costs.platformFeePct + costs.buySlippagePct + costs.sellSlippagePct;
    const executions = position.coreExitAt ? 3 : 2;
    return position.totalInvestedSol * variablePct / 100
      + costs.totalFixedCostSol * executions;
  }

  _close(position, trade, marketPrice) {
    const markReturnPct = returnPct(marketPrice, position.averageEntryPrice);
    const coreWeight = position.coreExitAt
      ? Math.max(0, Math.min(1, position.coreWeightPct / 100))
      : 0;
    const remainingUnits = position.tokenUnits * (1 - coreWeight);
    const execution = executableSell(trade, remainingUnits, marketPrice, {
      rugMarkReturnPct: markReturnPct,
    });
    if (execution.price == null) return false;
    const runnerProceedsSol = execution.proceedsSol ?? remainingUnits * execution.price;
    const proceedsSol = (position.coreProceedsSol || 0) + runnerProceedsSol;
    const grossReturnPct = (proceedsSol / position.totalInvestedSol - 1) * 100;
    const estimatedCostSol = this._estimatedCostSol(position);
    const netReturnPct = (proceedsSol - estimatedCostSol) / position.totalInvestedSol * 100 - 100;
    this._patch(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: execution.price,
      exitMarketPrice: marketPrice,
      exitImpactPct: execution.impactPct,
      exitReason: position.exitReason,
      grossReturnPct,
      netReturnPct,
      estimatedCostSol,
      holdMs: trade.timestampMs - position.entryAt,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
    return true;
  }

  _patch(id, values) {
    const fields = [
      'status', 'rejectionReason', 'entryAt', 'entryMarket', 'entryPrice',
      'entryMarketPrice', 'entryJumpPct', 'entryImpactPct', 'averageEntryPrice',
      'totalInvestedSol', 'tokenUnits', 'highestPrice', 'lowestPrice',
      'lastObservedAt', 'lastMarket', 'lastPrice', 'lastPoolQuoteJson',
      'lastPoolQuoteAt', 'lastPoolQuoteMarket', 'recentReturn2sPct',
      'maxFavorableReturnPct', 'maxAdverseReturnPct', 'exitTriggerAt',
      'coreExitTargetAt', 'coreExitDeadlineAt', 'coreExitAt', 'coreExitPrice',
      'coreExitMarketPrice', 'coreExitImpactPct', 'coreProceedsSol',
      'coreWeightPct', 'runnerStopPrice', 'runnerTier',
      'exitTargetAt', 'exitDeadlineAt', 'exitAt', 'exitMarket', 'exitPrice',
      'exitMarketPrice', 'exitImpactPct', 'exitReason', 'grossReturnPct',
      'netReturnPct', 'estimatedCostSol', 'holdMs',
    ];
    const row = { id, updatedAt: this.now() };
    for (const field of fields) row[field] = values[field] ?? null;
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
      SELECT * FROM cya_organic_burst_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC LIMIT ?
    `).all(limit);
    const groups = this.store.db.prepare(`
      SELECT cohort_id, entry_profile_id, exit_profile_id,
        COUNT(*) signals, COUNT(DISTINCT mint) independent_mints,
        SUM(status='PRICE_JUMP') price_jump, SUM(status='NO_ENTRY') no_entry,
        SUM(status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING')) active,
        SUM(status='CLOSED' AND net_return_pct IS NOT NULL
          AND entry_market=exit_market) resolved,
        SUM(status='NO_EXIT') no_exit,
        SUM(status='RIGHT_CENSORED') right_censored,
        SUM(status='CLOSED' AND net_return_pct IS NOT NULL
          AND entry_market=exit_market) priced_exits,
        SUM(status='CLOSED' AND (net_return_pct IS NULL
          OR entry_market IS NULL OR exit_market IS NULL
          OR entry_market<>exit_market)) closed_without_return,
        AVG(age_ms) average_age_ms, AVG(curve_pct) average_curve_pct,
        AVG(buyers_5s) average_buyers_5s, AVG(net_flow_5s) average_net_flow_5s,
        AVG(buy_tx_share_pct) average_buy_tx_share_pct,
        AVG(entry_impact_pct) average_entry_impact_pct,
        AVG(exit_impact_pct) average_exit_impact_pct,
        AVG(max_favorable_return_pct) average_mfe_pct,
        AVG(max_adverse_return_pct) average_mae_pct,
        AVG(CASE WHEN status='CLOSED' AND entry_market=exit_market
          THEN net_return_pct END) average_net_return_pct,
        AVG(CASE WHEN target_open_delay_ms BETWEEN 0 AND 5000 THEN 100.0 ELSE 0 END)
          target_open_5s_rate_pct,
        AVG(CASE WHEN status='CLOSED' AND entry_market=exit_market
          THEN CASE WHEN net_return_pct>0 THEN 100.0 ELSE 0 END END)
          win_rate_pct,
        AVG(CASE WHEN status='CLOSED' AND entry_market=exit_market
          THEN CASE WHEN net_return_pct>=50 THEN 100.0 ELSE 0 END END)
          big50_rate_pct,
        AVG(CASE WHEN status='CLOSED' AND entry_market=exit_market
          THEN CASE WHEN net_return_pct>=100 THEN 100.0 ELSE 0 END END)
          big100_rate_pct,
        MAX(CASE WHEN status='CLOSED' AND entry_market=exit_market
          THEN net_return_pct END) max_winner_pct
      FROM cya_organic_burst_shadow_positions
      GROUP BY cohort_id, entry_profile_id, exit_profile_id
      ORDER BY entry_profile_id, exit_profile_id
    `).all();
    const returns = this.store.db.prepare(`
      SELECT net_return_pct FROM cya_organic_burst_shadow_positions
      WHERE cohort_id=? AND status='CLOSED' AND net_return_pct IS NOT NULL
        AND entry_market=exit_market
      ORDER BY net_return_pct
    `);
    const cohorts = groups.map((group) => {
      const values = returns.all(group.cohort_id).map((row) => Number(row.net_return_pct));
      const wins = values.filter((value) => value > 0);
      const losses = values.filter((value) => value < 0);
      const profit = wins.reduce((sum, value) => sum + value, 0);
      const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const netReturnSum = values.reduce((sum, value) => sum + value, 0);
      const entered = Number(group.resolved || 0) + Number(group.no_exit || 0)
        + Number(group.active || 0);
      const completedEntered = Number(group.resolved || 0) + Number(group.no_exit || 0);
      const unpricedExits = Number(group.no_exit || 0) + Number(group.closed_without_return || 0);
      const pricedExits = Number(group.priced_exits || 0);
      const pricedAndUnpricedExits = pricedExits + unpricedExits;
      const stressAverage = (assumedNoExitReturnPct) => (
        pricedAndUnpricedExits > 0
          ? (netReturnSum + unpricedExits * assumedNoExitReturnPct) / pricedAndUnpricedExits
          : null
      );
      const middle = Math.floor(values.length / 2);
      const top5Profit = [...wins].sort((a, b) => b - a).slice(0, 5).reduce((sum, value) => sum + value, 0);
      const exitPriceCoveragePct = completedEntered > 0
        ? pricedExits / completedEntered * 100
        : null;
      const noExitRatePct = completedEntered > 0
        ? unpricedExits / completedEntered * 100
        : null;
      const stress30 = stressAverage(-30);
      const profitFactor = loss > 0 ? profit / loss : (profit > 0 ? null : 0);
      const promotionBlockers = [];
      if (pricedExits < 200) promotionBlockers.push('PRICED<200');
      if (!(exitPriceCoveragePct >= 90)) promotionBlockers.push('EXIT_COVERAGE<90%');
      if (!(noExitRatePct <= 5)) promotionBlockers.push('NO_EXIT>5%');
      if (!(stress30 > 0)) promotionBlockers.push('S30<=0');
      if (!(profitFactor > 1.2)) promotionBlockers.push('PF<=1.2');
      return {
        ...group,
        entered,
        completed_entered: completedEntered,
        unpriced_exits: unpricedExits,
        entry_coverage_pct: Number(group.signals) > 0 ? entered / Number(group.signals) * 100 : null,
        exit_price_coverage_pct: exitPriceCoveragePct,
        priced_signal_coverage_pct: Number(group.signals) > 0
          ? pricedExits / Number(group.signals) * 100 : null,
        no_exit_rate_pct: noExitRatePct,
        stress_average_net_return_30_pct: stress30,
        stress_average_net_return_50_pct: stressAverage(-50),
        stress_average_net_return_80_pct: stressAverage(-80),
        median_net_return_pct: values.length
          ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null,
        profit_factor: profitFactor,
        top_5_winner_contribution_pct: profit > 0 ? top5Profit / profit * 100 : null,
        promotion_ready: promotionBlockers.length === 0,
        promotion_blockers: promotionBlockers,
      };
    });
    const rugPairRows = this.store.db.prepare(`
      SELECT b.mint, b.signal_at,
        b.status AS baseline_status,
        CASE WHEN b.entry_market=b.exit_market THEN b.net_return_pct END
          AS baseline_return_pct,
        f.status AS filtered_status,
        CASE WHEN f.entry_market=f.exit_market THEN f.net_return_pct END
          AS filtered_return_pct,
        f.rejection_reason AS filtered_reason
      FROM cya_organic_burst_shadow_positions f
      JOIN cya_organic_burst_shadow_positions b
        ON b.mint = f.mint
        AND b.signal_at = f.signal_at
        AND b.position_sol = f.position_sol
        AND b.exit_profile_id = f.exit_profile_id
      WHERE b.entry_profile_id = 'COB_F_LR01_FIX30'
        AND f.entry_profile_id = 'COB_F_LR01_FIX30_RUGX'
        AND b.exit_profile_id = 'FIX30'
        AND f.exit_profile_id = 'FIX30'
      ORDER BY f.signal_at DESC
    `).all();
    const rugComparison = buildShadowRugPairComparison({
      id: 'COB_F_LR01_FIX30_RUGX',
      label: '高频 COB-F LR01 · 0.1 SOL FIX30',
      baselineProfileId: 'COB_F_LR01_FIX30',
      filteredProfileId: 'COB_F_LR01_FIX30_RUGX',
      exitProfileId: 'FIX30',
      rows: rugPairRows,
    });
    const guardStrategyId = 'CYA_ORGANIC_BURST:COB_F_LR01_FIX30_RUGX_FIX30';
    const guardStats = this.store.preEntryRugRisk?.guardStrategies?.get(guardStrategyId);
    if (guardStats) {
      rugComparison.guardAudit = {
        strategyId: guardStrategyId,
        evaluated: Number(guardStats.evaluated || 0),
        sampleReady: Number(guardStats.sampleReady || 0),
        sampleInsufficient: Number(guardStats.sampleInsufficient || 0),
        riskFlagged: Number(guardStats.riskFlagged || 0),
        hardBlocked: Number(guardStats.hardBlocked || 0),
      };
    }
    const rugComparisons = [rugComparison];
    return { cohorts, positions, rugComparisons };
  }
}

module.exports = { CyaOrganicBurstShadowSuite, STATUS, priceOf };
