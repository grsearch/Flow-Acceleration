'use strict';

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

class ResearchServer {
  constructor({
    config, store, engine, stream, labeler, trader = null, signalShadow = null,
    flowFirstShadow = null, smartPullbackShadow = null, smartOpenShadow = null,
    flowSmartConfirmShadow = null,
    launchPullbackShadow = null, launchQualityObserver = null,
    migratedDropReboundShadow = null,
    migrationContinuityShadow = null,
    rangeScalperShadow = null,
    cyaEarlyPyramidShadow = null,
    bondingCurveMomentumShadow = null,
    graduationHoldShadow = null,
    holderGrowthShadow = null,
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
    this.launchPullbackShadow = launchPullbackShadow;
    this.launchQualityObserver = launchQualityObserver;
    this.migratedDropReboundShadow = migratedDropReboundShadow;
    this.migrationContinuityShadow = migrationContinuityShadow;
    this.rangeScalperShadow = rangeScalperShadow;
    this.cyaEarlyPyramidShadow = cyaEarlyPyramidShadow;
    this.bondingCurveMomentumShadow = bondingCurveMomentumShadow;
    this.graduationHoldShadow = graduationHoldShadow;
    this.holderGrowthShadow = holderGrowthShadow;
    this.app = express();
    this.httpServer = null;
    this.startedAt = Date.now();
    this._routes();
  }

  _routes() {
    const publicDir = path.join(__dirname, 'public');
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '64kb' }));

    this.app.get('/api/overview', (_request, response) => {
      response.json(this.store.overview(Date.now(), this.engine.stats().candidateCount));
    });

    this.app.get('/api/signals', (request, response) => {
      response.json(this.store.recentSignals(numeric(request.query.limit, 200)));
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
        },
        timeSessions: this.store.shadowTimeSessionDashboard('holder-growth'),
        ...this.store.holderGrowthShadowDashboard({
          positionLimit: numeric(request.query.positionLimit, 100),
          cacheStats: true,
        }),
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
        database: this.store.health(),
        trading: this.trader?.health() || null,
        signalShadow: this.signalShadow?.health() || null,
        flowFirstShadow: this.flowFirstShadow?.health() || null,
        smartPullbackShadow: this.smartPullbackShadow?.health() || null,
        smartOpenShadow: this.smartOpenShadow?.health() || null,
        flowSmartConfirmShadow: this.flowSmartConfirmShadow?.health() || null,
        launchPullbackShadow: this.launchPullbackShadow?.health() || null,
        launchQualityObserver: this.launchQualityObserver?.health() || null,
        holderGrowthShadow: this.holderGrowthShadow?.health() || null,
        migratedDropReboundShadow: this.migratedDropReboundShadow?.health() || null,
        migrationContinuityShadow: this.migrationContinuityShadow?.health() || null,
        rangeScalperShadow: this.rangeScalperShadow?.health() || null,
        cyaEarlyPyramidShadow: this.cyaEarlyPyramidShadow?.health() || null,
        bondingCurveMomentumShadow: this.bondingCurveMomentumShadow?.health() || null,
        graduationHoldShadow: this.graduationHoldShadow?.health() || null,
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
