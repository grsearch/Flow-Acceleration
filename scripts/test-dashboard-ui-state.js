'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = require('../src/server/public/dashboard-runtime');

const html = fs.readFileSync(path.join(__dirname, '../src/server/public/index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)][0][1]
  .replace(/^\s*void refresh\(\);\r?$/m, '');
const ho = { id: 'graduation_accel_o_c80_ho500_x60_live', code: 'O-C80-HO500-X60',
  label: 'HO500 0.1 SOL', enabled: true, entryEnabled: true, market: 'PUMP_AMM',
  positionSizeSol: 0.1, signalSource: 'GRADUATION_ACCEL_O_C80_HO500_X60',
  hardStopPct: 30, maxHoldMs: 60_000, fixedHoldMs: 60_000 };
const old = { id: 'old_disabled', code: 'OLD', label: 'Old disabled', enabled: false,
  entryEnabled: true, positionSizeSol: 1, market: 'PUMP_AMM' };
const other = { ...ho, id: 'other', code: 'OTHER', label: 'Other strategy' };
const catalog = { live: [old, ho, other], shadows: {}, runtime: { gitCommit: 'test', pid: 1 },
  configurationIntegrity: { status: 'OK', issues: [], mismatches: [] } };
const detail = (strategy = ho) => ({ strategyId: strategy.id,
  generatedAt: Date.now(), dashboardSnapshot: { status: 'READY', generatedAt: Date.now() },
  runtime: { mode: 'LIVE', strategies: [strategy] }, stats: { orders: 4 },
  positions: [], orders: [], decisions: [] });
const response = (value) => ({ ok: true, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function createPage() {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', className: '', hidden: false, children: [], dataset: {},
      classList: { toggle() {} }, setAttribute() {}, getAttribute() { return null; },
      appendChild() {}, addEventListener() {},
    });
    return elements.get(selector);
  }
  let handler = async () => response({});
  const requests = [];
  const sandbox = {
    console, URLSearchParams, AbortController, setTimeout, clearTimeout,
    setInterval: () => 0, CSS: { escape: value => value },
    document: { hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    fetch: async (url, options) => { requests.push(url); return handler(url, options); },
    DashboardRuntime: { ...runtime, createJsonClient: (options) => {
      const client = runtime.createJsonClient(options);
      return (url, settings = {}) => client(url, { ...settings, timeoutMs: 35 });
    } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'dashboard-inline.js' });
  return { sandbox, element, requests, run: code => vm.runInContext(code, sandbox),
    handle: next => { handler = next; }, set: (name, value) => { sandbox[name] = value; } };
}

async function main() {
  assert(!html.includes('data-live-execution-strategy="quality_leader_ql_strict_protected_live"'),
    'initial menu must not imply an old strategy is the currently selected strategy');
  assert(html.includes('src="/dashboard-runtime.js"'));
  const sorted = runtime.normalizeLiveCatalog([old, ho, { ...ho }]);
  assert.deepStrictEqual(sorted.map(row => row.id), [ho.id, old.id]);
  assert.strictEqual(runtime.pickLiveStrategy(sorted, null), ho.id);
  assert.strictEqual(runtime.pickLiveStrategy(sorted, old.id), old.id, 'preserve explicit historical selection');

  let aborted = false;
  const timedJson = runtime.createJsonClient({ timeoutMs: 10, fetchImpl: (_url, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {}); // Deliberately ignores the abort to test deadline release.
  } });
  await assert.rejects(timedJson('/hung'), error => error.name === 'TimeoutError');
  assert(aborted, 'deadline must cancel the underlying request');
  const parent = new AbortController();
  const cancelled = timedJson('/cancel', { signal: parent.signal, timeoutMs: 1_000 });
  parent.abort();
  await assert.rejects(cancelled, error => error.name === 'AbortError');

  const page = createPage();
  page.set('catalogData', catalog);
  page.run("activeTabId='live-trading'; activeLiveStrategyId='smart-open'; renderLiveStrategyCatalog(catalogData)");
  const menu = page.element('#live-execution-strategy-selector').innerHTML;
  assert(menu.includes(ho.id), 'HO500 must be visible while viewing a Shadow page');
  assert(menu.includes('data-strategy-state="stopped" data-live-strategy="execution" data-live-execution-strategy="old_disabled"'));
  assert(menu.includes('配置已禁用'));
  assert.strictEqual(page.run('activeExecutionStrategyId'), ho.id);

  // A never-ending catalog request cannot hold the selected detail refresh lock.
  page.handle(url => url === '/api/strategy-status' ? new Promise(() => {}) : response(detail()));
  page.run("activeLiveStrategyId='execution'");
  await page.run('refresh(true)');
  assert.strictEqual(page.run('refreshInFlight'), false);
  assert(page.element('#live-order-summary').textContent.includes('4'));
  assert(page.run('Boolean(catalogRequest)'), 'catalog is still pending, independently');
  await page.run('catalogRequest');
  assert(page.element('#strategy-catalog-status').textContent.includes('STALE'));

  // Switching to an uncached strategy must remove all previous content immediately.
  page.element('#live-position-rows').innerHTML = '<tr>OLD PRIVATE POSITION</tr>';
  page.element('#live-strategy-expression').textContent = 'OLD RULE';
  page.run("activeExecutionStrategyId='other'; renderCachedStrategyView()");
  assert(!page.element('#live-position-rows').innerHTML.includes('OLD PRIVATE POSITION'));
  assert(!page.element('#live-strategy-expression').textContent.includes('OLD RULE'));
  assert(page.element('#live-strategy-expression').textContent.includes('OTHER'));
  assert(page.element('#live-metrics').innerHTML.includes('统计尚未加载'));

  // A late response from an old selected view cannot mutate the new one.
  const late = deferred();
  page.handle(() => late.promise);
  page.run("activeExecutionStrategyId='graduation_accel_o_c80_ho500_x60_live'; refreshGeneration=99");
  const oldRequest = page.run("loadDashboard('/old', renderLiveTrading, {generation:99, viewKey:activeViewKey(), strategyId:activeExecutionStrategyId})");
  page.run("activeExecutionStrategyId='other'; refreshGeneration=100; renderLivePending()");
  late.resolve(response(detail()));
  await oldRequest;
  assert(page.element('#live-strategy-expression').textContent.includes('OTHER'));

  // PREPARING does not render normalized zero counts as a successful snapshot.
  page.handle(() => response({ ...detail(other), dashboardSnapshot: { status: 'PREPARING' }, stats: { orders: 0 } }));
  await page.run("loadDashboard('/preparing', renderLiveTrading, {generation:100, viewKey:activeViewKey(), strategyId:activeExecutionStrategyId})");
  assert(page.element('#live-metrics').innerHTML.includes('统计尚未加载'));
  assert.strictEqual(page.run('strategyViewCache.has(activeViewKey())'), false);

  // A detail timeout releases its lock, retains only same-view successful data, and can recover.
  page.handle(url => url === '/api/strategy-status' ? response(catalog) : new Promise(() => {}));
  const detailTimeout = page.run('refresh(true)');
  await page.run('catalogRequest');
  assert(!page.element('#strategy-catalog-status').textContent.includes('STALE'), 'catalog recovers while detail is pending');
  assert.strictEqual(page.run('refreshInFlight'), true, 'detail is still pending independently');
  await detailTimeout;
  assert.strictEqual(page.run('refreshInFlight'), false);
  assert(page.element('#strategy-load-status').textContent.includes('ERROR'));
  page.handle(url => response(url === '/api/strategy-status' ? catalog : detail(other)));
  await page.run('refresh(true)');
  assert(page.element('#strategy-load-status').textContent.includes('READY'));
  assert(page.element('#live-order-summary').textContent.includes('4'));
  page.handle(url => url === '/api/strategy-status' ? response(catalog) : new Promise(() => {}));
  await page.run('refresh(true)');
  assert(page.element('#strategy-load-status').textContent.includes('STALE / ERROR'));
  assert(page.element('#live-order-summary').textContent.includes('4'), 'preserve last successful same-strategy data');

  page.handle(() => response(detail(ho)));
  await assert.rejects(page.run("loadDashboard('/wrong-strategy', renderLiveTrading, {generation:refreshGeneration, viewKey:activeViewKey(), strategyId:activeExecutionStrategyId})"), /策略与所选策略不一致/);
  assert(page.element('#live-order-summary').textContent.includes('4'));

  // Rendering an old cached detail must never replace the current catalog.
  page.element('#live-execution-strategy-selector').innerHTML = 'CURRENT CATALOG WITH HO500';
  page.run('renderCachedStrategyView()');
  assert.strictEqual(page.element('#live-execution-strategy-selector').innerHTML, 'CURRENT CATALOG WITH HO500');

  const staleRuntime = { ...detail(other), runtimeSnapshot: { status: 'STALE', sampledAt: Date.now() - 60_000 } };
  page.handle(() => response(staleRuntime));
  await page.run("loadDashboard('/stale-runtime', renderLiveTrading, {generation:refreshGeneration, viewKey:activeViewKey(), strategyId:activeExecutionStrategyId})");
  assert(page.element('#live-mode-title').textContent.includes('交易状态快照已过期'));
  assert(page.element('#live-mode-badge').textContent.includes('旧快照'));
  assert(page.element('#strategy-load-status').textContent.includes('交易状态快照已过期'));
  page.set('integrityCatalog', { ...catalog, configurationIntegrity: {
    status: 'MISMATCH', mismatchedFiles: ['src/config.js'], warnings: ['HO500_STRATEGY_MISSING'],
  } });
  page.run('renderLiveStrategyCatalog(integrityCatalog)');
  assert(page.element('#strategy-catalog-status').textContent.includes('HO500 未配置'));

  // Background backtests expose state first, never incomplete numeric results.
  const backtestPage = createPage();
  for (const state of ['PREPARING', 'BUSY', 'ERROR']) {
    backtestPage.handle(() => response({ dashboardQuery: { status: state } }));
    await backtestPage.run("requestBacktest('size=0.1')");
    assert(backtestPage.element('#backtest-query-status').textContent.includes(state));
    assert(backtestPage.element('#backtest-results').innerHTML.includes('暂不展示收益数值'));
  }
  const backtestResult = { metrics: { completedSamples: 42 }, parameters: { totalCostPct: 2 },
    dashboardQuery: { status: 'READY', generatedAt: Date.now() } };
  backtestPage.handle(() => response(backtestResult));
  await backtestPage.run("requestBacktest('size=0.1')");
  const priorResultHtml = backtestPage.element('#backtest-results').innerHTML;
  assert(priorResultHtml.includes('42'));
  backtestPage.handle(() => response({ dashboardQuery: { status: 'BUSY' } }));
  await backtestPage.run("requestBacktest('size=1')");
  assert.strictEqual(backtestPage.element('#backtest-results').innerHTML, priorResultHtml);
  assert(backtestPage.element('#backtest-query-status').textContent.includes('参数不同，并非本次结果'));
  backtestPage.handle(() => response({ ...backtestResult, dashboardQuery: { status: 'STALE', generatedAt: Date.now() - 600_000 } }));
  await backtestPage.run("requestBacktest('size=0.1')");
  assert(backtestPage.element('#backtest-query-status').textContent.includes('以下为旧回测结果'));
  backtestPage.handle(() => response({ dashboardQuery: { status: 'READY' } }));
  await backtestPage.run("requestBacktest('size=0.1')");
  assert(backtestPage.element('#backtest-query-status').textContent.includes('未返回完整回测统计'));
  assert.strictEqual(backtestPage.element('#backtest-results').innerHTML, priorResultHtml);
  console.log('test-dashboard-ui-state: ok (catalog isolation, HO500, disabled, deadlines, stale runtime, backtest states, recovery)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
