'use strict';

const RULE_VERSION = 'primary-early-threshold-v2';

const REJECT = Object.freeze({
  NOT_PRIMARY: 'NOT_PRIMARY',
  WRONG_VARIANT: 'WRONG_VARIANT',
  NETFLOW_W3_BELOW_MIN: 'NETFLOW_W3_BELOW_MIN',
  BUYERS_W3_BELOW_MIN: 'BUYERS_W3_BELOW_MIN',
  INVALID_PRICE: 'INVALID_PRICE',
  STALE_SIGNAL: 'STALE_SIGNAL',
});

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function evaluatePrimarySignal(signal, config, now = Date.now()) {
  const reasons = [];
  const signalCreatedAt = finite(signal?.createdAt, finite(signal?.timestampMs, now));
  const signalAgeMs = Math.max(0, now - signalCreatedAt);
  const netFlowW3 = finite(signal?.netFlowW3, -Infinity);
  const uniqueBuyersW3 = Math.max(0, Math.trunc(finite(signal?.uniqueBuyersW3, -Infinity)));
  const expectedVariant = config.signalVariant || 'primary_3w';
  const isExpectedThreshold = signal?.signalVariant === expectedVariant
    && expectedVariant.startsWith('primary_early_');

  if (!isExpectedThreshold
    && !(signal?.isPrimary === true || Number(signal?.isPrimary) === 1)) {
    reasons.push(REJECT.NOT_PRIMARY);
  }
  if (signal?.signalVariant !== expectedVariant) reasons.push(REJECT.WRONG_VARIANT);
  if (netFlowW3 < config.minNetFlowW3Sol) reasons.push(REJECT.NETFLOW_W3_BELOW_MIN);
  if (uniqueBuyersW3 < config.minUniqueBuyersW3) reasons.push(REJECT.BUYERS_W3_BELOW_MIN);
  if (!(finite(signal?.price) > 0)) reasons.push(REJECT.INVALID_PRICE);
  if (signalAgeMs > config.maxSignalAgeMs) reasons.push(REJECT.STALE_SIGNAL);

  return {
    ruleVersion: RULE_VERSION,
    matched: reasons.length === 0,
    rejectReasons: reasons,
    signalAgeMs,
    netFlowW3,
    uniqueBuyersW3,
  };
}

module.exports = {
  RULE_VERSION,
  REJECT,
  evaluatePrimarySignal,
};
