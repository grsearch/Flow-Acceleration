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
const sandbox = { console, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval: () => 0,
  CSS: { escape: value => value }, DashboardRuntime: dashboardRuntime,
  document: { hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {} },
  fetch() { requests += 1; throw new Error('Feedback panel cannot add a request'); },
};
vm.createContext(sandbox); vm.runInContext(source, sandbox);
const run = script => vm.runInContext(script, sandbox);
const summary = { captured: 15, largeLossCases: 3, provisional: 1, confirmedRug: 1, mixedLoss: 0,
  executionLoss: 1, marketLoss: 0, candidates: 0, unknown: 1, pending: 2, invalidSettlement: 1,
  learnedCases: 1, templatesAdded: 1, walletsAdded: 2, withdrawn: 1 };
sandbox.feedback = { available: true, summary, cases: [
  { positionId: 1, mint: 'safe-mint', status: 'FINAL', classification: 'CONFIRMED_RUG', updatedAt: 1000,
    settledAt: 999, realizedReturnPct: -61, entryEvidence: { capturedAt: 100 },
    triggerEvidence: { markReturnPct: -53 }, learning: { status: 'LEARNED', templatesAdded: 1, walletsAdded: 2 } },
  { positionId: 2, mint: '<script>unsafe</script>', status: 'TRIGGERED', classification: '<unsafe>',
    triggerEvidence: { evidenceUnavailable: true }, learning: { status: '<bad>' } },
] };
run('renderLiveLossRugFeedback(feedback)');
let rows = element('#live-loss-rug-rows').innerHTML;
assert(rows.includes('确认 RUG')); assert(rows.includes('已学习'));
assert(rows.includes('-61%')); assert(rows.includes('-53%'));
assert(rows.includes('尚未结算')); assert(rows.includes('未保存')); assert(rows.includes('证据不完整'));
assert(!rows.includes('<unsafe>')); assert(rows.includes('&lt;unsafe&gt;'));
assert(!rows.includes('<script>')); assert(!rows.includes('<bad>'));
assert(element('#live-loss-rug-note').textContent.includes('BASE/RUGX 严格同源对照'));
assert(element('#live-loss-rug-note').textContent.includes('入场证据 15 条不计入大亏'));
assert(element('#live-loss-rug-metrics').innerHTML.includes('已结算 ≥50% 大亏'));
assert(!/undefined|NaN/.test(rows + element('#live-loss-rug-metrics').innerHTML));
sandbox.feedback.cases = Array.from({ length: 30 }, (_, id) => ({ positionId: id, status: 'ANALYZED' }));
run('renderLiveLossRugFeedback(feedback)');
assert.equal((element('#live-loss-rug-rows').innerHTML.match(/<tr>/g) || []).length, 20);
run('renderLiveLossRugFeedback({available:false,summary:null,cases:[]})');
assert(element('#live-loss-rug-metrics').innerHTML.includes('不等于零大亏'));
assert(!element('#live-loss-rug-rows').innerHTML.includes('safe-mint'));
run('renderLiveLossRugFeedback({available:true,summary:{},cases:[]})');
assert(element('#live-loss-rug-rows').innerHTML.includes('不据此认定过滤有效'));
assert(!/undefined|NaN/.test(element('#live-loss-rug-metrics').innerHTML));
run('renderLiveLossRugFeedback(feedback); renderLivePending()');
assert(element('#live-loss-rug-rows').innerHTML.includes('此策略案例待加载'), 'switching strategies clears stale cases');
assert(source.includes('renderLiveLossRugFeedback(data.lossRugFeedback)'), 'render uses selected strategy snapshot, not health counters');
assert.equal(requests, 0);
console.log('Live loss RUG Dashboard tests passed: scoped snapshot, compact statuses, explicit unknown, safe escaping, no extra request.');
