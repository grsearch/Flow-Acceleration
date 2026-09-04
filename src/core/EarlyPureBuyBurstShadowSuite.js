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
const {
  initializeVotingSnapshotStorage,
  persistVotingSnapshot,
  recentVotingOpenSnapshots,
} = require('./SmartWalletVotingSnapshotStore');

const MARKET = 'PUMP_BONDING_CURVE';
const ACTIVE = new Set(['PENDING_ENTRY', 'OPEN', 'EXIT_PENDING']);

function number(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator * 100 : null;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function aggregate(rows) {
  const returns = rows.map((row) => number(row.net_return_pct)).filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const gains = wins.reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    completed: returns.length,
    winRatePct: ratio(wins.length, returns.length),
    averageNetReturnPct: returns.length
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    medianNetReturnPct: median(returns),
    profitFactor: losses > 0 ? gains / losses : (gains > 0 ? null : 0),
    big50RatePct: ratio(returns.filter((value) => value >= 50).length, returns.length),
    big100RatePct: ratio(returns.filter((value) => value >= 100).length, returns.length),
    rug50RatePct: ratio(returns.filter((value) => value <= -50).length, returns.length),
  };
}

class EarlyPureBuyBurstShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((profile) => [profile.id, profile]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((profile) => [profile.id, profile]));
    this.maxSmartConsensusWindowMs = Math.max(0, ...(config.entryProfiles || [])
      .map((profile) => number(profile.consensusWindowMs, 0)));
    this.smartWallets = new Set((config.smartWallets || []).filter(Boolean));
    this.states = new Map();
    this.positions = new Map();
    this.positionIdsByMint = new Map();
    this.seenMints = new Set();
    this.counters = {
      trades: 0, excludedSmartTrades: 0, candidates: 0, signals: 0,
      observedVotingSmartOpens: 0, smartConsensusSignals: 0,
      blockedByRugGuard: 0, opened: 0, closed: 0, noEntry: 0, noExit: 0,
      rightCensored: 0,
      cachedReserveExits: 0,
      lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS early_pure_buy_burst_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
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
        buyers_3s INTEGER,
        buy_tx_3s INTEGER,
        sell_tx_3s INTEGER,
        buy_flow_3s REAL,
        sell_flow_3s REAL,
        net_flow_3s REAL,
        buy_tx_share_pct REAL,
        confirmation_delay_ms INTEGER,
        delta_buyers INTEGER,
        delta_net_flow REAL,
        drawdown_pct REAL,
        reclaim_pct REAL,
        features_json TEXT NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_market_price REAL,
        entry_jump_pct REAL,
        entry_impact_pct REAL,
        token_units REAL,
        highest_price REAL,
        lowest_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        last_pool_quote_json TEXT,
        last_pool_quote_at INTEGER,
        last_pool_quote_market TEXT,
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
        UNIQUE(cohort_id, mint)
      );
      CREATE INDEX IF NOT EXISTS idx_early_pure_buy_status
        ON early_pure_buy_burst_shadow_positions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_early_pure_buy_mint
        ON early_pure_buy_burst_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_early_pure_buy_profiles
        ON early_pure_buy_burst_shadow_positions(entry_profile_id, exit_profile_id);
    `);
    initializeVotingSnapshotStorage(this.store);
    const columns = new Set(this.store.db.prepare(
      'PRAGMA table_info(early_pure_buy_burst_shadow_positions)',
    ).all().map((row) => row.name));
    for (const [name, definition] of [
      ['last_pool_quote_json', 'TEXT'],
      ['last_pool_quote_at', 'INTEGER'],
      ['last_pool_quote_market', 'TEXT'],
    ]) {
      if (!columns.has(name)) {
        this.store.db.exec(
          `ALTER TABLE early_pure_buy_burst_shadow_positions ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    this.insertPosition = this.store.db.prepare(`
      INSERT OR IGNORE INTO early_pure_buy_burst_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, mint, symbol, status,
        position_sol, configured_cost_pct, signal_at, signal_market, signal_price,
        age_ms, curve_pct, buyers_3s, buy_tx_3s, sell_tx_3s, buy_flow_3s,
        sell_flow_3s, net_flow_3s, buy_tx_share_pct, confirmation_delay_ms,
        delta_buyers, delta_net_flow, drawdown_pct, reclaim_pct, features_json,
        entry_target_at, entry_deadline_at, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @mint, @symbol, 'PENDING_ENTRY',
        @positionSol, @configuredCostPct, @signalAt, @signalMarket, @signalPrice,
        @ageMs, @curvePct, @buyers3s, @buyTx3s, @sellTx3s, @buyFlow3s,
        @sellFlow3s, @netFlow3s, @buyTxSharePct, @confirmationDelayMs,
        @deltaBuyers, @deltaNetFlow, @drawdownPct, @reclaimPct, @featuresJson,
        @entryTargetAt, @entryDeadlineAt, @createdAt, @updatedAt
      )
    `);
    this.loadActive = this.store.db.prepare(`
      SELECT * FROM early_pure_buy_burst_shadow_positions
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') ORDER BY signal_at, id
    `);
    this.loadSeen = this.store.db.prepare(
      'SELECT DISTINCT mint FROM early_pure_buy_burst_shadow_positions',
    );
    this.updatePosition = this.store.db.prepare(`
      UPDATE early_pure_buy_burst_shadow_positions SET
        status=@status, rejection_reason=@rejectionReason,
        entry_at=@entryAt, entry_market=@entryMarket, entry_price=@entryPrice,
        entry_market_price=@entryMarketPrice, entry_jump_pct=@entryJumpPct,
        entry_impact_pct=@entryImpactPct, token_units=@tokenUnits,
        highest_price=@highestPrice, lowest_price=@lowestPrice,
        max_favorable_return_pct=@maxFavorableReturnPct,
        max_adverse_return_pct=@maxAdverseReturnPct,
        last_pool_quote_json=@lastPoolQuoteJson,
        last_pool_quote_at=@lastPoolQuoteAt,
        last_pool_quote_market=@lastPoolQuoteMarket,
        exit_target_at=@exitTargetAt, exit_deadline_at=@exitDeadlineAt,
        exit_at=@exitAt, exit_market=@exitMarket, exit_price=@exitPrice,
        exit_market_price=@exitMarketPrice, exit_impact_pct=@exitImpactPct,
        exit_reason=@exitReason, gross_return_pct=@grossReturnPct,
        net_return_pct=@netReturnPct, estimated_cost_sol=@estimatedCostSol,
        hold_ms=@holdMs, updated_at=@updatedAt WHERE id=@id
    `);
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.loadSeen.all()) this.seenMints.add(row.mint);
    for (const row of this.loadActive.all()) this._trackPosition(this._position(row));
    for (const restored of recentVotingOpenSnapshots(
      this.store,
      this.now() - this.maxSmartConsensusWindowMs,
      this.now(),
    )) {
      this._rememberSmartWalletEvent(
        restored.event,
        restored.walletSnapshot,
        { restored: true },
      );
    }
    this.advanceTime(this.now());
  }

  stop() {}

  _position(row) {
    const position = {};
    for (const [key, value] of Object.entries(row)) {
      position[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    position.lastPoolQuote = parsePoolQuote(row.last_pool_quote_json);
    return position;
  }

  _save(position) {
    this.updatePosition.run({
      id: position.id, status: position.status,
      rejectionReason: position.rejectionReason ?? null,
      entryAt: position.entryAt ?? null, entryMarket: position.entryMarket ?? null,
      entryPrice: position.entryPrice ?? null,
      entryMarketPrice: position.entryMarketPrice ?? null,
      entryJumpPct: position.entryJumpPct ?? null,
      entryImpactPct: position.entryImpactPct ?? null,
      tokenUnits: position.tokenUnits ?? null,
      highestPrice: position.highestPrice ?? null,
      lowestPrice: position.lowestPrice ?? null,
      maxFavorableReturnPct: position.maxFavorableReturnPct ?? null,
      maxAdverseReturnPct: position.maxAdverseReturnPct ?? null,
      lastPoolQuoteJson: position.lastPoolQuote
        ? JSON.stringify(position.lastPoolQuote) : null,
      lastPoolQuoteAt: position.lastPoolQuoteAt ?? null,
      lastPoolQuoteMarket: position.lastPoolQuoteMarket ?? null,
      exitTargetAt: position.exitTargetAt ?? null,
      exitDeadlineAt: position.exitDeadlineAt ?? null,
      exitAt: position.exitAt ?? null, exitMarket: position.exitMarket ?? null,
      exitPrice: position.exitPrice ?? null,
      exitMarketPrice: position.exitMarketPrice ?? null,
      exitImpactPct: position.exitImpactPct ?? null,
      exitReason: position.exitReason ?? null,
      grossReturnPct: position.grossReturnPct ?? null,
      netReturnPct: position.netReturnPct ?? null,
      estimatedCostSol: position.estimatedCostSol ?? null,
      holdMs: position.holdMs ?? null, updatedAt: this.now(),
    });
  }

  _trackPosition(position) {
    this.positions.set(position.id, position);
    let ids = this.positionIdsByMint.get(position.mint);
    if (!ids) {
      ids = new Set();
      this.positionIdsByMint.set(position.mint, ids);
    }
    ids.add(position.id);
    return position;
  }

  _untrackPosition(position) {
    this.positions.delete(position.id);
    const ids = this.positionIdsByMint.get(position.mint);
    if (!ids) return;
    ids.delete(position.id);
    if (!ids.size) this.positionIdsByMint.delete(position.mint);
  }

  _positionsForMint(mint) {
    const ids = this.positionIdsByMint.get(mint);
    if (!ids) return [];
    return [...ids].map((id) => this.positions.get(id)).filter(Boolean);
  }

  _state(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = { rows: [], smartBuys: [], anchor: null, lastAt: 0 };
      this.states.set(mint, state);
    }
    if (!Array.isArray(state.smartBuys)) state.smartBuys = [];
    return state;
  }

  _pruneSmartBuys(state, at) {
    const cutoff = at - this.maxSmartConsensusWindowMs;
    while (state.smartBuys.length && state.smartBuys[0].timestampMs < cutoff) {
      state.smartBuys.shift();
    }
  }

  _addTrade(trade) {
    const state = this._state(trade.mint);
    state.rows.push(trade);
    if (state.rows.length > this.config.maxTradesPerMint) {
      state.rows.splice(0, state.rows.length - this.config.maxTradesPerMint);
    }
    const cutoff = trade.timestampMs - Math.max(10_000, this.config.featureWindowMs);
    while (state.rows.length && state.rows[0].timestampMs < cutoff) state.rows.shift();
    state.lastAt = trade.timestampMs;
    return state;
  }

  _features(state, now, windowMs = 3_000) {
    const rows = state.rows.filter((row) => row.timestampMs >= now - windowMs);
    const buys = rows.filter((row) => row.side === 'BUY');
    const sells = rows.filter((row) => row.side === 'SELL');
    const buyFlow = buys.reduce((sum, row) => sum + Math.max(0, number(row.solAmount, 0)), 0);
    const sellFlow = sells.reduce((sum, row) => sum + Math.max(0, number(row.solAmount, 0)), 0);
    const uniqueBuyers = new Set(buys.map((row) => row.wallet).filter(Boolean));
    const totalTx = buys.length + sells.length;
    return {
      buyers3s: uniqueBuyers.size, buyerSet: uniqueBuyers,
      buyTx3s: buys.length, sellTx3s: sells.length,
      buyFlow3s: buyFlow, sellFlow3s: sellFlow, netFlow3s: buyFlow - sellFlow,
      buyTxSharePct: totalTx ? buys.length / totalTx * 100 : null,
      maxSellSol: sells.reduce((max, row) => Math.max(max, number(row.solAmount, 0)), 0),
      sellSharePct: buyFlow + sellFlow > 0 ? sellFlow / (buyFlow + sellFlow) * 100 : 0,
    };
  }

  _baseline(trade, state) {
    const base = this.config.base;
    const ageMs = number(trade.ageMs);
    const curvePct = number(trade.curvePct);
    if (!(ageMs >= 0 && ageMs <= base.maxAgeMs)) return null;
    if (!(curvePct >= 0 && curvePct < base.maxCurvePct)) return null;
    const features = this._features(state, trade.timestampMs);
    if (features.netFlow3s < base.minNetFlow3sSol
      || features.netFlow3s > base.maxNetFlow3sSol
      || features.buyers3s < base.minBuyers3s
      || features.buyers3s > base.maxBuyers3s
      || features.sellTx3s > base.maxSellTx3s
      || features.buyTxSharePct !== 100) return null;
    const quote = executableBuy(trade, this.config.positionSizeSol, number(trade.price));
    if (!quote.available || number(quote.impactPct, Infinity) > this.config.maxEntryImpactPct) return null;
    return { ...features, ageMs, curvePct, signalPrice: number(trade.price), quote };
  }

  _emit(profileId, trade, anchor, features, extras = {}) {
    const profile = this.entryProfiles.get(profileId);
    if (!profile || profile.newEntriesEnabled === false) return [];
    const created = [];
    const allowedExits = new Set(profile.exitProfileIds || []);
    for (const exitProfile of this.exitProfiles.values()) {
      if (allowedExits.size && !allowedExits.has(exitProfile.id)) continue;
      const cohortId = `${profileId}:${exitProfile.id}`;
      const payload = {
        cohortId, entryProfileId: profileId, exitProfileId: exitProfile.id,
        mint: trade.mint, symbol: trade.symbol || null,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        signalAt: trade.timestampMs, signalMarket: MARKET,
        signalPrice: number(trade.price), ageMs: number(trade.ageMs),
        curvePct: number(trade.curvePct), buyers3s: features.buyers3s,
        buyTx3s: features.buyTx3s, sellTx3s: features.sellTx3s,
        buyFlow3s: features.buyFlow3s, sellFlow3s: features.sellFlow3s,
        netFlow3s: features.netFlow3s, buyTxSharePct: features.buyTxSharePct,
        confirmationDelayMs: trade.timestampMs - anchor.at,
        deltaBuyers: extras.deltaBuyers ?? 0, deltaNetFlow: extras.deltaNetFlow ?? 0,
        drawdownPct: extras.drawdownPct ?? null, reclaimPct: extras.reclaimPct ?? null,
        featuresJson: JSON.stringify({ ...features, ...extras, anchorAt: anchor.at }),
        entryTargetAt: trade.timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: trade.timestampMs + this.config.entryTimeoutMs,
        createdAt: trade.timestampMs, updatedAt: trade.timestampMs,
      };
      const result = this.insertPosition.run(payload);
      if (!result.changes) continue;
      const row = this.store.db.prepare(
        'SELECT * FROM early_pure_buy_burst_shadow_positions WHERE id=?',
      ).get(result.lastInsertRowid);
      const position = this._position(row);
      this._trackPosition(position);
      created.push(position);
    }
    if (created.length) {
      anchor.triggered.add(profileId);
      this.counters.signals += created.length;
      if (extras.smartConsensus) this.counters.smartConsensusSignals += 1;
      this.counters.lastActionAt = trade.timestampMs;
    }
    return created;
  }

  _evaluateSignals(trade, state) {
    const emitted = [];
    if (!state.anchor && !this.seenMints.has(trade.mint)) {
      const features = this._baseline(trade, state);
      if (features) {
        this.seenMints.add(trade.mint);
        this.counters.candidates += 1;
        state.anchor = {
          at: trade.timestampMs, price: number(trade.price), low: number(trade.price),
          features, triggered: new Set(),
        };
        emitted.push(...this._emit('EB_A', trade, state.anchor, features));
        for (const profile of this.entryProfiles.values()) {
          if (profile.pairedBaselineProfileId !== 'EB_A'
            || profile.newEntriesEnabled === false) continue;
          emitted.push(...this._emit(
            profile.id,
            trade,
            state.anchor,
            features,
            { pairedBaselineProfileId: 'EB_A' },
          ));
        }
        for (const profile of this.entryProfiles.values()) {
          if (profile.sourceProfileId !== 'EB_A' || profile.newEntriesEnabled === false) continue;
          const smartConsensus = this._smartConsensus(state, trade.timestampMs, profile);
          if (!smartConsensus) continue;
          emitted.push(...this._emit(
            profile.id,
            trade,
            state.anchor,
            features,
            { smartConsensus },
          ));
        }
      }
    }
    const anchor = state.anchor;
    if (!anchor) return emitted;
    const delay = trade.timestampMs - anchor.at;
    const price = number(trade.price);
    if (!(price > 0)) return emitted;
    anchor.low = Math.min(anchor.low, price);
    const features = this._features(state, trade.timestampMs);
    if (!anchor.triggered.has('EB_B')
      && delay >= this.config.confirmationB.minDelayMs
      && delay <= this.config.confirmationB.maxDelayMs) {
      const deltaBuyers = [...features.buyerSet]
        .filter((wallet) => !anchor.features.buyerSet.has(wallet)).length;
      const deltaNetFlow = features.netFlow3s - anchor.features.netFlow3s;
      const jumpPct = (price / anchor.price - 1) * 100;
      if (features.sellTx3s === 0
        && (deltaBuyers >= this.config.confirmationB.minDeltaBuyers
          || deltaNetFlow >= this.config.confirmationB.minDeltaNetFlowSol)
        && jumpPct <= this.config.confirmationB.maxJumpPct) {
        emitted.push(...this._emit('EB_B', trade, anchor, features, { deltaBuyers, deltaNetFlow, jumpPct }));
      }
    }
    if (!anchor.triggered.has('EB_C')
      && delay >= this.config.confirmationC.minDelayMs
      && delay <= this.config.confirmationC.maxDelayMs) {
      const drawdownPct = (anchor.low / anchor.price - 1) * -100;
      const reclaimPct = (price / anchor.low - 1) * 100;
      if (drawdownPct >= this.config.confirmationC.minDrawdownPct
        && drawdownPct <= this.config.confirmationC.maxDrawdownPct
        && reclaimPct >= this.config.confirmationC.minReclaimPct
        && reclaimPct <= this.config.confirmationC.maxReclaimPct
        && features.netFlow3s > 0
        && features.maxSellSol <= this.config.confirmationC.maxSingleSellSol
        && features.sellSharePct <= this.config.confirmationC.maxSellSharePct) {
        emitted.push(...this._emit('EB_C', trade, anchor, features, { drawdownPct, reclaimPct }));
      }
    }
    return emitted;
  }

  _advancePosition(position, trade) {
    if (trade.mint !== position.mint || trade.market !== MARKET) return;
    const timestampMs = number(trade.timestampMs, this.now());
    const marketPrice = number(trade.price);
    if (!(marketPrice > 0)) return;
    if (position.status === 'PENDING_ENTRY') {
      if (timestampMs < position.entryTargetAt) return;
      if (timestampMs > position.entryDeadlineAt) return this._finish(position, 'NO_ENTRY', 'ENTRY_TIMEOUT');
      const profile = this.entryProfiles.get(position.entryProfileId);
      const selectiveRugPair = profile?.rugGuardMode === 'LIVE_CURVE_CATASTROPHE';
      const guard = evaluateUniversalRugGuard(this.store, {
        strategyId: `EARLY_PURE_BUY:${position.entryProfileId}`,
        mint: position.mint, timestampMs, source: 'SHADOW',
        market: MARKET, lifecycleStage: 'CURVE_EARLY',
        ...(selectiveRugPair ? {
          enforcementMode: 'HARD_BLOCK',
          hardBlockSignatures: LIVE_CURVE_HARD_BLOCK_SIGNATURES,
          policyReason: 'SHADOW_LIVE_CURVE_CATASTROPHE_PAIRED',
        } : {}),
      });
      if (guard.blocked) {
        this.counters.blockedByRugGuard += 1;
        return this._finish(position, 'NO_ENTRY', guard.reason || 'RUG_GUARD');
      }
      const quote = executableBuy(trade, position.positionSol, marketPrice);
      const jumpPct = (marketPrice / position.signalPrice - 1) * 100;
      if (!quote.available) return;
      if (quote.impactPct > this.config.maxEntryImpactPct
        || jumpPct > this.config.maxEntryPriceJumpPct
        || jumpPct < -this.config.maxEntryPriceDropPct) {
        return this._finish(position, 'NO_ENTRY', 'ENTRY_EXECUTION_GUARD');
      }
      position.status = 'OPEN';
      position.entryAt = timestampMs; position.entryMarket = MARKET;
      position.entryPrice = quote.price; position.entryMarketPrice = marketPrice;
      position.entryJumpPct = jumpPct; position.entryImpactPct = quote.impactPct;
      position.tokenUnits = quote.tokenUnits; position.highestPrice = marketPrice;
      position.lowestPrice = marketPrice; position.maxFavorableReturnPct = 0;
      position.maxAdverseReturnPct = 0;
      this._rememberPoolQuote(position, trade, marketPrice);
      this.counters.opened += 1;
      this._save(position);
      return;
    }
    if (position.status !== 'PENDING_ENTRY') {
      this._rememberPoolQuote(position, trade, marketPrice);
    }
    if (position.status === 'OPEN') {
      position.highestPrice = Math.max(number(position.highestPrice, marketPrice), marketPrice);
      position.lowestPrice = Math.min(number(position.lowestPrice, marketPrice), marketPrice);
      position.maxFavorableReturnPct = (position.highestPrice / position.entryPrice - 1) * 100;
      position.maxAdverseReturnPct = (position.lowestPrice / position.entryPrice - 1) * 100;
      const exitProfile = this.exitProfiles.get(position.exitProfileId);
      if (timestampMs < position.entryAt + exitProfile.maxHoldMs) {
        this._save(position);
        return;
      }
      position.status = 'EXIT_PENDING';
      position.exitTargetAt = position.entryAt + exitProfile.maxHoldMs + this.config.exitDelayMs;
      position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
      this._save(position);
    }
    if (position.status === 'EXIT_PENDING' && timestampMs >= position.exitTargetAt) {
      this._close(position, trade, marketPrice);
    }
  }

  _rememberPoolQuote(position, trade, marketPrice) {
    if (!position || trade?.market !== position.entryMarket) return false;
    const quote = capturePoolQuote(trade, marketPrice);
    if (!quote) return false;
    position.lastPoolQuote = quote;
    position.lastPoolQuoteAt = quote.timestampMs;
    position.lastPoolQuoteMarket = quote.market;
    return true;
  }

  _close(position, trade, marketPrice) {
    const exit = executableSell(trade, position.tokenUnits, marketPrice, {
      rugMarkReturnPct: (marketPrice / position.entryPrice - 1) * 100,
    });
    if (!exit.available || !Number.isFinite(exit.proceedsSol)) return false;
    const grossReturnPct = (exit.proceedsSol / position.positionSol - 1) * 100;
    position.status = 'CLOSED'; position.exitAt = trade.timestampMs;
    position.exitMarket = trade.market; position.exitPrice = exit.price;
    position.exitMarketPrice = marketPrice; position.exitImpactPct = exit.impactPct;
    position.exitReason = `FIXED_${this.exitProfiles.get(position.exitProfileId).maxHoldMs}MS`;
    position.grossReturnPct = grossReturnPct;
    position.netReturnPct = grossReturnPct - this.costs.deterministicCostPct;
    position.estimatedCostSol = this.costs.totalFixedCostSol
      + position.positionSol * (this.costs.deterministicCostPct - this.costs.fixedCostPct) / 100;
    position.holdMs = trade.timestampMs - position.entryAt;
    this.counters.closed += 1;
    this._untrackPosition(position);
    this._save(position);
    return true;
  }

  _closeFromCachedQuote(position, now) {
    if (position.status !== 'EXIT_PENDING' || now < position.exitTargetAt) return false;
    if (!cacheIsUsableForExit({
      quote: position.lastPoolQuote,
      mint: position.mint,
      entryMarket: position.entryMarket,
      exitTargetAt: position.exitTargetAt,
      now,
      store: this.store,
    })) return false;
    const trade = quoteTrade(position.lastPoolQuote, position.mint);
    const marketPrice = quotePrice(position.lastPoolQuote);
    if (!trade || !(marketPrice > 0)) return false;
    const closed = this._close(position, {
      ...trade,
      timestampMs: Math.max(position.exitTargetAt, trade.timestampMs),
    }, marketPrice);
    if (closed) this.counters.cachedReserveExits += 1;
    return closed;
  }

  _finish(position, status, reason) {
    position.status = status; position.rejectionReason = reason;
    if (status === 'NO_EXIT' || status === 'RIGHT_CENSORED') position.exitReason = reason;
    this._untrackPosition(position);
    if (status === 'NO_EXIT') this.counters.noExit += 1;
    else if (status === 'RIGHT_CENSORED') this.counters.rightCensored += 1;
    else this.counters.noEntry += 1;
    this._save(position);
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint || trade.market !== MARKET) return [];
    const timestampMs = number(trade.timestampMs, this.now());
    this.counters.trades += 1;
    // The hot path is deliberately mint-local. Global expiry/NO_EXIT work is
    // handled by the existing maintenance tick, so one chain trade never
    // scans every active EB position.
    for (const position of this._positionsForMint(trade.mint)) {
      this._advancePosition(position, trade);
    }
    if (this.smartWallets.has(trade.wallet)) {
      this.counters.excludedSmartTrades += 1;
      return [];
    }
    const state = this._addTrade(trade);
    return this._evaluateSignals(trade, state);
  }

  onSmartWalletEvent(event, { walletSnapshot = null, persist = true } = {}) {
    if (!this.config.enabled || !event?.mint || !event?.wallet || !walletSnapshot
      || String(event.side || '').toUpperCase() !== 'BUY'
      || String(event.positionPhase || event.position_phase || '').toUpperCase() !== 'OPEN') {
      return false;
    }
    const timestampMs = number(event.timestampMs ?? event.timestamp_ms);
    if (!(timestampMs > 0)) return false;
    if (persist) persistVotingSnapshot(this.store, event, walletSnapshot, this.now());
    return this._rememberSmartWalletEvent(event, walletSnapshot);
  }

  _rememberSmartWalletEvent(event, walletSnapshot, { restored = false } = {}) {
    const timestampMs = number(event.timestampMs ?? event.timestamp_ms);
    if (!(timestampMs > 0) || !event?.mint || !event?.wallet || !walletSnapshot) return false;
    const state = this._state(event.mint);
    const eventId = number(event.id ?? event.smartEventId ?? event.smart_event_id);
    if (state.smartBuys.some((row) => row.wallet === event.wallet && row.eventId === eventId)) {
      return false;
    }
    state.smartBuys.push({
      timestampMs,
      eventId,
      wallet: event.wallet,
      clusterId: walletSnapshot.clusterId || event.wallet,
      selectionGrade: walletSnapshot.selectionGrade || null,
      pnlEligibilityClass: walletSnapshot.pnlEligibilityClass || null,
      registryVersion: number(walletSnapshot.registryVersion, 0),
      snapshotGeneratedAt: number(walletSnapshot.snapshotGeneratedAt),
      snapshotExpiresAt: number(walletSnapshot.snapshotExpiresAt),
    });
    state.smartBuys.sort((left, right) => left.timestampMs - right.timestampMs);
    state.lastAt = Math.max(state.lastAt, timestampMs);
    this._pruneSmartBuys(state, timestampMs);
    if (!restored) this.counters.observedVotingSmartOpens += 1;
    return true;
  }

  _smartConsensus(state, at, profile) {
    const windowMs = number(profile.consensusWindowMs, 0);
    const requiredClusters = number(profile.requiredClusters, Infinity);
    if (!(windowMs > 0) || !(requiredClusters > 0)) return null;
    const byCluster = new Map();
    for (const row of state.smartBuys) {
      if (row.timestampMs < at - windowMs || row.timestampMs > at) continue;
      const current = byCluster.get(row.clusterId);
      if (!current || row.timestampMs < current.timestampMs) byCluster.set(row.clusterId, row);
    }
    const allVotes = [...byCluster.values()]
      .sort((left, right) => left.timestampMs - right.timestampMs);
    const votes = profile.selectionGradeOnly
      ? allVotes.filter((row) => row.selectionGrade === profile.selectionGradeOnly)
      : allVotes;
    const selectionAClusters = votes.filter((row) => row.selectionGrade === 'S_A').length;
    const requiredA = number(profile.minSelectionAClusters, 0);
    if (votes.length < requiredClusters || selectionAClusters < requiredA) return null;
    return {
      sourceProfileId: profile.sourceProfileId,
      windowMs,
      requiredClusters,
      distinctClusters: votes.length,
      selectionAClusters,
      evaluatedAt: at,
      votes,
    };
  }

  advanceTime(now = this.now()) {
    for (const position of [...this.positions.values()]) {
      if (position.status === 'PENDING_ENTRY' && now > position.entryDeadlineAt) {
        this._finish(position, 'NO_ENTRY', 'ENTRY_TIMEOUT');
      } else if (position.status === 'OPEN'
        && now >= position.entryAt
          + number(this.exitProfiles.get(position.exitProfileId)?.maxHoldMs, Infinity)) {
        const maxHoldMs = number(
          this.exitProfiles.get(position.exitProfileId)?.maxHoldMs,
          Infinity,
        );
        position.status = 'EXIT_PENDING';
        position.exitTargetAt = position.entryAt + maxHoldMs + this.config.exitDelayMs;
        position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
        this._save(position);
        this._closeFromCachedQuote(position, now);
      } else if (position.status === 'EXIT_PENDING'
        && now >= position.exitTargetAt
        && this._closeFromCachedQuote(position, now)) {
        continue;
      } else if (position.status === 'EXIT_PENDING' && now > position.exitDeadlineAt) {
        const censorReason = exitCensorReason({
          mint: position.mint,
          entryMarket: position.entryMarket,
          exitTargetAt: position.exitTargetAt,
          store: this.store,
        });
        this._finish(
          position,
          censorReason ? 'RIGHT_CENSORED' : 'NO_EXIT',
          censorReason || 'EXIT_QUOTE_UNAVAILABLE',
        );
      }
    }
    const cutoff = now - Math.max(this.config.stateRetentionMs, this.maxSmartConsensusWindowMs);
    for (const [mint, state] of this.states) {
      this._pruneSmartBuys(state, now);
      if (state.lastAt < cutoff && !this.positionIdsByMint.has(mint)) {
        this.states.delete(mint);
      }
    }
  }

  health() {
    return {
      enabled: this.config.enabled, mode: 'SHADOW_EB', sendsTransactions: false,
      activePositions: this.positions.size, trackedMints: this.states.size,
      boundedPerMintTradeQueue: this.config.maxTradesPerMint,
      smartConsensusMaxWindowMs: this.maxSmartConsensusWindowMs,
      positionSizeSol: this.config.positionSizeSol,
      entryProfiles: [...this.entryProfiles.values()],
      exitProfiles: [...this.exitProfiles.values()], ...this.counters,
    };
  }

  dashboard({ positionLimit = 100 } = {}) {
    const cohorts = this.store.db.prepare(`
      SELECT entry_profile_id, exit_profile_id,
        COUNT(*) signals,
        SUM(CASE WHEN status='OPEN' OR status='EXIT_PENDING' THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN status='NO_ENTRY' THEN 1 ELSE 0 END) no_entry,
        SUM(CASE WHEN status='NO_EXIT' THEN 1 ELSE 0 END) no_exit
        , SUM(CASE WHEN status='RIGHT_CENSORED' THEN 1 ELSE 0 END) right_censored
      FROM early_pure_buy_burst_shadow_positions
      GROUP BY entry_profile_id, exit_profile_id ORDER BY entry_profile_id, exit_profile_id
    `).all().map((row) => {
      const completedRows = this.store.db.prepare(`
        SELECT net_return_pct FROM early_pure_buy_burst_shadow_positions
        WHERE entry_profile_id=? AND exit_profile_id=? AND status='CLOSED'
          AND net_return_pct IS NOT NULL
      `).all(row.entry_profile_id, row.exit_profile_id);
      return { ...row, ...aggregate(completedRows) };
    });
    const positions = this.store.db.prepare(`
      SELECT * FROM early_pure_buy_burst_shadow_positions
      ORDER BY signal_at DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, positionLimit)));
    const rugPairRows = this.store.db.prepare(`
      SELECT b.mint, b.signal_at,
        b.status AS baseline_status, b.net_return_pct AS baseline_return_pct,
        f.status AS filtered_status, f.net_return_pct AS filtered_return_pct,
        f.rejection_reason AS filtered_reason
      FROM early_pure_buy_burst_shadow_positions f
      JOIN early_pure_buy_burst_shadow_positions b
        ON b.mint = f.mint
        AND b.signal_at = f.signal_at
        AND b.exit_profile_id = f.exit_profile_id
      WHERE b.entry_profile_id = 'EB_A'
        AND f.entry_profile_id = 'EB_A_RUGX'
        AND b.exit_profile_id = 'FIX20'
        AND f.exit_profile_id = 'FIX20'
      ORDER BY f.signal_at DESC
    `).all();
    const rugComparisons = [buildShadowRugPairComparison({
      id: 'EB_A_FIX20_RUGX',
      label: '高频 EB-A · FIX20',
      baselineProfileId: 'EB_A',
      filteredProfileId: 'EB_A_RUGX',
      exitProfileId: 'FIX20',
      rows: rugPairRows,
    })];
    return {
      health: this.health(),
      strategy: {
        id: 'EB', name: 'Early Pure-Buy Burst Shadow',
        description: 'AGE<10s / Curve<50 / W3 3-5 SOL / Buyers 2-4 / pure buys; independent A/B/C and causal Smart Wallet overlay cohorts',
        missingExitPolicy: 'NO_EXIT_EXCLUDED_FROM_RETURN_STATS',
        positionSizeSol: this.config.positionSizeSol,
      },
      cohorts, positions, rugComparisons,
    };
  }
}

module.exports = { EarlyPureBuyBurstShadowSuite };
