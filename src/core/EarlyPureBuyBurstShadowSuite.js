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
const { hardBlockSignaturesForLifecycle } = require('./RugGuardPolicy');
const { buildShadowRugPairComparison } = require('./ShadowRugPairComparison');
const {
  initializeVotingSnapshotStorage,
  persistVotingSnapshot,
  recentVotingOpenSnapshots,
} = require('./SmartWalletVotingSnapshotStore');

const MARKET = 'PUMP_BONDING_CURVE';
const ACTIVE = new Set(['PENDING_ENTRY', 'OPEN', 'EXIT_PENDING']);
const STRICT_EXECUTION_VERSION = 'EB_EXEC_POST_TARGET_V1';
const STRICT_CURSOR_LIMIT = 256;

function strictPoint(trade, now, maxAgeMs = 3_000) {
  const point = {
    timestampMs: number(trade?.timestampMs), receivedAtMs: number(trade?.receivedAtMs),
    chainTimestampMs: number(trade?.chainTimestampMs), slot: number(trade?.slot),
    eventIndex: number(trade?.eventIndex), signature: trade?.signature,
    market: trade?.market, pool: trade?.bondingCurve,
  };
  if (point.market !== MARKET || typeof point.pool !== 'string' || !point.pool
    || typeof point.signature !== 'string' || !point.signature
    || !['timestampMs', 'receivedAtMs', 'chainTimestampMs', 'slot'].every(
      (key) => Number.isSafeInteger(point[key]) && point[key] > 0,
    ) || !Number.isSafeInteger(point.eventIndex) || point.eventIndex < 0) {
    return { reason: 'STRICT_SOURCE_IDENTITY_MISSING' };
  }
  // Chain times are second-resolution. Tolerate at most one second of clock
  // skew, never manufacture a timestamp for missing event metadata.
  if (now - point.receivedAtMs > maxAgeMs || now - point.chainTimestampMs > maxAgeMs
    || point.receivedAtMs - point.chainTimestampMs > maxAgeMs
    || point.chainTimestampMs > now + 1_000 || point.receivedAtMs > now + 1_000
    || point.timestampMs > now + 1_000 || now - point.timestampMs > maxAgeMs) {
    return { reason: 'STRICT_QUOTE_STALE_OR_FUTURE' };
  }
  try {
    for (const key of ['virtualTokenReservesRaw', 'virtualSolReservesRaw',
      'realTokenReservesRaw', 'realSolReservesRaw']) {
      if (trade[key] == null || !/^\d+$/.test(String(trade[key]))) throw new Error('missing reserves');
    }
    const virtualToken = BigInt(trade.virtualTokenReservesRaw);
    const virtualSol = BigInt(trade.virtualSolReservesRaw);
    const realToken = BigInt(trade.realTokenReservesRaw);
    const realSol = BigInt(trade.realSolReservesRaw);
    if (virtualToken <= 0n || virtualSol <= 0n || realToken < 0n || realSol < 0n
      || realToken > virtualToken || realSol > virtualSol) throw new Error('reserves');
    const markPrice = (Number(virtualSol) / 1e9) / (Number(virtualToken) / 1e6);
    if (!(markPrice > 0) || !Number.isFinite(markPrice)) throw new Error('price');
    return { ...point, markPrice };
  } catch (_) { return { reason: 'STRICT_RESERVES_INVALID' }; }
}

function advanceStrictCursor(cursor, point) {
  if (cursor && (point.pool !== cursor.pool || point.market !== cursor.market
    || point.slot < cursor.slot || point.chainTimestampMs < cursor.chainTimestampMs
    || point.timestampMs < cursor.timestampMs || point.receivedAtMs < cursor.receivedAtMs)) return null;
  const keys = cursor?.slot === point.slot
    ? (cursor.seenEventKeys || [`${cursor.signature}:${cursor.eventIndex}`]) : [];
  const prefix = `${point.signature}:`;
  if (keys.length >= STRICT_CURSOR_LIMIT
    || keys.some((key) => key.startsWith(prefix)
      && Number(key.slice(prefix.length)) >= point.eventIndex)) return null;
  return { ...point, seenEventKeys: [...keys, `${point.signature}:${point.eventIndex}`] };
}

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
  constructor({ config, store, now = () => Date.now(), onLiveSignal = null }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.onLiveSignal = onLiveSignal;
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
    this.strictSeen = new Set();
    this.counters = {
      trades: 0, excludedSmartTrades: 0, candidates: 0, signals: 0,
      observedVotingSmartOpens: 0, smartConsensusSignals: 0,
      blockedByRugGuard: 0, opened: 0, closed: 0, noEntry: 0, noExit: 0,
      rightCensored: 0,
      cachedReserveExits: 0,
      strictSourceRejected: 0, strictQuoteRejected: 0, strictRejections: {},
      liveSignals: 0, liveSignalErrors: 0,
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
    this.loadStrictSeen = this.store.db.prepare(
      'SELECT DISTINCT mint FROM early_pure_buy_burst_shadow_positions WHERE entry_profile_id=?',
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
        hold_ms=@holdMs, features_json=@featuresJson, updated_at=@updatedAt WHERE id=@id
    `);
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.loadSeen.all()) this.seenMints.add(row.mint);
    for (const profile of this.entryProfiles.values()) {
      if (!profile.strictExecution || profile.pairedBaselineProfileId) continue;
      for (const row of this.loadStrictSeen.all(profile.id)) {
        this.strictSeen.add(`${profile.id}:${row.mint}`);
      }
    }
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
    try {
      position.features = JSON.parse(row.features_json || '{}');
      position.strictExecution = position.features.strictExecution || null;
    } catch (_) { position.features = {}; }
    if (this.entryProfiles.get(position.entryProfileId)?.strictExecution
      || /^EB_A_EXEC_V1(?:_RUGX)?$/.test(position.entryProfileId) || position.strictExecution) {
      const execution = position.strictExecution;
      if (!execution || typeof execution !== 'object' || !execution.source?.pool
        || execution.source.market !== MARKET || !execution.source.signature
        || !['timestampMs', 'receivedAtMs', 'chainTimestampMs', 'slot'].every(
          (key) => Number.isSafeInteger(execution.source[key]) && execution.source[key] > 0,
        ) || !Number.isSafeInteger(execution.source.eventIndex) || execution.source.eventIndex < 0
        || !['maxHoldMs', 'entryTimeoutMs', 'exitTimeoutMs', 'maxQuoteChainAgeMs'].every(
          (key) => Number.isFinite(execution[key]) && execution[key] > 0,
        ) || !['entryDelayMs', 'exitDelayMs', 'hardStopPct'].every(
          (key) => Number.isFinite(execution[key]) && execution[key] >= 0,
        ) || !Number.isFinite(execution.costs?.deterministicCostPct)) {
        position.strictExecution = { invalid: true };
      }
    }
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
      featuresJson: position.strictExecution
        ? JSON.stringify({ ...position.features, strictExecution: position.strictExecution })
        : position.featuresJson,
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

  _baseline(trade, state, positionSizeSol = this.config.positionSizeSol,
    maxEntryImpactPct = this.config.maxEntryImpactPct) {
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
    const quote = executableBuy(trade, positionSizeSol, number(trade.price));
    if (!quote.available || number(quote.impactPct, Infinity) > maxEntryImpactPct) return null;
    return { ...features, ageMs, curvePct, signalPrice: number(trade.price), quote };
  }

  _emit(profileId, trade, anchor, features, extras = {}) {
    const profile = this.entryProfiles.get(profileId);
    if (!profile || profile.newEntriesEnabled === false) return [];
    const created = [];
    const allowedExits = new Set(profile.exitProfileIds || []);
    for (const exitProfile of this.exitProfiles.values()) {
      if (allowedExits.size && !allowedExits.has(exitProfile.id)) continue;
      if (!profile.strictExecution && (exitProfile.strictExecution
        || exitProfile.id === 'FIX20_H30_EXEC_V1')) continue;
      const positionSol = profile.strictExecution ? number(profile.positionSizeSol, 0.02)
        : this.config.positionSizeSol;
      const costs = profile.strictExecution
        ? costBreakdown({ ...this.config.costModel, ...profile.costModel, positionSizeSol: positionSol })
        : this.costs;
      const point = profile.strictExecution
        ? strictPoint(trade, this.now(), number(profile.maxQuoteChainAgeMs, 3_000)) : null;
      if (point?.reason) continue;
      const execution = profile.strictExecution ? {
        version: profile.executionVersion || STRICT_EXECUTION_VERSION,
        source: point, cursor: point, entry: null, exit: null,
        entryDelayMs: Math.max(0, number(profile.entryDelayMs, 1_000)),
        exitDelayMs: Math.max(0, number(profile.exitDelayMs, 1_000)),
        entryTimeoutMs: Math.max(1, number(profile.entryTimeoutMs, 15_000)),
        exitTimeoutMs: Math.max(1, number(profile.exitTimeoutMs, 15_000)),
        maxQuoteChainAgeMs: Math.max(1, number(profile.maxQuoteChainAgeMs, 3_000)),
        maxHoldMs: Math.max(1, number(exitProfile.maxHoldMs, 20_000)),
        hardStopPct: Math.max(0, number(exitProfile.hardStopPct, 30)),
        maxEntryImpactPct: number(profile.maxEntryImpactPct, this.config.maxEntryImpactPct),
        maxEntryPriceJumpPct: number(profile.maxEntryPriceJumpPct, this.config.maxEntryPriceJumpPct),
        maxEntryPriceDropPct: number(profile.maxEntryPriceDropPct, this.config.maxEntryPriceDropPct),
        rugGuardMode: profile.rugGuardMode || 'LABEL_ONLY', costs,
        quoteRejections: 0, lastQuoteRejection: null,
      } : null;
      const entryTargetAt = execution
        ? Math.max(point.timestampMs, point.receivedAtMs) + execution.entryDelayMs
        : trade.timestampMs + this.config.entryDelayMs;
      const cohortId = `${profileId}:${exitProfile.id}`;
      const payload = {
        cohortId, entryProfileId: profileId, exitProfileId: exitProfile.id,
        mint: trade.mint, symbol: trade.symbol || null,
        positionSol,
        configuredCostPct: costs.deterministicCostPct,
        signalAt: trade.timestampMs, signalMarket: MARKET,
        signalPrice: point?.markPrice || number(trade.price), ageMs: number(trade.ageMs),
        curvePct: number(trade.curvePct), buyers3s: features.buyers3s,
        buyTx3s: features.buyTx3s, sellTx3s: features.sellTx3s,
        buyFlow3s: features.buyFlow3s, sellFlow3s: features.sellFlow3s,
        netFlow3s: features.netFlow3s, buyTxSharePct: features.buyTxSharePct,
        confirmationDelayMs: trade.timestampMs - anchor.at,
        deltaBuyers: extras.deltaBuyers ?? 0, deltaNetFlow: extras.deltaNetFlow ?? 0,
        drawdownPct: extras.drawdownPct ?? null, reclaimPct: extras.reclaimPct ?? null,
        featuresJson: JSON.stringify({ ...features, ...extras, anchorAt: anchor.at,
          ...(execution ? { strictExecution: execution } : {}) }),
        entryTargetAt,
        entryDeadlineAt: execution ? entryTargetAt + execution.entryTimeoutMs
          : trade.timestampMs + this.config.entryTimeoutMs,
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
      if (profile.strictExecution && profile.liveBridgeEnabled && !profile.pairedBaselineProfileId) {
        this._bridgeStrictSignal(profile, trade, created[0]);
      }
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

  _strictRejected(reason, position = null) {
    this.counters[position ? 'strictQuoteRejected' : 'strictSourceRejected'] += 1;
    this.counters.strictRejections[reason] = (this.counters.strictRejections[reason] || 0) + 1;
    if (position) {
      position.strictExecution.quoteRejections += 1;
      position.strictExecution.lastQuoteRejection = reason;
      // Do not turn every rejected market event into a synchronous DB write.
      // These bounded diagnostics are persisted on the next state transition.
    }
  }

  _evaluateStrictSignals(trade, state) {
    const profiles = [...this.entryProfiles.values()].filter((profile) => profile.strictExecution
      && !profile.pairedBaselineProfileId && profile.newEntriesEnabled !== false);
    if (!profiles.length) return [];
    const maxAgeMs = Math.min(...profiles.map((profile) => number(profile.maxQuoteChainAgeMs, 3_000)));
    const point = strictPoint(trade, this.now(), maxAgeMs);
    if (point.reason) { this._strictRejected(point.reason); return []; }
    const cursor = advanceStrictCursor(state.strictCursor, point);
    if (!cursor) { this._strictRejected('STRICT_OUT_OF_ORDER_OR_DUPLICATE'); return []; }
    state.strictCursor = cursor;
    state.strictRows ||= [];
    state.strictRows.push({ ...trade, price: point.markPrice });
    state.strictRows = state.strictRows.filter((row) => row.timestampMs >= point.timestampMs - 3_000
      && row.timestampMs <= point.timestampMs && row.bondingCurve === point.pool)
      .slice(-Math.max(1, number(this.config.maxTradesPerMint, 256)));
    // Legacy rows admitted null age/curve via JavaScript's null >= 0 coercion.
    // Prove both bounds for a new source. Still keep an otherwise valid trade
    // above in the flow window: an unknown-age SELL must not disappear and
    // make subsequent known-age BUYs look like a pure-buy burst.
    if (!Number.isFinite(number(trade.ageMs)) || !Number.isFinite(number(trade.curvePct))) {
      this._strictRejected('STRICT_SOURCE_LIFECYCLE_UNKNOWN'); return [];
    }
    const emitted = [];
    for (const profile of profiles) {
      const seenKey = `${profile.id}:${trade.mint}`;
      if (this.strictSeen.has(seenKey)) continue;
      const features = this._baseline({ ...trade, price: point.markPrice },
        { rows: state.strictRows }, number(profile.positionSizeSol, 0.02),
        number(profile.maxEntryImpactPct, this.config.maxEntryImpactPct));
      if (!features || trade.side !== 'BUY') continue;
      if (features.quote.tokenUnits > Number(trade.realTokenReservesRaw) / 1e6) {
        this._strictRejected('STRICT_BUY_CAPACITY_UNAVAILABLE'); continue;
      }
      const token = this.store.getToken?.(trade.mint);
      const migrationAt = number(token?.migrated_at ?? token?.graduated_at);
      if ((migrationAt > 0 && migrationAt <= point.receivedAtMs) || trade.complete === true) {
        this._strictRejected('STRICT_CURVE_ALREADY_COMPLETE'); continue;
      }
      const anchor = { at: trade.timestampMs, price: point.markPrice, features, triggered: new Set() };
      const baseline = this._emit(profile.id, trade, anchor, features, {
        calibrationVersion: profile.executionVersion || STRICT_EXECUTION_VERSION,
        sourceMarketPrice: number(trade.price), sourceReservePrice: point.markPrice,
      });
      if (!baseline.length) continue;
      this.strictSeen.add(seenKey);
      this.counters.candidates += 1;
      emitted.push(...baseline);
      for (const paired of this.entryProfiles.values()) {
        if (!paired.strictExecution || paired.pairedBaselineProfileId !== profile.id
          || paired.newEntriesEnabled === false) continue;
        emitted.push(...this._emit(paired.id, trade, anchor, features, {
          pairedBaselineProfileId: profile.id, sourcePositionId: baseline[0].id,
          calibrationVersion: profile.executionVersion || STRICT_EXECUTION_VERSION,
          sourceMarketPrice: number(trade.price), sourceReservePrice: point.markPrice,
        }));
      }
    }
    return emitted;
  }

  _bridgeStrictSignal(profile, trade, position) {
    if (typeof this.onLiveSignal !== 'function' || !profile.liveStrategyId) return;
    const point = strictPoint(trade, this.now(), position.strictExecution.maxQuoteChainAgeMs);
    if (point.reason) { this._strictRejected(point.reason); return; }
    // The bridge runs once at the causal source signal, not after a simulated
    // entry. Actual transactions remain exclusively the live manager's job.
    const signal = {
      strategyId: profile.liveStrategyId,
      episodeId: `${position.strictExecution.version}:${trade.mint}:${trade.timestampMs}`,
      mint: trade.mint, symbol: trade.symbol || null,
      timestampMs: trade.timestampMs, receivedAtMs: point.receivedAtMs,
      chainTimestampMs: point.chainTimestampMs, signature: point.signature,
      slot: point.slot, eventIndex: point.eventIndex, market: MARKET,
      wallet: trade.wallet, side: trade.side, solAmount: trade.solAmount,
      tokenAmount: trade.tokenAmount, price: point.markPrice, reservePrice: point.markPrice,
      bondingCurve: point.pool, pool: trade.pool || null,
      virtualSolReservesRaw: trade.virtualSolReservesRaw,
      virtualTokenReservesRaw: trade.virtualTokenReservesRaw,
      realSolReservesRaw: trade.realSolReservesRaw,
      realTokenReservesRaw: trade.realTokenReservesRaw,
      curvePct: number(trade.curvePct), ageMs: number(trade.ageMs),
      features: {
        sourceCohortId: position.cohortId, sourcePositionId: position.id,
        sourceEntryProfileId: position.entryProfileId, sourceExitProfileId: position.exitProfileId,
        calibrationVersion: position.strictExecution.version, shadowPositionSol: position.positionSol,
        sourceSignalAt: position.signalAt, sourceReceivedAt: point.receivedAtMs,
        sourceChainTimestampMs: point.chainTimestampMs, sourceMarket: MARKET,
        sourceTradePrice: number(trade.price), sourceReservePrice: point.markPrice,
        sourcePool: point.pool, sourceSignature: point.signature, sourceEventIndex: point.eventIndex,
        simulatedEntryTargetAt: position.entryTargetAt,
        simulatedExecutionDelayMs: position.strictExecution.entryDelayMs,
      },
    };
    try {
      const result = this.onLiveSignal(signal);
      this.counters.liveSignals += 1;
      if (result?.catch) result.catch(() => { this.counters.liveSignalErrors += 1; });
    } catch (_) { this.counters.liveSignalErrors += 1; }
  }

  _strictPendingExit(position, triggerAt, reason, triggerPoint = null) {
    const execution = position.strictExecution;
    position.status = 'EXIT_PENDING';
    position.exitReason = reason;
    execution.exitTriggerAt = triggerAt;
    execution.exitTriggerPoint = triggerPoint;
    position.exitTargetAt = triggerAt + execution.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + execution.exitTimeoutMs;
    this._save(position);
  }

  _advanceStrictTime(position, now) {
    const execution = position.strictExecution;
    if (execution.invalid) {
      this._finish(position, position.status === 'PENDING_ENTRY' ? 'NO_ENTRY' : 'NO_EXIT',
        'STRICT_EXECUTION_METADATA_INVALID');
      return;
    }
    if (position.status === 'PENDING_ENTRY' && now > position.entryDeadlineAt) {
      this._finish(position, 'NO_ENTRY', 'STRICT_ENTRY_TIMEOUT');
    } else {
      if (position.status === 'OPEN' && now >= position.entryAt + execution.maxHoldMs) {
        this._strictPendingExit(position, position.entryAt + execution.maxHoldMs,
          `FIXED_${execution.maxHoldMs}MS`);
      }
      if (position.status === 'EXIT_PENDING' && now > position.exitDeadlineAt) {
        this._finish(position, 'NO_EXIT', 'STRICT_POST_TARGET_EXIT_QUOTE_UNAVAILABLE');
      }
    }
  }

  _advanceStrictPosition(position, trade) {
    if (trade.mint !== position.mint) return;
    this._advanceStrictTime(position, this.now());
    if (!ACTIVE.has(position.status)) return;
    const execution = position.strictExecution;
    const point = strictPoint(trade, this.now(), execution.maxQuoteChainAgeMs);
    if (point.reason) return this._strictRejected(point.reason, position);
    if (point.pool !== execution.source.pool || point.market !== execution.source.market) {
      return this._strictRejected('STRICT_MARKET_OR_POOL_MISMATCH', position);
    }
    const token = this.store.getToken?.(position.mint);
    const migrationAt = number(token?.migrated_at ?? token?.graduated_at);
    if ((migrationAt > 0 && migrationAt <= point.receivedAtMs) || trade.complete === true) {
      return this._strictRejected('STRICT_CURVE_ALREADY_COMPLETE', position);
    }
    const cursor = advanceStrictCursor(execution.cursor, point);
    if (!cursor) return this._strictRejected('STRICT_OUT_OF_ORDER_OR_DUPLICATE', position);
    execution.cursor = cursor;
    const timestampMs = Math.max(point.timestampMs, point.receivedAtMs);
    const marketPrice = point.markPrice;
    if (position.status === 'PENDING_ENTRY') {
      if (point.receivedAtMs <= execution.source.receivedAtMs
        || point.receivedAtMs < position.entryTargetAt || this.now() < position.entryTargetAt
        || point.chainTimestampMs < position.entryTargetAt
        || timestampMs < position.entryTargetAt) {
        return this._strictRejected('STRICT_ENTRY_BEFORE_TARGET', position);
      }
      if (timestampMs > position.entryDeadlineAt) return this._finish(position, 'NO_ENTRY', 'STRICT_ENTRY_TIMEOUT');
      const selective = execution.rugGuardMode === 'LIVE_CURVE_CATASTROPHE';
      const guard = evaluateUniversalRugGuard(this.store, {
        strategyId: `EARLY_PURE_BUY:${position.entryProfileId}`,
        mint: position.mint, timestampMs, source: 'SHADOW', market: MARKET,
        lifecycleStage: 'CURVE_EARLY', enforcementMode: selective ? 'HARD_BLOCK' : 'LABEL_ONLY',
        ...(selective ? {
          hardBlockSignatures: hardBlockSignaturesForLifecycle({ market: MARKET, lifecycleStage: 'CURVE_EARLY' }),
        } : {}),
        policyReason: selective ? 'SHADOW_STRICT_EXECUTION_RUGX_PAIR' : 'SHADOW_STRICT_EXECUTION_UNFILTERED_BASELINE',
      });
      execution.entryGuard = { evaluatedAt: timestampMs, blocked: Boolean(guard.blocked), reason: guard.reason || null };
      if (selective && guard.blocked) {
        this.counters.blockedByRugGuard += 1;
        return this._finish(position, 'NO_ENTRY', guard.reason || 'RUG_GUARD');
      }
      const quote = executableBuy(trade, position.positionSol, marketPrice);
      if (!quote.available || quote.tokenUnits > Number(trade.realTokenReservesRaw) / 1e6) {
        return this._strictRejected('STRICT_BUY_CAPACITY_UNAVAILABLE', position);
      }
      const jumpPct = (marketPrice / position.signalPrice - 1) * 100;
      if (quote.impactPct > execution.maxEntryImpactPct
        || jumpPct > execution.maxEntryPriceJumpPct || jumpPct < -execution.maxEntryPriceDropPct) {
        return this._finish(position, 'NO_ENTRY', 'ENTRY_EXECUTION_GUARD');
      }
      Object.assign(position, {
        status: 'OPEN', entryAt: timestampMs, entryMarket: MARKET,
        entryPrice: quote.price, entryMarketPrice: marketPrice,
        entryJumpPct: jumpPct, entryImpactPct: quote.impactPct, tokenUnits: quote.tokenUnits,
        highestPrice: marketPrice, lowestPrice: marketPrice,
        maxFavorableReturnPct: 0, maxAdverseReturnPct: 0,
      });
      execution.entry = point;
      this.counters.opened += 1;
      this._save(position);
      return;
    }
    const exit = executableSell(trade, position.tokenUnits, marketPrice);
    if (!exit.available || !Number.isFinite(exit.proceedsSol)
      || exit.proceedsSol > Number(trade.realSolReservesRaw) / 1e9) {
      return this._strictRejected('STRICT_SELL_CAPACITY_UNAVAILABLE', position);
    }
    if (position.status === 'OPEN') {
      position.highestPrice = Math.max(position.highestPrice, marketPrice);
      position.lowestPrice = Math.min(position.lowestPrice, marketPrice);
      position.maxFavorableReturnPct = (position.highestPrice / position.entryPrice - 1) * 100;
      position.maxAdverseReturnPct = (position.lowestPrice / position.entryPrice - 1) * 100;
      if (execution.hardStopPct > 0
        && (exit.proceedsSol / position.positionSol - 1) * 100 <= -execution.hardStopPct) {
        this._strictPendingExit(position, timestampMs, 'EXECUTABLE_HARD_STOP', point);
      } else this._save(position);
      return;
    }
    if (position.status === 'EXIT_PENDING') {
      if (point.receivedAtMs <= execution.exitTriggerAt
        || point.receivedAtMs <= execution.entry.receivedAtMs
        || point.receivedAtMs < position.exitTargetAt || this.now() < position.exitTargetAt
        || point.chainTimestampMs < position.exitTargetAt || timestampMs < position.exitTargetAt) {
        return this._strictRejected('STRICT_EXIT_BEFORE_TARGET', position);
      }
      if (timestampMs > position.exitDeadlineAt) return this._finish(position, 'NO_EXIT', 'STRICT_EXIT_TIMEOUT');
      execution.exit = point;
      this._close(position, { ...trade, timestampMs }, marketPrice);
    }
  }

  _advancePosition(position, trade) {
    if (position.strictExecution) return this._advanceStrictPosition(position, trade);
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
          hardBlockSignatures: hardBlockSignaturesForLifecycle({
            market: MARKET, lifecycleStage: 'CURVE_EARLY',
          }),
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
    position.exitReason = position.strictExecution ? position.exitReason
      : `FIXED_${this.exitProfiles.get(position.exitProfileId).maxHoldMs}MS`;
    position.grossReturnPct = grossReturnPct;
    const costs = position.strictExecution?.costs || this.costs;
    position.netReturnPct = grossReturnPct - (position.strictExecution
      ? position.configuredCostPct : costs.deterministicCostPct);
    position.estimatedCostSol = costs.totalFixedCostSol
      + position.positionSol * (costs.deterministicCostPct - costs.fixedCostPct) / 100;
    position.holdMs = trade.timestampMs - position.entryAt;
    this.counters.closed += 1;
    this._untrackPosition(position);
    this._save(position);
    return true;
  }

  _closeFromCachedQuote(position, now) {
    if (position.strictExecution) return false;
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
    return [...this._evaluateSignals(trade, state), ...this._evaluateStrictSignals(trade, state)];
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
      if (position.strictExecution) {
        this._advanceStrictTime(position, now);
        continue;
      }
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
      SELECT cohort_id, entry_profile_id, exit_profile_id, position_sol, configured_cost_pct,
        COUNT(*) signals,
        SUM(CASE WHEN status='OPEN' OR status='EXIT_PENDING' THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN status='NO_ENTRY' THEN 1 ELSE 0 END) no_entry,
        SUM(CASE WHEN status='NO_EXIT' THEN 1 ELSE 0 END) no_exit
        , SUM(CASE WHEN status='RIGHT_CENSORED' THEN 1 ELSE 0 END) right_censored
      FROM early_pure_buy_burst_shadow_positions
      GROUP BY cohort_id, entry_profile_id, exit_profile_id, position_sol, configured_cost_pct
      ORDER BY entry_profile_id, exit_profile_id
    `).all().map((row) => {
      const completedRows = this.store.db.prepare(`
        SELECT net_return_pct FROM early_pure_buy_burst_shadow_positions
        WHERE cohort_id=? AND position_sol=? AND configured_cost_pct=? AND status='CLOSED'
          AND net_return_pct IS NOT NULL
      `).all(row.cohort_id, row.position_sol, row.configured_cost_pct);
      return { ...row, ...aggregate(completedRows),
        executionVersion: this.entryProfiles.get(row.entry_profile_id)?.executionVersion || null };
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
    for (const filtered of this.entryProfiles.values()) {
      if (!filtered.strictExecution || !filtered.pairedBaselineProfileId) continue;
      for (const exitId of filtered.exitProfileIds || []) {
        const rows = this.store.db.prepare(`
          SELECT b.mint, b.signal_at,
            b.status AS baseline_status, b.net_return_pct AS baseline_return_pct,
            f.status AS filtered_status, f.net_return_pct AS filtered_return_pct,
            f.rejection_reason AS filtered_reason
          FROM early_pure_buy_burst_shadow_positions f
          JOIN early_pure_buy_burst_shadow_positions b ON b.mint=f.mint
            AND b.signal_at=f.signal_at AND b.position_sol=f.position_sol
            AND b.configured_cost_pct=f.configured_cost_pct
            AND b.exit_profile_id=f.exit_profile_id
          WHERE b.entry_profile_id=? AND f.entry_profile_id=? AND b.exit_profile_id=?
          ORDER BY f.signal_at DESC
        `).all(filtered.pairedBaselineProfileId, filtered.id, exitId);
        rugComparisons.push({ ...buildShadowRugPairComparison({
          id: `${filtered.id}:${exitId}`, label: `严格执行 0.02 SOL · ${exitId}`,
          baselineProfileId: filtered.pairedBaselineProfileId, filteredProfileId: filtered.id,
          exitProfileId: exitId, rows,
        }), positionSizeSol: filtered.positionSizeSol,
        executionVersion: filtered.executionVersion || STRICT_EXECUTION_VERSION });
      }
    }
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
