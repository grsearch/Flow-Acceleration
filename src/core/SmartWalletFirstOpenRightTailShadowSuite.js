'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const { tradePrice } = require('./PreEntryRugRiskTracker');

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pct(price, base) {
  return price >= 0 && base > 0 ? ((price / base) - 1) * 100 : null;
}

function percentile(values, quantile) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const index = (ordered.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower];
  return ordered[lower] * (upper - index) + ordered[upper] * (index - lower);
}

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

class SmartWalletFirstOpenRightTailShadowSuite {
  constructor({ config, store, rugRiskTracker = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.rugRiskTracker = rugRiskTracker;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.positionSizeSol });
    this.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    this.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
    this.episodes = new Map();
    this.episodesByMint = new Map();
    this.metrics = {
      smartEvents: 0,
      firstOpens: 0,
      ignoredAdds: 0,
      evaluatedProfiles: 0,
      qualifiedProfiles: 0,
      rejectedProfiles: 0,
      rowsCreated: 0,
      opened: 0,
      coreExits: 0,
      closed: 0,
      noExit: 0,
      lastActionAt: null,
      lastError: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS smart_wallet_first_open_right_tail_shadow_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cohort_id TEXT NOT NULL,
        entry_profile_id TEXT NOT NULL,
        exit_profile_id TEXT NOT NULL,
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
        pre_return_pct REAL,
        pre_max_consecutive_buys INTEGER,
        pre_buy_share_pct REAL,
        pre_side_alternation_pct REAL,
        pre_repeated_buy_size_pct REAL,
        pre_largest_wallet_share_pct REAL,
        pre_risk_json TEXT NOT NULL,
        entry_target_at INTEGER,
        entry_deadline_at INTEGER,
        entry_at INTEGER,
        entry_price REAL,
        entry_impact_pct REAL,
        token_units REAL,
        highest_price REAL,
        lowest_price REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        core_weight_pct REAL NOT NULL,
        core_exit_at INTEGER,
        core_exit_price REAL,
        core_proceeds_sol REAL,
        core_realized_return_pct REAL,
        runner_realized_return_pct REAL,
        runner_high_price REAL,
        runner_stop_price REAL,
        exit_target_at INTEGER,
        exit_deadline_at INTEGER,
        exit_at INTEGER,
        exit_price REAL,
        exit_impact_pct REAL,
        exit_reason TEXT,
        gross_return_pct REAL,
        net_return_pct REAL,
        estimated_cost_sol REAL,
        hold_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(smart_event_id, cohort_id)
      );
      CREATE INDEX IF NOT EXISTS idx_swfo_rt_mint_time
        ON smart_wallet_first_open_right_tail_shadow_positions(mint, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swfo_rt_profiles
        ON smart_wallet_first_open_right_tail_shadow_positions(
          entry_profile_id, exit_profile_id, signal_at DESC
        );
      CREATE INDEX IF NOT EXISTS idx_swfo_rt_status
        ON smart_wallet_first_open_right_tail_shadow_positions(status, updated_at DESC);
    `);
    const columns = new Set(this.store.db.prepare(
      'PRAGMA table_info(smart_wallet_first_open_right_tail_shadow_positions)',
    ).all().map((row) => row.name));
    const additions = [
      ['pre_repeated_buy_size_pct', 'REAL'],
      ['pre_largest_wallet_share_pct', 'REAL'],
      ['core_realized_return_pct', 'REAL'],
      ['runner_realized_return_pct', 'REAL'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.store.db.exec(
          `ALTER TABLE smart_wallet_first_open_right_tail_shadow_positions ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    this.insertRow = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_first_open_right_tail_shadow_positions (
        cohort_id, entry_profile_id, exit_profile_id, episode_id,
        smart_event_id, smart_wallet, mint, symbol, market, status,
        rejection_reason, position_sol, configured_cost_pct, signal_at,
        signal_price, pre_return_pct, pre_max_consecutive_buys,
        pre_buy_share_pct, pre_side_alternation_pct,
        pre_repeated_buy_size_pct, pre_largest_wallet_share_pct, pre_risk_json,
        entry_target_at, entry_deadline_at, core_weight_pct, created_at, updated_at
      ) VALUES (
        @cohortId, @entryProfileId, @exitProfileId, @episodeId,
        @smartEventId, @smartWallet, @mint, @symbol, @market, @status,
        @rejectionReason, @positionSol, @configuredCostPct, @signalAt,
        @signalPrice, @preReturnPct, @preMaxConsecutiveBuys,
        @preBuySharePct, @preSideAlternationPct,
        @preRepeatedBuySizePct, @preLargestWalletSharePct, @preRiskJson,
        @entryTargetAt, @entryDeadlineAt, @coreWeightPct, @createdAt, @updatedAt
      )
    `);
    this.getInserted = this.store.db.prepare(`
      SELECT id FROM smart_wallet_first_open_right_tail_shadow_positions
      WHERE smart_event_id=? AND cohort_id=?
    `);
    this.updateRow = this.store.db.prepare(`
      UPDATE smart_wallet_first_open_right_tail_shadow_positions SET
        status=@status, rejection_reason=@rejectionReason,
        entry_at=@entryAt, entry_price=@entryPrice, entry_impact_pct=@entryImpactPct,
        token_units=@tokenUnits, highest_price=@highestPrice, lowest_price=@lowestPrice,
        max_favorable_return_pct=@maxFavorableReturnPct,
        max_adverse_return_pct=@maxAdverseReturnPct,
        core_exit_at=@coreExitAt, core_exit_price=@coreExitPrice,
        core_proceeds_sol=@coreProceedsSol,
        core_realized_return_pct=@coreRealizedReturnPct,
        runner_realized_return_pct=@runnerRealizedReturnPct,
        runner_high_price=@runnerHighPrice,
        runner_stop_price=@runnerStopPrice,
        exit_target_at=@exitTargetAt, exit_deadline_at=@exitDeadlineAt,
        exit_at=@exitAt, exit_price=@exitPrice, exit_impact_pct=@exitImpactPct,
        exit_reason=@exitReason, gross_return_pct=@grossReturnPct,
        net_return_pct=@netReturnPct, estimated_cost_sol=@estimatedCostSol,
        hold_ms=@holdMs, updated_at=@updatedAt
      WHERE id=@id
    `);
    this.insertRows = this.store.db.transaction((rows) => {
      for (const row of rows) {
        const result = this.insertRow.run(row);
        if (!result.changes) continue;
        row.id = this.getInserted.get(row.smartEventId, row.cohortId)?.id || null;
      }
    });
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    this.store.db.prepare(`
      UPDATE smart_wallet_first_open_right_tail_shadow_positions
      SET status='CENSORED_RESTART',
          rejection_reason=COALESCE(rejection_reason, 'PROCESS_RESTART'), updated_at=?
      WHERE status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING')
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
    const episodeId = `SWFO-RT:${event.id}`;
    if (this.episodes.has(episodeId)) return;
    const risk = this.rugRiskTracker?.snapshot(event.mint, signalAt) || {};
    const preReturnPct = finite(risk.returnPct);
    const preMaxConsecutiveBuys = finite(risk.maxConsecutiveBuys);
    const now = this.now();
    const rows = [];
    const qualifiedRows = [];
    for (const entry of this.entryProfiles.values()) {
      this.metrics.evaluatedProfiles += 1;
      const incomplete = preReturnPct == null || preMaxConsecutiveBuys == null;
      const qualified = !incomplete
        && preReturnPct <= entry.maxPreReturnPct
        && preMaxConsecutiveBuys <= entry.maxConsecutiveBuys;
      if (qualified) this.metrics.qualifiedProfiles += 1;
      else this.metrics.rejectedProfiles += 1;
      const rejectionReason = incomplete
        ? 'INCOMPLETE_PRE_ENTRY_RISK'
        : (preReturnPct > entry.maxPreReturnPct
          ? `PRE_RETURN_ABOVE_${entry.maxPreReturnPct}`
          : (preMaxConsecutiveBuys > entry.maxConsecutiveBuys
            ? `BUY_RUN_ABOVE_${entry.maxConsecutiveBuys}` : null));
      for (const exit of this.exitProfiles.values()) {
        const row = {
          id: null,
          entry,
          exit,
          cohortId: `${entry.id}:${exit.id}`,
          entryProfileId: entry.id,
          exitProfileId: exit.id,
          episodeId,
          smartEventId: Number(event.id),
          smartWallet: event.wallet,
          mint: event.mint,
          symbol: event.symbol || null,
          market: event.market || null,
          status: qualified ? 'PENDING_ENTRY' : 'RULE_REJECTED',
          rejectionReason,
          positionSol: this.config.positionSizeSol,
          configuredCostPct: this.costs.deterministicCostPct,
          signalAt,
          signalPrice,
          preReturnPct,
          preMaxConsecutiveBuys,
          preBuySharePct: finite(risk.buySharePct),
          preSideAlternationPct: finite(risk.sideAlternationPct),
          preRepeatedBuySizePct: finite(risk.repeatedBuySizeSharePct),
          preLargestWalletSharePct: finite(risk.maxWalletBuyTxSharePct),
          preRiskJson: json(risk),
          entryTargetAt: qualified ? signalAt + this.config.entryDelayMs : null,
          entryDeadlineAt: qualified ? signalAt + this.config.entryTimeoutMs : null,
          entryAt: null,
          entryPrice: null,
          entryImpactPct: null,
          tokenUnits: null,
          highestPrice: null,
          lowestPrice: null,
          maxFavorableReturnPct: null,
          maxAdverseReturnPct: null,
          coreWeightPct: exit.coreWeightPct || 0,
          coreExitAt: null,
          coreExitPrice: null,
          coreProceedsSol: 0,
          coreRealizedReturnPct: null,
          runnerRealizedReturnPct: null,
          runnerHighPrice: null,
          runnerStopPrice: null,
          exitTargetAt: null,
          exitDeadlineAt: null,
          exitAt: null,
          exitPrice: null,
          exitImpactPct: null,
          exitReason: null,
          grossReturnPct: null,
          netReturnPct: null,
          estimatedCostSol: null,
          holdMs: null,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(row);
        if (qualified) qualifiedRows.push(row);
      }
    }
    this.insertRows(rows);
    this.metrics.rowsCreated += rows.filter((row) => row.id).length;
    const activeRows = qualifiedRows.filter((row) => row.id);
    if (activeRows.length) {
      const episode = {
        id: episodeId,
        mint: event.mint,
        market: event.market || null,
        signalAt,
        rows: activeRows,
        recentFlow: [],
        finalizeAt: signalAt + this.config.maxEpisodeMs,
      };
      this.episodes.set(episodeId, episode);
      const bucket = this.episodesByMint.get(event.mint) || new Set();
      bucket.add(episodeId);
      this.episodesByMint.set(event.mint, bucket);
    }
    this.metrics.firstOpens += 1;
    this.metrics.lastActionAt = now;
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint) return;
    const ids = this.episodesByMint.get(trade.mint);
    if (!ids?.size) return;
    const timestampMs = finite(trade.timestampMs);
    const markPrice = tradePrice(trade);
    if (!(timestampMs > 0) || !(markPrice > 0)) return;
    for (const id of [...ids]) {
      const episode = this.episodes.get(id);
      if (!episode || timestampMs < episode.signalAt) continue;
      if (episode.market && trade.market && episode.market !== trade.market) continue;
      this._observeEpisode(episode, trade, timestampMs, markPrice);
    }
  }

  _observeEpisode(episode, trade, timestampMs, markPrice) {
    const side = String(trade.side || '').toUpperCase();
    const sol = Math.max(0, finite(trade.solAmount, 0));
    episode.recentFlow.push({ timestampMs, side, sol });
    const cutoff = timestampMs - this.config.flowFadeWindowMs;
    while (episode.recentFlow.length && episode.recentFlow[0].timestampMs < cutoff) {
      episode.recentFlow.shift();
    }
    for (const row of episode.rows) {
      if (row.status === 'PENDING_ENTRY') this._tryEntry(row, trade, timestampMs, markPrice);
      if (row.status === 'OPEN') this._observeOpen(row, episode, trade, timestampMs, markPrice);
      if (row.status === 'EXIT_PENDING') this._tryExit(row, trade, timestampMs, markPrice);
    }
    if (timestampMs >= episode.finalizeAt) this._finalizeEpisode(episode, timestampMs);
  }

  _tryEntry(row, trade, timestampMs, markPrice) {
    if (timestampMs < row.entryTargetAt) return;
    if (timestampMs > row.entryDeadlineAt) {
      row.status = 'NO_ENTRY';
      row.rejectionReason = 'ENTRY_TIMEOUT';
      this._save(row);
      return;
    }
    const movePct = pct(markPrice, row.signalPrice);
    if (movePct > this.config.maxEntryPriceJumpPct
      || movePct < -this.config.maxEntryPriceDropPct) {
      row.status = 'NO_ENTRY';
      row.rejectionReason = movePct > 0 ? 'ENTRY_PRICE_JUMP' : 'ENTRY_PRICE_DROP';
      this._save(row);
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
    row.maxFavorableReturnPct = Math.max(0, pct(markPrice, row.entryPrice));
    row.maxAdverseReturnPct = Math.min(0, pct(markPrice, row.entryPrice));
    row.runnerHighPrice = markPrice;
    this.metrics.opened += 1;
    this._save(row);
  }

  _observeOpen(row, episode, trade, timestampMs, markPrice) {
    row.highestPrice = Math.max(row.highestPrice || markPrice, markPrice);
    row.lowestPrice = Math.min(row.lowestPrice || markPrice, markPrice);
    row.runnerHighPrice = Math.max(row.runnerHighPrice || markPrice, markPrice);
    row.maxFavorableReturnPct = Math.max(row.maxFavorableReturnPct || 0, pct(row.highestPrice, row.entryPrice));
    row.maxAdverseReturnPct = Math.min(row.maxAdverseReturnPct || 0, pct(row.lowestPrice, row.entryPrice));
    const elapsedMs = timestampMs - row.entryAt;
    const gross = pct(markPrice, row.entryPrice);
    if (row.exit.mode === 'CORE_RUNNER' && !row.coreExitAt
      && gross >= row.exit.coreActivationPct) {
      const units = row.tokenUnits * row.exit.coreWeightPct / 100;
      const quote = executableSell(trade, units, markPrice, { rugMarkReturnPct: gross });
      if (quote.available || quote.conservative) {
        row.coreExitAt = timestampMs;
        row.coreExitPrice = finite(quote.price, 0);
        row.coreProceedsSol = finite(quote.proceedsSol, row.coreExitPrice * units);
        const coreCapitalSol = row.positionSol * row.exit.coreWeightPct / 100;
        row.coreRealizedReturnPct = coreCapitalSol > 0
          ? (row.coreProceedsSol / coreCapitalSol - 1) * 100 : null;
        this.metrics.coreExits += 1;
      }
    }
    let reason = null;
    if (row.exit.hardStopPct > 0 && gross <= -row.exit.hardStopPct) {
      reason = `HARD_STOP_${row.exit.hardStopPct}`;
    } else if (row.exit.mode === 'FLOW_FADE' && elapsedMs >= row.exit.protectionMs) {
      const netFlow = episode.recentFlow.reduce((sum, item) => (
        sum + (item.side === 'BUY' ? item.sol : -item.sol)
      ), 0);
      if (netFlow <= row.exit.flowFadeNetSol) reason = 'FLOW_FADE';
    } else if (row.exit.mode === 'CORE_RUNNER' && row.coreExitAt) {
      const stop = row.runnerHighPrice * (1 - row.exit.trailingDrawdownPct / 100);
      row.runnerStopPrice = stop;
      if (markPrice <= stop) reason = `RUNNER_TRAIL_${row.exit.trailingDrawdownPct}`;
    }
    if (!reason && elapsedMs >= row.exit.maxHoldMs) reason = `FIXED_HOLD_${row.exit.maxHoldMs}MS`;
    if (reason) this._requestExit(row, timestampMs, reason);
    this._save(row);
  }

  _requestExit(row, timestampMs, reason) {
    if (row.status !== 'OPEN') return;
    row.status = 'EXIT_PENDING';
    row.exitTargetAt = timestampMs + this.config.exitDelayMs;
    row.exitDeadlineAt = timestampMs + this.config.exitTimeoutMs;
    row.exitReason = reason;
  }

  _tryExit(row, trade, timestampMs, markPrice) {
    if (timestampMs < row.exitTargetAt) return;
    if (timestampMs > row.exitDeadlineAt) {
      row.status = 'NO_EXIT';
      row.rejectionReason = 'EXIT_TIMEOUT';
      row.netReturnPct = null;
      this.metrics.noExit += 1;
      this._save(row);
      return;
    }
    const remainingWeight = row.coreExitAt ? 1 - row.exit.coreWeightPct / 100 : 1;
    const units = row.tokenUnits * remainingWeight;
    const markReturnPct = pct(markPrice, row.entryPrice);
    const quote = executableSell(trade, units, markPrice, { rugMarkReturnPct: markReturnPct });
    if (!quote.available && !quote.conservative) return;
    const exitPrice = finite(quote.price);
    if (exitPrice == null) return;
    const runnerProceedsSol = finite(quote.proceedsSol, exitPrice * units);
    const proceeds = runnerProceedsSol + (row.coreProceedsSol || 0);
    row.status = 'CLOSED';
    row.exitAt = timestampMs;
    row.exitPrice = exitPrice;
    row.exitImpactPct = quote.impactPct;
    row.runnerRealizedReturnPct = remainingWeight > 0
      ? (runnerProceedsSol / (row.positionSol * remainingWeight) - 1) * 100 : null;
    row.grossReturnPct = (proceeds / row.positionSol - 1) * 100;
    const extraFixedCostSol = row.coreExitAt ? this.costs.totalFixedCostSol : 0;
    row.estimatedCostSol = row.positionSol * row.configuredCostPct / 100 + extraFixedCostSol;
    row.netReturnPct = row.grossReturnPct - row.estimatedCostSol / row.positionSol * 100;
    row.holdMs = timestampMs - row.entryAt;
    this.metrics.closed += 1;
    this.metrics.lastActionAt = this.now();
    this._save(row);
  }

  _finalizeEpisode(episode, timestampMs) {
    for (const row of episode.rows) {
      if (row.status === 'PENDING_ENTRY') {
        row.status = 'NO_ENTRY';
        row.rejectionReason = 'ENTRY_TIMEOUT';
      } else if (row.status === 'OPEN' || row.status === 'EXIT_PENDING') {
        row.status = 'NO_EXIT';
        row.rejectionReason = 'NO_COMPARABLE_EXIT_TRADE';
        row.netReturnPct = null;
        this.metrics.noExit += 1;
      }
      this._save(row);
    }
    this.episodes.delete(episode.id);
    const bucket = this.episodesByMint.get(episode.mint);
    bucket?.delete(episode.id);
    if (bucket && !bucket.size) this.episodesByMint.delete(episode.mint);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const episode of [...this.episodes.values()]) {
      if (now >= episode.finalizeAt) this._finalizeEpisode(episode, now);
    }
  }

  _save(row) {
    if (!row.id) return;
    row.updatedAt = this.now();
    this.updateRow.run(row);
  }

  dashboard(limit = 100) {
    const groups = this.store.db.prepare(`
      SELECT cohort_id, entry_profile_id, exit_profile_id,
        COUNT(*) signals, COUNT(DISTINCT mint) mints,
        SUM(status='RULE_REJECTED') rule_rejected,
        SUM(entry_at IS NOT NULL) entries,
        SUM(status='CLOSED') closed,
        SUM(status='NO_EXIT') no_exit,
        AVG(CASE WHEN status='CLOSED' THEN net_return_pct END) average_net_return_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>0 THEN 100.0 ELSE 0 END END) win_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>=50 THEN 100.0 ELSE 0 END END) big50_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN CASE WHEN net_return_pct>=100 THEN 100.0 ELSE 0 END END) big100_rate_pct,
        AVG(CASE WHEN status='CLOSED' THEN max_favorable_return_pct END) average_mfe_pct,
        AVG(CASE WHEN status='CLOSED' THEN max_adverse_return_pct END) average_mae_pct,
        MAX(CASE WHEN status='CLOSED' THEN net_return_pct END) max_winner_pct,
        AVG(pre_return_pct) average_pre_return_pct,
        AVG(pre_max_consecutive_buys) average_pre_max_consecutive_buys
      FROM smart_wallet_first_open_right_tail_shadow_positions
      GROUP BY cohort_id, entry_profile_id, exit_profile_id
      ORDER BY entry_profile_id, exit_profile_id
    `).all();
    const returnRows = this.store.db.prepare(`
      SELECT net_return_pct FROM smart_wallet_first_open_right_tail_shadow_positions
      WHERE cohort_id=? AND status='CLOSED' AND net_return_pct IS NOT NULL
      ORDER BY net_return_pct DESC
    `);
    for (const group of groups) {
      const values = returnRows.all(group.cohort_id).map((row) => finite(row.net_return_pct)).filter(Number.isFinite);
      const profit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
      const loss = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
      const total = values.reduce((sum, value) => sum + value, 0);
      group.median_net_return_pct = percentile(values, 0.5);
      group.profit_factor = loss > 0 ? profit / loss : (profit > 0 ? null : 0);
      group.average_net_return_ex_top5_pct = values.length > 5
        ? values.slice(5).reduce((sum, value) => sum + value, 0) / (values.length - 5) : null;
      group.top_5_total_pnl_contribution_pct = total !== 0
        ? values.slice(0, 5).reduce((sum, value) => sum + value, 0) / total * 100 : null;
    }
    const positions = this.store.db.prepare(`
      SELECT * FROM smart_wallet_first_open_right_tail_shadow_positions
      ORDER BY CASE WHEN status IN ('PENDING_ENTRY','OPEN','EXIT_PENDING') THEN 0 ELSE 1 END,
        signal_at DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(300, Number(limit) || 100)));
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SWFO_RT',
      sendsTransactions: false,
      strategy: {
        firstOpenOnly: true,
        ignoresAdds: true,
        positionSizeSol: this.config.positionSizeSol,
        entryProfiles: [...this.entryProfiles.values()],
        exitProfiles: [...this.exitProfiles.values()],
      },
      groups,
      positions,
      health: this.health(),
    };
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SMART_FIRST_OPEN_RIGHT_TAIL',
      firstOpenOnly: true,
      ignoresAdds: true,
      hotPath: 'TRACKED_MINTS_IN_MEMORY_ONLY',
      preEntryRiskSource: 'IN_MEMORY_CAUSAL_SNAPSHOT',
      extraRpc: false,
      sendsTransactions: false,
      activeEpisodes: this.episodes.size,
      trackedMints: this.episodesByMint.size,
      entryProfiles: [...this.entryProfiles.keys()],
      exitProfiles: [...this.exitProfiles.keys()],
      ...this.metrics,
    };
  }
}

module.exports = { SmartWalletFirstOpenRightTailShadowSuite };
