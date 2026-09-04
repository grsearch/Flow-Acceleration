'use strict';

const { resolveRugGuardPolicy } = require('./RugGuardPolicy');

function evaluateUniversalRugGuard(store, {
  strategyId,
  mint,
  timestampMs,
  source = 'SHADOW',
  market = null,
  lifecycleStage = null,
  lifecycleAgeMs = null,
  enforcementMode = null,
  hardBlockSignatures = null,
  policyReason = null,
}) {
  const policy = enforcementMode
    ? {
        enforcementMode,
        policyReason: policyReason || 'CALLER_OVERRIDE',
        ...(Array.isArray(hardBlockSignatures)
          ? { hardBlockSignatures: [...hardBlockSignatures] }
          : {}),
      }
    : resolveRugGuardPolicy({
      strategyId, source, market, lifecycleStage, lifecycleAgeMs,
    });
  const tracker = store?.preEntryRugRisk;
  if (!tracker?.config?.enabled || typeof tracker.evaluateGuard !== 'function') {
    return {
      enabled: false,
      blocked: false,
      sampleReady: false,
      flagged: false,
      reason: 'RUG_GUARD_DISABLED',
      ...policy,
    };
  }
  return tracker.evaluateGuard({
    strategyId,
    mint,
    timestampMs,
    source,
    market,
    lifecycleStage,
    lifecycleAgeMs,
    ...policy,
  });
}

module.exports = { evaluateUniversalRugGuard };
