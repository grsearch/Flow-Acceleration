'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  executableBuy,
  reservesForTrade,
  simulateSellSequence,
} = require('./ShadowExecutionModel');

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tradePrice(trade) {
  // Reserve price is the least distorted public mark for comparing adjacent
  // trades; fall back to the execution/derived prices when it is unavailable.
  for (const value of [trade?.reservePrice, trade?.price, trade?.priceSolPerToken, trade?.curvePrice]) {
    const number = finite(value);
    if (number > 0) return number;
  }
  return null;
}

function beijingHour(timestampMs) {
  return new Date(timestampMs + (8 * 60 * 60 * 1_000)).getUTCHours();
}

function hourInWindow(hour, startHour, endHour) {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

const FIRST_CLIFF_LIFECYCLE_STAGES = Object.freeze([
  { id: 'LAUNCH', label: '发射 0–5 秒' },
  { id: 'CURVE_EARLY', label: 'Curve 5–30 秒' },
  { id: 'CURVE_LATE', label: 'Curve 30 秒后' },
  { id: 'CURVE_MIGRATION', label: 'Curve 80%–迁移' },
  { id: 'AMM_EARLY', label: 'PumpSwap 0–10 秒' },
  { id: 'AMM_MATURE', label: 'PumpSwap 10 秒后' },
]);

function firstCliffCounterRow() {
  return {
    firstCliffStageCandidateMatched: 0,
    firstCliffStageCandidateResolved: 0,
    firstCliffStageCandidateCaught: 0,
    firstCliffStageCandidateNoCliff30s: 0,
    firstCliffStageCandidateReturnSumPct: 0,
    firstCliffStageCandidateReturnSamples: 0,
    firstCliffHc1Matched: 0,
    firstCliffHc2Matched: 0,
    firstCliffHc1Resolved: 0,
    firstCliffHc2Resolved: 0,
    firstCliffHc1Caught: 0,
    firstCliffHc2Caught: 0,
    firstCliffHc1NoCliff30s: 0,
    firstCliffHc2NoCliff30s: 0,
    firstCliffHc1ReturnSumPct: 0,
    firstCliffHc2ReturnSumPct: 0,
    firstCliffHc1ReturnSamples: 0,
    firstCliffHc2ReturnSamples: 0,
  };
}

class PreEntryRugRiskTracker {
  constructor({ config, store = null, now = () => Date.now(), fileSystem = fs }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.fileSystem = fileSystem;
    this.states = new Map();
    // Cross-Mint toxic-template decisions are deliberately process-memory only.
    // A tiny snapshot is restored at startup and saved asynchronously, while
    // the hot entry path never waits for SQLite, disk, RPC or another service.
    // The first observed collapse remains unavoidable; later copies can be
    // rejected even when they contain fewer than minTrades.
    this.toxicWallets = new Map();
    this.toxicTemplates = new Map();
    this.toxicTemplateIndex = new Map();
    this.toxicVersion = 0;
    this.toxicMemoryDirty = false;
    this.toxicPersistTimer = null;
    this.toxicPersistPromise = null;
    this.guardStrategies = new Map();
    this.recentGuardDecisions = [];
    this.recentCliffOutcomes = [];
    this.recentDumpabilityWarnings = [];
    // Forward-only paired audit for the first-cliff heuristics. Candidates are
    // registered only after the existing guard has passed, so these counters
    // answer whether HC1/HC2 would improve every live/Shadow strategy without
    // changing, delaying or blocking its current entry path.
    this.firstCliffPendingByMint = new Map();
    this.firstCliffCandidateKeys = new Map();
    this.firstCliffPendingCount = 0;
    this.recentFirstCliffCounterfactuals = [];
    this.firstCliffAuditQueue = [];
    this.firstCliffAuditTimer = null;
    this.lastSweepAt = 0;
    this.metrics = {
      observedTrades: 0,
      evaluations: 0,
      sampleReady: 0,
      flagged: 0,
      flaggedLegacy: 0,
      flaggedVerticalFragile: 0,
      flaggedSparseBreadth: 0,
      flaggedChaseRepeatedSize: 0,
      flaggedBeijingRiskWindow: 0,
      toxicCollapsesLabeled: 0,
      toxicWalletsLearned: 0,
      toxicTemplatesLearned: 0,
      toxicMemoryLoaded: 0,
      toxicMemorySaved: 0,
      toxicMemoryLoadErrors: 0,
      toxicMemorySaveErrors: 0,
      toxicHistoryPersisted: 0,
      toxicHistoryErrors: 0,
      toxicFuzzyMatches: 0,
      flaggedCrossMintWallets: 0,
      flaggedCrossMintTemplates: 0,
      flaggedExtremeDumpability: 0,
      cliffCandidates: 0,
      cliffConfirmed: 0,
      cliffPairedArtifactsIgnored: 0,
      cliffRecoveredBeforeConfirm: 0,
      cliffRug70: 0,
      cliffRug80: 0,
      slowRug30: 0,
      dumpabilityEvaluations: 0,
      dumpabilitySampleReady: 0,
      dumpabilityWarnings: 0,
      firstCliffCandidates: 0,
      firstCliffHc1Matched: 0,
      firstCliffHc2Matched: 0,
      firstCliffStageCandidateMatched: 0,
      firstCliffResolved: 0,
      firstCliffCaught: 0,
      firstCliffNoCliff30s: 0,
      firstCliffCensored: 0,
      firstCliffAuditsPersisted: 0,
      firstCliffAuditErrors: 0,
      guardEvaluations: 0,
      guardPassed: 0,
      guardRejected: 0,
      guardRiskFlagged: 0,
      guardHardBlocked: 0,
      guardLabelOnly: 0,
      guardSampleInsufficient: 0,
      guardCrossMintRejected: 0,
      guardExtremeDumpabilityRejected: 0,
      liveCacheHits: 0,
      liveCacheMisses: 0,
      lastActionAt: null,
      lastError: null,
    };
  }

  start() {
    if (this.config.crossMintEnabled !== false) {
      this._loadToxicMemory();
      const intervalMs = this._cfg('toxicPersistIntervalMs', 5_000);
      this.toxicPersistTimer = setInterval(() => {
        this._persistToxicMemory().catch(() => {});
      }, intervalMs);
      this.toxicPersistTimer.unref?.();
    }
    if (this._cfg('firstCliffCounterfactualEnabled', true) !== false
      && typeof this.store?.recordPreEntryRugFirstCliffAudits === 'function') {
      const intervalMs = this._cfg('firstCliffAuditFlushMs', 1_000);
      this.firstCliffAuditTimer = setInterval(() => {
        // Resolve expired observations even when a Mint stops trading. This
        // keeps the fixed 24h acceptance window terminal instead of leaving a
        // growing PENDING tail that would invite another tuning cycle.
        this._sweepFirstCliffCounterfactuals(this.now());
        this._flushFirstCliffAudits();
      }, intervalMs);
      this.firstCliffAuditTimer.unref?.();
    }
  }

  stop() {
    if (this.toxicPersistTimer) clearInterval(this.toxicPersistTimer);
    this.toxicPersistTimer = null;
    if (this.firstCliffAuditTimer) clearInterval(this.firstCliffAuditTimer);
    this.firstCliffAuditTimer = null;
    this._flushFirstCliffAudits();
    this._persistToxicMemorySync();
    this.states.clear();
    this.toxicWallets.clear();
    this.toxicTemplates.clear();
    this.toxicTemplateIndex.clear();
    this.guardStrategies.clear();
    this.recentGuardDecisions = [];
    this.recentCliffOutcomes = [];
    this.recentDumpabilityWarnings = [];
    this.firstCliffPendingByMint.clear();
    this.firstCliffCandidateKeys.clear();
    this.firstCliffPendingCount = 0;
    this.recentFirstCliffCounterfactuals = [];
    this.firstCliffAuditQueue = [];
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint || !['BUY', 'SELL'].includes(trade.side)) return;
    const timestampMs = finite(trade.timestampMs);
    const price = tradePrice(trade);
    if (!(timestampMs > 0) || !(price > 0)) return;
    let state = this.states.get(trade.mint);
    if (!state) {
      state = {
        mint: trade.mint,
        events: [], offset: 0, lastAt: timestampMs, version: 0,
        firstSeenAt: timestampMs, firstBondingAt: null, firstAmmAt: null,
        lastCurvePct: null,
        cachedVersion: -1, cachedToxicVersion: -1, cachedRisk: null,
        peakPrice: price, peakAt: timestampMs, template: null,
        templatePeakPrice: null, templateToxicLabeled: false,
        cliffCandidate: null, confirmedCliffs: [], slowRugLabel: null,
        lastTrade: null, lastDumpabilityVersion: -1,
      };
      this.states.set(trade.mint, state);
    }
    const market = String(trade.market || '');
    if (market === 'PUMP_BONDING_CURVE' && !(state.firstBondingAt > 0)) {
      state.firstBondingAt = timestampMs;
    }
    if (market === 'PUMP_AMM' && !(state.firstAmmAt > 0)) state.firstAmmAt = timestampMs;
    const curvePct = finite(trade.curvePct);
    if (curvePct != null) state.lastCurvePct = curvePct;
    state.events.push({
      timestampMs,
      side: trade.side,
      price,
      wallet: String(trade.wallet || ''),
      solAmount: finite(trade.solAmount, 0),
      tokenAmount: finite(trade.tokenAmount, 0),
      market,
      signature: String(trade.signature || ''),
      slot: finite(trade.slot),
      ageMs: finite(trade.ageMs),
      curvePct,
    });
    state.lastTrade = this._capacityTrade(trade);
    state.version += 1;
    state.lastAt = Math.max(state.lastAt, timestampMs);
    if (!(state.peakPrice > 0) || price > state.peakPrice) {
      state.peakPrice = price;
      state.peakAt = timestampMs;
    }
    this._prune(state, timestampMs);
    if (state.events.length - state.offset > this.config.maxEventsPerMint) {
      state.offset = state.events.length - this.config.maxEventsPerMint;
      this._compact(state);
    }
    if (this.config.crossMintEnabled !== false) {
      this._refreshCrossMintTemplate(state, timestampMs, price);
      this._labelRapidCollapse(trade.mint, state, timestampMs, price);
    }
    this._observeRugPath(trade.mint, state, state.events[state.events.length - 1]);
    this._resolveFirstCliffCounterfactuals(
      trade.mint, state, state.events[state.events.length - 1],
    );
    const activePath = this._activeRugPath(state, timestampMs, price);
    if (activePath) trade.rugPath = activePath;
    this.metrics.observedTrades += 1;
    this.metrics.lastActionAt = this.now();
  }

  snapshot(mint, timestampMs = this.now()) {
    const state = this.states.get(mint);
    if (!state) return this._empty(timestampMs);
    if (state.cachedRisk && state.cachedVersion === state.version
      && state.cachedToxicVersion === this.toxicVersion
      && Math.abs(timestampMs - state.cachedRisk.observedAt) <= this.config.cacheMaxAgeMs) {
      this.metrics.evaluations += 1;
      if (state.cachedRisk.sampleReady) this.metrics.sampleReady += 1;
      if (state.cachedRisk.flagged) {
        this.metrics.flagged += 1;
        this._recordSignatureMetrics(state.cachedRisk);
      }
      return state.cachedRisk;
    }
    this._prune(state, timestampMs);
    const cutoff = timestampMs - this.config.windowMs;
    const rows = state.events.slice(state.offset).filter((row) => (
      row.timestampMs >= cutoff && row.timestampMs <= timestampMs
    ));
    if (!rows.length) return this._empty(timestampMs);
    let buys = 0;
    let alternations = 0;
    let upticks = 0;
    let priceComparisons = 0;
    let consecutiveBuys = 0;
    let maxConsecutiveBuys = 0;
    let maxBuyImpactPct = 0;
    const buyerTradeCounts = new Map();
    const buySizeCounts = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.side === 'BUY') {
        buys += 1;
        consecutiveBuys += 1;
        maxConsecutiveBuys = Math.max(maxConsecutiveBuys, consecutiveBuys);
        if (row.wallet) {
          buyerTradeCounts.set(row.wallet, (buyerTradeCounts.get(row.wallet) || 0) + 1);
        }
        if (row.solAmount > 0) {
          const sizeKey = row.solAmount.toFixed(3);
          buySizeCounts.set(sizeKey, (buySizeCounts.get(sizeKey) || 0) + 1);
        }
      } else consecutiveBuys = 0;
      if (index === 0) continue;
      const previous = rows[index - 1];
      if (row.side !== previous.side) alternations += 1;
      if (row.price !== previous.price) {
        priceComparisons += 1;
        if (row.price > previous.price) upticks += 1;
      }
      if (row.side === 'BUY' && previous.price > 0 && row.price > previous.price) {
        maxBuyImpactPct = Math.max(maxBuyImpactPct, (row.price / previous.price - 1) * 100);
      }
    }
    const buySharePct = buys / rows.length * 100;
    const sideAlternationPct = rows.length > 1 ? alternations / (rows.length - 1) * 100 : 0;
    const upTickSharePct = priceComparisons > 0 ? upticks / priceComparisons * 100 : 0;
    const returnPct = rows[0].price > 0 ? ((rows[rows.length - 1].price / rows[0].price) - 1) * 100 : 0;
    const uniqueBuyers = buyerTradeCounts.size;
    const maxWalletBuyTrades = buyerTradeCounts.size
      ? Math.max(...buyerTradeCounts.values()) : 0;
    const repeatedBuySizeTrades = buySizeCounts.size
      ? Math.max(...buySizeCounts.values()) : 0;
    const buysPerBuyer = uniqueBuyers > 0 ? buys / uniqueBuyers : null;
    const maxWalletBuyTxSharePct = buys > 0 ? maxWalletBuyTrades / buys * 100 : null;
    const repeatedBuySizeSharePct = buys > 0 ? repeatedBuySizeTrades / buys * 100 : null;
    const dumpability = this._dumpabilitySnapshot(state, rows, timestampMs);
    const firstCliffCounterfactual = this._firstCliffCounterfactualSnapshot(
      state, rows, dumpability, timestampMs,
    );
    const rugPath = this._activeRugPath(state, timestampMs, rows[rows.length - 1].price);
    const template = state.template
      && timestampMs - state.template.observedAt <= this._cfg('toxicCollapseWindowMs', 30_000)
      ? state.template : null;
    const toxicWalletOverlap = template
      ? this._toxicWalletOverlap(template.wallets, timestampMs) : 0;
    const toxicTemplateMatch = template
      ? this._activeToxicTemplate(template, timestampMs) : null;
    const crossMintToxicWallets = toxicWalletOverlap
      >= this._cfg('toxicWalletOverlapMin', 2);
    const crossMintToxicTemplate = Boolean(toxicTemplateMatch);
    const extremeCoordinatedDumpability = Boolean(
      this._cfg('extremeDumpabilityEnabled', true) !== false
      && template
      && template.largeBuyCount >= this._cfg('templateMinLargeBuys', 4)
      && template.totalBuySol >= this._cfg('templateMinTotalBuySol', 40)
      && template.burstSpanMs <= this._cfg('templateMaxBurstSpanMs', 500)
      && finite(dumpability?.observedWallets, 0)
        >= this._cfg('extremeDumpabilityMinObservedWallets', 4)
      && finite(dumpability?.top3ObservedSharePct, -1)
        >= this._cfg('extremeDumpabilityTop3ObservedSharePct', 70)
      && finite(dumpability?.top3RecoveryPct, 101)
        <= this._cfg('extremeDumpabilityTop3RecoveryMaxPct', 20)
    );
    const checks = {
      buyShare: buySharePct >= this.config.minBuySharePct,
      consecutiveBuys: maxConsecutiveBuys >= this.config.minConsecutiveBuys,
      lowAlternation: sideAlternationPct <= this.config.maxSideAlternationPct,
      upticks: upTickSharePct >= this.config.minUpTickSharePct,
      priceRunup: returnPct >= this.config.minReturnPct,
    };
    const score = Object.values(checks).filter(Boolean).length;
    const sampleReady = rows.length >= this.config.minTrades;
    const hour = beijingHour(timestampMs);
    const beijingRiskWindow = this.config.beijingRiskWindowEnabled && hourInWindow(
      hour,
      this.config.beijingRiskStartHour,
      this.config.beijingRiskEndHour,
    );
    const legacyMinFlags = beijingRiskWindow
      ? Math.min(this.config.minFlags, this.config.beijingRiskMinFlags)
      : this.config.minFlags;
    const signatures = {
      legacyStairStep: score >= legacyMinFlags,
      verticalFragileReuse: returnPct >= this.config.verticalFragileMinReturnPct
        && maxBuyImpactPct >= this.config.verticalFragileMinBuyImpactPct
        && maxWalletBuyTxSharePct != null
        && maxWalletBuyTxSharePct >= this.config.verticalFragileMinWalletTxSharePct,
      sparseBuyerBreadth: buysPerBuyer != null
        && buysPerBuyer >= this.config.sparseBreadthMinBuysPerBuyer,
      chaseRepeatedSize: returnPct >= this.config.chaseRepeatedMinReturnPct
        && repeatedBuySizeSharePct != null
        && repeatedBuySizeSharePct >= this.config.chaseRepeatedMinSizeSharePct,
      crossMintToxicWallets,
      crossMintToxicTemplate,
      extremeCoordinatedDumpability,
    };
    const flaggedReasons = Object.entries(signatures)
      .filter(([, matched]) => matched)
      .map(([name]) => name);
    const nativeFlagged = sampleReady && Object.entries(signatures)
      .some(([name, matched]) => !name.startsWith('crossMint')
        && name !== 'extremeCoordinatedDumpability' && matched);
    const crossMintToxic = crossMintToxicWallets || crossMintToxicTemplate;
    const flagged = nativeFlagged || crossMintToxic || extremeCoordinatedDumpability;
    this.metrics.evaluations += 1;
    if (sampleReady) this.metrics.sampleReady += 1;
    if (flagged) {
      this.metrics.flagged += 1;
    }
    const risk = {
      observedAt: timestampMs,
      windowMs: this.config.windowMs,
      sampleSize: rows.length,
      sampleReady,
      flagged,
      score,
      maxScore: Object.keys(checks).length,
      legacyMinFlags,
      beijingHour: hour,
      beijingRiskWindow,
      buySharePct,
      maxConsecutiveBuys,
      sideAlternationPct,
      upTickSharePct,
      returnPct,
      uniqueBuyers,
      buysPerBuyer,
      maxWalletBuyTxSharePct,
      repeatedBuySizeSharePct,
      maxBuyImpactPct,
      lastPrice: rows[rows.length - 1]?.price || null,
      crossMintToxic,
      extremeCoordinatedDumpability,
      toxicWalletOverlap,
      toxicTemplateMatch: toxicTemplateMatch?.fingerprint || null,
      templateFingerprint: template?.fingerprint || null,
      templateLargeBuyCount: template?.largeBuyCount || 0,
      templateBuySol: template?.totalBuySol || null,
      templateBurstSpanMs: template?.burstSpanMs || null,
      checks,
      signatures,
      flaggedReasons,
      rugPath,
      dumpability,
      firstCliffCounterfactual,
      researchWarnings: dumpability?.warnings || [],
    };
    if (flagged) this._recordSignatureMetrics(risk);
    state.cachedRisk = risk;
    state.cachedVersion = state.version;
    state.cachedToxicVersion = this.toxicVersion;
    return risk;
  }

  evaluateGuard({
    strategyId,
    mint,
    timestampMs = this.now(),
    source = 'SHADOW',
    market = null,
    lifecycleStage = null,
    lifecycleAgeMs = null,
    enforcementMode = 'HARD_BLOCK',
    policyReason = 'TRACKER_DEFAULT_HARD_BLOCK',
    requireHc2 = false,
    hardBlockSignatures = null,
  }) {
    const normalizedStrategyId = String(strategyId || 'UNKNOWN');
    const normalizedSource = String(source || 'SHADOW').toUpperCase();
    let risk;
    if (normalizedSource === 'LIVE') {
      const state = this.states.get(mint);
      const cached = state?.cachedRisk;
      if (cached && state.cachedVersion === state.version
        && state.cachedToxicVersion === this.toxicVersion
        && Math.abs(timestampMs - cached.observedAt) <= this.config.cacheMaxAgeMs) {
        risk = cached;
        this.metrics.liveCacheHits += 1;
      } else {
        // Refresh only from the bounded in-memory ring (<= maxEventsPerMint).
        // This keeps enforcement current without RPC, SQLite or network I/O.
        risk = this.snapshot(mint, timestampMs);
        this.metrics.liveCacheMisses += 1;
      }
    } else risk = this.snapshot(mint, timestampMs);
    const riskFlagged = Boolean(this.config.enabled && risk.flagged);
    const hc2Matched = Boolean(risk.firstCliffCounterfactual?.hc2Matched);
    const selectiveHardBlock = Array.isArray(hardBlockSignatures);
    const matchedHardBlockSignatures = selectiveHardBlock
      ? hardBlockSignatures.filter((name) => Boolean(risk.signatures?.[name]))
      : [];
    const hardBlockSignatureMatched = !selectiveHardBlock
      || matchedHardBlockSignatures.length > 0;
    const blocked = Boolean(riskFlagged
      && enforcementMode === 'HARD_BLOCK'
      && hardBlockSignatureMatched
      && (!requireHc2 || hc2Matched));
    const stats = this.guardStrategies.get(normalizedStrategyId) || {
      strategyId: normalizedStrategyId,
      source: normalizedSource,
      evaluated: 0,
      sampleReady: 0,
      sampleInsufficient: 0,
      passed: 0,
      rejected: 0,
      riskFlagged: 0,
      hardBlocked: 0,
      labelOnly: 0,
      lastEvaluatedAt: null,
      lastRejectedAt: null,
      lastFlaggedAt: null,
    };
    this._initializeFirstCliffStrategyStats(stats);
    stats.enforcementMode = stats.enforcementMode && stats.enforcementMode !== enforcementMode
      ? 'MIXED'
      : enforcementMode;
    stats.policyReason = stats.policyReason && stats.policyReason !== policyReason
      ? 'MULTIPLE_LIFECYCLE_POLICIES'
      : policyReason;
    stats.market = market;
    stats.lifecycleStage = lifecycleStage;
    stats.lifecycleAgeMs = lifecycleAgeMs;
    stats.requireHc2 = Boolean(requireHc2);
    stats.hardBlockSignatures = selectiveHardBlock ? [...hardBlockSignatures] : null;
    stats.evaluated += 1;
    stats.lastEvaluatedAt = timestampMs;
    if (risk.sampleReady) stats.sampleReady += 1;
    else stats.sampleInsufficient += 1;
    if (riskFlagged) {
      stats.riskFlagged += 1;
      stats.lastFlaggedAt = timestampMs;
    }
    if (blocked) {
      stats.rejected += 1;
      stats.hardBlocked += 1;
      stats.lastRejectedAt = timestampMs;
    } else {
      stats.passed += 1;
      if (riskFlagged) stats.labelOnly += 1;
    }
    this.guardStrategies.set(normalizedStrategyId, stats);

    this.metrics.guardEvaluations += 1;
    if (!blocked) this.metrics.guardPassed += 1;
    if (riskFlagged) this.metrics.guardRiskFlagged += 1;
    if (blocked) this.metrics.guardHardBlocked += 1;
    if (riskFlagged && !blocked) this.metrics.guardLabelOnly += 1;
    if (!risk.sampleReady) this.metrics.guardSampleInsufficient += 1;
    if (blocked) this.metrics.guardRejected += 1;
    if (blocked && risk.crossMintToxic) this.metrics.guardCrossMintRejected += 1;
    if (blocked && risk.extremeCoordinatedDumpability) {
      this.metrics.guardExtremeDumpabilityRejected += 1;
    }

    let decisionReason;
    if (blocked && risk.crossMintToxic) decisionReason = 'PRE_ENTRY_RUG_CROSS_MINT_TOXIC';
    else if (blocked && risk.extremeCoordinatedDumpability) {
      decisionReason = 'PRE_ENTRY_RUG_EXTREME_DUMPABILITY';
    } else if (blocked) decisionReason = 'PRE_ENTRY_RUG_RISK';
    else if (riskFlagged) decisionReason = selectiveHardBlock
      ? 'RUG_RISK_NOT_IN_HARD_BLOCK_SIGNATURES' : 'RUG_RISK_LABEL_ONLY';
    else decisionReason = risk.sampleReady ? 'RUG_GUARD_PASS' : 'RUG_GUARD_SAMPLE_INSUFFICIENT';

    const decision = {
      strategyId: normalizedStrategyId,
      source: normalizedSource,
      mint,
      observedAt: timestampMs,
      enforcementMode,
      policyReason,
      market,
      lifecycleStage,
      lifecycleAgeMs,
      requireHc2: Boolean(requireHc2),
      hardBlockSignatures: selectiveHardBlock ? [...hardBlockSignatures] : null,
      matchedHardBlockSignatures,
      hc2Matched,
      riskFlagged,
      blocked,
      reason: decisionReason,
      ...risk,
    };
    if (riskFlagged) {
      this.recentGuardDecisions.unshift(decision);
      if (this.recentGuardDecisions.length > 100) this.recentGuardDecisions.length = 100;
    }
    if (!blocked) this._registerFirstCliffCounterfactual({
      strategyId: normalizedStrategyId,
      source: normalizedSource,
      mint,
      timestampMs,
      risk,
      stats,
    });
    return decision;
  }

  classifyOutcome(mint, entryPrice, entryAt, observedAt = this.now()) {
    const state = this.states.get(mint);
    const entry = finite(entryPrice);
    const enteredAt = finite(entryAt, 0);
    if (!state || !(entry > 0)) return null;
    const cliff = state.confirmedCliffs.find((row) => row.confirmedAt >= enteredAt);
    if (cliff) {
      const returnPct = ((cliff.persistedPrice / entry) - 1) * 100;
      const kind = returnPct <= -80
        ? 'CLIFF_RUG_80' : (returnPct <= -70 ? 'CLIFF_RUG_70' : 'CLIFF_DROP_50');
      return { ...cliff, kind, entryPrice: entry, entryAt: enteredAt, returnPct, observedAt };
    }
    const slow = state.slowRugLabel;
    if (slow?.labeledAt >= enteredAt) {
      const returnPct = ((slow.price / entry) - 1) * 100;
      if (returnPct <= -30) return {
        ...slow, kind: 'SLOW_RUG_30', entryPrice: entry, entryAt: enteredAt, returnPct, observedAt,
      };
    }
    return null;
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled || now - this.lastSweepAt < this.config.sweepIntervalMs) return;
    this.lastSweepAt = now;
    const cutoff = now - this.config.stateRetentionMs;
    for (const [mint, state] of this.states) {
      this._resolveFirstCliffCounterfactuals(mint, state, null, now);
      if (state.lastAt < cutoff) this.states.delete(mint);
      else this._prune(state, now);
    }
    this._pruneFirstCliffCandidateKeys(now);
    this._expireToxicMemory(now);
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'UNIVERSAL_PRE_ENTRY_RUG_GUARD',
      scope: 'LIFECYCLE_AND_STRATEGY_TIERED',
      enforcement: 'LIVE_CURVE_CATASTROPHE_SELECTIVE_HARD_BLOCK',
      outcomeLabels: 'CLIFF_DROP_50/CLIFF_RUG_70/CLIFF_RUG_80/SLOW_RUG_30',
      dumpabilityMode: 'RESEARCH_WARNINGS_PLUS_EXTREME_LIVE_CURVE_HARD_BLOCK',
      firstCliffCounterfactualMode: 'PAIRED_SHADOW_NO_ENTRY_BLOCK',
      firstCliffLifecycleMode: 'STAGE_SPECIFIC_PAIRED_SHADOW_NO_ENTRY_BLOCK',
      livePath: 'MEMORY_ONLY_BOUNDED_CACHE_REFRESH',
      sendsTransactions: false,
      trackedMints: this.states.size,
      toxicWallets: this.toxicWallets.size,
      toxicTemplates: this.toxicTemplates.size,
      toxicMemoryPath: this._cfg('toxicMemoryPath', null),
      toxicMemoryPersistence: 'ASYNC_SNAPSHOT_HOT_PATH_MEMORY_ONLY',
      thresholds: {
        windowMs: this.config.windowMs,
        minTrades: this.config.minTrades,
        minBuySharePct: this.config.minBuySharePct,
        minConsecutiveBuys: this.config.minConsecutiveBuys,
        maxSideAlternationPct: this.config.maxSideAlternationPct,
        minUpTickSharePct: this.config.minUpTickSharePct,
        minReturnPct: this.config.minReturnPct,
        minFlags: this.config.minFlags,
        verticalFragileMinReturnPct: this.config.verticalFragileMinReturnPct,
        verticalFragileMinBuyImpactPct: this.config.verticalFragileMinBuyImpactPct,
        verticalFragileMinWalletTxSharePct: this.config.verticalFragileMinWalletTxSharePct,
        sparseBreadthMinBuysPerBuyer: this.config.sparseBreadthMinBuysPerBuyer,
        chaseRepeatedMinReturnPct: this.config.chaseRepeatedMinReturnPct,
        chaseRepeatedMinSizeSharePct: this.config.chaseRepeatedMinSizeSharePct,
        beijingRiskWindowEnabled: this.config.beijingRiskWindowEnabled,
        beijingRiskStartHour: this.config.beijingRiskStartHour,
        beijingRiskEndHour: this.config.beijingRiskEndHour,
        beijingRiskMinFlags: this.config.beijingRiskMinFlags,
        cliffEnabled: this._cfg('cliffEnabled', true),
        cliffWindowMs: this._cfg('cliffWindowMs', 2_000),
        cliffMaxSells: this._cfg('cliffMaxSells', 3),
        cliffMinDropPct: this._cfg('cliffMinDropPct', 50),
        cliffPersistMaxRatioPct: this._cfg('cliffPersistMaxRatioPct', 75),
        cliffPairIgnoreMs: this._cfg('cliffPairIgnoreMs', 100),
        slowRugMinDurationMs: this._cfg('slowRugMinDurationMs', 10_000),
        dumpabilityEnabled: this._cfg('dumpabilityEnabled', true),
        dumpabilityPositionSol: this._cfg('dumpabilityPositionSol', 1),
        dumpTop1ReserveWarnPct: this._cfg('dumpTop1ReserveWarnPct', 25),
        dumpTop3ReserveWarnPct: this._cfg('dumpTop3ReserveWarnPct', 50),
        extremeDumpabilityEnabled: this._cfg('extremeDumpabilityEnabled', true),
        extremeDumpabilityMinObservedWallets:
          this._cfg('extremeDumpabilityMinObservedWallets', 4),
        extremeDumpabilityTop3ObservedSharePct:
          this._cfg('extremeDumpabilityTop3ObservedSharePct', 70),
        extremeDumpabilityTop3RecoveryMaxPct:
          this._cfg('extremeDumpabilityTop3RecoveryMaxPct', 20),
        firstCliffCounterfactualEnabled: this._cfg('firstCliffCounterfactualEnabled', true),
        firstCliffHorizonMs: this._cfg('firstCliffHorizonMs', 30_000),
        firstCliffEffectiveBuyersMax: this._cfg('firstCliffEffectiveBuyersMax', 3),
        firstCliffHc1Top1Pct: this._cfg('firstCliffHc1Top1Pct', 15),
        firstCliffHc1Top3Pct: this._cfg('firstCliffHc1Top3Pct', 35),
        firstCliffHc2Top1Pct: this._cfg('firstCliffHc2Top1Pct', 20),
        firstCliffHc2Top3Pct: this._cfg('firstCliffHc2Top3Pct', 35),
        firstCliffLifecycleEnabled: this._cfg('firstCliffLifecycleEnabled', true),
        firstCliffLaunchMaxAgeMs: this._cfg('firstCliffLaunchMaxAgeMs', 5_000),
        firstCliffCurveEarlyMaxAgeMs: this._cfg('firstCliffCurveEarlyMaxAgeMs', 30_000),
        firstCliffCurveMigrationMinPct: this._cfg('firstCliffCurveMigrationMinPct', 80),
        firstCliffAmmEarlyMaxAgeMs: this._cfg('firstCliffAmmEarlyMaxAgeMs', 10_000),
        firstCliffAmmHc1Top3RecoveryMaxPct:
          this._cfg('firstCliffAmmHc1Top3RecoveryMaxPct', 50),
        firstCliffAmmHc2Top3RecoveryMaxPct:
          this._cfg('firstCliffAmmHc2Top3RecoveryMaxPct', 40),
        firstCliffAmmHc1WalletBuyTxSharePct:
          this._cfg('firstCliffAmmHc1WalletBuyTxSharePct', 50),
        firstCliffAmmHc2WalletBuyTxSharePct:
          this._cfg('firstCliffAmmHc2WalletBuyTxSharePct', 60),
        firstCliffCurveLateCandidateRecoveryMaxPct:
          this._cfg('firstCliffCurveLateCandidateRecoveryMaxPct', 2),
        firstCliffCurveMigrationCandidateWalletBuyTxSharePct:
          this._cfg('firstCliffCurveMigrationCandidateWalletBuyTxSharePct', 70),
        firstCliffAmmEarlyCandidateRecoveryMaxPct:
          this._cfg('firstCliffAmmEarlyCandidateRecoveryMaxPct', 20),
        firstCliffAmmEarlyCandidateWalletBuyTxSharePct:
          this._cfg('firstCliffAmmEarlyCandidateWalletBuyTxSharePct', 25),
        crossMintEnabled: this.config.crossMintEnabled !== false,
        templateWindowMs: this._cfg('templateWindowMs', 5_000),
        templateMinLargeBuys: this._cfg('templateMinLargeBuys', 4),
        templateMinTotalBuySol: this._cfg('templateMinTotalBuySol', 40),
        templateMaxBurstSpanMs: this._cfg('templateMaxBurstSpanMs', 500),
        toxicCollapsePct: this._cfg('toxicCollapsePct', 60),
        toxicCollapseWindowMs: this._cfg('toxicCollapseWindowMs', 30_000),
        toxicRetentionMs: this._cfg('toxicRetentionMs', 86_400_000),
        toxicWalletRetentionMs: this._cfg(
          'toxicWalletRetentionMs', this._cfg('toxicRetentionMs', 60 * 86_400_000),
        ),
        toxicTemplateRetentionMs: this._cfg(
          'toxicTemplateRetentionMs', this._cfg('toxicRetentionMs', 30 * 86_400_000),
        ),
        toxicAmountTolerancePct: this._cfg('toxicAmountTolerancePct', 2),
        toxicBurstToleranceMs: this._cfg('toxicBurstToleranceMs', 100),
        toxicWalletOverlapMin: this._cfg('toxicWalletOverlapMin', 2),
      },
      strategyStats: [...this.guardStrategies.values()]
        .map((row) => this._firstCliffStrategyHealth(row))
        .sort((left, right) => right.evaluated - left.evaluated),
      recentFlagged: this.recentGuardDecisions.slice(0, 50),
      recentCliffOutcomes: this.recentCliffOutcomes.slice(0, 50),
      recentDumpabilityWarnings: this.recentDumpabilityWarnings.slice(0, 50),
      firstCliffPending: this.firstCliffPendingCount,
      firstCliffLifecycleSummary: this._firstCliffLifecycleHealth(),
      recentFirstCliffCounterfactuals: this.recentFirstCliffCounterfactuals.slice(0, 50),
      ...this.metrics,
    };
  }

  _empty(observedAt) {
    return {
      observedAt,
      windowMs: this.config.windowMs,
      sampleSize: 0,
      sampleReady: false,
      flagged: false,
      score: 0,
      maxScore: 5,
      legacyMinFlags: this.config.minFlags,
      beijingHour: beijingHour(observedAt),
      beijingRiskWindow: false,
      buySharePct: null,
      maxConsecutiveBuys: 0,
      sideAlternationPct: null,
      upTickSharePct: null,
      returnPct: null,
      uniqueBuyers: 0,
      buysPerBuyer: null,
      maxWalletBuyTxSharePct: null,
      repeatedBuySizeSharePct: null,
      maxBuyImpactPct: null,
      lastPrice: null,
      crossMintToxic: false,
      extremeCoordinatedDumpability: false,
      toxicWalletOverlap: 0,
      toxicTemplateMatch: null,
      templateFingerprint: null,
      templateLargeBuyCount: 0,
      templateBuySol: null,
      templateBurstSpanMs: null,
      checks: {},
      signatures: {},
      flaggedReasons: [],
      rugPath: null,
      dumpability: null,
      firstCliffCounterfactual: {
        mode: 'PAIRED_SHADOW_NO_ENTRY_BLOCK', eligible: false,
        hc1Matched: false, hc2Matched: false,
        lifecycleStage: null, lifecycleLabel: null,
      },
      researchWarnings: [],
    };
  }

  _prune(state, now) {
    const cutoff = now - this.config.stateRetentionMs;
    while (state.offset < state.events.length
      && state.events[state.offset].timestampMs < cutoff) state.offset += 1;
    if (state.offset > 128 && state.offset * 2 >= state.events.length) this._compact(state);
  }

  _recordSignatureMetrics(risk) {
    if (risk.signatures?.legacyStairStep) this.metrics.flaggedLegacy += 1;
    if (risk.signatures?.verticalFragileReuse) this.metrics.flaggedVerticalFragile += 1;
    if (risk.signatures?.sparseBuyerBreadth) this.metrics.flaggedSparseBreadth += 1;
    if (risk.signatures?.chaseRepeatedSize) this.metrics.flaggedChaseRepeatedSize += 1;
    if (risk.signatures?.crossMintToxicWallets) this.metrics.flaggedCrossMintWallets += 1;
    if (risk.signatures?.crossMintToxicTemplate) this.metrics.flaggedCrossMintTemplates += 1;
    if (risk.signatures?.extremeCoordinatedDumpability) {
      this.metrics.flaggedExtremeDumpability += 1;
    }
    if (risk.beijingRiskWindow && risk.score >= this.config.beijingRiskMinFlags
      && risk.score < this.config.minFlags) this.metrics.flaggedBeijingRiskWindow += 1;
  }

  _capacityTrade(trade) {
    return {
      market: trade.market,
      poolBaseReservesRaw: trade.poolBaseReservesRaw,
      poolQuoteReservesRaw: trade.poolQuoteReservesRaw,
      virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw,
      virtualTokenReservesRaw: trade.virtualTokenReservesRaw,
      virtualSolReservesRaw: trade.virtualSolReservesRaw,
      realTokenReservesRaw: trade.realTokenReservesRaw,
      realSolReservesRaw: trade.realSolReservesRaw,
      ageMs: trade.ageMs,
      curvePct: trade.curvePct,
    };
  }

  _firstCliffCounterfactualSnapshot(state, rows, dumpability, timestampMs) {
    const mode = 'PAIRED_SHADOW_NO_ENTRY_BLOCK';
    const lifecycle = this._firstCliffLifecycle(state, rows, timestampMs);
    const profile = this._firstCliffLifecycleProfile(lifecycle.stage);
    if (this._cfg('firstCliffCounterfactualEnabled', true) === false) {
      return {
        mode, eligible: false, hc1Matched: false, hc2Matched: false,
        lifecycleStage: lifecycle.stage, lifecycleLabel: lifecycle.label,
      };
    }
    const walletBuySol = new Map();
    const walletBuyTrades = new Map();
    let buyTrades = 0;
    for (const row of rows) {
      if (row.side !== 'BUY' || !row.wallet || !(row.solAmount > 0)) continue;
      walletBuySol.set(row.wallet, (walletBuySol.get(row.wallet) || 0) + row.solAmount);
      walletBuyTrades.set(row.wallet, (walletBuyTrades.get(row.wallet) || 0) + 1);
      buyTrades += 1;
    }
    const buySolValues = [...walletBuySol.values()];
    const totalBuySol = buySolValues.reduce((sum, value) => sum + value, 0);
    const squaredBuySol = buySolValues.reduce((sum, value) => sum + value * value, 0);
    const effectiveBuyers = squaredBuySol > 0 ? totalBuySol * totalBuySol / squaredBuySol : null;
    const maxWalletBuyTrades = walletBuyTrades.size
      ? Math.max(...walletBuyTrades.values()) : 0;
    const maxWalletBuyTxSharePct = buyTrades > 0
      ? maxWalletBuyTrades / buyTrades * 100 : null;
    const market = String(state.lastTrade?.market || rows.at(-1)?.market || '');
    const isCurve = market === 'PUMP_BONDING_CURVE';
    const isAmm = market === 'PUMP_AMM';
    const realReserveRaw = finite(state.lastTrade?.realTokenReservesRaw);
    const realReserveTokenUnits = realReserveRaw > 0 ? realReserveRaw / 1e6 : null;
    const top1InventoryPct = isCurve && realReserveTokenUnits > 0
      ? finite(dumpability?.top1ObservedUnits, 0) / realReserveTokenUnits * 100
      : finite(dumpability?.top1ReservePct);
    const top3InventoryPct = isCurve && realReserveTokenUnits > 0
      ? finite(dumpability?.top3ObservedUnits, 0) / realReserveTokenUnits * 100
      : finite(dumpability?.top3ReservePct);
    const top3RecoveryPct = finite(dumpability?.top3RecoveryPct);
    const capacityReady = isCurve
      ? realReserveTokenUnits > 0 && finite(dumpability?.observedWallets, 0) > 0
      : isAmm && Boolean(dumpability?.sampleReady);
    const eligible = rows.length >= this.config.minTrades
      && effectiveBuyers != null && effectiveBuyers < profile.effectiveBuyersMax
      && capacityReady;
    const inventoryHc1 = top1InventoryPct >= profile.hc1.top1Pct
      || top3InventoryPct >= profile.hc1.top3Pct;
    const inventoryHc2 = top1InventoryPct >= profile.hc2.top1Pct
      || top3InventoryPct >= profile.hc2.top3Pct;
    const ammFlowHc1 = isAmm && top3RecoveryPct != null
      && top3RecoveryPct <= profile.hc1.top3RecoveryMaxPct
      && maxWalletBuyTxSharePct >= profile.hc1.walletBuyTxShareMinPct;
    const ammFlowHc2 = isAmm && top3RecoveryPct != null
      && top3RecoveryPct <= profile.hc2.top3RecoveryMaxPct
      && maxWalletBuyTxSharePct >= profile.hc2.walletBuyTxShareMinPct;
    const hc1Matched = eligible && (inventoryHc1 || ammFlowHc1);
    const hc2Matched = eligible && (inventoryHc2 || ammFlowHc2);
    const stageCandidate = this._firstCliffStageCandidate(lifecycle.stage, {
      top3RecoveryPct,
      maxWalletBuyTxSharePct,
    });
    return {
      mode,
      observedAt: timestampMs,
      market,
      lifecycleStage: lifecycle.stage,
      lifecycleLabel: lifecycle.label,
      lifecycleAgeMs: lifecycle.ageMs,
      lifecycleCurvePct: lifecycle.curvePct,
      eligible,
      effectiveBuyers,
      effectiveBuyersMax: profile.effectiveBuyersMax,
      totalBuySol,
      maxWalletBuyTxSharePct,
      realReserveTokenUnits,
      top1InventoryPct,
      top3InventoryPct,
      top1RealReservePct: isCurve ? top1InventoryPct : null,
      top3RealReservePct: isCurve ? top3InventoryPct : null,
      top3RecoveryPct,
      hc1Matched,
      hc2Matched,
      stageCandidateId: stageCandidate.id,
      stageCandidateLabel: stageCandidate.label,
      stageCandidateMatched: eligible && stageCandidate.matched,
      stageCandidateCriteria: stageCandidate.criteria,
      hc1: profile.hc1,
      hc2: profile.hc2,
    };
  }

  _firstCliffLifecycle(state, rows, timestampMs) {
    const last = rows.at(-1) || {};
    const market = String(state.lastTrade?.market || last.market || '');
    const curvePct = finite(state.lastTrade?.curvePct,
      finite(state.lastCurvePct, finite(last.curvePct)));
    if (market === 'PUMP_AMM') {
      const ageMs = Math.max(0, timestampMs - finite(state.firstAmmAt, timestampMs));
      const stage = ageMs <= this._cfg('firstCliffAmmEarlyMaxAgeMs', 10_000)
        ? 'AMM_EARLY' : 'AMM_MATURE';
      return { stage, label: this._firstCliffLifecycleLabel(stage), ageMs, curvePct };
    }
    const reportedAgeMs = finite(state.lastTrade?.ageMs, finite(last.ageMs));
    const ageMs = Math.max(0, reportedAgeMs != null
      ? reportedAgeMs : timestampMs - finite(state.firstBondingAt, state.firstSeenAt));
    let stage;
    if (curvePct != null
      && curvePct >= this._cfg('firstCliffCurveMigrationMinPct', 80)) {
      stage = 'CURVE_MIGRATION';
    } else if (ageMs <= this._cfg('firstCliffLaunchMaxAgeMs', 5_000)) {
      stage = 'LAUNCH';
    } else if (ageMs <= this._cfg('firstCliffCurveEarlyMaxAgeMs', 30_000)) {
      stage = 'CURVE_EARLY';
    } else stage = 'CURVE_LATE';
    return { stage, label: this._firstCliffLifecycleLabel(stage), ageMs, curvePct };
  }

  _firstCliffLifecycleLabel(stage) {
    return FIRST_CLIFF_LIFECYCLE_STAGES.find((row) => row.id === stage)?.label || stage;
  }

  _firstCliffLifecycleProfile(stage) {
    const effectiveBuyers = this._cfg('firstCliffEffectiveBuyersMax', 3);
    const base = {
      effectiveBuyersMax: effectiveBuyers,
      hc1: {
        top1Pct: this._cfg('firstCliffHc1Top1Pct', 15),
        top3Pct: this._cfg('firstCliffHc1Top3Pct', 35),
        top3RecoveryMaxPct: null,
        walletBuyTxShareMinPct: null,
      },
      hc2: {
        top1Pct: this._cfg('firstCliffHc2Top1Pct', 20),
        top3Pct: this._cfg('firstCliffHc2Top3Pct', 35),
        top3RecoveryMaxPct: null,
        walletBuyTxShareMinPct: null,
      },
    };
    if (this._cfg('firstCliffLifecycleEnabled', true) === false) return base;
    const adjusted = {
      effectiveBuyersMax: base.effectiveBuyersMax,
      hc1: { ...base.hc1 },
      hc2: { ...base.hc2 },
    };
    if (stage === 'LAUNCH') {
      adjusted.effectiveBuyersMax = Math.max(1, effectiveBuyers - 0.5);
      adjusted.hc1.top1Pct = Math.max(0, base.hc1.top1Pct - 3);
      adjusted.hc1.top3Pct = Math.max(0, base.hc1.top3Pct - 5);
      adjusted.hc2.top1Pct = Math.max(0, base.hc2.top1Pct - 2);
    } else if (stage === 'CURVE_LATE') {
      adjusted.hc1.top1Pct += 5;
      adjusted.hc1.top3Pct += 10;
      adjusted.hc2.top1Pct += 5;
      adjusted.hc2.top3Pct += 10;
    } else if (stage === 'CURVE_MIGRATION') {
      adjusted.effectiveBuyersMax += 1;
      adjusted.hc1.top3Pct += 5;
      adjusted.hc2.top3Pct += 10;
    } else if (stage === 'AMM_EARLY' || stage === 'AMM_MATURE') {
      const mature = stage === 'AMM_MATURE';
      adjusted.effectiveBuyersMax += mature ? 1 : 0;
      adjusted.hc1.top1Pct += mature ? 5 : 0;
      adjusted.hc1.top3Pct += mature ? 15 : 5;
      adjusted.hc2.top1Pct += mature ? 10 : 0;
      adjusted.hc2.top3Pct += mature ? 20 : 10;
      adjusted.hc1.top3RecoveryMaxPct = Math.max(0,
        this._cfg('firstCliffAmmHc1Top3RecoveryMaxPct', 50) - (mature ? 10 : 0));
      adjusted.hc2.top3RecoveryMaxPct = Math.max(0,
        this._cfg('firstCliffAmmHc2Top3RecoveryMaxPct', 40) - (mature ? 10 : 0));
      adjusted.hc1.walletBuyTxShareMinPct = Math.min(100,
        this._cfg('firstCliffAmmHc1WalletBuyTxSharePct', 50) + (mature ? 10 : 0));
      adjusted.hc2.walletBuyTxShareMinPct = Math.min(100,
        this._cfg('firstCliffAmmHc2WalletBuyTxSharePct', 60) + (mature ? 10 : 0));
    }
    return adjusted;
  }

  _firstCliffStageCandidate(stage, {
    top3RecoveryPct = null,
    maxWalletBuyTxSharePct = null,
  } = {}) {
    const recovery = finite(top3RecoveryPct);
    const walletShare = finite(maxWalletBuyTxSharePct);
    if (stage === 'CURVE_LATE') {
      const maxRecovery = this._cfg('firstCliffCurveLateCandidateRecoveryMaxPct', 2);
      return {
        id: 'CL-R2',
        label: `Top3回收≤${maxRecovery}%`,
        criteria: { top3RecoveryMaxPct: maxRecovery },
        matched: recovery != null && recovery <= maxRecovery,
      };
    }
    if (stage === 'CURVE_MIGRATION') {
      const minWalletShare = this._cfg(
        'firstCliffCurveMigrationCandidateWalletBuyTxSharePct', 70,
      );
      return {
        id: 'CM-W70',
        label: `单钱包买单≥${minWalletShare}%`,
        criteria: { walletBuyTxShareMinPct: minWalletShare },
        matched: walletShare != null && walletShare >= minWalletShare,
      };
    }
    if (stage === 'AMM_EARLY') {
      // A deliberately broad forward candidate: the last independent sample
      // caught every observed first cliff while selecting six of seven cases.
      // It is a label, not an entry rejection; tomorrow's data can measure the
      // false-positive cost before any enforcement decision is reconsidered.
      const maxRecovery = this._cfg('firstCliffAmmEarlyCandidateRecoveryMaxPct', 20);
      const minWalletShare = this._cfg(
        'firstCliffAmmEarlyCandidateWalletBuyTxSharePct', 25,
      );
      return {
        id: 'AE-R20-OR-W25',
        label: `Top3回收≤${maxRecovery}% 或 单钱包买单≥${minWalletShare}%`,
        criteria: {
          top3RecoveryMaxPct: maxRecovery,
          walletBuyTxShareMinPct: minWalletShare,
          operator: 'OR',
        },
        matched: (recovery != null && recovery <= maxRecovery)
          || (walletShare != null && walletShare >= minWalletShare),
      };
    }
    return {
      id: null,
      label: '仅分层标签',
      criteria: null,
      matched: false,
    };
  }

  _initializeFirstCliffStrategyStats(stats) {
    for (const name of Object.keys(firstCliffCounterRow())) {
      if (!Number.isFinite(stats[name])) stats[name] = 0;
    }
    if (!stats.firstCliffByStage || typeof stats.firstCliffByStage !== 'object') {
      stats.firstCliffByStage = {};
    }
    for (const stage of FIRST_CLIFF_LIFECYCLE_STAGES) {
      const row = stats.firstCliffByStage[stage.id] || {};
      for (const [name, value] of Object.entries(firstCliffCounterRow())) {
        if (!Number.isFinite(row[name])) row[name] = value;
      }
      row.stage = stage.id;
      row.label = stage.label;
      row.lifecycleStage = stage.id;
      row.lifecycleLabel = stage.label;
      stats.firstCliffByStage[stage.id] = row;
    }
  }

  _registerFirstCliffCounterfactual({ strategyId, source, mint, timestampMs, risk, stats }) {
    const feature = risk.firstCliffCounterfactual;
    // Persist every eligible opportunity, including the unflagged control arm.
    // Without it we could measure precision, but not recall or missed cliffs.
    // This remains an in-memory paired Shadow audit and does not block entry.
    if (!feature?.eligible) return;
    const key = `${source}|${strategyId}|${mint}|${feature.lifecycleStage || 'UNKNOWN'}`;
    const existingExpiry = this.firstCliffCandidateKeys.get(key);
    if (existingExpiry > timestampMs) return;
    const maxPending = this._cfg('firstCliffMaxPending', 10_000);
    if (this.firstCliffPendingCount >= maxPending) {
      this.metrics.firstCliffCensored += 1;
      return;
    }
    const horizonMs = this._cfg('firstCliffHorizonMs', 30_000);
    const candidate = {
      key,
      strategyId,
      source,
      mint,
      entryAt: timestampMs,
      deadlineAt: timestampMs + horizonMs,
      entryPrice: finite(risk.lastPrice),
      hc1Matched: Boolean(feature.hc1Matched),
      hc2Matched: Boolean(feature.hc2Matched),
      stageCandidateId: feature.stageCandidateId,
      stageCandidateLabel: feature.stageCandidateLabel,
      stageCandidateMatched: Boolean(feature.stageCandidateMatched),
      lifecycleStage: feature.lifecycleStage,
      lifecycleLabel: feature.lifecycleLabel,
      effectiveBuyers: feature.effectiveBuyers,
      top1InventoryPct: feature.top1InventoryPct,
      top3InventoryPct: feature.top3InventoryPct,
      top1RealReservePct: feature.top1RealReservePct,
      top3RealReservePct: feature.top3RealReservePct,
      top3RecoveryPct: feature.top3RecoveryPct,
      maxWalletBuyTxSharePct: feature.maxWalletBuyTxSharePct,
    };
    const pending = this.firstCliffPendingByMint.get(mint) || [];
    pending.push(candidate);
    this.firstCliffPendingByMint.set(mint, pending);
    this.firstCliffCandidateKeys.set(key, candidate.deadlineAt);
    this.firstCliffPendingCount += 1;
    this.metrics.firstCliffCandidates += 1;
    if (candidate.stageCandidateMatched) {
      stats.firstCliffStageCandidateMatched += 1;
      stats.firstCliffByStage[candidate.lifecycleStage].firstCliffStageCandidateMatched += 1;
      this.metrics.firstCliffStageCandidateMatched += 1;
    }
    if (candidate.hc1Matched) {
      stats.firstCliffHc1Matched += 1;
      stats.firstCliffByStage[candidate.lifecycleStage].firstCliffHc1Matched += 1;
      this.metrics.firstCliffHc1Matched += 1;
    }
    if (candidate.hc2Matched) {
      stats.firstCliffHc2Matched += 1;
      stats.firstCliffByStage[candidate.lifecycleStage].firstCliffHc2Matched += 1;
      this.metrics.firstCliffHc2Matched += 1;
    }
  }

  _resolveFirstCliffCounterfactuals(mint, state, event = null, now = null) {
    const pending = this.firstCliffPendingByMint.get(mint);
    if (!pending?.length) return;
    const observedAt = finite(event?.timestampMs, finite(now, this.now()));
    const latestPrice = finite(event?.price, finite(state.events.at(-1)?.price));
    const unresolved = [];
    for (const candidate of pending) {
      const cliff = state.confirmedCliffs.find((row) => (
        row.confirmedAt >= candidate.entryAt
        && row.confirmedAt <= candidate.deadlineAt
        && row.dropPct >= 70
      ));
      if (cliff) {
        const returnPct = candidate.entryPrice > 0
          ? (cliff.persistedPrice / candidate.entryPrice - 1) * 100 : null;
        this._finalizeFirstCliffCounterfactual(candidate, {
          outcome: 'CLIFF_RUG_70', resolvedAt: cliff.confirmedAt,
          returnPct, cliffDropPct: cliff.dropPct,
        });
      } else if (observedAt >= candidate.deadlineAt) {
        const lastMarkAt = finite(state.events.at(-1)?.timestampMs, observedAt);
        const markLagMs = Math.max(0, observedAt - lastMarkAt);
        // A quiet Mint cannot be labelled safe from an old mark. Persist it as
        // censored so tomorrow's precision/recall decision remains honest.
        if (markLagMs > 5_000) {
          this._finalizeFirstCliffCounterfactual(candidate, {
            outcome: 'CENSORED_STALE_MARK', resolvedAt: observedAt,
            returnPct: null, markLagMs,
          });
          continue;
        }
        const returnPct = candidate.entryPrice > 0 && latestPrice > 0
          ? (latestPrice / candidate.entryPrice - 1) * 100 : null;
        this._finalizeFirstCliffCounterfactual(candidate, {
          outcome: 'NO_CLIFF_30S', resolvedAt: observedAt, returnPct,
          markLagMs,
        });
      } else unresolved.push(candidate);
    }
    if (unresolved.length) this.firstCliffPendingByMint.set(mint, unresolved);
    else this.firstCliffPendingByMint.delete(mint);
  }

  _sweepFirstCliffCounterfactuals(now = this.now()) {
    if (!this.firstCliffPendingCount) return 0;
    let swept = 0;
    for (const [mint, pending] of this.firstCliffPendingByMint) {
      if (!pending?.some((row) => row.deadlineAt <= now)) continue;
      const state = this.states.get(mint);
      if (!state) continue;
      const before = pending.length;
      this._resolveFirstCliffCounterfactuals(mint, state, null, now);
      swept += before - (this.firstCliffPendingByMint.get(mint)?.length || 0);
    }
    return swept;
  }

  _finalizeFirstCliffCounterfactual(candidate, result) {
    this.firstCliffPendingCount = Math.max(0, this.firstCliffPendingCount - 1);
    this.firstCliffCandidateKeys.delete(candidate.key);
    const censored = result.outcome === 'CENSORED_STALE_MARK';
    if (censored) this.metrics.firstCliffCensored += 1;
    else {
      this.metrics.firstCliffResolved += 1;
      if (result.outcome === 'CLIFF_RUG_70') this.metrics.firstCliffCaught += 1;
      else this.metrics.firstCliffNoCliff30s += 1;
    }
    const stats = this.guardStrategies.get(candidate.strategyId);
    if (stats && !censored) {
      this._initializeFirstCliffStrategyStats(stats);
      const stageStats = stats.firstCliffByStage[candidate.lifecycleStage];
      if (candidate.stageCandidateMatched) {
        stats.firstCliffStageCandidateResolved += 1;
        stageStats.firstCliffStageCandidateResolved += 1;
        if (result.outcome === 'CLIFF_RUG_70') {
          stats.firstCliffStageCandidateCaught += 1;
          stageStats.firstCliffStageCandidateCaught += 1;
        } else {
          stats.firstCliffStageCandidateNoCliff30s += 1;
          stageStats.firstCliffStageCandidateNoCliff30s += 1;
        }
        if (Number.isFinite(result.returnPct)) {
          stats.firstCliffStageCandidateReturnSumPct += result.returnPct;
          stats.firstCliffStageCandidateReturnSamples += 1;
          stageStats.firstCliffStageCandidateReturnSumPct += result.returnPct;
          stageStats.firstCliffStageCandidateReturnSamples += 1;
        }
      }
      for (const cohort of ['Hc1', 'Hc2']) {
        if (!candidate[`${cohort.toLowerCase()}Matched`]) continue;
        stats[`firstCliff${cohort}Resolved`] += 1;
        stageStats[`firstCliff${cohort}Resolved`] += 1;
        if (result.outcome === 'CLIFF_RUG_70') stats[`firstCliff${cohort}Caught`] += 1;
        else stats[`firstCliff${cohort}NoCliff30s`] += 1;
        if (result.outcome === 'CLIFF_RUG_70') stageStats[`firstCliff${cohort}Caught`] += 1;
        else stageStats[`firstCliff${cohort}NoCliff30s`] += 1;
        if (Number.isFinite(result.returnPct)) {
          stats[`firstCliff${cohort}ReturnSumPct`] += result.returnPct;
          stats[`firstCliff${cohort}ReturnSamples`] += 1;
          stageStats[`firstCliff${cohort}ReturnSumPct`] += result.returnPct;
          stageStats[`firstCliff${cohort}ReturnSamples`] += 1;
        }
      }
    }
    const audit = {
      ...candidate,
      ...result,
      auditKey: `${candidate.key}|${candidate.entryAt}`,
    };
    this.recentFirstCliffCounterfactuals.unshift(audit);
    if (this.recentFirstCliffCounterfactuals.length > 100) {
      this.recentFirstCliffCounterfactuals.length = 100;
    }
    if (typeof this.store?.recordPreEntryRugFirstCliffAudits === 'function') {
      this.firstCliffAuditQueue.push(audit);
      const maxQueue = this._cfg('firstCliffMaxPending', 10_000);
      if (this.firstCliffAuditQueue.length > maxQueue) {
        this.firstCliffAuditQueue.splice(0, this.firstCliffAuditQueue.length - maxQueue);
        this.metrics.firstCliffCensored += 1;
      }
    }
  }

  _flushFirstCliffAudits() {
    if (!this.firstCliffAuditQueue.length
      || typeof this.store?.recordPreEntryRugFirstCliffAudits !== 'function') return 0;
    const batch = this.firstCliffAuditQueue.splice(0, 500);
    try {
      const written = this.store.recordPreEntryRugFirstCliffAudits(batch);
      this.metrics.firstCliffAuditsPersisted += Number(written) || 0;
      return Number(written) || 0;
    } catch (error) {
      this.firstCliffAuditQueue.unshift(...batch);
      const maxQueue = this._cfg('firstCliffMaxPending', 10_000);
      if (this.firstCliffAuditQueue.length > maxQueue) this.firstCliffAuditQueue.length = maxQueue;
      this.metrics.firstCliffAuditErrors += 1;
      this.metrics.lastError = `first cliff audit: ${error.message}`;
      return 0;
    }
  }

  _pruneFirstCliffCandidateKeys(now) {
    for (const [key, expiresAt] of this.firstCliffCandidateKeys) {
      if (expiresAt + this.config.stateRetentionMs < now) this.firstCliffCandidateKeys.delete(key);
    }
  }

  _firstCliffStrategyHealth(row) {
    this._initializeFirstCliffStrategyStats(row);
    return {
      ...row,
      ...this._firstCliffCounterHealth(row),
      firstCliffByStage: FIRST_CLIFF_LIFECYCLE_STAGES.map((stage) => ({
        ...row.firstCliffByStage[stage.id],
        ...this._firstCliffCounterHealth(row.firstCliffByStage[stage.id]),
      })),
    };
  }

  _firstCliffCounterHealth(row) {
    return {
      firstCliffStageCandidatePrecisionPct: row.firstCliffStageCandidateResolved > 0
        ? row.firstCliffStageCandidateCaught / row.firstCliffStageCandidateResolved * 100 : null,
      firstCliffStageCandidateAverageReturnPct: row.firstCliffStageCandidateReturnSamples > 0
        ? row.firstCliffStageCandidateReturnSumPct
          / row.firstCliffStageCandidateReturnSamples : null,
      firstCliffHc1PrecisionPct: row.firstCliffHc1Resolved > 0
        ? row.firstCliffHc1Caught / row.firstCliffHc1Resolved * 100 : null,
      firstCliffHc2PrecisionPct: row.firstCliffHc2Resolved > 0
        ? row.firstCliffHc2Caught / row.firstCliffHc2Resolved * 100 : null,
      firstCliffHc1AverageReturnPct: row.firstCliffHc1ReturnSamples > 0
        ? row.firstCliffHc1ReturnSumPct / row.firstCliffHc1ReturnSamples : null,
      firstCliffHc2AverageReturnPct: row.firstCliffHc2ReturnSamples > 0
        ? row.firstCliffHc2ReturnSumPct / row.firstCliffHc2ReturnSamples : null,
    };
  }

  _firstCliffLifecycleHealth() {
    const aggregates = Object.fromEntries(FIRST_CLIFF_LIFECYCLE_STAGES.map((stage) => [
      stage.id, {
        stage: stage.id,
        label: stage.label,
        lifecycleStage: stage.id,
        lifecycleLabel: stage.label,
        ...firstCliffCounterRow(),
      },
    ]));
    for (const stats of this.guardStrategies.values()) {
      this._initializeFirstCliffStrategyStats(stats);
      for (const stage of FIRST_CLIFF_LIFECYCLE_STAGES) {
        const source = stats.firstCliffByStage[stage.id];
        const target = aggregates[stage.id];
        for (const name of Object.keys(firstCliffCounterRow())) target[name] += source[name];
      }
    }
    return FIRST_CLIFF_LIFECYCLE_STAGES.map((stage) => {
      const candidate = this._firstCliffStageCandidate(stage.id);
      return {
        ...aggregates[stage.id],
        stageCandidateId: candidate.id,
        stageCandidateLabel: candidate.label,
        ...this._firstCliffCounterHealth(aggregates[stage.id]),
      };
    });
  }

  _observeRugPath(mint, state, event) {
    if (this._cfg('cliffEnabled', true) === false) return;
    const pairIgnoreMs = this._cfg('cliffPairIgnoreMs', 100);
    const persistRatio = this._cfg('cliffPersistMaxRatioPct', 75) / 100;
    const candidate = state.cliffCandidate;
    if (candidate) {
      const pairedBuy = event.side === 'BUY' && event.wallet
        && candidate.sellWallets.includes(event.wallet)
        && event.timestampMs - candidate.lastSellAt >= 0
        && event.timestampMs - candidate.lastSellAt <= pairIgnoreMs;
      if (pairedBuy) {
        state.cliffCandidate = null;
        this.metrics.cliffPairedArtifactsIgnored += 1;
      } else if (event.timestampMs > candidate.lastSellAt) {
        const independent = event.side !== 'SELL'
          || !candidate.sellWallets.includes(event.wallet);
        if (independent && event.price <= candidate.preShockPrice * persistRatio) {
          const confirmed = {
            kind: 'CLIFF_DROP_50', confirmed: true, mint,
            startedAt: candidate.startedAt, confirmedAt: event.timestampMs,
            preShockPrice: candidate.preShockPrice,
            persistedPrice: event.price,
            dropPct: (1 - event.price / candidate.preShockPrice) * 100,
            sellCount: candidate.sellCount,
            sellWallets: [...candidate.sellWallets],
          };
          state.confirmedCliffs.unshift(confirmed);
          if (state.confirmedCliffs.length > 8) state.confirmedCliffs.length = 8;
          state.cliffCandidate = null;
          this.metrics.cliffConfirmed += 1;
          if (confirmed.persistedPrice / confirmed.preShockPrice <= 0.3) this.metrics.cliffRug70 += 1;
          if (confirmed.persistedPrice / confirmed.preShockPrice <= 0.2) this.metrics.cliffRug80 += 1;
          this.recentCliffOutcomes.unshift(confirmed);
          if (this.recentCliffOutcomes.length > 100) this.recentCliffOutcomes.length = 100;
          return;
        }
        if (event.price > candidate.preShockPrice * persistRatio) {
          state.cliffCandidate = null;
          this.metrics.cliffRecoveredBeforeConfirm += 1;
        }
      }
      if (state.cliffCandidate
        && event.timestampMs - state.cliffCandidate.startedAt
          > this._cfg('cliffWindowMs', 2_000) + 2_000) state.cliffCandidate = null;
    }

    if (event.side !== 'SELL') return;
    const sameMarket = (row) => !event.market || !row.market || row.market === event.market;
    let pairedBefore = false;
    for (let index = state.events.length - 2; index >= state.offset; index -= 1) {
      const row = state.events[index];
      const ageMs = event.timestampMs - row.timestampMs;
      if (ageMs > pairIgnoreMs) break;
      if (ageMs >= 0 && row.side === 'BUY' && row.wallet
        && row.wallet === event.wallet && sameMarket(row)) {
        pairedBefore = true;
        break;
      }
    }
    if (pairedBefore) {
      this.metrics.cliffPairedArtifactsIgnored += 1;
      return;
    }
    const windowMs = this._cfg('cliffWindowMs', 2_000);
    const recentSells = [];
    for (let index = state.events.length - 1; index >= state.offset; index -= 1) {
      const row = state.events[index];
      if (row.timestampMs < event.timestampMs - windowMs) break;
      if (row.timestampMs <= event.timestampMs && row.side === 'SELL' && sameMarket(row)) {
        recentSells.unshift(row);
      }
    }
    const maxSells = this._cfg('cliffMaxSells', 3);
    if (!recentSells.length || recentSells.length > maxSells) return;
    const firstSell = recentSells[0];
    let preShockPrice = 0;
    for (let index = state.events.length - 1; index >= state.offset; index -= 1) {
      const row = state.events[index];
      if (row.timestampMs < firstSell.timestampMs - windowMs) break;
      if (row.timestampMs < firstSell.timestampMs && sameMarket(row)) {
        preShockPrice = Math.max(preShockPrice, row.price);
      }
    }
    if (!(preShockPrice > 0)) return;
    const minPrice = Math.min(...recentSells.map((row) => row.price));
    const dropPct = (1 - minPrice / preShockPrice) * 100;
    if (dropPct < this._cfg('cliffMinDropPct', 50)) return;
    state.cliffCandidate = {
      startedAt: firstSell.timestampMs,
      lastSellAt: event.timestampMs,
      preShockPrice,
      minPrice,
      dropPct,
      sellCount: recentSells.length,
      sellWallets: [...new Set(recentSells.map((row) => row.wallet).filter(Boolean))],
    };
    this.metrics.cliffCandidates += 1;
  }

  _activeRugPath(state, timestampMs, price) {
    const cliff = state.confirmedCliffs.find((row) => (
      timestampMs - row.confirmedAt <= this.config.stateRetentionMs
    ));
    if (cliff) return cliff;
    if (state.cliffCandidate) return {
      kind: 'CLIFF_CANDIDATE', confirmed: false,
      ...state.cliffCandidate,
    };
    const slowMinDurationMs = this._cfg('slowRugMinDurationMs', 10_000);
    if (!state.slowRugLabel && state.peakPrice > 0
      && timestampMs - state.peakAt >= slowMinDurationMs
      && price <= state.peakPrice * 0.7) {
      state.slowRugLabel = {
        kind: 'SLOW_RUG_30', confirmed: true,
        labeledAt: timestampMs, peakAt: state.peakAt,
        peakPrice: state.peakPrice, price,
        durationMs: timestampMs - state.peakAt,
      };
      this.metrics.slowRug30 += 1;
    }
    return state.slowRugLabel;
  }

  _dumpabilitySnapshot(state, rows, timestampMs) {
    if (this._cfg('dumpabilityEnabled', true) === false || !state.lastTrade) return null;
    const inventory = new Map();
    for (const row of rows) {
      if (!row.wallet || !(row.tokenAmount > 0)) continue;
      const prior = inventory.get(row.wallet) || 0;
      inventory.set(row.wallet, Math.max(0, prior + (row.side === 'BUY' ? row.tokenAmount : -row.tokenAmount)));
    }
    const holders = [...inventory.entries()]
      .filter(([, units]) => units > 0)
      .sort((left, right) => right[1] - left[1]);
    const totalObservedUnits = holders.reduce((sum, [, units]) => sum + units, 0);
    const top1Units = holders[0]?.[1] || 0;
    const top3Units = holders.slice(0, 3).reduce((sum, [, units]) => sum + units, 0);
    const reserves = reservesForTrade(state.lastTrade);
    const reserveTokenUnits = reserves ? Number(reserves.baseRaw) / 1e6 : null;
    const positionSol = this._cfg('dumpabilityPositionSol', 1);
    const markPrice = rows[rows.length - 1]?.price || null;
    const buy = executableBuy(state.lastTrade, positionSol, markPrice);
    const ourTokenUnits = buy.tokenUnits || (markPrice > 0 ? positionSol / markPrice : null);
    const top1Sequence = ourTokenUnits > 0
      ? simulateSellSequence(state.lastTrade, [top1Units, ourTokenUnits]) : null;
    const top3Sequence = ourTokenUnits > 0
      ? simulateSellSequence(state.lastTrade, [...holders.slice(0, 3).map(([, units]) => units), ourTokenUnits])
      : null;
    const top1RecoveryPct = top1Sequence?.available
      ? top1Sequence.legs.at(-1).proceedsSol / positionSol * 100 : null;
    const top3RecoveryPct = top3Sequence?.available
      ? top3Sequence.legs.at(-1).proceedsSol / positionSol * 100 : null;
    const sampleReady = rows.length >= this.config.minTrades
      && holders.length > 0 && reserveTokenUnits > 0 && ourTokenUnits > 0;
    const top1ReservePct = reserveTokenUnits > 0 ? top1Units / reserveTokenUnits * 100 : null;
    const top3ReservePct = reserveTokenUnits > 0 ? top3Units / reserveTokenUnits * 100 : null;
    const warnings = [];
    if (sampleReady && top1ReservePct >= this._cfg('dumpTop1ReserveWarnPct', 25)) {
      warnings.push('OBSERVED_TOP1_DUMPABLE_INVENTORY');
    }
    if (sampleReady && top3ReservePct >= this._cfg('dumpTop3ReserveWarnPct', 50)) {
      warnings.push('OBSERVED_TOP3_DUMPABLE_INVENTORY');
    }
    if (sampleReady && top3RecoveryPct != null && top3RecoveryPct < 50) {
      warnings.push('POST_TOP3_EXIT_RECOVERY_BELOW_50');
    }
    const result = {
      mode: 'RESEARCH_ONLY_NO_ENTRY_BLOCK', observedAt: timestampMs,
      sampleReady, sampleSize: rows.length, observedWallets: holders.length,
      totalObservedUnits, top1ObservedUnits: top1Units, top3ObservedUnits: top3Units,
      top1ObservedSharePct: totalObservedUnits > 0 ? top1Units / totalObservedUnits * 100 : null,
      top3ObservedSharePct: totalObservedUnits > 0 ? top3Units / totalObservedUnits * 100 : null,
      reserveTokenUnits, top1ReservePct, top3ReservePct,
      positionSol, top1RecoveryPct, top3RecoveryPct,
      warnings,
    };
    if (state.lastDumpabilityVersion !== state.version) {
      state.lastDumpabilityVersion = state.version;
      this.metrics.dumpabilityEvaluations += 1;
      if (sampleReady) this.metrics.dumpabilitySampleReady += 1;
      if (warnings.length) {
        this.metrics.dumpabilityWarnings += 1;
        this.recentDumpabilityWarnings.unshift({ mint: state.mint, ...result });
        if (this.recentDumpabilityWarnings.length > 100) {
          this.recentDumpabilityWarnings.length = 100;
        }
      }
    }
    return result;
  }

  _compact(state) {
    if (state.offset <= 0) return;
    state.events = state.events.slice(state.offset);
    state.offset = 0;
  }

  _cfg(name, fallback) {
    const value = this.config?.[name];
    return value == null ? fallback : value;
  }

  _refreshCrossMintTemplate(state, timestampMs, price) {
    const cutoff = timestampMs - this._cfg('templateWindowMs', 5_000);
    const minSol = this._cfg('templateLargeBuyMinSol', 1);
    const largeBuys = state.events.slice(state.offset).filter((row) => (
      row.side === 'BUY' && row.timestampMs >= cutoff && row.timestampMs <= timestampMs
      && row.solAmount >= minSol
    ));
    const minBuys = this._cfg('templateMinLargeBuys', 4);
    const maxBuys = this._cfg('templateMaxLargeBuys', 6);
    if (largeBuys.length < minBuys || largeBuys.length > maxBuys) return;
    const firstAt = largeBuys[0].timestampMs;
    const observedAt = largeBuys[largeBuys.length - 1].timestampMs;
    const burstSpanMs = observedAt - firstAt;
    const totalBuySol = largeBuys.reduce((sum, row) => sum + row.solAmount, 0);
    if (burstSpanMs > this._cfg('templateMaxBurstSpanMs', 500)
      || totalBuySol < this._cfg('templateMinTotalBuySol', 40)) return;
    const amounts = largeBuys.map((row) => row.solAmount).sort((left, right) => right - left);
    const fingerprint = this._templateFingerprint(amounts, burstSpanMs);
    const prior = state.template;
    state.template = {
      fingerprint,
      firstAt,
      observedAt,
      burstSpanMs,
      totalBuySol,
      largeBuyCount: largeBuys.length,
      wallets: [...new Set(largeBuys.map((row) => row.wallet).filter(Boolean))],
      amounts,
    };
    if (!prior || prior.fingerprint !== fingerprint || prior.observedAt !== observedAt) {
      state.templatePeakPrice = price;
      state.templateToxicLabeled = false;
    } else if (price > state.templatePeakPrice) state.templatePeakPrice = price;
  }

  _templateFingerprint(amounts, burstSpanMs) {
    const bucketSol = Math.max(0.01, this._cfg('templateSizeBucketSol', 0.25));
    const amountKey = amounts.map((amount) => (
      Math.round(amount / bucketSol) * bucketSol
    ).toFixed(2)).join(',');
    let spanKey = '1000';
    if (burstSpanMs <= 50) spanKey = '50';
    else if (burstSpanMs <= 100) spanKey = '100';
    else if (burstSpanMs <= 250) spanKey = '250';
    else if (burstSpanMs <= 500) spanKey = '500';
    return `${amounts.length}|${spanKey}|${amountKey}`;
  }

  _labelRapidCollapse(mint, state, timestampMs, price) {
    const template = state.template;
    if (!template || state.templateToxicLabeled
      || timestampMs - template.observedAt > this._cfg('toxicCollapseWindowMs', 30_000)) return;
    if (!(state.templatePeakPrice > 0) || price > state.templatePeakPrice) {
      state.templatePeakPrice = price;
      return;
    }
    const collapsePct = (1 - price / state.templatePeakPrice) * 100;
    if (collapsePct < this._cfg('toxicCollapsePct', 60)) return;
    state.templateToxicLabeled = true;
    const fallbackRetentionMs = this._cfg('toxicRetentionMs', 60 * 86_400_000);
    const templateExpiresAt = timestampMs + this._cfg(
      'toxicTemplateRetentionMs', fallbackRetentionMs,
    );
    const walletExpiresAt = timestampMs + this._cfg(
      'toxicWalletRetentionMs', fallbackRetentionMs,
    );
    const record = {
      mint,
      fingerprint: template.fingerprint,
      labeledAt: timestampMs,
      collapsePct,
      totalBuySol: template.totalBuySol,
      largeBuyCount: template.largeBuyCount,
      burstSpanMs: template.burstSpanMs,
      amounts: [...template.amounts],
    };
    const templateRecord = { ...record, expiresAt: templateExpiresAt };
    this.toxicTemplates.set(template.fingerprint, templateRecord);
    this._indexToxicTemplate(templateRecord);
    this._boundToxicTemplates(this._cfg('maxToxicTemplates', 1_024));
    let learnedWallets = 0;
    const historyRows = [{ kind: 'TEMPLATE', subject: template.fingerprint, ...templateRecord }];
    for (const wallet of template.wallets) {
      if (!wallet) continue;
      if (!this.toxicWallets.has(wallet)) learnedWallets += 1;
      const walletRecord = { ...record, wallet, expiresAt: walletExpiresAt };
      this.toxicWallets.set(wallet, walletRecord);
      historyRows.push({ kind: 'WALLET', subject: wallet, ...walletRecord });
    }
    this._boundMap(this.toxicWallets, this._cfg('maxToxicWallets', 4_096));
    this.metrics.toxicCollapsesLabeled += 1;
    this.metrics.toxicTemplatesLearned += 1;
    this.metrics.toxicWalletsLearned += learnedWallets;
    this.toxicVersion += 1;
    this.toxicMemoryDirty = true;
    if (typeof this.store?.recordPreEntryRugToxicHistory === 'function') {
      try {
        this.metrics.toxicHistoryPersisted += Number(
          this.store.recordPreEntryRugToxicHistory(historyRows),
        ) || 0;
      } catch (error) {
        this.metrics.toxicHistoryErrors += 1;
        this.metrics.lastError = `toxic history: ${error.message}`;
      }
    }
  }

  _toxicWalletOverlap(wallets, timestampMs) {
    let overlap = 0;
    for (const wallet of new Set(wallets || [])) {
      const record = this.toxicWallets.get(wallet);
      if (!record) continue;
      if (record.expiresAt <= timestampMs) {
        this.toxicWallets.delete(wallet);
        this.toxicVersion += 1;
        this.toxicMemoryDirty = true;
      }
      else overlap += 1;
    }
    return overlap;
  }

  _activeToxicTemplate(template, timestampMs) {
    const exact = this.toxicTemplates.get(template.fingerprint);
    if (exact?.expiresAt > timestampMs) return exact;
    if (exact) this._deleteToxicTemplate(exact.fingerprint);

    // Conservative fuzzy matching is bounded by large-buy count. It tolerates
    // tiny amount/timing jitter, but never treats a scaled or structurally
    // different burst as the same launch template.
    const candidates = this.toxicTemplateIndex.get(template.largeBuyCount);
    if (!candidates?.size) return null;
    for (const fingerprint of candidates) {
      const record = this.toxicTemplates.get(fingerprint);
      if (!record) continue;
      if (record.expiresAt <= timestampMs) {
        this._deleteToxicTemplate(fingerprint);
        continue;
      }
      if (this._templatesApproximatelyEqual(template, record)) {
        this.metrics.toxicFuzzyMatches += 1;
        return record;
      }
    }
    return null;
  }

  _expireToxicMemory(now) {
    let changed = false;
    for (const [key, record] of this.toxicWallets) {
      if (record.expiresAt <= now) {
        this.toxicWallets.delete(key);
        changed = true;
      }
    }
    for (const [key, record] of this.toxicTemplates) {
      if (record.expiresAt <= now) {
        this._deleteToxicTemplate(key, false);
        changed = true;
      }
    }
    if (changed) {
      this.toxicVersion += 1;
      this.toxicMemoryDirty = true;
    }
  }

  _boundMap(map, maxSize) {
    while (map.size > maxSize) map.delete(map.keys().next().value);
  }

  _templatesApproximatelyEqual(left, right) {
    if (left.largeBuyCount !== right.largeBuyCount) return false;
    const burstToleranceMs = this._cfg('toxicBurstToleranceMs', 100);
    if (Math.abs(left.burstSpanMs - right.burstSpanMs) > burstToleranceMs) return false;
    const leftAmounts = [...(left.amounts || [])].sort((a, b) => b - a);
    const rightAmounts = [...(right.amounts || [])].sort((a, b) => b - a);
    if (!leftAmounts.length || leftAmounts.length !== rightAmounts.length) return false;
    const tolerance = this._cfg('toxicAmountTolerancePct', 2) / 100;
    return leftAmounts.every((amount, index) => {
      const reference = rightAmounts[index];
      return reference > 0 && Math.abs(amount - reference) / reference <= tolerance;
    });
  }

  _indexToxicTemplate(record) {
    const key = finite(record?.largeBuyCount, 0);
    if (!(key > 0) || !record?.fingerprint) return;
    const bucket = this.toxicTemplateIndex.get(key) || new Set();
    bucket.add(record.fingerprint);
    this.toxicTemplateIndex.set(key, bucket);
  }

  _deleteToxicTemplate(fingerprint, bumpVersion = true) {
    const record = this.toxicTemplates.get(fingerprint);
    if (!record) return;
    this.toxicTemplates.delete(fingerprint);
    const bucket = this.toxicTemplateIndex.get(record.largeBuyCount);
    bucket?.delete(fingerprint);
    if (bucket && !bucket.size) this.toxicTemplateIndex.delete(record.largeBuyCount);
    if (bumpVersion) this.toxicVersion += 1;
    this.toxicMemoryDirty = true;
  }

  _boundToxicTemplates(maxSize) {
    while (this.toxicTemplates.size > maxSize) {
      this._deleteToxicTemplate(this.toxicTemplates.keys().next().value, false);
    }
  }

  _memoryPath() {
    const configured = String(this._cfg('toxicMemoryPath', '') || '').trim();
    return configured && configured !== ':memory:' ? path.resolve(configured) : null;
  }

  _memorySnapshot(now = this.now()) {
    return {
      version: 2,
      savedAt: now,
      retentionMs: this._cfg('toxicRetentionMs', 86_400_000),
      walletRetentionMs: this._cfg(
        'toxicWalletRetentionMs', this._cfg('toxicRetentionMs', 60 * 86_400_000),
      ),
      templateRetentionMs: this._cfg(
        'toxicTemplateRetentionMs', this._cfg('toxicRetentionMs', 30 * 86_400_000),
      ),
      templates: [...this.toxicTemplates.values()].filter((row) => row.expiresAt > now),
      wallets: [...this.toxicWallets.values()].filter((row) => row.expiresAt > now),
    };
  }

  _loadToxicMemory() {
    const memoryPath = this._memoryPath();
    if (!memoryPath) return;
    try {
      const payload = JSON.parse(this.fileSystem.readFileSync(memoryPath, 'utf8'));
      const now = this.now();
      for (const record of payload.templates || []) {
        if (!record?.fingerprint || !(record.expiresAt > now)) continue;
        this.toxicTemplates.set(record.fingerprint, record);
        this._indexToxicTemplate(record);
      }
      for (const record of payload.wallets || []) {
        if (!record?.wallet || !(record.expiresAt > now)) continue;
        this.toxicWallets.set(record.wallet, record);
      }
      this._boundToxicTemplates(this._cfg('maxToxicTemplates', 1_024));
      this._boundMap(this.toxicWallets, this._cfg('maxToxicWallets', 4_096));
      this.metrics.toxicMemoryLoaded = this.toxicTemplates.size + this.toxicWallets.size;
      this.toxicMemoryDirty = false;
      if (this.metrics.toxicMemoryLoaded > 0) this.toxicVersion += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.metrics.toxicMemoryLoadErrors += 1;
        this.metrics.lastError = `toxic memory load: ${error.message}`;
      }
    }
  }

  async _persistToxicMemory() {
    const memoryPath = this._memoryPath();
    if (!memoryPath || !this.toxicMemoryDirty || this.toxicPersistPromise) return;
    const snapshot = JSON.stringify(this._memorySnapshot());
    const temporaryPath = `${memoryPath}.${process.pid}.tmp`;
    this.toxicMemoryDirty = false;
    this.toxicPersistPromise = (async () => {
      try {
        await this.fileSystem.promises.mkdir(path.dirname(memoryPath), { recursive: true });
        await this.fileSystem.promises.writeFile(temporaryPath, snapshot, 'utf8');
        await this.fileSystem.promises.rename(temporaryPath, memoryPath);
        this.metrics.toxicMemorySaved += 1;
      } catch (error) {
        this.toxicMemoryDirty = true;
        this.metrics.toxicMemorySaveErrors += 1;
        this.metrics.lastError = `toxic memory save: ${error.message}`;
      } finally {
        this.toxicPersistPromise = null;
      }
    })();
    await this.toxicPersistPromise;
  }

  _persistToxicMemorySync() {
    const memoryPath = this._memoryPath();
    if (!memoryPath || !this.toxicMemoryDirty) return;
    const temporaryPath = `${memoryPath}.${process.pid}.stop.tmp`;
    try {
      this.fileSystem.mkdirSync(path.dirname(memoryPath), { recursive: true });
      this.fileSystem.writeFileSync(
        temporaryPath, JSON.stringify(this._memorySnapshot()), 'utf8',
      );
      this.fileSystem.renameSync(temporaryPath, memoryPath);
      this.toxicMemoryDirty = false;
      this.metrics.toxicMemorySaved += 1;
    } catch (error) {
      this.metrics.toxicMemorySaveErrors += 1;
      this.metrics.lastError = `toxic memory save: ${error.message}`;
    }
  }
}

module.exports = { PreEntryRugRiskTracker, tradePrice };
