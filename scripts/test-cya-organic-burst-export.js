'use strict';

const assert = require('assert');
const { buildCohortSummary } = require('./export-cya-organic-burst-summary');

const rows = [
  ['COB_A', 'INV10_X30', 'CLOSED', 10],
  ['COB_A', 'FIX20', 'CLOSED', -5],
  ['COB_A', 'FIX30', 'NO_EXIT', null],
  ['COB_F', 'FIX30', 'CLOSED', 20],
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
console.log('CYA Organic Burst export tests: PASS');
