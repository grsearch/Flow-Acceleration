#!/usr/bin/env node

const Database = require('better-sqlite3');
const {
  FROZEN_FIRST_CLIFF_ACCEPTANCE_V1,
  FROZEN_FIRST_CLIFF_LIFECYCLE_STUDY_V2,
  evaluateFirstCliffCohort,
  evaluateLifecycleFirstCliffCohort,
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

// One mint can be audited by several strategies or at several entry moments. The
// frozen acceptance unit is a mint, not an audit row: use its first resolved
// opportunity in this slice so a repeatedly observed mint cannot dominate
// precision, recall or return evidence.
const uniqueMintSlice = `
  WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY mint
      ORDER BY entry_at ASC, resolved_at ASC, id ASC
    ) AS mint_rank
    FROM pre_entry_rug_first_cliff_audits
    WHERE resolved_at >= ? AND resolved_at < ?
      AND outcome IN ('CLIFF_RUG_70', 'NO_CLIFF_30S')
      AND mint IS NOT NULL AND TRIM(mint) != ''
  )
`;

const uniqueLifecycleMintSlice = `
  WITH ranked AS (
    SELECT *,
      COALESCE(NULLIF(TRIM(lifecycle_stage), ''), 'UNKNOWN') AS lifecycle_stage_key,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(NULLIF(TRIM(lifecycle_stage), ''), 'UNKNOWN'), mint
        ORDER BY entry_at ASC, resolved_at ASC, id ASC
      ) AS mint_rank
    FROM pre_entry_rug_first_cliff_audits
    WHERE resolved_at >= ? AND resolved_at < ?
      AND outcome IN ('CLIFF_RUG_70', 'NO_CLIFF_30S')
      AND mint IS NOT NULL AND TRIM(mint) != ''
  )
`;

const queryFor = (column) => db.prepare(`${uniqueMintSlice}
  SELECT
    COUNT(*) AS all_resolved,
    SUM(CASE WHEN outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS actual_cliffs,
    SUM(CASE WHEN ${column} = 1 THEN 1 ELSE 0 END) AS matched_resolved,
    SUM(CASE WHEN ${column} = 1 AND outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS caught,
    SUM(CASE WHEN ${column} = 1 AND outcome != 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS false_positives,
    SUM(CASE WHEN ${column} = 0 AND outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS missed_cliffs,
    COUNT(CASE WHEN ${column} = 1 AND return_pct IS NOT NULL THEN 1 END)
      AS matched_return_samples,
    COUNT(CASE WHEN ${column} = 1 AND outcome != 'CLIFF_RUG_70'
      AND return_pct IS NOT NULL THEN 1 END) AS false_positive_return_samples,
    AVG(CASE WHEN ${column} = 1 THEN return_pct END) AS matched_average_return_pct,
    AVG(CASE WHEN ${column} = 1 AND outcome != 'CLIFF_RUG_70' THEN return_pct END)
      AS false_positive_average_return_pct
  FROM ranked
  WHERE mint_rank = 1
`);

const lifecycleRows = db.prepare(`${uniqueLifecycleMintSlice}
  SELECT lifecycle_stage_key AS lifecycle_stage, COUNT(*) AS resolved,
         COUNT(DISTINCT mint) AS distinct_mints,
         SUM(CASE WHEN outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS cliffs,
         SUM(hc1_matched) AS hc1_matched, SUM(hc2_matched) AS hc2_matched
  FROM ranked
  WHERE mint_rank = 1
  GROUP BY lifecycle_stage_key
  ORDER BY lifecycle_stage_key
`).all(startMs, endMs);

const lifecycleQueryFor = (condition) => db.prepare(`${uniqueLifecycleMintSlice}
  SELECT
    COUNT(*) AS all_resolved,
    COUNT(DISTINCT mint) AS distinct_mints,
    SUM(CASE WHEN outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS actual_cliffs,
    SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END) AS matched_resolved,
    COUNT(DISTINCT CASE WHEN ${condition} THEN mint END) AS matched_distinct_mints,
    SUM(CASE WHEN (${condition}) AND outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS caught,
    SUM(CASE WHEN (${condition}) AND outcome != 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS false_positives,
    SUM(CASE WHEN NOT (${condition}) AND outcome = 'CLIFF_RUG_70' THEN 1 ELSE 0 END) AS missed_cliffs,
    COUNT(CASE WHEN (${condition}) AND return_pct IS NOT NULL THEN 1 END)
      AS matched_return_samples,
    COUNT(CASE WHEN (${condition}) AND outcome != 'CLIFF_RUG_70'
      AND return_pct IS NOT NULL THEN 1 END) AS false_positive_return_samples,
    AVG(CASE WHEN ${condition} THEN return_pct END) AS matched_average_return_pct,
    AVG(CASE WHEN (${condition}) AND outcome != 'CLIFF_RUG_70' THEN return_pct END)
      AS false_positive_average_return_pct,
    SUM(CASE WHEN NOT (${condition}) THEN 1 ELSE 0 END) AS unmatched_resolved,
    AVG(CASE WHEN NOT (${condition}) THEN return_pct END) AS unmatched_average_return_pct,
    SUM(CASE WHEN (${condition}) AND return_pct <= -50 THEN 1 ELSE 0 END) AS matched_loss_50,
    SUM(CASE WHEN NOT (${condition}) AND return_pct <= -50 THEN 1 ELSE 0 END) AS unmatched_loss_50,
    SUM(CASE WHEN (${condition}) AND return_pct > 0 THEN 1 ELSE 0 END) AS matched_wins,
    SUM(CASE WHEN NOT (${condition}) AND return_pct > 0 THEN 1 ELSE 0 END) AS unmatched_wins
  FROM ranked
  WHERE mint_rank = 1
    AND lifecycle_stage_key = ?
`);

const cohorts = [
  ['HC1', 'hc1_matched'],
  ['HC2', 'hc2_matched'],
].map(([cohort, column]) => {
  const row = queryFor(column).get(startMs, endMs);
  const diagnostic = evaluateFirstCliffCohort({
    cohort,
    allResolved: row.all_resolved,
    actualCliffs: row.actual_cliffs,
    matchedResolved: row.matched_resolved,
    caught: row.caught,
    falsePositives: row.false_positives,
    missedCliffs: row.missed_cliffs,
    matchedReturnSamples: row.matched_return_samples,
    falsePositiveReturnSamples: row.false_positive_return_samples,
    matchedAverageReturnPct: row.matched_average_return_pct,
    falsePositiveAverageReturnPct: row.false_positive_average_return_pct,
  });
  return {
    ...diagnostic,
    legacyVerdict: diagnostic.verdict,
    verdict: 'DEPRECATED_CROSS_LIFECYCLE_DIAGNOSTIC',
    eligibleForGuard: false,
    reason: 'Cross-lifecycle pooling is retained only for historical comparison and cannot authorize a guard.',
  };
});

const lifecycleDefinitions = [
  ['HC1', 'hc1_matched = 1'],
  ['HC2', 'hc2_matched = 1'],
  ['HC_ANY', '(hc1_matched = 1 OR hc2_matched = 1)'],
];
const lifecycleCohorts = lifecycleRows.flatMap(({ lifecycle_stage: lifecycleStage }) => (
  lifecycleDefinitions.map(([cohort, condition]) => {
    const row = lifecycleQueryFor(condition).get(startMs, endMs, lifecycleStage);
    return {
      ...evaluateLifecycleFirstCliffCohort({
        cohort,
        lifecycleStage,
        distinctMints: row.distinct_mints,
        matchedDistinctMints: row.matched_distinct_mints,
        allResolved: row.all_resolved,
        actualCliffs: row.actual_cliffs,
        matchedResolved: row.matched_resolved,
        caught: row.caught,
        falsePositives: row.false_positives,
        missedCliffs: row.missed_cliffs,
        matchedReturnSamples: row.matched_return_samples,
        falsePositiveReturnSamples: row.false_positive_return_samples,
        matchedAverageReturnPct: row.matched_average_return_pct,
        falsePositiveAverageReturnPct: row.false_positive_average_return_pct,
      }),
      unmatchedResolved: row.unmatched_resolved,
      unmatchedAverageReturnPct: row.unmatched_average_return_pct,
      matchedLoss50: row.matched_loss_50,
      unmatchedLoss50: row.unmatched_loss_50,
      matchedWins: row.matched_wins,
      unmatchedWins: row.unmatched_wins,
    };
  })
));

const forwardShadow = lifecycleCohorts.filter((row) => row.eligibleForShadowReview);
const finalVerdict = forwardShadow.length
  ? 'CONTINUE_AMM_LIFECYCLE_FORWARD_SHADOW'
  : 'NO_AMM_LIFECYCLE_COHORT_PASSED';

console.log(JSON.stringify({
  policy: FROZEN_FIRST_CLIFF_ACCEPTANCE_V1,
  lifecyclePolicy: FROZEN_FIRST_CLIFF_LIFECYCLE_STUDY_V2,
  window: { startMs, endMs, durationHours: 24 },
  aggregationUnit: 'UNIQUE_MINT',
  dedupeRule: {
    lifecycleAcceptance: 'FIRST_ENTRY_PER_LIFECYCLE_AND_MINT_IN_FIXED_SLICE',
    deprecatedCrossLifecycleDiagnostic: 'FIRST_ENTRY_PER_MINT_IN_FIXED_SLICE',
  },
  finalVerdict,
  liveGuardEligible: false,
  terminal: false,
  retuneAllowed: false,
  warning: 'Single-day output is forward-shadow evidence only; never pool Curve/launch with AMM or promote a live hard block.',
  cohorts,
  lifecycleRows,
  lifecycleCohorts,
}, null, 2));

db.close();
