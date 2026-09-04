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
  'MIGRATION_CONTINUITY:',
  'MIGRATION_SECOND_LEG:',
];

const LIVE_CURVE_HARD_BLOCK_SIGNATURES = Object.freeze([
  'crossMintToxicWallets',
  'crossMintToxicTemplate',
  'extremeCoordinatedDumpability',
]);

const REPEAT_ACTOR_HARD_BLOCK_SIGNATURES = Object.freeze([
  'crossMintToxicWallets',
  'crossMintToxicTemplate',
]);

function hardBlockSignaturesForLifecycle({ market, lifecycleStage } = {}) {
  const normalizedMarket = normalized(market);
  const stage = normalized(lifecycleStage);
  // The coordinated-dumpability signature is currently validated only at the
  // Curve migration boundary. On earlier Curve stages and PumpSwap it remains
  // observable, but cannot inherit a threshold learned at another age.
  if (normalizedMarket === 'PUMP_BONDING_CURVE' && stage === 'CURVE_MIGRATION') {
    return [...LIVE_CURVE_HARD_BLOCK_SIGNATURES];
  }
  return [...REPEAT_ACTOR_HARD_BLOCK_SIGNATURES];
}

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
  lifecycleAgeMs,
  ammEarlyMaxAgeMs = 10_000,
} = {}) {
  const id = normalized(strategyId);
  const normalizedSource = normalized(source) || 'SHADOW';
  const normalizedMarket = normalized(market);
  const stage = normalized(lifecycleStage);
  const ageMs = Number(lifecycleAgeMs);
  const earlyLimitMs = Number.isFinite(Number(ammEarlyMaxAgeMs))
    ? Math.max(0, Number(ammEarlyMaxAgeMs))
    : 10_000;
  const isAmmEarly = stage === 'AMM_EARLY'
    || (normalizedMarket === 'PUMP_AMM'
      && Number.isFinite(ageMs)
      && ageMs >= 0
      && ageMs <= earlyLimitMs);
  const isCurve = normalizedMarket === 'PUMP_BONDING_CURVE'
    || stage === 'PRE_MIGRATION'
    || stage === 'LAUNCH'
    || stage.startsWith('CURVE_');

  // Live Curve entries block only high-specificity catastrophe evidence. The
  // broad native stair-step labels remain research-only so normal right tails
  // are not removed with the RUGs. Shadow behavior is intentionally unchanged.
  if (normalizedSource === 'LIVE' && isCurve) {
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.HARD_BLOCK,
      policyReason: stage === 'CURVE_MIGRATION'
        ? 'LIVE_CURVE_MIGRATION_CATASTROPHE_HARD_BLOCK'
        : 'LIVE_CURVE_STAGE_SCOPED_REPEAT_ACTOR_HARD_BLOCK',
      hardBlockSignatures: hardBlockSignaturesForLifecycle({
        market: normalizedMarket, lifecycleStage: stage,
      }),
      requireHc2: false,
    };
  }

  // Keep the previously validated post-migration guards unchanged. G is
  // deliberately excluded: its broad AMM_EARLY rejection removed profitable
  // right tails together with the rugs in the independent lifecycle audit.
  if (startsWithAny(id, HARD_BLOCK_FAMILIES)) {
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.HARD_BLOCK,
      policyReason: 'POST_MIGRATION_FAMILY_STAGE_SCOPED_HARD_BLOCK',
      hardBlockSignatures: hardBlockSignaturesForLifecycle({
        market: normalizedMarket, lifecycleStage: stage,
      }),
    };
  }

  // Research families keep collecting the same labels without changing their
  // historical entry semantics.
  if (startsWithAny(id, LABEL_ONLY_FAMILIES)) {
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.LABEL_ONLY,
      policyReason: 'RESEARCH_FAMILY_LIFECYCLE_LABEL_ONLY',
      requireHc2: false,
    };
  }

  if (isCurve) {
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.LABEL_ONLY,
      policyReason: stage === 'LAUNCH'
        ? 'LAUNCH_CONCENTRATION_LABEL_ONLY'
        : stage === 'CURVE_EARLY'
          ? 'CURVE_EARLY_INVENTORY_LABEL_ONLY'
          : stage === 'CURVE_LATE'
            ? 'CURVE_LATE_DUMPABILITY_LABEL_ONLY'
            : stage === 'CURVE_MIGRATION'
              ? 'CURVE_MIGRATION_EXIT_PATH_LABEL_ONLY'
              : 'CURVE_LIFECYCLE_LABEL_ONLY',
      requireHc2: false,
    };
  }

  if (normalizedMarket === 'PUMP_AMM'
    || stage === 'POST_MIGRATION'
    || stage.startsWith('AMM_')) {
    if (id.startsWith('MIGRATED_DROP_REBOUND:') && isAmmEarly) {
      return {
        enforcementMode: RUG_GUARD_ENFORCEMENT.LABEL_ONLY,
        policyReason: 'AMM_EARLY_STAGE_CANDIDATE_LABEL_ONLY',
        requireHc2: false,
      };
    }
    return {
      enforcementMode: RUG_GUARD_ENFORCEMENT.HARD_BLOCK,
      policyReason: 'POST_MIGRATION_AMM_STAGE_SCOPED_HARD_BLOCK',
      hardBlockSignatures: hardBlockSignaturesForLifecycle({
        market: normalizedMarket, lifecycleStage: isAmmEarly ? 'AMM_EARLY' : 'AMM_MATURE',
      }),
    };
  }

  // Unknown live routes remain fail-safe. Unknown research routes remain
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
  hardBlockSignaturesForLifecycle,
  LIVE_CURVE_HARD_BLOCK_SIGNATURES,
  REPEAT_ACTOR_HARD_BLOCK_SIGNATURES,
  RUG_GUARD_ENFORCEMENT,
  resolveRugGuardPolicy,
};
