'use strict';

const { executableBuy, executableSell } = require('./ShadowExecutionModel');

const HORIZONS = [5, 30, 120, 300];
const FAMILY_KEYS = ['flow', 'participation', 'balance', 'structure', 'execution'];
const LABEL_SCHEMA_VERSION = 2;
const OBSERVATION_TABLE = 'feature_edge_audit_observations_v2';
const BNH_TABLE = 'feature_edge_audit_bnh_shadow_positions';
const BNH_PROFILE_ID = 'FEA_BNH_120';

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregate(values) {
  const clean = values.filter(Number.isFinite);
  const positive = clean.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const negative = Math.abs(clean.filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0));
  return {
    count: clean.length,
    winRatePct: clean.length
      ? clean.filter((value) => value > 0).length / clean.length * 100 : null,
    averagePct: clean.length
      ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null,
    medianPct: median(clean),
    profitFactor: negative > 0 ? positive / negative : (positive > 0 ? null : 0),
    big50RatePct: clean.length
      ? clean.filter((value) => value >= 50).length / clean.length * 100 : null,
    big100RatePct: clean.length
      ? clean.filter((value) => value >= 100).length / clean.length * 100 : null,
    rug50RatePct: clean.length
      ? clean.filter((value) => value <= -50).length / clean.length * 100 : null,
  };
}

class FeatureEdgeAuditObserver {
  constructor({ config = {}, store }) {
    this.config = {
      enabled: config.enabled !== false,
      positionSol: finite(config.positionSol, 1),
      sampleCooldownMs: finite(config.sampleCooldownMs, 30_000),
      maxPending: Math.max(100, finite(config.maxPending, 3_000)),
      maxObservationLagMs: Math.max(250, finite(config.maxObservationLagMs, 3_000)),
      stateRetentionMs: Math.max(310_000, finite(config.stateRetentionMs, 360_000)),
      minNetFlowSol: finite(config.minNetFlowSol, 10),
      minFlowAccelerationSol: finite(config.minFlowAccelerationSol, 2),
      minBuyers: finite(config.minBuyers, 7),
      minBuySharePct: finite(config.minBuySharePct, 70),
      maxEntryImpactPct: finite(config.maxEntryImpactPct, 15),
      minCurvePct: finite(config.minCurvePct, 60),
      maxCurvePct: finite(config.maxCurvePct, 95),
      minAgeMs: finite(config.minAgeMs, 5_000),
      maxAgeMs: finite(config.maxAgeMs, 300_000),
      bnhEnabled: config.bnhEnabled !== false,
      bnhMinAgeMs: finite(config.bnhMinAgeMs, 30_000),
      bnhMaxAgeMs: finite(config.bnhMaxAgeMs, 120_000),
      bnhMinCurvePct: finite(config.bnhMinCurvePct, 60),
      bnhMaxCurvePct: finite(config.bnhMaxCurvePct, 90),
      bnhHoldMs: finite(config.bnhHoldMs, 120_000),
      bnhRoundTripCostPct: finite(config.bnhRoundTripCostPct, 3.2),
    };
    this.store = store;
    this.db = store?.db;
    this.pending = new Map();
    this.pendingByMint = new Map();
    this.lastSampleAt = new Map();
    this.statements = {};
    this.metrics = {
      signalsEvaluated: 0,
      samplesCreated: 0,
      samplesCompleted: 0,
      samplesCensored: 0,
      capacitySkipped: 0,
      cooldownSkipped: 0,
      quoteAvailable: 0,
      quoteMissing: 0,
      crossMarketInvalidated: 0,
      bnhOpened: 0,
      bnhClosed: 0,
      bnhNoExit: 0,
      lastSignalAt: null,
      lastCompletedAt: null,
    };
  }

  start() {
    if (!this.config.enabled || !this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${OBSERVATION_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label_schema_version INTEGER NOT NULL DEFAULT ${LABEL_SCHEMA_VERSION},
        signal_id INTEGER, signal_at_ms INTEGER NOT NULL, mint TEXT NOT NULL,
        signal_variant TEXT, market TEXT, age_ms INTEGER, curve_pct REAL,
        entry_market_price REAL NOT NULL, entry_executable_price REAL,
        entry_impact_pct REAL, entry_quote_available INTEGER NOT NULL DEFAULT 0,
        position_sol REAL NOT NULL, token_units REAL,
        flow_feature INTEGER NOT NULL DEFAULT 0,
        participation_feature INTEGER NOT NULL DEFAULT 0,
        balance_feature INTEGER NOT NULL DEFAULT 0,
        structure_feature INTEGER NOT NULL DEFAULT 0,
        execution_feature INTEGER NOT NULL DEFAULT 0,
        feature_score INTEGER NOT NULL DEFAULT 0, feature_json TEXT,
        mark_return_5s REAL, executable_return_5s REAL,
        mark_return_30s REAL, executable_return_30s REAL,
        mark_return_120s REAL, executable_return_120s REAL,
        mark_return_300s REAL, executable_return_300s REAL,
        mfe_pct REAL NOT NULL DEFAULT 0, mae_pct REAL NOT NULL DEFAULT 0,
        executable_mfe_pct REAL NOT NULL DEFAULT 0,
        executable_mae_pct REAL NOT NULL DEFAULT 0,
        horizon_lags_json TEXT, market_continuity_json TEXT,
        cross_market_seen INTEGER NOT NULL DEFAULT 0,
        label_status TEXT NOT NULL DEFAULT 'PENDING', censor_reason TEXT,
        finalized_at_ms INTEGER, created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feature_edge_audit_v2_signal_at
        ON ${OBSERVATION_TABLE}(signal_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_feature_edge_audit_v2_status
        ON ${OBSERVATION_TABLE}(label_status, signal_at_ms DESC);

      CREATE TABLE IF NOT EXISTS ${BNH_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL UNIQUE, profile_id TEXT NOT NULL,
        signal_at_ms INTEGER NOT NULL, mint TEXT NOT NULL, market TEXT NOT NULL,
        age_ms INTEGER, curve_pct REAL, entry_price REAL NOT NULL,
        entry_impact_pct REAL, position_sol REAL NOT NULL, token_units REAL NOT NULL,
        hold_ms INTEGER NOT NULL, round_trip_cost_pct REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN', exit_at_ms INTEGER, exit_price REAL,
        gross_return_pct REAL, net_return_pct REAL, mfe_pct REAL NOT NULL DEFAULT 0,
        mae_pct REAL NOT NULL DEFAULT 0, exit_reason TEXT, missing_exit_reason TEXT,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feature_edge_audit_bnh_signal_at
        ON ${BNH_TABLE}(signal_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_feature_edge_audit_bnh_status
        ON ${BNH_TABLE}(status, signal_at_ms DESC);
    `);
    this.statements.insert = this.db.prepare(`
      INSERT INTO ${OBSERVATION_TABLE} (
        signal_id, signal_at_ms, mint, signal_variant, market, age_ms, curve_pct,
        entry_market_price, entry_executable_price, entry_impact_pct,
        entry_quote_available, position_sol, token_units, flow_feature,
        participation_feature, balance_feature, structure_feature,
        execution_feature, feature_score, feature_json, created_at_ms
      ) VALUES (
        @signalId, @signalAtMs, @mint, @signalVariant, @market, @ageMs, @curvePct,
        @entryMarketPrice, @entryExecutablePrice, @entryImpactPct,
        @entryQuoteAvailable, @positionSol, @tokenUnits, @flowFeature,
        @participationFeature, @balanceFeature, @structureFeature,
        @executionFeature, @featureScore, @featureJson, @createdAtMs
      )
    `);
    this.statements.finalize = this.db.prepare(`
      UPDATE ${OBSERVATION_TABLE} SET
        mark_return_5s=@mark5, executable_return_5s=@exec5,
        mark_return_30s=@mark30, executable_return_30s=@exec30,
        mark_return_120s=@mark120, executable_return_120s=@exec120,
        mark_return_300s=@mark300, executable_return_300s=@exec300,
        mfe_pct=@mfe, mae_pct=@mae, executable_mfe_pct=@execMfe,
        executable_mae_pct=@execMae, horizon_lags_json=@horizonLagsJson,
        market_continuity_json=@marketContinuityJson,
        cross_market_seen=@crossMarketSeen, label_status=@labelStatus,
        censor_reason=@censorReason, finalized_at_ms=@finalizedAtMs WHERE id=@id
    `);
    this.statements.recent = this.db.prepare(`
      SELECT * FROM ${OBSERVATION_TABLE} ORDER BY signal_at_ms DESC LIMIT ?
    `);
    this.statements.insertBnh = this.db.prepare(`
      INSERT OR IGNORE INTO ${BNH_TABLE} (
        observation_id, profile_id, signal_at_ms, mint, market, age_ms, curve_pct,
        entry_price, entry_impact_pct, position_sol, token_units, hold_ms,
        round_trip_cost_pct, created_at_ms
      ) VALUES (
        @observationId, @profileId, @signalAtMs, @mint, @market, @ageMs, @curvePct,
        @entryPrice, @entryImpactPct, @positionSol, @tokenUnits, @holdMs,
        @roundTripCostPct, @createdAtMs
      )
    `);
    this.statements.closeBnh = this.db.prepare(`
      UPDATE ${BNH_TABLE} SET status=@status, exit_at_ms=@exitAtMs,
        exit_price=@exitPrice, gross_return_pct=@grossReturnPct,
        net_return_pct=@netReturnPct, mfe_pct=@mfePct, mae_pct=@maePct,
        exit_reason=@exitReason, missing_exit_reason=@missingExitReason
      WHERE observation_id=@observationId AND status='OPEN'
    `);
    this.statements.recentBnh = this.db.prepare(`
      SELECT * FROM ${BNH_TABLE} ORDER BY signal_at_ms DESC LIMIT ?
    `);
    this.db.prepare(`
      UPDATE ${BNH_TABLE} SET status='NO_EXIT',
        missing_exit_reason='PROCESS_RESTART_NO_RESTORE'
      WHERE status='OPEN'
    `).run();
  }

  stop() {
    this.advanceTime(Date.now() + this.config.stateRetentionMs, 'PROCESS_STOP');
  }

  onSignal(signal = {}) {
    if (!this.config.enabled || !this.statements.insert) return null;
    this.metrics.signalsEvaluated += 1;
    const signalAtMs = finite(signal.timestampMs ?? signal.signalAtMs);
    const entryMarketPrice = finite(signal.price);
    if (!signal.mint || !(signalAtMs > 0) || !(entryMarketPrice > 0)) return null;
    if (this.pending.size >= this.config.maxPending) {
      this.metrics.capacitySkipped += 1;
      return null;
    }
    const lastAt = this.lastSampleAt.get(signal.mint) || 0;
    if (signalAtMs - lastAt < this.config.sampleCooldownMs) {
      this.metrics.cooldownSkipped += 1;
      return null;
    }

    const net1 = finite(signal.netFlowW1, 0);
    const net2 = finite(signal.netFlowW2, 0);
    const net3 = finite(signal.netFlowW3, 0);
    const buyers1 = finite(signal.uniqueBuyersW1, 0);
    const buyers2 = finite(signal.uniqueBuyersW2, 0);
    const buyers3 = finite(signal.uniqueBuyersW3, 0);
    const tx1 = finite(signal.buyTxW1, 0);
    const tx2 = finite(signal.buyTxW2, 0);
    const tx3 = finite(signal.buyTxW3, 0);
    const buyFlow = finite(signal.buyFlowW3, 0);
    const sellFlow = finite(signal.sellFlowW3, 0);
    const buySharePct = buyFlow + sellFlow > 0 ? buyFlow / (buyFlow + sellFlow) * 100 : null;
    const quote = executableBuy(signal, this.config.positionSol, entryMarketPrice);
    const ageMs = finite(signal.ageMs);
    const curvePct = finite(signal.curvePct);
    const features = {
      flow: net3 >= this.config.minNetFlowSol
        && net3 - net2 >= this.config.minFlowAccelerationSol
        && net3 > net2 && net2 >= net1,
      participation: buyers3 >= this.config.minBuyers && buyers3 > buyers2
        && tx3 > tx2 && buyers2 >= buyers1 && tx2 >= tx1,
      balance: Number.isFinite(buySharePct) && buySharePct >= this.config.minBuySharePct,
      structure: Number.isFinite(curvePct) && curvePct >= this.config.minCurvePct
        && curvePct <= this.config.maxCurvePct && Number.isFinite(ageMs)
        && ageMs >= this.config.minAgeMs && ageMs <= this.config.maxAgeMs,
      execution: quote.available && Number.isFinite(quote.impactPct)
        && quote.impactPct <= this.config.maxEntryImpactPct,
    };
    // Participation is deliberately a penalty: the audit showed that crowded,
    // monotonically accelerating participation was an overheat/rug-risk marker.
    const featureScore = Number(features.flow) + Number(features.balance)
      + Number(features.structure) + Number(features.execution) - Number(features.participation);
    const featureJson = {
      netFlow: [net1, net2, net3], buyers: [buyers1, buyers2, buyers3],
      buyTx: [tx1, tx2, tx3], buySharePct,
      flowAccel: finite(signal.flowAccel),
      maxWalletFlowSharePct: finite(signal.maxWalletFlowSharePct),
      participationInterpretation: 'OVERHEAT_PENALTY', features,
    };
    const row = {
      signalId: finite(signal.signalId), signalAtMs, mint: signal.mint,
      signalVariant: signal.signalVariant || null, market: signal.market || null,
      ageMs, curvePct, entryMarketPrice,
      entryExecutablePrice: quote.available ? quote.price : null,
      entryImpactPct: finite(quote.impactPct), entryQuoteAvailable: Number(quote.available),
      positionSol: this.config.positionSol,
      tokenUnits: quote.available ? finite(quote.tokenUnits) : null,
      flowFeature: Number(features.flow),
      participationFeature: Number(features.participation),
      balanceFeature: Number(features.balance), structureFeature: Number(features.structure),
      executionFeature: Number(features.execution), featureScore,
      featureJson: JSON.stringify(featureJson), createdAtMs: Date.now(),
    };
    const result = this.statements.insert.run(row);
    const sample = {
      ...row, id: Number(result.lastInsertRowid), features, horizons: {}, horizonLags: {},
      marketContinuity: { entryMarket: row.market, invalidatedAtMs: null, exitMarket: null },
      crossMarketSeen: false, mfe: 0, mae: 0, execMfe: 0, execMae: 0, bnhOpen: false,
    };
    this.pending.set(sample.id, sample);
    if (!this.pendingByMint.has(sample.mint)) this.pendingByMint.set(sample.mint, new Set());
    this.pendingByMint.get(sample.mint).add(sample.id);
    this.lastSampleAt.set(sample.mint, signalAtMs);
    this.metrics.samplesCreated += 1;
    if (quote.available) this.metrics.quoteAvailable += 1;
    else this.metrics.quoteMissing += 1;
    this.metrics.lastSignalAt = signalAtMs;
    this._maybeOpenBnh(sample);
    return sample;
  }

  _maybeOpenBnh(sample) {
    const eligible = this.config.bnhEnabled
      && sample.market === 'PUMP_BONDING_CURVE'
      && sample.features.balance && !sample.features.participation
      && sample.features.structure && sample.features.execution
      && sample.ageMs >= this.config.bnhMinAgeMs && sample.ageMs <= this.config.bnhMaxAgeMs
      && sample.curvePct >= this.config.bnhMinCurvePct
      && sample.curvePct <= this.config.bnhMaxCurvePct
      && sample.entryExecutablePrice > 0 && sample.tokenUnits > 0;
    if (!eligible) return;
    const inserted = this.statements.insertBnh.run({
      observationId: sample.id, profileId: BNH_PROFILE_ID,
      signalAtMs: sample.signalAtMs, mint: sample.mint, market: sample.market,
      ageMs: sample.ageMs, curvePct: sample.curvePct,
      entryPrice: sample.entryExecutablePrice, entryImpactPct: sample.entryImpactPct,
      positionSol: sample.positionSol, tokenUnits: sample.tokenUnits,
      holdMs: this.config.bnhHoldMs,
      roundTripCostPct: this.config.bnhRoundTripCostPct, createdAtMs: Date.now(),
    });
    sample.bnhOpen = inserted.changes > 0;
    if (sample.bnhOpen) this.metrics.bnhOpened += 1;
  }

  observeTrade(trade = {}) {
    if (!this.config.enabled || !trade.mint) return 0;
    const ids = this.pendingByMint.get(trade.mint);
    if (!ids?.size) return 0;
    const timestampMs = finite(trade.timestampMs);
    const price = finite(trade.price);
    if (!(timestampMs > 0) || !(price > 0)) return 0;
    let updated = 0;
    for (const id of [...ids]) {
      const sample = this.pending.get(id);
      if (!sample || timestampMs < sample.signalAtMs) continue;
      const elapsedMs = timestampMs - sample.signalAtMs;
      if (sample.market && trade.market && trade.market !== sample.market) {
        if (!sample.crossMarketSeen) {
          sample.crossMarketSeen = true;
          sample.marketContinuity.invalidatedAtMs = timestampMs;
          sample.marketContinuity.exitMarket = trade.market;
          this.metrics.crossMarketInvalidated += 1;
          if (sample.bnhOpen) this._closeBnh(sample, {
            status: 'NO_EXIT', exitAtMs: timestampMs,
            missingExitReason: 'MARKET_TRANSITION_BEFORE_SAME_VENUE_EXIT',
          });
        }
        updated += 1;
        continue;
      }
      const markReturnPct = (price / sample.entryMarketPrice - 1) * 100;
      sample.mfe = Math.max(sample.mfe, markReturnPct);
      sample.mae = Math.min(sample.mae, markReturnPct);
      let executableReturnPct = null;
      if (sample.tokenUnits > 0) {
        const exit = executableSell(trade, sample.tokenUnits, price, { rugMarkReturnPct: markReturnPct });
        if (Number.isFinite(exit.proceedsSol)) {
          executableReturnPct = (exit.proceedsSol / sample.positionSol - 1) * 100;
          sample.execMfe = Math.max(sample.execMfe, executableReturnPct);
          sample.execMae = Math.min(sample.execMae, executableReturnPct);
        }
      }
      for (const seconds of HORIZONS) {
        if (sample.horizons[seconds]) continue;
        const targetMs = seconds * 1_000;
        if (elapsedMs < targetMs) continue;
        const lagMs = elapsedMs - targetMs;
        if (lagMs <= this.config.maxObservationLagMs) {
          sample.horizons[seconds] = { markReturnPct, executableReturnPct };
          sample.horizonLags[seconds] = lagMs;
        }
      }
      if (sample.bnhOpen && elapsedMs >= this.config.bnhHoldMs) {
        if (elapsedMs - this.config.bnhHoldMs <= this.config.maxObservationLagMs
          && Number.isFinite(executableReturnPct)) {
          this._closeBnh(sample, {
            status: 'CLOSED', exitAtMs: timestampMs, exitPrice: price,
            grossReturnPct: executableReturnPct,
            netReturnPct: executableReturnPct - this.config.bnhRoundTripCostPct,
            exitReason: 'FIXED_120S_SAME_MARKET',
          });
        } else if (elapsedMs - this.config.bnhHoldMs > this.config.maxObservationLagMs) {
          this._closeBnh(sample, {
            status: 'NO_EXIT', exitAtMs: timestampMs,
            missingExitReason: 'NO_TIMELY_SAME_MARKET_EXIT_QUOTE',
          });
        }
      }
      updated += 1;
      if (sample.horizons[300]) this._finalize(sample, 'COMPLETE', null, timestampMs);
    }
    return updated;
  }

  _closeBnh(sample, result) {
    if (!sample.bnhOpen) return;
    this.statements.closeBnh.run({
      observationId: sample.id, status: result.status, exitAtMs: result.exitAtMs || null,
      exitPrice: result.exitPrice ?? null, grossReturnPct: result.grossReturnPct ?? null,
      netReturnPct: result.netReturnPct ?? null,
      mfePct: sample.execMfe - this.config.bnhRoundTripCostPct,
      maePct: sample.execMae - this.config.bnhRoundTripCostPct,
      exitReason: result.exitReason || null,
      missingExitReason: result.missingExitReason || null,
    });
    sample.bnhOpen = false;
    if (result.status === 'CLOSED') this.metrics.bnhClosed += 1;
    else this.metrics.bnhNoExit += 1;
  }

  advanceTime(now = Date.now(), reason = 'OBSERVATION_TIMEOUT') {
    if (!this.config.enabled) return 0;
    let finalized = 0;
    for (const sample of [...this.pending.values()]) {
      if (sample.bnhOpen
        && now - sample.signalAtMs > this.config.bnhHoldMs + this.config.maxObservationLagMs) {
        this._closeBnh(sample, {
          status: 'NO_EXIT', exitAtMs: now,
          missingExitReason: 'NO_TIMELY_SAME_MARKET_EXIT_QUOTE',
        });
      }
      if (now - sample.signalAtMs < 300_000 + this.config.maxObservationLagMs) continue;
      const censorReason = sample.crossMarketSeen ? 'CROSS_MARKET_LABEL_INVALID' : reason;
      this._finalize(sample, 'RIGHT_CENSORED', censorReason, now);
      finalized += 1;
    }
    for (const [mint, timestampMs] of this.lastSampleAt) {
      if (now - timestampMs > this.config.stateRetentionMs) this.lastSampleAt.delete(mint);
    }
    return finalized;
  }

  trackedMints(now = Date.now()) {
    this.advanceTime(now);
    return [...this.pendingByMint.keys()];
  }

  _finalize(sample, labelStatus, censorReason, finalizedAtMs) {
    if (!this.pending.has(sample.id)) return;
    const values = {};
    for (const seconds of HORIZONS) {
      values[`mark${seconds}`] = sample.horizons[seconds]?.markReturnPct ?? null;
      values[`exec${seconds}`] = sample.horizons[seconds]?.executableReturnPct ?? null;
    }
    this.statements.finalize.run({
      id: sample.id, ...values, mfe: sample.mfe, mae: sample.mae,
      execMfe: sample.execMfe, execMae: sample.execMae,
      horizonLagsJson: JSON.stringify(sample.horizonLags),
      marketContinuityJson: JSON.stringify(sample.marketContinuity),
      crossMarketSeen: Number(sample.crossMarketSeen), labelStatus, censorReason,
      finalizedAtMs,
    });
    this.pending.delete(sample.id);
    const ids = this.pendingByMint.get(sample.mint);
    ids?.delete(sample.id);
    if (!ids?.size) this.pendingByMint.delete(sample.mint);
    if (labelStatus === 'COMPLETE') this.metrics.samplesCompleted += 1;
    else this.metrics.samplesCensored += 1;
    this.metrics.lastCompletedAt = finalizedAtMs;
  }

  dashboard({ limit = 2_000 } = {}) {
    if (!this.config.enabled || !this.statements.recent) {
      return {
        summary: this.health(), horizons: [], families: [], scores: [], recent: [],
        bnh: {}, bnhRecent: [],
      };
    }
    const rowLimit = Math.max(100, Math.min(5_000, Number(limit) || 2_000));
    const rows = this.statements.recent.all(rowLimit);
    const horizons = HORIZONS.map((seconds) => {
      const eligible = rows.filter((row) => !row.cross_market_seen);
      return {
        horizonSeconds: seconds,
        coveragePct: rows.length ? eligible.filter((row) => Number.isFinite(
          finite(row[`executable_return_${seconds}s`]),
        )).length / rows.length * 100 : null,
        mark: aggregate(eligible.map((row) => finite(row[`mark_return_${seconds}s`]))),
        executable: aggregate(eligible.map((row) => finite(row[`executable_return_${seconds}s`]))),
      };
    });
    const targetSeconds = 120;
    const targetField = 'executable_return_120s';
    const validRows = rows.filter((row) => !row.cross_market_seen
      && Number.isFinite(finite(row[targetField])));
    const baseline = aggregate(validRows.map((row) => finite(row[targetField])));
    const families = FAMILY_KEYS.map((family) => {
      const column = `${family}_feature`;
      const preferredValue = family === 'participation' ? 0 : 1;
      const preferred = aggregate(validRows.filter((row) => row[column] === preferredValue)
        .map((row) => finite(row[targetField])));
      const opposite = aggregate(validRows.filter((row) => row[column] !== preferredValue)
        .map((row) => finite(row[targetField])));
      return {
        family, horizonSeconds: targetSeconds, preferredValue, ...preferred, opposite,
        averageLiftPct: Number.isFinite(preferred.averagePct) && Number.isFinite(opposite.averagePct)
          ? preferred.averagePct - opposite.averagePct : null,
        winRateLiftPct: Number.isFinite(preferred.winRatePct) && Number.isFinite(opposite.winRatePct)
          ? preferred.winRatePct - opposite.winRatePct : null,
      };
    });
    const scores = [-1, 0, 1, 2, 3, 4].map((score) => ({
      score,
      ...aggregate(validRows.filter((row) => row.feature_score === score)
        .map((row) => finite(row[targetField]))),
    }));
    const bnhRows = this.statements.recentBnh.all(rowLimit);
    const bnhPriced = bnhRows.filter((row) => row.status === 'CLOSED'
      && Number.isFinite(finite(row.net_return_pct)));
    const bnhStats = aggregate(bnhPriced.map((row) => finite(row.net_return_pct)));
    const bnhNoExit = bnhRows.filter((row) => row.status === 'NO_EXIT').length;
    const completed = rows.filter((row) => row.label_status === 'COMPLETE').length;
    const censored = rows.filter((row) => row.label_status !== 'COMPLETE').length;
    return {
      summary: {
        ...this.health(), rowsLoaded: rows.length, targetHorizonSeconds: targetSeconds,
        baseline, completionRatePct: rows.length ? completed / rows.length * 100 : null,
        censorRatePct: rows.length ? censored / rows.length * 100 : null,
        quoteCoveragePct: rows.length
          ? rows.filter((row) => row.entry_quote_available).length / rows.length * 100 : null,
        crossMarketRatePct: rows.length
          ? rows.filter((row) => row.cross_market_seen).length / rows.length * 100 : null,
      },
      horizons,
      families,
      scores,
      bnh: {
        profileId: BNH_PROFILE_ID, holdMs: this.config.bnhHoldMs,
        roundTripCostPct: this.config.bnhRoundTripCostPct,
        signals: bnhRows.length, priced: bnhPriced.length, noExit: bnhNoExit,
        noExitRatePct: bnhRows.length ? bnhNoExit / bnhRows.length * 100 : null,
        ...bnhStats,
        ready: bnhPriced.length >= 1_000 && bnhStats.profitFactor >= 1.3
          && bnhStats.medianPct > 0 && bnhStats.rug50RatePct <= 12,
        readinessRule: '2个独立24h；定价≥1000；PF≥1.3；中位>0；RUG50≤12%',
      },
      bnhRecent: bnhRows.slice(0, 100).map((row) => ({
        signalAtMs: row.signal_at_ms, mint: row.mint, status: row.status,
        ageMs: row.age_ms, curvePct: finite(row.curve_pct),
        entryImpactPct: finite(row.entry_impact_pct), netReturnPct: finite(row.net_return_pct),
        mfePct: finite(row.mfe_pct), maePct: finite(row.mae_pct),
        holdMs: row.hold_ms, reason: row.exit_reason || row.missing_exit_reason,
      })),
      recent: rows.slice(0, 100).map((row) => ({
        id: row.id, signalAtMs: row.signal_at_ms, mint: row.mint,
        signalVariant: row.signal_variant, featureScore: row.feature_score,
        quoteAvailable: Boolean(row.entry_quote_available),
        entryImpactPct: finite(row.entry_impact_pct),
        markReturn120s: finite(row.mark_return_120s),
        executableReturn120s: finite(row.executable_return_120s),
        mfePct: finite(row.mfe_pct), executableMfePct: finite(row.executable_mfe_pct),
        crossMarketSeen: Boolean(row.cross_market_seen), labelStatus: row.label_status,
        censorReason: row.censor_reason,
      })),
    };
  }

  health() {
    return {
      enabled: this.config.enabled, mode: 'FEA-OBS-V2', observerOnly: true,
      sendsTransactions: false, extraRpcCalls: false, simulatesPositions: true,
      labelSchemaVersion: LABEL_SCHEMA_VERSION, observationTable: OBSERVATION_TABLE,
      positionSol: this.config.positionSol, horizonsSeconds: HORIZONS,
      bnhProfileId: BNH_PROFILE_ID, bnhHoldMs: this.config.bnhHoldMs,
      pending: this.pending.size, trackedMints: this.pendingByMint.size, ...this.metrics,
    };
  }
}

module.exports = {
  FeatureEdgeAuditObserver,
  aggregate,
  OBSERVATION_TABLE,
  BNH_TABLE,
  BNH_PROFILE_ID,
};
