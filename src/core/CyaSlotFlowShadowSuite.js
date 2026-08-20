'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');

const STATUS = Object.freeze({
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

function returnPct(price, base) {
  return price > 0 && base > 0 ? (price / base - 1) * 100 : null;
}

function rowPosition(row) {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    entryProfileId: row.entry_profile_id,
    managementProfileId: row.management_profile_id,
    episodeId: row.episode_id,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    positionSol: finite(row.position_sol, 1),
    signalAt: finite(row.signal_at),
    signalMarket: row.signal_market,
    signalPrice: finite(row.signal_price),
    entryTargetAt: finite(row.entry_target_at),
    entryDeadlineAt: finite(row.entry_deadline_at),
    entryAt: finite(row.entry_at),
    entryMarket: row.entry_market,
    entryPrice: finite(row.entry_price),
    entryMarketPrice: finite(row.entry_market_price),
    averageEntryPrice: finite(row.average_entry_price),
    totalInvestedSol: finite(row.total_invested_sol, 0),
    tokenUnits: finite(row.token_units, 0),
    addCount: Math.max(0, Math.trunc(finite(row.add_count, 0))),
    lastAddAt: finite(row.last_add_at),
    lastAddPrice: finite(row.last_add_price),
    highestPrice: finite(row.highest_price),
    lowestPrice: finite(row.lowest_price),
    lastObservedAt: finite(row.last_observed_at),
    lastMarket: row.last_market,
    lastPrice: finite(row.last_price),
    maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
    maxAdverseReturnPct: finite(row.max_adverse_return_pct, 0),
    exitTargetAt: finite(row.exit_target_at),
    exitDeadlineAt: finite(row.exit_deadline_at),
    exitReason: row.exit_reason,
  };
}

function percentile(values, q) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper
    ? ordered[lower]
    : ordered[lower] * (upper - position) + ordered[upper] * (position - lower);
}

class CyaSlotFlowShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.managementProfiles = new Map(
      (config.managementProfiles || []).map((row) => [row.id, row]),
    );
    this.maxSignalAgeMs = Math.max(
      0,
      ...[...this.entryProfiles.values()].map((row) => finite(row.maxAgeMs, 0)),
    );
    this.excludedWallets = new Set(config.excludedWallets || []);
    this.targetWallet = config.targetWallet || null;
    if (this.targetWallet) this.excludedWallets.add(this.targetWallet);
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.lastEpisodes = new Map();
    this.metrics = {
      observedTrades: 0,
      observedPublicTrades: 0,
      excludedWalletTrades: 0,
      outOfOrderSlotTrades: 0,
      slotTransitions: 0,
      evaluatedTransitions: 0,
      qualifiedSignals: 0,
      replaySignalsSuppressed: 0,
      rugGuardRejected: 0,
      priceJump: 0,
      noEntry: 0,
      opened: 0,
      adds: 0,
      closed: 0,
      noExit: 0,
      futureTargetLabels: 0,
      lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS cya_slot_flow_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        management_profile_id TEXT NOT NULL,
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
        signal_age_ms INTEGER,
        source_slot INTEGER,
        trigger_slot INTEGER,
        public_buyers_5s INTEGER,
        public_buy_tx_5s INTEGER,
        public_sell_tx_5s INTEGER,
        public_buy_flow_5s REAL,
        public_sell_flow_5s REAL,
        public_net_flow_5s REAL,
        buy_tx_share_pct REAL,
        largest_buyer_share_pct REAL,
        return_5s_pct REAL,
        source_slot_buyers INTEGER,
        source_slot_buy_tx INTEGER,
        source_slot_sell_tx INTEGER,
        source_slot_net_flow REAL,
        creator_sell_tx_5s INTEGER,
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
        add_count INTEGER NOT NULL DEFAULT 0,
        last_add_at INTEGER,
        last_add_price REAL,
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
      CREATE INDEX IF NOT EXISTS idx_cya_slot_flow_status
        ON cya_slot_flow_shadow_positions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cya_slot_flow_mint
        ON cya_slot_flow_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cya_slot_flow_profiles
        ON cya_slot_flow_shadow_positions(entry_profile_id, management_profile_id);
    `);
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO cya_slot_flow_shadow_positions (
        cohort_id, entry_profile_id, management_profile_id, episode_id, mint, symbol,
        status, rejection_reason, position_sol, configured_cost_pct,
        signal_at, signal_market, signal_price, signal_age_ms, source_slot, trigger_slot,
        public_buyers_5s, public_buy_tx_5s, public_sell_tx_5s,
        public_buy_flow_5s, public_sell_flow_5s, public_net_flow_5s,
        buy_tx_share_pct, largest_buyer_share_pct, return_5s_pct,
        source_slot_buyers, source_slot_buy_tx, source_slot_sell_tx,
        source_slot_net_flow, creator_sell_tx_5s, features_json,
        entry_target_at, entry_deadline_at, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @managementProfileId, @episodeId, @mint, @symbol,
        @status, @rejectionReason, @positionSol, @configuredCostPct,
        @signalAt, @signalMarket, @signalPrice, @signalAgeMs, @sourceSlot, @triggerSlot,
        @publicBuyers5s, @publicBuyTx5s, @publicSellTx5s,
        @publicBuyFlow5s, @publicSellFlow5s, @publicNetFlow5s,
        @buyTxSharePct, @largestBuyerSharePct, @return5sPct,
        @sourceSlotBuyers, @sourceSlotBuyTx, @sourceSlotSellTx,
        @sourceSlotNetFlow, @creatorSellTx5s, @featuresJson,
        @entryTargetAt, @entryDeadlineAt, @createdAt, @updatedAt
      )
    `);
    this.active = this.store.db.prepare(`
      SELECT * FROM cya_slot_flow_shadow_positions
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') ORDER BY signal_at, id
    `);
    this.update = this.store.db.prepare(`
      UPDATE cya_slot_flow_shadow_positions SET
        status=COALESCE(@status,status),
        rejection_reason=COALESCE(@rejectionReason,rejection_reason),
        entry_at=COALESCE(@entryAt,entry_at),
        entry_market=COALESCE(@entryMarket,entry_market),
        entry_price=COALESCE(@entryPrice,entry_price),
        entry_market_price=COALESCE(@entryMarketPrice,entry_market_price),
        entry_jump_pct=COALESCE(@entryJumpPct,entry_jump_pct),
        entry_impact_pct=COALESCE(@entryImpactPct,entry_impact_pct),
        average_entry_price=COALESCE(@averageEntryPrice,average_entry_price),
        total_invested_sol=COALESCE(@totalInvestedSol,total_invested_sol),
        token_units=COALESCE(@tokenUnits,token_units),
        add_count=COALESCE(@addCount,add_count),
        last_add_at=COALESCE(@lastAddAt,last_add_at),
        last_add_price=COALESCE(@lastAddPrice,last_add_price),
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
        exit_market_price=COALESCE(@exitMarketPrice,exit_market_price),
        exit_impact_pct=COALESCE(@exitImpactPct,exit_impact_pct),
        exit_reason=COALESCE(@exitReason,exit_reason),
        gross_return_pct=COALESCE(@grossReturnPct,gross_return_pct),
        net_return_pct=COALESCE(@netReturnPct,net_return_pct),
        estimated_cost_sol=COALESCE(@estimatedCostSol,estimated_cost_sol),
        hold_ms=COALESCE(@holdMs,hold_ms),
        updated_at=@updatedAt
      WHERE id=@id
    `);
    this.markNoExit = this.store.db.prepare(`
      UPDATE cya_slot_flow_shadow_positions SET status='NO_EXIT',
        exit_reason=@exitReason, estimated_cost_sol=@estimatedCostSol, updated_at=@updatedAt
      WHERE id=@id
    `);
    this.labelTarget = this.store.db.prepare(`
      UPDATE cya_slot_flow_shadow_positions SET
        target_open_at=@targetOpenAt,
        target_open_delay_ms=@targetOpenAt-signal_at,
        updated_at=@updatedAt
      WHERE mint=@mint AND signal_at<@targetOpenAt
        AND signal_at>=@targetOpenAt-@labelWindowMs AND target_open_at IS NULL
    `);
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.active.all()) {
      const position = rowPosition(row);
      if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(position.id, position);
      else this.positions.set(position.id, position);
      this._index(position);
    }
    const recent = this.store.db.prepare(`
      SELECT mint, entry_profile_id, MAX(signal_at) signal_at
      FROM cya_slot_flow_shadow_positions WHERE signal_at>=?
      GROUP BY mint, entry_profile_id
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
      mode: 'SHADOW_CSF',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      managementProfiles: [...this.managementProfiles.values()],
      strategy: {
        name: 'CYA Slot Flow',
        code: 'CSF',
        targetWallet: this.targetWallet,
        positionSizeSol: this.config.positionSizeSol,
        featureWindowMs: this.config.featureWindowMs,
        maxTradesPerMint: this.config.maxTradesPerMint,
        maxSignalAgeMs: this.maxSignalAgeMs,
        entryDelayMs: this.config.entryDelayMs,
        targetLabelWindowMs: this.config.targetLabelWindowMs,
        sourceBoundary: 'COMPLETED_PREVIOUS_SLOT',
        excludedWalletCount: this.excludedWallets.size,
        research: {
          isolatedPositionTable: 'cya_slot_flow_shadow_positions',
          entryUsesTargetWallet: false,
          targetOpenIsFutureLabelOnly: true,
          sameWalletAddsIgnored: true,
          capacityAwareEntryAndExit: true,
          boundedPerMintQueue: true,
          scansAllStatesPerTrade: false,
          sendsTransactions: false,
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
    this._observePositions(trade, price);
    this.metrics.observedTrades += 1;

    // CSF features are pre-graduation only. Positions still see every comparable
    // trade above, but late Curve and all PumpSwap trades never allocate or scan
    // feature state. Global expiry is handled by the existing maintenance timer.
    if (trade.market !== 'PUMP_BONDING_CURVE') return [];
    const tradeAgeMs = finite(trade.ageMs);
    if (tradeAgeMs != null
      && tradeAgeMs > this.maxSignalAgeMs + this.config.featureWindowMs) {
      if (!this.rowsByMint.has(trade.mint)) this.states.delete(trade.mint);
      return [];
    }

    const excluded = this.excludedWallets.has(trade.wallet);
    const state = this._state(trade.mint);
    const slot = finite(trade.slot);
    if (slot != null && state.currentSlot != null && slot < state.currentSlot) {
      this.metrics.outOfOrderSlotTrades += 1;
      if (excluded) this.metrics.excludedWalletTrades += 1;
      else this.metrics.observedPublicTrades += 1;
      return [];
    }
    let signals = [];
    const isNewSlot = slot != null && state.currentSlot != null && slot > state.currentSlot;
    if (isNewSlot) {
      this.metrics.slotTransitions += 1;
      if (!excluded && !replay && trade.market === 'PUMP_BONDING_CURVE') {
        signals = this._evaluateCompletedSlot(state, trade);
      } else if (replay) this.metrics.replaySignalsSuppressed += 1;
      state.previousSlot = state.currentSlot;
      state.currentSlot = slot;
    } else if (state.currentSlot == null && slot != null) {
      state.currentSlot = slot;
    }
    if (excluded) {
      this.metrics.excludedWalletTrades += 1;
      state.lastAt = Math.max(state.lastAt, timestampMs);
      return signals;
    }
    this.metrics.observedPublicTrades += 1;
    this._appendPublicTrade(state, trade, price);
    return signals;
  }

  onSmartWalletEvent(event) {
    if (!this.config.enabled || !this.targetWallet || event?.wallet !== this.targetWallet
      || String(event?.side || '').toUpperCase() !== 'BUY'
      || String(event?.positionPhase || '').toUpperCase() !== 'OPEN') return 0;
    const targetOpenAt = finite(event.timestampMs);
    if (!(targetOpenAt > 0) || !event.mint) return 0;
    const result = this.labelTarget.run({
      mint: event.mint,
      targetOpenAt,
      labelWindowMs: this.config.targetLabelWindowMs,
      updatedAt: this.now(),
    });
    this.metrics.futureTargetLabels += result.changes;
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
      const profile = this.managementProfiles.get(position.managementProfileId);
      if (!profile) continue;
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
      } else if (position.status === STATUS.OPEN && now - position.entryAt >= profile.maxHoldMs) {
        this._requestExit(position, position.entryAt + profile.maxHoldMs, 'MAX_HOLD');
      }
    }
    const cutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      this._prune(state, now);
      if (state.lastAt < cutoff && !this.rowsByMint.has(mint)) this.states.delete(mint);
    }
    for (const [key, timestampMs] of this.lastEpisodes) {
      if (timestampMs < cutoff) this.lastEpisodes.delete(key);
    }
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      const token = this.store.getToken(mint);
      state = {
        mint,
        creator: token?.creator || null,
        currentSlot: null,
        previousSlot: null,
        lastAt: 0,
        trades: [],
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _appendPublicTrade(state, trade, price) {
    state.lastAt = Math.max(state.lastAt, trade.timestampMs);
    state.trades.push({
      timestampMs: trade.timestampMs,
      slot: finite(trade.slot),
      side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      price,
      ageMs: finite(trade.ageMs),
    });
    this._prune(state, trade.timestampMs);
  }

  _prune(state, timestampMs) {
    const cutoff = timestampMs - this.config.featureWindowMs;
    while (state.trades.length && state.trades[0].timestampMs < cutoff) state.trades.shift();
    const overflow = state.trades.length - this.config.maxTradesPerMint;
    if (overflow > 0) state.trades.splice(0, overflow);
  }

  _aggregate(rows, creator) {
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buyFlow = buys.reduce((sum, row) => sum + row.solAmount, 0);
    const sellFlow = sells.reduce((sum, row) => sum + row.solAmount, 0);
    const byBuyer = new Map();
    for (const row of buys) {
      if (!row.wallet) continue;
      byBuyer.set(row.wallet, (byBuyer.get(row.wallet) || 0) + row.solAmount);
    }
    const largest = Math.max(0, ...byBuyer.values());
    return {
      buyers: byBuyer.size,
      buyTx: buys.length,
      sellTx: sells.length,
      buyFlow,
      sellFlow,
      netFlow: buyFlow - sellFlow,
      buyTxSharePct: buys.length + sells.length
        ? buys.length / (buys.length + sells.length) * 100 : 0,
      largestBuyerSharePct: buyFlow > 0 ? largest / buyFlow * 100 : 100,
      creatorSellTx: creator
        ? sells.filter((row) => row.wallet === creator).length : 0,
    };
  }

  _features(state, triggerTrade) {
    const timestampMs = triggerTrade.timestampMs;
    const rows = state.trades.filter((row) => row.timestampMs >= timestampMs - this.config.featureWindowMs
      && row.timestampMs < timestampMs);
    const sourceSlot = state.currentSlot;
    const sourceRows = rows.filter((row) => row.slot === sourceSlot);
    const all = this._aggregate(rows, state.creator);
    const slot = this._aggregate(sourceRows, state.creator);
    const first = rows[0];
    const last = rows[rows.length - 1];
    return {
      ageMs: finite(triggerTrade.ageMs),
      sourceSlot,
      triggerSlot: finite(triggerTrade.slot),
      publicBuyers5s: all.buyers,
      publicBuyTx5s: all.buyTx,
      publicSellTx5s: all.sellTx,
      publicBuyFlow5s: all.buyFlow,
      publicSellFlow5s: all.sellFlow,
      publicNetFlow5s: all.netFlow,
      buyTxSharePct: all.buyTxSharePct,
      largestBuyerSharePct: all.largestBuyerSharePct,
      return5sPct: first?.price > 0 && last?.price > 0 ? returnPct(last.price, first.price) : 0,
      creatorSellTx5s: all.creatorSellTx,
      sourceSlotBuyers: slot.buyers,
      sourceSlotBuyTx: slot.buyTx,
      sourceSlotSellTx: slot.sellTx,
      sourceSlotNetFlow: slot.netFlow,
      sourcePrice: last?.price || priceOf(triggerTrade),
      sourceRows: sourceRows.length,
    };
  }

  _matches(profile, f) {
    return f.sourceRows > 0
      && f.ageMs >= profile.minAgeMs
      && f.ageMs <= profile.maxAgeMs
      && f.publicBuyers5s >= profile.minBuyers5s
      && f.publicNetFlow5s >= profile.minNetFlow5sSol
      && f.buyTxSharePct >= profile.minBuyTxSharePct
      && f.largestBuyerSharePct <= profile.maxLargestBuyerSharePct
      && f.return5sPct >= profile.minReturn5sPct
      && f.return5sPct <= profile.maxReturn5sPct
      && f.sourceSlotBuyers >= profile.minSourceSlotBuyers
      && f.sourceSlotNetFlow >= profile.minSourceSlotNetFlowSol
      && (!profile.requireCreatorNoSell || f.creatorSellTx5s === 0);
  }

  _evaluateCompletedSlot(state, trade) {
    const features = this._features(state, trade);
    this.metrics.evaluatedTransitions += 1;
    const results = [];
    for (const profile of this.entryProfiles.values()) {
      const key = `${trade.mint}:${profile.id}`;
      const prior = this.lastEpisodes.get(key);
      if (prior != null && trade.timestampMs - prior < this.config.episodeCooldownMs) continue;
      if (!this._matches(profile, features)) continue;
      this.lastEpisodes.set(key, trade.timestampMs);
      results.push(...this._recordSignal(profile, trade, features));
    }
    return results;
  }

  _recordSignal(entryProfile, trade, features) {
    const episodeId = `${trade.mint}:${entryProfile.id}:${trade.timestampMs}`;
    const now = this.now();
    const results = [];
    this.metrics.qualifiedSignals += 1;
    for (const management of this.managementProfiles.values()) {
      const result = this.insert.run({
        cohortId: `${entryProfile.id}:${management.id}`,
        entryProfileId: entryProfile.id,
        managementProfileId: management.id,
        episodeId,
        mint: trade.mint,
        symbol: trade.symbol || this.store.getToken(trade.mint)?.symbol || null,
        status: STATUS.PENDING_ENTRY,
        rejectionReason: null,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        signalAt: trade.timestampMs,
        signalMarket: trade.market,
        signalPrice: features.sourcePrice,
        signalAgeMs: features.ageMs,
        sourceSlot: features.sourceSlot,
        triggerSlot: features.triggerSlot,
        publicBuyers5s: features.publicBuyers5s,
        publicBuyTx5s: features.publicBuyTx5s,
        publicSellTx5s: features.publicSellTx5s,
        publicBuyFlow5s: features.publicBuyFlow5s,
        publicSellFlow5s: features.publicSellFlow5s,
        publicNetFlow5s: features.publicNetFlow5s,
        buyTxSharePct: features.buyTxSharePct,
        largestBuyerSharePct: features.largestBuyerSharePct,
        return5sPct: features.return5sPct,
        sourceSlotBuyers: features.sourceSlotBuyers,
        sourceSlotBuyTx: features.sourceSlotBuyTx,
        sourceSlotSellTx: features.sourceSlotSellTx,
        sourceSlotNetFlow: features.sourceSlotNetFlow,
        creatorSellTx5s: features.creatorSellTx5s,
        featuresJson: JSON.stringify(features),
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
        createdAt: now,
        updatedAt: now,
      });
      if (!result.changes) continue;
      const row = this.store.db.prepare(
        'SELECT * FROM cya_slot_flow_shadow_positions WHERE id=?',
      ).get(Number(result.lastInsertRowid));
      const position = rowPosition(row);
      this.pendingEntries.set(position.id, position);
      this._index(position);
      results.push(row);
    }
    this.metrics.lastActionAt = now;
    return results;
  }

  _observePositions(trade, marketPrice) {
    for (const id of [...(this.rowsByMint.get(trade.mint) || [])]) {
      const pending = this.pendingEntries.get(id);
      if (pending) {
        if (trade.timestampMs < pending.entryTargetAt
          || trade.timestampMs > pending.entryDeadlineAt
          || trade.market !== pending.signalMarket) continue;
        this._open(pending, trade, marketPrice);
        continue;
      }
      const position = this.positions.get(id);
      if (!position || trade.timestampMs < position.entryAt
        || !this._comparable(position, trade, marketPrice)) continue;
      if (position.status === STATUS.EXIT_PENDING) {
        if (trade.timestampMs >= position.exitTargetAt
          && trade.timestampMs <= position.exitDeadlineAt) this._close(position, trade, marketPrice);
        continue;
      }
      if (position.status !== STATUS.OPEN) continue;
      this._mark(position, trade, marketPrice);
      this._maybeAdd(position, trade, marketPrice);
      this._evaluateExit(position, trade.timestampMs, marketPrice);
    }
  }

  _comparable(position, trade, price) {
    if (trade.market === position.entryMarket || trade.market === position.lastMarket) return true;
    if (trade.market !== 'PUMP_AMM') return false;
    const reference = position.lastPrice || position.averageEntryPrice || position.entryPrice;
    const ratio = reference > 0 ? price / reference : 0;
    return ratio >= 0.05 && ratio <= 20;
  }

  _open(position, trade, marketPrice) {
    const rugGuard = evaluateUniversalRugGuard(this.store, {
      strategyId: `CYA_SLOT_FLOW:${position.cohortId}`,
      mint: position.mint,
      timestampMs: trade.timestampMs,
    });
    if (rugGuard.blocked) {
      this._patch(position.id, { status: STATUS.NO_ENTRY, rejectionReason: 'PRE_ENTRY_RUG_RISK' });
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
    if (jumpPct > this.config.maxEntryPriceJumpPct
      || jumpPct < -this.config.maxEntryPriceDropPct
      || execution.impactPct > this.config.maxEntryImpactPct) {
      this._patch(position.id, {
        status: STATUS.PRICE_JUMP,
        rejectionReason: execution.impactPct > this.config.maxEntryImpactPct
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
      entryMarketPrice: marketPrice,
      averageEntryPrice: execution.price,
      totalInvestedSol: position.positionSol,
      tokenUnits: execution.tokenUnits,
      addCount: 0,
      lastAddAt: trade.timestampMs,
      lastAddPrice: execution.price,
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      lastObservedAt: trade.timestampMs,
      lastMarket: trade.market,
      lastPrice: marketPrice,
      maxFavorableReturnPct: Math.max(0, returnPct(marketPrice, execution.price)),
      maxAdverseReturnPct: Math.min(0, returnPct(marketPrice, execution.price)),
    });
    this._patch(position.id, {
      status: STATUS.OPEN,
      entryAt: position.entryAt,
      entryMarket: position.entryMarket,
      entryPrice: position.entryPrice,
      entryMarketPrice: position.entryMarketPrice,
      entryJumpPct: jumpPct,
      entryImpactPct: execution.impactPct,
      averageEntryPrice: position.averageEntryPrice,
      totalInvestedSol: position.totalInvestedSol,
      tokenUnits: position.tokenUnits,
      addCount: 0,
      lastAddAt: position.lastAddAt,
      lastAddPrice: position.lastAddPrice,
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      lastObservedAt: trade.timestampMs,
      lastMarket: trade.market,
      lastPrice: marketPrice,
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
    position.lastObservedAt = trade.timestampMs;
    position.lastMarket = trade.market;
    position.lastPrice = price;
    position.maxFavorableReturnPct = Math.max(
      position.maxFavorableReturnPct || 0,
      returnPct(position.highestPrice, position.averageEntryPrice) || 0,
    );
    position.maxAdverseReturnPct = Math.min(
      position.maxAdverseReturnPct || 0,
      returnPct(position.lowestPrice, position.averageEntryPrice) || 0,
    );
    this._patch(position.id, {
      highestPrice: position.highestPrice,
      lowestPrice: position.lowestPrice,
      lastObservedAt: position.lastObservedAt,
      lastMarket: position.lastMarket,
      lastPrice: position.lastPrice,
      maxFavorableReturnPct: position.maxFavorableReturnPct,
      maxAdverseReturnPct: position.maxAdverseReturnPct,
    });
  }

  _currentFlow(mint, timestampMs) {
    const rows = (this.states.get(mint)?.trades || []).filter(
      (row) => row.timestampMs >= timestampMs - 1_000 && row.timestampMs <= timestampMs,
    );
    return this._aggregate(rows, this.states.get(mint)?.creator || null);
  }

  _maybeAdd(position, trade, marketPrice) {
    const profile = this.managementProfiles.get(position.managementProfileId);
    if (!profile || !(profile.addActivationPct > 0) || position.addCount >= profile.maxAdds
      || trade.timestampMs - position.entryAt > profile.addMaxAgeMs
      || trade.timestampMs - position.lastAddAt < profile.addCooldownMs
      || marketPrice < position.lastAddPrice * (1 + profile.addStepPct / 100)) return;
    const gross = returnPct(marketPrice, position.averageEntryPrice);
    if (!(gross >= profile.addActivationPct)) return;
    const flow = this._currentFlow(position.mint, trade.timestampMs);
    if (flow.netFlow < profile.minAddNetFlow1sSol || flow.buyers < profile.minAddBuyers1s
      || flow.buyTxSharePct < profile.minAddBuyTxSharePct) return;
    const addSol = position.positionSol * profile.addFraction;
    const execution = executableBuy(trade, addSol, marketPrice);
    if (!execution.available || !(execution.price > 0)
      || execution.impactPct > this.config.maxAddImpactPct) return;
    position.totalInvestedSol += addSol;
    position.tokenUnits += execution.tokenUnits;
    position.averageEntryPrice = position.totalInvestedSol / position.tokenUnits;
    position.addCount += 1;
    position.lastAddAt = trade.timestampMs;
    position.lastAddPrice = execution.price;
    this._patch(position.id, {
      averageEntryPrice: position.averageEntryPrice,
      totalInvestedSol: position.totalInvestedSol,
      tokenUnits: position.tokenUnits,
      addCount: position.addCount,
      lastAddAt: position.lastAddAt,
      lastAddPrice: position.lastAddPrice,
    });
    this.metrics.adds += 1;
  }

  _evaluateExit(position, timestampMs, price) {
    const profile = this.managementProfiles.get(position.managementProfileId);
    const heldMs = timestampMs - position.entryAt;
    const gross = returnPct(price, position.averageEntryPrice);
    const drawdown = position.highestPrice > 0 ? (1 - price / position.highestPrice) * 100 : 0;
    let reason = null;
    let triggerAt = timestampMs;
    if (gross <= -profile.hardStopPct) reason = `HARD_STOP_${profile.hardStopPct}`;
    else if (heldMs >= profile.noContinuationMs
      && position.maxFavorableReturnPct < profile.minContinuationMfePct) {
      reason = 'NO_CONTINUATION';
      triggerAt = position.entryAt + profile.noContinuationMs;
    } else if (profile.trailingActivationPct > 0
      && position.maxFavorableReturnPct >= profile.trailingActivationPct
      && drawdown >= profile.trailingStopPct) {
      reason = `RUNNER_TRAIL_${profile.trailingStopPct}`;
    } else if (heldMs >= profile.maxHoldMs) {
      reason = 'MAX_HOLD';
      triggerAt = position.entryAt + profile.maxHoldMs;
    }
    if (reason) this._requestExit(position, triggerAt, reason);
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
    const variablePct = this.costs.platformFeePct + this.costs.buySlippagePct
      + this.costs.sellSlippagePct;
    return position.totalInvestedSol * variablePct / 100
      + this.costs.totalFixedCostSol * (2 + position.addCount);
  }

  _close(position, trade, marketPrice) {
    const markReturnPct = returnPct(marketPrice, position.averageEntryPrice);
    const execution = executableSell(trade, position.tokenUnits, marketPrice, { rugMarkReturnPct: markReturnPct });
    if (execution.price == null) return;
    const proceedsSol = execution.proceedsSol ?? position.tokenUnits * execution.price;
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
      grossReturnPct,
      netReturnPct,
      estimatedCostSol,
      holdMs: trade.timestampMs - position.entryAt,
    });
    this.positions.delete(position.id);
    this._unindex(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
  }

  _patch(id, values) {
    const fields = [
      'status', 'rejectionReason', 'entryAt', 'entryMarket', 'entryPrice',
      'entryMarketPrice', 'entryJumpPct', 'entryImpactPct', 'averageEntryPrice',
      'totalInvestedSol', 'tokenUnits', 'addCount', 'lastAddAt', 'lastAddPrice',
      'highestPrice', 'lowestPrice', 'lastObservedAt', 'lastMarket', 'lastPrice',
      'maxFavorableReturnPct', 'maxAdverseReturnPct', 'exitTriggerAt', 'exitTargetAt',
      'exitDeadlineAt', 'exitAt', 'exitMarket', 'exitPrice', 'exitMarketPrice',
      'exitImpactPct', 'exitReason', 'grossReturnPct', 'netReturnPct',
      'estimatedCostSol', 'holdMs',
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
      SELECT * FROM cya_slot_flow_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC LIMIT ?
    `).all(limit);
    const groups = this.store.db.prepare(`
      SELECT cohort_id, entry_profile_id, management_profile_id,
        COUNT(*) signals, COUNT(DISTINCT mint) independent_mints,
        SUM(status='PRICE_JUMP') price_jump, SUM(status='NO_ENTRY') no_entry,
        SUM(status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING')) active,
        SUM(status='CLOSED') resolved, SUM(status='NO_EXIT') no_exit,
        SUM(add_count) adds,
        AVG(public_buyers_5s) average_buyers_5s,
        AVG(public_net_flow_5s) average_net_flow_5s,
        AVG(buy_tx_share_pct) average_buy_tx_share_pct,
        AVG(largest_buyer_share_pct) average_largest_buyer_share_pct,
        AVG(entry_impact_pct) average_entry_impact_pct,
        AVG(exit_impact_pct) average_exit_impact_pct,
        AVG(max_favorable_return_pct) average_mfe_pct,
        AVG(max_adverse_return_pct) average_mae_pct,
        AVG(net_return_pct) average_net_return_pct,
        AVG(CASE WHEN target_open_delay_ms<=5000 THEN 100.0 ELSE 0 END) target_open_5s_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>0 THEN 100.0 ELSE 0 END END)
          win_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>=20 THEN 100.0 ELSE 0 END END)
          big20_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>=50 THEN 100.0 ELSE 0 END END)
          big50_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>=100 THEN 100.0 ELSE 0 END END)
          big100_rate_pct,
        MAX(net_return_pct) max_winner_pct
      FROM cya_slot_flow_shadow_positions
      GROUP BY cohort_id, entry_profile_id, management_profile_id
      ORDER BY entry_profile_id, management_profile_id
    `).all();
    const returnRows = this.store.db.prepare(`
      SELECT net_return_pct, max_favorable_return_pct
      FROM cya_slot_flow_shadow_positions
      WHERE cohort_id=? AND status='CLOSED' AND net_return_pct IS NOT NULL
      ORDER BY net_return_pct
    `);
    const cohorts = groups.map((group) => {
      const rows = returnRows.all(group.cohort_id);
      const values = rows.map((row) => Number(row.net_return_pct)).filter(Number.isFinite);
      const wins = values.filter((value) => value > 0).sort((a, b) => b - a);
      const losses = values.filter((value) => value < 0);
      const profit = wins.reduce((sum, value) => sum + value, 0);
      const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      const opportunities = rows.filter((row) => Number(row.max_favorable_return_pct) >= 50);
      const capture = opportunities.map((row) => {
        const mfe = Number(row.max_favorable_return_pct);
        return mfe > 0 ? Number(row.net_return_pct) / mfe * 100 : null;
      }).filter(Number.isFinite);
      return {
        ...group,
        median_net_return_pct: percentile(values, 0.5),
        profit_factor: loss > 0 ? profit / loss : (profit > 0 ? null : 0),
        top_5_winner_contribution_pct: profit > 0
          ? wins.slice(0, 5).reduce((sum, value) => sum + value, 0) / profit * 100 : null,
        big50_opportunities: opportunities.length,
        average_big50_capture_pct: capture.length
          ? capture.reduce((sum, value) => sum + value, 0) / capture.length : null,
      };
    });
    return { cohorts, positions };
  }
}

module.exports = { CyaSlotFlowShadowSuite, STATUS, priceOf };
