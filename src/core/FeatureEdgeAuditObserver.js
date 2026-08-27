'use strict';

const { executableBuy, executableSell } = require('./ShadowExecutionModel');

const HORIZONS = [5, 30, 120, 300];
const FAMILY_KEYS = ['flow', 'participation', 'balance', 'structure', 'execution'];

function finite(value, fallback = null) {
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
  const negative = Math.abs(clean.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    count: clean.length,
    winRatePct: clean.length
      ? clean.filter((value) => value > 0).length / clean.length * 100
      : null,
    averagePct: clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null,
    medianPct: median(clean),
    profitFactor: negative > 0 ? positive / negative : (positive > 0 ? null : 0),
    big50RatePct: clean.length
      ? clean.filter((value) => value >= 50).length / clean.length * 100
      : null,
    rug50RatePct: clean.length
      ? clean.filter((value) => value <= -50).length / clean.length * 100
      : null,
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
      minBuyers: finite(config.minBuyers, 7),
      minBuySharePct: finite(config.minBuySharePct, 70),
      maxEntryImpactPct: finite(config.maxEntryImpactPct, 15),
      minCurvePct: finite(config.minCurvePct, 60),
      maxCurvePct: finite(config.maxCurvePct, 95),
      minAgeMs: finite(config.minAgeMs, 5_000),
      maxAgeMs: finite(config.maxAgeMs, 300_000),
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
      lastSignalAt: null,
      lastCompletedAt: null,
    };
  }

  start() {
    if (!this.config.enabled || !this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feature_edge_audit_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER,
        signal_at_ms INTEGER NOT NULL,
        mint TEXT NOT NULL,
        signal_variant TEXT,
        market TEXT,
        age_ms INTEGER,
        curve_pct REAL,
        entry_market_price REAL NOT NULL,
        entry_executable_price REAL,
        entry_impact_pct REAL,
        entry_quote_available INTEGER NOT NULL DEFAULT 0,
        position_sol REAL NOT NULL,
        token_units REAL,
        flow_feature INTEGER NOT NULL DEFAULT 0,
        participation_feature INTEGER NOT NULL DEFAULT 0,
        balance_feature INTEGER NOT NULL DEFAULT 0,
        structure_feature INTEGER NOT NULL DEFAULT 0,
        execution_feature INTEGER NOT NULL DEFAULT 0,
        feature_score INTEGER NOT NULL DEFAULT 0,
        feature_json TEXT,
        mark_return_5s REAL,
        executable_return_5s REAL,
        mark_return_30s REAL,
        executable_return_30s REAL,
        mark_return_120s REAL,
        executable_return_120s REAL,
        mark_return_300s REAL,
        executable_return_300s REAL,
        mfe_pct REAL NOT NULL DEFAULT 0,
        mae_pct REAL NOT NULL DEFAULT 0,
        executable_mfe_pct REAL NOT NULL DEFAULT 0,
        executable_mae_pct REAL NOT NULL DEFAULT 0,
        horizon_lags_json TEXT,
        label_status TEXT NOT NULL DEFAULT 'PENDING',
        censor_reason TEXT,
        finalized_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feature_edge_audit_signal_at
        ON feature_edge_audit_observations(signal_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_feature_edge_audit_status
        ON feature_edge_audit_observations(label_status, signal_at_ms DESC);
    `);
    this.statements.insert = this.db.prepare(`
      INSERT INTO feature_edge_audit_observations (
        signal_id, signal_at_ms, mint, signal_variant, market, age_ms, curve_pct,
        entry_market_price, entry_executable_price, entry_impact_pct,
        entry_quote_available, position_sol, token_units,
        flow_feature, participation_feature, balance_feature, structure_feature,
        execution_feature, feature_score, feature_json, created_at_ms
      ) VALUES (
        @signalId, @signalAtMs, @mint, @signalVariant, @market, @ageMs, @curvePct,
        @entryMarketPrice, @entryExecutablePrice, @entryImpactPct,
        @entryQuoteAvailable, @positionSol, @tokenUnits,
        @flowFeature, @participationFeature, @balanceFeature, @structureFeature,
        @executionFeature, @featureScore, @featureJson, @createdAtMs
      )
    `);
    this.statements.finalize = this.db.prepare(`
      UPDATE feature_edge_audit_observations SET
        mark_return_5s=@mark5, executable_return_5s=@exec5,
        mark_return_30s=@mark30, executable_return_30s=@exec30,
        mark_return_120s=@mark120, executable_return_120s=@exec120,
        mark_return_300s=@mark300, executable_return_300s=@exec300,
        mfe_pct=@mfe, mae_pct=@mae,
        executable_mfe_pct=@execMfe, executable_mae_pct=@execMae,
        horizon_lags_json=@horizonLagsJson, label_status=@labelStatus,
        censor_reason=@censorReason, finalized_at_ms=@finalizedAtMs
      WHERE id=@id
    `);
    this.statements.recent = this.db.prepare(`
      SELECT * FROM feature_edge_audit_observations
      ORDER BY signal_at_ms DESC LIMIT ?
    `);
  }

  stop() {
    this.advanceTime(Date.now() + this.config.stateRetentionMs, 'PROCESS_STOP');
  }

  onSignal(signal = {}) {
    if (!this.config.enabled || !this.statements.insert) return null;
    this.metrics.signalsEvaluated += 1;
    const signalAtMs = finite(signal.timestampMs);
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
      flow: net3 >= this.config.minNetFlowSol && net3 > net2 && net2 >= net1,
      participation: buyers3 >= this.config.minBuyers && buyers3 > buyers2
        && tx3 > tx2 && buyers2 >= buyers1 && tx2 >= tx1,
      balance: Number.isFinite(buySharePct) && buySharePct >= this.config.minBuySharePct,
      structure: Number.isFinite(curvePct) && curvePct >= this.config.minCurvePct
        && curvePct <= this.config.maxCurvePct && Number.isFinite(ageMs)
        && ageMs >= this.config.minAgeMs && ageMs <= this.config.maxAgeMs,
      execution: quote.available && Number.isFinite(quote.impactPct)
        && quote.impactPct <= this.config.maxEntryImpactPct,
    };
    const featureScore = FAMILY_KEYS.filter((key) => features[key]).length;
    const featureJson = {
      netFlow: [net1, net2, net3],
      buyers: [buyers1, buyers2, buyers3],
      buyTx: [tx1, tx2, tx3],
      buySharePct,
      flowAccel: finite(signal.flowAccel),
      maxWalletFlowSharePct: finite(signal.maxWalletFlowSharePct),
      features,
    };
    const row = {
      signalId: finite(signal.signalId),
      signalAtMs,
      mint: signal.mint,
      signalVariant: signal.signalVariant || null,
      market: signal.market || null,
      ageMs,
      curvePct,
      entryMarketPrice,
      entryExecutablePrice: quote.available ? quote.price : null,
      entryImpactPct: finite(quote.impactPct),
      entryQuoteAvailable: Number(quote.available),
      positionSol: this.config.positionSol,
      tokenUnits: quote.available ? finite(quote.tokenUnits) : null,
      flowFeature: Number(features.flow),
      participationFeature: Number(features.participation),
      balanceFeature: Number(features.balance),
      structureFeature: Number(features.structure),
      executionFeature: Number(features.execution),
      featureScore,
      featureJson: JSON.stringify(featureJson),
      createdAtMs: Date.now(),
    };
    const result = this.statements.insert.run(row);
    const sample = {
      ...row,
      id: Number(result.lastInsertRowid),
      features,
      horizons: {},
      horizonLags: {},
      mfe: 0,
      mae: 0,
      execMfe: 0,
      execMae: 0,
    };
    this.pending.set(sample.id, sample);
    if (!this.pendingByMint.has(sample.mint)) this.pendingByMint.set(sample.mint, new Set());
    this.pendingByMint.get(sample.mint).add(sample.id);
    this.lastSampleAt.set(sample.mint, signalAtMs);
    this.metrics.samplesCreated += 1;
    if (quote.available) this.metrics.quoteAvailable += 1;
    else this.metrics.quoteMissing += 1;
    this.metrics.lastSignalAt = signalAtMs;
    return sample;
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
      const markReturnPct = (price / sample.entryMarketPrice - 1) * 100;
      sample.mfe = Math.max(sample.mfe, markReturnPct);
      sample.mae = Math.min(sample.mae, markReturnPct);
      let executableReturnPct = null;
      if (sample.tokenUnits > 0) {
        const exit = executableSell(trade, sample.tokenUnits, price, {
          rugMarkReturnPct: markReturnPct,
        });
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
      updated += 1;
      if (sample.horizons[300]) this._finalize(sample, 'COMPLETE', null, timestampMs);
    }
    return updated;
  }

  advanceTime(now = Date.now(), reason = 'OBSERVATION_TIMEOUT') {
    if (!this.config.enabled) return 0;
    let finalized = 0;
    for (const sample of [...this.pending.values()]) {
      if (now - sample.signalAtMs < 300_000 + this.config.maxObservationLagMs) continue;
      this._finalize(sample, 'RIGHT_CENSORED', reason, now);
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
      id: sample.id,
      ...values,
      mfe: sample.mfe,
      mae: sample.mae,
      execMfe: sample.execMfe,
      execMae: sample.execMae,
      horizonLagsJson: JSON.stringify(sample.horizonLags),
      labelStatus,
      censorReason,
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
      return { summary: this.health(), horizons: [], families: [], scores: [], recent: [] };
    }
    const rows = this.statements.recent.all(Math.max(100, Math.min(5_000, Number(limit) || 2_000)));
    const horizons = HORIZONS.map((seconds) => ({
      horizonSeconds: seconds,
      mark: aggregate(rows.map((row) => finite(row[`mark_return_${seconds}s`]))),
      executable: aggregate(rows.map((row) => finite(row[`executable_return_${seconds}s`]))),
    }));
    const targetSeconds = rows.some((row) => Number.isFinite(finite(row.executable_return_300s)))
      ? 300 : 120;
    const targetField = `executable_return_${targetSeconds}s`;
    const baseline = aggregate(rows.map((row) => finite(row[targetField])));
    const families = FAMILY_KEYS.map((family) => {
      const column = `${family}_feature`;
      const stats = aggregate(rows.filter((row) => row[column] === 1)
        .map((row) => finite(row[targetField])));
      return {
        family,
        horizonSeconds: targetSeconds,
        ...stats,
        averageLiftPct: Number.isFinite(stats.averagePct) && Number.isFinite(baseline.averagePct)
          ? stats.averagePct - baseline.averagePct : null,
        winRateLiftPct: Number.isFinite(stats.winRatePct) && Number.isFinite(baseline.winRatePct)
          ? stats.winRatePct - baseline.winRatePct : null,
      };
    });
    const scores = [0, 1, 2, 3, 4, 5].map((score) => ({
      score,
      ...aggregate(rows.filter((row) => row.feature_score === score)
        .map((row) => finite(row[targetField]))),
    }));
    return {
      summary: {
        ...this.health(),
        rowsLoaded: rows.length,
        targetHorizonSeconds: targetSeconds,
        baseline,
      },
      horizons,
      families,
      scores,
      recent: rows.slice(0, 100).map((row) => ({
        id: row.id,
        signalAtMs: row.signal_at_ms,
        mint: row.mint,
        signalVariant: row.signal_variant,
        featureScore: row.feature_score,
        quoteAvailable: Boolean(row.entry_quote_available),
        entryImpactPct: finite(row.entry_impact_pct),
        markReturn300s: finite(row.mark_return_300s),
        executableReturn300s: finite(row.executable_return_300s),
        mfePct: finite(row.mfe_pct),
        executableMfePct: finite(row.executable_mfe_pct),
        labelStatus: row.label_status,
        censorReason: row.censor_reason,
      })),
    };
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'FEA-OBS',
      observerOnly: true,
      sendsTransactions: false,
      extraRpcCalls: false,
      positionSol: this.config.positionSol,
      horizonsSeconds: HORIZONS,
      pending: this.pending.size,
      trackedMints: this.pendingByMint.size,
      ...this.metrics,
    };
  }
}

module.exports = { FeatureEdgeAuditObserver, aggregate };
