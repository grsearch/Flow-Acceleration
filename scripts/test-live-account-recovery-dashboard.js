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
    refund_sol: 0.00203928, recovery_fee_sol: 0.000105, cash_after_recovery_pnl_sol: -0.00106572,
    queueCounts: { WAITING_FEE_QUOTE: 12, WAITING_ACCOUNT_EMPTY: 3, WAITING_TRADING: 2,
      WAITING_SAFETY: 1, QUEUED: 4, SIGNED_UNCONFIRMED: 5, CONFIRMED: 18, BLOCKED: 2, ABSENT: 1 } },
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
assert(rows.includes('链上结果未知（保留锁，不保证广播成功）')); assert(rows.includes('已退款（链上已确认）'));
assert(rows.includes('&lt;script&gt;')); assert(!rows.includes('<script>'));
assert(rows.includes('阶段 &lt;unsafe-stage&gt;')); assert(!rows.includes('<unsafe-stage>'));
assert(!/undefined|NaN/.test(rows + metrics));
assert(rows.includes('已签 未知') && rows.includes('未签检查 未知'));
assert(rows.includes('连续失败 未知') && rows.includes('最近检查 未知') && rows.includes('下次检查 未知'));
assert(rows.includes('报价诊断未知（旧快照不推算）'));
let queue = element('#live-account-recovery-queue').innerHTML;
assert(queue.includes('当前策略全体回收任务'));
assert(queue.includes('等待费用报价 <b>12</b>') && queue.includes('已退款 <b>18</b>'), 'summary includes all tasks, not the two visible cases');
assert(element('#live-account-recovery-note').textContent.includes('已签次数也不等于已广播或已扣费次数'));

const inspectionTime = 1_788_691_221_000;
sandbox.fixture.cases = [
  { position_id: 1, status: 'PENDING', error: 'CLEANUP_FEE_UNAVAILABLE', error_stage: 'FEE_QUOTE',
    attempts: 0, checks: 7, consecutive_failures: 4, last_checked_at: inspectionTime,
    next_attempt_at: inspectionTime + 60_000,
    diagnostics: { version: 'ACCOUNT_RECOVERY_DIAGNOSTICS_V1',
      account: { status: 'EMPTY', tokenAmountRaw: '0', contextSlot: 123, reason: 'SAFE_EMPTY' },
      quoteAttempts: [
        { rpc: 'PRIMARY', blockhashSlot: 124, feeSlot: 124, feeLamports: null, result: 'CLEANUP_FEE_UNAVAILABLE' },
        { rpc: 'PRIMARY', blockhashSlot: 125, feeSlot: 125, feeLamports: null, result: 'CLEANUP_FEE_UNAVAILABLE' },
        { rpc: 'FALLBACK', blockhashSlot: 126, feeSlot: 126, feeLamports: '105000', result: 'OK' },
        { rpc: 'FALLBACK', result: 'MUST_NOT_DISPLAY' } ], rawTransactionBase64: 'NEVER_RENDER_RAW_PAYLOAD' } },
  { position_id: 2, status: 'PENDING', error: 'TOKEN_ACCOUNT_BALANCE_NONZERO',
    diagnostics: { version: 'ACCOUNT_RECOVERY_DIAGNOSTICS_V1', account: { status: 'NONZERO', tokenAmountRaw: '9' } } },
  { position_id: 3, status: 'PENDING', error: 'TOKEN_ACCOUNT_NOT_SAFELY_EMPTY' },
  { position_id: 4, status: 'PENDING', error: 'TOKEN_ACCOUNT_DELEGATED' },
  { position_id: 5, status: 'PENDING', error: 'TOKEN_ACCOUNT_AUTHORITY_MISMATCH' },
  { position_id: 6, status: 'PENDING', error: 'ACTIVE_POSITION_OR_UNRESOLVED_ORDER' },
  { position_id: 7, status: 'PENDING', error: null },
  { position_id: 8, status: 'PREPARED', signature: 'fixture-signature', attempts: 1, checks: 2 },
  { position_id: 9, status: 'UNKNOWN', signature: 'fixture-signature', attempts: 1, checks: 2 },
  { position_id: 10, status: 'BLOCKED', error: 'CLEANUP_FEE_TOO_HIGH', error_stage: 'FEE_QUOTE' },
  { position_id: 11, status: 'CONFIRMED', error: null },
  { position_id: 12, status: 'PENDING', error: '<script>error</script>', error_stage: '<stage>',
    diagnostics: { version: 'ACCOUNT_RECOVERY_DIAGNOSTICS_V1',
      account: { status: '<status>', tokenAmountRaw: '<img>', reason: '<reason>' },
      quoteAttempts: [{ rpc: 'https://private.invalid/?key=secret', blockhashSlot: '<slot>',
        feeSlot: null, feeLamports: '<fee>', result: '<script>quote</script>' }] } },
];
run('renderLiveAccountRecovery(fixture)');
rows = element('#live-account-recovery-rows').innerHTML;
assert(rows.includes('等待费用报价 / 报价重试（未发送）'));
assert(rows.includes('账户仍有代币，等待清空（未发送）'));
assert(rows.includes('空账户安全校验未通过（未发送）'));
assert.equal((rows.match(/权限安全检查阻止回收（未发送）/g) || []).length, 2);
assert(rows.includes('等待交易结束（未发送）') && rows.includes('排队未发送'));
assert(rows.includes('已签名待确认（不保证广播成功）'));
assert(rows.includes('链上结果未知（保留锁，不保证广播成功）'));
assert(rows.includes('已停止回收，等待检查') && rows.includes('已退款（链上已确认）'));
assert(rows.includes('已签 0<br>未签检查 7<br>连续失败 4'));
assert(rows.includes(`最近检查 ${run(`dateTime(${inspectionTime})`)}`));
assert(rows.includes(`下次检查 ${run(`dateTime(${inspectionTime + 60_000})`)}`));
assert(rows.includes('代币余额 0 raw') && rows.includes('代币余额 9 raw'));
assert(rows.includes('主 RPC · blockhash slot 124 · fee slot 124 · 费用 未知 lamports'));
assert(rows.includes('备用 RPC · blockhash slot 126 · fee slot 126 · 费用 105000 lamports · OK'));
assert(!rows.includes('MUST_NOT_DISPLAY') && !rows.includes('NEVER_RENDER_RAW_PAYLOAD'));
assert(rows.includes('&lt;status&gt;') && rows.includes('&lt;reason&gt;') && rows.includes('&lt;script&gt;quote&lt;/script&gt;'));
assert(!rows.includes('<script>') && !rows.includes('<img>') && !rows.includes('key=secret'));
assert(!/undefined|NaN/.test(rows));
assert.equal(run("recoveryStateLabel('PENDING', 'AUTHORITY_MISMATCH')"), '权限安全检查阻止回收（未发送）');
assert.equal(run("recoveryStateLabel('PENDING', 'ACCOUNT_RECOVERY_MIN_AGE')"), '等待最短观察期（未发送）');
assert.equal(run("recoveryStateLabel('PENDING', 'CLEANUP_BLOCKHASH_CONTEXT_STALE', 'BLOCKHASH')"), '等待费用上下文 / 区块哈希重试（未发送）');
for (const status of ['CONFIRMED', 'BLOCKED', 'ABSENT']) {
  sandbox.terminalStatus = status;
  sandbox.fixture.cases = [{ status, next_attempt_at: null }];
  run('renderLiveAccountRecovery(fixture)');
  assert(element('#live-account-recovery-rows').innerHTML.includes('下次检查 已结束，不自动重试'));
  assert.equal(run('recoveryNextCheckTime(terminalStatus, undefined)'), '未知', 'omitted old field is still unknown');
}
const queueCounts = sandbox.fixture.summary.queueCounts;
delete sandbox.fixture.summary.queueCounts;
run('renderLiveAccountRecovery(fixture)');
assert(element('#live-account-recovery-queue').innerHTML.includes('分类未知；不以最近 20 条案例推算'));
sandbox.fixture.summary.queueCounts = { WAITING_FEE_QUOTE: 12 };
run('renderLiveAccountRecovery(fixture)');
queue = element('#live-account-recovery-queue').innerHTML;
assert(queue.includes('等待账户清空 <b>未知</b>'), 'missing categories must not become zero');
sandbox.fixture.summary.queueCounts = queueCounts;
sandbox.fixture.cases = Array.from({ length: 30 }, (_, i) => ({ position_id: i }));
run('renderLiveAccountRecovery(fixture)');
assert.equal((element('#live-account-recovery-rows').innerHTML.match(/<tr>/g) || []).length, 20);
run('renderLiveAccountRecovery({available:false,summary:null,cases:[]})');
assert(element('#live-account-recovery-metrics').innerHTML.includes('旧收据未知，不是零占款'));
assert(!element('#live-account-recovery-rows').innerHTML.includes('test-account'));
assert(element('#live-account-recovery-queue').innerHTML.includes('分类未知'));
assert(!element('#live-account-recovery-queue').innerHTML.includes('<b>12</b>'));
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
  gross_return_pct: -12.44480665, economic_verified: true, economic_pnl_sol: -0.000849657,
  economic_return_pct: -4.2260979856, economic_cost_basis_sol: 0.020105,
  account_retained_funding_sol: 0.001887234, recovery_refund_sol: 0,
  recovery_network_fee_sol: 0, cash_after_recovery_pnl_sol: -0.002736891,
  account_recovery_states: { PENDING: 1 }, account_recovery_error: 'INVALID_ACCOUNT_FUNDING',
  exit_reason: 'TRAILING_STOP', hold_ms: 9000,
};
sandbox.liveFixture = {
  runtime: { mode: 'LIVE', strategies: [{ id: position134.strategy_id, positionSizeSol: 0.02 }] },
  positions: [position134], stats: { win_rate_pct: 98, wins: 999, average_realized_return_pct: 123,
    total_realized_pnl_sol: 456 }, orders: [], decisions: [], accountRecovery: sandbox.fixture,
  performance: { basis: 'ECONOMIC_VERIFIED_CLOSED_V1', status: 'COMPLETE', closed_positions: 1,
    verified_closed_positions: 1, unverified_closed_positions: 0, wins: 0, win_rate_pct: 0,
    average_return_pct: -4.2260979856, verified_pnl_sol: -0.000849657,
    total_pnl_sol: -0.000849657, coverage_pct: 100 },
};
run("activeExecutionStrategyId = 'legacy_early_flow_rugx_live'; renderLiveTrading(liveFixture)");
let positionRows = element('#live-position-rows').innerHTML;
assert.equal((positionRows.match(/<tr>/g) || []).length, 1);
assert(positionRows.includes('原交易现金 -0.002737 SOL / -12.44%'));
assert(positionRows.includes('<td class="negative">已核实经济 -0.00085 SOL / -4.23%'));
assert(positionRows.indexOf('已核实经济') < positionRows.indexOf('原交易现金'));
assert(positionRows.includes('现金收益基数 0.02199223 SOL（含账户占款）'));
assert(positionRows.includes('收益基数 0.020105 SOL（剔除账户占款）'));
assert(positionRows.includes('触发参考价涨跌 +0.73%（非成交收益）'));
assert(positionRows.includes('账户留存 0.00188723 SOL · 已确认退款 0 SOL · 回收费 0 SOL'));
assert(positionRows.includes('排队未发送 1 项 · 最近原因：检查未通过，等待重查（未发送） · INVALID_ACCOUNT_FUNDING'));
assert(!positionRows.includes(' · 阶段 '));
assert(positionRows.includes('截至目前现金 -0.00273689 SOL（仅计已确认回收，不含待回收资金）'));
assert(!positionRows.includes('回收后现金'));
assert(!/undefined|NaN/.test(positionRows));
assert(positionRows.includes('最近检查 未知 · 下次检查 未知 · 未签检查 未知'));
// Position-level fields are supplied independently of the truncated case panel.
sandbox.liveFixture.positions = [{ ...position134, account_recovery_error: 'CLEANUP_FEE_UNAVAILABLE',
  account_recovery_error_stage: 'FEE_QUOTE', account_recovery_checks: 7,
  account_recovery_last_checked_at: inspectionTime, account_recovery_next_attempt_at: inspectionTime + 60_000,
}];
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
assert(positionRows.includes('最近原因：等待费用报价 / 报价重试（未发送） · CLEANUP_FEE_UNAVAILABLE · 阶段 FEE_QUOTE'));
assert(positionRows.includes(`最近检查 ${run(`dateTime(${inspectionTime})`)} · 下次检查 ${run(`dateTime(${inspectionTime + 60_000})`)} · 未签检查 7`));
sandbox.liveFixture.positions = [{ ...position134, account_recovery_states: { PENDING: 1, BLOCKED: 1 },
  account_recovery_error: 'CLEANUP_FEE_TOO_HIGH', account_recovery_error_stage: 'FEE_QUOTE',
}];
run('renderLiveTrading(liveFixture)');
assert(!element('#live-position-rows').innerHTML.includes('最近原因：等待费用报价'), 'do not attribute one blocked task error to every queued account');
sandbox.liveFixture.positions = [position134];
run('renderLiveTrading(liveFixture)');
let mainMetrics = element('#live-metrics').innerHTML;
assert(mainMetrics.includes('经济胜率（已核实）'));
assert(mainMetrics.includes('平均经济收益（已核实）'));
assert(mainMetrics.includes('累计经济盈亏（全体已平仓）'));
assert(mainMetrics.includes('已核实 1 / 1 仓；待核实 0 仓'));
assert(mainMetrics.includes('-0.00085 SOL'));
assert(!mainMetrics.includes('98%') && !mainMetrics.includes('+123%') && !mainMetrics.includes('456 SOL'));

// A confirmed refund changes only the displayed confirmed ledger values.
sandbox.liveFixture.positions = [{ ...position134,
  account_retained_funding_sol: 0, recovery_refund_sol: 0.001887234,
  recovery_network_fee_sol: 0.000105, cash_after_recovery_pnl_sol: -0.000954657,
  economic_pnl_sol: -0.000954657, economic_return_pct: -4.74835613,
  account_recovery_states: { CONFIRMED: 1 }, account_recovery_error: null,
  account_recovery_next_attempt_at: null,
}];
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
assert(positionRows.includes('账户留存 0 SOL · 已确认退款 0.00188723 SOL · 回收费 0.000105 SOL'));
assert(positionRows.includes('已退款（链上已确认） 1 项'));
assert(positionRows.includes('下次检查 已结束，不自动重试'));
assert(positionRows.includes('截至目前现金 -0.00095466 SOL'));
assert(!positionRows.includes('排队未发送'));
assert(!positionRows.includes(' · 阶段 '));

// Unknown confirmation is not a projected refund or zero funding; errors escape.
sandbox.liveFixture.positions = [{ ...position134, economic_verified: false, economic_pnl_sol: null,
  economic_return_pct: null, economic_cost_basis_sol: null,
  account_retained_funding_sol: null, cash_after_recovery_pnl_sol: null,
  account_recovery_states: { UNKNOWN: 1 }, account_recovery_error: '<script>unsafe</script>',
  account_recovery_error_stage: '<unsafe-stage>',
}];
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
assert(positionRows.includes('<td class="muted">经济待核实（不计输赢）'));
assert(positionRows.includes('账户留存 待验证'));
assert(positionRows.includes('截至目前现金 待验证'));
assert(positionRows.includes('链上结果未知（保留锁，不保证广播成功） 1 项'));
assert(positionRows.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
assert(positionRows.includes('阶段 &lt;unsafe-stage&gt;'));
assert(!positionRows.includes('<unsafe-stage>'));
assert(!positionRows.includes('<script>'));
assert(!/undefined|NaN/.test(positionRows));

// Cash loss does not determine the primary color when verified economics win.
sandbox.liveFixture.positions = [{ ...position134, economic_pnl_sol: 0.001,
  economic_return_pct: 4.97388709, realized_pnl_sol: -0.000887234,
  realized_return_pct: -4.034, gross_return_pct: -4.034,
}];
sandbox.liveFixture.performance = { ...sandbox.liveFixture.performance,
  wins: 1, win_rate_pct: 100, average_return_pct: 4.97388709,
  verified_pnl_sol: 0.001, total_pnl_sol: 0.001,
};
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
assert(positionRows.includes('<td class="positive">已核实经济 +0.001 SOL / +4.97%'));
assert(positionRows.includes('原交易现金 -0.000887 SOL / -4.03%'));
mainMetrics = element('#live-metrics').innerHTML;
assert(mainMetrics.includes('<span>经济胜率（已核实）</span><strong>100%</strong>'));
assert(mainMetrics.includes('<strong class="positive">0.001 SOL</strong>'));

// Verified older rows may predate the explicit basis column. The server has
// already validated their economic return, so only the auxiliary basis is unknown.
delete sandbox.liveFixture.positions[0].economic_cost_basis_sol;
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
assert(positionRows.includes('<td class="positive">已核实经济 +0.001 SOL / +4.97%'));
assert(positionRows.includes('经济收益基数 待验证（剔除账户占款）'));
assert(!positionRows.includes('经济待核实（不计输赢）'));

// Only the verified subset has performance; an accidental/stale total is ignored.
sandbox.liveFixture.performance = { basis: 'ECONOMIC_VERIFIED_CLOSED_V1', status: 'PARTIAL',
  closed_positions: 3, verified_closed_positions: 2, unverified_closed_positions: 1,
  wins: 1, win_rate_pct: 50, average_return_pct: 1.25, verified_pnl_sol: 0.0005,
  total_pnl_sol: 987654, coverage_pct: 66.6666667,
};
run('renderLiveTrading(liveFixture)');
mainMetrics = element('#live-metrics').innerHTML;
assert(mainMetrics.includes('已核实 2 / 3 仓；待核实 1 仓'));
assert(mainMetrics.includes('<span>经济胜率（已核实）</span><strong>50%</strong>'));
assert(mainMetrics.includes('<span>累计经济盈亏（全体已平仓）</span><strong class="muted">待核实</strong>'));
assert(mainMetrics.includes('0.0005 SOL') && mainMetrics.includes('66.7%'));
assert(!mainMetrics.includes('987,654') && !mainMetrics.includes('456 SOL'));

// EMPTY means no closed sample, not a 0% win rate or proven zero profit.
sandbox.liveFixture.performance = { ...sandbox.liveFixture.performance, status: 'EMPTY',
  closed_positions: 0, verified_closed_positions: 0, unverified_closed_positions: 0,
  wins: 0, win_rate_pct: null, average_return_pct: null, verified_pnl_sol: 0,
  total_pnl_sol: 0, coverage_pct: null,
};
run('renderLiveTrading(liveFixture)');
mainMetrics = element('#live-metrics').innerHTML;
assert(mainMetrics.includes('<span>经济胜率（已核实）</span><strong>暂无已平仓</strong>'));
assert(mainMetrics.includes('<span>累计经济盈亏（全体已平仓）</span><strong class="muted">暂无已平仓</strong>'));

// Missing or unavailable old snapshots never fall back to legacy cash metrics,
// and populated economic numbers without the explicit verification flag are stale.
delete sandbox.liveFixture.performance;
delete sandbox.liveFixture.positions[0].economic_verified;
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
mainMetrics = element('#live-metrics').innerHTML;
assert(positionRows.includes('<td class="muted">经济待核实（不计输赢）'));
assert(!positionRows.includes('已核实经济 +0.001'));
assert(positionRows.includes('原交易现金 -0.000887 SOL'));
assert(mainMetrics.includes('经济证据待核实；不以现金收益替代'));
assert(mainMetrics.includes('<span>经济胜率（已核实）</span><strong>待核实</strong>'));
assert(!mainMetrics.includes('98%') && !mainMetrics.includes('456 SOL'));
sandbox.liveFixture.performance = { basis: 'ECONOMIC_VERIFIED_CLOSED_V1', status: 'UNAVAILABLE',
  closed_positions: 1, verified_closed_positions: 1, unverified_closed_positions: 0,
  wins: 1, win_rate_pct: 100, average_return_pct: 999, verified_pnl_sol: 999, total_pnl_sol: 999,
};
run('renderLiveTrading(liveFixture)');
assert(!element('#live-metrics').innerHTML.includes('999 SOL'));

// DRY_RUN remains a simulated view even if a stale live performance object or
// economic flag arrives in the same payload; it has no account-rent accounting.
sandbox.liveFixture.runtime.mode = 'DRY_RUN';
sandbox.liveFixture.positions = [{ ...position134, mode: 'DRY_RUN', realized_pnl_sol: null,
  realized_return_pct: null, economic_verified: true, economic_pnl_sol: 777,
  economic_return_pct: 888, price_return_pct: 12, gross_return_pct: 12,
}];
sandbox.liveFixture.stats = { win_rate_pct: 75, wins: 3, average_realized_return_pct: 2.5,
  total_realized_pnl_sol: 0.002 };
run('renderLiveTrading(liveFixture)');
positionRows = element('#live-position-rows').innerHTML;
mainMetrics = element('#live-metrics').innerHTML;
assert(positionRows.includes('<td class="positive">模拟收益 +12%'));
assert(!positionRows.includes('经济') && !positionRows.includes('账户留存'));
assert(mainMetrics.includes('<span>模拟胜率</span><strong>75%</strong>'));
assert(mainMetrics.includes('平均模拟收益') && !mainMetrics.includes('经济胜率'));
assert(!mainMetrics.includes('999 SOL'));
sandbox.liveFixture.runtime.mode = 'LIVE';
sandbox.liveFixture.positions = [{ ...position134 }];

// Old snapshots do not imply that omitted recovery records are completed.
delete sandbox.liveFixture.positions[0].account_recovery_states;
run('renderLiveTrading(liveFixture)');
assert(element('#live-position-rows').innerHTML.includes('回收状态待验证'));
sandbox.liveFixture.positions = [];
run('renderLiveTrading(liveFixture)');
assert(element('#live-position-rows').innerHTML.includes('暂无仓位记录'));
assert.equal(requests, 0);
console.log('Live account recovery Dashboard tests passed: verified economics primary, partial coverage and unknown isolation, cash audit, DRY_RUN isolation, pending/confirmed refunds, safe escaping, no extra requests.');
