'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRuntime } = require('../src/index');
const { config } = require('../src/config');

async function main() {
  const dashboard = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'server', 'public', 'index.html'),
    'utf8',
  );
  const inlineScripts = [...dashboard.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.ok(inlineScripts.length > 0, 'dashboard should contain an inline application script');
  for (const [, source] of inlineScripts) {
    assert.doesNotThrow(() => new Function(source), 'dashboard script should parse');
  }
  assert.ok(dashboard.includes('name="exitExecutionDelayMs"'));
  assert.ok(dashboard.includes('name="exitExecutionDelayMs" type="number" min="0" step="50" value="200"'));
  assert.ok(dashboard.includes('name="firstSignalOnly"'));
  assert.ok(dashboard.includes('name="signalCooldownMs"'));
  assert.ok(dashboard.includes('name="singlePositionPerMint"'));
  assert.ok(dashboard.includes('name="flowExitNetFlowThresholdSol"'));
  assert.ok(dashboard.includes('name="exitOnSmartWalletSell"'));
  assert.ok(dashboard.includes('name="minDeltaNetFlow12"'));
  assert.ok(dashboard.includes('OPEN 10秒覆盖'));
  assert.ok(dashboard.includes('value="shadow_2w"'));
  assert.ok(dashboard.includes('aria-controls="live-trading"'));
  assert.ok(dashboard.includes('id="live-trading"'));
  assert.ok(dashboard.includes('id="live-position-rows"'));
  assert.ok(dashboard.includes('id="live-order-rows"'));
  assert.ok(dashboard.includes('id="live-decision-rows"'));
  assert.ok(dashboard.includes("['每日开仓额度', '不设上限']"));
  assert.ok(!dashboard.includes('每日开仓上限'));
  assert.ok(dashboard.includes('id="signal-shadow-position-rows"'));
  assert.ok(dashboard.includes('id="signal-shadow-metrics"'));
  assert.ok(dashboard.includes('id="smart-pullback-metrics"'));
  assert.ok(dashboard.includes('id="smart-pullback-position-rows"'));
  assert.ok(dashboard.includes('Current live strategy'));

  const runtimeConfig = {
    ...config,
    storage: {
      ...config.storage,
      dbPath: ':memory:',
    },
    server: {
      ...config.server,
      host: '127.0.0.1',
      port: 0,
    },
  };
  const runtime = createRuntime(runtimeConfig);
  const entryLookupPlan = runtime.store.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT timestamp_ms, price, market
    FROM raw_trades
    WHERE mint = ? AND timestamp_ms >= ? AND price > 0
    ORDER BY timestamp_ms, id
    LIMIT 1
  `).all('test-mint', 0);
  assert.ok(
    entryLookupPlan.some(({ detail }) => detail.includes('idx_raw_trades_mint_ts')),
    'backtest entry lookup should use the mint/timestamp index',
  );
  const liveOrderPlan = runtime.store.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM live_orders
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).all();
  assert.ok(
    liveOrderPlan.some(({ detail }) => detail.includes('idx_live_orders_created_id')),
    'live order dashboard should use the recent-order index',
  );

  try {
    await runtime.server.start();
    const { port } = runtime.server.httpServer.address();
    const routes = [
      '/',
      '/api/overview',
      '/api/signals',
      '/api/backtest',
      '/api/smart-wallets',
      '/api/signal-repetition',
      '/api/live-trading',
      '/api/primary-signal-shadow',
      '/api/smart-pullback-shadow',
      '/api/health',
    ];

    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.strictEqual(response.status, 200, `${route} should return 200`);
      assert.ok((await response.text()).length > 0, `${route} should return a body`);
    }
    const liveTrading = await (await fetch(
      `http://127.0.0.1:${port}/api/live-trading`,
    )).json();
    assert.strictEqual(liveTrading.runtime.mode, 'DISABLED');
    assert.strictEqual(liveTrading.runtime.safetyLock, true);
    assert.strictEqual(liveTrading.runtime.strategy.entry.signalVariant, 'primary_early_5_4');
    assert.strictEqual(liveTrading.runtime.strategy.entry.market, 'PUMP_BONDING_CURVE');
    assert.strictEqual(liveTrading.runtime.strategy.entry.minNetFlowW3Sol, 5);
    assert.strictEqual(liveTrading.runtime.strategy.entry.minUniqueBuyersW3, 4);
    assert.strictEqual(
      liveTrading.runtime.strategy.exit.policy,
      'PRIMARY_IMMEDIATE_TRAILING',
    );
    assert.strictEqual(liveTrading.runtime.strategy.exit.maxHoldMs, 60_000);
    assert.strictEqual(liveTrading.runtime.strategy.exit.trailingActivationPct, 0);
    assert.strictEqual(liveTrading.runtime.strategy.exit.trailingStopPct, 7.5);
    assert.strictEqual(liveTrading.runtime.strategy.execution.buySlippagePct, 10);
    assert.strictEqual(liveTrading.runtime.strategy.execution.sellSlippagePct, 15);
    assert.ok(Array.isArray(liveTrading.positions));
    assert.ok(Array.isArray(liveTrading.orders));
    assert.ok(Array.isArray(liveTrading.decisions));
    assert.strictEqual(liveTrading.stats.decisions, 0);
    const signalShadow = await (await fetch(
      `http://127.0.0.1:${port}/api/primary-signal-shadow`,
    )).json();
    assert.strictEqual(signalShadow.runtime.mode, 'SHADOW');
    assert.strictEqual(signalShadow.runtime.strategy.entry.minNetFlowW3Sol, 5);
    assert.strictEqual(signalShadow.runtime.strategy.entry.minUniqueBuyersW3, 4);
    assert.strictEqual(signalShadow.runtime.strategy.exit.trailingActivationPct, 0);
    assert.strictEqual(signalShadow.runtime.strategy.exit.trailingStopPct, 7.5);
    assert.strictEqual(signalShadow.runtime.strategy.risk.sendsTransactions, false);
    assert.deepStrictEqual(
      signalShadow.runtime.profiles.map((profile) => [
        profile.profileId,
        profile.strategy.entry.minNetFlowW3Sol,
        profile.strategy.entry.minUniqueBuyersW3,
      ]),
      [['aggressive', 3, 3], ['balanced', 5, 4], ['conservative', 7, 5]],
    );
    assert.ok(Array.isArray(signalShadow.profiles));
    assert.ok(Array.isArray(signalShadow.positions));
    const smartPullback = await (await fetch(
      `http://127.0.0.1:${port}/api/smart-pullback-shadow`,
    )).json();
    assert.strictEqual(smartPullback.runtime.mode, 'SHADOW_AB');
    assert.strictEqual(smartPullback.runtime.sendsTransactions, false);
    assert.deepStrictEqual(
      smartPullback.runtime.cohorts.map((cohort) => [
        cohort.cohortId,
        cohort.strategy.exit.trailingStopPct,
      ]),
      [['A', 7.5], ['B', 12.5]],
    );
    assert.ok(Array.isArray(smartPullback.cohorts));
    assert.ok(Array.isArray(smartPullback.positions));
    const dynamicResponse = await fetch(
      `http://127.0.0.1:${port}/api/backtest?takeProfitPct=5&stopLossPct=3`
      + '&trailingStopPct=2&exitRetryCount=1&splitRatio=0.6'
      + '&firstSignalOnly=true&signalCooldownMs=30000&maxCurvePct=60&maxBuyTxW3=3',
    );
    const dynamic = await dynamicResponse.json();
    assert.strictEqual(dynamic.parameters.takeProfitPct, 5);
    assert.strictEqual(dynamic.parameters.stopLossPct, 3);
    assert.strictEqual(dynamic.parameters.trailingStopPct, 2);
    assert.strictEqual(dynamic.parameters.exitRetryCount, 1);
    assert.strictEqual(dynamic.parameters.exitExecutionDelayMs, 200);
    assert.strictEqual(dynamic.parameters.firstSignalOnly, true);
    assert.strictEqual(dynamic.parameters.signalCooldownMs, 30_000);
    assert.strictEqual(dynamic.parameters.maxCurvePct, 60);
    assert.strictEqual(dynamic.parameters.maxBuyTxW3, 3);
    assert.ok(!dynamic.warnings.some(({ code }) => code === 'IDEALIZED_ZERO_DELAY_EXIT'));
    assert.ok(dynamic.metrics.robustness);
    const idealized = await (await fetch(
      `http://127.0.0.1:${port}/api/backtest?takeProfitPct=5&exitExecutionDelayMs=0`,
    )).json();
    assert.ok(idealized.warnings.some(({ code }) => code === 'IDEALIZED_ZERO_DELAY_EXIT'));
    const breakout = await (await fetch(
      `http://127.0.0.1:${port}/api/backtest?signalVariant=shadow_netflow_breakout`,
    )).json();
    assert.strictEqual(breakout.parameters.minFlowAccel, 0);
    const layered = await (await fetch(
      `http://127.0.0.1:${port}/api/backtest?maxNetFlowW3=&maxCurvePct=`
      + '&minAgeSec=5&maxAgeSec=120&minDeltaNetFlow12=1&minDeltaNetFlow23=2'
      + '&minBuyTxW3=5&minUniqueBuyersW3=4&maxEntryPriceJumpPct=20'
      + '&singlePositionPerMint=true&flowExitNetFlowThresholdSol=0'
      + '&flowExitWindowMs=2000&flowExitMinHoldMs=1000&flowExitConfirmations=2'
      + '&exitOnSmartWalletSell=true',
    )).json();
    assert.strictEqual(layered.parameters.maxNetFlowW3, null,
      'blank optional maximum must stay disabled');
    assert.strictEqual(layered.parameters.maxCurvePct, null,
      'blank optional Curve maximum must stay disabled');
    assert.strictEqual(layered.parameters.minAgeMs, 5_000);
    assert.strictEqual(layered.parameters.maxAgeMs, 120_000);
    assert.strictEqual(layered.parameters.minDeltaNetFlow12, 1);
    assert.strictEqual(layered.parameters.minDeltaNetFlow23, 2);
    assert.strictEqual(layered.parameters.singlePositionPerMint, true);
    assert.strictEqual(layered.parameters.flowExitNetFlowThresholdSol, 0);
    assert.strictEqual(layered.parameters.exitOnSmartWalletSell, true);
  } finally {
    await runtime.stop('server-smoke-test');
  }

  console.log('test-research-server: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
