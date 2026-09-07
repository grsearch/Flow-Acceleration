const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  FROZEN_FIRST_CLIFF_ACCEPTANCE_V1,
  FROZEN_FIRST_CLIFF_LIFECYCLE_STUDY_V2,
  evaluateFirstCliffCohort,
  evaluateLifecycleFirstCliffCohort,
} = require('../src/core/FirstCliffAcceptance');

const approved = evaluateFirstCliffCohort({
  cohort: 'HC1', allResolved: 100, actualCliffs: 10,
  matchedResolved: 25, caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedReturnSamples: 25, falsePositiveReturnSamples: 19,
  matchedAverageReturnPct: -20, falsePositiveAverageReturnPct: -2,
});
assert.equal(approved.verdict, 'APPROVE_FOR_GUARD_REVIEW');
assert.equal(approved.precisionPct, 24);
assert.equal(approved.recallPct, 60);

const rejected = evaluateFirstCliffCohort({
  cohort: 'HC2', allResolved: 100, actualCliffs: 10,
  matchedResolved: 25, caught: 2, falsePositives: 23, missedCliffs: 8,
  matchedReturnSamples: 25, falsePositiveReturnSamples: 23,
  matchedAverageReturnPct: -5, falsePositiveAverageReturnPct: 8,
});
assert.equal(rejected.verdict, 'REJECT_AND_STOP');

const sparse = evaluateFirstCliffCohort({
  cohort: 'HC1', allResolved: 40, actualCliffs: 1,
  matchedResolved: 10, caught: 1, falsePositives: 9, missedCliffs: 0,
  matchedReturnSamples: 10, falsePositiveReturnSamples: 9,
  matchedAverageReturnPct: -50, falsePositiveAverageReturnPct: -10,
});
assert.equal(sparse.verdict, 'STOP_INSUFFICIENT_EVENT_RATE');
assert.equal(FROZEN_FIRST_CLIFF_ACCEPTANCE_V1.windowHours, 24);

const missingReturn = evaluateFirstCliffCohort({
  cohort: 'HC1', allResolved: 100, actualCliffs: 10,
  matchedResolved: 25, caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedReturnSamples: 0, falsePositiveReturnSamples: 0,
  matchedAverageReturnPct: null, falsePositiveAverageReturnPct: null,
});
assert.equal(missingReturn.verdict, 'REJECT_MISSING_RETURN_EVIDENCE');
assert.equal(missingReturn.eligibleForGuard, false);

const partialReturn = evaluateFirstCliffCohort({
  cohort: 'HC1', allResolved: 100, actualCliffs: 10,
  matchedResolved: 25, caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedReturnSamples: 24, falsePositiveReturnSamples: 19,
  matchedAverageReturnPct: -20, falsePositiveAverageReturnPct: -2,
});
assert.equal(partialReturn.verdict, 'REJECT_MISSING_RETURN_EVIDENCE');
assert(partialReturn.missingRequiredStatistics
  .includes('matchedReturnSamples!=matchedResolved'));

const missingCount = evaluateFirstCliffCohort({
  cohort: 'HC1', allResolved: null, actualCliffs: 10,
  matchedResolved: 25, caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedReturnSamples: 25, falsePositiveReturnSamples: 19,
  matchedAverageReturnPct: -20, falsePositiveAverageReturnPct: -2,
});
assert.equal(missingCount.verdict, 'STOP_INSUFFICIENT_STATISTICS');
assert.deepEqual(missingCount.missingRequiredStatistics, ['allResolved']);

const ammResearch = evaluateLifecycleFirstCliffCohort({
  cohort: 'HC_ANY', lifecycleStage: 'AMM_EARLY', distinctMints: 80,
  matchedDistinctMints: 60,
  allResolved: 100, actualCliffs: 10, matchedResolved: 25,
  caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedReturnSamples: 25, falsePositiveReturnSamples: 19,
  matchedAverageReturnPct: -20, falsePositiveAverageReturnPct: -2,
});
assert.equal(ammResearch.verdict, 'CONTINUE_FORWARD_SHADOW');
assert.equal(ammResearch.eligibleForShadowReview, true);
assert.equal(ammResearch.eligibleForGuard, false,
  'one daily slice must never authorize a live hard block');
assert.equal(ammResearch.promotionCleanDays, 3);

const wrongLifecycle = evaluateLifecycleFirstCliffCohort({
  cohort: 'HC_ANY', lifecycleStage: 'CURVE_LATE', distinctMints: 80,
  matchedDistinctMints: 60,
  allResolved: 100, actualCliffs: 10, matchedResolved: 25,
  caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedReturnSamples: 25, falsePositiveReturnSamples: 19,
  matchedAverageReturnPct: -20, falsePositiveAverageReturnPct: -2,
});
assert.equal(wrongLifecycle.verdict, 'OBSERVE_ONLY_LIFECYCLE');
assert.equal(wrongLifecycle.eligibleForShadowReview, false);

const sparseDistinctMints = evaluateLifecycleFirstCliffCohort({
  cohort: 'HC_ANY', lifecycleStage: 'AMM_MATURE', distinctMints: 12,
  matchedDistinctMints: 8,
  allResolved: 100, actualCliffs: 10, matchedResolved: 25,
  caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedReturnSamples: 25, falsePositiveReturnSamples: 19,
  matchedAverageReturnPct: -20, falsePositiveAverageReturnPct: -2,
});
assert.equal(sparseDistinctMints.verdict, 'CONTINUE_INSUFFICIENT_FORWARD_SAMPLE');
assert.deepEqual(FROZEN_FIRST_CLIFF_LIFECYCLE_STUDY_V2.eligibleStages,
  ['AMM_EARLY', 'AMM_MATURE']);

const missingLifecycleReturn = evaluateLifecycleFirstCliffCohort({
  cohort: 'HC_ANY', lifecycleStage: 'AMM_EARLY', distinctMints: 80,
  matchedDistinctMints: 60,
  allResolved: 100, actualCliffs: 10, matchedResolved: 25,
  caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedReturnSamples: 0, falsePositiveReturnSamples: 19,
  matchedAverageReturnPct: undefined, falsePositiveAverageReturnPct: -2,
});
assert.equal(missingLifecycleReturn.verdict, 'CONTINUE_INSUFFICIENT_FORWARD_SAMPLE');
assert.equal(missingLifecycleReturn.eligibleForShadowReview, false);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-first-cliff-unique-'));
const databasePath = path.join(temporary, 'first-cliff.db');
const database = new Database(databasePath);
database.exec(`
  CREATE TABLE pre_entry_rug_first_cliff_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    lifecycle_stage TEXT,
    entry_at INTEGER NOT NULL,
    resolved_at INTEGER NOT NULL,
    hc1_matched INTEGER NOT NULL,
    hc2_matched INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    return_pct REAL
  )
`);
const insert = database.prepare(`
  INSERT INTO pre_entry_rug_first_cliff_audits (
    mint, lifecycle_stage, entry_at, resolved_at,
    hc1_matched, hc2_matched, outcome, return_pct
  ) VALUES (?, 'AMM_EARLY', ?, ?, 1, 0, ?, ?)
`);
for (let index = 0; index < 60; index += 1) {
  insert.run(
    `mint-${index}`,
    100 + index,
    200 + index,
    index < 12 ? 'CLIFF_RUG_70' : 'NO_CLIFF_30S',
    index < 12 ? -50 : 0,
  );
}
// Repeated later audits for mint-0 must not reweight event counts or returns.
for (let index = 0; index < 30; index += 1) {
  insert.run('mint-0', 1_000 + index, 1_100 + index, 'NO_CLIFF_30S', 100);
}
database.close();
const analyzer = path.join(__dirname, 'analyze-first-cliff-acceptance.js');
const originalArgv = process.argv;
const originalConsoleLog = console.log;
const originalExitCode = process.exitCode;
let analyzerOutput = '';
try {
  process.argv = [process.execPath, analyzer, databasePath, '2000'];
  process.exitCode = undefined;
  console.log = (value) => { analyzerOutput += String(value); };
  delete require.cache[require.resolve(analyzer)];
  require(analyzer);
  assert.equal(process.exitCode, undefined);
} finally {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  console.log = originalConsoleLog;
}
const report = JSON.parse(analyzerOutput);
assert.equal(report.aggregationUnit, 'UNIQUE_MINT');
const hc1AmmEarly = report.lifecycleCohorts.find((row) => (
  row.lifecycleStage === 'AMM_EARLY' && row.cohort === 'HC1'
));
assert.equal(hc1AmmEarly.allResolved, 60);
assert.equal(hc1AmmEarly.matchedResolved, 60);
assert.equal(hc1AmmEarly.actualCliffs, 12);
assert.equal(hc1AmmEarly.matchedAverageReturnPct, -10);
assert.equal(hc1AmmEarly.verdict, 'CONTINUE_FORWARD_SHADOW');
fs.rmSync(temporary, { recursive: true, force: true });

console.log('First-cliff frozen acceptance tests passed.');
