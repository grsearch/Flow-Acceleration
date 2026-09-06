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
  { position_id: 2, account_address: '<unsafe>', status: 'UNKNOWN', error: '<script>bad</script>', error_stage: '<unsafe-stage>' }] };
run('renderLiveAccountRecovery(fixture)');
const metrics = element('#live-account-recovery-metrics').innerHTML;
assert(metrics.includes('原交易现金盈亏')); assert(metrics.includes('经济盈亏（全体已平仓）'));
assert(metrics.includes('待验证')); assert(metrics.includes('已验证 2 / 3 仓'));
assert(metrics.includes('已验证子集经济盈亏'));
assert(metrics.includes('截至目前现金盈亏（已知部分）'));
assert(metrics.includes('不含待回收资金'));
assert(!metrics.includes('回收后现金'));
assert(element('#live-account-recovery-note').textContent.includes('不再给经济盈亏加一次'));
let rows = element('#live-account-recovery-rows').innerHTML;
assert(rows.includes('0.00203928 SOL')); assert(rows.includes('0.000105 SOL'));
assert(rows.includes('确认未知，保留锁')); assert(rows.includes('退款已确认'));
assert(rows.includes('&lt;script&gt;')); assert(!rows.includes('<script>'));
assert(rows.includes('阶段 &lt;unsafe-stage&gt;')); assert(!rows.includes('<unsafe-stage>'));
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

// Exercise the actual Live Trading renderer, not only strings in its source.
// Production position #134: correct cash/economic arithmetic, no refund yet.
const position134 = {
  id: 134, strategy_id: 'legacy_early_flow_rugx_live', status: 'CLOSED', mode: 'LIVE',
  mint: 'test-mint', position_sol: 0.02, updated_at: 1788691221000,
  entry_price: 0.0000005038, highest_price: 0.0000005659, exit_price: 0.0000005074,
  price_return_pct: 0.727, entry_sol_delta: -0.021992234,
  realized_pnl_sol: -0.002736891, realized_return_pct: -12.44480665,
  gross_return_pct: -12.44480665, economic_pnl_sol: -0.000849657,
  economic_return_pct: -4.2260979856, economic_cost_basis_sol: 0.020105,
  account_retained_funding_sol: 0.001887234, recovery_refund_sol: 0,
  recovery_network_fee_sol: 0, cash_after_recovery_pnl_sol: -0.002736891,
  account_recovery_states: { PENDING: 1 }, account_recovery_error: 'INVALID_ACCOUNT_FUNDING',
  exit_reason: 'TRAILING_STOP', hold_ms: 9000,
};
sandbox.liveFixture = {
  runtime: { mode: 'LIVE', strategies: [{ id: position134.strategy_id, positionSizeSol: 0.02 }] },
  positions: [position134], stats: {}, orders: [], decisions: [], accountRecovery: sandbox.fixture,
};
run("activeExecutionStrategyId = 'legacy_early_flow_rugx_live'; renderLiveTrading(liveFixture)");
let positionRows = element('#live-position-rows').innerHTML;
assert.equal((positionRows.match(/<tr>/g) || []).length, 1);
assert(positionRows.includes('原交易现金 -0.002737 SOL / -12.44%'));
assert(positionRows.includes('经济 -0.00085 SOL / -4.23%'));
assert(positionRows.includes('现金收益基数 0.02199223 SOL（含账户占款）'));
assert(positionRows.includes('收益基数 0.020105 SOL（剔除账户占款）'));
assert(positionRows.includes('触发参考价涨跌 +0.73%（非成交收益）'));
assert(positionRows.includes('账户留存 0.00188723 SOL · 已确认退款 0 SOL · 回收费 0 SOL'));
assert(positionRows.includes('待回收（未退款） 1 项 · INVALID_ACCOUNT_FUNDING'));
assert(!positionRows.includes(' · 阶段 '));
assert(positionRows.includes('截至目前现金 -0.00273689 SOL（仅计已确认回收，不含待回收资金）'));
assert(!positionRows.includes('回收后现金'));
assert(!/undefined|NaN/.test(positionRows));

// A confirmed refund changes only the displayed confirmed ledger values.
sandbox.liveFixture.positions = [{ ...position134,
  account_retained_funding_sol: 0, recovery_refund_sol: 0.001887234,
  recovery_network_fee_sol: 0.000105, cash_after_recovery_pnl_sol: -0.000954657,
  economic_pnl_sol: -0.000954657, economic_return_pct: -4.74835613,
  account_recovery_states: { CONFIRMED: 1 }, account_recovery_error: null,
}];
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
assert(positionRows.includes('账户留存 0 SOL · 已确认退款 0.00188723 SOL · 回收费 0.000105 SOL'));
assert(positionRows.includes('退款已确认 1 项'));
assert(positionRows.includes('截至目前现金 -0.00095466 SOL'));
assert(!positionRows.includes('待回收（未退款）'));
assert(!positionRows.includes(' · 阶段 '));

// Unknown confirmation is not a projected refund or zero funding; errors escape.
sandbox.liveFixture.positions = [{ ...position134, economic_pnl_sol: null,
  economic_return_pct: null, economic_cost_basis_sol: null,
  account_retained_funding_sol: null, cash_after_recovery_pnl_sol: null,
  account_recovery_states: { UNKNOWN: 1 }, account_recovery_error: '<script>unsafe</script>',
  account_recovery_error_stage: '<unsafe-stage>',
}];
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
assert(positionRows.includes('经济 待验证'));
assert(positionRows.includes('账户留存 待验证'));
assert(positionRows.includes('截至目前现金 待验证'));
assert(positionRows.includes('确认未知（不预计退款） 1 项'));
assert(positionRows.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
assert(positionRows.includes('阶段 &lt;unsafe-stage&gt;'));
assert(!positionRows.includes('<unsafe-stage>'));
assert(!positionRows.includes('<script>'));
assert(!/undefined|NaN/.test(positionRows));

// Old snapshots do not imply that omitted recovery records are completed.
delete sandbox.liveFixture.positions[0].account_recovery_states;
run('renderLiveTrading(liveFixture)');
assert(element('#live-position-rows').innerHTML.includes('回收状态待验证'));
sandbox.liveFixture.positions = [];
run('renderLiveTrading(liveFixture)');
assert(element('#live-position-rows').innerHTML.includes('暂无仓位记录'));
assert.equal(requests, 0);
console.log('Live account recovery Dashboard tests passed: actual position rows, distinct return bases, trigger reference, pending/confirmed/unknown refunds, safe escaping, no extra requests.');
