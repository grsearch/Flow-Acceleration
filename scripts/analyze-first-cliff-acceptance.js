#!/usr/bin/env node

const Database = require('better-sqlite3');
const {
  FROZEN_FIRST_CLIFF_ACCEPTANCE_V1,
  evaluateFirstCliffCohort,
} = require('../src/core/FirstCliffAcceptance');

const databasePath = process.argv[2];
const requestedEndMs = Number(process.argv[3]);

if (!databasePath) {
  console.error('Usage: node scripts/analyze-first-cliff-acceptance.js <db> [endMs]');
  process.exit(1);
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const table = db.prepare(`
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'pre_entry_rug_first_cliff_audits'
`).get();
if (!table) {
  console.error('pre_entry_rug_first_cliff_audits is missing; the forward audit was not deployed.');
  process.exitCode = 2;
  db.close();
  return;
}

const latest = db.prepare(`
  SELECT MAX(resolved_at) AS resolvedAt
  FROM pre_entry_rug_first_cliff_audits
`).get();
const endMs = Number.isFinite(requestedEndMs) && requestedEndMs > 0
  ? requestedEndMs : Number(latest?.resolvedAt);
if (!(endMs > 0)) {
  console.error('No resolved first-cliff audits are available.');
  process.exitCode = 3;
  db.close();
  return;
}
const startMs = endMs - FROZEN_FIRST_CLIFF_ACCEPTANCE_V1.windowHours * 60 * 60 * 1_000;

const queryFor = (column) => db.prepare(`
  SELECT
    COUNT(*) AS all_resolved,
    SUM(CASE WHEN outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS actual_cliffs,
    SUM(CASE WHEN ${column} = 1 THEN 1 ELSE 0 END) AS matched_resolved,
    SUM(CASE WHEN ${column} = 1 AND outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS caught,
    SUM(CASE WHEN ${column} = 1 AND outcome != 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS false_positives,
    SUM(CASE WHEN ${column} = 0 AND outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS missed_cliffs,
    AVG(CASE WHEN ${column} = 1 THEN return_pct END) AS matched_average_return_pct,
    AVG(CASE WHEN ${column} = 1 AND outcome != 'CLIFF_RUG_70' THEN return_pct END)
      AS false_positive_average_return_pct
  FROM pre_entry_rug_first_cliff_audits
  WHERE resolved_at >= ? AND resolved_at < ?
    AND outcome IN ('CLIFF_RUG_70', 'NO_CLIFF_30S')
`);

const lifecycleRows = db.prepare(`
  SELECT lifecycle_stage, COUNT(*) AS resolved,
         SUM(CASE WHEN outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS cliffs,
         SUM(hc1_matched) AS hc1_matched, SUM(hc2_matched) AS hc2_matched
  FROM pre_entry_rug_first_cliff_audits
  WHERE resolved_at >= ? AND resolved_at < ?
    AND outcome IN ('CLIFF_RUG_70', 'NO_CLIFF_30S')
  GROUP BY lifecycle_stage
  ORDER BY lifecycle_stage
`).all(startMs, endMs);

const cohorts = [
  ['HC1', 'hc1_matched'],
  ['HC2', 'hc2_matched'],
].map(([cohort, column]) => {
  const row = queryFor(column).get(startMs, endMs);
  return evaluateFirstCliffCohort({
    cohort,
    allResolved: row.all_resolved,
    actualCliffs: row.actual_cliffs,
    matchedResolved: row.matched_resolved,
    caught: row.caught,
    falsePositives: row.false_positives,
    missedCliffs: row.missed_cliffs,
    matchedAverageReturnPct: row.matched_average_return_pct,
    falsePositiveAverageReturnPct: row.false_positive_average_return_pct,
  });
});

const approved = cohorts.filter((row) => row.eligibleForGuard);
const finalVerdict = approved.length
  ? `APPROVE_${approved.map((row) => row.cohort).join('_')}_FOR_GUARD_REVIEW`
  : cohorts.every((row) => row.verdict === 'STOP_INSUFFICIENT_EVENT_RATE')
    ? 'STOP_INSUFFICIENT_EVENT_RATE'
    : 'REJECT_AND_STOP';

console.log(JSON.stringify({
  policy: FROZEN_FIRST_CLIFF_ACCEPTANCE_V1,
  window: { startMs, endMs, durationHours: 24 },
  finalVerdict,
  terminal: true,
  retuneAllowed: false,
  cohorts,
  lifecycleRows,
}, null, 2));

db.close();
