'use strict';

const path = require('path');
const express = require('express');
const { runBacktest } = require('../core/FlowBacktester');

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class ResearchServer {
  constructor({ config, store, engine, stream, labeler }) {
    this.config = config;
    this.store = store;
    this.engine = engine;
    this.stream = stream;
    this.labeler = labeler;
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
      const result = runBacktest(this.store.db, {
        holdMs: numeric(request.query.holdMs, 5_000),
        executionDelayMs: numeric(request.query.executionDelayMs, 200),
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
        failureRatePct: numeric(request.query.failureRatePct, defaultCosts.failureRatePct ?? 0),
        failureLossPct: numeric(request.query.failureLossPct, defaultCosts.failureLossPct ?? 1),
        minNetFlowW3: numeric(request.query.minNetFlowW3, this.config.strategy.minNetFlowW3Sol),
        minFlowAccel: numeric(request.query.minFlowAccel, this.config.strategy.minAccelerationRatio),
        includeRows: false,
      });
      response.json(result);
    });

    this.app.get('/api/smart-wallets', (_request, response) => {
      response.json(this.store.smartWalletStats(this.config.smartWallets));
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
