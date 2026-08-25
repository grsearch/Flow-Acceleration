'use strict';

const assert = require('assert');
const { buildCohortSummary } = require('./export-cya-organic-burst-summary');

const rows = [
  ['COB_A', 'INV10_X30', 'CLOSED', 10],
  ['COB_A', 'FIX20', 'CLOSED', -5],
  ['COB_A', 'FIX30', 'NO_EXIT', null],
  ['COB_F', 'FIX30', 'CLOSED', 20],
  ['COB_F', 'FIX30', 'NO_EXIT', null],
  ['COB_F', 'FIX30', 'NO_ENTRY', null],
  ['COB_F', 'FIX30', 'PRICE_JUMP', null],
].map(([entry, exit, status, net], index) => ({
  entry_profile_id: entry,
  exit_profile_id: exit,
  status,
  net_return_pct: net,
  mint: `mint-${index}`,
}));

const summary = buildCohortSummary(rows);
assert.deepStrictEqual(
  summary.map((row) => `${row.entry_profile_id}:${row.exit_profile_id}`),
  ['COB_A:FIX20', 'COB_A:FIX30', 'COB_A:INV10_X30', 'COB_F:FIX30'],
);
assert.strictEqual(summary.find((row) => row.exit_profile_id === 'FIX30').signals, 1);
assert.strictEqual(summary.find((row) => row.exit_profile_id === 'INV10_X30').signals, 1);
const mixed = summary.find((row) => row.entry_profile_id === 'COB_F');
assert.strictEqual(mixed.signals, 4);
assert.strictEqual(mixed.entered, 2);
assert.strictEqual(mixed.priced_exits, 1);
assert.strictEqual(mixed.unpriced_exits, 1);
assert.strictEqual(mixed.entry_coverage_pct, 50);
assert.strictEqual(mixed.exit_price_coverage_pct, 50);
assert.strictEqual(mixed.priced_signal_coverage_pct, 25);
assert.strictEqual(mixed.no_exit_rate_pct, 50);
assert.strictEqual(mixed.stress_average_net_return_30_pct, -5);
assert.strictEqual(mixed.stress_average_net_return_50_pct, -15);
assert.strictEqual(mixed.stress_average_net_return_80_pct, -30);
console.log('CYA Organic Burst export tests: PASS');
