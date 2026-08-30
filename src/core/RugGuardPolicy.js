'use strict';

const RUG_GUARD_ENFORCEMENT = Object.freeze({
  HARD_BLOCK: 'HARD_BLOCK',
  LABEL_ONLY: 'LABEL_ONLY',
});

const LABEL_ONLY_FAMILIES = [
  'BONDING_MOMENTUM:',
  'CYA:',
  'CYA_SLOT_FLOW:',
  'FLOW_FIRST:',
  'FLOW_SMART_CONFIRM:',
  'GRADUATION_HOLD:',
  'HOLDER_GROWTH:',
  'LAUNCH_PULLBACK:',
  'PRIMARY:',
  'PUBLIC_FLOW_LEAD:',
  'SMART_LIKE_EARLY:',
  'SMART_OPEN:',
  'SMART_PULLBACK:',
  'SMART_RESONANCE:',
  'BIG_WINNER:',
];

const HARD_BLOCK_FAMILIES = [
  'MIGRATED_DROP_REBOUND:',
  'MIGRATION_CONTINUITY:',
  'MIGRATION_SECOND_LEG:',
];

function normalized(value) {
  return String(value || '').trim().toUpperCase();
}

function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function resolveRugGuardPolicy({
  strategyId,
  source = 'SHADOW',
  market,
  lifecycleStage,
} = {}) {
  const id = normalized(strategyId);
  const normalizedSource = normalized(source) || 'SHADOW';
  const normalizedMarket = normalized(market);
  const stage = normalized(lifecycleStage);

  // These families were measured as post-migration execution paths and the
  // fast-RUG label materially reduced their executable losses.
  if (startsWithAny(id, HARD_BLOCK_FAMILIES)) {
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.HARD_BLOCK,
      policyReason: 'POST_MIGRATION_FAMILY_HARD_BLOCK',
    };
  }

  // COB/Big-Winner and Launch cohorts currently over-block profitable right
  // tails. Keep collecting the exact same risk labels without rejecting entry.
  if (startsWithAny(id, LABEL_ONLY_FAMILIES)) {
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.LABEL_ONLY,
      policyReason: 'PRE_MIGRATION_OR_RESEARCH_FAMILY_LABEL_ONLY',
    };
  }

  if (normalizedMarket === 'PUMP_BONDING_CURVE'
    || stage === 'PRE_MIGRATION'
    || stage === 'LAUNCH'
    || stage.startsWith('CURVE_')) {
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.LABEL_ONLY,
      policyReason: 'CURVE_LIFECYCLE_LABEL_ONLY',
    };
  }

  if (normalizedMarket === 'PUMP_AMM'
    || stage === 'POST_MIGRATION'
    || stage.startsWith('AMM_')) {
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.HARD_BLOCK,
      policyReason: 'POST_MIGRATION_AMM_HARD_BLOCK',
    };
  }

  // Unknown live routes stay fail-safe. Unknown research routes remain
  // observable without silently changing historical Shadow entry semantics.
  return normalizedSource === 'LIVE'
    ? {
        enforcementMode: RUG_GUARD_ENFORCEMENT.HARD_BLOCK,
        policyReason: 'UNKNOWN_LIVE_FAIL_SAFE_HARD_BLOCK',
      }
    : {
        enforcementMode: RUG_GUARD_ENFORCEMENT.LABEL_ONLY,
        policyReason: 'UNKNOWN_SHADOW_LABEL_ONLY',
      };
}

module.exports = {
  RUG_GUARD_ENFORCEMENT,
  resolveRugGuardPolicy,
};
