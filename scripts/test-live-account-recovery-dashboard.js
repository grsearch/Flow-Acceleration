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
  if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', className: '',
    hidden: false, children: [], dataset: {}, classList: { toggle() {} }, setAttribute() {},
    getAttribute() { return null; }, appendChild() {}, addEventListener() {} });
  return elements.get(selector);
};
let requests = 0;
const sandbox = { console, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval: () => 0,
  CSS: { escape: value => value }, DashboardRuntime: dashboardRuntime,
  document: { hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {} },
  fetch() { requests += 1; throw new Error('Account panel cannot request an endpoint'); } };
vm.createContext(sandbox); vm.runInContext(source, sandbox);
const run = code => vm.runInContext(code, sandbox);
sandbox.fixture = { available: true,
  summary: { cash_pnl_sol: -0.003, economic_pnl_sol: null, verified_economic_pnl_sol: 0.001,
    funding_complete_positions: 2, closed_positions: 3, retained_funding_sol: 0.00203928,
    refund_sol: 0.00203928, recovery_fee_sol: 0.000105, cash_after_recovery_pnl_sol: -0.00106572 },
  cases: [{ position_id: 1, account_address: 'test-account', status: 'CONFIRMED', funded_lamports: '2039280',
    refund_lamports: '2039280', network_fee_sol: 0.000105, wallet_sol_delta: 0.00193428, signature: 'test-close' },
  { position_id: 2, account_address: '<unsafe>', status: 'UNKNOWN', error: '<script>bad</script>' }] };
run('renderLiveAccountRecovery(fixture)');
const metrics = element('#live-account-recovery-metrics').innerHTML;
assert(metrics.includes('原交易现金盈亏')); assert(metrics.includes('经济盈亏（全体已平仓）'));
assert(metrics.includes('待验证')); assert(metrics.includes('已验证 2 / 3 仓'));
assert(metrics.includes('已验证子集经济盈亏'));
assert(element('#live-account-recovery-note').textContent.includes('不再给经济盈亏加一次'));
let rows = element('#live-account-recovery-rows').innerHTML;
assert(rows.includes('0.00203928 SOL')); assert(rows.includes('0.000105 SOL'));
assert(rows.includes('确认未知，保留锁')); assert(rows.includes('退款已确认'));
assert(rows.includes('&lt;script&gt;')); assert(!rows.includes('<script>'));
assert(!/undefined|NaN/.test(rows + metrics));
sandbox.fixture.cases = Array.from({ length: 30 }, (_, i) => ({ position_id: i }));
run('renderLiveAccountRecovery(fixture)');
assert.equal((element('#live-account-recovery-rows').innerHTML.match(/<tr>/g) || []).length, 20);
run('renderLiveAccountRecovery({available:false,summary:null,cases:[]})');
assert(element('#live-account-recovery-metrics').innerHTML.includes('旧收据未知，不是零占款'));
assert(!element('#live-account-recovery-rows').innerHTML.includes('test-account'));
run('renderLiveAccountRecovery(fixture); renderLivePending()');
assert(element('#live-account-recovery-rows').innerHTML.includes('所选策略账户证据待加载'));
assert(source.includes('renderLiveAccountRecovery(data.accountRecovery)'));
assert(source.includes('row.economic_pnl_sol') && source.includes('row.cash_after_recovery_pnl_sol'));
assert.equal(requests, 0);
console.log('Live account recovery Dashboard tests passed: explicit cash/economic/funding/recovery, partial coverage, unknown, safe escaping, no extra requests.');
