'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');

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
    exitProfileId: row.exit_profile_id,
    episodeId: row.episode_id,
    mint: row.mint,
    status: row.status,
    signalAt: finite(row.signal_at),
    signalPrice: finite(row.signal_price),
    signalMarket: row.signal_market,
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

class SmartResonanceRightTailShadowSuite {
  constructor({ config, store, now = () => Date.now(), rugRiskTracker = null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.rugRiskTracker = rugRiskTracker;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.maxResonanceWindowMs = Math.max(0, ...(config.entryProfiles || [])
      .map((row) => Number(row.resonanceWindowMs) || 0));
    this.smartWallets = new Set(config.smartWallets || []);
    this.states = new Map();
    this.pendingEntries = new Map();
    this.positions = new Map();
    this.rowsByMint = new Map();
    this.lastEpisodes = new Map();
    this.metrics = {
      observedTrades: 0,
      observedSmartBuys: 0,
      resonanceEdges: 0,
      qualifiedSignals: 0,
      rejectedSignals: 0,
      replaySignalsSuppressed: 0,
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
      CREATE TABLE IF NOT EXISTS smart_resonance_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        trigger_event_id INTEGER,
        trigger_wallet TEXT NOT NULL,
        trigger_signature TEXT,
        resonance_window_ms INTEGER NOT NULL,
        required_wallets INTEGER NOT NULL,
        distinct_wallets INTEGER NOT NULL,
        resonance_span_ms INTEGER,
        resonance_wallets_json TEXT NOT NULL,
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
        graduated INTEGER NOT NULL DEFAULT 0,
        public_buyers_5s INTEGER,
        public_buy_tx_5s INTEGER,
        public_sell_tx_5s INTEGER,
        public_buy_flow_5s REAL,
        public_sell_flow_5s REAL,
        public_net_flow_5s REAL,
        largest_buyer_share_pct REAL,
        features_json TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_smart_resonance_status
        ON smart_resonance_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_smart_resonance_mint
        ON smart_resonance_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_smart_resonance_profiles
        ON smart_resonance_shadow_positions(entry_profile_id, exit_profile_id);
    `);
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_resonance_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id,
        trigger_event_id, trigger_wallet, trigger_signature,
        resonance_window_ms, required_wallets, distinct_wallets, resonance_span_ms,
        resonance_wallets_json, mint, symbol, status, rejection_reason,
        position_sol, configured_cost_pct, signal_at, signal_market, signal_price,
        age_ms, curve_pct, graduated, public_buyers_5s, public_buy_tx_5s,
        public_sell_tx_5s, public_buy_flow_5s, public_sell_flow_5s,
        public_net_flow_5s, largest_buyer_share_pct, features_json,
        entry_target_at, entry_deadline_at, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId,
        @triggerEventId, @triggerWallet, @triggerSignature,
        @resonanceWindowMs, @requiredWallets, @distinctWallets, @resonanceSpanMs,
        @resonanceWalletsJson, @mint, @symbol, @status, @rejectionReason,
        @positionSol, @configuredCostPct, @signalAt, @signalMarket, @signalPrice,
        @ageMs, @curvePct, @graduated, @publicBuyers5s, @publicBuyTx5s,
        @publicSellTx5s, @publicBuyFlow5s, @publicSellFlow5s,
        @publicNetFlow5s, @largestBuyerSharePct, @featuresJson,
        @entryTargetAt, @entryDeadlineAt, @createdAt, @updatedAt
      )
    `);
    this.active = this.store.db.prepare(`
      SELECT * FROM smart_resonance_shadow_positions
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') ORDER BY signal_at, id
    `);
    this.update = this.store.db.prepare(`
      UPDATE smart_resonance_shadow_positions SET
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
      UPDATE smart_resonance_shadow_positions
      SET status='NO_EXIT', exit_reason=@exitReason,
        estimated_cost_sol=@estimatedCostSol, updated_at=@updatedAt
      WHERE id=@id
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
    const recentEpisodes = this.store.db.prepare(`
      SELECT mint, entry_profile_id, MAX(signal_at) signal_at
      FROM smart_resonance_shadow_positions
      WHERE signal_at>=? GROUP BY mint, entry_profile_id
    `).all(this.now() - this.config.stateRetentionMs);
    for (const row of recentEpisodes) {
      this.lastEpisodes.set(`${row.mint}:${row.entry_profile_id}`, Number(row.signal_at));
    }
    this.advanceTime(this.now());
  }

  stop() {}

  trackedMints() { return [...this.rowsByMint.keys()]; }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SR',
      sendsTransactions: false,
      pendingEntries: this.pendingEntries.size,
      activePositions: this.positions.size,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()],
      strategy: {
        name: 'Smart Wallet Resonance Right-Tail',
        positionSizeSol: this.config.positionSizeSol,
        featureWindowMs: this.config.featureWindowMs,
        entryDelayMs: this.config.entryDelayMs,
        maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
        maxEntryPriceDropPct: this.config.maxEntryPriceDropPct,
        smartWalletCount: this.smartWallets.size,
        research: {
          isolatedPositionTable: 'smart_resonance_shadow_positions',
          causalTrigger: true,
          retrospectiveEntry: false,
          sendsTransactions: false,
          noExitPricedAsTotalLoss: false,
        },
      },
      ...this.metrics,
    };
  }

  observeTrade(trade) {
    const timestampMs = finite(trade?.timestampMs);
    const price = priceOf(trade);
    if (!this.config.enabled || !trade?.mint || !(timestampMs > 0) || !(price > 0)
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade.market)) return;
    this.advanceTime(timestampMs);
    this._observeState(trade, price);
    this._observePositions(trade, price);
    this.metrics.observedTrades += 1;
  }

  onSmartWalletEvent(event, { replay = false } = {}) {
    const timestampMs = finite(event?.timestampMs);
    const price = priceOf(event);
    if (!this.config.enabled || !event?.mint || !event?.wallet
      || !this.smartWallets.has(event.wallet)
      || String(event.side || '').toUpperCase() !== 'BUY'
      || !(timestampMs > 0) || !(price > 0)
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(event.market)) return [];
    this.metrics.observedSmartBuys += 1;
    const state = this._state(event.mint);
    const duplicate = state.smartBuys.some((row) => row.wallet === event.wallet
      && row.signature === event.signature && row.eventIndex === finite(event.eventIndex, 0));
    if (!duplicate) {
      state.smartBuys.push({
        timestampMs,
        wallet: event.wallet,
        signature: event.signature || null,
        eventIndex: finite(event.eventIndex, 0),
        eventId: event.id || null,
        price,
        market: event.market,
      });
    }
    this._pruneState(state, timestampMs);
    if (replay) {
      this.metrics.replaySignalsSuppressed += 1;
      return [];
    }
    const results = [];
    for (const profile of this.entryProfiles.values()) {
      const resonance = this._resonance(state, timestampMs, profile);
      if (!resonance) continue;
      const episodeKey = `${event.mint}:${profile.id}`;
      const lastEpisodeAt = this.lastEpisodes.get(episodeKey);
      if (lastEpisodeAt != null && timestampMs - lastEpisodeAt < this.config.episodeCooldownMs) continue;
      this.lastEpisodes.set(episodeKey, timestampMs);
      this.metrics.resonanceEdges += 1;
      const features = this._features(event.mint, timestampMs, event);
      const reasons = this._entryReasons(profile, features);
      results.push(...this._recordSignal({
        profile,
        event,
        timestampMs,
        price,
        resonance,
        features,
        reasons,
      }));
    }
    return results;
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
      state = { trades: [], smartBuys: [], lastAt: 0 };
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
      market: trade.market,
      signature: trade.signature || null,
      eventIndex: finite(trade.eventIndex, 0),
      curvePct: finite(trade.curvePct),
      ageMs: finite(trade.ageMs),
    });
    this._pruneState(state, trade.timestampMs);
  }

  _pruneState(state, timestampMs) {
    const tradeCutoff = timestampMs - this.config.featureWindowMs;
    const smartCutoff = timestampMs - this.maxResonanceWindowMs;
    while (state.trades.length && state.trades[0].timestampMs < tradeCutoff) {
      state.trades.shift();
    }
    while (state.smartBuys.length && state.smartBuys[0].timestampMs < smartCutoff) {
      state.smartBuys.shift();
    }
  }

  _resonance(state, timestampMs, profile) {
    const rows = state.smartBuys.filter((row) => (
      row.timestampMs >= timestampMs - profile.resonanceWindowMs
      && row.timestampMs <= timestampMs
    ));
    const latestByWallet = new Map();
    for (const row of rows) latestByWallet.set(row.wallet, row);
    if (latestByWallet.size < profile.requiredWallets) return null;
    const distinct = [...latestByWallet.values()].sort((a, b) => a.timestampMs - b.timestampMs);
    const required = distinct.slice(-profile.requiredWallets);
    const firstAt = Math.min(...required.map((row) => row.timestampMs));
    return {
      distinctWallets: latestByWallet.size,
      spanMs: timestampMs - firstAt,
      wallets: [...latestByWallet.keys()].sort(),
    };
  }

  _features(mint, timestampMs, triggerEvent) {
    const rows = (this.states.get(mint)?.trades || []).filter((row) => (
      row.timestampMs >= timestampMs - this.config.featureWindowMs
      && row.timestampMs < timestampMs
      && !this.smartWallets.has(row.wallet)
      && !(row.signature === triggerEvent.signature
        && row.eventIndex === finite(triggerEvent.eventIndex, 0))
    ));
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buyFlow = buys.reduce((sum, row) => sum + row.solAmount, 0);
    const sellFlow = sells.reduce((sum, row) => sum + row.solAmount, 0);
    const flowByBuyer = new Map();
    for (const row of buys) {
      if (!row.wallet) continue;
      flowByBuyer.set(row.wallet, (flowByBuyer.get(row.wallet) || 0) + row.solAmount);
    }
    const largestBuyFlow = Math.max(0, ...flowByBuyer.values());
    const token = this.store.getToken(mint);
    const createdAt = finite(token?.created_at ?? token?.createdAt);
    const graduatedAt = finite(token?.graduated_at ?? token?.graduatedAt);
    const latest = rows[rows.length - 1];
    return {
      market: triggerEvent.market,
      ageMs: finite(triggerEvent.ageMs, finite(latest?.ageMs,
        createdAt == null ? null : timestampMs - createdAt)),
      curvePct: finite(triggerEvent.curvePct, latest?.curvePct),
      graduated: Boolean(graduatedAt > 0 && graduatedAt <= timestampMs),
      publicBuyers5s: flowByBuyer.size,
      publicBuyTx5s: buys.length,
      publicSellTx5s: sells.length,
      publicBuyFlow5s: buyFlow,
      publicSellFlow5s: sellFlow,
      publicNetFlow5s: buyFlow - sellFlow,
      largestBuyerSharePct: buyFlow > 0 ? largestBuyFlow / buyFlow * 100 : 0,
      rugRisk: this.rugRiskTracker?.snapshot(mint, timestampMs) || null,
    };
  }

  _entryReasons(profile, features) {
    const reasons = [];
    if (features.publicBuyers5s < (profile.minPublicBuyers5s || 0)) {
      reasons.push('PUBLIC_BUYERS_BELOW_MIN');
    }
    if (features.publicBuyFlow5s < (profile.minPublicBuyFlow5sSol || 0)) {
      reasons.push('PUBLIC_BUY_FLOW_BELOW_MIN');
    }
    if (features.largestBuyerSharePct > (profile.maxLargestBuyerSharePct ?? 100)) {
      reasons.push('LARGEST_BUYER_SHARE_ABOVE_MAX');
    }
    if (profile.requirePreGraduation && features.graduated) reasons.push('ALREADY_GRADUATED');
    if (profile.requiredMarket && features.market !== profile.requiredMarket) {
      reasons.push('WRONG_MARKET');
    }
    if (profile.maxAgeMs != null
      && (features.ageMs == null || features.ageMs > profile.maxAgeMs)) reasons.push('AGE_ABOVE_MAX');
    if (profile.minCurvePct != null
      && (features.curvePct == null || features.curvePct < profile.minCurvePct)) reasons.push('CURVE_BELOW_MIN');
    if (profile.maxCurvePct != null
      && (features.curvePct == null || features.curvePct > profile.maxCurvePct)) reasons.push('CURVE_ABOVE_MAX');
    if (profile.requireHealthyRugRisk) {
      if (!features.rugRisk?.sampleReady) reasons.push('RUG_RISK_SAMPLE_INSUFFICIENT');
      else if (features.rugRisk.flagged) reasons.push('PRE_ENTRY_RUG_RISK');
    }
    return reasons;
  }

  _recordSignal({ profile, event, timestampMs, price, resonance, features, reasons }) {
    const matched = reasons.length === 0;
    const episodeId = `${event.mint}:${profile.id}:${timestampMs}`;
    const results = [];
    if (matched) this.metrics.qualifiedSignals += 1;
    else this.metrics.rejectedSignals += 1;
    for (const exit of this.exitProfiles.values()) {
      const now = this.now();
      const cohortId = `${profile.id}_${exit.id}`;
      const result = this.insert.run({
        cohortId,
        entryProfileId: profile.id,
        exitProfileId: exit.id,
        episodeId,
        triggerEventId: event.id || null,
        triggerWallet: event.wallet,
        triggerSignature: event.signature || null,
        resonanceWindowMs: profile.resonanceWindowMs,
        requiredWallets: profile.requiredWallets,
        distinctWallets: resonance.distinctWallets,
        resonanceSpanMs: resonance.spanMs,
        resonanceWalletsJson: JSON.stringify(resonance.wallets),
        mint: event.mint,
        symbol: event.symbol || this.store.getToken(event.mint)?.symbol || null,
        status: matched ? STATUS.PENDING_ENTRY : STATUS.RULE_REJECTED,
        rejectionReason: reasons.join(',') || null,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        signalAt: timestampMs,
        signalMarket: event.market,
        signalPrice: price,
        ageMs: features.ageMs,
        curvePct: features.curvePct,
        graduated: features.graduated ? 1 : 0,
        publicBuyers5s: features.publicBuyers5s,
        publicBuyTx5s: features.publicBuyTx5s,
        publicSellTx5s: features.publicSellTx5s,
        publicBuyFlow5s: features.publicBuyFlow5s,
        publicSellFlow5s: features.publicSellFlow5s,
        publicNetFlow5s: features.publicNetFlow5s,
        largestBuyerSharePct: features.largestBuyerSharePct,
        featuresJson: JSON.stringify(features),
        entryTargetAt: timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
        createdAt: now,
        updatedAt: now,
      });
      if (!result.changes) continue;
      const row = this.store.db.prepare(
        'SELECT * FROM smart_resonance_shadow_positions WHERE id=?',
      ).get(Number(result.lastInsertRowid));
      const position = camelRow(row);
      if (matched) {
        this.pendingEntries.set(position.id, position);
        this._index(position);
      }
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
        const entryExecution = executableBuy(trade, position.positionSol, price);
        const entryPrice = entryExecution.price ?? price;
        const jumpPct = (entryPrice / position.signalPrice - 1) * 100;
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
        } else this._open(position, trade, entryPrice, jumpPct, price);
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
    const movePct = Math.abs((price / reference - 1) * 100);
    return movePct <= this.config.maxCrossMarketPriceJumpPct;
  }

  _open(position, trade, price, jumpPct, marketPrice = price) {
    Object.assign(position, {
      status: STATUS.OPEN,
      entryAt: trade.timestampMs,
      entryMarket: trade.market,
      entryPrice: price,
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      lastPrice: marketPrice,
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
      highestPrice: marketPrice,
      lowestPrice: marketPrice,
      lastObservedAt: trade.timestampMs,
      lastMarket: trade.market,
      lastPrice: marketPrice,
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
    const markReturnPct = (price / position.entryPrice - 1) * 100;
    const execution = executableSell(
      trade,
      position.positionSol / position.entryPrice,
      price,
      { rugMarkReturnPct: markReturnPct },
    );
    const executablePrice = execution.price ?? price;
    const executableReturnPct = (executablePrice / position.entryPrice - 1) * 100;
    const estimatedCostSol = this._estimatedCostSol(position);
    const netReturnPct = executableReturnPct - estimatedCostSol / position.positionSol * 100;
    this._patch(position.id, {
      status: STATUS.CLOSED,
      exitAt: trade.timestampMs,
      exitMarket: trade.market,
      exitPrice: executablePrice,
      grossReturnPct: markReturnPct,
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
      FROM smart_resonance_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC LIMIT ?
    `).all(limit);
    const groups = this.store.db.prepare(`
      SELECT cohort_id, entry_profile_id, exit_profile_id,
        COUNT(*) attempts, COUNT(DISTINCT episode_id) signals,
        COUNT(DISTINCT mint) independent_mints,
        SUM(status='RULE_REJECTED') rule_rejected,
        SUM(status='PRICE_JUMP') price_jump,
        SUM(status='NO_ENTRY') no_entry,
        SUM(status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING')) active,
        SUM(status='CLOSED') resolved,
        SUM(status='NO_EXIT') no_exit,
        AVG(distinct_wallets) average_distinct_wallets,
        AVG(resonance_span_ms) average_resonance_span_ms,
        AVG(public_buyers_5s) average_public_buyers_5s,
        AVG(public_buy_flow_5s) average_public_buy_flow_5s,
        AVG(public_net_flow_5s) average_public_net_flow_5s,
        AVG(largest_buyer_share_pct) average_largest_buyer_share_pct,
        AVG(max_favorable_return_pct) average_mfe_pct,
        AVG(max_adverse_return_pct) average_mae_pct,
        AVG(net_return_pct) average_net_return_pct,
        AVG(CASE WHEN status='CLOSED'
          THEN CASE WHEN net_return_pct>0 THEN 100.0 ELSE 0 END END) win_rate_pct,
        AVG(CASE WHEN status='CLOSED'
          THEN CASE WHEN net_return_pct>=50 THEN 100.0 ELSE 0 END END) big50_rate_pct,
        AVG(CASE WHEN status='CLOSED'
          THEN CASE WHEN net_return_pct>=100 THEN 100.0 ELSE 0 END END) big100_rate_pct,
        MAX(net_return_pct) max_winner_pct
      FROM smart_resonance_shadow_positions
      GROUP BY cohort_id, entry_profile_id, exit_profile_id
      ORDER BY entry_profile_id, exit_profile_id
    `).all();
    const returns = this.store.db.prepare(`
      SELECT net_return_pct FROM smart_resonance_shadow_positions
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
    return { cohorts, positions };
  }
}

module.exports = { SmartResonanceRightTailShadowSuite, STATUS, priceOf };
