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
  const liveRenderer = dashboard.match(
    /function renderLiveTrading\(data\) \{[\s\S]*?\n    function renderLaunchPullbackShadow/,
  )?.[0] || '';
  assert.ok(liveRenderer, 'live trading renderer should be present');
  assert.ok(
    !liveRenderer.includes('rangeScalper'),
    'live renderer must not reference health-only Range Scalper state',
  );
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
  assert.ok(dashboard.includes('id="flow-first-metrics"'));
  assert.ok(dashboard.includes('id="flow-first-position-rows"'));
  assert.ok(dashboard.includes('Flow-First Shadow C'));
  assert.ok(dashboard.includes('id="smart-pullback-metrics"'));
  assert.ok(dashboard.includes('id="smart-pullback-position-rows"'));
  assert.ok(dashboard.includes('data-live-strategy="smart-open"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="smart-open"'));
  assert.ok(dashboard.includes('id="smart-open-metrics"'));
  assert.ok(dashboard.includes('id="smart-open-position-rows"'));
  assert.ok(dashboard.includes("json('/api/smart-open-shadow?positionLimit=30')"));
  assert.ok(dashboard.includes('data-live-strategy="flow-smart-confirm"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="flow-smart-confirm"'));
  assert.ok(dashboard.includes('id="flow-smart-confirm-metrics"'));
  assert.ok(dashboard.includes('id="flow-smart-confirm-position-rows"'));
  assert.ok(dashboard.includes("json('/api/flow-smart-confirm-shadow?positionLimit=30')"));
  assert.ok(dashboard.includes('data-live-strategy="launch-pullback"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="launch-pullback"'));
  assert.ok(dashboard.includes('id="launch-pullback-metrics"'));
  assert.ok(dashboard.includes('id="launch-pullback-position-rows"'));
  assert.ok(dashboard.includes("json('/api/launch-pullback-shadow?positionLimit=30')"));
  assert.ok(dashboard.includes('data-live-strategy="migrated-rebound"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="migrated-rebound"'));
  assert.ok(dashboard.includes('id="migrated-rebound-cohort-rows"'));
  assert.ok(dashboard.includes('id="migrated-rebound-position-rows"'));
  assert.ok(dashboard.includes('生命周期超跌反弹 · G'));
  assert.ok(dashboard.includes('毕业前 Curve / 毕业后 PumpSwap 分层'));
  assert.ok(dashboard.includes('GE30_R23_F1/F3 使用全新 cohort，不混入历史'));
  assert.ok(dashboard.includes('FO_F2_J2_3S'));
  assert.ok(dashboard.includes('第1波只预热，仅交易第2/3波'));
  assert.ok(dashboard.includes('CYA Early Pyramid · K（已停）'));
  assert.ok(dashboard.includes("json('/api/migrated-drop-rebound-shadow?positionLimit=30')"));
  assert.ok(dashboard.includes('data-live-strategy="migration-continuity"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="migration-continuity"'));
  assert.ok(dashboard.includes('id="migration-continuity-cohort-rows"'));
  assert.ok(dashboard.includes('id="migration-continuity-position-rows"'));
  assert.ok(dashboard.includes("json('/api/migration-continuity-shadow?positionLimit=100')"));
  assert.ok(dashboard.includes('data-live-strategy="range-scalper"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="range-scalper"'));
  assert.ok(dashboard.includes('id="range-scalper-cohort-rows"'));
  assert.ok(dashboard.includes('id="range-scalper-position-rows"'));
  assert.ok(dashboard.includes("json('/api/range-scalper-shadow?positionLimit=100')"));
  assert.ok(dashboard.includes('data-live-strategy="cya-early-pyramid"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="cya-early-pyramid"'));
  assert.ok(dashboard.includes('id="cya-early-pyramid-cohort-rows"'));
  assert.ok(dashboard.includes('id="cya-early-pyramid-position-rows"'));
  assert.ok(dashboard.includes('id="cya-early-pyramid-time-sessions"'));
  assert.ok(dashboard.includes("json('/api/cya-early-pyramid-shadow?positionLimit=100')"));
  assert.ok(dashboard.includes('data-live-strategy="bonding-momentum"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="bonding-momentum"'));
  assert.ok(dashboard.includes('id="bonding-momentum-cohort-rows"'));
  assert.ok(dashboard.includes('id="bonding-momentum-position-rows"'));
  assert.ok(dashboard.includes('id="bonding-momentum-snapshot-rows"'));
  assert.ok(dashboard.includes('Bonding Curve 动量 · H'));
  assert.ok(dashboard.includes("json('/api/bonding-curve-momentum-shadow?positionLimit=30&snapshotLimit=40')"));
  assert.ok(dashboard.includes('data-live-strategy="graduation-hold"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="graduation-hold"'));
  assert.ok(dashboard.includes('id="graduation-hold-cohort-rows"'));
  assert.ok(dashboard.includes('id="graduation-hold-position-rows"'));
  assert.ok(dashboard.includes('id="graduation-hold-time-sessions"'));
  assert.ok(dashboard.includes('毕业概率持仓 · I'));
  assert.ok(dashboard.includes("json('/api/graduation-hold-shadow?positionLimit=30')"));
  assert.ok(dashboard.includes('data-live-strategy="graduation-acceleration"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="graduation-acceleration"'));
  assert.ok(dashboard.includes('id="graduation-acceleration-cohort-rows"'));
  assert.ok(dashboard.includes('id="graduation-acceleration-position-rows"'));
  assert.ok(dashboard.includes('毕业加速 · O'));
  assert.ok(dashboard.includes("json('/api/graduation-acceleration-shadow?positionLimit=100')"));
  assert.ok(dashboard.includes('data-live-strategy="launch-quality"'));
  assert.ok(dashboard.includes('data-live-strategy-pane="launch-quality"'));
  assert.ok(dashboard.includes('id="launch-quality-observation-rows"'));
  assert.ok(dashboard.includes('id="launch-quality-snapshot-rows"'));
  assert.ok(dashboard.includes("json('/api/launch-quality-observer?observationLimit=30&snapshotLimit=60')"));
  assert.ok(dashboard.includes('function renderMetricGroups('));
  assert.ok(dashboard.includes('function renderTimeSessions('));
  assert.ok(dashboard.includes('北京时间分时观察'));
  assert.ok(dashboard.includes('id="migrated-rebound-time-sessions"'));
  assert.ok(dashboard.includes('id="bonding-momentum-time-sessions"'));
  assert.ok(dashboard.includes("renderMetricGroups('#smart-open-metrics'"));
  assert.ok(dashboard.includes("renderMetricGroups('#launch-pullback-metrics'"));
  assert.ok(dashboard.includes("renderMetricGroups('#flow-first-metrics'"));
  assert.ok(dashboard.includes("renderMetricGroups('#smart-pullback-metrics'"));
  assert.ok(dashboard.includes("renderMetricGroups('#signal-shadow-metrics'"));
  assert.ok(dashboard.includes("let activeLiveStrategyId = 'execution';"));
  assert.ok(dashboard.includes('Current live strategy'));
  assert.ok(dashboard.includes("let activeTabId = 'overview';"));
  assert.ok(dashboard.includes('refreshInFlight'));
  assert.ok(dashboard.includes('if (document.hidden && !force) return;'));
  assert.ok(dashboard.includes("json('/api/signals?limit=50')"));
  assert.ok(dashboard.includes('positionLimit=30&orderLimit=30&decisionLimit=30'));
  assert.ok(dashboard.includes("document.addEventListener('visibilitychange'"));
  assert.ok(!dashboard.includes("document.querySelector('#backtest-form').requestSubmit();"));

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
  let dashboardCacheComputations = 0;
  const cachedDashboardValue = () => {
    dashboardCacheComputations += 1;
    return dashboardCacheComputations;
  };
  assert.strictEqual(runtime.store._cachedDashboardStats('test:dashboard', 15_000, cachedDashboardValue), 1);
  assert.strictEqual(runtime.store._cachedDashboardStats('test:dashboard', 15_000, cachedDashboardValue), 1);
  assert.strictEqual(dashboardCacheComputations, 1);
  for (const strategyId of [
    'primary-shadow',
    'flow-first',
    'smart-pullback',
    'smart-open',
    'launch-pullback',
    'migrated-rebound',
    'range-scalper',
    'bonding-momentum',
    'graduation-hold',
  ]) {
    const timeSessions = runtime.store.shadowTimeSessionDashboard(strategyId);
    assert.strictEqual(timeSessions.timezone, 'Asia/Shanghai');
    assert.strictEqual(timeSessions.observationOnly, true);
    assert.deepStrictEqual(
      timeSessions.sessions.map((session) => session.id),
      ['00-04', '04-08', '08-18', '18-24'],
    );
  }
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
      '/api/flow-first-shadow',
      '/api/smart-pullback-shadow',
      '/api/smart-open-shadow',
      '/api/launch-pullback-shadow',
      '/api/migrated-drop-rebound-shadow',
      '/api/migration-continuity-shadow',
      '/api/range-scalper-shadow',
      '/api/bonding-curve-momentum-shadow',
      '/api/graduation-hold-shadow',
      '/api/graduation-acceleration-shadow',
      '/api/launch-quality-observer',
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
    assert.strictEqual(
      liveTrading.runtime.strategies[0].id,
      'post_gd25_32_r2_4_age30_xleg_v2',
    );
    assert.strictEqual(liveTrading.runtime.strategies[0].entryEnabled, true);
    assert.strictEqual(liveTrading.runtime.strategies[1].entryEnabled, false);
    assert.strictEqual(liveTrading.runtime.strategies[0].market, 'PUMP_AMM');
    assert.strictEqual(liveTrading.runtime.strategies[0].positionSizeSol, 1);
    assert.strictEqual(liveTrading.runtime.priorityFeeSol, 0.0005);
    assert.strictEqual(liveTrading.runtime.priorityFeeMicroLamports, 2_000_000);
    assert.strictEqual(liveTrading.runtime.strategies[0].trailingActivationPct, 8);
    assert.strictEqual(liveTrading.runtime.strategies[0].trailingStopPct, 3);
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
    const flowFirst = await (await fetch(
      `http://127.0.0.1:${port}/api/flow-first-shadow`,
    )).json();
    assert.strictEqual(flowFirst.runtime.mode, 'SHADOW_C');
    assert.strictEqual(flowFirst.runtime.sendsTransactions, false);
    assert.deepStrictEqual(
      flowFirst.runtime.cohorts.map((cohort) => [
        cohort.cohortId,
        cohort.strategy.exit.policy,
        cohort.strategy.exit.fixedHoldMs,
        cohort.strategy.exit.trailingStopPct,
      ]),
      [
        ['C5', 'FIXED_HOLD', 5_000, null],
        ['C75', 'IMMEDIATE_TRAILING', null, 7.5],
        ['C125', 'IMMEDIATE_TRAILING', null, 12.5],
      ],
    );
    assert.ok(Array.isArray(flowFirst.cohorts));
    assert.ok(Array.isArray(flowFirst.positions));
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
    const smartOpen = await (await fetch(
      `http://127.0.0.1:${port}/api/smart-open-shadow`,
    )).json();
    assert.strictEqual(smartOpen.runtime.mode, 'SHADOW_SMART_OPEN');
    assert.strictEqual(smartOpen.runtime.sendsTransactions, false);
    assert.deepStrictEqual(
      smartOpen.runtime.cohorts.map((cohort) => [
        cohort.cohortId,
        cohort.strategy.entry.positionPhase,
        cohort.strategy.exit.policy,
        cohort.strategy.research.isolatedTable,
      ]),
      [
        ['D0', 'OPEN', 'FIXED_HOLD', 'smart_open_shadow_positions'],
        ['D1', 'OPEN', 'DELAYED_TRAILING', 'smart_open_shadow_positions'],
        ['D2', 'OPEN', 'SMART_REDUCE_OR_CLOSE', 'smart_open_shadow_positions'],
      ],
    );
    assert.ok(Array.isArray(smartOpen.cohorts));
    assert.ok(Array.isArray(smartOpen.positions));
    const flowSmartConfirm = await (await fetch(
      `http://127.0.0.1:${port}/api/flow-smart-confirm-shadow`,
    )).json();
    assert.strictEqual(flowSmartConfirm.runtime.mode, 'SHADOW_L');
    assert.strictEqual(flowSmartConfirm.runtime.sendsTransactions, false);
    assert.deepStrictEqual(
      flowSmartConfirm.runtime.cohorts.map((cohort) => [
        cohort.cohortId,
        cohort.strategy.entry.maxConfirmationDelayMs,
        cohort.strategy.entry.priceBasis,
        cohort.strategy.research.isolatedTable,
      ]),
      [
        ['L5_F5', 5_000, 'FIRST_TRADE_AFTER_SMART_OPEN', 'flow_smart_confirm_shadow_positions'],
        ['L15_F5', 15_000, 'FIRST_TRADE_AFTER_SMART_OPEN', 'flow_smart_confirm_shadow_positions'],
        ['L5_T15', 5_000, 'FIRST_TRADE_AFTER_SMART_OPEN', 'flow_smart_confirm_shadow_positions'],
        ['L15_T20', 15_000, 'FIRST_TRADE_AFTER_SMART_OPEN', 'flow_smart_confirm_shadow_positions'],
      ],
    );
    assert.ok(Array.isArray(flowSmartConfirm.cohorts));
    assert.ok(Array.isArray(flowSmartConfirm.positions));
    const launchPullback = await (await fetch(
      `http://127.0.0.1:${port}/api/launch-pullback-shadow`,
    )).json();
    assert.strictEqual(launchPullback.runtime.mode, 'SHADOW_F');
    assert.strictEqual(launchPullback.runtime.sendsTransactions, false);
    const launchCohorts = launchPullback.runtime.cohorts.map((cohort) => [
        cohort.cohortId,
        cohort.strategy.entry.minNetFlowSol,
        cohort.strategy.entry.maxCreatorSharePct,
        cohort.strategy.exit.policy,
        cohort.strategy.exit.fixedHoldMs ?? null,
        cohort.strategy.exit.activationPct ?? null,
        cohort.strategy.exit.drawdownPct ?? null,
        cohort.strategy.exit.minHoldMs ?? null,
        cohort.strategy.exit.maxHoldMs ?? null,
        cohort.strategy.exit.hardStopPct ?? null,
        cohort.strategy.research.isolatedTable,
      ]);
    assert.deepStrictEqual(
      launchCohorts.slice(0, 6),
      [
        ['F1_3S', 15, 5, 'FIXED_HOLD', 3_000, null, null, null, null, null, 'launch_pullback_shadow_positions'],
        ['F1_8S', 15, 5, 'FIXED_HOLD', 8_000, null, null, null, null, null, 'launch_pullback_shadow_positions'],
        ['F2_3S', 20, 10, 'FIXED_HOLD', 3_000, null, null, null, null, null, 'launch_pullback_shadow_positions'],
        ['F2_8S', 20, 10, 'FIXED_HOLD', 8_000, null, null, null, null, null, 'launch_pullback_shadow_positions'],
        ['F3_3S', 20, 20, 'FIXED_HOLD', 3_000, null, null, null, null, null, 'launch_pullback_shadow_positions'],
        ['F3_8S', 20, 20, 'FIXED_HOLD', 8_000, null, null, null, null, null, 'launch_pullback_shadow_positions'],
      ],
    );
    assert(launchCohorts.some((row) => row[0] === 'FQ1_3S'));
    assert(launchCohorts.some((row) => row[0] === 'FQ2_8S'));
    assert(launchCohorts.some((row) => row[0] === 'FQ_X15' && row[5] === 8 && row[8] === 15_000));
    assert(launchCohorts.some((row) => row[0] === 'FQ_X30' && row[5] === 10 && row[8] === 30_000));
    assert(launchCohorts.some((row) => row[0] === 'FO_C70_10S' && row[4] === 10_000));
    assert(launchCohorts.some((row) => row[0] === 'FO_F2_J2_3S' && row[4] === 3_000));
    assert(launchCohorts.some((row) => row[0] === 'FO_RB10_T20' && row[5] === 20 && row[8] === 120_000));
    assert(launchCohorts.some((row) => row[0] === 'FO_D12_R3_T15' && row[5] === 10 && row[6] === 15));
    assert(launchCohorts.some((row) => row[0] === 'F2_8S_NF30' && row[1] === 30 && row[4] === 8_000));
    assert(launchCohorts.some((row) => row[0] === 'FT_C_NF30' && row[1] === 30 && row[5] === 30));
    const causalCohorts = Object.fromEntries(
      launchPullback.runtime.cohorts
        .filter((cohort) => cohort.cohortId.startsWith('F_ABSORB')
          || cohort.cohortId.startsWith('F_REACCEL'))
        .map((cohort) => [cohort.cohortId, cohort.strategy.entry]),
    );
    assert.strictEqual(causalCohorts.F_ABSORB3_8S.minSellSolSincePeak, 3);
    assert.strictEqual(causalCohorts.F_ABSORB3_8S.minBuyRefillRatio, 0.5);
    assert.strictEqual(causalCohorts.F_ABSORB5_RUNNER.minSellSolSincePeak, 5);
    assert.strictEqual(causalCohorts.F_REACCEL0_8S.minRecentNetFlow1s, 0);
    assert.strictEqual(causalCohorts.F_REACCEL0_8S.minNetFlowAcceleration1s, 0);
    assert.ok(Array.isArray(launchPullback.cohorts));
    assert.ok(Array.isArray(launchPullback.positions));
    const migratedRebound = await (await fetch(
      `http://127.0.0.1:${port}/api/migrated-drop-rebound-shadow`,
    )).json();
    assert.strictEqual(migratedRebound.runtime.mode, 'SHADOW_G');
    assert.strictEqual(migratedRebound.runtime.sendsTransactions, false);
    assert.deepStrictEqual(migratedRebound.runtime.lifecycleStages, [
      { id: 'POST_MIGRATION', label: '毕业后', market: 'PUMP_AMM' },
    ]);
    assert.strictEqual(migratedRebound.runtime.entryProfiles.length, 4);
    assert.deepStrictEqual(
      migratedRebound.runtime.exitProfiles.map((profile) => profile.id),
      [
        'X3', 'X8', 'XLEG', 'XB50', 'XB25',
        'V2_R2_H10', 'V2_R2_H15', 'V2_B75_H20', 'V2_B75_H60',
        'XR3_H12', 'XR3_H15', 'XR4_H12', 'XR4_H15',
      ],
    );
    assert.strictEqual(
      migratedRebound.runtime.strategy.scope,
      'PRE_MIGRATION_BONDING_CURVE_AND_POST_MIGRATION_PUMP_AMM',
    );
    assert.strictEqual(
      migratedRebound.runtime.strategy.research.isolatedTable,
      'migrated_drop_rebound_shadow_positions',
    );
    assert.deepStrictEqual(
      migratedRebound.runtime.entryProfiles.find((profile) => profile.id === 'GD25_35'),
      {
        id: 'GD25_35',
        label: '深跌25–35%',
        windowMs: 1_000,
        dropMinPct: 25,
        dropMaxPct: 35,
        reboundMinPct: 2,
        reboundMaxPct: 5,
        reboundTimeoutMs: 1_000,
      },
    );
    assert.deepStrictEqual(
      migratedRebound.runtime.entryProfiles
        .filter((profile) => profile.id.startsWith('GE30_'))
        .map((profile) => [
          profile.id,
          profile.maxLifecycleAgeMs,
          profile.maxSignalsPerMint,
          profile.reboundMaxPct,
        ]),
      [
        ['GE30_R23_F1', 30_000, 1, 3],
        ['GE30_R23_F3', 30_000, 3, 3],
        ['GE30_D25_32_R24_F1', 30_000, 1, 4],
      ],
    );
    assert.ok(Array.isArray(migratedRebound.cohorts));
    assert.ok(Array.isArray(migratedRebound.positions));
    const rangeScalper = await (await fetch(
      `http://127.0.0.1:${port}/api/range-scalper-shadow`,
    )).json();
    assert.strictEqual(rangeScalper.runtime.mode, 'SHADOW_J');
    assert.strictEqual(rangeScalper.runtime.sendsTransactions, false);
    assert.strictEqual(rangeScalper.runtime.entryProfiles.length, 4);
    assert.strictEqual(rangeScalper.runtime.exitProfiles.length, 4);
    assert.strictEqual(
      rangeScalper.runtime.strategy.research.isolatedTable,
      'range_scalper_shadow_positions',
    );
    assert.deepStrictEqual(
      rangeScalper.runtime.entryProfiles.find((profile) => profile.id === 'JW'),
      {
        id: 'JW',
        label: 'JW · JB条件预热后仅交易第2/3波',
        warmupProfileId: 'JB',
        deviationSigma: 1.5,
        reboundPct: 2,
        reboundTimeoutMs: 5_000,
        minRecentNetFlowSol: 0.1,
        minOpportunityIndex: 2,
        maxOpportunityIndex: 3,
        exitProfileIds: ['X6'],
      },
    );
    assert.ok(Array.isArray(rangeScalper.cohorts));
    assert.ok(Array.isArray(rangeScalper.positions));
    const cyaPyramid = await (await fetch(
      `http://127.0.0.1:${port}/api/cya-early-pyramid-shadow`,
    )).json();
    assert.strictEqual(cyaPyramid.runtime.mode, 'SHADOW_K');
    assert.strictEqual(cyaPyramid.runtime.enabled, false);
    assert.strictEqual(cyaPyramid.runtime.sendsTransactions, false);
    assert.strictEqual(cyaPyramid.runtime.entryProfiles.length, 2);
    assert.strictEqual(cyaPyramid.runtime.exitProfiles.length, 2);
    assert.strictEqual(cyaPyramid.runtime.strategy.research.simulatedPositionSol, 1);
    assert.strictEqual(
      cyaPyramid.runtime.strategy.research.isolatedPositionTable,
      'cya_early_pyramid_shadow_positions',
    );
    assert.ok(Array.isArray(cyaPyramid.cohorts));
    assert.ok(Array.isArray(cyaPyramid.positions));
    const bondingMomentum = await (await fetch(
      `http://127.0.0.1:${port}/api/bonding-curve-momentum-shadow`,
    )).json();
    assert.strictEqual(bondingMomentum.runtime.mode, 'SHADOW_H');
    assert.strictEqual(bondingMomentum.runtime.sendsTransactions, false);
    assert.strictEqual(bondingMomentum.runtime.entryProfiles.length, 4);
    assert.strictEqual(bondingMomentum.runtime.exitProfiles.length, 3);
    assert.strictEqual(
      bondingMomentum.runtime.strategy.scope,
      'PRE_MIGRATION_PUMP_BONDING_CURVE',
    );
    assert.strictEqual(
      bondingMomentum.runtime.strategy.research.isolatedPositionTable,
      'bonding_curve_momentum_shadow_positions',
    );
    assert.strictEqual(
      bondingMomentum.runtime.strategy.research.isolatedSnapshotTable,
      'bonding_curve_momentum_shadow_snapshots',
    );
    assert.ok(Array.isArray(bondingMomentum.cohorts));
    assert.ok(Array.isArray(bondingMomentum.positions));
    assert.ok(Array.isArray(bondingMomentum.snapshots));
    const graduationHold = await (await fetch(
      `http://127.0.0.1:${port}/api/graduation-hold-shadow`,
    )).json();
    assert.strictEqual(graduationHold.runtime.mode, 'SHADOW_I');
    assert.strictEqual(graduationHold.runtime.sendsTransactions, false);
    assert.strictEqual(graduationHold.runtime.strategy.entry.maxSignalCurvePct, 70);
    assert.strictEqual(
      graduationHold.runtime.strategy.research.isolatedTable,
      'graduation_hold_shadow_positions',
    );
    assert.deepStrictEqual(
      graduationHold.runtime.cohorts.map((cohort) => [cohort.id, cohort.exitMode]),
      [
        ['I0', 'CONTROL_TRAILING'],
        ['I1', 'PRE_GRAD_CHECKPOINTS'],
        ['I2', 'THROUGH_GRADUATION'],
      ],
    );
    assert.ok(Array.isArray(graduationHold.cohorts));
    assert.ok(Array.isArray(graduationHold.positions));
    const graduationAcceleration = await (await fetch(
      `http://127.0.0.1:${port}/api/graduation-acceleration-shadow`,
    )).json();
    assert.strictEqual(graduationAcceleration.runtime.mode, 'SHADOW_O');
    assert.strictEqual(graduationAcceleration.runtime.sendsTransactions, false);
    assert.deepStrictEqual(graduationAcceleration.runtime.capacitySols, [0.05, 0.5, 1]);
    assert.strictEqual(
      graduationAcceleration.runtime.strategy.research.isolatedTable,
      'graduation_acceleration_shadow_positions',
    );
    assert.strictEqual(
      graduationAcceleration.runtime.strategy.research.noExitPricedAsLoss,
      false,
    );
    assert.ok(Array.isArray(graduationAcceleration.cohorts));
    assert.ok(Array.isArray(graduationAcceleration.positions));
    const migrationContinuity = await (await fetch(
      `http://127.0.0.1:${port}/api/migration-continuity-shadow`,
    )).json();
    assert.strictEqual(migrationContinuity.runtime.mode, 'SHADOW_M');
    assert.strictEqual(migrationContinuity.runtime.sendsTransactions, false);
    assert.strictEqual(
      migrationContinuity.runtime.strategy.research.isolatedTable,
      'migration_continuity_shadow_positions',
    );
    assert.deepStrictEqual(
      migrationContinuity.runtime.exitProfiles.map((profile) => profile.id),
      ['E60', 'E120', 'T10', 'T12_5', 'FLOW', 'RUNNER'],
    );
    assert.ok(Array.isArray(migrationContinuity.cohorts));
    assert.ok(Array.isArray(migrationContinuity.positions));
    const launchQuality = await (await fetch(
      `http://127.0.0.1:${port}/api/launch-quality-observer`,
    )).json();
    assert.strictEqual(launchQuality.runtime.mode, 'OBSERVER_ONLY');
    assert.strictEqual(launchQuality.runtime.sendsTransactions, false);
    assert.strictEqual(launchQuality.runtime.opensSimulatedPositions, false);
    assert.deepStrictEqual(
      launchQuality.runtime.strategy.research.isolatedTables,
      ['launch_quality_observations', 'launch_quality_snapshots'],
    );
    assert.ok(Array.isArray(launchQuality.observations));
    assert.ok(Array.isArray(launchQuality.snapshots));
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
