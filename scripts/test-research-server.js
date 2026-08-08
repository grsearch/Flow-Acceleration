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

  try {
    await runtime.server.start();
    const { port } = runtime.server.httpServer.address();
    const routes = [
      '/',
      '/api/overview',
      '/api/signals',
      '/api/backtest',
      '/api/smart-wallets',
      '/api/health',
    ];

    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.strictEqual(response.status, 200, `${route} should return 200`);
      assert.ok((await response.text()).length > 0, `${route} should return a body`);
    }
    const dynamicResponse = await fetch(
      `http://127.0.0.1:${port}/api/backtest?takeProfitPct=5&stopLossPct=3`
      + '&trailingStopPct=2&exitRetryCount=1&splitRatio=0.6',
    );
    const dynamic = await dynamicResponse.json();
    assert.strictEqual(dynamic.parameters.takeProfitPct, 5);
    assert.strictEqual(dynamic.parameters.stopLossPct, 3);
    assert.strictEqual(dynamic.parameters.trailingStopPct, 2);
    assert.strictEqual(dynamic.parameters.exitRetryCount, 1);
    assert.ok(dynamic.metrics.robustness);
  } finally {
    await runtime.stop('server-smoke-test');
  }

  console.log('test-research-server: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
