'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const { evaluateUniversalRugGuard } = require('./UniversalRugGuard');

const STATUS = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  NO_ENTRY: 'NO_ENTRY',
  NO_EXIT: 'NO_EXIT',
  RUG_REJECTED: 'RUG_REJECTED',
});

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function priceOf(trade) {
  const reserve = finite(trade?.reservePrice);
  return reserve > 0 ? reserve : finite(trade?.price);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper
    ? ordered[lower]
    : ordered[lower] * (upper - position) + ordered[upper] * (position - lower);
}

function profitFactor(values) {
  const wins = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return losses > 0 ? wins / losses : (wins > 0 ? null : 0);
}

function quoteReserveSol(trade) {
  try {
    const quote = BigInt(trade?.poolQuoteReservesRaw || 0)
      + BigInt(trade?.virtualQuoteReservesRaw || 0);
    return quote > 0n ? Number(quote) / 1e9 : null;
  } catch (_) {
    return null;
  }
}

// PumpSwap events carry post-trade reserves. Reconstruct the immediately prior
// reserve price so the very first observed dump can be evaluated without
// waiting for another tick. The scale is SOL per token (9 versus 6 decimals).
function preSellReservePrice(trade) {
  if (trade?.market !== 'PUMP_AMM' || trade?.side !== 'SELL') return null;
  try {
    const baseAfter = BigInt(trade.poolBaseReservesRaw || 0);
    const quoteAfter = BigInt(trade.poolQuoteReservesRaw || 0)
      + BigInt(trade.virtualQuoteReservesRaw || 0);
    const tokenIn = BigInt(Math.max(0, Math.round(finite(trade.tokenAmount, 0) * 1e6)));
    const solOut = BigInt(Math.max(0, Math.round(finite(trade.solAmount, 0) * 1e9)));
    const baseBefore = baseAfter - tokenIn;
    const quoteBefore = quoteAfter + solOut;
    if (baseBefore <= 0n || quoteBefore <= 0n) return null;
    return (Number(quoteBefore) / 1e9) / (Number(baseBefore) / 1e6);
  } catch (_) {
    return null;
  }
}

class SameSlotDumpBackrunShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = config.entryProfiles || [];
    this.exitProfiles = config.exitProfiles || [];
    this.trackedUntil = new Map();
    this.marketState = new Map();
    this.openPositions = new Map();
    this.positionsByMint = new Map();
    this.episodesByMint = new Map();
    this.lastEpisodeAt = new Map();
    this.slotFirstSeenAt = new Map();
    this.pendingWrites = [];
    this.metrics = {
      observedTrades: 0,
      observedSells: 0,
      qualifiedDumps: 0,
      simulatedEntries: 0,
      rugGuardRejected: 0,
      capacityRejected: 0,
      firstBuyObserved: 0,
      firstBuySameSlot: 0,
      closed: 0,
      noExit: 0,
      flushes: 0,
      writeErrors: 0,
      hotPathLastUs: 0,
      hotPathMaxUs: 0,
      lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS same_slot_dump_backrun_shadow_positions (
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
        signal_slot INTEGER,
        signal_signature TEXT,
        signal_event_index INTEGER,
        sell_wallet TEXT,
        sell_sol REAL,
        pre_price REAL,
        post_dump_price REAL,
        drop_pct REAL,
        quote_reserve_sol REAL,
        sell_to_quote_pct REAL,
        observer_latency_ms REAL,
        slot_observed_elapsed_ms REAL,
        rug_guard_json TEXT,
        entry_at INTEGER,
        entry_slot INTEGER,
        entry_price REAL,
        entry_market_price REAL,
        entry_impact_pct REAL,
        token_units REAL,
        first_buy_at INTEGER,
        first_buy_delay_ms INTEGER,
        first_buy_slot INTEGER,
        first_buy_same_slot INTEGER,
        first_buy_sol REAL,
        first_buy_wallet TEXT,
        first_buy_signature TEXT,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_slot INTEGER,
        exit_price REAL,
        exit_market_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        hold_ms INTEGER,
        same_slot_exit INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(cohort_id, episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_same_slot_dump_status
        ON same_slot_dump_backrun_shadow_positions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_same_slot_dump_mint
        ON same_slot_dump_backrun_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_same_slot_dump_profiles
        ON same_slot_dump_backrun_shadow_positions(entry_profile_id, exit_profile_id);
    `);
    this.insert = this.store.db.prepare(`
      INSERT OR IGNORE INTO same_slot_dump_backrun_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id, mint, symbol,
        status, rejection_reason, position_sol, configured_cost_pct,
        signal_at, signal_slot, signal_signature, signal_event_index,
        sell_wallet, sell_sol, pre_price, post_dump_price, drop_pct,
        quote_reserve_sol, sell_to_quote_pct, observer_latency_ms,
        slot_observed_elapsed_ms, rug_guard_json,
        entry_at, entry_slot, entry_price, entry_market_price, entry_impact_pct,
        token_units, max_favorable_return_pct, max_adverse_return_pct,
        exit_target_at, exit_deadline_at, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId, @mint, @symbol,
        @status, @rejectionReason, @positionSol, @configuredCostPct,
        @signalAt, @signalSlot, @signalSignature, @signalEventIndex,
        @sellWallet, @sellSol, @prePrice, @postDumpPrice, @dropPct,
        @quoteReserveSol, @sellToQuotePct, @observerLatencyMs,
        @slotObservedElapsedMs, @rugGuardJson,
        @entryAt, @entrySlot, @entryPrice, @entryMarketPrice, @entryImpactPct,
        @tokenUnits, @maxFavorableReturnPct, @maxAdverseReturnPct,
        @exitTargetAt, @exitDeadlineAt, @createdAt, @updatedAt
      )
    `);
    this.update = this.store.db.prepare(`
      UPDATE same_slot_dump_backrun_shadow_positions SET
        status=COALESCE(@status,status),
        rejection_reason=COALESCE(@rejectionReason,rejection_reason),
        first_buy_at=COALESCE(@firstBuyAt,first_buy_at),
        first_buy_delay_ms=COALESCE(@firstBuyDelayMs,first_buy_delay_ms),
        first_buy_slot=COALESCE(@firstBuySlot,first_buy_slot),
        first_buy_same_slot=COALESCE(@firstBuySameSlot,first_buy_same_slot),
        first_buy_sol=COALESCE(@firstBuySol,first_buy_sol),
        first_buy_wallet=COALESCE(@firstBuyWallet,first_buy_wallet),
        first_buy_signature=COALESCE(@firstBuySignature,first_buy_signature),
        max_favorable_return_pct=COALESCE(@maxFavorableReturnPct,max_favorable_return_pct),
        max_adverse_return_pct=COALESCE(@maxAdverseReturnPct,max_adverse_return_pct),
        exit_at=COALESCE(@exitAt,exit_at),
        exit_slot=COALESCE(@exitSlot,exit_slot),
        exit_price=COALESCE(@exitPrice,exit_price),
        exit_market_price=COALESCE(@exitMarketPrice,exit_market_price),
        exit_impact_pct=COALESCE(@exitImpactPct,exit_impact_pct),
        exit_reason=COALESCE(@exitReason,exit_reason),
        gross_return_pct=COALESCE(@grossReturnPct,gross_return_pct),
        net_return_pct=COALESCE(@netReturnPct,net_return_pct),
        hold_ms=COALESCE(@holdMs,hold_ms),
        same_slot_exit=COALESCE(@sameSlotExit,same_slot_exit),
        updated_at=@updatedAt
      WHERE cohort_id=@cohortId AND episode_id=@episodeId
    `);
    this.active = this.store.db.prepare(`
      SELECT * FROM same_slot_dump_backrun_shadow_positions
      WHERE status='OPEN' ORDER BY signal_at, id
    `);
  }

  start() {
    if (!this.config.enabled) return;
    for (const row of this.active.all()) {
      const position = this._positionFromRow(row);
      this._indexPosition(position);
    }
  }

  stop() {
    this._flushWrites();
  }

  onGraduated(token = {}) {
    if (!this.config.enabled || !token.mint) return;
    const startedAt = finite(
      token.migratedAt ?? token.completedAt ?? token.graduatedAt
        ?? token.migrated_at ?? token.completed_at ?? token.graduated_at ?? token.timestampMs,
      this.now(),
    );
    this.trackedUntil.set(token.mint, startedAt + this.config.trackingAgeMs);
  }

  trackedMints(now = this.now()) {
    const result = [];
    for (const [mint, expiry] of this.trackedUntil) {
      if (expiry >= now) result.push(mint);
      else this.trackedUntil.delete(mint);
    }
    return result;
  }

  observeTrade(trade) {
    const started = process.hrtime.bigint();
    try {
      if (!this.config.enabled || trade?.market !== 'PUMP_AMM' || !trade.mint) return [];
      const timestampMs = finite(trade.timestampMs ?? trade.receivedAtMs, this.now());
      if (!this.trackedUntil.has(trade.mint) && !this.positionsByMint.has(trade.mint)) return [];
      this.metrics.observedTrades += 1;
      const slot = finite(trade.slot);
      if (slot != null && !this.slotFirstSeenAt.has(slot)) this.slotFirstSeenAt.set(slot, timestampMs);

      this._labelFirstBuy(trade, timestampMs);
      this._observeOpenPositions(trade, timestampMs);

      const state = this.marketState.get(trade.mint) || { lastPrice: null, lastAt: null };
      const postPrice = priceOf(trade);
      let signals = [];
      if (trade.side === 'SELL' && finite(trade.solAmount, 0) > 0 && postPrice > 0) {
        this.metrics.observedSells += 1;
        const lastFresh = state.lastPrice > 0 && timestampMs - finite(state.lastAt, 0) <= 5_000;
        const prePrice = lastFresh ? state.lastPrice : preSellReservePrice(trade);
        if (prePrice > postPrice) signals = this._observeDump(trade, timestampMs, prePrice, postPrice);
      }
      state.lastPrice = postPrice || state.lastPrice;
      state.lastAt = timestampMs;
      this.marketState.set(trade.mint, state);
      return signals;
    } finally {
      const elapsedUs = Number(process.hrtime.bigint() - started) / 1_000;
      this.metrics.hotPathLastUs = elapsedUs;
      this.metrics.hotPathMaxUs = Math.max(this.metrics.hotPathMaxUs, elapsedUs);
    }
  }

  _observeDump(trade, timestampMs, prePrice, postPrice) {
    const dropPct = (1 - postPrice / prePrice) * 100;
    const sellSol = finite(trade.solAmount, 0);
    const reserveSol = quoteReserveSol(trade);
    const episodeId = `${trade.mint}:${trade.signature || timestampMs}:${trade.eventIndex || 0}`;
    const slotFirst = this.slotFirstSeenAt.get(finite(trade.slot));
    const matched = [];
    for (const entry of this.entryProfiles) {
      if (sellSol < entry.minSellSol || dropPct < entry.minDropPct || dropPct > entry.maxDropPct) continue;
      if (reserveSol != null && reserveSol < entry.minQuoteReserveSol) continue;
      const cooldownKey = `${trade.mint}:${entry.id}`;
      if (timestampMs - (this.lastEpisodeAt.get(cooldownKey) || 0) < this.config.episodeCooldownMs) continue;
      this.lastEpisodeAt.set(cooldownKey, timestampMs);
      this.metrics.qualifiedDumps += 1;
      const rug = evaluateUniversalRugGuard(this.store, {
        strategyId: `SDBR-${entry.id}`,
        mint: trade.mint,
        timestampMs,
        source: 'SHADOW',
      });
      const buy = executableBuy(trade, this.config.positionSizeSol, postPrice);
      const rejected = rug.blocked || !buy.available
        || finite(buy.impactPct, Infinity) > entry.maxEntryImpactPct;
      const rejectionReason = rug.blocked
        ? (rug.reason || 'RUG_GUARD')
        : (!buy.available ? buy.reason : (rejected ? 'ENTRY_CAPACITY_IMPACT' : null));
      if (rug.blocked) this.metrics.rugGuardRejected += 1;
      else if (rejected) this.metrics.capacityRejected += 1;

      const episodeRows = this.episodesByMint.get(trade.mint) || [];
      for (const exit of this.exitProfiles) {
        const cohortId = `${entry.id}/${exit.id}`;
        const row = {
          cohortId,
          entryProfileId: entry.id,
          exitProfileId: exit.id,
          exitProfile: exit,
          episodeId,
          mint: trade.mint,
          symbol: trade.symbol || null,
          status: rejected ? (rug.blocked ? STATUS.RUG_REJECTED : STATUS.NO_ENTRY) : STATUS.OPEN,
          rejectionReason,
          positionSol: this.config.positionSizeSol,
          signalAt: timestampMs,
          signalSlot: finite(trade.slot),
          signalSignature: trade.signature || null,
          signalEventIndex: finite(trade.eventIndex, 0),
          sellWallet: trade.wallet || null,
          sellSol,
          prePrice,
          postDumpPrice: postPrice,
          dropPct,
          quoteReserveSol: reserveSol,
          sellToQuotePct: reserveSol > 0 ? sellSol / reserveSol * 100 : null,
          observerLatencyMs: Math.max(0, finite(trade.receivedAtMs, timestampMs) - finite(trade.chainTimestampMs, timestampMs)),
          slotObservedElapsedMs: slotFirst == null ? null : Math.max(0, timestampMs - slotFirst),
          rugGuardJson: JSON.stringify(rug),
          entryAt: rejected ? null : timestampMs,
          entrySlot: rejected ? null : finite(trade.slot),
          entryPrice: rejected ? null : buy.price,
          entryMarketPrice: rejected ? null : postPrice,
          entryImpactPct: rejected ? null : buy.impactPct,
          tokenUnits: rejected ? null : buy.tokenUnits,
          maxFavorableReturnPct: rejected ? null : 0,
          maxAdverseReturnPct: rejected ? null : 0,
          exitTargetAt: rejected ? null : timestampMs + (exit.holdMs || exit.maxHoldMs),
          exitDeadlineAt: rejected ? null : timestampMs + (exit.holdMs || exit.maxHoldMs) + this.config.exitGraceMs,
        };
        this._queueInsert(row);
        episodeRows.push(row);
        if (!rejected) {
          this._indexPosition(row);
          this.metrics.simulatedEntries += 1;
        }
      }
      // Keep the configured number of episodes, not merely that many cohort
      // rows. Each episode expands into one row per exit profile.
      const retainedRows = this.config.maxEpisodesPerMint * Math.max(1, this.exitProfiles.length);
      this.episodesByMint.set(trade.mint, episodeRows.slice(-retainedRows));
      matched.push({ entryProfileId: entry.id, episodeId, mint: trade.mint, dropPct, sellSol });
    }
    if (matched.length) this.metrics.lastActionAt = timestampMs;
    return matched;
  }

  _labelFirstBuy(trade, timestampMs) {
    if (trade.side !== 'BUY') return;
    const rows = this.episodesByMint.get(trade.mint);
    if (!rows?.length) return;
    const byEpisode = new Map();
    for (const row of rows) {
      if (row.firstBuyAt != null || timestampMs < row.signalAt
        || trade.signature === row.signalSignature || trade.wallet === row.sellWallet) continue;
      byEpisode.set(row.episodeId, row);
    }
    for (const sample of byEpisode.values()) {
      const sameSlot = sample.signalSlot != null && finite(trade.slot) === sample.signalSlot;
      this.metrics.firstBuyObserved += 1;
      if (sameSlot) this.metrics.firstBuySameSlot += 1;
      for (const row of rows) {
        if (row.episodeId !== sample.episodeId || row.firstBuyAt != null) continue;
        Object.assign(row, {
          firstBuyAt: timestampMs,
          firstBuyDelayMs: timestampMs - row.signalAt,
          firstBuySlot: finite(trade.slot),
          firstBuySameSlot: sameSlot ? 1 : 0,
          firstBuySol: finite(trade.solAmount),
          firstBuyWallet: trade.wallet || null,
          firstBuySignature: trade.signature || null,
        });
        this._queueUpdate(row);
      }
    }
  }

  _observeOpenPositions(trade, timestampMs) {
    const keys = this.positionsByMint.get(trade.mint);
    if (!keys?.size) return;
    const marketPrice = priceOf(trade);
    if (!(marketPrice > 0)) return;
    for (const key of [...keys]) {
      const position = this.openPositions.get(key);
      if (!position || timestampMs <= position.signalAt) continue;
      const markReturnPct = (marketPrice / position.entryPrice - 1) * 100;
      const sell = executableSell(trade, position.tokenUnits, marketPrice, { rugMarkReturnPct: markReturnPct });
      const executableReturnPct = sell.price == null ? null : (sell.price / position.entryPrice - 1) * 100;
      if (executableReturnPct != null) {
        position.maxFavorableReturnPct = Math.max(position.maxFavorableReturnPct ?? 0, executableReturnPct);
        position.maxAdverseReturnPct = Math.min(position.maxAdverseReturnPct ?? 0, executableReturnPct);
      }
      const takeProfit = position.exitProfile.kind === 'TAKE_OR_FIXED'
        && executableReturnPct != null
        && executableReturnPct >= position.exitProfile.takeProfitPct;
      if (takeProfit || timestampMs >= position.exitTargetAt) {
        this._close(position, trade, timestampMs, sell, takeProfit ? 'TAKE_PROFIT' : 'FIXED_HOLD');
      }
    }
  }

  _close(position, trade, timestampMs, sell, reason) {
    if (sell.price == null) return;
    const grossReturnPct = (sell.price / position.entryPrice - 1) * 100;
    position.status = STATUS.CLOSED;
    position.exitAt = timestampMs;
    position.exitSlot = finite(trade.slot);
    position.exitPrice = sell.price;
    position.exitMarketPrice = sell.marketPrice;
    position.exitImpactPct = sell.impactPct;
    position.exitReason = reason;
    position.grossReturnPct = grossReturnPct;
    position.netReturnPct = grossReturnPct - this.costs.deterministicCostPct;
    position.holdMs = timestampMs - position.entryAt;
    position.sameSlotExit = position.signalSlot != null && position.exitSlot === position.signalSlot ? 1 : 0;
    this._queueUpdate(position);
    this._unindexPosition(position);
    this.metrics.closed += 1;
    this.metrics.lastActionAt = timestampMs;
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const position of [...this.openPositions.values()]) {
      if (now <= position.exitDeadlineAt) continue;
      position.status = STATUS.NO_EXIT;
      position.exitReason = 'NO_CAUSAL_EXIT_TRADE';
      this._queueUpdate(position);
      this._unindexPosition(position);
      this.metrics.noExit += 1;
    }
    for (const [mint, rows] of this.episodesByMint) {
      const kept = rows.filter((row) => now - row.signalAt <= this.config.stateRetentionMs);
      if (kept.length) this.episodesByMint.set(mint, kept);
      else this.episodesByMint.delete(mint);
    }
    for (const [slot, firstAt] of this.slotFirstSeenAt) {
      if (now - firstAt > this.config.stateRetentionMs) this.slotFirstSeenAt.delete(slot);
    }
    for (const [mint, state] of this.marketState) {
      if (now - finite(state.lastAt, 0) > this.config.stateRetentionMs) this.marketState.delete(mint);
    }
    this.trackedMints(now);
    this._flushWrites();
  }

  _positionFromRow(row) {
    const exitProfile = this.exitProfiles.find((profile) => profile.id === row.exit_profile_id) || {
      id: row.exit_profile_id,
      kind: 'FIXED',
      holdMs: Math.max(0, finite(row.exit_target_at, 0) - finite(row.entry_at, 0)),
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
      positionSol: finite(row.position_sol),
      signalAt: finite(row.signal_at),
      signalSlot: finite(row.signal_slot),
      entryAt: finite(row.entry_at),
      entryPrice: finite(row.entry_price),
      tokenUnits: finite(row.token_units),
      maxFavorableReturnPct: finite(row.max_favorable_return_pct, 0),
      maxAdverseReturnPct: finite(row.max_adverse_return_pct, 0),
      exitTargetAt: finite(row.exit_target_at),
      exitDeadlineAt: finite(row.exit_deadline_at),
    };
  }

  _indexPosition(position) {
    const key = `${position.cohortId}:${position.episodeId}`;
    this.openPositions.set(key, position);
    const keys = this.positionsByMint.get(position.mint) || new Set();
    keys.add(key);
    this.positionsByMint.set(position.mint, keys);
  }

  _unindexPosition(position) {
    const key = `${position.cohortId}:${position.episodeId}`;
    this.openPositions.delete(key);
    const keys = this.positionsByMint.get(position.mint);
    if (!keys) return;
    keys.delete(key);
    if (!keys.size) this.positionsByMint.delete(position.mint);
  }

  _queueInsert(position) {
    this.pendingWrites.push({ type: 'insert', position });
  }

  _queueUpdate(position) {
    this.pendingWrites.push({ type: 'update', position });
  }

  _writeParams(position) {
    return {
      ...position,
      configuredCostPct: this.costs.deterministicCostPct,
      firstBuyAt: position.firstBuyAt ?? null,
      firstBuyDelayMs: position.firstBuyDelayMs ?? null,
      firstBuySlot: position.firstBuySlot ?? null,
      firstBuySameSlot: position.firstBuySameSlot ?? null,
      firstBuySol: position.firstBuySol ?? null,
      firstBuyWallet: position.firstBuyWallet ?? null,
      firstBuySignature: position.firstBuySignature ?? null,
      exitAt: position.exitAt ?? null,
      exitSlot: position.exitSlot ?? null,
      exitPrice: position.exitPrice ?? null,
      exitMarketPrice: position.exitMarketPrice ?? null,
      exitImpactPct: position.exitImpactPct ?? null,
      exitReason: position.exitReason ?? null,
      grossReturnPct: position.grossReturnPct ?? null,
      netReturnPct: position.netReturnPct ?? null,
      holdMs: position.holdMs ?? null,
      sameSlotExit: position.sameSlotExit ?? null,
      rejectionReason: position.rejectionReason ?? null,
      createdAt: position.signalAt,
      updatedAt: position.exitAt || position.firstBuyAt || position.signalAt,
    };
  }

  _flushWrites() {
    if (!this.pendingWrites.length) return;
    const writes = this.pendingWrites.splice(0);
    const transaction = this.store.db.transaction((operations) => {
      for (const operation of operations) {
        const params = this._writeParams(operation.position);
        if (operation.type === 'insert') this.insert.run(params);
        else this.update.run(params);
      }
    });
    try {
      transaction(writes);
      this.metrics.flushes += 1;
    } catch (error) {
      this.metrics.writeErrors += 1;
      console.error('[SameSlotDumpBackrunShadow] write failed:', error.message);
    }
  }

  dashboard({ positionLimit = 50 } = {}) {
    this._flushWrites();
    const rows = this.store.db.prepare(`
      SELECT * FROM same_slot_dump_backrun_shadow_positions ORDER BY signal_at DESC, id DESC
    `).all();
    const groups = new Map();
    for (const row of rows) {
      const group = groups.get(row.cohort_id) || [];
      group.push(row);
      groups.set(row.cohort_id, group);
    }
    const cohorts = [...groups.entries()].map(([cohortId, group]) => {
      const resolved = group.filter((row) => row.status === STATUS.CLOSED);
      const returns = resolved.map((row) => finite(row.net_return_pct)).filter(Number.isFinite);
      const episodes = new Map(group.map((row) => [row.episode_id, row]));
      const labeled = [...episodes.values()].filter((row) => row.first_buy_at != null);
      return {
        cohort_id: cohortId,
        entry_profile_id: group[0]?.entry_profile_id,
        exit_profile_id: group[0]?.exit_profile_id,
        signals: episodes.size,
        open: group.filter((row) => row.status === STATUS.OPEN).length,
        resolved: resolved.length,
        no_entry: group.filter((row) => row.status === STATUS.NO_ENTRY).length,
        rug_rejected: group.filter((row) => row.status === STATUS.RUG_REJECTED).length,
        no_exit: group.filter((row) => row.status === STATUS.NO_EXIT).length,
        win_rate_pct: returns.length ? returns.filter((value) => value > 0).length / returns.length * 100 : null,
        average_net_return_pct: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
        median_net_return_pct: percentile(returns, 0.5),
        profit_factor: profitFactor(returns),
        max_winner_pct: returns.length ? Math.max(...returns) : null,
        same_slot_exit_rate_pct: resolved.length
          ? resolved.filter((row) => row.same_slot_exit === 1).length / resolved.length * 100
          : null,
        same_slot_first_buy_rate_pct: labeled.length
          ? labeled.filter((row) => row.first_buy_same_slot === 1).length / labeled.length * 100
          : null,
        average_first_buy_delay_ms: labeled.length
          ? labeled.reduce((sum, row) => sum + finite(row.first_buy_delay_ms, 0), 0) / labeled.length
          : null,
        average_drop_pct: group.length
          ? group.reduce((sum, row) => sum + finite(row.drop_pct, 0), 0) / group.length
          : null,
        average_entry_impact_pct: group.length
          ? group.reduce((sum, row) => sum + finite(row.entry_impact_pct, 0), 0) / group.length
          : null,
      };
    });
    return {
      generatedAt: this.now(),
      runtime: this.health(),
      cohorts,
      positions: rows.slice(0, Math.max(1, Math.trunc(positionLimit))),
    };
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SAME_SLOT_DUMP_BACKRUN',
      code: 'SDBR',
      sendsTransactions: false,
      addsRpcRequests: false,
      changesLiveTrading: false,
      trackedMints: this.trackedUntil.size,
      activePositions: this.openPositions.size,
      pendingWrites: this.pendingWrites.length,
      entryProfiles: this.entryProfiles.map((profile) => profile.id),
      exitProfiles: this.exitProfiles.map((profile) => profile.id),
      ...this.metrics,
    };
  }
}

module.exports = { SameSlotDumpBackrunShadowSuite, STATUS };
