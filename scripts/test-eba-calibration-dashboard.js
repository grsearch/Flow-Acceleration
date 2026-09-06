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
let requests = 0;
const sandbox = {
  console, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval: () => 0,
  CSS: { escape: value => value }, DashboardRuntime: dashboardRuntime,
  document: { hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {} },
  fetch() { requests += 1; throw new Error('Rendering must not request another endpoint'); },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'dashboard-inline.js' });
const run = script => vm.runInContext(script, sandbox);
const calibration = {
  id: 'early_pure_buy_burst_eba_fix20_calibration_live', code: 'EB-A-FIX20-CAL02',
  label: 'EB-A 0.02 SOL执行校准', enabled: true, entryEnabled: true,
  market: 'PUMP_BONDING_CURVE', signalSource: 'EARLY_PURE_BUY_EBA_EXEC_V1',
  sourceShadowCohortId: 'EB_A_EXEC_V1:FIX20_H30_EXEC_V1', ruleVersion: 'eba_calibration_v1',
  positionSizeSol: 0.02, hardStopPct: 30, fixedHoldMs: 20_000, maxHoldMs: 20_000,
  maxConcurrentPositions: 3, maxTotalConcurrentPositions: 3, activePositions: 0,
  calibrationOnly: true, stopOnExecutionAnomaly: true,
  cumulativeAmountLimitSol: null, cumulativeLossLimitSol: null, cumulativeTradeLimit: null,
  calibrationSafety: { blocked: false, reason: null },
};
const detail = strategy => ({
  strategyId: strategy.id, generatedAt: Date.now(),
  dashboardSnapshot: { status: 'READY', generatedAt: Date.now() },
  runtime: { mode: 'LIVE', strategies: [strategy], maxConcurrentPositions: 10,
    maxConcurrentPositionsPerMint: 3, minWalletReserveSol: 0.05,
    priorityFeeSol: 0.0001, emergencyPriorityFeeSol: 0.0001, killSwitchActive: false },
  stats: {}, positions: [{}], orders: [{}], decisions: [{}],
});
function render(strategy = calibration, extra = {}) {
  sandbox.fixture = { ...detail(strategy), ...extra };
  sandbox.selectedId = strategy.id;
  run('activeExecutionStrategyId=selectedId; renderLiveTrading(fixture)');
}
function allText() {
  return [...elements.values()].map(item => `${item.textContent} ${item.innerHTML}`).join('\n');
}

const paused = [
  'graduation_accel_o_c80_ho500_x60_live',
  'migrated_ge30_r23_f2_only_g2_xleg_live',
  'migrated_grt_r23_f3_v2_xleg_live',
].map(id => ({ id, code: id, enabled: true, entryEnabled: false, positionSizeSol: 0.1 }));
sandbox.catalogFixture = { live: [...paused, calibration], shadows: {} };
run('renderLiveStrategyCatalog(catalogFixture)');
const menu = element('#live-execution-strategy-selector').innerHTML;
assert(menu.includes('EB-A-FIX20-CAL02'));
assert(menu.includes('0.02 SOL'));
assert.equal((menu.match(/data-strategy-state="active"/g) || []).length, 1);
assert.equal((menu.match(/data-strategy-state="stopped"/g) || []).length, 3);

render();
let cards = element('#live-strategy-cards').innerHTML;
assert(cards.includes('0.02 SOL'));
assert(cards.includes('30%'));
assert(cards.includes('20s'));
assert(cards.includes('本策略最大并发</span><b>3 仓'));
assert(cards.includes('账户总并发约束</span><b>3 仓'));
assert(!cards.includes('10 仓'), 'do not show the unrelated global concurrency as this strategy limit');
assert(cards.includes('普通买/卖优先费</span><b>0.0001 SOL / 笔'));
assert(cards.includes('紧急卖出优先费</span><b>0.0001 SOL / 笔'));
assert.equal((cards.match(/不设累计上限/g) || []).length, 3);
assert(cards.includes('非盈利验证'));
assert(cards.includes('Bonding Curve 固定SOL硬上限'));
assert(!cards.includes('XLEG'));
assert(element('#live-mode-title').textContent.includes('小额真实执行校准'));
assert(element('#live-strategy-expression').textContent.includes('20s'));
assert(element('#live-runtime-strip').innerHTML.includes('未触发（仍受其他执行保护约束）'));
assert(!/undefined|NaN/.test(allText()), 'missing counters and order fields must remain explicit unknown');

render(calibration, { runtime: { ...detail(calibration).runtime, emergencyPriorityFeeSol: undefined } });
cards = element('#live-strategy-cards').innerHTML;
assert(cards.includes('普通买/卖优先费</span><b>0.0001 SOL / 笔'));
assert(cards.includes('紧急卖出优先费</span><b>待确认'), 'missing emergency fee must not fall back to the normal fee');
render(calibration, { runtime: { ...detail(calibration).runtime, priorityFeeSol: undefined, emergencyPriorityFeeSol: 0 } });
cards = element('#live-strategy-cards').innerHTML;
assert(cards.includes('普通买/卖优先费</span><b>待确认'));
assert(cards.includes('紧急卖出优先费</span><b>0 SOL / 笔'), 'explicit zero fee is not unknown');
assert(html.includes('name="priorityFeeSol" type="number" min="0" step="0.0001" value="0.0005"'),
  'the independent historical research form default is not the live execution fee');

render({ ...calibration, calibrationSafety: null,
  cumulativeAmountLimitSol: undefined, cumulativeLossLimitSol: undefined, cumulativeTradeLimit: undefined });
cards = element('#live-strategy-cards').innerHTML;
assert(cards.includes('待确认，不能认定可开仓'));
assert(!cards.includes('不设累计上限'), 'missing policy is not an explicit unlimited policy');
render({ ...calibration, calibrationSafety: { blocked: true, reason: 'EXIT_FAILED <unsafe>' } });
assert(element('#live-runtime-strip').innerHTML.includes('已阻止新仓'));
assert(element('#live-runtime-strip').innerHTML.includes('&lt;unsafe&gt;'));
assert(!element('#live-runtime-strip').innerHTML.includes('<unsafe>'));
render(calibration, { runtimeSnapshot: { status: 'STALE', sampledAt: Date.now() - 60_000 } });
assert.equal(element('#live-mode-title').textContent, '交易状态快照已过期');
assert(element('#live-mode-description').textContent.includes('不能据此确认'));
render({ ...calibration, entryEnabled: false });
assert(element('#live-mode-title').textContent.includes('已停止新开仓'));

// Shadow profiles are not silently pooled with the old 1 SOL cohort or hidden without samples.
sandbox.shadowFixture = {
  health: { enabled: true, positionSizeSol: 1, entryProfiles: [
    { id: 'EB_A', label: 'EB-A old', newEntriesEnabled: false },
    { id: 'EB_A_EXEC_V1', label: 'EB-A execution V1', newEntriesEnabled: true,
      positionSizeSol: 0.02, fixedHoldMs: 20_000, hardStopPct: 30,
      executionVersion: 'EB_EXEC_POST_TARGET_V1' },
  ], exitProfiles: [{ id: 'FIX20', label: '固定20秒', maxHoldMs: 20_000 },
    { id: 'FIX20_H30_EXEC_V1', label: '严格20秒/止损30%', maxHoldMs: 20_000, hardStopPct: 30 }] },
  cohorts: [
    { cohort_id: 'EB_A:FIX20', entry_profile_id: 'EB_A', exit_profile_id: 'FIX20',
      position_sol: 1, signals: 3, completed: 3, averageNetReturnPct: 5 },
    { cohort_id: 'EB_A_EXEC_V1:FIX20_H30_EXEC_V1', entry_profile_id: 'EB_A_EXEC_V1', exit_profile_id: 'FIX20_H30_EXEC_V1',
      position_sol: 0.02, configured_cost_pct: 3.05, signals: 2, no_exit: 1, right_censored: 1 },
  ],
  positions: [{ entry_profile_id: 'EB_A_EXEC_V1', exit_profile_id: 'FIX20_H30_EXEC_V1',
    status: 'NO_EXIT', net_return_pct: 99, position_sol: 0.02 }],
};
run('renderEarlyPureBuyBurstShadow(shadowFixture)');
const shadowRows = element('#early-pure-buy-burst-cohort-rows').innerHTML;
assert(shadowRows.includes('data-eb-cohort="EB_A_EXEC_V1:FIX20_H30_EXEC_V1"'));
assert(shadowRows.includes('0.02 SOL'));
assert(shadowRows.includes('1 SOL'));
assert(shadowRows.includes('固定20s · 硬止损30%'));
assert(shadowRows.includes('停止新增'));
assert(shadowRows.includes('未知不记0'));
assert(shadowRows.includes('EB_EXEC_POST_TARGET_V1'));
assert(shadowRows.includes('估算成本 3.05%，非链上实际费用'));
assert(element('#early-pure-buy-burst-expression').textContent.includes('旧缓存报价口径不与EXEC_V1严格链时间执行混算'));
assert(!element('#early-pure-buy-burst-metrics').innerHTML.includes('永不签名或发送实盘信号'));
assert(!element('#early-pure-buy-burst-position-rows').innerHTML.includes('+99%'), 'unclosed stale return is not settled profit');
assert(!/undefined|NaN/.test(allText()));
assert.equal(requests, 0);
console.log('PASS EB-A calibration dashboard: selected configuration, unlimited policy, safety unknown, stale runtime, and isolated Shadow display');
