'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const { tradePrice } = require('./PreEntryRugRiskTracker');

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

class SmartWalletRugEscapeShadowSuite {
  constructor({ config, store, rugRiskTracker = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.rugRiskTracker = rugRiskTracker;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.episodesByMint = new Map();
    this.episodes = new Map();
    this.metrics = {
      smartEvents: 0,
      firstOpens: 0,
      ignoredAdds: 0,
      rowsCreated: 0,
      guardBlocked: 0,
      entries: 0,
      emergencyTriggers: 0,
      closes: 0,
      noExits: 0,
      futureRugs: 0,
      lastActionAt: null,
      lastError: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS smart_wallet_rug_escape_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        smart_event_id INTEGER NOT NULL,
        smart_wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        market TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        position_sol REAL NOT NULL,
        configured_cost_pct REAL NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_price REAL NOT NULL,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_price REAL,
        entry_impact_pct REAL,
        token_units REAL,
        highest_price REAL,
        lowest_price REAL,
        pre_entry_risk_json TEXT,
        synthetic_score INTEGER NOT NULL DEFAULT 0,
        synthetic_flagged INTEGER NOT NULL DEFAULT 0,
        synthetic_reasons_json TEXT NOT NULL DEFAULT '[]',
        emergency_trigger_at INTEGER,
        emergency_reason TEXT,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        rug50_at INTEGER,
        rug70_at INTEGER,
        escaped_before_rug INTEGER,
        caught_rug INTEGER,
        guard_avoided_rug INTEGER,
        label_status TEXT NOT NULL DEFAULT 'PENDING',
        label_deadline_at INTEGER NOT NULL,
        observed_buyers INTEGER NOT NULL DEFAULT 0,
        observed_buy_flow_sol REAL NOT NULL DEFAULT 0,
        observed_sell_flow_sol REAL NOT NULL DEFAULT 0,
        peak_sell_sol REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(smart_event_id, cohort_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sw_rug_escape_mint_time
        ON smart_wallet_rug_escape_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sw_rug_escape_cohort_label
        ON smart_wallet_rug_escape_shadow_positions(cohort_id, label_status, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sw_rug_escape_wallet_time
        ON smart_wallet_rug_escape_shadow_positions(smart_wallet, signal_at DESC);
    `);
    this.insertRow = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_rug_escape_shadow_positions (
        cohort_id, episode_id, smart_event_id, smart_wallet, mint, symbol, market,
        status, rejection_reason, position_sol, configured_cost_pct,
        signal_at, signal_price, entry_target_at, entry_deadline_at,
        pre_entry_risk_json, synthetic_score, synthetic_flagged, synthetic_reasons_json,
        label_deadline_at, created_at, updated_at
      ) VALUES (
        @cohortId, @episodeId, @smartEventId, @smartWallet, @mint, @symbol, @market,
        @status, @rejectionReason, @positionSol, @configuredCostPct,
        @signalAt, @signalPrice, @entryTargetAt, @entryDeadlineAt,
        @preEntryRiskJson, @syntheticScore, @syntheticFlagged, @syntheticReasonsJson,
        @labelDeadlineAt, @createdAt, @updatedAt
      )
    `);
    this.updateRow = this.store.db.prepare(`
      UPDATE smart_wallet_rug_escape_shadow_positions SET
        status=@status, rejection_reason=@rejectionReason,
        entry_at=@entryAt, entry_price=@entryPrice, entry_impact_pct=@entryImpactPct,
        token_units=@tokenUnits, highest_price=@highestPrice, lowest_price=@lowestPrice,
        emergency_trigger_at=@emergencyTriggerAt, emergency_reason=@emergencyReason,
        exit_target_at=@exitTargetAt, exit_deadline_at=@exitDeadlineAt,
        exit_at=@exitAt, exit_price=@exitPrice, exit_impact_pct=@exitImpactPct,
        exit_reason=@exitReason, gross_return_pct=@grossReturnPct,
        net_return_pct=@netReturnPct, rug50_at=@rug50At, rug70_at=@rug70At,
        escaped_before_rug=@escapedBeforeRug, caught_rug=@caughtRug,
        guard_avoided_rug=@guardAvoidedRug, label_status=@labelStatus,
        observed_buyers=@observedBuyers, observed_buy_flow_sol=@observedBuyFlowSol,
        observed_sell_flow_sol=@observedSellFlowSol, peak_sell_sol=@peakSellSol,
        updated_at=@updatedAt
      WHERE id=@id
    `);
    this.getInserted = this.store.db.prepare(`
      SELECT * FROM smart_wallet_rug_escape_shadow_positions
      WHERE smart_event_id=? AND cohort_id=?
    `);
  }

  start() {
    if (!this.config.enabled) return;
    // This is deliberately forward-only. A restart cannot reconstruct the exact
    // sub-second flow tape, so unfinished rows are censored rather than assigned
    // a fictitious loss or replayed against future-known data.
    const now = this.now();
    this.store.db.prepare(`
      UPDATE smart_wallet_rug_escape_shadow_positions
      SET status='CENSORED_RESTART', label_status='CENSORED',
          rejection_reason=COALESCE(rejection_reason, 'PROCESS_RESTART'), updated_at=?
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') OR label_status='PENDING'
    `).run(now);
  }

  stop() {
    this.episodes.clear();
    this.episodesByMint.clear();
  }

  trackedMints() {
    return [...this.episodesByMint.keys()];
  }

  onSmartWalletEvent(event) {
    if (!this.config.enabled || !event?.mint) return;
    this.metrics.smartEvents += 1;
    const phase = String(event.positionPhase || event.position_phase || '').toUpperCase();
    if (String(event.side || '').toUpperCase() !== 'BUY' || phase !== 'OPEN') {
      if (phase === 'ADD') this.metrics.ignoredAdds += 1;
      return;
    }
    const signalAt = finite(event.timestampMs ?? event.timestamp_ms);
    const signalPrice = tradePrice(event);
    if (!(signalAt > 0) || !(signalPrice > 0) || !event.wallet || !event.id) return;
    const episodeId = `SWRE:${event.id}`;
    if (this.episodes.has(episodeId)) return;
    const risk = this.rugRiskTracker?.snapshot(event.mint, signalAt) || {};
    const synthetic = this._syntheticAssessment(risk);
    const episode = {
      id: episodeId,
      smartEventId: Number(event.id),
      smartWallet: event.wallet,
      mint: event.mint,
      symbol: event.symbol || null,
      market: event.market || null,
      signalAt,
      signalPrice,
      labelDeadlineAt: signalAt + this.config.labelHorizonMs,
      finalizeAt: signalAt + this.config.labelHorizonMs
        + this.config.entryTimeoutMs + this.config.exitTimeoutMs,
      rows: [],
      events: [],
      buyers: new Set(),
      lastNewBuyerAt: signalAt,
      buyFlowSol: 0,
      sellFlowSol: 0,
      peakSellSol: 0,
      finalized: false,
    };
    for (const profile of this.config.profiles) {
      const blocked = Boolean(profile.syntheticGuard && synthetic.flagged);
      const row = {
        id: null,
        profile,
        cohortId: profile.id,
        episodeId,
        smartEventId: episode.smartEventId,
        smartWallet: event.wallet,
        mint: event.mint,
        symbol: event.symbol || null,
        market: event.market || null,
        status: blocked ? 'NO_ENTRY' : 'PENDING_ENTRY',
        rejectionReason: blocked ? 'SYNTHETIC_RAMP_GUARD' : null,
        positionSol: this.config.positionSizeSol,
        configuredCostPct: this.costs.deterministicCostPct,
        signalAt,
        signalPrice,
        entryTargetAt: blocked ? null : signalAt + this.config.entryDelayMs,
        entryDeadlineAt: blocked ? null : signalAt + this.config.entryTimeoutMs,
        entryAt: null,
        entryPrice: null,
        entryImpactPct: null,
        tokenUnits: null,
        highestPrice: null,
        lowestPrice: null,
        preEntryRiskJson: json(risk),
        syntheticScore: synthetic.score,
        syntheticFlagged: Number(synthetic.flagged),
        syntheticReasonsJson: json(synthetic.reasons),
        emergencyTriggerAt: null,
        emergencyReason: null,
        exitTargetAt: null,
        exitDeadlineAt: null,
        exitAt: null,
        exitPrice: null,
        exitImpactPct: null,
        exitReason: null,
        grossReturnPct: null,
        netReturnPct: null,
        rug50At: null,
        rug70At: null,
        escapedBeforeRug: null,
        caughtRug: null,
        guardAvoidedRug: null,
        labelStatus: 'PENDING',
        labelDeadlineAt: episode.labelDeadlineAt,
        observedBuyers: 0,
        observedBuyFlowSol: 0,
        observedSellFlowSol: 0,
        peakSellSol: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      const result = this.insertRow.run(row);
      const saved = result.changes > 0
        ? this.getInserted.get(row.smartEventId, row.cohortId) : null;
      if (!saved) continue;
      row.id = saved.id;
      episode.rows.push(row);
      this.metrics.rowsCreated += 1;
      if (blocked) this.metrics.guardBlocked += 1;
    }
    if (!episode.rows.length) return;
    this.episodes.set(episodeId, episode);
    const bucket = this.episodesByMint.get(event.mint) || new Set();
    bucket.add(episodeId);
    this.episodesByMint.set(event.mint, bucket);
    this.metrics.firstOpens += 1;
    this.metrics.lastActionAt = this.now();
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint) return;
    const episodeIds = this.episodesByMint.get(trade.mint);
    if (!episodeIds?.size) return;
    const timestampMs = finite(trade.timestampMs);
    const markPrice = tradePrice(trade);
    if (!(timestampMs > 0) || !(markPrice > 0)) return;
    for (const episodeId of [...episodeIds]) {
      const episode = this.episodes.get(episodeId);
      if (!episode || episode.finalized || timestampMs < episode.signalAt) continue;
      if (episode.market && trade.market && episode.market !== trade.market) continue;
      this._observeEpisode(episode, trade, timestampMs, markPrice);
    }
  }

  _observeEpisode(episode, trade, timestampMs, markPrice) {
    const sol = Math.max(0, finite(trade.solAmount, 0));
    const side = String(trade.side || '').toUpperCase();
    episode.events.push({ timestampMs, side, sol, wallet: String(trade.wallet || ''), markPrice });
    const cutoff = timestampMs - Math.max(this.config.labelHorizonMs, 60_000);
    while (episode.events.length && episode.events[0].timestampMs < cutoff) episode.events.shift();
    if (side === 'BUY') {
      episode.buyFlowSol += sol;
      if (trade.wallet && !episode.buyers.has(trade.wallet)) {
        episode.buyers.add(trade.wallet);
        episode.lastNewBuyerAt = timestampMs;
      }
    } else if (side === 'SELL') {
      episode.sellFlowSol += sol;
      episode.peakSellSol = Math.max(episode.peakSellSol, sol);
    }

    for (const row of episode.rows) {
      if (row.status === 'PENDING_ENTRY') this._tryEntry(row, trade, timestampMs, markPrice);
      if (timestampMs <= episode.labelDeadlineAt && row.entryPrice > 0) {
        row.highestPrice = Math.max(row.highestPrice || row.entryPrice, markPrice);
        row.lowestPrice = Math.min(row.lowestPrice || row.entryPrice, markPrice);
        const markReturnPct = ((markPrice / row.entryPrice) - 1) * 100;
        if (row.rug50At == null && markReturnPct <= -this.config.rug50Pct) {
          row.rug50At = timestampMs;
        }
        if (row.rug70At == null && markReturnPct <= -this.config.rug70Pct) {
          row.rug70At = timestampMs;
        }
      } else if (timestampMs <= episode.labelDeadlineAt && row.status === 'NO_ENTRY') {
        const signalReturnPct = ((markPrice / row.signalPrice) - 1) * 100;
        if (row.rug50At == null && signalReturnPct <= -this.config.rug50Pct) row.rug50At = timestampMs;
        if (row.rug70At == null && signalReturnPct <= -this.config.rug70Pct) row.rug70At = timestampMs;
      }

      if (row.status === 'OPEN') {
        const elapsedMs = timestampMs - row.entryAt;
        if (row.profile.emergencyExit && elapsedMs <= this.config.emergencyWindowMs) {
          const reason = this._emergencyReason(episode, trade, timestampMs, row);
          if (reason) this._requestExit(row, timestampMs, reason);
        }
        if (row.status === 'OPEN' && timestampMs >= row.entryAt + row.profile.holdMs) {
          this._requestExit(row, timestampMs, `FIXED_HOLD_${row.profile.holdMs}MS`);
        }
      }
      if (row.status === 'EXIT_PENDING') this._tryExit(row, trade, timestampMs, markPrice);
      this._syncObserved(row, episode);
      this._save(row);
    }
    if (timestampMs >= episode.finalizeAt) this._finalizeEpisode(episode, timestampMs);
  }

  _tryEntry(row, trade, timestampMs, markPrice) {
    if (timestampMs < row.entryTargetAt) return;
    if (timestampMs > row.entryDeadlineAt) {
      row.status = 'NO_ENTRY';
      row.rejectionReason = 'ENTRY_TIMEOUT';
      return;
    }
    const movePct = ((markPrice / row.signalPrice) - 1) * 100;
    if (movePct > this.config.maxEntryPriceJumpPct
      || movePct < -this.config.maxEntryPriceDropPct) {
      row.status = 'NO_ENTRY';
      row.rejectionReason = movePct > 0 ? 'ENTRY_PRICE_JUMP' : 'ENTRY_PRICE_DROP';
      return;
    }
    const quote = executableBuy(trade, row.positionSol, markPrice);
    if (!quote.available || !(quote.price > 0) || !(quote.tokenUnits > 0)) return;
    row.status = 'OPEN';
    row.entryAt = timestampMs;
    row.entryPrice = quote.price;
    row.entryImpactPct = quote.impactPct;
    row.tokenUnits = quote.tokenUnits;
    row.highestPrice = markPrice;
    row.lowestPrice = markPrice;
    this.metrics.entries += 1;
  }

  _emergencyReason(episode, trade, timestampMs, row) {
    const recentCutoff = timestampMs - this.config.emergencyRecentFlowMs;
    const recent = episode.events.filter((event) => event.timestampMs >= recentCutoff);
    const recentNetFlow = recent.reduce((sum, event) => (
      sum + (event.side === 'BUY' ? event.sol : -event.sol)
    ), 0);
    const totalNetFlow = episode.buyFlowSol - episode.sellFlowSol;
    const sellSol = String(trade.side || '').toUpperCase() === 'SELL'
      ? Math.max(0, finite(trade.solAmount, 0)) : 0;
    if (sellSol >= this.config.minLargeSellSol
      && sellSol >= episode.buyFlowSol * this.config.minSellBuyFlowRatio) {
      return 'FIRST_LARGE_SELL';
    }
    if (recentNetFlow <= this.config.flowFlipNetSol && totalNetFlow < 0) return 'NET_FLOW_SIGN_FLIP';
    const markReturnPct = ((tradePrice(trade) / row.entryPrice) - 1) * 100;
    if (markReturnPct <= -this.config.fastDropPct) return 'FAST_PRICE_COLLAPSE';
    if (episode.buyers.size >= this.config.minBuyersBeforeStall
      && timestampMs - episode.lastNewBuyerAt >= this.config.buyerStallMs
      && recentNetFlow < 0) return 'BUYER_RETENTION_COLLAPSE';
    return null;
  }

  _requestExit(row, timestampMs, reason) {
    if (row.status !== 'OPEN') return;
    row.status = 'EXIT_PENDING';
    row.emergencyTriggerAt = reason.startsWith('FIXED_HOLD') ? row.emergencyTriggerAt : timestampMs;
    row.emergencyReason = reason.startsWith('FIXED_HOLD') ? row.emergencyReason : reason;
    row.exitTargetAt = timestampMs + this.config.exitDelayMs;
    row.exitDeadlineAt = timestampMs + this.config.exitTimeoutMs;
    row.exitReason = reason;
    if (!reason.startsWith('FIXED_HOLD')) this.metrics.emergencyTriggers += 1;
  }

  _tryExit(row, trade, timestampMs, markPrice) {
    if (timestampMs < row.exitTargetAt) return;
    if (timestampMs > row.exitDeadlineAt) {
      row.status = 'NO_EXIT';
      row.rejectionReason = 'EXIT_TIMEOUT';
      row.netReturnPct = null;
      this.metrics.noExits += 1;
      return;
    }
    const markReturnPct = ((markPrice / row.entryPrice) - 1) * 100;
    const quote = executableSell(trade, row.tokenUnits, markPrice, { rugMarkReturnPct: markReturnPct });
    if (!quote.available && !quote.conservative) return;
    const exitPrice = finite(quote.price);
    if (exitPrice == null) return;
    row.status = 'CLOSED';
    row.exitAt = timestampMs;
    row.exitPrice = exitPrice;
    row.exitImpactPct = quote.impactPct;
    row.grossReturnPct = ((exitPrice / row.entryPrice) - 1) * 100;
    row.netReturnPct = row.grossReturnPct - row.configuredCostPct;
    this.metrics.closes += 1;
  }

  _syncObserved(row, episode) {
    row.observedBuyers = episode.buyers.size;
    row.observedBuyFlowSol = episode.buyFlowSol;
    row.observedSellFlowSol = episode.sellFlowSol;
    row.peakSellSol = episode.peakSellSol;
  }

  _finalizeEpisode(episode, timestampMs) {
    if (episode.finalized) return;
    for (const row of episode.rows) {
      if (row.status === 'PENDING_ENTRY') {
        row.status = 'NO_ENTRY';
        row.rejectionReason = 'ENTRY_TIMEOUT';
      } else if (row.status === 'OPEN' || row.status === 'EXIT_PENDING') {
        row.status = 'NO_EXIT';
        row.rejectionReason = 'NO_COMPARABLE_EXIT_TRADE';
        row.netReturnPct = null;
        this.metrics.noExits += 1;
      }
      const futureRug = row.rug50At != null;
      row.escapedBeforeRug = futureRug && row.exitAt != null && row.exitAt < row.rug50At ? 1 : 0;
      row.caughtRug = futureRug && row.entryAt != null && !row.escapedBeforeRug ? 1 : 0;
      row.guardAvoidedRug = futureRug && row.status === 'NO_ENTRY'
        && row.rejectionReason === 'SYNTHETIC_RAMP_GUARD' ? 1 : 0;
      row.labelStatus = 'COMPLETE';
      row.updatedAt = timestampMs;
      this._save(row);
    }
    if (episode.rows.some((row) => row.rug50At != null)) this.metrics.futureRugs += 1;
    episode.finalized = true;
    this.episodes.delete(episode.id);
    const bucket = this.episodesByMint.get(episode.mint);
    bucket?.delete(episode.id);
    if (bucket && !bucket.size) this.episodesByMint.delete(episode.mint);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const episode of [...this.episodes.values()]) {
      if (now < episode.finalizeAt) continue;
      this._finalizeEpisode(episode, now);
    }
  }

  _syntheticAssessment(risk) {
    const reasons = [];
    if (risk.flagged) reasons.push('UNIVERSAL_RUG_GUARD');
    if (finite(risk.returnPct, 0) >= this.config.syntheticMinRunupPct
      && finite(risk.buySharePct, 0) >= this.config.syntheticMinBuySharePct) {
      reasons.push('ONE_SIDED_RUNUP');
    }
    if (finite(risk.sideAlternationPct, 100) <= this.config.syntheticMaxAlternationPct) {
      reasons.push('LOW_SIDE_ALTERNATION');
    }
    if (finite(risk.maxConsecutiveBuys, 0) >= this.config.syntheticMinConsecutiveBuys) {
      reasons.push('CONSECUTIVE_BUY_STAIR');
    }
    if (finite(risk.repeatedBuySizeSharePct, 0) >= this.config.syntheticMinRepeatedSizePct) {
      reasons.push('REPEATED_BUY_SIZE');
    }
    if (finite(risk.maxWalletBuyTxSharePct, 0) >= this.config.syntheticMinWalletSharePct) {
      reasons.push('CONCENTRATED_BUYER');
    }
    const nonUniversal = reasons.filter((reason) => reason !== 'UNIVERSAL_RUG_GUARD').length;
    return {
      score: nonUniversal,
      reasons,
      flagged: Boolean(risk.flagged || nonUniversal >= this.config.syntheticMinFlags),
    };
  }

  _save(row) {
    row.updatedAt = this.now();
    this.updateRow.run(row);
  }

  dashboard(limit = 100) {
    const groups = this.store.db.prepare(`
      SELECT cohort_id, market,
        COUNT(*) AS signals,
        COUNT(DISTINCT mint) AS mints,
        SUM(CASE WHEN entry_at IS NOT NULL THEN 1 ELSE 0 END) AS entries,
        SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed,
        SUM(CASE WHEN status='NO_ENTRY' THEN 1 ELSE 0 END) AS no_entry,
        SUM(CASE WHEN label_status='COMPLETE' AND rug50_at IS NOT NULL THEN 1 ELSE 0 END) AS future_rugs,
        SUM(COALESCE(escaped_before_rug,0)) AS escaped_before_rug,
        SUM(COALESCE(caught_rug,0)) AS caught_rug,
        SUM(COALESCE(guard_avoided_rug,0)) AS guard_avoided_rug,
        AVG(CASE WHEN status='CLOSED' THEN net_return_pct END) AS average_net_return_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>0 THEN 100.0 ELSE 0 END END) AS win_rate_pct
      FROM smart_wallet_rug_escape_shadow_positions
      GROUP BY cohort_id, market
      ORDER BY cohort_id, market
    `).all();
    const escapeRows = this.store.db.prepare(`
      SELECT cohort_id, market, rug50_at - exit_at AS lead_ms
      FROM smart_wallet_rug_escape_shadow_positions
      WHERE escaped_before_rug=1 AND rug50_at IS NOT NULL AND exit_at IS NOT NULL
    `).all();
    for (const group of groups) {
      const leads = escapeRows.filter((row) => row.cohort_id === group.cohort_id
        && row.market === group.market).map((row) => finite(row.lead_ms));
      group.median_escape_lead_ms = median(leads);
      group.future_rug_rate_pct = group.signals > 0 ? group.future_rugs / group.signals * 100 : null;
      group.escape_rate_pct = group.future_rugs > 0
        ? group.escaped_before_rug / group.future_rugs * 100 : null;
      group.caught_rug_rate_pct = group.entries > 0 ? group.caught_rug / group.entries * 100 : null;
    }
    const walletStats = this.store.db.prepare(`
      SELECT smart_wallet,
        COUNT(*) AS first_opens,
        SUM(CASE WHEN rug50_at IS NOT NULL THEN 1 ELSE 0 END) AS future_rugs,
        AVG(CASE WHEN status='CLOSED' THEN net_return_pct END) AS baseline_average_net_return_pct
      FROM smart_wallet_rug_escape_shadow_positions
      WHERE cohort_id='BASE_T30'
      GROUP BY smart_wallet
      ORDER BY first_opens DESC, smart_wallet
      LIMIT 50
    `).all().map((row) => ({
      ...row,
      future_rug_rate_pct: row.first_opens > 0 ? row.future_rugs / row.first_opens * 100 : null,
    }));
    const positions = this.store.db.prepare(`
      SELECT * FROM smart_wallet_rug_escape_shadow_positions
      ORDER BY signal_at DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100)));
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SWRE',
      sendsTransactions: false,
      strategy: {
        firstOpenOnly: true,
        ignoresAdds: true,
        positionSizeSol: this.config.positionSizeSol,
        emergencyWindowMs: this.config.emergencyWindowMs,
        labelHorizonMs: this.config.labelHorizonMs,
        profiles: this.config.profiles,
      },
      groups,
      walletStats,
      positions,
      health: this.health(),
    };
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SMART_WALLET_RUG_ESCAPE',
      firstOpenOnly: true,
      ignoresAdds: true,
      hotPath: 'IN_MEMORY_TRACKED_MINTS_ONLY',
      extraRpc: false,
      sendsTransactions: false,
      activeEpisodes: this.episodes.size,
      trackedMints: this.episodesByMint.size,
      profiles: this.config.profiles.map((profile) => profile.id),
      ...this.metrics,
    };
  }
}

module.exports = { SmartWalletRugEscapeShadowSuite };
