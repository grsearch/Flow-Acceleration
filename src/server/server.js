'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { runBacktest } = require('../core/FlowBacktester');
const { DashboardReadModel } = require('../data/DashboardReadModel');

function numeric(value, fallback) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function secondsToMs(value, fallback) {
  const seconds = numeric(value, null);
  return seconds == null ? fallback : seconds * 1_000;
}

function boolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function databaseOperational(status) {
  return !['LOCKED', 'DEGRADED', 'DATA_LOSS'].includes(String(status || ''));
}

const EMPTY_LIVE_TRADING_STATS = Object.freeze({
  decisions: 0,
  matched: 0,
  rule_rejected: 0,
  matched_disabled: 0,
  risk_rejected: 0,
  positions: 0,
  active_positions: 0,
  closed_positions: 0,
  entry_failed_positions: 0,
  pre_submit_migrated_positions: 0,
  pre_submit_guard_rejected_positions: 0,
  execution_entry_failed_positions: 0,
  exit_failed_positions: 0,
  deployed_sol: 0,
  average_hold_ms: null,
  priced_closed_positions: 0,
  settled_closed_positions: 0,
  wins: 0,
  total_realized_pnl_sol: 0,
  average_realized_return_pct: null,
  average_gross_return_pct: null,
  orders: 0,
  confirmed_orders: 0,
  failed_orders: 0,
  unknown_orders: 0,
  win_rate_pct: null,
});

function normalizedLiveTradingDashboard(value, strategyId) {
  const dashboard = value && typeof value === 'object' ? value : {};
  return {
    ...dashboard,
    stats: {
      ...EMPTY_LIVE_TRADING_STATS,
      ...(dashboard.stats && typeof dashboard.stats === 'object' ? dashboard.stats : {}),
    },
    positions: Array.isArray(dashboard.positions) ? dashboard.positions : [],
    orders: Array.isArray(dashboard.orders) ? dashboard.orders : [],
    decisions: Array.isArray(dashboard.decisions) ? dashboard.decisions : [],
    entryLocks: Array.isArray(dashboard.entryLocks) ? dashboard.entryLocks : [],
    strategyId: dashboard.strategyId || strategyId || null,
  };
}

function loadRetentionMaintenance(dbPath) {
  if (!dbPath || dbPath === ':memory:') return null;
  const reportPath = path.join(
    path.dirname(path.resolve(dbPath)),
    'exports',
    'retention-last-run.json',
  );
  if (!fs.existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.mode !== 'COS_GATED_RETENTION') return null;
    return {
      status: 'COMPLETED',
      completedAtMs: Number(report.completedAtMs) || null,
      deletedRows: Number(report.deletedRows) || 0,
      stopReason: report.stopReason || null,
      reusableBytes: Number(report.pages?.after?.reusableBytes) || 0,
      archiveSha256: report.cosGate?.sha256 || null,
      hardMaxRowsPerRun: Number(report.limits?.hardMaxRowsPerRun) || 5_000_000,
      repeatGuardMs: Number(report.limits?.repeatGuardMs) || 24 * 60 * 60_000,
    };
  } catch (error) {
    return {
      status: 'REPORT_ERROR',
      error: error.message,
    };
  }
}

class ResearchServer {
  constructor({
    config, runtimeIdentity = null, store, engine, stream, labeler,
    trader = null, signalShadow = null,
    flowFirstShadow = null, smartPullbackShadow = null, smartOpenShadow = null,
    flowSmartConfirmShadow = null,
    smartLikeEarlyShadow = null,
    preEntryRugRisk = null,
    smartWalletRegistry = null,
    smartWalletConsensusFlowRunnerShadow = null,
    smartWalletConsensusOverlay = null,
    smartResonanceShadow = null,
    smartWalletRugEscapeShadow = null,
    smartWalletFirstOpenRightTailShadow = null,
    individualSmartWalletShadows = null,
    publicFlowLeadShadow = null,
    publicFlowAbsorptionRecoveryShadow = null,
    creatorAffinityShadow = null,
    cyaSlotFlowShadow = null,
    cyaOrganicBurstShadow = null,
    earlyPureBuyBurstShadow = null,
    sameSlotDumpBackrunShadow = null,
    launchPullbackShadow = null, launchQualityObserver = null,
    migrationSecondLegObserver = null,
    migrationSecondLegShadow = null,
    migratedDropReboundShadow = null,
    migrationContinuityShadow = null,
    rangeScalperShadow = null,
    cyaEarlyPyramidShadow = null,
    bondingCurveMomentumShadow = null,
    graduationHoldShadow = null,
    holderGrowthShadow = null,
    qualityLeaderShadow = null,
    bigWinnerShadow = null,
    graduationAccelerationShadow = null,
    featureEdgeAudit = null,
    postMigrationSurvivor = null,
  }) {
    this.config = config;
    this.runtimeIdentity = runtimeIdentity;
    this.store = store;
    this.engine = engine;
    this.stream = stream;
    this.labeler = labeler;
    this.trader = trader;
    this.signalShadow = signalShadow;
    this.flowFirstShadow = flowFirstShadow;
    this.smartPullbackShadow = smartPullbackShadow;
    this.smartOpenShadow = smartOpenShadow;
    this.flowSmartConfirmShadow = flowSmartConfirmShadow;
    this.smartLikeEarlyShadow = smartLikeEarlyShadow;
    this.preEntryRugRisk = preEntryRugRisk;
    this.smartWalletRegistry = smartWalletRegistry;
    this.smartWalletConsensusFlowRunnerShadow = smartWalletConsensusFlowRunnerShadow;
    this.smartWalletConsensusOverlay = smartWalletConsensusOverlay;
    this.smartResonanceShadow = smartResonanceShadow;
    this.smartWalletRugEscapeShadow = smartWalletRugEscapeShadow;
    this.smartWalletFirstOpenRightTailShadow = smartWalletFirstOpenRightTailShadow;
    this.individualSmartWalletShadows = individualSmartWalletShadows;
    this.publicFlowLeadShadow = publicFlowLeadShadow;
    this.publicFlowAbsorptionRecoveryShadow = publicFlowAbsorptionRecoveryShadow;
    this.creatorAffinityShadow = creatorAffinityShadow;
    this.cyaSlotFlowShadow = cyaSlotFlowShadow;
    this.cyaOrganicBurstShadow = cyaOrganicBurstShadow;
    this.earlyPureBuyBurstShadow = earlyPureBuyBurstShadow;
    this.sameSlotDumpBackrunShadow = sameSlotDumpBackrunShadow;
    this.launchPullbackShadow = launchPullbackShadow;
    this.launchQualityObserver = launchQualityObserver;
    this.migrationSecondLegObserver = migrationSecondLegObserver;
    this.migrationSecondLegShadow = migrationSecondLegShadow;
    this.migratedDropReboundShadow = migratedDropReboundShadow;
    this.migrationContinuityShadow = migrationContinuityShadow;
    this.rangeScalperShadow = rangeScalperShadow;
    this.cyaEarlyPyramidShadow = cyaEarlyPyramidShadow;
    this.bondingCurveMomentumShadow = bondingCurveMomentumShadow;
    this.graduationHoldShadow = graduationHoldShadow;
    this.holderGrowthShadow = holderGrowthShadow;
    this.qualityLeaderShadow = qualityLeaderShadow;
    this.bigWinnerShadow = bigWinnerShadow;
    this.graduationAccelerationShadow = graduationAccelerationShadow;
    this.featureEdgeAudit = featureEdgeAudit;
    this.postMigrationSurvivor = postMigrationSurvivor;
    this.retentionMaintenance = loadRetentionMaintenance(this.store?.config?.dbPath);
    this.dashboardReadModel = new DashboardReadModel({
      config: this.config.dashboardCache || { enabled: false },
      storage: this.config.storage || {},
      smartWallets: this.config.smartWallets || [],
      liveStrategies: this.config.liveTrading?.strategies || [],
      shadowSettings: {
        flowFirstBigWinnerPct: this.config.flowFirstShadow?.bigWinnerPct ?? 50,
        smartPullbackBigWinnerPct: this.config.smartPullbackShadow?.bigWinnerPct ?? 50,
        smartOpenBigWinnerPct: this.config.smartOpenShadow?.bigWinnerPct ?? 50,
        migratedBigWinnerPct: this.config.migratedDropReboundShadow?.bigWinnerPct ?? 50,
        holderGrowthBigWinnerPct: this.config.holderGrowthShadow?.bigWinnerPct ?? 50,
        qualityLeaderBigWinnerPct: this.config.qualityLeaderShadow?.bigWinnerPct ?? 100,
        bondingMomentumBigWinnerPct: this.config.bondingCurveMomentumShadow?.bigWinnerPct ?? 50,
        graduationHoldBigWinnerPct: this.config.graduationHoldShadow?.bigWinnerPct ?? 50,
        graduationAccelerationBigWinnerPct:
          this.config.graduationAccelerationShadow?.bigWinnerPct ?? 50,
      },
      smartWalletRegistryConfig: this.config.smartWalletRegistry || {},
      smartWalletConsensusOverlayConfig: this.config.smartWalletConsensusOverlay || {},
    });
    this.app = express();
    this.httpServer = null;
    this.startedAt = Date.now();
    this.slowRouteLastLoggedAt = new Map();
    this._routes();
  }

  _liveSourceDiagnostics(strategy) {
    if (!strategy) return null;
    const migratedProfiles = {
      MIGRATED_GE30_R23_F2_ONLY_G2_XLEG: 'GE30_R23_F2_ONLY',
      MIGRATED_GRT_R23_F3_V2_XLEG: 'GRT_R23_F3_V2',
    };
    const migratedProfileId = migratedProfiles[strategy.signalSource];
    if (migratedProfileId && this.migratedDropReboundShadow) {
      const runtime = this.migratedDropReboundShadow.health();
      const profile = runtime.entryProfiles?.find((row) => row.id === migratedProfileId) || null;
      const diagnostics = runtime.profileDiagnostics
        ?.find((row) => row.profileId === migratedProfileId) || null;
      return {
        kind: 'MIGRATED_DROP_REBOUND',
        profileId: migratedProfileId,
        maxLifecycleAgeMs: profile?.maxLifecycleAgeMs ?? null,
        ...diagnostics,
      };
    }
    if (strategy.signalSource === 'GRADUATION_ACCEL_O_C80_P500_STAIR240'
      && this.graduationAccelerationShadow) {
      const runtime = this.graduationAccelerationShadow.health();
      const profileId = 'O_C80_P500_STAIR240';
      const profile = runtime.entryProfiles?.find((row) => row.id === profileId) || null;
      const diagnostics = runtime.profileDiagnostics
        ?.find((row) => row.profileId === profileId) || null;
      return {
        kind: 'GRADUATION_PERSISTENCE',
        profileId,
        persistenceMs: profile?.persistenceMs ?? null,
        ...diagnostics,
      };
    }
    return null;
  }

  _dashboardSnapshot(key, directRead) {
    if (!this.dashboardReadModel.enabled) {
      return {
        value: directRead(),
        metadata: { status: 'DIRECT' },
      };
    }
    const cached = this.dashboardReadModel.read(key);
    return {
      value: cached?.value || {
        timeSessions: { sessions: [] },
        cohorts: [],
        positions: [],
        observations: [],
        snapshots: [],
        stats: {},
      },
      metadata: cached ? {
        status: 'READY',
        generatedAt: cached.generatedAt,
        durationMs: cached.durationMs,
      } : { status: 'PREPARING' },
    };
  }

  _routes() {
    const publicDir = path.join(__dirname, 'public');
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '64kb' }));
    this.app.use((request, response, next) => {
      const startedAt = process.hrtime.bigint();
      response.once('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        if (durationMs < 250) return;
        const routeKey = `${request.method} ${request.path}`;
        const now = Date.now();
        if (now - (this.slowRouteLastLoggedAt.get(routeKey) || 0) < 30_000) return;
        this.slowRouteLastLoggedAt.set(routeKey, now);
        console.warn(`[Dashboard:slow] ${routeKey} ${durationMs.toFixed(1)}ms`);
      });
      next();
    });

    this.app.get('/api/overview', (_request, response) => {
      const cached = this.dashboardReadModel.read('overview');
      if (!this.dashboardReadModel.enabled) {
        response.json(this.store.overview(Date.now(), this.engine.stats().candidateCount));
        return;
      }
      response.json({
        ...(cached?.value || {
          rawTradesToday: 0,
          activeTokens: 0,
          flowSignalsToday: 0,
          shadowSignalsToday: 0,
          earlyThresholdSignalsToday: 0,
          smartWalletTradesToday: 0,
        }),
        candidateCount: this.engine.stats().candidateCount,
        dashboardSnapshot: cached ? {
          status: 'READY', generatedAt: cached.generatedAt, durationMs: cached.durationMs,
        } : { status: 'PREPARING' },
      });
    });

    this.app.get('/api/signals', (request, response) => {
      const limit = Math.min(200, Math.max(1, numeric(request.query.limit, 200)));
      const cached = this.dashboardReadModel.read('recent-signals');
      response.json(this.dashboardReadModel.enabled
        ? (cached?.value || []).slice(0, limit)
        : this.store.recentSignals(limit));
    });

    // Keep the sidebar state tied to the configuration that is actually loaded
    // by the running process. This route intentionally reads no SQLite tables so
    // the five-second dashboard refresh cannot add pressure to a large database.
    this.app.get('/api/strategy-status', (_request, response) => {
      const enabled = (key) => Boolean(this.config[key]?.enabled);
      response.set('Cache-Control', 'no-store');
      response.json({
        shadows: {
          'smart-open': enabled('smartOpenShadow'),
          'flow-smart-confirm': enabled('flowSmartConfirmShadow'),
          'smart-like-early': enabled('smartLikeEarlyShadow'),
          'cya-slot-flow': enabled('cyaSlotFlowShadow'),
          'cya-organic-burst': enabled('cyaOrganicBurstShadow'),
          'early-pure-buy-burst': enabled('earlyPureBuyBurstShadow'),
          'same-slot-dump-backrun': enabled('sameSlotDumpBackrunShadow'),
          'smart-resonance': enabled('smartResonanceShadow'),
          'smart-consensus-v2': enabled('smartWalletConsensusFlowRunnerShadow'),
          'smart-consensus-overlay': enabled('smartWalletConsensusOverlay'),
          'smart-wallet-rug-escape': enabled('smartWalletRugEscapeShadow'),
          'smart-first-open-right-tail': enabled('smartWalletFirstOpenRightTailShadow'),
          'individual-smart-wallets': enabled('individualSmartWalletShadows'),
          'public-flow-lead': enabled('publicFlowLeadShadow'),
          'public-flow-recovery': enabled('publicFlowAbsorptionRecoveryShadow'),
          'creator-affinity': enabled('creatorAffinityShadow'),
          'launch-pullback': enabled('launchPullbackShadow'),
          'migrated-rebound': enabled('migratedDropReboundShadow'),
          'migration-continuity': enabled('migrationContinuityShadow'),
          'range-scalper': enabled('rangeScalperShadow'),
          'cya-early-pyramid': enabled('cyaEarlyPyramidShadow'),
          'bonding-momentum': enabled('bondingCurveMomentumShadow'),
          'graduation-hold': enabled('graduationHoldShadow'),
          'graduation-acceleration': enabled('graduationAccelerationShadow'),
          'feature-edge-audit': enabled('featureEdgeAudit'),
          'post-migration-survivor': enabled('postMigrationSurvivorObserver'),
          'launch-quality': enabled('launchQualityObserver'),
          'migration-second-leg': enabled('migrationSecondLegObserver')
            || enabled('migrationSecondLegShadow'),
          'holder-growth': enabled('holderGrowthShadow'),
          'quality-leader': enabled('qualityLeaderShadow'),
          'big-winner': enabled('bigWinnerShadow'),
          'flow-first': enabled('flowFirstShadow'),
          'smart-pullback': enabled('smartPullbackShadow'),
          'primary-shadow': enabled('signalShadow'),
        },
      });
    });

    this.app.get('/api/backtest', (request, response) => {
      const defaultCosts = this.config.labels.costModel || {};
      const signalVariant = request.query.signalVariant || 'primary_3w';
      const defaultMinFlowAccel = ['shadow_netflow_breakout', '*'].includes(signalVariant)
        ? 0
        : this.config.strategy.minAccelerationRatio;
      const result = runBacktest(this.store.db, {
        rawTradeTable: 'raw_trades_all',
        holdMs: numeric(request.query.holdMs, 60_000),
        executionDelayMs: numeric(
          request.query.executionDelayMs,
          this.config.backtest?.executionDelayMs ?? 200,
        ),
        entryTimeoutMs: numeric(
          request.query.entryTimeoutMs,
          this.config.backtest?.entryTimeoutMs ?? 2_000,
        ),
        exitTimeoutMs: numeric(
          request.query.exitTimeoutMs,
          this.config.backtest?.exitTimeoutMs ?? 5_000,
        ),
        noExitLossPct: request.query.noExitLossPct === undefined
          || String(request.query.noExitLossPct).trim() === ''
          ? this.config.backtest?.noExitLossPct
          : numeric(request.query.noExitLossPct, undefined),
        takeProfitPct: numeric(request.query.takeProfitPct, 0),
        stopLossPct: numeric(request.query.stopLossPct, 0),
        trailingStopPct: numeric(request.query.trailingStopPct, 0),
        trailingActivationPct: numeric(request.query.trailingActivationPct, 0),
        flowExitNetFlowThresholdSol: numeric(
          request.query.flowExitNetFlowThresholdSol,
          undefined,
        ),
        flowExitWindowMs: numeric(request.query.flowExitWindowMs, 2_000),
        flowExitMinHoldMs: numeric(request.query.flowExitMinHoldMs, 1_000),
        flowExitConfirmations: numeric(request.query.flowExitConfirmations, 2),
        exitOnSmartWalletSell: boolean(request.query.exitOnSmartWalletSell, false),
        smartWallets: this.config.smartWallets,
        exitExecutionDelayMs: numeric(
          request.query.exitExecutionDelayMs,
          this.config.backtest?.exitExecutionDelayMs ?? 200,
        ),
        exitRetryCount: numeric(request.query.exitRetryCount, 0),
        exitRetryDelayMs: numeric(request.query.exitRetryDelayMs, 500),
        exitFailureCostSol: numeric(request.query.exitFailureCostSol, undefined),
        platformFeePct: numeric(
          request.query.platformFeePct,
          defaultCosts.platformFeePct ?? this.config.labels.configuredTradingCostPct,
        ),
        buySlippagePct: numeric(request.query.buySlippagePct, defaultCosts.buySlippagePct ?? 0),
        sellSlippagePct: numeric(request.query.sellSlippagePct, defaultCosts.sellSlippagePct ?? 0),
        priceImpactPct: numeric(request.query.priceImpactPct, defaultCosts.priceImpactPct ?? 0),
        baseTxFeeSol: numeric(request.query.baseTxFeeSol, defaultCosts.baseTxFeeSol ?? 0),
        priorityFeeSol: numeric(request.query.priorityFeeSol, defaultCosts.priorityFeeSol ?? 0),
        jitoTipSol: numeric(request.query.jitoTipSol, defaultCosts.jitoTipSol ?? 0),
        fixedCostSol: numeric(request.query.fixedCostSol, defaultCosts.fixedCostSol ?? 0),
        positionSizeSol: numeric(request.query.positionSizeSol, defaultCosts.positionSizeSol ?? 0.2),
        entryFailureRatePct: numeric(
          request.query.entryFailureRatePct ?? request.query.failureRatePct,
          defaultCosts.entryFailureRatePct ?? defaultCosts.failureRatePct ?? 0,
        ),
        entryFailureCostPct: numeric(
          request.query.entryFailureCostPct ?? request.query.failureLossPct,
          defaultCosts.entryFailureCostPct ?? defaultCosts.failureLossPct ?? 1,
        ),
        minNetFlowW3: numeric(request.query.minNetFlowW3, this.config.strategy.minNetFlowW3Sol),
        maxNetFlowW3: numeric(request.query.maxNetFlowW3, undefined),
        minFlowAccel: numeric(request.query.minFlowAccel, defaultMinFlowAccel),
        minAgeMs: secondsToMs(request.query.minAgeSec, undefined),
        maxAgeMs: secondsToMs(request.query.maxAgeSec, undefined),
        minCurvePct: numeric(request.query.minCurvePct, undefined),
        maxCurvePct: numeric(request.query.maxCurvePct, undefined),
        minDeltaNetFlow12: numeric(request.query.minDeltaNetFlow12, undefined),
        minDeltaNetFlow23: numeric(request.query.minDeltaNetFlow23, undefined),
        minBuyTxW3: numeric(request.query.minBuyTxW3, undefined),
        minUniqueBuyersW3: numeric(request.query.minUniqueBuyersW3, undefined),
        maxBuyTxW3: numeric(request.query.maxBuyTxW3, undefined),
        maxUniqueBuyersW3: numeric(request.query.maxUniqueBuyersW3, undefined),
        excludedMints: request.query.excludedMints,
        maxEntryPriceJumpPct: numeric(request.query.maxEntryPriceJumpPct, undefined),
        firstSignalOnly: boolean(request.query.firstSignalOnly, false),
        signalCooldownMs: numeric(
          request.query.signalCooldownMs,
          this.config.backtest?.signalCooldownMs ?? 5_000,
        ),
        singlePositionPerMint: boolean(
          request.query.singlePositionPerMint,
          this.config.backtest?.singlePositionPerMint ?? true,
        ),
        signalVariant,
        fromMs: request.query.fromMs,
        toMs: request.query.toMs,
        dataCutoffMs: request.query.dataCutoffMs,
        splitRatio: numeric(request.query.splitRatio, 0.7),
        bootstrapSamples: numeric(request.query.bootstrapSamples, 500),
        includeRows: false,
      });
      response.json(result);
    });

    this.app.get('/api/smart-wallets', (_request, response) => {
      const cached = this.dashboardReadModel.read('smart-wallets');
      response.json(this.dashboardReadModel.enabled
        ? (cached?.value || [])
        : this.store.smartWalletStats(this.config.smartWallets));
    });

    this.app.get('/api/smart-wallet-registry', (request, response) => {
      const cached = this._dashboardSnapshot('smart-wallet-registry', () => (
        this.smartWalletRegistry?.dashboard(numeric(request.query.limit, 100)) || {
          enabled: false,
          observerOnly: true,
          sendsTransactions: false,
          wallets: [],
        }
      ));
      response.json({
        generatedAt: Date.now(),
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/smart-consensus-overlay', (request, response) => {
      const cached = this._dashboardSnapshot('smart-consensus-overlay', () => (
        this.smartWalletConsensusOverlay?.dashboard(
          numeric(request.query.limit, 100),
        ) || {
          enabled: false,
          observerOnly: true,
          sendsTransactions: false,
          profiles: [],
          recent: [],
        }
      ));
      response.json({
        generatedAt: Date.now(),
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/signal-repetition', (_request, response) => {
      const cached = this.dashboardReadModel.read('signal-repetition');
      response.json(this.dashboardReadModel.enabled
        ? (cached?.value || {
          primarySignals: 0,
          uniqueMints: 0,
          signalEpisodes: 0,
          laterSignals: 0,
        })
        : this.store.signalRepetitionStats());
    });

    this.app.get('/api/live-trading', (request, response) => {
      const runtime = this.trader?.health() || {
        mode: 'DISABLED',
        enabled: false,
        dryRun: true,
        activePositions: 0,
      };
      const strategyId = request.query.strategyId
        || runtime.strategies?.[0]?.id
        || null;
      const strategy = runtime.strategies?.find((row) => row.id === strategyId) || null;
      const cached = strategyId
        ? this.dashboardReadModel.read(`live-trading:${strategyId}`)
        : null;
      const databaseDashboard = normalizedLiveTradingDashboard(
        this.dashboardReadModel.enabled
          ? cached?.value
          : this.store.liveTradingDashboard({
          strategyId,
          positionLimit: numeric(request.query.positionLimit, 30),
          orderLimit: numeric(request.query.orderLimit, 30),
          decisionLimit: numeric(request.query.decisionLimit, 30),
          }),
        strategyId,
      );
      response.json({
        generatedAt: Date.now(),
        runtime,
        monitoredWallets: this.config.smartWallets,
        sourceDiagnostics: this._liveSourceDiagnostics(strategy),
        ...databaseDashboard,
        dashboardSnapshot: this.dashboardReadModel.enabled
          ? (cached ? {
            status: 'READY', generatedAt: cached.generatedAt, durationMs: cached.durationMs,
          } : { status: 'PREPARING' })
          : { status: 'DIRECT' },
      });
    });

    this.app.get('/api/primary-signal-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:primary', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('primary-shadow'),
        ...this.store.primarySignalShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.signalShadow?.health() || {
          enabled: false,
          mode: 'SHADOW',
          activePositions: 0,
          pendingEntries: 0,
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/flow-first-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:flow-first', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('flow-first'),
        ...this.store.flowFirstShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.flowFirstShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.flowFirstShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_C',
          sendsTransactions: false,
          cohorts: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/smart-pullback-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:smart-pullback', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('smart-pullback'),
        ...this.store.smartPullbackShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.smartPullbackShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.smartPullbackShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_AB',
          sendsTransactions: false,
          cohorts: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/smart-open-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:smart-open', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('smart-open'),
        ...this.store.smartOpenShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.smartOpenShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.smartOpenShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_SMART_OPEN',
          sendsTransactions: false,
          cohorts: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/launch-quality-observer', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:launch-quality', () => (
        this.store.launchQualityDashboard({
          observationLimit: numeric(request.query.observationLimit, 30),
          snapshotLimit: numeric(request.query.snapshotLimit, 60),
        })
      ));
      response.json({
        generatedAt: Date.now(),
        runtime: this.launchQualityObserver?.health() || {
          enabled: false,
          mode: 'OBSERVER_ONLY',
          sendsTransactions: false,
          opensSimulatedPositions: false,
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/migration-second-leg-observer', async (request, response, next) => {
      try {
        const dashboard = await this.store.dashboardQueryInWorker(
          'migrationSecondLegDashboard',
          {
            observationLimit: numeric(request.query.observationLimit, 40),
            snapshotLimit: numeric(request.query.snapshotLimit, 100),
            statsSnapshotLimit: numeric(request.query.statsSnapshotLimit, 200000),
          },
        );
        response.json({
          generatedAt: Date.now(),
          runtime: this.migrationSecondLegObserver?.health() || {
            enabled: false,
            mode: 'M2F_OBSERVER_ONLY',
            code: 'M2F-OBS',
            sendsTransactions: false,
            opensSimulatedPositions: false,
            addsRpcRequests: false,
          },
          runtimeShadow: this.migrationSecondLegShadow?.health() || {
            enabled: false,
            mode: 'SHADOW_PMO_STRICT_PAIR_MATRIX',
            code: 'PMO / PMO-RUGX',
            sendsTransactions: false,
            guardRequired: true,
          },
          ...dashboard,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.get('/api/same-slot-dump-backrun-shadow', (request, response) => {
      response.json(this.sameSlotDumpBackrunShadow?.dashboard({
        positionLimit: numeric(request.query.positionLimit, 50),
      }) || {
        generatedAt: Date.now(),
        runtime: {
          enabled: false,
          mode: 'SHADOW_SAME_SLOT_DUMP_BACKRUN',
          code: 'SDBR',
          sendsTransactions: false,
          addsRpcRequests: false,
        },
        cohorts: [],
        positions: [],
      });
    });

    this.app.get('/api/launch-pullback-shadow', async (request, response, next) => {
      try {
        const result = await this.store.dashboardQueryInWorker(
          'launchPullbackDashboardBundle',
          {
            positionLimit: numeric(request.query.positionLimit, 30),
            bigWinnerPct: this.config.launchPullbackShadow?.bigWinnerPct ?? 50,
          },
        );
        response.json({
          generatedAt: Date.now(),
          runtime: this.launchPullbackShadow?.health() || {
            enabled: false,
            mode: 'SHADOW_F',
            sendsTransactions: false,
            cohorts: [],
          },
          timeSessions: result.timeSessions || [],
          ...(result.dashboard || {}),
          dashboardQuery: result.dashboardQuery,
        });
      } catch (error) {
        next(error);
      }
    });

    this.app.get('/api/migrated-drop-rebound-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:migrated-rebound', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('migrated-rebound'),
        ...this.store.migratedDropReboundShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.migratedDropReboundShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.migratedDropReboundShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_G',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/holder-growth-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:holder-growth', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('holder-growth'),
        ...this.store.holderGrowthShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          bigWinnerPct: this.config.holderGrowthShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.holderGrowthShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_N',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/quality-leader-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:quality-leader', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('quality-leader'),
        ...this.store.qualityLeaderShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          bigWinnerPct: this.config.qualityLeaderShadow?.bigWinnerPct ?? 100,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.qualityLeaderShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_QL',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/big-winner-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.bigWinnerShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_BW',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.bigWinnerShadow
          ? this.store.shadowTimeSessionDashboard('big-winner')
          : { sessions: [] },
        ...(this.bigWinnerShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
        }) || { cohorts: [], positions: [] }),
      });
    });

    this.app.get('/api/migration-continuity-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:migration-continuity', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('migration-continuity'),
        ...this.store.migrationContinuityShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          cacheStats: true,
        }),
      }));
      response.json({
        runtime: this.migrationContinuityShadow?.health() || {
          enabled: false, mode: 'SHADOW_M', sendsTransactions: false,
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/bonding-curve-momentum-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:bonding-momentum', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('bonding-momentum'),
        ...this.store.bondingCurveMomentumShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          snapshotLimit: numeric(request.query.snapshotLimit, 40),
          bigWinnerPct: this.config.bondingCurveMomentumShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.bondingCurveMomentumShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_H',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/range-scalper-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:range-scalper', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('range-scalper'),
        ...this.store.rangeScalperShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.rangeScalperShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_J',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/flow-smart-confirm-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:flow-smart-confirm', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('flow-smart-confirm'),
        ...this.store.flowSmartConfirmShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.flowSmartConfirmShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_L',
          sendsTransactions: false,
          cohorts: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/smart-like-early-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.smartLikeEarlyShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_SMART_LIKE_EARLY',
          sendsTransactions: false,
          entryProfiles: [],
          addProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.smartLikeEarlyShadow
          ? this.store.shadowTimeSessionDashboard('smart-like-early')
          : { sessions: [] },
        ...(this.smartLikeEarlyShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
        }) || { cohorts: [], positions: [] }),
      });
    });

    this.app.get('/api/smart-resonance-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.smartResonanceShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_SR',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.smartResonanceShadow
          ? this.store.shadowTimeSessionDashboard('smart-resonance')
          : { sessions: [] },
        ...(this.smartResonanceShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
        }) || { cohorts: [], positions: [] }),
      });
    });

    this.app.get('/api/smart-consensus-v2-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        ...(this.smartWalletConsensusFlowRunnerShadow?.dashboard(
          numeric(request.query.positionLimit, 100),
        ) || {
          enabled: false,
          observerOnly: true,
          sendsTransactions: false,
          recent: [],
          summary: [],
        }),
      });
    });

    this.app.get('/api/smart-wallet-rug-escape-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        ...(this.smartWalletRugEscapeShadow?.dashboard(
          numeric(request.query.positionLimit, 100),
        ) || {
          enabled: false,
          mode: 'SHADOW_SWRE',
          sendsTransactions: false,
          strategy: {},
          groups: [],
          walletStats: [],
          positions: [],
          health: { enabled: false },
        }),
      });
    });

    this.app.get('/api/smart-first-open-right-tail-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        ...(this.smartWalletFirstOpenRightTailShadow?.dashboard(
          numeric(request.query.positionLimit, 100),
        ) || {
          enabled: false,
          mode: 'SHADOW_SWFO_RT',
          sendsTransactions: false,
          strategy: {},
          groups: [],
          positions: [],
          health: { enabled: false },
        }),
      });
    });

    this.app.get('/api/individual-smart-wallet-shadows', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        ...(this.individualSmartWalletShadows?.dashboard(
          numeric(request.query.positionLimit, 100),
        ) || {
          enabled: false,
          mode: 'SHADOW_INDIVIDUAL_SMART_WALLETS',
          sendsTransactions: false,
          pooledConsensus: false,
          strategies: [],
          health: { enabled: false },
        }),
      });
    });

    this.app.get('/api/public-flow-lead-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.publicFlowLeadShadow?.health() || {
          enabled: false,
          mode: 'OBSERVER_PFL',
          sendsTransactions: false,
          observerOnly: true,
          simulatesPositions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.publicFlowLeadShadow
          ? this.store.shadowTimeSessionDashboard('public-flow-lead')
          : { sessions: [] },
        ...(this.publicFlowLeadShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
        }) || { cohorts: [], positions: [] }),
      });
    });

    this.app.get('/api/cya-slot-flow-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.cyaSlotFlowShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_CSF',
          sendsTransactions: false,
          entryProfiles: [],
          managementProfiles: [],
        },
        timeSessions: this.cyaSlotFlowShadow
          ? this.store.shadowTimeSessionDashboard('cya-slot-flow')
          : { sessions: [] },
        ...(this.cyaSlotFlowShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
        }) || { cohorts: [], positions: [] }),
      });
    });

    this.app.get('/api/public-flow-recovery-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.publicFlowAbsorptionRecoveryShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_PUBLIC_FLOW_ABSORPTION_RECOVERY',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.publicFlowAbsorptionRecoveryShadow
          ? this.store.shadowTimeSessionDashboard('public-flow-recovery')
          : { sessions: [] },
        ...(this.publicFlowAbsorptionRecoveryShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 50),
          observationLimit: numeric(request.query.observationLimit, 50),
        }) || {
          cohorts: [], positions: [], observations: [], observationStats: {},
        }),
      });
    });

    this.app.get('/api/creator-affinity-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.creatorAffinityShadow?.health() || {
          enabled: false,
          mode: 'OBSERVER_CAF',
          sendsTransactions: false,
          observerOnly: true,
          simulatesPositions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.creatorAffinityShadow
          ? this.store.shadowTimeSessionDashboard('creator-affinity')
          : { sessions: [] },
        ...(this.creatorAffinityShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
        }) || { cohorts: [], positions: [] }),
      });
    });

    this.app.get('/api/feature-edge-audit', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.featureEdgeAudit?.health() || {
          enabled: false,
          mode: 'FEA-OBS-V2',
          observerOnly: true,
          sendsTransactions: false,
          extraRpcCalls: false,
        },
        ...(this.featureEdgeAudit?.dashboard({
          limit: numeric(request.query.limit, 2_000),
        }) || {
          summary: {}, horizons: [], families: [], scores: [], recent: [],
          bnh: {}, bnhRecent: [],
        }),
      });
    });

    this.app.get('/api/post-migration-survivor', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        ...(this.postMigrationSurvivor?.dashboard({
          limit: numeric(request.query.limit, 2_000),
        }) || {
          runtime: {
            enabled: false,
            mode: 'PM_SURV_OBSERVER_ONLY',
            observerOnly: true,
            sendsTransactions: false,
            extraRpcCalls: false,
          },
          summary: {},
          stages: [],
          dropReasons: [],
          recent: [],
          milestones: [],
        }),
      });
    });

    this.app.get('/api/cya-organic-burst-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.cyaOrganicBurstShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_COB',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        ...(this.cyaOrganicBurstShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
        }) || { cohorts: [], positions: [], rugComparisons: [] }),
      });
    });

    this.app.get('/api/early-pure-buy-burst-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.earlyPureBuyBurstShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_EB',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        ...(this.earlyPureBuyBurstShadow?.dashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
        }) || { cohorts: [], positions: [] }),
      });
    });

    this.app.get('/api/cya-early-pyramid-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:cya-early-pyramid', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('cya-early-pyramid'),
        ...this.store.cyaEarlyPyramidShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          cacheStats: true,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.cyaEarlyPyramidShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_K',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/graduation-hold-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:graduation-hold', () => ({
        timeSessions: this.store.shadowTimeSessionDashboard('graduation-hold'),
        ...this.store.graduationHoldShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.graduationHoldShadow?.bigWinnerPct ?? 50,
        }),
      }));
      response.json({
        generatedAt: Date.now(),
        runtime: this.graduationHoldShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_I',
          sendsTransactions: false,
          cohorts: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/api/graduation-acceleration-shadow', (request, response) => {
      const cached = this._dashboardSnapshot('shadow:graduation-acceleration', () => (
        this.store.graduationAccelerationShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          bigWinnerPct: this.config.graduationAccelerationShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        })
      ));
      response.json({
        generatedAt: Date.now(),
        runtime: this.graduationAccelerationShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_O',
          sendsTransactions: false,
          entryProfiles: [],
          capacitySols: [],
        },
        ...cached.value,
        dashboardSnapshot: cached.metadata,
      });
    });

    this.app.get('/health', (_request, response) => {
      const now = Date.now();
      const engine = this.engine.stats();
      const stream = this.stream.health();
      const database = this.store.healthSnapshot();
      const migratedRebound = this.migratedDropReboundShadow?.health() || {};
      const streaming = stream.regions.some((region) => region.state === 'connected');
      const databaseReady = databaseOperational(database.writeStatus);
      response.set('Cache-Control', 'no-store');
      response.json({
        // Keep the liveness status tied to the stream so an external watchdog
        // cannot create a restart loop for a database lock. Readiness and the
        // detailed API expose the degraded database state separately.
        status: streaming ? 'streaming' : 'waiting',
        ready: databaseReady,
        uptimeMs: now - this.startedAt,
        dataLatencyMs: engine.lastTradeAt ? Math.max(0, now - engine.lastTradeAt) : null,
        databaseWriteStatus: database.writeStatus,
        databaseQueuedTradeLagMs: database.queuedTradeLagMs,
        runtime: this.runtimeIdentity,
        stream: {
          activeLabel: stream.activeLabel,
          subscriptionMode: stream.subscriptionMode,
          transactionsReceived: stream.transactionsReceived,
          lastTransactionAt: stream.lastTransactionAt,
          requestedAmmMintCount: stream.requestedAmmMintCount,
          appliedAmmMintCount: stream.appliedAmmMintCount,
          requestedSubscriptionVersion: stream.requestedSubscriptionVersion,
          appliedSubscriptionVersion: stream.appliedSubscriptionVersion,
          errors: stream.errors,
          failovers: stream.failovers,
          staleFailovers: stream.staleFailovers,
          watchdogEventLoopDeferrals: stream.watchdogEventLoopDeferrals,
          lastWatchdogLagMs: stream.lastWatchdogLagMs,
        },
        migratedDropRebound: {
          trackedMints: migratedRebound.trackedMints,
          pendingMigrationMints: migratedRebound.pendingMigrationMints,
          migratedObservationMints: migratedRebound.migratedObservationMints,
          graduationEventsObserved: migratedRebound.graduationEventsObserved,
          migrationEventsObserved: migratedRebound.migrationEventsObserved,
          firstAmmMigrationRecoveries: migratedRebound.firstAmmMigrationRecoveries,
          resolvedMigrationEvents: migratedRebound.resolvedMigrationEvents,
          migrationResolutionPct: migratedRebound.migrationResolutionPct,
          migrationResolutionMode: migratedRebound.migrationResolutionMode,
          ammTradesObserved: migratedRebound.ammTradesObserved,
          missingMigratedAtAmmTrades: migratedRebound.missingMigratedAtAmmTrades,
          ammMigrationMetadataCoveragePct:
            migratedRebound.ammMigrationMetadataCoveragePct,
          postMigrationEligibleTrades: migratedRebound.postMigrationEligibleTrades,
          signals: migratedRebound.signals,
          lastAmmTradeObservedAt: migratedRebound.lastAmmTradeObservedAt,
        },
        smartWalletMaintenance: this.smartWalletRegistry?.maintenanceHealth() || null,
      });
    });

    this.app.get('/api/health', (_request, response) => {
      const now = Date.now();
      const engine = this.engine.stats();
      const stream = this.stream.health();
      const database = this.store.healthSnapshot();
      const streaming = stream.regions.some((region) => region.state === 'connected');
      response.json({
        status: streaming
          ? (databaseOperational(database.writeStatus) ? 'streaming' : 'degraded')
          : 'waiting',
        uptimeMs: now - this.startedAt,
        dataLatencyMs: engine.lastTradeAt ? Math.max(0, now - engine.lastTradeAt) : null,
        runtime: this.runtimeIdentity,
        engine,
        labels: this.labeler.stats(),
        stream,
        database: {
          ...database,
          retentionMaintenance: this.retentionMaintenance,
        },
        dashboardReadModel: this.dashboardReadModel.health(),
        trading: this.trader?.health() || null,
        signalShadow: this.signalShadow?.health() || null,
        flowFirstShadow: this.flowFirstShadow?.health() || null,
        smartPullbackShadow: this.smartPullbackShadow?.health() || null,
        smartOpenShadow: this.smartOpenShadow?.health() || null,
        flowSmartConfirmShadow: this.flowSmartConfirmShadow?.health() || null,
        smartLikeEarlyShadow: this.smartLikeEarlyShadow?.health() || null,
        preEntryRugRisk: this.preEntryRugRisk?.health() || null,
        smartWalletRegistry: this.smartWalletRegistry?.health() || null,
        smartWalletConsensusFlowRunnerShadow:
          this.smartWalletConsensusFlowRunnerShadow?.health() || null,
        smartWalletConsensusOverlay: this.smartWalletConsensusOverlay?.health() || null,
        smartResonanceShadow: this.smartResonanceShadow?.health() || null,
        smartWalletRugEscapeShadow: this.smartWalletRugEscapeShadow?.health() || null,
        smartWalletFirstOpenRightTailShadow:
          this.smartWalletFirstOpenRightTailShadow?.health() || null,
        individualSmartWalletShadows:
          this.individualSmartWalletShadows?.health() || null,
        publicFlowLeadShadow: this.publicFlowLeadShadow?.health() || null,
        publicFlowAbsorptionRecoveryShadow:
          this.publicFlowAbsorptionRecoveryShadow?.health() || null,
        creatorAffinityShadow: this.creatorAffinityShadow?.health() || null,
        cyaSlotFlowShadow: this.cyaSlotFlowShadow?.health() || null,
        cyaOrganicBurstShadow: this.cyaOrganicBurstShadow?.health() || null,
        earlyPureBuyBurstShadow: this.earlyPureBuyBurstShadow?.health() || null,
        sameSlotDumpBackrunShadow: this.sameSlotDumpBackrunShadow?.health() || null,
        launchPullbackShadow: this.launchPullbackShadow?.health() || null,
        launchQualityObserver: this.launchQualityObserver?.health() || null,
        migrationSecondLegObserver: this.migrationSecondLegObserver?.health() || null,
        migrationSecondLegShadow: this.migrationSecondLegShadow?.health() || null,
        holderGrowthShadow: this.holderGrowthShadow?.health() || null,
        qualityLeaderShadow: this.qualityLeaderShadow?.health() || null,
        bigWinnerShadow: this.bigWinnerShadow?.health() || null,
        migratedDropReboundShadow: this.migratedDropReboundShadow?.health() || null,
        migrationContinuityShadow: this.migrationContinuityShadow?.health() || null,
        rangeScalperShadow: this.rangeScalperShadow?.health() || null,
        cyaEarlyPyramidShadow: this.cyaEarlyPyramidShadow?.health() || null,
        bondingCurveMomentumShadow: this.bondingCurveMomentumShadow?.health() || null,
        graduationHoldShadow: this.graduationHoldShadow?.health() || null,
        graduationAccelerationShadow: this.graduationAccelerationShadow?.health() || null,
        featureEdgeAudit: this.featureEdgeAudit?.health() || null,
        postMigrationSurvivor: this.postMigrationSurvivor?.health() || null,
      });
    });

    // Keep API failures machine-readable. Without this guard, an omitted API
    // route falls through to the SPA index and returns HTML with status 200,
    // which surfaces in the dashboard as a misleading JSON parse failure.
    this.app.use('/api', (request, response) => {
      response.status(404).json({
        error: 'api route not found',
        path: request.originalUrl,
      });
    });

    this.app.use(express.static(publicDir, { maxAge: '5m', index: 'index.html' }));
    this.app.get('*', (_request, response) => response.sendFile(path.join(publicDir, 'index.html')));

    this.app.use((error, _request, response, _next) => {
      console.error('[Dashboard]', error);
      response.status(500).json({ error: error.message || 'internal error' });
    });
  }

  start() {
    if (this.httpServer) return Promise.resolve();
    this.dashboardReadModel.start();
    return new Promise((resolve, reject) => {
      const server = this.app.listen(this.config.server.port, this.config.server.host, () => {
        this.httpServer = server;
        resolve();
      });
      server.once('error', reject);
    });
  }

  async stop() {
    if (!this.httpServer) {
      await this.dashboardReadModel.stop();
      return;
    }
    await new Promise((resolve) => {
      this.httpServer.close(() => {
        this.httpServer = null;
        resolve();
      });
    });
    await this.dashboardReadModel.stop();
  }
}

module.exports = ResearchServer;
