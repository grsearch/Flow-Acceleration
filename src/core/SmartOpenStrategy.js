'use strict';

const RULE_VERSION = 'smart-open-curve-v1';

const REJECT = Object.freeze({
  NOT_OPEN: 'NOT_OPEN',
  NOT_BONDING_CURVE: 'NOT_BONDING_CURVE',
  SMART_BUY_TOO_SMALL: 'SMART_BUY_TOO_SMALL',
  INSUFFICIENT_PREBUY_BUYERS: 'INSUFFICIENT_PREBUY_BUYERS',
  STALE_EVENT: 'STALE_EVENT',
});

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function evaluateSmartOpen(event, context, config, now = Date.now()) {
  const reasons = [];
  const phase = String(event?.positionPhase || '').toUpperCase();
  const market = String(event?.market || '').toUpperCase();
  const smartSol = finite(event?.solAmount);
  const preBuyers = Math.max(0, Math.trunc(finite(context?.uniqueBuyers)));
  const eventReceivedAt = finite(context?.receivedAtMs, finite(event?.timestampMs, now));
  const eventAgeMs = Math.max(0, now - eventReceivedAt);

  if (phase !== 'OPEN') reasons.push(REJECT.NOT_OPEN);
  if (market !== 'PUMP_BONDING_CURVE') reasons.push(REJECT.NOT_BONDING_CURVE);
  if (smartSol < config.minSmartOpenSol) reasons.push(REJECT.SMART_BUY_TOO_SMALL);
  if (preBuyers < config.minPreBuyers) reasons.push(REJECT.INSUFFICIENT_PREBUY_BUYERS);
  if (eventAgeMs > config.maxSignalAgeMs) reasons.push(REJECT.STALE_EVENT);

  return {
    ruleVersion: RULE_VERSION,
    matched: reasons.length === 0,
    rejectReasons: reasons,
    eventAgeMs,
    preBuyers,
    preBuyTx: Math.max(0, Math.trunc(finite(context?.buyTx))),
    preBuyFlowSol: finite(context?.buyFlowSol),
    preSellFlowSol: finite(context?.sellFlowSol),
    preNetFlowSol: finite(context?.netFlowSol),
  };
}

module.exports = {
  RULE_VERSION,
  REJECT,
  evaluateSmartOpen,
};
