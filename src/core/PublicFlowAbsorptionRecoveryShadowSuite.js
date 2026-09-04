'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');

const STATUS = Object.freeze({
  PENDING_ENTRY: 'PENDING_ENTRY',
  OPEN: 'OPEN',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED: 'CLOSED',
  NO_ENTRY: 'NO_ENTRY',
  NO_EXIT: 'NO_EXIT',
  RUG_REJECTED: 'RUG_REJECTED',
});

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function priceOf(trade) {
  const reserve = finite(trade?.reservePrice);
  return reserve > 0 ? reserve : finite(trade?.price);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper
    ? ordered[lower]
    : ordered[lower] * (upper - position) + ordered[upper] * (position - lower);
}

function profitFactor(values) {
  const profit = values.filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(values.filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0));
  return loss > 0 ? profit / loss : (profit > 0 ? null : 0);
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function stateFor(token = {}, historyComplete = false) {
  return {
    mint: token.mint,
    symbol: token.symbol || null,
    creator: token.creator || token.creator_wallet || null,
    createdAt: finite(token.createdAt ?? token.created_at),
    historyComplete,
    observedFromAt: null,
    lastAt: null,
    trades: [],
    wallets: new Map(),
    firstBuyers: [],
    firstBuyerSet: new Set(),
    lastRejectedLowAt: null,
    lastRejectedAt: null,
  };
}

class PublicFlowAbsorptionRecoveryShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = config.entryProfiles || [];
    this.exitProfiles = config.exitProfiles || [];
    this.entryById = new Map(this.entryProfiles.map((profile) => [profile.id, profile]));
    this.exitById = new Map(this.exitProfiles.map((profile) => [profile.id, profile]));
    this.publicProfiles = this.entryProfiles.filter((profile) => profile.trigger === 'PUBLIC_FLOW');
    this.j36Profiles = this.entryProfiles.filter((profile) => profile.trigger === 'J36_OPEN');
    this.j36Wallet = config.j36Wallet;
    this.states = new Map();
    this.pendingEntries = new Map();
    this.openPositions = new Map();
    this.positionKeysByMint = new Map();
    this.labelRowsByMint = new Map();
    this.smartEventsByMint = new Map();
    this.signaledMints = new Set();
    this.pendingWrites = [];
    this.metrics = {
      observedTrades: 0,
      observedCurveTrades: 0,
      recoveryStructures: 0,
      publicSignals: 0,
      j36OpenEvents: 0,
      j36Signals: 0,
      smartOpenLabels: 0,
      pendingCreated: 0,
      opened: 0,
      closed: 0,
      noEntry: 0,
      noExit: 0,
      rugRejected: 0,
      impactRejected: 0,
      priceMoveRejected: 0,
      observationsWritten: 0,
      flushes: 0,
      writeErrors: 0,
      lastActionAt: null,
      rejectionReasons: {},
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS public_flow_absorption_recovery_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        trigger_type TEXT NOT NULL,
        trigger_wallet TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_market TEXT NOT NULL,
        signal_price REAL NOT NULL,
        age_ms INTEGER,
        curve_pct REAL,
        pullback_pct REAL,
        rebound_pct REAL,
        selloff_sellers INTEGER,
        selloff_sell_sol REAL,
        selloff_net_flow_sol REAL,
        net_flow_3s_sol REAL,
        net_flow_5s_sol REAL,
        net_flow_10s_sol REAL,
        buyers_3s INTEGER,
        top1_buy_share_5s_pct REAL,
        observed_holders INTEGER,
        first20_retention_pct REAL,
        top3_inventory_pct REAL,
        creator_sell_5s INTEGER,
        history_complete INTEGER,
        features_json TEXT NOT NULL,
        smart_wallet_count INTEGER NOT NULL DEFAULT 0,
        smart_cluster_count INTEGER NOT NULL DEFAULT 0,
        smart_wallets_json TEXT NOT NULL DEFAULT '[]',
        smart_clusters_json TEXT NOT NULL DEFAULT '[]',
        smart_first_at INTEGER,
        smart_last_at INTEGER,
        smart_first_delay_ms INTEGER,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_market_price REAL,
        entry_price REAL,
        entry_jump_pct REAL,
        entry_impact_pct REAL,
        token_units REAL,
        highest_return_pct REAL,
        lowest_return_pct REAL,
        last_market TEXT,
        last_market_price REAL,
        exit_trigger_at INTEGER,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_market TEXT,
        exit_market_price REAL,
        exit_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        hold_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pfar_shadow_status
        ON public_flow_absorption_recovery_shadow_positions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pfar_shadow_mint
        ON public_flow_absorption_recovery_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pfar_shadow_profiles
        ON public_flow_absorption_recovery_shadow_positions(
          entry_profile_id, exit_profile_id, signal_at DESC
        );

      CREATE TABLE IF NOT EXISTS public_flow_absorption_recovery_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id TEXT NOT NULL UNIQUE,
        mint TEXT NOT NULL,
        symbol TEXT,
        trigger_type TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        pullback_low_at INTEGER,
        qualified INTEGER NOT NULL,
        rejection_reasons_json TEXT NOT NULL,
        features_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pfar_observations_time
        ON public_flow_absorption_recovery_observations(observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pfar_observations_mint
        ON public_flow_absorption_recovery_observations(mint, observed_at DESC);
    `);
    const positionColumns = new Set(this.store.db.prepare(
      'PRAGMA table_info(public_flow_absorption_recovery_shadow_positions)',
    ).all().map((column) => column.name));
    if (!positionColumns.has('smart_clusters_json')) {
      this.store.db.exec(
        "ALTER TABLE public_flow_absorption_recovery_shadow_positions ADD COLUMN smart_clusters_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    this.insertPosition = this.store.db.prepare(`
      INSERT OR IGNORE INTO public_flow_absorption_recovery_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id, mint, symbol,
        status, rejection_reason, trigger_type, trigger_wallet,
        position_sol, configured_cost_pct, signal_at, signal_market, signal_price,
        age_ms, curve_pct, pullback_pct, rebound_pct, selloff_sellers,
        selloff_sell_sol, selloff_net_flow_sol, net_flow_3s_sol, net_flow_5s_sol,
        net_flow_10s_sol, buyers_3s, top1_buy_share_5s_pct, observed_holders,
        first20_retention_pct, top3_inventory_pct, creator_sell_5s,
        history_complete, features_json, smart_wallet_count, smart_cluster_count,
        smart_wallets_json, smart_clusters_json, smart_first_at, smart_last_at, smart_first_delay_ms,
        entry_target_at, entry_deadline_at, entry_at, entry_market,
        entry_market_price, entry_price, entry_jump_pct, entry_impact_pct,
        token_units, highest_return_pct, lowest_return_pct, last_market,
        last_market_price, exit_trigger_at, exit_target_at, exit_deadline_at,
        exit_at, exit_market, exit_market_price, exit_price, exit_impact_pct,
        exit_reason, gross_return_pct, net_return_pct, hold_ms, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId, @mint, @symbol,
        @status, @rejectionReason, @triggerType, @triggerWallet,
        @positionSol, @configuredCostPct, @signalAt, @signalMarket, @signalPrice,
        @ageMs, @curvePct, @pullbackPct, @reboundPct, @selloffSellers,
        @selloffSellSol, @selloffNetFlowSol, @netFlow3sSol, @netFlow5sSol,
        @netFlow10sSol, @buyers3s, @top1BuyShare5sPct, @observedHolders,
        @first20RetentionPct, @top3InventoryPct, @creatorSell5s,
        @historyComplete, @featuresJson, @smartWalletCount, @smartClusterCount,
        @smartWalletsJson, @smartClustersJson, @smartFirstAt, @smartLastAt, @smartFirstDelayMs,
        @entryTargetAt, @entryDeadlineAt, @entryAt, @entryMarket,
        @entryMarketPrice, @entryPrice, @entryJumpPct, @entryImpactPct,
        @tokenUnits, @highestReturnPct, @lowestReturnPct, @lastMarket,
        @lastMarketPrice, @exitTriggerAt, @exitTargetAt, @exitDeadlineAt,
        @exitAt, @exitMarket, @exitMarketPrice, @exitPrice, @exitImpactPct,
        @exitReason, @grossReturnPct, @netReturnPct, @holdMs, @createdAt, @updatedAt
      )
    `);
    this.updatePosition = this.store.db.prepare(`
      UPDATE public_flow_absorption_recovery_shadow_positions SET
        status=@status,
        rejection_reason=@rejectionReason,
        smart_wallet_count=@smartWalletCount,
        smart_cluster_count=@smartClusterCount,
        smart_wallets_json=@smartWalletsJson,
        smart_clusters_json=@smartClustersJson,
        smart_first_at=@smartFirstAt,
        smart_last_at=@smartLastAt,
        smart_first_delay_ms=@smartFirstDelayMs,
        entry_at=@entryAt,
        entry_market=@entryMarket,
        entry_market_price=@entryMarketPrice,
        entry_price=@entryPrice,
        entry_jump_pct=@entryJumpPct,
        entry_impact_pct=@entryImpactPct,
        token_units=@tokenUnits,
        highest_return_pct=@highestReturnPct,
        lowest_return_pct=@lowestReturnPct,
        last_market=@lastMarket,
        last_market_price=@lastMarketPrice,
        exit_trigger_at=@exitTriggerAt,
        exit_target_at=@exitTargetAt,
        exit_deadline_at=@exitDeadlineAt,
        exit_at=@exitAt,
        exit_market=@exitMarket,
        exit_market_price=@exitMarketPrice,
        exit_price=@exitPrice,
        exit_impact_pct=@exitImpactPct,
        exit_reason=@exitReason,
        gross_return_pct=@grossReturnPct,
        net_return_pct=@netReturnPct,
        hold_ms=@holdMs,
        updated_at=@updatedAt
      WHERE cohort_id=@cohortId AND episode_id=@episodeId
    `);
    this.insertObservation = this.store.db.prepare(`
      INSERT OR IGNORE INTO public_flow_absorption_recovery_observations (
        observation_id, mint, symbol, trigger_type, observed_at,
        pullback_low_at, qualified, rejection_reasons_json, features_json, created_at
      ) VALUES (
        @observationId, @mint, @symbol, @triggerType, @observedAt,
        @pullbackLowAt, @qualified, @rejectionReasonsJson, @featuresJson, @createdAt
      )
    `);
  }

  start() {
    if (!this.config.enabled) return;
    const active = this.store.db.prepare(`
      SELECT * FROM public_flow_absorption_recovery_shadow_positions
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING')
      ORDER BY signal_at, id
    `).all();
    for (const row of active) this._restorePosition(row);
    const signaled = this.store.db.prepare(`
      SELECT DISTINCT mint, entry_profile_id
      FROM public_flow_absorption_recovery_shadow_positions
    `).all();
    for (const row of signaled) this.signaledMints.add(`${row.mint}:${row.entry_profile_id}`);
    const recentLabels = this.store.db.prepare(`
      SELECT * FROM public_flow_absorption_recovery_shadow_positions
      WHERE entry_profile_id='PFAR_B_TAG_ONLY' AND signal_at>=?
    `).all(this.now() - this.config.smartFutureLabelWindowMs);
    for (const row of recentLabels) this._indexLabelRow(this._rowToPosition(row));
    this.advanceTime(this.now());
  }

  stop() { this._flushWrites(); }

  onCreate(token = {}) {
    if (!this.config.enabled || !token.mint) return;
    this.states.set(token.mint, stateFor(token, true));
  }

  trackedMints() {
    return [...new Set([
      ...this.positionKeysByMint.keys(),
      ...this.labelRowsByMint.keys(),
    ])];
  }

  observeTrade(trade, { replay = false } = {}) {
    if (!this.config.enabled || !trade?.mint
      || !['PUMP_BONDING_CURVE', 'PUMP_AMM'].includes(trade.market)) return [];
    const timestampMs = finite(trade.timestampMs);
    const price = priceOf(trade);
    if (!(timestampMs > 0) || !(price > 0)) return [];
    this.metrics.observedTrades += 1;
    this._observePositions(trade, timestampMs, price);
    if (trade.market !== 'PUMP_BONDING_CURVE') return [];
    this.metrics.observedCurveTrades += 1;
    const state = this._applyCurveTrade(trade, timestampMs, price);
    if (replay || !state) return [];
    return this._evaluatePublic(state, trade, timestampMs, price);
  }

  onSmartWalletEvent(event, { walletSnapshot = null } = {}) {
    if (!this.config.enabled || !event?.mint || !event.wallet) return [];
    const timestampMs = finite(event.timestampMs ?? event.timestamp_ms);
    const side = String(event.side || '').toUpperCase();
    const phase = String(event.positionPhase ?? event.position_phase ?? '').toUpperCase();
    if (!(timestampMs > 0) || side !== 'BUY' || phase !== 'OPEN') return [];
    const cluster = walletSnapshot?.independenceClusterId
      || walletSnapshot?.independence_cluster_id
      || event.independenceClusterId
      || event.wallet;
    this._rememberSmartEvent(event.mint, {
      timestampMs,
      wallet: event.wallet,
      cluster,
      grade: walletSnapshot?.grade || null,
    });
    this._labelTagOnlyRows(event.mint, timestampMs);

    if (event.wallet !== this.j36Wallet) return [];
    this.metrics.j36OpenEvents += 1;
    const state = this.states.get(event.mint);
    const price = priceOf(event);
    if (!state || !(price > 0)) return [];
    const features = { ...this._features(state, timestampMs), observedAt: timestampMs };
    const results = [];
    for (const profile of this.j36Profiles) {
      const reasons = this._entryReasons(profile, features);
      if (finite(event.solAmount, 0) < finite(profile.minTriggerBuySol, 0)) {
        reasons.push('TRIGGER_BUY_BELOW_MIN');
      }
      this._recordObservation(state, 'J36_OPEN', features, reasons);
      if (reasons.length) continue;
      results.push(...this._recordSignal(profile, state, event, timestampMs, price, features));
      if (results.length) this.metrics.j36Signals += 1;
    }
    return results;
  }

  _ensureState(trade, timestampMs) {
    let state = this.states.get(trade.mint);
    if (state) return state;
    const token = this.store.getToken(trade.mint) || {};
    const ageMs = finite(trade.ageMs,
      finite(token.created_at ?? token.createdAt) == null
        ? null : timestampMs - finite(token.created_at ?? token.createdAt));
    state = stateFor({
      mint: trade.mint,
      symbol: trade.symbol || token.symbol,
      creator: token.creator || token.creator_wallet,
      createdAt: finite(token.created_at ?? token.createdAt),
    }, ageMs != null && ageMs <= this.config.completeHistoryMaxInitialAgeMs);
    this.states.set(trade.mint, state);
    return state;
  }

  _applyCurveTrade(trade, timestampMs, price) {
    const state = this._ensureState(trade, timestampMs);
    state.observedFromAt ??= timestampMs;
    state.lastAt = timestampMs;
    state.symbol ||= trade.symbol || null;
    state.trades.push({
      timestampMs,
      price,
      side: String(trade.side || '').toUpperCase(),
      wallet: trade.wallet || null,
      solAmount: Math.max(0, finite(trade.solAmount, 0)),
      tokenAmount: Math.max(0, finite(trade.tokenAmount, 0)),
      curvePct: finite(trade.curvePct),
      ageMs: finite(trade.ageMs),
    });
    const cutoff = timestampMs - this.config.structureWindowMs;
    while (state.trades.length && state.trades[0].timestampMs < cutoff) state.trades.shift();

    if (trade.wallet) {
      const wallet = state.wallets.get(trade.wallet) || {
        firstBuyAt: null, buyToken: 0, netToken: 0, buySol: 0,
      };
      if (String(trade.side).toUpperCase() === 'BUY') {
        if (wallet.firstBuyAt == null) {
          wallet.firstBuyAt = timestampMs;
          if (!state.firstBuyerSet.has(trade.wallet)) {
            state.firstBuyerSet.add(trade.wallet);
            state.firstBuyers.push(trade.wallet);
          }
        }
        wallet.buyToken += Math.max(0, finite(trade.tokenAmount, 0));
        wallet.netToken += Math.max(0, finite(trade.tokenAmount, 0));
        wallet.buySol += Math.max(0, finite(trade.solAmount, 0));
      } else if (String(trade.side).toUpperCase() === 'SELL') {
        wallet.netToken -= Math.max(0, finite(trade.tokenAmount, 0));
      }
      state.wallets.set(trade.wallet, wallet);
    }
    return state;
  }

  _features(state, timestampMs) {
    const rows = state.trades.filter((row) => row.timestampMs <= timestampMs
      && row.timestampMs >= timestampMs - this.config.structureWindowMs);
    const latest = rows.at(-1);
    if (!rows.length || !latest) return { historyComplete: state.historyComplete };
    let peak = rows[0];
    let low = rows[0];
    for (const row of rows.slice(1)) {
      if (row.price > peak.price) {
        peak = row;
        low = row;
      } else if (row.price < low.price) low = row;
    }
    const betweenPeakAndLow = rows.filter((row) => row.timestampMs >= peak.timestampMs
      && row.timestampMs <= low.timestampMs);
    const window = (milliseconds) => rows.filter((row) => (
      row.timestampMs >= timestampMs - milliseconds
    ));
    const flow = (events) => events.reduce((sum, row) => (
      sum + (row.side === 'BUY' ? row.solAmount : -row.solAmount)
    ), 0);
    const buys = (events) => events.filter((row) => row.side === 'BUY');
    const sells = (events) => events.filter((row) => row.side === 'SELL');
    const rows1 = window(1_000);
    const rows3 = window(3_000);
    const rows5 = window(5_000);
    const rows10 = window(10_000);
    const buys5 = buys(rows5);
    const buyFlow5 = buys5.reduce((sum, row) => sum + row.solAmount, 0);
    const byBuyer5 = new Map();
    for (const row of buys5) {
      if (row.wallet) byBuyer5.set(row.wallet, (byBuyer5.get(row.wallet) || 0) + row.solAmount);
    }
    const largestBuy5 = Math.max(0, ...byBuyer5.values());
    const positiveHolders = [...state.wallets.entries()]
      .map(([wallet, value]) => ({ wallet, ...value, netToken: Math.max(0, value.netToken) }))
      .filter((row) => row.netToken > 0)
      .sort((left, right) => right.netToken - left.netToken);
    const totalInventory = positiveHolders.reduce((sum, row) => sum + row.netToken, 0);
    const top3Inventory = positiveHolders.slice(0, 3)
      .reduce((sum, row) => sum + row.netToken, 0);
    const first20 = state.firstBuyers.slice(0, 20)
      .map((wallet) => state.wallets.get(wallet)).filter(Boolean);
    const retained = first20.filter((wallet) => wallet.buyToken > 0
      && wallet.netToken >= wallet.buyToken * this.config.retentionFloorFraction).length;
    const selloffSells = sells(betweenPeakAndLow);
    const tokenAge = finite(latest.ageMs,
      state.createdAt == null ? null : timestampMs - state.createdAt);
    return {
      ageMs: tokenAge,
      curvePct: finite(latest.curvePct),
      historyComplete: state.historyComplete,
      observedHistoryMs: state.observedFromAt == null ? 0 : timestampMs - state.observedFromAt,
      peakAt: peak.timestampMs,
      peakPrice: peak.price,
      pullbackLowAt: low.timestampMs,
      pullbackLowPrice: low.price,
      pullbackPct: peak.price > 0 ? (1 - low.price / peak.price) * 100 : null,
      reboundPct: low.price > 0 ? (latest.price / low.price - 1) * 100 : null,
      selloffSellers: new Set(selloffSells.map((row) => row.wallet).filter(Boolean)).size,
      selloffSellSol: selloffSells.reduce((sum, row) => sum + row.solAmount, 0),
      selloffNetFlowSol: flow(betweenPeakAndLow),
      netFlow3sSol: flow(rows3),
      netFlow5sSol: flow(rows5),
      netFlow10sSol: flow(rows10),
      buyers3s: new Set(buys(rows3).map((row) => row.wallet).filter(Boolean)).size,
      buyers5s: byBuyer5.size,
      top1BuyShare5sPct: buyFlow5 > 0 ? largestBuy5 / buyFlow5 * 100 : null,
      recentSell1sSol: sells(rows1).reduce((sum, row) => sum + row.solAmount, 0),
      observedHolders: positiveHolders.length,
      first20RetentionPct: first20.length
        ? retained / first20.length * 100 : null,
      first20SampleSize: first20.length,
      top3InventoryPct: totalInventory > 0 ? top3Inventory / totalInventory * 100 : null,
      creatorSell5s: Boolean(state.creator && sells(rows5)
        .some((row) => row.wallet === state.creator)),
    };
  }

  _entryReasons(profile, features) {
    const reasons = [];
    const below = (value, limit) => limit != null && !(finite(value) >= limit);
    const above = (value, limit) => limit != null && !(finite(value) <= limit);
    if (profile.requireCompleteHistory && !features.historyComplete) reasons.push('HISTORY_INCOMPLETE');
    if (below(features.ageMs, profile.minAgeMs)) reasons.push('AGE_BELOW_MIN');
    if (above(features.ageMs, profile.maxAgeMs)) reasons.push('AGE_ABOVE_MAX');
    if (below(features.curvePct, profile.minCurvePct)) reasons.push('CURVE_BELOW_MIN');
    if (above(features.curvePct, profile.maxCurvePct)) reasons.push('CURVE_ABOVE_MAX');
    if (below(features.pullbackPct, profile.minPullbackPct)) reasons.push('PULLBACK_BELOW_MIN');
    if (above(features.pullbackPct, profile.maxPullbackPct)) reasons.push('PULLBACK_ABOVE_MAX');
    if (below(features.reboundPct, profile.minReboundPct)) reasons.push('REBOUND_BELOW_MIN');
    if (above(features.reboundPct, profile.maxReboundPct)) reasons.push('REBOUND_ABOVE_MAX');
    if (!(features.pullbackLowAt < (features.observedAt || Infinity))) reasons.push('NO_POST_LOW_RECOVERY');
    if (below(features.selloffSellers, profile.minSelloffSellers)) reasons.push('SELLOFF_SELLERS_BELOW_MIN');
    if (below(features.selloffSellSol, profile.minSelloffSellSol)) reasons.push('SELLOFF_FLOW_BELOW_MIN');
    if (profile.maxSelloffNetFlowSol != null
      && !(finite(features.selloffNetFlowSol, Infinity) <= profile.maxSelloffNetFlowSol)) {
      reasons.push('SELLOFF_NOT_NET_NEGATIVE');
    }
    if (below(features.netFlow3sSol, profile.minNetFlow3sSol)) reasons.push('NET_FLOW_3S_BELOW_MIN');
    if (below(features.netFlow5sSol, profile.minNetFlow5sSol)) reasons.push('NET_FLOW_5S_BELOW_MIN');
    if (below(features.netFlow10sSol, profile.minNetFlow10sSol)) reasons.push('NET_FLOW_10S_BELOW_MIN');
    if (below(features.buyers3s, profile.minBuyers3s)) reasons.push('BUYERS_3S_BELOW_MIN');
    if (above(features.top1BuyShare5sPct, profile.maxTop1BuyShare5sPct)) reasons.push('TOP1_BUY_SHARE_ABOVE_MAX');
    if (above(features.recentSell1sSol, profile.maxRecentSell1sSol)) reasons.push('RECENT_SELL_FLOW_ABOVE_MAX');
    if (below(features.observedHolders, profile.minObservedHolders)) reasons.push('HOLDERS_BELOW_MIN');
    if (below(features.first20SampleSize, profile.minFirstBuyerSample)) reasons.push('FIRST_BUYER_SAMPLE_BELOW_MIN');
    if (below(features.first20RetentionPct, profile.minFirst20RetentionPct)) reasons.push('RETENTION_BELOW_MIN');
    if (above(features.top3InventoryPct, profile.maxTop3InventoryPct)) reasons.push('TOP3_INVENTORY_ABOVE_MAX');
    if (profile.rejectCreatorSell5s && features.creatorSell5s) reasons.push('CREATOR_RECENT_SELL');
    return reasons;
  }

  _isRecoveryStructure(features) {
    return finite(features.pullbackPct, 0) >= this.config.observationMinPullbackPct
      && finite(features.reboundPct, 0) >= this.config.observationMinReboundPct
      && features.pullbackLowAt < features.observedAt;
  }

  _evaluatePublic(state, trade, timestampMs, price) {
    if (this.publicProfiles.every((profile) => (
      this.signaledMints.has(`${state.mint}:${profile.id}`)
    ))) return [];
    const features = { ...this._features(state, timestampMs), observedAt: timestampMs };
    if (!this._isRecoveryStructure(features)) return [];
    this.metrics.recoveryStructures += 1;
    const representative = this.publicProfiles[0];
    const representativeReasons = representative
      ? this._entryReasons(representative, features) : ['NO_PUBLIC_PROFILE'];
    const shouldRecord = state.lastRejectedLowAt !== features.pullbackLowAt
      || timestampMs - finite(state.lastRejectedAt, 0) >= this.config.rejectionObservationCooldownMs;
    if (shouldRecord) {
      state.lastRejectedLowAt = features.pullbackLowAt;
      state.lastRejectedAt = timestampMs;
      this._recordObservation(state, 'PUBLIC_FLOW', features, representativeReasons);
    }
    const results = [];
    for (const profile of this.publicProfiles) {
      if (this.signaledMints.has(`${state.mint}:${profile.id}`)) continue;
      const reasons = this._entryReasons(profile, features);
      if (reasons.length) {
        this._countRejections(reasons);
        continue;
      }
      results.push(...this._recordSignal(profile, state, trade, timestampMs, price, features));
    }
    if (results.length) this.metrics.publicSignals += 1;
    return results;
  }

  _recordObservation(state, triggerType, features, reasons) {
    const outcome = reasons.length ? 'REJECT' : 'PASS';
    const observationId = `${state.mint}:${triggerType}:${features.pullbackLowAt || 0}:${outcome}`;
    this.pendingWrites.push({
      type: 'observation',
      row: {
        observationId,
        mint: state.mint,
        symbol: state.symbol,
        triggerType,
        observedAt: features.observedAt,
        pullbackLowAt: features.pullbackLowAt || null,
        qualified: reasons.length ? 0 : 1,
        rejectionReasonsJson: JSON.stringify(reasons),
        featuresJson: JSON.stringify(features),
        createdAt: this.now(),
      },
    });
  }

  _recordSignal(profile, state, trade, timestampMs, price, features) {
    const seenKey = `${state.mint}:${profile.id}`;
    if (this.signaledMints.has(seenKey)) return [];
    this.signaledMints.add(seenKey);
    const episodeId = `${state.mint}:${profile.id}:${features.pullbackLowAt || timestampMs}`;
    const smart = profile.id === 'PFAR_B_TAG_ONLY'
      ? this._smartSnapshot(state.mint, timestampMs) : this._emptySmartSnapshot();
    const rows = [];
    for (const exitProfile of this.exitProfiles) {
      const position = {
        cohortId: `${profile.id}/${exitProfile.id}`,
        entryProfileId: profile.id,
        exitProfileId: exitProfile.id,
        exitProfile,
        episodeId,
        mint: state.mint,
        symbol: state.symbol || trade.symbol || null,
        status: STATUS.PENDING_ENTRY,
        rejectionReason: null,
        triggerType: profile.trigger,
        triggerWallet: profile.trigger === 'J36_OPEN' ? trade.wallet : null,
        positionSol: this.config.positionSizeSol,
        signalAt: timestampMs,
        signalMarket: 'PUMP_BONDING_CURVE',
        signalPrice: price,
        features,
        ...smart,
        entryTargetAt: timestampMs + this.config.entryDelayMs,
        entryDeadlineAt: timestampMs + this.config.entryDelayMs + this.config.entryTimeoutMs,
        entryAt: null,
        entryMarket: null,
        entryMarketPrice: null,
        entryPrice: null,
        entryJumpPct: null,
        entryImpactPct: null,
        tokenUnits: null,
        highestReturnPct: null,
        lowestReturnPct: null,
        lastMarket: null,
        lastMarketPrice: null,
        exitTriggerAt: null,
        exitTargetAt: null,
        exitDeadlineAt: null,
        exitAt: null,
        exitMarket: null,
        exitMarketPrice: null,
        exitPrice: null,
        exitImpactPct: null,
        exitReason: null,
        grossReturnPct: null,
        netReturnPct: null,
        holdMs: null,
      };
      this._queuePosition('insert', position);
      this.pendingEntries.set(this._positionKey(position), position);
      this._indexPosition(position);
      if (profile.id === 'PFAR_B_TAG_ONLY') this._indexLabelRow(position);
      this.metrics.pendingCreated += 1;
      rows.push(position);
    }
    this.metrics.lastActionAt = timestampMs;
    return rows;
  }

  _observePositions(trade, timestampMs, marketPrice) {
    const keys = this.positionKeysByMint.get(trade.mint);
    if (!keys?.size) return;
    for (const key of [...keys]) {
      const position = this.pendingEntries.get(key) || this.openPositions.get(key);
      if (!position) continue;
      if (position.status === STATUS.PENDING_ENTRY) {
        if (trade.market !== 'PUMP_BONDING_CURVE'
          || timestampMs < position.entryTargetAt
          || timestampMs > position.entryDeadlineAt) continue;
        this._open(position, trade, timestampMs, marketPrice);
        continue;
      }
      if (position.status === STATUS.EXIT_PENDING) {
        if (timestampMs < position.exitTargetAt || timestampMs > position.exitDeadlineAt) continue;
        this._fillExit(position, trade, timestampMs, marketPrice);
        continue;
      }
      if (position.status !== STATUS.OPEN || timestampMs <= position.entryAt) continue;
      if (!this._comparableMarket(position, trade, marketPrice)) continue;
      const quote = executableSell(trade, position.tokenUnits, marketPrice, {
        rugMarkReturnPct: (marketPrice / position.entryPrice - 1) * 100,
      });
      if (quote.price != null) {
        const currentReturn = (quote.price / position.entryPrice - 1) * 100;
        position.highestReturnPct = Math.max(finite(position.highestReturnPct, 0), currentReturn);
        position.lowestReturnPct = Math.min(finite(position.lowestReturnPct, 0), currentReturn);
        position.lastMarket = trade.market;
        position.lastMarketPrice = marketPrice;
        if (currentReturn <= -position.exitProfile.hardStopPct) {
          this._requestExit(position, timestampMs,
            `HARD_STOP_${position.exitProfile.hardStopPct}`);
        } else if (timestampMs - position.entryAt >= position.exitProfile.maxHoldMs) {
          this._requestExit(position, position.entryAt + position.exitProfile.maxHoldMs,
            `FIXED_${position.exitProfile.maxHoldMs}MS`);
        }
      }
    }
  }

  _open(position, trade, timestampMs, marketPrice) {
    const jumpPct = (marketPrice / position.signalPrice - 1) * 100;
    if (jumpPct > this.config.maxEntryPriceJumpPct
      || jumpPct < -this.config.maxEntryPriceDropPct) {
      position.status = STATUS.NO_ENTRY;
      position.rejectionReason = `ENTRY_PRICE_MOVE_${jumpPct.toFixed(2)}PCT`;
      position.entryJumpPct = jumpPct;
      this.metrics.priceMoveRejected += 1;
      this.metrics.noEntry += 1;
      this._finishPending(position);
      return;
    }
    const rug = evaluateUniversalRugGuard(this.store, {
      strategyId: `PFAR:${position.entryProfileId}`,
      mint: position.mint,
      timestampMs,
      source: 'SHADOW',
    });
    if (rug.blocked) {
      position.status = STATUS.RUG_REJECTED;
      position.rejectionReason = rug.reason || 'UNIVERSAL_RUG_GUARD';
      this.metrics.rugRejected += 1;
      this._finishPending(position);
      return;
    }
    const quote = executableBuy(trade, position.positionSol, marketPrice);
    if (!quote.available || finite(quote.impactPct, Infinity) > this.config.maxEntryImpactPct) {
      position.status = STATUS.NO_ENTRY;
      position.rejectionReason = !quote.available
        ? quote.reason : `ENTRY_IMPACT_${quote.impactPct.toFixed(2)}PCT`;
      position.entryImpactPct = quote.impactPct;
      this.metrics.impactRejected += 1;
      this.metrics.noEntry += 1;
      this._finishPending(position);
      return;
    }
    Object.assign(position, {
      status: STATUS.OPEN,
      entryAt: timestampMs,
      entryMarket: trade.market,
      entryMarketPrice: marketPrice,
      entryPrice: quote.price,
      entryJumpPct: jumpPct,
      entryImpactPct: quote.impactPct,
      tokenUnits: quote.tokenUnits,
      highestReturnPct: 0,
      lowestReturnPct: 0,
      lastMarket: trade.market,
      lastMarketPrice: marketPrice,
    });
    const key = this._positionKey(position);
    this.pendingEntries.delete(key);
    this.openPositions.set(key, position);
    this._queuePosition('update', position);
    this.metrics.opened += 1;
  }

  _finishPending(position) {
    const key = this._positionKey(position);
    this.pendingEntries.delete(key);
    this._unindexPosition(position);
    this._queuePosition('update', position);
  }

  _requestExit(position, triggerAt, reason) {
    if (position.status !== STATUS.OPEN) return;
    position.status = STATUS.EXIT_PENDING;
    position.exitTriggerAt = triggerAt;
    position.exitTargetAt = triggerAt + this.config.exitDelayMs;
    position.exitDeadlineAt = position.exitTargetAt + this.config.exitTimeoutMs;
    position.exitReason = reason;
    this._queuePosition('update', position);
  }

  _fillExit(position, trade, timestampMs, marketPrice) {
    if (!this._comparableMarket(position, trade, marketPrice)) return;
    const markReturnPct = (marketPrice / position.entryPrice - 1) * 100;
    const quote = executableSell(trade, position.tokenUnits, marketPrice, { rugMarkReturnPct: markReturnPct });
    if (quote.price == null) return;
    const grossReturnPct = (quote.price / position.entryPrice - 1) * 100;
    Object.assign(position, {
      status: STATUS.CLOSED,
      exitAt: timestampMs,
      exitMarket: trade.market,
      exitMarketPrice: marketPrice,
      exitPrice: quote.price,
      exitImpactPct: quote.impactPct,
      grossReturnPct,
      netReturnPct: grossReturnPct - this.costs.deterministicCostPct,
      holdMs: timestampMs - position.entryAt,
    });
    this._queuePosition('update', position);
    this._finishOpen(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = timestampMs;
  }

  _comparableMarket(position, trade, marketPrice) {
    if (trade.market === position.lastMarket || trade.market === position.entryMarket) return true;
    if (trade.market !== 'PUMP_AMM') return false;
    const reference = finite(position.lastMarketPrice, position.entryMarketPrice);
    return reference > 0
      && Math.abs((marketPrice / reference - 1) * 100) <= this.config.maxCrossMarketPriceJumpPct;
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const position of [...this.pendingEntries.values()]) {
      if (now <= position.entryDeadlineAt) continue;
      position.status = STATUS.NO_ENTRY;
      position.rejectionReason = 'NO_CURVE_TRADE_IN_ENTRY_WINDOW';
      this.metrics.noEntry += 1;
      this._finishPending(position);
    }
    for (const position of [...this.openPositions.values()]) {
      if (position.status === STATUS.OPEN
        && now - position.entryAt >= position.exitProfile.maxHoldMs) {
        this._requestExit(position, position.entryAt + position.exitProfile.maxHoldMs,
          `FIXED_${position.exitProfile.maxHoldMs}MS`);
      }
      if (position.status === STATUS.EXIT_PENDING && now > position.exitDeadlineAt) {
        position.status = STATUS.NO_EXIT;
        position.exitReason ||= 'NO_EXECUTABLE_EXIT_TRADE';
        this._queuePosition('update', position);
        this._finishOpen(position);
        this.metrics.noExit += 1;
      }
    }
    const stateCutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      if (finite(state.lastAt, 0) < stateCutoff && !this.positionKeysByMint.has(mint)) {
        this.states.delete(mint);
      }
    }
    const labelCutoff = now - this.config.smartFutureLabelWindowMs;
    for (const [mint, rows] of this.labelRowsByMint) {
      const kept = rows.filter((row) => row.signalAt >= labelCutoff);
      if (kept.length) this.labelRowsByMint.set(mint, kept);
      else this.labelRowsByMint.delete(mint);
    }
    const smartCutoff = now - this.config.smartLookbackMs - this.config.smartFutureLabelWindowMs;
    for (const [mint, events] of this.smartEventsByMint) {
      const kept = events.filter((event) => event.timestampMs >= smartCutoff);
      if (kept.length) this.smartEventsByMint.set(mint, kept);
      else this.smartEventsByMint.delete(mint);
    }
    this._flushWrites();
  }

  _rememberSmartEvent(mint, event) {
    const events = this.smartEventsByMint.get(mint) || [];
    if (!events.some((row) => row.wallet === event.wallet
      && row.timestampMs === event.timestampMs)) events.push(event);
    this.smartEventsByMint.set(mint, events);
  }

  _emptySmartSnapshot() {
    return {
      smartWalletCount: 0,
      smartClusterCount: 0,
      smartWallets: new Set(),
      smartClusters: new Set(),
      smartFirstAt: null,
      smartLastAt: null,
      smartFirstDelayMs: null,
    };
  }

  _smartSnapshot(mint, signalAt) {
    const result = this._emptySmartSnapshot();
    const events = (this.smartEventsByMint.get(mint) || []).filter((event) => (
      event.timestampMs >= signalAt - this.config.smartLookbackMs
      && event.timestampMs <= signalAt
    ));
    for (const event of events) {
      result.smartWallets.add(event.wallet);
      result.smartClusters.add(event.cluster || event.wallet);
      result.smartFirstAt = result.smartFirstAt == null
        ? event.timestampMs : Math.min(result.smartFirstAt, event.timestampMs);
      result.smartLastAt = result.smartLastAt == null
        ? event.timestampMs : Math.max(result.smartLastAt, event.timestampMs);
    }
    result.smartWalletCount = result.smartWallets.size;
    result.smartClusterCount = result.smartClusters.size;
    result.smartFirstDelayMs = result.smartFirstAt == null ? null : result.smartFirstAt - signalAt;
    return result;
  }

  _labelTagOnlyRows(mint, timestampMs) {
    const rows = this.labelRowsByMint.get(mint) || [];
    const eventRows = this.smartEventsByMint.get(mint) || [];
    for (const position of rows) {
      if (timestampMs < position.signalAt - this.config.smartLookbackMs
        || timestampMs > position.signalAt + this.config.smartFutureLabelWindowMs) continue;
      // Seed from the persisted label so a restart cannot erase earlier wallet
      // identities when the first new OPEN arrives after startup.
      const snapshot = this._emptySmartSnapshot();
      for (const wallet of position.smartWallets || []) snapshot.smartWallets.add(wallet);
      for (const cluster of position.smartClusters || []) snapshot.smartClusters.add(cluster);
      snapshot.smartFirstAt = position.smartFirstAt;
      snapshot.smartLastAt = position.smartLastAt;
      // Merge both lookback and future labels available in this runtime. A
      // negative delay means the label existed before the public signal.
      for (const event of eventRows) {
        if (event.timestampMs < position.signalAt - this.config.smartLookbackMs
          || event.timestampMs > position.signalAt + this.config.smartFutureLabelWindowMs) continue;
        snapshot.smartWallets.add(event.wallet);
        snapshot.smartClusters.add(event.cluster || event.wallet);
        snapshot.smartFirstAt = snapshot.smartFirstAt == null
          ? event.timestampMs : Math.min(snapshot.smartFirstAt, event.timestampMs);
        snapshot.smartLastAt = snapshot.smartLastAt == null
          ? event.timestampMs : Math.max(snapshot.smartLastAt, event.timestampMs);
      }
      snapshot.smartWalletCount = snapshot.smartWallets.size;
      snapshot.smartClusterCount = snapshot.smartClusters.size;
      snapshot.smartFirstDelayMs = snapshot.smartFirstAt == null
        ? null : snapshot.smartFirstAt - position.signalAt;
      if (snapshot.smartWalletCount === position.smartWalletCount
        && snapshot.smartClusterCount === position.smartClusterCount) continue;
      Object.assign(position, snapshot);
      this._queuePosition('update', position);
      this.metrics.smartOpenLabels += 1;
    }
  }

  _countRejections(reasons) {
    for (const reason of reasons) {
      this.metrics.rejectionReasons[reason]
        = (this.metrics.rejectionReasons[reason] || 0) + 1;
    }
  }

  _positionKey(position) { return `${position.cohortId}:${position.episodeId}`; }

  _indexPosition(position) {
    const key = this._positionKey(position);
    const keys = this.positionKeysByMint.get(position.mint) || new Set();
    keys.add(key);
    this.positionKeysByMint.set(position.mint, keys);
  }

  _unindexPosition(position) {
    const key = this._positionKey(position);
    const keys = this.positionKeysByMint.get(position.mint);
    if (!keys) return;
    keys.delete(key);
    if (!keys.size) this.positionKeysByMint.delete(position.mint);
  }

  _indexLabelRow(position) {
    const rows = this.labelRowsByMint.get(position.mint) || [];
    if (!rows.some((row) => this._positionKey(row) === this._positionKey(position))) {
      rows.push(position);
    }
    this.labelRowsByMint.set(position.mint, rows);
  }

  _finishOpen(position) {
    this.openPositions.delete(this._positionKey(position));
    this._unindexPosition(position);
  }

  _restorePosition(row) {
    const position = this._rowToPosition(row);
    const key = this._positionKey(position);
    this._indexPosition(position);
    if (position.status === STATUS.PENDING_ENTRY) this.pendingEntries.set(key, position);
    else this.openPositions.set(key, position);
  }

  _rowToPosition(row) {
    const exitProfile = this.exitById.get(row.exit_profile_id) || {
      id: row.exit_profile_id,
      maxHoldMs: Math.max(1, finite(row.exit_trigger_at, row.entry_at)
        - finite(row.entry_at, 0)),
      hardStopPct: 15,
    };
    return {
      cohortId: row.cohort_id,
      entryProfileId: row.entry_profile_id,
      exitProfileId: row.exit_profile_id,
      exitProfile,
      episodeId: row.episode_id,
      mint: row.mint,
      symbol: row.symbol,
      status: row.status,
      rejectionReason: row.rejection_reason,
      triggerType: row.trigger_type,
      triggerWallet: row.trigger_wallet,
      positionSol: finite(row.position_sol),
      signalAt: finite(row.signal_at),
      signalMarket: row.signal_market,
      signalPrice: finite(row.signal_price),
      features: JSON.parse(row.features_json || '{}'),
      smartWalletCount: finite(row.smart_wallet_count, 0),
      smartClusterCount: finite(row.smart_cluster_count, 0),
      smartWallets: new Set(jsonArray(row.smart_wallets_json)),
      smartClusters: new Set(jsonArray(row.smart_clusters_json)),
      smartFirstAt: finite(row.smart_first_at),
      smartLastAt: finite(row.smart_last_at),
      smartFirstDelayMs: finite(row.smart_first_delay_ms),
      entryTargetAt: finite(row.entry_target_at),
      entryDeadlineAt: finite(row.entry_deadline_at),
      entryAt: finite(row.entry_at),
      entryMarket: row.entry_market,
      entryMarketPrice: finite(row.entry_market_price),
      entryPrice: finite(row.entry_price),
      entryJumpPct: finite(row.entry_jump_pct),
      entryImpactPct: finite(row.entry_impact_pct),
      tokenUnits: finite(row.token_units),
      highestReturnPct: finite(row.highest_return_pct),
      lowestReturnPct: finite(row.lowest_return_pct),
      lastMarket: row.last_market,
      lastMarketPrice: finite(row.last_market_price),
      exitTriggerAt: finite(row.exit_trigger_at),
      exitTargetAt: finite(row.exit_target_at),
      exitDeadlineAt: finite(row.exit_deadline_at),
      exitAt: finite(row.exit_at),
      exitMarket: row.exit_market,
      exitMarketPrice: finite(row.exit_market_price),
      exitPrice: finite(row.exit_price),
      exitImpactPct: finite(row.exit_impact_pct),
      exitReason: row.exit_reason,
      grossReturnPct: finite(row.gross_return_pct),
      netReturnPct: finite(row.net_return_pct),
      holdMs: finite(row.hold_ms),
    };
  }

  _queuePosition(type, position) {
    this.pendingWrites.push({ type, position });
  }

  _writeParams(position) {
    const features = position.features || {};
    return {
      ...position,
      configuredCostPct: this.costs.deterministicCostPct,
      ageMs: features.ageMs ?? null,
      curvePct: features.curvePct ?? null,
      pullbackPct: features.pullbackPct ?? null,
      reboundPct: features.reboundPct ?? null,
      selloffSellers: features.selloffSellers ?? null,
      selloffSellSol: features.selloffSellSol ?? null,
      selloffNetFlowSol: features.selloffNetFlowSol ?? null,
      netFlow3sSol: features.netFlow3sSol ?? null,
      netFlow5sSol: features.netFlow5sSol ?? null,
      netFlow10sSol: features.netFlow10sSol ?? null,
      buyers3s: features.buyers3s ?? null,
      top1BuyShare5sPct: features.top1BuyShare5sPct ?? null,
      observedHolders: features.observedHolders ?? null,
      first20RetentionPct: features.first20RetentionPct ?? null,
      top3InventoryPct: features.top3InventoryPct ?? null,
      creatorSell5s: features.creatorSell5s == null ? null : Number(features.creatorSell5s),
      historyComplete: features.historyComplete == null ? null : Number(features.historyComplete),
      featuresJson: JSON.stringify(features),
      smartWalletCount: position.smartWalletCount || 0,
      smartClusterCount: position.smartClusterCount || 0,
      smartWalletsJson: JSON.stringify([...position.smartWallets]),
      smartClustersJson: JSON.stringify([...position.smartClusters]),
      smartFirstAt: position.smartFirstAt ?? null,
      smartLastAt: position.smartLastAt ?? null,
      smartFirstDelayMs: position.smartFirstDelayMs ?? null,
      rejectionReason: position.rejectionReason ?? null,
      triggerWallet: position.triggerWallet ?? null,
      entryAt: position.entryAt ?? null,
      entryMarket: position.entryMarket ?? null,
      entryMarketPrice: position.entryMarketPrice ?? null,
      entryPrice: position.entryPrice ?? null,
      entryJumpPct: position.entryJumpPct ?? null,
      entryImpactPct: position.entryImpactPct ?? null,
      tokenUnits: position.tokenUnits ?? null,
      highestReturnPct: position.highestReturnPct ?? null,
      lowestReturnPct: position.lowestReturnPct ?? null,
      lastMarket: position.lastMarket ?? null,
      lastMarketPrice: position.lastMarketPrice ?? null,
      exitTriggerAt: position.exitTriggerAt ?? null,
      exitTargetAt: position.exitTargetAt ?? null,
      exitDeadlineAt: position.exitDeadlineAt ?? null,
      exitAt: position.exitAt ?? null,
      exitMarket: position.exitMarket ?? null,
      exitMarketPrice: position.exitMarketPrice ?? null,
      exitPrice: position.exitPrice ?? null,
      exitImpactPct: position.exitImpactPct ?? null,
      exitReason: position.exitReason ?? null,
      grossReturnPct: position.grossReturnPct ?? null,
      netReturnPct: position.netReturnPct ?? null,
      holdMs: position.holdMs ?? null,
      createdAt: position.signalAt,
      updatedAt: this.now(),
    };
  }

  _flushWrites() {
    if (!this.pendingWrites.length) return;
    const operations = this.pendingWrites.splice(0);
    const write = this.store.db.transaction((rows) => {
      for (const operation of rows) {
        if (operation.type === 'observation') {
          const result = this.insertObservation.run(operation.row);
          this.metrics.observationsWritten += result.changes;
        } else {
          const params = this._writeParams(operation.position);
          if (operation.type === 'insert') this.insertPosition.run(params);
          else this.updatePosition.run(params);
        }
      }
    });
    try {
      write(operations);
      this.metrics.flushes += 1;
    } catch (error) {
      this.pendingWrites.unshift(...operations);
      this.metrics.writeErrors += 1;
      console.error('[PublicFlowAbsorptionRecoveryShadow] write failed:', error.message);
    }
  }

  health() {
    const completeStates = [...this.states.values()]
      .filter((state) => state.historyComplete).length;
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_PUBLIC_FLOW_ABSORPTION_RECOVERY',
      code: 'PFAR-V1',
      sendsTransactions: false,
      changesLiveTrading: false,
      entryUsesSmartWallet: false,
      smartWalletRole: 'B_TAG_ONLY_AND_C_J36_CONTROL',
      trackedStates: this.states.size,
      completeHistoryStates: completeStates,
      activePositions: this.openPositions.size,
      pendingEntries: this.pendingEntries.size,
      pendingWrites: this.pendingWrites.length,
      positionSizeSol: this.config.positionSizeSol,
      entryDelayMs: this.config.entryDelayMs,
      maxEntryPriceJumpPct: this.config.maxEntryPriceJumpPct,
      maxEntryImpactPct: this.config.maxEntryImpactPct,
      entryProfiles: this.entryProfiles,
      exitProfiles: this.exitProfiles,
      ...this.metrics,
    };
  }

  dashboard({ positionLimit = 50, observationLimit = 50 } = {}) {
    this._flushWrites();
    const groupRows = this.store.db.prepare(`
      SELECT cohort_id, entry_profile_id, exit_profile_id,
        COUNT(*) signals, COUNT(DISTINCT mint) independent_mints,
        SUM(status='PENDING_ENTRY') pending_entry,
        SUM(status IN ('OPEN','EXIT_PENDING')) active,
        SUM(status='CLOSED') resolved,
        SUM(status='NO_ENTRY') no_entry,
        SUM(status='RUG_REJECTED') rug_rejected,
        SUM(status='NO_EXIT') no_exit,
        AVG(CASE WHEN status='CLOSED' THEN net_return_pct END) average_net_return_pct,
        AVG(CASE WHEN status='CLOSED' THEN net_return_pct>0 END)*100 win_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN net_return_pct>=20 END)*100 big20_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN net_return_pct>=50 END)*100 big50_rate_pct,
        MAX(CASE WHEN status='CLOSED' THEN net_return_pct END) max_winner_pct,
        AVG(pullback_pct) average_pullback_pct,
        AVG(rebound_pct) average_rebound_pct,
        AVG(net_flow_3s_sol) average_net_flow_3s_sol,
        AVG(observed_holders) average_observed_holders,
        AVG(first20_retention_pct) average_first20_retention_pct,
        AVG(top3_inventory_pct) average_top3_inventory_pct,
        AVG(entry_impact_pct) average_entry_impact_pct,
        AVG(smart_wallet_count) average_smart_wallet_count,
        AVG(smart_cluster_count) average_smart_cluster_count,
        AVG(smart_wallet_count>0)*100 smart_labeled_rate_pct
      FROM public_flow_absorption_recovery_shadow_positions
      GROUP BY cohort_id, entry_profile_id, exit_profile_id
      ORDER BY entry_profile_id, exit_profile_id
    `).all();
    const returnQuery = this.store.db.prepare(`
      SELECT net_return_pct FROM public_flow_absorption_recovery_shadow_positions
      WHERE cohort_id=? AND status='CLOSED' AND net_return_pct IS NOT NULL
      ORDER BY net_return_pct
    `);
    const cohorts = groupRows.map((row) => {
      const values = returnQuery.all(row.cohort_id)
        .map((item) => finite(item.net_return_pct)).filter(Number.isFinite);
      return {
        ...row,
        median_net_return_pct: percentile(values, 0.5),
        profit_factor: profitFactor(values),
      };
    });
    const positions = this.store.db.prepare(`
      SELECT * FROM public_flow_absorption_recovery_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') THEN 0 ELSE 1 END,
        updated_at DESC, id DESC LIMIT ?
    `).all(Math.min(200, Math.max(1, Math.trunc(positionLimit))));
    const observations = this.store.db.prepare(`
      SELECT * FROM public_flow_absorption_recovery_observations
      ORDER BY observed_at DESC, id DESC LIMIT ?
    `).all(Math.min(200, Math.max(1, Math.trunc(observationLimit))));
    const observationStats = this.store.db.prepare(`
      SELECT COUNT(*) observations, COUNT(DISTINCT mint) independent_mints,
        SUM(qualified) qualified,
        MAX(observed_at) latest_observed_at
      FROM public_flow_absorption_recovery_observations
    `).get();
    return {
      generatedAt: this.now(),
      runtime: this.health(),
      cohorts,
      positions,
      observations,
      observationStats,
    };
  }
}

module.exports = { PublicFlowAbsorptionRecoveryShadowSuite, STATUS, priceOf };
