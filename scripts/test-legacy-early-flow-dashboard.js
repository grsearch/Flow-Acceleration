'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dashboardRuntime = require('../src/server/public/dashboard-runtime');

const html = fs.readFileSync(path.join(__dirname, '../src/server/public/index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)][0][1]
  .replace(/^\s*void refresh\(\);\r?$/m, '');
const elements = new Map();
const element = selector => {
  if (!elements.has(selector)) elements.set(selector, {
    innerHTML: '', textContent: '', className: '', hidden: false, children: [], dataset: {},
    classList: { toggle() {} }, setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, addEventListener() {},
  });
  return elements.get(selector);
};
const panes = ['execution', 'legacy-early-flow', 'migration-second-leg'].map(id => ({
  dataset: { liveStrategyPane: id }, hidden: true,
}));
const shadowButtons = ['legacy-early-flow-base', 'legacy-early-flow-rugx', 'migration-second-leg']
  .map(id => ({ dataset: { liveStrategy: id }, setAttribute() {} }));
let requests = 0;
const sandbox = {
  console, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval: () => 0,
  CSS: { escape: value => value }, DashboardRuntime: dashboardRuntime,
  document: { hidden: false, querySelector: element, querySelectorAll: selector => {
    if (selector === '[data-live-strategy-pane]') return panes;
    if (selector === '#shadow-strategy-selector [data-live-strategy]') return shadowButtons;
    return [];
  }, addEventListener() {} },
  fetch() { requests += 1; throw new Error('Render must not issue extra network requests'); },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'dashboard-inline.js' });
const run = script => vm.runInContext(script, sandbox);
const allText = () => [...elements.values()].map(item => `${item.textContent} ${item.innerHTML}`).join('\n');
const live = {
  id: 'legacy_early_flow_rugx_live', code: 'LEGACY-EARLY-FLOW-RUGX',
  label: 'Legacy Early Flow RUGX', enabled: true, entryEnabled: true,
  market: 'PUMP_AMM', signalSource: 'LEGACY_EARLY_FLOW_EXEC_V1',
  sourceShadowCohortId: 'LEGACY-EARLY-FLOW-RUGX', ruleVersion: 'legacy_early_flow_exec_v1',
  positionSizeSol: 0.02, exitMode: 'TRAILING', hardStopPct: 30,
  trailingActivationPct: 10, trailingStopPct: 5, maxHoldMs: 1_800_000,
  calibrationOnly: true, maxConcurrentPositions: 3, maxTotalConcurrentPositions: 3,
  cumulativeAmountLimitSol: null, cumulativeLossLimitSol: null, cumulativeTradeLimit: null,
  stopOnExecutionAnomaly: true, calibrationSafety: { blocked: false, reason: null },
};
const paused = ['early_pure_buy_burst_eba_fix20_calibration_live',
  'graduation_accel_o_c80_ho500_x60_live', 'migrated_ge30_r23_f2_only_g2_xleg_live',
  'migrated_grt_r23_f3_v2_xleg_live'].map(id => ({
  id, code: id, enabled: true, entryEnabled: false, positionSizeSol: 0.02,
}));
sandbox.catalogFixture = { live: [...paused, live], shadows: {
  'legacy-early-flow-base': true, 'legacy-early-flow-rugx': true, 'migration-second-leg': false,
} };
run('renderLiveStrategyCatalog(catalogFixture)');
const menu = element('#live-execution-strategy-selector').innerHTML;
assert(menu.includes('LEGACY-EARLY-FLOW-RUGX'));
assert.equal((menu.match(/data-strategy-state="active"/g) || []).length, 1);
assert.equal((menu.match(/data-strategy-state="stopped"/g) || []).length, 4);
assert.deepEqual(shadowButtons.map(item => item.dataset.strategyState), ['active', 'active', 'stopped']);
for (const selected of ['legacy-early-flow-base', 'legacy-early-flow-rugx']) {
  run(`selectLiveStrategy('${selected}')`);
  assert.equal(panes.find(item => item.dataset.liveStrategyPane === 'legacy-early-flow').hidden, false);
  assert.equal(panes.find(item => item.dataset.liveStrategyPane === 'migration-second-leg').hidden, true);
  assert(html.includes(`data-live-strategy="${selected}"`));
  assert(html.includes(`'${selected}': requestContext => [`));
}

function renderLive(strategy = live, extra = {}) {
  sandbox.liveFixture = {
    strategyId: strategy.id, generatedAt: Date.now(), dashboardSnapshot: { status: 'READY' },
    runtime: { mode: 'LIVE', strategies: [strategy], killSwitchActive: false,
      priorityFeeSol: 0.0001, emergencyPriorityFeeSol: 0.0001, minWalletReserveSol: 0.05 },
    sourceDiagnostics: { kind: 'LEGACY_EARLY_FLOW', evaluated: 18, signals: 4,
      rugRejected: 1, liveBridgeEmitted: 3, liveBridgeErrors: 0, liveBridgeEnabled: true },
    stats: {}, positions: [{}], orders: [{}], decisions: [{}], ...extra,
  };
  run('activeExecutionStrategyId=liveFixture.strategyId; renderLiveTrading(liveFixture)');
}
renderLive();
let cards = element('#live-strategy-cards').innerHTML;
assert(cards.includes('0.02 SOL'));
assert(cards.includes('PumpSwap 固定SOL硬上限'));
assert(cards.includes('移动止盈 + 硬止损（整仓）'));
assert(cards.includes('硬止损触发</span><b>30%'));
assert(cards.includes('移动止盈激活</span><b>10%'));
assert(cards.includes('峰值回撤退出</span><b>5%'));
assert(cards.includes('最长持仓</span><b>30m'));
assert(cards.includes('本策略最大并发</span><b>3 仓'));
assert(cards.includes('账户总并发约束</span><b>3 仓'));
assert.equal((cards.match(/不设累计上限/g) || []).length, 3);
assert(cards.includes('0.0001 SOL / 笔'));
assert(cards.includes('Smart Wallet共识</span><b>不要求'));
assert(!/XLEG|QL Strict|固定持有|(?:^|[ >])1 SOL/.test(cards));
assert(element('#live-strategy-expression').textContent.includes('15–25秒'));
assert(element('#live-strategy-expression').textContent.includes('最大单笔买入占比≤70%'));
assert(element('#live-mode-title').textContent.includes('小额真实执行校准'));
assert(element('#live-mode-description').textContent.includes('不代表已验证盈利'));
assert(element('#live-runtime-strip').innerHTML.includes('未触发（仍受其他执行保护约束）'));
assert(element('#live-metrics').innerHTML.includes('EARLY_FLOW源头评估'));
assert(element('#live-metrics').innerHTML.includes('允许发送信号'));
assert(element('#live-metrics').innerHTML.includes('FDV参考价'));
assert(element('#live-metrics').innerHTML.includes('待确认 · 非正常结论'));
assert(!element('#live-metrics').innerHTML.includes('READY · 可计算FDV'));
assert(!/undefined|NaN/.test(allText()));

const referenceNow = Date.now();
const readyReference = { status: 'READY', ready: true, refreshing: false,
  reference: { priceUsd: 105.25, observedAt: referenceNow - 5_000, expiresAt: referenceNow + 295_000 },
  lastAttemptAt: referenceNow - 6_000, lastCompletedAt: referenceNow - 5_000,
  lastSuccessAt: referenceNow - 5_000, nextRefreshAt: referenceNow + 54_000,
  failures: 2, timeouts: 1, consecutiveFailures: 0, lastError: null, lastErrorCode: null,
  lastHttpStatus: 200, requestTimeoutMs: 3_000, refreshIntervalMs: 60_000 };
const fdvSource = { kind: 'LEGACY_EARLY_FLOW', evaluated: 45_841, sourceSignals: 0,
  rugRejected: 0, liveBridgeEnabled: true,
  rejectedByReason: { FDV_REFERENCE_UNAVAILABLE: 724 },
  fdvRejectedByReason: { TOKEN_SUPPLY_UNAVAILABLE: 4, SOL_USD_REFERENCE_UNAVAILABLE: 700,
    SOL_USD_REFERENCE_EXPIRED: 19, SOL_USD_REFERENCE_NOT_YET_KNOWN: 1 } };
renderLive(live, { sourceDiagnostics: { ...fdvSource, solUsdReference: readyReference } });
let fdvMetrics = element('#live-metrics').innerHTML;
assert(fdvMetrics.includes('READY · 可计算FDV'));
assert(fdvMetrics.includes('缓存 $105.25 / SOL'));
assert(fdvMetrics.includes('FDV缺数据阻断</span><strong>724'));
assert(fdvMetrics.includes('SOL/USD缺失 700'));
assert(fdvMetrics.includes('代币供应量缺失 4'));
assert(fdvMetrics.includes('参考价晚于事件 1'));
assert(fdvMetrics.includes('累计评估次数，非币数或已命中信号，不计RUG拦截'));
assert(fdvMetrics.includes('参考价失败 / 超时</span><strong>2 / 1'));
assert(fdvMetrics.includes('最近尝试'));
assert(fdvMetrics.includes('下次刷新'));
renderLive(live, { sourceDiagnostics: { ...fdvSource, solUsdReference: {
  ...readyReference, status: 'UNAVAILABLE', ready: false, reference: null,
  refreshing: true, pendingAgeMs: 2_000, lastErrorCode: '<bad> & timeout',
} } });
fdvMetrics = element('#live-metrics').innerHTML;
assert(fdvMetrics.includes('缺失 · 无法判断机会'));
assert(fdvMetrics.includes('刷新中 2s'));
assert(fdvMetrics.includes('&lt;bad&gt; &amp; timeout'));
assert(!fdvMetrics.includes('<bad>'));
assert(fdvMetrics.includes('不代表市场没有机会，也不是RUG拒绝'));
renderLive(live, { sourceDiagnostics: { ...fdvSource, solUsdReference: {
  ...readyReference, reference: { ...readyReference.reference, expiresAt: referenceNow - 1 },
} } });
assert(element('#live-metrics').innerHTML.includes('过期 · 无法判断机会'), 'cached READY must expire in the UI too');
assert(!element('#live-metrics').innerHTML.includes('READY · 可计算FDV'));
renderLive(live, { sourceDiagnostics: { ...fdvSource, solUsdReference: readyReference },
  runtimeSnapshot: { status: 'STALE' } });
assert(element('#live-metrics').innerHTML.includes('运行快照过期 · 待确认'));
assert(!element('#live-metrics').innerHTML.includes('READY · 可计算FDV'));

renderLive({ ...live, hardStopPct: 25, trailingActivationPct: 12, trailingStopPct: 6,
  maxHoldMs: 3_600_000, positionSizeSol: 0.03 });
cards = element('#live-strategy-cards').innerHTML;
assert(cards.includes('硬止损触发</span><b>25%'));
assert(cards.includes('移动止盈激活</span><b>12%'));
assert(cards.includes('峰值回撤退出</span><b>6%'));
assert(cards.includes('最长持仓</span><b>60m'));
assert(cards.includes('0.03 SOL'), 'amount and exits are from selected runtime, not hardcoded');
renderLive({ ...live, entryEnabled: false });
assert(element('#live-mode-title').textContent.includes('已停止新开仓'));
renderLive({ ...live, calibrationSafety: null }, { sourceDiagnostics: { kind: 'LEGACY_EARLY_FLOW' } });
assert(element('#live-runtime-strip').innerHTML.includes('待确认，不能认定可开仓'));
assert(!element('#live-metrics').innerHTML.includes('允许发送信号'));
renderLive({ ...live, calibrationSafety: { blocked: true, reason: 'EXIT_FAILED <bad>' } });
assert(element('#live-runtime-strip').innerHTML.includes('已阻止新仓'));
assert(element('#live-runtime-strip').innerHTML.includes('&lt;bad&gt;'));
renderLive(live, { runtimeSnapshot: { status: 'STALE', sampledAt: Date.now() - 60_000 } });
assert.equal(element('#live-mode-title').textContent, '交易状态快照已过期');
sandbox.healthFixture = { status: 'streaming', stream: { regions: [] }, database: {}, engine: {}, labels: {},
  trading: { mode: 'LIVE', strategies: [...paused, live] } };
run('renderHealth(healthFixture)');
const healthTrading = element('#health-cards').innerHTML.match(/<h2>Trading<\/h2>([\s\S]*?)<\/article>/)[1];
assert(healthTrading.includes('Legacy Early Flow RUGX'));
assert(healthTrading.includes('H30 / A10 / D5 / 30m'));
assert(!healthTrading.includes('1秒跌'));

const ids = ['LEGACY-EARLY-FLOW-BASE', 'LEGACY-EARLY-FLOW-RUGX'];
const configs = ids.map(id => ({ id, entryMode: 'LEGACY_EARLY_FLOW', newEntriesEnabled: true,
  positionSizeSol: 0.02, executionVersion: 'LEGACY_EARLY_FLOW_EXEC_V1',
  hardStopPct: 30, trailingActivationPct: 10, trailingStopPct: 5, maxHoldMs: 1_800_000,
  configuredCostPct: 3.2, liveBridgeEnabled: id === ids[1],
  liveStrategyId: id === ids[1] ? live.id : null,
}));
const shadow = {
  runtimeShadow: { enabled: true, newEntriesEnabled: true,
    strategy: { cohorts: [...configs, { id: 'PMO-FLOW-H20-A75-D25-X300-BASE', positionSizeSol: 1 }] },
    legacyEarlyFlow: { evaluated: 18, matched: 4, liveSignals: 3, liveBridgeErrors: 0,
      strictRejectedByReason: { STALE_QUOTE: 2 } },
  },
  shadow: {
    // Entire-suite stats deliberately poisonous: Legacy must not display these as its results.
    stats: { signals: 999999, average_net_return_pct: 999 },
    cohorts: [
      ...ids.map(id => ({ cohort_id: id, position_sol: 0.02, configured_cost_pct: 3.2,
        signals: 4, mints: 4, entered: 3, resolved: 2, win_rate_pct: 50,
        average_net_return_pct: -3, profit_factor: 0.6, no_exit: 1 })),
      { cohort_id: 'PMO-FLOW-H20-A75-D25-X300-BASE', signals: 999999 },
      { cohort_id: 'LEGACY-EARLY-FLOW-RUGX-OLD', signals: 888888 },
    ],
    rugComparisons: [
      { baselineProfileId: ids[0], filteredProfileId: ids[1], label: 'EXACT_NEW_PAIR',
        pairedSignals: 4, comparableResolved: 2, blocked: 1, resolvedBlocked: 1,
        pairAudit: { candidatePairs: 6, sourceMismatch: 1, protocolMismatch: 1,
          entryMismatch: 0, guardUnavailable: 1, incompleteOutcomes: 2 } },
      { baselineProfileId: 'PMO-FLOW-H20-A75-D25-X300-BASE', filteredProfileId: 'PMO-FLOW-H20-A75-D25-X300-RUGX', label: 'PMO_PAIR_ONLY' },
      { baselineProfileId: ids[0], filteredProfileId: 'LEGACY-EARLY-FLOW-RUGX-OLD', label: 'WRONG_LEGACY_PAIR' },
    ],
    positions: [
      { cohort_id: ids[0], status: 'CLOSED', net_return_pct: 12, position_sol: 0.02,
        features: { sourceFeatures: { netFlow1sSol: 0.5, buyers5s: 3, trades5s: 4,
          maxSingleBuyShare5s: 0.6, ageMs: 20_000 } } },
      { cohort_id: ids[1], status: 'NO_EXIT', net_return_pct: 99, position_sol: 0.02 },
      { cohort_id: ids[1], status: 'OPEN', net_return_pct: 77, position_sol: 0.02, features_json: 'malformed' },
      { cohort_id: ids[1], status: 'EXIT_PENDING', net_return_pct: 88, position_sol: 0.02, features_json: 'null' },
      { cohort_id: 'PMO-FLOW-POISON', status: 'CLOSED', net_return_pct: 666 },
      { cohort_id: 'LEGACY-EARLY-FLOW-RUGX-OLD', status: 'CLOSED', net_return_pct: 555 },
    ],
  },
};
sandbox.shadowFixture = shadow;
run('activeLiveStrategyId="legacy-early-flow-base"; renderLegacyEarlyFlowShadow(shadowFixture)');
let rows = element('#legacy-early-flow-cohort-rows').innerHTML;
assert.equal((rows.match(/data-legacy-cohort=/g) || []).length, 2);
assert(rows.includes('原版无RUG过滤'));
assert(rows.includes('当前阶段重复作恶钱包/模板RUG过滤'));
assert(rows.includes('0.02 SOL'));
assert(rows.includes('H30 / A10 / D5 / 30m'));
assert(rows.includes('估算费用 3.2%，非链上实际费用'));
assert(!/PMO|888|999|1 SOL/.test(rows));
assert(element('#legacy-early-flow-metrics').innerHTML.includes(live.id));
assert(element('#legacy-early-flow-metrics').innerHTML.includes('允许发送信号'));
assert(element('#legacy-early-flow-pair-rows').innerHTML.includes('EXACT_NEW_PAIR'));
assert(element('#legacy-early-flow-pair-rows').innerHTML.includes('风控不可用 1'));
assert(element('#legacy-early-flow-pair-rows').innerHTML.includes('不计过滤收益'));
assert(!/PMO_PAIR_ONLY|WRONG_LEGACY_PAIR/.test(element('#legacy-early-flow-pair-rows').innerHTML));
assert(element('#legacy-early-flow-position-rows').innerHTML.includes('+12%'));
assert(element('#legacy-early-flow-position-rows').innerHTML.includes('0.5 SOL / 3'));
assert(element('#legacy-early-flow-position-rows').innerHTML.includes('最大单笔 60%'));
assert(element('#legacy-early-flow-position-rows').innerHTML.includes('0.02 SOL / 20s'));
assert(!/\+99%|\+77%|\+88%|666|555/.test(element('#legacy-early-flow-position-rows').innerHTML));
assert(!/undefined|NaN/.test(allText()));

run('renderMigrationSecondLegObserver(shadowFixture)');
assert(element('#m2f-rug-pair-rows').innerHTML.includes('PMO_PAIR_ONLY'));
assert(!element('#m2f-rug-pair-rows').innerHTML.includes('EXACT_NEW_PAIR'));
assert(!element('#m2f-shadow-metrics').innerHTML.includes('999'), 'no mixed-suite fallback for PMO metrics');
assert(!element('#m2f-shadow-cohort-rows').innerHTML.includes('LEGACY-EARLY-FLOW'));

sandbox.shadowFixture = { ...shadow,
  runtimeShadow: { ...shadow.runtimeShadow, legacyEarlyFlow: {
    evaluated: 18, sourceSignals: 2, cohortSignals: 4, signals: 4,
  } },
  shadow: { ...shadow.shadow, legacyCohorts: [shadow.shadow.cohorts[0]],
    legacyPositions: [shadow.shadow.positions[0]], positions: [{ cohort_id: ids[0], status: 'CLOSED', net_return_pct: 333 }] },
};
run('renderLegacyEarlyFlowShadow(shadowFixture)');
assert(element('#legacy-early-flow-metrics').innerHTML.includes('18 / 2'));
assert(element('#legacy-early-flow-metrics').innerHTML.includes('两臂记录 4'));
assert(element('#legacy-early-flow-position-rows').innerHTML.includes('+12%'));
assert(!element('#legacy-early-flow-position-rows').innerHTML.includes('+333%'), 'dedicated indexed rows take precedence over mixed rows');
assert(element('#legacy-early-flow-cohort-rows').innerHTML.includes('等待前向样本'), 'dedicated cohort data must not fall back to mixed aggregate for a missing arm');

sandbox.shadowFixture = { ...shadow, runtimeSnapshot: { status: 'STALE' } };
run('renderLegacyEarlyFlowShadow(shadowFixture)');
assert(!element('#legacy-early-flow-metrics').innerHTML.includes('允许发送信号'));

sandbox.shadowFixture = { ...shadow, solUsdReference: readyReference,
  runtimeShadow: { ...shadow.runtimeShadow, legacyEarlyFlow: fdvSource } };
run('renderLegacyEarlyFlowShadow(shadowFixture)');
assert(element('#legacy-early-flow-metrics').innerHTML.includes('READY · 可计算FDV'));
assert(element('#legacy-early-flow-metrics').innerHTML.includes('FDV缺数据阻断'));
assert(element('#legacy-early-flow-metrics').innerHTML.includes('724'));
sandbox.shadowFixture.solUsdReference = { ...readyReference, status: 'STALE', ready: false, reference: null };
run('renderLegacyEarlyFlowShadow(shadowFixture)');
assert(element('#legacy-early-flow-metrics').innerHTML.includes('过期 · 无法判断机会'));
sandbox.shadowFixture = { ...shadow, runtimeShadow: { ...shadow.runtimeShadow, newEntriesEnabled: false } };
run('renderLegacyEarlyFlowShadow(shadowFixture)');
assert(element('#legacy-early-flow-cohort-rows').innerHTML.includes('停止新增；存量继续退出'));
assert(!element('#legacy-early-flow-metrics').innerHTML.includes('允许发送信号'));
assert(element('#legacy-early-flow-metrics').innerHTML.includes('待确认 · 非正常结论'));

run('renderLegacyEarlyFlowShadow({dashboardQuery:{status:"PREPARING"}})');
rows = element('#legacy-early-flow-cohort-rows').innerHTML;
assert.equal((rows.match(/data-legacy-cohort=/g) || []).length, 2, 'both configured families remain discoverable with no data');
assert(rows.includes('等待前向样本'));
assert(rows.includes('配置待确认'));
assert(!rows.includes('前向采集中'));
assert(!element('#legacy-early-flow-metrics').innerHTML.includes('允许发送信号'));
assert(element('#legacy-early-flow-expression').textContent.includes('后台准备'));
assert(element('#legacy-early-flow-pair-rows').innerHTML.includes('等待严格配对'));
assert(!/undefined|NaN/.test(allText()));
assert.equal(requests, 0);

async function testCachedSourceDiagnosticsApi() {
  const ResearchServer = require('../src/server/server');
  let currentReference = readyReference;
  let healthReads = 0;
  const server = new ResearchServer({
    config: { storage: { dbPath: ':memory:' }, dashboardCache: { enabled: true },
      liveTrading: { strategies: [live] }, migrationSecondLegShadow: { cohorts: configs },
      smartWallets: [] },
    store: { config: { dbPath: ':memory:' },
      dashboardQueryInWorker: async () => ({ shadow: {}, solUsdReference: { status: 'POISON_STORED' } }) },
    trader: { health: () => ({ mode: 'LIVE', strategies: [live] }) },
    migrationSecondLegShadow: { health: () => ({ legacyEarlyFlow: fdvSource }) },
    migrationSecondLegObserver: { health: () => ({ enabled: true }) },
    solUsdReference: { health() { healthReads++; return currentReference; },
      refresh() { throw new Error('HTTP must not refresh SOL/USD'); } },
  });
  // Exercise the production snapshot path without opening a file-backed DB.
  server.dashboardReadModel.enabled = true;
  server.dashboardReadModel.read = () => ({ status: 'READY', generatedAt: Date.now(),
    value: { stats: {}, shadow: {}, solUsdReference: { status: 'POISON_STORED' },
      sourceDiagnostics: { solUsdReference: { status: 'POISON_STORED' } } } });
  const httpServer = await new Promise(resolve => {
    const listening = server.app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const api = async route => {
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}${route}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    let response = await api(`/api/live-trading?strategyId=${live.id}`);
    assert.deepEqual(response.sourceDiagnostics.solUsdReference, readyReference);
    assert.equal(response.sourceDiagnostics.rejectedByReason.FDV_REFERENCE_UNAVAILABLE, 724);
    assert.equal(response.sourceDiagnostics.fdvRejectedByReason.SOL_USD_REFERENCE_UNAVAILABLE, 700);
    response = await api('/api/migration-second-leg-observer');
    assert.deepEqual(response.solUsdReference, readyReference, 'independent HTTP cached route must report current owner reference');
    server.dashboardReadModel.enabled = false;
    response = await api('/api/migration-second-leg-observer');
    assert.deepEqual(response.solUsdReference, readyReference, 'direct worker route must expose same contract');
    server.dashboardReadModel.enabled = true;
    currentReference = { status: 'UNAVAILABLE', ready: false, reference: null,
      refreshing: false, timeouts: 3, lastErrorCode: 'SOL_USD_REQUEST_TIMEOUT' };
    response = await api(`/api/live-trading?strategyId=${live.id}`);
    assert.deepEqual(response.sourceDiagnostics.solUsdReference, currentReference, 'runtime error is not replaced by stale historical cache');
    assert.equal(healthReads, 4, 'one cached health read per request, no feed polling');
    server.solUsdReference = null;
    response = await api(`/api/live-trading?strategyId=${live.id}`);
    assert.equal(response.sourceDiagnostics.solUsdReference, null, 'missing owner stays unknown');
    response = await api('/api/migration-second-leg-observer');
    assert.equal(response.solUsdReference, null);
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
}

testCachedSourceDiagnosticsApi().then(() => {
  console.log('PASS Legacy Early Flow Dashboard: cached FDV readiness/failure diagnostics, HTTP contracts, strict pairs and unknown handling');
}).catch(error => { console.error(error); process.exitCode = 1; });
