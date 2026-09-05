'use strict';

const AMM_CONTEXT_SCHEMA_VERSION = 1;
const AMM_POST_TRADE_STATE = 'POST_TRADE_V1';

function invalidContext(reason) {
  return { schemaVersion: AMM_CONTEXT_SCHEMA_VERSION,
    ammQuoteState: 'INVALID', ammQuoteStateReason: reason,
    prePoolBaseReservesRaw: null, prePoolQuoteReservesRaw: null,
    preReservePrice: null, ammExecutionFees: null };
}

function contextFields(value) {
  const number = value.preReservePrice == null ? null : Number(value.preReservePrice);
  return {
    schemaVersion: AMM_CONTEXT_SCHEMA_VERSION,
    ammQuoteState: typeof value.ammQuoteState === 'string' ? value.ammQuoteState : null,
    ammQuoteStateReason: value.ammQuoteStateReason == null ? null : String(value.ammQuoteStateReason),
    prePoolBaseReservesRaw: value.prePoolBaseReservesRaw == null ? null : String(value.prePoolBaseReservesRaw),
    prePoolQuoteReservesRaw: value.prePoolQuoteReservesRaw == null ? null : String(value.prePoolQuoteReservesRaw),
    preReservePrice: Number.isFinite(number) ? number : null,
    ammExecutionFees: value.ammExecutionFees && typeof value.ammExecutionFees === 'object'
      && !Array.isArray(value.ammExecutionFees) ? { ...value.ammExecutionFees } : null,
  };
}

function ammExecutionContext(trade = {}) {
  // An explicit state (especially INVALID) takes precedence over a saved blob.
  if (trade.ammQuoteState != null) return typeof trade.ammQuoteState === 'string' && trade.ammQuoteState
    ? contextFields(trade) : invalidContext('AMM_CONTEXT_STATE_MISSING');
  const encoded = trade.ammExecutionContextJson ?? trade.amm_execution_context_json;
  if (encoded == null) return null; // Historical rows remain unknown, never POST.
  try {
    const value = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
    if (!value || value.schemaVersion !== AMM_CONTEXT_SCHEMA_VERSION) {
      return invalidContext('AMM_CONTEXT_VERSION_UNSUPPORTED');
    }
    if (typeof value.ammQuoteState !== 'string' || !value.ammQuoteState) {
      return invalidContext('AMM_CONTEXT_STATE_MISSING');
    }
    return contextFields(value);
  } catch (_) {
    return invalidContext('AMM_CONTEXT_JSON_INVALID');
  }
}

function serializeAmmExecutionContext(trade = {}) {
  const context = ammExecutionContext(trade);
  if (!context) return null;
  try {
    // Fees may be raw integer BigInts; do not round them through Number.
    return JSON.stringify(context, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  } catch (_) {
    return JSON.stringify(invalidContext('AMM_CONTEXT_NOT_SERIALIZABLE'));
  }
}

function restoreRawExecutionContext(trade = {}) {
  const context = ammExecutionContext(trade);
  if (!context) return { ...trade };
  const { schemaVersion: _version, ...fields } = context;
  return { ...trade, ...fields };
}

// Final main/shard write-boundary compatibility for old producers and queued
// rows. Never mutate retry objects, infer a post-state, or rewrite old records.
function normalizeRawExecutionContext(trade = {}) {
  return {
    ...trade,
    pool: trade.pool ?? null,
    poolBaseReservesRaw: trade.poolBaseReservesRaw == null ? null : String(trade.poolBaseReservesRaw),
    poolQuoteReservesRaw: trade.poolQuoteReservesRaw == null ? null : String(trade.poolQuoteReservesRaw),
    virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw == null ? null : String(trade.virtualQuoteReservesRaw),
    ammExecutionContextJson: serializeAmmExecutionContext(trade),
  };
}

module.exports = { AMM_CONTEXT_SCHEMA_VERSION, AMM_POST_TRADE_STATE, ammExecutionContext,
  serializeAmmExecutionContext, restoreRawExecutionContext, normalizeRawExecutionContext };
