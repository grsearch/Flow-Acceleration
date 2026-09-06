'use strict';

const assert = require('node:assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');
const { economicPositionVerified } = require('../src/data/LiveAccountRecoveryStore');
const store = new ResearchStore({ dbPath: ':memory:', flushMs: 60_000, flushMax: 1000 },
  { configuredTradingCostPct: 0 });
const approx = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} vs ${expected}`);
const T = 1_900_000_000_000;
function insert(id, overrides = {}) {
  const row = { id, mint: `offline-mint-${id}`, strategy_id: 'economic-test', mode: 'LIVE', status: 'CLOSED',
    position_sol: 0.02, opened_at: T, closed_at: T + 10_000, updated_at: T + id, created_at: T,
    entry_sol_delta: -0.02199223, realized_pnl_sol: -0.00169, realized_return_pct: -7.68,
    economic_pnl_sol: 0.000197, economic_return_pct: 0.98, economic_cost_basis_sol: 0.020105,
    account_funding_complete: 1, account_recovery_complete: 1,
    account_funding_cash_pnl_sol: -0.00169, ...overrides };
  const keys = Object.keys(row);
  store.db.prepare(`INSERT INTO live_positions(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...keys.map(key => row[key]));
  return row;
}
const dashboard = (strategyId = 'economic-test', positionLimit = 100) => store.liveTradingDashboard({ strategyId, positionLimit });
try {
  assert.equal(dashboard().performance.status, 'EMPTY');
  assert.equal(dashboard().performance.total_pnl_sol, null);
  assert.equal(dashboard().performance.win_rate_pct, null);
  const first = insert(1);
  insert(2, { realized_pnl_sol: 0.002442, realized_return_pct: 11.1,
    account_funding_cash_pnl_sol: 0.002442, economic_pnl_sol: 0.004329, economic_return_pct: 21.53 });
  insert(3, { realized_pnl_sol: -0.002213, realized_return_pct: -10.06,
    account_funding_cash_pnl_sol: -0.002213, economic_pnl_sol: -0.000325, economic_return_pct: -1.62 });
  insert(4, { realized_pnl_sol: -0.001887, account_funding_cash_pnl_sol: -0.001887,
    economic_pnl_sol: 0, economic_return_pct: 0 });
  let page = dashboard('economic-test', 1);
  assert.equal(page.positions.length, 1);
  assert.equal(page.performance.closed_positions, 4, 'aggregate is not limited to visible positions');
  assert.equal(page.performance.basis, 'ECONOMIC_VERIFIED_CLOSED_V1');
  assert.equal(page.performance.status, 'COMPLETE');
  assert.equal(page.performance.wins, 2, 'cash-loss / economic-profit is a verified winner');
  assert.equal(page.performance.win_rate_pct, 50, 'flat verified trades remain in denominator');
  approx(page.performance.average_return_pct, (0.98 + 21.53 - 1.62) / 4);
  approx(page.performance.total_pnl_sol, 0.000197 + 0.004329 - 0.000325);
  assert.equal(page.stats.wins, 1, 'legacy cash reporting API semantics must not change');
  const cashBefore = page.stats.total_realized_pnl_sol;
  insert(5, { account_funding_complete: 0, economic_pnl_sol: 99 });
  insert(6, { account_recovery_complete: 0, economic_pnl_sol: 99 }); // PREPARED accounting
  insert(7, { account_recovery_complete: 0, economic_pnl_sol: null, economic_return_pct: null }); // UNKNOWN
  insert(8, { account_funding_cash_pnl_sol: -0.009, economic_pnl_sol: 99 }); // stale cash basis
  insert(9, { mode: 'DRY_RUN', economic_pnl_sol: 99 });
  insert(10, { status: 'OPEN', closed_at: null, economic_pnl_sol: 99 });
  insert(11, { strategy_id: 'other', economic_pnl_sol: 99 });
  insert(12, { status: 'ENTRY_FAILED', opened_at: null, economic_pnl_sol: 99 });
  page = dashboard();
  assert.equal(page.performance.closed_positions, 8);
  assert.equal(page.performance.verified_closed_positions, 4);
  assert.equal(page.performance.unverified_closed_positions, 4);
  assert.equal(page.performance.coverage_pct, 50);
  assert.equal(page.performance.status, 'PARTIAL');
  assert.equal(page.performance.total_pnl_sol, null, 'never extrapolate the subset to the whole strategy');
  approx(page.performance.verified_pnl_sol, 0.004201);
  assert.equal(page.performance.win_rate_pct, 50, 'unknown/DRY_RUN/OPEN/failed-entry are not losses');
  assert.deepEqual(page.positions.filter(row => row.economic_verified).map(row => row.id).sort(), [1, 2, 3, 4]);
  assert.equal(page.positions.find(row => row.id === 8).economic_pnl_sol, null, 'stale row is also hidden');
  const cashAfter = store.db.prepare("SELECT SUM(realized_pnl_sol) n FROM live_positions WHERE strategy_id='economic-test' AND status='CLOSED'").get().n;
  approx(page.stats.total_realized_pnl_sol, cashAfter);
  assert.notEqual(cashBefore, cashAfter);
  for (const patch of [
    { economic_pnl_sol: Infinity }, { economic_return_pct: NaN }, { account_funding_complete: null },
    { account_recovery_complete: 0 }, { mode: 'DRY_RUN' }, { status: 'OPEN' },
    { realized_pnl_sol: null }, { account_funding_cash_pnl_sol: -0.009 },
  ]) assert.equal(economicPositionVerified({ ...first, ...patch }), false);
  assert.equal(economicPositionVerified(first), true);
  assert.equal(dashboard('other').performance.status, 'COMPLETE');
  assert.equal(dashboard(null).performance.verified_closed_positions, 5);
  // Verify real receipt-driven accounting across an uncertain close and its refund
  // in the dedicated account-recovery-store suite; this suite never modifies orders.
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM live_orders').get().n, 0);
  // Prior readonly snapshots without the newly displayed basis remain readable:
  // their preexisting economic return was only computed for a positive basis.
  store.db.exec('ALTER TABLE live_positions DROP COLUMN economic_cost_basis_sol');
  assert.equal(dashboard().performance.verified_closed_positions, 4);
  store.db.exec('ALTER TABLE live_positions DROP COLUMN account_recovery_complete');
  assert.equal(dashboard().performance.status, 'UNAVAILABLE');
  assert.equal(dashboard().performance.win_rate_pct, null);
  assert.equal(dashboard().positions.some(row => row.economic_verified), false);
  store.db.exec('DROP TABLE live_account_recoveries');
  assert.equal(dashboard().performance.status, 'UNAVAILABLE');
  console.log('Live economic performance: verified coverage, cash/profit divergence, flat trades, stale/unknown exclusion, mode/strategy isolation and readonly compatibility passed');
} finally { store.close(); }
