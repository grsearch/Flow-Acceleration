const assert = require('node:assert/strict');
const {
  FROZEN_FIRST_CLIFF_ACCEPTANCE_V1,
  evaluateFirstCliffCohort,
} = require('../src/core/FirstCliffAcceptance');

const approved = evaluateFirstCliffCohort({
  cohort: 'HC1', allResolved: 100, actualCliffs: 10,
  matchedResolved: 25, caught: 6, falsePositives: 19, missedCliffs: 4,
  matchedAverageReturnPct: -20, falsePositiveAverageReturnPct: -2,
});
assert.equal(approved.verdict, 'APPROVE_FOR_GUARD_REVIEW');
assert.equal(approved.precisionPct, 24);
assert.equal(approved.recallPct, 60);

const rejected = evaluateFirstCliffCohort({
  cohort: 'HC2', allResolved: 100, actualCliffs: 10,
  matchedResolved: 25, caught: 2, falsePositives: 23, missedCliffs: 8,
  matchedAverageReturnPct: -5, falsePositiveAverageReturnPct: 8,
});
assert.equal(rejected.verdict, 'REJECT_AND_STOP');

const sparse = evaluateFirstCliffCohort({
  cohort: 'HC1', allResolved: 40, actualCliffs: 1,
  matchedResolved: 10, caught: 1, falsePositives: 9, missedCliffs: 0,
  matchedAverageReturnPct: -50, falsePositiveAverageReturnPct: -10,
});
assert.equal(sparse.verdict, 'STOP_INSUFFICIENT_EVENT_RATE');
assert.equal(FROZEN_FIRST_CLIFF_ACCEPTANCE_V1.windowHours, 24);

console.log('First-cliff frozen acceptance tests passed.');
