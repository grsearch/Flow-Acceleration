const FROZEN_FIRST_CLIFF_ACCEPTANCE_V1 = Object.freeze({
  policyId: 'FIRST_CLIFF_ACCEPTANCE_V1_20260829',
  windowHours: 24,
  minAllResolved: 50,
  minMatchedResolved: 20,
  minActualCliffs: 3,
  minPrecisionPct: 20,
  minRecallPct: 50,
  maxMatchedAverageReturnPct: -10,
  maxFalsePositiveAverageReturnPct: 5,
});

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function ratioPct(numerator, denominator) {
  return denominator > 0 ? numerator / denominator * 100 : null;
}

function evaluateFirstCliffCohort(input, policy = FROZEN_FIRST_CLIFF_ACCEPTANCE_V1) {
  const row = {
    cohort: String(input.cohort || ''),
    allResolved: Number(input.allResolved) || 0,
    actualCliffs: Number(input.actualCliffs) || 0,
    matchedResolved: Number(input.matchedResolved) || 0,
    caught: Number(input.caught) || 0,
    falsePositives: Number(input.falsePositives) || 0,
    missedCliffs: Number(input.missedCliffs) || 0,
    matchedAverageReturnPct: finiteOrNull(input.matchedAverageReturnPct),
    falsePositiveAverageReturnPct: finiteOrNull(input.falsePositiveAverageReturnPct),
  };
  row.precisionPct = ratioPct(row.caught, row.matchedResolved);
  row.recallPct = ratioPct(row.caught, row.actualCliffs);

  const insufficient = row.allResolved < policy.minAllResolved
    || row.matchedResolved < policy.minMatchedResolved
    || row.actualCliffs < policy.minActualCliffs;
  if (insufficient) {
    return {
      ...row,
      verdict: 'STOP_INSUFFICIENT_EVENT_RATE',
      eligibleForGuard: false,
      reason: '24h fixed window did not reach the frozen event-frequency floor; stop this direction instead of extending or retuning it.',
    };
  }

  const passed = row.precisionPct >= policy.minPrecisionPct
    && row.recallPct >= policy.minRecallPct
    && row.matchedAverageReturnPct != null
    && row.matchedAverageReturnPct <= policy.maxMatchedAverageReturnPct
    && row.falsePositiveAverageReturnPct != null
    && row.falsePositiveAverageReturnPct <= policy.maxFalsePositiveAverageReturnPct;
  return {
    ...row,
    verdict: passed ? 'APPROVE_FOR_GUARD_REVIEW' : 'REJECT_AND_STOP',
    eligibleForGuard: passed,
    reason: passed
      ? 'Frozen precision, recall and opportunity-cost gates all passed.'
      : 'At least one frozen precision, recall or opportunity-cost gate failed; reject without threshold tuning.',
  };
}

module.exports = {
  FROZEN_FIRST_CLIFF_ACCEPTANCE_V1,
  evaluateFirstCliffCohort,
};
