'use strict';

const { resolveRugGuardPolicy } = require('./RugGuardPolicy');

function evaluateUniversalRugGuard(store, {
  strategyId,
  mint,
  timestampMs,
  source = 'SHADOW',
  market = null,
  lifecycleStage = null,
  enforcementMode = null,
}) {
  const policy = enforcementMode
    ? { enforcementMode, policyReason: 'CALLER_OVERRIDE' }
    : resolveRugGuardPolicy({ strategyId, source, market, lifecycleStage });
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
    ...policy,
  });
}

module.exports = { evaluateUniversalRugGuard };
