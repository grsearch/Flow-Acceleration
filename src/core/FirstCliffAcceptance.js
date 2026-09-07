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

// Daily lifecycle slices are research evidence only.  Keeping this policy
// separate from V1 prevents AMM evidence from being pooled with Curve/launch
// stages and prevents one good day from silently becoming a live hard block.
const FROZEN_FIRST_CLIFF_LIFECYCLE_STUDY_V2 = Object.freeze({
  policyId: 'FIRST_CLIFF_LIFECYCLE_STUDY_V2_20260907',
  windowHours: 24,
  promotionCleanDays: 3,
  eligibleStages: Object.freeze(['AMM_EARLY', 'AMM_MATURE']),
  minAllResolved: 50,
  minMatchedResolved: 20,
  minActualCliffs: 3,
  minDistinctMints: 50,
  minMatchedDistinctMints: 50,
  minPrecisionPct: 20,
  minRecallPct: 50,
  maxMatchedAverageReturnPct: -10,
  maxFalsePositiveAverageReturnPct: 5,
});

function finiteOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function countOrNull(value) {
  const numeric = finiteOrNull(value);
  return numeric != null && numeric >= 0 ? numeric : null;
}

function ratioPct(numerator, denominator) {
  return numerator != null && denominator != null && denominator > 0
    ? numerator / denominator * 100 : null;
}

function evaluateFirstCliffCohort(input, policy = FROZEN_FIRST_CLIFF_ACCEPTANCE_V1) {
  const row = {
    cohort: String(input.cohort || ''),
    allResolved: countOrNull(input.allResolved),
    actualCliffs: countOrNull(input.actualCliffs),
    matchedResolved: countOrNull(input.matchedResolved),
    caught: countOrNull(input.caught),
    falsePositives: countOrNull(input.falsePositives),
    missedCliffs: countOrNull(input.missedCliffs),
    matchedReturnSamples: countOrNull(input.matchedReturnSamples),
    falsePositiveReturnSamples: countOrNull(input.falsePositiveReturnSamples),
    matchedAverageReturnPct: finiteOrNull(input.matchedAverageReturnPct),
    falsePositiveAverageReturnPct: finiteOrNull(input.falsePositiveAverageReturnPct),
  };
  const requiredCountFields = [
    'allResolved', 'actualCliffs', 'matchedResolved', 'caught',
    'falsePositives', 'missedCliffs',
  ];
  row.missingRequiredStatistics = requiredCountFields
    .filter((field) => row[field] == null);
  row.precisionPct = ratioPct(row.caught, row.matchedResolved);
  row.recallPct = ratioPct(row.caught, row.actualCliffs);

  if (row.missingRequiredStatistics.length) {
    return {
      ...row,
      verdict: 'STOP_INSUFFICIENT_STATISTICS',
      eligibleForGuard: false,
      reason: `Required cohort statistics are missing: ${row.missingRequiredStatistics.join(', ')}.`,
    };
  }

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

  const missingReturnStatistics = [
    ['matchedReturnSamples', row.matchedReturnSamples],
    ['falsePositiveReturnSamples', row.falsePositiveReturnSamples],
    ['matchedAverageReturnPct', row.matchedAverageReturnPct],
    ['falsePositiveAverageReturnPct', row.falsePositiveAverageReturnPct],
  ].filter(([, value]) => value == null).map(([field]) => field);
  if (row.matchedReturnSamples != null
    && row.matchedReturnSamples !== row.matchedResolved) {
    missingReturnStatistics.push('matchedReturnSamples!=matchedResolved');
  }
  if (row.falsePositiveReturnSamples != null
    && row.falsePositiveReturnSamples !== row.falsePositives) {
    missingReturnStatistics.push('falsePositiveReturnSamples!=falsePositives');
  }
  if (missingReturnStatistics.length) {
    return {
      ...row,
      missingRequiredStatistics: missingReturnStatistics,
      verdict: 'REJECT_MISSING_RETURN_EVIDENCE',
      eligibleForGuard: false,
      reason: `Required return evidence is missing: ${missingReturnStatistics.join(', ')}.`,
    };
  }

  const passed = row.precisionPct >= policy.minPrecisionPct
    && row.recallPct >= policy.minRecallPct
    && row.matchedAverageReturnPct <= policy.maxMatchedAverageReturnPct
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

function evaluateLifecycleFirstCliffCohort(
  input,
  policy = FROZEN_FIRST_CLIFF_LIFECYCLE_STUDY_V2,
) {
  const lifecycleStage = String(input.lifecycleStage || 'UNKNOWN');
  const distinctMints = countOrNull(input.distinctMints);
  const matchedDistinctMints = countOrNull(input.matchedDistinctMints);
  const base = evaluateFirstCliffCohort(input, policy);
  const eligibleStage = policy.eligibleStages.includes(lifecycleStage);
  if (!eligibleStage) {
    return {
      ...base,
      lifecycleStage,
      distinctMints,
      matchedDistinctMints,
      eligibleForGuard: false,
      eligibleForShadowReview: false,
      verdict: 'OBSERVE_ONLY_LIFECYCLE',
      reason: 'This lifecycle remains observational; AMM thresholds must not be transferred to Curve or launch stages.',
    };
  }
  if (distinctMints == null
    || matchedDistinctMints == null
    || distinctMints < policy.minDistinctMints
    || matchedDistinctMints < policy.minMatchedDistinctMints
    || base.verdict === 'STOP_INSUFFICIENT_EVENT_RATE'
    || base.verdict === 'STOP_INSUFFICIENT_STATISTICS'
    || base.verdict === 'REJECT_MISSING_RETURN_EVIDENCE') {
    return {
      ...base,
      lifecycleStage,
      distinctMints,
      matchedDistinctMints,
      eligibleForGuard: false,
      eligibleForShadowReview: false,
      verdict: 'CONTINUE_INSUFFICIENT_FORWARD_SAMPLE',
      reason: 'Keep the frozen AMM lifecycle shadow cohort; required unique-mint, event or return evidence is incomplete.',
    };
  }
  const passed = base.eligibleForGuard === true;
  return {
    ...base,
    lifecycleStage,
    distinctMints,
    matchedDistinctMints,
    eligibleForGuard: false,
    eligibleForShadowReview: passed,
    verdict: passed ? 'CONTINUE_FORWARD_SHADOW' : 'REJECT_STAGE_COHORT',
    promotionCleanDays: policy.promotionCleanDays,
    reason: passed
      ? 'One frozen daily slice passed; collect the same cohort for three clean days before any guard review.'
      : 'The frozen lifecycle cohort failed without cross-stage pooling; do not retune it on this slice.',
  };
}

module.exports = {
  FROZEN_FIRST_CLIFF_ACCEPTANCE_V1,
  FROZEN_FIRST_CLIFF_LIFECYCLE_STUDY_V2,
  evaluateFirstCliffCohort,
  evaluateLifecycleFirstCliffCohort,
};
