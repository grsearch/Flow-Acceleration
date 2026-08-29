'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { runBacktest } = require('../core/FlowBacktester');

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
    config, store, engine, stream, labeler, trader = null, signalShadow = null,
    flowFirstShadow = null, smartPullbackShadow = null, smartOpenShadow = null,
    flowSmartConfirmShadow = null,
    smartLikeEarlyShadow = null,
    preEntryRugRisk = null,
    smartResonanceShadow = null,
    smartWalletRugEscapeShadow = null,
    smartWalletFirstOpenRightTailShadow = null,
    publicFlowLeadShadow = null,
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
    this.smartResonanceShadow = smartResonanceShadow;
    this.smartWalletRugEscapeShadow = smartWalletRugEscapeShadow;
    this.smartWalletFirstOpenRightTailShadow = smartWalletFirstOpenRightTailShadow;
    this.publicFlowLeadShadow = publicFlowLeadShadow;
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
    this.app = express();
    this.httpServer = null;
    this.startedAt = Date.now();
    this.slowRouteLastLoggedAt = new Map();
    this._routes();
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
      response.json(this.store.overview(Date.now(), this.engine.stats().candidateCount));
    });

    this.app.get('/api/signals', (request, response) => {
      response.json(this.store.recentSignals(numeric(request.query.limit, 200)));
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
          'smart-wallet-rug-escape': enabled('smartWalletRugEscapeShadow'),
          'smart-first-open-right-tail': enabled('smartWalletFirstOpenRightTailShadow'),
          'public-flow-lead': enabled('publicFlowLeadShadow'),
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
        noExitLossPct: numeric(
          request.query.noExitLossPct,
          this.config.backtest?.noExitLossPct ?? 100,
        ),
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
      response.json(this.store.smartWalletStats(this.config.smartWallets));
    });

    this.app.get('/api/signal-repetition', (_request, response) => {
      response.json(this.store.signalRepetitionStats());
    });

    this.app.get('/api/live-trading', (request, response) => {
      const runtime = this.trader?.health() || {
        mode: 'DISABLED',
        enabled: false,
        dryRun: true,
        activePositions: 0,
      };
      response.json({
        generatedAt: Date.now(),
        runtime,
        monitoredWallets: this.config.smartWallets,
        ...this.store.liveTradingDashboard({
          strategyId: request.query.strategyId
            || runtime.strategies?.[0]?.id
            || null,
          positionLimit: numeric(request.query.positionLimit, 30),
          orderLimit: numeric(request.query.orderLimit, 30),
          decisionLimit: numeric(request.query.decisionLimit, 30),
        }),
      });
    });

    this.app.get('/api/primary-signal-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.signalShadow?.health() || {
          enabled: false,
          mode: 'SHADOW',
          activePositions: 0,
          pendingEntries: 0,
        },
        timeSessions: this.store.shadowTimeSessionDashboard('primary-shadow'),
        ...this.store.primarySignalShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/flow-first-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.flowFirstShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_C',
          sendsTransactions: false,
          cohorts: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('flow-first'),
        ...this.store.flowFirstShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.flowFirstShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/smart-pullback-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.smartPullbackShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_AB',
          sendsTransactions: false,
          cohorts: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('smart-pullback'),
        ...this.store.smartPullbackShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.smartPullbackShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/smart-open-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.smartOpenShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_SMART_OPEN',
          sendsTransactions: false,
          cohorts: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('smart-open'),
        ...this.store.smartOpenShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.smartOpenShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/launch-quality-observer', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.launchQualityObserver?.health() || {
          enabled: false,
          mode: 'OBSERVER_ONLY',
          sendsTransactions: false,
          opensSimulatedPositions: false,
        },
        ...this.store.launchQualityDashboard({
          observationLimit: numeric(request.query.observationLimit, 30),
          snapshotLimit: numeric(request.query.snapshotLimit, 60),
        }),
      });
    });

    this.app.get('/api/migration-second-leg-observer', (request, response) => {
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
          mode: 'SHADOW_M2F_RESEARCH_MATRIX',
          code: 'M2F-MATRIX',
          sendsTransactions: false,
          guardRequired: true,
        },
        ...this.store.migrationSecondLegDashboard({
          observationLimit: numeric(request.query.observationLimit, 40),
          snapshotLimit: numeric(request.query.snapshotLimit, 100),
        }),
      });
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

    this.app.get('/api/launch-pullback-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.launchPullbackShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_F',
          sendsTransactions: false,
          cohorts: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('launch-pullback'),
        ...this.store.launchPullbackShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.launchPullbackShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/migrated-drop-rebound-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.migratedDropReboundShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_G',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('migrated-rebound'),
        ...this.store.migratedDropReboundShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.migratedDropReboundShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/holder-growth-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.holderGrowthShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_N',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('holder-growth'),
        ...this.store.holderGrowthShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          bigWinnerPct: this.config.holderGrowthShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/quality-leader-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.qualityLeaderShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_QL',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('quality-leader'),
        ...this.store.qualityLeaderShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          bigWinnerPct: this.config.qualityLeaderShadow?.bigWinnerPct ?? 100,
        }),
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
      response.json({
        runtime: this.migrationContinuityShadow?.health() || {
          enabled: false, mode: 'SHADOW_M', sendsTransactions: false,
        },
        timeSessions: this.store.shadowTimeSessionDashboard('migration-continuity'),
        ...this.store.migrationContinuityShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/bonding-curve-momentum-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.bondingCurveMomentumShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_H',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('bonding-momentum'),
        ...this.store.bondingCurveMomentumShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          snapshotLimit: numeric(request.query.snapshotLimit, 40),
          bigWinnerPct: this.config.bondingCurveMomentumShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/range-scalper-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.rangeScalperShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_J',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('range-scalper'),
        ...this.store.rangeScalperShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/flow-smart-confirm-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.flowSmartConfirmShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_L',
          sendsTransactions: false,
          cohorts: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('flow-smart-confirm'),
        ...this.store.flowSmartConfirmShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          cacheStats: true,
        }),
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
          mode: 'FEA-OBS',
          observerOnly: true,
          sendsTransactions: false,
          extraRpcCalls: false,
        },
        ...(this.featureEdgeAudit?.dashboard({
          limit: numeric(request.query.limit, 2_000),
        }) || { summary: {}, horizons: [], families: [], scores: [], recent: [] }),
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
        }) || { cohorts: [], positions: [] }),
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
      response.json({
        generatedAt: Date.now(),
        runtime: this.cyaEarlyPyramidShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_K',
          sendsTransactions: false,
          entryProfiles: [],
          exitProfiles: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('cya-early-pyramid'),
        ...this.store.cyaEarlyPyramidShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          cacheStats: true,
        }),
      });
    });

    this.app.get('/api/graduation-hold-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.graduationHoldShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_I',
          sendsTransactions: false,
          cohorts: [],
        },
        timeSessions: this.store.shadowTimeSessionDashboard('graduation-hold'),
        ...this.store.graduationHoldShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 30),
          bigWinnerPct: this.config.graduationHoldShadow?.bigWinnerPct ?? 50,
        }),
      });
    });

    this.app.get('/api/graduation-acceleration-shadow', (request, response) => {
      response.json({
        generatedAt: Date.now(),
        runtime: this.graduationAccelerationShadow?.health() || {
          enabled: false,
          mode: 'SHADOW_O',
          sendsTransactions: false,
          entryProfiles: [],
          capacitySols: [],
        },
        ...this.store.graduationAccelerationShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          bigWinnerPct: this.config.graduationAccelerationShadow?.bigWinnerPct ?? 50,
          cacheStats: true,
        }),
      });
    });

    this.app.get('/health', (_request, response) => {
      const now = Date.now();
      const engine = this.engine.stats();
      const stream = this.stream.health();
      response.set('Cache-Control', 'no-store');
      response.json({
        status: stream.regions.some((region) => region.state === 'connected')
          ? 'streaming'
          : 'waiting',
        ready: true,
        uptimeMs: now - this.startedAt,
        dataLatencyMs: engine.lastTradeAt ? Math.max(0, now - engine.lastTradeAt) : null,
      });
    });

    this.app.get('/api/health', (_request, response) => {
      const now = Date.now();
      const engine = this.engine.stats();
      response.json({
        status: this.stream.health().regions.some((region) => region.state === 'connected')
          ? 'streaming'
          : 'waiting',
        uptimeMs: now - this.startedAt,
        dataLatencyMs: engine.lastTradeAt ? Math.max(0, now - engine.lastTradeAt) : null,
        engine,
        labels: this.labeler.stats(),
        stream: this.stream.health(),
        database: {
          ...this.store.healthSnapshot(),
          retentionMaintenance: this.retentionMaintenance,
        },
        trading: this.trader?.health() || null,
        signalShadow: this.signalShadow?.health() || null,
        flowFirstShadow: this.flowFirstShadow?.health() || null,
        smartPullbackShadow: this.smartPullbackShadow?.health() || null,
        smartOpenShadow: this.smartOpenShadow?.health() || null,
        flowSmartConfirmShadow: this.flowSmartConfirmShadow?.health() || null,
        smartLikeEarlyShadow: this.smartLikeEarlyShadow?.health() || null,
        preEntryRugRisk: this.preEntryRugRisk?.health() || null,
        smartResonanceShadow: this.smartResonanceShadow?.health() || null,
        smartWalletRugEscapeShadow: this.smartWalletRugEscapeShadow?.health() || null,
        smartWalletFirstOpenRightTailShadow:
          this.smartWalletFirstOpenRightTailShadow?.health() || null,
        publicFlowLeadShadow: this.publicFlowLeadShadow?.health() || null,
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
    return new Promise((resolve, reject) => {
      const server = this.app.listen(this.config.server.port, this.config.server.host, () => {
        this.httpServer = server;
        resolve();
      });
      server.once('error', reject);
    });
  }

  stop() {
    if (!this.httpServer) return Promise.resolve();
    return new Promise((resolve) => {
      this.httpServer.close(() => {
        this.httpServer = null;
        resolve();
      });
    });
  }
}

module.exports = ResearchServer;
