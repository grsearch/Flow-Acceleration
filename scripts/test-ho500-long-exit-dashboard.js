'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ResearchStore } = require('../src/data/ResearchStore');
const dashboardRuntime = require('../src/server/public/dashboard-runtime');

const profiles = [1800, 3600].flatMap((hold) => [[30, 20], [100, 30]]
  .flatMap(([activation, drawdown]) => [20, 30, 0].map(hardStop => ({
    id: `O_C80_HO500_LONG_A${activation}_D${drawdown}_H${hardStop || 'OFF'}_X${hold}`,
    label: `HO500 ${hold / 60}m A${activation} D${drawdown} H${hardStop || 'OFF'}`,
    experimentGroup: 'HO500_LONG_EXIT_V1', pairedEntryProfileId: 'O_C80_HO500_X60',
    hardStopPct: hardStop, runnerMaxHoldMs: hold * 1000,
    trailingActivationPct: activation, trailingStopPct: drawdown, capacitySols: [0.1],
  }))));
const store = new ResearchStore({
  dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
}, { configuredTradingCostPct: 2.71 });
let sequence = 0;

function insert(profileId, status, netReturn, { entered = true, capacity = 0.1 } = {}) {
  sequence += 1;
  const at = 1_000_000 + sequence * 1000;
  const row = store.createGraduationAccelerationShadowPosition({
    cohortId: `${profileId}:${capacity === 0.1 ? '0_1' : '1'}SOL`, episodeId: `episode-${sequence}`,
    entryProfileId: profileId, mint: `test-mint-${sequence}`, status,
    positionSol: capacity, configuredCostPct: 2.71, signalAt: at, signalPrice: 1,
    entryTargetAt: at + 500, entryDeadlineAt: at + 2500, coreWeightPct: 0,
  });
  store.updateGraduationAccelerationShadowPosition(row.id, {
    entryAt: entered ? at + 500 : null, entryPrice: entered ? 1 : null,
    exitAt: status === 'CLOSED' ? at + 5000 : null, netReturnPct: netReturn,
  });
}

function page() {
  const html = fs.readFileSync(path.join(__dirname, '../src/server/public/index.html'), 'utf8');
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)][0][1]
    .replace(/^\s*void refresh\(\);\r?$/m, '');
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', className: '', hidden: false, dataset: {}, children: [],
      classList: { toggle() {} }, setAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, appendChild() {},
    });
    return elements.get(selector);
  };
  let requests = 0;
  const sandbox = {
    console, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval: () => 0,
    CSS: { escape: value => value }, DashboardRuntime: dashboardRuntime,
    document: { hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    fetch: () => { requests += 1; throw new Error('Rendering must not request a new endpoint'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'dashboard-inline.js' });
  return { html, element, requests: () => requests,
    render(data) { sandbox.fixture = data; vm.runInContext('renderGraduationAccelerationShadow(fixture)', sandbox); } };
}

try {
  const firstId = profiles[0].id;
  for (const result of [120, -80, -50, 50, 0]) insert(firstId, 'CLOSED', result);
  insert(firstId, 'RUNNER', 800);
  insert(firstId, 'EXIT_PENDING', 800);
  insert(firstId, 'NO_EXIT', 700);
  insert(firstId, 'DATA_ERROR', 900);
  insert(firstId, 'CLOSED', null);
  insert(firstId, 'PENDING_ENTRY', null, { entered: false });
  insert(firstId, 'DATA_ERROR', 900, { entered: false });
  insert(firstId, 'CLOSED', 9999, { capacity: 1 });
  insert(profiles[1].id, 'NO_EXIT', 999);
  insert('O_C80_HO500_X60', 'CLOSED', 7);

  let cohortReads = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    if (sql.includes('COUNT(*) AS signals') && sql.includes('graduation_acceleration_shadow_positions')) cohortReads += 1;
    return prepare(sql);
  };
  const data = store.graduationAccelerationShadowDashboard({ cacheStats: true });
  store.graduationAccelerationShadowDashboard({ cacheStats: true });
  assert.equal(cohortReads, 1, 'new metrics must reuse the existing cached cohort aggregation');
  const row = data.cohorts.find(cohort => cohort.entry_profile_id === firstId && cohort.position_sol === 0.1);
  assert.equal(row.entered, 10);
  assert.equal(row.resolved, 5);
  assert.equal(row.closed, 6);
  assert.equal(row.missing_return_closed, 1);
  assert.equal(row.active_entered, 2);
  assert.equal(row.pending_entries, 1);
  assert.equal(row.no_exit, 1);
  assert.equal(row.data_error, 2);
  assert.equal(row.entered_data_error, 1);
  assert.equal(row.completed_coverage_pct, 50);
  assert.equal(row.terminal_exit_coverage_pct, 62.5);
  assert.equal(row.average_net_return_pct, 8, 'exclude unresolved/active/error values from completed returns');
  assert.equal(row.median_net_return_pct, 0);
  assert.equal(row.win_rate_pct, 40);
  assert.equal(row.loss_50_count, 2);
  assert.equal(row.loss_80_count, 1);
  assert.equal(row.win_50_count, 2);
  assert.equal(row.win_100_count, 1);

  const view = page();
  const runtimeProfiles = [...profiles].reverse();
  const originalOrder = runtimeProfiles.map(profile => profile.id).join(',');
  view.render({ ...data, runtime: { enabled: true, entryProfiles: [
    ...runtimeProfiles, { id: 'O_C80_HO500_X60', label: 'Original fixed 60s' },
    { ...profiles[0], id: 'other-experiment', experimentGroup: 'ANOTHER_EXPERIMENT' },
  ] } });
  const result = view.element('#graduation-acceleration-long-exit-rows').innerHTML;
  assert.equal((result.match(/data-ho500-long-profile=/g) || []).length, 12);
  for (const profile of profiles) assert(result.includes(`data-ho500-long-profile="${profile.id}"`));
  assert(result.indexOf(profiles[0].id) < result.indexOf(profiles[1].id));
  assert(result.indexOf(profiles[1].id) < result.indexOf(profiles[2].id), 'H20/H30/OFF remain adjacent');
  assert.equal(runtimeProfiles.map(profile => profile.id).join(','), originalOrder);
  const firstRow = result.match(/<tr[^>]*>[\s\S]*?<\/tr>/)[0];
  assert(firstRow.includes('10 / 5'));
  assert(firstRow.includes('2 / 1'));
  assert(firstRow.includes('1 / 2'));
  assert(firstRow.includes('50% / 62.5%'));
  assert(firstRow.includes('+8% / +0%'));
  assert(!result.includes('9,999'), 'do not mix 1 SOL results into the 0.1 SOL comparison');
  assert(result.includes('关闭（OFF）'));
  assert(result.includes('尚无样本'), 'configured groups remain visible before the first fill');
  assert(result.includes('— / —'), 'no completed samples must not imply zero return or zero win rate');
  assert(view.element('#graduation-acceleration-long-exit-status').textContent.includes('12 / 12'));
  assert(view.element('#graduation-acceleration-cohort-rows').innerHTML.includes('Original fixed 60s'));
  assert(view.html.includes('两者都不是行情连续覆盖率'));
  assert(view.html.includes('各组完成样本可能不同'));
  assert.equal(view.requests(), 0);

  view.render({ runtime: { enabled: false, entryProfiles: profiles }, cohorts: [], positions: [] });
  assert(view.element('#graduation-acceleration-long-exit-status').textContent.includes('暂停观察'));
  assert.equal((view.element('#graduation-acceleration-long-exit-rows').innerHTML.match(/尚无样本/g) || []).length, 12);
  view.render({ ...data, runtime: { enabled: true, entryProfiles: [] } });
  assert(view.element('#graduation-acceleration-long-exit-status').textContent.includes('历史统计'));
  assert(view.element('#graduation-acceleration-long-exit-rows').innerHTML.includes(firstId));
  assert.equal((view.element('#graduation-acceleration-long-exit-rows').innerHTML.match(/data-ho500-long-profile=/g) || []).length, 2);
  view.render({ runtime: { entryProfiles: [] }, cohorts: [] });
  assert(view.element('#graduation-acceleration-long-exit-status').textContent.includes('未包含'));
  assert(view.element('#graduation-acceleration-long-exit-rows').innerHTML.includes('尚未加载'));
  const postProfiles = profiles.map(profile => ({ ...profile, id: `${profile.id}_POSTV1`,
    pairedEntryProfileId: 'O_C80_HO500_X60_POSTV1', executionModelVersion: 'POST_TRADE_V1' }));
  const oldRow = { ...row, entry_profile_id: firstId, average_net_return_pct: 81 };
  const postRow = { ...row, entry_profile_id: postProfiles[0].id, average_net_return_pct: -9 };
  view.render({ runtime: { enabled: true, entryProfiles: [
    ...profiles.map(profile => ({ ...profile, newEntriesEnabled: false })), ...postProfiles,
  ] }, cohorts: [oldRow, postRow,
    { ...row, entry_profile_id: 'O_C80_HO500_X60_POSTV1', average_net_return_pct: -12 },
    { ...row, entry_profile_id: 'O_C80_HO500_X60_POSTV1_D1000', average_net_return_pct: -18 },
  ], positions: [] });
  const mixed = view.element('#graduation-acceleration-long-exit-rows').innerHTML;
  assert.equal((mixed.match(/data-ho500-long-profile=/g) || []).length, 13,
    '12 new groups plus only the old group with history, without merging versions');
  assert(mixed.includes('POSTV1 · 交易后报价'));
  assert(mixed.includes('旧 PRE · 历史口径'));
  assert(mixed.includes('+81%') && mixed.includes('-9%'));
  const execution = view.element('#graduation-acceleration-execution-model-rows').innerHTML;
  assert(execution.includes('延迟 1 秒') && execution.includes('-12%') && execution.includes('-18%'));
  assert.equal(view.requests(), 0, 'new execution comparison reuses the cached payload');
  console.log('test-ho500-long-exit-dashboard: ok (12 groups, 0.1 SOL isolation, unfinished states, coverage, tails, cached aggregation, no new requests)');
} finally {
  store.close();
}
