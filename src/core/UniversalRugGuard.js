'use strict';

function evaluateUniversalRugGuard(store, {
  strategyId,
  mint,
  timestampMs,
  source = 'SHADOW',
}) {
  const tracker = store?.preEntryRugRisk;
  if (!tracker?.config?.enabled || typeof tracker.evaluateGuard !== 'function') {
    return {
      enabled: false,
      blocked: false,
      sampleReady: false,
      flagged: false,
      reason: 'RUG_GUARD_DISABLED',
    };
  }
  return tracker.evaluateGuard({ strategyId, mint, timestampMs, source });
}

module.exports = { evaluateUniversalRugGuard };
